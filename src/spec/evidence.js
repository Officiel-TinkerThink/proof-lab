// A receipt is a summary: verdict, totals and the checks that failed. Everything else a reader might want to
// investigate (every check, the step timeline, console output) goes to an evidence file kept next to the receipt.
// The receipt carries the evidence file's hash, so the details cannot be swapped without the signature failing.

// The file name suffix is EVIDENCE_SUFFIX in chain.js, which writes and verifies the file.
export const MAX_LISTED_FAILURES = 20;
export const MAX_PAGE_ERRORS = 10;
const CLIP_CHARS = 200;
const HINT_CHARS = 300;

function clipText(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}... [${text.length - limit} more characters]` : text;
}

// Long strings and large structures are cut in the receipt; the full value stays in the evidence file.
export function clipValue(value, limit = CLIP_CHARS) {
  if (typeof value === "string") return clipText(value, limit);
  if (value === null || typeof value !== "object") return value;
  const text = JSON.stringify(value);
  return text.length > limit ? clipText(text, limit) : value;
}

const summaryOfCheck = check => ({
  ...check,
  expected: clipValue(check.expected),
  actual: clipValue(check.actual),
  ...(check.error === undefined ? {} : { error: clipValue(check.error) }),
  ...(check.hint === undefined ? {} : { hint: clipValue(check.hint, HINT_CHARS) }),
});

// totals counts every check; failures lists the failed ones (up to MAX_LISTED_FAILURES, clipped).
export function summarize(checks) {
  const failed = checks.filter(check => !check.pass);
  const failures = failed.slice(0, MAX_LISTED_FAILURES).map(summaryOfCheck);
  return {
    totals: { checks: checks.length, passed: checks.length - failed.length, failed: failed.length, omitted: failed.length - failures.length },
    failures,
  };
}

export function summarizePageErrors(pageErrors) {
  return pageErrors.slice(0, MAX_PAGE_ERRORS).map(message => clipValue(message));
}

// JSON Lines: one record per line, each with a "type", so an agent can grep or read it a section at a time.
export function evidenceText(records) {
  return `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
}
