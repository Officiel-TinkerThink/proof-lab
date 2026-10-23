---
name: verify
description: Verify browser-visible work before saying it is done. Write or update the spec for the feature, run it, read the status, and report only what the receipt supports.
---

# Verify before you say done

"Done" means a signed receipt on the current revision says PASS. Your own reading of the code, a green unit test or "it looked right" does not count.

## Loop

1. **Read the feature map** in `lab/verify/features/<feature>.md`: what exists, how a visitor gets there, how to drive it, what usually lies. If none exists, write one from the page, not from the code.
   To learn the real role, name, test ids and storage keys of the page, run `node src/lab.js look --url <url>` (or `--spec <file> --until <step>` for the page after some steps). It writes no receipt.
2. **Write or update the spec** in `specs/<feature>.json` (format and ops: `SPECS.md`). Assert what a visitor sees and what is stored, not what the code intends. Every claim you will make needs a check with a `hint` saying what to fix when it fails.
3. **Preflight once per session:** `node src/lab.js doctor --key-file <key> --spec specs/<feature>.json`.
4. **Run:** `node src/lab.js run --spec specs/<feature>.json --key-file <key>`. Exit 0 PASS, 1 FAIL, 2 cannot tell.
   Several features: repeat `--spec` (`--spec specs/a.json --spec specs/b.json`). They run concurrently, up to half the machine's workers (`--jobs N` for fewer), each with its own receipt; one broken spec does not stop the others. Separate `run` commands on the same receipts directory are also safe at the same time.
5. **Read the gate, not the log:** `node src/lab.js status --spec specs/<feature>.json --key-file <key>`.
6. **Investigate only what failed:** `node src/lab.js show` reads the evidence of a receipt (failing step, console, page snapshot, screenshot). The receipt is a summary on purpose.

## Stop rules

| Status | Meaning | What you do |
|---|---|---|
| PASS | Current spec, current revision, all checks passed | You may say done, citing the receipt file |
| FAIL | A check failed | Read the hint, fix the app, run again |
| STOP | The same check failed on 3 receipts in a row | Stop editing. Say what you tried and ask for help |
| STALE | The spec or the app changed since the last receipt | Run again; an old PASS proves nothing |
| NEEDS-REVIEW (exit 3) | Every check passed, but the spec lists `review` claims a human must judge | Do not say done. Hand a human the receipt and the list |
| UNVERIFIED | The app exposes no revision | Add `<meta name="app-revision">` or pass `--max-age` |
| NO-RECEIPT | Nothing recorded yet | Run |
| ERROR / CANNOT-TELL | The run could not decide (setup, timeout, bad spec) | Fix the setup. This is not a FAIL and not a PASS |

## Rules

- Never edit a spec to make a failing check pass unless the expectation itself was wrong, and then say so in your report.
- Never delete, rewrite or hand-edit receipts or evidence. They are hash-chained and signed.
- Never put the signing key on the command line or in the environment: `--key-file` only.
- Report the receipt file name, the verdict and the check totals. Do not claim anything the spec did not assert.
- A claim that is not an assertion (looks good, feels fast, copy reads well) goes in the spec as a `review` step with a note. It never passes: the run ends exit 3 and status NEEDS-REVIEW. Never turn a claim into a weak assertion to get a green PASS.
