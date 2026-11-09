// A machine-wide pool of run slots, so separate `run` commands and the queue worker together never exceed what this machine can
// carry. One file per slot in a directory under the OS temp folder (the resource guarded is this machine's CPU and memory,
// whatever receipts directory a run writes to). A slot is taken by creating its file exclusively and given back by removing it.
// A holder that died without giving its slot back is detected by its process id (and, against a reused id, by the slot's age).
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, link, stat } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SLOT_MAX_AGE_MS = 6 * 60 * 60 * 1000; // no run lasts this long: a slot this old is a leak, whatever its process id says
const HALF_WRITTEN_MS = 5000;                      // a slot file with no content yet is a holder mid-write, until it is this old

export const slotsDir = () => process.env.PROOF_LAB_SLOTS_DIR || join(tmpdir(), "proof-lab-slots");

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM"; // exists, but not ours to signal
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

// True when the slot's holder is gone and the file was removed (or was already gone); false when it is held.
async function reclaimIfStale(path) {
  const owner = await readOwner(path);
  if (!owner) {
    const info = await stat(path).catch(() => null);
    if (!info) return true;
    if (Date.now() - info.mtimeMs < HALF_WRITTEN_MS) return false;
  } else if (processAlive(owner.pid) && Date.now() - owner.at < SLOT_MAX_AGE_MS) {
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

// A slot (a function that gives it back, once) or null when all `limit` slots are held. Never waits.
export async function tryAcquireSlot(limit, dir = slotsDir()) {
  await mkdir(dir, { recursive: true });
  for (let n = 0; n < limit; n += 1) {
    const path = join(dir, `slot-${n}.lock`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let handle;
      try {
        handle = await open(path, "wx");
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (attempt === 0 && await reclaimIfStale(path)) continue;
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
      held.add(path);
      giveBackOnExit();
      let given = false;
      return async () => {
        if (given) return;
        given = true;
        held.delete(path);
        await rm(path, { force: true }).catch(() => {});
      };
    }
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
