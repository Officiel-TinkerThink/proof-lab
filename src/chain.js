// Receipt chain: canonical body, SHA-256 hash link, HMAC-SHA256 signature, atomic writes, verification.
// Must stay byte-compatible with proof-lab-go/main.go. test/chain.test.mjs pins the shared fixture.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { chmod, link, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";

export const KEY_ENV = "PROOF_LAB_KEY";
export const MIN_KEY_BYTES = 32;
export const GENESIS = "GENESIS";
// Lock file in the receipts directory. Its name does not end in .json, so receiptFiles never lists it.
export const LOCK_NAME = ".chain.lock";
export const LOCK_TIMEOUT_MS = 30000;
// Evidence file suffix. It does not end in .json, so receiptFiles (which lists *.json) never mistakes evidence for a receipt.
export const EVIDENCE_SUFFIX = ".evidence.jsonl";
const REVISION = /^[0-9a-f]{12}$/;

// Missing or short key: throw. A receipt without a signature is not evidence, so nothing is written.
export function signingKey(env = process.env) {
  const key = env[KEY_ENV] ?? "";
  if (Buffer.byteLength(key, "utf8") < MIN_KEY_BYTES) {
    throw new Error(`${KEY_ENV} must be set to at least ${MIN_KEY_BYTES} bytes; receipts are signed and none is written without a key`);
  }
  return Buffer.from(key, "utf8");
}

// Key from a file, for --key-file. A key file never enters the environment, so child processes and
// /proc/<pid>/environ cannot read it. Like ssh's private keys, it must not be readable by group or others (POSIX only).
export async function signingKeyFromFile(path) {
  const info = await stat(path);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error(`key file ${path} is readable by group or others (mode ${(info.mode & 0o777).toString(8)}); set it to 0600`);
  }
  const key = (await readFile(path, "utf8")).replace(/[\r\n]+$/, "");
  if (Buffer.byteLength(key, "utf8") < MIN_KEY_BYTES) {
    throw new Error(`key file must hold at least ${MIN_KEY_BYTES} bytes; receipts are signed and none is written without a key`);
  }
  return Buffer.from(key, "utf8");
}

// Fixed width, nine fractional digits, matching the Go driver so file names sort in time order.
export function fixedStamp(date = new Date()) {
  return date.toISOString().replace("Z", "000000Z");
}

export function fileStamp(at) {
  return at.replace(/[:.]/g, "-");
}

export function revisionOrUnknown(revision) {
  return typeof revision === "string" && REVISION.test(revision) ? revision : "unknown";
}

// Lone surrogates become U+FFFD, as Go's encoder writes them; JSON.stringify would emit \udXXX escapes instead.
const wellFormed = (_key, value) => (typeof value === "string" ? value.toWellFormed() : value);

// Canonical body: every field except hash and mac, in insertion order. Go's encoder escapes U+2028 and U+2029,
// JSON.stringify does not, so they are escaped here to keep the bytes identical.
export function canonicalBody(receipt) {
  const { hash: _hash, mac: _mac, ...body } = receipt;
  return JSON.stringify(body, wellFormed).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

// Stored fields in the order the Go struct writes them. A file is valid only if it is exactly these fields, in this order.
// Node-driver receipts add spec, totals and evidence; a receipt without them (the Go driver's, or prove.js's) still verifies.
const STORED_FIELDS = ["verdict", "app", "bug", "spec", "revision", "at", "totals", "checks", "evidence", "pageErrors", "screenshot", "error", "next", "keyId", "prevHash", "hash", "mac"];

// Receipt file body: two-space indent and the same escapes as canonicalBody, so Node and Go write identical bytes.
export function fileBody(receipt) {
  return JSON.stringify(receipt, wellFormed, 2).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

// The stored fields only, in file order: unknown keys are dropped, so a file that carries any extra key differs from it.
export function knownFieldsOnly(parsed) {
  return Object.fromEntries(STORED_FIELDS.filter(name => name in parsed).map(name => [name, parsed[name]]));
}

// The browser inherits the environment unless told otherwise, so the signing key is withheld from its launch.
export function environmentWithoutKey(env = process.env) {
  const { [KEY_ENV]: _key, ...rest } = env;
  return rest;
}

export const sha256Hex = text => createHash("sha256").update(text, "utf8").digest("hex");

export const signBody = (body, key) => createHmac("sha256", key).update(body, "utf8").digest("hex");

// Key ID: first 16 hex characters of SHA-256(key). It names the key without revealing it, and goes inside the signed body.
export const keyIdOf = key => createHash("sha256").update(key).digest("hex").slice(0, 16);

function macEqual(expected, actual) {
  if (typeof actual !== "string" || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

// Removes a file this process just created. Windows cannot delete a read-only file, so the flag is cleared first.
async function discard(path) {
  await chmod(path, 0o644).catch(() => {});
  await rm(path, { force: true }).catch(() => {});
}

// Flushes a directory's entries to stable storage, so a completed rename survives a crash.
async function syncDir(dir) {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Atomic write: a uniquely named temp file in the same directory, flushed, then renamed over the target.
// A failure removes the temp file, so no partial *.json is ever left behind. The result is read-only (0444): this
// blocks accidental edits; it does not stop the file's owner, so the anchor (--expect-head) is the tamper check.
export async function writeAtomic(path, data) {
  const tmp = join(dirname(path), `${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(tmp, "wx", 0o644);
  try {
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    await rename(tmp, path);
    // rename(2) is not durable until the directory entry is flushed (fsync(2)). Windows cannot open a directory to
    // sync it, so there the rename is not flushed by this code; that gap is recorded as unresolved.
    if (process.platform !== "win32") await syncDir(dirname(path));
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(tmp, { force: true });
    throw error;
  }
  try {
    await chmod(path, 0o444);
  } catch (error) {
    await discard(path);
    throw error;
  }
}

export async function receiptFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
    .map(entry => join(dir, entry.name))
    .sort();
}

// Hash of the newest receipt. An empty directory is genesis; an unreadable newest receipt is an error, never GENESIS.
// The chain is not restarted when the key changes: a restart would let a whole earlier segment be removed unseen.
export async function latestHash(dir) {
  const files = await receiptFiles(dir);
  if (files.length === 0) return GENESIS;
  const newest = files.at(-1);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(newest, "utf8"));
  } catch {
    throw new Error(`previous receipt ${basename(newest)} is unreadable; the chain cannot be extended`);
  }
  if (typeof parsed?.hash !== "string" || parsed.hash === "") {
    throw new Error(`previous receipt ${basename(newest)} has no hash; the chain cannot be extended`);
  }
  return parsed.hash;
}

// Writes the screenshot (if any) and the signed receipt. On any failure the screenshot and the receipt fields are
// rolled back and the error is thrown, so the caller can report ERROR.
// Advisory lock around the head read and the receipt write, so two writers cannot link to the same head. Node has no
// flock, so the lock is an exclusive create of LOCK_NAME holding {"pid", "host"}, removed on exit.
// A lock is reclaimed only when its owner is provably gone: same host and the pid no longer exists. A lock held by a
// live process or by another host is never taken over, by age or otherwise; the wait then ends with an error.
// Known limits (recorded in the README): a pid can be reused after a crash, so a stale lock can look live until the
// pid is reused; and two reclaimers racing on the same stale lock can, in a narrow window, remove a fresh lock.
export async function withChainLock(dir, timeoutMs, fn) {
  const lockPath = join(dir, LOCK_NAME);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await tryCreateLock(lockPath)) break;
    if (await reclaimIfStale(lockPath)) continue;
    if (Date.now() >= deadline) {
      throw new Error(`receipts in ${dir} are locked by another writer; if no writer is running, remove ${LOCK_NAME}`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  try {
    return await fn();
  } finally {
    // Best effort. If fn succeeded, the receipt is already on disk, and a failure to remove the lock must not turn that
    // success into an error (the caller would report ERROR next to a valid signed receipt). A lock left behind is
    // reclaimed by the next writer once this process has exited (same host, pid gone).
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

async function tryCreateLock(lockPath) {
  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname() }));
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true });
    throw error;
  }
  await handle.close();
  return true;
}

// Returns true when the lock was removed (or already gone) and the caller should retry at once.
async function reclaimIfStale(lockPath) {
  const owner = await readLockOwner(lockPath);
  if (!owner || owner.host !== hostname() || processAlive(owner.pid)) return false;
  const claimed = `${lockPath}.stale-${randomBytes(6).toString("hex")}`;
  try {
    await rename(lockPath, claimed);
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
  const taken = await readLockOwner(claimed);
  if (taken && taken.pid === owner.pid && taken.host === owner.host) {
    await rm(claimed, { force: true });
    return true;
  }
  // The name now holds a lock a live writer created after our check: put it back if the name is still free.
  await link(claimed, lockPath).catch(() => {});
  await rm(claimed, { force: true });
  return false;
}

async function readLockOwner(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const owner = JSON.parse(text);
    return Number.isInteger(owner?.pid) && owner.pid > 0 && typeof owner.host === "string" ? owner : null;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// Writes the receipt, and with it the screenshot (shot, a Buffer) and the evidence file (evidence, text) when given.
// Returns { receiptPath, evidencePath }. Everything is written after the ordering check, inside the lock, so a refused
// receipt never touches a file that belongs to an earlier run; on any failure every file this call wrote is removed.
export async function writeReceipt(receipt, { shot, evidence, key, dir, lockTimeoutMs = LOCK_TIMEOUT_MS }) {
  await mkdir(dir, { recursive: true });
  const stamp = fileStamp(receipt.at);
  const rev = revisionOrUnknown(receipt.revision);
  const newName = `${stamp}-${rev}.json`;
  const evidenceBefore = receipt.evidence;
  const written = [];
  try {
    return await withChainLock(dir, lockTimeoutMs, async () => {
      // The head is the newest receipt by name, and verify reads names in that order. A new receipt must sort after
      // the head, or linking it would fork the chain. Refusing is the fail-closed choice; the run can be repeated.
      const existing = await receiptFiles(dir);
      if (existing.length > 0 && basename(existing.at(-1)) >= newName) {
        throw new Error(`receipt ${newName} is not later than the chain head ${basename(existing.at(-1))}; not written, so the chain does not fork`);
      }
      let evidencePath = null;
      if (shot) {
        const shotPath = join(dir, `${stamp}-${rev}.png`);
        written.push(shotPath);
        await writeAtomic(shotPath, shot);
        receipt.screenshot = shotPath;
      }
      if (evidence !== undefined) {
        const name = `${stamp}-${rev}${EVIDENCE_SUFFIX}`;
        evidencePath = join(dir, name);
        written.push(evidencePath);
        await writeAtomic(evidencePath, evidence);
        receipt.evidence = { file: name, sha256: sha256Hex(evidence), bytes: Buffer.byteLength(evidence, "utf8") };
      }
      // Fields are re-appended so keyId and prevHash sit after `next`, the order the Go struct writes them in.
      delete receipt.keyId;
      delete receipt.prevHash;
      receipt.keyId = keyIdOf(key);
      receipt.prevHash = await latestHash(dir);
      const body = canonicalBody(receipt);
      receipt.hash = sha256Hex(body);
      receipt.mac = signBody(body, key);
      const receiptPath = join(dir, newName);
      written.push(receiptPath);
      await writeAtomic(receiptPath, fileBody(receipt));
      return { receiptPath, evidencePath };
    });
  } catch (error) {
    for (const path of written) await discard(path);
    receipt.screenshot = null;
    if (evidenceBefore === undefined) delete receipt.evidence;
    else receipt.evidence = evidenceBefore;
    delete receipt.hash;
    delete receipt.mac;
    throw error;
  }
}

// Checks every receipt in name order: body hashes to its hash, prevHash links to the one before, and the MAC verifies.
// Returns problems (one per bad receipt) and the number of receipts checked. A read error throws: nothing can be said.
// The evidence file a receipt names, if any. A changed file is a problem. A missing file is not: evidence can be pruned,
// and the failures themselves are in the signed receipt, so deleting evidence cannot hide one.
async function evidenceIssue(dir, receipt) {
  const evidence = receipt.evidence;
  if (evidence === undefined || evidence === null) return null;
  const file = evidence?.file;
  // The name must be a plain file next to the receipt, so a forged reference cannot make verify read anywhere else.
  if (typeof file !== "string" || typeof evidence.sha256 !== "string" || file !== basename(file) || !file.endsWith(EVIDENCE_SUFFIX)) {
    return { problem: `evidence reference is malformed (it must name a plain *${EVIDENCE_SUFFIX} file next to the receipt, with a sha256)` };
  }
  let bytes;
  try {
    bytes = await readFile(join(dir, file));
  } catch (error) {
    if (error.code === "ENOENT") return { missing: file };
    throw error;
  }
  if (createHash("sha256").update(bytes).digest("hex") !== evidence.sha256) {
    return { problem: `evidence file ${file} does not match the hash recorded in the receipt` };
  }
  return null;
}

export async function verifyChain(dir, key) {
  const files = await receiptFiles(dir);
  if (files.length === 0) throw new Error(`no receipts in ${dir}`);
  const problems = [];
  const missingEvidence = [];
  const keyId = keyIdOf(key);
  let prev = GENESIS; // null once a receipt cannot be parsed: the next link is unknown, and the run is already invalid. "" is a stored hash, not unknown.
  for (const path of files) {
    const name = basename(path);
    const text = await readFile(path, "utf8");
    let receipt;
    try {
      receipt = JSON.parse(text);
    } catch {
      receipt = null;
    }
    if (receipt === null || typeof receipt !== "object") {
      problems.push(`${name}: not a readable receipt`);
      prev = null;
      continue;
    }
    const body = canonicalBody(receipt);
    if (fileBody(knownFieldsOnly(receipt)) !== text) {
      problems.push(`${name}: file is not the receipt this driver writes (fields added, removed, re-cased or re-spaced)`);
    } else if (prev !== null && receipt.prevHash !== prev) {
      problems.push(`${name}: prevHash does not link to the receipt before it`);
    } else if (sha256Hex(body) !== receipt.hash) {
      problems.push(`${name}: hash does not match the receipt body`);
    } else if (receipt.keyId !== keyId) {
      problems.push(`${name}: signed under key id ${receipt.keyId}, not this key (${keyId}); verify it with the key for that id`);
    } else if (!macEqual(signBody(body, key), receipt.mac)) {
      problems.push(`${name}: signature is missing or does not verify with this key`);
    } else {
      // The receipt itself is sound, so its evidence reference is signed and can be trusted: check the file it names.
      const issue = await evidenceIssue(dir, receipt);
      if (issue?.problem) problems.push(`${name}: ${issue.problem}`);
      else if (issue?.missing) missingEvidence.push(issue.missing);
    }
    prev = typeof receipt.hash === "string" ? receipt.hash : null;
  }
  return { problems, checked: files.length, missingEvidence };
}
