// Receipt chain: canonical body, SHA-256 hash link, HMAC-SHA256 signature, atomic writes, verification.
// Must stay byte-compatible with proof-lab-go/main.go. test/chain.test.mjs pins the shared fixture.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";

export const KEY_ENV = "PROOF_LAB_KEY";
export const MIN_KEY_BYTES = 32;
export const GENESIS = "GENESIS";
const REVISION = /^[0-9a-f]{12}$/;

// Missing or short key: throw. A receipt without a signature is not evidence, so nothing is written.
export function signingKey(env = process.env) {
  const key = env[KEY_ENV] ?? "";
  if (Buffer.byteLength(key, "utf8") < MIN_KEY_BYTES) {
    throw new Error(`${KEY_ENV} must be set to at least ${MIN_KEY_BYTES} bytes; receipts are signed and none is written without a key`);
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

// Canonical body: every field except hash and mac, in insertion order. Go's encoder escapes U+2028 and U+2029,
// JSON.stringify does not, so they are escaped here to keep the bytes identical.
export function canonicalBody(receipt) {
  const { hash: _hash, mac: _mac, ...body } = receipt;
  return JSON.stringify(body).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export const sha256Hex = text => createHash("sha256").update(text, "utf8").digest("hex");

export const signBody = (body, key) => createHmac("sha256", key).update(body, "utf8").digest("hex");

function macEqual(expected, actual) {
  if (typeof actual !== "string" || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

// Atomic write: a uniquely named temp file in the same directory, flushed, then renamed over the target.
// A failure removes the temp file, so no partial *.json is ever left behind.
export async function writeAtomic(path, data) {
  const tmp = join(dirname(path), `${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(tmp, "wx", 0o644);
  try {
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    await rename(tmp, path);
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(tmp, { force: true });
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
export async function writeReceipt(receipt, { shot, key, dir }) {
  await mkdir(dir, { recursive: true });
  const stamp = fileStamp(receipt.at);
  const rev = revisionOrUnknown(receipt.revision);
  let shotPath = null;
  try {
    if (shot) {
      shotPath = join(dir, `${stamp}-${rev}.png`);
      await writeAtomic(shotPath, shot);
      receipt.screenshot = shotPath;
    }
    receipt.prevHash = await latestHash(dir);
    const body = canonicalBody(receipt);
    receipt.hash = sha256Hex(body);
    receipt.mac = signBody(body, key);
    await writeAtomic(join(dir, `${stamp}-${rev}.json`), JSON.stringify(receipt, null, 2));
  } catch (error) {
    if (shotPath) await rm(shotPath, { force: true });
    receipt.screenshot = null;
    delete receipt.hash;
    delete receipt.mac;
    throw error;
  }
}

// Checks every receipt in name order: body hashes to its hash, prevHash links to the one before, and the MAC verifies.
// Returns problems (one per bad receipt) and the number of receipts checked. A read error throws: nothing can be said.
export async function verifyChain(dir, key) {
  const files = await receiptFiles(dir);
  if (files.length === 0) throw new Error(`no receipts in ${dir}`);
  const problems = [];
  let prev = GENESIS; // null once a receipt cannot be parsed: the next link is unknown, and the run is already invalid
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
    if (prev !== null && receipt.prevHash !== prev) {
      problems.push(`${name}: prevHash does not link to the receipt before it`);
    } else if (sha256Hex(body) !== receipt.hash) {
      problems.push(`${name}: hash does not match the receipt body`);
    } else if (!macEqual(signBody(body, key), receipt.mac)) {
      problems.push(`${name}: signature is missing or does not verify with this key`);
    }
    prev = typeof receipt.hash === "string" && receipt.hash !== "" ? receipt.hash : null;
  }
  return { problems, checked: files.length };
}
