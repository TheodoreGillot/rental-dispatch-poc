# Atelier Lumière · Studio back office

A single static site for a rental studio's operations team. Home shows the day,
Calendar and Reservations show the bookings, Equipment shows stock and
maintenance, Operations is a re-plan inbox, and Assistant takes booking requests.
One in-memory store feeds every view, and every write updates all of them at once.

The app is served from GitHub Pages with relative paths. There are no runtime
dependencies, external fonts, images, scripts, tracking or network calls. The only
request is `fetch('data/seed.json')`.

Honest notes on what is real, faked, cut and how to reset the data live in
[PROJECT_NOTES.md](PROJECT_NOTES.md). They are linked here only and are not part
of the product UI.

## Run

Serving over HTTP is required because the page fetches the seed file. Opening
`index.html` from `file://` blocks that request and the app shows an error state.

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

GitHub Pages serves the same files from the repository root.

## Test

Requires Node 18 or newer; nothing to install.

```sh
node --test
```

The suite covers the seed generator, store writes and notifications, selectors,
solver, proposals, assistant tools, assistant flows, manual-panel logic, acceptance
paths A–D and static project checks.

## Data

`data/seed.json` holds 150 equipment lines, 60 customers and 300 reservations
spanning two months back and four months ahead of the fixed studio date
(`2026-11-24`). It includes five deliberate stock conflicts and recent
cancellations, so Operations has real work on first load. Every deliberate
conflict is placed where a single move or swap can clear it; the generator
asserts this at build time.

`node tools/generate-seed.js` rewrites the file byte-identically using a fixed
mulberry32 seed. A test compares the committed bytes with the generator output.

## Architecture

| Path | Purpose |
| --- | --- |
| `index.html` | Shell, six views, manual panel, toast, CSP |
| `styles.css` | Design system, responsive shell, tables, calendar, chat, panel |
| `favicon.svg` | Logo mark |
| `src/validation.js` | Real-date checks, inclusive ranges, day arithmetic |
| `src/selectors.js` | Pure read models: KPIs, conflicts, calendar, matrix, lists, activity |
| `src/solver.js` | Availability-based move/swap search and cancellation search |
| `src/proposals.js` | Deterministic re-plan inbox, plan validation and apply |
| `src/store.js` | One store, subscriptions, validated writes, operations events |
| `src/assistant-tools.js` | Four read tools and two store-backed write tools |
| `src/assistant.js` | Rule-based parsing, clarification, confirmation, templates |
| `src/app.js` | UI rendering, store subscription, toast, manual panel, chat |
| `tools/generate-seed.js` | Deterministic seed generator |
| `tools/checks.js` | Acceptance checks A–E with printed numbers |

The store is `{ equipment, customers, reservations, events }`. It exposes
`subscribe`, `getState`, `commitReservation`, `cancelReservation`,
`approveProposal`, `rejectProposal` and `reset`. Every successful write updates
the state once, appends one operations event and notifies each subscriber exactly
once. Views never keep a copy.

Selectors used by views and tests include `kpis`, `needsAttention`,
`calendarMonth`, `matrixCell`, `reservationsFor`, `activityFeed`, `conflicts` and
`checkItems`. `checkItems` is the shared availability helper behind the manual
panel, the assistant's check tool and store validation.

## Assistant tools

`src/assistant-tools.js` exports `createAssistantTools({ store })`:

```js
check_availability({ start, end, items: [{ stockId, quantity }] })
// -> { ok, feasible, start, end, items: [{ stockId, name, category,
//      requested, available, short, reason, alternatives }],
//      alternatives: { dates: [{ start, end, shift }], items: [] }, message }
// -> { ok: false, code: 'validation', error }

create_reservation({ customerId, start, end, items })
// -> { ok, reservation, view, message }
// -> { ok: false, code: 'validation'|'unavailable', error, alternatives }

cancel_reservation(id)
// -> { ok, reservation, freedItems, proposals: [{ id, status, feasibility }], message }
// -> { ok: false, code, error }

get_reservation(id)
// -> { ok, reservation } | { ok: false, code: 'not_found', error }

get_customer(query)
get_item(query)
// -> { ok, query, found, matches, message }
```

The assistant calls these tools only. It never mutates state and never invents
availability: every number in a reply comes from a tool result. It is rule-based
(fixed patterns and a slot-filling state machine, 0 LLM calls), not a model.

## Proposals and approval

- A conflict plan is only `feasible` after its moves/swaps are applied to a draft
  and the target conflict is re-checked and gone. Otherwise the solver tries a
  bounded combination of up to three actions, then reports `partial` with the
  remaining overbooking or `none` for a human.
- Conflict proposal ids are versioned per attempt (`RP-CF-LGT-004-2`). A decided
  card renders its recorded actions. If the conflict is still open, the card is
  marked unresolved and a new version is built.
- A cancellation proposal only claims a conflict on the same stock id with
  overlapping dates, and identical actions are deduplicated across the inbox.
- Approval applies the whole plan to a draft, counts every stock id on every day
  (including the target reservation's own quantities), refuses new or worsened
  overbooking or conflict, verifies the target conflict is gone, and only then
  commits. A failed check returns a typed error and changes nothing.

## Checks

Run the acceptance checks (paths A–D plus the solver median for E) with real
numbers printed:

```sh
node tools/checks.js
```

Solver time for check E is the `solverMs` of the first pending proposal built
from the seed state, sampled 200 times with the median reported.

## Design

- One system sans stack; system mono only for ids and tool JSON.
- Type scale: 12, 14, 16, 20, 28, 40 px.
- One accent (`#1d4ed8`) and neutral greys.
- Sidebar from 1024 px; off-canvas menu below that. Six views.
- Sticky table headers with sortable columns; labelled stacked rows below 768 px.
- The manual panel is a labelled dialog with a visible close control, Escape to
  close and focus returned to the opener.
- Custom controls, visible focus rings, `aria-label` on icon-only buttons,
  `aria-sort` on sortable headers and `aria-live` for the toast and chat.

## Known limitations

- No backend: edits live in page memory and reload resets them.
- No browser is installed in this environment, so layout at 1280 px and 375 px,
  sticky-header behaviour, paint timing and native focus appearance were verified
  from CSS only, not by rendering.
- The assistant understands fixed patterns and asks for clarification rather
  than guessing.
