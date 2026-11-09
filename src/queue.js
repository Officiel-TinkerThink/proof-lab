// queue: leave a batch of specs and poll for it. `submit` writes a job and returns its id at once; a background worker runs the
// job (all its specs concurrently, within the machine-wide slots of slots.js) and writes the result into the job; `status`
// reads it. Receipts and evidence are written by the runs exactly as `run` writes them: a job file is bookkeeping, not evidence.
// Usage: node src/lab.js queue submit (--spec <file.json> ... | --spec-dir <dir>) --key-file <path> [--receipts <dir>] [--jobs N] [--no-worker] [--json]
//        node src/lab.js queue status --id <job id> [--receipts <dir>] [--json]
//        node src/lab.js queue list [--state queued|running|done|cancelled|interrupted] [--limit N] [--receipts <dir>] [--json]
//        node src/lab.js queue cancel --id <job id> [--receipts <dir>]
//        node src/lab.js queue work [--idle-exit <seconds>] [--receipts <dir>]   (started by submit; run it by hand to restart a worker)
// Exit of `status`: the job's own code once finished (0 pass, 1 a check failed, 2 error/cancelled/interrupted, 3 needs review), 4 not finished yet.
// The signing key is never stored: a job holds the path of the key file and the worker reads it when the job starts.
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { rmSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { signingKeyFromFile } from "./chain.js";
import { runCli } from "./cli.js";
import { safeLine, scrubReceiptFile, scrubText } from "./receipt-scrub.js";
import { combinedExitCode, exitCodeOf, maxJobs, runGovernor, runSpecs, specsInDir } from "./run-spec.js";
import { openExclusive, processAlive, reclaimIfStale } from "./slots.js";
import { isMainModule, parseCli } from "./spec/util.js";

export const EXIT_NOT_FINISHED = 4;
const LAB_JS = join(dirname(fileURLToPath(import.meta.url)), "lab.js");
const ID_PATTERN = /^\d{13}-[0-9a-f]{12}$/;
const JOB_FILE = /^(\d{13}-[0-9a-f]{12})\.json$/;
const DIRS = ["queued", "running", "done"];
const STATES = ["queued", "running", "done", "cancelled", "interrupted"];
const DEFAULT_IDLE_EXIT_SECONDS = 30;
const POLL_MS = 1000;
const MAX_LOOP_FAILURES = 10;

const queueRoot = receiptsDir => join(receiptsDir, ".queue");
const jobPath = (receiptsDir, dir, id) => join(queueRoot(receiptsDir), dir, `${id}.json`);

// ---- files: every write is a temp file renamed into place, every move between states is a rename (atomic: one winner) ----

async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await rename(from, to);
    } catch (error) {
      if (attempt >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error; // Windows: a reader may hold the file for a moment
      await sleep(50);
    }
  }
}

async function writeJson(path, value) {
  const temp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  const handle = await open(temp, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync(); // flushed before it is renamed into place, like the receipts
  } finally {
    await handle.close();
  }
  try {
    await renameWithRetry(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

// The job in a file, or null when it is gone. A write is atomic, so a parse error is a damaged file; one retry covers a move in flight.
async function readJob(path) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      if (attempt >= 1 || !(error instanceof SyntaxError)) throw error;
      await sleep(50);
    }
  }
}

async function jobIds(receiptsDir, dir) {
  try {
    return (await readdir(join(queueRoot(receiptsDir), dir))).map(name => JOB_FILE.exec(name)?.[1]).filter(Boolean).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

// The queue folders are private to the user on POSIX: whoever can write a job file chooses the specs the worker runs and the key
// file it signs with, so a receipts directory that others can write to must not carry a queue they can write to.
async function ensureDirs(receiptsDir) {
  for (const dir of DIRS) await mkdir(join(queueRoot(receiptsDir), dir), { recursive: true, mode: 0o700 });
}

// The job with this id wherever it is now (queued, running or done), or null.
export async function findJob(receiptsDir, id) {
  if (!ID_PATTERN.test(id)) throw new Error("--id is not a job id (it looks like 1700000000000-0123456789ab)");
  for (const dir of DIRS) {
    const job = await readJob(jobPath(receiptsDir, dir, id));
    if (job) return job;
  }
  return null;
}

const publicJob = job => ({ ...job, keyFile: undefined });

// ---- the worker: one per receipts directory, found by its lock file ----

const workerLockPath = receiptsDir => join(queueRoot(receiptsDir), "worker.lock");
// The worker rewrites its lock every WORKER_HEARTBEAT_MS; a lock not refreshed for WORKER_STALE_MS has no live worker behind it,
// whatever its process id says (a reused id). Taking over a stale lock is the reclaim of slots.js (grace for a lock mid-write, claim-then-verify).
const WORKER_HEARTBEAT_MS = 20_000;
const WORKER_STALE_MS = 120_000;

async function readWorkerLock(receiptsDir) {
  try {
    const owner = JSON.parse(await readFile(workerLockPath(receiptsDir), "utf8"));
    return Number.isInteger(owner?.pid) && typeof owner.host === "string" && Number.isFinite(owner.at) ? owner : null;
  } catch {
    return null;
  }
}

export async function workerAlive(receiptsDir) {
  const owner = await readWorkerLock(receiptsDir);
  return Boolean(owner && owner.host === hostname() && processAlive(owner.pid) && Date.now() - owner.at < WORKER_STALE_MS);
}

// A function that gives the worker lock back, or null when a live worker holds it.
async function takeWorkerLock(receiptsDir) {
  await ensureDirs(receiptsDir);
  const path = workerLockPath(receiptsDir);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    try {
      handle = await openExclusive(path);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await reclaimIfStale(path, { maxAgeMs: WORKER_STALE_MS })) continue;
      return null;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() }));
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(path, { force: true }).catch(() => {});
      throw error;
    }
    await handle.close();
    // The lock is only ever refreshed or removed while it still names this process: a worker that was suspended long enough for
    // its lock to be taken over (the machine slept) must not write over, or delete, the new holder's lock.
    const ours = async () => { const owner = await readWorkerLock(receiptsDir); return owner === null || owner.pid === process.pid; };
    const give = () => rmSync(path, { force: true });
    process.once("exit", give);
    let beating = Promise.resolve();
    const beat = setInterval(() => {
      beating = beating.then(async () => { if (await ours()) await writeJson(path, { pid: process.pid, host: hostname(), at: Date.now() }); }).catch(() => {});
    }, WORKER_HEARTBEAT_MS);
    beat.unref();
    return async () => {
      clearInterval(beat);
      process.removeListener("exit", give);
      await beating; // a refresh already under way must not land after the lock is removed and bring it back
      if (await ours()) await rm(path, { force: true });
    };
  }
  return null;
}

// Starts the background worker unless one is running. It outlives this process.
export function startWorker(receiptsDir, { idleExitSeconds = DEFAULT_IDLE_EXIT_SECONDS } = {}) {
  const child = spawn(process.execPath, [LAB_JS, "queue", "work", "--receipts", receiptsDir, "--idle-exit", String(idleExitSeconds)], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {}); // a worker that cannot start leaves the job queued; `status` says no worker is running
  child.unref();
}

// ---- jobs ----

// The decision on a queued job - run it or cancel it - is taken by whoever creates its claim file first. An exclusive create has
// one winner; a rename does not (two renames of one file can both succeed on Windows), so the moves between states are only ever
// done by the holder of the claim.
const claimPath = (receiptsDir, id) => join(queueRoot(receiptsDir), "running", `${id}.claim`);

async function takeClaim(receiptsDir, id) {
  try {
    const handle = await openExclusive(claimPath(receiptsDir, id));
    await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname() }));
    await handle.close();
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

// A claimed job that never started (no run began) goes back to queued/ and its claim is dropped. Best effort: if this fails too,
// the next worker's settleOrphans does the same, because the job still says state "queued".
async function putBack(receiptsDir, id) {
  try {
    await renameWithRetry(jobPath(receiptsDir, "running", id), jobPath(receiptsDir, "queued", id));
    await rm(claimPath(receiptsDir, id), { force: true });
  } catch { /* settled by the next worker */ }
}

// Takes the oldest queued job that nobody has claimed, or null.
async function claimNext(receiptsDir) {
  for (const id of await jobIds(receiptsDir, "queued")) {
    if (!(await takeClaim(receiptsDir, id))) continue; // claimed by a worker or a cancel
    const from = jobPath(receiptsDir, "queued", id);
    const to = jobPath(receiptsDir, "running", id);
    try {
      await renameWithRetry(from, to);
    } catch (error) {
      if (error.code === "ENOENT") continue; // gone since it was listed
      throw error;
    }
    let job;
    try {
      job = await readJob(to);
    } catch (error) {
      if (!(error instanceof SyntaxError)) { await putBack(receiptsDir, id); throw error; } // a failed read is not a damaged file
      job = null;
    }
    if (!job) { // damaged: set it aside where no listing reads it, and go on
      await renameWithRetry(to, join(queueRoot(receiptsDir), "done", `${id}.unreadable`)).catch(() => {});
      continue;
    }
    const started = { ...job, state: "running", startedAt: new Date().toISOString(), workerPid: process.pid, workerHost: hostname() };
    try {
      await writeJson(to, started);
    } catch (error) {
      await putBack(receiptsDir, id); // nothing has run yet: the job goes back to the queue instead of being stranded
      throw error;
    }
    return started;
  }
  return null;
}

async function finish(receiptsDir, job, fields) {
  const done = { ...job, ...fields, state: fields.state ?? "done", finishedAt: new Date().toISOString() };
  await writeJson(jobPath(receiptsDir, "running", job.id), done);
  await renameWithRetry(jobPath(receiptsDir, "running", job.id), jobPath(receiptsDir, "done", job.id));
  return done;
}

const summaryOf = (receipt, specPath) => ({
  specPath,
  spec: receipt.spec ?? null,
  verdict: receipt.verdict,
  totals: receipt.totals ?? null,
  needsReview: receipt.review?.total ?? 0,
  receiptFile: receipt.detail?.receiptPath ? scrubReceiptFile(receipt.detail.receiptPath) : null,
  error: receipt.error ? scrubText(String(receipt.error)) : null,
});

// Runs one claimed job and files its result. A failure of the job itself (the key cannot be read) is the job's error, exit 2.
// Filing the result is outside the try: if that fails, the error is the worker's, not "the job could not run", and the job stays
// in running/ where the next worker settles it as interrupted (its receipts, if any, are listed by `list`).
export async function runJob(receiptsDir, job, { run = runSpecs, loadKey = signingKeyFromFile, governor } = {}) {
  let outcome;
  try {
    if (process.env.PROOF_LAB_KEY !== undefined) throw new Error("PROOF_LAB_KEY is set in the worker's environment; unset it and start the worker again");
    const key = await loadKey(job.keyFile);
    const receipts = await run(job.specs, { key, receiptsDir, jobs: Math.min(job.jobs ?? Infinity, maxJobs()), governor });
    outcome = { exitCode: combinedExitCode(receipts.map(exitCodeOf)), results: receipts.map((receipt, i) => summaryOf(receipt, job.specs[i])), error: null };
  } catch (error) {
    outcome = { exitCode: 2, results: [], error: `the job could not run: ${safeLine(error)}` };
  }
  return finish(receiptsDir, job, outcome);
}

// Jobs a dead worker left in running/: its runs may have written receipts, so they are not run again; submit the job again.
async function settleOrphans(receiptsDir) {
  // A queued job with a claim file was claimed by a worker (or a cancel) that died before moving it: it is queued again.
  for (const id of await jobIds(receiptsDir, "queued")) await rm(claimPath(receiptsDir, id), { force: true });
  for (const id of await jobIds(receiptsDir, "running")) {
    const job = await readJob(jobPath(receiptsDir, "running", id)).catch(() => null);
    if (!job || (job.workerHost ?? job.host) !== hostname()) continue; // another host's worker may still be running it
    if (job.state === "queued") { // claimed, but the worker stopped before it started anything: it is queued again, not lost
      await putBack(receiptsDir, id);
      continue;
    }
    if (job.state !== "running") { // it was filed, and the worker stopped before the move to done/: the result stands
      const filed = await readJob(jobPath(receiptsDir, "done", id)).catch(() => null);
      if (filed) await rm(jobPath(receiptsDir, "running", id), { force: true }); // never replace a result already in done/
      else await renameWithRetry(jobPath(receiptsDir, "running", id), jobPath(receiptsDir, "done", id));
      continue;
    }
    await finish(receiptsDir, job, { state: "interrupted", exitCode: 2, results: job.results ?? [], error: "the worker stopped before this job finished; some specs may have written receipts (see `list`); submit the job again" });
  }
}

// The worker: runs queued jobs, several at a time (the slots of slots.js keep the runs themselves within the machine), and
// stops after `idleExitSeconds` with nothing queued or running. Returns the number of jobs it ran.
export async function workQueue(receiptsDir, { idleExitSeconds = DEFAULT_IDLE_EXIT_SECONDS, pollMs = POLL_MS, ...deps } = {}) {
  let ran = 0;
  for (;;) {
    const give = await takeWorkerLock(receiptsDir);
    if (!give) return ran; // a live worker has it
    try {
      await settleOrphans(receiptsDir);
      let stop = false;
      let busy = 0;
      let lastActivity = Date.now();
      // One governor for every job: memory and CPU headroom are judged for the worker as a whole, not once per job.
      const governor = deps.governor ?? runGovernor();
      // A failure in one loop (a full disk, a file that cannot be moved) must not end the others mid-job or free the lock under
      // them: the loop reports it, waits, and tries again; ten in a row end this loop, and when none is left the worker ends.
      const loop = async () => {
        let failures = 0;
        while (!stop && failures < MAX_LOOP_FAILURES) {
          try {
            const job = await claimNext(receiptsDir);
            if (job) {
              busy += 1;
              try {
                await runJob(receiptsDir, job, { ...deps, governor });
                ran += 1;
              } finally {
                busy -= 1;
                lastActivity = Date.now();
              }
              failures = 0;
              continue;
            }
            failures = 0;
            if (busy === 0 && Date.now() - lastActivity >= idleExitSeconds * 1000) { stop = true; break; }
          } catch (error) {
            failures += 1;
            console.error(`queue worker: ${safeLine(error)}`);
          }
          await sleep(pollMs);
        }
      };
      await Promise.all(Array.from({ length: maxJobs() }, loop));
    } finally {
      await give();
    }
    // A job submitted while the worker was deciding to stop must not wait for nobody.
    if ((await jobIds(receiptsDir, "queued")).length === 0) return ran;
  }
}

// ---- commands ----

async function submit(values, receiptsDir) {
  if (process.env.PROOF_LAB_KEY !== undefined) throw new Error("PROOF_LAB_KEY is set in the environment; unset it and pass the key with --key-file <path>");
  if (!values["key-file"]) throw new Error("--key-file <path> is required: the signing key is read from a 0600 file");
  if (!values.spec?.length && !values["spec-dir"]?.length) throw new Error("--spec <file.json> or --spec-dir <dir> is required");
  if (values.jobs !== undefined && !/^[1-9]\d{0,5}$/.test(values.jobs)) throw new Error("--jobs takes a whole number of 1 or more");
  const fromDirs = [];
  for (const dir of values["spec-dir"] ?? []) fromDirs.push(...await specsInDir(dir));
  const specs = [...(values.spec ?? []), ...fromDirs].map(path => resolve(path));
  for (const spec of specs) {
    const info = await stat(spec).catch(() => null);
    if (!info?.isFile()) throw new Error(`spec file not found: ${scrubText(spec)}`);
  }
  const keyFile = resolve(values["key-file"]);
  await signingKeyFromFile(keyFile); // fail now, not when the job starts; the key itself is dropped at once
  await ensureDirs(receiptsDir);
  const id = `${String(Date.now()).padStart(13, "0")}-${randomBytes(6).toString("hex")}`;
  const job = { id, state: "queued", submittedAt: new Date().toISOString(), submittedBy: userInfo().username, host: hostname(), specs, keyFile, jobs: values.jobs === undefined ? null : Number(values.jobs), startedAt: null, finishedAt: null, workerPid: null, exitCode: null, results: null, error: null };
  await writeJson(jobPath(receiptsDir, "queued", id), job);
  const startedWorker = !values["no-worker"] && !(await workerAlive(receiptsDir));
  if (startedWorker) startWorker(receiptsDir);
  if (values.json) console.log(JSON.stringify({ id, state: "queued", specs: specs.length, workerStarted: startedWorker }, null, 2));
  else console.log(`${id}\n  queued ${specs.length} spec(s); poll with: node src/lab.js queue status --id ${id}${values["no-worker"] ? "\n  no worker started: run `queue work` to run it" : ""}`);
  return 0;
}

function printJob(job, worker) {
  console.log(`job ${job.id}: ${job.state.toUpperCase()}`);
  console.log(`  submitted ${job.submittedAt} by ${job.submittedBy}@${job.host}, ${job.specs.length} spec(s)`);
  if (job.startedAt) console.log(`  started   ${job.startedAt}`);
  if (job.finishedAt) console.log(`  finished  ${job.finishedAt}`);
  if (job.cancelledBy) console.log(`  cancelled by ${job.cancelledBy}`);
  for (const result of job.results ?? []) console.log(`  ${result.verdict} ${result.spec ?? result.specPath}${result.receiptFile ? `  receipt: ${result.receiptFile}` : ""}${result.needsReview ? `  (${result.needsReview} claim(s) need review)` : ""}${result.error ? `  error: ${result.error}` : ""}`);
  if (job.error) console.log(`  error: ${scrubText(job.error)}`);
  if ((job.state === "queued" || job.state === "running") && !worker) console.log("  no worker is running: start one with `node src/lab.js queue work`");
}

async function status(values, receiptsDir) {
  if (!values.id) throw new Error("--id <job id> is required");
  const job = await findJob(receiptsDir, values.id);
  if (!job) throw new Error("no job with that id in this receipts directory");
  const worker = await workerAlive(receiptsDir);
  if (values.json) console.log(JSON.stringify({ ...publicJob(job), workerRunning: worker }, null, 2));
  else printJob(job, worker);
  if (job.state === "queued" || job.state === "running") return EXIT_NOT_FINISHED;
  return job.exitCode ?? 2;
}

async function list(values, receiptsDir) {
  if (values.state !== undefined && !STATES.includes(values.state)) throw new Error(`--state is one of ${STATES.join(", ")}`);
  if (values.limit !== undefined && !/^[1-9]\d{0,5}$/.test(values.limit)) throw new Error("--limit takes a whole number of 1 or more");
  const limit = values.limit === undefined ? 20 : Number(values.limit);
  const jobs = [];
  for (const dir of DIRS) {
    for (const id of await jobIds(receiptsDir, dir)) {
      const job = await readJob(jobPath(receiptsDir, dir, id)).catch(() => null);
      if (job && (values.state === undefined || job.state === values.state)) jobs.push(job);
    }
  }
  jobs.sort((a, b) => (a.id < b.id ? 1 : -1));
  const shown = jobs.slice(0, limit);
  if (values.json) console.log(JSON.stringify(shown.map(publicJob), null, 2));
  else if (shown.length === 0) console.log("no jobs");
  else for (const job of shown) console.log(`${job.id}  ${job.state.padEnd(11)} ${String(job.specs.length).padStart(3)} spec(s)  ${job.submittedAt}${job.exitCode === null ? "" : `  exit ${job.exitCode}`}`);
  return 0;
}

async function cancel(values, receiptsDir) {
  if (!values.id) throw new Error("--id <job id> is required");
  if (!ID_PATTERN.test(values.id)) throw new Error("--id is not a job id (it looks like 1700000000000-0123456789ab)");
  await ensureDirs(receiptsDir);
  const notQueued = () => {
    console.error("that job is not queued (it is running, finished, or does not exist); a running job cannot be cancelled");
    return 2;
  };
  if (!(await takeClaim(receiptsDir, values.id))) return notQueued(); // a worker (or an earlier cancel) decided first
  try {
    await renameWithRetry(jobPath(receiptsDir, "queued", values.id), jobPath(receiptsDir, "done", values.id));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await rm(claimPath(receiptsDir, values.id), { force: true }); // there was no such queued job: leave no claim behind
    return notQueued();
  }
  const path = jobPath(receiptsDir, "done", values.id);
  const job = await readJob(path);
  await writeJson(path, { ...job, state: "cancelled", cancelledBy: `${userInfo().username}@${hostname()}`, finishedAt: new Date().toISOString(), exitCode: 2 });
  console.log(`job ${values.id}: CANCELLED`);
  return 0;
}

async function work(values, receiptsDir) {
  if (values["idle-exit"] !== undefined && !/^\d{1,6}$/.test(values["idle-exit"])) throw new Error("--idle-exit takes a whole number of seconds (0 stops as soon as nothing is queued)");
  const ran = await workQueue(receiptsDir, values["idle-exit"] === undefined ? {} : { idleExitSeconds: Number(values["idle-exit"]) });
  console.log(`worker done: ${ran} job(s) run`);
  return 0;
}

const COMMON = { receipts: { type: "string" }, json: { type: "boolean" } };
const SUBCOMMANDS = {
  submit: { options: { ...COMMON, spec: { type: "string", multiple: true }, "spec-dir": { type: "string", multiple: true }, "key-file": { type: "string" }, jobs: { type: "string" }, "no-worker": { type: "boolean" } }, run: submit },
  status: { options: { ...COMMON, id: { type: "string" } }, run: status },
  list: { options: { ...COMMON, state: { type: "string" }, limit: { type: "string" } }, run: list },
  cancel: { options: { ...COMMON, id: { type: "string" } }, run: cancel },
  work: { options: { ...COMMON, "idle-exit": { type: "string" } }, run: work },
};

export async function main(args, { defaultReceipts }) {
  const [name, ...rest] = args;
  if (name === undefined || !Object.hasOwn(SUBCOMMANDS, name)) {
    console.error(`usage: node src/lab.js queue <${Object.keys(SUBCOMMANDS).join("|")}> [options]`);
    return 2;
  }
  const values = parseCli(rest, SUBCOMMANDS[name].options);
  return SUBCOMMANDS[name].run(values, resolve(values.receipts ?? defaultReceipts));
}

if (isMainModule(import.meta.url)) {
  await runCli(() => main(process.argv.slice(2), { defaultReceipts: process.env.PROOF_LAB_RECEIPTS ?? join(dirname(LAB_JS), "..", "receipts") }));
}
