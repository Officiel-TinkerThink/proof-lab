// doctor: is the setup sound enough for a run to mean something? Run it first.
// Exit 0: every required check is ok. Exit 2: something is wrong with the setup. Fix it, do not guess.
// Freshness of earlier receipts is reported as information; it does not make the setup unsound.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";
import { LOCK_NAME, environmentWithoutKey, keyIdOf, receiptFiles, signingKeyFromFile, verifyChain } from "./chain.js";
import { startApp } from "./server.js";
import { validateSpec } from "./spec/schema.js";
import { firstLine, isMainModule, parseCli } from "./spec/util.js";
import { runCli } from "./cli.js";
import { scrubValue } from "./spec/evidence.js";
import { formatStatus, scrubStatus, statusOf } from "./status.js";

const MIN_NODE_MAJOR = 20;
const BROWSER_TIMEOUT_MS = 30000;

const ok = (name, detail) => ({ name, ok: true, detail });
const bad = (name, detail) => ({ name, ok: false, detail });

async function attempt(name, work) {
  try {
    return await work();
  } catch (error) {
    return bad(name, firstLine(error));
  }
}

const withTimeout = (promise, ms, message) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms).unref()),
]);

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function checkWritable(dir) {
  return attempt("receipts directory is writable", async () => {
    await mkdir(dir, { recursive: true });
    const probe = join(dir, `.doctor-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
    await writeFile(probe, "ok");
    await rm(probe, { force: true });
    return ok("receipts directory is writable", dir);
  });
}

async function checkChain(dir, key) {
  return attempt("receipt chain verifies", async () => {
    const files = await receiptFiles(dir);
    if (files.length === 0) return ok("receipt chain verifies", "no receipts yet");
    if (!key) return bad("receipt chain verifies", "cannot check without a valid key");
    const result = await verifyChain(dir, key);
    if (result.problems.length > 0) return bad("receipt chain verifies", result.problems.join("; "));
    const missing = result.missingEvidence.length;
    return ok("receipt chain verifies", `${result.checked} receipts${missing ? `, ${missing} evidence file(s) pruned` : ""}`);
  });
}

async function checkLock(dir) {
  return attempt("no stuck writer lock", async () => {
    let text;
    try {
      text = await readFile(join(dir, LOCK_NAME), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return ok("no stuck writer lock", "none");
      throw error;
    }
    let owner = null;
    try { owner = JSON.parse(text); } catch { /* an unreadable lock is reported below */ }
    if (!owner || !Number.isInteger(owner.pid)) return bad("no stuck writer lock", `${LOCK_NAME} exists and cannot be read; remove it if no run is in progress`);
    if (owner.host === hostname() && !processAlive(owner.pid)) return ok("no stuck writer lock", `a stale lock from pid ${owner.pid} will be reclaimed by the next run`);
    return ok("no stuck writer lock", `a run is writing (pid ${owner.pid} on ${owner.host}); a second writer waits for it`);
  });
}

async function checkBrowser() {
  return attempt("browser launches", async () => {
    const browser = await withTimeout(chromium.launch({ headless: true, env: environmentWithoutKey() }), BROWSER_TIMEOUT_MS, `Chromium did not start within ${BROWSER_TIMEOUT_MS / 1000} s`);
    try {
      const page = await browser.newPage();
      await page.goto("about:blank");
      return ok("browser launches", `chromium ${browser.version()}`);
    } finally {
      await browser.close().catch(() => {});
    }
  });
}

async function checkSpec(specPath) {
  const name = `spec ${specPath}`;
  let spec;
  try {
    spec = JSON.parse(await readFile(specPath, "utf8"));
  } catch (error) {
    return [bad(name, `cannot be read: ${firstLine(error)}`)];
  }
  const problems = validateSpec(spec);
  if (problems.length > 0) return [bad(name, `invalid: ${problems.join("; ")}`)];
  const results = [ok(name, `valid (${spec.steps.length} steps)`)];
  results.push(await attempt(`app for ${specPath} is reachable`, async () => {
    const start = spec.app?.start ?? "/";
    if (spec.app?.url) {
      const response = await fetch(new URL(start, spec.app.url).href, { signal: AbortSignal.timeout(8000), redirect: "follow" });
      return response.status < 500 ? ok(`app for ${specPath} is reachable`, `${spec.app.url} answered ${response.status}`) : bad(`app for ${specPath} is reachable`, `${spec.app.url} answered ${response.status}`);
    }
    const server = await startApp({ bug: spec.app?.bug });
    try {
      const response = await fetch(new URL(start, server.url).href, { signal: AbortSignal.timeout(5000), redirect: "follow" });
      return response.status === 200 ? ok(`app for ${specPath} is reachable`, "the built-in app answered 200") : bad(`app for ${specPath} is reachable`, `the built-in app answered ${response.status} for ${start}`);
    } finally {
      await server.close().catch(() => {});
    }
  }));
  return results;
}

export async function runDoctor({ dir, keyFile, specPaths = [] }) {
  const checks = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push(major >= MIN_NODE_MAJOR ? ok("node version", process.versions.node) : bad("node version", `${process.versions.node}; ${MIN_NODE_MAJOR} or newer is needed`));
  checks.push(process.env.PROOF_LAB_KEY === undefined
    ? ok("signing key is not in the environment", "PROOF_LAB_KEY is unset")
    : bad("signing key is not in the environment", "PROOF_LAB_KEY is set; unset it and use --key-file (the environment leaks to child processes)"));

  let key = null;
  if (!keyFile) {
    checks.push(bad("signing key file", "--key-file <path> is required"));
  } else {
    const result = await attempt("signing key file", async () => {
      key = await signingKeyFromFile(keyFile);
      return ok("signing key file", `readable, key id ${keyIdOf(key)}`);
    });
    checks.push(result);
  }
  checks.push(await checkWritable(dir));
  checks.push(await checkChain(dir, key));
  checks.push(await checkLock(dir));
  checks.push(await checkBrowser());
  for (const specPath of specPaths) checks.push(...await checkSpec(specPath));

  // Information only: where each spec stands. A stale or failing receipt is history, not a broken setup.
  const statuses = [];
  if (key) {
    for (const specPath of specPaths) statuses.push(await statusOf({ dir, key, specPath }));
  }
  return { ok: checks.every(check => check.ok), checks, statuses };
}

// Everything doctor prints goes through here, text and --json alike: a check's detail names the receipts directory, a spec
// path or the text of a system error, and a status carries the receipt's path. Scrubbing twice changes nothing.
export function scrubDoctor(raw) {
  return { ...scrubValue({ ok: raw.ok, checks: raw.checks }), statuses: raw.statuses.map(scrubStatus) };
}

export function formatDoctor(raw) {
  const result = scrubDoctor(raw);
  const lines = ["doctor"];
  for (const check of result.checks) lines.push(`  ${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`);
  for (const status of result.statuses) lines.push(`  info ${formatStatus(status).split("\n").join("\n       ")}`);
  lines.push(result.ok ? "  The setup is sound." : "  The setup is not sound. Fix the failed checks above, do not guess.");
  return lines.join("\n");
}

const CLI_OPTIONS = {
  "key-file": { type: "string" },
  receipts: { type: "string" },
  spec: { type: "string", multiple: true },
  json: { type: "boolean" },
};

// CLI: doctor --key-file <path> [--receipts <dir>] [--spec <file.json>]... [--json]. Returns the exit code.
export async function main(args, { defaultReceipts }) {
  const values = parseCli(args, CLI_OPTIONS);
  const result = await runDoctor({ dir: values.receipts ?? defaultReceipts, keyFile: values["key-file"], specPaths: values.spec ?? [] });
  console.log(values.json ? JSON.stringify(scrubDoctor(result), null, 2) : formatDoctor(result));
  return result.ok ? 0 : 2;
}

if (isMainModule(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  await runCli(() => main(process.argv.slice(2), { defaultReceipts: process.env.PROOF_LAB_RECEIPTS ?? join(root, "receipts") }));
}
