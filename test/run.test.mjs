// Regression gate for the prove runner: each scenario must give the expected verdict and exit code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROVE = fileURLToPath(new URL("../src/prove.js", import.meta.url));

function runProve(args) {
  const result = spawnSync(process.execPath, [PROVE, ...args], { encoding: "utf8", timeout: 120_000 });
  const receipt = JSON.parse(result.stdout);
  return { exit: result.status, receipt };
}

test("clean app gives PASS with exit 0", () => {
  const { exit, receipt } = runProve([]);
  assert.equal(receipt.verdict, "PASS");
  assert.equal(exit, 0);
  assert.ok(receipt.checks.length >= 6, "expected all checks to be recorded");
});

test("no-persist bug gives FAIL with exit 1 and reload checks named", () => {
  const { exit, receipt } = runProve(["--bug", "no-persist"]);
  assert.equal(receipt.verdict, "FAIL");
  assert.equal(exit, 1);
  const failed = receipt.checks.filter(check => !check.pass).map(check => check.name);
  assert.ok(failed.includes("status survives reload"));
  assert.ok(failed.includes("record is in localStorage"));
});

test("lost-confirmation bug gives FAIL with exit 1 and both confirmation checks failing", () => {
  const { exit, receipt } = runProve(["--bug", "lost-confirmation"]);
  assert.equal(receipt.verdict, "FAIL");
  assert.equal(exit, 1);
  const failed = receipt.checks.filter(check => !check.pass).map(check => check.name);
  assert.deepEqual(failed.sort(), ["confirmation shows after join", "confirmation survives reload"].sort());
});

test("unreachable app gives ERROR (can't tell) with exit 2, not FAIL", () => {
  const { exit, receipt } = runProve(["--url", "http://127.0.0.1:1"]);
  assert.equal(receipt.verdict, "ERROR");
  assert.equal(exit, 2);
  assert.equal(receipt.checks.length, 0);
  assert.match(receipt.error, /prove failed/);
});

test("every receipt carries a hash and the previous receipt's hash", () => {
  const { receipt } = runProve([]);
  assert.match(receipt.hash, /^[0-9a-f]{64}$/);
  assert.ok(receipt.prevHash === "GENESIS" || /^[0-9a-f]{64}$/.test(receipt.prevHash));
});
