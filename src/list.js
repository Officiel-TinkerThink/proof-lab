// list: the receipts in a directory, newest first, so nobody has to guess a file name or open the folder.
// Usage: node src/list.js [--receipts <dir>] [--limit <n>] [--json]
// It only reads. It does not check signatures: `status` gives the verdict that counts.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { join } from "node:path";
import { receiptFiles } from "./chain.js";
import { runCli } from "./cli.js";
import { scrubText } from "./receipt-scrub.js";
import { isMainModule, parseCli } from "./spec/util.js";

const CLI_OPTIONS = { receipts: { type: "string" }, limit: { type: "string" }, json: { type: "boolean" } };
const DEFAULT_LIMIT = 20;

async function summarize(path) {
  const file = basename(path);
  try {
    const receipt = JSON.parse(await readFile(path, "utf8"));
    const text = value => (typeof value === "string" ? scrubText(value.slice(0, 100)) : null);
    return { file, verdict: text(receipt.verdict), spec: text(receipt.spec), at: text(receipt.at), revision: text(receipt.revision) };
  } catch {
    return { file, verdict: "UNREADABLE", spec: null, at: null, revision: null };
  }
}

export async function main(args, { defaultReceipts }) {
  const values = parseCli(args, CLI_OPTIONS);
  const limit = values.limit === undefined ? DEFAULT_LIMIT : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("--limit must be a whole number from 1 to 1000");
  const dir = values.receipts ?? defaultReceipts;
  let files;
  try {
    files = await receiptFiles(dir);
  } catch (error) {
    throw new Error(`the receipts directory could not be read (${error?.code ?? "error"})`);
  }
  const shown = [];
  for (const path of files.reverse().slice(0, limit)) shown.push(await summarize(join(dir, basename(path))));
  if (values.json) {
    console.log(JSON.stringify({ total: files.length, receipts: shown }, null, 2));
  } else {
    console.log(`${files.length} receipts${files.length > shown.length ? `, newest ${shown.length} shown` : ""} (not signature-checked: use status for the verdict)`);
    for (const item of shown) console.log(`${(item.verdict ?? "?").padEnd(10)} ${item.at ?? "?"}  ${item.spec ?? "?"}  ${item.file}`);
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  await runCli(() => main(process.argv.slice(2), { defaultReceipts: process.env.PROOF_LAB_RECEIPTS ?? "receipts" }));
}
