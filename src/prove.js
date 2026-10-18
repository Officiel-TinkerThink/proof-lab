// prove: drive the waitlist app as a fresh visitor, record checks, write a receipt.
// Verdicts: PASS (exit 0), FAIL (exit 1), ERROR = can't tell (exit 2).
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startApp } from "./server.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RECEIPTS = join(ROOT, "receipts");
const EMAIL = "ada@example.test";
const KEY = "waitlist-record";
const TIMEOUT_MS = 3000;

const sha256 = text => createHash("sha256").update(text).digest("hex");
const firstLine = error => (error instanceof Error ? error.message : String(error)).split("\n")[0];

async function latestHash() {
  await mkdir(RECEIPTS, { recursive: true });
  const names = (await readdir(RECEIPTS)).filter(name => name.endsWith(".json")).sort();
  if (!names.length) return "GENESIS";
  const last = JSON.parse(await readFile(join(RECEIPTS, names.at(-1)), "utf8"));
  return last.hash;
}

async function serverRevision(url) {
  const response = await fetch(new URL("/__revision", url), { signal: AbortSignal.timeout(2000) });
  return (await response.json()).revision;
}

async function pageRevision(page) {
  return page.locator('meta[name="app-revision"]').getAttribute("content", { timeout: 1000 }).catch(() => null);
}

export async function prove({ url, bug } = {}) {
  let server = null;
  const receipt = {
    verdict: "ERROR",
    app: url ?? null,
    bug: bug ?? null,
    revision: null,
    at: new Date().toISOString(),
    checks: [],
    pageErrors: [],
    screenshot: null,
    error: null,
    next: [],
  };
  const pageErrors = new Set();
  let browser = null;

  try {
    if (!url) {
      server = await startApp({ bug });
      receipt.app = server.url;
    }
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext(); // fresh visitor: no storage
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);
    page.on("pageerror", error => pageErrors.add(error.message));
    page.on("console", message => { if (message.type() === "error") pageErrors.add(message.text()); });

    await page.goto(receipt.app, { waitUntil: "load" });
    const loadedRevision = await pageRevision(page);
    receipt.revision = loadedRevision;

    const check = (name, actual, expected, hint) => {
      const pass = JSON.stringify(actual) === JSON.stringify(expected);
      receipt.checks.push({ name, pass, expected, actual, ...(hint && !pass ? { hint } : {}) });
    };
    const text = async selector => (await page.locator(selector).count()) ? (await page.locator(selector).first().innerText()).trim() : null;

    check("fresh visitor sees no request", await text('[data-testid="status"]'), "none");

    await page.getByLabel("Email", { exact: true }).fill(EMAIL);
    await page.getByRole("button", { name: "Join waitlist", exact: true }).click();
    await page.getByTestId("status").filter({ hasText: "waitlisted" }).waitFor().catch(() => {});

    check("status shows waitlisted after join", await text('[data-testid="status"]'), "waitlisted",
      "The form did not move to waitlisted. Check the submit handler and the status element.");
    const confirmationBefore = await text('[role="status"]');
    check("confirmation shows after join", Boolean(confirmationBefore && confirmationBefore.includes("waitlist")), true,
      "No confirmation after submit. Show the waitlist confirmation when a record exists.");

    await page.reload({ waitUntil: "load" });

    check("status survives reload", await text('[data-testid="status"]'), "waitlisted",
      "The record vanished on reload. Persist it to localStorage under the key " + KEY + ".");
    check("email survives reload", await text('[data-testid="email"]'), EMAIL,
      "The saved email is not the one typed. Persist the address the visitor entered.");
    const confirmationAfter = await text('[role="status"]');
    check("confirmation survives reload", Boolean(confirmationAfter && confirmationAfter.includes("waitlist")), true,
      "The confirmation is missing after reload. Show the waitlist confirmation when a saved record exists.");

    const stored = await page.evaluate(key => localStorage.getItem(key), KEY);
    let storedEmail = null;
    try { storedEmail = JSON.parse(stored)?.email ?? null; } catch { storedEmail = null; }
    check("record is in localStorage", storedEmail, EMAIL,
      "localStorage holds no record with the visitor's email. What the page shows is not what was saved.");

    const afterRevision = await pageRevision(page);
    const now = await serverRevision(receipt.app);
    if (afterRevision !== loadedRevision || now !== loadedRevision) {
      receipt.error = `The app changed while proving (loaded ${loadedRevision}, now ${now}). Evidence from two builds proves neither.`;
    } else if (receipt.checks.length === 0) {
      receipt.error = "No checks were recorded.";
    } else {
      receipt.verdict = receipt.checks.every(entry => entry.pass) ? "PASS" : "FAIL";
    }

    await mkdir(RECEIPTS, { recursive: true });
    const shot = join(RECEIPTS, `${receipt.at.replace(/[:.]/g, "-")}-${loadedRevision ?? "unknown"}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    receipt.screenshot = shot;
  } catch (error) {
    receipt.verdict = "ERROR";
    receipt.error = `prove failed: ${firstLine(error)}`;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await server.close().catch(() => {});
  }

  receipt.pageErrors = [...pageErrors];
  if (receipt.verdict === "PASS") {
    receipt.next = ["These checks passed on this revision. They cover nothing else: read the screenshot for anything they missed."];
  } else if (receipt.verdict === "FAIL") {
    receipt.next = receipt.checks.filter(entry => !entry.pass).map(entry =>
      entry.hint ?? `Fix "${entry.name}": expected ${JSON.stringify(entry.expected)}, got ${JSON.stringify(entry.actual)}.`);
  } else {
    receipt.next = [receipt.error ?? "Unknown error.", "Can't tell is not the same as broken: run it again once the app is stable."];
  }

  // Tamper evidence: each receipt commits to the one before it.
  receipt.prevHash = await latestHash();
  const { hash: _unused, ...body } = receipt;
  receipt.hash = sha256(JSON.stringify(body));
  await writeFile(join(RECEIPTS, `${receipt.at.replace(/[:.]/g, "-")}-${receipt.revision ?? "unknown"}.json`), JSON.stringify(receipt, null, 2));
  return receipt;
}

// CLI: node src/prove.js [--url <http://...>] [--bug <name>]
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const receipt = await prove({ url: flag("--url"), bug: flag("--bug") });
  console.log(JSON.stringify(receipt, null, 2));
  process.exitCode = receipt.verdict === "PASS" ? 0 : receipt.verdict === "FAIL" ? 1 : 2;
}
