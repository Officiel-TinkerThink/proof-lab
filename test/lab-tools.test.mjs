import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixedStamp, receiptFiles, writeReceipt } from "../src/chain.js";
import { formatDoctor, runDoctor } from "../src/doctor.js";
import { evidenceText } from "../src/spec/evidence.js";
import { loadEvidence, render, savePicture } from "../src/show.js";
import { currentRevision, formatStatus, statusOf } from "../src/status.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WAITLIST = join(ROOT, "specs", "waitlist.json");
const KEY = Buffer.alloc(40, 5);
const TIMEOUT = { timeout: 180000 };

const waitlistText = await readFile(WAITLIST, "utf8");
const waitlistHash = createHash("sha256").update(waitlistText).digest("hex").slice(0, 12);
const waitlistRevision = await currentRevision(JSON.parse(waitlistText));
const stamp = n => fixedStamp(new Date(Date.UTC(2026, 9, 19, 10, 0, 0) + n * 1000));

const failing = (name, hint) => ({ step: 3, name, pass: false, expected: "a", actual: "b", ...(hint ? { hint } : {}) });

// A receipt in the field order the Node driver writes, for chains that need no browser.
function receipt({ n, verdict = "PASS", specHash = waitlistHash, name = "waitlist", revision = waitlistRevision, checks = [], error = null, at }) {
  const failed = checks.filter(check => check.pass === false).length;
  const total = Math.max(checks.length, 1);
  return {
    verdict, app: "http://127.0.0.1:1", bug: null, spec: `${name}@${specHash}`, revision, at: at ?? stamp(n),
    totals: { checks: total, passed: total - failed, failed, omitted: 0 }, checks, evidence: null,
    pageErrors: [], screenshot: null, error, next: checks.map(check => check.hint ?? `Fix ${check.name}`),
  };
}

async function inTempDir(work) {
  const dir = await mkdtemp(join(tmpdir(), "proof-tools-"));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function chain(dir, receipts) {
  for (const item of receipts) await writeReceipt(item, { key: KEY, dir });
}

const status = (dir, extra = {}) => statusOf({ dir, key: KEY, specPath: WAITLIST, ...extra });

test("status: no receipt, no directory, or only another spec's receipts is NO-RECEIPT", async () => {
  await inTempDir(async dir => {
    const empty = await status(dir);
    assert.deepEqual([empty.state, empty.exitCode, empty.ok], ["NO-RECEIPT", 1, false]);
    assert.equal((await status(join(dir, "missing"))).state, "NO-RECEIPT");
    await chain(dir, [receipt({ n: 1, name: "other" })]);
    assert.equal((await status(dir)).state, "NO-RECEIPT");
  });
});

test("status: a fresh PASS is the only exit 0", async () => {
  await inTempDir(async dir => {
    await chain(dir, [receipt({ n: 1 })]);
    const result = await status(dir);
    assert.deepEqual([result.state, result.exitCode, result.ok], ["PASS", 0, true]);
    assert.equal(result.currentRevision, waitlistRevision);
    assert.equal(result.advice[0], "Done. Show the receipt.");
    assert.match(formatStatus(result), /^PASS waitlist\n {2}receipt: .*\.json/);
  });
});

test("status: a PASS for other code or another spec is STALE", async () => {
  await inTempDir(async dir => {
    await chain(dir, [receipt({ n: 1, revision: "ffffffffffff" })]);
    const app = await status(dir);
    assert.deepEqual([app.state, app.exitCode], ["STALE", 1]);
    assert.match(app.advice[0], new RegExp(`the app changed: the receipt says PASS for ffffffffffff, but the source is now ${waitlistRevision}`));
  });
  await inTempDir(async dir => {
    await chain(dir, [receipt({ n: 1, specHash: "000000000000" })]);
    const spec = await status(dir);
    assert.equal(spec.state, "STALE");
    assert.match(spec.advice[0], /the spec changed since this receipt/);
  });
  await inTempDir(async dir => {
    await chain(dir, [receipt({ n: 1, specHash: "000000000000", revision: "ffffffffffff" })]);
    const both = await status(dir);
    assert.match(both.advice[0], /the spec changed.*the app changed/);
  });
});

test("status: an app with no revision cannot be shown fresh, unless the receipt is recent enough", async () => {
  await inTempDir(async dir => {
    const specPath = join(dir, "external.json");
    const text = JSON.stringify({ name: "external", app: { url: "http://127.0.0.1:1/" }, steps: [{ op: "assertUrl", contains: "x" }] });
    await writeFile(specPath, text);
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 12);
    const receipts = join(dir, "receipts");
    await chain(receipts, [receipt({ n: 1, name: "external", specHash: hash, revision: null, at: fixedStamp(new Date()) })]);
    const ask = extra => statusOf({ dir: receipts, key: KEY, specPath, ...extra });

    const unverified = await ask();
    assert.deepEqual([unverified.state, unverified.exitCode], ["UNVERIFIED", 1]);
    assert.match(unverified.advice[0], /--max-age/);
    assert.equal((await ask({ maxAgeSeconds: 3600 })).state, "PASS");
    const later = new Date(Date.now() + 2 * 3600 * 1000);
    const old = await ask({ maxAgeSeconds: 3600, now: later });
    assert.equal(old.state, "STALE");
    assert.match(old.advice[0], /the receipt is \d+ s old, more than the 3600 s allowed/);
  });
});

test("status: a FAIL carries the hints; the same check failing three runs in a row is STOP", async () => {
  await inTempDir(async dir => {
    await chain(dir, [receipt({ n: 1, verdict: "FAIL", checks: [failing("bad", "make it persist")] })]);
    const one = await status(dir);
    assert.deepEqual([one.state, one.exitCode], ["FAIL", 1]);
    assert.deepEqual(one.failedChecks, [{ step: 3, name: "bad" }]);
    assert.ok(one.advice.includes("make it persist"));
  });
  const fail = (n, names, extra = {}) => receipt({ n, verdict: "FAIL", checks: names.map(name => failing(name)), ...extra });
  const cases = [
    ["three in a row, same check", [fail(1, ["bad"]), fail(2, ["bad"]), fail(3, ["bad"])], {}, "STOP", ["bad"]],
    ["only two in a row", [fail(1, ["bad"]), fail(2, ["bad"])], {}, "FAIL", undefined],
    ["three in a row, different checks each time", [fail(1, ["a"]), fail(2, ["b"]), fail(3, ["c"])], {}, "FAIL", undefined],
    ["three in a row, spec changed in between", [fail(1, ["bad"]), fail(2, ["bad"], { specHash: "111111111111" }), fail(3, ["bad"])], {}, "FAIL", undefined],
    ["one check common to all three", [fail(1, ["bad"]), fail(2, ["bad", "other"]), fail(3, ["bad", "third"])], {}, "STOP", ["bad"]],
    ["a PASS in between resets the count", [fail(1, ["bad"]), fail(2, ["bad"]), receipt({ n: 3 }), fail(4, ["bad"])], {}, "FAIL", undefined],
    ["three failures then a PASS", [fail(1, ["bad"]), fail(2, ["bad"]), fail(3, ["bad"]), receipt({ n: 4 })], {}, "PASS", undefined],
    ["limit set to two", [fail(1, ["bad"]), fail(2, ["bad"])], { maxAttempts: 2 }, "STOP", ["bad"]],
  ];
  for (const [label, receipts, extra, state, repeated] of cases) {
    await inTempDir(async dir => {
      await chain(dir, receipts);
      const result = await status(dir, extra);
      assert.equal(result.state, state, label);
      assert.deepEqual(result.repeated, repeated, label);
      if (state === "STOP") assert.match(result.advice[0], /Hand a human the receipt/);
    });
  }
});

test("status: an ERROR run, a broken chain and a bad spec are exit 2: fix the setup", async () => {
  await inTempDir(async dir => {
    await chain(dir, [receipt({ n: 1, verdict: "ERROR", error: "run failed: browser did not start" })]);
    const result = await status(dir);
    assert.deepEqual([result.state, result.exitCode], ["ERROR", 2]);
    assert.match(result.advice[0], /Fix the setup/);
    assert.ok(result.advice.some(line => line.includes("browser did not start")));
  });
  await inTempDir(async dir => {
    await chain(dir, [receipt({ n: 1 })]);
    const [file] = await receiptFiles(dir);
    await chmod(file, 0o644);
    await writeFile(file, (await readFile(file, "utf8")).replace('"PASS"', '"FAIL"'));
    const result = await status(dir);
    assert.deepEqual([result.state, result.exitCode], ["CANNOT-TELL", 2]);
    assert.ok(result.problems.length > 0);
    assert.match(result.advice[0], /does not verify/);
  });
  await inTempDir(async dir => {
    const bad = join(dir, "bad.json");
    await writeFile(bad, JSON.stringify({ name: "bad", steps: [{ op: "teleport" }] }));
    assert.equal((await statusOf({ dir, key: KEY, specPath: bad })).state, "CANNOT-TELL");
    assert.equal((await statusOf({ dir, key: KEY, specPath: join(dir, "missing.json") })).state, "CANNOT-TELL");
  });
});

test("status: a missing evidence file is a note, not a reason to doubt a PASS", async () => {
  await inTempDir(async dir => {
    const item = receipt({ n: 1 });
    const paths = await writeReceipt(item, { evidence: "{}\n", key: KEY, dir });
    await rm(paths.evidencePath);
    const result = await status(dir);
    assert.equal(result.state, "PASS");
    assert.ok(result.advice.some(line => /evidence file\(s\) are missing/.test(line)));
  });
});

const EVIDENCE = evidenceText([
  { type: "run", spec: "waitlist@abc", app: "http://x", revision: "0123456789ab", at: "t", timeoutMs: 3000, start: null, node: "v24", platform: "win32", browser: "chromium 1" },
  { type: "step", step: 1, op: "assertText", target: "testId=status", check: "first", ms: 12, ok: true },
  { type: "step", step: 2, op: "click", target: "role=button name=Join", check: "step 2: click", ms: 40, ok: false },
  { type: "step", step: 3, op: "click", check: "third", ms: 5, ok: true, skipped: "Timeout 200ms exceeded." },
  { type: "check", step: 1, name: "first", pass: true, expected: "a", actual: "a" },
  { type: "check", step: 2, name: "second", pass: false, expected: "a", actual: "b", hint: "fix it", error: "boom" },
  { type: "context", step: 2, url: "http://x/", title: "T", aria: "- heading \"Hi\"\n- button \"Join\"" },
  { type: "screenshot", step: 2, mime: "image/jpeg", base64: Buffer.from([1, 2, 3]).toString("base64") },
  { type: "console", level: "error", text: "logged error" },
  { type: "pageerror", message: "Uncaught boom" },
  { type: "summary", verdict: "FAIL", totals: { checks: 2, passed: 1, failed: 1, omitted: 0 }, error: null },
]);

async function withEvidenceChain(work) {
  await inTempDir(async dir => {
    const failed = receipt({ n: 1, verdict: "FAIL", checks: [failing("second", "fix it")], revision: "0123456789ab" });
    failed.totals = { checks: 2, passed: 1, failed: 1, omitted: 0 };
    const paths = await writeReceipt(failed, { evidence: EVIDENCE, key: KEY, dir });
    await work(dir, paths);
  });
}

test("show: evidence is checked against the signed hash before it is read", async () => {
  await withEvidenceChain(async (dir, paths) => {
    const loaded = await loadEvidence({ dir, key: KEY });
    assert.equal(loaded.records.length, 11);
    assert.deepEqual(loaded.notes, []);
    assert.equal(loaded.path, paths.receiptPath);
    const unsigned = await loadEvidence({ dir });
    assert.match(unsigned.notes[0], /signature was not checked/);

    await assert.rejects(loadEvidence({ dir, receipt: "no-such.json", key: KEY }), /is not a receipt in/);
    const byName = await loadEvidence({ dir, receipt: paths.receiptPath.split(/[\\/]/).at(-1), key: KEY });
    assert.equal(byName.path, paths.receiptPath);
    // a path as the tools print it (<dir>/name) names the same receipt, and a wrong one is refused without printing the directory
    const asPrinted = await loadEvidence({ dir, receipt: `<dir>/${paths.receiptPath.split(/[\\/]/).at(-1)}`, key: KEY });
    assert.equal(asPrinted.path, paths.receiptPath);
    await assert.rejects(loadEvidence({ dir, receipt: "<dir>/no-such.json", key: KEY }), error => /^no-such\.json is not a receipt in the receipts directory$/.test(error.message));

    await chmod(paths.evidencePath, 0o644);
    await writeFile(paths.evidencePath, EVIDENCE.replace("logged error", "all fine"));
    await assert.rejects(loadEvidence({ dir, key: KEY }), /does not match the hash/);
    await assert.rejects(loadEvidence({ dir }), /does not match the hash/);

    await rm(paths.evidencePath);
    const gone = await loadEvidence({ dir, key: KEY });
    assert.equal(gone.records, null);
    assert.match(gone.notes.at(-1), /missing .*pruned/);
  });
  await inTempDir(async dir => {
    await chain(dir, [receipt({ n: 1 })]);
    const none = await loadEvidence({ dir, key: KEY });
    assert.equal(none.records, null);
    assert.match(none.notes.at(-1), /no evidence file/);
  });
  await inTempDir(async dir => {
    await assert.rejects(loadEvidence({ dir }), /no receipts in/);
  });
});

test("show: sections render the steps, checks, failures, console and page context", async () => {
  await withEvidenceChain(async dir => {
    const loaded = await loadEvidence({ dir, key: KEY });
    const text = name => render(name, loaded).text;
    assert.match(text("summary"), /^FAIL waitlist@[0-9a-f]{12}/);
    assert.match(text("summary"), /2 checks, 1 passed, 1 failed/);
    assert.match(text("summary"), /FAIL step 3: second/);
    assert.match(text("steps"), / {2}2 {2}FAIL {5}40 ms {2}click role=button name=Join/);
    assert.match(text("steps"), /\(optional, skipped: Timeout 200ms exceeded\.\)/);
    assert.match(text("checks"), /PASS step 1: first/);
    assert.match(text("failures"), /hint {5}fix it/);
    assert.match(text("failures"), /page: http:\/\/x\/ \(T\)/);
    assert.match(text("console"), /\[error\] logged error/);
    assert.match(text("console"), /\[pageerror\] Uncaught boom/);
    assert.match(text("context"), /- button "Join"/);
    assert.equal(render("failures", { ...loaded, records: [] }).text, "  no failed checks");
    assert.equal(render("console", { ...loaded, records: [] }).text, "  no console output");
    assert.throws(() => render("nope", loaded), /unknown section/);
  });
});

test("show: the first failure picture can be saved as a file", async () => {
  await withEvidenceChain(async dir => {
    const loaded = await loadEvidence({ dir, key: KEY });
    const out = join(dir, "failure.jpg");
    assert.equal(await savePicture(loaded.records, out), out);
    assert.deepEqual([...await readFile(out)], [1, 2, 3]);
    assert.equal(await savePicture([], join(dir, "none.jpg")), null);
  });
});

async function keyFileIn(dir) {
  const keyFile = join(dir, "key.txt");
  await writeFile(keyFile, "k".repeat(48));
  if (process.platform !== "win32") await chmod(keyFile, 0o600);
  return keyFile;
}

function tool(name, args, env = {}) {
  const { PROOF_LAB_KEY: _ignored, ...clean } = process.env;
  return spawnSync(process.execPath, [join(ROOT, "src", `${name}.js`), ...args], { encoding: "utf8", env: { ...clean, ...env } });
}

test("the status and show CLIs: exit codes, text and JSON", async () => {
  await inTempDir(async dir => {
    const keyFile = await keyFileIn(dir);
    const cliKey = Buffer.from("k".repeat(48));
    const receipts = join(dir, "receipts");
    await mkdir(receipts);
    await writeReceipt(receipt({ n: 1 }), { key: cliKey, dir: receipts });

    const pass = tool("status", ["--spec", WAITLIST, "--key-file", keyFile, "--receipts", receipts]);
    assert.equal(pass.status, 0, pass.stdout + pass.stderr);
    assert.match(pass.stdout, /^PASS waitlist/);
    const json = tool("status", ["--spec", WAITLIST, "--key-file", keyFile, "--receipts", receipts, "--json"]);
    assert.equal(JSON.parse(json.stdout).state, "PASS");

    await writeReceipt(receipt({ n: 2, revision: "ffffffffffff" }), { key: cliKey, dir: receipts });
    const stale = tool("status", ["--spec", WAITLIST, "--key-file", keyFile, "--receipts", receipts]);
    assert.equal(stale.status, 1);
    assert.match(stale.stdout, /^STALE waitlist/);

    for (const [args, message] of [
      [["--spec", WAITLIST, "--receipts", receipts], /--key-file <path> is required/],
      [["--key-file", keyFile, "--receipts", receipts], /--spec <file\.json> is required/],
      [["--spec", WAITLIST, "--key-file", keyFile, "--receipts", receipts, "--max-age=0"], /--max-age must be a number greater than 0/],
      [["--spec", WAITLIST, "--key-file", keyFile, "--receipts", receipts, "--max-age=soon"], /--max-age must be a number greater than 0/],
      [["--spec", WAITLIST, "--key-file", keyFile, "--receipts", "--json"], /receipts/],
      [["--spec", WAITLIST, "--key-file", keyFile, "--recipts", receipts], /Unknown option '--recipts'/],
      [["--spec", WAITLIST, "--key-file", keyFile, "stray"], /Unexpected argument 'stray'/],
    ]) {
      const result = tool("status", args);
      assert.equal(result.status, 2, args.join(" "));
      assert.match(result.stderr, message);
    }

    const failedAt = join(dir, "show-receipts");
    await mkdir(failedAt);
    const failed = receipt({ n: 1, verdict: "FAIL", checks: [failing("second", "fix it")] });
    await writeReceipt(failed, { evidence: EVIDENCE, key: cliKey, dir: failedAt });
    const shown = tool("show", ["--receipts", failedAt, "--key-file", keyFile, "--failures"]);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /FAIL step 2: second/); // the evidence lists the check at the step it ran in
    const picture = join(dir, "picture.jpg");
    const saved = tool("show", ["--receipts", failedAt, "--key-file", keyFile, "--save-picture", picture]);
    assert.equal(saved.status, 0, saved.stderr);
    assert.deepEqual([...await readFile(picture)], [1, 2, 3]);
    const many = tool("show", ["--receipts", failedAt, "--key-file", keyFile, "--steps", "--console", "--json"]);
    assert.deepEqual(Object.keys(JSON.parse(many.stdout)), ["steps", "console"]);
    assert.equal(tool("show", ["--receipts", join(dir, "nowhere")]).status, 2);
  });
});

test("doctor: a sound setup is ok and reports where each spec stands", TIMEOUT, async () => {
  await inTempDir(async dir => {
    const keyFile = await keyFileIn(dir);
    const result = await runDoctor({ dir: join(dir, "receipts"), keyFile, specPaths: [WAITLIST] });
    assert.equal(result.ok, true, formatDoctor(result));
    assert.deepEqual(result.checks.map(check => check.name), [
      "node version", "signing key is not in the environment", "signing key file", "receipts directory is writable",
      "receipt chain verifies", "no stuck writer lock", "browser launches", `spec ${basename(WAITLIST)}`, `app for ${basename(WAITLIST)} is reachable`,
    ]);
    assert.match(result.checks.find(check => check.name === "browser launches").detail, /^chromium /);
    assert.equal(result.statuses[0].state, "NO-RECEIPT");
    assert.match(formatDoctor(result), /The setup is sound\./);
  });
});

test("doctor: every setup problem is reported by name", TIMEOUT, async () => {
  await inTempDir(async dir => {
    const keyFile = await keyFileIn(dir);
    const receipts = join(dir, "receipts");
    const failedNames = result => result.checks.filter(check => !check.ok).map(check => check.name);

    assert.deepEqual(failedNames(await runDoctor({ dir: receipts, keyFile: undefined })), ["signing key file", "receipt chain verifies"].filter((_, i) => i === 0));

    const missingKey = await runDoctor({ dir: receipts, keyFile: join(dir, "nope.txt") });
    assert.deepEqual(failedNames(missingKey), ["signing key file"]);

    process.env.PROOF_LAB_KEY = "x".repeat(48);
    try {
      assert.deepEqual(failedNames(await runDoctor({ dir: receipts, keyFile })), ["signing key is not in the environment"]);
    } finally {
      delete process.env.PROOF_LAB_KEY;
    }

    const aFile = join(dir, "file.txt");
    await writeFile(aFile, "x");
    assert.ok(failedNames(await runDoctor({ dir: aFile, keyFile })).includes("receipts directory is writable"));

    const invalid = join(dir, "invalid.json");
    await writeFile(invalid, JSON.stringify({ name: "bad", steps: [{ op: "teleport" }] }));
    const unreachable = join(dir, "unreachable.json");
    await writeFile(unreachable, JSON.stringify({ name: "gone", app: { url: "http://127.0.0.1:1/" }, steps: [{ op: "assertUrl", contains: "x" }] }));
    const specs = await runDoctor({ dir: receipts, keyFile, specPaths: [invalid, unreachable, join(dir, "missing.json")] });
    // A check is named by the spec's file name: the directory the operator chose is not printed.
    assert.deepEqual(failedNames(specs), [`spec ${basename(invalid)}`, `app for ${basename(unreachable)} is reachable`, "spec missing.json"]);
    assert.match(formatDoctor(specs), /The setup is not sound\. Fix the failed checks above, do not guess\./);

    // two specs with the same file name in different folders are told apart by position, never by folder
    await mkdir(join(dir, "a"));
    await mkdir(join(dir, "b"));
    await writeFile(join(dir, "a", "same.json"), JSON.stringify({ name: "bad", steps: [{ op: "teleport" }] }));
    await writeFile(join(dir, "b", "same.json"), JSON.stringify({ name: "bad", steps: [{ op: "teleport" }] }));
    const twins = await runDoctor({ dir: receipts, keyFile, specPaths: [join(dir, "a", "same.json"), join(dir, "b", "same.json")] });
    assert.deepEqual(failedNames(twins), ["spec #1 same.json", "spec #2 same.json"]);
  });
});

test("doctor: a tampered chain and a stuck lock are told apart", TIMEOUT, async () => {
  await inTempDir(async dir => {
    const keyFile = await keyFileIn(dir);
    const receipts = join(dir, "receipts");
    await mkdir(receipts);
    const cliKey = Buffer.from("k".repeat(48));
    await writeReceipt(receipt({ n: 1 }), { key: cliKey, dir: receipts });
    const clean = await runDoctor({ dir: receipts, keyFile });
    assert.equal(clean.checks.find(check => check.name === "receipt chain verifies").detail, "1 receipts");

    // A lock whose owner is gone is reclaimed by the next run: not a problem. A lock nobody can read is.
    await writeFile(join(receipts, ".chain.lock"), JSON.stringify({ pid: 2147483646, host: (await import("node:os")).hostname() }));
    const stale = await runDoctor({ dir: receipts, keyFile });
    const staleLock = stale.checks.find(check => check.name === "no stuck writer lock");
    assert.equal(staleLock.ok, true);
    assert.match(staleLock.detail, /stale lock from pid 2147483646 will be reclaimed/);
    await writeFile(join(receipts, ".chain.lock"), "not json");
    const garbled = await runDoctor({ dir: receipts, keyFile });
    assert.equal(garbled.checks.find(check => check.name === "no stuck writer lock").ok, false);
    await rm(join(receipts, ".chain.lock"));

    const [file] = await receiptFiles(receipts);
    await chmod(file, 0o644);
    await writeFile(file, (await readFile(file, "utf8")).replace('"PASS"', '"FAIL"'));
    const tampered = await runDoctor({ dir: receipts, keyFile });
    assert.equal(tampered.ok, false);
    assert.equal(tampered.checks.find(check => check.name === "receipt chain verifies").ok, false);
  });
});

test("the doctor CLI exits 0 for a sound setup and 2 for a broken one", TIMEOUT, async () => {
  await inTempDir(async dir => {
    const keyFile = await keyFileIn(dir);
    const receipts = join(dir, "receipts");
    const good = tool("doctor", ["--key-file", keyFile, "--receipts", receipts, "--spec", WAITLIST]);
    assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.match(good.stdout, /The setup is sound\./);
    const json = tool("doctor", ["--key-file", keyFile, "--receipts", receipts, "--json"]);
    assert.equal(JSON.parse(json.stdout).ok, true);
    const noKey = tool("doctor", ["--receipts", receipts]);
    assert.equal(noKey.status, 2);
    assert.match(noKey.stdout, /FAIL signing key file: --key-file <path> is required/);
    const inEnv = tool("doctor", ["--key-file", keyFile, "--receipts", receipts], { PROOF_LAB_KEY: "x".repeat(48) });
    assert.equal(inEnv.status, 2);
  });
});
