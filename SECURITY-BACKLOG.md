# Security and hardening backlog

Findings from review cycles 1 to 13 that are valid but deferred. The product goal comes first: a working, clean verification tool. Every item here is a known limit, not an oversight. Resolve them in a later hardening pass, starting with the structural redesign (item S1).

Last updated: 2026-10-19.

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
| S2.14 | `scrubStatus` scrubs the receipt directory with the same rules as free text. A directory name of 40+ base64-like characters with a digit, a letter in each case (for example `/home/runner2/work/ProofLab/ProofLab/receipts`, or a hyphenated Windows folder name) prints as `[redacted long value]`. The receipt file name stays intact, so the receipt is still found by name. Errs toward hiding; the printed path is wrong, no data is lost. Cycle-16 defect review F1. | low |

## S3. Other deferred items

| ID | Item | Severity |
|---|---|---|
| S3.1 | Screenshots can show on-screen credentials; they are kept as taken (documented, not redacted). | medium |
| S3.2 | `src/chain.js` key id is an unsalted sha256 of the key; the key file must be random, enforced only by length. | medium |
| S3.3 | Key-file permission check and symlink checks are skipped on Windows hosts (tests skipped). | low |
| S3.4 | The revision text from the app under test is scrubbed for display but compared raw. | info |
| S3.5 | Hint text is clipped at 300 characters while the docs say 200. | info |
| S3.6 | Old-name receipts are matched in `status` by a dual-form comparison (kept for compatibility). | info |
