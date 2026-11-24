/*
 * Tool interface for the rule-based assistant. Every function is read-only and
 * deterministic: it validates its arguments, reads the demo state, and calls the
 * existing solver. Nothing is sent over a network and no LLM is involved.
 *
 * createTools(getState) returns the three tools with the signatures the assistant
 * uses. Pass a state object or a function that returns the current state.
 *
 * Loaded as a classic script before assistant.js and app.js. Node tests read it
 * through module.exports.
 */
(function () {
  'use strict';

  const solver = typeof module !== 'undefined'
    ? require('./solver.js')
    : globalThis.RentalSolver;

  const { toDay } = typeof module !== 'undefined'
    ? require('./validation.js')
    : globalThis.RentalValidation;

  const now = typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

  function error(message) {
    return { ok: false, error: message };
  }

  function readState(getState) {
    const state = typeof getState === 'function' ? getState() : getState;
    if (!state || !Array.isArray(state.bookings) || !Array.isArray(state.resources)) {
      throw new Error('Tool state must include resources and bookings arrays.');
    }
    return state;
  }

  function findActiveBooking(state, bookingId) {
    if (typeof bookingId !== 'string' || bookingId.trim() === '') {
      return { error: 'A reservation id is required, for example B-1001.' };
    }
    const id = bookingId.trim();
    const booking = state.bookings.find((candidate) => candidate.id === id);
    if (!booking) return { error: `No reservation ${id} exists.` };
    if (booking.status === 'cancelled') return { error: `Reservation ${id} is already cancelled.` };
    return { booking };
  }

  function createTools(stateOrGetter) {
    readState(stateOrGetter); // fail fast if the caller wired the state wrongly
    const getState = typeof stateOrGetter === 'function' ? stateOrGetter : () => stateOrGetter;

    // Assistant policy: only clients waiting for dates that overlap the cancelled
    // booking are re-planned. Requests with invalid dates are kept so the solver
    // can report the validation error rather than silently ignoring them.
    function overlapsBooking(request, booking) {
      const requestStart = toDay(request.start);
      const requestEnd = toDay(request.end);
      const bookingStart = toDay(booking.start);
      const bookingEnd = toDay(booking.end);
      if ([requestStart, requestEnd, bookingStart, bookingEnd].some((day) => day === null)) return true;
      return requestStart <= bookingEnd && bookingStart <= requestEnd;
    }

    /**
     * Validate that a reservation can be cancelled and return what it would release.
     * Does not change the state.
     */
    function cancel_reservation(bookingId) {
      const state = readState(getState);
      const found = findActiveBooking(state, bookingId);
      if (found.error) return error(found.error);
      const { booking } = found;
      if (!Array.isArray(booking.assigned) || booking.assigned.length === 0) {
        return error(`Reservation ${booking.id} has no items to release.`);
      }
      const released = booking.assigned.map((id) => {
        const res = state.resources.find((candidate) => candidate.id === id);
        return res
          ? { id: res.id, kind: res.kind, label: res.label }
          : { id, kind: null, label: 'Unknown item' };
      });
      return {
        ok: true,
        bookingId: booking.id,
        client: booking.client,
        start: booking.start,
        end: booking.end,
        status: booking.status,
        releasedIds: [...booking.assigned],
        released,
        message: `Reservation ${booking.id} can be cancelled; ${released.length} item(s) would be released.`,
      };
    }

    /**
     * Run the deterministic re-plan search for a cancellation.
     * moves is the best plan's actions, and is always empty when feasible is false.
     */
    function solve_replan(bookingId, releasedIds) {
      const state = readState(getState);
      const found = findActiveBooking(state, bookingId);
      if (found.error) return error(found.error);
      const { booking } = found;
      if (!Array.isArray(releasedIds)) return error('releasedIds must be an array of item ids.');
      const unique = [...new Set(releasedIds)];
      if (unique.some((id) => typeof id !== 'string')) return error('Every released id must be a string.');
      const outside = unique.filter((id) => !booking.assigned.includes(id));
      if (outside.length) {
        return error(`Not part of reservation ${booking.id}: ${outside.join(', ')}.`);
      }

      const started = now();
      let solution;
      try {
        const waitlist = (state.waitlist || []).filter((request) => overlapsBooking(request, booking));
        solution = solver.solve({ ...state, waitlist }, {
          bookingId: booking.id,
          releasedIds: unique,
          question: '',
        });
      } catch (caught) {
        return error(`The solver failed: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
      const solverMs = now() - started;
      const feasible = solution.outcome !== 'none';
      const best = feasible ? solution.plans[0] : null;
      const moves = feasible && best
        ? best.actions.map((action) => ({
          planId: best.id,
          requestId: best.requestId,
          client: best.client,
          start: best.start,
          end: best.end,
          planStatus: best.status,
          resourceId: action.resourceId,
          label: action.label,
          kind: action.kind,
          source: action.source,
        }))
        : [];
      const missing = feasible && best
        ? [...best.missing]
        : solution.rejected.map((rejected) => `${rejected.requestId}: ${rejected.reason}`);

      return {
        ok: true,
        feasible,
        outcome: solution.outcome,
        reason: solution.reason,
        moves,
        missing,
        handoffs: solution.handoffs,
        solverMs,
        plan: best
          ? {
            id: best.id,
            requestId: best.requestId,
            client: best.client,
            status: best.status,
            filled: best.filled,
            required: best.required,
            start: best.start,
            end: best.end,
          }
          : null,
      };
    }

    /**
     * Availability for one kind over a range, from solver.availabilityReport().
     * The optional mount is checked only when supplied.
     */
    function check_availability(resourceKind, start, end, mount = null) {
      const state = readState(getState);
      const report = solver.availabilityReport(state, {
        kind: resourceKind,
        start,
        end,
        mount,
      });
      if (!report.ok) return report;
      const label = report.resourceKind;
      const message = report.available.length
        ? `${report.available.length} ${label} item(s) are free from ${start} to ${end}: ${report.available.join(', ')}.`
        : `No ${label} item is free from ${start} to ${end}.`;
      return { ...report, message };
    }

    return { cancel_reservation, solve_replan, check_availability };
  }

  const api = { createTools };

  if (typeof module !== 'undefined') {
    module.exports = api;
  } else {
    globalThis.RentalTools = api;
  }
})();
