/*
 * Tools exposed to the rule-based assistant. Reads go through selectors; writes
 * go through the store (commitReservation / cancelReservation). The assistant
 * never touches state directly and never invents availability.
 *
 * Loaded as a classic script after store.js, before assistant.js.
 */
(function () {
  'use strict';

  const selectors = typeof module !== 'undefined'
    ? require('./selectors.js')
    : globalThis.RentalSelectors;

  const proposals = typeof module !== 'undefined'
    ? require('./proposals.js')
    : globalThis.RentalProposals;

  function createAssistantTools(deps = {}) {
    const store = deps.store;
    if (!store || typeof store.getState !== 'function') {
      throw new Error('createAssistantTools needs a store with getState().');
    }

    function state() {
      return store.getState();
    }

    function normaliseItems(items) {
      if (!Array.isArray(items) || items.length === 0) {
        return { error: 'Pass items as [{ stockId, quantity }].' };
      }
      const rows = [];
      const seen = new Set();
      for (const item of items) {
        if (!item || typeof item.stockId !== 'string' || !item.stockId.trim()) {
          return { error: 'Every item needs a stockId.' };
        }
        const stockId = item.stockId.trim();
        if (seen.has(stockId)) return { error: `List ${stockId} once and give it a single quantity.` };
        if (!Number.isInteger(item.quantity) || item.quantity < 1) {
          return { error: `Quantity for ${stockId} must be a whole number of 1 or more.` };
        }
        seen.add(stockId);
        rows.push({ stockId, quantity: item.quantity });
      }
      return { rows };
    }

    function checkAvailability(input = {}) {
      const { start, end, items } = input;
      const normalised = normaliseItems(items);
      if (normalised.error) return { ok: false, code: 'validation', error: normalised.error };
      const check = selectors.checkItems(state(), { start, end, items: normalised.rows });
      if (!check.ok) return { ok: false, code: 'validation', error: check.error };
      const short = check.items.filter((item) => item.short > 0);
      const message = check.feasible
        ? `All ${check.items.length} item line(s) are available from ${start} to ${end}.`
        : `${short.length} item line(s) are short from ${start} to ${end}: ${short.map((item) => `${item.stockId} (${item.available} of ${item.requested})`).join(', ')}.`;
      return {
        ok: true,
        feasible: check.feasible,
        start,
        end,
        items: check.items.map((item) => ({
          stockId: item.stockId,
          name: item.name,
          category: item.category,
          requested: item.requested,
          available: item.available,
          short: item.short,
          reason: item.reason,
          alternatives: item.alternatives,
        })),
        alternatives: check.alternatives,
        message,
      };
    }

    function createReservation(input = {}) {
      const result = store.commitReservation({
        customerId: input.customerId,
        start: input.start,
        end: input.end,
        items: input.items,
      });
      if (!result.ok) {
        return {
          ok: false,
          code: result.code || 'validation',
          error: result.error,
          alternatives: result.alternatives || result.check?.alternatives || null,
          check: result.check || null,
        };
      }
      return {
        ok: true,
        reservation: result.reservation,
        view: result.view,
        message: `Reservation ${result.reservation.id} created for ${result.view.customerName}, ${result.reservation.start} to ${result.reservation.end}.`,
      };
    }

    function cancelReservation(id) {
      const result = store.cancelReservation(id);
      if (!result.ok) return { ok: false, code: result.code || 'validation', error: result.error };
      const related = proposals.buildProposals(state())
        .filter((proposal) => proposal.cancelledReservationId === id)
        .map((proposal) => ({
          id: proposal.id,
          status: proposal.status,
          feasibility: proposal.feasibility,
          reservationId: proposal.reservationId,
        }));
      return {
        ok: true,
        reservation: result.reservation,
        freedItems: result.freedItems,
        proposals: related,
        message: `Reservation ${id} cancelled; ${result.freedItems.length} item line(s) freed.${related.length ? ` Operations proposal ${related[0].id} created.` : ''}`,
      };
    }

    function getReservation(id) {
      const view = selectors.getReservation(state(), String(id || '').trim());
      if (!view) return { ok: false, code: 'not_found', error: `No reservation ${String(id)} exists.` };
      return { ok: true, reservation: view };
    }

    function getCustomer(query) {
      const text = String(query || '').trim();
      const current = state();
      const matches = selectors.customerMatches(current, text, 10).map((customer) => ({
        ...customer,
        activeReservations: current.reservations
          .filter((reservation) => reservation.customerId === customer.id
            && (reservation.status === 'confirmed' || reservation.status === 'held'))
          .sort((a, b) => a.start.localeCompare(b.start))
          .map((reservation) => ({ id: reservation.id, start: reservation.start, end: reservation.end, status: reservation.status })),
      }));
      return {
        ok: true,
        query: text,
        found: matches.length > 0,
        matches,
        message: matches.length === 0
          ? `No customer matches "${text}".`
          : `${matches.length} customer match(es) for "${text}".`,
      };
    }

    function getItem(query) {
      const text = String(query || '').trim();
      const matches = selectors.itemMatches(state(), text, 10);
      return {
        ok: true,
        query: text,
        found: matches.length > 0,
        matches,
        message: matches.length === 0 ? `No equipment matches "${text}".` : `${matches.length} equipment match(es) for "${text}".`,
      };
    }

    return {
      check_availability: checkAvailability,
      create_reservation: createReservation,
      cancel_reservation: cancelReservation,
      get_reservation: getReservation,
      get_customer: getCustomer,
      get_item: getItem,
    };
  }

  const api = { createAssistantTools };

  if (typeof module !== 'undefined') {
    module.exports = api;
  } else {
    globalThis.RentalAssistantTools = api;
  }
})();
