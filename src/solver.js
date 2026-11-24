/*
 * Deterministic re-plan solver for a cancelled rental. Pure functions, no DOM,
 * no network, no LLM calls. Given a cancellation and the inventory state it
 * searches the waitlist for feasible re-lets and returns ranked plans, explicit
 * reasons for every rejection, and hand-off items for human decisions.
 *
 * Loaded as a classic script so it also works from file://. Node tests read it
 * through module.exports; the browser reads it from globalThis.RentalSolver.
 */
(function () {
  'use strict';

  const { toDay, inputProblem } = typeof module !== 'undefined'
    ? require('./validation.js')
    : globalThis.RentalValidation;

  const BUFFER_DAYS = 1;

  // Rule check: a question matching a pattern goes to a human with the clause text.
  const HANDOFF_RULES = [
    { topic: 'refund', pattern: /\b(refund\w*|deposits?|money[\s-]back|reimburs\w*|repay\w*)\b/i, clauseId: 'CL-4.2' },
    {
      topic: 'cancellation fee',
      pattern: /\b(fees?|charges?|surcharges?|penalt(y|ies)|costs?|pay(s|ing|ment)?|paid|bill(s|ed|ing)?|price)\b/i,
      clauseId: 'CL-5.1',
    },
    { topic: 'contract question', pattern: /\b(contract\w*|clauses?|liab\w*|terms|agreement)\b/i, clauseId: 'CL-9.1' },
  ];

  const MISSING_CLAUSE = { title: 'Not on file', text: 'No clause text on file; check the contract.' };

  /**
   * True when two inclusive date ranges are closer than the buffer allows.
   * With bufferDays = 1, a booking ending on day 4 blocks day 5 but not day 6.
   */
  function overlapsWithBuffer(a, b, bufferDays) {
    return toDay(a.start) <= toDay(b.end) + bufferDays && toDay(b.start) <= toDay(a.end) + bufferDays;
  }

  function routeHandoffs(question, clauses) {
    const text = question == null ? '' : String(question).trim();
    if (!text) return [];
    const matched = HANDOFF_RULES.filter((rule) => rule.pattern.test(text));
    // Fail safe: a question no rule recognises still goes to a human, without a clause.
    if (matched.length === 0) {
      return [{ topic: 'unclassified question', reason: 'No rule matched. A human reads this question.', clause: null }];
    }
    return matched.map((rule) => {
      const clause = clauses[rule.clauseId] || MISSING_CLAUSE;
      return {
        topic: rule.topic,
        reason: `Matches the ${rule.topic} rule. Money and contract decisions go to a human.`,
        clause: { id: rule.clauseId, title: clause.title, text: clause.text },
      };
    });
  }

  function none(reason, handoffs) {
    return { outcome: 'none', reason, plans: [], rejected: [], handoffs };
  }

  // Released items first (they came back from the cancelled booking), then by id for stable output.
  function candidatesFor(kind, ctx) {
    const rank = (res) => (ctx.released.includes(res.id) ? 0 : 1);
    return ctx.resources
      .filter((res) => res.kind === kind)
      .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  }

  /** Returns a human-readable reason why an item cannot serve the request, or null if it can. */
  function blockingReason(res, request, ctx) {
    if (ctx.held.includes(res.id)) return `${res.id}: held by staff, not offered`;
    if (res.mount && res.mount !== request.mount) {
      return `${res.id}: mount ${res.mount} does not fit request mount ${request.mount}`;
    }
    if (res.status === 'maintenance') {
      if (res.maintenanceUntil == null) return `${res.id}: in maintenance with no return date, not offered`;
      if (toDay(res.maintenanceUntil) >= toDay(request.start)) {
        return `${res.id}: in maintenance until ${res.maintenanceUntil}, after pickup on ${request.start}`;
      }
    } else if (res.status !== 'ok') {
      return `${res.id}: unknown status "${String(res.status)}", not offered`;
    }
    const clash = ctx.active.find((b) => b.assigned.includes(res.id) && overlapsWithBuffer(request, b, ctx.bufferDays));
    if (clash) {
      return `${res.id}: booked as ${clash.id} (${clash.start} to ${clash.end}) inside the ${ctx.bufferDays}-day buffer`;
    }
    return null;
  }

  function describeShortfall({ kind, missing, notes }) {
    const detail = notes.length ? notes.join('; ') : `no ${kind} item in inventory`;
    return `Missing ${missing} x ${kind}: ${detail}`;
  }

  function evaluateRequest(request, position, ctx) {
    const actions = [];
    const shortfalls = [];
    const chosen = new Set();
    for (const need of request.needs) {
      const notes = [];
      let found = 0;
      for (const res of candidatesFor(need.kind, ctx)) {
        if (found >= need.count) break;
        const problem = chosen.has(res.id)
          ? `${res.id}: already assigned to this request`
          : blockingReason(res, request, ctx);
        if (problem) {
          notes.push(problem);
          continue;
        }
        chosen.add(res.id);
        actions.push({
          resourceId: res.id,
          label: res.label,
          kind: res.kind,
          source: ctx.released.includes(res.id) ? 'released' : 'free stock',
        });
        found += 1;
      }
      if (found < need.count) shortfalls.push({ kind: need.kind, missing: need.count - found, notes });
    }
    return { request, position, actions, shortfalls };
  }

  function buildPlan({ request, position, actions, shortfalls }, ctx) {
    const required = request.needs.reduce((sum, need) => sum + need.count, 0);
    const usedIds = actions.map((action) => action.resourceId);
    const unused = ctx.released.filter((id) => !usedIds.includes(id));
    const missing = shortfalls.map(describeShortfall);

    const checks = [
      `Availability: items must be free from ${request.start} to ${request.end} after active bookings`,
      'Status: only items with status ok or maintenance are considered; other statuses are not offered',
      'Maintenance: an item is blocked when its return date is missing or on or after pickup',
      `Buffer: ${ctx.bufferDays} day(s) must separate bookings on the same item`,
      `Kit compatibility: bodies and lenses must match mount ${request.mount}; mount-free items fit any mount`,
    ];
    if (ctx.held.length) checks.push(`Staff hold: not offered ${ctx.held.join(', ')}`);

    const open = [
      ...missing,
      ...(unused.length ? [`Released but not used: ${unused.join(', ')}`] : []),
      ...(missing.length ? ['Partial kit: client consent needed before confirming'] : []),
      ...ctx.handoffs.map((h) => `Human decision pending: ${h.topic}${h.clause ? ` (clause ${h.clause.id})` : ''}`),
    ];

    return {
      requestId: request.id,
      cancelledBookingId: ctx.cancelled.id,
      releasedIds: ctx.released,
      bufferDays: ctx.bufferDays,
      client: request.client,
      start: request.start,
      end: request.end,
      status: missing.length ? 'partial' : 'full',
      filled: actions.length,
      required,
      freeStockCount: actions.filter((action) => action.source === 'free stock').length,
      waitlistPosition: position,
      actions,
      checks,
      changes: [
        { client: ctx.cancelled.client, text: `Booking ${ctx.cancelled.id} cancelled; released ${ctx.released.join(', ')}` },
        { client: request.client, text: `Offered ${usedIds.join(', ') || 'nothing'} for ${request.start} to ${request.end}` },
        { client: 'Other clients', text: 'No existing booking is moved; only free items are offered' },
      ],
      missing,
      open,
    };
  }

  // Ranking: higher share of the requested items first (a full kit scores 1, so it beats any partial kit);
  // then fewer free-stock items (more released kit); then earlier waitlist position.
  function comparePlans(a, b) {
    return (b.filled / b.required) - (a.filled / a.required)
      || a.freeStockCount - b.freeStockCount
      || a.waitlistPosition - b.waitlistPosition;
  }

  function decide(plans, rejected, waitlistSize, handoffs) {
    if (plans.length === 0) {
      const why = waitlistSize === 0
        ? 'The waitlist is empty.'
        : rejected.map((r) => `${r.requestId}: ${r.reason}`).join(' | ');
      return { outcome: 'none', reason: `No feasible plan. ${why}`, plans, rejected, handoffs };
    }
    const [best] = plans;
    if (best.status === 'full') {
      return { outcome: 'full', reason: `Full re-plan: ${best.requestId} receives all requested kit.`, plans, rejected, handoffs };
    }
    return {
      outcome: 'partial',
      reason: `No full re-plan. Next-best: ${best.id} gives ${best.requestId} ${best.filled} of ${best.required} items. ${best.missing.join(' ')}`,
      plans,
      rejected,
      handoffs,
    };
  }

  // Items held back by staff are never offered: those of this cancellation and those kept by earlier cancellations.
  function makeContext(state, cancelled, released, bufferDays, handoffs) {
    const earlierHolds = state.bookings.filter((b) => b.status === 'cancelled').flatMap((b) => b.held ?? []);
    return {
      cancelled,
      released,
      held: [...cancelled.assigned.filter((id) => !released.includes(id)), ...earlierHolds],
      active: state.bookings.filter((b) => b.status !== 'cancelled' && b.id !== cancelled.id),
      resources: state.resources,
      bufferDays,
      handoffs,
    };
  }

  /**
   * Ranks re-plans for the waitlist after a cancellation.
   * @param {{resources: object[], bookings: object[], waitlist: object[], clauses: object}} state
   * @param {{bookingId: string, releasedIds: string[], question?: string}} cancellation
   *   releasedIds are the booking items the staff released; other items of the booking are held.
   * @param {number} [bufferDays]
   * @returns {{outcome: 'full'|'partial'|'none', reason: string, plans: object[], rejected: object[], handoffs: object[]}}
   */
  function solve(state, cancellation, bufferDays = BUFFER_DAYS) {
    const handoffs = routeHandoffs(cancellation.question, state.clauses);
    const problem = inputProblem(state);
    if (problem) return none(problem, handoffs);

    const cancelled = state.bookings.find((b) => b.id === cancellation.bookingId && b.status !== 'cancelled');
    if (!cancelled) return none(`No active booking ${cancellation.bookingId} to cancel.`, handoffs);

    const released = cancelled.assigned.filter((id) => cancellation.releasedIds.includes(id));
    if (released.length === 0) return none('No kit or studio released: every item of the booking is held.', handoffs);

    const ctx = makeContext(state, cancelled, released, bufferDays, handoffs);
    const evaluations = state.waitlist.map((request, position) => evaluateRequest(request, position, ctx));
    const plans = evaluations
      .filter((e) => e.actions.length > 0)
      .map((e) => buildPlan(e, ctx))
      .sort(comparePlans)
      .map((plan, index) => ({ id: `P${index + 1}`, ...plan }));
    const rejected = evaluations
      .filter((e) => e.actions.length === 0)
      .map((e) => ({
        requestId: e.request.id,
        client: e.request.client,
        reason: e.shortfalls.map(describeShortfall).join(' '),
      }));

    return decide(plans, rejected, state.waitlist.length, handoffs);
  }

  // Max-plus-one over the existing B-numbers, so a new booking id never collides with an existing one.
  function nextBookingId(bookings) {
    const numbers = bookings
      .map((b) => /^B-(\d+)$/.exec(b.id))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    return `B-${Math.max(1000, ...numbers) + 1}`;
  }

  /**
   * Returns a new state with the plan applied. The input state is not mutated.
   * Before anything changes, every action is re-checked against the current state;
   * if one is now blocked, the function throws and the input state is left as it was.
   * The cancelled booking is marked cancelled and keeps its held items as `held`,
   * the request leaves the waitlist, and a new booking holds the planned items.
   */
  function applyPlan(state, plan) {
    const original = state.bookings.find((b) => b.id === plan.cancelledBookingId && b.status !== 'cancelled');
    const request = state.waitlist.find((r) => r.id === plan.requestId);
    if (!original || !request) throw new Error(`Cannot apply ${plan.id}: booking or request not found`);

    const planned = plan.actions.map((action) => action.resourceId);
    const repeated = [...new Set(planned.filter((id, index) => planned.indexOf(id) !== index))];
    if (repeated.length) throw new Error(`Cannot apply ${plan.id}: duplicate item in the plan: ${repeated.join(', ')}`);

    const released = original.assigned.filter((id) => plan.releasedIds.includes(id));
    const ctx = makeContext(state, original, released, plan.bufferDays, []);
    const blocked = plan.actions
      .map((action) => {
        const res = state.resources.find((r) => r.id === action.resourceId);
        return res ? blockingReason(res, request, ctx) : `${action.resourceId}: not in inventory`;
      })
      .filter(Boolean);
    if (blocked.length) throw new Error(`Cannot apply ${plan.id}, the kit is no longer free: ${blocked.join('; ')}`);

    const next = structuredClone(state);
    const cancelled = next.bookings.find((b) => b.id === original.id);
    cancelled.status = 'cancelled';
    cancelled.held = original.assigned.filter((id) => !released.includes(id));
    next.waitlist = next.waitlist.filter((r) => r.id !== request.id);
    next.bookings.push({
      id: nextBookingId(state.bookings),
      client: request.client,
      start: request.start,
      end: request.end,
      mount: request.mount,
      status: plan.status === 'full' ? 'confirmed' : 'awaiting-client-consent',
      assigned: plan.actions.map((action) => action.resourceId),
    });
    return next;
  }

  const api = { BUFFER_DAYS, overlapsWithBuffer, routeHandoffs, solve, applyPlan };

  if (typeof module !== 'undefined') {
    module.exports = api;
  } else {
    globalThis.RentalSolver = api;
  }
})();
