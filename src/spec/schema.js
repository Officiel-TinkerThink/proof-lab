// Spec schema: the one place that says which ops exist, which fields each takes and which are required.
// Unknown fields are errors: a typo such as "equal" must not turn an assertion into a silent no-op.
// Everything a validator can know without a browser is checked here, so a bad spec costs no browser run.

import { BUILTIN_VARS, MAX_CAPTURES, VAR_NAME, referencesOf } from "./vars.js";

export const TARGET_KEYS =["role", "label", "text", "placeholder", "altText", "title", "testId", "selector"];

// How a step names the element it acts on. Exactly one of TARGET_KEYS; the rest refine it.
export const TARGET_FIELDS = {
  role: "string", label: "string", text: "string", placeholder: "string", altText: "string",
  title: "string", testId: "string", selector: "string",
  exact: "boolean", hasText: "string", nth: "integer", frame: "string|array",
  checked: "boolean", disabled: "boolean", expanded: "boolean", pressed: "boolean", selected: "boolean",
  level: "integer", includeHidden: "boolean",
};

// These refine a role locator only. On any other target Playwright would drop them silently.
const ROLE_ONLY_FIELDS = ["checked", "disabled", "expanded", "pressed", "selected", "level", "includeHidden"];

// "name" is the accessible name when a role is given; without a role it is the older spelling of "check".
const COMMON_FIELDS = { op: "string", check: "string", name: "string", hint: "string", timeout: "number", optional: "boolean" };

const MATCH = { equals: "string", contains: "string", matches: "string", flags: "string" };
const MATCH_ONE = ["equals", "contains", "matches"];
const KEY_MODIFIERS = ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"];
const STATES = ["enabled", "disabled", "editable", "checked", "unchecked", "indeterminate", "focused", "attached", "detached", "inViewport"];
// g and y make a RegExp remember where it stopped, so repeated reads of the same text would disagree.
const REGEX_FLAGS = /^[dimsuv]*$/;

const CLICK_FIELDS = { button: ["left", "right", "middle"], clickCount: "integer", modifiers: "array", position: "object", force: "boolean", delay: "number" };

// Inclusive [min, max] for numeric fields.
const RANGES = {
  nth: [0, Infinity], level: [0, Infinity], clickCount: [1, Infinity], delay: [0, Infinity],
  count: [0, Infinity], min: [0, Infinity], max: [0, Infinity], status: [100, 599],
  width: [1, 10000], height: [1, 10000], latitude: [-90, 90], longitude: [-180, 180], accuracy: [0, Infinity], ms: [0, Infinity], index: [0, Infinity],
};

// Element types for array fields.
const ITEMS = { frame: "string", byValue: "string", byLabel: "string", byIndex: "integer" };

const FILE_FIELDS = { name: "string", mimeType: "string", text: "string", base64: "string" };

const MEDIA = ["screen", "print"];
const COLOR_SCHEMES = ["light", "dark", "no-preference"];
const REDUCED_MOTION = ["reduce", "no-preference"];
const CLOCK_ACTIONS = ["install", "setFixedTime", "pauseAt", "fastForward", "runFor", "resume"];
// The permission names Chromium accepts in Playwright's grantPermissions.
export const PERMISSIONS = ["accelerometer", "ambient-light-sensor", "background-sync", "camera", "clipboard-read", "clipboard-write", "geolocation", "gyroscope", "local-fonts", "magnetometer", "microphone", "midi", "midi-sysex", "notifications", "payment-handler", "storage-access"];

// target: "none" | "optional" | "required". assertion: true adds "not". oneOf: exactly one. anyOf: at least one.
// forbidden: fields that make no sense for the op. conflicts: pairs that cannot be given together.
export const OPS = {
  // Not an assertion: a claim for a human to judge. It never passes or fails; the run ends "needs review" (exit 3).
  review: { target: "none", fields: { note: "string" }, required: ["check"], forbidden: ["optional", "timeout", "hint", "name"] },
  goto: { target: "none", fields: { url: "string", status: "integer" }, required: ["url"] },
  back: { target: "none", fields: {} },
  forward: { target: "none", fields: {} },
  reload: { target: "none", fields: {} },
  waitForUrl: { target: "none", fields: MATCH, oneOf: MATCH_ONE },
  waitFor: { target: "required", fields: { state: ["attached", "detached", "visible", "hidden"] } },

  click: { target: "required", fields: CLICK_FIELDS },
  dblclick: { target: "required", fields: { button: CLICK_FIELDS.button, modifiers: "array", position: "object", force: "boolean", delay: "number" } },
  hover: { target: "required", fields: { modifiers: "array", position: "object", force: "boolean" } },
  focus: { target: "required", fields: {} },
  blur: { target: "required", fields: {} },
  clear: { target: "required", fields: {} },
  fill: { target: "required", fields: { value: "string" }, required: ["value"] },
  type: { target: "required", fields: { value: "string", delay: "number" }, required: ["value"] },
  press: { target: "optional", fields: { key: "string" }, required: ["key"] },
  check: { target: "required", fields: {} },
  uncheck: { target: "required", fields: {} },
  // byValue/byLabel/byIndex, not value/label/index: "label" is already a target field (getByLabel).
  selectOption: { target: "required", fields: { byValue: "string|array", byLabel: "string|array", byIndex: "integer|array" }, oneOf: ["byValue", "byLabel", "byIndex"] },
  setInputFiles: { target: "required", fields: { files: "array" }, required: ["files"] },
  dragTo: { target: "required", fields: { to: "object", html5: "boolean" }, required: ["to"] },
  scrollIntoView: { target: "required", fields: {} },
  scroll: { target: "optional", fields: { x: "number", y: "number" }, anyOf: ["x", "y"] },

  assertText: { target: "required", assertion: true, fields: MATCH, oneOf: MATCH_ONE },
  assertValue: { target: "required", assertion: true, fields: MATCH, oneOf: MATCH_ONE },
  assertValues: { target: "required", assertion: true, fields: { equals: "array" }, required: ["equals"], items: { equals: "string" } },
  assertVisible: { target: "required", assertion: true, fields: { visible: "boolean" } },
  assertState: { target: "required", assertion: true, fields: { state: STATES }, required: ["state"] },
  assertAttribute: { target: "required", assertion: true, fields: { attribute: "string", ...MATCH, absent: "boolean" }, required: ["attribute"], oneOf: [...MATCH_ONE, "absent"] },
  assertProperty: { target: "required", assertion: true, fields: { property: "string", equals: "any" }, required: ["property", "equals"] },
  assertCss: { target: "required", assertion: true, fields: { property: "string", ...MATCH }, required: ["property"], oneOf: MATCH_ONE },
  // count counts every match, so nth (which narrows to one) has no meaning here.
  assertCount: { target: "required", assertion: true, fields: { count: "integer", min: "integer", max: "integer" }, anyOf: ["count", "min", "max"], forbidden: ["nth"], conflicts: [["count", "min"], ["count", "max"]] },
  // WCAG contrast ratio of the element's text colour on its background; min defaults to 4.5. A ratio that cannot be computed
  // (a background image or gradient, opacity) becomes a claim for a human, never a pass.
  assertContrast: { target: "required", assertion: true, fields: { min: "number" } },
  assertUrl: { target: "none", assertion: true, fields: MATCH, oneOf: MATCH_ONE },
  assertTitle: { target: "none", assertion: true, fields: MATCH, oneOf: MATCH_ONE },
  // path reads inside the stored value, so it needs equals: with exists it would be silently ignored.
  assertStorage: { target: "none", assertion: true, fields: { area: ["local", "session"], key: "string", path: "string", equals: "any", exists: "boolean" }, required: ["key"], oneOf: ["equals", "exists"], conflicts: [["exists", "path"]] },

  // Environment: what the visitor's browser looks like. Values that only a new browser context can set (locale, time zone)
  // belong to the top-level "env" block; these ops change the running page.
  setViewport: { target: "none", fields: { width: "integer", height: "integer" }, required: ["width", "height"] },
  emulateMedia: { target: "none", fields: { media: MEDIA, colorScheme: COLOR_SCHEMES, reducedMotion: REDUCED_MOTION }, anyOf: ["media", "colorScheme", "reducedMotion"] },
  setOffline: { target: "none", fields: { offline: "boolean" }, required: ["offline"] },
  grantPermissions: { target: "none", fields: { permissions: "array" }, required: ["permissions"] },
  clearPermissions: { target: "none", fields: {} },
  setGeolocation: { target: "none", fields: { latitude: "number", longitude: "number", accuracy: "number" }, required: ["latitude", "longitude"] },
  // "cookie" is the cookie's name: "name" already labels the step.
  setCookie: { target: "none", fields: { cookie: "string", value: "string", path: "string", httpOnly: "boolean", secure: "boolean", sameSite: ["Strict", "Lax", "None"] }, required: ["cookie", "value"] },
  clearCookies: { target: "none", fields: { cookie: "string" } },
  assertCookie: { target: "none", assertion: true, fields: { cookie: "string", path: "string", ...MATCH, exists: "boolean" }, required: ["cookie"], oneOf: [...MATCH_ONE, "exists"] },
  setStorage: { target: "none", fields: { area: ["local", "session"], key: "string", value: "any" }, required: ["key", "value"] },
  clearStorage: { target: "none", fields: { area: ["local", "session"], key: "string" } },
  // install and setFixedTime/pauseAt take a time, fastForward and runFor take milliseconds.
  clock: { target: "none", fields: { action: CLOCK_ACTIONS, time: "string|number", ms: "number" }, required: ["action"] },

  // Reads one value off the page into a variable for later steps ({{name}}, see vars.js). Not an assertion: it records no check.
  capture: { target: "required", fields: { as: "string", from: ["text", "value", "count", "attribute"], attribute: "string" }, required: ["as", "from"], forbidden: ["optional"] },

  // Tabs: index counts open tabs in the order they were opened (0 = the first page); the other form matches the address.
  switchTab: { target: "none", fields: { index: "integer", ...MATCH }, oneOf: ["index", ...MATCH_ONE] },
  closeTab: { target: "none", fields: {} },
};

// These steps can cause a dialog, a download or a popup, so they take an "expect" block (see EXPECT_KINDS).
const EXPECTING_OPS = ["goto", "back", "forward", "reload", "click", "dblclick", "press", "check", "uncheck", "selectOption", "setInputFiles", "dragTo"];
for (const op of EXPECTING_OPS) OPS[op] = { ...OPS[op], fields: { ...OPS[op].fields, expect: "object" } };

const DIALOG_TYPES = ["alert", "confirm", "prompt", "beforeunload"];
const MAX_WITHIN_MS = 60000;
// What each kind of expectation may say. A text field is a string (equals) or an object with one of equals, contains, matches.
const EXPECT_KINDS = {
  dialog: { type: DIALOG_TYPES, message: "string|object", action: ["accept", "dismiss"], promptText: "string", appears: "boolean", within: "number" },
  download: { filename: "string|object", content: "string|object", appears: "boolean", within: "number" },
  popup: { url: "string|object", title: "string|object", switchTo: "boolean", appears: "boolean", within: "number" },
};
const EXPECT_TEXT_FIELDS = { dialog: ["message"], download: ["filename", "content"], popup: ["url", "title"] };

// Browser-context settings a spec may fix for the whole run.
const ENV_FIELDS = { viewport: "object", locale: "string", timezoneId: "string", colorScheme: COLOR_SCHEMES, reducedMotion: REDUCED_MOTION, geolocation: "object", permissions: "array" };

const TOP_LEVEL = { name: "string", app: "object", env: "object", steps: "array", timeoutMs: "number", noPageErrors: "boolean", allowPageErrors: "array" };
// Expected browser noise (a refusal's own "Failed to load resource: 401") a spec may exempt from noPageErrors.
const MAX_ALLOWED_ERRORS = 20;
const MAX_ALLOWED_ERROR_LENGTH = 200;
const APP_FIELDS = { url: "string", bug: "string", start: "string" };
const MAX_STEPS = 500;
const MAX_TIMEOUT_MS = 600000;

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const has = (object, key) => Object.hasOwn(object, key);
const TYPES = {
  string: value => typeof value === "string",
  number: value => typeof value === "number" && Number.isFinite(value),
  integer: value => Number.isInteger(value),
  boolean: value => typeof value === "boolean",
  array: Array.isArray,
  object: isObject,
  any: () => true,
};

function typeProblem(value, type) {
  if (Array.isArray(type)) return type.includes(value) ? null : `one of ${type.join(", ")}`;
  return type.split("|").some(name => TYPES[name](value)) ? null : type.split("|").join(" or ");
}

// Own properties only: a key such as "constructor" or "__proto__" is an unknown field, never a lookup into Object.prototype.
function checkFields(owner, label, definitions, problems) {
  for (const key of Object.keys(owner)) {
    if (!has(definitions, key)) {
      problems.push(`${label} has unknown field "${key}"`);
      continue;
    }
    const wanted = typeProblem(owner[key], definitions[key]);
    if (wanted) problems.push(`${label}.${key} must be ${wanted}`);
  }
}

function checkRanges(owner, label, problems) {
  for (const [key, [low, high]] of Object.entries(RANGES)) {
    const value = owner[key];
    if (typeof value === "number" && (value < low || value > high)) {
      problems.push(`${label}.${key} must be ${high === Infinity ? `${low} or more` : `from ${low} to ${high}`}`);
    }
  }
}

function checkItems(owner, label, problems, extra = {}) {
  for (const [key, type] of Object.entries({ ...ITEMS, ...extra })) {
    if (!Array.isArray(owner[key])) continue;
    if (owner[key].length === 0 && key !== "equals") problems.push(`${label}.${key} must not be an empty list`);
    owner[key].forEach((item, index) => {
      if (typeProblem(item, type)) problems.push(`${label}.${key}[${index}] must be ${type}`);
    });
  }
  // An option index counts from 0.
  const indexes = [].concat(owner.byIndex ?? []);
  indexes.forEach((value, position) => {
    if (typeof value === "number" && value < 0) problems.push(`${label}.byIndex${Array.isArray(owner.byIndex) ? `[${position}]` : ""} must be 0 or more`);
  });
  if (Array.isArray(owner.modifiers)) {
    for (const name of owner.modifiers) {
      if (!KEY_MODIFIERS.includes(name)) problems.push(`${label}.modifiers must each be one of ${KEY_MODIFIERS.join(", ")}`);
    }
  }
}

// Target keys of a step or of a nested target (dragTo.to): exactly the rules a locator needs.
function checkTarget(owner, label, { required, nested }, problems) {
  const keys = TARGET_KEYS.filter(key => owner[key] !== undefined);
  if (required && keys.length === 0) problems.push(`${label} needs a target: one of ${TARGET_KEYS.join(", ")}`);
  if (keys.length > 1) problems.push(`${label} has more than one target (${keys.join(", ")}); use one`);
  // These only refine a target. Without one the runner would act on the page and drop them silently.
  if (keys.length === 0) {
    for (const refinement of ["frame", "nth", "hasText", "exact"]) {
      if (owner[refinement] !== undefined) problems.push(`${label}: ${refinement} needs a target`);
    }
  }
  const misplaced = ROLE_ONLY_FIELDS.filter(key => owner[key] !== undefined);
  if (misplaced.length > 0 && owner.role === undefined) {
    problems.push(`${label}: ${misplaced.join(", ")} apply to a role target only; add role, or remove them`);
  }
  if (nested && owner.name !== undefined && owner.role === undefined) problems.push(`${label}: name applies to a role target only`);
}

function checkPosition(owner, label, problems) {
  if (!isObject(owner.position)) return;
  checkFields(owner.position, `${label}.position`, { x: "number", y: "number" }, problems);
  if (owner.position.x === undefined || owner.position.y === undefined) problems.push(`${label}.position needs x and y`);
}

function checkFiles(files, label, problems) {
  files.forEach((file, index) => {
    const at = `${label}.files[${index}]`;
    if (typeof file === "string") {
      if (file === "") problems.push(`${at} must not be empty`);
    } else if (isObject(file)) {
      checkFields(file, at, FILE_FIELDS, problems);
      if (typeof file.name !== "string" || file.name === "") problems.push(`${at} needs a name`);
      if (file.text !== undefined && file.base64 !== undefined) problems.push(`${at} has both text and base64; use one`);
    } else {
      problems.push(`${label}.files[${index}] must be a path or an object with a name`);
    }
  });
}

function checkPermissions(permissions, label, problems) {
  if (permissions.length === 0) problems.push(`${label} must not be an empty list`);
  permissions.forEach((name, index) => {
    if (!PERMISSIONS.includes(name)) problems.push(`${label}[${index}] must be one of ${PERMISSIONS.join(", ")}`);
  });
}

const CLOCK_TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2}))?$/;

function checkClock(step, label, problems) {
  const needsTime = ["setFixedTime", "pauseAt"].includes(step.action);
  const needsMs = ["fastForward", "runFor"].includes(step.action);
  if (needsTime && step.time === undefined) problems.push(`${label} (${step.action}) needs "time"`);
  if (needsMs && step.ms === undefined) problems.push(`${label} (${step.action}) needs "ms"`);
  if (!needsTime && step.action !== "install" && step.time !== undefined) problems.push(`${label} (${step.action}) cannot use "time"`);
  if (!needsMs && step.ms !== undefined) problems.push(`${label} (${step.action}) cannot use "ms"`);
  // A date-time without an offset is read in the time zone of the machine running the spec, so the same spec would set
  // different instants on different hosts: the offset (Z or +hh:mm) is required, and a bare date is UTC midnight.
  if (typeof step.time === "string" && !(CLOCK_TIME.test(step.time) && !Number.isNaN(Date.parse(step.time)))) problems.push(`${label}.time is not a date with an explicit offset: use an ISO 8601 string such as 2026-01-31T09:00:00Z or 2026-01-31T09:00:00+02:00, a date such as 2026-01-31 (UTC midnight), or epoch milliseconds`);
  if (typeof step.time === "number" && !(step.time >= 0)) problems.push(`${label}.time must be 0 or more (epoch milliseconds)`);
}

// A text expectation inside an expect block: a string means equals; an object has exactly one of equals, contains, matches.
function checkTextMatcher(value, label, problems) {
  if (!isObject(value)) return;
  checkFields(value, label, MATCH, problems);
  const given = MATCH_ONE.filter(key => value[key] !== undefined);
  if (given.length !== 1) problems.push(`${label} needs exactly one of ${MATCH_ONE.join(", ")}`);
  if (value.flags !== undefined && value.matches === undefined) problems.push(`${label}.flags only applies with matches`);
  if (typeof value.flags === "string" && !REGEX_FLAGS.test(value.flags)) problems.push(`${label}.flags may only use d, i, m, s, u, v`);
  if (typeof value.matches === "string") {
    try { new RegExp(value.matches, value.flags); } catch (error) { problems.push(`${label}.matches is not a valid regular expression: ${error.message}`); }
  }
}

// The expect block of an action step: one object per kind of event the step must cause.
function checkExpect(expect, label, problems) {
  const at = `${label}.expect`;
  checkFields(expect, at, { dialog: "object", download: "object", popup: "object" }, problems);
  if (Object.keys(expect).length === 0) problems.push(`${at} needs at least one of ${Object.keys(EXPECT_KINDS).join(", ")}`);
  for (const [kind, fields] of Object.entries(EXPECT_KINDS)) {
    const block = expect[kind];
    if (!isObject(block)) continue;
    const path = `${at}.${kind}`;
    checkFields(block, path, fields, problems);
    for (const key of EXPECT_TEXT_FIELDS[kind]) checkTextMatcher(block[key], `${path}.${key}`, problems);
    if (typeof block.within === "number" && !(block.within >= 0 && block.within <= MAX_WITHIN_MS)) problems.push(`${path}.within must be from 0 to ${MAX_WITHIN_MS}`);
    if (block.appears === false) {
      const extra = Object.keys(block).filter(key => key !== "appears" && key !== "within");
      if (extra.length > 0) problems.push(`${path}: appears false means nothing may happen, so ${extra.join(", ")} cannot be given`);
    } else if (block.within !== undefined) {
      problems.push(`${path}.within only applies with appears: false (the step's timeout is how long an expected event is waited for)`);
    }
    if (kind === "dialog" && block.promptText !== undefined && (block.action === "dismiss" || (block.type !== undefined && block.type !== "prompt"))) {
      problems.push(`${path}.promptText only applies when a prompt is accepted`);
    }
  }
}

// The settings that fix the browser context for the whole run: checked without a browser.
function checkEnv(env, problems) {
  checkFields(env, "env", ENV_FIELDS, problems);
  if (isObject(env.viewport)) {
    checkFields(env.viewport, "env.viewport", { width: "integer", height: "integer" }, problems);
    if (env.viewport.width === undefined || env.viewport.height === undefined) problems.push("env.viewport needs width and height");
    checkRanges(env.viewport, "env.viewport", problems);
  }
  if (isObject(env.geolocation)) {
    checkFields(env.geolocation, "env.geolocation", { latitude: "number", longitude: "number", accuracy: "number" }, problems);
    if (env.geolocation.latitude === undefined || env.geolocation.longitude === undefined) problems.push("env.geolocation needs latitude and longitude");
    checkRanges(env.geolocation, "env.geolocation", problems);
  }
  if (typeof env.locale === "string") {
    try { Intl.getCanonicalLocales(env.locale); } catch { problems.push(`env.locale is not a valid locale tag: ${JSON.stringify(env.locale)}`); }
  }
  if (typeof env.timezoneId === "string") {
    try { new Intl.DateTimeFormat("en", { timeZone: env.timezoneId }); } catch { problems.push(`env.timezoneId is not a time zone this runtime knows: ${JSON.stringify(env.timezoneId)}`); }
  }
  if (Array.isArray(env.permissions)) checkPermissions(env.permissions, "env.permissions", problems);
}

function validateStep(step, at) {
  if (!isObject(step)) return [`${at} must be an object`];
  if (typeof step.op !== "string") return [`${at}.op must be a string, one of ${Object.keys(OPS).join(", ")}`];
  if (!has(OPS, step.op)) return [`${at}.op "${step.op}" is not one of ${Object.keys(OPS).join(", ")}`];
  const definition = OPS[step.op];

  const label = `${at} (${step.op})`;
  const problems = [];
  const known = { ...COMMON_FIELDS, ...(definition.target === "none" ? {} : TARGET_FIELDS), ...definition.fields, ...(definition.assertion ? { not: "boolean" } : {}) };
  checkFields(step, label, known, problems);
  if (problems.length > 0) return problems; // field-level problems make the rule checks below noise

  for (const field of definition.required ?? []) {
    if (step[field] === undefined) problems.push(`${label} needs "${field}"`);
  }
  for (const field of definition.forbidden ?? []) {
    if (step[field] !== undefined) problems.push(`${label} cannot use "${field}"`);
  }
  for (const [first, second] of definition.conflicts ?? []) {
    if (step[first] !== undefined && step[second] !== undefined) problems.push(`${label} cannot combine "${first}" with "${second}"`);
  }
  if (definition.target !== "none") checkTarget(step, label, { required: definition.target === "required", nested: false }, problems);
  if (definition.oneOf) {
    const given = definition.oneOf.filter(key => step[key] !== undefined);
    if (given.length !== 1) problems.push(`${label} needs exactly one of ${definition.oneOf.join(", ")}`);
  }
  if (definition.anyOf && !definition.anyOf.some(key => step[key] !== undefined)) {
    problems.push(`${label} needs at least one of ${definition.anyOf.join(", ")}`);
  }

  if (step.flags !== undefined && step.matches === undefined) problems.push(`${label}.flags only applies with matches`);
  if (typeof step.flags === "string" && !REGEX_FLAGS.test(step.flags)) problems.push(`${label}.flags may only use d, i, m, s, u, v (g and y make a pattern remember state between reads)`);
  if (typeof step.matches === "string") {
    try { new RegExp(step.matches, step.flags); } catch (error) {
      problems.push(`${label}.matches is not a valid regular expression: ${error.message}`);
    }
  }

  // Playwright reads a timeout of 0 as "wait forever". For an assertion, 0 means "read once".
  if (typeof step.timeout === "number") {
    if (definition.assertion && step.timeout < 0) problems.push(`${label}.timeout must not be negative`);
    if (!definition.assertion && step.timeout < 1) problems.push(`${label}.timeout must be at least 1 ms (0 would wait forever); only assertions may use 0, to read once`);
    if (step.timeout > MAX_TIMEOUT_MS) problems.push(`${label}.timeout must be at most ${MAX_TIMEOUT_MS}`);
  }
  checkRanges(step, label, problems);
  checkItems(step, label, problems, definition.items);
  checkPosition(step, label, problems);
  if (typeof step.min === "number" && typeof step.max === "number" && step.min > step.max) problems.push(`${label}.min must not exceed max`);
  if (Array.isArray(step.files)) checkFiles(step.files, label, problems);
  if (step.optional === true && definition.assertion) problems.push(`${label}: an assertion cannot be optional`);
  if (step.op === "press" && typeof step.key === "string" && step.key.trim() === "") problems.push(`${label}.key must not be empty`);
  if (step.op === "goto" && typeof step.url === "string" && step.url.trim() === "") problems.push(`${label}.url must not be empty`);
  if (Array.isArray(step.permissions)) checkPermissions(step.permissions, `${label}.permissions`, problems);
  if (step.op === "clock") checkClock(step, label, problems);
  if (isObject(step.expect)) checkExpect(step.expect, label, problems);
  if (step.op === "capture") {
    if (typeof step.as === "string" && (!VAR_NAME.test(step.as) || BUILTIN_VARS.includes(step.as))) {
      problems.push(`${label}.as must be a name of letters, digits and _ (starting with a letter, at most 40), and not a built-in (${BUILTIN_VARS.join(", ")})`);
    }
    if (step.from === "count" && step.nth !== undefined) problems.push(`${label}: nth narrows to one element, so it has no meaning when from is "count" (count counts every match)`);
    if (step.from === "attribute" && step.attribute === undefined) problems.push(`${label} needs "attribute" when from is "attribute"`);
    if (step.from !== "attribute" && step.attribute !== undefined) problems.push(`${label}.attribute only applies when from is "attribute"`);
  }
  if (step.op === "setCookie") {
    if (step.cookie === "") problems.push(`${label}.cookie must not be empty`);
    if (typeof step.path === "string" && !step.path.startsWith("/")) problems.push(`${label}.path must start with /`);
    if (step.sameSite === "None" && step.secure !== true) problems.push(`${label}: sameSite None needs secure: true (browsers refuse it otherwise)`);
  }
  if ((step.op === "assertCookie" || step.op === "clearCookies") && step.cookie === "") problems.push(`${label}.cookie must not be empty`);
  if (step.op === "dragTo" && isObject(step.to)) {
    checkFields(step.to, `${label}.to`, { ...TARGET_FIELDS, name: "string" }, problems);
    checkTarget(step.to, `${label}.to`, { required: true, nested: true }, problems);
    checkRanges(step.to, `${label}.to`, problems);
    checkItems(step.to, `${label}.to`, problems);
  }
  return problems;
}

// A step records a check when it asserts, when goto is told which status to expect, or when it has an expect block.
const recordsCheck = step => isObject(step) && has(OPS, step.op) && (OPS[step.op].assertion === true || (step.op === "goto" && step.status !== undefined) || isObject(step.expect));

function checkApp(app, problems) {
  checkFields(app, "app", APP_FIELDS, problems);
  if (app.url !== undefined && app.bug !== undefined) problems.push("app.url and app.bug cannot both be set: a bug is injected into the built-in app only");
  if (typeof app.url === "string") {
    let protocol = null;
    try { protocol = new URL(app.url).protocol; } catch { /* reported below */ }
    if (protocol !== "http:" && protocol !== "https:") problems.push("app.url must be an http or https URL");
  }
  // One leading slash only: "//host/x" would send the run to another host.
  if (typeof app.start === "string" && !/^\/(?!\/)[^\\\s]*$/.test(app.start)) {
    problems.push("app.start must be a path starting with a single /, with no backslash or spaces");
  }
}

export function validateSpec(spec) {
  if (!isObject(spec)) return ["spec must be a JSON object"];
  const problems = [];
  checkFields(spec, "spec", TOP_LEVEL, problems);
  // The name as written: a trailing newline, a DEL or a C1 control must not be trimmed away before the check.
  if (typeof spec.name !== "string" || spec.name !== spec.name.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(spec.name)
    || [...spec.name].length < 1 || [...spec.name].length > 100) {
    problems.push("name must be 1 to 100 characters, with no control characters and no leading or trailing space");
  }
  if (isObject(spec.app)) checkApp(spec.app, problems);
  if (isObject(spec.env)) checkEnv(spec.env, problems);
  if (Array.isArray(spec.allowPageErrors)) {
    const list = spec.allowPageErrors;
    if (list.length > MAX_ALLOWED_ERRORS) problems.push(`allowPageErrors must not hold more than ${MAX_ALLOWED_ERRORS} entries`);
    list.forEach((text, index) => {
      if (typeof text !== "string" || text.length < 1 || text.length > MAX_ALLOWED_ERROR_LENGTH) {
        problems.push(`allowPageErrors[${index}] must be a text of 1 to ${MAX_ALLOWED_ERROR_LENGTH} characters`);
      }
    });
    if (spec.noPageErrors !== true) problems.push("allowPageErrors only has a meaning with noPageErrors: true");
  }
  if (typeof spec.timeoutMs === "number" && !(spec.timeoutMs >= 1 && spec.timeoutMs <= MAX_TIMEOUT_MS)) {
    problems.push(`timeoutMs must be from 1 to ${MAX_TIMEOUT_MS}`);
  }
  if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
    problems.push("steps must be a non-empty array");
    return problems;
  }
  if (spec.steps.length > MAX_STEPS) problems.push(`steps must not hold more than ${MAX_STEPS} entries`);
  spec.steps.forEach((step, index) => problems.push(...validateStep(step, `steps[${index}]`)));
  // A {{name}} must be built in or set by an earlier capture step, so a typo is caught here, not in a browser run.
  const known = new Set(BUILTIN_VARS);
  let captures = 0;
  spec.steps.forEach((step, index) => {
    if (!isObject(step)) return;
    for (const { field, name } of referencesOf(step)) {
      if (!known.has(name)) problems.push(`steps[${index}].${field} uses {{${name}}}, which no earlier capture step sets (write \\{{${name}}} for the literal text)`);
    }
    if (step.op === "capture" && typeof step.as === "string") {
      known.add(step.as);
      captures += 1;
    }
  });
  if (captures > MAX_CAPTURES) problems.push(`spec must not hold more than ${MAX_CAPTURES} capture steps`);
  if (problems.length === 0 && !spec.steps.some(recordsCheck) && spec.noPageErrors !== true) {
    problems.push("spec has no assertions, so it would pass without proving anything: add an assert step, a goto with status, or noPageErrors: true");
  }
  return problems;
}
