// A browser session for the tools that drive an app: a fresh visitor (no storage) in a headless Chromium that does not
// inherit the signing key. run-spec and look both open their page here, so they see the app the same way.
import { chromium } from "playwright";
import { environmentWithoutKey } from "../chain.js";

// A page load is where machine load shows first: with three browser suites at once, a cold Chromium needed more than the
// old 10 s and runs came back ERROR ("page.goto: Timeout 10000ms exceeded"). The load budget is long, the checks' own
// budget (timeoutMs) stays short, and a load that still fails is ERROR (can't tell), never a verdict on the app.
const MIN_NAVIGATION_TIMEOUT_MS = 30000;

// The spec's "env" block as Playwright context options. Only what the schema allows gets here; absent means the browser default.
export function contextOptionsOf(env) {
  if (!env) return {};
  const { viewport, locale, timezoneId, colorScheme, reducedMotion, geolocation, permissions } = env;
  return Object.fromEntries(Object.entries({
    viewport, locale, timezoneId, colorScheme, reducedMotion, permissions,
    geolocation: geolocation === undefined ? undefined : { accuracy: 0, ...geolocation },
  }).filter(([, value]) => value !== undefined));
}

// hooks: onLaunch(browserVersion), onPageError(message), onConsole(level, text), onResponse(response), onRequestFailed(request), all optional.
// Returns { browser, page, adopt(page), browserVersion, close, lost, whenLost, shared }. close() never throws. Navigation to firstUrl is part of opening:
// if it fails the browser is closed again and the error is thrown.
// With `pool` (browser-pool.js, opt-in) the browser is leased from the pool and shared with other runs: close() then closes only
// this run's context and gives the lease back, and the browser string says "shared" so the receipt never claims more isolation
// than the run had. `lost()` tells whether the browser went away under the run (a crash is not a verdict on the app).
export async function openSession({ firstUrl, timeoutMs, env, hooks = {}, pool = null }) {
  const lease = pool ? await pool.lease() : null;
  let browser;
  try {
    browser = lease ? lease.browser : await chromium.launch({ headless: true, env: environmentWithoutKey() });
  } catch (error) {
    lease?.release();
    throw error;
  }
  // Lost = the browser went away while the run still used it. A pooled browser is watched once, by the pool; one of our own here.
  // `whenLost` settles at that moment, so a step stuck polling a dead page is abandoned at once instead of at its own deadline.
  let disconnected = false;
  let closedLost = null; // what lost() said as the run closed: closing the browser ourselves, or a death after the run left, is no loss
  let signalLost;
  const whenLost = new Promise(resolve => { signalLost = resolve; });
  if (lease) lease.whenLost.then(signalLost);
  else browser.on("disconnected", () => { disconnected = true; signalLost(); });
  // A page that crashed (renderer out of memory, killed) leaves calls in flight on it that Playwright can leave pending
  // (microsoft/playwright #31907, #43204 on 1.64.0), so a page crash is a loss of the run too: ERROR, never a verdict on the app.
  let pageCrashed = false;
  // A call can be rejected ("target closed") a moment before the 'disconnected' event arrives, so the connection itself is asked too:
  // a run that closes at that moment must still count as lost, not as an app that failed its checks.
  const gone = () => browser.isConnected?.() === false;
  const lost = () => closedLost ?? (disconnected || pageCrashed || gone() || Boolean(lease?.lost()));
  let context = null;
  const close = async () => {
    closedLost ??= lost();
    if (!lease) return browser.close().catch(() => {});
    await context?.close().catch(() => {});
    lease.release();
  };
  try {
    const browserVersion = `chromium ${browser.version()}${lease ? " (shared browser, own context)" : ""}`;
    hooks.onLaunch?.(browserVersion); // before the first navigation, so a run that fails there still records its browser
    context = await browser.newContext(contextOptionsOf(env));
    // The first page and every popup get the same timeouts and hooks: an error on a second tab is still the app's error.
    // Idempotent: the context's "page" event and an expectation block can both adopt the same popup, and hooks must not double.
    const adopted = new WeakSet();
    const adopt = page => {
      if (adopted.has(page)) return page;
      adopted.add(page);
      page.setDefaultTimeout(timeoutMs);
      page.setDefaultNavigationTimeout(Math.max(timeoutMs, MIN_NAVIGATION_TIMEOUT_MS));
      page.on("crash", () => { pageCrashed = true; signalLost(); });
      page.on("pageerror", error => hooks.onPageError?.(error.message));
      page.on("console", message => hooks.onConsole?.(message.type(), message.text()));
      page.on("response", response => hooks.onResponse?.(response));
      page.on("requestfailed", request => hooks.onRequestFailed?.(request));
      return page;
    };
    // Any tab the app opens, by a plain click or a script, is the app's tab: its errors count, with or without an expect block.
    context.on("page", adopt);
    const page = adopt(await context.newPage());
    await page.goto(firstUrl, { waitUntil: "load" });
    // A shared browser is not handed out: closing or driving it would reach every run on it.
    return { browser: lease ? null : browser, page, adopt, browserVersion, close, lost, whenLost, shared: Boolean(lease) };
  } catch (error) {
    await close();
    throw error;
  }
}
