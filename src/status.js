// status: the question an agent asks before it says "done": do the receipts prove this spec for the code as it is now?
// Exit 0 only for a PASS receipt that is fresh. Every other answer says what to do next (the stop rules).
//   0  PASS and fresh: done, show the receipt
//   1  not proven: FAIL, STOP (same check keeps failing), STALE (code or spec changed since), NO-RECEIPT, UNVERIFIED
//   3  NEEDS-REVIEW: every check passed and is fresh, but the spec lists claims only a human can judge
//   2  cannot tell: the last run was ERROR, the chain does not verify, the spec is invalid: fix the setup, do not guess
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { receiptFiles, signingKeyFromFile, verifyChain } from "./chain.js";
import { createFixtureHandler } from "./fixtures.js";
import { render, revisionOf } from "./server.js";
import { runCli } from "./cli.js";
import { safeLine, scrubReceiptFile } from "./receipt-scrub.js";
import { redactSecrets, scrubValue, specLabel } from "./spec/evidence.js";
import { validateSpec } from "./spec/schema.js";
import { firstLine, isMainModule, parseCli } from "./spec/util.js";

export const DEFAULT_MAX_ATTEMPTS = 3;
const EXIT = { PASS: 0, FAIL: 1, STOP: 1, STALE: 1, UNVERIFIED: 1, "NO-RECEIPT": 1, "NEEDS-REVIEW": 3, ERROR: 2, "CANNOT-TELL": 2 };
const META_REVISION = /<meta\s+name="app-revision"\s+content="([0-9a-f]{12})"/;

export const exitCodeOf = state => EXIT[state];

// "2026-10-19T10:00:00.001000000Z" -> Date. The receipt stamp has nine fractional digits; Date reads three.
const parseStamp = at => new Date(String(at).replace(/(\.\d{3})\d*Z$/, "$1Z"));

// The revision of the app a spec runs against, as it is now. null when it cannot be known.
export async function currentRevision(spec) {
  const start = spec.app?.start ?? "/";
  if (spec.app?.url) {
    try {
      const response = await fetch(new URL(start, spec.app.url).href, { signal: AbortSignal.timeout(5000) });
      return response.headers.get("x-app-revision") ?? META_REVISION.exec(await response.text())?.[1] ?? null;
    } catch {
      return null;
    }
  }
  const path = new URL(start, "http://localhost").pathname;
  if (path === "/") return (await render({ bug: spec.app?.bug })).revision;
  if (path.startsWith("/fixtures/")) return createFixtureHandler({ revisionOf }).revisionFor(path);
  return null;
}

const failedNames = receipt => new Set((receipt.checks ?? []).filter(check => check.pass === false).map(check => check.name));

// The checks that failed in every one of the last `attempts` receipts, when those receipts are all FAIL for the same spec.
function repeatedFailures(receipts, attempts) {
  const recent = receipts.slice(-attempts);
  if (recent.length < attempts || !recent.every(receipt => receipt.verdict === "FAIL" && receipt.spec === recent[0].spec)) return [];
  return [...failedNames(recent[0])].filter(name => recent.every(receipt => failedNames(receipt).has(name)));
}

function answer(state, fields) {
  return { state, ok: state === "PASS", exitCode: EXIT[state], ...fields };
}

export async function statusOf({ dir, key, specPath, maxAttempts = DEFAULT_MAX_ATTEMPTS, maxAgeSeconds, now = new Date() }) {
  let text;
  let spec;
  try {
    text = await readFile(specPath, "utf8");
    spec = JSON.parse(text);
  } catch (error) {
    // A JSON.parse message can quote the file's own bytes, so only the kind of failure is reported.
    const kind = error instanceof SyntaxError ? "parsed as JSON" : `read (${error?.code ?? "error"})`;
    return answer("CANNOT-TELL", { spec: null, advice: [`The spec could not be ${kind}. Fix the path or the file.`] });
  }
  const problems = validateSpec(spec);
  if (problems.length > 0) return answer("CANNOT-TELL", { spec: typeof spec?.name === "string" ? redactSecrets(spec.name) : null, advice: [`The spec is invalid: ${redactSecrets(problems.join("; "))}. Fix the spec first.`] });
  const specHash = createHash("sha256").update(text).digest("hex").slice(0, 12);
  const base = { spec: redactSecrets(spec.name), specHash };

  let verified;
  try {
    verified = await verifyChain(dir, key);
  } catch (error) {
    if (error.code === "ENOENT" || /^no receipts in /.test(error.message)) {
      return answer("NO-RECEIPT", { ...base, advice: ["No receipt exists in the receipts directory. Run the spec, then ask again."] });
    }
    return answer("CANNOT-TELL", { ...base, advice: [`The receipts could not be checked: ${safeLine(error)}. Fix the setup.`] });
  }
  if (verified.problems.length > 0) {
    return answer("CANNOT-TELL", { ...base, problems: verified.problems, advice: ["The receipt chain does not verify, so no receipt can be trusted. Do not say done; hand a human the problems."] });
  }

  const files = await receiptFiles(dir);
  const mine = [];
  for (const file of files) {
    const receipt = JSON.parse(await readFile(file, "utf8"));
    if (typeof receipt.spec === "string" && [spec.name, redactSecrets(spec.name)].includes(receipt.spec.slice(0, receipt.spec.lastIndexOf("@")))) mine.push({ ...receipt, file });
  }
  if (mine.length === 0) return answer("NO-RECEIPT", { ...base, advice: [`No receipt for the spec "${base.spec}" yet. Run it, then ask again.`] });

  const latest = mine.at(-1);
  const failedChecks = (latest.checks ?? []).filter(check => check.pass === false).map(check => ({ step: check.step, name: check.name }));
  const common = {
    ...base, receiptFile: latest.file, verdict: latest.verdict, revision: latest.revision, at: latest.at,
    totals: latest.totals ?? null, failedChecks, attempts: mine.length,
    review: { total: latest.review?.total ?? 0, items: latest.review?.items ?? [] },
  };

  if (latest.verdict === "ERROR") {
    return answer("ERROR", { ...common, advice: ["The last run could not tell. Fix the setup (see the error in the receipt), do not guess, then run again.", ...(latest.error ? [`Error: ${redactSecrets(latest.error)}`] : [])] });
  }
  if (latest.verdict === "FAIL") {
    const repeated = repeatedFailures(mine, maxAttempts);
    if (repeated.length > 0) {
      return answer("STOP", { ...common, repeated, advice: [`The same check keeps failing on ${maxAttempts} runs in a row: ${repeated.join("; ")}. Stop fixing. Hand a human the receipt.`] });
    }
    return answer("FAIL", { ...common, advice: [...(latest.next ?? []), "Fix the code, run the spec again, ask again."] });
  }
  if (latest.verdict !== "PASS") return answer("CANNOT-TELL", { ...common, advice: [`The receipt has an unknown verdict "${latest.verdict}". Do not say done.`] });

  // PASS. It counts only for this spec and this code.
  const reasons = [];
  // The second form is a receipt written before the name was scrubbed.
  if (![specLabel(spec.name, specHash), `${spec.name}@${specHash}`].includes(latest.spec)) reasons.push("the spec changed since this receipt");
  const revisionNow = await currentRevision(spec);
  // The revision comes from the app's own header or page: scrubbed for display, compared raw below.
  common.currentRevision = typeof revisionNow === "string" ? redactSecrets(revisionNow) : revisionNow;
  let unverified = false;
  if (revisionNow !== null && latest.revision !== null) {
    if (revisionNow !== latest.revision) reasons.push(`the app changed: the receipt says PASS for ${latest.revision}, but the source is now ${redactSecrets(revisionNow)}`);
  } else if (maxAgeSeconds === undefined) {
    unverified = true; // the app exposes no revision, so the receipt cannot be tied to the code as it is now
  }
  if (maxAgeSeconds !== undefined) {
    const ageSeconds = (now.getTime() - parseStamp(latest.at).getTime()) / 1000;
    common.ageSeconds = Math.round(ageSeconds);
    if (ageSeconds > maxAgeSeconds) reasons.push(`the receipt is ${Math.round(ageSeconds)} s old, more than the ${maxAgeSeconds} s allowed`);
  }
  if (reasons.length > 0) return answer("STALE", { ...common, advice: [`STALE: ${reasons.join("; ")}. Run the spec again.`] });
  if (unverified) {
    return answer("UNVERIFIED", { ...common, advice: ["PASS, but the app exposes no revision (meta app-revision), so this receipt cannot be tied to the code as it is now. Run the spec again, or pass --max-age <seconds>."] });
  }
  if (common.review.total > 0) {
    return answer("NEEDS-REVIEW", { ...common, advice: [`Every check passed, but ${common.review.total} claim(s) need a human to judge them. Do not say done: hand a human the receipt and the list.`] });
  }
  const advice = ["Done. Show the receipt."];
  if (verified.missingEvidence.length > 0) advice.push(`Note: ${verified.missingEvidence.length} evidence file(s) are missing; the signed summaries still verify.`);
  return answer("PASS", { ...common, advice });
}

// Scrubbed here, so every caller (status, doctor) prints safe text whichever field later holds app-supplied text.
export function scrubStatus(raw) {
  const scrubbed = scrubValue(raw);
  if (typeof raw.receiptFile !== "string") return scrubbed;
  return { ...scrubbed, receiptFile: scrubReceiptFile(raw.receiptFile) };
}

export function formatStatus(raw) {
  const result = scrubStatus(raw);
  const lines = [`${result.state}${result.spec ? ` ${result.spec}` : ""}`];
  if (result.receiptFile) lines.push(`  receipt: ${result.receiptFile}`);
  if (result.revision !== undefined && result.revision !== null) lines.push(`  receipt revision: ${result.revision}${result.currentRevision ? `   current: ${result.currentRevision}` : ""}`);
  if (result.totals) lines.push(`  ${result.totals.checks} checks, ${result.totals.passed} passed, ${result.totals.failed} failed`);
  for (const check of result.failedChecks ?? []) lines.push(`  FAIL step ${check.step}: ${check.name}`);
  for (const item of result.review?.items ?? []) lines.push(`  REVIEW step ${item.step}: ${item.name}${item.note ? ` (${item.note})` : ""}`);
  for (const problem of result.problems ?? []) lines.push(`  problem: ${problem}`);
  for (const line of result.advice ?? []) lines.push(`  -> ${line}`);
  return lines.join("\n");
}

const CLI_OPTIONS = {
  spec: { type: "string" },
  "key-file": { type: "string" },
  receipts: { type: "string" },
  "max-attempts": { type: "string" },
  "max-age": { type: "string" },
  json: { type: "boolean" },
};

// CLI: node src/status.js --spec <file.json> --key-file <path> [--receipts <dir>] [--max-attempts N] [--max-age SECONDS] [--json]
// Returns the exit code.
export async function main(args, { defaultReceipts }) {
  const values = parseCli(args, CLI_OPTIONS);
  if (process.env.PROOF_LAB_KEY !== undefined) throw new Error("PROOF_LAB_KEY is set in the environment; unset it and pass the key with --key-file <path>");
  if (!values["key-file"]) throw new Error("--key-file <path> is required: receipts are checked with the signing key");
  if (!values.spec) throw new Error("--spec <file.json> is required");
  const number = (name, fallback) => {
    const raw = values[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a number greater than 0`);
    return value;
  };
  const result = await statusOf({
    dir: values.receipts ?? defaultReceipts,
    key: await signingKeyFromFile(values["key-file"]),
    specPath: values.spec,
    maxAttempts: Math.floor(number("max-attempts", DEFAULT_MAX_ATTEMPTS)),
    maxAgeSeconds: number("max-age", undefined),
  });
  // Everything printed is scrubbed once more here, whichever field a later change puts text in.
  const shown = scrubStatus(result);
  console.log(values.json ? JSON.stringify(shown, null, 2) : formatStatus(shown));
  return result.exitCode;
}

if (isMainModule(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  await runCli(() => main(process.argv.slice(2), { defaultReceipts: process.env.PROOF_LAB_RECEIPTS ?? join(root, "receipts") }));
}
