// Regression gate for the prove runner: each scenario must give the expected verdict and exit code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROVE = fileURLToPath(new URL("../src/prove.js", import.meta.url));
const TEST_KEY = "run-test-key-not-a-secret-0123456789abcdef";

// The key goes to the prover in a 0600 file, never in the environment (the prover refuses PROOF_LAB_KEY).
async function keyFileWith(key) {
  const dir = await mkdtemp(join(tmpdir(), "proof-key-"));
  const path = join(dir, "key");
  await writeFile(path, `${key}\n`);
  await chmod(path, 0o600);
  return path;
}

async function runProve(args, { key = TEST_KEY } = {}) {
  const receiptsDir = await mkdtemp(join(tmpdir(), "proof-run-"));
  const env = { ...process.env, PROOF_LAB_RECEIPTS: receiptsDir };
  delete env.PROOF_LAB_KEY;
  const keyArgs = key === null ? [] : ["--key-file", await keyFileWith(key)];
  const result = spawnSync(process.execPath, [PROVE, ...keyArgs, ...args], { encoding: "utf8", timeout: 120_000, env });
  const receipt = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  return { exit: result.status, receipt, receiptsDir, stderr: result.stderr };
}

test("clean app gives PASS with exit 0", async () => {
  const { exit, receipt } = await runProve([]);
  assert.equal(receipt.verdict, "PASS", receipt.error ?? undefined);
  assert.equal(exit, 0);
  assert.ok(receipt.checks.length >= 6, "expected all checks to be recorded");
});

test("no-persist bug gives FAIL with exit 1 and reload checks named", async () => {
  const { exit, receipt } = await runProve(["--bug", "no-persist"]);
  assert.equal(receipt.verdict, "FAIL", receipt.error ?? undefined);
  assert.equal(exit, 1);
  const failed = receipt.checks.filter(check => !check.pass).map(check => check.name);
  assert.ok(failed.includes("status survives reload"));
  assert.ok(failed.includes("record is in localStorage"));
});

test("lost-confirmation bug gives FAIL with exit 1 and both confirmation checks failing", async () => {
  const { exit, receipt } = await runProve(["--bug", "lost-confirmation"]);
  assert.equal(receipt.verdict, "FAIL", receipt.error ?? undefined);
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

// prove prints the whole receipt, so a receipts directory with a credential-looking segment must not appear in it: not in the
// picture path writeReceipt stores, and not in the text of a failed write (the system's error names the path it failed on).
test("the printed receipt does not carry a credential-looking receipts directory", async () => {
  const base = await mkdtemp(join(tmpdir(), "proof-scrub-"));
  const keyPath = await keyFileWith(TEST_KEY);
  const env = { ...process.env };
  delete env.PROOF_LAB_KEY;
  const prove = receiptsDir => spawnSync(process.execPath, [PROVE, "--key-file", keyPath, "--receipts", receiptsDir], { encoding: "utf8", timeout: 120_000, env });

  const good = join(base, "password=hunter2");
  await mkdir(good);
  const written = prove(good);
  assert.equal(written.status, 0, written.stdout + written.stderr);
  assert.match(JSON.parse(written.stdout).screenshot, /[\\/]\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f]{12}\.png$/, "the picture path keeps the file name");
  assert.equal(written.stdout.includes("hunter2"), false, "the picture path must not carry the raw directory");

  const notADirectory = join(base, "token=hunter2");
  await writeFile(notADirectory, "a file where the receipts directory should be");
  const failed = prove(notADirectory);
  assert.equal(failed.status, 2, failed.stdout + failed.stderr);
  assert.match(JSON.parse(failed.stdout).error, /^receipt write failed:/);
  assert.equal(failed.stdout.includes("hunter2"), false, "the failed-write text must not carry the raw path");
});

test("missing key gives exit 2 and writes no receipt", async () => {
  const { exit, receipt, receiptsDir, stderr } = await runProve([], { key: null });
  assert.equal(exit, 2);
  assert.equal(receipt, null);
  assert.match(stderr, /--key-file <path> is required/);
  assert.equal(stderr.includes(TEST_KEY), false);
  assert.deepEqual((await readdir(receiptsDir)), []);
});

test("a key in the environment is refused with exit 2 and writes no receipt", async () => {
  const receiptsDir = await mkdtemp(join(tmpdir(), "proof-run-"));
  const keyPath = await keyFileWith(TEST_KEY);
  const env = { ...process.env, PROOF_LAB_RECEIPTS: receiptsDir, PROOF_LAB_KEY: TEST_KEY };
  const result = spawnSync(process.execPath, [PROVE, "--key-file", keyPath], { encoding: "utf8", timeout: 120_000, env });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /PROOF_LAB_KEY is set in the environment/);
  assert.equal(result.stderr.includes(TEST_KEY), false);
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
  const keyPath = await keyFileWith(TEST_KEY);
  const env = { ...process.env };
  delete env.PROOF_LAB_KEY;
  const verify = spawnSync(process.execPath, [PROVE, "--verify", "--key-file", keyPath, "--receipts", receiptsDir], {
    encoding: "utf8",
    env,
  });
  assert.equal(verify.status, 0, verify.stdout + verify.stderr);
  assert.match(verify.stdout, /VALID: 1 receipts/);
});
