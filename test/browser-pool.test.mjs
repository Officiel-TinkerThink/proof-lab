// The opt-in shared-browser pool (`--share-browser N`): the bookkeeping with fake browsers, then real Chromium for what a shared
// browser must still guarantee (a receipt that says so, contexts that do not leak into each other, a crash that is ERROR).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBrowserPool, MAX_SHARE } from "../src/spec/browser-pool.js";
import { openSession } from "../src/spec/session.js";
import { parseShareBrowser, runSpec, runSpecs } from "../src/run-spec.js";
import { createGovernor } from "../src/capacity.js";
import { KEY, TIMEOUT } from "./spec-helpers.mjs";

const WAITLIST = fileURLToPath(new URL("../specs/waitlist.json", import.meta.url));

function fakeBrowsers() {
  const launched = [];
  const launch = async () => {
    const browser = Object.assign(new EventEmitter(), { id: launched.length, closed: false, close: async () => { browser.closed = true; browser.emit("disconnected"); } });
    launched.push(browser);
    await new Promise(resolve => setImmediate(resolve));
    return browser;
  };
  return { launched, launch };
}

test("pool: a browser is filled up to `perBrowser` leases before the next is launched, also for leases asked for at once", async () => {
  const { launched, launch } = fakeBrowsers();
  const pool = createBrowserPool({ perBrowser: 2, launch });
  const leases = await Promise.all([pool.lease(), pool.lease(), pool.lease(), pool.lease(), pool.lease()]);
  assert.equal(launched.length, 3, "5 leases at 2 per browser need 3 browsers, not one launch per lease");
  assert.deepEqual(leases.map(lease => lease.browser.id), [0, 0, 1, 1, 2]);
  assert.deepEqual(pool.stats().map(entry => entry.leases), [2, 2, 1]);
  leases[0].release();
  leases[0].release(); // once only
  assert.deepEqual(pool.stats().map(entry => entry.leases), [1, 2, 1]);
  assert.equal((await pool.lease()).browser.id, 0, "a freed place is used before a new browser is launched");
  await pool.close();
  assert.ok(launched.every(browser => browser.closed));
});

test("pool: a browser that disconnected is never leased again, and the runs on it are told it was lost", async () => {
  const { launched, launch } = fakeBrowsers();
  const pool = createBrowserPool({ perBrowser: 4, launch });
  const first = await pool.lease();
  assert.equal(first.lost(), false);
  launched[0].emit("disconnected");
  assert.equal(first.lost(), true);
  const next = await pool.lease();
  assert.equal(next.browser.id, 1, "a dead browser is not handed out");
  assert.equal(next.lost(), false);
  first.release();
  await pool.close();
});

test("pool: a launch that fails reaches the caller, leaves no place taken, and the next lease tries again", async () => {
  let attempt = 0;
  const { launch } = fakeBrowsers();
  const pool = createBrowserPool({ perBrowser: 2, launch: async () => { attempt += 1; if (attempt === 1) throw new Error("no chromium"); return launch(); } });
  await assert.rejects(pool.lease(), /no chromium/);
  assert.deepEqual(pool.stats(), []);
  assert.equal((await pool.lease()).browser.id, 0);
  await pool.close();
});

test("pool: closed means no more leases; limits are checked", async () => {
  const pool = createBrowserPool({ perBrowser: 2, launch: fakeBrowsers().launch });
  await pool.close();
  await assert.rejects(pool.lease(), /closed/);
  for (const bad of [0, -1, 1.5, MAX_SHARE + 1, undefined]) assert.throws(() => createBrowserPool({ perBrowser: bad }), /between 1 and/);
});

test("--share-browser: a whole number from 1 to the limit; 1 or absent is one browser per run", () => {
  assert.equal(parseShareBrowser(undefined), 1);
  assert.equal(parseShareBrowser("1"), 1);
  assert.equal(parseShareBrowser("8"), 8);
  for (const bad of ["0", "-2", "2.5", "many", "", String(MAX_SHARE + 1)]) assert.throws(() => parseShareBrowser(bad), /--share-browser takes a whole number/);
});

async function receiptsOf(t) {
  const dir = await mkdtemp(join(tmpdir(), "proof-pool-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const evidenceBrowser = async receipt => JSON.parse((await readFile(receipt.detail.evidencePath, "utf8")).split("\n")[0]).browser;

test("shared browser: runs pass, share one Chromium, and the evidence says the browser was shared; the default says nothing of the kind", TIMEOUT, async t => {
  const receiptsDir = await receiptsOf(t);
  const shared = await runSpecs([WAITLIST, WAITLIST, WAITLIST], { key: KEY, receiptsDir, jobs: 3, shareBrowser: 3, governor: createGovernor() });
  assert.deepEqual(shared.map(receipt => receipt.verdict), ["PASS", "PASS", "PASS"]);
  for (const receipt of shared) assert.match(await evidenceBrowser(receipt), /^chromium \S+ \(shared browser, own context\)$/);
  const alone = await runSpecs([WAITLIST, WAITLIST], { key: KEY, receiptsDir, jobs: 2, governor: createGovernor() });
  assert.deepEqual(alone.map(receipt => receipt.verdict), ["PASS", "PASS"]);
  for (const receipt of alone) assert.match(await evidenceBrowser(receipt), /^chromium \S+$/);
});

test("shared browser: two contexts of one browser do not see each other's cookies or storage", TIMEOUT, async () => {
  const pool = createBrowserPool({ perBrowser: 2 });
  const a = await openSession({ firstUrl: "about:blank", timeoutMs: 5000, pool });
  const b = await openSession({ firstUrl: "about:blank", timeoutMs: 5000, pool });
  try {
    assert.equal(a.browser, b.browser, "one browser");
    await a.page.context().addCookies([{ name: "c", value: "from-a", url: "https://example.test/" }]);
    assert.equal((await b.page.context().cookies("https://example.test/")).length, 0);
    assert.equal((await a.page.context().cookies("https://example.test/")).length, 1);
  } finally {
    await a.close();
    await b.close();
    await pool.close();
  }
});

test("shared browser: closing one run leaves the others working; a browser that dies makes every run on it ERROR, never FAIL or PASS", TIMEOUT, async t => {
  const receiptsDir = await receiptsOf(t);
  const pool = createBrowserPool({ perBrowser: 2 });
  try {
    const survivors = await Promise.all([openSession({ firstUrl: "about:blank", timeoutMs: 5000, pool }), openSession({ firstUrl: "about:blank", timeoutMs: 5000, pool })]);
    await survivors[0].close();
    assert.equal(survivors[1].lost(), false);
    assert.equal(await survivors[1].page.evaluate(() => 1 + 1), 2, "the other run's context is untouched");
    await survivors[1].close();

    const runs = [runSpec({ specPath: WAITLIST, key: KEY, receiptsDir, pool }), runSpec({ specPath: WAITLIST, key: KEY, receiptsDir, pool })];
    for (let i = 0; i < 100 && pool.browsers().length === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 20));
    await new Promise(resolve => setTimeout(resolve, 250));
    await pool.browsers()[0].close(); // the process goes away under both runs
    const results = await Promise.all(runs);
    assert.deepEqual(results.map(receipt => receipt.verdict), ["ERROR", "ERROR"]);
    assert.ok(results.every(receipt => /browser stopped|closed|aborted/i.test(receipt.error)), results.map(receipt => receipt.error).join(" | "));
  } finally {
    await pool.close();
  }
});

test("default (one browser per run): closing our own browser at the end of a run is not a lost browser", TIMEOUT, async t => {
  const receiptsDir = await receiptsOf(t);
  const receipt = await runSpec({ specPath: WAITLIST, key: KEY, receiptsDir });
  assert.equal(receipt.verdict, "PASS", receipt.error ?? "");
});
