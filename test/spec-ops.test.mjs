import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSpec } from "../src/run-spec.js";
import { OPS, TARGET_FIELDS } from "../src/spec/schema.js";
import { TIMEOUT, explain, failedChecks, page, runInline } from "./spec-helpers.mjs";

const testId = (id, rest) => ({ testId: id, ...rest });

test("no op field shares a name with a target field or a common field", () => {
  const reserved = new Set([...Object.keys(TARGET_FIELDS), "op", "check", "name", "hint", "timeout", "optional", "not"]);
  const clashes = [];
  for (const [op, definition] of Object.entries(OPS)) {
    for (const field of Object.keys(definition.fields)) {
      // goto's url and the like are fine; only a clash with a name the step already uses elsewhere is a defect.
      if (reserved.has(field)) clashes.push(`${op}.${field}`);
    }
  }
  assert.deepEqual(clashes, []);
});

test("validateSpec rejects unknown fields so a typo cannot hide", () => {
  const problems = validateSpec({
    name: "x",
    steps: [{ op: "assertText", selector: "#a", equal: "x" }, { op: "click", selector: "#a", colour: "red" }],
  });
  assert.ok(problems.some(problem => problem.includes('unknown field "equal"')), problems.join("; "));
  assert.ok(problems.some(problem => problem.includes('unknown field "colour"')), problems.join("; "));
});

test("validateSpec checks targets, one-of rules and patterns", () => {
  const problems = validateSpec({
    name: "x",
    steps: [
      { op: "click" },
      { op: "click", role: "button", selector: "#a" },
      { op: "assertText", selector: "#a" },
      { op: "assertText", selector: "#a", equals: "x", contains: "y" },
      { op: "assertText", selector: "#a", matches: "(" },
      { op: "assertCount", selector: "li" },
      { op: "assertText", selector: "#a", equals: "x", optional: true },
      { op: "dragTo", selector: "#a", to: {} },
    ],
  });
  const text = problems.join("\n");
  assert.match(text, /steps\[0\] \(click\) needs a target/);
  assert.match(text, /steps\[1\] \(click\) has more than one target/);
  assert.match(text, /steps\[2\] \(assertText\) needs exactly one of equals, contains, matches/);
  assert.match(text, /steps\[3\] \(assertText\) needs exactly one of/);
  assert.match(text, /steps\[4\] \(assertText\)\.matches is not a valid regular expression/);
  assert.match(text, /steps\[5\] \(assertCount\) needs at least one of count, min, max/);
  assert.match(text, /steps\[6\] \(assertText\): an assertion cannot be optional/);
  assert.match(text, /steps\[7\] \(dragTo\)\.to needs a target/);
});

test("form controls: text, choice, date, file, validation, submit and reset", TIMEOUT, async () => {
  const receipt = await runInline(page("/fixtures/forms.html", [
    { op: "fill", label: "Name", value: "Ada" },
    { op: "assertValue", check: "text input", label: "Name", equals: "Ada" },
    { op: "fill", label: "Bio", value: "line1\nline2" },
    { op: "assertValue", check: "textarea", label: "Bio", equals: "line1\nline2" },
    { op: "fill", label: "Password", value: "s3cret" },
    { op: "assertValue", check: "password", label: "Password", equals: "s3cret" },
    { op: "fill", label: "Age", value: "36" },
    { op: "assertValue", check: "number", label: "Age", equals: "36" },
    { op: "check", label: "Subscribe" },
    { op: "assertState", check: "checkbox checked", label: "Subscribe", state: "checked" },
    { op: "uncheck", label: "Subscribe" },
    { op: "assertState", check: "checkbox unchecked", label: "Subscribe", state: "unchecked" },
    { op: "check", label: "Pro" },
    { op: "assertState", check: "radio chosen", label: "Pro", state: "checked" },
    { op: "assertState", check: "other radio not chosen", label: "Free", state: "unchecked" },
    { op: "selectOption", label: "Country", byValue: "NL" },
    { op: "assertValue", check: "select by value", label: "Country", equals: "NL" },
    { op: "selectOption", label: "Country", byIndex: 1 },
    { op: "assertValue", check: "select by index", label: "Country", equals: "ID" },
    { op: "selectOption", label: "Country", byLabel: "United States" },
    { op: "assertValue", check: "select by label", label: "Country", equals: "US" },
    { op: "selectOption", label: "Tags", byValue: ["a", "c"] },
    { op: "assertValues", check: "multi-select", label: "Tags", equals: ["a", "c"] },
    { op: "fill", label: "Birthday", value: "2020-02-02" },
    { op: "assertValue", check: "date", label: "Birthday", equals: "2020-02-02" },
    { op: "fill", label: "Alarm", value: "13:15" },
    { op: "assertValue", check: "time", label: "Alarm", equals: "13:15" },
    { op: "fill", label: "Meeting", value: "2020-03-02T05:15" },
    { op: "assertValue", check: "datetime-local", label: "Meeting", equals: "2020-03-02T05:15" },
    { op: "fill", label: "Theme color", value: "#ff0000" },
    { op: "assertValue", check: "color", label: "Theme color", equals: "#ff0000" },
    { op: "fill", label: "Volume", value: "8" },
    { op: "assertText", check: "range fires input", ...testId("volume-out", {}), equals: "8" },
    { op: "setInputFiles", label: "Avatar", files: [{ name: "a.txt", mimeType: "text/plain", text: "hi" }] },
    { op: "assertText", check: "file chosen", ...testId("avatar-name", {}), equals: "a.txt" },
    { op: "setInputFiles", label: "Avatar", files: [] },
    { op: "assertText", check: "file cleared", ...testId("avatar-name", {}), equals: "none" },
    { op: "assertState", check: "disabled input", label: "Locked", state: "disabled" },
    { op: "assertState", check: "readonly input is not editable", label: "Reference", state: "editable", not: true },
    { op: "fill", role: "textbox", name: "Notes", value: "my notes" },
    { op: "assertText", check: "contenteditable", role: "textbox", name: "Notes", equals: "my notes" },

    { op: "click", role: "button", name: "Send" },
    { op: "assertText", check: "invalid form is not submitted", ...testId("result", {}), equals: "not submitted" },
    { op: "assertProperty", check: "required field reports valueMissing", label: "Contact email", property: "validity.valueMissing", equals: true },
    { op: "fill", label: "Contact email", value: "not-an-email" },
    { op: "assertProperty", check: "email reports typeMismatch", label: "Contact email", property: "validity.typeMismatch", equals: true },
    { op: "fill", label: "Contact email", value: "ada@example.test" },
    { op: "click", role: "button", name: "Send" },
    { op: "assertText", check: "valid form submits", ...testId("result", {}), contains: "\"plan\":\"pro\"" },
    { op: "assertText", check: "multi-select submitted as list", ...testId("result", {}), contains: "\"tags\":[\"a\",\"c\"]" },
    { op: "fill", label: "Name", value: "Bob" },
    { op: "press", label: "Name", key: "Enter" },
    { op: "assertText", check: "Enter submits", ...testId("result", {}), contains: "\"name\":\"Bob\"" },
    { op: "click", role: "button", name: "Reset" },
    { op: "assertText", check: "reset clears the result", ...testId("result", {}), equals: "not submitted" },
    { op: "assertValue", check: "reset clears fields", label: "Name", equals: "" },
  ]));
  assert.equal(receipt.verdict, "PASS", explain(receipt));
});

test("keyboard and mouse: click variants, hover, keys, focus order, drag, scroll", TIMEOUT, async () => {
  const receipt = await runInline(page("/fixtures/interact.html", [
    { op: "click", role: "button", name: "Click me" },
    { op: "assertText", check: "click", ...testId("clicks", {}), equals: "1" },
    { op: "dblclick", role: "button", name: "Double target" },
    { op: "assertText", check: "double click", ...testId("dblclicks", {}), equals: "1" },
    { op: "click", selector: "#ctx", button: "right" },
    { op: "assertText", check: "right click opens the menu", ...testId("ctx-state", {}), equals: "open" },
    { op: "click", selector: "h1" },
    { op: "assertText", check: "click elsewhere closes it", ...testId("ctx-state", {}), equals: "closed" },
    { op: "hover", selector: "#hover" },
    { op: "assertText", check: "hover", ...testId("hover-state", {}), equals: "hovered" },
    { op: "press", label: "Key logger", key: "Control+a" },
    { op: "assertText", check: "key name", ...testId("last-key", {}), equals: "a" },
    { op: "assertText", check: "modifier held", ...testId("last-mods", {}), equals: "Control" },
    { op: "focus", label: "First" },
    { op: "assertState", check: "focused", label: "First", state: "focused" },
    { op: "press", key: "Tab" },
    { op: "assertText", check: "tab moves focus on", ...testId("focused", {}), equals: "t2" },
    { op: "press", key: "Tab" },
    { op: "press", key: "Shift+Tab" },
    { op: "assertText", check: "shift+tab moves focus back", ...testId("focused", {}), equals: "t2" },
    { op: "click", selector: "#mod", modifiers: ["Shift"] },
    { op: "assertText", check: "modifier click", ...testId("mod-state", {}), equals: "Shift" },
    { op: "dragTo", selector: "#drag", to: { selector: "#drop" }, html5: true },
    { op: "assertText", check: "drag and drop", ...testId("drop-state", {}), equals: "dropped" },
    { op: "assertCount", check: "list length", selector: "#list li", count: 40 },
    { op: "scroll", selector: "#scroller", y: 100 },
    { op: "assertText", check: "element scrolled", ...testId("scroll-top", {}), equals: "100" },
    { op: "scrollIntoView", role: "button", name: "Far button" },
    { op: "click", role: "button", name: "Far button" },
    { op: "assertText", check: "far button clicked", ...testId("far-state", {}), equals: "clicked" },
  ]));
  assert.equal(receipt.verdict, "PASS", explain(receipt));
});

test("timing: assertions and waits follow slow pages; timeout 0 reads once", TIMEOUT, async () => {
  const receipt = await runInline(page("/fixtures/timing.html", [
    { op: "click", role: "button", name: "Start" },
    { op: "assertText", check: "loading shows", ...testId("state", {}), equals: "loading" },
    { op: "waitFor", selector: "#spinner", state: "hidden" },
    { op: "assertText", check: "ready after the wait", ...testId("state", {}), equals: "ready" },
    { op: "assertCount", check: "results", selector: "#results li", count: 2 },
    { op: "fill", label: "Search", value: "abc" },
    { op: "assertText", check: "debounced text arrives", ...testId("debounced", {}), equals: "abc" },
    { op: "assertText", check: "lazily attached element", ...testId("lazy", {}), equals: "lazy loaded" },
    { op: "assertCss", check: "fade finished", ...testId("fade", {}), property: "opacity", equals: "1" },
    { op: "assertVisible", check: "spinner is gone", selector: "#spinner", visible: false },
  ]));
  assert.equal(receipt.verdict, "PASS", explain(receipt));

  const oneShot = await runInline(page("/fixtures/timing.html", [
    { op: "fill", label: "Search", value: "abc" },
    { op: "assertText", check: "read once, before the debounce", ...testId("debounced", {}), equals: "abc", timeout: 0 },
  ]));
  assert.equal(oneShot.verdict, "FAIL");
  assert.deepEqual(failedChecks(oneShot).map(check => check.actual), ["none"]);
});

test("navigation: links, history, hash and query routes, status, redirect", TIMEOUT, async () => {
  const receipt = await runInline(page("/fixtures/nav.html", [
    { op: "assertTitle", check: "start page title", equals: "Fixture: navigation" },
    { op: "click", role: "link", name: "Go to page B" },
    { op: "assertUrl", check: "link navigated", contains: "/fixtures/nav-b.html" },
    { op: "assertTitle", check: "page B title", equals: "Page B" },
    { op: "back" },
    { op: "assertTitle", check: "back", equals: "Fixture: navigation" },
    { op: "forward" },
    { op: "assertTitle", check: "forward", equals: "Page B" },
    { op: "goto", url: "/fixtures/nav.html" },
    { op: "click", role: "link", name: "Route one" },
    { op: "assertText", check: "hash route one", ...testId("route", {}), equals: "#/one" },
    { op: "click", role: "link", name: "Route two" },
    { op: "assertText", check: "hash route two", ...testId("route", {}), equals: "#/two" },
    { op: "back" },
    { op: "assertText", check: "back to route one", ...testId("route", {}), equals: "#/one" },
    { op: "click", role: "button", name: "Push state" },
    { op: "assertText", check: "pushState step", ...testId("step", {}), equals: "1" },
    { op: "assertUrl", check: "pushState url", matches: "\\?step=1$" },
    { op: "goto", check: "missing page is a 404", url: "/api/status/404", status: 404 },
    { op: "goto", check: "broken page is a 500", url: "/api/status/500", status: 500 },
    { op: "goto", url: "/api/redirect" },
    { op: "assertUrl", check: "redirect lands on page B", contains: "/fixtures/nav-b.html" },
    { op: "goto", url: "/fixtures/nav.html" },
    { op: "assertAttribute", check: "mailto link", role: "link", name: "Email Ada", attribute: "href", equals: "mailto:ada@example.test" },
    { op: "waitForUrl", contains: "/fixtures/nav.html" },
  ]));
  assert.equal(receipt.verdict, "PASS", explain(receipt));
});

test("frames and shadow DOM: iframe fields, nested content, open and closed roots", TIMEOUT, async () => {
  const receipt = await runInline(page("/fixtures/frames.html", [
    { op: "fill", label: "Frame field", frame: "#inline", value: "hello" },
    { op: "click", role: "button", name: "Echo", frame: "#inline" },
    { op: "assertText", check: "srcdoc iframe", selector: "#out", frame: "#inline", equals: "hello" },
    { op: "assertText", check: "iframe with a page", selector: "h1", frame: "#child", equals: "Page B" },
    { op: "click", role: "button", name: "Shadow button" },
    { op: "assertText", check: "open shadow root is pierced", ...testId("shadow-out", {}), equals: "clicked" },
    { op: "assertCount", check: "closed shadow root is not reachable", role: "button", name: "Closed button", count: 0 },
  ]));
  assert.equal(receipt.verdict, "PASS", explain(receipt));
});

test("ARIA state: expanded, live region, dialog focus and Escape", TIMEOUT, async () => {
  const receipt = await runInline(page("/fixtures/a11y.html", [
    { op: "assertAttribute", check: "collapsed", role: "button", name: "Details", attribute: "aria-expanded", equals: "false" },
    { op: "click", role: "button", name: "Details" },
    { op: "assertAttribute", check: "expanded", role: "button", name: "Details", attribute: "aria-expanded", equals: "true" },
    { op: "assertVisible", check: "panel shows", selector: "#panel" },
    { op: "click", role: "button", name: "Details" },
    { op: "assertVisible", check: "panel hides", selector: "#panel", visible: false },
    { op: "click", role: "button", name: "Announce" },
    { op: "assertText", check: "live region announces", role: "status", equals: "Saved" },
    { op: "click", role: "button", name: "Open dialog" },
    { op: "assertVisible", check: "dialog opens", role: "dialog", name: "Confirm" },
    { op: "assertState", check: "focus moves into the dialog", role: "button", name: "Close", state: "focused" },
    { op: "press", key: "Escape" },
    { op: "assertVisible", check: "Escape closes it", role: "dialog", name: "Confirm", visible: false },
    { op: "assertState", check: "focus returns to the opener", role: "button", name: "Open dialog", state: "focused" },
  ]));
  assert.equal(receipt.verdict, "PASS", explain(receipt));
});

test("failure paths: wrong text, ambiguous target, missing element, optional step, not", TIMEOUT, async () => {
  const receipt = await runInline(page("/fixtures/forms.html", [
    { op: "assertText", check: "wrong text", ...testId("result", {}), equals: "something else", timeout: 100, hint: "result should change" },
    { op: "click", check: "ambiguous button", role: "button" },
    { op: "click", check: "missing element", selector: "#no-such", timeout: 200 },
    { op: "click", selector: "#no-such-either", optional: true, timeout: 200 },
    { op: "assertText", check: "not equals passes", ...testId("result", {}), equals: "something else", not: true },
  ]));
  assert.equal(receipt.verdict, "FAIL", explain(receipt));
  const failed = failedChecks(receipt);
  assert.deepEqual(failed.map(check => check.name), ["wrong text", "ambiguous button", "missing element"]);
  assert.equal(failed[0].actual, "not submitted");
  assert.equal(failed[0].hint, "result should change");
  assert.match(failed[1].error, /strict mode violation/i);
  // The receipt keeps failed checks only; the passing one is in the evidence detail.
  assert.ok(receipt.detail.checks.find(check => check.name === "not equals passes").pass);
  assert.equal(receipt.totals.checks, 5 - 1); // the optional step recorded nothing
  assert.equal(receipt.totals.failed, 3);
});

test("content assertions fail on a missing element, with or without not", TIMEOUT, async () => {
  const receipt = await runInline(page("/fixtures/forms.html", [
    { op: "assertText", check: "typo in the selector, not equals", ...testId("no-such", {}), equals: "error", not: true, timeout: 200 },
    { op: "assertValue", check: "typo in the label, not equals", label: "No such field", equals: "x", not: true, timeout: 200 },
    { op: "assertState", check: "typo, not enabled", label: "No such field", state: "enabled", not: true, timeout: 200 },
    { op: "assertVisible", check: "absent element is not visible", selector: "#no-such", visible: false },
    { op: "assertState", check: "absent element is detached", selector: "#no-such", state: "detached" },
    { op: "assertCount", check: "absent element has count 0", selector: "#no-such", count: 0 },
  ]));
  assert.equal(receipt.verdict, "FAIL");
  assert.deepEqual(failedChecks(receipt).map(check => check.name), [
    "typo in the selector, not equals", "typo in the label, not equals", "typo, not enabled",
  ]);
  for (const check of failedChecks(receipt)) assert.equal(check.error, "element not found");
});

test("multi-select ignores order, absent:false means present, optional steps leave no failed check", TIMEOUT, async () => {
  const receipt = await runInline(page("/fixtures/forms.html", [
    { op: "selectOption", label: "Tags", byValue: ["c", "a"] },
    { op: "assertValues", check: "same set, other order", label: "Tags", equals: ["a", "c"] },
    { op: "assertAttribute", check: "readonly is present", label: "Reference", attribute: "readonly", absent: false },
    { op: "assertAttribute", check: "no such attribute is absent", label: "Reference", attribute: "data-nope", absent: true },
    { op: "assertAttribute", check: "no such attribute is not present", label: "Reference", attribute: "data-nope", absent: false, not: true },
    { op: "goto", url: "/api/status/404", status: 200, optional: true },
    { op: "goto", url: "/fixtures/forms.html" },
    { op: "assertTitle", check: "back on the form", equals: "Fixture: forms" },
  ]));
  assert.equal(receipt.verdict, "PASS", explain(receipt));
  assert.deepEqual(receipt.checks, []);
});

test("assertStorage and assertProperty compare objects by content, not key order", TIMEOUT, async () => {
  const receipt = await runInline(page("/fixtures/storage.html", [
    { op: "click", role: "button", name: "Save prefs" },
    { op: "assertStorage", check: "object in another key order", key: "prefs", equals: { theme: "dark", density: "compact" } },
    { op: "assertStorage", check: "one field of the object", key: "prefs", path: "theme", equals: "dark" },
    { op: "assertStorage", check: "key exists", key: "prefs", exists: true },
    { op: "assertStorage", check: "other key does not exist", key: "no-such-key", exists: false },
    { op: "assertStorage", check: "session storage is separate", area: "session", key: "prefs", exists: false },
  ]));
  assert.equal(receipt.verdict, "PASS", explain(receipt));
});

test("a start path that redirects does not raise a false 'app changed' error", TIMEOUT, async () => {
  const receipt = await runInline({
    name: "redirect-start",
    app: { start: "/api/redirect?to=/fixtures/nav-b.html" },
    steps: [{ op: "assertTitle", check: "landed on page B", equals: "Page B" }],
  });
  assert.equal(receipt.verdict, "PASS", explain(receipt));
  assert.match(receipt.revision, /^[0-9a-f]{12}$/);
});

const problemsOf = steps => validateSpec({ name: "x", steps }).join("\n");

test("validateSpec: prototype keys and odd shapes are problems, never exceptions", () => {
  const spec = JSON.parse('{"name":"x","constructor":1,"__proto__":2,"steps":[{"op":"back","toString":1,"__proto__":1,"constructor":3}]}');
  let problems;
  assert.doesNotThrow(() => { problems = validateSpec(spec).join("\n"); });
  assert.match(problems, /spec has unknown field "constructor"/);
  assert.match(problems, /steps\[0\] \(back\) has unknown field "toString"/);
  assert.match(problems, /steps\[0\] \(back\) has unknown field "constructor"/);
  assert.match(problemsOf([{ op: ["goto"], url: "/" }]), /steps\[0\]\.op must be a string/);
  assert.match(problemsOf(["click"]), /steps\[0\] must be an object/);
  assert.match(validateSpec([]).join("\n"), /spec must be a JSON object/);
  assert.match(validateSpec({ name: "x", steps: [] }).join("\n"), /steps must be a non-empty array/);
});

test("validateSpec: nested dragTo target follows the target rules", () => {
  const text = problemsOf([
    { op: "dragTo", selector: "#a", to: { role: "listitem", testId: "x" } },
    { op: "dragTo", selector: "#a", to: { testId: "x", hasTxt: "Done" } },
    { op: "dragTo", selector: "#a", to: { role: 5 } },
    { op: "dragTo", selector: "#a", to: { selector: "#b", checked: true } },
    { op: "dragTo", selector: "#a", to: { selector: "#b", name: "x" } },
  ]);
  assert.match(text, /steps\[0\] \(dragTo\)\.to has more than one target/);
  assert.match(text, /steps\[1\] \(dragTo\)\.to has unknown field "hasTxt"/);
  assert.match(text, /steps\[2\] \(dragTo\)\.to\.role must be string/);
  assert.match(text, /steps\[3\] \(dragTo\)\.to: checked apply to a role target only/);
  assert.match(text, /steps\[4\] \(dragTo\)\.to: name applies to a role target only/);
});

test("validateSpec: timeouts, targets and frames", () => {
  const text = problemsOf([
    { op: "click", role: "button", timeout: 0 },
    { op: "goto", url: "/", timeout: 0 },
    { op: "assertText", selector: "#a", equals: "x", timeout: -1 },
    { op: "press", key: "Enter", frame: "#f" },
    { op: "scroll", y: 10, frame: "#f" },
    { op: "assertVisible", label: "Remember me", checked: true },
  ]);
  assert.match(text, /steps\[0\] \(click\)\.timeout must be at least 1 ms/);
  assert.match(text, /steps\[1\] \(goto\)\.timeout must be at least 1 ms/);
  assert.match(text, /steps\[2\] \(assertText\)\.timeout must not be negative/);
  assert.match(text, /steps\[3\] \(press\): frame needs a target/);
  assert.match(text, /steps\[4\] \(scroll\): frame needs a target/);
  assert.match(text, /steps\[5\] \(assertVisible\): checked apply to a role target only/);
  assert.equal(problemsOf([{ op: "assertText", selector: "#a", equals: "x", timeout: 0 }]), "");
  assert.equal(problemsOf([{ op: "assertVisible", role: "checkbox", name: "Remember me", checked: true }]), "");
});

test("validateSpec: numbers, lists and patterns", () => {
  const text = problemsOf([
    { op: "assertCount", selector: "li", count: -1 },
    { op: "assertCount", selector: "li", count: 1.5 },
    { op: "assertCount", selector: "li", min: 3, max: 2 },
    { op: "assertCount", selector: "li", count: 2, min: 1 },
    { op: "assertCount", selector: "li", count: 2, nth: 0 },
    { op: "press", key: "  " },
    { op: "click", selector: "#a", clickCount: 0 },
    { op: "click", selector: "#a", position: { x: 1 } },
    { op: "click", selector: "#a", modifiers: ["Hyper"] },
    { op: "selectOption", selector: "#s", byIndex: [0, 1.5] },
    { op: "selectOption", selector: "#s", byValue: [] },
    { op: "assertText", selector: "#a", matches: "x", flags: "g" },
    { op: "assertText", selector: "#a", equals: "x", flags: "i" },
    { op: "assertText", selector: "#a", matches: "x", flags: "iy" },
    { op: "goto", url: " " },
    { op: "goto", url: "/", status: 99 },
    { op: "click", selector: "#a", frame: ["#f", 5] },
  ]);
  assert.match(text, /steps\[0\] \(assertCount\)\.count must be 0 or more/);
  assert.match(text, /steps\[1\] \(assertCount\)\.count must be integer/);
  assert.match(text, /steps\[2\] \(assertCount\)\.min must not exceed max/);
  assert.match(text, /steps\[3\] \(assertCount\) cannot combine "count" with "min"/);
  assert.match(text, /steps\[4\] \(assertCount\) cannot use "nth"/);
  assert.match(text, /steps\[5\] \(press\)\.key must not be empty/);
  assert.match(text, /steps\[6\] \(click\)\.clickCount must be 1 or more/);
  assert.match(text, /steps\[7\] \(click\)\.position needs x and y/);
  assert.match(text, /steps\[8\] \(click\)\.modifiers must each be one of/);
  assert.match(text, /steps\[9\] \(selectOption\)\.byIndex\[1\] must be integer/);
  assert.match(text, /steps\[10\] \(selectOption\)\.byValue must not be an empty list/);
  assert.match(text, /steps\[11\] \(assertText\)\.flags may only use d, i, m, s, u, v/);
  assert.match(text, /steps\[12\] \(assertText\)\.flags only applies with matches/);
  assert.match(text, /steps\[13\] \(assertText\)\.flags may only use/);
  assert.match(text, /steps\[14\] \(goto\)\.url must not be empty/);
  assert.match(text, /steps\[15\] \(goto\)\.status must be from 100 to 599/);
  assert.match(text, /steps\[16\] \(click\)\.frame\[1\] must be string/);
  assert.equal(problemsOf([{ op: "assertText", selector: "#a", matches: "x", flags: "i" }]), "");
});

test("validateSpec: a refinement without a target is an error, not a silent drop", () => {
  const text = problemsOf([
    { op: "press", key: "Enter", nth: 2 },
    { op: "scroll", y: 300, hasText: "Results" },
    { op: "press", key: "Enter", exact: false },
    { op: "press", key: "Enter", frame: "#f" },
  ]);
  assert.match(text, /steps\[0\] \(press\): nth needs a target/);
  assert.match(text, /steps\[1\] \(scroll\): hasText needs a target/);
  assert.match(text, /steps\[2\] \(press\): exact needs a target/);
  assert.match(text, /steps\[3\] \(press\): frame needs a target/);
  assert.equal(problemsOf([{ op: "press", key: "Enter", selector: "#a", nth: 1 }, { op: "assertUrl", contains: "/" }]), "");
});

test("validateSpec: storage assertions, option lists, indexes and step timeouts", () => {
  const text = problemsOf([
    { op: "assertStorage", key: "session", path: "user.role", exists: true },
    { op: "assertValues", selector: "#s", equals: [1, 2] },
    { op: "selectOption", selector: "#s", byIndex: -1 },
    { op: "selectOption", selector: "#s", byIndex: [0, -2] },
    { op: "click", selector: "#a", timeout: 600001 },
    { op: "assertText", selector: "#a", equals: "x", timeout: 600001 },
  ]);
  assert.match(text, /steps\[0\] \(assertStorage\) cannot combine "exists" with "path"/);
  assert.match(text, /steps\[1\] \(assertValues\)\.equals\[0\] must be string/);
  assert.match(text, /steps\[2\] \(selectOption\)\.byIndex must be 0 or more/);
  assert.match(text, /steps\[3\] \(selectOption\)\.byIndex\[1\] must be 0 or more/);
  assert.match(text, /steps\[4\] \(click\)\.timeout must be at most 600000/);
  assert.match(text, /steps\[5\] \(assertText\)\.timeout must be at most 600000/);
  assert.equal(problemsOf([{ op: "assertStorage", key: "k", path: "a.b", equals: 1 }]), "");
  assert.equal(problemsOf([{ op: "assertValues", selector: "#s", equals: ["a", "b"] }]), "");
});

test("validateSpec: names are checked as written, in characters; the d flag is allowed", () => {
  const named = name => validateSpec({ name, steps: [{ op: "assertUrl", contains: "/" }] }).join("\n");
  const bad = /name must be 1 to 100 characters, with no control characters and no leading or trailing space/;
  for (const name of ["Checkout\n", "Checkout\t", " Checkout", "Checkout ", "\u007fCheckout", "Check\u0085out", "a\u0000b", "", "x".repeat(101)]) {
    assert.match(named(name), bad, JSON.stringify(name));
  }
  assert.equal(named("x".repeat(100)), "");
  assert.equal(named("😀".repeat(100)), "", "100 characters, though 200 UTF-16 code units");
  assert.equal(named("Checkout flow, step 2"), "");
  assert.equal(problemsOf([{ op: "assertText", selector: "#a", matches: "ok", flags: "d" }]), "");
});

test("validateSpec: file entries, app settings, names and assertion-less specs", () => {
  const text = problemsOf([
    { op: "setInputFiles", selector: "#f", files: [42, "", { text: "x" }, { name: "a", mimetype: "x" }, { name: "b", text: "t", base64: "dA==" }] },
  ]);
  assert.match(text, /steps\[0\] \(setInputFiles\)\.files\[0\] must be a path or an object with a name/);
  assert.match(text, /\.files\[1\] must not be empty/);
  assert.match(text, /\.files\[2\] needs a name/);
  assert.match(text, /\.files\[3\] has unknown field "mimetype"/);
  assert.match(text, /\.files\[4\] has both text and base64/);
  assert.equal(problemsOf([{ op: "setInputFiles", selector: "#f", files: [] }]).includes("files"), false);

  const app = app => validateSpec({ name: "x", app, steps: [{ op: "assertUrl", contains: "/" }] }).join("\n");
  assert.match(app({ start: "//evil.example/x" }), /app\.start must be a path starting with a single \//);
  assert.match(app({ start: "/a\\b" }), /app\.start must be a path/);
  assert.match(app({ start: "/ok?x=1" }), /^$/);
  assert.match(app({ url: "ftp://host/" }), /app\.url must be an http or https URL/);
  assert.match(app({ url: "not a url" }), /app\.url must be an http or https URL/);
  assert.match(app({ url: "http://localhost:3000/app/", bug: "no-persist" }), /cannot both be set/);

  assert.match(validateSpec({ name: "", steps: [{ op: "assertUrl", contains: "/" }] }).join("\n"), /name must be 1 to 100 characters/);
  assert.match(validateSpec({ name: "a\nb", steps: [{ op: "assertUrl", contains: "/" }] }).join("\n"), /name must be 1 to 100 characters/);
  assert.match(validateSpec({ name: "x", timeoutMs: 0, steps: [{ op: "assertUrl", contains: "/" }] }).join("\n"), /timeoutMs must be from 1 to 600000/);
  assert.match(validateSpec({ name: "x", timeoutMs: 0.5, steps: [{ op: "assertUrl", contains: "/" }] }).join("\n"), /timeoutMs must be from 1 to 600000/);
  assert.match(validateSpec({ name: "x", timeoutMs: 600001, steps: [{ op: "assertUrl", contains: "/" }] }).join("\n"), /timeoutMs must be from 1 to 600000/);
  assert.equal(validateSpec({ name: "x", timeoutMs: 1, steps: [{ op: "assertUrl", contains: "/" }] }).length, 0);

  assert.match(problemsOf([{ op: "goto", url: "/" }, { op: "click", selector: "#a" }]), /spec has no assertions/);
  assert.equal(problemsOf([{ op: "goto", url: "/", status: 200 }]), "");
  assert.equal(validateSpec({ name: "x", noPageErrors: true, steps: [{ op: "goto", url: "/" }] }).length, 0);
  assert.match(validateSpec({ name: "x", steps: Array.from({ length: 501 }, () => ({ op: "assertUrl", contains: "/" })) }).join("\n"), /must not hold more than 500 entries/);
});
