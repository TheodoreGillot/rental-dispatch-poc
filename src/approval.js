/*
 * Pure helpers for the approve step: whether an approved plan is still the
 * fresh result, and the confirmation text. No DOM, so Node tests can cover them.
 *
 * Loaded as a classic script before app.js. Node tests read it through
 * module.exports; the browser reads it from globalThis.RentalApproval.
 */
(function () {
  'use strict';

  /** True when the approved plan is exactly the plan the fresh solve returns under the same id. */
  function isCurrentPlan(plan, solution) {
    const fresh = solution.plans.find((candidate) => candidate.id === plan.id);
    return fresh !== undefined && JSON.stringify(fresh) === JSON.stringify(plan);
  }

  /** Confirmation text after approval. A partial plan waits for the client before the booking is confirmed. */
  function approvalMessage(plan) {
    if (plan.status === 'full') {
      return `Approved ${plan.id}. Booking ${plan.cancelledBookingId} cancelled; ${plan.requestId} re-let as a new booking. Inventory updated below.`;
    }
    return `Approved ${plan.id} as a partial plan (${plan.filled} of ${plan.required} items). Booking ${plan.cancelledBookingId} cancelled. The client must consent before the booking is confirmed. Inventory updated below.`;
  }

  const api = { isCurrentPlan, approvalMessage };

  if (typeof module !== 'undefined') {
    module.exports = api;
  } else {
    globalThis.RentalApproval = api;
  }
})();
