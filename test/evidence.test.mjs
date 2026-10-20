import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  EVIDENCE_SUFFIX, LOCK_NAME, MAX_EVIDENCE_BYTES, canonicalBody, fileBody, fileStamp, fixedStamp, isEvidenceName, keyIdOf,
  latestHash, receiptFiles, sha256Hex, signBody, verifyChain, withChainLock, writeReceipt,
} from "../src/chain.js";

const KEY = Buffer.alloc(40, 9);
const REVISION = "0123456789ab";
const stamp = ms => fixedStamp(new Date(Date.UTC(2026, 9, 19, 10, 0, 0, ms)));

// A receipt in the field order the Node driver writes.
const baseReceipt = (at, extra = {}) => ({
  verdict: "PASS", app: "http://x", bug: null, spec: "t@000000000000", revision: REVISION, at,
  totals: { checks: 1, passed: 1, failed: 0, omitted: 0 }, checks: [], evidence: null,
  pageErrors: [], screenshot: null, error: null, next: ["ok"], ...extra,
});

async function inTempDir(work) {
  const dir = await mkdtemp(join(tmpdir(), "proof-evidence-"));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Writes a correctly signed receipt whose evidence reference is whatever the test says, as a forger with the key could.
async function writeSigned(dir, receipt) {
  receipt.keyId = keyIdOf(KEY);
  receipt.prevHash = await latestHash(dir);
  const body = canonicalBody(receipt);
  receipt.hash = sha256Hex(body);
  receipt.mac = signBody(body, KEY);
  await writeFile(join(dir, `${fileStamp(receipt.at)}-${REVISION}.json`), fileBody(receipt));
}

test("writeReceipt stores the evidence file, signs its hash, and verify accepts it", async () => {
  await inTempDir(async dir => {
    const receipt = baseReceipt(stamp(1));
    const evidence = '{"type":"run"}\n{"type":"summary"}\n';
    const paths = await writeReceipt(receipt, { shot: Buffer.from("png"), evidence, key: KEY, dir });

    const name = `${fileStamp(receipt.at)}-${REVISION}${EVIDENCE_SUFFIX}`;
    assert.equal(basename(paths.evidencePath), name);
    assert.deepEqual(receipt.evidence, { file: name, sha256: sha256Hex(evidence), bytes: Buffer.byteLength(evidence) });
    assert.equal(await readFile(paths.evidencePath, "utf8"), evidence);
    assert.deepEqual((await readdir(dir)).sort(), [name, `${fileStamp(receipt.at)}-${REVISION}.json`, `${fileStamp(receipt.at)}-${REVISION}.png`].sort());
    assert.equal((await receiptFiles(dir)).length, 1, "evidence must not be listed as a receipt");

    const stored = JSON.parse(await readFile(paths.receiptPath, "utf8"));
    assert.equal(stored.evidence.file, name, "the receipt names the file, not a path");
    assert.deepEqual(await verifyChain(dir, KEY), { problems: [], checked: 1, missingEvidence: [] });
  });
});

test("a changed evidence file is a verification problem; a missing one is a note", async () => {
  await inTempDir(async dir => {
    const receipt = baseReceipt(stamp(2));
    const paths = await writeReceipt(receipt, { evidence: "original\n", key: KEY, dir });

    await chmod(paths.evidencePath, 0o644);
    await writeFile(paths.evidencePath, "edited\n");
    const edited = await verifyChain(dir, KEY);
    assert.equal(edited.problems.length, 1);
    assert.match(edited.problems[0], /evidence file .* does not match the hash recorded in the receipt/);

    await rm(paths.evidencePath);
    const gone = await verifyChain(dir, KEY);
    assert.deepEqual(gone.problems, []);
    assert.deepEqual(gone.missingEvidence, [receipt.evidence.file]);
  });
});

test("a forged evidence reference cannot make verify read anywhere else", async () => {
  const forged = [
    { file: "../outside.evidence.jsonl", sha256: "x" },
    { file: "sub/inside.evidence.jsonl", sha256: "x" },
    { file: "C:\\somewhere\\x.evidence.jsonl", sha256: "x" },
    { file: "/etc/passwd.evidence.jsonl", sha256: "x" },
    { file: "plain.json", sha256: "x" },
    { file: "x.evidence.jsonl.exe", sha256: "x" },
    { file: "", sha256: "x" },
    { file: "x.evidence.jsonl" },
    { file: 5, sha256: "x" },
    "x.evidence.jsonl",
    5,
    [],
  ];
  for (const evidence of forged) {
    await inTempDir(async dir => {
      await writeSigned(dir, baseReceipt(stamp(3), { evidence }));
      const result = await verifyChain(dir, KEY);
      assert.equal(result.problems.length, 1, JSON.stringify(evidence));
      assert.match(result.problems[0], /evidence reference is malformed/, JSON.stringify(evidence));
    });
  }
});

test("only a plain, non-device evidence name is accepted, by the verifier and by isEvidenceName", async () => {
  const good = [`${fileStamp(stamp(1))}-${REVISION}${EVIDENCE_SUFFIX}`, "x.evidence.jsonl", "con-x.evidence.jsonl", "A1-b2.evidence.jsonl"];
  for (const name of good) assert.equal(isEvidenceName(name), true, name);
  const bad = [
    "con.evidence.jsonl", "CON.evidence.jsonl", "nul.evidence.jsonl", "Aux.evidence.jsonl", "com1.evidence.jsonl", "LPT9.evidence.jsonl",
    "a:b.evidence.jsonl", "r.json:x.evidence.jsonl", "x.y.evidence.jsonl", ".evidence.jsonl", "-x.evidence.jsonl", "a b.evidence.jsonl",
    "a\u0000b.evidence.jsonl", "x.evidence.jsonl ", "x.evidence.jsonl.", "../x.evidence.jsonl", "x/y.evidence.jsonl", "x\\y.evidence.jsonl",
    "x.evidence.json", "x.EVIDENCE.JSONL", "", null, 5,
  ];
  for (const name of bad) assert.equal(isEvidenceName(name), false, JSON.stringify(name));
  for (const name of ["con.evidence.jsonl", "a:b.evidence.jsonl", "x.y.evidence.jsonl"]) {
    await inTempDir(async dir => {
      await writeSigned(dir, baseReceipt(stamp(3), { evidence: { file: name, sha256: "x" } }));
      const result = await verifyChain(dir, KEY);
      assert.match(result.problems[0] ?? "", /evidence reference is malformed/, name);
    });
  }
});

test("an evidence path that is a directory, a link or too large is a problem, never a read", async t => {
  await inTempDir(async dir => {
    const paths = await writeReceipt(baseReceipt(stamp(1)), { evidence: "original\n", key: KEY, dir });
    await chmod(paths.evidencePath, 0o644);
    await rm(paths.evidencePath);
    await mkdir(paths.evidencePath);
    const asDirectory = await verifyChain(dir, KEY);
    assert.equal(asDirectory.problems.length, 1);
    assert.match(asDirectory.problems[0], /is not a plain file/);
  });

  await inTempDir(async dir => {
    const paths = await writeReceipt(baseReceipt(stamp(2)), { evidence: "original\n", key: KEY, dir });
    await chmod(paths.evidencePath, 0o644);
    await rm(paths.evidencePath);
    // A link to a file with exactly the right content: still refused, so verify is no oracle for files elsewhere.
    const outside = join(dir, "outside.txt");
    await writeFile(outside, "original\n");
    try {
      await symlink(outside, paths.evidencePath);
    } catch {
      t.diagnostic("symbolic links cannot be created here; the link case was skipped");
      return;
    }
    const linked = await verifyChain(dir, KEY);
    assert.equal(linked.problems.length, 1);
    assert.match(linked.problems[0], /is not a plain file/);
  });

  await inTempDir(async dir => {
    const paths = await writeReceipt(baseReceipt(stamp(3)), { evidence: "original\n", key: KEY, dir });
    await chmod(paths.evidencePath, 0o644);
    await truncate(paths.evidencePath, MAX_EVIDENCE_BYTES + 1);
    const large = await verifyChain(dir, KEY);
    assert.equal(large.problems.length, 1);
    assert.match(large.problems[0], /is larger than/);
  });

  await inTempDir(async dir => {
    await assert.rejects(
      writeReceipt(baseReceipt(stamp(4)), { evidence: "x".repeat(MAX_EVIDENCE_BYTES + 1), key: KEY, dir }),
      /the evidence is larger than/,
    );
    assert.deepEqual(await readdir(dir), []);
  });
});

test("writeReceipt puts the fields in stored order itself, and refuses fields it does not store", async () => {
  await inTempDir(async dir => {
    const shuffled = Object.fromEntries(Object.entries(baseReceipt(stamp(1))).reverse());
    await writeReceipt(shuffled, { evidence: "E\n", key: KEY, dir });
    assert.deepEqual((await verifyChain(dir, KEY)).problems, []);

    const noEvidenceKey = baseReceipt(stamp(2));
    delete noEvidenceKey.evidence;
    delete noEvidenceKey.screenshot;
    await writeReceipt(noEvidenceKey, { shot: Buffer.from("png"), evidence: "E2\n", key: KEY, dir });
    assert.deepEqual(await verifyChain(dir, KEY), { problems: [], checked: 2, missingEvidence: [] });
  });
  await inTempDir(async dir => {
    const extra = { ...baseReceipt(stamp(3)), surprise: 1 };
    await assert.rejects(writeReceipt(extra, { key: KEY, dir }), /fields the format does not store: surprise/);
    assert.deepEqual(await readdir(dir), []);
  });
});

test("a write that fails after signing rolls back inside the lock and leaves the caller's receipt as it was", async () => {
  await inTempDir(async dir => {
    const receipt = baseReceipt(stamp(1));
    const name = `${fileStamp(receipt.at)}-${REVISION}`;
    await mkdir(join(dir, `${name}.json`)); // the receipt cannot be renamed onto a directory
    await assert.rejects(writeReceipt(receipt, { shot: Buffer.from("png"), evidence: "E\n", key: KEY, dir }), error => {
      assert.equal(error.leftovers, undefined, "the png and the evidence were removed");
      return true;
    });
    for (const field of ["keyId", "prevHash", "hash", "mac"]) assert.equal(field in receipt, false, field);
    assert.equal(receipt.screenshot, null);
    assert.equal(receipt.evidence, null);
    assert.deepEqual((await readdir(dir)).sort(), [`${name}.json`]);
    assert.ok(!(await readdir(dir)).includes(".chain.lock"), "the lock is released");
  });
  await inTempDir(async dir => {
    const receipt = baseReceipt(stamp(2));
    await mkdir(join(dir, `${fileStamp(receipt.at)}-${REVISION}.png`)); // the picture cannot be renamed onto a directory
    // Nothing was created by this call, so nothing is removed: the directory that is in the way stays, and no leftover is reported.
    await assert.rejects(writeReceipt(receipt, { shot: Buffer.from("png"), key: KEY, dir }), error => {
      assert.equal(error.leftovers, undefined);
      return true;
    });
    assert.equal(receipt.screenshot, null);
    assert.deepEqual((await readdir(dir)).sort(), [`${fileStamp(receipt.at)}-${REVISION}.png`]);
  });
});

test("writers in one process queue; a lock left by this process is reclaimed at once", async () => {
  await inTempDir(async dir => {
    const events = [];
    const slow = withChainLock(dir, 5000, async () => {
      events.push("first in");
      await new Promise(resolve => setTimeout(resolve, 200));
      events.push("first out");
    });
    const second = withChainLock(dir, 5000, async () => { events.push("second in"); });
    await Promise.all([slow, second]);
    assert.deepEqual(events, ["first in", "first out", "second in"]);
  });
  await inTempDir(async dir => {
    // The lock file names this very process, but no writer here holds it: its removal must have failed earlier.
    await writeFile(join(dir, LOCK_NAME), JSON.stringify({ pid: process.pid, host: hostname() }));
    const started = Date.now();
    assert.equal(await withChainLock(dir, 5000, async () => "reclaimed"), "reclaimed");
    assert.ok(Date.now() - started < 2000, "no 30 second wait on our own leftover");
  });
  await inTempDir(async dir => {
    const holder = withChainLock(dir, 5000, () => new Promise(resolve => setTimeout(resolve, 400)));
    await assert.rejects(withChainLock(dir, 100, async () => "never"), /locked by another writer/);
    await holder;
    assert.equal(await withChainLock(dir, 1000, async () => "free again"), "free again");
  });
});

test("a refused receipt leaves the files of the earlier run untouched", async () => {
  await inTempDir(async dir => {
    const first = baseReceipt(stamp(5));
    const kept = await writeReceipt(first, { shot: Buffer.from("png-a"), evidence: "A\n", key: KEY, dir });

    const second = baseReceipt(stamp(5)); // same instant and revision: the same file names
    await assert.rejects(
      writeReceipt(second, { shot: Buffer.from("png-b"), evidence: "B\n", key: KEY, dir }),
      /not later than the chain head/,
    );
    assert.equal(await readFile(kept.evidencePath, "utf8"), "A\n");
    assert.equal(await readFile(join(dir, `${fileStamp(first.at)}-${REVISION}.png`), "utf8"), "png-a");
    assert.equal(second.screenshot, null);
    assert.equal(second.evidence, null);
    assert.equal(second.hash, undefined);
    assert.deepEqual((await verifyChain(dir, KEY)).problems, []);
    assert.equal((await readdir(dir)).length, 3);
  });
});

test("a receipt written without evidence, in the older shape, still verifies, alone and mixed with new ones", async () => {
  await inTempDir(async dir => {
    const older = {
      verdict: "PASS", app: "http://x", bug: null, revision: REVISION, at: stamp(7),
      checks: [{ name: "c", pass: true, expected: 1, actual: 1 }], pageErrors: [], screenshot: null, error: null, next: [],
    };
    await writeReceipt(older, { key: KEY, dir });
    const stored = JSON.parse(await readFile(join(dir, `${fileStamp(older.at)}-${REVISION}.json`), "utf8"));
    for (const field of ["spec", "totals", "evidence"]) assert.equal(field in stored, false, field);
    assert.deepEqual((await verifyChain(dir, KEY)).problems, []);

    await writeReceipt(baseReceipt(stamp(8)), { evidence: "E\n", key: KEY, dir });
    assert.deepEqual(await verifyChain(dir, KEY), { problems: [], checked: 2, missingEvidence: [] });
  });
});

test("a signed receipt cannot gain, lose or reorder the new fields without verify noticing", async () => {
  await inTempDir(async dir => {
    const receipt = baseReceipt(stamp(9), {
      verdict: "FAIL",
      totals: { checks: 2, passed: 1, failed: 1, omitted: 0 },
      checks: [{ step: 2, name: "bad", pass: false, expected: "a", actual: "b" }],
    });
    const paths = await writeReceipt(receipt, { evidence: "E\n", key: KEY, dir });
    const original = await readFile(paths.receiptPath, "utf8");
    assert.deepEqual((await verifyChain(dir, KEY)).problems, []);
    await chmod(paths.receiptPath, 0o644);

    const stored = JSON.parse(original);
    const changes = {
      "totals edited": { ...stored, totals: { ...stored.totals, extra: 1 } },
      "failure dropped": { ...stored, checks: [], totals: { checks: 2, passed: 2, failed: 0, omitted: 0 } },
      "verdict changed": { ...stored, verdict: "PASS" },
      "evidence hash swapped": { ...stored, evidence: { ...stored.evidence, sha256: sha256Hex("other") } },
      "evidence removed": Object.fromEntries(Object.entries(stored).filter(([key]) => key !== "evidence")),
    };
    for (const [label, changed] of Object.entries(changes)) {
      await writeFile(paths.receiptPath, JSON.stringify(changed, null, 2));
      const result = await verifyChain(dir, KEY);
      assert.equal(result.problems.length, 1, label);
    }
  });
});
