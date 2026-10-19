// Spec schema: the one place that says which ops exist, which fields each takes and which are required.
// Unknown fields are errors: a typo such as "equal" must not turn an assertion into a silent no-op.
// Everything a validator can know without a browser is checked here, so a bad spec costs no browser run.

export const TARGET_KEYS = ["role", "label", "text", "placeholder", "altText", "title", "testId", "selector"];

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
};

// Element types for array fields.
const ITEMS = { frame: "string", byValue: "string", byLabel: "string", byIndex: "integer" };

const FILE_FIELDS = { name: "string", mimeType: "string", text: "string", base64: "string" };

// target: "none" | "optional" | "required". assertion: true adds "not". oneOf: exactly one. anyOf: at least one.
// forbidden: fields that make no sense for the op. conflicts: pairs that cannot be given together.
export const OPS = {
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
  assertUrl: { target: "none", assertion: true, fields: MATCH, oneOf: MATCH_ONE },
  assertTitle: { target: "none", assertion: true, fields: MATCH, oneOf: MATCH_ONE },
  // path reads inside the stored value, so it needs equals: with exists it would be silently ignored.
  assertStorage: { target: "none", assertion: true, fields: { area: ["local", "session"], key: "string", path: "string", equals: "any", exists: "boolean" }, required: ["key"], oneOf: ["equals", "exists"], conflicts: [["exists", "path"]] },
};

const TOP_LEVEL = { name: "string", app: "object", steps: "array", timeoutMs: "number", noPageErrors: "boolean" };
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
  if (step.op === "dragTo" && isObject(step.to)) {
    checkFields(step.to, `${label}.to`, { ...TARGET_FIELDS, name: "string" }, problems);
    checkTarget(step.to, `${label}.to`, { required: true, nested: true }, problems);
    checkRanges(step.to, `${label}.to`, problems);
    checkItems(step.to, `${label}.to`, problems);
  }
  return problems;
}

// A step records a check when it asserts, or when goto is told which status to expect.
const recordsCheck = step => isObject(step) && has(OPS, step.op) && (OPS[step.op].assertion === true || (step.op === "goto" && step.status !== undefined));

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
  if (typeof spec.timeoutMs === "number" && !(spec.timeoutMs >= 1 && spec.timeoutMs <= MAX_TIMEOUT_MS)) {
    problems.push(`timeoutMs must be from 1 to ${MAX_TIMEOUT_MS}`);
  }
  if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
    problems.push("steps must be a non-empty array");
    return problems;
  }
  if (spec.steps.length > MAX_STEPS) problems.push(`steps must not hold more than ${MAX_STEPS} entries`);
  spec.steps.forEach((step, index) => problems.push(...validateStep(step, `steps[${index}]`)));
  if (problems.length === 0 && !spec.steps.some(recordsCheck) && spec.noPageErrors !== true) {
    problems.push("spec has no assertions, so it would pass without proving anything: add an assert step, a goto with status, or noPageErrors: true");
  }
  return problems;
}
