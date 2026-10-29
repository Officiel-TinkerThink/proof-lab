import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LAB = join(fileURLToPath(new URL("..", import.meta.url)), "src", "lab.js");
const lab = args => spawnSync(process.execPath, [LAB, ...args], { encoding: "utf8", timeout: 60000 });

test("no command prints the usage and exits 2; help prints it and exits 0", () => {
  const none = lab([]);
  assert.equal(none.status, 2, none.stdout + none.stderr);
  for (const name of ["run", "status", "doctor", "show", "look", "validate", "list", "ops"]) assert.match(none.stdout, new RegExp(`^  ${name} `, "m"));
  const help = lab(["help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /usage: node src\/lab\.js/);
});

test("an unknown command exits 2 and names it; inherited object keys are not commands", () => {
  for (const name of ["teleport", "constructor", "toString", "__proto__"]) {
    const result = lab([name]);
    assert.equal(result.status, 2, name);
    assert.match(result.stderr, new RegExp(`unknown command "${name}"`));
  }
});

test("a command's own argument errors exit 2, never 1", () => {
  for (const command of ["status", "doctor", "show", "run", "look", "validate", "list", "ops"]) {
    const result = lab([command, "--no-such-flag"]);
    assert.equal(result.status, 2, `${command}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /ERROR: .*--no-such-flag/);
  }
});
