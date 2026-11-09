// The machine-wide slots (slots.js) and the job queue (queue.js). The queue is driven with a fake run and a fake key: what is
// under test is the bookkeeping (claim, finish, cancel, orphans, one worker), not the browsers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { createGovernor } from "../src/capacity.js";
import { findJob, main as queueMain, runJob, workQueue, workerAlive } from "../src/queue.js";
import { inPool } from "../src/run-spec.js";
import { SLOT_MAX_AGE_MS, slotsInUse, tryAcquireSlot } from "../src/slots.js";

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "proof-queue-"));
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

const DEAD_PID = 2147483646;

// ---- slots ----

test("slots: no more than `limit` are held at once, and a given-back slot can be taken again", async t => {
  const dir = await tempDir(t);
  const a = await tryAcquireSlot(2, dir);
  const b = await tryAcquireSlot(2, dir);
  assert.ok(a && b);
  assert.equal(await tryAcquireSlot(2, dir), null);
  assert.equal(await slotsInUse(2, dir), 2);
  await a();
  await a(); // giving back twice is harmless
  const c = await tryAcquireSlot(2, dir);
  assert.ok(c);
  assert.equal(await tryAcquireSlot(2, dir), null);
  await b();
  await c();
  assert.equal(await slotsInUse(2, dir), 0);
});

test("slots: a slot whose holder is gone is reclaimed; a live one is not", async t => {
  const dir = await tempDir(t);
  await writeFile(join(dir, "slot-0.lock"), JSON.stringify({ pid: DEAD_PID, at: Date.now() }));
  const taken = await tryAcquireSlot(1, dir);
  assert.ok(taken, "a dead holder's slot is reclaimed");
  assert.equal(await tryAcquireSlot(1, dir), null, "now it is held by this live process");
  await taken();
  await writeFile(join(dir, "slot-0.lock"), JSON.stringify({ pid: process.pid, at: Date.now() }));
  assert.equal(await tryAcquireSlot(1, dir), null, "a live holder keeps its slot");
});

test("slots: a slot older than the age limit is a leak even if its pid is alive (a reused id)", async t => {
  const dir = await tempDir(t);
  await writeFile(join(dir, "slot-0.lock"), JSON.stringify({ pid: process.pid, at: Date.now() - SLOT_MAX_AGE_MS - 1000 }));
  assert.ok(await tryAcquireSlot(1, dir));
});

test("slots: a slot file that is still being written is not taken from its holder", async t => {
  const dir = await tempDir(t);
  await writeFile(join(dir, "slot-0.lock"), "");
  assert.equal(await tryAcquireSlot(1, dir), null);
});

test("the governor waits while every slot is held elsewhere, then admits and hands out the release", async () => {
  let offers = 0;
  const waits = [];
  let released = 0;
  const { admit } = createGovernor({
    read: () => ({ reading: { freeMemory: 8 * 1024 ** 3, cpuBusy: 0, load1: 0, cores: 4 }, cpus: [] }),
    sleep: async () => {},
    onWait: reason => waits.push(reason),
    acquire: async () => { offers += 1; return offers < 3 ? null : async () => { released += 1; }; },
  });
  const release = await admit(() => 0);
  assert.deepEqual(waits, ["slots", "slots"]);
  assert.equal(typeof release, "function");
  await release();
  assert.equal(released, 1);
});

test("inPool gives every slot back, also when a run throws, and when a worker finds nothing left", async () => {
  let taken = 0;
  let given = 0;
  const admit = async () => { taken += 1; return async () => { given += 1; }; };
  await assert.rejects(() => inPool([1, 2, 3], 3, async n => { if (n === 2) throw new Error("boom"); }, { admit }), /boom/);
  assert.equal(given, taken, "every slot taken was given back");
  taken = 0;
  given = 0;
  await inPool([1], 4, async () => {}, { admit }); // four workers, one item: three admissions find nothing left
  assert.equal(given, taken);
});

// ---- queue ----

const KEY = "k".repeat(48);
const fakeLoadKey = async () => Buffer.from(KEY);
const passing = (specPath, extra = {}) => ({ verdict: "PASS", spec: specPath.split(/[\\/]/).pop(), app: "http://127.0.0.1:1", totals: { checks: 1, passed: 1, failed: 0 }, checks: [], review: { total: 0, items: [] }, detail: { receiptPath: join(tmpdir(), `${Date.now()}-abc.json`) }, ...extra });

async function quiet(fn) {
  const lines = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  try {
    return { code: await fn(), out: lines.join("\n") };
  } finally {
    console.log = log;
    console.error = err;
  }
}

async function setup(t) {
  const dir = await tempDir(t);
  const spec = join(dir, "a.json");
  const other = join(dir, "b.json");
  await writeFile(spec, "{}");
  await writeFile(other, "{}");
  const keyFile = join(dir, "key");
  await writeFile(keyFile, KEY, { mode: 0o600 });
  const receipts = join(dir, "receipts");
  await mkdir(receipts);
  const q = args => quiet(() => queueMain(args, { defaultReceipts: receipts }));
  const submit = async (...specs) => {
    const { code, out } = await q(["submit", ...specs.flatMap(s => ["--spec", s]), "--key-file", keyFile, "--no-worker", "--json"]);
    assert.equal(code, 0);
    return JSON.parse(out).id;
  };
  return { dir, spec, other, keyFile, receipts, q, submit };
}

test("queue: submit returns an id at once; the job is queued, holds no key, and status says not finished (4)", async t => {
  const { spec, keyFile, receipts, q, submit } = await setup(t);
  const id = await submit(spec);
  const job = await findJob(receipts, id);
  assert.equal(job.state, "queued");
  assert.equal(job.specs.length, 1);
  assert.equal(job.keyFile, keyFile);
  assert.ok(!JSON.stringify(job).includes(KEY), "the key itself is never stored");
  const { code, out } = await q(["status", "--id", id, "--json"]);
  assert.equal(code, 4);
  assert.equal(JSON.parse(out).state, "queued");
  assert.equal(JSON.parse(out).keyFile, undefined, "status does not print the key file path");
});

test("queue: a worker runs the job; status then gives its results and exit code, and the worker stops and frees its lock", async t => {
  const { spec, other, receipts, q, submit } = await setup(t);
  const id = await submit(spec, other);
  const seen = [];
  const ran = await workQueue(receipts, { idleExitSeconds: 0, pollMs: 10, loadKey: fakeLoadKey, run: async (specs, options) => { seen.push({ specs, jobs: options.jobs, dir: options.receiptsDir }); return specs.map(passing); } });
  assert.equal(ran, 1);
  assert.deepEqual(seen[0].specs.map(s => s.split(/[\\/]/).pop()), ["a.json", "b.json"]);
  assert.equal(seen[0].dir, receipts);
  const { code, out } = await q(["status", "--id", id, "--json"]);
  assert.equal(code, 0);
  const job = JSON.parse(out);
  assert.equal(job.state, "done");
  assert.equal(job.exitCode, 0);
  assert.equal(job.results.length, 2);
  assert.ok(job.results.every(r => r.verdict === "PASS" && r.receiptFile));
  assert.equal(await workerAlive(receipts), false);
  assert.deepEqual((await readdir(join(receipts, ".queue"))).sort(), ["done", "queued", "running"]);
  assert.deepEqual((await readdir(receipts)).filter(name => name.endsWith(".json")), [], "no job file is mistaken for a receipt");
});

test("queue: the job's exit code is the combined one: FAIL over ERROR over needs-review over PASS", async t => {
  const { spec, other, receipts, q, submit } = await setup(t);
  const failing = await submit(spec, other);
  await workQueue(receipts, { idleExitSeconds: 0, pollMs: 10, loadKey: fakeLoadKey, run: async specs => [passing(specs[0]), passing(specs[1], { verdict: "FAIL" })] });
  assert.equal((await q(["status", "--id", failing])).code, 1);
  const review = await submit(spec);
  await workQueue(receipts, { idleExitSeconds: 0, pollMs: 10, loadKey: fakeLoadKey, run: async specs => [passing(specs[0], { review: { total: 2, items: [] } })] });
  const { code, out } = await q(["status", "--id", review]);
  assert.equal(code, 3);
  assert.match(out, /2 claim\(s\) need review/);
});

test("queue: a key that cannot be read fails the job with exit 2 and the error, and the worker goes on", async t => {
  const { spec, receipts, q, submit } = await setup(t);
  const bad = await submit(spec);
  const good = await submit(spec);
  let calls = 0;
  await workQueue(receipts, {
    idleExitSeconds: 0, pollMs: 10, run: async specs => specs.map(passing),
    loadKey: async () => { calls += 1; if (calls === 1) throw new Error("key file must hold at least 32 bytes"); return Buffer.from(KEY); },
  });
  // The jobs run side by side, so which of the two met the unreadable key is not fixed: one failed, one went on.
  const results = [await q(["status", "--id", bad, "--json"]), await q(["status", "--id", good, "--json"])];
  assert.deepEqual(results.map(r => r.code).sort(), [0, 2]);
  assert.match(JSON.parse(results.find(r => r.code === 2).out).error, /could not run: .*at least 32 bytes/);
});

test("queue: jobs are taken oldest first, and several run at once", async t => {
  const { spec, receipts, submit } = await setup(t);
  const ids = [await submit(spec), await submit(spec), await submit(spec)];
  const started = [];
  let running = 0;
  let peak = 0;
  await workQueue(receipts, { idleExitSeconds: 0, pollMs: 10, loadKey: fakeLoadKey, run: async specs => {
    started.push(specs);
    running += 1;
    peak = Math.max(peak, running);
    await new Promise(resolve => setTimeout(resolve, 80));
    running -= 1;
    return specs.map(passing);
  } });
  assert.equal(started.length, 3);
  for (const id of ids) assert.equal((await findJob(receipts, id)).state, "done");
  assert.ok(peak >= 2 || (await import("node:os")).availableParallelism() < 2, `jobs overlap (peak ${peak})`);
});

test("queue: only one worker runs per receipts directory", async t => {
  const { spec, receipts, submit } = await setup(t);
  await submit(spec);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = workQueue(receipts, { idleExitSeconds: 0, pollMs: 10, loadKey: fakeLoadKey, run: async specs => { await gate; return specs.map(passing); } });
  for (let i = 0; i < 100 && !(await workerAlive(receipts)); i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await workerAlive(receipts), true);
  assert.equal(await workQueue(receipts, { idleExitSeconds: 0, pollMs: 10, loadKey: fakeLoadKey, run: async () => assert.fail("a second worker must not run") }), 0);
  release();
  assert.equal(await first, 1);
});

test("queue: a job a dead worker left running is settled as interrupted, not run again", async t => {
  const { spec, receipts, q, submit } = await setup(t);
  const id = await submit(spec);
  const { rename } = await import("node:fs/promises");
  await mkdir(join(receipts, ".queue", "running"), { recursive: true });
  const path = join(receipts, ".queue");
  const job = await findJob(receipts, id);
  await rm(join(path, "queued", `${id}.json`));
  await writeFile(join(path, "running", `${id}.json`), JSON.stringify({ ...job, state: "running", host: hostname(), workerPid: DEAD_PID, startedAt: new Date().toISOString() }));
  await workQueue(receipts, { idleExitSeconds: 0, pollMs: 10, loadKey: fakeLoadKey, run: async () => assert.fail("an interrupted job is not run again") });
  const { code, out } = await q(["status", "--id", id, "--json"]);
  assert.equal(code, 2);
  assert.equal(JSON.parse(out).state, "interrupted");
  assert.match(JSON.parse(out).error, /submit the job again/);
  void rename;
});

test("queue: cancel stops a queued job and refuses one that already finished", async t => {
  const { spec, receipts, q, submit } = await setup(t);
  const id = await submit(spec);
  const cancelled = await q(["cancel", "--id", id]);
  assert.equal(cancelled.code, 0);
  assert.equal((await findJob(receipts, id)).state, "cancelled");
  assert.equal((await q(["status", "--id", id])).code, 2);
  assert.equal(await workQueue(receipts, { idleExitSeconds: 0, pollMs: 10, loadKey: fakeLoadKey, run: async () => assert.fail("a cancelled job is not run") }), 0);
  assert.equal((await q(["cancel", "--id", id])).code, 2, "a job that is not queued cannot be cancelled");
});

test("queue: list shows newest first and filters by state", async t => {
  const { spec, receipts, q, submit } = await setup(t);
  const older = await submit(spec);
  await new Promise(resolve => setTimeout(resolve, 5));
  const newer = await submit(spec);
  await q(["cancel", "--id", older]);
  const all = JSON.parse((await q(["list", "--json"])).out);
  assert.deepEqual(all.map(job => job.id), [newer, older]);
  assert.deepEqual(JSON.parse((await q(["list", "--state", "queued", "--json"])).out).map(job => job.id), [newer]);
  assert.equal(JSON.parse((await q(["list", "--state", "cancelled", "--json"])).out)[0].id, older);
  await assert.rejects(() => q(["list", "--state", "bogus"]), /--state is one of/);
  void receipts;
});

test("queue: an id that is not a job id is refused before any path is built from it", async t => {
  const { q } = await setup(t);
  for (const id of ["../x", "..\\..\\x", "1700000000000-xyz", ""]) {
    await assert.rejects(() => q(["status", "--id", id]), /--id/);
    await assert.rejects(() => q(["cancel", "--id", id]), /--id/);
  }
});

test("queue: submit checks its input before it queues anything", async t => {
  const { dir, spec, keyFile, receipts, q } = await setup(t);
  await assert.rejects(() => q(["submit", "--key-file", keyFile]), /--spec/);
  await assert.rejects(() => q(["submit", "--spec", spec]), /--key-file/);
  await assert.rejects(() => q(["submit", "--spec", join(dir, "missing.json"), "--key-file", keyFile]), /spec file not found/);
  await assert.rejects(() => q(["submit", "--spec", spec, "--key-file", join(dir, "nokey")]), /ENOENT|no such file/i);
  await assert.rejects(() => q(["submit", "--spec", spec, "--key-file", keyFile, "--jobs", "0"]), /--jobs/);
  assert.deepEqual(await readdir(join(receipts, ".queue", "queued")).catch(() => []), []);
});

test("queue: runJob files a job's result even when run throws", async t => {
  const { spec, receipts, submit } = await setup(t);
  const id = await submit(spec);
  const job = await findJob(receipts, id);
  const { rename } = await import("node:fs/promises");
  await mkdir(join(receipts, ".queue", "running"), { recursive: true });
  await rename(join(receipts, ".queue", "queued", `${id}.json`), join(receipts, ".queue", "running", `${id}.json`));
  const done = await runJob(receipts, job, { loadKey: fakeLoadKey, run: async () => { throw new Error("browser gone"); } });
  assert.equal(done.state, "done");
  assert.equal(done.exitCode, 2);
  assert.match(done.error, /browser gone/);
  assert.equal((await findJob(receipts, id)).state, "done");
});
