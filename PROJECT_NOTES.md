# Project notes

Honest notes about the build. These are deliberately kept out of the product UI.
They are linked from `README.md` only.

## Scope card

The wording that used to sit in the UI, updated to match this build:

> Real: availability validation, reservation writes and deterministic re-plan search (plain code). Assistant: rule-based intent parsing, slot filling and templated replies; 0 LLM calls. Faked: login, data, client messages, vendor integrations. Cut: billing, dashboards (except the Home KPIs), settings.

## Model calls

**LLM calls per run: 0.** The assistant is rule-based: fixed patterns, a slot-filling
and confirmation state machine, and templates filled from tool output. There is no
model client, API key, network request or inference anywhere in the project.
`src/assistant.js` exports `LLM_CALLS = 0` for tests; the number is not shown in
the product UI.

## Faked components

- **Login.** There is no authentication or user account. The product opens straight
  into the workspace as a studio manager.
- **Data.** Equipment, customers and reservations are generated fixture data in
  `data/seed.json`; no real house, client or contract is described.
- **Client messages.** No email, SMS or portal message is sent. Cancellation and
  re-plan effects stay inside the page.
- **Vendor integrations.** No courier, payment, accounting or inventory vendor is
  connected.

## Cut

- **Billing and invoices.** No money is calculated or collected.
- **Dashboards.** Home has four KPIs, a needs-attention list, a workspace grid and
  an activity feed; there is no separate analytics screen.
- **Settings.** No preferences, roles, integrations or notification settings.

## Re-plan proposals

- Conflict proposals are **verified re-plan suggestions**. The solver tries a move
  for the latest-starting affected reservation (nearest free dates for its whole
  item set, up to 60 days), then equivalent-stock swaps, applying each candidate
  to a draft copy and re-checking the target conflict. It only calls a plan
  `feasible` when the target conflict actually disappears. If one action cannot
  clear it, it searches a bounded combination of up to three moves/swaps, then
  reports `partial` with the remaining overbooking or `none` for a human.
- The seed generator only creates deliberate conflicts that one move or swap
  clears, and asserts that at build time. `data/seed.json` is regenerated from it.
- Conflict proposal ids are versioned per attempt: the first is
  `RP-CF-<stockId>` and later attempts are `RP-CF-<stockId>-2`, `-3`, and so on.
  A decided card always renders the actions recorded in its operations event, not
  a freshly rebuilt plan. If the conflict is still open after a decision, the card
  is shown as unresolved and the next version is created so the conflict stays
  actionable. This covers both approve-remains and reject-remains cases.
- Cancellation proposals are truthful. A cancellation only claims a conflict when
  it freed the **same stock id** on dates that overlap that conflict. The actions
  are derived from the target conflict's verified plan. Identical actions are
  deduplicated across the inbox; a later cancellation that frees stock for an
  already-proposed plan is shown as covered rather than repeating the move. If the
  freed stock does not affect any open conflict, the card says so.
- Cancellation proposals use the same availability search after the freed stock
  is removed from the booking. The six most recent cancellations are considered,
  so the inbox stays an inbox rather than a full cancellation log.
- `solverMs` is measured with `performance.now()` (or `Date.now()` when absent).
  It is the real search time, not a fixture.
- Approval validates at **plan level**: it applies every action to a draft, then
  counts every stock id on every day across all blocking reservations, including
  the target reservation's own quantities. It refuses a plan that creates or
  worsens any overbooking or conflict, verifies the target conflict is gone, and
  only then commits. A refused approval changes nothing and returns a typed error.
  A rejected proposal also leaves every reservation untouched.

## Resetting the data

- Writes live in page memory and are lost on reload; the seed file is the source.
- To restore the committed fixtures, delete `data/seed.json` and run
  `node tools/generate-seed.js`.
- To regenerate a clean file in place, run `node tools/generate-seed.js`; the
  generator is deterministic and rewrites the file byte-identically.
- `store.reset()` restores the in-memory seed and appends a `store.reset` event;
  there is no reset control in the product UI.

## Runtime constraints

- Single static site, relative paths, hosted on GitHub Pages.
- No runtime dependencies, external fonts, images, scripts, tracking or network
  calls. The only request is `fetch('data/seed.json')`.
- No `innerHTML`; all dynamic nodes use `textContent` and `createElement`.
- The CSP is:
  `default-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'`.
- Opening `index.html` over `file://` blocks the seed fetch. Serve the folder with
  a static HTTP server; see `README.md`.

## Known limitations

- There is no server, so two browsers do not share edits and a reload loses them.
- The assistant is rule-based: fixed patterns, a slot-filling and confirmation
  state machine, and templates filled from tool output. It understands stock ids
  and examples such as "Book 2 × LGT-004 for Nordlys Film from 2026-12-10 to
  2026-12-12". It asks a clarifying question instead of guessing when a customer
  or item is ambiguous, and it rejects decimal or negative quantities rather than
  rounding them.
- The studio date is the fixed anchor in `data/seed.json` (`2026-11-24`), so KPIs
  stay reproducible instead of moving with the viewer's clock.
- Layout at 1280 px and 375 px, sticky headers and native focus appearance were
  verified from CSS only; no browser is installed in this environment.
