import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSpec } from "../src/run-spec.js";
import { redactSecrets } from "../src/spec/evidence.js";
import { hideQuery } from "../src/spec/expect.js";
import { TIMEOUT, explain, failedChecks, page, runInline } from "./spec-helpers.mjs";

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
    ['{\\"token\\":\\"abc def\\"}', '{\\"token\\":\\"[redacted]"}'],
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
  assert.ok(performance.now() - started < 2000, "linear-time redaction");
});

test("hideQuery: a token in the path is hidden too", () => {
  assert.equal(hideQuery("http://h.test/reset/a1b2c3d4e5f6g7h8i9j0/confirm"), "http://h.test/reset/[hidden]/confirm");
  assert.equal(hideQuery("http://h.test/items/12345"), "http://h.test/items/12345");
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
