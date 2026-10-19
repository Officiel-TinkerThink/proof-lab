import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSpec } from "../src/run-spec.js";
import { verifyChain } from "../src/chain.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STRICT = join(ROOT, "specs", "waitlist-strict.json");
const KEY = Buffer.alloc(40, 7);
const TIMEOUT = { timeout: 120000 };

// Runs the strict waitlist spec against the app with one known defect (or none) and returns the receipt.
async function runStrict(bug) {
  const work = await mkdtemp(join(tmpdir(), "proof-bugs-"));
  try {
    const spec = JSON.parse(await readFile(STRICT, "utf8"));
    if (bug) spec.app = { bug };
    const specPath = join(work, "strict.json");
    await writeFile(specPath, JSON.stringify(spec));
    const receipt = await runSpec({ specPath, key: KEY, receiptsDir: join(work, "receipts") });
    const { problems } = await verifyChain(join(work, "receipts"), KEY);
    assert.deepEqual(problems, [], "the receipt chain must verify");
    return receipt;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const failedNames = receipt => receipt.checks.filter(check => !check.pass).map(check => check.name);

test("the strict spec passes on the clean app", TIMEOUT, async () => {
  const receipt = await runStrict(null);
  assert.equal(receipt.verdict, "PASS", JSON.stringify(receipt.checks, null, 2));
  assert.equal(receipt.totals.checks, 8);
});

// Each known defect must be caught by the check that is about it, not by luck.
const CASES = [
  ["wrong-email", ["email survives reload", "record is in localStorage"]],
  ["wrong-status", ["status shows waitlisted after join", "status survives reload"]],
  ["console-error", ["no page errors"]],
  ["no-persist", ["status survives reload"]],
  ["lost-confirmation", ["confirmation shows after join"]],
];

for (const [bug, expected] of CASES) {
  test(`${bug} FAILs the strict spec at the checks that are about it`, TIMEOUT, async () => {
    const receipt = await runStrict(bug);
    assert.equal(receipt.verdict, "FAIL", `${bug} must not pass`);
    assert.equal(receipt.bug, bug);
    const failed = failedNames(receipt);
    for (const name of expected) assert.ok(failed.includes(name), `${bug}: expected "${name}" among failed checks: ${failed.join(", ")}`);
  });
}
