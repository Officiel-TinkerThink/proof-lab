import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { validateSpec } from "../src/run-spec.js";
import { contextOptionsOf } from "../src/spec/session.js";
import { TIMEOUT, explain, failedChecks, page, runInline, withRun } from "./spec-helpers.mjs";

const ENV_PAGE = "/fixtures/env.html";
const text = (testId, equals) => ({ op: "assertText", testId, equals });

async function expectPass(spec) {
  const receipt = await runInline(spec);
  assert.equal(receipt.verdict, "PASS", explain(receipt));
  return receipt;
}

// --- validation: no browser needed ---------------------------------------------------------------------------------

test("validateSpec: the env block is checked field by field", () => {
  const problems = env => validateSpec(page(ENV_PAGE, [text("viewport", "x")], { env })).join(" | ");
  assert.equal(problems({ viewport: { width: 600, height: 400 }, locale: "de-DE", timezoneId: "Asia/Tokyo", colorScheme: "dark", reducedMotion: "reduce", geolocation: { latitude: 35, longitude: 139 }, permissions: ["geolocation"] }), "");
  assert.match(problems({ viewport: { width: 600 } }), /env.viewport needs width and height/);
  assert.match(problems({ viewport: { width: 0, height: 10 } }), /env.viewport.width must be from 1 to 10000/);
  assert.match(problems({ locale: "not a locale" }), /env.locale is not a valid locale tag/);
  assert.match(problems({ timezoneId: "Mars/Olympus" }), /env.timezoneId is not a time zone/);
  assert.match(problems({ colorScheme: "blue" }), /env.colorScheme must be one of/);
  assert.match(problems({ geolocation: { latitude: 91, longitude: 0 } }), /env.geolocation.latitude must be from -90 to 90/);
  assert.match(problems({ geolocation: { latitude: 1 } }), /needs latitude and longitude/);
  assert.match(problems({ permissions: ["teleport"] }), /env.permissions\[0\] must be one of/);
  assert.match(problems({ permissions: [] }), /must not be an empty list/);
  assert.match(problems({ offline: true }), /unknown field "offline"/, "offline is a step, because a run that starts offline cannot load its page");
});

test("validateSpec: the environment ops need what they act on and nothing they would drop", () => {
  const problems = step => validateSpec(page(ENV_PAGE, [text("viewport", "x"), step])).join(" | ");
  assert.equal(problems({ op: "setViewport", width: 390, height: 844 }), "");
  assert.match(problems({ op: "setViewport", width: 390 }), /needs "height"/);
  assert.match(problems({ op: "emulateMedia" }), /needs at least one of media, colorScheme, reducedMotion/);
  assert.match(problems({ op: "setOffline" }), /needs "offline"/);
  assert.match(problems({ op: "grantPermissions", permissions: ["nope"] }), /permissions\[0\] must be one of/);
  assert.match(problems({ op: "setGeolocation", latitude: 1 }), /needs "longitude"/);
  assert.match(problems({ op: "setGeolocation", latitude: 1, longitude: 181 }), /longitude must be from -180 to 180/);
  assert.match(problems({ op: "setCookie", cookie: "a" }), /needs "value"/);
  assert.match(problems({ op: "setCookie", cookie: "a", value: "b", path: "x" }), /path must start with \//);
  assert.match(problems({ op: "setCookie", cookie: "a", value: "b", sameSite: "None" }), /sameSite None needs secure/);
  assert.match(problems({ op: "assertCookie", cookie: "a" }), /needs exactly one of equals, contains, matches, exists/);
  assert.match(problems({ op: "assertCookie", cookie: "a", equals: "b", exists: true }), /needs exactly one of/);
  assert.match(problems({ op: "clearCookies", cookie: "" }), /cookie must not be empty/);
  assert.match(problems({ op: "setStorage", key: "k" }), /needs "value"/);
  assert.match(problems({ op: "clock" }), /needs "action"/);
  assert.match(problems({ op: "clock", action: "setFixedTime" }), /needs "time"/);
  assert.match(problems({ op: "clock", action: "fastForward" }), /needs "ms"/);
  assert.match(problems({ op: "clock", action: "fastForward", ms: 5, time: 1 }), /cannot use "time"/);
  assert.match(problems({ op: "clock", action: "resume", ms: 5 }), /cannot use "ms"/);
  assert.match(problems({ op: "clock", action: "setFixedTime", time: "yesterday" }), /not a date with an explicit offset/);
  assert.match(problems({ op: "clock", action: "setFixedTime", time: "2030-06-15T12:00:00" }), /not a date with an explicit offset/, "no offset means the runner's own time zone");
  assert.match(problems({ op: "clock", action: "setFixedTime", time: "2030-13-45T12:00:00Z" }), /not a date with an explicit offset/);
  assert.equal(problems({ op: "clock", action: "setFixedTime", time: "2030-06-15T12:00:00+02:00" }), "");
  assert.equal(problems({ op: "clock", action: "setFixedTime", time: "2030-06-15" }), "");
  assert.equal(problems({ op: "clock", action: "setFixedTime", time: "2030-06-15T12:00:00Z" }), "");
  assert.equal(problems({ op: "clock", action: "install" }), "");
});

test("contextOptionsOf passes only what the spec set, and fills geolocation accuracy", () => {
  assert.deepEqual(contextOptionsOf(undefined), {});
  assert.deepEqual(contextOptionsOf({}), {});
  assert.deepEqual(contextOptionsOf({ locale: "fr-FR", geolocation: { latitude: 1, longitude: 2 } }), { locale: "fr-FR", geolocation: { accuracy: 0, latitude: 1, longitude: 2 } });
});

// --- the env block ---------------------------------------------------------------------------------------------------

test("env: viewport, locale, time zone, color scheme and reduced motion reach the page", TIMEOUT, async () => {
  await expectPass(page(ENV_PAGE, [
    text("viewport", "600x400"),
    text("locale", "de-DE"),
    text("number", "1.234.567,891"),
    text("timezone", "Asia/Tokyo"),
    text("scheme", "dark"),
    text("motion", "reduce"),
  ], { env: { viewport: { width: 600, height: 400 }, locale: "de-DE", timezoneId: "Asia/Tokyo", colorScheme: "dark", reducedMotion: "reduce" } }));
});

test("env: without a block the page sees the browser defaults, and a wrong expectation fails", TIMEOUT, async () => {
  const receipt = await runInline(page(ENV_PAGE, [text("scheme", "light"), text("motion", "no-preference"), text("scheme", "dark")]));
  assert.equal(receipt.verdict, "FAIL");
  assert.deepEqual(failedChecks(receipt).map(check => check.step), [3], explain(receipt));
});

// --- runtime ops -----------------------------------------------------------------------------------------------------

test("setViewport and emulateMedia change the running page", TIMEOUT, async () => {
  await expectPass(page(ENV_PAGE, [
    text("scheme", "light"),
    { op: "setViewport", width: 390, height: 844 },
    text("viewport", "390x844"),
    { op: "emulateMedia", colorScheme: "dark", reducedMotion: "reduce" },
    text("scheme", "dark"),
    text("motion", "reduce"),
    { op: "emulateMedia", media: "print" },
    text("media", "print"),
  ]));
});

test("setOffline cuts the network and setOffline false restores it", TIMEOUT, async () => {
  await expectPass(page(ENV_PAGE, [
    { op: "click", role: "button", name: "Try fetch" },
    text("fetch", "ok 200"),
    { op: "setOffline", offline: true },
    text("online", "false"),
    { op: "click", role: "button", name: "Try fetch" },
    text("fetch", "failed"),
    { op: "setOffline", offline: false },
    text("online", "true"),
    { op: "click", role: "button", name: "Try fetch" },
    text("fetch", "ok 200"),
  ]));
});

test("geolocation and permissions: denied by default, granted by env or by step, moved by setGeolocation", TIMEOUT, async () => {
  const ask = [{ op: "click", role: "button", name: "Ask for position" }];
  await expectPass(page(ENV_PAGE, [...ask, text("position", "error 1")]));
  await expectPass(page(ENV_PAGE, [
    ...ask, text("position", "35.68,139.69"),
  ], { env: { permissions: ["geolocation"], geolocation: { latitude: 35.68, longitude: 139.69 } } }));
  await expectPass(page(ENV_PAGE, [
    { op: "setGeolocation", latitude: 48.85, longitude: 2.35 },
    { op: "grantPermissions", permissions: ["geolocation"] },
    ...ask,
    text("position", "48.85,2.35"),
    { op: "setGeolocation", latitude: -33.87, longitude: 151.21 },
    ...ask,
    text("position", "-33.87,151.21"),
    { op: "clearPermissions" },
  ]));
});

test("cookies: set, assert, clear; an httpOnly value is never written to the receipt", TIMEOUT, async () => {
  await expectPass(page(ENV_PAGE, [
    { op: "assertCookie", cookie: "visit", exists: false },
    { op: "setCookie", cookie: "visit", value: "first" },
    { op: "assertCookie", cookie: "visit", equals: "first" },
    { op: "assertCookie", cookie: "visit", matches: "^fi" },
    { op: "assertCookie", cookie: "visit", path: "/other", exists: false },
    { op: "clearCookies", cookie: "visit" },
    { op: "assertCookie", cookie: "visit", exists: false },
  ]));
  // The fixture server sets spec_cookie=<value> as httpOnly. The spec holds the secret as its expected value in three
  // forms, passing and failing, with and without "not": none may reach the receipt or the evidence file.
  await withRun(page(ENV_PAGE, [
    { op: "goto", url: "/api/cookie?value=hunter2" },
    { op: "assertCookie", cookie: "spec_cookie", exists: true },
    { op: "assertCookie", cookie: "spec_cookie", equals: "hunter2" },
    { op: "assertCookie", cookie: "spec_cookie", equals: "wrong" },
    { op: "assertCookie", cookie: "spec_cookie", equals: "hunter2", not: true },
    { op: "assertCookie", cookie: "spec_cookie", contains: "hunt", not: true },
    { op: "assertCookie", cookie: "spec_cookie", matches: "^hunter", not: true },
    { op: "assertCookie", cookie: "no_such_cookie", equals: "x", not: true },
  ]), async (receipt, receiptsDir) => {
    assert.equal(receipt.verdict, "FAIL");
    const failed = failedChecks(receipt);
    assert.deepEqual(failed.map(check => check.step), [4, 5, 6, 7, 8], explain(receipt));
    assert.match(failed[0].actual, /^\(cookie, 7 characters, sha256 [0-9a-f]{8}\)$/);
    assert.match(failed[0].expected, /^equals \(5 characters, sha256 [0-9a-f]{8}\)$/);
    assert.notEqual(failed[0].actual.slice(-10), failed[0].expected.slice(-10), "different values show different fingerprints");
    assert.equal(failed[4].error, "cookie not found", "a missing cookie fails also with not");
    // The evidence file also holds the page's own url and text (this fixture endpoint prints the value it sets), which is
    // the app's data and not the spec's: only the records that carry the spec's expectations are scanned.
    const secret = /hunter2|hunt\b|\^hunter/;
    let scanned = 0;
    for (const entry of await readdir(receiptsDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const content = await readFile(join(entry.parentPath, entry.name), "utf8");
      if (!entry.name.endsWith(".evidence.jsonl")) {
        assert.doesNotMatch(content, secret, `${entry.name} holds the secret value or part of it`);
        scanned++;
        continue;
      }
      for (const line of content.split("\n").filter(Boolean)) {
        const record = JSON.parse(line);
        if (record.type === "context" || record.type === "screenshot") continue;
        assert.doesNotMatch(line, secret, `an evidence ${record.type} record holds the secret value or part of it`);
        scanned++;
      }
    }
    assert.ok(scanned > 8, "the receipt and the evidence records were scanned");
  });
});

test("storage: setStorage stores objects as JSON, clearStorage removes one key or the area", TIMEOUT, async () => {
  await expectPass(page(ENV_PAGE, [
    { op: "setStorage", key: "plan", value: { tier: "gold", seats: 3 } },
    { op: "assertStorage", key: "plan", path: "tier", equals: "gold" },
    { op: "setStorage", area: "session", key: "token", value: "abc" },
    { op: "assertStorage", area: "session", key: "token", equals: "abc" },
    { op: "clearStorage", key: "plan" },
    { op: "assertStorage", key: "plan", exists: false },
    { op: "setStorage", key: "a", value: 1 },
    { op: "setStorage", key: "b", value: 2 },
    { op: "clearStorage" },
    { op: "assertStorage", key: "a", exists: false },
    { op: "assertStorage", key: "b", exists: false },
    { op: "assertStorage", area: "session", key: "token", equals: "abc" },
  ]));
});

test("clock: a fixed time shows in the page, and fast-forward fires a timer without waiting", TIMEOUT, async () => {
  await expectPass(page(ENV_PAGE, [
    { op: "clock", action: "install" },
    { op: "reload" },
    text("timer", "waiting"),
    { op: "clock", action: "fastForward", ms: 5000 },
    text("timer", "fired"),
    { op: "clock", action: "setFixedTime", time: "2030-06-15T12:00:00Z" },
    { op: "click", role: "button", name: "Show time" },
    text("now", "2030-06-15T12:00:00.000Z"),
  ]));
});

test("an environment step the page does not allow is a failed check with a hint, not an ERROR", TIMEOUT, async () => {
  // about:blank has no storage: the page refuses, and the spec author's hint is what the receipt carries.
  const receipt = await runInline(page(ENV_PAGE, [
    { op: "goto", url: "about:blank" },
    { op: "setStorage", key: "k", value: "v", hint: "open the app before writing storage" },
    text("scheme", "light"),
  ]));
  assert.equal(receipt.verdict, "FAIL", explain(receipt));
  const failed = failedChecks(receipt);
  assert.equal(failed[0].step, 2, explain(receipt));
  assert.equal(failed[0].hint, "open the app before writing storage");
});
