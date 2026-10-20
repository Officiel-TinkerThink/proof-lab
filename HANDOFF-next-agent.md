# Handoff: proof-lab redaction work (state after review run 3)

Date: 2026-10-20. Repo: `D:/core/projects/proof-lab`. Branch: `feat/regression-tests`. No git remote configured: nothing is pushed, nothing is merged. Do not push or merge unless the owner asks.

Read first: `HANDOFF.md` (state and history), `SPECS.md` lines 176-181 (the redaction contract), `SECURITY-BACKLOG.md` (scope contract: S1, S2.x, S3.x are deferred and must not be re-reported).

## State

- Code head: `11a2974`. Last reviewed head: `11a2974` (defect review, cycle 4 of 5: no finding). The review run is **done**; there is no unreviewed code. Later commits are documentation only.
- Gate: `node --test test/*.test.mjs` gives 241 tests, 240 pass, 1 skipped, 0 fail. **`npm test` is not the gate**: it runs only `test/run.test.mjs` (the prove scenarios). The full run takes about 90 s; run it in the background.
- The one skipped test is `a key file readable by group or others is refused` (`test/durability.test.mjs:39`). It checks POSIX file modes, so it runs only on Linux and macOS and is skipped on Windows.
- Demo (`node demo/run-demo.mjs`: PASS 0; FAIL 1 twice; NEEDS-REVIEW 3; expectations PASS 0; ERROR 2 twice; chain VALID 0; tamper INVALID 1) was last verified on `d8bd36c`. **It was not re-run after the changes below.** Run it before relying on it.

## What is decided (owner decisions, 2026-10-20)

- The lab-name exemption stays: the lab's own receipt, picture and evidence file names are kept intact and the directory above is scrubbed (recorded in `SPECS.md` line 181). Any other name is scrubbed together with the whole path.
- The evidence path is scrubbed like the receipt path.
- The review cap is five cycles per run (the one in the `review-fix-cycle` skill).
- `prove` gets the same scrub as `run`.

## What the code does now

The root cause of every raw-path leak was that nothing forced a command's output through the scrub. It is fixed at the sources:

- `src/receipt-scrub.js`: `scrubReceipt` (the one scrub point, before a receipt is written), `writeScrubbedReceipt` (the only way `run` and `prove` write a receipt; it throws for a receipt `scrubReceipt` has not seen, and scrubs the failed-write text), `scrubReceiptFile` (scrubs a printed path; keeps only a name matching `LAB_FILE_NAME`).
- `src/chain.js`: `writeReceipt` stores the picture by file name (like `evidence.file`), not by path. `LAB_FILE_NAME` is the one definition of the lab's file-name shape, built from the same pieces that build the names.
- `src/cli.js` `runCli`: every command (`run`, `status`, `look`, `lab`, `show`, `doctor`, `prove`) ends through it: scrubbed `ERROR: ` line (`safeLine` in `src/spec/evidence.js`), exit 2. Exit 1 means "a check failed", never an unexpected error.
- `doctor` prints through `scrubDoctor`; `show` and `look` scrub their path lines.
- Tests: `test/cli-output.test.mjs` runs the real commands against a receipts directory named `password=hunter2`; the name-shape and guard tests are in `test/spec-receipt.test.mjs`; the `prove` test is in `test/run.test.mjs`.

## Open items

1. **Convention, enforced by tests only.** A new command must end through `runCli`, write receipts only through `scrubReceipt` + `writeScrubbedReceipt`, and print paths through `scrubReceiptFile`. Nothing in the module graph forces it. Add any new command to `test/cli-output.test.mjs`.
2. **Old receipts on disk** still hold the picture's full path in the signed `screenshot` field. They are not rewritten (that would break the signatures). `verifyChain` does not read the field and `show` scrubs it when printing.
3. **Unchecked: an outside reader of the receipt format.** A comment in `src/chain.js` mentions a Go struct and a "Go driver". No Go code is in this repo, so I could not check whether it treats `screenshot` as a path. The field is still a string, and new receipts hold a bare name. Ask the owner if a Go reader exists.
4. **S2.14 (directory over-hiding)** needs no change unless the owner asks. A long, mixed-case, digit-bearing directory name prints as `[redacted long value]`; the file name stays intact.
5. **Not scrubbed, by design:** `look()` returns the caller's own `--screenshot` path in its result (only the printed output is scrubbed); `prove --verify` prints chain problems that name bare files only.

## Rules that stay in force

- Signing key only via `--key-file`; never the `PROOF_LAB_KEY` environment variable.
- Cookie values stay masked (length plus keyed HMAC fingerprint).
- Never delete or move a file during a gate or a review, including logs. Each run writes a new log name.
- Security findings are deferred to documents (`SECURITY-BACKLOG.md`), not dropped.
- Review rules (agent-kit `review-fix-cycle` skill): freeze the diff before review; delta review only; "done" needs a review of the latest fix; a run that reaches the cap is "not done" and the user is notified.

## Quarantined files (restore only if the owner asks)

- `20261019T165040789-0793` (`gate-b-0022.log`) and `20261019T165245046-d756` (`gate-b-0023.log`), removed by a runner earlier. Restore with `safe-rm-restore`.

## Out of scope for this handoff

- `D:/core/projects/agent-kit` is a separate repo. Its review skill change is merged to `main` (PR #21, merge commit `4071a3b`).
- Untracked `denyB.out` in agent-kit is not ours; leave it.

## History of this branch's redaction work

- `d8bd36c`: exact lab-name shape; non-lab names scrubbed with the whole path. Reviewed in run 2: no finding.
- Run 2 (cap 5, used 4): `5540c6b` receipt path in `run --json`/text; `ce03403` screenshot path; `fc57da7` keep `.png` and `.evidence.jsonl` names; `03ff43f` evidence path scrubbed and the exemption recorded in `SPECS.md`; `33f5e48` wording fix.
- S2.15 (`receipt.error`): `8c02e97`. S2.16 (`prove` scrubbed nothing): `e3d44e3`, `cb5f330`. Both fixed at the root.
- Run 3 (cap 5, used 4): S2.17, the same root cause in every command: `29343d6`, then `11a2974` for the cycle 3 findings (one file-name definition, `prove` through `runCli`, stronger tests). Last review: no finding.
- Backlog: S2.15, S2.16, S2.17 are fixed; S2.14 is open by decision.
