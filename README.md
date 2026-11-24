# Atelier Lumière (fictional) dispatch console

A static, product-style demo for a fictional rental house. Staff cancel a
reservation, the deterministic solver searches the waitlist for a re-plan, and a
dispatcher approves or rejects the result. A rule-based assistant can take a
cancellation or availability request, restate it, ask for confirmation, and call
the same solver.

Everything is fictional: the house ("Atelier Lumière (fictional)"), the clients,
the kit, the clauses and the dates. There is no login, backend, network call,
analytics or LLM. The solver is deterministic code.

## Files

| Path | Purpose |
| --- | --- |
| `index.html` | App shell (sidebar/top navigation), five tabs, footer and scope card |
| `styles.css` | Design system, responsive shell, controls, tables, calendar and chat |
| `favicon.svg` | Page icon (a separate file because the CSP blocks data: URIs) |
| `src/data.js` | Fictional inventory, bookings, waitlist, overflow request, clauses, four scenarios |
| `src/validation.js` | Date, range and count checks (unchanged) |
| `src/solver.js` | Deterministic re-plan search, rule check, `applyPlan`, and the read-only `availabilityReport` helper |
| `src/approval.js` | Approve-step helpers (unchanged) |
| `src/summary.js` | Pure Dispatch card numbers: open reservations, capacity, re-plans |
| `src/tools.js` | Pure assistant tools that validate input and call the solver |
| `src/assistant.js` | Rule-based intent parsing, confirmation state machine and templated replies |
| `src/app.js` | UI wiring: tabs, views, Dispatch flow, assistant chat; textContent only |
| `tests/*.test.js` | Node built-in test runner: solver, validation, approval, tools, assistant, summary, static checks |

## Run

Open `index.html` in a browser. It works from `file://` because every script is a
classic script; all paths are relative, so it also works in a subdirectory.

Or serve the folder statically:

```sh
python3 -m http.server 8000
# then open the printed local address
```

## Test

Requires Node 18 or newer; there are no packages to install.

```sh
node --test
```

The suite covers the original solver, validation and approval behaviour plus the
new tools, assistant state machine, summary rules and static checks on the shipped
files.

## Screens

- **Dispatch** — three summary cards, then the original three-step flow (scenario
  cards, kit checklist, solve) and the results panel with approve/reject.
- **Calendar** — a month grid built from active bookings, with previous/next month
  and a selected-day list. Days with reservations show a count and the first id.
- **Equipment** — the resource table with id, kind, mount, a status badge
  (Available, Booked, Maintenance, Held) and the booking that holds it. Filter by
  kind.
- **Reservations** — bookings with id, client, dates, items and a status badge.
  Search and status filters. Assistant hand-off links focus the matching row.
- **Assistant** — chat with fixed suggestions, confirmation, collapsible solver
  calls and a hand-off link for no-plan cases.

Every data view has an empty state, a one-frame loading state and an error state
for failed tool calls or invalid input. Table headers are sticky on desktop, rows
have a hover state, and tables become labelled blocks on phones.

## Summary card rules

- **Open reservations:** bookings whose status is not `cancelled`.
- **Equipment at capacity:** a resource counts when its status is `maintenance`,
  or when it is assigned to an open booking whose inclusive date range contains
  the demo reference date, `2026-12-02` (the first pickup in the demo data). The
  rule lives in `src/summary.js` and does not depend on the viewer's clock.
- **Re-plans this session:** starts at 0 and increments for each user-initiated
  solve: the Dispatch **Solve re-plan** button and each assistant `solve_replan`
  call. It is session-only and resets on reload.

## Assistant

The assistant is rule-based: fixed regular expressions, a small confirmation
state machine and templates filled from tool output. It makes **0 LLM calls**.
`src/assistant.js` exports `LLM_CALLS = 0`; `src/app.js` writes that value into
the visible badges. No network API is present in the project.

### Intents

| Intent | Examples | Behaviour |
| --- | --- | --- |
| Cancel a reservation | "Cancel B-1001", "drop reservation B-1002", "cancel Client A" | Finds the reservation, restates what would be released and the re-plan step, then waits for "yes" |
| Availability / reschedule enquiry | "Is a camera available 2026-12-05 to 2026-12-07?", "reschedule B-1002 to 2026-12-14" | Parses kind, dates and optional mount, restates the check, then waits for "yes". It never moves a booking |
| General question | "What is the refund policy?", "hello" | Routes money/contract topics through the existing rule check to a human with the clause; otherwise explains the two supported actions |

No tool runs before an explicit confirmation. "No" stops the pending action.
A new request replaces a pending one without calling a tool. An unknown booking
id produces an error reply, not an exception.

### Tool interface

`src/tools.js` exports `createTools(getState)`, which returns these functions.
`getState` may be a state object or a function returning the current state.

```js
cancel_reservation(bookingId)
// -> { ok: true, bookingId, client, start, end, status,
//      releasedIds, released: [{ id, kind, label }], message }
// -> { ok: false, error }

solve_replan(bookingId, releasedIds)
// -> { ok: true, feasible, outcome, reason, moves, missing, handoffs,
//      solverMs, plan }
// -> { ok: false, error }
// moves is the best plan's actions, with planId, requestId, client, dates,
// resourceId, label, kind and source. moves is [] whenever feasible is false.

check_availability(resourceKind, start, end, mount = null)
// -> { ok: true, resourceKind, start, end, mount, bufferDays,
//      available: [ids], unavailable: [{ id, label, reason }], message }
// -> { ok: false, error }
```

`cancel_reservation` only validates; it does not mutate state. `solve_replan`
searches the waitlist requests whose dates overlap the cancelled booking, so the
answer matches the scenario the dispatcher is working. `check_availability`
reuses the solver's status, maintenance, buffer, mount and staff-hold rules. A
mount is checked only when supplied.

Every assistant reply that calls a tool renders a collapsed **Solver call**
`<details>` block containing the tool name, inputs and the structured output as
JSON inside a `<pre>` written with `textContent`.

### No feasible plan

When `solve_replan` returns `feasible: false`, the assistant says so, prints the
solver's reason, never lists a move, and adds a visible link to the reservation
in the Reservations tab. The hand-off sentence is:

> No feasible re-plan, so this goes to a human dispatcher. Open the reservation in the Reservations tab.

## Scenarios and demo scripts

The three original scenarios are unchanged:

1. **Happy path:** full 6/6 re-plan.
2. **Jury kit mix:** untick `LENS-Z-85`; full 4/4 using `LENS-Z-24` from free stock.
3. **Edge case:** partial 2/3 with the `CAM-Z-BK` maintenance reason and the
   refund hand-off to clause CL-4.2.

The fourth scenario is new:

4. **No plan hand-off:** Client I (`B-1000`) cancels an EF-mount body
   (`CAM-EF-01`). Client J (`W-2004`) needs a Z-mount camera for 2026-12-16 to
   2026-12-17. All three Z bodies are booked inside the 1-day buffer
   (`B-1004`, `B-1005`, `B-1003`), `CAM-Z-BK` is in maintenance until
   2026-12-20, and the released body has the wrong mount. The solver genuinely
   returns `outcome: "none"`; nothing is forced. `W-2004` lives in
   `overflowWaitlist` so the three original scenarios and their regression tests
   keep the same request set. The assistant searches both waitlist arrays.

Suggested demo paths:

- **(a) Normal reservation:** open **Reservations**, search `B-1001`, read the
  client, dates, items and Confirmed badge.
- **(b) Cancellation that re-plans:** in **Dispatch**, pick scenario 1 and solve,
  or ask the assistant to "Cancel B-1001" and confirm. The solver returns a full
  plan; nothing is applied until a dispatcher approves.
- **(c) Cancellation that cannot be re-planned:** in **Dispatch**, pick scenario 4
  and solve, or ask the assistant to "Cancel B-1000" and confirm. The result is
  `none`; the assistant links to the reservation for a human hand-off.

## Scope card

The footer button **About this demo** expands the scope card. The exact text is:

> Real: constraint check and re-plan search (deterministic code). Assistant: rule-based intent parsing and templated replies; 0 LLM calls. Faked: login, data, client messages, vendor integrations. Cut: billing, dashboards (except the summary cards on Dispatch), settings.

The cut list matches the build: there is no billing, no settings screen, and no
dashboard beyond the three Dispatch summary cards.

## Solver compatibility

- `src/solver.js` `solve` and `applyPlan` output and behaviour are unchanged.
- One named export was added: `availabilityReport(state, options)`. It reuses the
  same `blockingReason`, `candidatesFor` and date rules as `solve()` and is
  read-only. `src/tools.js` `check_availability` is its only caller.
- `src/validation.js` and `src/approval.js` are unchanged.

## Typography and layout

- One system sans stack; a system mono stack is used only for ids and JSON.
- Documented scale in `styles.css`: 12, 14, 16, 20, 28, 40 px.
- One accent colour (`#1d4ed8`); all other colours are neutrals.
- Sidebar at 1024 px and wider; below that the sidebar becomes an off-canvas menu
  toggled by the top-bar button. The Dispatch workspace is two columns from
  1152 px. Tables stack below 768 px so the page does not scroll sideways at
  375 px.
- All controls are styled: buttons, text/search inputs, selects (custom chevron),
  checkboxes (custom check), tables and badges. Every focusable element gets a
  visible focus ring.

## Accessibility

- One visible `h1` per view and ordered `h2`/`h3` beneath it.
- Tab buttons are real buttons with `aria-current="page"` on the active tab and
  arrow/Home/End focus movement. Switching tabs moves focus to the view heading.
- Icon-only menu button has an `aria-label`; the inline SVG mark is decorative.
- Results use an `aria-live` region; tool errors use `role="alert"`.
- The scope card receives focus when opened, returns focus to the footer button
  when closed, and closes with Escape.
- Tables stack into labelled blocks on phones; badges always carry a text label.

## Known limitations

- The assistant's cancel and re-plan tools are read-only. They show what a
  cancellation would release and what the solver returns; a dispatcher still
  applies the plan in Dispatch. The chat never edits the live inventory.
- The assistant searches requests that overlap the cancelled booking's dates,
  not every waitlist entry. This keeps it aligned with the scenario the
  dispatcher selected.
- Availability without a mount is physical availability across all mounts; the
  reply states the mount only when one was parsed.
- Approvals live in page memory; reloading resets the demo.
- Dates in the demo are fixed in December 2026. The calendar and capacity card
  use data-derived reference dates rather than the wall clock.
