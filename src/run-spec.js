// run-spec: drive an app through a JSON spec, record every assertion, write a signed receipt.
// Verdicts: PASS (exit 0), FAIL (exit 1: an assertion failed), ERROR (exit 2: the run could not finish).
// Usage: node src/run-spec.js --spec <file.json> --key-file <path> [--receipts <dir>]
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startApp } from "./server.js";
import { environmentWithoutKey, fixedStamp, signingKeyFromFile, writeReceipt } from "./chain.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_RECEIPTS = process.env.PROOF_LAB_RECEIPTS ?? join(ROOT, "receipts");
const TIMEOUT_MS = 3000;

// Required fields per op. fill, click and assertText have extra either/or rules in validateSpec.
const OPS = {
  goto: ["url"],
  fill: ["value"],
  click: [],
  press: ["key"],
  waitFor: ["selector"],
  reload: [],
  assertText: ["selector"],
  assertVisible: ["selector"],
  assertStorage: ["key", "equals"],
};

const firstLine = error => (error instanceof Error ? error.message : String(error)).split("\n")[0];

export function validateSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return ["spec must be a JSON object"];
  const problems = [];
  if (typeof spec.name !== "string" || spec.name.trim() === "") problems.push("name must be a non-empty string");
  if (spec.app !== undefined && (typeof spec.app !== "object" || spec.app === null)) problems.push("app must be an object");
  if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
    problems.push("steps must be a non-empty array");
    return problems;
  }
  spec.steps.forEach((step, i) => {
    const at = `steps[${i}]`;
    if (!step || typeof step !== "object") return problems.push(`${at} must be an object`);
    if (!Object.hasOwn(OPS, step.op)) return problems.push(`${at}.op "${step.op}" is not one of ${Object.keys(OPS).join(", ")}`);
    for (const field of OPS[step.op]) {
      if (step[field] === undefined) problems.push(`${at} (${step.op}) needs "${field}"`);
    }
    if (step.op === "fill" && !step.label && !step.selector) problems.push(`${at} (fill) needs "label" or "selector"`);
    if (step.op === "click" && !(step.role && step.name) && !step.selector) {
      problems.push(`${at} (click) needs "role" with "name", or "selector"`);
    }
    if (step.op === "assertText" && (step.equals === undefined) === (step.contains === undefined)) {
      problems.push(`${at} (assertText) needs exactly one of "equals" or "contains"`);
    }
  });
  return problems;
}

function locate(page, step) {
  if (step.role) return page.getByRole(step.role, { name: step.name, exact: true });
  if (step.label) return page.getByLabel(step.label, { exact: true });
  return page.locator(step.selector);
}

const readValue = (object, path) => (path ? path.split(".").reduce((node, part) => node?.[part], object) : object);

// One step. Assertions record a check. A failed action (missing element, timeout) is recorded as a failed check too,
// because the app did not allow the step; the run goes on so the receipt shows every failure.
async function runStep(page, step, index, appUrl, checks) {
  const target = step.selector ?? (step.label ? `label ${step.label}` : step.name ?? "");
  const label = step.name ?? `step ${index}: ${step.op} ${target}`.trim();
  const record = (pass, expected, actual, hint) => checks.push({ name: label, pass, expected, actual, ...(hint && !pass ? { hint } : {}) });
  const hint = step.hint;
  try {
    switch (step.op) {
      case "goto":
        await page.goto(new URL(step.url, appUrl).href, { waitUntil: "load" });
        return;
      case "fill":
        await locate(page, step).fill(step.value);
        return;
      case "click":
        await locate(page, step).click();
        return;
      case "press":
        await page.keyboard.press(step.key);
        return;
      case "waitFor":
        // optional: a missed wait is not a failed check; the assertion after it decides (as in prove.js).
        await page.locator(step.selector).filter(step.hasText ? { hasText: step.hasText } : {}).first()
          .waitFor({ state: "visible" })
          .catch(error => { if (!step.optional) throw error; });
        return;
      case "reload":
        await page.reload({ waitUntil: "load" });
        return;
      case "assertText": {
        const exists = (await page.locator(step.selector).count()) > 0;
        const actual = exists ? (await page.locator(step.selector).first().innerText()).trim() : null;
        const pass = step.equals !== undefined ? actual === step.equals : (actual ?? "").includes(step.contains);
        record(pass, step.equals ?? `contains ${JSON.stringify(step.contains)}`, actual, hint);
        return;
      }
      case "assertVisible": {
        const actual = await page.locator(step.selector).first().isVisible().catch(() => false);
        record(actual === true, true, actual, hint);
        return;
      }
      case "assertStorage": {
        const raw = await page.evaluate(key => localStorage.getItem(key), step.key);
        let parsed = null;
        try { parsed = raw === null ? null : JSON.parse(raw); } catch { parsed = raw; }
        const actual = readValue(parsed, step.path) ?? null;
        record(JSON.stringify(actual) === JSON.stringify(step.equals), step.equals, actual, hint);
        return;
      }
      default:
        throw new Error(`unknown op ${step.op}`);
    }
  } catch (error) {
    const isAssert = step.op.startsWith("assert");
    if (isAssert) {
      record(false, step.equals ?? step.contains ?? true, null, hint);
    } else {
      record(false, `${step.op} completes`, firstLine(error), hint ?? `The app did not allow step ${index} (${step.op} ${target}).`);
    }
    checks.at(-1).error = firstLine(error);
  }
}

// Runs one spec file. Returns the receipt. An invalid spec returns ERROR and writes no receipt.
export async function runSpec({ specPath, key, receiptsDir = DEFAULT_RECEIPTS } = {}) {
  const receipt = {
    verdict: "ERROR", app: null, bug: null, spec: null, revision: null, at: fixedStamp(),
    checks: [], pageErrors: [], screenshot: null, error: null, next: [],
  };

  let spec;
  let text;
  try {
    text = await readFile(specPath, "utf8");
    spec = JSON.parse(text);
  } catch (error) {
    receipt.error = `spec could not be read or parsed: ${firstLine(error)}`;
    receipt.next = [receipt.error, "Fix the spec file and run again. No receipt was written."];
    return receipt;
  }
  const problems = validateSpec(spec);
  if (problems.length > 0) {
    receipt.error = `invalid spec: ${problems.join("; ")}`;
    receipt.next = [receipt.error, "Fix the spec file and run again. No receipt was written."];
    return receipt;
  }

  receipt.spec = `${spec.name}@${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
  receipt.bug = spec.app?.bug ?? null;
  const pageErrors = new Set();
  let server = null;
  let browser = null;
  let shot = null;

  try {
    if (spec.app?.url) {
      receipt.app = spec.app.url;
    } else {
      server = await startApp({ bug: spec.app?.bug });
      receipt.app = server.url;
    }
    browser = await chromium.launch({ headless: true, env: environmentWithoutKey() });
    const context = await browser.newContext(); // fresh visitor: no storage
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);
    page.on("pageerror", error => pageErrors.add(error.message));
    page.on("console", message => { if (message.type() === "error") pageErrors.add(message.text()); });

    await page.goto(receipt.app, { waitUntil: "load" });
    receipt.revision = await page.locator('meta[name="app-revision"]').getAttribute("content", { timeout: 1000 }).catch(() => null);

    for (const [i, step] of spec.steps.entries()) {
      await runStep(page, step, i + 1, receipt.app, receipt.checks);
    }
    if (spec.noPageErrors === true) {
      receipt.checks.push({
        name: "no page errors", pass: pageErrors.size === 0, expected: [], actual: [...pageErrors],
        ...(pageErrors.size > 0 ? { hint: "The page logged errors. Read pageErrors in the receipt." } : {}),
      });
    }

    if (server) {
      const response = await fetch(new URL("/__revision", receipt.app), { signal: AbortSignal.timeout(2000) });
      const now = (await response.json()).revision;
      if (now !== receipt.revision) {
        throw new Error(`the app changed while running (loaded ${receipt.revision}, now ${now}); evidence from two builds proves neither`);
      }
    }
    shot = await page.screenshot({ fullPage: true });
    if (receipt.checks.length === 0) {
      receipt.error = "No checks were recorded. Add assertions to the spec.";
      receipt.verdict = "ERROR";
    } else {
      receipt.verdict = receipt.checks.every(check => check.pass) ? "PASS" : "FAIL";
    }
  } catch (error) {
    receipt.verdict = "ERROR";
    receipt.error = `run failed: ${firstLine(error)}`;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await server.close().catch(() => {});
  }

  receipt.pageErrors = [...pageErrors];
  if (receipt.verdict === "PASS") {
    receipt.next = ["These checks passed on this revision. They cover nothing else: read the screenshot for anything they missed."];
  } else if (receipt.verdict === "FAIL") {
    receipt.next = receipt.checks.filter(check => !check.pass).map(check =>
      check.hint ?? `Fix "${check.name}": expected ${JSON.stringify(check.expected)}, got ${JSON.stringify(check.actual)}.`);
  } else {
    receipt.next = [receipt.error ?? "Unknown error.", "Can't tell is not the same as broken: run it again once the app is stable."];
  }

  // A receipt that cannot be written is not evidence: the run becomes ERROR, never a silent PASS.
  try {
    await writeReceipt(receipt, { shot, key, dir: receiptsDir });
  } catch (error) {
    receipt.verdict = "ERROR";
    receipt.error = `receipt write failed: ${firstLine(error)}`;
    receipt.next = [receipt.error, "No receipt file was written, so this run is not evidence. Fix the receipts directory and run again."];
  }
  return receipt;
}

const EXIT = { PASS: 0, FAIL: 1, ERROR: 2 };

// CLI: node src/run-spec.js --spec <file.json> --key-file <path> [--receipts <dir>]
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  let key;
  try {
    if (process.env.PROOF_LAB_KEY !== undefined) {
      throw new Error("PROOF_LAB_KEY is set in the environment; unset it and pass the key with --key-file <path>");
    }
    if (!flag("--key-file")) throw new Error("--key-file <path> is required: the signing key is read from a 0600 file");
    key = await signingKeyFromFile(flag("--key-file"));
  } catch (error) {
    console.error(`ERROR: ${firstLine(error)}`);
    process.exitCode = 2;
  }
  if (key && flag("--spec")) {
    const receipt = await runSpec({ specPath: flag("--spec"), key, receiptsDir: flag("--receipts") ?? DEFAULT_RECEIPTS });
    console.log(`${receipt.verdict} ${receipt.spec ?? "(no spec)"} ${receipt.app ?? ""}`.trimEnd());
    for (const check of receipt.checks) {
      console.log(`  ${check.pass ? "PASS" : "FAIL"} ${check.name}`);
    }
    if (receipt.error) console.log(`  error: ${receipt.error}`);
    process.exitCode = EXIT[receipt.verdict];
  } else if (key) {
    console.error("ERROR: --spec <file.json> is required");
    process.exitCode = 2;
  }
}
