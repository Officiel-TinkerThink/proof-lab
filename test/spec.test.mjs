import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSpec, validateSpec } from "../src/run-spec.js";
import { verifyChain } from "../src/chain.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WAITLIST = join(ROOT, "specs", "waitlist.json");
const KEY = Buffer.alloc(40, 7);
const TIMEOUT = { timeout: 120000 };

async function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

// Copies the waitlist spec with an app.bug set, into a directory that is not the receipts directory.
async function specWithBug(bug, dir) {
  const spec = JSON.parse(await readFile(WAITLIST, "utf8"));
  spec.app = { bug };
  const path = join(dir, `waitlist-${bug}.json`);
  await writeFile(path, JSON.stringify(spec, null, 2));
  return path;
}

test("validateSpec rejects an unknown op", () => {
  const problems = validateSpec({ name: "x", steps: [{ op: "teleport" }] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /op "teleport" is not one of/);
});

test("validateSpec accepts the waitlist spec", async () => {
  assert.deepEqual(validateSpec(JSON.parse(await readFile(WAITLIST, "utf8"))), []);
});

test("waitlist spec PASSes on the clean app, and the receipts chain verifies", TIMEOUT, async () => {
  const receipts = await tempDir("proof-spec-");
  try {
    const receipt = await runSpec({ specPath: WAITLIST, key: KEY, receiptsDir: receipts });
    assert.equal(receipt.verdict, "PASS", JSON.stringify(receipt.checks, null, 2));
    assert.match(receipt.spec, /^waitlist@[0-9a-f]{12}$/);
    const { problems, checked } = await verifyChain(receipts, KEY);
    assert.deepEqual(problems, []);
    assert.equal(checked, 1);
  } finally {
    await rm(receipts, { recursive: true, force: true });
  }
});

test("no-persist bug FAILs at 'status survives reload'", TIMEOUT, async () => {
  const specs = await tempDir("proof-spec-src-");
  const receipts = await tempDir("proof-spec-");
  try {
    const specPath = await specWithBug("no-persist", specs);
    const receipt = await runSpec({ specPath, key: KEY, receiptsDir: receipts });
    assert.equal(receipt.verdict, "FAIL");
    assert.equal(receipt.bug, "no-persist");
    const failed = receipt.checks.filter(check => !check.pass).map(check => check.name);
    assert.ok(failed.includes("status survives reload"), `failed checks: ${failed.join(", ")}`);
  } finally {
    await rm(specs, { recursive: true, force: true });
    await rm(receipts, { recursive: true, force: true });
  }
});

test("malformed spec returns ERROR and writes no receipt", TIMEOUT, async () => {
  const specs = await tempDir("proof-spec-src-");
  const receipts = await tempDir("proof-spec-");
  try {
    const unknownOp = join(specs, "unknown-op.json");
    await writeFile(unknownOp, JSON.stringify({ name: "bad", steps: [{ op: "teleport" }] }));
    const notJson = join(specs, "not-json.json");
    await writeFile(notJson, "{not json");
    for (const specPath of [unknownOp, notJson]) {
      const receipt = await runSpec({ specPath, key: KEY, receiptsDir: receipts });
      assert.equal(receipt.verdict, "ERROR");
    }
    assert.deepEqual(await readdir(receipts), []);
  } finally {
    await rm(specs, { recursive: true, force: true });
    await rm(receipts, { recursive: true, force: true });
  }
});
