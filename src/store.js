/*
 * One store for the whole product: { equipment, customers, reservations, events }.
 *
 * Every write validates against current availability, updates the state once,
 * appends one operations event and notifies every subscriber exactly once.
 * Views never keep their own copy; the assistant and the manual panel both call
 * commitReservation / cancelReservation.
 *
 * createStore(seed, { now }) returns the store. `now` is injectable so tests can
 * fix event timestamps; the browser default is the real clock.
 */
(function () {
  'use strict';

  const selectors = typeof module !== 'undefined'
    ? require('./selectors.js')
    : globalThis.RentalSelectors;

  const proposals = typeof module !== 'undefined'
    ? require('./proposals.js')
    : globalThis.RentalProposals;

  const { rangeProblem } = typeof module !== 'undefined'
    ? require('./validation.js')
    : globalThis.RentalValidation;

  function clone(value) {
    return typeof structuredClone === 'function'
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  }

  function fail(error, code = 'validation', extra = {}) {
    return { ok: false, code, error, ...extra };
  }

  function createStore(seed, options = {}) {
    if (!seed || !Array.isArray(seed.equipment) || !Array.isArray(seed.customers) || !Array.isArray(seed.reservations)) {
      throw new Error('Seed data must include equipment, customers and reservations arrays.');
    }
    const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
    const initial = {
      equipment: clone(seed.equipment),
      customers: clone(seed.customers),
      reservations: clone(seed.reservations),
      events: [],
    };
    let state = clone(initial);
    let eventCounter = 0;
    const listeners = new Set();

    function nextReservationId() {
      const numbers = state.reservations
        .map((reservation) => /^RX-(\d+)$/.exec(reservation.id))
        .filter(Boolean)
        .map((match) => Number(match[1]));
      return `RX-${Math.max(1000, ...numbers) + 1}`;
    }

    function appendEvent(type, payload) {
      eventCounter += 1;
      const event = {
        id: `EV-${1000 + eventCounter}`,
        type,
        at: now(),
        ...payload,
      };
      state.events.push(event);
      return event;
    }

    function notify() {
      for (const listener of [...listeners]) {
        try {
          listener(state);
        } catch (error) {
          // A broken subscriber must not prevent the other subscribers or the write.
          if (typeof console !== 'undefined' && console.error) console.error('Store subscriber failed', error);
        }
      }
    }

    function subscribe(listener) {
      if (typeof listener !== 'function') throw new Error('subscribe() needs a listener function.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    function getState() {
      // Callers get a copy so selector and tool output can never mutate the
      // store by holding on to a live reference.
      return clone(state);
    }

    function normaliseItems(input) {
      if (!Array.isArray(input) || input.length === 0) {
        return { error: 'A reservation needs at least one item.' };
      }
      const seen = new Set();
      const items = [];
      for (const row of input) {
        const stockId = row && typeof row.stockId === 'string' ? row.stockId.trim() : '';
        const quantity = row ? row.quantity : undefined;
        if (!stockId) return { error: 'Every item needs a stockId.' };
        if (!Number.isInteger(quantity) || quantity < 1) {
          return { error: `Quantity for ${stockId} must be a whole number of 1 or more.` };
        }
        if (seen.has(stockId)) return { error: `List ${stockId} once and give it a single quantity.` };
        seen.add(stockId);
        items.push({ stockId, quantity });
      }
      return { items };
    }

    /**
     * Create a reservation after checking availability.
     * @returns {{ok: true, reservation: object, view: object, event: object}
     *   | {ok: false, code: string, error: string, check?: object, alternatives?: object}}
     */
    function commitReservation(input = {}) {
      const customerId = typeof input.customerId === 'string' ? input.customerId.trim() : '';
      if (!customerId) return fail('Choose a customer before saving.');
      const customer = state.customers.find((row) => row.id === customerId);
      if (!customer) return fail(`No customer ${customerId} exists.`);
      const dates = rangeProblem('Reservation', input.start, input.end);
      if (dates) return fail(dates);
      const normalised = normaliseItems(input.items);
      if (normalised.error) return fail(normalised.error);

      for (const row of normalised.items) {
        const item = selectors.equipmentFor(state, row.stockId);
        if (!item) return fail(`${row.stockId} is not in the inventory.`);
      }

      const check = selectors.checkItems(state, {
        start: input.start,
        end: input.end,
        items: normalised.items,
      });
      if (!check.ok) return fail(check.error || 'The reservation dates are invalid.');
      if (!check.feasible) {
        const short = check.items.filter((row) => row.short > 0);
        const names = short.map((row) => `${row.stockId} short by ${row.short}`).join('; ');
        return fail(`Not enough stock for these dates: ${names}.`, 'unavailable', {
          check,
          alternatives: check.alternatives,
          short,
        });
      }

      const reservation = {
        id: nextReservationId(),
        customerId,
        start: input.start,
        end: input.end,
        items: normalised.items,
        status: 'confirmed',
        createdAt: now(),
      };
      state.reservations.push(reservation);
      const event = appendEvent('reservation.created', {
        reservationId: reservation.id,
        summary: `Reservation ${reservation.id} created`,
        customerId,
        customerName: customer.name,
        start: reservation.start,
        end: reservation.end,
        items: clone(normalised.items),
      });
      notify();
      return {
        ok: true,
        reservation: clone(reservation),
        view: clone(selectors.getReservation(state, reservation.id)),
        event: clone(event),
      };
    }

    /** Cancel an open reservation. Returns the items it freed. */
    function cancelReservation(id) {
      const reservation = state.reservations.find((row) => row.id === id);
      if (!reservation) return fail(`No reservation ${String(id)} exists.`);
      if (reservation.status === 'cancelled') return fail(`Reservation ${id} is already cancelled.`, 'conflict');
      if (reservation.status === 'returned') return fail(`Reservation ${id} has already been returned.`, 'conflict');
      const freedItems = reservation.items.map((row) => {
        const item = selectors.equipmentFor(state, row.stockId);
        return {
          stockId: row.stockId,
          name: item ? item.name : row.stockId,
          category: item ? item.category : null,
          quantity: row.quantity,
        };
      });
      reservation.status = 'cancelled';
      reservation.cancelledAt = now();
      const event = appendEvent('reservation.cancelled', {
        reservationId: reservation.id,
        summary: `Reservation ${reservation.id} cancelled`,
        customerId: reservation.customerId,
        freedItems,
      });
      notify();
      return { ok: true, reservation: clone(selectors.getReservation(state, id)), freedItems: clone(freedItems), event: clone(event) };
    }

    function findProposal(id) {
      return proposals.buildProposals(state).find((proposal) => proposal.id === id) || null;
    }

    /** Apply a pending proposal's plan actions. Human-only proposals cannot be approved. */
    function approveProposal(id) {
      const proposal = findProposal(id);
      if (!proposal) return fail(`No proposal ${id} exists.`, 'not_found');
      if (proposal.status === 'approved') return fail(`Proposal ${id} is already approved.`, 'conflict');
      if (proposal.status === 'rejected') return fail(`Proposal ${id} was rejected.`, 'conflict');
      if (proposal.status === 'human' || proposal.feasibility === 'none' || proposal.actions.length === 0) {
        return fail(`Proposal ${id} has no feasible plan and belongs to a human dispatcher.`, 'human');
      }
      if (proposal.feasibility !== 'feasible') {
        return fail(`Proposal ${id} is not a verified plan; a human dispatcher has to decide.`, 'unverified');
      }

      let reservations;
      try {
        reservations = proposals.applyProposal(state, proposal);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error), (error && error.code) || 'unavailable');
      }

      // Approve against a draft, then verify the target conflict is gone and no
      // new conflict or overbooking was created before committing anything.
      const beforeConflicts = selectors.conflicts(state);
      const draftState = { ...state, reservations };
      const afterConflicts = selectors.conflicts(draftState);
      const targetId = proposal.conflict && proposal.conflict.id ? proposal.conflict.id : null;
      if (targetId) {
        const before = beforeConflicts.find((conflict) => conflict.id === targetId);
        if (!before) {
          return fail(`Proposal ${id} targets ${targetId}, which is no longer open. Nothing was changed.`, 'stale');
        }
        if (afterConflicts.some((conflict) => conflict.id === targetId)) {
          return fail(`Proposal ${id} did not clear ${targetId}. Nothing was changed.`, 'unverified');
        }
      }
      for (const conflict of afterConflicts) {
        const before = beforeConflicts.find((row) => row.id === conflict.id);
        if (!before) {
          return fail(`Proposal ${id} would create a new ${conflict.stockId} conflict. Nothing was changed.`, 'unverified');
        }
        if (conflict.overBy > before.overBy) {
          return fail(`Proposal ${id} would worsen the ${conflict.stockId} conflict. Nothing was changed.`, 'unverified');
        }
      }

      state.reservations = reservations;
      const snapshot = { ...proposal, status: 'approved', actions: proposal.actions, appliedAt: now() };
      const event = appendEvent('proposal.approved', {
        proposalId: proposal.id,
        reservationId: proposal.reservationId,
        summary: `Proposal ${proposal.id} approved`,
        proposal: snapshot,
      });
      notify();
      return { ok: true, proposal: clone(snapshot), event: clone(event) };
    }

    /** Reject a proposal without touching any reservation. */
    function rejectProposal(id) {
      const proposal = findProposal(id);
      if (!proposal) return fail(`No proposal ${id} exists.`, 'not_found');
      if (proposal.status === 'approved') return fail(`Proposal ${id} is already approved.`, 'conflict');
      if (proposal.status === 'rejected') return fail(`Proposal ${id} is already rejected.`, 'conflict');
      const snapshot = { ...proposal, status: 'rejected' };
      const event = appendEvent('proposal.rejected', {
        proposalId: proposal.id,
        reservationId: proposal.reservationId,
        summary: `Proposal ${proposal.id} rejected`,
        proposal: snapshot,
      });
      notify();
      return { ok: true, proposal: clone(snapshot), event: clone(event) };
    }

    /** Restore the seed and clear every session write. One notification. */
    function reset() {
      state = clone(initial);
      eventCounter = 0;
      appendEvent('store.reset', { summary: 'Workspace reset to the seed data' });
      notify();
      return { ok: true, state: clone(state) };
    }

    return {
      subscribe,
      getState,
      commitReservation,
      cancelReservation,
      approveProposal,
      rejectProposal,
      reset,
      anchorDate: seed.meta?.anchorDate || null,
      version: seed.version || 1,
    };
  }

  const api = { createStore };

  if (typeof module !== 'undefined') {
    module.exports = api;
  } else {
    globalThis.RentalStore = api;
  }
})();
