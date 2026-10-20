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

// The first line of an error, for a command to print. A system error carries the path it failed on, exactly as the call
// got it (error.path, error.dest): that path is replaced the way a printed path is, so no directory is printed, and nothing
// is guessed. The rest of the line is free text and goes through the pattern scrub. Any error line a command prints goes
// through this, never through firstLine alone.
export function safeLine(error) {
  let line = firstLine(error);
  const named = ["path", "dest"].map(key => (Buffer.isBuffer(error?.[key]) ? error[key].toString() : error?.[key])).filter(value => typeof value === "string" && value !== "");
  if (named.length > 0) {
    // One pass over the line with one pattern, the longest path tried first at each position: one path can sit inside the
    // other (a rename into a folder holding the same name), and a second pass would also rewrite the text the first one
    // inserted. A replacer function, not a replacement string: a name holding `$&` or `$$` must not be expanded.
    const escaped = [...new Set(named)].sort((a, b) => b.length - a.length).map(path => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    line = line.replace(new RegExp(escaped.join("|"), "g"), path => scrubReceiptFile(path));
  }
  return redactSecrets(line);
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
