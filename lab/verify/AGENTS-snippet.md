## Verification rule (paste into the project's AGENTS.md)

Before you say a browser-visible change is done:

1. Follow `lab/verify/SKILL.md`: spec for the feature, `node src/lab.js run`, then `node src/lab.js status`.
2. You may say "done" only when status is PASS on the current revision. Cite the receipt file name and the check totals.
3. On NEEDS-REVIEW (exit 3) every check passed but a human must judge the listed claims: say so and hand over the receipt. It is not done.
4. On STOP (same check failed three times) stop editing and report what you tried.
5. On STALE, UNVERIFIED, NO-RECEIPT or ERROR, run again or fix the setup. None of these is a pass.
6. Never edit receipts or evidence, and never pass the signing key except with `--key-file`.
