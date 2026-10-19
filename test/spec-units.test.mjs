import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCK_NAME, withChainLock } from "../src/chain.js";
import { MAX_LISTED_FAILURES, clipValue, evidenceText, summarize, summarizePageErrors } from "../src/spec/evidence.js";
import { poll } from "../src/spec/poll.js";
import { STEPS } from "../src/spec/steps.js";

test("html5 dragTo releases the mouse button when the drop target is missing", async () => {
  const calls = [];
  const page = {
    locator: selector => ({
      hover: async () => {
        calls.push(`hover ${selector}`);
        if (selector === "#missing") throw new Error("not found");
      },
    }),
    mouse: { down: async () => calls.push("down"), up: async () => calls.push("up") },
  };
  const ctx = { page, timeoutMs: 100, specDir: "." };
  await assert.rejects(
    STEPS.dragTo(ctx, { op: "dragTo", selector: "#a", to: { selector: "#missing" }, html5: true }),
    /not found/,
  );
  assert.deepEqual(calls, ["hover #a", "down", "hover #missing", "up"]);
});

test("poll: one read with timeout 0, retries until pass, a throw is a failed read", async () => {
  let reads = 0;
  const once = await poll(async () => { reads += 1; return { pass: false, actual: reads }; }, 0);
  assert.equal(reads, 1);
  assert.equal(once.pass, false);

  reads = 0;
  const eventually = await poll(async () => { reads += 1; return { pass: reads >= 3, actual: reads }; }, 3000);
  assert.equal(eventually.pass, true);
  assert.equal(reads, 3);

  const thrown = await poll(async () => { throw new Error("boom\nsecond line"); }, 100);
  assert.deepEqual(thrown, { pass: false, actual: null, error: "boom" });
});

test("poll: a wall-clock jump during the wait does not end it early", async () => {
  const realNow = Date.now;
  let calls = 0;
  // The first read of the wall clock is honest; every later one is an hour ahead.
  Date.now = () => realNow() + (++calls > 1 ? 3_600_000 : 0);
  try {
    const started = performance.now();
    const result = await poll(async () => ({ pass: false, actual: 0 }), 200);
    assert.equal(result.pass, false);
    assert.ok(performance.now() - started >= 190, "poll must wait the full budget on the monotonic clock");
  } finally {
    Date.now = realNow;
  }
});

test("a lock that cannot be removed does not turn a finished write into an error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "proof-lock-"));
  try {
    const value = await withChainLock(dir, 1000, async () => {
      const lock = join(dir, LOCK_NAME);
      await rm(lock);
      await mkdir(lock); // removing a directory without recursive fails, as a locked file would on Windows
      return "written";
    });
    assert.equal(value, "written");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("withChainLock still passes on a real error from the work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "proof-lock-"));
  try {
    await assert.rejects(withChainLock(dir, 1000, async () => { throw new Error("work failed"); }), /work failed/);
    // and the lock is gone, so the next writer is not blocked
    assert.equal(await withChainLock(dir, 1000, async () => "next"), "next");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("clipValue cuts long strings and large structures, and leaves small values alone", () => {
  assert.equal(clipValue("short"), "short");
  assert.equal(clipValue(42), 42);
  assert.equal(clipValue(null), null);
  assert.deepEqual(clipValue({ a: 1 }), { a: 1 });
  const long = clipValue("x".repeat(500));
  assert.ok(long.startsWith("x".repeat(200)));
  assert.match(long, /\[300 more characters\]$/);
  const big = clipValue(Array.from({ length: 200 }, (_, i) => i));
  assert.equal(typeof big, "string");
  assert.match(big, /more characters\]$/);
});

test("summarize lists failed checks only, caps the list, and counts the rest", () => {
  const checks = [
    { step: 1, name: "passes", pass: true, expected: "a", actual: "a" },
    ...Array.from({ length: MAX_LISTED_FAILURES + 5 }, (_, i) => ({
      step: i + 2, name: `fails ${i}`, pass: false, expected: "x".repeat(500), actual: "y", hint: "h", error: "e".repeat(500),
    })),
  ];
  const { totals, failures } = summarize(checks);
  assert.deepEqual(totals, { checks: 26, passed: 1, failed: 25, omitted: 5 });
  assert.equal(failures.length, MAX_LISTED_FAILURES);
  assert.ok(failures.every(check => check.pass === false));
  assert.ok(failures[0].expected.length < 300);
  assert.ok(failures[0].error.length < 300);
  assert.equal(failures[0].hint, "h");
  assert.deepEqual(summarize([]).totals, { checks: 0, passed: 0, failed: 0, omitted: 0 });
});

test("summarizePageErrors caps and clips; evidenceText is one JSON record per line", () => {
  const errors = summarizePageErrors(Array.from({ length: 30 }, (_, i) => `error ${i} ${"z".repeat(400)}`));
  assert.equal(errors.length, 10);
  assert.ok(errors[0].length < 300);
  const text = evidenceText([{ type: "a", n: 1 }, { type: "b", s: "line\nbreak" }]);
  const lines = text.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[1]), { type: "b", s: "line\nbreak" });
  assert.ok(text.endsWith("\n"));
});
