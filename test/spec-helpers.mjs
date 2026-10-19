import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSpec } from "../src/run-spec.js";

export const KEY = Buffer.alloc(40, 7);
export const TIMEOUT = { timeout: 120000 };

// Runs a spec given as an object, against the built-in app, with receipts in a throwaway directory.
export async function runInline(spec) {
  const specs = await mkdtemp(join(tmpdir(), "proof-spec-src-"));
  const receipts = await mkdtemp(join(tmpdir(), "proof-spec-"));
  try {
    const specPath = join(specs, "inline.json");
    await writeFile(specPath, JSON.stringify(spec));
    return await runSpec({ specPath, key: KEY, receiptsDir: receipts });
  } finally {
    await rm(specs, { recursive: true, force: true });
    await rm(receipts, { recursive: true, force: true });
  }
}

// Like runInline, but hands the receipts directory to the callback before it is removed, so a test can read what was written.
export async function withRun(spec, inspect) {
  const specs = await mkdtemp(join(tmpdir(), "proof-spec-src-"));
  const receipts = await mkdtemp(join(tmpdir(), "proof-spec-"));
  try {
    const specPath = join(specs, "inline.json");
    await writeFile(specPath, JSON.stringify(spec));
    const receipt = await runSpec({ specPath, key: KEY, receiptsDir: receipts });
    return await inspect(receipt, receipts);
  } finally {
    await rm(specs, { recursive: true, force: true });
    await rm(receipts, { recursive: true, force: true });
  }
}

export const failedChecks = receipt => receipt.checks.filter(check => !check.pass);

// What to print when a test expected PASS: the failing checks, with what was read.
export const explain = receipt => JSON.stringify({
  verdict: receipt.verdict,
  error: receipt.error,
  failed: failedChecks(receipt).map(({ name, expected, actual, error }) => ({ name, expected, actual, error })),
}, null, 2);

export const page = (start, steps, extra = {}) => ({ name: `fixture${start.replace(/\W+/g, "-")}`, app: { start }, steps, ...extra });
