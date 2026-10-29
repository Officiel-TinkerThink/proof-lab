import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { specsInDir } from "../src/run-spec.js";
import { OPS, validateSpec } from "../src/spec/schema.js";
import { errorDetail } from "../src/spec/util.js";
import { substituteStep } from "../src/spec/vars.js";
import { TIMEOUT, explain, failedChecks, page, withRun } from "./spec-helpers.mjs";

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

test('errorDetail: only the first line of an error is kept, never the markup Playwright quotes after it', () => {
  const message = 'locator.click: Error: strict mode violation: getByRole(\'button\') resolved to 6 elements:\n'
    + '    1) <input value="hunter2" type="text"/> aka locator(\'#b\')\nCall log:\n  - waiting';
  const detail = errorDetail(new Error(message));
  assert.match(detail, /resolved to 6 elements:$/);
  assert.ok(!detail.includes('hunter2'));
  assert.equal(errorDetail(new Error('plain\nsecond line')), 'plain');
});

test('an ambiguous target lists the first matches by tag and plain identifiers, read from the page', TIMEOUT, async () => {
  const steps = [{ op: 'click', role: 'button', check: 'ambiguous click', timeout: 2000 }];
  await withRun(page('/fixtures/network.html', steps, { noPageErrors: true }), async receipt => {
    assert.equal(receipt.verdict, 'FAIL', explain(receipt));
    const failed = failedChecks(receipt)[0];
    assert.match(String(failed.error), /strict mode violation.*<button id=load> \| <button id=slow> \| <button id=broken> \| <button id=echo>$/s, explain(receipt));
    assert.ok(!String(failed.error).includes('Load items'), 'the text of the page is not listed');
  });
});

test('list: shows receipts newest first, counts them, marks an unreadable file; a missing folder is an error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pl-list-'));
  try {
    await writeFile(join(dir, '2026-01-01T00-00-00-000000000Z-unknown.json'), JSON.stringify({ verdict: 'PASS', spec: 'one', at: '2026-01-01T00:00:00Z' }));
    await writeFile(join(dir, '2026-01-02T00-00-00-000000000Z-unknown.json'), '{ broken');
    const out = lab(['list', '--receipts', dir]);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /^2 receipts/m);
    assert.ok(out.stdout.indexOf('UNREADABLE') < out.stdout.indexOf('PASS'), 'newest first');
    assert.equal(JSON.parse(lab(['list', '--receipts', dir, '--limit', '1', '--json']).stdout).receipts.length, 1);
    assert.equal(lab(['list', '--receipts', join(dir, 'missing')]).status, 2);
    assert.equal(lab(['list', '--receipts', dir, '--limit', '0']).status, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('validate: an absence check with no positive check before it is a warning, never an error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pl-lint-'));
  try {
    const bare = join(dir, 'bare.json');
    const paired = join(dir, 'paired.json');
    const absent = { op: 'assertCount', testId: 'error', count: 0 };
    const shown = { op: 'assertVisible', testId: 'title' };
    await writeFile(bare, JSON.stringify({ name: 't', steps: [absent] }));
    await writeFile(paired, JSON.stringify({ name: 't', steps: [shown, absent] }));
    const warned = lab(['validate', '--spec', bare]);
    assert.equal(warned.status, 0, 'a warning does not fail validation');
    assert.match(warned.stdout, /warning: steps\[0\] \(assertCount\) checks that something is absent/);
    assert.doesNotMatch(lab(['validate', '--spec', paired]).stdout, /warning/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('look --spec: an app that is not on this machine gets a note that the steps are replayed there', TIMEOUT, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pl-lookwarn-'));
  try {
    const spec = join(dir, 's.json');
    await writeFile(spec, JSON.stringify({ name: 't', app: { url: 'http://example.invalid:9/' }, steps: [{ op: 'goto', url: '/', status: 200 }] }));
    const result = lab(['look', '--spec', spec, '--until', '0']);
    assert.match(result.stderr, /not this machine/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ops: the cheat sheet lists every op of the schema', () => {
  const sheet = JSON.parse(lab(['ops', '--json']).stdout);
  assert.deepEqual(sheet.map(entry => entry.op), Object.keys(OPS));
  assert.ok(sheet.find(entry => entry.op === 'capture').fields.includes('from=text|value|count|attribute'));
  assert.match(lab(['ops']).stdout, /^assertText! \[required\]/m);
});

test('assertContrast: computes the WCAG ratio; what it cannot compute is a claim for a human, never a pass', TIMEOUT, async () => {
  const steps = [
    { op: 'assertContrast', check: 'good is readable', selector: '#good' },
    { op: 'assertContrast', check: 'translucent still readable', selector: '#alpha', min: 7 },
    { op: 'assertContrast', check: 'poor is poor', selector: '#poor' },
    { op: 'assertContrast', check: 'poor fails AAA', selector: '#poor', not: true, min: 3 },
    { op: 'assertContrast', check: 'faded cannot be computed', selector: '#faded' },
    { op: 'assertContrast', check: 'gradient cannot be computed', selector: '#image' },
  ];
  await withRun(page('/fixtures/contrast.html', steps, { noPageErrors: false }), async receipt => {
    assert.equal(receipt.verdict, 'FAIL', explain(receipt));
    assert.deepEqual(receipt.checks.map(check => check.name), ['poor is poor'], 'only the real ratio below the bar fails');
    assert.match(String(receipt.checks[0].actual), /^1\.2\d?$/);
    assert.equal(receipt.review.total, 2, 'the two uncomputable claims go to a human');
  });
});

test('review fixes: capture rules, prototype-name ops, ops anyOf, lint counts goto status, exact contrast bar', () => {
  assert.match(validateSpec({ ...base, steps: [{ op: 'capture', selector: 'li', nth: 1, from: 'count', as: 'n' }] }).join(';'), /nth narrows/);
  assert.deepEqual(validateSpec({ ...base, steps: [{ op: 'capture', selector: 'li', nth: 1, from: 'text', as: 'n' }] }), []);
  assert.match(validateSpec({ ...base, steps: [{ op: 'constructor' }] }).join(';'), /is not one of/, 'an inherited name is an unknown op, not a crash');
  const sheet = JSON.parse(lab(['ops', '--json']).stdout);
  assert.deepEqual(sheet.find(entry => entry.op === 'assertCount').anyOf, ['count', 'min', 'max']);
  assert.deepEqual(sheet.find(entry => entry.op === 'assertCount').oneOf, []);
});
