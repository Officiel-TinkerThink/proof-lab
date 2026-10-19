# SPECS: prove a feature works, with a receipt

A spec is a JSON file that says what a visitor does and what must be true afterwards. The runner drives a real
headless browser through it, records every check, and writes a signed **receipt** (a summary) and an **evidence file**
(the detail). An agent that says "done" without a PASS receipt for the current code has not shown anything.

```
node src/doctor.js  --key-file <key> [--spec specs/x.json]      is the setup sound?        exit 0 / 2
node src/run-spec.js --spec specs/x.json --key-file <key>       run it, write the receipt  exit 0 PASS / 1 FAIL / 2 ERROR / 3 PASS but needs review
node src/status.js  --spec specs/x.json --key-file <key>        can I say done?            exit 0 / 1 / 2 / 3
node src/show.js    --key-file <key> [--failures|--steps|...]   what happened in detail?
node src/look.js    --url <url> | --spec specs/x.json [--until N]   what does the page offer a spec? (no receipt, no key)
```

`node src/lab.js <run|status|doctor|show|look> ...` is the same set behind one entry point.

The key is read from a file only (`--key-file`, mode 0600 on Linux and macOS, at least 32 bytes). `PROOF_LAB_KEY` in the
environment is refused. Receipts go to `receipts/` unless `--receipts <dir>` or `PROOF_LAB_RECEIPTS` says otherwise.

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


Further detail on the same rule. Recognised credential shapes include `OAuth`, `Token` and `ApiKey` scheme values, vendor prefixes (AKIA/ASIA, GitHub, Slack, Stripe, `sk-`, AIza), JWTs (also after a hyphen), prefixed runs of 40 or more characters that contain a digit (a long run of letters only is kept, like a long word), and key names such as `pass`, `auth`, `sid`, `pw`, `otp`, `pin`, `authorization`, `passphrase` and `passcode`. A short name counts as a whole word, so `author` is kept but `DB_PASS`, `auth_mode` and `pass_count` are redacted (over-redaction is the safe direction); a key name keeps at most 200 more name characters before its value. A value never runs across a line break. A query in an address quoted inside any text (an error that names the URL it failed on) is hidden. A credential-named step records `(masked, N characters, hmac xxxxxxxx)` for strings, numbers and objects; booleans and null are kept, and the runner's own label `<op> completes` is not a value. The names of the data read (`key`, `attribute`, `property`, `path`) use the whole list; for `assertValue`, and `assertAttribute`/`assertProperty` on `value`, the control's `label`, `placeholder`, `testId`, `selector` or `name` counts only when it holds a strong word (password, secret, token, api key, credential, pw, otp), so a field called "Session name" is recorded. Addresses other than http(s) and `about:` are recorded as `scheme[hidden]` (`about:` keeps its path, never its query). The query, hash and token-like path segments of an address a spec expects (`assertUrl` `equals`/`contains`, a popup `url`, `app.start`) are hidden in the label as well as in the actual; a `matches` regular expression is kept as written, because its `?` and `#` are syntax. An object field whose key names a credential is hidden whole but keeps its shape (a list stays a list); a field called `__proto__` or `constructor` is recorded as data; a value nested deeper than 6 levels is flattened to a redacted JSON string, counted from each top-level field of the receipt or record. Console and page-error text over 50,000 characters is cut with a note of how many characters were dropped. The spec's name in `spec` (`name@hash`) is scrubbed once and the hash is appended afterwards, so a name such as `Session: idle` becomes `Session: [redacted]@hash` and `status` still finds its receipts. `look` lists storage key names as written (they are names, not values). A tab whose close is refused stays the current tab and the step fails; if the close never settles, the step is failed by its time limit and the run is on the tab it moved to.
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
| `spec`, `app`, `bug`, `revision`, `at` | Which spec (`name@hash`), where, any injected bug, the app revision seen, when |
| `totals` | `{checks, passed, failed, omitted}`. `omitted` counts failed checks not listed below (the first 20 are listed). |
| `checks` | **Failed checks only**: `{step, name, pass, expected, actual, hint?, error?}`, long values clipped to 200 characters |
| `review` | `{total, items}`: claims from `review` steps that need a human (the first 20 as `{step, name, note?}`). Receipts from before this field have none. |
| `evidence` | `{file, sha256, bytes}`: the evidence file next to the receipt, and its hash (covered by the signature) |
| `pageErrors` | Up to 10 page errors, clipped |
| `screenshot`, `error`, `next` | The final full-page screenshot; why the run is ERROR; what to do next |
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
