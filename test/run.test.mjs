// Regression gate for the prove runner: each scenario must give the expected verdict and exit code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROVE = fileURLToPath(new URL("../src/prove.js", import.meta.url));
const TEST_KEY = "run-test-key-not-a-secret-0123456789abcdef";

async function runProve(args, { key = TEST_KEY } = {}) {
  const receiptsDir = await mkdtemp(join(tmpdir(), "proof-run-"));
  const env = { ...process.env, PROOF_LAB_RECEIPTS: receiptsDir };
  if (key === null) delete env.PROOF_LAB_KEY;
  else env.PROOF_LAB_KEY = key;
  const result = spawnSync(process.execPath, [PROVE, ...args], { encoding: "utf8", timeout: 120_000, env });
  const receipt = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  return { exit: result.status, receipt, receiptsDir, stderr: result.stderr };
}

test("clean app gives PASS with exit 0", async () => {
  const { exit, receipt } = await runProve([]);
  assert.equal(receipt.verdict, "PASS");
  assert.equal(exit, 0);
  assert.ok(receipt.checks.length >= 6, "expected all checks to be recorded");
});

test("no-persist bug gives FAIL with exit 1 and reload checks named", async () => {
  const { exit, receipt } = await runProve(["--bug", "no-persist"]);
  assert.equal(receipt.verdict, "FAIL");
  assert.equal(exit, 1);
  const failed = receipt.checks.filter(check => !check.pass).map(check => check.name);
  assert.ok(failed.includes("status survives reload"));
  assert.ok(failed.includes("record is in localStorage"));
});

test("lost-confirmation bug gives FAIL with exit 1 and both confirmation checks failing", async () => {
  const { exit, receipt } = await runProve(["--bug", "lost-confirmation"]);
  assert.equal(receipt.verdict, "FAIL");
  assert.equal(exit, 1);
  const failed = receipt.checks.filter(check => !check.pass).map(check => check.name);
  assert.deepEqual(failed.sort(), ["confirmation shows after join", "confirmation survives reload"].sort());
});

test("unreachable app gives ERROR (can't tell) with exit 2, not FAIL", async () => {
  const { exit, receipt } = await runProve(["--url", "http://127.0.0.1:1"]);
  assert.equal(receipt.verdict, "ERROR");
  assert.equal(exit, 2);
  assert.equal(receipt.checks.length, 0);
  assert.match(receipt.error, /prove failed/);
});

test("missing key gives exit 2 and writes no receipt", async () => {
  const { exit, receipt, receiptsDir, stderr } = await runProve([], { key: null });
  assert.equal(exit, 2);
  assert.equal(receipt, null);
  assert.match(stderr, /PROOF_LAB_KEY must be set/);
  assert.equal(stderr.includes(TEST_KEY), false);
  assert.deepEqual((await readdir(receiptsDir)), []);
});

test("every receipt carries a hash, a MAC and the previous receipt's hash", async () => {
  const { receipt } = await runProve([]);
  assert.match(receipt.hash, /^[0-9a-f]{64}$/);
  assert.match(receipt.mac, /^[0-9a-f]{64}$/);
  assert.equal(receipt.prevHash, "GENESIS");
});

test("verify accepts a receipts directory the run just wrote", async () => {
  const { receiptsDir } = await runProve([]);
  const verify = spawnSync(process.execPath, [PROVE, "--verify", "--receipts", receiptsDir], {
    encoding: "utf8",
    env: { ...process.env, PROOF_LAB_KEY: TEST_KEY },
  });
  assert.equal(verify.status, 0, verify.stdout + verify.stderr);
  assert.match(verify.stdout, /VALID: 1 receipts/);
});
