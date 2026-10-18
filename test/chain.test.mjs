// Chain compatibility and verification. The fixture constants are the same ones proof-lab-go/main_test.go pins,
// so a body, hash or MAC that drifts between the two drivers fails here and there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GENESIS,
  canonicalBody,
  keyIdOf,
  latestHash,
  signBody,
  signingKey,
  sha256Hex,
  verifyChain,
  writeReceipt,
} from "../src/chain.js";

const fixtureBody = '{"verdict":"PASS","app":"http://127.0.0.1:4173","bug":null,"revision":"e5ec1a11e78c","at":"2026-01-01T00:00:00.000000000Z","checks":[{"name":"status shows waitlisted after join","pass":true,"expected":"waitlisted","actual":"waitlisted"}],"pageErrors":[],"screenshot":null,"error":null,"next":["These checks passed on this revision."],"keyId":"1492e30d3fc4a9f9","prevHash":"GENESIS"}';
const fixtureHash = "ed447ec6aba941605a7f90f161f9ae09a504002959229a891ace8c0476956835";
const fixtureMAC = "df5cab1b1f1cf82c773e66524334939ef2d8a02498a03631a0b455ba138f50f3";
const testKey = Buffer.from("unit-test-key-not-a-secret-0123456789", "utf8");
const testKeyId = "1492e30d3fc4a9f9";

function receipt(at) {
  return {
    verdict: "PASS",
    app: "http://127.0.0.1:4173",
    bug: null,
    revision: "e5ec1a11e78c",
    at,
    checks: [{ name: "status shows waitlisted after join", pass: true, expected: "waitlisted", actual: "waitlisted" }],
    pageErrors: [],
    screenshot: null,
    error: null,
    next: ["These checks passed on this revision."],
    prevHash: GENESIS,
  };
}

// A temp directory whose files are made writable and removed when the test ends. Windows cannot delete read-only files.
async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "proof-chain-"));
  t.after(async () => {
    for (const name of await readdir(dir)) await chmod(join(dir, name), 0o644).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function writeTwo(t) {
  const dir = await tempDir(t);
  for (const at of ["2026-01-01T00:00:00.000000005Z", "2026-01-01T00:00:00.000000006Z"]) {
    await writeReceipt(receipt(at), { key: testKey, dir });
  }
  return dir;
}

async function readReceipts(dir) {
  const names = (await readdir(dir)).filter(name => name.endsWith(".json")).sort();
  return Promise.all(
    names.map(async name => ({ path: join(dir, name), data: JSON.parse(await readFile(join(dir, name), "utf8")) })),
  );
}

test("body, hash and MAC match the Go driver fixture", () => {
  const parsed = JSON.parse(fixtureBody);
  assert.equal(canonicalBody(parsed), fixtureBody);
  assert.equal(sha256Hex(fixtureBody), fixtureHash);
  assert.equal(signBody(fixtureBody, testKey), fixtureMAC);
});

test("canonical body escapes U+2028 and U+2029 like Go does", () => {
  const body = canonicalBody({ ...receipt("2026-01-01T00:00:00.000000000Z"), next: ["a b c"] });
  assert.ok(body.includes("a\\u2028b\\u2029c"));
  assert.ok(!body.includes(" "));
});

test("canonical body writes a lone surrogate as U+FFFD, as Go's encoder does", () => {
  const body = canonicalBody({ ...receipt("2026-01-01T00:00:00.000000000Z"), next: ["a\ud800b"] });
  assert.ok(body.includes("a�b"));
  assert.ok(!body.includes("\\ud800"));
});

test("signingKey rejects a missing or short key and accepts 32 bytes", () => {
  assert.throws(() => signingKey({}), /PROOF_LAB_KEY must be set/);
  assert.throws(() => signingKey({ PROOF_LAB_KEY: "too-short" }), /PROOF_LAB_KEY must be set/);
  assert.equal(signingKey({ PROOF_LAB_KEY: "x".repeat(32) }).length, 32);
});

test("keyId is the first 16 hex characters of SHA-256(key) and every written receipt carries it", async t => {
  assert.equal(keyIdOf(testKey), testKeyId);
  const dir = await writeTwo(t);
  for (const { data } of await readReceipts(dir)) assert.equal(data.keyId, testKeyId);
});

test("written chain verifies, and the second receipt links to the first", async t => {
  const dir = await writeTwo(t);
  const result = await verifyChain(dir, testKey);
  assert.deepEqual(result.problems, []);
  assert.equal(result.checked, 2);
  const [first, second] = await readReceipts(dir);
  assert.equal(first.data.prevHash, GENESIS);
  assert.equal(second.data.prevHash, first.data.hash);
  assert.match(second.data.mac, /^[0-9a-f]{64}$/);
});

test("a written receipt is read-only: no write bit is set and a plain write is refused", async t => {
  const dir = await writeTwo(t);
  const [first] = await readReceipts(dir);
  const { mode } = await stat(first.path);
  assert.equal(mode & 0o222, 0, `receipt keeps a write bit: ${mode.toString(8)}`);
  // Refused on Windows and on non-root POSIX. A root process on POSIX bypasses file modes, so this is not a boundary there.
  await assert.rejects(writeFile(first.path, "tamper"));
});

test("an edited receipt is flagged, even after its read-only flag is cleared", async t => {
  const dir = await writeTwo(t);
  const [first] = await readReceipts(dir);
  const text = await readFile(first.path, "utf8");
  const edited = text.replace('"verdict": "PASS"', '"verdict": "FAIL"');
  await assert.rejects(writeFile(first.path, edited));
  // An attacker with rights can clear the read-only flag. The chain must still catch the edit.
  await chmod(first.path, 0o644);
  await writeFile(first.path, edited);
  const result = await verifyChain(dir, testKey);
  assert.equal(result.problems.length, 1);
});

test("a wrong key flags every receipt as signed under another key id", async t => {
  const dir = await writeTwo(t);
  const result = await verifyChain(dir, Buffer.from("another-key-not-a-secret-0123456789ab"));
  assert.equal(result.problems.length, 2);
  assert.ok(result.problems.every(problem => /key id/.test(problem)));
});

test("latestHash is GENESIS for an empty directory and the newest hash otherwise", async t => {
  const dir = await tempDir(t);
  assert.equal(await latestHash(dir), GENESIS);
  await writeReceipt(receipt("2026-01-01T00:00:00.000000007Z"), { key: testKey, dir });
  const [stored] = await readReceipts(dir);
  assert.equal(await latestHash(dir), stored.data.hash);
});
