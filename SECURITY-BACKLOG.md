# Security and hardening backlog

Findings from review cycles 1 to 13 that are valid but deferred. The product goal comes first: a working, clean verification tool. Every item here is a known limit, not an oversight. Resolve them in a later hardening pass, starting with the structural redesign (item S1).

Last updated: 2026-10-20 (S2.14 to S2.17 fixed at their root; see each row).

## S1. Redaction of free text is pattern-based and cannot be complete (design)

Receipts and evidence scrub free text (page errors, console output, URLs, check values) with an ordered pattern list in `src/spec/evidence.js` (`SECRET_PATTERNS`). Recognising secrets in an open set of text shapes has no end: cycles 9 to 13 each found new shapes.
Planned fix: record structural data by default (names, pass or fail, counts, lengths, keyed HMAC fingerprints); keep raw free text opt-in in a separate evidence file, best effort; keep the patterns as a second layer. Done when no reviewer finds a leak in the default output.

## S2. Known limits of the pattern layer (documented in SPECS.md)

| ID | Limit | Severity |
|---|---|---|
| S2.1 | Pass or fail of a check can act as an oracle on a masked value (bisection). | low |
| S2.2 | An unindented value on the line after a key, and a quoted key with a value on the next line, are not masked. | medium |
| S2.3 | Compound names in one case (`dbpass`, `DBPASS`) are not split. | low |
| S2.4 | A list below a key that is itself a list item is kept; a blank line between a key and its list is not masked. | low |
| S2.5 | More than four levels of backslash escaping, and unicode-escaped slashes in an address, are not recognised. | low |
| S2.6 | A blank inside an address before its `?` or `#` ends the address; text glued after a quoted address's closing quote is plain text. | low |
| S2.7 | Unquoted `key=value` ends at a blank, `&`, `,` or `;`; a passphrase with spaces must be quoted. | medium |
| S2.8 | A password that begins with digits and holds an unencoded `/` is read as a port plus path and kept. | low |
| S2.9 | The page-error "more characters" count is that of the first original text that redacted to the same message. | info |
| S2.10 | A page error cut inside a `[query hidden]` marker can be re-expanded by a later scrub. | low |
| S2.11 | An HTML-entity quoted value stops at an escaped closer (`\&quot;`). | low |
| S2.12 | A password that begins with digits and continues with one of `;`, `<`, `>` or a closing bracket right after the digits (`//u:1234;x@h`) is read as a port and kept; the delimiter set is spelled out in SPECS.md. | low |
| S2.13 | A quoted sentence that contains an address takes the text up to its closing quote into the hidden query (for example `"What? see https://a.b/c?x=1 and more" ok` hides `see … and more`). Follows the spec's blank-inside-query rule; errs toward hiding. | low |
| S2.14 | `scrubStatus` scrubs the receipt directory with the same rules as free text. A directory name of 40+ base64-like characters with a digit, a letter in each case (for example `/home/runner2/work/ProofLab/ProofLab/receipts`, or a hyphenated Windows folder name) prints as `[redacted long value]`. The receipt file name stays intact, so the receipt is still found by name. Errs toward hiding; the printed path is wrong, no data is lost. Cycle-16 defect review F1. **Fixed 2026-10-20 at the root:** the cause was a secret detector run over a value the operator chose, which can never be complete and quiet at once. The lab no longer prints the directory of a path it prints itself (`<dir>/` and the file name; `doctor` names a spec by its file name). The messages the lab writes no longer embed a directory (they say "the receipts directory"), and the line of a system error is built from its fields (code, description, call, and the file names as `<dir>/` and the name) and never from its message text (`safeLine`), so nothing is searched or replaced inside a string. What stays pattern-scrubbed is free text that holds a path the lab did not hand to the call: text from the page or a library (for example a Playwright message), where a long folder name can still show as `[redacted long value]`; an error from a library that has a `path` property but no `syscall` (the lab's own calls raise none); and text that echoes the operator's own input back (for example `--url is not a URL: …`). In an error line a file is named only when the lab wrote it (its receipt, picture, evidence or lock file; `<dir>/name`); every other path, a directory or a file the operator named (for example a key file), is `<path>`, an allow-list that does not depend on which call failed. | fixed |
| S2.15 | `receipt.error` (for example `receipt write failed: <fs error>`) is copied into `run --json` and printed by `run` as the error line without a path scrub, so a Node fs error that names a receipts directory holding a secret-like segment prints that directory. Free-text error path; pre-existing. Found by the 2026-10-20 review run, cycle 2. **Fixed 2026-10-20:** the cause was text added to the receipt after the one scrub point in `runSpec`; the failed-write `error` and `next` are now scrubbed where they are set, and the `screenshot` path is scrubbed right after `writeReceipt` stores it, so the receipt a caller gets in process and both printouts are clean. | fixed |
| S2.16 | `prove` has the same root cause as S2.15 and none of its fix: `src/prove.js` prints the whole receipt (`:202`) and scrubs nothing. The `screenshot` path (raw receipts directory, set by `writeReceipt`), the failed-write `error` (`:144`) and `pageErrors` (`:129`, filled raw from the page at `:69-70`) reach the printout as they are. `prove` runs the lab's own fixture app, so the page text is the lab's; the receipts directory is chosen by the operator. Found by the 2026-10-20 review run, cycle 5; not fixed there because the five-cycle cap was reached. **Fixed 2026-10-20:** the three scrub steps now live in `src/receipt-scrub.js` and both `run` and `prove` call them (scrub point before the write, failed-write text, stored picture path), so a new entry point imports them instead of copying them. | fixed |
| S2.18 | Prints that still carry text without the path rule (found by the 2026-10-20 security review, outside the changes then under review). Fixed in run 6: `show` prints a stored receipt's `error` and `next` through `scrubText` (every path in it becomes `<path>`, then the pattern scrub); `prove --verify`, `status` and `show` print verify problems through it; `lab` scrubs the unknown command word it echoes; `run` scrubs a spec-refusal message. Residual: `server.js` returns an error's message to the HTTP client of the built-in test app; that text is not printed by a lab command, so it is left as it is. | low, mostly fixed |
| S2.17 | The same root cause in the other commands (found by an inventory of every print site, 2026-10-20). The signed receipt held the picture's full path (`screenshot`), so `show --json` printed the receipts directory; `doctor` printed raw directories, spec paths and receipt paths in text and `--json`; `show` and `look` printed raw path lines; four of seven commands printed an error line without a scrub. **Fixed 2026-10-20 at the sources:** the receipt stores the picture by name (like `evidence.file`; old receipts that hold a path are scrubbed by `show` on the way out); one `runCli` wrapper (`src/cli.js`) ends every command with a scrubbed error line (`safeLine`); `doctor` prints through one `scrubDoctor`. Receipts written before this change still hold the full path on disk (signed, not rewritten). | fixed |

## S3. Other deferred items

| ID | Item | Severity |
|---|---|---|
| S3.1 | Screenshots can show on-screen credentials; they are kept as taken (documented, not redacted). | medium |
| S3.2 | `src/chain.js` key id is an unsalted sha256 of the key; the key file must be random, enforced only by length. | medium |
| S3.3 | Key-file permission check and symlink checks are skipped on Windows hosts (tests skipped). | low |
| S3.4 | The revision text from the app under test is scrubbed for display but compared raw. | info |
| S3.5 | Hint text is clipped at 300 characters while the docs say 200. | info |
| S3.6 | Old-name receipts are matched in `status` by a dual-form comparison (kept for compatibility). | info |
| S3.7 | `writeAtomic` (`src/chain.js`) renames the file into place and then syncs the directory (POSIX). If the sync fails, its catch removes only the temporary file: the renamed receipt stays on disk, `writeReceipt` does not list it in `leftovers`, and the run reports ERROR while a signed receipt exists. Fixed on POSIX (run 6): a rename the directory does not confirm removes its target, so a failed write leaves nothing. Residual: on Windows the directory is not synced, so the rename is not flushed by this code. | low, POSIX fixed |

## U. User-feedback backlog (from `proof-lab-feedback.md`, 64 items, 2026-10-28)

Fixed in this pass: F-07/F-30 (`allowPageErrors`), F-15 (`validate`), F-13/F-44/F-59 (`--spec-dir`, "N of M specs run"), the docs items (F-21, F-26 to F-29, F-31, F-35, exit 3, flags). F-06 was fixed earlier by the concurrent-runs commit. Deferred, with the reason:

| ID | Item | Why deferred |
|---|---|---|
| U.1 | F-08, F-58: a `list` command; absolute receipt paths | `list` is new surface; absolute paths conflict with the deliberate path scrubbing (S2.14). Needs an owner decision. |
| U.2 | F-23: `review --accept` that signs a human verdict into the chain | Chain format and Part 11 signing meaning need a design. |
| U.3 | F-25, F-37, F-42, F-47, F-52, F-54: capture variables, setup hooks | New spec language; needs a design. |
| U.4 | F-33, F-34, F-48 to F-51, F-53: binary upload, new-tab follow, second browser context, mail sink, session identity | New ops; each needs a design. |
| U.5 | F-26, F-46, F-55: warn or refuse an absence-only check without a positive control | Lint rule with false positives; needs a design. |
| U.6 | F-41, F-43, F-63: richer failure hints (match list, text in pieces) | Needs the locator code path; small follow-up. |
| U.7 | F-04: `look --spec` warning when the app URL is not loopback | Small follow-up. |
| U.8 | F-56, F-57, F-64: contrast check, table-driven step, `colorScheme` in screenshot | New features / needs reproduction. |
| U.9 | F-02, F-11, F-14, F-20, F-24, F-32, F-61, F-62, F-19, F-10 | agent-kit guard and agent behaviour, not this repo. |
| U.10 | F-03, F-60 | `setup.mjs` `--run --receipts` pass-through is not in this repo. |
