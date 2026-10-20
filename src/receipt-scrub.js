// The one place that decides how a receipt is scrubbed and written. `run` (run-spec.js) and `prove` (prove.js) both go
// through scrubReceipt and writeScrubbedReceipt, and writeScrubbedReceipt refuses a receipt that scrubReceipt has not seen,
// so a new entry point cannot write one unscrubbed by forgetting a step.
import { LAB_FILE_NAME, writeReceipt } from "./chain.js";
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

// How a printed path is shown: the directory is never printed, whatever it holds. The operator chose it, so the operator
// already knows it, and guessing whether a folder name looks like a secret has no end (it hides harmless names and misses
// others). What is left is the file name: the lab's own shape is kept intact, any other name is scrubbed like free text.
export const DIR_PLACEHOLDER = "<dir>/";
export function scrubReceiptFile(path) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  // A bare drive letter ("D:name.json") ends the directory part at the colon.
  const nameStart = Math.max(cut + 1, /^[A-Za-z]:/.test(path) ? 2 : 0);
  const name = path.slice(nameStart);
  const shown = LAB_FILE_NAME.test(name) ? name : redactSecrets(name); // only the exact shape chain.js writes is kept as it is
  return nameStart === 0 ? shown : `${DIR_PLACEHOLDER}${shown}`; // a bare name has no directory to hide
}
