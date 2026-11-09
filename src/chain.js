// Receipt chain: canonical body, SHA-256 hash link, HMAC-SHA256 signature, atomic writes, verification.
// Must stay byte-compatible with proof-lab-go/main.go. test/chain.test.mjs pins the shared fixture.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { createReadStream } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";

export const KEY_ENV = "PROOF_LAB_KEY";
export const MIN_KEY_BYTES = 32;
export const GENESIS = "GENESIS";
// Lock file in the receipts directory. Its name does not end in .json, so receiptFiles never lists it.
export const LOCK_NAME = ".chain.lock";
// A stale lock the writer claims before it removes it: the lock's name, `.stale-` and 12 hex characters (see withChainLock).
export const STALE_CLAIM_NAME = new RegExp(`^${LOCK_NAME.replaceAll(".", "\\.")}\\.stale-[0-9a-f]{12}$`);
export const LOCK_TIMEOUT_MS = 30000;
// Evidence file suffix. It does not end in .json, so receiptFiles (which lists *.json) never mistakes evidence for a receipt.
export const EVIDENCE_SUFFIX = ".evidence.jsonl";
// Evidence is small by construction (a few hundred records at most). A bigger file is refused when written and when verified.
export const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
const REVISION_HEX = "[0-9a-f]{12}";
const REVISION = new RegExp(`^${REVISION_HEX}$`);
// The suffixes of the three files written under one stem: the receipt, the picture and (above) the evidence.
const RECEIPT_SUFFIX = ".json";
const PICTURE_SUFFIX = ".png";
// The only shape a receipt may name as its evidence: letters, digits and hyphens, then the suffix. No separators, no
// colon (an NTFS alternate data stream), no extra dots, and never a Windows device name such as CON.
const EVIDENCE_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*\.evidence\.jsonl$/;
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

export function isEvidenceName(name) {
  return typeof name === "string" && EVIDENCE_NAME.test(name) && !DEVICE_NAME.test(name.slice(0, -EVIDENCE_SUFFIX.length));
}

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
    throw new Error(`the key file is readable by group or others (mode ${(info.mode & 0o777).toString(8)}); set it to 0600`);
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

// The one definition of the name the lab gives a file it writes: `${fileStamp(fixedStamp(at))}-${revision or "unknown"}` plus
// one of the three suffixes. writeReceipt builds the names, and the scrub of a printed path (receipt-scrub.js) keeps exactly
// this shape intact, so the two cannot drift apart: a name the lab writes can never be mangled by the scrub.
const escapeDots = text => text.replaceAll(".", "\\.");
export const LAB_FILE_NAME = new RegExp(
  `^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{9}Z-(?:${REVISION_HEX}|unknown)(?:${[RECEIPT_SUFFIX, PICTURE_SUFFIX, EVIDENCE_SUFFIX].map(escapeDots).join("|")})$`,
);

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
const STORED_FIELDS = ["verdict", "app", "bug", "spec", "revision", "at", "totals", "checks", "review", "evidence", "pageErrors", "screenshot", "error", "next", "keyId", "prevHash", "hash", "mac"];

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
// Returns false when the file is still there, so the caller can say so instead of claiming a clean rollback.
async function discard(path) {
  await chmod(path, 0o644).catch(() => {});
  try {
    await rm(path, { force: true });
    return true;
  } catch {
    return false;
  }
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
    if (process.platform !== "win32") {
      // A rename the directory does not confirm is a failed write: the file goes, so a caller that reports a failure
      // leaves nothing behind (the target is a new, uniquely named file, so nothing older is lost).
      await syncDir(dirname(path)).catch(async error => {
        await rm(path, { force: true }).catch(() => {});
        throw error;
      });
    }
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

// Advisory lock around the head read and the receipt write, so two writers cannot link to the same head. Node has no
// flock, so the lock is an exclusive create of LOCK_NAME holding {"pid", "host"}, removed on exit.
// A lock is reclaimed only when its owner is provably gone: same host and the pid no longer exists. A lock held by a
// live process or by another host is never taken over, by age or otherwise; the wait then ends with an error.
// Writers inside one process queue up first, so a lock file naming this process's own pid can only be a leftover of an
// earlier write whose cleanup failed, and is reclaimed at once.
// Known limits (recorded in the README): a pid can be reused after a crash, so a stale lock can look live until the
// pid is reused; and two reclaimers racing on the same stale lock can, in a narrow window, remove a fresh lock.
const queues = new Map(); // lock path -> promise that settles when the last queued writer of this process is done

function lockedError(dir) {
  return new Error(`the receipts directory is locked by another writer; if no writer is running, remove ${LOCK_NAME}`);
}

async function queueInProcess(lockPath, dir, timeoutMs, task) {
  const previous = queues.get(lockPath) ?? Promise.resolve();
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const tail = previous.then(() => done);
  queues.set(lockPath, tail);
  try {
    let timer;
    const timedOut = new Promise((_, reject) => { timer = setTimeout(() => reject(lockedError(dir)), timeoutMs); });
    try {
      await Promise.race([previous, timedOut]);
    } finally {
      clearTimeout(timer);
    }
    return await task();
  } finally {
    finish();
    tail.then(() => { if (queues.get(lockPath) === tail) queues.delete(lockPath); });
  }
}

export function withChainLock(dir, timeoutMs, fn) {
  const lockPath = join(dir, LOCK_NAME);
  return queueInProcess(lockPath, dir, timeoutMs, async () => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await tryCreateLock(lockPath)) break;
      if (await reclaimIfStale(lockPath)) continue;
      if (Date.now() >= deadline) throw lockedError(dir);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    try {
      return await fn();
    } finally {
      // Best effort. If fn succeeded, the receipt is already on disk, and a failure to remove the lock must not turn that
      // success into an error (the caller would report ERROR next to a valid signed receipt). A lock left behind is
      // reclaimed by the next writer: at once if it names this process, once the process is gone if another.
      await rm(lockPath, { force: true }).catch(() => {});
    }
  });
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
  if (!owner || owner.host !== hostname()) return false;
  // Writers of this process are queued (queueInProcess), so none holds the lock while we look: a lock that names our own
  // pid is a leftover, however alive the pid is. For any other pid, alive means held.
  if (owner.pid !== process.pid && processAlive(owner.pid)) return false;
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
// With stampNow (a clock returning a fixedStamp), `at` is set inside the lock, as the receipt joins the chain, so runs
// that overlap never refuse each other: whichever seals first comes first. Without it, `at` is kept as given.
export async function writeReceipt(receipt, { shot, evidence, key, dir, lockTimeoutMs = LOCK_TIMEOUT_MS, stampNow }) {
  assertStorable(receipt);
  if (evidence !== undefined && Buffer.byteLength(evidence, "utf8") > MAX_EVIDENCE_BYTES) {
    throw new Error(`the evidence is larger than ${MAX_EVIDENCE_BYTES} bytes; nothing was written`);
  }
  await mkdir(dir, { recursive: true });
  const rev = revisionOrUnknown(receipt.revision);
  const before = { at: receipt.at, screenshot: receipt.screenshot, evidence: receipt.evidence, keyId: receipt.keyId, prevHash: receipt.prevHash };
  try {
    return await withChainLock(dir, lockTimeoutMs, async () => {
      // The head is the newest receipt by name, and verify reads names in that order. A new receipt must sort after
      // the head, or linking it would fork the chain. Refusing is the fail-closed choice; the run can be repeated.
      const existing = await receiptFiles(dir);
      const head = existing.length > 0 ? basename(existing.at(-1)) : null;
      if (stampNow) receipt.at = await sealStamp(head, rev, stampNow);
      const stamp = fileStamp(receipt.at);
      const newName = `${stamp}-${rev}${RECEIPT_SUFFIX}`;
      if (head !== null && head >= newName) {
        throw new Error(`receipt ${newName} is not later than the chain head ${head}; not written, so the chain does not fork`);
      }
      const written = [];
      try {
        let evidencePath = null;
        if (shot) {
          const shotName = `${stamp}-${rev}${PICTURE_SUFFIX}`;
          const shotPath = join(dir, shotName);
          await writeAtomic(shotPath, shot);
          written.push(shotPath); // tracked once it exists, so a rollback never touches something this call did not create
          // By name, like the evidence file: the signed receipt never holds the path of the directory it sits in, so no
          // command that prints a receipt can print that directory.
          receipt.screenshot = shotName;
        }
        if (evidence !== undefined) {
          const name = `${stamp}-${rev}${EVIDENCE_SUFFIX}`;
          evidencePath = join(dir, name);
          await writeAtomic(evidencePath, evidence);
          written.push(evidencePath);
          receipt.evidence = { file: name, sha256: sha256Hex(evidence), bytes: Buffer.byteLength(evidence, "utf8") };
        }
        receipt.keyId = keyIdOf(key);
        receipt.prevHash = await latestHash(dir);
        inStoredOrder(receipt); // keyId and prevHash land after `next`, the order the Go struct writes them in
        const body = canonicalBody(receipt);
        receipt.hash = sha256Hex(body);
        receipt.mac = signBody(body, key);
        const receiptPath = join(dir, newName);
        await writeAtomic(receiptPath, fileBody(receipt));
        written.push(receiptPath);
        return { receiptPath, evidencePath };
      } catch (error) {
        // Still inside the lock: until these files are gone, another writer could link to a receipt that is about to vanish.
        const leftovers = [];
        for (const path of written) if (!(await discard(path))) leftovers.push(path);
        // The files this call could not remove, by name: a field of the error, so the message is not rewritten (the line a
        // command prints is built from the error's fields, see safeLine) and no directory is put into any text.
        if (leftovers.length > 0) error.leftovers = leftovers.map(path => basename(path));
        throw error;
      }
    });
  } catch (error) {
    // The caller keeps its object: put back what this call changed, and leave no chain fields on an unwritten receipt.
    restoreField(receipt, "at", before.at);
    restoreField(receipt, "screenshot", before.screenshot);
    restoreField(receipt, "evidence", before.evidence);
    restoreField(receipt, "keyId", before.keyId);
    restoreField(receipt, "prevHash", before.prevHash);
    delete receipt.hash;
    delete receipt.mac;
    throw error;
  }
}

// A receipt may hold only fields the format stores. Anything else would make the file differ from the one verify
// expects, so it is refused before anything is written.
function assertStorable(receipt) {
  const unknown = Object.keys(receipt).filter(key => !STORED_FIELDS.includes(key));
  if (unknown.length > 0) throw new Error(`the receipt has fields the format does not store: ${unknown.join(", ")}`);
}

// The stored fields in the order the format writes them, whatever order the caller built the object in.
function inStoredOrder(receipt) {
  const ordered = knownFieldsOnly(receipt);
  for (const key of Object.keys(receipt)) delete receipt[key];
  Object.assign(receipt, ordered);
}

// The clock's stamp, once it names a receipt that sorts after the head. Two seals in one millisecond give the same stamp,
// so a head up to SEAL_WAIT_MS ahead is waited out (inside the lock, so no other writer moves the head meanwhile). A head
// further ahead is a clock problem: the stamp is returned as it is and the ordering check refuses it.
export const SEAL_WAIT_MS = 1000;
async function sealStamp(head, rev, stampNow) {
  const deadline = Date.now() + SEAL_WAIT_MS;
  for (;;) {
    const at = stampNow();
    if (head === null || `${fileStamp(at)}-${rev}${RECEIPT_SUFFIX}` > head || Date.now() >= deadline) return at;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

function restoreField(receipt, key, value) {
  if (value === undefined) delete receipt[key];
  else receipt[key] = value;
}

async function sha256OfFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

// The evidence file a receipt names, if any. A changed or unreadable file is a problem. A missing file is not: evidence
// can be pruned, and the failures themselves are in the signed receipt, so deleting evidence cannot hide one.
async function evidenceIssue(dir, receipt) {
  const evidence = receipt.evidence;
  if (evidence === undefined || evidence === null) return null;
  const file = evidence?.file;
  // The name must be a plain evidence file next to the receipt, so a forged reference cannot make verify read anywhere else.
  if (!isEvidenceName(file) || typeof evidence.sha256 !== "string") {
    return { problem: `evidence reference is malformed (it must name a plain *${EVIDENCE_SUFFIX} file next to the receipt, with a sha256)` };
  }
  const path = join(dir, file);
  const unreadable = error => ({ problem: `evidence file ${file} cannot be read (${error.code ?? "error"})` });
  let info;
  try {
    info = await lstat(path); // lstat: a symbolic link is not followed
  } catch (error) {
    return error.code === "ENOENT" ? { missing: file } : unreadable(error);
  }
  if (!info.isFile()) return { problem: `evidence file ${file} is not a plain file` };
  if (info.size > MAX_EVIDENCE_BYTES) return { problem: `evidence file ${file} is larger than ${MAX_EVIDENCE_BYTES} bytes` };
  let digest;
  try {
    digest = await sha256OfFile(path);
  } catch (error) {
    return unreadable(error);
  }
  if (digest !== evidence.sha256) return { problem: `evidence file ${file} does not match the hash recorded in the receipt` };
  return null;
}

// Checks every receipt in name order: body hashes to its hash, prevHash links to the one before, the MAC verifies, and
// any evidence file it names still matches. Returns problems (one per bad receipt), the number of receipts checked, and
// the evidence files that are gone. A read error on a receipt throws: nothing can be said.
export async function verifyChain(dir, key) {
  const files = await receiptFiles(dir);
  if (files.length === 0) throw new Error("no receipts in the receipts directory");
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
