// One function per op. Actions throw when the page does not allow them (the runner records that as a failed check).
// Assertions never throw: they poll, then record a check with the last value read.
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { addressLabel, hideQuery, isSensitiveStep, maskValue, redactSecrets } from "./evidence.js";
import { hasTarget, locate } from "./locate.js";
import { poll } from "./poll.js";
import { defined, pick, readPath } from "./util.js";
import { MAX_VALUE_CHARS } from "./vars.js";

// Reads inside a poll are short so the poll, not Playwright, decides how long to keep trying.
const READ_TIMEOUT_MS = 250;

// A claim no assertion can settle (copy tone, layout feel). It is neither a pass nor a fail: it is listed for a human.
// The page is not touched, and the step needs no target.
function review(ctx, step) {
  ctx.reviews.push({ step: ctx.index, name: redactSecrets(step.check), ...(step.note === undefined ? {} : { note: redactSecrets(step.note) }) });
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
// show(actual) is what the check records; the match always uses the value as read.
async function textAssertion(ctx, step, read, show = value => value) {
  const match = matcher(step);
  // An address assertion can carry a query or hash in what it expects, so its label is hidden the same way as the actual.
  await assertion(ctx, step, show === hideQuery ? addressLabel(match) : match.label, async () => {
    const actual = await read();
    return { pass: actual !== null && match.test(actual), actual: actual === null ? null : show(actual) };
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

// Runs in the page. The WCAG ratio of the element's text colour over what is behind it, or why that cannot be known.
// Only plain rgb()/rgba() colours with no image, gradient or opacity in the way are computed: a guess would be a false pass.
function contrastInPage(element) {
  const parse = text => {
    const match = /^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)(?:\s*[,/]\s*([\d.]+)(%)?)?\s*\)$/.exec(text);
    if (!match) return null;
    const alpha = match[4] === undefined ? 1 : Number(match[4]) / (match[5] ? 100 : 1);
    return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: alpha };
  };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const light = ({ r, g, b }) => {
    const channel = value => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const layers = [];
  for (let node = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (Number(style.opacity) < 1) return { reason: "an element has opacity below 1" };
    if (style.backgroundImage !== "none") return { reason: "the background is an image or gradient" };
    const color = parse(style.backgroundColor);
    if (!color) return { reason: `the background colour ${style.backgroundColor} is not a plain rgb colour` };
    if (color.a > 0) layers.push(color);
    if (color.a === 1) break;
  }
  let background = layers.at(-1)?.a === 1 ? layers.pop() : { r: 255, g: 255, b: 255, a: 1 };
  while (layers.length > 0) background = over(layers.pop(), background);
  const text = parse(getComputedStyle(element).color);
  if (!text) return { reason: "the text colour is not a plain rgb colour" };
  const foreground = over(text, background);
  const [bright, dark] = [light(foreground), light(background)].sort((a, b) => b - a);
  return { ratio: (bright + 0.05) / (dark + 0.05) };
}

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

  // Reads one value into a variable. It records no check: a read that fails (no element) fails the step like an action.
  async capture(ctx, step) {
    // A value kept in a variable can reach a later step's expectation, so a credential field is never captured.
    if (isSensitiveStep({ ...step, op: step.from === "attribute" ? "assertAttribute" : "assertValue" })) {
      throw new Error("capture does not read a field that holds a credential");
    }
    const options = { timeout: budget(ctx, step) };
    let value;
    if (step.from === "count") value = String(await strict(ctx, step).count());
    else {
      const locator = await existing(ctx, step);
      if (step.from === "text") value = (await locator.innerText(options)).trim();
      else if (step.from === "value") value = await locator.inputValue(options);
      else value = await locator.getAttribute(step.attribute, options);
      if (value === null) throw new Error(`attribute "${step.attribute}" is not set`);
    }
    ctx.vars.set(step.as, value.length > MAX_VALUE_CHARS ? value.slice(0, MAX_VALUE_CHARS) : value);
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
  // The match sees the whole address; the record shows origin and path only (a code or token may be in the query).
  async assertContrast(ctx, step) {
    const wanted = step.min ?? 4.5;
    let unknown = null;
    const result = await poll(async () => {
      const read = await (await existing(ctx, step)).evaluate(contrastInPage, undefined, { timeout: READ_TIMEOUT_MS });
      unknown = read.ratio === undefined ? read.reason : null;
      if (unknown !== null) return { pass: true, actual: null }; // nothing to wait for: the ratio is not computable
      const ratio = Math.round(read.ratio * 100) / 100;
      return { pass: step.not ? ratio < wanted : ratio >= wanted, actual: ratio };
    }, budget(ctx, step));
    // A ratio that cannot be computed is a claim for a human, not a pass and not a fail.
    if (unknown !== null && result.error === undefined) {
      ctx.reviews.push({ step: ctx.index, name: redactSecrets(step.check ?? `step ${ctx.index}: contrast`), note: `contrast could not be computed: ${unknown}` });
      return;
    }
    ctx.record(step, result.pass, step.not ? { not: `contrast >= ${wanted}` } : `contrast >= ${wanted}`, result.actual ?? null, result.error);
  },
  async assertUrl(ctx, step) { await textAssertion(ctx, step, async () => ctx.page.url(), hideQuery); },
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
    const print = maskValue;
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
    const closing = ctx.page;
    const open = closing.context().pages();
    if (open.length < 2) throw new Error("this is the only open tab");
    // The run moves first: a close that finishes late (or a step given up on) cannot leave it on a tab that is gone.
    const next = open.filter(page => page !== closing).at(-1);
    ctx.page = next;
    try {
      await closing.close();
    } catch (error) {
      ctx.page = closing; // the tab is still open: the run stays where it was, and the step fails
      throw error;
    }
    await next.bringToFront();
  },
};
