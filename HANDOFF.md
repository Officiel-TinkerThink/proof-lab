# Handoff: proof-lab

Date: 2026-10-20. Branch: `feat/regression-tests`. Remote: none configured, nothing pushed, nothing merged.

## State

- Last commit: `164570c` (cycle-14 fixes and this file). Gates for it are green: `gate-{a,b,c}-0024`.
- **Uncommitted, in progress (cycle 15 fixes):**
  - `src/spec/evidence.js`: the quoted-address rule. A quote inside the query stays in it when a letter, digit or `_` follows it. The blank group after the query also takes such quotes, so `"https://h/x?a=1 b"c d"` hides the whole address.
  - `src/status.js`: `scrubStatus` keeps the receipt file name intact and scrubs the directory above it. The separator is kept outside the scrub.
  - `test/spec-expect.test.mjs`: tests for the quote rule and for the receipt path.
  - `spec-expect` suite: 72 of 72 pass on these edits.
  - Gates A, B and C have NOT been rerun on these edits. Run them before committing.
- Demo: `node demo/run-demo.mjs` was rerun on `164570c` and matched every expected verdict, exit code and chain result. Rerun after the uncommitted edits, then show the owner every receipt variant.

## Review status

- Cycle 15 (the review of the cycle-14 fixes):
  - Defect reviewer: 0 findings. Its out-of-scope items are in the backlog list below.
  - Spec reviewer: 2 findings, both fixed in the uncommitted edits above. F1 receipt path printed unscrubbed. F2 a quote inside the query ended the match too early.
- The loop is not yet clean: the cycle-15 fixes have not been reviewed. Run one more cycle (defect and spec reviewers on the diff `164570c..HEAD`, with the scope contract in `SECURITY-BACKLOG.md`).
- New limit to add to the backlog: a quoted sentence that contains an address takes the text up to its closing quote into the hidden query (for example `"What? see https://a.b/c?x=1 and more" ok` hides `see … and more`). This follows the spec's "blanks inside the query" rule and errs toward hiding. Record it as S2.13.

## Commits (this branch)

- `542c486`, `c6f7148`, `ae1d8ea`: cycles 9 to 11.
- `6b7f3e4`: cycle 12 fixes.
- `7e4edfc`: cycle 13 fixes, `SECURITY-BACKLOG.md`.
- `164570c`: cycle 14 fixes, `HANDOFF.md`.

## Open items, in order

1. Commit the uncommitted cycle-15 edits after gates A, B and C pass on them.
2. Run the cycle-16 review on the cycle-15 fixes (see Review status). Fix in-scope findings, park the rest in the backlog. Stop when a cycle yields no in-scope finding.
3. Rerun the demo after the last change and show all receipt variants to the owner.
4. Security redesign (backlog S1) is deferred per owner direction. Do not start it without a new decision.
5. Untracked `denyB.out` in `D:/core/projects/agent-kit` is not ours; leave it.

## Quarantined files (restore only if needed; the owner runs this)

- `20261019T165040789-0793`: `gate-b-0022.log`, removed by a runner. Restore with `safe-rm-restore`.
- `20261019T165245046-d756`: `gate-b-0023.log`, removed by a runner. Same.

Annotations on file: `ann-20261019T165709055392-23d0aa` (noncompliant, high), `ann-20261019T165843650764-8e7e9c` (noncompliant, medium). Both are rule violations by `verification-runner` (unrequested delete). Suggested fix in the annotations: forbid `rm` or move on logs and unnamed files, and forbid post-run cleanup.

## agent-kit

- Committed as `9c171ab` on `feat/general-purpose-routing`: scope contract, backlog, bounded-mechanism check, autonomous decisions with researched best practice.
- Full suite `agentkit-0002`: ALL PASSED (684 s).
- Not pushed or merged.

## Owner notes (decide later; not blocking)

- No remote for proof-lab. Choose where to push.
- `master` fast-forward decision.
- Symlink and key-file permission tests are skipped on Windows.
- Screenshots can show on-screen credentials (documented, S3.1).
- `chain.js` key id is an unsalted sha256 of the key (S3.2).

## Close-out: cycle cap reached (not done)

Date: 2026-10-20. Branch `feat/regression-tests`. Last commit `d8bd36c`.

- Review cap: five review cycles, as agreed. This run is not done.
- Unreviewed fixes (commit `d8bd36c`): exact lab name shape for `LAB_RECEIPT_NAME`; non-lab names scrubbed with the whole path (joined-run rule); bare drive letter with a lab name kept intact. Tests: 233 pass, 1 skipped, 0 fail. Demo rerun matches every variant.
- Last reviewed head: `1954c8f` (defect and spec review found the two items fixed in `d8bd36c`).
- Open, low: `run-spec.js:375` prints `receiptPath` unscrubbed in `run --json`. Not in the diff; not yet checked against the backlog.
- Open, documented: directory over-hiding (S2.14); lab-name exemption deviates from spec line 181 literal wording (human decision: keep the exemption or scrub the name too).
- Next step for the owner: decide whether to accept `d8bd36c` as is, or open a new run with a fresh cap to review it.
