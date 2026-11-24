/*
 * Date and range helpers shared by the store, selectors and solver.
 * Pure functions, no DOM and no clock reads.
 *
 * Loaded as a classic script before selectors.js. Node reads it through
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

  function isoFromDay(day) {
    if (!Number.isFinite(day)) return null;
    return new Date(day * DAY_MS).toISOString().slice(0, 10);
  }

  function addDays(isoDate, amount) {
    const day = toDay(isoDate);
    if (day === null || !Number.isFinite(amount)) return null;
    return isoFromDay(day + amount);
  }

  function daysBetween(start, end) {
    const a = toDay(start);
    const b = toDay(end);
    if (a === null || b === null) return null;
    return b - a;
  }

  /** Every real date from start to end inclusive, or [] for an invalid range. */
  function eachDay(start, end) {
    const a = toDay(start);
    const b = toDay(end);
    if (a === null || b === null || a > b) return [];
    const days = [];
    for (let day = a; day <= b; day += 1) days.push(isoFromDay(day));
    return days;
  }

  function rangeProblem(label, start, end) {
    if (toDay(start) === null) {
      return `${label} has an invalid start date "${String(start)}": expected a real YYYY-MM-DD date.`;
    }
    if (toDay(end) === null) {
      return `${label} has an invalid end date "${String(end)}": expected a real YYYY-MM-DD date.`;
    }
    if (toDay(start) > toDay(end)) {
      return `${label} ends on ${end}, before it starts on ${start}.`;
    }
    return null;
  }

  function rangesOverlap(aStart, aEnd, bStart, bEnd) {
    const a1 = toDay(aStart);
    const a2 = toDay(aEnd);
    const b1 = toDay(bStart);
    const b2 = toDay(bEnd);
    if ([a1, a2, b1, b2].some((day) => day === null)) return false;
    return a1 <= b2 && b1 <= a2;
  }

  /**
   * Validate a raw quantity field without coercing it. Used by the manual panel
   * so "2.5", "-3", "0" and "" stay visible as typed and are reported as errors
   * instead of becoming 1 or a truncated number.
   */
  function parseQuantityInput(raw) {
    const text = typeof raw === 'string' ? raw.trim() : raw === undefined || raw === null ? '' : String(raw).trim();
    if (!/^\d+$/.test(text)) {
      return { ok: false, quantity: null, error: 'Enter a whole number of 1 or more.' };
    }
    const quantity = Number(text);
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      return { ok: false, quantity: null, error: 'Enter a whole number of 1 or more.' };
    }
    return { ok: true, quantity, error: null };
  }

  const api = { DAY_MS, toDay, isoFromDay, addDays, daysBetween, eachDay, rangeProblem, rangesOverlap, parseQuantityInput };

  if (typeof module !== 'undefined') {
    module.exports = api;
  } else {
    globalThis.RentalValidation = api;
  }
})();
