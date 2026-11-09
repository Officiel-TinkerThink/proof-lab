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
import { POLL_MS, cpuBusyBetween, createGovernor, headroom, memoryAvailable, memoryLimit } from "../src/capacity.js";

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

const GIB = 1024 ** 3;

test("maxJobs is two per worker, bounded by memory, at least one", () => {
  assert.equal(maxJobs(16, 64 * GIB), 32);
  assert.equal(maxJobs(16, 8 * GIB), 6);
  assert.equal(maxJobs(14, 23 * GIB), 17);
  assert.equal(maxJobs(8, 1 * GIB), 1);
  assert.equal(maxJobs(1, 64 * GIB), 2);
  assert.equal(maxJobs(4, 0), 1);
  assert.ok(maxJobs() >= 1);
});

test("a container's memory limit is the memory the runs are planned against, not the host's", () => {
  // As measured in a Docker container started with --memory=2g on a 12 GiB VM: totalmem() 12 GiB, constrainedMemory() 2 GiB.
  assert.equal(memoryLimit({ total: 12 * GIB, constrained: 2 * GIB }), 2 * GIB);
  assert.equal(maxJobs(8, memoryLimit({ total: 12 * GIB, constrained: 2 * GIB })), 1, "2 GiB carries one run, not the eight the host's 12 GiB would");
  // No limit: Node reports an absurdly large constrained value (or none, or 0), and the machine's memory stands.
  // `null`, not `undefined`: an explicit undefined would pick up the default, the live value of the machine the test runs on.
  assert.equal(memoryLimit({ total: 12 * GIB, constrained: 18446744073709552000 }), 12 * GIB);
  assert.equal(memoryLimit({ total: 12 * GIB, constrained: null }), 12 * GIB);
  assert.equal(memoryLimit({ total: 12 * GIB, constrained: 0 }), 12 * GIB);
  // Free memory is what is free inside the limit: availableMemory() (2.1 GB in the container) rather than the host's 11.8 GiB.
  assert.equal(memoryAvailable({ free: 11 * GIB, available: 2 * GIB }), 2 * GIB);
  assert.equal(memoryAvailable({ free: 1 * GIB, available: 5 * GIB }), 1 * GIB);
  assert.equal(memoryAvailable({ free: 3 * GIB, available: null }), 3 * GIB, "a Node without availableMemory() keeps the machine's number");
  assert.ok(memoryLimit() > 0 && memoryAvailable() >= 0);
});

test("headroom refuses a start on low memory, hot CPU or high load", () => {
  const ok = { freeMemory: 8 * GIB, cpuBusy: 0.3, load1: 1, cores: 8 };
  assert.equal(headroom(ok).ok, true);
  assert.equal(headroom({ ...ok, freeMemory: 1.5 * GIB }).reason, "memory");
  assert.equal(headroom({ ...ok, cpuBusy: 0.95 }).reason, "cpu");
  assert.equal(headroom({ ...ok, load1: 20 }).reason, "load");
});

test("cpuBusyBetween measures the busy share of all CPUs", () => {
  const t = (idle, user) => ({ times: { user, nice: 0, sys: 0, idle, irq: 0 } });
  assert.equal(cpuBusyBetween([t(0, 0), t(0, 0)], [t(50, 50), t(50, 50)]), 0.5);
  assert.equal(cpuBusyBetween([t(5, 5)], [t(5, 5)]), 0);
});

test("the governor lets the first run start at once and holds later ones while there is no headroom", async () => {
  let inFlight = 0;
  let hot = true;
  const waits = [];
  const { admit } = createGovernor({
    read: () => ({ reading: { freeMemory: 8 * GIB, cpuBusy: hot ? 0.99 : 0.1, load1: 0, cores: 4 }, cpus: [] }),
    sleep: async ms => { if (ms === POLL_MS) hot = false; },
    onWait: reason => waits.push(reason),
  });
  const first = await admit(() => inFlight);
  assert.deepEqual(waits, []);
  inFlight = 1;
  const second = await admit(() => inFlight);
  assert.deepEqual(waits, ["cpu"]);
  await first();
  await second();
  hot = true;
  inFlight = 0;
  await admit(() => inFlight); // nothing running: never blocks
  assert.deepEqual(waits, ["cpu"]);
});

test("one governor shared by several pools counts the runs of all of them, so the second pool's first run is not exempt from headroom", async () => {
  let hot = false;
  const waits = [];
  const { admit } = createGovernor({
    read: () => ({ reading: { freeMemory: 8 * GIB, cpuBusy: hot ? 0.99 : 0.1, load1: 0, cores: 4 }, cpus: [] }),
    sleep: async ms => { if (ms === POLL_MS) hot = false; },
    onWait: reason => waits.push(reason),
  });
  await admit(() => 0); // pool A's first run
  hot = true;
  await admit(() => 0); // pool B has nothing in flight itself, but A's run is: headroom is judged
  assert.deepEqual(waits, ["cpu"]);
});

test("the governor lets a run start when the last one ends during the CPU sample", async () => {
  let inFlight = 1;
  const waits = [];
  const { admit } = createGovernor({
    read: () => ({ reading: { freeMemory: 8 * GIB, cpuBusy: 0.99, load1: 0, cores: 4 }, cpus: [] }),
    sleep: async () => { inFlight = 0; },
    onWait: reason => waits.push(reason),
  });
  await admit(() => inFlight);
  assert.deepEqual(waits, []);
});

test("a burst of admissions shares one CPU sample, counts each run on it as load, and measures again when that runs out", async () => {
  let sleeps = 0;
  const { admit } = createGovernor({
    read: () => ({ reading: { freeMemory: 20 * GIB, cpuBusy: 0.05, load1: 0, cores: 4 }, cpus: [] }),
    sleep: async () => { sleeps += 1; },
    now: () => 0, // the sample never expires by age here: only the projection ends it
  });
  const gives = [];
  for (let i = 0; i < 6; i += 1) gives.push(await admit(() => 0));
  // #1 nothing running: no sample. #2 measures (1). #3-#5 ride that sample: 0.05 + 1/4, 2/4, 3/4 are all within 0.85.
  // #6 would project 1.05: measures again (2).
  assert.equal(sleeps, 2);
  for (const give of gives) await give();
});

test("a burst on one sample is also bounded by memory: each run on it counts as a whole run's memory", async () => {
  let sleeps = 0;
  const { admit } = createGovernor({
    read: () => ({ reading: { freeMemory: 4 * GIB, cpuBusy: 0.01, load1: 0, cores: 64 }, cpus: [] }),
    sleep: async () => { sleeps += 1; },
    now: () => 0,
  });
  const gives = [];
  for (let i = 0; i < 5; i += 1) gives.push(await admit(() => 0));
  // 4 GiB free, 1 GiB per run and 1 GiB reserve: #2 measures, #3 and #4 ride it (3 and 2 GiB left), #5 would leave 1 GiB: measures.
  assert.equal(sleeps, 2);
  for (const give of gives) await give();
});

test("a sample older than its limit is measured again, and a hold always takes a fresh one", async () => {
  let clock = 0;
  let hot = false;
  let reads = 0;
  const waits = [];
  const { admit } = createGovernor({
    read: () => { reads += 1; return { reading: { freeMemory: 20 * GIB, cpuBusy: hot ? 0.99 : 0.05, load1: 0, cores: 64 }, cpus: [] }; },
    sleep: async ms => { if (ms === POLL_MS) hot = false; },
    now: () => clock,
    onWait: reason => waits.push(reason),
  });
  await admit(() => 0); // no sample
  await admit(() => 0); // measures: 2 reads
  assert.equal(reads, 2);
  await admit(() => 0); // rides the sample: no read
  assert.equal(reads, 2);
  clock = 10_000;
  hot = true;
  await admit(() => 0); // too old: measures (2 reads), finds it hot, holds, measures again (2 reads), then admits
  assert.deepEqual(waits, ["cpu"]);
  assert.equal(reads, 6);
});

test("inPool with admit starts items only when admitted and still never exceeds `jobs`", async () => {
  let running = 0;
  let peak = 0;
  // A governor that reports "hot CPU" while two runs are in flight: the pool must keep to two.
  const { admit } = createGovernor({
    read: () => ({ reading: { freeMemory: 8 * GIB, cpuBusy: running >= 2 ? 0.99 : 0.1, load1: 0, cores: 4 }, cpus: [] }),
    sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5))),
    sampleMaxAgeMs: 0, // every admission measures: the mock's CPU follows `running` exactly
  });
  const results = await inPool([1, 2, 3, 4, 5, 6], 4, async n => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise(resolve => setTimeout(resolve, 30));
    running -= 1;
    return n;
  }, { admit });
  assert.deepEqual(results, [1, 2, 3, 4, 5, 6]);
  assert.ok(peak <= 2, `peak ${peak}`);
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
  assert.match(result.stdout, /^3 of 3 specs run, \d at a time: 2 PASS, 1 ERROR$/m);
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
