# Rental re-plan demo (fictional)

A static proof of concept for a university pitch. A rental house's operations
staff cancel a rental; the app searches the waitlist for a re-let of the freed
kit and studio slot, staff approve or reject, and questions about money or
contracts go to a human.

Everything is fictional: the house ("Atelier Lumière (fictional)"), the clients
("Client A (fictional)" and so on), the kit, the clauses and the dates. There is
no login, no backend, no network call at runtime, no API key and no LLM. The
solver is deterministic code.

## Files

| Path | Purpose |
| --- | --- |
| `index.html` | Demo page: scope card, scenario picker, kit selection, ranked plans, approve/reject, hand-off panel, timing |
| `styles.css` | Layout (phone width first, 16px gutters) |
| `src/data.js` | Fictional inventory, studio slots, bookings, waitlist, maintenance status, clauses, scenarios |
| `src/validation.js` | Input checks: real YYYY-MM-DD dates, ranges that do not end before they start, positive integer counts (no DOM) |
| `src/solver.js` | Pure re-plan search, rule check for hand-offs, and `applyPlan` (no DOM) |
| `src/approval.js` | Pure approve-step helpers: is the approved plan still the fresh result, and the confirmation text |
| `src/app.js` | UI wiring; renders plans with `textContent` only |
| `tests/*.test.js` | Node built-in test runner tests: solver, validation, approval, and static checks on the shipped files |

## Run

Open `index.html` in a browser. No server is needed; it works from `file://`.

Or serve the folder statically, for example:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

The page is also safe to host in a subdirectory: all paths are relative.

## Test

Requires Node 18 or newer (developed on Node 26; no packages to install).

```sh
node --test
```

The tests cover the happy path, buffer and maintenance boundaries, no-candidate
and maintenance failure modes, input validation (dates, ranges, counts, empty
needs), duplicate-kind needs, booking ids, staff-held kit, ranking, hand-off
routing, `applyPlan` (including its re-check), the approve guard, and the CSP
and banned-API checks.

## Deploy (GitHub Pages)

1. Push this folder's contents to the `main` branch of a GitHub repository.
2. In the repository settings, open Pages, choose "Deploy from a branch",
   select `main` and the `/ (root)` folder, and save.
3. The site is served at `https://<user>.github.io/<repo>/`. No build step.

## How the solver works

- **Input:** the cancelled booking, the released items (the rest of the booking's items are held by staff), the active bookings, the waitlist, and the clauses.
- **Input validation:** every booking start and end, request start and end, and maintenance return date must be a real YYYY-MM-DD date; ranges must not end before they start; each need must have a positive integer count; a request needs at least one need. Any failure returns `outcome: 'none'` with a reason that names the field and the value. Nothing is treated as free.
- **Constraints per candidate item:**
  - *Kit compatibility:* bodies and lenses must match the request mount; mount-free items (lights, audio, studio slots) fit any mount.
  - *Status:* only `ok` and `maintenance` items are considered; any other status is unavailable.
  - *Maintenance:* an item is blocked when its return date is missing or on or after the pickup day.
  - *Availability with buffer:* the item must have no active booking within 1 day of the requested range (one full day must separate bookings).
  - *Staff hold:* items not released are never offered, including items held by an earlier cancellation (stored as `held` on that cancelled booking).
  - *One item per request:* an item is assigned at most once per request, even when two needs name the same kind.
- **Ranking:** a higher share of the requested items first (a full kit scores 100%, so full beats partial); then fewer free-stock items (more released kit); then earlier waitlist position.
- **Approve guard:** before applying, the app re-runs the solver with the kit currently ticked and refuses unless the approved plan is identical to the fresh result. Changing a kit tick hides the results until the user solves again.
- **Apply re-check:** `applyPlan` re-runs the same blocking checks for every action against the current state. If one is now blocked, it throws and the input state is unchanged. The new booking id is max-plus-one over the existing B-numbers.
- **Held kit:** after an approval, the cancelled booking keeps the items staff held back as `held`, so they are not offered as free stock later. Released items the plan did not use become free stock.
- **Output:** every plan lists the actions, the constraints checked, what changes for which client, and what is left open. A rejected request carries its reason. If nothing works, the result is `outcome: 'none'` with the reason.
- **Hand-off rule check:** any non-empty client question goes to a human hand-off. A question matching a rule gets that topic and its clause text. Matching is case-insensitive and by whole word, and covers the inflected forms below:
  - *Refund topic (clause CL-4.2):* `refund` and any word starting with `refund` (refunds, refunded); `deposit` and `deposits`; `money back` or `money-back`; any word starting with `reimburs`; any word starting with `repay`.
  - *Cancellation fee topic (clause CL-5.1):* `fee`, `fees`, `charge`, `charges`, `surcharge`, `surcharges`, `penalty`, `penalties`, `cost`, `costs`, `pay`, `pays`, `paying`, `payment`, `paid`, `bill`, `bills`, `billed`, `billing`, `price`.
  - *Contract question topic (clause CL-9.1):* `contract` and any word starting with `contract`; `clause` and `clauses`; `liable` and any word starting with `liab` (liability, liabilities); `terms`; `agreement`.

  A question matching none of these gets a general "unclassified question" hand-off with no clause. The solver never decides money or contract questions.

## Scope card

- **Real:** the constraint check and re-plan search on the mock data.
- **Wrapper:** the staff UI.
- **Faked:** login, data, client messages (templated), vendor integrations. The AI: none in this PoC.
- **Cut:** billing, dashboards, settings.

## Known limitations

- Single location, one buffer value (1 day), and a single maintenance rule.
- Needs of the same kind in one request draw distinct items, but the solver has no preference between them beyond the released-first and id order.
- Client messages come from a fixed template and are never sent.
- Approvals are kept in memory for the page session: the next solve starts from the approved inventory. Reloading the page resets the demo.
- Hand-off topics are keyword rules. They only pick the clause to attach; every question still goes to a human, so a missed keyword cannot hide a question.
- A request that fails input validation fails the whole solve, so one bad request blocks the others until it is fixed.
- Scripts are classic (non-module) scripts so `file://` works; each file is wrapped in an IIFE. The browser gets one namespace per file (`RentalData`, `RentalSolver`). ES modules were avoided because browsers block module scripts from `file://`.
- Requires a modern browser with `structuredClone` (Chrome 98+, Firefox 94+, Safari 15.4+).
- Not tested in a real browser in this environment; the page was checked by static review and by running the solver and helpers in Node.
- The Content-Security-Policy is `default-src 'self'; base-uri 'none'; form-action 'none'`; there are no inline scripts or styles. Behaviour of `'self'` for `file://` pages depends on the browser and should be checked when the demo is first opened.
