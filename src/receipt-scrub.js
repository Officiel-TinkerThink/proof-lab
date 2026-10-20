// The one place that decides how a receipt is scrubbed and written. `run` (run-spec.js) and `prove` (prove.js) both go
// through scrubReceipt and writeScrubbedReceipt, and writeScrubbedReceipt refuses a receipt that scrubReceipt has not seen,
// so a new entry point cannot write one unscrubbed by forgetting a step.
import * as util from "node:util";
import { LAB_FILE_NAME, LOCK_NAME, STALE_CLAIM_NAME, writeReceipt } from "./chain.js";
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
    receipt.error = `receipt write failed: ${safeLine(error)}`; // safe by construction: scrubbing it again would hide the lab's own file names
    receipt.next = [receipt.error, advice];
    return null;
  }
}

const DIR_PLACEHOLDER = "<dir>/";

// A path as a tool prints it (`<dir>/name`) read back as what it names: the directory part is not known, the name is.
// Either separator is accepted after the placeholder, as a path typed on Windows would use it.
const PLACEHOLDER_HEAD = DIR_PLACEHOLDER.slice(0, -1);
export const fromPrinted = printed => (printed.startsWith(PLACEHOLDER_HEAD) && /[\\/]/.test(printed[PLACEHOLDER_HEAD.length] ?? "") ? printed.slice(PLACEHOLDER_HEAD.length + 1) : printed);

// A path in an error line: its name is printed only when the lab wrote that file (its receipt, picture or evidence name, or
// its lock file). Any other path, a directory or a file the operator named, is `<path>`. An allow-list, because whether a
// path is a directory cannot be told from the call that failed on it (stat, open and realpath take either), and a list of
// directory calls would never be complete.
const lastSegment = path => path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
const isLabName = name => LAB_FILE_NAME.test(name) || name === LOCK_NAME || STALE_CLAIM_NAME.test(name);
const shownPath = path => (isLabName(lastSegment(path)) ? scrubReceiptFile(path) : "<path>");
// The code and the call are printed only in the shapes Node writes them (ENOENT, ERR_FS_EISDIR; open, spawn). Any other text
// there is shown as a placeholder: an allow-list, not a pattern, so a value from a dependency cannot put a path in the line.
const CODE_SHAPE = /^[A-Z][A-Z0-9_]*$/;
const CALL_SHAPE = /^[a-z][a-z0-9_]*$/;

// What safeLine returns when it cannot read the error at all. Exported so a test can tell it from a real line.
export const UNREADABLE_ERROR = "an error whose text could not be read";

// The first line of an error, for a command to print. Any error line a command prints goes through this, never through
// firstLine alone, and it never throws (it runs inside the handler that reports an error).
//
// A system error that names a path (code, syscall, errno, path, dest) is not cleaned up: its line is built from those
// fields, in the form Node writes it, with each path shown by shownPath. Its free-text message is never printed, so
// nothing has to be found and replaced inside a string (which never ends: overlapping paths, `$&` in a name, characters
// that mean something in a pattern). Every other error is free text and goes through the pattern scrub. Files the writer
// could not remove are a field of the error (`leftovers`, bare names the lab wrote), added here as a sentence of the lab's own.
export function safeLine(error) {
  try {
    const asText = value => (Buffer.isBuffer(value) ? value.toString() : typeof value === "string" ? value : "");
    // The lab's own sentence. Only names of the lab's own shape are listed; the pattern scrub is not run over it, because it
    // would read a 43-character file name as a token and hide it.
    const left = Array.isArray(error?.leftovers) && error.leftovers.length > 0
      ? `; could not remove ${error.leftovers.map(name => (typeof name === "string" && LAB_FILE_NAME.test(name) ? name : "<path>")).join(", ")}, so check the receipts directory`
      : "";
    const [path, dest] = [asText(error?.path), asText(error?.dest)];
    if (path !== "" && typeof error.code === "string" && typeof error.syscall === "string") {
      // The line is composed of parts that are safe by construction: the code, Node's description, the call and the paths
      // as shownPath gives them. The pattern scrub is applied to the two that come from the error, not to the whole line.
      const word = error.syscall.split(" ")[0]; // a spawn error's syscall is `spawn <file>`: the file is in path, shown as a path
      const call = CALL_SHAPE.test(word) ? word : "<call>";
      const code = CODE_SHAPE.test(error.code) ? error.code : "<code>";
      // The description is Node's own table; older Node has no such function, and an unknown number must not stop the report.
      const reason = typeof error.errno === "number" && error.errno < 0 ? util.getSystemErrorMessage?.(error.errno) : undefined;
      const quoted = [path, dest].filter(named => named !== "").map(named => `'${shownPath(named)}'`);
      return firstLine(`${reason === undefined ? code : `${code}: ${reason}`}, ${call} ${quoted.join(" -> ")}${left}`);
    }
    return `${redactSecrets(firstLine(error))}${left}`;
  } catch {
    return UNREADABLE_ERROR;
  }
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
