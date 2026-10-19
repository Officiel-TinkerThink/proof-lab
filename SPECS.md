# SPECS: prove a feature works, with a receipt

A spec is a JSON file that says what a visitor does and what must be true afterwards. The runner drives a real
headless browser through it, records every check, and writes a signed **receipt** (a summary) and an **evidence file**
(the detail). An agent that says "done" without a PASS receipt for the current code has not shown anything.

```
node src/doctor.js  --key-file <key> [--spec specs/x.json]      is the setup sound?        exit 0 / 2
node src/run-spec.js --spec specs/x.json --key-file <key>       run it, write the receipt  exit 0 PASS / 1 FAIL / 2 ERROR
node src/status.js  --spec specs/x.json --key-file <key>        can I say done?            exit 0 / 1 / 2
node src/show.js    --key-file <key> [--failures|--steps|...]   what happened in detail?
```

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

### Operations (34)

| Op | Fields | Notes |
|---|---|---|
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

## Fixtures

The built-in server serves pages and endpoints so every op has something real to run against. Local use only (it binds
127.0.0.1 and answers only `127.0.0.1` and `localhost`).

Pages (`/fixtures/<name>.html`): `forms` (every input type, validation, submit, reset), `interact` (click variants,
hover, keys, focus order, drag, scroll), `timing` (delays, debounce, lazy elements), `nav` and `nav-b` (links, history,
hash and query routes, popups), `frames` (iframes, open and closed shadow DOM), `dialogs` (alert, confirm, prompt,
download, file input, clipboard, geolocation, notifications), `storage` (cookies, local/session storage, IndexedDB,
locale, time zone, colour scheme), `network` (fetch, slow, failing, console and page errors), `a11y` and `a11y-bad`.

Endpoints: `/api/items`, `/api/echo`, `/api/slow?ms=`, `/api/status/<code>`, `/api/redirect?to=`, `/api/cookie?value=`,
`/api/count` (POST needs the `X-Proof-Lab` header), `/download/hello.txt`, `/__revision[?path=/fixtures/<page>]`.

## Limits worth knowing

- One revision per receipt: the page the run opened first. A change to a page reached later is not detected.
- A closed shadow root cannot be reached by any locator.
- `back` and `forward` cannot tell "no history" from a same-document move; assert the URL.
- `assertText` reads rendered text. `assertAttribute` or `assertProperty` read the source value.
- Not yet covered: dialogs, downloads, popups and tabs as step expectations, network mocking, viewport and locale
  emulation, accessibility audits, and visual comparison. See the roadmap in the commit history.
