// run-spec: drive an app through a JSON spec, record every check, write a signed summary receipt and an evidence file.
// Verdicts: PASS (exit 0), FAIL (exit 1: a check failed), ERROR (exit 2: the run could not finish).
// Usage: node src/run-spec.js --spec <file.json> --key-file <path> [--receipts <dir>] [--json]
// The ops and fields a spec may use are in src/spec/schema.js and documented in SPECS.md.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REVISION_HEADER, startApp } from "./server.js";
import { fixedStamp, signingKeyFromFile, writeReceipt } from "./chain.js";
import { clipValue, evidenceText, hideAddressText, hideQuery, hideTokenSegments, isSensitiveStep, maskValue, redactClip, redactSecrets, scrubRecord, specLabel, scrubValue, summarize, summarizePageErrors, summarizeReviews } from "./spec/evidence.js";
import { absentWaitMs, withExpectations } from "./spec/expect.js";
import { describeTarget } from "./spec/locate.js";
import { DEFAULT_TIMEOUT_MS } from "./spec/poll.js";
import { validateSpec } from "./spec/schema.js";
import { openSession } from "./spec/session.js";
import { recordWriteFailure, scrubReceipt, scrubStoredPaths } from "./receipt-scrub.js";
import { scrubReceiptFile } from "./status.js";
import { STEPS } from "./spec/steps.js";
import { bounded, firstLine, isMainModule, parseCli } from "./spec/util.js";

export { validateSpec };

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_RECEIPTS = process.env.PROOF_LAB_RECEIPTS ?? join(ROOT, "receipts");
const EXIT = { PASS: 0, FAIL: 1, ERROR: 2 };
// Every check passed but the spec listed claims only a human can judge: not "done", and not a failure either.
export const EXIT_NEEDS_REVIEW = 3;
const exitCodeOf = receipt => (receipt.verdict === "PASS" && receipt.review?.total > 0 ? EXIT_NEEDS_REVIEW : EXIT[receipt.verdict]);
const MAX_CONSOLE_RECORDS = 500;
const MAX_PAGE_ERRORS_KEPT = 100;
const MAX_FAILURE_CONTEXTS = 5;
const MAX_REVISION_RECHECKS = 50;
const ARIA_CHARS = 8000;
// Fields of an evidence record that are the run's own bookkeeping, not page or spec text (the receipt's are in receipt-scrub.js).
const EVIDENCE_BOOKKEEPING = ["type", "spec", "at", "mime", "base64"];
// Playwright times out its own actions. This is the margin on top of a step's budget before the runner gives up on a
// step that never returns at all (a frozen page does not answer count() or title()).
export const stepLimits = { graceMs: 20000 }; // an object so a test can shorten it

// "check" names the step in the receipt. "name" without a role is the older spelling of it.
function labelOf(step, index) {
  if (step.check !== undefined) return step.check;
  if (step.name !== undefined && step.role === undefined) return step.name;
  return `step ${index}: ${step.op} ${describeTarget(step)}`.trim();
}

// adopt(page) gives a popup the hooks and timeouts of the first page (see openSession); ctx.page moves to a popup on switchTo.
export function createContext({ page, adopt = page => page, appUrl, specDir, timeoutMs, checks }) {
  const ctx = {
    // A tab the app closed stays the current page: a later step on it fails honestly instead of silently reading another tab.
    page, adopt, appUrl, specDir, timeoutMs, checks, index: 0, suppressed: [], reviews: [],
    record(step, pass, rawExpected, rawActual, rawError) {
      // What the page or the spec shows can hold a credential (an address, a field value, an error that quotes one):
      // every value is scrubbed here, once, before it can reach the receipt or the evidence file.
      // A step that names a credential (a storage key "authToken", a field labelled "Password") never records the value it
      // read or compared: only its length and a keyed fingerprint, as for cookies. The secret-making name is not inside the value.
      const hide = value => (isSensitiveStep(step) && typeof value !== "boolean" && value !== null && value !== undefined
        ? `(masked, ${maskValue(value)})` : value);
      // "<op> completes" is the runner's own label for a step that could not run, not a value anyone typed.
      const expected = scrubValue(rawExpected === `${step.op} completes` ? rawExpected : hide(rawExpected));
      const actual = scrubValue(hide(rawActual));
      const error = rawError === undefined ? undefined : scrubValue(rawError);
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
export async function runStep(ctx, step) {
  const first = ctx.checks.length;
  const suppressedBefore = ctx.suppressed.length;
  ctx.epoch = (ctx.epoch ?? 0) + 1; // work left over from an earlier, abandoned step can tell that it is stale
  const started = performance.now();
  const record = { type: "step", step: ctx.index, op: step.op, check: labelOf(step, ctx.index) };
  const target = describeTarget(step);
  if (target) record.target = target;
  // Listeners a step arms (dialog, popup) are removed when the step ends, also when it was given up on: otherwise an
  // abandoned step's handler would answer a later step's dialog.
  const cleanups = [];
  try {
    // The step sees the run through a view whose writes stop counting once the step is over: bounded() only races the
    // step, it cannot cancel it, so a step that hung past its limit and then recovers must not record a check under
    // the next step's number or move the run to another tab.
    const epoch = ctx.epoch;
    const live = () => ctx.epoch === epoch;
    const stepCtx = Object.create(ctx, {
      record: { value: (...args) => { if (live()) ctx.record(...args); } },
      page: { get: () => ctx.page, set: page => { if (live()) ctx.page = page; } },
      onStepEnd: { value: cleanup => { cleanups.push(cleanup); } },
    });
    const act = () => STEPS[step.op](stepCtx, step);
    await bounded(step.expect === undefined ? act() : withExpectations(stepCtx, step, labelOf, act), (step.timeout ?? ctx.timeoutMs) + stepLimits.graceMs + absentWaitMs(step), `step ${ctx.index} (${step.op})`);
  } catch (error) {
    ctx.epoch += 1; // the step is given up on: anything it still has in flight must not touch the run any more
    if (step.optional) {
      record.skipped = firstLine(error);
    } else {
      const hint = step.hint ?? `The app did not allow step ${ctx.index} (${step.op}${target ? ` ${target}` : ""}).`;
      ctx.record({ ...step, hint }, false, `${step.op} completes`, null, firstLine(error));
    }
  } finally {
    for (const cleanup of cleanups) cleanup();
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
    context.url = clipValue(hideQuery(page.url()), 300);
    context.title = clipValue(redactSecrets(await bounded(page.title(), 2000, "reading the title")), 300);
  } catch { /* the page may be gone or frozen */ }
  try {
    context.aria = clipValue(redactSecrets(await page.locator("body").ariaSnapshot({ timeout: 2000 })), ARIA_CHARS);
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
      if (now !== null && now !== revision) return `${hideTokenSegments(new URL(url).pathname)} was ${revision} when loaded and is ${now} now`;
    } catch { /* an app that cannot be asked again cannot be compared; the run itself stands */ }
  }
  return null;
}

// Runs one spec file. Returns the receipt as stored, plus a non-stored `detail` (the evidence, in memory).
// An invalid spec returns ERROR and writes nothing.
export async function runSpec({ specPath, key, receiptsDir = DEFAULT_RECEIPTS } = {}) {
  const receipt = {
    verdict: "ERROR", app: null, bug: null, spec: null, revision: null, at: fixedStamp(),
    totals: null, checks: [], review: { total: 0, items: [] }, evidence: null, pageErrors: [], screenshot: null, error: null, next: [],
  };
  const refuse = raw => {
    const message = redactSecrets(raw);
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
    // A JSON.parse message can quote the file's own bytes, so only the kind of failure is reported.
    return refuse(`spec could not be ${error instanceof SyntaxError ? "parsed as JSON" : `read (${error?.code ?? "error"})`}`);
  }
  let problems;
  try {
    problems = validateSpec(spec);
  } catch (error) {
    problems = [`the validator failed: ${firstLine(error)}`];
  }
  if (problems.length > 0) return refuse(`invalid spec: ${problems.join("; ")}`);

  receipt.spec = specLabel(spec.name, createHash("sha256").update(text).digest("hex").slice(0, 12));
  receipt.bug = spec.app?.bug ?? null;
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pageErrors = new Set();
  let pageErrorsDropped = 0;
  const pageErrorLengths = new Map();
  const noteError = raw => {
    const message = redactClip(raw, 1000);
    // The length is kept only for a message that is kept: the map cannot outgrow the capped set.
    if (pageErrors.size < MAX_PAGE_ERRORS_KEPT) {
      pageErrors.add(message);
      if (!pageErrorLengths.has(message)) pageErrorLengths.set(message, String(raw).length);
    }
    else if (!pageErrors.has(message)) pageErrorsDropped += 1;
  };
  const consoleRecords = [];
  let consoleDropped = 0;
  const stepRecords = [];
  const contextRecords = [];
  const checks = [];
  let reviews = [];
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
    // Without app.start the run opens the app exactly as given (an app.url with a path keeps its path).
    const firstUrl = spec.app?.start === undefined ? receipt.app : new URL(spec.app.start, receipt.app).href;
    const session = await openSession({
      firstUrl,
      timeoutMs,
      env: spec.env,
      hooks: {
        onLaunch: version => { browserVersion = version; },
        onPageError: message => noteError(message),
        onConsole: (level, text) => {
          if (level === "error") noteError(text);
          if (consoleRecords.length < MAX_CONSOLE_RECORDS) consoleRecords.push({ type: "console", level, text: redactClip(text, 1000) });
          else consoleDropped += 1;
        },
        onResponse: response => {
          try {
            if (response.request().resourceType() !== "document") return;
            const revision = response.headers()[REVISION_HEADER];
            if (!revision) return;
            const url = response.url();
            if (seenRevisions.has(url) && seenRevisions.get(url) !== revision) {
              changedWhileRunning ??= `${hideTokenSegments(new URL(url).pathname)} was ${seenRevisions.get(url)} and became ${revision} between two loads`;
            }
            seenRevisions.set(url, revision);
          } catch { /* a response of a page that is already closing */ }
        },
      },
    });
    browser = session.browser;
    const page = session.page;
    receipt.revision = await page.locator('meta[name="app-revision"]').getAttribute("content", { timeout: 1000 }).catch(() => null);

    const ctx = createContext({ page, adopt: session.adopt, appUrl: receipt.app, specDir: dirname(resolve(specPath)), timeoutMs, checks });
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
    reviews = ctx.reviews;
    // A popup that closed itself leaves no page to photograph: take the last tab that is still open.
    const finalPage = ctx.page.isClosed() ? ctx.page.context().pages().at(-1) ?? ctx.page : ctx.page;
    shot = await finalPage.screenshot({ fullPage: true });
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
        step: 0, name: "no page errors", pass: pageErrors.size === 0, expected: [], actual: summarizePageErrors([...pageErrors], pageErrorLengths),
        ...(pageErrors.size > 0 ? { hint: "The page logged errors. Read the console records in the evidence file." } : {}),
      });
    }
    if (checks.length === 0) {
      receipt.error = "No checks were recorded. Add assertions to the spec.";
    } else {
      receipt.verdict = checks.every(check => check.pass) ? "PASS" : "FAIL";
    }
  }

  // Scrub the checks in place first: the receipt's failures, its next steps and the evidence records are all built from them.
  checks.forEach(check => Object.assign(check, scrubRecord(check)));
  const { totals, failures } = summarize(checks);
  receipt.totals = totals;
  receipt.checks = failures;
  receipt.review = summarizeReviews(reviews);
  receipt.pageErrors = summarizePageErrors([...pageErrors], pageErrorLengths);
  if (receipt.verdict === "PASS") {
    receipt.next = reviews.length > 0
      ? [`Every check passed, but ${reviews.length} claim(s) need a human: ${reviews.slice(0, 5).map(item => item.name).join("; ")}. Do not say done; hand a human the receipt.`]
      : ["These checks passed on this revision. They cover nothing else: read the screenshot for anything they missed."];
  } else if (receipt.verdict === "FAIL") {
    receipt.next = failures.map(check =>
      check.hint ?? `Fix "${check.name}" (step ${check.step}): expected ${JSON.stringify(check.expected)}, got ${JSON.stringify(check.actual)}.`);
    if (totals.omitted > 0) receipt.next.push(`${totals.omitted} more failed checks are in the evidence file.`);
  } else {
    receipt.next = [receipt.error ?? "Unknown error.", "Can't tell is not the same as broken: run it again once the app is stable."];
  }

  // Choke point: the receipt and every evidence record are scrubbed here, once, whichever code path produced the text
  // (a step error, a hint, a review note, a context, a page-supplied revision). Redaction at the sources stays as a second layer.
  scrubReceipt(receipt);

  const records = [
    { type: "run", spec: receipt.spec, app: receipt.app, revision: receipt.revision, at: receipt.at, timeoutMs, start: typeof spec.app?.start === "string" ? hideAddressText(spec.app.start) : spec.app?.start ?? null, node: process.version, platform: process.platform, browser: browserVersion, env: spec.env ?? null },
    ...stepRecords,
    ...checks.map(check => ({ type: "check", ...check })),
    ...reviews.map(item => ({ type: "review", ...item })),
    ...contextRecords,
    ...consoleRecords,
    ...(consoleDropped > 0 ? [{ type: "console-truncated", dropped: consoleDropped }] : []),
    ...[...pageErrors].map(message => ({ type: "pageerror", message })),
    ...(pageErrorsDropped > 0 ? [{ type: "pageerror-truncated", dropped: pageErrorsDropped }] : []),
    { type: "summary", verdict: receipt.verdict, totals, error: receipt.error },
  ];
  records.forEach((record, index) => { records[index] = scrubRecord(record, EVIDENCE_BOOKKEEPING); });
  // The detail a caller gets in process is scrubbed like the files: a consumer added later cannot be the one that leaks.
  // The same rule as the files (a screenshot's base64 is a picture, not text), so the two cannot differ.
  const asFiled = list => list.map(record => scrubRecord(record, EVIDENCE_BOOKKEEPING));
  const detail = { checks, steps: asFiled(stepRecords), contexts: asFiled(contextRecords), console: asFiled(consoleRecords), pageErrors: [...pageErrors], receiptPath: null, evidencePath: null };

  // The steps after the scrub point (see receipt-scrub.js): what a failed write and writeReceipt add is scrubbed as well.
  try {
    const paths = await writeReceipt(receipt, { shot, evidence: evidenceText(records), key, dir: receiptsDir });
    detail.receiptPath = paths.receiptPath;
    detail.evidencePath = paths.evidencePath;
  } catch (error) {
    recordWriteFailure(receipt, error, "This run is not evidence. Check the receipts directory (and any file named in the error), fix it and run again.");
  }
  scrubStoredPaths(receipt); // detail keeps the real paths for callers
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
    console.log(JSON.stringify({ ...receipt, receiptFile: receipt.detail?.receiptPath ? scrubReceiptFile(receipt.detail.receiptPath) : null, evidenceFile: receipt.detail?.evidencePath ? scrubReceiptFile(receipt.detail.evidencePath) : null }, null, 2));
  } else {
    const totals = receipt.totals;
    console.log(`${receipt.verdict} ${receipt.spec ?? "(no spec)"} ${receipt.app ?? ""}`.trimEnd());
    if (totals) console.log(`  ${totals.checks} checks, ${totals.passed} passed, ${totals.failed} failed`);
    for (const check of receipt.checks) console.log(`  FAIL step ${check.step}: ${check.name}`);
    if (receipt.review?.total > 0) {
      console.log(`  NEEDS REVIEW: ${receipt.review.total} claim(s) only a human can judge (the run is not "done")`);
      for (const item of receipt.review.items) console.log(`    step ${item.step}: ${item.name}${item.note ? ` (${item.note})` : ""}`);
    }
    if (receipt.error) console.log(`  error: ${receipt.error}`);
    if (receipt.detail?.receiptPath) console.log(`  receipt:  ${scrubReceiptFile(receipt.detail.receiptPath)}`);
    if (receipt.detail?.evidencePath) console.log(`  evidence: ${scrubReceiptFile(receipt.detail.evidencePath)}`);
  }
  return exitCodeOf(receipt);
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    // Exit 2, never 1: 1 means "a check failed", and an unexpected exception is not that.
    console.error(`ERROR: ${redactSecrets(firstLine(error))}`);
    process.exitCode = 2;
  }
}
