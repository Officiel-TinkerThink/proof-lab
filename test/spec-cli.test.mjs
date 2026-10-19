import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "src", "run-spec.js");
const WAITLIST = join(ROOT, "specs", "waitlist.json");
const TIMEOUT = { timeout: 180000 };

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "proof-cli-"));
  const keyFile = join(dir, "key.txt");
  await writeFile(keyFile, "k".repeat(48));
  if (process.platform !== "win32") await chmod(keyFile, 0o600);
  return { dir, keyFile, receipts: join(dir, "receipts") };
}

// The key is never in the environment: PROOF_LAB_KEY is removed from the child unless a test sets it on purpose.
function cli(args, env = {}) {
  const { PROOF_LAB_KEY: _ignored, ...clean } = process.env;
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...clean, ...env } });
}

test("the CLI exits 2, not 1, for every setup problem, and writes nothing", TIMEOUT, async () => {
  const { dir, keyFile, receipts } = await workspace();
  try {
    const bad = join(dir, "bad.json");
    await writeFile(bad, JSON.stringify({ name: "bad", steps: [{ op: "teleport" }] }));
    const notJson = join(dir, "not-json.json");
    await writeFile(notJson, "{nope");

    const cases = [
      ["no key file", ["--spec", WAITLIST, "--receipts", receipts], {}, /--key-file <path> is required/],
      ["no spec", ["--key-file", keyFile, "--receipts", receipts], {}, /--spec <file\.json> is required/],
      ["key in the environment", ["--spec", WAITLIST, "--key-file", keyFile, "--receipts", receipts], { PROOF_LAB_KEY: "x".repeat(48) }, /PROOF_LAB_KEY is set/],
      ["missing key file", ["--spec", WAITLIST, "--key-file", join(dir, "nope.txt"), "--receipts", receipts], {}, /ERROR:/],
    ];
    for (const [label, args, env, message] of cases) {
      const result = cli(args, env);
      assert.equal(result.status, 2, `${label}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, message, label);
    }
    for (const spec of [bad, notJson, join(dir, "missing.json")]) {
      const result = cli(["--spec", spec, "--key-file", keyFile, "--receipts", receipts]);
      assert.equal(result.status, 2, spec);
      assert.match(result.stdout, /^ERROR /m);
      assert.match(result.stdout, /error: (invalid spec|spec could not be read)/);
    }
    await assert.rejects(readdir(receipts), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the CLI exits 0 on PASS, prints the summary and the file names, and --json carries the same facts", TIMEOUT, async () => {
  const { dir, keyFile, receipts } = await workspace();
  try {
    const text = cli(["--spec", WAITLIST, "--key-file", keyFile, "--receipts", receipts]);
    assert.equal(text.status, 0, text.stdout + text.stderr);
    assert.match(text.stdout, /^PASS waitlist@[0-9a-f]{12} http:\/\/127\.0\.0\.1:\d+/m);
    assert.match(text.stdout, /7 checks, 7 passed, 0 failed/);
    assert.match(text.stdout, /receipt:  .*\.json/);
    assert.match(text.stdout, /evidence: .*\.evidence\.jsonl/);

    const json = cli(["--spec", WAITLIST, "--key-file", keyFile, "--receipts", receipts, "--json"]);
    assert.equal(json.status, 0, json.stdout + json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.verdict, "PASS");
    assert.deepEqual(parsed.totals, { checks: 7, passed: 7, failed: 0, omitted: 0 });
    assert.match(parsed.receiptFile, /\.json$/);
    assert.match(parsed.evidenceFile, /\.evidence\.jsonl$/);
    assert.equal((await readdir(receipts)).filter(name => name.endsWith(".json")).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the CLI exits 1 on FAIL and names the failed checks", TIMEOUT, async () => {
  const { dir, keyFile, receipts } = await workspace();
  try {
    const spec = JSON.parse(await readFile(WAITLIST, "utf8"));
    spec.app = { bug: "no-persist" };
    const specPath = join(dir, "no-persist.json");
    await writeFile(specPath, JSON.stringify(spec));
    const result = cli(["--spec", specPath, "--key-file", keyFile, "--receipts", receipts]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /^FAIL /m);
    assert.match(result.stdout, /FAIL step 8: status survives reload/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
