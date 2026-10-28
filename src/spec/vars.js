// Spec variables: {{name}} in a few value fields, set by a `capture` step or built in ({{runId}}).
// Page text is untrusted, so a reference is replaced only in the fields listed in SUBSTITUTED: never in a target
// (page text would become a selector), in matches/flags (page text inside a pattern), op, check, name or hint.
// A literal {{name}} is written \{{name}}. Anything that is not exactly {{identifier}} is left alone.

export const VAR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
export const BUILTIN_VARS = ["runId"];
export const MAX_CAPTURES = 20;
export const MAX_VALUE_CHARS = 1000;

const REF = /(\\)?\{\{([A-Za-z][A-Za-z0-9_]{0,39})\}\}/g;

export const SUBSTITUTED = {
  goto: ["url"],
  fill: ["value"],
  type: ["value"],
  assertText: ["equals", "contains"],
  assertValue: ["equals", "contains"],
  assertAttribute: ["equals", "contains"],
  assertUrl: ["equals", "contains"],
  assertTitle: ["equals", "contains"],
  assertCookie: ["equals", "contains"],
};

const fieldsOf = step => (SUBSTITUTED[step?.op] ?? []).filter(field => typeof step[field] === "string");

// The names a step refers to (escaped references do not count).
export function referencesOf(step) {
  const names = [];
  for (const field of fieldsOf(step)) {
    for (const match of step[field].matchAll(REF)) if (match[1] === undefined) names.push({ field, name: match[2] });
  }
  return names;
}

// A copy of the step with its references replaced. An unknown name throws: validation catches it first, this is the backstop.
export function substituteStep(step, vars, appUrl) {
  const fields = fieldsOf(step);
  if (fields.length === 0) return step;
  const copy = { ...step };
  let replaced = false;
  for (const field of fields) {
    copy[field] = step[field].replace(REF, (all, escape, name) => {
      if (escape !== undefined) return all.slice(1);
      if (!vars.has(name)) throw new Error(`{{${name}}} was never captured`);
      replaced = true;
      return vars.get(name);
    });
  }
  // A captured value must not send the run to another site.
  if (replaced && step.op === "goto" && new URL(copy.url, appUrl).origin !== new URL(appUrl).origin) {
    throw new Error("goto with a captured value must stay on the app's origin");
  }
  return copy;
}
