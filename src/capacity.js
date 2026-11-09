// How many runs the machine can carry at once, and when the next one may start.
// Each run is a browser (and often an app server): the ceiling follows cores and memory, and a governor holds a new run back
// while the machine is short of memory or hot on CPU, so many runs go at once without crashing the host or VM.
import { availableParallelism, cpus, freemem, loadavg, totalmem } from "node:os";
import { setTimeout as sleepMs } from "node:timers/promises";

export const RUN_MEMORY_BYTES = 1024 ** 3;        // what one run (browser + app server) is assumed to need
export const MEMORY_RESERVE_BYTES = 1024 ** 3;    // always left for the OS and everything else
export const TOTAL_MEMORY_SHARE = 0.75;           // the most of the machine's memory the runs may be planned against
export const CPU_BUSY_LIMIT = 0.85;               // no new run while the CPUs are busier than this
export const LOAD_PER_CORE_LIMIT = 1.25;          // no new run while the 1-minute load average per core is above this (POSIX)
export const SETTLE_MS = 250;                    // a started run needs time to show in the numbers before the next is judged
export const SAMPLE_MS = 250;                    // the window the CPU is measured over at each admission
export const POLL_MS = 1000;

// A browser run mostly waits (for the page, the network, the app), so a worker serves more than one run. The governor, not this
// number, keeps the machine from being overloaded: it holds a new run back above CPU_BUSY_LIMIT or when memory runs short.
export const RUNS_PER_WORKER = 2;

// The most runs worth planning for: RUNS_PER_WORKER per worker, and no more than memory allows. At least one.
export function maxJobs(parallelism = availableParallelism(), totalMemory = totalmem(), perRun = RUN_MEMORY_BYTES) {
  const byMemory = Math.floor((totalMemory * TOTAL_MEMORY_SHARE) / perRun);
  return Math.max(1, Math.min(parallelism * RUNS_PER_WORKER, byMemory));
}

// Busy share (0..1) of all CPUs between two cpus() readings.
export function cpuBusyBetween(before, after) {
  let idle = 0;
  let total = 0;
  for (let i = 0; i < Math.min(before.length, after.length); i += 1) {
    const b = before[i].times;
    const a = after[i].times;
    const sum = t => t.user + t.nice + t.sys + t.idle + t.irq;
    idle += a.idle - b.idle;
    total += sum(a) - sum(b);
  }
  return total > 0 ? Math.min(1, Math.max(0, 1 - idle / total)) : 0;
}

// May one more run start? Pure: the caller passes the readings. Returns { ok, reason }.
export function headroom({ freeMemory, cpuBusy, load1, cores }, perRun = RUN_MEMORY_BYTES) {
  if (freeMemory < perRun + MEMORY_RESERVE_BYTES) return { ok: false, reason: "memory" };
  if (cpuBusy > CPU_BUSY_LIMIT) return { ok: false, reason: "cpu" };
  if (load1 / Math.max(1, cores) > LOAD_PER_CORE_LIMIT) return { ok: false, reason: "load" };
  return { ok: true, reason: null };
}

// The readings of this machine now. cpuBusy is measured over the time since `previous` (a cpus() reading).
export function readMachine(previous) {
  const now = cpus();
  return { reading: { freeMemory: freemem(), cpuBusy: previous ? cpuBusyBetween(previous, now) : 0, load1: loadavg()[0], cores: now.length || 1 }, cpus: now };
}

// admit(running) resolves, with a function that gives the run's slot back, when one more run may start.
// Headroom: with none of this pool's runs in flight it is not waited for (the pool must always make progress); otherwise it
// waits for memory and CPU, one admission at a time with a settle pause after each, so a burst of finished runs cannot all
// start on the same stale numbers.
// Slot: `acquire()` (see slots.js) resolves to a release function, or null while every slot of the machine is held by runs of
// other processes; it is waited for, since those runs end or their holders are reclaimed. The default has no limit.
export function createGovernor({ read = readMachine, sleep = sleepMs, perRun = RUN_MEMORY_BYTES, onWait = () => {}, acquire = async () => () => {} } = {}) {
  let gate = Promise.resolve();
  // Runs this governor has admitted and not yet seen released. A governor shared by several pools (the queue worker's jobs)
  // counts all of them, so "nothing is running" means nothing, not just nothing in one pool.
  let active = 0;
  const admit = ownRunning => {
    const running = () => Math.max(ownRunning(), active);
    const turn = gate.then(async () => {
      for (;;) {
        if (running() > 0) {
          // CPU is measured over a fresh window right now: a reading kept from minutes ago would average a spike away.
          const baseline = read(null).cpus;
          await sleep(SAMPLE_MS);
          if (running() > 0) { // else the last run ended during the sample: nothing is running, so do not hold this one back
            const verdict = headroom(read(baseline).reading, perRun);
            if (!verdict.ok) {
              onWait(verdict.reason);
              await sleep(POLL_MS);
              continue;
            }
          }
        }
        const release = await acquire();
        if (release) {
          if (running() > 0) await sleep(SETTLE_MS);
          active += 1;
          let given = false;
          return async () => {
            if (given) return;
            given = true;
            active -= 1;
            await release();
          };
        }
        onWait("slots");
        await sleep(POLL_MS);
      }
    });
    gate = turn.catch(() => {});
    return turn;
  };
  return { admit };
}
