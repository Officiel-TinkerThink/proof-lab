# Feature map: waitlist

Spec: `specs/waitlist.json` (core), `specs/waitlist-strict.json` (core + no page errors).

## What exists

- One page at `/`: a form with an Email field and a "Join waitlist" button.
- A "Your local request" section: Request status (`data-testid=status`), Saved email (`data-testid=email`), and a live region (`role=status`) with the confirmation.
- State lives in the browser only: `localStorage` key `waitlist-record`, value `{status, email}`.

## How a visitor gets there

Open the app root. A fresh visitor sees status `none`, email `—`, no confirmation.

## How to drive it

| Intent | Op |
|---|---|
| Type the address | `fill` with `label: "Email"` |
| Submit | `click` role button "Join waitlist" (or `press` Enter in the field) |
| Wait for the result | `waitFor` the status element to contain `waitlisted` |
| Prove it persists | `reload`, then assert again |
| Prove what was stored | `assertStorage` key `waitlist-record`, path `email` |

## What usually lies

| Symptom | Real cause | Check that catches it |
|---|---|---|
| Page shows waitlisted, gone after reload | Value kept in memory only | `status survives reload`, `record is in localStorage` |
| Shows the right email, stores another | Value transformed before saving | `record is in localStorage` (path `email`) |
| Shows "confirmed" instead of "waitlisted" | Wrong status written | `status shows waitlisted after join` |
| Confirmation text missing | Message not rendered | `confirmation shows after join` |
| Works but the console is red | Error thrown after submit | `no page errors` (strict spec only) |

Known sabotage builds for testing the specs: `app.bug` = `no-persist`, `lost-confirmation`, `wrong-email`, `wrong-status`, `console-error`.

## Not covered (needs human review)

Visual design, copy tone, accessibility beyond role and label lookups.
