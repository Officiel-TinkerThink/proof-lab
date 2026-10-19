// Runs every demo spec against the built-in app and prints each receipt variant, then verifies the hash chain and
// shows what a tampered receipt looks like. Uses a throwaway key file and receipts folder: nothing in ./receipts changes.
//   node demo/run-demo.mjs
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "proof-lab-demo-"));
const keyFile = join(work, "demo.key");
writeFileSync(keyFile, randomBytes(32).toString("hex"), { mode: 0o600 });
const receipts = join(work, "receipts");
mkdirSync(receipts);

const env = { ...process.env };
delete env.PROOF_LAB_KEY; // the tools refuse an environment key: only --key-file is accepted
const run = (args) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", env });
const rule = title => console.log(`\n${"=".repeat(100)}\n${title}\n${"=".repeat(100)}`);
const specs = readdirSync(join(ROOT, "demo", "specs")).filter(name => name.endsWith(".json")).sort();

const MEANING = {
  "01-pass.json": "All verified: every check passed. Exit 0.",
  "02-fail-no-persist.json": "One bug found: the app forgets the record on reload. Exit 1.",
  "03-fail-lost-confirmation.json": "A different bug: the confirmation is lost after reload. Exit 1.",
  "04-needs-review.json": "Checks passed, but claims only a human can judge are listed. Exit 3: do not say done.",
  "05-pass-expectations.json": "Expectation blocks: a click must open a tab, another must not. Exit 0.",
  "06-error-invalid-spec.json": "The spec itself is invalid, nothing ran. Exit 2.",
  "07-error-no-checks.json": "The spec ran but asserted nothing. Exit 2.",
};

for (const name of specs) {
  rule(`${name}: ${MEANING[name] ?? ""}`);
  const result = run(["src/run-spec.js", "--spec", join("demo", "specs", name), "--key-file", keyFile, "--receipts", receipts, "--json"]);
  console.log(`exit code: ${result.status}`);
  console.log((result.stdout || result.stderr).trim());
}

rule("Evidence behind a receipt: the detail file of the FAIL run (02), first record of each type");
const evidenceFiles = readdirSync(receipts).filter(name => name.endsWith(".evidence.jsonl"));
const shown = new Set();
for (const file of evidenceFiles) {
  const lines = readFileSync(join(receipts, file), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  if (!lines.some(record => record.type === "check" && record.pass === false)) continue;
  console.log(`${file}: ${lines.length} records`);
  for (const record of lines) {
    if (shown.has(record.type)) continue;
    shown.add(record.type);
    console.log(JSON.stringify(record).slice(0, 400));
  }
  break;
}

rule("Verify the chain: every receipt is hash-chained and signed");
let verify = run(["src/prove.js", "--verify", "--key-file", keyFile, "--receipts", receipts]);
console.log(`exit code: ${verify.status}\n${(verify.stdout || verify.stderr).trim()}`);

rule("Tamper with one receipt (flip FAIL to PASS in a copy of the folder), then verify again");
const forged = join(work, "forged");
mkdirSync(forged);
for (const name of readdirSync(receipts)) copyFileSync(join(receipts, name), join(forged, name));
const victim = readdirSync(forged).filter(name => name.endsWith(".json")).find(name => JSON.parse(readFileSync(join(forged, name), "utf8")).verdict === "FAIL");
const text = readFileSync(join(forged, victim), "utf8").replace('"verdict": "FAIL"', '"verdict": "PASS"').replace('"verdict":"FAIL"', '"verdict":"PASS"');
chmodSync(join(forged, victim), 0o666); // receipts are written read-only; the forger lifts that on the copy
writeFileSync(join(forged, victim), text);
verify = run(["src/prove.js", "--verify", "--key-file", keyFile, "--receipts", forged]);
console.log(`edited: ${victim}\nexit code: ${verify.status}\n${(verify.stdout || verify.stderr).trim()}`);

console.log(`\nAll files are in ${work} (key, receipts, forged copy).`);
