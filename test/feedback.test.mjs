import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { specsInDir } from "../src/run-spec.js";
import { validateSpec } from "../src/spec/schema.js";

const LAB = join(fileURLToPath(new URL("..", import.meta.url)), "src", "lab.js");
const lab = args => spawnSync(process.execPath, [LAB, ...args], { encoding: "utf8", timeout: 60000 });
const base = { name: "t", steps: [{ op: "goto", url: "/" }], noPageErrors: true };

test("allowPageErrors: texts are accepted with noPageErrors, and refused without it or when malformed", () => {
  assert.deepEqual(validateSpec({ ...base, allowPageErrors: ["401", "Failed to load resource"] }), []);
  assert.match(validateSpec({ ...base, noPageErrors: false, allowPageErrors: ["401"], steps: [{ op: "goto", url: "/", status: 200 }] }).join(";"), /needs|only has a meaning/);
  assert.match(validateSpec({ ...base, allowPageErrors: [""] }).join(";"), /allowPageErrors\[0\]/);
  assert.match(validateSpec({ ...base, allowPageErrors: [5] }).join(";"), /allowPageErrors\[0\]/);
  assert.match(validateSpec({ ...base, allowPageErrors: Array(21).fill("x") }).join(";"), /more than 20/);
  assert.match(validateSpec({ ...base, allowPageErrors: "401" }).join(";"), /allowPageErrors must be/);
});

test("validate: valid spec exits 0, an invalid or unreadable one exits 2 and says why; nothing is written", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pl-validate-"));
  try {
    const good = join(dir, "good.json");
    const bad = join(dir, "bad.json");
    const broken = join(dir, "broken.json");
    await writeFile(good, JSON.stringify(base));
    await writeFile(bad, JSON.stringify({ name: "t", steps: [{ op: "nope" }] }));
    await writeFile(broken, "{ not json");
    const ok = lab(["validate", "--spec", good]);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /^valid good\.json \(1 steps\)$/m);
    const refused = lab(["validate", "--spec", good, "--spec", bad, "--spec", broken]);
    assert.equal(refused.status, 2);
    assert.match(refused.stdout, /^valid good\.json/m);
    assert.match(refused.stdout, /^INVALID bad\.json$/m);
    assert.match(refused.stdout, /op "nope" is not one of/);
    assert.match(refused.stdout, /^INVALID broken\.json$/m);
    const json = JSON.parse(lab(["validate", "--spec", bad, "--json"]).stdout);
    assert.equal(json[0].valid, false);
    assert.equal(lab(["validate"]).status, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("specsInDir: the .json files by name; an empty or missing directory is an error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pl-specdir-"));
  try {
    await assert.rejects(specsInDir(dir), /holds no \.json/);
    await writeFile(join(dir, "b.json"), "{}");
    await writeFile(join(dir, "a.json"), "{}");
    await writeFile(join(dir, "notes.md"), "x");
    assert.deepEqual(await specsInDir(dir), [join(dir, "a.json"), join(dir, "b.json")]);
    await assert.rejects(specsInDir(join(dir, "missing")), /--spec-dir could not be read/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
