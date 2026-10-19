// A receipt is a summary: verdict, totals and the checks that failed. Everything else a reader might want to
// investigate (every check, the step timeline, console output) goes to an evidence file kept next to the receipt.
// The receipt carries the evidence file's hash, so the details cannot be swapped without the signature failing.
import { createHmac, randomBytes } from "node:crypto";

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
// Names that mark a value as a credential. The long ones match inside a longer key (db_password, x-auth-token): the part
// before the name needs no match, and the part after is bounded, so no input makes the match cost more than linear time.
// The short ones only as the whole key, so "author" and "bypass" are left alone.
const KEY = String.raw`(?:(?:password|passwd|passphrase|passcode|pwd|secret|token|api[ _-]?key|access[ _-]?key|private[ _-]?key|authorization|credentials?|cookie|session(?:[ _-]?id)?)[\w.-]{0,200}|(?:(?<![A-Za-z])(?:pass|auth|sid|pw|otp|pin)(?![A-Za-z])|(?-i:(?<=[a-z0-9])(?:Pass|Auth|Sid|Pw|Otp|Pin)(?![a-z])|(?<![A-Za-z])(?:pass|auth|sid|pw|otp|pin)(?=[A-Z])))[\w.-]{0,200})`;
// (the last two alternatives read camelCase: "dbPass", "authHeader"; "bypass" and "Passage" stay)
// The separator can be escaped or url-encoded: password=, "password": , \"password\":, password%3D.
// Blanks stop at a line break: a key at the end of a line ("Cookies":) must not take the next line as its value.
const SP = String.raw`[^\S\r\n]*`;
const KEY_END = String.raw`\\?["']?${SP}`;
const BASE64 = "A-Za-z0-9+/_-";
// "Basic validation" is prose; "Basic dXNlcjpwYXNz" is not: a scheme value needs a digit, + / = or at least 20 characters.
const SCHEME_VALUE = String.raw`(?:(?=[\w.~+/=-]*[\d+/=])[\w.~+/=-]{8,}|[\w.~+/=-]{20,})`;
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted private key]"],
  // A JWT with no signature is still a JWT. It may follow a hyphen ("auth-eyJ..."), not a letter, digit or underscore; each
  // part is bounded, so a long run of "eyJ" starts costs at most a bounded scan each.
  // Only the header is bounded: a payload or signature is a run with no dot, so a second start cannot sit inside it.
  [/(?<![A-Za-z0-9_])eyJ[\w-]{8,1000}\.[\w-]{8,}(?:\.[\w-]*)?/g, "[redacted jwt]"],
  // A password in a URL's userinfo goes first: it may itself contain a "?" or "#" that the address rules below would cut at.
  // Bounded, so many "//x:" starts in one long run cost a bounded scan each. Not "host:4173/@name": a port is not a password.
  [/(\/\/[^/\s:@]*:)(?!\d+(?:[/?#\s]|$))\S{1,2000}@/g, "$1[redacted]@"],
  // A query or fragment in an address inside free text (an error that quotes the URL it failed on) is hidden like a
  // recorded address; a query after a "#/route" counts too. The part before it is bounded for the same reason.
  [/(\bhttps?:\/\/[^\s?"'<>]{0,4000})\?(?!\[query hidden\])[^\s"'<>]*/gi, "$1?[query hidden]"],
  [/(\bhttps?:\/\/[^\s#"'<>]{0,4000})#(?!\[hash hidden\])(?:\[query hidden\]|[^\s"'<>])*/gi, "$1#[hash hidden]"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted access key]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{22,}|xox[abprs]-[\w-]{10,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{20,}|AIza[\w-]{35})/g, "[redacted token]"],
  [new RegExp(String.raw`\b(Bearer|Basic|Digest|OAuth|Token|ApiKey)\s+${SCHEME_VALUE}`, "gi"), "$1 [redacted]"],
  // "key: value" with an unquoted value takes the rest of the line: a passphrase or "ApiKey 123" has spaces in it.
  [new RegExp(String.raw`(${KEY})(${KEY_END}(?::|%3[Aa])${SP})[^\s\\"'][^\r\n]*`, "gi"), "$1$2[redacted]"],
  // A key at the end of a line with its value indented on the next line (YAML style). A quoted key ("Cookies":) and a list
  // item below it ("- button ...", an aria tree) are not a value.
  [new RegExp(String.raw`(${KEY})(:${SP}\r?\n[^\S\r\n]+)(?!- )[^\r\n]+`, "gi"), "$1$2[redacted]"],
  // The same key and value HTML-escaped: password=&quot;x&quot; or &#34;x&#34;.
  [new RegExp(String.raw`(${KEY})(${KEY_END}(?:[:=]|%3[AaDd])${SP}&(?:quot|#34|#x22);)(?:(?!&(?:quot|#34|#x22);).)*`, "gi"), "$1$2[redacted]"],
  // A quoted value of any length keeps its quotes (an escaped quote does not end it); "key=value" runs up to the next space.
  [new RegExp(String.raw`(${KEY})(${KEY_END}(?:[:=]|%3[AaDd])${SP}\\")(?:[^\\]|\\(?!"))*`, "gi"), "$1$2[redacted]"], // value inside \"...\" (JSON inside a string)
  [new RegExp(String.raw`(${KEY})(${KEY_END}(?:[:=]|%3[AaDd])${SP}")(?:[^"\\]|\\.)*`, "gi"), "$1$2[redacted]"],
  [new RegExp(String.raw`(${KEY})(${KEY_END}(?:[:=]|%3[AaDd])${SP}')(?:[^'\\]|\\.)*`, "gi"), "$1$2[redacted]"],
  [new RegExp(String.raw`(${KEY})(${KEY_END}(?:[:=]|%3[AaDd])${SP})[^\s"'&,;\\]+`, "gi"), "$1$2[redacted]"],
  [/(?<![A-Fa-f0-9])[A-Fa-f0-9]{32,}(?![A-Fa-f0-9])/g, "[redacted hex]"],
  // A run of 40 or more token characters that contains a digit. Long hyphenated words and names ("closed-shadow-root-...")
  // have none and are kept. Starting only where a run begins keeps the scan linear.
  [/(?<![A-Za-z0-9+_-])(?=[A-Za-z0-9+_-]*\d)[A-Za-z0-9+_-]{40,}={0,2}/g, "[redacted long value]"],
  // Base64 with "/" also looks like a path: it counts as a value only when it mixes digits and both letter cases.
  [new RegExp(`(?<![${BASE64}])(?=[${BASE64}]*\\d)(?=[${BASE64}]*[a-z])(?=[${BASE64}]*[A-Z])[${BASE64}]{40,}={0,2}`, "g"), "[redacted long value]"],
];
// Text of any length is accepted and kept whole (the evidence file holds every check in full); a test feeds the patterns
// hostile input to keep them linear.
export function redactSecrets(text) {
  return SECRET_PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), String(text));
}

// redactSecrets over every string inside a value (a check's expected and actual can be text or a small object).
// Below the depth limit the rest is redacted as one JSON text, so nothing nested deeper is ever left raw.
export function scrubValue(value, depth = 0) {
  if (typeof value === "string") return redactSecrets(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  if (value === null || typeof value !== "object") return value;
  if (depth > 6) {
    try { return redactSecrets(JSON.stringify(value)); } catch { return "[unreadable value]"; }
  }
  if (Array.isArray(value)) return value.map(item => scrubValue(item, depth + 1));
  // An object field is a key and a value that no text pattern sees together: a field named like a credential is masked
  // whole. Keys are scrubbed too; two keys that collapse to one are kept apart.
  return copyFields(value, (rawKey, item) => (nameMatches(SENSITIVE_NAME, rawKey) ? maskLeaves(item) : scrubValue(item, depth + 1)));
}

// A copy of an object with scrubbed keys and the values valueOf(rawKey, item) gives. Two fields whose keys scrub to the same
// text are kept apart ("x", "x#2", ...) even when a real key already looks like "x#2": nothing is overwritten, and each
// collision costs constant time (a counter per scrubbed key, a membership test for the rare clash with a literal "#n").
function copyFields(object, valueOf) {
  const out = {};
  const next = new Map();
  for (const [rawKey, item] of Object.entries(object)) {
    const base = redactSecrets(rawKey);
    let n = next.get(base) ?? 1;
    let key = n === 1 ? base : `${base}#${n}`;
    while (Object.hasOwn(out, key)) { n += 1; key = `${base}#${n}`; }
    next.set(base, n + 1);
    // defineProperty, not assignment: a field called "__proto__" is data here, never the prototype.
    Object.defineProperty(out, key, { value: valueOf(rawKey, item), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

// A credential field is hidden whole, and keeps its shape: a list stays a list of the same length, so code that reads the
// record (a look report's key list) never meets a different type.
function maskLeaves(item, depth = 0) {
  if (item === null || typeof item === "boolean" || item === undefined) return item;
  if (typeof item !== "object") return "[redacted]";
  if (depth > 6) return "[redacted]";
  if (Array.isArray(item)) return item.map(entry => maskLeaves(entry, depth + 1));
  return copyFields(item, (_name, entry) => maskLeaves(entry, depth + 1));
}

// Text taken from a page or a dialog is cut before it is scanned when it is huge: every recorded text is clipped to
// far less than this, so a secret cannot straddle the cut that matters.
// One cut, one count: the text is redacted (its first SCAN_CHARS only) and cut to `limit` here, and the note says how many
// characters of the original were dropped. Clipping the result again would count from the middle.
const SCAN_CHARS = 50_000;
export const redactClip = (text, limit) => {
  const whole = String(text);
  if (whole.length <= limit) return clipValue(redactSecrets(whole), limit);
  return `${redactSecrets(whole.slice(0, SCAN_CHARS)).slice(0, limit)}... [${whole.length - limit} more characters]`;
};

// The label an address assertion records for what it expects. A regular expression is not an address: its "?" and "#" are
// syntax, so its label is kept as written.
export const addressLabel = match => (match.kind === "matches" ? match.label : hideAddressText(String(match.label)));

// The identity of a run's spec: its name (scrubbed, since a name can quote anything) and the hash of its file. The hash is
// added after the scrub so a name that looks like "Session: idle" cannot swallow it; status.js compares with the same function.
export const specLabel = (name, hash) => `${redactSecrets(name)}@${hash}`;

// Query, fragment and token-like path segments inside spec-authored address text (an expected address, app.start): hidden
// like a recorded address. A regular expression is not an address: its "?" and "#" are syntax, so its label is left alone.
export const hideAddressText = text => String(text)
  .replace(/\?(?!\[query hidden\])[^\s"']*/g, "?[query hidden]")
  .replace(/#(?!\[hash hidden\])[^\s"']*/g, "#[hash hidden]")
  // Path segments only: the character before the slash is not another slash, so a host ("//proof-lab-staging-2026.test") stays.
  .replace(/(?<=(?:^|[^/])\/)[^\s/?#"']{16,}/g, segment => (/\d/.test(segment) && /[A-Za-z]/.test(segment)) || /^[A-Za-z0-9]{24,}$/.test(segment) ? "[hidden]" : segment);

// The one place that makes "nothing written holds a credential" true by construction: every record that leaves the
// run (receipt, evidence lines, look output) passes through here, whatever field a new sink puts text in. Fields in
// `keep` are the run's own bookkeeping (a path, a timestamp, a picture): they are not page or spec text.
export function scrubRecord(record, keep = []) {
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, keep.includes(key) ? item : scrubValue(item)]));
}

// An address can carry a code or token in its query, fragment or even its path (a reset link): the record keeps the
// origin and the path, with a long mixed letter-and-digit segment hidden, and never the query or fragment.
export function hideQuery(url) {
  try {
    const parsed = new URL(url);
    // about:blank has no origin; data: and blob: addresses can hold the content itself, so only the scheme is kept.
    if (parsed.protocol === "about:") return clipValue(String(url).split(/[?#]/)[0], 100);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return `${parsed.protocol}[hidden]`;
    return redactSecrets(`${parsed.origin}${hideTokenSegments(parsed.pathname)}${parsed.search ? "?[query hidden]" : ""}${parsed.hash ? "#[hash hidden]" : ""}`);
  } catch {
    return "[unparseable address]"; // the raw text could hold a query
  }
}

// A path segment that looks like a token: 16 or more characters mixing letters and digits, or 24 or more letters and
// digits in one run. File and page names ("forms.html", "authentication-settings") stay readable.
export function hideTokenSegments(pathname) {
  return redactSecrets(pathname.split("/").map(segment => {
    const mixed = segment.length >= 16 && /\d/.test(segment) && /[A-Za-z]/.test(segment);
    return mixed || /^[A-Za-z0-9]{24,}$/.test(segment) ? "[hidden]" : segment;
  }).join("/"));
}

// A value that must never be written, shown as its length and a keyed fingerprint: two runs of one process can see
// that two values are equal, nobody can recover or guess the value from it (the key is random per process).
const FINGERPRINT_KEY = randomBytes(32);
export function maskValue(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return `${text.length} characters, hmac ${createHmac("sha256", FINGERPRINT_KEY).update(text).digest("hex").slice(0, 8)}`;
}

// Words in a step that say its value is a credential (a storage key, an attribute, a field label, a selector): the
// values it reads or compares are masked whole, because the name that makes them secret is not inside the value.
// The short names ("pass", "auth", "sid") count only as a whole word (DB_PASS, auth.token), so "author" and "compass" do not.
const SENSITIVE_NAME = /password|passwd|passphrase|passcode|secret|token|api[ _-]?key|access[ _-]?key|private[ _-]?key|authorization|credential|cookie|session|(?<![A-Za-z])(?:pwd|pw|pass|auth|sid|otp|pin)(?![A-Za-z])/i;
// A control's own name (label, placeholder, test id, selector) is judged by the strong words only: "Session name" or
// "Pin location" is a field about something else, "Password" or "API key" is the credential.
const STRONG_NAME = /password|passwd|passphrase|passcode|secret|token|api[ _-]?key|access[ _-]?key|private[ _-]?key|credential|cookie|authorization|session[ _-]?id|(?<![A-Za-z])(?:pwd|pw|otp|pin|sid)(?![A-Za-z])/i;
// camelCase names are read as words ("authHeader" is "auth_Header", "dbPass" is "db_Pass") before the patterns see them.
const nameMatches = (pattern, name) => pattern.test(name) || pattern.test(name.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
// The names of the data read (key, attribute, property, path) always count; the names of the control count when the step
// reads the control's value (assertValue, or an attribute or property called "value"), not when it only finds a button
// called "Show password".
export const isSensitiveStep = step => {
  const named = (field, pattern) => typeof step?.[field] === "string" && nameMatches(pattern, step[field]);
  const readsValue = step?.op === "assertValue" || (["assertAttribute", "assertProperty"].includes(step?.op) && (step.attribute ?? step.property) === "value");
  return ["key", "attribute", "property", "path"].some(field => named(field, SENSITIVE_NAME))
    || (readsValue && ["label", "placeholder", "testId", "selector", "name"].some(field => named(field, STRONG_NAME)));
};

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
