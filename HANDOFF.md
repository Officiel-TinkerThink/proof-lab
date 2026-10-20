# Handoff: proof-lab

Date: 2026-10-20. Branch: `feat/regression-tests`. Remote: none configured, nothing pushed, nothing merged.

## State

- Working tree: clean after the commit that adds this file. The last fix commit is the cycle-14 commit.
- Gates on the final tree (log names `gate-{a,b,c}-0024`, all in `C:/Users/wahyu.sinurat-mp/.claude-me/agent-kit/verification-logs/`):
  - A: 72 tests, 71 pass, 0 fail, 1 skipped (key-file group/other-readable permission test; not runnable on this Windows host).
  - B: 54 tests, 54 pass, 0 fail.
  - C: 106 tests, 106 pass, 0 fail.
- `node demo/run-demo.mjs` ran before the cycle-14 fixes. Output shows PASS 0, FAIL 1 (two bugs), NEEDS-REVIEW 3, expectations PASS 0, ERROR 2 (invalid spec, no checks), chain VALID, tamper INVALID. Re-run it once before showing the owner.

## Commits (this branch)

- `542c486`, `c6f7148`, `ae1d8ea`: cycles 9 to 11.
- `6b7f3e4`: cycle 12 fixes.
- `7e4edfc`: cycle 13 fixes, `SECURITY-BACKLOG.md`.
- Cycle-14 fixes: the commit that adds this file.

## What changed in cycle 14

- Quoted address: text after a quoted address is kept. Unclosed quotes hide only the query, up to the first blank. Quote handling in the query follows SPECS.md.
- `status` and `doctor`: the receipt path is no longer scrubbed. `scrubStatus` in `src/status.js` replaces the old `scrubValue(raw)` call, and `formatStatus` uses it too.
- Port delimiter set spelled out in SPECS.md. `;`, `<`, `>` were added to the documented set.
- Tests added: quoted address, `scrubStatus`.

## Open items, in order

1. **Cycle-15 review of the cycle-14 fixes was not run.** Stop condition not yet met. Run `code-review:defect-reviewer` and `code-review:spec-reviewer` on the diff `7e4edfc..HEAD`, with the scope contract from `SECURITY-BACKLOG.md` (in scope: wrong results, crashes, non-idempotent scrub, destroyed ordinary text; out of scope: hardening and hostile-input shapes). Judge each finding; fix in-scope ones; park the rest in the backlog.
2. Re-run `node demo/run-demo.mjs` after any change, and show the owner every receipt variant.
3. **Security redesign (backlog S1) is deferred** per owner direction. Do not start it without a new decision.
4. Untracked `denyB.out` in `D:/core/projects/agent-kit` is not ours; leave it.

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
