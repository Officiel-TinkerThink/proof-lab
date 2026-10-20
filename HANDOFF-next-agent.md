# Handoff: fix the open redaction items (proof-lab)

Date: 2026-10-20. Repo: `D:/core/projects/proof-lab`. Branch: `feat/regression-tests`. No git remote configured: nothing is pushed, nothing is merged. Do not push or merge unless the owner asks.

Read first: `HANDOFF.md` (state and history), `SPECS.md` lines 176-181 (the redaction contract), `SECURITY-BACKLOG.md` (scope contract: S1, S2.x, S3.x are deferred and must not be re-reported).

## State

- Head: `c501fc3` (handoff note). Code head: `d8bd36c`.
- **Last reviewed head: `1954c8f`.** `d8bd36c` has NO review. The five-cycle review cap was reached, so the run is "not done" until `d8bd36c` (and whatever you change) is reviewed.
- Gates on `d8bd36c`: `node --test test/*.test.mjs` gives 234 tests, 233 pass, 1 skipped (`a key file readable by group or others is refused`, `test/durability.test.mjs:39`: POSIX file modes, so it runs only on Linux and macOS), 0 fail. Run it in the background: it takes more than 120 s.
- Demo: `node demo/run-demo.mjs` must show: PASS 0; FAIL 1 (two bugs); NEEDS-REVIEW exit 3; expectations PASS 0; ERROR 2 (invalid spec); ERROR 2 (no checks); chain VALID exit 0; tamper INVALID exit 1. Verified on `d8bd36c`.

## What `d8bd36c` changed (the code under review)

`src/status.js`, `scrubReceiptFile` and `LAB_RECEIPT_NAME`:
- `LAB_RECEIPT_NAME` is now `^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{9}Z-(?:[0-9a-f]{12}|unknown)\.json$`. It matches `fixedStamp` + `fileStamp` in `src/chain.js:53-59` and the name built at `src/chain.js:316-318`.
- A name that does not match is scrubbed with the WHOLE path (`redactSecrets(path)`), so a run joined by `/` is judged as one (spec line 179).
- A lab-shaped name keeps its name intact; only the directory above it is scrubbed, with the separator kept outside the scrub.
- A bare drive letter (`D:2026-...json`) is handled: the name starts after the colon.
- Tests: `test/spec-expect.test.mjs`, the test named "scrubStatus: a renamed receipt file is scrubbed; only the lab's own name shape is kept".

## Open items, in order

1. **Review `d8bd36c`.** Freeze the diff to a scratch file first (`git diff 1954c8f..d8bd36c`), then run defect and spec reviewers on it (size gate: small change, these two only). Scope contract is in `SECURITY-BACKLOG.md`. Owner must decide whether a fresh review run has its own five-cycle cap before you start it.

2. **`run --json` and `run` text print the receipt path raw.** Verified: `src/run-spec.js:375` (`receiptFile: receipt.detail?.receiptPath`) and `src/run-spec.js:386` (`console.log(\`  receipt:  ${receipt.detail.receiptPath}\`)`). Only `status` goes through `scrubStatus`. Decide and fix: route the receipt path through the same scrub (`scrubStatus` or the same function), or record why the path is safe. The path is built in `src/chain.js:350-353` from the receipts directory the caller chose. Check `SECURITY-BACKLOG.md` for an existing entry before you call it new. Add a test.

3. **Owner decision (do not decide alone):** the lab-name exemption. Spec line 181 says the status command "scrubs everything it prints". A lab-shaped name is kept intact, which is a documented deviation. Options:
   - (a) Keep the exemption. Cost: the spec's literal wording is not met for lab-written names; record it as an accepted deviation with the reason.
   - (b) Scrub the name too. Cost: a normal receipt name such as `2026-10-19T10-00-00-000000000Z-0123456789ab.json` matches the long-value rule and prints as `[redacted long value].json`, so the receipt cannot be found by its printed name.
   - Recommendation: (a), with the deviation written into the spec and the backlog. Ask the owner in one line before changing it.

4. **Directory over-hiding (S2.14).** A plain receipts directory with a long, mixed-case, digit-bearing name prints as `[redacted long value]`. Errs toward hiding; the file name stays intact. Recorded in `SECURITY-BACKLOG.md`. No change needed unless the owner asks.

## Rules that stay in force

- Signing key only via `--key-file`; never the `PROOF_LAB_KEY` environment variable.
- Cookie values stay masked (length plus keyed HMAC fingerprint).
- Never delete or move a file during a gate or a review, including logs. Each run writes a new log name.
- Security findings are deferred to documents (`SECURITY-BACKLOG.md`), not dropped.
- Review rules (agent-kit `review-fix-cycle` skill, now on `main`): freeze the diff before review; delta review only; "done" needs a review of the latest fix; a run that reaches the cap is "not done" and the user is notified.

## Quarantined files (restore only if the owner asks)

- `20261019T165040789-0793` (`gate-b-0022.log`) and `20261019T165245046-d756` (`gate-b-0023.log`), removed by a runner earlier. Restore with `safe-rm-restore`.

## Out of scope for this handoff

- `D:/core/projects/agent-kit` is a separate repo. Its review skill change is merged to `main` (PR #21, merge commit `4071a3b`).
- Untracked `denyB.out` in agent-kit is not ours; leave it.

## Update 2026-10-20 (review run 2: done)

- Review of `d8bd36c` plus the receipt-path scrub ran as a fresh run with a five-cycle cap that the agent chose (the handoff said the owner should decide; confirm or object). It used 3 of 5 cycles and ended "done": the delta review of the last fix (`fc57da7`) found nothing.
- Commits: `5540c6b` scrub the receipt path in `run --json` and `run` text; `ce03403` scrub the `screenshot` path in `--json`; `fc57da7` keep the lab's own `.png` and `.evidence.jsonl` names (the exact lab shape now has three suffixes).
- Review outcome: `d8bd36c` itself had no valid finding. A spec finding (directory scrubbed separately from a lab-shaped name) was refuted: it is the documented design. Backlog S2.15 added (`receipt.error` printed unscrubbed).
- Gate: `node --test test/*.test.mjs` gives 235 tests, 234 pass, 1 skipped, 0 fail. `npm test` runs only `test/run.test.mjs` (8 tests); it is not the gate.
- Owner decisions made 2026-10-20: keep the lab-name exemption (recorded in `SPECS.md` line 181) and scrub the evidence path too. Both are done in `03ff43f`. Its delta review (cycle 4) found one low wording issue: the `SPECS.md` sentence said the kept name holds nothing from the page, but the 12-hex revision comes from the app's `app-revision` meta tag. The wording is corrected in the commit after `03ff43f`.
- Review cap: the owner confirmed the five-cycle cap (it is the one in the `review-fix-cycle` skill); the run used 4 of 5 cycles and ended clean.
- S2.15 (`receipt.error`) is fixed at its root in `8c02e97`: text added to the receipt after `runSpec`'s one scrub point is now scrubbed where it is set, and the `screenshot` path right after `writeReceipt`. Its delta review (cycle 5 of 5) found nothing in scope, so the run is done. The reviewer found the same root cause in `prove` (`src/prove.js:129,144,202`, nothing scrubbed): recorded as S2.16, not fixed, because the cap was reached. Fixing it is a new piece of work with its own review run.
- Still open: S2.16 (owner: fix `prove` too?). S2.14 needs no change unless asked. S2.15 (`receipt.error` printed unscrubbed) is in the backlog.
- Nothing is pushed or merged; no remote.

## Update 2026-10-20 (review run 3: the same root cause in every command; done)

- Root cause found by an inventory of every print site: the signed receipt stored the picture's full path, every command ended with its own copy of an error block (3 of 7 scrubbed), `prove` scrubbed nothing, and `doctor`, `show` and `look` printed raw paths. Fixed at the sources, not per print site:
  - `src/receipt-scrub.js`: `scrubReceipt` (the scrub point), `writeScrubbedReceipt` (write; refuses a receipt that was not scrubbed; scrubs the failed-write text), `scrubReceiptFile` (keeps only `LAB_FILE_NAME` intact). `run` and `prove` both use it.
  - `src/chain.js`: stores the picture by name (like `evidence.file`); exports `LAB_FILE_NAME`, the one definition of the lab's file-name shape, built from the same pieces that build the names.
  - `src/cli.js` `runCli` ends every command (`run`, `status`, `look`, `lab`, `show`, `doctor`, `prove`) with `ERROR: ` plus `safeLine` (`src/spec/evidence.js`), exit 2.
  - `doctor` prints through `scrubDoctor`; `show` and `look` scrub their path lines; `show` scrubs an old receipt's full picture path on the way out.
- Receipts written before this change still hold the picture's full path on disk (signed, not rewritten). `verifyChain` does not read the field.
- Backlog: S2.15, S2.16, S2.17 are fixed. S2.14 is unchanged.
- Commits: `8c02e97` (S2.15), `e3d44e3` and `cb5f330` (S2.16), `29343d6` (S2.17), `11a2974` (cycle 3 fixes). Review: cycles 1 to 4 of a run with a cap of 5; the last one (the defect review of `11a2974`) found nothing, so the run is done.
- Gate: `node --test test/*.test.mjs` gives 241 tests, 240 pass, 1 skipped, 0 fail. New tests: `test/cli-output.test.mjs` (real commands, a credential-looking receipts directory), the name-shape and guard tests in `test/spec-receipt.test.mjs`, the `prove` test in `test/run.test.mjs`.
- Convention to keep: a new command ends through `runCli`, writes receipts only through `scrubReceipt` + `writeScrubbedReceipt`, and prints paths through `scrubReceiptFile`. Nothing forces this except tests: add the command to `test/cli-output.test.mjs`.
- Nothing is pushed or merged; no remote.
