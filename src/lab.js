// One entry point: node src/lab.js <run|status|doctor|show> [options]. Each command is the module of the same name;
// this file only picks it and keeps the exit-code contract: 0 pass, 1 a check or gate says no, 2 cannot tell.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, firstLine } from "./spec/util.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultReceipts = process.env.PROOF_LAB_RECEIPTS ?? join(ROOT, "receipts");

const COMMANDS = {
  run: { about: "run a spec against the app and write a signed receipt (--spec, --key-file)", load: () => import("./run-spec.js"), withDefaults: false },
  status: { about: "say whether the work may be called done: PASS, FAIL, STOP, STALE, UNVERIFIED, NO-RECEIPT", load: () => import("./status.js"), withDefaults: true },
  doctor: { about: "check key, receipts directory, chain and specs before a run", load: () => import("./doctor.js"), withDefaults: true },
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
    console.error(`unknown command "${name}"\n${usage()}`);
    return 2;
  }
  const command = COMMANDS[name];
  const module = await command.load();
  return command.withDefaults ? module.main(rest, { defaultReceipts }) : module.main(rest);
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`ERROR: ${firstLine(error)}`);
    process.exitCode = 2;
  }
}
