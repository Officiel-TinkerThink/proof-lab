import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { specsInDir } from "../src/run-spec.js";
import { validateSpec } from "../src/spec/schema.js";
import { substituteStep } from "../src/spec/vars.js";
import { TIMEOUT, explain, page, withRun } from "./spec-helpers.mjs";

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

test('allowPageErrors: an expected console error passes, an uncaught exception never does', TIMEOUT, async () => {
  const click = [{ op: 'click', role: 'button', name: 'Log error' }, { op: 'assertText', check: 'page loaded', testId: 'items-state', equals: 'idle' }];
  await withRun(page('/fixtures/network.html', click, { noPageErrors: true, allowPageErrors: ['logged error', '404'] }), async receipt => {
    // The page logs its own error and the browser adds "Failed to load resource ... 404" for the favicon: both are listed.
    assert.equal(receipt.verdict, 'PASS', explain(receipt));
    assert.ok(receipt.pageErrors.includes('logged error'), 'the error stays in the receipt');
  });
  await withRun(page('/fixtures/network.html', click, { noPageErrors: true, allowPageErrors: ['something else'] }), async receipt => {
    assert.equal(receipt.verdict, 'FAIL');
  });
  const load = [{ op: 'assertTitle', check: 'titled', contains: '' }];
  await withRun(page('/fixtures/broken.html', load, { noPageErrors: true, allowPageErrors: ['boom', 'login failed'] }), async receipt => {
    assert.equal(receipt.verdict, 'FAIL', 'an uncaught exception is not exempt even when its text is listed');
    assert.ok(receipt.checks.some(check => check.name === 'no page errors'));
  });
});

test('run: every --spec-dir is read, not only the last', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'pl-empty-'));
  const full = await mkdtemp(join(tmpdir(), 'pl-full-'));
  try {
    await writeFile(join(full, 'a.json'), '{}');
    const result = lab(['run', '--spec-dir', empty, '--spec-dir', full, '--key-file', join(full, 'no-key')]);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /--spec-dir holds no .json/, 'the first folder was read');
  } finally {
    await rm(empty, { recursive: true, force: true });
    await rm(full, { recursive: true, force: true });
  }
});

test('variables: a reference needs an earlier capture; only listed value fields are replaced; goto stays on the origin', () => {
  const capture = { op: 'capture', testId: 'x', from: 'text', as: 'first' };
  const fine = { ...base, steps: [capture, { op: 'assertText', testId: 'y', equals: 'a {{first}} b {{runId}}' }] };
  assert.deepEqual(validateSpec(fine), []);
  assert.match(validateSpec({ ...base, steps: [{ op: 'assertText', testId: 'y', equals: '{{first}}' }, capture] }).join(';'), /no earlier capture/);
  assert.deepEqual(validateSpec({ ...base, steps: [{ op: 'assertText', testId: 'y', equals: String.raw`\{{first}}` }] }), [], 'an escaped reference is literal text');
  assert.match(validateSpec({ ...base, steps: [{ ...capture, as: 'runId' }] }).join(';'), /built-in/);
  assert.match(validateSpec({ ...base, steps: [{ ...capture, from: 'attribute' }] }).join(';'), /needs "attribute"/);
  const vars = new Map([['first', 'hello'], ['bad', 'https://evil.example/']]);
  const app = 'http://127.0.0.1:1234';
  assert.equal(substituteStep({ op: 'fill', testId: 'a', value: 'x-{{first}}' }, vars, app).value, 'x-hello');
  assert.equal(substituteStep({ op: 'click', testId: '{{first}}' }, vars, app).testId, '{{first}}', 'targets are never replaced');
  assert.equal(substituteStep({ op: 'assertText', testId: 'a', matches: '{{first}}', equals: undefined, contains: String.raw`\{{first}}` }, vars, app).contains, '{{first}}');
  assert.throws(() => substituteStep({ op: 'goto', url: '{{bad}}' }, vars, app), /origin/);
  assert.throws(() => substituteStep({ op: 'fill', testId: 'a', value: '{{nope}}' }, vars, app), /never captured/);
});

test('variables: capture reads text and count into later steps; the evidence holds the name, not the value', TIMEOUT, async () => {
  const steps = [
    { op: 'capture', testId: 'items-state', from: 'text', as: 'state' },
    { op: 'capture', selector: 'button', from: 'count', as: 'buttons' },
    { op: 'assertText', check: 'state carried over', testId: 'items-state', equals: '{{state}}' },
    { op: 'assertText', check: 'wrong value fails', testId: 'items-state', contains: '{{buttons}}x' },
  ];
  await withRun(page('/fixtures/network.html', steps, { noPageErrors: false }), async receipt => {
    assert.equal(receipt.verdict, 'FAIL', explain(receipt));
    assert.deepEqual(receipt.checks.map(check => check.name), ['wrong value fails']);
  });
});
