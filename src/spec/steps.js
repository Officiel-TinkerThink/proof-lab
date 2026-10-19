// One function per op. Actions throw when the page does not allow them (the runner records that as a failed check).
// Assertions never throw: they poll, then record a check with the last value read.
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { hasTarget, locate } from "./locate.js";
import { poll } from "./poll.js";
import { defined, pick, readPath } from "./util.js";

// Reads inside a poll are short so the poll, not Playwright, decides how long to keep trying.
const READ_TIMEOUT_MS = 250;

// A claim no assertion can settle (copy tone, layout feel). It is neither a pass nor a fail: it is listed for a human.
// The page is not touched, and the step needs no target.
function review(ctx, step) {
  ctx.reviews.push({ step: ctx.index, name: step.check, ...(step.note === undefined ? {} : { note: step.note }) });
}

const budget = (ctx, step) => step.timeout ?? ctx.timeoutMs;
const withTimeout = (ctx, step, options = {}) => defined({ ...options, timeout: budget(ctx, step) });

// Actions use the strict locator: a target that matches several elements is an ambiguous spec and should fail.
const strict = (ctx, step) => locate(ctx.page, step);
// Reads take the first match unless the spec says nth, as the original prove.js did.
const reader = (ctx, step) => (step.nth === undefined ? locate(ctx.page, step).first() : locate(ctx.page, step));

// equals | contains | matches, as a test function and a readable label.
export function matcher(step) {
  if (step.equals !== undefined) return { test: value => value === step.equals, label: step.equals, kind: "equals", value: step.equals };
  if (step.contains !== undefined) {
    return { test: value => typeof value === "string" && value.includes(step.contains), label: `contains ${JSON.stringify(step.contains)}`, kind: "contains", value: step.contains };
  }
  // g and y are rejected by the schema; they are also dropped here, because a RegExp that remembers lastIndex
  // would give different answers on repeated reads of the same text.
  const pattern = new RegExp(step.matches, (step.flags ?? "").replace(/[gy]/g, ""));
  return { test: value => typeof value === "string" && pattern.test(value), label: `matches ${pattern}`, kind: "matches", value: step.matches };
}

// A content assertion on an element that is not there is a failure, with or without "not": otherwise a typo in a
// selector would make "not equals error" pass for ever. Throwing makes poll record a failed read, which "not" never flips.
const elementNotFound = () => { throw new Error("element not found"); };

// The locator for a content read, or "element not found". Checked first, so a typo costs one short read and always
// reports the same error, not a Playwright timeout message that differs from op to op.
async function existing(ctx, step) {
  const locator = reader(ctx, step);
  if (!(await present(locator))) elementNotFound();
  return locator;
}

// Polls evaluate() -> { pass, actual }, applies "not", records one check.
async function assertion(ctx, step, expected, evaluate) {
  const result = await poll(async () => {
    const read = await evaluate();
    return { ...read, pass: step.not ? !read.pass : read.pass };
  }, budget(ctx, step));
  ctx.record(step, result.pass, step.not ? { not: expected } : expected, result.actual ?? null, result.error);
}

// A text assertion reads one string off the page; the string reader is the only part that differs.
async function textAssertion(ctx, step, read) {
  const match = matcher(step);
  await assertion(ctx, step, match.label, async () => {
    const actual = await read();
    return { pass: actual !== null && match.test(actual), actual };
  });
}

const present = async locator => (await locator.count()) > 0;

const STATE_READERS = {
  enabled: locator => locator.isEnabled({ timeout: READ_TIMEOUT_MS }),
  disabled: locator => locator.isDisabled({ timeout: READ_TIMEOUT_MS }),
  editable: locator => locator.isEditable({ timeout: READ_TIMEOUT_MS }),
  checked: locator => locator.isChecked({ timeout: READ_TIMEOUT_MS }),
  unchecked: async locator => !(await locator.isChecked({ timeout: READ_TIMEOUT_MS })),
  indeterminate: locator => locator.evaluate(element => element.indeterminate === true, undefined, { timeout: READ_TIMEOUT_MS }),
  focused: locator => locator.evaluate(element => element.matches(":focus"), undefined, { timeout: READ_TIMEOUT_MS }),
  inViewport: locator => locator.evaluate(element => new Promise(done => {
    const observer = new IntersectionObserver(entries => { observer.disconnect(); done(entries[0].intersectionRatio > 0); });
    observer.observe(element);
  }), undefined, { timeout: READ_TIMEOUT_MS }),
};

const toFile = (file, specDir) => {
  if (typeof file === "string") return isAbsolute(file) ? file : resolve(specDir, file);
  const buffer = file.base64 !== undefined ? Buffer.from(file.base64, "base64") : Buffer.from(file.text ?? "", "utf8");
  return { name: file.name, mimeType: file.mimeType ?? "application/octet-stream", buffer };
};

export const STEPS = {
  review,

  // Navigation
  async goto(ctx, step) {
    const response = await ctx.page.goto(new URL(step.url, ctx.appUrl).href, { waitUntil: "load", timeout: budget(ctx, step) });
    if (step.status !== undefined) {
      const actual = response ? response.status() : null;
      ctx.record(step, actual === step.status, step.status, actual);
    }
  },
  async back(ctx, step) { await ctx.page.goBack({ waitUntil: "load", timeout: budget(ctx, step) }); },
  async forward(ctx, step) { await ctx.page.goForward({ waitUntil: "load", timeout: budget(ctx, step) }); },
  async reload(ctx, step) { await ctx.page.reload({ waitUntil: "load", timeout: budget(ctx, step) }); },
  async waitForUrl(ctx, step) {
    const match = matcher(step);
    await ctx.page.waitForURL(url => match.test(url.href), { timeout: budget(ctx, step) });
  },
  async waitFor(ctx, step) {
    await reader(ctx, step).waitFor({ state: step.state ?? "visible", timeout: budget(ctx, step) });
  },

  // Actions
  async click(ctx, step) {
    await strict(ctx, step).click(withTimeout(ctx, step, pick(step, ["button", "clickCount", "modifiers", "position", "force", "delay"])));
  },
  async dblclick(ctx, step) {
    await strict(ctx, step).dblclick(withTimeout(ctx, step, pick(step, ["button", "modifiers", "position", "force", "delay"])));
  },
  async hover(ctx, step) {
    await strict(ctx, step).hover(withTimeout(ctx, step, pick(step, ["modifiers", "position", "force"])));
  },
  async focus(ctx, step) { await strict(ctx, step).focus(withTimeout(ctx, step)); },
  async blur(ctx, step) { await strict(ctx, step).blur(withTimeout(ctx, step)); },
  async clear(ctx, step) { await strict(ctx, step).clear(withTimeout(ctx, step)); },
  async fill(ctx, step) { await strict(ctx, step).fill(step.value, withTimeout(ctx, step)); },
  async type(ctx, step) {
    await strict(ctx, step).pressSequentially(step.value, withTimeout(ctx, step, pick(step, ["delay"])));
  },
  async press(ctx, step) {
    if (hasTarget(step)) await strict(ctx, step).press(step.key, withTimeout(ctx, step));
    else await ctx.page.keyboard.press(step.key);
  },
  async check(ctx, step) { await strict(ctx, step).check(withTimeout(ctx, step)); },
  async uncheck(ctx, step) { await strict(ctx, step).uncheck(withTimeout(ctx, step)); },
  async selectOption(ctx, step) {
    let choices;
    if (step.byValue !== undefined) choices = [].concat(step.byValue).map(value => ({ value }));
    else if (step.byLabel !== undefined) choices = [].concat(step.byLabel).map(label => ({ label }));
    else choices = [].concat(step.byIndex).map(index => ({ index }));
    await strict(ctx, step).selectOption(choices, withTimeout(ctx, step));
  },
  async setInputFiles(ctx, step) {
    await strict(ctx, step).setInputFiles(step.files.map(file => toFile(file, ctx.specDir)), withTimeout(ctx, step));
  },
  async dragTo(ctx, step) {
    const source = strict(ctx, step);
    const destination = locate(ctx.page, { ...step.to, frame: step.to.frame ?? step.frame });
    const options = withTimeout(ctx, step);
    if (step.html5) {
      // Native HTML5 drag needs two moves over the target before the drop, or dragover never fires.
      await source.hover(options);
      await ctx.page.mouse.down();
      try {
        await destination.hover(options);
        await destination.hover(options);
      } finally {
        // Release the button even when the drop target is missing, or later steps would run with it held down.
        await ctx.page.mouse.up();
      }
    } else {
      await source.dragTo(destination, options);
    }
  },
  async scrollIntoView(ctx, step) { await strict(ctx, step).scrollIntoViewIfNeeded(withTimeout(ctx, step)); },
  async scroll(ctx, step) {
    const by = [step.x ?? 0, step.y ?? 0];
    if (hasTarget(step)) await strict(ctx, step).evaluate((element, [x, y]) => element.scrollBy(x, y), by, withTimeout(ctx, step));
    else await ctx.page.mouse.wheel(...by);
  },

  // Assertions
  async assertText(ctx, step) {
    await textAssertion(ctx, step, async () => {
      const locator = await existing(ctx, step);
      return (await locator.innerText({ timeout: READ_TIMEOUT_MS })).trim();
    });
  },
  async assertValue(ctx, step) {
    await textAssertion(ctx, step, async () => (await existing(ctx, step)).inputValue({ timeout: READ_TIMEOUT_MS }));
  },
  async assertValues(ctx, step) {
    await assertion(ctx, step, step.equals, async () => {
      const actual = await (await existing(ctx, step)).evaluate(
        element => [...element.selectedOptions].map(option => option.value), undefined, { timeout: READ_TIMEOUT_MS });
      // A multi-select has a set of chosen options, not an order, so the comparison ignores order.
      return { pass: isDeepStrictEqual([...actual].sort(), [...step.equals].sort()), actual };
    });
  },
  async assertVisible(ctx, step) {
    const wanted = step.visible !== false;
    await assertion(ctx, step, wanted, async () => {
      const locator = reader(ctx, step);
      const actual = (await present(locator)) && (await locator.isVisible());
      return { pass: actual === wanted, actual };
    });
  },
  async assertState(ctx, step) {
    await assertion(ctx, step, step.state, async () => {
      const locator = reader(ctx, step);
      const exists = await present(locator);
      if (step.state === "attached") return { pass: exists, actual: exists ? "attached" : "detached" };
      if (step.state === "detached") return { pass: !exists, actual: exists ? "attached" : "detached" };
      if (!exists) elementNotFound();
      const holds = await STATE_READERS[step.state](locator);
      return { pass: holds === true, actual: holds === true ? step.state : `not ${step.state}` };
    });
  },
  async assertAttribute(ctx, step) {
    if (step.absent !== undefined) {
      // absent: true means the attribute must not be there; absent: false means it must be there, with any value.
      const wantedAbsent = step.absent === true;
      await assertion(ctx, step, wantedAbsent ? "absent" : "present", async () => {
        const actual = await (await existing(ctx, step)).getAttribute(step.attribute, { timeout: READ_TIMEOUT_MS });
        return { pass: (actual === null) === wantedAbsent, actual };
      });
    } else {
      await textAssertion(ctx, step, async () => (await existing(ctx, step)).getAttribute(step.attribute, { timeout: READ_TIMEOUT_MS }));
    }
  },
  async assertProperty(ctx, step) {
    await assertion(ctx, step, step.equals, async () => {
      const actual = await (await existing(ctx, step)).evaluate(
        (element, path) => path.split(".").reduce((node, part) => node?.[part], element), step.property, { timeout: READ_TIMEOUT_MS });
      // undefined (no such property) and null are the same here; objects compare by content, not key order.
      return { pass: isDeepStrictEqual(actual ?? null, step.equals), actual: actual ?? null };
    });
  },
  async assertCss(ctx, step) {
    await textAssertion(ctx, step, async () => (await existing(ctx, step)).evaluate(
      (element, property) => getComputedStyle(element).getPropertyValue(property), step.property, { timeout: READ_TIMEOUT_MS }));
  },
  async assertCount(ctx, step) {
    const expected = step.count !== undefined ? step.count : { min: step.min, max: step.max };
    await assertion(ctx, step, expected, async () => {
      const actual = await strict(ctx, step).count();
      const pass = step.count !== undefined
        ? actual === step.count
        : (step.min === undefined || actual >= step.min) && (step.max === undefined || actual <= step.max);
      return { pass, actual };
    });
  },
  async assertUrl(ctx, step) { await textAssertion(ctx, step, async () => ctx.page.url()); },
  async assertTitle(ctx, step) { await textAssertion(ctx, step, () => ctx.page.title()); },
  async assertStorage(ctx, step) {
    const area = `${step.area ?? "local"}Storage`;
    await assertion(ctx, step, step.equals !== undefined ? step.equals : step.exists, async () => {
      const raw = await ctx.page.evaluate(([name, key]) => window[name].getItem(key), [area, step.key]);
      if (step.equals === undefined) return { pass: (raw !== null) === step.exists, actual: raw !== null };
      let parsed = raw;
      if (raw !== null) {
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
      }
      const actual = (step.path ? readPath(parsed, step.path) : parsed) ?? null;
      return { pass: isDeepStrictEqual(actual, step.equals), actual };
    });
  },
  // A cookie is usually a session token: the receipt records its length and a fingerprint, never the value.
  async assertCookie(ctx, step) {
    const context = ctx.page.context();
    const match = step.exists === undefined ? matcher(step) : null;
    // A cookie value is often a session token, and whether it is httpOnly is known only after reading it: the receipt
    // never carries the expected value, only how it is compared and its length.
    // A short fingerprint stands in for the value: two different values show two different fingerprints on a mismatch.
    const print = value => `${String(value).length} characters, sha256 ${createHash("sha256").update(String(value)).digest("hex").slice(0, 8)}`;
    const expected = match === null
      ? { exists: step.exists }
      : `${match.kind} (${match.kind === "equals" ? print(match.value) : `${String(match.value).length} characters`})`;
    await assertion(ctx, step, expected, async () => {
      const found = (await context.cookies()).find(cookie => cookie.name === step.cookie && (step.path === undefined || cookie.path === step.path));
      if (match === null) return { pass: (found !== undefined) === step.exists, actual: found !== undefined };
      // Like a missing element: a typo in the cookie name must fail with or without "not", so it is a failed read.
      if (!found) throw new Error("cookie not found");
      return {
        pass: match.test(found.value),
        actual: `(cookie, ${print(found.value)})`,
      };
    });
  },

  // Environment
  async setViewport(ctx, step) { await ctx.page.setViewportSize({ width: step.width, height: step.height }); },
  async emulateMedia(ctx, step) { await ctx.page.emulateMedia(pick(step, ["media", "colorScheme", "reducedMotion"])); },
  // Offline holds until a later setOffline says otherwise; it applies to the whole browser context.
  async setOffline(ctx, step) { await ctx.page.context().setOffline(step.offline); },
  async grantPermissions(ctx, step) {
    await ctx.page.context().grantPermissions(step.permissions, { origin: new URL(ctx.appUrl).origin });
  },
  async clearPermissions(ctx) { await ctx.page.context().clearPermissions(); },
  async setGeolocation(ctx, step) {
    await ctx.page.context().setGeolocation({ latitude: step.latitude, longitude: step.longitude, accuracy: step.accuracy ?? 0 });
  },
  async setCookie(ctx, step) {
    await ctx.page.context().addCookies([{
      ...pick(step, ["value", "httpOnly", "secure", "sameSite"]),
      name: step.cookie, domain: new URL(ctx.appUrl).hostname, path: step.path ?? "/",
    }]);
  },
  async clearCookies(ctx, step) {
    await ctx.page.context().clearCookies(step.cookie === undefined ? undefined : { name: step.cookie });
  },
  // A value that is not a string is stored as JSON, the form assertStorage reads back.
  async setStorage(ctx, step) {
    const text = typeof step.value === "string" ? step.value : JSON.stringify(step.value);
    await ctx.page.evaluate(([name, key, value]) => window[name].setItem(key, value), [`${step.area ?? "local"}Storage`, step.key, text]);
  },
  async clearStorage(ctx, step) {
    await ctx.page.evaluate(([name, key]) => (key === null ? window[name].clear() : window[name].removeItem(key)), [`${step.area ?? "local"}Storage`, step.key ?? null]);
  },
  async clock(ctx, step) {
    const clock = ctx.page.clock;
    const time = typeof step.time === "string" ? new Date(step.time) : step.time;
    if (step.action === "install") await clock.install(time === undefined ? undefined : { time });
    else if (step.action === "setFixedTime") await clock.setFixedTime(time);
    else if (step.action === "pauseAt") await clock.pauseAt(time);
    else if (step.action === "fastForward") await clock.fastForward(step.ms);
    else if (step.action === "runFor") await clock.runFor(step.ms);
    else await clock.resume();
  },

  // Tabs: the open pages of the browser context in the order they were opened (0 is the first page of the run).
  async switchTab(ctx, step) {
    const pages = ctx.page.context().pages();
    let target;
    if (step.index !== undefined) target = pages[step.index];
    else {
      const match = matcher(step);
      target = pages.find(candidate => match.test(candidate.url()));
    }
    if (!target) throw new Error(step.index !== undefined ? `there is no tab ${step.index} (${pages.length} open)` : `no open tab has a matching address (${pages.length} open)`);
    await target.bringToFront();
    ctx.page = target;
  },
  // Closes the current tab and moves to the last one still open; closing the only tab is a failed step.
  async closeTab(ctx) {
    const context = ctx.page.context();
    if (context.pages().length < 2) throw new Error("this is the only open tab");
    await ctx.page.close();
    ctx.page = context.pages().at(-1);
    await ctx.page.bringToFront();
  },
};
