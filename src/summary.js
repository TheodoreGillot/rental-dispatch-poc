/*
 * Summary numbers for the Dispatch cards. Pure functions, no DOM.
 *
 * Capacity rule (also documented in the README): a resource is at capacity when
 * its status is "maintenance", or when it is assigned to an active (not cancelled)
 * booking whose inclusive range contains the demo reference date. The reference
 * date is the first pickup in the demo data, 2026-12-02, so the number does not
 * change with the wall clock or the timezone of the machine opening the page.
 *
 * Loaded as a classic script before app.js. Node tests read it through module.exports.
 */
(function () {
  'use strict';

  const { toDay } = typeof module !== 'undefined'
    ? require('./validation.js')
    : globalThis.RentalValidation;

  const DEMO_REFERENCE_DATE = '2026-12-02';

  /** A reservation counts as open until it is cancelled. */
  function isOpen(booking) {
    return booking.status !== 'cancelled';
  }

  function openReservations(state) {
    return state.bookings.filter(isOpen).length;
  }

  /** Resources in maintenance or held by an open booking on the reference date. */
  function equipmentAtCapacity(state, referenceDate = DEMO_REFERENCE_DATE) {
    const reference = toDay(referenceDate);
    if (reference === null) return [];
    const open = state.bookings.filter(isOpen);
    return state.resources.filter((res) => {
      if (res.status === 'maintenance') return true;
      return open.some((booking) => booking.assigned.includes(res.id)
        && toDay(booking.start) !== null
        && toDay(booking.end) !== null
        && toDay(booking.start) <= reference
        && reference <= toDay(booking.end));
    });
  }

  function summaryStats(state, replansRun = 0, referenceDate = DEMO_REFERENCE_DATE) {
    return {
      openReservations: openReservations(state),
      equipmentAtCapacity: equipmentAtCapacity(state, referenceDate).length,
      replansRun,
    };
  }

  const api = { DEMO_REFERENCE_DATE, isOpen, openReservations, equipmentAtCapacity, summaryStats };

  if (typeof module !== 'undefined') {
    module.exports = api;
  } else {
    globalThis.RentalSummary = api;
  }
})();
