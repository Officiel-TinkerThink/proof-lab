// validate: parse and check specs without running them, so an author fixes field names in seconds.
// Usage: node src/validate.js --spec <file.json> [--spec <file.json> ...] [--json]
// Exit 0 when every spec is valid, 2 when one cannot be read or is invalid (the same as a run that refuses it).
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { runCli } from "./cli.js";
import { safeLine, scrubText } from "./receipt-scrub.js";
import { validateSpec } from "./spec/schema.js";
import { isMainModule, parseCli } from "./spec/util.js";

const CLI_OPTIONS = { spec: { type: "string", multiple: true }, json: { type: "boolean" } };

async function check(specPath) {
  const file = scrubText(basename(specPath));
  let spec;
  try {
    spec = JSON.parse(await readFile(specPath, "utf8"));
  } catch (error) {
    return { file, valid: false, problems: [`cannot be read or parsed: ${safeLine(error)}`] };
  }
  const problems = validateSpec(spec).map(problem => scrubText(problem));
  return { file, valid: problems.length === 0, problems, steps: Array.isArray(spec?.steps) ? spec.steps.length : 0 };
}

export async function main(args) {
  const values = parseCli(args, CLI_OPTIONS);
  if (!values.spec?.length) throw new Error("--spec <file.json> is required");
  const results = [];
  for (const specPath of values.spec) results.push(await check(specPath));
  if (values.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const result of results) {
      if (result.valid) console.log(`valid ${result.file} (${result.steps} steps)`);
      else {
        console.log(`INVALID ${result.file}`);
        for (const problem of result.problems) console.log(`  ${problem}`);
      }
    }
  }
  return results.every(result => result.valid) ? 0 : 2;
}

if (isMainModule(import.meta.url)) await runCli(() => main(process.argv.slice(2)));
