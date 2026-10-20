// show: read the details behind a receipt. The receipt is a summary; its evidence file holds every check, the step
// timeline, console output and the page as it was at the first failures. The file is checked against the hash in the
// (signed) receipt before anything is shown, so what an agent reads is what the run recorded.
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_EVIDENCE_BYTES, isEvidenceName, receiptFiles, signingKeyFromFile, verifyChain } from "./chain.js";
import { runCli } from "./cli.js";
import { fromPrinted, scrubReceiptFile } from "./receipt-scrub.js";
import { redactSecrets } from "./spec/evidence.js";
import { isMainModule, parseCli } from "./spec/util.js";

const SECTIONS = ["summary", "steps", "checks", "failures", "console", "context"];

// Loads a receipt and its evidence. records is null when there is no evidence to read (the notes say why).
export async function loadEvidence({ dir, receipt: which = "latest", key }) {
  const files = await receiptFiles(dir);
  if (files.length === 0) throw new Error("no receipts in the receipts directory");
  let path;
  if (which === "latest") {
    path = files.at(-1);
  } else {
    const asGiven = fromPrinted(which); // a path as this tool prints it (<dir>/name) names a receipt in the directory
    const wanted = resolve(isAbsolute(asGiven) ? asGiven : join(dir, asGiven));
    path = files.find(file => resolve(file) === wanted);
    if (!path) throw new Error(`${scrubReceiptFile(asGiven)} is not a receipt in the receipts directory`);
  }
  const notes = [];
  if (key) {
    const result = await verifyChain(dir, key);
    if (result.problems.length > 0) throw new Error(`the receipt chain does not verify, so nothing can be trusted: ${result.problems.join("; ")}`);
  } else {
    notes.push("The receipt signature was not checked: pass --key-file to verify the chain.");
  }
  const receipt = JSON.parse(await readFile(path, "utf8"));
  if (!receipt.evidence) return { receipt, path, records: null, notes: [...notes, "This receipt has no evidence file."] };

  const file = receipt.evidence.file;
  if (!isEvidenceName(file)) throw new Error("the evidence reference in the receipt is malformed");
  let bytes;
  try {
    const info = await lstat(join(dir, file));
    if (!info.isFile()) throw new Error(`evidence file ${file} is not a plain file`);
    if (info.size > MAX_EVIDENCE_BYTES) throw new Error(`evidence file ${file} is larger than ${MAX_EVIDENCE_BYTES} bytes`);
    bytes = await readFile(join(dir, file));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { receipt, path, records: null, notes: [...notes, `The evidence file ${file} is missing (it may have been pruned). The receipt summary is still the signed record.`] };
  }
  if (createHash("sha256").update(bytes).digest("hex") !== receipt.evidence.sha256) {
    throw new Error(`evidence file ${file} does not match the hash in the receipt; do not trust it`);
  }
  const records = bytes.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line));
  return { receipt, path, evidencePath: join(dir, file), records, notes };
}

const ofType = (records, type) => records.filter(record => record.type === type);
const show = value => (typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value) ?? "undefined");

function checkLine(check) {
  const status = check.pass ? "PASS" : "FAIL";
  const detail = check.pass ? "" : `\n      expected ${show(check.expected)}\n      actual   ${show(check.actual)}${check.error ? `\n      error    ${check.error}` : ""}${check.hint ? `\n      hint     ${check.hint}` : ""}`;
  return `  ${status} step ${check.step}: ${check.name}${detail}`;
}

// Each section returns lines of text for people, and the underlying records for --json.
export function render(section, { receipt, records, path }) {
  switch (section) {
    case "summary": {
      const lines = [`${receipt.verdict} ${receipt.spec ?? ""} ${receipt.app ?? ""}`.trimEnd(), `  receipt:  ${scrubReceiptFile(path)}`];
      if (receipt.evidence) lines.push(`  evidence: ${receipt.evidence.file} (${receipt.evidence.bytes} bytes)`);
      if (receipt.totals) lines.push(`  ${receipt.totals.checks} checks, ${receipt.totals.passed} passed, ${receipt.totals.failed} failed${receipt.totals.omitted ? ` (${receipt.totals.omitted} not listed here; see --checks)` : ""}`);
      for (const check of receipt.checks ?? []) lines.push(checkLine(check));
      if (receipt.review?.total > 0) {
        lines.push(`  NEEDS REVIEW: ${receipt.review.total} claim(s) only a human can judge${receipt.review.total > receipt.review.items.length ? ` (${receipt.review.items.length} listed)` : ""}`);
        for (const item of receipt.review.items) lines.push(`    step ${item.step}: ${item.name}${item.note ? ` (${item.note})` : ""}`);
      }
      if (receipt.error) lines.push(`  error: ${receipt.error}`);
      for (const line of receipt.next ?? []) lines.push(`  -> ${line}`);
      // A receipt written before the picture was stored by name holds the full path of the picture: scrub it on the way out.
      return { text: lines.join("\n"), data: typeof receipt.screenshot === "string" ? { ...receipt, screenshot: scrubReceiptFile(receipt.screenshot) } : receipt };
    }
    case "steps": {
      const steps = ofType(records, "step");
      const lines = steps.map(step => `  ${String(step.step).padStart(3)}  ${step.ok ? "ok  " : "FAIL"} ${String(step.ms).padStart(6)} ms  ${step.op}${step.target ? ` ${step.target}` : ""}${step.skipped ? `   (optional, skipped: ${step.skipped})` : ""}`);
      return { text: lines.join("\n"), data: steps };
    }
    case "checks": {
      const checks = ofType(records, "check");
      return { text: checks.map(checkLine).join("\n"), data: checks };
    }
    case "failures": {
      const failed = ofType(records, "check").filter(check => !check.pass);
      const contexts = ofType(records, "context");
      const lines = [];
      for (const check of failed) {
        lines.push(checkLine(check));
        const context = contexts.find(candidate => candidate.step === check.step);
        if (context) lines.push(`      page: ${context.url} (${context.title ?? "no title"}); see --context for what it showed`);
      }
      return { text: lines.length > 0 ? lines.join("\n") : "  no failed checks", data: { failed, contexts } };
    }
    case "console": {
      const messages = ofType(records, "console");
      const errors = ofType(records, "pageerror");
      const lines = [...messages.map(record => `  [${record.level}] ${record.text}`), ...errors.map(record => `  [pageerror] ${record.message}`)];
      for (const record of ofType(records, "console-truncated")) lines.push(`  (${record.dropped} more console records were dropped)`);
      for (const record of ofType(records, "pageerror-truncated")) lines.push(`  (${record.dropped} more page errors were dropped)`);
      return { text: lines.length > 0 ? lines.join("\n") : "  no console output", data: { messages, errors } };
    }
    case "context": {
      const contexts = ofType(records, "context");
      const lines = contexts.flatMap(context => [`  step ${context.step}: ${context.url} (${context.title ?? "no title"})`, ...(context.aria ? context.aria.split("\n").map(line => `    ${line}`) : [`    (no snapshot: ${context.ariaError ?? "unavailable"})`])]);
      return { text: lines.length > 0 ? lines.join("\n") : "  no page context was captured (no check failed)", data: contexts };
    }
    default:
      throw new Error(`unknown section ${section}`);
  }
}

// Writes the first failure picture to a file. Returns the path, or null when the run has none.
export async function savePicture(records, outPath) {
  const picture = ofType(records, "screenshot")[0];
  if (!picture) return null;
  await writeFile(outPath, Buffer.from(picture.base64, "base64"));
  return outPath;
}

const CLI_OPTIONS = {
  receipts: { type: "string" },
  receipt: { type: "string" },
  "key-file": { type: "string" },
  "save-picture": { type: "string" },
  json: { type: "boolean" },
  ...Object.fromEntries(SECTIONS.map(name => [name, { type: "boolean" }])),
};

// CLI: show [--receipts <dir>] [--receipt <file|latest>] [--key-file <path>] [--summary|--steps|--checks|--failures|--console|--context]
//           [--save-picture <file.jpg>] [--json]. Returns the exit code.
export async function main(args, { defaultReceipts }) {
  const values = parseCli(args, CLI_OPTIONS);
  if (process.env.PROOF_LAB_KEY !== undefined) throw new Error("PROOF_LAB_KEY is set in the environment; unset it and pass the key with --key-file <path>");
  const chosen = SECTIONS.filter(name => values[name]);
  const loaded = await loadEvidence({
    dir: values.receipts ?? defaultReceipts,
    receipt: values.receipt ?? "latest",
    key: values["key-file"] ? await signingKeyFromFile(values["key-file"]) : undefined,
  });
  const sections = chosen.length > 0 ? chosen : ["summary"];
  const needsRecords = sections.some(name => name !== "summary") || values["save-picture"];
  if (needsRecords && !loaded.records) throw new Error(loaded.notes.at(-1));
  const rendered = Object.fromEntries(sections.map(name => [name, render(name, loaded)]));
  if (values["save-picture"]) {
    const saved = await savePicture(loaded.records, values["save-picture"]);
    if (!saved) throw new Error("this run captured no picture (no check failed)");
    console.error(`picture written to ${scrubReceiptFile(saved)}`);
  }
  if (values.json) {
    console.log(JSON.stringify(Object.fromEntries(sections.map(name => [name, rendered[name].data])), null, 2));
  } else {
    for (const name of sections) console.log(sections.length > 1 ? `== ${name} ==\n${rendered[name].text}` : rendered[name].text);
    for (const note of loaded.notes) console.error(`note: ${redactSecrets(note)}`);
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  await runCli(() => main(process.argv.slice(2), { defaultReceipts: process.env.PROOF_LAB_RECEIPTS ?? join(root, "receipts") }));
}
