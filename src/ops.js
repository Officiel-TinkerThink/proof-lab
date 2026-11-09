// ops: a one-page cheat sheet of every op, generated from the schema, so it cannot drift from what validate accepts.
// Usage: node src/ops.js [--json]
import { runCli } from "./cli.js";
import { OPS } from "./spec/schema.js";
import { isMainModule, parseCli } from "./spec/util.js";

const describe = (name, type) => (Array.isArray(type) ? `${name}=${type.join("|")}` : name);

export function cheatSheet() {
  return Object.entries(OPS).map(([op, definition]) => {
    const required = new Set(definition.required ?? []);
    const fields = Object.entries(definition.fields).map(([name, type]) => `${describe(name, type)}${required.has(name) ? "" : "?"}`);
    return {
      op,
      target: definition.target,
      assertion: definition.assertion === true,
      fields,
      oneOf: definition.oneOf ?? [],
      anyOf: definition.anyOf ?? [],
    };
  });
}

export async function main(args) {
  const values = parseCli(args, { json: { type: "boolean" } });
  const sheet = cheatSheet();
  if (values.json) {
    console.log(JSON.stringify(sheet, null, 2));
    return 0;
  }
  console.log("op (target: none | optional | required; ! = assertion, takes `not`)  fields (? = optional; a target adds role, label, text, testId, selector ...)");
  for (const entry of sheet) {
    const pick = (entry.oneOf.length > 0 ? `  exactly one of: ${entry.oneOf.join(", ")}` : "") + (entry.anyOf.length > 0 ? `  at least one of: ${entry.anyOf.join(", ")}` : "");
    console.log(`${entry.op}${entry.assertion ? "!" : ""} [${entry.target}] ${entry.fields.join(" ")}${pick}`);
  }
  return 0;
}

if (isMainModule(import.meta.url)) await runCli(() => main(process.argv.slice(2)));
