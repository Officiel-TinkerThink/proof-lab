// prove: drive the waitlist app as a fresh visitor, record checks, write a signed receipt.
// Verdicts: PASS (exit 0), FAIL (exit 1), ERROR = can't tell (exit 2).
// Key: every run and every verify takes --key-file <path> (a 0600 file). PROOF_LAB_KEY in the environment is refused.
// Verify: node src/prove.js --verify --key-file <path> [--receipts <dir>] [--expect-head <hash>]  (0 intact, 1 tampered, 2 cannot verify)
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { scrubReceipt, writeScrubbedReceipt } from "./receipt-scrub.js";
import { startApp } from "./server.js";
import {
  GENESIS,
  KEY_ENV,
  environmentWithoutKey,
  fixedStamp,
  latestHash,
  signingKey,
  signingKeyFromFile,
  verifyChain,
} from "./chain.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_RECEIPTS = process.env.PROOF_LAB_RECEIPTS ?? join(ROOT, "receipts");
const EMAIL = "ada@example.test";
const KEY = "waitlist-record";
const TIMEOUT_MS = 3000;
// A page load is where machine load shows first (a cold browser on a busy host took more than 3 s and the run came back
// ERROR: "page.goto: Timeout 3000ms exceeded"). Navigation gets its own, longer budget; checks keep the short one.
const NAVIGATION_TIMEOUT_MS = 20000;

const firstLine = error => (error instanceof Error ? error.message : String(error)).split("\n")[0];

async function serverRevision(url) {
  const response = await fetch(new URL("/__revision", url), { signal: AbortSignal.timeout(2000) });
  return (await response.json()).revision;
}

async function pageRevision(page) {
  return page.locator('meta[name="app-revision"]').getAttribute("content", { timeout: 1000 }).catch(() => null);
}

export async function prove({ url, bug, receiptsDir = DEFAULT_RECEIPTS, key = signingKey() } = {}) {
  let server = null;
  const receipt = {
    verdict: "ERROR",
    app: url ?? null,
    bug: bug ?? null,
    revision: null,
    at: fixedStamp(),
    checks: [],
    pageErrors: [],
    screenshot: null,
    error: null,
    next: [],
  };
  const pageErrors = new Set();
  let browser = null;
  let shot = null;

  try {
    if (!url) {
      server = await startApp({ bug });
      receipt.app = server.url;
    }
    browser = await chromium.launch({ headless: true, env: environmentWithoutKey() });
    const context = await browser.newContext(); // fresh visitor: no storage
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
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

    shot = await page.screenshot({ fullPage: true });
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

  // The same two calls as `run` (see receipt-scrub.js): scrub the receipt, then write it. A receipt that cannot be written
  // is not evidence: ERROR, never a silent PASS.
  scrubReceipt(receipt);
  await writeScrubbedReceipt(receipt, { shot, key, dir: receiptsDir },
    "No receipt file was written, so this run is not evidence. Fix the receipts directory and run again.");
  return receipt;
}

// verifyReceipts returns the exit code: 0 intact, 1 tampered, unsigned or not the expected head, 2 cannot verify.
export async function verifyReceipts({ receiptsDir = DEFAULT_RECEIPTS, key, expectHead = "" } = {}) {
  let result;
  try {
    result = await verifyChain(receiptsDir, key);
  } catch (error) {
    console.error(`cannot verify: ${firstLine(error)}`);
    return 2;
  }
  const problems = [...result.problems];
  let head = null;
  try {
    head = await latestHash(receiptsDir);
  } catch (error) {
    problems.push(`head: ${firstLine(error)}`);
  }
  if (expectHead && head !== expectHead) {
    problems.push("head does not match --expect-head: receipts were added or removed since that head was recorded");
  }
  problems.forEach(problem => console.log(problem));
  if (problems.length > 0) {
    console.log(`INVALID: ${problems.length} problem(s), ${result.checked} receipts checked`);
    return 1;
  }
  console.log(`VALID: ${result.checked} receipts, hash chain and signatures intact\nhead: ${head ?? GENESIS}`);
  return 0;
}

// CLI: node src/prove.js --key-file <path> [--url <http://...>] [--bug <name>] [--receipts <dir>] | --verify [--expect-head <hash>]
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  let key;
  try {
    // The key comes only from --key-file. A key variable in the environment stays readable through /proc/<pid>/environ
    // and by child processes, even after the variable is deleted, so the run refuses to start while it is set.
    if (Object.hasOwn(process.env, KEY_ENV)) {
      throw new Error(`${KEY_ENV} is set in the environment; unset it and pass the key with --key-file <path>`);
    }
    if (!flag("--key-file")) {
      throw new Error("--key-file <path> is required: the signing key is read from a 0600 file, never from the environment");
    }
    key = await signingKeyFromFile(flag("--key-file"));
  } catch (error) {
    console.error(firstLine(error));
    process.exitCode = 2;
  }
  if (key) {
    if (args.includes("--verify")) {
      process.exitCode = await verifyReceipts({ receiptsDir: flag("--receipts") ?? DEFAULT_RECEIPTS, key, expectHead: flag("--expect-head") });
    } else {
      const receipt = await prove({ url: flag("--url"), bug: flag("--bug"), receiptsDir: flag("--receipts") ?? DEFAULT_RECEIPTS, key });
      console.log(JSON.stringify(receipt, null, 2));
      process.exitCode = receipt.verdict === "PASS" ? 0 : receipt.verdict === "FAIL" ? 1 : 2;
    }
  }
}
