// Chain compatibility and verification. The fixture constants are the same ones proof-lab-go/main_test.go pins,
// so a body, hash or MAC that drifts between the two drivers fails here and there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GENESIS,
  canonicalBody,
  latestHash,
  signBody,
  signingKey,
  sha256Hex,
  verifyChain,
  writeReceipt,
} from "../src/chain.js";

const fixtureBody = '{"verdict":"PASS","app":"http://127.0.0.1:4173","bug":null,"revision":"e5ec1a11e78c","at":"2026-01-01T00:00:00.000000000Z","checks":[{"name":"status shows waitlisted after join","pass":true,"expected":"waitlisted","actual":"waitlisted"}],"pageErrors":[],"screenshot":null,"error":null,"next":["These checks passed on this revision."],"prevHash":"GENESIS"}';
const fixtureHash = "4ab0a237622ad3070db8bb1476f8971094b42ffae2bc178faf6651d117761151";
const fixtureMAC = "7fe435267bac163ee4e3c32b16f81f7d59cabcf64ffe131d2498d9b18095c689";
const testKey = Buffer.from("unit-test-key-not-a-secret-0123456789", "utf8");

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

test("body, hash and MAC match the Go driver fixture", () => {
  const parsed = JSON.parse(fixtureBody);
  assert.equal(canonicalBody(parsed), fixtureBody);
  assert.equal(sha256Hex(fixtureBody), fixtureHash);
  assert.equal(signBody(fixtureBody, testKey), fixtureMAC);
});

test("canonical body escapes U+2028 and U+2029 like Go does", () => {
  const body = canonicalBody({ ...receipt("2026-01-01T00:00:00.000000000Z"), next: ["a\u2028b\u2029c"] });
  assert.ok(body.includes("a\\u2028b\\u2029c"));
  assert.ok(!body.includes("\u2028"));
});

test("signingKey rejects a missing or short key and accepts 32 bytes", () => {
  assert.throws(() => signingKey({}), /PROOF_LAB_KEY must be set/);
  assert.throws(() => signingKey({ PROOF_LAB_KEY: "too-short" }), /PROOF_LAB_KEY must be set/);
  assert.equal(signingKey({ PROOF_LAB_KEY: "x".repeat(32) }).length, 32);
});

async function writeTwo() {
  const dir = await mkdtemp(join(tmpdir(), "proof-chain-"));
  for (const at of ["2026-01-01T00:00:00.000000005Z", "2026-01-01T00:00:00.000000006Z"]) {
    await writeReceipt(receipt(at), { key: testKey, dir });
  }
  return dir;
}

test("written chain verifies, and the second receipt links to the first", async () => {
  const dir = await writeTwo();
  const result = await verifyChain(dir, testKey);
  assert.deepEqual(result.problems, []);
  assert.equal(result.checked, 2);
  const files = (await readdir(dir)).filter(name => name.endsWith(".json")).sort();
  const first = JSON.parse(await readFile(join(dir, files[0]), "utf8"));
  const second = JSON.parse(await readFile(join(dir, files[1]), "utf8"));
  assert.equal(first.prevHash, GENESIS);
  assert.equal(second.prevHash, first.hash);
  assert.match(second.mac, /^[0-9a-f]{64}$/);
});

test("an edited receipt is flagged", async () => {
  const dir = await writeTwo();
  const files = (await readdir(dir)).filter(name => name.endsWith(".json")).sort();
  const path = join(dir, files[0]);
  const text = await readFile(path, "utf8");
  await writeFile(path, text.replace('"verdict": "PASS"', '"verdict": "FAIL"'));
  const result = await verifyChain(dir, testKey);
  assert.equal(result.problems.length, 1);
});

test("a wrong key flags every receipt", async () => {
  const dir = await writeTwo();
  const result = await verifyChain(dir, Buffer.from("another-key-not-a-secret-0123456789ab"));
  assert.equal(result.problems.length, 2);
});

test("latestHash is GENESIS for an empty directory and the newest hash otherwise", async () => {
  const dir = await mkdtemp(join(tmpdir(), "proof-chain-"));
  assert.equal(await latestHash(dir), GENESIS);
  await writeReceipt(receipt("2026-01-01T00:00:00.000000007Z"), { key: testKey, dir });
  const files = (await readdir(dir)).filter(name => name.endsWith(".json"));
  const stored = JSON.parse(await readFile(join(dir, files[0]), "utf8"));
  assert.equal(await latestHash(dir), stored.hash);
});
