/*
 * Deterministic re-plan solver for the studio inventory.
 *
 * The original constraint search has been adapted to the seed data shape
 * (equipment lines with quantityOwned, reservations with item quantities).
 * For a conflict it tries, in order and in a stable order:
 *   1. move the latest-starting affected reservation to the nearest free dates;
 *   2. swap its constrained lines for equivalent stock in the same category;
 *   3. report that no plan exists, so Operations assigns it to a human.
 *
 * Pure functions, no DOM, no network, no model calls. Times are measured with
 * performance.now (or Date.now) only to report solverMs.
 */
(function () {
  'use strict';

  const selectors = typeof module !== 'undefined'
    ? require('./selectors.js')
    : globalThis.RentalSelectors;

  const { rangesOverlap } = typeof module !== 'undefined'
    ? require('./validation.js')
    : globalThis.RentalValidation;

  const now = typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

  function rawReservation(state, id) {
    return state.reservations.find((reservation) => reservation.id === id) || null;
  }

  function cloneReservations(state) {
    return typeof structuredClone === 'function'
      ? structuredClone(state.reservations)
      : JSON.parse(JSON.stringify(state.reservations));
  }

  function moveAction(reservation, target) {
    return {
      type: 'move',
      reservationId: reservation.id,
      from: { start: reservation.start, end: reservation.end },
      to: { start: target.start, end: target.end },
      shift: target.shift,
    };
  }

  function swapAction(reservation, row, replacement, quantity = row.quantity) {
    return {
      type: 'swap',
      reservationId: reservation.id,
      fromStockId: row.stockId,
      toStockId: replacement.stockId,
      quantity,
      dates: { start: reservation.start, end: reservation.end },
    };
  }

  function describeMove(action) {
    return `Move ${action.reservationId} from ${action.from.start} to ${action.from.end} to ${action.to.start} to ${action.to.end}`;
  }

  function describeSwap(action) {
    return `Swap ${action.quantity} × ${action.fromStockId} for ${action.toStockId} on ${action.reservationId}`;
  }

  function describeAction(action) {
    return action.type === 'move' ? describeMove(action) : describeSwap(action);
  }

  function actionKey(action) {
    if (action.type === 'move') {
      return `move|${action.reservationId}|${action.to.start}|${action.to.end}`;
    }
    return `swap|${action.reservationId}|${action.fromStockId}|${action.toStockId}|${action.quantity}`;
  }

  /**
   * Apply move/swap actions to a reservations array that the caller owns (a
   * draft). Throws rather than mutating shared state when an action no longer
   * fits the reservation.
   */
  function applyActions(reservations, actions) {
    for (const action of actions) {
      const reservation = reservations.find((row) => row.id === action.reservationId);
      if (!reservation) throw new Error(`Reservation ${action.reservationId} is no longer in the workspace.`);

      if (action.type === 'move') {
        if (!action.to || typeof action.to.start !== 'string' || typeof action.to.end !== 'string') {
          throw new Error(`Cannot move ${reservation.id}: invalid target dates.`);
        }
        reservation.start = action.to.start;
        reservation.end = action.to.end;
        continue;
      }

      if (action.type === 'swap') {
        const row = reservation.items.find((item) => item.stockId === action.fromStockId);
        if (!row) throw new Error(`Reservation ${reservation.id} no longer holds ${action.fromStockId}.`);
        const quantity = Math.min(action.quantity, row.quantity);
        if (!Number.isInteger(quantity) || quantity < 1) {
          throw new Error(`Cannot swap ${action.fromStockId}: invalid quantity.`);
        }
        row.quantity -= quantity;
        if (row.quantity === 0) reservation.items = reservation.items.filter((item) => item !== row);
        const existing = reservation.items.find((item) => item.stockId === action.toStockId);
        if (existing) existing.quantity += quantity;
        else reservation.items.push({ stockId: action.toStockId, quantity });
        continue;
      }

      throw new Error(`Unknown plan action "${String(action.type)}".`);
    }
    return reservations;
  }

  /** The overbooked row for the same stock after a draft is applied, or null. */
  function remainingConflict(state, reservations, conflict) {
    const next = { ...state, reservations };
    return selectors.conflicts(next).find((row) => row.id === conflict.id) || null;
  }

  function evaluatePlan(state, conflict, actions) {
    try {
      const draft = applyActions(cloneReservations(state), actions);
      const remaining = remainingConflict(state, draft, conflict);
      return { ok: true, clears: !remaining, overBy: remaining ? remaining.overBy : 0, draft };
    } catch (error) {
      return { ok: false, clears: false, overBy: Infinity, error };
    }
  }

  /**
   * Candidate single actions in a stable order. A move for every affected
   * reservation, then whole-line swaps, then one-unit swaps so a combination
   * can trim a line without moving the whole reservation.
   */
  function candidateActions(state, conflict, maxShift) {
    const affected = conflict.reservationIds
      .map((id) => rawReservation(state, id))
      .filter(Boolean)
      .sort((a, b) => b.start.localeCompare(a.start) || b.id.localeCompare(a.id));
    const actions = [];
    const seen = new Set();
    function add(action) {
      const key = actionKey(action);
      if (seen.has(key)) return;
      seen.add(key);
      actions.push(action);
    }

    for (const reservation of affected) {
      const alternatives = selectors.freeDateAlternatives(state, {
        start: reservation.start,
        end: reservation.end,
        items: reservation.items,
        excludeReservationId: reservation.id,
        limit: 1,
        maxShift,
      });
      if (alternatives.length) add(moveAction(reservation, alternatives[0]));

      for (const row of reservation.items) {
        const replacements = selectors.equivalentItems(
          state,
          row.stockId,
          reservation.start,
          reservation.end,
          row.quantity,
          [reservation.id],
          1,
        );
        if (replacements.length) add(swapAction(reservation, row, replacements[0]));
        if (row.quantity > 1) {
          const single = selectors.equivalentItems(
            state,
            row.stockId,
            reservation.start,
            reservation.end,
            1,
            [reservation.id],
            1,
          );
          if (single.length) add(swapAction(reservation, row, single[0], 1));
        }
      }
    }
    return { affected, actions };
  }

  function compatible(actions) {
    const moves = new Set();
    const swaps = new Set();
    for (const action of actions) {
      if (action.type === 'move') {
        if (moves.has(action.reservationId)) return false;
        moves.add(action.reservationId);
      } else {
        const key = `${action.reservationId}|${action.fromStockId}`;
        if (swaps.has(key)) return false;
        swaps.add(key);
      }
    }
    return true;
  }

  /**
   * Search one conflict for an actionable re-plan. Every candidate is applied
   * to a draft and the conflict is re-checked; an action or combination is only
   * feasible when the target conflict is actually gone. Combinations are bounded
   * to three actions, then the best partial reduction is reported, or none.
   */
  function solveConflict(state, conflict, options = {}) {
    const started = now();
    const maxShift = Number.isInteger(options.maxShift) ? options.maxShift : 60;
    const { affected, actions } = candidateActions(state, conflict, maxShift);
    const limit = Math.min(actions.length, 16);
    let best = null;

    function record(result, chosen) {
      if (!result.ok) return false;
      if (result.clears) return true;
      const candidate = { actions: chosen, overBy: result.overBy };
      if (!best
        || candidate.overBy < best.overBy
        || (candidate.overBy === best.overBy && candidate.actions.length < best.actions.length)) {
        best = candidate;
      }
      return false;
    }

    function resultFor(feasibility, chosen, overBy, reason) {
      return {
        feasibility,
        actions: chosen,
        actionLabels: chosen.map(describeAction),
        reason,
        solverMs: now() - started,
        reservationId: chosen.length ? chosen[0].reservationId : (affected[0] ? affected[0].id : null),
        overByRemaining: overBy,
      };
    }

    // One action.
    for (let i = 0; i < limit; i += 1) {
      const chosen = [actions[i]];
      if (record(evaluatePlan(state, conflict, chosen), chosen)) {
        return resultFor('feasible', chosen, 0, `${conflict.stockId} conflict clears with one action: ${describeAction(chosen[0])}.`);
      }
    }

    // Two actions.
    for (let i = 0; i < limit; i += 1) {
      for (let j = i + 1; j < limit; j += 1) {
        const chosen = [actions[i], actions[j]];
        if (!compatible(chosen)) continue;
        if (record(evaluatePlan(state, conflict, chosen), chosen)) {
          return resultFor('feasible', chosen, 0, `${conflict.stockId} conflict clears with a two-action plan: ${chosen.map(describeAction).join('; ')}.`);
        }
      }
    }

    // Three actions (the bounded maximum).
    for (let i = 0; i < limit; i += 1) {
      for (let j = i + 1; j < limit; j += 1) {
        for (let k = j + 1; k < limit; k += 1) {
          const chosen = [actions[i], actions[j], actions[k]];
          if (!compatible(chosen)) continue;
          if (record(evaluatePlan(state, conflict, chosen), chosen)) {
            return resultFor('feasible', chosen, 0, `${conflict.stockId} conflict clears with a three-action plan: ${chosen.map(describeAction).join('; ')}.`);
          }
        }
      }
    }

    const originalOverBy = conflict.overBy;
    if (best && best.overBy < originalOverBy) {
      return resultFor(
        'partial',
        best.actions,
        best.overBy,
        `Up to three moves or swaps reduce the ${conflict.stockId} overbooking to ${best.overBy} over owned, but cannot clear it. A human dispatcher has to decide.`,
      );
    }

    return resultFor(
      'none',
      [],
      originalOverBy,
      `No free dates or equivalent stock can absorb this conflict within ${maxShift} days. A human dispatcher has to decide.`,
    );
  }

  /**
   * A cancellation frees stock. It only targets a conflict on the same stock id
   * whose dates overlap the cancelled reservation, and only when restoring that
   * reservation would actually deepen the conflict (so the freed units reduce
   * the shortfall). The plan itself comes from solveConflict.
   */
  function solveCancellation(state, cancelledReservation, conflictRows, solvedResults = null) {
    const started = now();
    const freed = cancelledReservation.items.map((row) => ({
      stockId: row.stockId,
      quantity: row.quantity,
      item: selectors.equipmentFor(state, row.stockId),
    }));
    const freedByStock = new Map();
    for (const row of freed) freedByStock.set(row.stockId, (freedByStock.get(row.stockId) || 0) + row.quantity);
    const related = (conflictRows || [])
      .filter((conflict) => {
        if ((freedByStock.get(conflict.stockId) || 0) < 1) return false;
        if (!rangesOverlap(cancelledReservation.start, cancelledReservation.end, conflict.from, conflict.to)) return false;
        const restored = {
          ...state,
          reservations: state.reservations.map((row) => (row.id === cancelledReservation.id
            ? { ...row, status: 'confirmed', start: cancelledReservation.start, end: cancelledReservation.end }
            : row)),
        };
        const before = selectors.conflicts(restored).find((row) => row.id === conflict.id);
        return Boolean(before && before.overBy > conflict.overBy);
      })
      .sort((a, b) => a.id.localeCompare(b.id));

    if (related.length === 0) {
      return {
        feasibility: 'none',
        actions: [],
        actionLabels: [],
        reason: `Cancellation ${cancelledReservation.id} freed ${freed.length} line(s), but no open conflict needs those items on overlapping dates. The stock is back in availability; a dispatcher can re-let it.`,
        solverMs: now() - started,
        reservationId: null,
        conflict: null,
        freedQuantity: 0,
      };
    }

    const target = related[0];
    const cached = solvedResults && solvedResults.get(target.id);
    const result = cached || solveConflict(state, target);
    const freedQuantity = freedByStock.get(target.stockId) || 0;
    return {
      ...result,
      reason: `${result.reason} Cancellation ${cancelledReservation.id} freed ${freedQuantity} × ${target.stockId} on dates that overlap the conflict.`,
      conflict: target,
      freedQuantity,
      solverMs: cached ? cached.solverMs : now() - started,
    };
  }

  const api = { solveConflict, solveCancellation, applyActions };

  if (typeof module !== 'undefined') {
    module.exports = api;
  } else {
    globalThis.RentalSolver = api;
  }
})();
