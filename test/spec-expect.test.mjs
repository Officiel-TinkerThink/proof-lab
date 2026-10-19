import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSpec } from "../src/run-spec.js";
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
  const pageA = { name: "a" };
  const pageB = { name: "b" };
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
