import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const firstLine = error => (error instanceof Error ? error.message : String(error)).split("\n")[0];

// The first line, and for a Playwright "strict mode violation" the first few matched elements it lists after it, so an
// author sees which elements the target matched. Each element is reduced to its tag and its id, data-testid and name when
// those are plain identifiers; nothing else of the page's markup (values, text) is kept.
const MAX_LISTED_ELEMENTS = 4;
const IDENTIFIER_ATTRIBUTES = ["id", "data-testid", "name"];
const describeElement = line => {
  const opening = /^\s*\d+\) <([a-zA-Z][a-zA-Z0-9-]{0,30})/.exec(line);
  if (!opening) return "<element>";
  // Attributes are read one after the other from the end of the tag name and the scan stops at the first thing that is not
  // name="value": text inside the element, or a quote inside a value, is never looked at.
  const attributes = [];
  let rest = line.slice(opening[0].length);
  for (let match = /^\s+([A-Za-z][A-Za-z0-9:_-]*)="([^"]*)"/.exec(rest); match && attributes.length < 12; match = /^\s+([A-Za-z][A-Za-z0-9:_-]*)="([^"]*)"/.exec(rest)) {
    if (IDENTIFIER_ATTRIBUTES.includes(match[1]) && /^[A-Za-z0-9_-]{1,40}$/.test(match[2])) attributes.push(`${match[1]}=${match[2]}`);
    rest = rest.slice(match[0].length);
  }
  return `<${[opening[1], ...attributes].join(" ")}>`;
};
export function errorDetail(error) {
  const lines = (error instanceof Error ? error.message : String(error)).split("\n");
  if (!/strict mode violation/.test(lines[0])) return lines[0];
  const listed = lines.slice(1).filter(line => /^\s*\d+\) /.test(line)).slice(0, MAX_LISTED_ELEMENTS)
    .map(describeElement);
  return listed.length === 0 ? lines[0] : `${lines[0]} ${listed.join(" | ")}`;
}

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
