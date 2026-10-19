// A browser session for the tools that drive an app: a fresh visitor (no storage) in a headless Chromium that does not
// inherit the signing key. run-spec and look both open their page here, so they see the app the same way.
import { chromium } from "playwright";
import { environmentWithoutKey } from "../chain.js";

const MIN_NAVIGATION_TIMEOUT_MS = 10000;

// hooks: onPageError(message), onConsole(level, text), onResponse(response), onRequestFailed(request), all optional.
// Returns { browser, page, browserVersion, close }. close() never throws. Navigation to firstUrl is part of opening:
// if it fails the browser is closed again and the error is thrown.
export async function openSession({ firstUrl, timeoutMs, hooks = {} }) {
  const browser = await chromium.launch({ headless: true, env: environmentWithoutKey() });
  const close = () => browser.close().catch(() => {});
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(Math.max(timeoutMs, MIN_NAVIGATION_TIMEOUT_MS));
    page.on("pageerror", error => hooks.onPageError?.(error.message));
    page.on("console", message => hooks.onConsole?.(message.type(), message.text()));
    page.on("response", response => hooks.onResponse?.(response));
    page.on("requestfailed", request => hooks.onRequestFailed?.(request));
    await page.goto(firstUrl, { waitUntil: "load" });
    return { browser, page, browserVersion: `chromium ${browser.version()}`, close };
  } catch (error) {
    await close();
    throw error;
  }
}
