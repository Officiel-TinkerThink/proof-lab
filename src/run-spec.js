// run-spec: drive an app through a JSON spec, record every check, write a signed summary receipt and an evidence file.
// Verdicts: PASS (exit 0), FAIL (exit 1: a check failed), ERROR (exit 2: the run could not finish).
// Usage: node src/run-spec.js --spec <file.json> --key-file <path> [--receipts <dir>] [--json]
// The ops and fields a spec may use are in src/spec/schema.js and documented in SPECS.md.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { REVISION_HEADER, startApp } from "./server.js";
import { environmentWithoutKey, fixedStamp, signingKeyFromFile, writeReceipt } from "./chain.js";
import { clipValue, evidenceText, summarize, summarizePageErrors } from "./spec/evidence.js";
import { describeTarget } from "./spec/locate.js";
import { DEFAULT_TIMEOUT_MS } from "./spec/poll.js";
import { validateSpec } from "./spec/schema.js";
import { STEPS } from "./spec/steps.js";
import { bounded, firstLine, isMainModule, parseCli } from "./spec/util.js";

export { validateSpec };

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_RECEIPTS = process.env.PROOF_LAB_RECEIPTS ?? join(ROOT, "receipts");
const EXIT = { PASS: 0, FAIL: 1, ERROR: 2 };
const MAX_CONSOLE_RECORDS = 500;
const MAX_PAGE_ERRORS_KEPT = 100;
const MAX_FAILURE_CONTEXTS = 5;
const MAX_REVISION_RECHECKS = 50;
const ARIA_CHARS = 8000;
// Playwright times out its own actions. This is the margin on top of a step's budget before the runner gives up on a
// step that never returns at all (a frozen page does not answer count() or title()).
const STEP_GRACE_MS = 20000;

// "check" names the step in the receipt. "name" without a role is the older spelling of it.
function labelOf(step, index) {
  if (step.check !== undefined) return step.check;
  if (step.name !== undefined && step.role === undefined) return step.name;
  return `step ${index}: ${step.op} ${describeTarget(step)}`.trim();
}

function createContext({ page, appUrl, specDir, timeoutMs, checks }) {
  const ctx = {
    page, appUrl, specDir, timeoutMs, checks, index: 0, suppressed: [],
    record(step, pass, expected, actual, error) {
      // An optional step is allowed to fail: it leaves no failed check, but the evidence timeline says it did.
      if (!pass && step.optional) {
        ctx.suppressed.push(`${labelOf(step, ctx.index)}: expected ${JSON.stringify(clipValue(expected))}, got ${JSON.stringify(clipValue(actual))}`);
        return;
      }
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
  const suppressedBefore = ctx.suppressed.length;
  const started = performance.now();
  const record = { type: "step", step: ctx.index, op: step.op, check: labelOf(step, ctx.index) };
  const target = describeTarget(step);
  if (target) record.target = target;
  try {
    await bounded(STEPS[step.op](ctx, step), (step.timeout ?? ctx.timeoutMs) + STEP_GRACE_MS, `step ${ctx.index} (${step.op})`);
  } catch (error) {
    if (step.optional) {
      record.skipped = firstLine(error);
    } else {
      const hint = step.hint ?? `The app did not allow step ${ctx.index} (${step.op}${target ? ` ${target}` : ""}).`;
      ctx.record({ ...step, hint }, false, `${step.op} completes`, null, firstLine(error));
    }
  }
  const suppressed = ctx.suppressed.slice(suppressedBefore);
  if (suppressed.length > 0 && record.skipped === undefined) record.skipped = `optional check failed: ${suppressed[0]}`;
  record.ms = Math.round(performance.now() - started);
  record.ok = ctx.checks.slice(first).every(check => check.pass);
  return record;
}

// What the page looked like when a check failed: the address, the title, and the accessibility tree (what an agent
// "sees"). The first failure also gets a small picture. Every call is bounded: a frozen page answers none of them.
async function captureContext(page, step, withPicture) {
  const context = { type: "context", step, url: null, title: null, aria: null };
  const records = [context];
  try {
    context.url = page.url();
    context.title = await bounded(page.title(), 2000, "reading the title");
  } catch { /* the page may be gone or frozen */ }
  try {
    context.aria = clipValue(await page.locator("body").ariaSnapshot({ timeout: 2000 }), ARIA_CHARS);
  } catch (error) {
    context.ariaError = firstLine(error);
  }
  if (withPicture) {
    try {
      const jpeg = await bounded(page.screenshot({ type: "jpeg", quality: 60, timeout: 3000 }), 5000, "taking the picture");
      records.push({ type: "screenshot", step, mime: "image/jpeg", base64: jpeg.toString("base64") });
    } catch { /* no picture is not a failure */ }
  }
  return records;
}

// Did any page the run loaded change on the server while the run was going? Every page of the app says its revision in a
// response header. A page loaded twice with two revisions is caught as it happens; a page loaded once is asked again now.
async function revisionDrift(seen) {
  for (const [url, revision] of [...seen].slice(0, MAX_REVISION_RECHECKS)) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "manual" });
      const now = response.headers.get(REVISION_HEADER);
      if (now !== null && now !== revision) return `${new URL(url).pathname} was ${revision} when loaded and is ${now} now`;
    } catch { /* an app that cannot be asked again cannot be compared; the run itself stands */ }
  }
  return null;
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
  let pageErrorsDropped = 0;
  const noteError = message => {
    if (pageErrors.size < MAX_PAGE_ERRORS_KEPT) pageErrors.add(clipValue(message, 1000));
    else if (!pageErrors.has(clipValue(message, 1000))) pageErrorsDropped += 1;
  };
  const consoleRecords = [];
  let consoleDropped = 0;
  const stepRecords = [];
  const contextRecords = [];
  const checks = [];
  const seenRevisions = new Map();
  let changedWhileRunning = null;
  let server = null;
  let browser = null;
  let shot = null;
  let browserVersion = null;
  let completed = false;

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
    page.on("pageerror", error => noteError(error.message));
    page.on("console", message => {
      if (message.type() === "error") noteError(message.text());
      if (consoleRecords.length < MAX_CONSOLE_RECORDS) consoleRecords.push({ type: "console", level: message.type(), text: clipValue(message.text(), 1000) });
      else consoleDropped += 1;
    });
    page.on("response", response => {
      try {
        if (response.request().resourceType() !== "document") return;
        const revision = response.headers()[REVISION_HEADER];
        if (!revision) return;
        const url = response.url();
        if (seenRevisions.has(url) && seenRevisions.get(url) !== revision) {
          changedWhileRunning ??= `${new URL(url).pathname} was ${seenRevisions.get(url)} and became ${revision} between two loads`;
        }
        seenRevisions.set(url, revision);
      } catch { /* a response of a page that is already closing */ }
    });

    // Without app.start the run opens the app exactly as given (an app.url with a path keeps its path).
    const firstUrl = spec.app?.start === undefined ? receipt.app : new URL(spec.app.start, receipt.app).href;
    await page.goto(firstUrl, { waitUntil: "load" });
    receipt.revision = await page.locator('meta[name="app-revision"]').getAttribute("content", { timeout: 1000 }).catch(() => null);

    const ctx = createContext({ page, appUrl: receipt.app, specDir: dirname(resolve(specPath)), timeoutMs, checks });
    for (const [i, step] of spec.steps.entries()) {
      ctx.index = i + 1;
      const first = checks.length;
      stepRecords.push(await runStep(ctx, step));
      const failedNow = checks.slice(first).some(check => !check.pass);
      if (failedNow && contextRecords.filter(record => record.type === "context").length < MAX_FAILURE_CONTEXTS) {
        const pictured = contextRecords.some(record => record.type === "screenshot");
        const captured = await bounded(captureContext(ctx.page, ctx.index, !pictured), 12000, "capturing the page")
          .catch(error => [{ type: "context", step: ctx.index, url: null, title: null, aria: null, ariaError: firstLine(error) }]);
        contextRecords.push(...captured);
      }
    }

    // The app can change on disk during a run; evidence from two builds proves neither.
    const drift = changedWhileRunning ?? await revisionDrift(seenRevisions);
    if (drift) throw new Error(`the app changed while running (${drift}); evidence from two builds proves neither`);
    shot = await ctx.page.screenshot({ fullPage: true });
    completed = true;
  } catch (error) {
    receipt.verdict = "ERROR";
    receipt.error = `run failed: ${firstLine(error)}`;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await server.close().catch(() => {});
  }

  if (completed) {
    // Last, so an error thrown late in the run (during the guard or the final screenshot) is still seen by this check.
    if (spec.noPageErrors === true) {
      checks.push({
        step: 0, name: "no page errors", pass: pageErrors.size === 0, expected: [], actual: summarizePageErrors([...pageErrors]),
        ...(pageErrors.size > 0 ? { hint: "The page logged errors. Read the console records in the evidence file." } : {}),
      });
    }
    if (checks.length === 0) {
      receipt.error = "No checks were recorded. Add assertions to the spec.";
    } else {
      receipt.verdict = checks.every(check => check.pass) ? "PASS" : "FAIL";
    }
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
    ...(pageErrorsDropped > 0 ? [{ type: "pageerror-truncated", dropped: pageErrorsDropped }] : []),
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
    receipt.next = [receipt.error, "This run is not evidence. Check the receipts directory (and any file named in the error), fix it and run again."];
  }
  Object.defineProperty(receipt, "detail", { value: detail, enumerable: false });
  return receipt;
}

const CLI_OPTIONS = {
  spec: { type: "string" },
  "key-file": { type: "string" },
  receipts: { type: "string" },
  json: { type: "boolean" },
};

// CLI: node src/run-spec.js --spec <file.json> --key-file <path> [--receipts <dir>] [--json]. Returns the exit code.
export async function main(args) {
  const values = parseCli(args, CLI_OPTIONS);
  if (process.env.PROOF_LAB_KEY !== undefined) {
    throw new Error("PROOF_LAB_KEY is set in the environment; unset it and pass the key with --key-file <path>");
  }
  if (!values["key-file"]) throw new Error("--key-file <path> is required: the signing key is read from a 0600 file");
  if (!values.spec) throw new Error("--spec <file.json> is required");
  const key = await signingKeyFromFile(values["key-file"]);
  const receipt = await runSpec({ specPath: values.spec, key, receiptsDir: values.receipts ?? DEFAULT_RECEIPTS });
  if (values.json) {
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
  return EXIT[receipt.verdict];
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    // Exit 2, never 1: 1 means "a check failed", and an unexpected exception is not that.
    console.error(`ERROR: ${firstLine(error)}`);
    process.exitCode = 2;
  }
}
