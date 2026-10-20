// The one place that decides how a receipt is scrubbed and written. `run` (run-spec.js) and `prove` (prove.js) both go
// through scrubReceipt and writeScrubbedReceipt, and writeScrubbedReceipt refuses a receipt that scrubReceipt has not seen,
// so a new entry point cannot write one unscrubbed by forgetting a step.
import { getSystemErrorMessage } from "node:util";
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
    receipt.error = scrubValue(`receipt write failed: ${safeLine(error)}`);
    receipt.next = [receipt.error, advice];
    return null;
  }
}

const DIR_PLACEHOLDER = "<dir>/";

// A path as a tool prints it (`<dir>/name`) read back as what it names: the directory part is not known, the name is.
// Either separator is accepted after the placeholder, as a path typed on Windows would use it.
const PLACEHOLDER_HEAD = DIR_PLACEHOLDER.slice(0, -1);
export const fromPrinted = printed => (printed.startsWith(PLACEHOLDER_HEAD) && /[\\/]/.test(printed[PLACEHOLDER_HEAD.length] ?? "") ? printed.slice(PLACEHOLDER_HEAD.length + 1) : printed);

// The first line of an error, for a command to print. Any error line a command prints goes through this, never through
// firstLine alone.
//
// A system error that names a path (code, syscall, errno, path, dest) is not cleaned up: its line is built from those
// fields, in the form Node writes it, with each path shown the way a printed path is. Its free-text message is never
// printed, so nothing has to be found and replaced inside a string (which never ends: overlapping paths, `$&` in a name,
// characters that mean something in a pattern). Every other error is free text and goes through the pattern scrub.
export function safeLine(error) {
  const asText = value => (Buffer.isBuffer(value) ? value.toString() : typeof value === "string" ? value : "");
  const [path, dest] = [asText(error?.path), asText(error?.dest)];
  if (path !== "" && typeof error.code === "string" && typeof error.syscall === "string") {
    const reason = typeof error.errno === "number" ? getSystemErrorMessage(error.errno) : undefined;
    const quoted = [path, dest].filter(shown => shown !== "").map(shown => `'${scrubReceiptFile(shown)}'`);
    return redactSecrets(firstLine(`${reason === undefined ? error.code : `${error.code}: ${reason}`}, ${error.syscall} ${quoted.join(" -> ")}`)); // a name with a line break stays one line
  }
  return redactSecrets(firstLine(error));
}

// How a printed path is shown: the directory is never printed, whatever it holds. The operator chose it, so the operator
// already knows it, and guessing whether a folder name looks like a secret has no end (it hides harmless names and misses
// others). What is left is the file name: the lab's own shape is kept intact, any other name is scrubbed like free text.
export function scrubReceiptFile(path) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  // A bare drive letter ("D:name.json") ends the directory part at the colon.
  const nameStart = Math.max(cut + 1, /^[A-Za-z]:/.test(path) ? 2 : 0);
  const name = path.slice(nameStart);
  const shown = LAB_FILE_NAME.test(name) ? name : redactSecrets(name); // only the exact shape chain.js writes is kept as it is
  return nameStart === 0 ? shown : `${DIR_PLACEHOLDER}${shown}`; // a bare name has no directory to hide
}
