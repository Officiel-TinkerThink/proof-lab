// The one place that decides how a receipt is scrubbed and written. `run` (run-spec.js) and `prove` (prove.js) both go
// through scrubReceipt and writeScrubbedReceipt, and writeScrubbedReceipt refuses a receipt that scrubReceipt has not seen,
// so a new entry point cannot write one unscrubbed by forgetting a step.
import { writeReceipt } from "./chain.js";
import { hideQuery, redactSecrets, scrubValue } from "./spec/evidence.js";
import { firstLine } from "./spec/util.js";

// Fields that are the run's own bookkeeping, not page or spec text; the scrub leaves them alone.
// "spec" is the run's identity (name scrubbed, hash appended by specLabel): scrubbing it again could swallow the hash.
const RECEIPT_BOOKKEEPING = ["spec", "at", "verdict"];
const scrubbed = new WeakSet();

// Step 1, the scrub point: every field of the receipt, whichever code path produced its text, before it is written.
export function scrubReceipt(receipt) {
  if (typeof receipt.app === "string") receipt.app = hideQuery(receipt.app);
  for (const key of Object.keys(receipt)) if (!RECEIPT_BOOKKEEPING.includes(key)) receipt[key] = scrubValue(receipt[key]);
  scrubbed.add(receipt);
}

// Step 2, around the write. A receipt that cannot be written is not evidence, so the run becomes ERROR, never a silent
// PASS; the system's error text names the path it failed on and arrives after step 1, so it is scrubbed as it is set.
// (writeReceipt stores the picture and the evidence file by name, so the receipt holds no path of its own.)
// Returns the written paths, or null.
export async function writeScrubbedReceipt(receipt, options, advice) {
  if (!scrubbed.has(receipt)) throw new Error("writeScrubbedReceipt: scrubReceipt(receipt) must run first, so nothing unscrubbed is written");
  try {
    return await writeReceipt(receipt, options);
  } catch (error) {
    receipt.verdict = "ERROR";
    receipt.error = scrubValue(`receipt write failed: ${firstLine(error)}`);
    receipt.next = [receipt.error, advice];
    return null;
  }
}

// The name chain.js writes for a receipt: `${fileStamp(fixedStamp(at))}-${revision or "unknown"}.json`, where fixedStamp
// gives nine fractional digits. Only this exact shape is kept intact, with the receipt's own suffix or the suffix of the
// picture or evidence file written next to it (chain.js writes all three under the same stem).
const LAB_RECEIPT_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{9}Z-(?:[0-9a-f]{12}|unknown)(?:\.json|\.png|\.evidence\.jsonl)$/;

// A name the lab did not write (renamed, or hand-placed) is scrubbed together with the whole path, because a run joined
// by "/" is judged as a whole. Only a lab-shaped name is kept intact; then the directory above it is scrubbed alone, and
// the separator stays outside that scrub so a value run in the directory cannot swallow it.
export function scrubReceiptFile(path) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  // A bare drive letter ("D:name.json") ends the directory part at the colon.
  const nameStart = Math.max(cut + 1, /^[A-Za-z]:/.test(path) ? 2 : 0);
  const name = path.slice(nameStart);
  if (!LAB_RECEIPT_NAME.test(name)) return redactSecrets(path);
  const head = path.slice(0, nameStart);
  const sep = /[\\/]$/.test(head) ? head.slice(-1) : "";
  const dir = head.slice(0, head.length - sep.length);
  return `${dir === "" ? "" : redactSecrets(dir)}${sep}${name}`;
}
