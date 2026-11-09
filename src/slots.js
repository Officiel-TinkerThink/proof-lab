// A machine-wide pool of run slots, so separate `run` commands and the queue worker together never exceed what this machine can
// carry. One file per slot in a directory under the OS temp folder (the resource guarded is this machine's CPU and memory,
// whatever receipts directory a run writes to). A slot is taken by creating its file exclusively and given back by removing it.
// A holder that died without giving its slot back is detected by its process id (and, against a reused id, by the slot's age).
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, link, stat } from "node:fs/promises";
import { rmSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export const SLOT_MAX_AGE_MS = 6 * 60 * 60 * 1000; // no run lasts this long: a slot this old is a leak, whatever its process id says
const HALF_WRITTEN_MS = 5000;                      // a lock file with no content yet is a holder mid-write, until it is this old

// One folder per user (and private to them on POSIX): on a shared temp folder another user's files cannot hold this user's slots.
// The slots of two users on one machine are then counted apart; Windows keeps a temp folder per user anyway.
const userKey = () => { try { return userInfo().username.replace(/[^A-Za-z0-9._-]/g, "_"); } catch { return "user"; } };
export const slotsDir = () => process.env.PROOF_LAB_SLOTS_DIR || join(tmpdir(), `proof-lab-slots-${userKey()}`);

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM"; // exists, but not ours to signal
  }
}

// Windows answers EPERM/EACCES/EBUSY to a create of a file that was just removed while a handle (a scanner, the remover) still
// keeps it delete-pending. That passes within a moment, so the create is retried a few times; EEXIST and anything else throw.
const TRANSIENT_CREATE = new Set(["EPERM", "EACCES", "EBUSY"]);
export const isTransientCreateError = error => TRANSIENT_CREATE.has(error?.code);
export async function openExclusive(path, { attempts = 5, waitMs = 50 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await open(path, "wx");
    } catch (error) {
      if (attempt >= attempts || !isTransientCreateError(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }
}

async function readOwner(path) {
  try {
    const owner = JSON.parse(await readFile(path, "utf8"));
    return Number.isInteger(owner?.pid) && owner.pid > 0 && Number.isFinite(owner.at) ? owner : null;
  } catch {
    return null;
  }
}

// True when the lock file's holder is gone and the file was removed (or was already gone); false when it is held. The holder
// is gone when its process is, or when the file is older than `maxAgeMs` (a reused process id), or when it never got content
// and is past the grace for a holder mid-write. A lock of another host is never reclaimed. Used for slots and the worker lock.
export async function reclaimIfStale(path, { maxAgeMs = SLOT_MAX_AGE_MS } = {}) {
  const owner = await readOwner(path);
  if (!owner) {
    const info = await stat(path).catch(() => null);
    if (!info) return true;
    if (Date.now() - info.mtimeMs < HALF_WRITTEN_MS) return false;
  } else if (owner.host !== undefined && owner.host !== hostname()) {
    return false;
  } else if (processAlive(owner.pid) && Date.now() - owner.at < maxAgeMs) {
    return false;
  }
  // Take it out of the way under a name of our own first, then check it is still the file we judged: a fresh holder may
  // have created it in between, and then it is put back.
  const claimed = `${path}.stale-${randomBytes(6).toString("hex")}`;
  try {
    await rename(path, claimed);
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
  const taken = await readOwner(claimed);
  if ((owner === null && taken === null) || (owner && taken && taken.pid === owner.pid && taken.at === owner.at)) {
    await rm(claimed, { force: true });
    return true;
  }
  await link(claimed, path).catch(() => {});
  await rm(claimed, { force: true });
  return false;
}

const held = new Set();
let exitHookSet = false;
function giveBackOnExit() {
  if (exitHookSet) return;
  exitHookSet = true;
  process.on("exit", () => { for (const path of held) { try { rmSync(path, { force: true }); } catch { /* the age and pid checks reclaim it */ } } });
}

const MAX_BLOCKED_IN_A_ROW = 30; // whole attempts (each tried every slot and was refused); the governor polls once a second
let blockedInARow = 0;

// A slot (a function that gives it back, once) or null when all `limit` slots are held. Never waits.
export async function tryAcquireSlot(limit, dir = slotsDir()) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let blocked = null; // a slot that could not even be tried (permissions); it is not "held", so it must not look like a full pool
  let seenHeld = false;
  for (let n = 0; n < limit; n += 1) {
    const path = join(dir, `slot-${n}.lock`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let handle;
      try {
        handle = await openExclusive(path);
      } catch (error) {
        if (error.code === "EEXIST") {
          seenHeld = true;
          if (attempt === 0 && await reclaimIfStale(path)) continue;
        } else if (isTransientCreateError(error)) {
          blocked = error; // still delete-pending after the retries: try the next slot, the caller polls again
        } else {
          throw error;
        }
        break;
      }
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      } catch (error) {
        await handle.close().catch(() => {});
        await rm(path, { force: true }).catch(() => {});
        throw error;
      }
      await handle.close();
      blockedInARow = 0;
      held.add(path);
      giveBackOnExit();
      let given = false;
      return async () => {
        if (given) return;
        given = true;
        for (let attempt = 0; attempt < 4; attempt += 1) { // Windows: a scanner may hold the file for a moment
          try {
            await rm(path, { force: true });
            held.delete(path);
            return;
          } catch {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }
        // Still there: it stays in `held`, so the exit hook removes it, and a later holder reclaims it by process id.
      };
    }
  }
  // Every slot refused with a permission-type error and none is held. A delete-pending file clears within moments, so that is
  // waited out (the caller polls again); only a refusal that lasts is a real permission problem, which waiting never fixes.
  if (blocked && !seenHeld) {
    blockedInARow += 1;
    if (blockedInARow >= MAX_BLOCKED_IN_A_ROW) throw blocked;
  } else {
    blockedInARow = 0;
  }
  return null;
}

// How many slots are held right now (for status output). Does not reclaim anything.
export async function slotsInUse(limit, dir = slotsDir()) {
  let used = 0;
  for (let n = 0; n < limit; n += 1) {
    const owner = await readOwner(join(dir, `slot-${n}.lock`));
    if (owner && processAlive(owner.pid) && Date.now() - owner.at < SLOT_MAX_AGE_MS) used += 1;
  }
  return used;
}
