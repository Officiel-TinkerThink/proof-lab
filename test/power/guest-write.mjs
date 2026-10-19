// Runs inside the guest. Writes receipts through the real chain.js and prints ACK <index> only after writeReceipt resolves,
// that is, after the file and its directory were flushed. The host kills the VM at an arbitrary point (the power cut).
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeReceipt } from "/work/src/chain.js";

const DIR = "/work/receipts";
const KEY = await readFile("/work/key");
await mkdir(DIR, { recursive: true });

// Continue after the current head so the chain never forks across power cycles.
const names = (await readdir(DIR)).filter(n => n.endsWith(".json")).sort();
let index = 1;
if (names.length) {
  const head = JSON.parse(await readFile(join(DIR, names[names.length - 1]), "utf8"));
  index = Number(head.at.slice(-10, -1)) + 1;
}

const receiptAt = i => ({
  verdict: "PASS",
  app: "http://127.0.0.1:4173",
  bug: null,
  revision: "e5ec1a11e78c",
  at: `2026-01-01T00:00:00.${String(i).padStart(9, "0")}Z`,
  checks: [{ name: "status shows waitlisted after join", pass: true, expected: "waitlisted", actual: "waitlisted" }],
  pageErrors: [],
  screenshot: null,
  error: null,
  next: ["These checks passed on this revision."],
});

for (;;) {
  await writeReceipt(receiptAt(index), { key: KEY, dir: DIR });
  console.log(`ACK ${index}`);
  index += 1;
}
