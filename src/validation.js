/*
 * Input checks for the solver: real calendar dates, inclusive ranges that do not
 * end before they start, and positive integer counts. Pure functions, no DOM.
 *
 * Loaded as a classic script before solver.js. Node reads it through
 * module.exports; the browser reads it from globalThis.RentalValidation.
 */
(function () {
  'use strict';

  const DAY_MS = 24 * 60 * 60 * 1000;
  const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

  /** Epoch day for a real calendar date written as YYYY-MM-DD, or null. */
  function toDay(isoDate) {
    const match = typeof isoDate === 'string' ? ISO_DATE.exec(isoDate) : null;
    if (!match) return null;
    const [year, month, day] = match.slice(1).map(Number);
    const ms = Date.UTC(year, month - 1, day);
    const date = new Date(ms);
    const isReal = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
    return isReal ? ms / DAY_MS : null;
  }

  function badDate(label, field, value) {
    return `${label} has an invalid ${field} date "${String(value)}": expected a real YYYY-MM-DD date.`;
  }

  /** Problem with an inclusive range (real dates, end not before start), or null. */
  function rangeProblem(label, start, end) {
    if (toDay(start) === null) return badDate(label, 'start', start);
    if (toDay(end) === null) return badDate(label, 'end', end);
    return toDay(start) > toDay(end) ? `${label} ends on ${end}, before it starts on ${start}.` : null;
  }

  /** Problem with a request's needs: at least one need, each with a positive integer count. */
  function needsProblem(request) {
    if (!Array.isArray(request.needs) || request.needs.length === 0) {
      return `Request ${request.id} has no items requested.`;
    }
    for (const need of request.needs) {
      if (need.count === 0) return `Request ${request.id} asks for 0 x ${need.kind}: no items requested.`;
      if (!Number.isInteger(need.count) || need.count < 1) {
        return `Request ${request.id} asks for ${String(need.count)} x ${need.kind}: the count must be a positive integer.`;
      }
    }
    return null;
  }

  /**
   * First problem with the dates, ranges or counts the solver reads, or null.
   * Every booking, request and maintenance return date is checked, so no bad value reaches the solver.
   */
  function inputProblem(state) {
    const problems = [
      ...state.resources
        .filter((res) => res.maintenanceUntil != null && toDay(res.maintenanceUntil) === null)
        .map((res) => badDate(`Resource ${res.id}`, 'maintenanceUntil', res.maintenanceUntil)),
      ...state.bookings.map((b) => rangeProblem(`Booking ${b.id}`, b.start, b.end)),
      ...state.waitlist.map((r) => rangeProblem(`Request ${r.id}`, r.start, r.end) || needsProblem(r)),
    ];
    return problems.find(Boolean) ?? null;
  }

  const api = { toDay, inputProblem };

  if (typeof module !== 'undefined') {
    module.exports = api;
  } else {
    globalThis.RentalValidation = api;
  }
})();
