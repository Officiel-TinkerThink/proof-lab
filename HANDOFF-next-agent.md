# Handoff: proof-lab redaction work (state after review run 5)

Date: 2026-10-20. Repo: `D:/core/projects/proof-lab`. Branch: `feat/regression-tests`. No git remote configured: nothing is pushed, nothing is merged. Do not push or merge unless the owner asks.

Read first: `HANDOFF.md` (older state and history), `SPECS.md` lines 176-181 (the redaction contract), `SECURITY-BACKLOG.md` (scope contract: S1, S2.x, S3.x are deferred and must not be re-reported).

## State

- Code head: `7da1456`. Last reviewed head: `7da1456` (defect and security review, cycle 3 of 5: no finding). The review run is **done**; there is no unreviewed code. Later commits are documentation only.
- Gate: `node --test test/*.test.mjs` gives 244 tests, 243 pass, 1 skipped, 0 fail. **`npm test` is not the gate**: it runs only `test/run.test.mjs` (the prove scenarios). The full run takes about 90 s; run it in the background.
- The one skipped test is `a key file readable by group or others is refused` (`test/durability.test.mjs:39`). It checks POSIX file modes, so it runs only on Linux and macOS and is skipped on Windows.
- Demo (`node demo/run-demo.mjs`: PASS 0; FAIL 1 twice; NEEDS-REVIEW 3; expectations PASS 0; ERROR 2 twice; chain VALID 0; tamper INVALID 1) was last verified on `d8bd36c`. **It was not re-run after the changes below.** Run it before relying on it.

## What is decided (owner decisions, 2026-10-20)

- The directory of a path the lab prints is never printed. A path shows as `<dir>/` and the file name; the lab's own file names (receipt, picture, evidence) are kept as they are, any other name is scrubbed like free text. Recorded in `SPECS.md` line 181. This replaced the earlier rule "scrub the directory" and closes S2.14.
- In an error line a file is named only when the lab wrote it (its receipt, picture, evidence or lock file); every other path, a directory or a file the operator named, shows as `<path>`.
- The evidence path is handled like the receipt path. `prove` gets the same scrub as `run`.
- The review cap is five cycles per run (the one in the `review-fix-cycle` skill).

## What the code does now

The root cause of every raw-path leak was that nothing forced a command's output through one rule, and that the lab guessed which text looked secret in values the operator chose. It is fixed at the sources, by structure and not by pattern:

- `src/receipt-scrub.js`:
  - `scrubReceipt` is the one scrub point, before a receipt is written. `writeScrubbedReceipt` is the only way `run` and `prove` write a receipt; it throws for a receipt `scrubReceipt` has not seen.
  - `scrubReceiptFile` shows a printed path as `<dir>/name` (never the directory). `fromPrinted` reads such a path back (`show --receipt <dir>/name` works).
  - `safeLine` is the line of an error that every command prints. A system error that names a path (code, syscall, errno, path) has its line **built from those fields** in Node's form, never from its message text; nothing is searched or replaced in a string. Other errors are free text with the pattern scrub. It never throws (`UNREADABLE_ERROR` is the last resort). The pattern scrub is not run over a finished structured line, because it would hide the lab's own 43-character file names.
- `src/chain.js`: `writeReceipt` stores the picture by file name. `LAB_FILE_NAME` is the one definition of the lab's file-name shape. A write that fails sets `error.leftovers` (bare file names it could not remove) instead of rewriting the message. Lab-written messages say "the receipts directory" and carry no path.
- `src/cli.js` `runCli` ends every command (`run`, `status`, `look`, `lab`, `show`, `doctor`, `prove`): scrubbed `ERROR: ` line through `safeLine`, exit 2. Exit 1 means "a check failed", never an unexpected error.
- `doctor` prints through `scrubDoctor` and names a spec by its file name (two specs with the same file name are numbered `#1`, `#2`); `show` and `look` scrub their path lines.
- Tests: `test/cli-output.test.mjs` runs the real commands against a receipts directory named `password=hunter2`; the `safeLine` test in `test/spec-receipt.test.mjs` uses real file-system errors and compares with Node's own message; the `prove` test is in `test/run.test.mjs`.

## Open items

1. **Convention, enforced by tests only.** A new command must end through `runCli`, write receipts only through `scrubReceipt` + `writeScrubbedReceipt`, print paths through `scrubReceiptFile` and errors through `safeLine`. Nothing in the module graph forces it. Add any new command to `test/cli-output.test.mjs`.
2. **Old receipts on disk** still hold the picture's full path in the signed `screenshot` field (and, if written before the S2.15 fix, a path in `error`). They are not rewritten (that would break the signatures). `verifyChain` does not read the field; `show` scrubs the screenshot when printing, not `error` and `next` (S2.18).
3. **Unchecked: an outside reader of the receipt format.** A comment in `src/chain.js` mentions a Go struct and a "Go driver". No Go code is in this repo, so I could not check whether it treats `screenshot` as a path. The field is still a string, and new receipts hold a bare name. Ask the owner if a Go reader exists.
4. **Backlog items left open, all low:** S2.18 (prints that still carry text without the path rule: stored `error`/`next` in `show`, `prove --verify` problem strings, the test app's HTTP error message, the unknown-command echo in `lab`); S3.7 (`writeAtomic` keeps the renamed file if the directory sync fails, `src/chain.js`). S2.14 to S2.17 are fixed, with their remaining limits written in the rows.
5. **Not scrubbed, by design:** `look()` returns the caller's own `--screenshot` path in its result (only the printed output is scrubbed). `.chain.lock.stale-<hex>` is not on the allow-list, so an error on it prints `<path>`.

## Rules that stay in force

- Signing key only via `--key-file`; never the `PROOF_LAB_KEY` environment variable.
- Cookie values stay masked (length plus keyed HMAC fingerprint).
- Never delete or move a file during a gate or a review, including logs. Each run writes a new log name.
- Security findings are deferred to documents (`SECURITY-BACKLOG.md`), not dropped.
- Review rules (agent-kit `review-fix-cycle` skill): freeze the diff before review; delta review only; "done" needs a review of the latest fix; a run that reaches the cap is "not done" and the user is notified; when the same function keeps producing findings, change the design, not the patch (`safeLine` was redesigned that way).

## Quarantined files (restore only if the owner asks)

- `20261019T165040789-0793` (`gate-b-0022.log`) and `20261019T165245046-d756` (`gate-b-0023.log`), removed by a runner earlier. Restore with `safe-rm-restore`.

## Out of scope for this handoff

- `D:/core/projects/agent-kit` is a separate repo. Its review skill change is merged to `main` (PR #21, merge commit `4071a3b`).
- Untracked `denyB.out` in agent-kit is not ours; leave it.

## History of this branch's redaction work

- `d8bd36c`: exact lab-name shape; non-lab names scrubbed with the whole path. Reviewed in run 2: no finding.
- Run 2 (cap 5, used 4): `5540c6b`, `ce03403`, `fc57da7`, `03ff43f`, `33f5e48`: receipt, picture and evidence paths in `run`; the exemption recorded in `SPECS.md`.
- S2.15 (`receipt.error`): `8c02e97`. S2.16 (`prove` scrubbed nothing): `e3d44e3`, `cb5f330`.
- Run 3 (cap 5, used 4): S2.17, the same root cause in every command: `29343d6`, `11a2974`.
- Run 4 (cap 5, used 3): S2.14 at the root, the directory is never printed: `5eb87c8`, `3d0a5f0`, `77561b6`, `083fe6e`, `a8ab385`. Last review: no finding.
- Run 5 (cap 5, used 3): `safeLine` redesigned to build a system error's line from its fields instead of searching its message (it had been patched in four consecutive cycles): `b9b7a1e`, `c3f45c9`, `7da1456`. Last review (defect and security): no finding.
