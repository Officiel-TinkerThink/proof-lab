import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const firstLine = error => (error instanceof Error ? error.message : String(error)).split("\n")[0];

// Only the first line of an error: the rest of a Playwright message quotes the page's markup. A target that matched
// several elements is listed from the page itself instead (locate.js, describeMatches).
export const errorDetail = firstLine;

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Drops undefined values so optional spec fields are not passed to Playwright as explicit undefined.
export const defined = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

export const pick = (object, keys) => defined(Object.fromEntries(keys.map(key => [key, object[key]])));

export const readPath = (value, path) => path.split(".").reduce((node, part) => node?.[part], value);

// A promise that gives up after ms. For calls Playwright cannot time out itself (a frozen page never answers title()).
// The timer is released as soon as the promise settles, and the late result of the abandoned call is ignored.
export function bounded(promise, ms, what = "the call") {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms (the page may be frozen)`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Command line parsing that refuses what it does not understand: an unknown flag, a flag without its value, a stray
// word. A misspelt --receipts must be an error, not a silent fall back to the default directory.
export function parseCli(args, options) {
  return parseArgs({ args, options, strict: true, allowPositionals: false }).values;
}

// True when this module is the program being run. Real paths are compared so a symlink, a junction or a different
// drive-letter case still counts. If the entry path cannot be resolved ("node src/run-spec" without the extension),
// the entry is almost certainly this module, so names are compared instead: a CLI must never exit 0 having done nothing.
export function isMainModule(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(importMetaUrl);
  try {
    return realpathSync.native(entry) === realpathSync.native(self);
  } catch {
    const bare = path => path.replace(/\.[cm]?js$/i, "").toLowerCase();
    return bare(resolve(entry)) === bare(self);
  }
}
