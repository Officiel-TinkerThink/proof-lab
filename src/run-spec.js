// run-spec: drive an app through a JSON spec, record every check, write a signed summary receipt and an evidence file.
// Verdicts: PASS (exit 0), FAIL (exit 1: a check failed), ERROR (exit 2: the run could not finish).
// Usage: node src/run-spec.js --spec <file.json> --key-file <path> [--receipts <dir>] [--json]
// The ops and fields a spec may use are in src/spec/schema.js and documented in SPECS.md.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startApp } from "./server.js";
import { environmentWithoutKey, fixedStamp, signingKeyFromFile, writeReceipt } from "./chain.js";
import { clipValue, evidenceText, summarize, summarizePageErrors } from "./spec/evidence.js";
import { describeTarget } from "./spec/locate.js";
import { DEFAULT_TIMEOUT_MS } from "./spec/poll.js";
import { validateSpec } from "./spec/schema.js";
import { STEPS } from "./spec/steps.js";
import { firstLine } from "./spec/util.js";

export { validateSpec };

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_RECEIPTS = process.env.PROOF_LAB_RECEIPTS ?? join(ROOT, "receipts");
const EXIT = { PASS: 0, FAIL: 1, ERROR: 2 };
const MAX_CONSOLE_RECORDS = 500;
const MAX_FAILURE_CONTEXTS = 5;
const ARIA_CHARS = 8000;

// "check" names the step in the receipt. "name" without a role is the older spelling of it.
function labelOf(step, index) {
  if (step.check !== undefined) return step.check;
  if (step.name !== undefined && step.role === undefined) return step.name;
  return `step ${index}: ${step.op} ${describeTarget(step)}`.trim();
}

function createContext({ page, appUrl, specDir, timeoutMs, checks }) {
  const ctx = {
    page, appUrl, specDir, timeoutMs, checks, index: 0,
    record(step, pass, expected, actual, error) {
      // An optional step is allowed to fail: it leaves no failed check (the evidence timeline still shows it).
      if (!pass && step.optional) return;
      const check = { step: ctx.index, name: labelOf(step, ctx.index), pass, expected, actual };
      if (!pass && step.hint) check.hint = step.hint;
      if (!pass && error) check.error = error;
      checks.push(check);
    },
  };
  return ctx;
}

// A step the page did not allow is a failed check, not an ERROR: the run goes on so the receipt lists every failure.
async function runStep(ctx, step) {
  const first = ctx.checks.length;
  const started = performance.now();
  const record = { type: "step", step: ctx.index, op: step.op, check: labelOf(step, ctx.index) };
  const target = describeTarget(step);
  if (target) record.target = target;
  try {
    await STEPS[step.op](ctx, step);
  } catch (error) {
    if (step.optional) {
      record.skipped = firstLine(error);
    } else {
      const hint = step.hint ?? `The app did not allow step ${ctx.index} (${step.op} ${target}).`.replace(/ \)/, ")");
      ctx.record({ ...step, hint }, false, `${step.op} completes`, null, firstLine(error));
    }
  }
  record.ms = Math.round(performance.now() - started);
  record.ok = ctx.checks.slice(first).every(check => check.pass);
  return record;
}

// What the page looked like when a check failed: the address, the title, and the accessibility tree (what an agent
// "sees"). The first failure also gets a small picture.
async function captureContext(page, step, withPicture) {
  const context = { type: "context", step, url: null, title: null, aria: null };
  const records = [context];
  try {
    context.url = page.url();
    context.title = await page.title();
  } catch { /* the page may be gone */ }
  try {
    context.aria = clipValue(await page.locator("body").ariaSnapshot({ timeout: 2000 }), ARIA_CHARS);
  } catch (error) {
    context.ariaError = firstLine(error);
  }
  if (withPicture) {
    try {
      const jpeg = await page.screenshot({ type: "jpeg", quality: 60, timeout: 3000 });
      records.push({ type: "screenshot", step, mime: "image/jpeg", base64: jpeg.toString("base64") });
    } catch { /* no picture is not a failure */ }
  }
  return records;
}

// Runs one spec file. Returns the receipt as stored, plus a non-stored `detail` (the evidence, in memory).
// An invalid spec returns ERROR and writes nothing.
export async function runSpec({ specPath, key, receiptsDir = DEFAULT_RECEIPTS } = {}) {
  const receipt = {
    verdict: "ERROR", app: null, bug: null, spec: null, revision: null, at: fixedStamp(),
    totals: null, checks: [], evidence: null, pageErrors: [], screenshot: null, error: null, next: [],
  };
  const refuse = message => {
    receipt.error = message;
    receipt.next = [message, "Fix the spec file and run again. Nothing was written."];
    return receipt;
  };

  let spec;
  let text;
  try {
    text = await readFile(specPath, "utf8");
    spec = JSON.parse(text);
  } catch (error) {
    return refuse(`spec could not be read or parsed: ${firstLine(error)}`);
  }
  let problems;
  try {
    problems = validateSpec(spec);
  } catch (error) {
    problems = [`the validator failed: ${firstLine(error)}`];
  }
  if (problems.length > 0) return refuse(`invalid spec: ${problems.join("; ")}`);

  receipt.spec = `${spec.name}@${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
  receipt.bug = spec.app?.bug ?? null;
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pageErrors = new Set();
  const consoleRecords = [];
  let consoleDropped = 0;
  const stepRecords = [];
  const contextRecords = [];
  const checks = [];
  let server = null;
  let browser = null;
  let shot = null;
  let browserVersion = null;

  try {
    if (spec.app?.url) {
      receipt.app = spec.app.url;
    } else {
      server = await startApp({ bug: spec.app?.bug });
      receipt.app = server.url;
    }
    browser = await chromium.launch({ headless: true, env: environmentWithoutKey() });
    browserVersion = `chromium ${browser.version()}`;
    const context = await browser.newContext(); // fresh visitor: no storage
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(Math.max(timeoutMs, 10000));
    page.on("pageerror", error => pageErrors.add(error.message));
    page.on("console", message => {
      if (message.type() === "error") pageErrors.add(message.text());
      if (consoleRecords.length < MAX_CONSOLE_RECORDS) consoleRecords.push({ type: "console", level: message.type(), text: clipValue(message.text(), 1000) });
      else consoleDropped += 1;
    });

    // Without app.start the run opens the app exactly as given (an app.url with a path keeps its path).
    const firstUrl = spec.app?.start === undefined ? receipt.app : new URL(spec.app.start, receipt.app).href;
    await page.goto(firstUrl, { waitUntil: "load" });
    const landed = new URL(page.url()); // after any redirect: the page whose revision is recorded
    receipt.revision = await page.locator('meta[name="app-revision"]').getAttribute("content", { timeout: 1000 }).catch(() => null);

    const ctx = createContext({ page, appUrl: receipt.app, specDir: dirname(resolve(specPath)), timeoutMs, checks });
    for (const [i, step] of spec.steps.entries()) {
      ctx.index = i + 1;
      const first = checks.length;
      stepRecords.push(await runStep(ctx, step));
      if (checks.slice(first).some(check => !check.pass) && contextRecords.filter(r => r.type === "context").length < MAX_FAILURE_CONTEXTS) {
        contextRecords.push(...await captureContext(ctx.page, ctx.index, !contextRecords.some(r => r.type === "screenshot")));
      }
    }
    if (spec.noPageErrors === true) {
      checks.push({
        step: 0, name: "no page errors", pass: pageErrors.size === 0, expected: [], actual: [...pageErrors],
        ...(pageErrors.size > 0 ? { hint: "The page logged errors. Read the console records in the evidence file." } : {}),
      });
    }

    // The built-in app can change on disk during a run; evidence from two builds proves neither.
    // Only a page that carries a revision can be compared, and only on the origin the server serves.
    if (server && receipt.revision !== null && landed.origin === new URL(receipt.app).origin) {
      const query = landed.pathname.startsWith("/fixtures/") ? `?path=${encodeURIComponent(landed.pathname)}` : "";
      const response = await fetch(new URL(`/__revision${query}`, receipt.app), { signal: AbortSignal.timeout(2000) });
      const now = (await response.json()).revision;
      if (now !== receipt.revision) {
        throw new Error(`the app changed while running (loaded ${receipt.revision}, now ${now}); evidence from two builds proves neither`);
      }
    }
    shot = await ctx.page.screenshot({ fullPage: true });
    if (checks.length === 0) {
      receipt.error = "No checks were recorded. Add assertions to the spec.";
    } else {
      receipt.verdict = checks.every(check => check.pass) ? "PASS" : "FAIL";
    }
  } catch (error) {
    receipt.verdict = "ERROR";
    receipt.error = `run failed: ${firstLine(error)}`;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await server.close().catch(() => {});
  }

  const { totals, failures } = summarize(checks);
  receipt.totals = totals;
  receipt.checks = failures;
  receipt.pageErrors = summarizePageErrors([...pageErrors]);
  if (receipt.verdict === "PASS") {
    receipt.next = ["These checks passed on this revision. They cover nothing else: read the screenshot for anything they missed."];
  } else if (receipt.verdict === "FAIL") {
    receipt.next = failures.map(check =>
      check.hint ?? `Fix "${check.name}" (step ${check.step}): expected ${JSON.stringify(check.expected)}, got ${JSON.stringify(check.actual)}.`);
    if (totals.omitted > 0) receipt.next.push(`${totals.omitted} more failed checks are in the evidence file.`);
  } else {
    receipt.next = [receipt.error ?? "Unknown error.", "Can't tell is not the same as broken: run it again once the app is stable."];
  }

  const records = [
    { type: "run", spec: receipt.spec, app: receipt.app, revision: receipt.revision, at: receipt.at, timeoutMs, start: spec.app?.start ?? null, node: process.version, platform: process.platform, browser: browserVersion },
    ...stepRecords,
    ...checks.map(check => ({ type: "check", ...check })),
    ...contextRecords,
    ...consoleRecords,
    ...(consoleDropped > 0 ? [{ type: "console-truncated", dropped: consoleDropped }] : []),
    ...[...pageErrors].map(message => ({ type: "pageerror", message })),
    { type: "summary", verdict: receipt.verdict, totals, error: receipt.error },
  ];
  const detail = { checks, steps: stepRecords, contexts: contextRecords, console: consoleRecords, pageErrors: [...pageErrors], receiptPath: null, evidencePath: null };

  // A receipt that cannot be written is not evidence: the run becomes ERROR, never a silent PASS.
  try {
    const paths = await writeReceipt(receipt, { shot, evidence: evidenceText(records), key, dir: receiptsDir });
    detail.receiptPath = paths.receiptPath;
    detail.evidencePath = paths.evidencePath;
  } catch (error) {
    receipt.verdict = "ERROR";
    receipt.error = `receipt write failed: ${firstLine(error)}`;
    receipt.next = [receipt.error, "No receipt file was written, so this run is not evidence. Fix the receipts directory and run again."];
  }
  Object.defineProperty(receipt, "detail", { value: detail, enumerable: false });
  return receipt;
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    // Real paths, so a symlink, a junction or a different drive-letter case still starts the CLI instead of exiting 0 silently.
    return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// CLI: node src/run-spec.js --spec <file.json> --key-file <path> [--receipts <dir>] [--json]
async function main(args) {
  const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  if (process.env.PROOF_LAB_KEY !== undefined) {
    throw new Error("PROOF_LAB_KEY is set in the environment; unset it and pass the key with --key-file <path>");
  }
  if (!flag("--key-file")) throw new Error("--key-file <path> is required: the signing key is read from a 0600 file");
  if (!flag("--spec")) throw new Error("--spec <file.json> is required");
  const key = await signingKeyFromFile(flag("--key-file"));
  const receipt = await runSpec({ specPath: flag("--spec"), key, receiptsDir: flag("--receipts") ?? DEFAULT_RECEIPTS });
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ...receipt, receiptFile: receipt.detail?.receiptPath ?? null, evidenceFile: receipt.detail?.evidencePath ?? null }, null, 2));
  } else {
    const totals = receipt.totals;
    console.log(`${receipt.verdict} ${receipt.spec ?? "(no spec)"} ${receipt.app ?? ""}`.trimEnd());
    if (totals) console.log(`  ${totals.checks} checks, ${totals.passed} passed, ${totals.failed} failed`);
    for (const check of receipt.checks) console.log(`  FAIL step ${check.step}: ${check.name}`);
    if (receipt.error) console.log(`  error: ${receipt.error}`);
    if (receipt.detail?.receiptPath) console.log(`  receipt:  ${receipt.detail.receiptPath}`);
    if (receipt.detail?.evidencePath) console.log(`  evidence: ${receipt.detail.evidencePath}`);
  }
  process.exitCode = EXIT[receipt.verdict];
}

if (isMain()) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    // Exit 2, never 1: 1 means "a check failed", and an unexpected exception is not that.
    console.error(`ERROR: ${firstLine(error)}`);
    process.exitCode = 2;
  }
}
