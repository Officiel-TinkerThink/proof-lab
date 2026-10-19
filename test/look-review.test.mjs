import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSpec, validateSpec } from "../src/run-spec.js";
import { verifyChain } from "../src/chain.js";
import { statusOf } from "../src/status.js";
import { actionableElements, look } from "../src/look.js";
import { startApp } from "../src/server.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WAITLIST = join(ROOT, "specs", "waitlist.json");
const STRICT = join(ROOT, "specs", "waitlist-strict.json");
const KEY = Buffer.alloc(40, 7);
const TIMEOUT = { timeout: 120000 };

async function withDir(work) {
  const dir = await mkdtemp(join(tmpdir(), "proof-review-"));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const SIMPLE = [
  { op: "assertText", check: "status starts at none", selector: "[data-testid=\"status\"]", equals: "none" },
];

async function runWith(dir, steps, extra = {}) {
  const specPath = join(dir, "spec.json");
  await writeFile(specPath, JSON.stringify({ name: "review-spec", steps, ...extra }));
  const receipts = join(dir, "receipts");
  const receipt = await runSpec({ specPath, key: KEY, receiptsDir: receipts });
  return { receipt, receipts, specPath };
}

// --- needs review -----------------------------------------------------------------------------------------------

test("validateSpec: review needs a check name, takes only a note, and is not an assertion", () => {
  const problems = steps => validateSpec({ name: "x", steps }).join(" | ");
  assert.equal(problems([...SIMPLE, { op: "review", check: "the copy reads well", note: "tone" }]), "");
  assert.match(problems([...SIMPLE, { op: "review" }]), /needs "check"/);
  assert.match(problems([...SIMPLE, { op: "review", check: "c", note: 5 }]), /note must be string/);
  for (const field of ["optional", "timeout", "hint", "name"]) {
    assert.match(problems([...SIMPLE, { op: "review", check: "c", [field]: field === "optional" ? true : field === "timeout" ? 10 : "x" }]), new RegExp(`cannot use "${field}"`), field);
  }
  assert.match(problems([{ op: "review", check: "only a claim" }]), /no assertions/, "a spec of claims alone proves nothing");
  assert.match(problems([...SIMPLE, { op: "review", check: "c", role: "button" }]), /unknown field "role"/);
});

test("a PASS with a review claim is signed as PASS, lists the claim, counts no check, and the chain verifies", TIMEOUT, async () => {
  await withDir(async dir => {
    const { receipt, receipts } = await runWith(dir, [...SIMPLE, { op: "review", check: "the confirmation copy reads well", note: "tone and length" }]);
    assert.equal(receipt.verdict, "PASS", JSON.stringify(receipt.checks));
    assert.deepEqual(receipt.review, { total: 1, items: [{ step: 2, name: "the confirmation copy reads well", note: "tone and length" }] });
    assert.equal(receipt.totals.checks, 1, "a claim is not a check");
    assert.match(receipt.next[0], /1 claim\(s\) need a human/);
    assert.deepEqual((await verifyChain(receipts, KEY)).problems, []);
    const evidence = (await readFile(receipt.detail.evidencePath, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(evidence.filter(record => record.type === "review").map(record => record.name), ["the confirmation copy reads well"]);
    assert.equal(evidence.find(record => record.type === "step" && record.op === "review").ok, true);
  });
});

test("claims are capped in the receipt, counted in full, and a FAIL stays a FAIL", TIMEOUT, async () => {
  await withDir(async dir => {
    const claims = Array.from({ length: 25 }, (_, index) => ({ op: "review", check: `claim ${index + 1}` }));
    const { receipt } = await runWith(dir, [...claims, { op: "assertText", check: "wrong on purpose", selector: "[data-testid=\"status\"]", equals: "nope", timeout: 100 }]);
    assert.equal(receipt.verdict, "FAIL");
    assert.equal(receipt.review.total, 25);
    assert.equal(receipt.review.items.length, 20);
  });
});

test("a run without claims carries an empty review and the old PASS advice", TIMEOUT, async () => {
  await withDir(async dir => {
    const { receipt } = await runWith(dir, SIMPLE);
    assert.deepEqual(receipt.review, { total: 0, items: [] });
    assert.match(receipt.next[0], /^These checks passed on this revision/);
  });
});

test("status: a fresh PASS with open claims is NEEDS-REVIEW (exit 3), never done", TIMEOUT, async () => {
  await withDir(async dir => {
    const { specPath, receipts } = await runWith(dir, [...SIMPLE, { op: "review", check: "layout feels right" }]);
    const result = await statusOf({ dir: receipts, key: KEY, specPath });
    assert.equal(result.state, "NEEDS-REVIEW");
    assert.equal(result.exitCode, 3);
    assert.equal(result.ok, false);
    assert.equal(result.review.total, 1);
    assert.match(result.advice[0], /Do not say done/);
  });
});

test("the CLI exits 3 for a PASS with open claims and prints them; --json carries them", TIMEOUT, async () => {
  await withDir(async dir => {
    const keyFile = join(dir, "key.txt");
    await writeFile(keyFile, "k".repeat(48));
    if (process.platform !== "win32") await chmod(keyFile, 0o600);
    const specPath = join(dir, "spec.json");
    await writeFile(specPath, JSON.stringify({ name: "review-cli", steps: [...SIMPLE, { op: "review", check: "tone is friendly", note: "read it" }] }));
    const { PROOF_LAB_KEY: _ignored, ...env } = process.env;
    const run = extra => spawnSync(process.execPath, [join(ROOT, "src", "run-spec.js"), "--spec", specPath, "--key-file", keyFile, "--receipts", join(dir, "receipts"), ...extra], { encoding: "utf8", env });
    const text = run([]);
    assert.equal(text.status, 3, text.stdout + text.stderr);
    assert.match(text.stdout, /^PASS review-cli@/m);
    assert.match(text.stdout, /NEEDS REVIEW: 1 claim\(s\)/);
    assert.match(text.stdout, /step 2: tone is friendly \(read it\)/);
    const json = run(["--json"]);
    assert.equal(json.status, 3);
    assert.equal(JSON.parse(json.stdout).review.total, 1);
  });
});

// --- look -------------------------------------------------------------------------------------------------------

test("actionableElements reads roles and names from the accessibility tree and flags repeats", () => {
  const aria = [
    '- heading "Waitlist" [level=1]',
    '- textbox "Email"',
    '- button "Join"',
    '- button "Join"',
    '- link "Say \\"hi\\"":',
    "  - /url: /x",
    '- paragraph: some text',
    '- button',
  ].join("\n");
  const elements = actionableElements(aria);
  assert.deepEqual(elements, [
    { role: "heading", name: "Waitlist" },
    { role: "textbox", name: "Email" },
    { role: "button", name: "Join", matches: 2 },
    { role: "button", name: "Join", matches: 2 },
    { role: "link", name: 'Say "hi"' },
    { role: "button" },
  ]);
  assert.deepEqual(actionableElements(""), []);
});

test("look --url lists the targets, test ids and storage keys without writing anything", TIMEOUT, async () => {
  const app = await startApp();
  try {
    const result = await look({ url: app.url });
    assert.equal(result.status, 200);
    assert.equal(result.title, "Waitlist practice page");
    assert.ok(result.elements.some(element => element.role === "button" && element.name === "Join waitlist"), JSON.stringify(result.elements));
    assert.ok(result.elements.some(element => element.role === "textbox" && element.name === "Email"));
    assert.deepEqual(result.testIds.sort(), ["email", "status"]);
    assert.deepEqual(result.storage.local, []);
    assert.deepEqual(result.replayed, []);
    assert.deepEqual(result.pageErrors, []);
  } finally {
    await app.close();
  }
});

test("look reports failed requests by path only, never the query", TIMEOUT, async () => {
  const app = await startApp();
  try {
    const result = await look({ url: `${app.url}/api/status/404?token=secret` });
    assert.equal(result.status, 404);
    assert.ok(result.failedRequests.length > 0);
    for (const request of result.failedRequests) assert.doesNotMatch(JSON.stringify(request), /secret|token/);
  } finally {
    await app.close();
  }
});

test("look --spec replays steps up to --until, so state made by the spec can be seen", TIMEOUT, async () => {
  const result = await look({ specPath: WAITLIST, until: 5 });
  assert.equal(result.replayed.length, 5);
  assert.ok(result.replayed.every(step => step.ok), JSON.stringify(result.replayed));
  assert.deepEqual(result.storage.local, ["waitlist-record"]);
  const none = await look({ specPath: WAITLIST, until: 0 });
  assert.deepEqual(none.storage.local, []);
  assert.equal(none.replayed.length, 0);
});

test("look reports the status and URL of the page it ends on, not of the first load, and drops the query", TIMEOUT, async () => {
  await withDir(async dir => {
    const specPath = join(dir, "to-404.json");
    await writeFile(specPath, JSON.stringify({ name: "to-404", steps: [...SIMPLE, { op: "goto", url: "/api/status/404?token=secret" }] }));
    const result = await look({ specPath });
    assert.equal(result.status, 404, "the goto's 404 answers for the page the header describes");
    assert.match(result.url, /\/api\/status\/404$/);
    assert.doesNotMatch(JSON.stringify(result), /secret|token=/);
    const before = await look({ specPath, until: 1 });
    assert.equal(before.status, 200);
  });
});

test("a spec file that is not JSON is refused without echoing any of its bytes", TIMEOUT, async () => {
  await withDir(async dir => {
    const notSpec = join(dir, "key.txt");
    await writeFile(notSpec, "deadbeefcafe0123456789abcdef-SECRETKEYBYTES");
    await assert.rejects(look({ specPath: notSpec }), error => /could not be parsed as JSON/.test(error.message) && !/deadbeef|SECRET/i.test(error.message));
    const receipt = await runSpec({ specPath: notSpec, key: KEY, receiptsDir: join(dir, "receipts") });
    assert.equal(receipt.verdict, "ERROR");
    assert.doesNotMatch(String(receipt.error), /deadbeef|SECRET/i);
  });
});

test("an ERROR run whose first page fails to load still records the browser in the evidence", TIMEOUT, async () => {
  await withDir(async dir => {
    const { receipt, receipts } = await runWith(dir, SIMPLE, { app: { url: "http://127.0.0.1:1/" } });
    assert.equal(receipt.verdict, "ERROR");
    const lines = (await readFile(join(receipts, receipt.evidence.file), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.match(lines.find(record => record.type === "run").browser, /^chromium /);
  });
});

test("look shows page errors the app throws, and refuses what it cannot do", TIMEOUT, async () => {
  const strict = JSON.parse(await readFile(STRICT, "utf8"));
  await withDir(async dir => {
    const specPath = join(dir, "console-error.json");
    await writeFile(specPath, JSON.stringify({ ...strict, app: { bug: "console-error" } }));
    const result = await look({ specPath, until: 3 });
    assert.ok(result.pageErrors.some(message => /analytics failed/.test(message)), JSON.stringify(result.pageErrors));

    await assert.rejects(look({ specPath: WAITLIST, until: 999 }), /--until must be a whole number from 0 to \d+/);
    await assert.rejects(look({ specPath: WAITLIST, until: -1 }), /--until must be/);
    await assert.rejects(look({ url: "file:///etc/passwd" }), /must be http or https/);
    await assert.rejects(look({ url: "not a url" }), /is not a URL/);
    await writeFile(join(dir, "bad.json"), JSON.stringify({ name: "bad", steps: [{ op: "teleport" }] }));
    await assert.rejects(look({ specPath: join(dir, "bad.json") }), /invalid spec/);
    await assert.rejects(look({ specPath: join(dir, "missing.json") }), /could not be read/);

    const existing = join(dir, "exists.png");
    await writeFile(existing, "keep me");
    await assert.rejects(look({ specPath: WAITLIST, until: 0, screenshotPath: existing }), { code: "EEXIST" });
    assert.equal(await readFile(existing, "utf8"), "keep me", "an existing file is never replaced");
    const fresh = join(dir, "fresh.png");
    const result2 = await look({ specPath: WAITLIST, until: 0, screenshotPath: fresh });
    assert.equal(result2.screenshot, fresh);
    assert.equal((await readFile(fresh)).subarray(1, 4).toString(), "PNG");
  });
});

test("the look CLI: exactly one of --url and --spec, exit 0 when it looked, exit 2 otherwise", TIMEOUT, () => {
  const cli = args => spawnSync(process.execPath, [join(ROOT, "src", "look.js"), ...args], { encoding: "utf8" });
  for (const args of [[], ["--url", "http://127.0.0.1:1/", "--spec", WAITLIST], ["--until", "2", "--url", "http://127.0.0.1:1/"], ["--spec", WAITLIST, "--until", "two"], ["--spec", WAITLIST, "--until", ""]]) {
    const result = cli(args);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /^ERROR: /);
  }
  const unreachable = cli(["--url", "http://127.0.0.1:1/"]);
  assert.equal(unreachable.status, 2, "a page that does not load is 'could not look', not a failure");
  const looked = cli(["--spec", WAITLIST, "--until", "0", "--json"]);
  assert.equal(looked.status, 0, looked.stdout + looked.stderr);
  assert.equal(JSON.parse(looked.stdout).title, "Waitlist practice page");
});
