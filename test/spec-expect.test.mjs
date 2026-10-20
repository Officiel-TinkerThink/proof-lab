import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSpec } from "../src/run-spec.js";
import { redactSecrets } from "../src/spec/evidence.js";
import { hideQuery } from "../src/spec/expect.js";
import { TIMEOUT, explain, failedChecks, page, runInline, withRun } from "./spec-helpers.mjs";

const DIALOGS = "/fixtures/dialogs.html";
const POPUPS = "/fixtures/popups.html";
const button = name => ({ op: "click", role: "button", name });
const text = (testId, equals) => ({ op: "assertText", testId, equals });
const title = equals => ({ op: "assertTitle", equals });

async function expectPass(spec) {
  const receipt = await runInline(spec);
  assert.equal(receipt.verdict, "PASS", explain(receipt));
  return receipt;
}

// --- validation: no browser needed ---------------------------------------------------------------------------------

test("validateSpec: an expect block is checked kind by kind", () => {
  const problems = expect => validateSpec(page(DIALOGS, [{ ...button("Alert"), expect }])).join(" | ");
  assert.equal(problems({ dialog: { type: "confirm", message: { contains: "Delete" }, action: "dismiss" } }), "");
  assert.equal(problems({ download: { filename: "a.txt", content: { matches: "^hello", flags: "i" } }, popup: { url: { contains: "x" }, switchTo: false } }), "");
  assert.equal(problems({ dialog: { appears: false, within: 200 } }), "");
  assert.match(problems({}), /expect needs at least one of dialog, download, popup/);
  assert.match(problems({ modal: {} }), /unknown field "modal"/);
  assert.match(problems({ dialog: { type: "toast" } }), /expect.dialog.type must be one of alert, confirm, prompt, beforeunload/);
  assert.match(problems({ dialog: { message: {} } }), /expect.dialog.message needs exactly one of equals, contains, matches/);
  assert.match(problems({ dialog: { message: { equals: "a", contains: "b" } } }), /needs exactly one of/);
  assert.match(problems({ dialog: { message: { matches: "(" } } }), /not a valid regular expression/);
  assert.match(problems({ dialog: { message: { matches: "a", flags: "g" } } }), /flags may only use/);
  assert.match(problems({ dialog: { message: { flags: "i" } } }), /flags only applies with matches/);
  assert.match(problems({ dialog: { appears: false, message: "x" } }), /appears false means nothing may happen, so message cannot be given/);
  assert.match(problems({ popup: { appears: false, switchTo: false } }), /so switchTo cannot be given/);
  assert.match(problems({ dialog: { within: 100 } }), /within only applies with appears: false/);
  assert.match(problems({ dialog: { appears: false, within: 70000 } }), /within must be from 0 to 60000/);
  assert.match(problems({ dialog: { action: "dismiss", promptText: "x" } }), /promptText only applies when a prompt is accepted/);
  assert.match(problems({ dialog: { type: "confirm", promptText: "x" } }), /promptText only applies/);
  assert.match(problems("dialog"), /expect must be object/);
});

test("validateSpec: expect belongs to action steps only, and counts as a check", () => {
  const dialog = { dialog: { type: "alert" } };
  assert.match(validateSpec(page(DIALOGS, [{ op: "assertTitle", equals: "x", expect: dialog }])).join(" | "), /unknown field "expect"/);
  assert.match(validateSpec(page(DIALOGS, [{ op: "fill", label: "x", value: "y", expect: dialog }])).join(" | "), /unknown field "expect"/);
  assert.equal(validateSpec(page(DIALOGS, [{ ...button("Alert"), expect: dialog }])).join(" | "), "", "a spec whose only check is an expectation is a spec");
  assert.equal(validateSpec(page(DIALOGS, [{ op: "goto", url: "/fixtures/nav-b.html", expect: dialog }])).join(" | "), "");
});

test("validateSpec: switchTab needs an index or an address matcher, closeTab nothing", () => {
  const problems = step => validateSpec(page(POPUPS, [title("Popups fixture"), step])).join(" | ");
  assert.equal(problems({ op: "switchTab", index: 1 }), "");
  assert.equal(problems({ op: "switchTab", contains: "nav-b" }), "");
  assert.equal(problems({ op: "closeTab" }), "");
  assert.match(problems({ op: "switchTab" }), /needs exactly one of index, equals, contains, matches/);
  assert.match(problems({ op: "switchTab", index: 1, contains: "x" }), /needs exactly one of/);
  assert.match(problems({ op: "switchTab", index: -1 }), /index must be 0 or more/);
});

// --- dialogs ---------------------------------------------------------------------------------------------------------

test("dialog: alert, confirm accept and dismiss, prompt with and without text", TIMEOUT, async () => {
  await expectPass(page(DIALOGS, [
    { ...button("Alert"), expect: { dialog: { type: "alert", message: "Hello alert" } } },
    text("alert-state", "closed"),
    { ...button("Confirm"), expect: { dialog: { type: "confirm", message: { contains: "Delete" }, action: "accept" } } },
    text("confirm-result", "true"),
    { ...button("Confirm"), expect: { dialog: { type: "confirm", message: { matches: "^delete item", flags: "i" }, action: "dismiss" } } },
    text("confirm-result", "false"),
    { ...button("Prompt"), expect: { dialog: { type: "prompt", message: "Your name?", promptText: "Ada" } } },
    text("prompt-result", "Ada"),
    { ...button("Prompt"), expect: { dialog: { type: "prompt", action: "dismiss" } } },
    text("prompt-result", "cancelled"),
    { ...button("Prompt"), expect: { dialog: { type: "prompt" } } },
    text("prompt-result", "anon"),
  ]));
});

test("dialog: a leave-page warning is answered on navigation", TIMEOUT, async () => {
  await expectPass(page(DIALOGS, [
    { op: "check", label: "Warn on leave" },
    { op: "goto", url: "/fixtures/nav-b.html", expect: { dialog: { type: "beforeunload", action: "accept" } } },
    title("Page B"),
  ]));
});

test("dialog: a wrong type or message fails with what the dialog really said", TIMEOUT, async () => {
  const receipt = await runInline(page(DIALOGS, [
    { ...button("Alert"), expect: { dialog: { type: "confirm" } } },
    { ...button("Confirm"), expect: { dialog: { type: "confirm", message: "Remove item?" } } },
    { ...button("Confirm"), hint: "the confirm text changed", expect: { dialog: { message: { contains: "Delete" } } } },
  ]));
  assert.equal(receipt.verdict, "FAIL");
  const failed = failedChecks(receipt);
  assert.deepEqual(failed.map(check => check.step), [1, 2], explain(receipt));
  assert.match(failed[0].name, /-> dialog$/);
  assert.deepEqual(failed[0].actual, { type: "alert", message: "Hello alert", answered: "accept" });
  assert.deepEqual(failed[1].actual, { type: "confirm", message: "Delete item?", answered: "accept" });
});

test("dialog: an expected dialog that never opens fails; appears false passes without one and fails with one", TIMEOUT, async () => {
  const receipt = await runInline(page(DIALOGS, [
    { op: "check", label: "Warn on leave", timeout: 400, expect: { dialog: { type: "alert" } } },
    { op: "uncheck", label: "Warn on leave", expect: { dialog: { appears: false, within: 200 } } },
    { ...button("Alert"), expect: { dialog: { appears: false, within: 200 } } },
  ]));
  assert.equal(receipt.verdict, "FAIL");
  const failed = failedChecks(receipt);
  assert.deepEqual(failed.map(check => check.step), [1, 3], explain(receipt));
  assert.equal(failed[0].actual, null);
  assert.deepEqual(failed[0].expected, { dialog: "appears", type: "alert" });
  assert.deepEqual(failed[1].expected, { dialog: "none" });
  assert.equal(failed[1].actual.type, "alert");
});

test("expect: a step that fails by itself records the step, not a second failure for the missing event", TIMEOUT, async () => {
  const receipt = await runInline(page(DIALOGS, [
    { ...button("No such button"), timeout: 300, expect: { dialog: { type: "alert" } } },
    text("alert-state", "idle"),
  ]));
  assert.equal(receipt.verdict, "FAIL");
  assert.equal(failedChecks(receipt).length, 1, explain(receipt));
  assert.equal(failedChecks(receipt)[0].step, 1);
  assert.doesNotMatch(failedChecks(receipt)[0].name, /-> dialog/);
});

// --- downloads -------------------------------------------------------------------------------------------------------

test("download: the file name and the content are checked", TIMEOUT, async () => {
  const link = { op: "click", role: "link", name: "Download hello" };
  await expectPass(page(DIALOGS, [
    { ...link, expect: { download: { filename: "hello.txt", content: { contains: "hello from proof-lab" } } } },
    { ...link, expect: { download: { filename: { matches: "\\.txt$" }, content: "hello from proof-lab\n" } } },
    { ...link, expect: { download: {} } },
  ]));
  const receipt = await runInline(page(DIALOGS, [
    { ...link, expect: { download: { filename: "other.txt" } } },
    { ...link, expect: { download: { content: { contains: "goodbye" } } } },
    { ...link, expect: { download: { appears: false, within: 200 } } },
    { ...button("Alert"), timeout: 400, expect: { dialog: { type: "alert" }, download: { filename: "x.txt" } } },
  ]));
  const failed = failedChecks(receipt);
  assert.deepEqual(failed.map(check => check.step), [1, 2, 3, 4], explain(receipt));
  assert.deepEqual(failed[0].actual, { filename: "hello.txt", bytes: 21 });
  assert.equal(failed[1].actual.content, "hello from proof-lab\n");
  assert.equal(failed[3].actual, null);
});

// --- popups and tabs -------------------------------------------------------------------------------------------------

test("popup: a link and a script open a tab, the spec moves into it and back", TIMEOUT, async () => {
  await expectPass(page(POPUPS, [
    title("Popups fixture"),
    { op: "click", role: "link", name: "Open page B in a new tab", expect: { popup: { url: { contains: "/fixtures/nav-b.html" }, title: "Page B" } } },
    title("Page B"),
    { op: "closeTab" },
    title("Popups fixture"),
    { ...button("Open page B from script"), expect: { popup: {} } },
    title("Page B"),
    { op: "switchTab", index: 0 },
    title("Popups fixture"),
    { op: "switchTab", contains: "nav-b" },
    title("Page B"),
    { op: "switchTab", matches: "popups\\.html$" },
    title("Popups fixture"),
  ]));
});

test("popup: switchTo false keeps the spec on its page; a popup that opens late is waited for; none opens when none should", TIMEOUT, async () => {
  await expectPass(page(POPUPS, [
    { ...button("Open page B from script"), expect: { popup: { title: "Page B", switchTo: false } } },
    title("Popups fixture"),
    { ...button("Open page B after a pause"), expect: { popup: { url: { contains: "nav-b" } } } },
    title("Page B"),
    { op: "switchTab", index: 0 },
    { ...button("Do nothing"), expect: { popup: { appears: false, within: 300 } } },
    text("state", "clicked"),
  ]));
});

test("popup: a wrong address, a missing popup and a popup that should not open are failed checks", TIMEOUT, async () => {
  const receipt = await runInline(page(POPUPS, [
    { ...button("Open page B from script"), expect: { popup: { url: { contains: "elsewhere" }, switchTo: false } } },
    { ...button("Do nothing"), timeout: 400, expect: { popup: { title: "Page B" } } },
    { ...button("Open page B from script"), expect: { popup: { appears: false, within: 300 } } },
  ]));
  assert.equal(receipt.verdict, "FAIL");
  const failed = failedChecks(receipt);
  assert.deepEqual(failed.map(check => check.step), [1, 2, 3], explain(receipt));
  assert.match(failed[0].actual.url, /nav-b\.html$/);
  assert.equal(failed[0].actual.title, "Page B");
  assert.equal(failed[1].actual, null);
  assert.match(failed[2].actual.url, /nav-b\.html$/);
});

test("popup: a popup that closes itself leaves a receipt, not an ERROR, and the run stays on its page", TIMEOUT, async () => {
  const receipt = await runInline(page(POPUPS, [
    { ...button("Open page B and close it"), expect: { popup: { url: { contains: "nav-b" } } } },
  ]));
  assert.notEqual(receipt.verdict, "ERROR", explain(receipt));
  const both = await runInline(page(POPUPS, [
    { ...button("Open page B twice"), expect: { popup: { title: "Page B", switchTo: false } } },
    title("Popups fixture"),
  ]));
  assert.equal(both.verdict, "PASS", explain(both));
});

test("runStep: a step that hung past its limit cannot record a check or move the run afterwards", async () => {
  const { createContext, runStep, stepLimits } = await import("../src/run-spec.js");
  const { STEPS } = await import("../src/spec/steps.js");
  const before = stepLimits.graceMs;
  const pageA = { name: "a", isClosed: () => false };
  const pageB = { name: "b", isClosed: () => false };
  const checks = [];
  const ctx = createContext({ page: pageA, appUrl: "http://127.0.0.1:1", specDir: ".", timeoutMs: 50, checks });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  STEPS.__hang = async stepCtx => { await gate; stepCtx.record({ op: "__hang" }, true, "late", "late"); stepCtx.page = pageB; };
  STEPS.__quick = async stepCtx => { stepCtx.record({ op: "__quick" }, true, "quick", "quick"); };
  try {
    stepLimits.graceMs = 20;
    ctx.index = 1;
    const hung = await runStep(ctx, { op: "__hang", timeout: 50 });
    assert.equal(hung.ok, false, "the step that hung is a failed check");
    ctx.index = 2;
    await runStep(ctx, { op: "__quick" });
    release(); // the hung step now wakes up, in the middle of the run
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(checks.map(check => [check.step, check.pass]), [[1, false], [2, true]], "no late check under any step number");
    assert.equal(ctx.page, pageA, "a late tab switch does not move the run");
  } finally {
    stepLimits.graceMs = before;
    delete STEPS.__hang;
    delete STEPS.__quick;
  }
});

test("redactSecrets: credential-shaped text is replaced, ordinary text is not", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r";
  assert.equal(redactSecrets(`auth ${jwt} done`), "auth [redacted jwt] done");
  assert.equal(redactSecrets("Authorization: Bearer abcdef123456789"), "Authorization: [redacted]");
  assert.equal(redactSecrets("login failed token=hunter2hunter2 for ada"), "login failed token=[redacted] for ada");
  assert.equal(redactSecrets('{"password":"swordfish99"}'), '{"password":"[redacted]"}');
  assert.equal(redactSecrets("GET https://ada:s3cret@example.test/x"), "GET https://ada:[redacted]@example.test/x");
  assert.equal(redactSecrets(`key ${"a1b2c3d4".repeat(5)}`), "key [redacted hex]");
  for (const plain of ["status code=404 for /api/items", "TypeError: x is not a function at app.js:12:3", "Failed to load resource: 500"]) {
    assert.equal(redactSecrets(plain), plain);
  }
});

test("hideQuery: a popup address keeps its origin and path, never its query or fragment", () => {
  assert.equal(hideQuery("http://127.0.0.1:9/fixtures/nav-b.html?code=s3cret#frag"), "http://127.0.0.1:9/fixtures/nav-b.html?[query hidden]#[hash hidden]");
  assert.equal(hideQuery("http://127.0.0.1:9/a"), "http://127.0.0.1:9/a");
  assert.equal(hideQuery("about:blank"), "about:blank");
  assert.equal(hideQuery("data:text/html,<p>secret</p>"), "data:[hidden]");
});

test("popup: the address in the evidence has no query, while the match still sees the whole address", TIMEOUT, async () => {
  const receipt = await runInline(page(POPUPS, [
    { ...button("Open page B with a code"), expect: { popup: { url: { contains: "code=s3cretvalue1" }, switchTo: false } } },
    { ...button("Open page B with a code"), expect: { popup: { url: { contains: "nope" }, switchTo: false } } },
  ]));
  const failed = failedChecks(receipt);
  assert.deepEqual(failed.map(check => check.step), [2], explain(receipt));
  assert.equal(failed[0].actual.url.includes("s3cretvalue1"), false, "the code must not reach the receipt");
  assert.ok(failed[0].actual.url.endsWith("/fixtures/nav-b.html?[query hidden]#[hash hidden]"), failed[0].actual.url);
});

test("popup: a page error in a tab the app opened by a plain click counts, and the credential in it is not recorded", TIMEOUT, async () => {
  const receipt = await runInline({ ...page(POPUPS, [
    button("Open the broken page"),
    { op: "switchTab", index: 1 },
    title("Broken page"),
    { op: "assertText", selector: "h1", equals: "Broken" },
  ]), noPageErrors: true });
  assert.equal(receipt.verdict, "FAIL", explain(receipt));
  const text = JSON.stringify(receipt);
  assert.match(text, /boom/);
  assert.doesNotMatch(text, /swordfish99|hunter2hunter2/, "a credential the app logged must not reach the receipt");
});

test("closeTab: the run moves to the last other tab before the close settles, and refuses to close the only tab", async () => {
  const { STEPS } = await import("../src/spec/steps.js");
  const first = { name: "first", bringToFront: async () => {} };
  const second = { name: "second", bringToFront: async () => {} };
  const pages = [first, second];
  let seenDuringClose = null;
  const closing = { context: () => ({ pages: () => pages }), close: async () => { seenDuringClose = ctx.page; } };
  pages.push(closing);
  const ctx = { page: closing };
  await STEPS.closeTab(ctx, { op: "closeTab" });
  assert.equal(seenDuringClose, second, "ctx.page already points at the next tab when the close runs");
  assert.equal(ctx.page, second);
  const lone = { context: () => ({ pages: () => [lone] }), close: async () => { throw new Error("must not close"); } };
  await assert.rejects(STEPS.closeTab({ page: lone }, { op: "closeTab" }), /only open tab/);
});

test("redactSecrets: schemes, key variants, quoted and encoded values, and key material", () => {
  const cases = [
    ["Authorization: ApiKey 1234567890abcdef", "Authorization: [redacted]"],
    ["password: correct horse battery", "password: [redacted]"],
    ['login failed password="ab cd"', 'login failed password="[redacted]"'],
    ['{"password":"x y z"}', '{"password":"[redacted]"}'],
    ['{\\"token\\":\\"abc def\\"}', '{\\"token\\":\\"[redacted]\\"}'],
    ["password: ab'cd efgh", "password: [redacted]"],
    ['{"password":"ab\\"cd"}', '{"password":"[redacted]"}'],
    ["API key: abc def", "API key: [redacted]"],
    ["Session ID: zz9", "Session ID: [redacted]"],
    ["jwt eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0. end", "jwt [redacted jwt] end"],
    ["k sk_live_abcdefghijklmnop1234 e", "k [redacted token] e"],
    ["http://:pw@host/x", "http://:[redacted]@host/x"],
    ["a?token%3Dabcdef1&x=1", "a?token%3D[redacted]&x=1"],
    ["Cookie: sid=abc123; theme=dark", "Cookie: [redacted]"],
    ["db_password=hunter2 private_key=zz", "db_password=[redacted] private_key=[redacted]"],
    ["http://ada:p/w@ss@example.test/x", "http://ada:[redacted]@example.test/x"],
    ["key AKIAIOSFODNN7EXAMPLE end", "key [redacted access key] end"],
    ["tok ghp_abcdefghijklmnopqrstuvwxyz0123456789 x", "tok [redacted token] x"],
    ["-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY----- done", "[redacted private key] done"],
    [`blob ${"aB3/".repeat(12)} end`, "blob [redacted long value] end"],
  ];
  for (const [input, expected] of cases) assert.equal(redactSecrets(input), expected, input);
  for (const plain of ["Basic validation failed for field email", "bearer configuration missing", "the author wrote a bypass: ok",
    "src/app/fixtures/some-long-directory-name/another-long-file-name-here.js", "request id 123e4567-e89b-12d3-a456-426614174000"]) {
    assert.equal(redactSecrets(plain), plain);
  }
  assert.equal(redactSecrets("Basic dXNlcjpwYXNzd29yZA=="), "Basic [redacted]");
});

test("redactSecrets: a long hostile input finishes quickly", () => {
  const started = performance.now();
  redactSecrets("a-".repeat(50_000));
  redactSecrets(`${"x".repeat(60_000)} token`);
  redactSecrets(`Basic ${" ".repeat(60_000)}`);
  redactSecrets("token:".repeat(20_000));
  redactSecrets(`${"a1".repeat(40_000)}g`);
  redactSecrets("-----BEGIN PRIVATE KEY-----".repeat(5_000));
  redactSecrets(`password=\"${"x\\".repeat(40_000)}`);
  redactSecrets("aB3/".repeat(30_000));
  assert.ok(performance.now() - started < 3000, "linear-time redaction on text of any length");
  assert.equal(redactSecrets("word ".repeat(30_000)).length, 150_000, "long ordinary text is kept whole");
});

test("hideQuery: a token in the path is hidden too", () => {
  assert.equal(hideQuery("http://h.test/reset/a1b2c3d4e5f6g7h8i9j0/confirm"), "http://h.test/reset/[hidden]/confirm");
  assert.equal(hideQuery("http://h.test/reset/abcdefghijklmnopqrstuvwxyz/confirm"), "http://h.test/reset/[hidden]/confirm");
  assert.equal(hideQuery("http://h.test/items/12345"), "http://h.test/items/12345");
  assert.equal(hideQuery("http://h.test/authentication-settings/forms.html"), "http://h.test/authentication-settings/forms.html");
  assert.equal(hideQuery("about:blank?code=ab12cd34#x"), "about:blank");
});

test("scrubValue: a value nested deeper than the depth limit and an object key are scrubbed too", async () => {
  const { scrubValue } = await import("../src/spec/evidence.js");
  const deep = { a: { b: { c: { d: { e: { f: { g: { s: "password: hunter2hunter2" } } } } } } } };
  assert.doesNotMatch(JSON.stringify(scrubValue(deep)), /hunter2/);
  assert.doesNotMatch(JSON.stringify(scrubValue({ "token=abcdef123": 1 })), /abcdef123/);
  assert.equal(scrubValue(new Date("2026-01-02T03:04:05Z")), "2026-01-02T03:04:05.000Z");
});

test("record: a step that names a credential records its length and fingerprint, never the value", async () => {
  const { createContext } = await import("../src/run-spec.js");
  const checks = [];
  const ctx = createContext({ page: {}, appUrl: "http://127.0.0.1:1", specDir: ".", timeoutMs: 50, checks });
  ctx.record({ op: "assertStorage", key: "authToken" }, false, "equals opaque-expected", "opaque-actual-1", undefined);
  ctx.record({ op: "assertValue", label: "Password" }, true, "equals x", "hunter2", undefined);
  ctx.record({ op: "assertValue", label: "Name" }, false, "equals x", "Ada", undefined);
  ctx.record({ op: "assertState", name: "Show password" }, true, "enabled", true, undefined);
  const text = JSON.stringify(checks);
  assert.doesNotMatch(text, /opaque-actual-1|opaque-expected|hunter2/);
  assert.match(checks[0].actual, /^\(masked, 15 characters, hmac [0-9a-f]{8}\)$/);
  assert.equal(checks[2].actual, "Ada", "an ordinary field is recorded as it is");
  assert.equal(checks[3].actual, true, "a button called Show password is not a credential");
});

test("assertUrl: the match sees the whole address, the record never shows its query", async () => {
  const { STEPS } = await import("../src/spec/steps.js");
  const recorded = [];
  const ctx = { timeoutMs: 100, page: { url: () => "http://127.0.0.1:4173/done?code=ab12cd34&state=x" }, record: (...args) => recorded.push(args) };
  await STEPS.assertUrl(ctx, { op: "assertUrl", contains: "code=ab12cd34", timeout: 0 });
  await STEPS.assertUrl(ctx, { op: "assertUrl", contains: "never", timeout: 0 });
  assert.equal(recorded[0][1], true, "the match used the real address");
  assert.equal(recorded[1][1], false);
  assert.equal(recorded[1][3], "http://127.0.0.1:4173/done?[query hidden]");
});

test("closeTab: if the tab will not close, the run stays on it and the step fails", async () => {
  const { STEPS } = await import("../src/spec/steps.js");
  const other = { bringToFront: async () => {} };
  const closing = { context: () => ({ pages: () => [other, closing] }), close: async () => { throw new Error("close refused"); } };
  const ctx = { page: closing };
  await assert.rejects(STEPS.closeTab(ctx, { op: "closeTab" }), /close refused/);
  assert.equal(ctx.page, closing);
});

test("choke point: no field of the receipt or the evidence file holds a credential, whichever path put it there", TIMEOUT, async () => {
  const { readFile } = await import("node:fs/promises");
  // withRun reads inside the callback: the receipts directory is removed when it returns.
  await withRun(page("/fixtures/forms.html", [
    { op: "assertTitle", check: "title check token=namesecret88", equals: "nope", hint: "hint password=hintsecret77", timeout: 0 },
    { op: "review", check: "tone api_key=reviewsecret66", note: "secret=notesecret55" },
    { op: "click", selector: "#no-such", optional: true, timeout: 100, hint: "cookie: optsecret44" },
  ]), async receipt => {
    const evidence = await readFile(receipt.detail.evidencePath, "utf8");
    const text = JSON.stringify(receipt) + evidence;
    assert.doesNotMatch(text, /namesecret88|hintsecret77|reviewsecret66|notesecret55|optsecret44/, explain(receipt));
    assert.match(text, /title check token=\[redacted\]/, "the label stays readable");
  });
});

test("scrubValue: every string inside a check value is redacted", async () => {
  const { scrubValue } = await import("../src/spec/evidence.js");
  assert.deepEqual(scrubValue({ a: "token=abcdef", b: ["password: x"], n: 3 }), { a: "token=[redacted]", b: ["password: [redacted]"], n: 3 });
});

test("runStep: a check's actual and error text is scrubbed before it is recorded", async () => {
  const { createContext } = await import("../src/run-spec.js");
  const checks = [];
  const ctx = createContext({ page: {}, appUrl: "http://127.0.0.1:1", specDir: ".", timeoutMs: 50, checks });
  ctx.record({ op: "assertUrl" }, false, "https://a.test/?token=xyz987", "https://a.test/?token=xyz987", "saw token=xyz987");
  assert.doesNotMatch(JSON.stringify(checks), /xyz987/);
});

test("runStep: listeners a step armed are removed when the step is given up on", async () => {
  const { createContext, runStep, stepLimits } = await import("../src/run-spec.js");
  const { STEPS } = await import("../src/spec/steps.js");
  const before = stepLimits.graceMs;
  const ctx = createContext({ page: { isClosed: () => false }, appUrl: "http://127.0.0.1:1", specDir: ".", timeoutMs: 50, checks: [] });
  let removed = false;
  STEPS.__arm = async stepCtx => { stepCtx.onStepEnd(() => { removed = true; }); await new Promise(() => {}); };
  try {
    stepLimits.graceMs = 20;
    ctx.index = 1;
    const record = await runStep(ctx, { op: "__arm", timeout: 50 });
    assert.equal(record.ok, false);
    assert.equal(removed, true, "the abandoned step's listeners are gone before the next step starts");
  } finally {
    stepLimits.graceMs = before;
    delete STEPS.__arm;
  }
});

test("switchTab and closeTab: a tab that is not there is a failed step with a hint, not an ERROR", TIMEOUT, async () => {
  const receipt = await runInline(page(POPUPS, [
    { op: "switchTab", index: 5, hint: "open the popup first" },
    { op: "switchTab", contains: "nowhere" },
    { op: "closeTab" },
    title("Popups fixture"),
  ]));
  assert.equal(receipt.verdict, "FAIL", explain(receipt));
  const failed = failedChecks(receipt);
  assert.deepEqual(failed.map(check => check.step), [1, 2, 3], explain(receipt));
  assert.equal(failed[0].hint, "open the popup first");
  assert.match(failed[0].error, /there is no tab 5 \(1 open\)/);
  assert.match(failed[1].error, /no open tab has a matching address/);
  assert.match(failed[2].error, /only open tab/);
});

test("popup: assertions after the popup step read the popup's own address", TIMEOUT, async () => {
  const receipt = await runInline(page(POPUPS, [
    { ...button("Open page B from script"), expect: { popup: { title: "Page B" } } },
    { op: "assertUrl", contains: "nav-b" },
  ]));
  assert.equal(receipt.verdict, "PASS", explain(receipt));
});

test("record: a number read from a credential-named step is masked, a boolean is not", async () => {
  const { createContext } = await import("../src/run-spec.js");
  const checks = [];
  const ctx = createContext({ page: {}, appUrl: "http://127.0.0.1:1", specDir: ".", timeoutMs: 50, checks });
  ctx.record({ op: "assertStorage", key: "authToken" }, true, "equals 482913", 482913, undefined);
  ctx.record({ op: "assertValue", label: "OTP" }, true, "equals x", true, undefined);
  assert.doesNotMatch(JSON.stringify(checks[0]), /482913/);
  assert.match(checks[0].actual, /^\(masked, 6 characters, hmac [0-9a-f]{8}\)$/);
  assert.equal(checks[1].actual, true);
});

test("scrubValue: a keyed credential field is hidden whole, at any depth, and collapsed keys do not overwrite each other", async () => {
  const { scrubValue } = await import("../src/spec/evidence.js");
  const hidden = scrubValue({ password: "hunter2", deep: { list: [{ sessionId: "abc123xyz" }] }, ok: "fine" });
  assert.doesNotMatch(JSON.stringify(hidden), /hunter2|abc123xyz/);
  assert.equal(hidden.ok, "fine");
  const clash = scrubValue({ "token=aaaaaa11": 1, "token=bbbbbb22": 2 });
  assert.equal(Object.keys(clash).length, 2, "two different keys stay two keys");
});

test("redactSecrets: short and dotted key names, a long suffix, hex after an underscore; hyphenated names and a port in a path stay", () => {
  assert.doesNotMatch(redactSecrets("DB_PASS=s3cretvalue"), /s3cretvalue/);
  assert.doesNotMatch(redactSecrets("db.password: s3cretvalue"), /s3cretvalue/);
  assert.doesNotMatch(redactSecrets(`${"x".repeat(150)}_token=zzsecret99`), /zzsecret99/);
  assert.doesNotMatch(redactSecrets("key_0123456789abcdef0123456789abcdef"), /0123456789abcdef0123456789abcdef/);
  assert.equal(redactSecrets("a well-known-long-hyphenated-name here"), "a well-known-long-hyphenated-name here");
  assert.equal(redactSecrets("see //host:8080/path@v2 for details"), "see //host:8080/path@v2 for details");
});

test("redactSecrets: a repeated JWT-like run is linear, and an aria line naming a password is redacted", () => {
  const started = Date.now();
  redactSecrets("eyJabcdefgh.".repeat(20000));
  assert.ok(Date.now() - started < 2000, "a repeated eyJ run must not take quadratic time");
  assert.doesNotMatch(redactSecrets('- textbox "Password": hunter2'), /hunter2/);
});

test("assertUrl: a query in what the spec expects is hidden in the label as well", async () => {
  const { STEPS } = await import("../src/spec/steps.js");
  const recorded = [];
  const ctx = { timeoutMs: 100, page: { url: () => "http://127.0.0.1:4173/done" }, record: (...args) => recorded.push(args) };
  await STEPS.assertUrl(ctx, { op: "assertUrl", contains: "?code=ab12cd34", timeout: 0 });
  assert.doesNotMatch(JSON.stringify(recorded[0][2]), /ab12cd34/);
});

test("refuse and the choke point: a spec name that looks like a credential, and an ERROR run with no reachable app, keep the receipt clean", TIMEOUT, async () => {
  const { runInline } = await import("./spec-helpers.mjs");
  const receipt = await runInline({ name: "login token=namesecret99", app: { url: "http://127.0.0.1:9" }, steps: [{ op: "assertTitle", equals: "x" }] });
  assert.doesNotMatch(JSON.stringify(receipt), /namesecret99/);
  assert.equal(receipt.verdict, "ERROR");
  assert.ok(receipt.app === null || typeof receipt.app === "string");
});

test("cycle 8: a credential field keeps its shape, a field called __proto__ or constructor is data, colliding keys are cheap and kept apart", async () => {
  const { scrubValue, scrubRecord } = await import("../src/spec/evidence.js");
  assert.deepEqual(scrubValue({ session: ["k1", "k2"] }), { session: ["[redacted]", "[redacted]"] }, "a list stays a list");
  assert.deepEqual(scrubValue(JSON.parse('{"constructor":1,"toString":2}')), { constructor: 1, toString: 2 });
  const proto = scrubValue(JSON.parse('{"__proto__":{"admin":true}}'));
  assert.equal(Object.getPrototypeOf(proto), Object.prototype, "the prototype is not replaced");
  assert.deepEqual(Object.keys(proto), ["__proto__"]);
  const many = Object.fromEntries(Array.from({ length: 20000 }, (_, i) => [`token=value${i}`, i]));
  const started = Date.now();
  assert.equal(Object.keys(scrubValue(many)).length, 20000);
  assert.ok(Date.now() - started < 3000, "many colliding keys must not cost quadratic time");
  assert.deepEqual(scrubRecord({ storage: { session: ["a"] } }, ["storage"]), { storage: { session: ["a"] } });
});

test("cycle 8: names that mark a credential: authorization, pass, auth, sid, DB_PASS; a control called Session name is not one", async () => {
  const { scrubValue, isSensitiveStep } = await import("../src/spec/evidence.js");
  assert.deepEqual(scrubValue({ authorization: "abc123def456ghi789", pass: "zzz", db_auth: "q", sid: "x" }), { authorization: "[redacted]", pass: "[redacted]", db_auth: "[redacted]", sid: "[redacted]" });
  assert.deepEqual(scrubValue({ author: "Ada", compass: "north" }), { author: "Ada", compass: "north" });
  assert.equal(isSensitiveStep({ op: "assertStorage", key: "auth" }), true);
  assert.equal(isSensitiveStep({ op: "assertStorage", key: "DB_PASS" }), true);
  assert.equal(isSensitiveStep({ op: "assertValue", label: "Password" }), true);
  assert.equal(isSensitiveStep({ op: "assertValue", label: "Session name" }), false);
  assert.equal(isSensitiveStep({ op: "assertAttribute", attribute: "value", label: "API key" }), true);
});

test("cycle 8: a JWT after a hyphen, a long JWT and a long run of eyJ starts", () => {
  assert.doesNotMatch(redactSecrets("auth-eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NTY.sig"), /eyJ/);
  const long = `eyJ${"a".repeat(900)}.${"b".repeat(3000)}.${"c".repeat(500)}`;
  assert.doesNotMatch(redactSecrets(long), /aaaa|bbbb/);
  const started = Date.now();
  redactSecrets("eyJ-".repeat(40000));
  assert.ok(Date.now() - started < 3000, "a run of eyJ starts must stay fast");
});

test("cycle 8: a key at the end of an aria line does not take the next line; a URL quoted in an error loses its query", () => {
  assert.equal(redactSecrets('- region "Cookies":\n  - button "Accept all"'), '- region "Cookies":\n  - button "Accept all"');
  assert.equal(redactSecrets("page.goto: net::ERR at http://x:1/p?code=abcd1234 failed"), "page.goto: net::ERR at http://x:1/p?[query hidden] failed");
  assert.equal(redactSecrets(redactSecrets("see http://x/p?code=1")), "see http://x/p?[query hidden]", "scrubbing twice changes nothing");
  assert.doesNotMatch(redactSecrets("PIN: 482913"), /482913/);
});

test("cycle 8: redactHead says how much it cut; an address label hides a path token; a regex label is left as written", async () => {
  const { redactClip, hideAddressText, specLabel } = await import("../src/spec/evidence.js");
  assert.match(redactClip("x".repeat(60), 50), /\[10 more characters\]$/);
  assert.equal(hideAddressText("http://h/reset/ab12cd34ef56gh78ij/x?c=1"), "http://h/reset/[hidden]/x?[query hidden]");
  assert.equal(specLabel("Session: idle", "0123456789ab"), "Session: [redacted]@0123456789ab");
  const { STEPS } = await import("../src/spec/steps.js");
  const recorded = [];
  const ctx = { timeoutMs: 100, page: { url: () => "http://127.0.0.1:4173/login" }, record: (...args) => recorded.push(args) };
  await STEPS.assertUrl(ctx, { op: "assertUrl", matches: "login\?next=", timeout: 0 });
  assert.match(recorded[0][2], /next=/, "the regular expression label is not cut at its question mark");
});

test("cycle 8: a spec named like a credential still gets a receipt that status can find", TIMEOUT, async () => {
  const receipt = await runInline({ ...page("/fixtures/forms.html", [{ op: "assertTitle", equals: "nope", timeout: 0 }]), name: "Session: idle timeout" });
  assert.match(receipt.spec, /^Session: \[redacted\]@[0-9a-f]{12}$/);
});

test("cycle 8: a look report lists session storage key names", () => {
  return import("../src/look.js").then(({ formatLook }) => {
    const text = formatLook({ url: "http://x/", title: null, status: null, replayed: [], elements: [], testIds: [], storage: { local: ["a"], session: ["[redacted]"] }, frames: 0, console: [], pageErrors: [], failedRequests: [], aria: "- main", screenshot: null });
    assert.match(text, /sessionStorage keys: \[redacted\]/);
  });
});

test("cycle 9: one cut and one count; colliding keys never overwrite; a host is not a path token; the whole path segment is hidden", async () => {
  const { redactClip, scrubValue, hideAddressText } = await import("../src/spec/evidence.js");
  assert.match(redactClip("a".repeat(60000), 1000), /\.\.\. \[59000 more characters\]$/, "counted from the original text");
  assert.equal(redactClip("short", 1000), "short");
  const clash = scrubValue(JSON.parse('{"0123456789abcdef0123456789abcdef":1,"fedcba9876543210fedcba9876543210":2,"[redacted hex]#2":3}'));
  assert.deepEqual(Object.values(clash).sort(), [1, 2, 3], "no field is lost");
  assert.equal(hideAddressText("https://proof-lab-staging-2026.example.test/home"), "https://proof-lab-staging-2026.example.test/home");
  assert.equal(hideAddressText("http://h/reset/AbC123dEf456GhI789+JkL"), "http://h/reset/[hidden]");
});

test("cycle 9: a query after a hash route and a hash in text are hidden; a long JWT payload goes whole; a PIN field is masked", async () => {
  const { isSensitiveStep } = await import("../src/spec/evidence.js");
  assert.equal(redactSecrets("went to http://127.0.0.1:4173/#/reset?code=abcd1234efgh ok"), "went to http://127.0.0.1:4173/#[hash hidden] ok");
  assert.equal(redactSecrets("at http://h/p#access=x1y2 end"), "at http://h/p#[hash hidden] end");
  assert.equal(redactSecrets(redactSecrets("at http://h/p?a=1#b")), "at http://h/p?[query hidden]#[hash hidden]", "idempotent, a query and its fragment each keep a marker");
  const jwt = `eyJhbGciOiJIUzI1NiJ9.${"p".repeat(20000)}.${"s".repeat(500)}`;
  assert.equal(redactSecrets(`t ${jwt} u`), "t [redacted jwt] u");
  assert.equal(isSensitiveStep({ op: "assertValue", label: "PIN" }), true);
});

test("cycle 9: a popup expectation with a regular expression keeps its label", TIMEOUT, async () => {
  const { addressLabel } = await import("../src/spec/evidence.js");
  assert.equal(addressLabel({ kind: "matches", label: "matches /popup\\?id=\\d+/" }), "matches /popup\\?id=\\d+/");
  assert.equal(addressLabel({ kind: "contains", label: 'contains "/a?b=1"' }), 'contains "/a?[query hidden]"');
});

test("cycle 9b: camelCase names, a password with a question mark, a value on the next line, HTML-escaped values", async () => {
  const { scrubValue, isSensitiveStep } = await import("../src/spec/evidence.js");
  assert.doesNotMatch(redactSecrets("dbPass=hunter22 authHeader: abc123"), /hunter22|abc123/);
  assert.equal(redactSecrets("a bypass=1 Passage: ok"), "a bypass=1 Passage: ok");
  assert.deepEqual(scrubValue({ authHeader: "x1", dbPass: "y2", author: "Ada" }), { authHeader: "[redacted]", dbPass: "[redacted]", author: "Ada" });
  assert.equal(isSensitiveStep({ op: "assertStorage", key: "authHeader" }), true);
  assert.equal(isSensitiveStep({ op: "assertValue", label: "Session ID" }), true);
  assert.equal(isSensitiveStep({ op: "assertValue", label: "Session name" }), false);
  assert.doesNotMatch(redactSecrets("open http://u:pa?ss1@host/x now"), /pa\?ss1|pa\?/);
  assert.doesNotMatch(redactSecrets("config:\n  password:\n    s3cr3tval"), /s3cr3tval/);
  assert.equal(redactSecrets('- region "Cookies":\n  - button "Accept all"'), '- region "Cookies":\n  - button "Accept all"');
  assert.doesNotMatch(redactSecrets("password=&quot;hunter22&quot; x"), /hunter22/);
  assert.match(redactSecrets("password=&quot;hunter22&quot; x"), / x$/);
});

test("cycle 10: a list under a credential key is a value, a list under an aria node is not", () => {
  assert.equal(redactSecrets("tokens:\n  - abc\n  - def\nnext: 1"), "tokens:\n  [redacted]\nnext: 1");
  assert.equal(redactSecrets("tokens:\n    - abc"), "tokens:\n    [redacted]");
  const again = redactSecrets("tokens:\n  - abc\n  - def");
  assert.equal(redactSecrets(again), again);
  assert.equal(redactSecrets('- region Cookies:\n    - button "Accept all"'), '- region Cookies:\n    - button "Accept all"');
  assert.equal(redactSecrets('  - region Cookies:\n      - button "Accept all"\n      - link "More"'), '  - region Cookies:\n      - button "Accept all"\n      - link "More"');
});

test("cycle 11: a value after a blank is hidden even when its key is glued to a ? or #, a quote in a query does not end it", () => {
  assert.doesNotMatch(redactSecrets("went to http://h/#password: hunter22 ok"), /hunter22/);
  assert.doesNotMatch(redactSecrets("http://h/p?password: my secret"), /my secret|\bsecret\b/);
  assert.doesNotMatch(redactSecrets("see http://h/p?token='abc99xyz' end"), /abc99xyz/);
  assert.match(redactSecrets("see http://h/p?token='abc99xyz' end"), / end$/);
  assert.doesNotMatch(redactSecrets("err http:\\\\/\\\\/h/p?code=zz88"), /zz88/);
  const once = redactSecrets("a http://h/p?x=1#f b");
  assert.equal(redactSecrets(once), once);
});

test("cycle 11: an HTML-escaped value ends at its own quote kind, an unquoted value with a quote inside runs to the blank", () => {
  assert.doesNotMatch(redactSecrets("password=&quot;it&#39;s hunter&quot; ok"), /hunter|it&#39;s/);
  assert.match(redactSecrets("password=&quot;it&#39;s hunter&quot; ok"), /&quot; ok$/);
  assert.equal(redactSecrets('password=ab"cd ef'), 'password=[redacted] ef');
});

test("cycle 11: status prints no credential from an invalid spec's problem text", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { statusOf, formatStatus } = await import("../src/status.js");
  const { KEY } = await import("./spec-helpers.mjs");
  const dir = await mkdtemp(join(tmpdir(), "proof-status-"));
  try {
    const specPath = join(dir, "s.json");
    await writeFile(specPath, JSON.stringify(page("/fixtures/forms.html", [{ op: "fill password=hunter22", check: "x" }])));
    const result = await statusOf({ dir: join(dir, "none"), key: KEY, specPath });
    assert.equal(result.state, "CANNOT-TELL");
    assert.doesNotMatch(formatStatus(result) + JSON.stringify(result), /hunter22/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cycle 10: HTML-escaped keys and values, single or double, across a line break", () => {
  assert.doesNotMatch(redactSecrets("{&quot;password&quot;:&quot;hunter22&quot;}"), /hunter22/);
  assert.doesNotMatch(redactSecrets("password=&#39;hunter22&#39; x"), /hunter22/);
  assert.doesNotMatch(redactSecrets("password=&quot;hunter\n22&quot;"), /hunter|\n22/);
});

test("cycle 10: an unquoted key=value ends at a blank or an ampersand, an unquoted key: value at the line break", () => {
  assert.match(redactSecrets("password=abc user=bob"), / user=bob$/);
  assert.match(redactSecrets("password=abc&user=bob"), /&user=bob$/);
  const colon = redactSecrets("password: my pass phrase\nnext line");
  assert.doesNotMatch(colon, /pass phrase/);
  assert.match(colon, /\nnext line$/);
  assert.doesNotMatch(redactSecrets('password="my pass phrase" ok'), /pass phrase/);
});

test("cycle 10: a JWT with a short payload, all-caps and acronym-prefixed names", async () => {
  const { scrubValue, isSensitiveStep } = await import("../src/spec/evidence.js");
  assert.doesNotMatch(redactSecrets("eyJhbGciOiJIUzI1NiJ9.e30.c2ln"), /e30|c2ln/);
  assert.doesNotMatch(redactSecrets("dbPASS=hunter22 DBPass=hunter23"), /hunter2/);
  assert.equal(redactSecrets("COMPASS=north"), "COMPASS=north");
  assert.deepEqual(scrubValue({ DBPass: "a1", dbPASS: "b2" }), { DBPass: "[redacted]", dbPASS: "[redacted]" });
  assert.equal(isSensitiveStep({ op: "assertValue", title: "Password" }), true);
  assert.equal(isSensitiveStep({ op: "assertValue", altText: "Secret code" }), true);
});

test("cycle 10: a query or fragment is hidden after a marker, after a long path, and in JSON-escaped slashes", () => {
  const afterMarker = redactSecrets("see http://h/a?[query hidden]&code=abcd1234efgh");
  assert.doesNotMatch(afterMarker, /abcd1234efgh/);
  assert.equal(redactSecrets(afterMarker), afterMarker);
  assert.doesNotMatch(redactSecrets(`http://h/${"a".repeat(5000)}?code=abc`), /code=abc/);
  assert.doesNotMatch(redactSecrets("http:\\/\\/h\\/p?code=xyz99"), /xyz99/);
  assert.doesNotMatch(redactSecrets("http:\\/\\/u:pw99@host"), /pw99/);
  assert.equal(redactSecrets("go http://h/#/r?c=1 now"), "go http://h/#[hash hidden] now");
});

test("cycle 10: a path segment after an empty one is hidden, a host is kept", async () => {
  const { hideAddressText } = await import("../src/spec/evidence.js");
  assert.equal(hideAddressText("http://h//AbC123dEf456GhI789"), "http://h//[hidden]");
  assert.equal(hideAddressText("http://proof-lab-staging-2026.test/x"), "http://proof-lab-staging-2026.test/x");
  assert.equal(hideAddressText("//proof-lab-staging-2026.test/x"), "//proof-lab-staging-2026.test/x");
  assert.doesNotMatch(hideAddressText("http://h/a?[query hidden]&c=zz99"), /zz99/);
});

test("cycle 10: a text that fits is kept whole, and a second cut adds to the first count", async () => {
  const { redactClip, summarizePageErrors } = await import("../src/spec/evidence.js");
  assert.doesNotMatch(redactClip("pw=ab ".repeat(160), 1000), /more characters/);
  const long = redactClip("y".repeat(3000), 1000);
  assert.match(summarizePageErrors([long], new Map([[long, 3000]]))[0], /\[2800 more characters\]$/);
  const grown = redactClip("pw=ab ".repeat(150), 1000);
  assert.match(summarizePageErrors([grown], new Map([[grown, 900]]))[0], /\[700 more characters\]$/);
  const small = redactClip("pw=ab ".repeat(30), 1000);
  assert.equal(summarizePageErrors([small], new Map([[small, 180]]))[0], small, "an original that fits stays whole");
  assert.equal(summarizePageErrors(["short"])[0], "short");
});

test("cycle 10: status of an invalid spec names the spec scrubbed", TIMEOUT, async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { statusOf } = await import("../src/status.js");
  const { KEY } = await import("./spec-helpers.mjs");
  const dir = await mkdtemp(join(tmpdir(), "proof-status-"));
  try {
    const specPath = join(dir, "s.json");
    await writeFile(specPath, JSON.stringify({ name: "Session: hunter22" }));
    const result = await statusOf({ dir: join(dir, "none"), key: KEY, specPath });
    assert.equal(result.state, "CANNOT-TELL");
    assert.doesNotMatch(JSON.stringify(result.spec), /hunter22/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cycle 10: the in-process detail holds the same screenshot as the evidence file", TIMEOUT, async () => {
  const { readFile } = await import("node:fs/promises");
  await withRun(page("/fixtures/forms.html", [{ op: "assertTitle", check: "title check", equals: "nope", timeout: 0 }]), async receipt => {
    const filed = (await readFile(receipt.detail.evidencePath, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line)).find(record => record.type === "screenshot");
    const inProcess = receipt.detail.contexts.find(record => record.type === "screenshot");
    assert.ok(filed && inProcess, explain(receipt));
    assert.equal(inProcess.base64, filed.base64);
  });
});

test("cycle 9b: many http:// and //x: starts in one long run stay fast", () => {
  for (const unit of ["http://", "//x:", "eyJ-", "token:"]) {
    const started = Date.now();
    redactSecrets(unit.repeat(Math.ceil(120000 / unit.length)));
    assert.ok(Date.now() - started < 4000, `${unit} repeated took ${Date.now() - started} ms`);
  }
});

test("redactSecrets: a quoted address keeps its own closing quote and what follows it", () => {
  assert.equal(redactSecrets('{"url":"https://h/x?page=2","status":503}').endsWith('","status":503}'), true);
  assert.equal(redactSecrets("go 'https://h/x?a=1' now"), "go 'https://h/x?[query hidden]' now");
  assert.equal(redactSecrets("x https://h/x?token='abc' y").includes("abc"), false);
});

test("redactSecrets: an unindented list under a credential key is masked; mixed entity quotes end the value", () => {
  assert.equal(redactSecrets("tokens:\n- abc\n- def").includes("abc"), false);
  assert.equal(redactSecrets("password=&#34;abc&quot; next").endsWith(" next"), true);
  assert.equal(redactSecrets("password=&#34;abc&quot; next").includes("abc"), false);
});

test("redactSecrets: a cut note survives every later scrub, so scrubbing is idempotent", () => {
  const cut = `Session: ${"a b ".repeat(400)}... [1509 more characters]`;
  const once = redactSecrets(cut);
  assert.equal(once.endsWith("... [1509 more characters]"), true);
  assert.equal(redactSecrets(once), once);
});

test("redactSecrets: userinfo password is hidden, a port is not, and a hostile run stays fast", () => {
  assert.equal(redactSecrets("see //u:pw@host/x"), "see //u:[redacted]@host/x");
  assert.equal(redactSecrets("//host:8080/path@v2"), "//host:8080/path@v2");
  const started = Date.now();
  redactSecrets("//a:".repeat(250000));
  redactSecrets("//a:".repeat(60000) + "@".repeat(60000));
  assert.equal(Date.now() - started < 3000, true);
});

test("redactSecrets: a quoted address with a blank in its query ends at its own quote", () => {
  assert.equal(redactSecrets('{"url":"https://h/x?q=hello world"}'), '{"url":"https://h/x?[query hidden]"}');
  assert.equal(redactSecrets("{'u':'https://h/x?q=hello world','n':1}"), "{'u':'https://h/x?[query hidden]','n':1}");
  const once = redactSecrets('{"url":"https://h/x?q=hello world"}');
  assert.equal(redactSecrets(once), once);
});

test("redactSecrets: a password that begins with digits is masked before ? or #; a port before / is kept", () => {
  assert.equal(redactSecrets("https://u:1234?x@h/").includes("1234"), false);
  assert.equal(redactSecrets("https://u:99#x@h/").includes("99#"), false);
  assert.equal(redactSecrets("https://u:123@h/").includes("123"), false);
  assert.equal(redactSecrets("//host:8080/path@v2"), "//host:8080/path@v2");
});

test("redactSecrets: ports in escaped and JSON text are kept, a quote inside a quoted query does not end it, a long password scrubs the same twice", () => {
  const escaped = redactSecrets("http:\/\/localhost:4173\/?email=a@b.com");
  assert.equal(escaped.includes("4173"), true);
  assert.equal(escaped.includes("a@b.com"), false);
  const json = redactSecrets('{"url":"http://localhost:4173","email":"a@b.com"}');
  assert.equal(json.includes("4173"), true);
  assert.equal(json.includes('"email"'), true);
  assert.equal(redactSecrets('"https://h/x?a="b"'), '"https://h/x?[query hidden]"');
  assert.equal(redactSecrets("'https://h/x?a='b'"), "'https://h/x?[query hidden]'");
  const long = `//u:${"a".repeat(1900)}@${"b".repeat(200)}@host`;
  assert.equal(redactSecrets(redactSecrets(long)), redactSecrets(long));
  assert.equal(redactSecrets(long), "//u:[redacted]@host");
});

test("redactSecrets: text after a quoted address is kept; an unclosed quote hides only the query", () => {
  assert.equal(redactSecrets('Could not load "https://h/x?q=1". Retrying in 5 s'), 'Could not load "https://h/x?[query hidden]". Retrying in 5 s');
  assert.equal(redactSecrets('<img src="https://h/x.png?v=1">logo</p>'), '<img src="https://h/x.png?[query hidden]">logo</p>');
  assert.equal(redactSecrets("Navigation to 'https://h/x?a=1 failed: timeout"), "Navigation to 'https://h/x?[query hidden] failed: timeout");
  assert.equal(redactSecrets('{"url":"https://h/x?q=hello world","n":1}'), '{"url":"https://h/x?[query hidden]","n":1}');
  assert.equal(redactSecrets('"https://h/x?a="b"'), '"https://h/x?[query hidden]"');
});

test("scrubStatus: the receipt path is kept, other fields are scrubbed", async () => {
  const { scrubStatus } = await import("../src/status.js");
  const name = "2026-10-19T10-00-00-000000000Z-0123456789ab.json";
  const shown = scrubStatus({ receiptFile: `D:/receipts/${name}`, advice: ["password=hunter2 next"] });
  assert.equal(shown.receiptFile, `D:/receipts/${name}`);
  assert.equal(shown.advice[0].includes("hunter2"), false);
  // a credential-shaped directory is scrubbed; the file name the lab wrote stays intact
  const hidden = scrubStatus({ receiptFile: `D:/runs/password=hunter2/${name}` });
  assert.equal(hidden.receiptFile.includes("hunter2"), false);
  assert.equal(hidden.receiptFile.endsWith(`/${name}`), true);
});

test("scrubStatus: a renamed receipt file is scrubbed; only the lab's own name shape is kept", async () => {
  const { scrubStatus } = await import("../src/status.js");
  const renamed = scrubStatus({ receiptFile: "D:/receipts/token=hunter2.json" });
  assert.equal(renamed.receiptFile.includes("hunter2"), false);
  assert.equal(renamed.receiptFile.startsWith("D:/receipts/"), true);
  // a run joined by "/" is judged whole: a long non-lab name in a long directory is hidden, not split and passed through
  const joined = scrubStatus({ receiptFile: "D:/receipts/Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr/St0Uv1Wx2Yz3Ab4Cd5Ef6Gh.json" });
  assert.equal(joined.receiptFile.includes("St0Uv1"), false);
  // the lab's shape is exact: a 32-digit stamp is not the lab's name and its hex run is redacted
  const longStamp = scrubStatus({ receiptFile: "D:/receipts/000000000000000000000000000000000Z-unknown.json" });
  assert.equal(longStamp.receiptFile.includes("000000000000000000000000000000000Z"), false);
  // a bare drive letter with a lab name keeps the name intact
  const bare = scrubStatus({ receiptFile: "D:2026-10-19T10-00-00-000000000Z-0123456789ab.json" });
  assert.equal(bare.receiptFile, "D:2026-10-19T10-00-00-000000000Z-0123456789ab.json");
  // the picture and evidence files the lab writes under the same stem keep their names too; a foreign suffix does not
  for (const suffix of [".png", ".evidence.jsonl"]) {
    const sibling = scrubStatus({ receiptFile: `D:/receipts/2026-10-19T10-00-00-000000000Z-0123456789ab${suffix}` });
    assert.equal(sibling.receiptFile, `D:/receipts/2026-10-19T10-00-00-000000000Z-0123456789ab${suffix}`);
  }
  const foreign = scrubStatus({ receiptFile: "D:/receipts/token=hunter2/2026-10-19T10-00-00-000000000Z-0123456789ab.pdf" });
  assert.equal(foreign.receiptFile.includes("hunter2"), false);
});

test("redactSecrets: a quote inside a quoted address query stays in the query when a letter follows it", () => {
  assert.equal(redactSecrets(`"https://h/x?a=1 b"c d"`), `"https://h/x?[query hidden]"`);
  assert.equal(redactSecrets(`Could not load "https://h/x?q=1". Retrying in 5 s`), `Could not load "https://h/x?[query hidden]". Retrying in 5 s`);
});
