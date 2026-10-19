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
// Names that mark a value as a credential. The long ones match inside a longer key (db_password, x-auth-token); the
// short ones only as the whole key, so "author" and "bypass" are left alone.
const KEY = String.raw`(?:\b[\w-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|credentials?|cookie|session(?:id)?)[\w-]*|\b(?:pass|auth|sid)\b)`;
// The separator can be escaped or url-encoded: password=, "password": , \"password\":, password%3D.
const KEY_END = String.raw`\\?["']?\s*`;
const BASE64 = "A-Za-z0-9+/_-";
// "Basic validation" is prose; "Basic dXNlcjpwYXNz" is not: a scheme value needs a digit, + / = or at least 20 characters.
const SCHEME_VALUE = String.raw`(?:(?=[\w.~+/=-]*[\d+/=])[\w.~+/=-]{8,}|[\w.~+/=-]{20,})`;
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted private key]"],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,}/g, "[redacted jwt]"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted access key]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{22,}|xox[abprs]-[\w-]{10,})/g, "[redacted token]"],
  [new RegExp(String.raw`\b(Bearer|Basic|Digest|OAuth|Token|ApiKey)\s+${SCHEME_VALUE}`, "gi"), "$1 [redacted]"],
  // "key: value" with an unquoted value takes the rest of the line: a passphrase or "ApiKey 123" has spaces in it.
  [new RegExp(String.raw`(${KEY})(${KEY_END}(?::|%3[Aa])\s*)[^\s\\"'][^\r\n"']*`, "gi"), "$1$2[redacted]"],
  // A quoted value of any length keeps its quotes; "key=value" runs up to the next space.
  [new RegExp(String.raw`(${KEY})(${KEY_END}(?:[:=]|%3[AaDd])\s*\\?["'])[^"']*`, "gi"), "$1$2[redacted]"],
  [new RegExp(String.raw`(${KEY})(${KEY_END}(?:[:=]|%3[AaDd])\s*)[^\s"'&,;\\]+`, "gi"), "$1$2[redacted]"],
  [/(\/\/[^/\s:@]+:)\S+@/g, "$1[redacted]@"],
  [/\b[A-Fa-f0-9]{32,}\b/g, "[redacted hex]"],
  [/\b[A-Za-z0-9+_-]{40,}={0,2}(?![A-Za-z0-9+_-])/g, "[redacted long value]"],
  // Base64 with "/" also looks like a path: it counts as a value only when it mixes digits and both letter cases.
  [new RegExp(`(?<![${BASE64}])(?=[${BASE64}]*\\d)(?=[${BASE64}]*[a-z])(?=[${BASE64}]*[A-Z])[${BASE64}]{40,}={0,2}`, "g"), "[redacted long value]"],
];
// Text of any length is accepted (a download, a console line); the part past this is dropped, which keeps every pattern
// linear in practice. Every caller clips the result to far less.
const MAX_REDACT_CHARS = 10_000;
export function redactSecrets(text) {
  const input = String(text).slice(0, MAX_REDACT_CHARS);
  return SECRET_PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), input);
}

// redactSecrets over every string inside a value (a check's expected and actual can be text or a small object).
export function scrubValue(value, depth = 0) {
  if (typeof value === "string") return redactSecrets(value);
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(item => scrubValue(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubValue(item, depth + 1)]));
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
