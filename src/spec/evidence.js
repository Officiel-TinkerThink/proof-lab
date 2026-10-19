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

// Console and page-error text is the app's own and can carry a credential it logged by mistake. Anything shaped like
// one is replaced before the text reaches a receipt or the evidence file; the key name stays, so the line is still useful.
const SECRET_PATTERNS = [
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,}/g, "[redacted jwt]"],
  [/\b(Bearer|Basic)\s+[\w.~+/=-]{8,}/gi, "$1 [redacted]"],
  [/\b([\w-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|session(?:id)?)[\w-]*)(["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic)\s+)?[^\s"'&,;]{3,}/gi, "$1$2[redacted]"],
  [/(\/\/[^/\s:@]+:)[^/\s@]+@/g, "$1[redacted]@"],
  [/\b[A-Fa-f0-9]{32,}\b/g, "[redacted hex]"],
  [/\b[A-Za-z0-9+_-]{40,}={0,2}(?![A-Za-z0-9+_-])/g, "[redacted long value]"],
];
export function redactSecrets(text) {
  return SECRET_PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), String(text));
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

// Claims the spec made that no assertion can settle. total counts them all; items lists the first MAX_LISTED_REVIEWS, clipped.
export const MAX_LISTED_REVIEWS = 20;
export function summarizeReviews(reviews) {
  const items = reviews.slice(0, MAX_LISTED_REVIEWS).map(({ step, name, note }) => ({
    step, name: clipValue(name), ...(note === undefined ? {} : { note: clipValue(note, HINT_CHARS) }),
  }));
  return { total: reviews.length, items };
}

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
