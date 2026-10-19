// look: see a page the way a spec sees it, before writing the spec. Nothing is signed and no receipt is written: this is
// for learning what is there (roles, names, test ids, stored keys, console, failed requests), not for proving anything.
//   node src/look.js --url <http(s) url> [--screenshot <new file.png>] [--json]
//   node src/look.js --spec <file.json> [--until <step>] [--screenshot <new file.png>] [--json]
// With --spec, the spec's own steps run first (up to --until, default all) so the page can be looked at after the form
// was filled or the dialog opened. Those steps are the spec's, so they may change the app's state; --url only loads.
// Exit 0: looked. Exit 2: could not (bad arguments, spec invalid, page did not load). Never 1: nothing was checked.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createContext, runStep } from "./run-spec.js";
import { startApp } from "./server.js";
import { clipValue, redactSecrets } from "./spec/evidence.js";
import { DEFAULT_TIMEOUT_MS } from "./spec/poll.js";
import { validateSpec } from "./spec/schema.js";
import { openSession } from "./spec/session.js";
import { bounded, firstLine, isMainModule, parseCli } from "./spec/util.js";

const ARIA_CHARS = 8000;
const MAX_ELEMENTS = 200;
const MAX_CONSOLE = 50;
const MAX_PAGE_ERRORS = 20;
const MAX_FAILED_REQUESTS = 50;
const READ_MS = 3000;
// Roles a visitor acts on; headings and dialogs are listed too because specs assert on them.
const ACTIONABLE = new Set(["button", "link", "textbox", "searchbox", "checkbox", "radio", "switch", "combobox", "listbox", "option", "slider", "spinbutton", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "heading", "dialog", "alert", "status"]);
const ARIA_LINE = /^\s*- ([a-z]+)(?: ("(?:[^"\\]|\\.)*"))?/;

// Parses Playwright's accessibility snapshot into spec-ready targets: { role, name }. A role that appears with the same
// name several times is flagged, because a spec for it needs nth or a narrower target.
export function actionableElements(aria) {
  const found = [];
  const counts = new Map();
  for (const line of aria.split("\n")) {
    const match = ARIA_LINE.exec(line);
    if (!match || !ACTIONABLE.has(match[1])) continue;
    let name;
    try {
      name = match[2] === undefined ? undefined : JSON.parse(match[2]);
    } catch {
      name = undefined; // an escape JSON does not read: leave the name out rather than guess it
    }
    const key = `${match[1]}\u0000${name ?? ""}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    found.push({ role: match[1], ...(name === undefined || name === "" ? {} : { name }), key });
  }
  return found.slice(0, MAX_ELEMENTS).map(({ key, ...element }) => ({ ...element, ...(counts.get(key) > 1 ? { matches: counts.get(key) } : {}) }));
}

// The query string can carry tokens: requests are reported by origin and path only.
function withoutQuery(url) {
  try {
    const parsed = new URL(url);
    // about:, data:, chrome-error: and the like have an opaque or no origin ("null"): show scheme, host and path without query or fragment.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return clipValue(`${parsed.protocol}${parsed.host ? `//${parsed.host}` : ""}${parsed.pathname}`, 200);
    return clipValue(redactSecrets(`${parsed.origin}${parsed.pathname}`), 200);
  } catch {
    return clipValue(String(url).split("?")[0], 200);
  }
}

async function pageFacts(page) {
  const read = (work, label) => bounded(work, READ_MS, label).catch(() => null);
  const aria = await read(page.locator("body").ariaSnapshot({ timeout: READ_MS }), "reading the accessibility tree");
  const page_ = await read(page.evaluate(() => {
    const keys = area => { try { return Object.keys(area).slice(0, 50); } catch { return null; } };
    return {
      testIds: [...new Set([...document.querySelectorAll("[data-testid]")].map(element => element.getAttribute("data-testid")))].slice(0, 50),
      localStorage: keys(localStorage),
      sessionStorage: keys(sessionStorage),
      frames: window.frames.length,
    };
  }), "reading test ids and storage keys");
  return { aria, ...(page_ ?? { testIds: null, localStorage: null, sessionStorage: null, frames: null }) };
}

// Opens the page (and replays spec steps when given), then reports what is there.
export async function look({ url, specPath, until, screenshotPath }) {
  let spec = null;
  if (specPath !== undefined) {
    let text;
    try {
      text = await readFile(specPath, "utf8");
      spec = JSON.parse(text);
    } catch (error) {
      // A JSON.parse message can quote the file's own bytes, so only the kind of failure is reported.
      throw new Error(`spec could not be ${error instanceof SyntaxError ? "parsed as JSON" : `read (${error?.code ?? "error"})`}`);
    }
    const problems = validateSpec(spec);
    if (problems.length > 0) throw new Error(`invalid spec: ${problems.join("; ")}`);
    if (until !== undefined && (!Number.isInteger(until) || until < 0 || until > spec.steps.length)) {
      throw new Error(`--until must be a whole number from 0 to ${spec.steps.length} (the number of steps)`);
    }
  } else {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`--url is not a URL: ${clipValue(String(url), 100)}`);
    }
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("--url must be http or https");
  }

  let server = null;
  let session = null;
  try {
    let appUrl;
    let firstUrl;
    if (spec) {
      if (spec.app?.url) appUrl = spec.app.url;
      else {
        server = await startApp({ bug: spec.app?.bug });
        appUrl = server.url;
      }
      firstUrl = spec.app?.start === undefined ? appUrl : new URL(spec.app.start, appUrl).href;
    } else {
      firstUrl = url;
    }

    const consoleRecords = [];
    const pageErrors = [];
    const failedRequests = [];
    // Status of each top-level document response by URL. The report asks for the page it ends on, so a page that was
    // reached without a response (about:blank, history, cache) gets no status instead of an earlier page's.
    const documentStatuses = new Map();
    const failed = entry => { if (failedRequests.length < MAX_FAILED_REQUESTS) failedRequests.push(entry); };
    session = await openSession({
      firstUrl,
      timeoutMs: spec?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      env: spec?.env,
      hooks: {
        onConsole: (level, text) => { if (consoleRecords.length < MAX_CONSOLE) consoleRecords.push({ level, text: clipValue(redactSecrets(text), 300) }); },
        onPageError: message => { if (pageErrors.length < MAX_PAGE_ERRORS) pageErrors.push(clipValue(redactSecrets(message), 300)); },
        onResponse: response => {
          try {
            const request = response.request();
            if (request.resourceType() === "document" && request.frame().parentFrame() === null) {
              documentStatuses.delete(response.url()); // a later load of the same URL replaces the earlier status and counts as the newest
              documentStatuses.set(response.url(), response.status());
              if (documentStatuses.size > 200) documentStatuses.delete(documentStatuses.keys().next().value); // keep the newest: the final page is among them
            }
            if (response.status() >= 400) failed({ url: withoutQuery(response.url()), status: response.status() });
          } catch { /* a response of a page that is already closing */ }
        },
        onRequestFailed: request => failed({ url: withoutQuery(request.url()), failure: clipValue(request.failure()?.errorText ?? "failed", 100) }),
      },
    });

    const replayed = [];
    let ctx = null;
    if (spec) {
      ctx = createContext({ page: session.page, adopt: session.adopt, appUrl, specDir: dirname(resolve(specPath)), timeoutMs: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS, checks: [] });
      const last = until ?? spec.steps.length;
      for (const [index, step] of spec.steps.slice(0, last).entries()) {
        ctx.index = index + 1;
        const record = await runStep(ctx, step);
        replayed.push({ step: record.step, op: record.op, ok: record.ok, ...(record.skipped ? { skipped: record.skipped } : {}) });
      }
    }

    // A replayed step may have moved the spec to a popup: look at the page the spec ends on.
    const spent = ctx?.page ?? session.page;
    const view = spent.isClosed() ? spent.context().pages().at(-1) ?? spent : spent;
    const facts = await pageFacts(view);
    let title = null;
    try { title = await bounded(view.title(), 2000, "reading the title"); } catch { /* frozen or closed page */ }
    let screenshot = null;
    if (screenshotPath !== undefined) {
      const png = await bounded(view.screenshot({ fullPage: true, timeout: 5000 }), 8000, "taking the picture");
      await writeFile(screenshotPath, png, { flag: "wx" }); // never replaces a file that is already there
      screenshot = screenshotPath;
    }
    return {
      url: withoutQuery(view.url()),
      title,
      status: documentStatuses.get(view.url().split("#")[0]) ?? null,
      replayed,
      aria: facts.aria === null ? null : clipValue(facts.aria, ARIA_CHARS),
      elements: facts.aria === null ? [] : actionableElements(facts.aria),
      testIds: facts.testIds,
      storage: { local: facts.localStorage, session: facts.sessionStorage },
      frames: facts.frames,
      console: consoleRecords,
      pageErrors,
      failedRequests,
      screenshot,
    };
  } finally {
    if (session) await session.close();
    if (server) await server.close().catch(() => {});
  }
}

export function formatLook(result) {
  const lines = [`${result.url}  ${result.title === null ? "(no title)" : JSON.stringify(result.title)}${result.status === null ? "" : `  HTTP ${result.status}`}`];
  if (result.replayed.length > 0) {
    lines.push(`  replayed ${result.replayed.length} step(s): ${result.replayed.map(step => `${step.step}:${step.op}${step.ok ? "" : "(failed)"}`).join(" ")}`);
  }
  lines.push("  targets a spec can use:");
  for (const element of result.elements) {
    lines.push(`    ${JSON.stringify({ role: element.role, ...(element.name === undefined ? {} : { name: element.name }) })}${element.matches ? `   (${element.matches} matches: add nth or narrow it)` : ""}`);
  }
  if (result.elements.length === 0) lines.push("    (none found)");
  if (result.testIds?.length > 0) lines.push(`  test ids: ${result.testIds.join(", ")}`);
  if (result.storage.local?.length > 0) lines.push(`  localStorage keys: ${result.storage.local.join(", ")}`);
  if (result.storage.session?.length > 0) lines.push(`  sessionStorage keys: ${result.storage.session.join(", ")}`);
  if (result.frames > 0) lines.push(`  frames: ${result.frames} (a target inside one needs "frame")`);
  for (const record of result.console) lines.push(`  [console ${record.level}] ${record.text}`);
  for (const message of result.pageErrors) lines.push(`  [pageerror] ${message}`);
  for (const request of result.failedRequests) lines.push(`  [request] ${request.url} ${request.status ?? request.failure}`);
  if (result.screenshot) lines.push(`  picture: ${result.screenshot}`);
  lines.push("  accessibility tree:");
  lines.push(...(result.aria === null ? ["    (unavailable)"] : result.aria.split("\n").map(line => `    ${line}`)));
  return lines.join("\n");
}

const CLI_OPTIONS = {
  url: { type: "string" },
  spec: { type: "string" },
  until: { type: "string" },
  screenshot: { type: "string" },
  json: { type: "boolean" },
};

export async function main(args) {
  const values = parseCli(args, CLI_OPTIONS);
  if ((values.url === undefined) === (values.spec === undefined)) throw new Error("give exactly one of --url <http(s) url> or --spec <file.json>");
  if (values.until !== undefined && values.spec === undefined) throw new Error("--until applies to --spec only");
  let until;
  if (values.until !== undefined) {
    until = Number(values.until);
    if (values.until.trim() === "" || !Number.isInteger(until)) throw new Error("--until must be a whole number");
  }
  const result = await look({ url: values.url, specPath: values.spec, until, screenshotPath: values.screenshot });
  console.log(values.json ? JSON.stringify(result, null, 2) : formatLook(result));
  return 0;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`ERROR: ${firstLine(error)}`);
    process.exitCode = 2;
  }
}
