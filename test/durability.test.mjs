// Durability and key-handling tests: key file mode, head ordering (fail closed), receipts lock, lock cleanup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readdir, rm, writeFile, access } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { LOCK_NAME, signingKeyFromFile, writeReceipt } from "../src/chain.js";

const KEY = "unit-test-key-not-a-secret-0123456789";

const receiptAt = at => ({
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
});

async function tempDir() {
  return mkdtemp(join(tmpdir(), "proof-lab-durability-"));
}

async function keyFile(content, mode) {
  const dir = await tempDir();
  const path = join(dir, "key");
  await writeFile(path, content);
  await chmod(path, mode);
  return { dir, path };
}

const onPosix = process.platform !== "win32";

test("a key file readable by group or others is refused", { skip: !onPosix }, async () => {
  const { dir, path } = await keyFile(`${KEY}\n`, 0o644);
  try {
    await assert.rejects(signingKeyFromFile(path), /readable by group or others/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a 0600 key file loads without its trailing newline", async () => {
  const { dir, path } = await keyFile(`${KEY}\r\n`, 0o600);
  try {
    const key = await signingKeyFromFile(path);
    assert.equal(key.toString("utf8"), KEY);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a receipt not later than the chain head is refused and nothing is written", async () => {
  const dir = await tempDir();
  try {
    await writeReceipt(receiptAt("2026-01-01T00:00:00.000000002Z"), { key: Buffer.from(KEY), dir });
    await assert.rejects(
      writeReceipt(receiptAt("2026-01-01T00:00:00.000000001Z"), { key: Buffer.from(KEY), dir }),
      /not later than the chain head/,
    );
    const names = (await readdir(dir)).filter(name => name.endsWith(".json"));
    assert.equal(names.length, 1, "the refused receipt must not be written");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a writer gives up while another holds the lock, and leaves that lock in place", async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir, LOCK_NAME), "held by another writer");
    await assert.rejects(
      writeReceipt(receiptAt("2026-01-01T00:00:00.000000003Z"), { key: Buffer.from(KEY), dir, lockTimeoutMs: 150 }),
      /locked by another writer/,
    );
    await access(join(dir, LOCK_NAME));
    const names = (await readdir(dir)).filter(name => name.endsWith(".json"));
    assert.equal(names.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A pid that existed a moment ago and has exited: the process table no longer holds it.
function deadPid() {
  return spawnSync(process.execPath, ["-e", "0"]).pid;
}

test("a lock left by a process that no longer exists is reclaimed", async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir, LOCK_NAME), JSON.stringify({ pid: deadPid(), host: hostname() }));
    await writeReceipt(receiptAt("2026-01-01T00:00:00.000000006Z"), { key: Buffer.from(KEY), dir });
    const names = (await readdir(dir)).filter(name => name.endsWith(".json"));
    assert.equal(names.length, 1);
    assert.equal((await readdir(dir)).includes(LOCK_NAME), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a lock held by a live process is never taken over", async () => {
  const dir = await tempDir();
  // A lock naming this process's own pid is a leftover (writers here queue), so the live owner must be another process.
  const owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    await writeFile(join(dir, LOCK_NAME), JSON.stringify({ pid: owner.pid, host: hostname() }));
    await assert.rejects(
      writeReceipt(receiptAt("2026-01-01T00:00:00.000000007Z"), { key: Buffer.from(KEY), dir, lockTimeoutMs: 150 }),
      /locked by another writer/,
    );
    await access(join(dir, LOCK_NAME));
  } finally {
    owner.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a lock from another host is never taken over, even when its pid is dead here", async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir, LOCK_NAME), JSON.stringify({ pid: deadPid(), host: "some-other-host" }));
    await assert.rejects(
      writeReceipt(receiptAt("2026-01-01T00:00:00.000000008Z"), { key: Buffer.from(KEY), dir, lockTimeoutMs: 150 }),
      /locked by another writer/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a leftover temp file from a crashed write is ignored by the chain", async () => {
  const dir = await tempDir();
  try {
    await writeReceipt(receiptAt("2026-01-01T00:00:00.000000009Z"), { key: Buffer.from(KEY), dir });
    await writeFile(join(dir, "2026-01-01T00-00-00-000000010Z-e5ec1a11e78c.json.abc123.tmp"), "partial");
    await writeReceipt(receiptAt("2026-01-01T00:00:00.000000010Z"), { key: Buffer.from(KEY), dir });
    const names = (await readdir(dir)).filter(name => name.endsWith(".json"));
    assert.equal(names.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a successful write removes its lock file", async () => {
  const dir = await tempDir();
  try {
    await writeReceipt(receiptAt("2026-01-01T00:00:00.000000004Z"), { key: Buffer.from(KEY), dir });
    const entries = await readdir(dir);
    assert.equal(entries.includes(LOCK_NAME), false, "the lock file must not outlive the write");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
