# SPECS: prove a feature works, with a receipt

A spec is a JSON file that says what a visitor does and what must be true afterwards. The runner drives a real
headless browser through it, records every check, and writes a signed **receipt** (a summary) and an **evidence file**
(the detail). An agent that says "done" without a PASS receipt for the current code has not shown anything.

```
node src/doctor.js  --key-file <key> [--spec specs/x.json]      is the setup sound?        exit 0 / 2
node src/run-spec.js --spec specs/x.json --key-file <key>       run it, write the receipt  exit 0 PASS / 1 FAIL / 2 ERROR / 3 PASS but needs review
                     [--spec specs/y.json ...] [--jobs N]       several specs, concurrently (see "Many specs at once")
node src/status.js  --spec specs/x.json --key-file <key>        can I say done?            exit 0 / 1 / 2 / 3
node src/show.js    --key-file <key> [--failures|--steps|...]   what happened in detail?
node src/look.js    --url <url> | --spec specs/x.json [--until N]   what does the page offer a spec? (no receipt, no key)
```

`node src/lab.js <run|status|doctor|show|look> ...` is the same set behind one entry point.

The key is read from a file only (`--key-file`, mode 0600 on Linux and macOS, at least 32 bytes). `PROOF_LAB_KEY` in the
environment is refused. Receipts go to `receipts/` unless `--receipts <dir>` or `PROOF_LAB_RECEIPTS` says otherwise.

### Many specs at once

`run` takes `--spec` more than once and runs the specs concurrently: at most half of the machine's workers
(`os.availableParallelism()`, at least one) at a time. `--jobs N` lowers that; a higher number is cut to the half, with a
note. Each run is independent: its own browser, its own app server on a free port, its own receipt and evidence file. A spec
that cannot be read, or a run that stops, is an ERROR for that spec only; the others go on. The results print in the order of
the `--spec` flags (`--json` prints a list), then one line of totals. The exit code is 1 if any spec FAILed, else 2 if any
was ERROR, else 3 if any PASS needs review, else 0. One `--spec` prints and exits exactly as before.

Separate `run` processes may also share one receipts directory at the same time. A receipt's `at` is stamped as it joins
the chain, inside the lock, so whichever run finishes first comes first and no run refuses another.

## The loop

1. `doctor` first. Exit 2 means the setup is wrong: fix it, do not guess.
2. `run-spec`. Read the verdict. FAIL names the check that failed and says what to fix.
3. Fix the code. Run again.
4. `status` before saying done. Exit 0 only for a PASS receipt for this spec **and** the code as it is now.
5. Stop rules (what `status` tells you):

| State | Exit | Meaning | Do |
|---|---|---|---|
| PASS | 0 | PASS receipt, spec and app unchanged since | Done. Show the receipt. |
| FAIL | 1 | The last run failed | Fix, run again |
| STOP | 1 | The same check failed on 3 runs in a row (`--max-attempts N`) | Stop. Hand a human the receipt. |
| STALE | 1 | PASS, but the spec or the app changed since | Run again |
| UNVERIFIED | 1 | PASS, but the app exposes no revision so freshness cannot be shown | Run again, or `--max-age <seconds>` |
| NEEDS-REVIEW | 3 | Every check passed and is fresh, but the spec lists claims only a human can judge (`review` steps) | Do not say done. Hand a human the receipt and the list. |
| NO-RECEIPT | 1 | No receipt for this spec | Run it |
| ERROR | 2 | The last run could not tell | Fix the setup, do not guess |
| CANNOT-TELL | 2 | The chain does not verify, or the spec is invalid | Fix the setup, do not guess |

An app exposes its revision with `<meta name="app-revision" content="<12 hex characters>">`. The built-in app does.

## A spec

```json
{
  "name": "waitlist",
  "app": { "bug": "no-persist" },
  "timeoutMs": 3000,
  "noPageErrors": true,
  "steps": [
    { "op": "fill", "label": "Email", "value": "ada@example.test" },
    { "op": "click", "role": "button", "name": "Join waitlist" },
    { "op": "reload" },
    { "op": "assertText", "check": "status survives reload", "testId": "status", "equals": "waitlisted",
      "hint": "Persist the record to localStorage under waitlist-record." }
  ]
}
```

| Field | Meaning |
|---|---|
| `name` | 1 to 100 characters. Receipts record `name@<12 hex of the spec file>`. |
| `app.url` | An http(s) app to test. Without it the built-in app starts on a free port. |
| `app.bug` | Inject a known defect into the built-in app (`no-persist`, `lost-confirmation`). Not with `app.url`. |
| `app.start` | Path to open first (default `/`). One leading `/`. Built-in fixture pages are under `/fixtures/`. |
| `env` | The visitor's browser, fixed for the whole run: `viewport {width, height}`, `locale` (`de-DE`), `timezoneId` (`Asia/Tokyo`), `colorScheme` (`light` `dark` `no-preference`), `reducedMotion` (`reduce` `no-preference`), `geolocation {latitude, longitude, accuracy?}`, `permissions` (a list: `geolocation`, `notifications`, `camera`, `microphone`, `clipboard-read`, `clipboard-write`, ...). Recorded in the evidence `run` record. There is no `offline` here: a run that starts offline cannot load its page; use the `setOffline` step. Geolocation is only readable by the page when `permissions` also lists `geolocation`. |
| `timeoutMs` | Default budget per step, ms (default 3000, at most 600000). |
| `noPageErrors` | Adds a final check: no uncaught exception and no `console.error` during the run. |
| `steps` | 1 to 500 steps. The spec must contain an assertion (`assert*`, a `goto` with `status`) or `noPageErrors`, or it would prove nothing. |

**Unknown fields are errors.** A typo such as `equal` is rejected before any browser starts; it can never turn an
assertion into a silent no-op. An invalid spec is exit 2 and writes nothing.

### Every step

| Field | Meaning |
|---|---|
| `op` | The operation (below). |
| `check` | The name this step gets in the receipt. Without it: `step N: op target`. (`name` without a `role` is the older spelling.) |
| `hint` | What to do when this fails. Shown in the receipt and in `status`. Write it for the agent that will read it. |
| `timeout` | Budget in ms for this step. Actions need at least 1. An assertion may use 0, which reads once. |
| `optional` | Actions only. A failure is allowed and records no failed check (the evidence timeline still shows it). |
| `not` | Assertions only. Negates the condition; it still retries until the negated condition holds. |

### Targets: which element

Exactly one of these names the element. The rest refine it.

| Field | Finds by |
|---|---|
| `role` (+ `name`) | ARIA role and accessible name (`{"role":"button","name":"Join waitlist"}`) |
| `label` | The text of its `<label>` |
| `text` | Its visible text |
| `placeholder`, `altText`, `title` | Those attributes |
| `testId` | `data-testid` |
| `selector` | A CSS selector (last resort) |

Refinements: `exact` (default `true`: whole-string match; `false` for substring), `hasText`, `nth` (0-based),
`frame` (CSS selector of an iframe, or a list for nested frames), and for `role` only: `checked`, `disabled`,
`expanded`, `pressed`, `selected`, `level`, `includeHidden`. Open shadow DOM is searched automatically; closed shadow
DOM cannot be reached.

Actions need a target that matches **one** element: several matches fail the step (ambiguous). Reads use the first match
unless `nth` is given. `assertCount` counts all matches.

### Operations (49)

| Op | Fields | Notes |
|---|---|---|
| `review` | `check`, `note?` | **Not an assertion.** A claim no check can settle (copy tone, layout feel). It never passes or fails and counts no check. The run still ends PASS, but exit 3 and `status` NEEDS-REVIEW say a human must look. A spec of claims alone is invalid. |
| `goto` | `url`, `status?` | A path starting with `/` is on the app's origin. `status` adds a check on the HTTP status. |
| `back` `forward` `reload` | | `back`/`forward` with no history do nothing: follow with `assertUrl`. |
| `waitForUrl` | `equals` or `contains` or `matches` | |
| `waitFor` | target, `state?` (`visible` default, `attached`, `detached`, `hidden`) | Use `optional` to wait without failing. |
| `click` | target, `button?`, `clickCount?`, `modifiers?`, `position?`, `force?`, `delay?` | `modifiers`: Alt, Control, ControlOrMeta, Meta, Shift. |
| `dblclick` | target, `button?`, `modifiers?`, `position?`, `force?`, `delay?` | |
| `hover` `focus` `blur` `clear` `check` `uncheck` `scrollIntoView` | target | `hover` also takes `modifiers`, `position`, `force`. |
| `fill` | target, `value` | Works on inputs, textareas, date/time/color/range inputs and contenteditable. |
| `type` | target, `value`, `delay?` | Key by key, for pages with key handlers. Prefer `fill`. |
| `press` | `key`, target? | `Enter`, `Control+a`, `Shift+Tab`. No target: the page. |
| `selectOption` | target, one of `byValue`, `byLabel`, `byIndex` | Each may be a list for a multi-select. |
| `setInputFiles` | target, `files` | Paths (relative to the spec file) or `{name, mimeType?, text?|base64?}`. `[]` clears. |
| `dragTo` | target, `to` (a target), `html5?` | `html5: true` for native drag-and-drop. |
| `scroll` | `x?`, `y?`, target? | With a target, scrolls that element; without, the page. |
| `assertText` | target, `equals` or `contains` or `matches` | Reads the rendered text (CSS `text-transform` applies). |
| `assertValue` | target, `equals` or `contains` or `matches` | The value of an input. |
| `assertValues` | target, `equals` (list) | Chosen options of a multi-select. Order ignored. |
| `assertVisible` | target, `visible?` (default `true`) | An absent element is not visible. |
| `assertState` | target, `state` | enabled, disabled, editable, checked, unchecked, indeterminate, focused, attached, detached, inViewport |
| `assertAttribute` | target, `attribute`, one of `equals` `contains` `matches` `absent` | `absent: true` = must not exist; `absent: false` = must exist, any value. |
| `assertProperty` | target, `property` (dotted), `equals` | For example `validity.valueMissing`. Objects compare by content. |
| `assertCss` | target, `property`, one of `equals` `contains` `matches` | Computed style. |
| `assertCount` | target, `count` or `min`/`max` | No `nth`. |
| `assertUrl` `assertTitle` | `equals` or `contains` or `matches` | |
| `assertStorage` | `area?` (`local` default, `session`), `key`, `path?`, one of `equals` `exists` | The value is parsed as JSON when it can be; `path` is dotted. Objects compare by content. |
| `assertCookie` | `cookie` (the name), `path?`, one of `equals` `contains` `matches` `exists` | Looks in the whole browser context. A cookie value is usually a session token: the check never records a value, expected or actual: only the length and, for `equals` and for the actual side, a short keyed fingerprint (HMAC-SHA-256 with a random key held only for the run) (`(cookie, 7 characters, hmac 1a2b3c4d)`), so two different values are told apart on a mismatch. A cookie that is not there fails, also with `not`; use `exists: false` to expect absence. |
| `setViewport` | `width`, `height` | Resizes the running page (1 to 10000). Fires `resize`. |
| `emulateMedia` | one or more of `media` (`screen` `print`), `colorScheme`, `reducedMotion` | Changes the running page; `matchMedia` listeners fire. |
| `setOffline` | `offline` | Cuts (or restores) the network of the whole browser context until a later `setOffline`. |
| `grantPermissions` `clearPermissions` | `permissions` (grant only) | For the app's origin. Without a grant a permission prompt is denied in the headless browser. |
| `setGeolocation` | `latitude`, `longitude`, `accuracy?` | Needs the `geolocation` permission to be readable by the page. |
| `setCookie` | `cookie`, `value`, `path?` (default `/`), `httpOnly?`, `secure?`, `sameSite?` | For the app's host. `sameSite: None` needs `secure: true`. |
| `clearCookies` | `cookie?` | One cookie by name, or all. |
| `setStorage` | `area?`, `key`, `value` | A non-string value is stored as JSON, the form `assertStorage` reads back. The page must already be on the app (about:blank has no storage). |
| `clearStorage` | `area?`, `key?` | One key, or the whole area. |
| `clock` | `action`, and `time` or `ms` | `install` (optional `time`), `setFixedTime` and `pauseAt` (need `time`: ISO string with an offset such as `2030-06-15T12:00:00Z` or `+02:00`, a bare date = UTC midnight, or epoch ms; a time without an offset is rejected because it would depend on the runner's time zone), `fastForward` and `runFor` (need `ms`), `resume`. Install, then `reload`, to control timers the page sets while loading. |
| `switchTab` | `index`, or one of `equals` `contains` `matches` | Moves the spec to another open tab. `index` counts the tabs that are open now, in the order they opened (0 = the oldest tab still open); the other form matches the tab's address. No such tab is a failed step. |
| `closeTab` | | Closes the current tab and moves to the last one still open. The only tab cannot be closed. |

`matches` is a regular expression; `flags` may use `d i m s u v` (not `g` or `y`).

### Expectations: what an action must cause

`goto` `back` `forward` `reload` `click` `dblclick` `press` `check` `uncheck` `selectOption` `setInputFiles` `dragTo`
take an `expect` block. The listeners are armed **before** the action runs (the event can fire before the action
returns), and each kind in the block records **one check** named `<step> -> dialog|download|popup`, with what was
asked and what really happened. If the action itself fails, only that failure is recorded: the missing event is a
consequence, not a second finding. A step with an `expect` block counts as a check for the "a spec needs a check" rule.

```json
{ "op": "click", "role": "button", "name": "Delete", "expect": { "dialog": { "type": "confirm", "message": { "contains": "Delete" }, "action": "accept" } } }
```

A text field below is a string (equals) or an object with one of `equals` `contains` `matches` (and `flags`).

| Kind | Fields | Behaviour |
|---|---|---|
| `dialog` | `type?` (`alert` `confirm` `prompt` `beforeunload`), `message?`, `action?` (`accept` default, `dismiss`), `promptText?` | The dialog is answered as `action` says; `promptText` is typed into an accepted prompt (without it OK keeps the prompt's default text). The check's `actual` is `{ type, message, answered }`, plus `dialogs` when more than one opened (the first is checked, all are answered alike). Without an `expect` block a dialog is dismissed by the browser and not recorded. |
| `download` | `filename?`, `content?` | `filename` is the suggested name. `content` is the text of the file, read only up to 1,000,000 bytes (a larger file fails the check). `actual` is `{ filename, bytes, content }` with the content clipped to 200 characters. |
| `popup` | `url?`, `title?`, `switchTo?` (default `true`) | A new tab opened by the step (a `target=_blank` link or `window.open`). It is waited for until DOM content is loaded. The spec **moves into the popup** unless `switchTo` is `false`; later steps then act on it. The popup's console output and page errors count like the first page's (a spec run does not record failed requests). |

Every kind also takes `appears: false`: nothing of that kind may happen. It waits `within` ms (default 500, at most
60000) and fails if one happened; no other field may be given with it. For an expected event the wait is the step's
`timeout`, counted from the start of the step; an event that has already happened gets at least one more second to finish (a popup to load, a download to save). The step's overall limit grows by the longest `within`. A popup that has closed itself is not switched to; if the tab the spec is on closes later, the next step on it fails (it is never silently moved to another tab: use `switchTab`). Every popup opened by the step gets the run's page-error and console hooks, and the final picture is taken from the last tab still open.

**What a receipt and its evidence never contain.** Text that comes from the page or the spec (console output, page errors, dialog and download text, titles, check `expected`/`actual`/`error` values, the accessibility tree) passes through one redaction step first: JWTs, `Bearer`/`Basic`/`Digest`/`Token`/`ApiKey` credentials, `key=value` and `key: value` pairs whose key names a password, secret, token, API or access key, authorization, credential, cookie or session, cloud access keys, private-key blocks, passwords inside an address, long hex and base64 values. The key name stays, the value becomes `[redacted]`. Hyphenated UUIDs and short ids are kept (they are identifiers, not credentials), unless their key is one of the names above; a 32-character hex run is always redacted. A spec author's own text (check names, hints, review notes, the app address) is scrubbed the same way. This happens in one place, when the receipt and the evidence lines are built (and when `look` builds its report), so a new field cannot skip it. Known costs: a `key: value` pair whose key is one of those names loses the rest of the line (a validation message that starts with "Password: " is hidden, and so is a passphrase with spaces); a short `Basic`/`Bearer` word with no digit and under 20 characters is read as prose. A check whose step names the data it reads with a credential word (`key`, `attribute`, `property` or `path` such as `authToken`, or the label of an `assertValue` such as "Password") records `(masked, N characters, hmac xxxxxxxx)` instead of the values. Page and popup addresses (including the address `assertUrl` records) are recorded as origin and path: the query and fragment are hidden, and a path segment of 16 or more characters that mixes letters and digits, or of 24 or more letters and digits, is hidden too (`assertUrl` still matches on the whole address). A screenshot is a picture of the page and is **not** redacted: a credential shown on screen appears in it. A step that stays stuck is given up on 20 s (`stepLimits.graceMs`) after its own timeout.


Further detail on the same rule. Recognised credential shapes include `OAuth`, `Token` and `ApiKey` scheme values, vendor prefixes (AKIA/ASIA, GitHub, Slack, Stripe, `sk-`, AIza), JWTs (a header of up to 1000 characters, a payload and signature of any length, also after a hyphen), any run of 40 or more characters that contains a digit (a long run of letters only is kept, like a long word; a run joined by `/` is judged as a whole and counts only when it mixes digits and both letter cases, because a path does not; a stretch of 40 characters with a digit and no `/` in it is redacted either way), a password in an address's user information (even one that contains a question mark), and key names such as `pass`, `auth`, `sid`, `pw`, `otp`, `pin`, `authorization`, `passphrase` and `passcode`. A short name counts as a whole word or a camelCase word, so `author` and `bypass` are kept but `DB_PASS`, `dbPass`, `dbPASS`, `DBPass`, `authHeader`, `auth_mode` and `pass_count` are redacted (over-redaction is the safe direction; a compound written in one case, `dbpass` or `DBPASS`, is not split and is kept); a key name keeps at most 200 more name characters before its value. An unquoted `key: value` ends at the line break; an unquoted `key=value` ends at the next blank, `&`, `,` or `;` (so the other pairs of a log line are kept; a passphrase with spaces must be quoted to be hidden whole; a quote inside the value does not end it); a quoted value (also an escaped or HTML-escaped one, with the key HTML-escaped too) runs to its closing quote, which may be on a later line; a bare `key:` at the end of a line takes an indented value on the next line, and so does a list below it (`tokens:` followed by `- a` lines), but not a quoted key, and not a list below a key that is itself a list item (an aria tree). Queries and fragments of http(s) addresses quoted inside any text (an error that names the URL it failed on, a `#/route?code=` address) are hidden, whatever the length of the address and also when a `?[query hidden]` marker is already in the text; JSON-escaped slashes (`http:\/\/`, also escaped twice) count as slashes; a quote inside a query does not end it; the key rules run first, so a key glued to a `?` or `#` hides its value before the address is cut. A credential-named step records `(masked, N characters, hmac xxxxxxxx)` for strings, numbers and objects; booleans and null are kept, and the runner's own label `<op> completes` is not a value. The names of the data read (`key`, `attribute`, `property`, `path`) use the whole list; for `assertValue`, and `assertAttribute`/`assertProperty` on `value`, the control's `label`, `placeholder`, `testId`, `selector`, `name`, `title`, `altText` or `text` counts only when it holds a strong word (password, passwd, passphrase, passcode, secret, token, api key, access key, private key, credential, cookie, authorization, session id, sid, pw, pwd, otp, pin), so a field called "Session name" is recorded. Addresses other than http(s) and `about:` are recorded as `scheme:[hidden]` (`about:` keeps its path, never its query). The query, hash and token-like path segments (the whole segment, whatever characters it holds) of an address a spec expects (`assertUrl` `equals`/`contains`, a popup `url`, `app.start`) are hidden in the label as well as in the actual; the host is kept; a `matches` regular expression is kept as written, because its `?` and `#` are syntax. An object field whose key names a credential is hidden whole but keeps its shape (a list stays a list); a field called `__proto__` or `constructor` is recorded as data and two keys that scrub to the same text are kept apart; a value nested deeper than 6 levels is flattened to a redacted JSON string, counted from each top-level field of the receipt or record. Console and page-error text is cut to 1000 characters (300 in `look`) after redaction, with one note of how many characters were dropped, counted from the original text (a text that fits is kept whole after redaction, even when placeholders make it longer; the receipt's page-error list cuts again at 200, and its note also counts from the original text); only the first 50,000 characters of a longer text are scanned. The `detail` a caller gets in process is scrubbed like the files, with the same exceptions (a screenshot's picture is kept as it is). The spec's name in `spec` (`name@hash`) is scrubbed once and the hash is appended afterwards, so a name such as `Session: idle` becomes `Session: [redacted]@hash`; `status` finds receipts written with either form and prints the scrubbed name. `look` lists storage key names as written, except that a name shaped like a credential (a long hex string, `token=...`) is redacted. A tab whose close is refused stays the current tab and the step fails; if the close never settles, the step is failed by its time limit and the run is on the tab it moved to. A page load has its own budget, 30 s in specs and `look` (and never less than `timeoutMs`), 20 s in `prove`; a load that still fails is ERROR, not a verdict on the app. Known limit: a check's pass or fail result can still tell a spec author whether a masked value contains a given text.

Redaction details settled in review cycle 12. A list below a credential key is masked whether or not its items are indented. A "run" or "stretch" of token characters means letters, digits, `+`, `_` and `-`. A page error in the receipt is kept whole when its original text or its text after redaction is 200 characters or fewer (the evidence file holds up to 1000); otherwise it is cut with a note `... [N more characters]`, and a later scrub keeps that note unchanged. The status command scrubs everything it prints, including the current revision, and reports an unreadable spec only as `parsed as JSON` or `read (code)`. One exception, decided by the owner: the lab's own receipt, picture and evidence file name (the exact stamp-and-revision shape the lab writes itself, with `.json`, `.png` or `.evidence.jsonl`; it holds only a UTC stamp and either `unknown` or the app's own 12-hex revision from its `app-revision` meta tag, which is an identifier and below the 40-character redaction rule) is kept as it is, so the file can still be found by name; the directory above it is never printed (a path shows as `<dir>/` and the name, whatever the directory holds: the operator chose it, and a guess at what looks secret in it never ends), and a name of any other shape is scrubbed like free text. The same holds for the paths `look` and `show` echo back (`--screenshot`, `--save-picture`); `doctor` names a spec by its file name and does not print the receipts directory. The messages the lab writes say "the receipts directory" and do not embed the path, and the line of a system error is built from its code, its description and the call, never from its message text; a file is named in it (`<dir>/` and the name) only when the lab wrote it (its receipt, picture, evidence or lock file, or a stale lock it claims), and any other path, a directory or a file the operator named, shows as `<path>`; any other error text, from the page or a library, is scrubbed like free text. `run` prints its receipt and evidence paths the same way (the receipt holds the picture by name, not by path). A `//user:password@host` password is hidden up to the last `@` of the same blank-free token (no length window, so a second scrub changes nothing); digits that run to a `/`, a backslash, `<`, `>`, `;`, a quote, a closing bracket, a comma or the token end after the colon (`//host:8080/path@v2`) are a port, not a password (a password that begins with digits and then holds an unencoded `/` is therefore kept; browsers read it the same way), while digits followed by `@`, `?` or `#` are masked as a password. A quoted address (opened by `"` or `'`) ends at its own closing quote on the same line, blanks inside the query included; a quote inside the query is part of it only when a letter, digit or `_` follows it, blanks after the query are part of it only when a closing quote follows later on the same line, and an unclosed quote hides the query up to the first blank, so the text after the address is kept; an unquoted address takes a quote glued to its query with it. Known limits: a blank inside an address before its `?` or `#` ends the address (a blank is not valid in a URL; the part after it is plain text); the "more characters" count of a page error is that of the first original text that redacted to the same message; a blank line between a key and its list is not masked; more than four levels of backslash escaping and unicode-escaped slashes in an address are not recognised.

`matches` is a regular expression; `flags` may use `i m s u v` (not `g` or `y`).

### How assertions behave

- They **retry** until they pass or the step's budget is spent, then record one check holding the last value read.
  There is no need for sleeps, and there is no `sleep` op.
- A content assertion (`assertText`, `assertValue`, `assertValues`, `assertAttribute`, `assertProperty`, `assertCss`,
  and `assertState` for any state but attached/detached) on an element that is **not there fails** with
  `element not found`, with or without `not`. A typo in a selector can never make a `not` assertion pass.
  `assertVisible`, `assertState` `detached` and `assertCount` treat absence as a legitimate answer.
- An action the page does not allow (no such element, ambiguous, timeout) is a **failed check**, not an ERROR, and the
  run goes on so the receipt lists every failure.

## The receipt

A signed JSON file, `receipts/<stamp>-<revision>.json`, small on purpose:

| Field | Meaning |
|---|---|
| `verdict` | `PASS` every check passed and there was at least one; `FAIL` one or more failed; `ERROR` the run could not tell |
| `spec`, `app`, `bug`, `revision`, `at` | Which spec (`name@hash`), where, any injected bug, the app revision seen, when the receipt joined the chain (the end of the run; the evidence's `run` record holds its start) |
| `totals` | `{checks, passed, failed, omitted}`. `omitted` counts failed checks not listed below (the first 20 are listed). |
| `checks` | **Failed checks only**: `{step, name, pass, expected, actual, hint?, error?}`, long values clipped to 200 characters |
| `review` | `{total, items}`: claims from `review` steps that need a human (the first 20 as `{step, name, note?}`). Receipts from before this field have none. |
| `evidence` | `{file, sha256, bytes}`: the evidence file next to the receipt, and its hash (covered by the signature) |
| `pageErrors` | Up to 10 page errors, clipped |
| `screenshot`, `error`, `next` | The file name of the final full-page screenshot (next to the receipt, stored by name like `evidence.file`; receipts from before this held its full path); why the run is ERROR; what to do next |
| `keyId`, `prevHash`, `hash`, `mac` | The chain: each receipt links to the one before and is signed |

ERROR means "cannot tell", never "broken": an unreachable app, a browser that did not start, an app that changed during
the run, a receipt that could not be written, an invalid spec. Run again once the setup is sound.

`verify` (`src/prove.js --verify`, or `status`/`doctor`) checks the whole chain. A changed evidence file is a problem;
a missing one is only a note, because the failures themselves are in the signed receipt.

## The evidence

`receipts/<stamp>-<revision>.evidence.jsonl`: one JSON record per line. Read it with `show`, or with any tool.

| `type` | Holds |
|---|---|
| `run` | spec, app, revision, time, budget, node, platform, browser version |
| `step` | `step`, `op`, `target`, `check`, `ms`, `ok`, and `skipped` for an optional step that failed |
| `check` | Every check in full: `step`, `name`, `pass`, `expected`, `actual`, `hint?`, `error?` |
| `review` | Every claim from a `review` step: `step`, `name`, `note?` |
| `context` | For the first 5 failures: `url`, `title`, and `aria`, the accessibility tree of the page then |
| `screenshot` | For the first failure: a small JPEG (`mime`, `base64`) |
| `console`, `pageerror` | Console output (up to 500 records) and uncaught page errors |
| `summary` | verdict, totals, error |

```
node src/show.js --key-file k.txt                  the receipt summary
node src/show.js --key-file k.txt --failures       failed checks with the page as it was
node src/show.js --key-file k.txt --steps          the timeline: which step, how long, what failed
node src/show.js --key-file k.txt --checks --console --json
node src/show.js --key-file k.txt --save-picture failure.jpg
node src/show.js --receipt <file> --receipts <dir> ...
```

`show` checks the evidence against the receipt's hash first and refuses to show a file that does not match.
Evidence may be pruned to save space; the receipts stay valid.

## Look before you write

`look` opens a page the way a run does (a fresh visitor, no stored state) and prints what a spec can use. It writes no
receipt and needs no key. Use it to find the role and name of a control, the test ids, and the storage keys, instead of
guessing them from source.

```
node src/look.js --url http://127.0.0.1:4173/                 the page as loaded
node src/look.js --spec specs/waitlist.json --until 5          the page after the spec's first 5 steps
node src/look.js --spec specs/waitlist.json --screenshot p.png --json
```

It reports the title and HTTP status, the targets as `{role, name}` (a repeated pair is flagged: add `nth` or narrow it),
test ids, localStorage and sessionStorage keys (names only, never values), the frame count, console output, page errors,
failed requests (origin and path only, never the query), and the accessibility tree. `--spec` replays the spec's own steps,
which may change the app's state; `--url` only loads the page. `--screenshot` never replaces an existing file. Exit 0
when it looked, 2 when it could not; never 1, because nothing was checked.

## Fixtures

The built-in server serves pages and endpoints so every op has something real to run against. Local use only (it binds
127.0.0.1 and answers only `127.0.0.1` and `localhost`).

Pages (`/fixtures/<name>.html`): `forms` (every input type, validation, submit, reset), `interact` (click variants,
hover, keys, focus order, drag, scroll), `timing` (delays, debounce, lazy elements), `nav` and `nav-b` (links, history,
hash and query routes), `popups` (a `target=_blank` link, `window.open` from a script, two at once, one after a pause), `frames` (iframes, open and closed shadow DOM), `dialogs` (alert, confirm, prompt,
download, file input, clipboard, geolocation, notifications), `storage` (cookies, local/session storage, IndexedDB,
locale, time zone, colour scheme), `env` (viewport, colour scheme, reduced motion, print media, locale, number format,
time zone, online state, geolocation, a fetch to try offline, current time, a 5 s timer), `network` (fetch, slow, failing, console and page errors), `a11y` and `a11y-bad`.

Endpoints: `/api/items`, `/api/echo`, `/api/slow?ms=`, `/api/status/<code>`, `/api/redirect?to=`, `/api/cookie?value=`,
`/api/count` (POST needs the `X-Proof-Lab` header), `/download/hello.txt`, `/__revision[?path=/fixtures/<page>]`.

## Limits worth knowing

- One revision per receipt: the page the run opened first. A change to a page reached later is not detected.
- A closed shadow root cannot be reached by any locator.
- `back` and `forward` cannot tell "no history" from a same-document move; assert the URL.
- `assertText` reads rendered text. `assertAttribute` or `assertProperty` read the source value.
- Not yet covered: file chooser, request and response expectations, network mocking, accessibility audits,
  and visual comparison. See the roadmap in the commit history.
- Locale and time zone are fixed per run (`env`), not changed mid-run: they need a new browser context.
