import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSpec } from "../src/run-spec.js";
import { verifyChain } from "../src/chain.js";
import { KEY, TIMEOUT, explain, page, withRun } from "./spec-helpers.mjs";

const WAITLIST = fileURLToPath(new URL("../specs/waitlist.json", import.meta.url));
const FIELD_ORDER = ["verdict", "app", "bug", "spec", "revision", "at", "totals", "checks", "evidence", "pageErrors", "screenshot", "error", "next", "keyId", "prevHash", "hash", "mac"];

const records = async path => (await readFile(path, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
const ofType = (all, type) => all.filter(record => record.type === type);
const waitlist = async extra => ({ ...JSON.parse(await readFile(WAITLIST, "utf8")), ...extra });

test("a passing run: the receipt is a small summary, the evidence holds the detail, both verify", TIMEOUT, async () => {
  await withRun(await waitlist(), async (receipt, dir) => {
    assert.equal(receipt.verdict, "PASS", explain(receipt));
    assert.deepEqual(receipt.totals, { checks: 7, passed: 7, failed: 0, omitted: 0 });
    assert.deepEqual(receipt.checks, [], "a passing receipt lists no checks");
    assert.deepEqual(Object.keys(receipt), FIELD_ORDER);
    assert.equal(JSON.stringify(receipt).includes("detail"), false, "detail is in memory only");

    const { receiptPath, evidencePath } = receipt.detail;
    assert.ok((await stat(receiptPath)).size < 2500, "the receipt stays small");
    const bytes = await readFile(evidencePath);
    assert.equal(receipt.evidence.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(receipt.evidence.bytes, bytes.length);

    const all = await records(evidencePath);
    assert.equal(ofType(all, "run").length, 1);
    assert.equal(ofType(all, "step").length, 11);
    assert.equal(ofType(all, "check").length, 7);
    assert.equal(ofType(all, "summary").length, 1);
    assert.ok(ofType(all, "check").every(check => check.pass === true && Number.isInteger(check.step)));
    assert.ok(ofType(all, "step").every(step => step.ok === true && typeof step.ms === "number"));
    const run = ofType(all, "run")[0];
    assert.equal(run.revision, receipt.revision);
    assert.match(run.browser, /^chromium /);
    assert.equal(ofType(all, "summary")[0].verdict, "PASS");

    assert.deepEqual(await verifyChain(dir, KEY), { problems: [], checked: 1, missingEvidence: [] });
    assert.equal((await readdir(dir)).length, 3, "receipt, screenshot and evidence");
  });
});

test("a failing run: the receipt lists the failures with step numbers, the evidence shows the page then", TIMEOUT, async () => {
  await withRun(await waitlist({ app: { bug: "no-persist" } }), async receipt => {
    assert.equal(receipt.verdict, "FAIL");
    assert.equal(receipt.totals.failed, receipt.checks.length);
    assert.equal(receipt.totals.passed + receipt.totals.failed, receipt.totals.checks);
    assert.ok(receipt.checks.length >= 1 && receipt.checks.every(check => check.pass === false && Number.isInteger(check.step)));
    const survive = receipt.checks.find(check => check.name === "status survives reload");
    assert.deepEqual([survive.expected, survive.actual, survive.step], ["waitlisted", "none", 8]);
    assert.match(survive.hint, /localStorage/);
    assert.ok(receipt.next.some(line => /localStorage/.test(line)));

    const all = await records(receipt.detail.evidencePath);
    const steps = ofType(all, "step");
    for (const failed of receipt.checks) assert.equal(steps.find(step => step.step === failed.step).ok, false);

    const contexts = ofType(all, "context");
    assert.ok(contexts.length >= 1 && contexts.length <= 5);
    assert.match(contexts[0].url, /^http:\/\/127\.0\.0\.1:\d+\//);
    assert.equal(typeof contexts[0].aria, "string");
    assert.ok(contexts[0].aria.length > 20, "an accessibility snapshot of the page");
    const pictures = ofType(all, "screenshot");
    assert.equal(pictures.length, 1, "only the first failure gets a picture");
    assert.equal(pictures[0].mime, "image/jpeg");
    assert.ok(pictures[0].base64.startsWith("/9j/"), "a JPEG");
  });
});

test("many failures: the receipt lists the first 20 and counts the rest, the evidence keeps all", TIMEOUT, async () => {
  const steps = Array.from({ length: 25 }, (_, i) => ({ op: "assertText", check: `bad ${i}`, testId: "result", equals: `nope ${i}`, timeout: 0 }));
  await withRun(page("/fixtures/forms.html", steps), async receipt => {
    assert.equal(receipt.verdict, "FAIL");
    assert.deepEqual(receipt.totals, { checks: 25, passed: 0, failed: 25, omitted: 5 });
    assert.equal(receipt.checks.length, 20);
    assert.ok(receipt.next.includes("5 more failed checks are in the evidence file."));
    const all = await records(receipt.detail.evidencePath);
    assert.equal(ofType(all, "check").length, 25);
    assert.equal(ofType(all, "context").length, 5, "page context is kept for the first five failures only");
  });
});

test("long values are clipped in the receipt and whole in the evidence", TIMEOUT, async () => {
  const long = "q".repeat(1000);
  const spec = page("/fixtures/forms.html", [
    { op: "fill", label: "Bio", value: long },
    { op: "assertValue", check: "bio is short", label: "Bio", equals: "x", timeout: 0 },
  ]);
  await withRun(spec, async receipt => {
    assert.equal(receipt.verdict, "FAIL");
    const [failure] = receipt.checks;
    assert.ok(failure.actual.length < 300);
    assert.match(failure.actual, /\[800 more characters\]$/);
    const full = ofType(await records(receipt.detail.evidencePath), "check")[0];
    assert.equal(full.actual, long);
  });
});

test("an optional step that fails leaves no check and shows in the evidence timeline", TIMEOUT, async () => {
  const spec = page("/fixtures/forms.html", [
    { op: "click", selector: "#no-such", optional: true, timeout: 200 },
    { op: "assertState", check: "page loaded", label: "Name", state: "enabled" },
  ]);
  await withRun(spec, async receipt => {
    assert.equal(receipt.verdict, "PASS", explain(receipt));
    assert.equal(receipt.totals.checks, 1);
    const skipped = ofType(await records(receipt.detail.evidencePath), "step")[0];
    assert.equal(skipped.ok, true);
    assert.match(skipped.skipped, /Timeout|waiting for locator/);
  });
});

test("console output and page errors are kept; noPageErrors turns an error into a failed check", TIMEOUT, async () => {
  const failing = page("/fixtures/network.html", [
    { op: "click", role: "button", name: "Log error" },
    { op: "assertText", check: "page loaded", testId: "items-state", equals: "idle" },
  ], { noPageErrors: true });
  await withRun(failing, async receipt => {
    assert.equal(receipt.verdict, "FAIL");
    const noErrors = receipt.checks.find(check => check.name === "no page errors");
    assert.equal(noErrors.step, 0);
    assert.ok(receipt.pageErrors.includes("logged error"));
    const consoleRecords = ofType(await records(receipt.detail.evidencePath), "console");
    assert.ok(consoleRecords.some(record => record.level === "error" && record.text === "logged error"));
  });

  const clean = page("/fixtures/forms.html", [{ op: "assertState", check: "page loaded", label: "Name", state: "enabled" }], { noPageErrors: true });
  await withRun(clean, async receipt => {
    assert.equal(receipt.verdict, "PASS", explain(receipt));
    assert.equal(receipt.totals.checks, 2);
  });
});

test("an unreachable app is ERROR, and the receipt and evidence are still written and verify", TIMEOUT, async () => {
  const spec = { name: "unreachable", app: { url: "http://127.0.0.1:1/" }, steps: [{ op: "assertUrl", contains: "x" }] };
  await withRun(spec, async (receipt, dir) => {
    assert.equal(receipt.verdict, "ERROR");
    assert.match(receipt.error, /^run failed:/);
    assert.deepEqual(receipt.totals, { checks: 0, passed: 0, failed: 0, omitted: 0 });
    const summary = ofType(await records(receipt.detail.evidencePath), "summary")[0];
    assert.equal(summary.verdict, "ERROR");
    assert.deepEqual((await verifyChain(dir, KEY)).problems, []);
  });
});

test("a receipt that cannot be written makes the run ERROR and leaves nothing half-written", TIMEOUT, async () => {
  const workdir = await mkdtemp(join(tmpdir(), "proof-badreceipts-"));
  try {
    const notADirectory = join(workdir, "file.txt");
    await writeFile(notADirectory, "a file where the receipts directory should be");
    const specPath = join(workdir, "spec.json");
    await writeFile(specPath, JSON.stringify(page("/fixtures/forms.html", [{ op: "assertState", check: "loaded", label: "Name", state: "enabled" }])));
    const receipt = await runSpec({ specPath, key: KEY, receiptsDir: notADirectory });
    assert.equal(receipt.verdict, "ERROR");
    assert.match(receipt.error, /^receipt write failed:/);
    assert.equal(receipt.evidence, null);
    assert.equal(receipt.hash, undefined);
    assert.equal(receipt.detail.receiptPath, null);
    assert.equal(await readFile(notADirectory, "utf8"), "a file where the receipts directory should be");
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});
