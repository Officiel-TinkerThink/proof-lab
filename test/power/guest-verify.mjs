// Runs inside the guest after the power cycle. Verifies the chain and prints the head index for the host to compare with the last ACK.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyChain } from "/work/src/chain.js";

const DIR = "/work/receipts";
const KEY = await readFile("/work/key");
const result = await verifyChain(DIR, KEY);
const names = (await readdir(DIR)).filter(n => n.endsWith(".json")).sort();
const head = names.length ? JSON.parse(await readFile(join(DIR, names[names.length - 1]), "utf8")) : null;
const headIndex = head ? Number(head.at.slice(-10, -1)) : 0;
console.log(`VERIFY checked=${result.checked} problems=${result.problems.length} head=${headIndex}`);
for (const problem of result.problems) console.log(`PROBLEM ${problem}`);
