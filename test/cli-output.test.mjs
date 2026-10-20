// No command prints the receipts directory raw. The directory name below looks like a credential (key=value) to the scrubber,
// so any path of it that reaches the output shows as a leak. Each case runs the real command.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const WAITLIST = join(ROOT, "specs", "waitlist.json");
const TIMEOUT = { timeout: 240000 };

function command(file, args) {
  const { PROOF_LAB_KEY: _ignored, ...clean } = process.env;
  return spawnSync(process.execPath, [join(SRC, file), ...args], { encoding: "utf8", env: clean });
}

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "proof-output-"));
  const keyFile = join(dir, "key.txt");
  await writeFile(keyFile, "k".repeat(48));
  if (process.platform !== "win32") await chmod(keyFile, 0o600);
  return { dir, keyFile, receipts: join(dir, "password=hunter2") };
}

const leaks = result => `${result.stdout}${result.stderr}`.includes("hunter2");
// Stricter, for the paths the lab prints itself: not even the harmless part of the directory (the temp folder above it) appears.
const showsDirectory = result => leaks(result) || `${result.stdout}${result.stderr}`.includes("proof-output-");

test("show, status and doctor print a receipt from a credential-looking directory without that directory", TIMEOUT, async () => {
  const { dir, keyFile, receipts } = await workspace();
  const leaks = showsDirectory; // in this test, any trace of the directory counts as a leak
  try {
    await mkdir(receipts);
    const run = command("run-spec.js", ["--spec", WAITLIST, "--key-file", keyFile, "--receipts", receipts]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(leaks(run), false, "run");

    for (const args of [["--json"], ["--summary"], []]) {
      const shown = command("show.js", ["--receipts", receipts, ...args]);
      assert.equal(shown.status, 0, shown.stdout + shown.stderr);
      assert.equal(leaks(shown), false, `show ${args.join(" ")}`);
    }
    // The output itself is checked too, so a command that crashed before printing cannot pass for a clean one.
    const status = command("status.js", ["--spec", WAITLIST, "--key-file", keyFile, "--receipts", receipts, "--json"]);
    assert.equal(JSON.parse(status.stdout).state, "PASS", status.stdout + status.stderr);
    assert.equal(leaks(status), false, "status --json");

    const doctorJson = command("doctor.js", ["--key-file", keyFile, "--receipts", receipts, "--spec", WAITLIST, "--json"]);
    assert.ok(Array.isArray(JSON.parse(doctorJson.stdout).checks), doctorJson.stdout + doctorJson.stderr);
    assert.equal(leaks(doctorJson), false, "doctor --json");
    const doctorText = command("doctor.js", ["--key-file", keyFile, "--receipts", receipts, "--spec", WAITLIST]);
    assert.match(doctorText.stdout, /^doctor\n/, doctorText.stdout + doctorText.stderr);
    assert.equal(leaks(doctorText), false, "doctor");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("doctor and status on a first run (no receipt yet) print no directory", TIMEOUT, async () => {
  const { dir, keyFile, receipts } = await workspace();
  try {
    await mkdir(receipts);
    // The lab's own "no receipt yet" message used to embed the directory; here the directory holds nothing.
    const doctor = command("doctor.js", ["--key-file", keyFile, "--receipts", receipts, "--spec", WAITLIST]);
    assert.match(doctor.stdout, /No receipt exists in the receipts directory/, doctor.stdout + doctor.stderr);
    assert.equal(showsDirectory(doctor), false, "doctor");
    const status = command("status.js", ["--spec", WAITLIST, "--key-file", keyFile, "--receipts", receipts]);
    assert.match(status.stdout, /No receipt exists in the receipts directory/, status.stdout + status.stderr);
    assert.equal(showsDirectory(status), false, "status");
    // A spec that cannot be read: the system error names the spec's full path, and only its file name may appear.
    const missing = join(dir, "no-such-folder-Ab1Cd2", "missing.json");
    const unreadable = command("doctor.js", ["--key-file", keyFile, "--receipts", receipts, "--spec", missing]);
    assert.match(unreadable.stdout, /spec missing\.json: cannot be read: .*<dir>\/missing\.json/, unreadable.stdout + unreadable.stderr);
    assert.equal(unreadable.stdout.includes("no-such-folder"), false, "doctor, unreadable spec");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a command that fails prints an error line without the directory it failed on", TIMEOUT, async () => {
  const { dir, receipts } = await workspace();
  try {
    // No receipts there: show fails with an error that names the directory; lab show goes through the same top-level block.
    // prove fails on a key file that is not there, and the system's error names the path of it.
    const missingKey = join(receipts, "key.txt");
    for (const [file, args] of [["show.js", ["--receipts", receipts]], ["lab.js", ["show", "--receipts", receipts]], ["prove.js", ["--key-file", missingKey]], ["prove.js", ["--verify", "--key-file", missingKey]]]) {
      const failed = command(file, args);
      assert.equal(failed.status, 2, failed.stdout + failed.stderr);
      assert.match(failed.stderr, /^ERROR: /m);
      assert.equal(leaks(failed), false, `${file} ${args.join(" ")}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
