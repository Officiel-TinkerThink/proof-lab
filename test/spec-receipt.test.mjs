import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSpec } from "../src/run-spec.js";
import { scrubReceipt, writeScrubbedReceipt } from "../src/receipt-scrub.js";
import { LAB_FILE_NAME, fixedStamp, verifyChain } from "../src/chain.js";
import { KEY, TIMEOUT, explain, page, withRun } from "./spec-helpers.mjs";

const WAITLIST = fileURLToPath(new URL("../specs/waitlist.json", import.meta.url));
const FIELD_ORDER = ["verdict", "app", "bug", "spec", "revision", "at", "totals", "checks", "review", "evidence", "pageErrors", "screenshot", "error", "next", "keyId", "prevHash", "hash", "mac"];

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
  // Words, not one opaque run: a 40+ character run of letters is credential-shaped and is redacted on purpose.
  const long = "word ".repeat(200);
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

// A tiny app that sends its revision in a header, and changes it from the Nth request of "/" on.
async function appWithRevisions(changeAtRequest) {
  let requests = 0;
  const server = http.createServer((req, res) => {
    if (req.url !== "/") {
      res.writeHead(204);
      res.end();
      return;
    }
    requests += 1;
    const revision = requests >= changeAtRequest ? "bbbbbbbbbbbb" : "aaaaaaaaaaaa";
    res.writeHead(200, { "content-type": "text/html", "x-app-revision": revision });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="app-revision" content="${revision}"><title>t</title><link rel="icon" href="data:,"></head><body><h1>hi</h1></body></html>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

test("a page that changes between two loads, or after the run, makes the run ERROR; a steady one passes", TIMEOUT, async () => {
  const spec = (url, steps) => ({ name: "drift", app: { url }, steps });
  const heading = { op: "assertText", check: "heading", selector: "h1", equals: "hi" };

  const steady = await appWithRevisions(Number.POSITIVE_INFINITY);
  try {
    await withRun(spec(steady.url, [heading, { op: "reload" }, heading]), async receipt => {
      assert.equal(receipt.verdict, "PASS", explain(receipt));
      assert.equal(receipt.revision, "aaaaaaaaaaaa");
    });
  } finally {
    await steady.close();
  }

  const reloaded = await appWithRevisions(2); // the reload is the second request
  try {
    await withRun(spec(reloaded.url, [heading, { op: "reload" }, heading]), async receipt => {
      assert.equal(receipt.verdict, "ERROR");
      assert.match(receipt.error, /the app changed while running \(\/ was aaaaaaaaaaaa and became bbbbbbbbbbbb between two loads\)/);
    });
  } finally {
    await reloaded.close();
  }

  const afterwards = await appWithRevisions(2); // no reload: the check at the end is the second request
  try {
    await withRun(spec(afterwards.url, [heading]), async receipt => {
      assert.equal(receipt.verdict, "ERROR");
      assert.match(receipt.error, /\/ was aaaaaaaaaaaa when loaded and is bbbbbbbbbbbb now/);
    });
  } finally {
    await afterwards.close();
  }
});

async function serveHtml(html) {
  const server = http.createServer((req, res) => {
    if (req.url !== "/") {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

test("an optional check that fails is shown as skipped in the timeline, not as ok", TIMEOUT, async () => {
  const spec = page("/fixtures/forms.html", [
    { op: "goto", url: "/api/status/404", status: 200, optional: true },
    { op: "goto", url: "/fixtures/forms.html" },
    { op: "assertState", check: "back on the form", label: "Name", state: "enabled" },
  ]);
  await withRun(spec, async receipt => {
    assert.equal(receipt.verdict, "PASS", explain(receipt));
    assert.equal(receipt.totals.checks, 1);
    const first = ofType(await records(receipt.detail.evidencePath), "step")[0];
    assert.equal(first.ok, true);
    assert.match(first.skipped, /^optional check failed: step 1: goto: expected 200, got 404$/);
  });
});

test("page errors are capped in memory and in the evidence, and counted", TIMEOUT, async () => {
  const app = await serveHtml(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>noisy</title><link rel="icon" href="data:,"></head><body><h1>noisy</h1><script>for (let i = 0; i < 300; i++) console.error("error number " + i);</script></body></html>`);
  try {
    const spec = { name: "noisy", app: { url: app.url }, noPageErrors: true, steps: [{ op: "assertTitle", check: "titled", equals: "noisy" }] };
    await withRun(spec, async receipt => {
      assert.equal(receipt.verdict, "FAIL");
      assert.equal(receipt.pageErrors.length, 10);
      const all = await records(receipt.detail.evidencePath);
      assert.equal(ofType(all, "pageerror").length, 100);
      assert.deepEqual(ofType(all, "pageerror-truncated"), [{ type: "pageerror-truncated", dropped: 200 }]);
      assert.equal(ofType(all, "console").length, 300);
      const failed = receipt.checks.find(check => check.name === "no page errors");
      assert.equal(failed.actual.length, 10);
    });
  } finally {
    await app.close();
  }
});

test("a frozen page ends the run as ERROR with a receipt, it does not hang the run", { timeout: 240000 }, async () => {
  const app = await serveHtml(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>frozen</title><link rel="icon" href="data:,"></head><body><h1>alive</h1><button id="freeze" onclick="while (true) {}">Freeze</button></body></html>`);
  try {
    const spec = {
      name: "frozen", app: { url: app.url }, timeoutMs: 1000,
      steps: [
        { op: "assertText", check: "alive", selector: "h1", equals: "alive" },
        { op: "click", check: "freeze the page", selector: "#freeze" },
        { op: "assertText", check: "still readable", selector: "h1", equals: "alive" },
      ],
    };
    await withRun(spec, async (receipt, dir) => {
      assert.ok(["ERROR", "FAIL"].includes(receipt.verdict), `the run must end, with ${receipt.verdict}`);
      assert.ok(receipt.detail.receiptPath, "a receipt is written even for a frozen page");
      assert.deepEqual((await verifyChain(dir, KEY)).problems, []);
      const steps = ofType(await records(receipt.detail.evidencePath), "step");
      assert.ok(steps.length >= 2, "the steps before the freeze were recorded");
    });
  } finally {
    await app.close();
  }
});

test("a fixture page reached by goto is covered by the revision guard too", TIMEOUT, async () => {
  const spec = {
    name: "fixtures-guard",
    steps: [
      { op: "assertText", check: "waitlist app", testId: "status", equals: "none" },
      { op: "goto", url: "/fixtures/forms.html" },
      { op: "assertTitle", check: "forms fixture", equals: "Fixture: forms" },
      { op: "goto", url: "/fixtures/nav.html" },
      { op: "assertTitle", check: "nav fixture", equals: "Fixture: navigation" },
    ],
  };
  await withRun(spec, async receipt => {
    assert.equal(receipt.verdict, "PASS", explain(receipt));
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

test("every file name writeReceipt writes has the shape the path scrub keeps intact", TIMEOUT, async () => {
  const dir = await mkdtemp(join(tmpdir(), "proof-names-"));
  try {
    for (const revision of ["0123456789ab", null]) {
      const receipt = { verdict: "PASS", app: "http://127.0.0.1:1", revision, at: fixedStamp(), checks: [], screenshot: null, error: null, next: [] };
      scrubReceipt(receipt);
      await writeScrubbedReceipt(receipt, { shot: Buffer.from("png"), evidence: '{"type":"run"}\n', key: KEY, dir }, "advice");
      assert.match(receipt.screenshot, LAB_FILE_NAME);
    }
    const names = (await readdir(dir)).filter(name => !name.startsWith("."));
    assert.equal(names.length, 6, "two receipts, each with a picture and an evidence file");
    for (const name of names) assert.match(name, LAB_FILE_NAME);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a receipt that scrubReceipt has not seen is refused, so an entry point cannot write one unscrubbed", TIMEOUT, async () => {
  const dir = await mkdtemp(join(tmpdir(), "proof-unscrubbed-"));
  try {
    const receipt = { verdict: "PASS", app: "http://127.0.0.1:1", revision: null, at: fixedStamp(), checks: [], screenshot: null, error: null, next: [] };
    const options = { shot: null, key: KEY, dir };
    await assert.rejects(writeScrubbedReceipt(receipt, options, "advice"), /scrubReceipt\(receipt\) must run first/);
    assert.deepEqual(await readdir(dir), [], "nothing is written for a refused receipt");
    scrubReceipt(receipt);
    const paths = await writeScrubbedReceipt(receipt, options, "advice");
    assert.equal(receipt.error, null, "the scrubbed receipt is written");
    assert.match(paths.receiptPath, /\.json$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the text a failed receipt write adds to the receipt is scrubbed like the rest of it", TIMEOUT, async () => {
  const workdir = await mkdtemp(join(tmpdir(), "proof-badreceipts-"));
  try {
    // The system's error names the path it failed on; here that path holds a credential-looking segment.
    const notADirectory = join(workdir, "password=hunter2");
    await writeFile(notADirectory, "a file where the receipts directory should be");
    const specPath = join(workdir, "spec.json");
    await writeFile(specPath, JSON.stringify(page("/fixtures/forms.html", [{ op: "assertState", check: "loaded", label: "Name", state: "enabled" }])));
    const receipt = await runSpec({ specPath, key: KEY, receiptsDir: notADirectory });
    assert.equal(receipt.verdict, "ERROR");
    assert.match(receipt.error, /^receipt write failed:/);
    assert.equal(JSON.stringify(receipt).includes("hunter2"), false, "the failed-write text must not carry the raw path");
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});
