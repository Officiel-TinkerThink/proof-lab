// The one place that decides how a receipt is scrubbed. `run` (run-spec.js) and `prove` (prove.js) both call these three
// steps, so an entry point cannot skip one; a new entry point imports them instead of copying them.
import { hideQuery, scrubValue } from "./spec/evidence.js";
import { scrubReceiptFile } from "./status.js";
import { firstLine } from "./spec/util.js";

// Fields that are the run's own bookkeeping, not page or spec text; the scrub leaves them alone.
// "spec" is the run's identity (name scrubbed, hash appended by specLabel): scrubbing it again could swallow the hash.
const RECEIPT_BOOKKEEPING = ["spec", "at", "verdict"];

// Step 1, the scrub point: every field of the receipt, whichever code path produced its text, before it is written.
export function scrubReceipt(receipt) {
  if (typeof receipt.app === "string") receipt.app = hideQuery(receipt.app);
  for (const key of Object.keys(receipt)) if (!RECEIPT_BOOKKEEPING.includes(key)) receipt[key] = scrubValue(receipt[key]);
}

// Step 2: a receipt that cannot be written is not evidence, so the run becomes ERROR, never a silent PASS. The system's
// error text names the path it failed on and arrives after step 1, so it is scrubbed here as it is set.
export function recordWriteFailure(receipt, error, advice) {
  receipt.verdict = "ERROR";
  receipt.error = scrubValue(`receipt write failed: ${firstLine(error)}`);
  receipt.next = [receipt.error, advice];
}

// Step 3: writeReceipt stores the picture's path on the receipt after step 1, with the raw receipts directory in it.
// The signed file on disk keeps the real path; the receipt a caller gets and prints does not.
export function scrubStoredPaths(receipt) {
  if (typeof receipt.screenshot === "string") receipt.screenshot = scrubReceiptFile(receipt.screenshot);
}
