// An opt-in pool of shared browsers for a batch of runs (`--share-browser N`). By default every run launches its own Chromium; in
// a pool up to N runs share one, each in its own browser context: its own cookies, storage, cache and pages, but not its own
// process tree. That saves the launch (the bulk of a short run) and about half the memory per run; the price is a shared failure
// domain (a browser that dies takes down every run in it) and a shared GPU and network service. The receipt says so: the browser
// string of a pooled run reads "(shared browser, own context)", so no receipt claims an independent browser it did not have.
import { chromium } from "playwright";
import { environmentWithoutKey } from "../chain.js";

export const MAX_SHARE = 32; // contexts per browser; beyond this a single page-heavy run starves the rest

export const launchBrowser = () => chromium.launch({ headless: true, env: environmentWithoutKey() });

// lease() resolves { browser, release, lost }: `lost()` is true once the browser behind the lease has disconnected (crashed or
// was killed), so a run can tell "the app failed" from "the browser went away". release() gives the place back, once.
// A browser is filled up to `perBrowser` leases before the next is launched (fewest browsers, most sharing); a browser that
// disconnected is dropped and never leased again. close() closes every browser; leases still out then count as lost.
export function createBrowserPool({ perBrowser, launch = launchBrowser } = {}) {
  if (!Number.isInteger(perBrowser) || perBrowser < 1 || perBrowser > MAX_SHARE) throw new Error(`a browser pool shares between 1 and ${MAX_SHARE} runs`);
  const entries = new Set(); // { ready: Promise<Browser>, leases, dead }
  let closed = false;

  const start = () => {
    const entry = { leases: 0, dead: false, browser: null };
    entry.ready = launch().then(browser => {
      entry.browser = browser;
      browser.on("disconnected", () => { entry.dead = true; entries.delete(entry); });
      return browser;
    }, error => { entry.dead = true; entries.delete(entry); throw error; });
    entries.add(entry);
    return entry;
  };

  const lease = async () => {
    if (closed) throw new Error("the browser pool is closed");
    let entry = [...entries].find(candidate => !candidate.dead && candidate.leases < perBrowser);
    entry ??= start();
    entry.leases += 1; // taken before the launch finishes, so concurrent leases fill this browser instead of each launching one
    let given = false;
    const release = () => { if (!given) { given = true; entry.leases -= 1; } };
    try {
      const browser = await entry.ready;
      if (entry.dead) throw new Error("the shared browser stopped before the run could start");
      return { browser, release, lost: () => entry.dead };
    } catch (error) {
      release();
      throw error;
    }
  };

  const close = async () => {
    closed = true;
    const all = [...entries];
    entries.clear();
    await Promise.all(all.map(entry => entry.ready.then(browser => browser.close(), () => {}).catch(() => {})));
  };

  // For diagnostics and tests: how many browsers are alive and how many leases each holds.
  const stats = () => [...entries].map(entry => ({ leases: entry.leases, dead: entry.dead }));
  const browsers = () => [...entries].map(entry => entry.browser).filter(Boolean);
  return { lease, close, stats, browsers, perBrowser };
}
