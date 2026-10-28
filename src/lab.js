// One entry point: node src/lab.js <run|status|doctor|look|validate|show> [options]. Each command is the module of the same name;
// this file only picks it and keeps the exit-code contract: 0 pass, 1 a check or gate says no, 2 cannot tell.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./cli.js";
import { scrubText } from "./receipt-scrub.js";
import { isMainModule } from "./spec/util.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultReceipts = process.env.PROOF_LAB_RECEIPTS ?? join(ROOT, "receipts");

const COMMANDS = {
  run: { about: "run a spec against the app and write a signed receipt (--spec, --key-file)", load: () => import("./run-spec.js"), withDefaults: false },
  status: { about: "say whether the work may be called done: PASS, FAIL, STOP, STALE, UNVERIFIED, NO-RECEIPT", load: () => import("./status.js"), withDefaults: true },
  doctor: { about: "check key, receipts directory, chain and specs before a run", load: () => import("./doctor.js"), withDefaults: true },
  look: { about: "see a page as a spec sees it: roles, names, test ids, storage keys, console (no receipt)", load: () => import("./look.js"), withDefaults: false },
  validate: { about: "check specs for mistakes without running them (--spec, no browser, no receipt)", load: () => import("./validate.js"), withDefaults: false },
  show: { about: "read the evidence of one receipt (failures, steps, console, page)", load: () => import("./show.js"), withDefaults: true },
};

export function usage() {
  const lines = Object.entries(COMMANDS).map(([name, { about }]) => `  ${name.padEnd(7)} ${about}`);
  return `usage: node src/lab.js <command> [options]\n${lines.join("\n")}`;
}

export async function main(args) {
  const [name, ...rest] = args;
  if (name === undefined || name === "--help" || name === "-h" || name === "help") {
    console.log(usage());
    return name === undefined ? 2 : 0;
  }
  if (!Object.hasOwn(COMMANDS, name)) {
    console.error(`unknown command "${scrubText(name)}"\n${usage()}`); // the typed word is not trusted to be harmless: it is scrubbed like any text
    return 2;
  }
  const command = COMMANDS[name];
  const module = await command.load();
  return command.withDefaults ? module.main(rest, { defaultReceipts }) : module.main(rest);
}

if (isMainModule(import.meta.url)) await runCli(() => main(process.argv.slice(2)));
