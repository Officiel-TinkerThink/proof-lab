// Expectation blocks: what an action step must cause. A click that should open a confirm dialog, a link that should
// start a download, a button that should open a second tab. The listeners are armed before the action runs, because
// the event can fire before the action returns, and each expectation becomes one check next to the step's own.
//   { "op": "click", "role": "button", "name": "Delete", "expect": { "dialog": { "type": "confirm", "message": "Delete item?", "action": "accept" } } }
// If the action itself fails, no expectation is recorded: the step is already a failed check and the missing event is
// a consequence, not a second finding.
import { readFile, stat } from "node:fs/promises";
import { clipValue } from "./evidence.js";
import { matcher } from "./steps.js";
import { bounded, firstLine } from "./util.js";

export const MAX_DOWNLOAD_READ_BYTES = 1_000_000;
export const DEFAULT_ABSENT_MS = 500;
// The longest an absence wait can take, so the step's outer bound can include it.
export const absentWaitMs = step => Math.max(0, ...Object.values(step.expect ?? {})
  .filter(block => block?.appears === false).map(block => block.within ?? DEFAULT_ABSENT_MS));
const ACTUAL_TEXT_CHARS = 200;

// A text expectation is a string (equals) or an object with one of equals, contains, matches (and flags).
export const matchOf = value => matcher(typeof value === "string" ? { equals: value } : value);

const without = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

// A promise that can be resolved from outside, for "the event happened".
function signal() {
  let fire;
  const promise = new Promise(resolve => { fire = resolve; });
  return { promise, fire };
}

// Resolves true when the signal fires within ms, false when the time runs out first.
async function happensWithin(promise, ms) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(false), Math.max(ms, 0)); });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const ARM = {
  dialog(ctx, block) {
    const page = ctx.page;
    const seen = [];
    const happened = signal();
    // A dialog nobody expected is dismissed (cancel), the least destructive answer.
    const answer = block.appears === false ? "dismiss" : block.action ?? "accept";
    const handler = async dialog => {
      seen.push({ type: dialog.type(), message: dialog.message() });
      happened.fire();
      try {
        if (answer === "dismiss") await dialog.dismiss();
        // Pressing OK in a prompt keeps the text it was opened with, unless the spec types another.
        else await dialog.accept(block.promptText ?? dialog.defaultValue());
      } catch { /* the page closed the dialog itself */ }
    };
    page.on("dialog", handler);
    return {
      happened: happened.promise,
      off: () => page.off("dialog", handler),
      async evaluate() {
        const first = seen[0] ?? null;
        const actual = first === null ? null : { type: first.type, message: clipValue(first.message, ACTUAL_TEXT_CHARS), answered: answer, ...(seen.length > 1 ? { dialogs: seen.length } : {}) };
        if (block.appears === false) return { pass: first === null, expected: { dialog: "none" }, actual };
        const expected = without({ dialog: "appears", type: block.type, message: block.message === undefined ? undefined : matchOf(block.message).label });
        const pass = first !== null
          && (block.type === undefined || first.type === block.type)
          && (block.message === undefined || matchOf(block.message).test(first.message));
        return { pass, expected, actual };
      },
    };
  },

  download(ctx, block) {
    const page = ctx.page;
    let found = null;
    const happened = signal();
    const handler = download => { found ??= download; happened.fire(); };
    page.on("download", handler);
    return {
      happened: happened.promise,
      off: () => page.off("download", handler),
      async evaluate(ms) {
        if (block.appears === false) {
          return { pass: found === null, expected: { download: "none" }, actual: found === null ? null : { filename: found.suggestedFilename() } };
        }
        const expected = without({
          download: "starts",
          filename: block.filename === undefined ? undefined : matchOf(block.filename).label,
          content: block.content === undefined ? undefined : matchOf(block.content).label,
        });
        if (found === null) return { pass: false, expected, actual: null };
        const actual = { filename: found.suggestedFilename() };
        try {
          const failure = await bounded(found.failure(), Math.max(ms, 1000), "waiting for the download to finish");
          if (failure) return { pass: false, expected, actual: { ...actual, failure: clipValue(failure, 100) } };
          let pass = block.filename === undefined || matchOf(block.filename).test(actual.filename);
          const path = await found.path();
          const { size } = await stat(path);
          actual.bytes = size;
          if (block.content !== undefined) {
            if (size > MAX_DOWNLOAD_READ_BYTES) {
              actual.content = `(not read: over ${MAX_DOWNLOAD_READ_BYTES} bytes)`;
              pass = false;
            } else {
              const text = await readFile(path, "utf8");
              actual.content = clipValue(text, ACTUAL_TEXT_CHARS);
              pass = pass && matchOf(block.content).test(text);
            }
          }
          return { pass, expected, actual };
        } catch (error) {
          return { pass: false, expected, actual, error: firstLine(error) };
        }
      },
    };
  },

  popup(ctx, block) {
    const page = ctx.page;
    const epoch = ctx.epoch;
    let found = null;
    const happened = signal();
    // The popup gets the run's hooks at once: an error it throws while loading is the app's error.
    const handler = popup => {
      // Every popup gets the hooks, so a page error in the second one counts too; the first one is the one checked.
      const adopted = ctx.adopt(popup);
      if (found === null) found = adopted;
      happened.fire();
    };
    page.on("popup", handler);
    return {
      happened: happened.promise,
      off: () => page.off("popup", handler),
      async evaluate(ms) {
        if (block.appears === false) {
          return { pass: found === null, expected: { popup: "none" }, actual: found === null ? null : { url: found.url() } };
        }
        const expected = without({
          popup: "opens",
          url: block.url === undefined ? undefined : matchOf(block.url).label,
          title: block.title === undefined ? undefined : matchOf(block.title).label,
        });
        if (found === null) return { pass: false, expected, actual: null };
        let error;
        try {
          await found.waitForLoadState("domcontentloaded", { timeout: Math.max(ms, 1000) });
        } catch (loadError) {
          error = firstLine(loadError);
        }
        const title = await bounded(found.title(), 2000, "reading the title").catch(() => null);
        const actual = { url: found.url(), title: title === null ? null : clipValue(title, ACTUAL_TEXT_CHARS) };
        // The spec carries on in the new tab unless it says not to, or the tab has already closed itself.
        if (block.switchTo !== false && !found.isClosed()) {
          await found.bringToFront().catch(() => {});
          // bringToFront can outlast the step: a step that was given up on must not move the run to another tab.
          if (ctx.epoch === epoch && !found.isClosed()) ctx.page = found;
        }
        const pass = error === undefined
          && (block.url === undefined || matchOf(block.url).test(actual.url))
          && (block.title === undefined || (title !== null && matchOf(block.title).test(title)));
        return { pass, expected, actual, ...(error ? { error } : {}) };
      },
    };
  },
};

// Runs action() with the step's expectations armed, then records one check per expectation. An error from action()
// propagates (after the listeners are removed) and is recorded by the caller as the step's failed check.
export async function withExpectations(ctx, step, labelOf, action) {
  const deadline = performance.now() + (step.timeout ?? ctx.timeoutMs);
  // If the step was given up on (its bound hit) while this still waits, a late record would land on a later step.
  const index = ctx.index;
  const epoch = ctx.epoch;
  const armed = Object.keys(ARM)
    .filter(kind => step.expect[kind] !== undefined)
    .map(kind => ({ kind, block: step.expect[kind], ...ARM[kind](ctx, step.expect[kind]) }));
  try {
    await action();
    // All waits run together, so two expectations cost the longer of them, not the sum.
    await Promise.all(armed.map(entry => happensWithin(
      entry.happened,
      entry.block.appears === false ? entry.block.within ?? DEFAULT_ABSENT_MS : deadline - performance.now(),
    )));
    const label = labelOf(step, index);
    for (const entry of armed) {
      const outcome = await entry.evaluate(deadline - performance.now());
      if (ctx.epoch !== epoch) return;
      ctx.record({ ...step, check: `${label} -> ${entry.kind}` }, outcome.pass, outcome.expected, outcome.actual, outcome.error);
    }
  } finally {
    for (const entry of armed) entry.off();
  }
}
