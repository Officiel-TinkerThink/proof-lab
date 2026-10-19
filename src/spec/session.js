// A browser session for the tools that drive an app: a fresh visitor (no storage) in a headless Chromium that does not
// inherit the signing key. run-spec and look both open their page here, so they see the app the same way.
import { chromium } from "playwright";
import { environmentWithoutKey } from "../chain.js";

const MIN_NAVIGATION_TIMEOUT_MS = 10000;

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
// Returns { browser, page, adopt(page), browserVersion, close }. close() never throws. Navigation to firstUrl is part of opening:
// if it fails the browser is closed again and the error is thrown.
export async function openSession({ firstUrl, timeoutMs, env, hooks = {} }) {
  const browser = await chromium.launch({ headless: true, env: environmentWithoutKey() });
  const close = () => browser.close().catch(() => {});
  const browserVersion = `chromium ${browser.version()}`;
  hooks.onLaunch?.(browserVersion); // before the first navigation, so a run that fails there still records its browser
  try {
    const context = await browser.newContext(contextOptionsOf(env));
    // The first page and every popup get the same timeouts and hooks: an error on a second tab is still the app's error.
    // Idempotent: the context's "page" event and an expectation block can both adopt the same popup, and hooks must not double.
    const adopted = new WeakSet();
    const adopt = page => {
      if (adopted.has(page)) return page;
      adopted.add(page);
      page.setDefaultTimeout(timeoutMs);
      page.setDefaultNavigationTimeout(Math.max(timeoutMs, MIN_NAVIGATION_TIMEOUT_MS));
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
    return { browser, page, adopt, browserVersion, close };
  } catch (error) {
    await close();
    throw error;
  }
}
