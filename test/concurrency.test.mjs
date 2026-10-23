// Runs that overlap: in one process (run --spec a --spec b) and in separate processes writing one receipts directory.
// Each must end with its own receipt and an intact chain, whichever finishes first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GENESIS, SEAL_WAIT_MS, fixedStamp, verifyChain, writeReceipt } from "../src/chain.js";
import { combinedExitCode, inPool, maxJobs } from "../src/run-spec.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "src", "run-spec.js");
const WAITLIST = join(ROOT, "specs", "waitlist.json");
const TIMEOUT = { timeout: 240000 };
const KEY_TEXT = "k".repeat(48);
const key = Buffer.from(KEY_TEXT, "utf8");

const receipt = at => ({ verdict: "PASS", app: "http://127.0.0.1:4173", bug: null, revision: "e5ec1a11e78c", at, checks: [], pageErrors: [], screenshot: null, error: null, next: ["ok"], prevHash: GENESIS });

// A temp directory whose files are made writable and removed when the test ends. Windows cannot delete read-only files.
async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "proof-conc-"));
  t.after(async () => {
    const chmodAll = async path => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) await chmodAll(full);
        else await chmod(full, 0o644).catch(() => {});
      }
    };
    await chmodAll(dir).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const receiptNames = async dir => (await readdir(dir)).filter(name => name.endsWith(".json")).sort();

test("a run that started first but seals last is stamped when it seals, and the chain stays whole", async t => {
  const dir = await tempDir(t);
  const early = receipt("2026-01-01T00:00:00.000000000Z"); // started first
  const late = receipt(fixedStamp()); // started later, sealed first
  await writeReceipt(late, { key, dir, stampNow: fixedStamp });
  await writeReceipt(early, { key, dir, stampNow: fixedStamp });
  assert.ok(early.at > late.at, `the second seal is stamped after the first (${early.at} > ${late.at})`);
  assert.equal(early.prevHash, late.hash, "the second seal links to the first");
  const result = await verifyChain(dir, key);
  assert.deepEqual(result.problems, []);
  assert.equal(result.checked, 2);
});

test("without a clock, an out-of-order stamp is still refused", async t => {
  const dir = await tempDir(t);
  await writeReceipt(receipt("2026-01-01T00:00:00.000000005Z"), { key, dir });
  await assert.rejects(writeReceipt(receipt("2026-01-01T00:00:00.000000004Z"), { key, dir }), /not later than the chain head/);
});

test("two seals in one millisecond: the second waits for the clock to move past the head", async t => {
  const dir = await tempDir(t);
  const frozen = fixedStamp();
  let calls = 0;
  const clock = () => (++calls < 3 ? frozen : fixedStamp(new Date(Date.parse(frozen) + 1)));
  await writeReceipt(receipt(frozen), { key, dir }); // the head, stamped `frozen`
  const second = receipt("2026-01-01T00:00:00.000000000Z");
  await writeReceipt(second, { key, dir, stampNow: clock });
  assert.ok(calls >= 3, "the clock was read again until it named a later receipt");
  assert.ok(second.at > frozen);
  assert.deepEqual((await verifyChain(dir, key)).problems, []);
});

test("a head further ahead than the wait is a clock problem: refused, and the caller's stamp is put back", async t => {
  const dir = await tempDir(t);
  const future = fixedStamp(new Date(Date.now() + 3_600_000));
  await writeReceipt(receipt(future), { key, dir });
  const behind = receipt("2026-01-01T00:00:00.000000000Z");
  const started = Date.now();
  await assert.rejects(writeReceipt(behind, { key, dir, stampNow: fixedStamp }), /not later than the chain head/);
  assert.ok(Date.now() - started < SEAL_WAIT_MS + 2000, "gives up after the wait, not the lock timeout");
  assert.equal(behind.at, "2026-01-01T00:00:00.000000000Z");
  assert.equal((await receiptNames(dir)).length, 1);
});

test("many writers in one process, each with its own start stamp, all seal into one chain", async t => {
  const dir = await tempDir(t);
  const starts = Array.from({ length: 8 }, (_, i) => fixedStamp(new Date(Date.now() - i * 1000))); // newest start first
  await Promise.all(starts.map(at => writeReceipt(receipt(at), { key, dir, stampNow: fixedStamp })));
  const result = await verifyChain(dir, key);
  assert.deepEqual(result.problems, []);
  assert.equal(result.checked, 8);
});

test("maxJobs is half the machine's workers, at least one", () => {
  assert.equal(maxJobs(16), 8);
  assert.equal(maxJobs(8), 4);
  assert.equal(maxJobs(3), 1);
  assert.equal(maxJobs(2), 1);
  assert.equal(maxJobs(1), 1);
  assert.ok(maxJobs() >= 1);
});

test("inPool never runs more than `jobs` at once and keeps the order of its items", async () => {
  let running = 0;
  let peak = 0;
  const results = await inPool([30, 5, 20, 1, 10, 15], 3, async ms => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise(resolve => setTimeout(resolve, ms));
    running -= 1;
    return ms * 2;
  });
  assert.equal(peak, 3);
  assert.deepEqual(results, [60, 10, 40, 2, 20, 30]);
  assert.deepEqual(await inPool([], 4, async () => 1), []);
});

test("one exit code for many runs: FAIL over ERROR over needs-review over PASS", () => {
  assert.equal(combinedExitCode([0, 0]), 0);
  assert.equal(combinedExitCode([0, 3]), 3);
  assert.equal(combinedExitCode([3, 2, 0]), 2);
  assert.equal(combinedExitCode([2, 1, 3]), 1);
});

// The CLI, through a child process. The key is never in the environment.
function cli(args) {
  const { PROOF_LAB_KEY: _ignored, ...env } = process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", status => resolve({ status, stdout, stderr }));
  });
}

async function workspace(t) {
  const dir = await tempDir(t);
  const keyFile = join(dir, "key.txt");
  await writeFile(keyFile, KEY_TEXT);
  if (process.platform !== "win32") await chmod(keyFile, 0o600);
  return { dir, keyFile, receipts: join(dir, "receipts") };
}

test("run takes several specs: each gets its own receipt, a broken one does not stop the others", TIMEOUT, async t => {
  const { dir, keyFile, receipts } = await workspace(t);
  const broken = join(dir, "broken.json");
  await writeFile(broken, "{nope");
  const result = await cli(["--spec", WAITLIST, "--spec", broken, "--spec", WAITLIST, "--key-file", keyFile, "--receipts", receipts, "--jobs", "2"]);
  assert.equal(result.status, 2, result.stdout + result.stderr); // one ERROR, no FAIL
  const lines = result.stdout.split("\n");
  assert.match(lines[0], /^PASS waitlist@/);
  assert.ok(lines.some(line => /^ERROR \(spec 2\)/.test(line)), result.stdout);
  assert.match(result.stdout, /^3 specs, \d at a time: 2 PASS, 1 ERROR$/m);
  assert.equal((await receiptNames(receipts)).length, 2);
  assert.deepEqual((await verifyChain(receipts, key)).problems, []);

  const json = await cli(["--spec", WAITLIST, "--spec", broken, "--key-file", keyFile, "--receipts", receipts, "--json"]);
  const parsed = JSON.parse(json.stdout);
  assert.deepEqual(parsed.map(item => item.verdict), ["PASS", "ERROR"]);
});

test("two run processes at once on one receipts directory both seal, whichever finishes first", TIMEOUT, async t => {
  const { keyFile, receipts } = await workspace(t);
  const args = ["--spec", WAITLIST, "--key-file", keyFile, "--receipts", receipts];
  const results = await Promise.all([cli(args), cli(args), cli(args)]);
  for (const result of results) assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal((await receiptNames(receipts)).length, 3);
  const verified = await verifyChain(receipts, key);
  assert.deepEqual(verified.problems, []);
  assert.equal(verified.checked, 3);
});

test("--jobs must be a whole number of 1 or more", TIMEOUT, async t => {
  const { keyFile, receipts } = await workspace(t);
  for (const jobs of ["0", "007", "two", "1.5"]) {
    const result = await cli(["--spec", WAITLIST, "--key-file", keyFile, "--receipts", receipts, "--jobs", jobs]);
    assert.equal(result.status, 2, jobs);
    assert.match(result.stderr, /--jobs takes a whole number/, jobs);
  }
});
