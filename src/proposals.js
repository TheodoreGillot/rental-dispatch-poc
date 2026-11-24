/*
 * Operations inbox: deterministic re-plan proposals built from cancellations
 * and overbooked stock lines. Proposals never mutate anything by themselves;
 * store.approveProposal() applies the plan actions through validation.
 *
 * Status overlay: approval and rejection are recorded as operations events so
 * the inbox survives every re-render without keeping a second copy of data.
 * Conflict proposal ids are versioned per attempt (RP-CF-LGT-004-2). When a
 * decided proposal's conflict is still open, the old card stays visible as
 * unresolved and a new version is built so the conflict stays actionable.
 */
(function () {
  'use strict';

  const selectors = typeof module !== 'undefined'
    ? require('./selectors.js')
    : globalThis.RentalSelectors;

  const solver = typeof module !== 'undefined'
    ? require('./solver.js')
    : globalThis.RentalSolver;

  const { toDay, isoFromDay } = typeof module !== 'undefined'
    ? require('./validation.js')
    : globalThis.RentalValidation;

  function clone(value) {
    return typeof structuredClone === 'function'
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  }

  function planError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function eventStatus(events) {
    const statuses = new Map();
    for (const event of events) {
      if (event.type === 'proposal.approved' && event.proposal) {
        statuses.set(event.proposal.id, { status: 'approved', proposal: event.proposal });
      }
      if (event.type === 'proposal.rejected' && event.proposal) {
        statuses.set(event.proposal.id, { status: 'rejected', proposal: event.proposal });
      }
    }
    return statuses;
  }

  function conflictBaseId(stockId) {
    return `RP-CF-${stockId}`;
  }

  /**
   * Next undecided version for a conflict. Attempt 1 keeps the historical id
   * without a suffix; later attempts are suffixed with their version number.
   */
  function activeConflictId(statuses, stockId) {
    const base = conflictBaseId(stockId);
    let version = 1;
    while (statuses.has(version === 1 ? base : `${base}-${version}`)) version += 1;
    return { id: version === 1 ? base : `${base}-${version}`, version };
  }

  function actionSignature(action) {
    if (!action || typeof action !== 'object') return 'invalid';
    if (action.type === 'move') {
      return `move|${action.reservationId}|${action.to && action.to.start}|${action.to && action.to.end}`;
    }
    return `swap|${action.reservationId}|${action.fromStockId}|${action.toStockId}|${action.quantity}`;
  }

  function freedItemsFor(state, reservation) {
    return reservation.items.map((row) => {
      const item = selectors.equipmentFor(state, row.stockId);
      return {
        stockId: row.stockId,
        name: item ? item.name : row.stockId,
        category: item ? item.category : null,
        quantity: row.quantity,
      };
    });
  }

  /** The six most recent cancellations, newest first and deterministic. */
  function recentCancellations(state) {
    return state.reservations
      .filter((reservation) => reservation.status === 'cancelled')
      .sort((a, b) => String(b.cancelledAt || '').localeCompare(String(a.cancelledAt || '')) || b.id.localeCompare(a.id))
      .slice(0, 6);
  }

  function proposalStatus(feasibility) {
    return feasibility === 'feasible' ? 'pending' : 'human';
  }

  function assignedTo(feasibility) {
    return feasibility === 'feasible' ? 'Operations' : 'Human dispatcher';
  }

  /**
   * Build the inbox from current state. Stable order: pending, human,
   * rejected, approved; then id.
   */
  function buildProposals(state) {
    const statuses = eventStatus(state.events || []);
    const conflictRows = selectors.conflicts(state);
    const openConflictIds = new Set(conflictRows.map((conflict) => conflict.id));
    const proposals = [];
    const solvedConflicts = new Map();
    const claimedActions = new Map();

    for (const conflict of conflictRows) {
      const result = solver.solveConflict(state, conflict);
      solvedConflicts.set(conflict.id, result);
      const active = activeConflictId(statuses, conflict.stockId);
      const id = active.id;
      if (statuses.has(id)) continue;
      for (const action of result.actions) {
        if (!claimedActions.has(actionSignature(action))) claimedActions.set(actionSignature(action), id);
      }
      proposals.push({
        id,
        version: active.version,
        reason: 'conflict',
        reservationId: result.reservationId || conflict.reservationIds[0] || null,
        link: result.reservationId || conflict.reservationIds[0] || null,
        freedItems: [],
        actions: result.actions,
        actionLabels: result.actionLabels,
        solverMs: result.solverMs,
        feasibility: result.feasibility,
        overByRemaining: result.overByRemaining,
        status: proposalStatus(result.feasibility),
        assignedTo: assignedTo(result.feasibility),
        summary: `Resolve the ${conflict.name} overbooking, ${conflict.from} to ${conflict.to}.`,
        detail: result.reason,
        conflict,
        unresolved: false,
      });
    }

    for (const cancelled of recentCancellations(state)) {
      const id = `RP-${cancelled.id}`;
      if (statuses.has(id)) continue;
      const result = solver.solveCancellation(state, cancelled, conflictRows, solvedConflicts);
      const target = result.reservationId || (result.conflict ? result.conflict.reservationIds[0] : cancelled.id);
      let actions = result.actions;
      let actionLabels = result.actionLabels;
      let feasibility = result.feasibility;
      let status = proposalStatus(feasibility);
      let summary;
      let detail = result.reason;
      let conflict = result.conflict || null;

      if (conflict) {
        const fresh = result.actions
          .map((action, index) => ({ action, label: result.actionLabels[index] }))
          .filter((row) => !claimedActions.has(actionSignature(row.action)));
        if (result.actions.length > 0 && fresh.length === 0) {
          // The same move/swap is already proposed elsewhere. Keep the card so a
          // cancelled reservation is never silently missing, but do not show the
          // same action twice; no extra plan is needed.
          actions = [];
          actionLabels = [];
          feasibility = 'none';
          status = 'human';
          summary = `Cancellation ${cancelled.id} freed stock that could clear the ${conflict.name} conflict, but the same plan is already proposed as ${claimedActions.get(actionSignature(result.actions[0]))}.`;
          detail = `${detail} No additional actions are needed from this cancellation.`;
        } else {
          if (fresh.length !== result.actions.length) {
            actions = fresh.map((row) => row.action);
            actionLabels = fresh.map((row) => row.label);
            feasibility = 'partial';
            status = 'human';
          }
          for (const action of actions) {
            if (!claimedActions.has(actionSignature(action))) claimedActions.set(actionSignature(action), id);
          }
          summary = feasibility === 'feasible'
            ? `Cancellation ${cancelled.id} freed ${result.freedQuantity || 0} × ${conflict.stockId} on overlapping dates, reducing the ${conflict.name} conflict; the verified plan is below.`
            : `Cancellation ${cancelled.id} freed ${result.freedQuantity || 0} × ${conflict.stockId} on overlapping dates, but no verified plan clears the ${conflict.name} conflict yet.`;
        }
      } else if (result.actions.length > 0) {
        summary = `Cancellation ${cancelled.id} freed stock; the verified plan is below.`;
      } else {
        summary = `Cancellation ${cancelled.id} freed stock; no open conflict needs those items.`;
      }

      proposals.push({
        id,
        reason: 'cancellation',
        reservationId: target,
        link: target,
        cancelledReservationId: cancelled.id,
        freedItems: freedItemsFor(state, cancelled),
        actions,
        actionLabels,
        solverMs: result.solverMs,
        feasibility,
        overByRemaining: result.overByRemaining,
        status,
        assignedTo: assignedTo(feasibility),
        summary,
        detail,
        conflict,
        unresolved: false,
      });
    }

    // Keep decided proposals visible even after their underlying rows changed.
    // They render the recorded actions, never a freshly rebuilt plan.
    for (const [id, recorded] of statuses) {
      if (proposals.some((proposal) => proposal.id === id)) continue;
      const conflictId = recorded.proposal && recorded.proposal.conflict ? recorded.proposal.conflict.id : null;
      proposals.push({
        ...recorded.proposal,
        status: recorded.status,
        unresolved: Boolean(conflictId && openConflictIds.has(conflictId)),
      });
    }

    const rank = { pending: 0, human: 1, rejected: 2, approved: 3 };
    return proposals.sort((a, b) => (rank[a.status] ?? 4) - (rank[b.status] ?? 4) || a.id.localeCompare(b.id));
  }

  /**
   * Apply a proposal's plan to a draft, then validate the whole resulting
   * state. Every stock id and every day is counted from all blocking
   * reservations, including the target reservation's own holdings, so earlier
   * actions in the same plan cannot hide an overbooking. Throws a typed error
   * and leaves the caller's state untouched when the plan is invalid.
   */
  function applyProposal(state, proposal) {
    if (!proposal || !Array.isArray(proposal.actions) || proposal.actions.length === 0) {
      throw planError('invalid-plan', `Proposal ${proposal ? proposal.id : 'unknown'} has no plan to apply.`);
    }
    const draft = clone(state);
    const beforeConflicts = selectors.conflicts(state);

    for (const action of proposal.actions) {
      const reservation = draft.reservations.find((row) => row.id === action.reservationId);
      if (!reservation) throw planError('invalid-plan', `Reservation ${action.reservationId} is no longer in the workspace.`);

      if (action.type === 'move') {
        if (toDay(action.to && action.to.start) === null || toDay(action.to && action.to.end) === null) {
          throw planError('invalid-plan', `Cannot move ${reservation.id}: invalid target dates.`);
        }
        reservation.start = action.to.start;
        reservation.end = action.to.end;
        continue;
      }

      if (action.type === 'swap') {
        const row = reservation.items.find((item) => item.stockId === action.fromStockId);
        if (!row) throw planError('invalid-plan', `Reservation ${reservation.id} no longer holds ${action.fromStockId}.`);
        const targetItem = selectors.equipmentFor(draft, action.toStockId);
        if (!targetItem || targetItem.maintenance !== 'ok') {
          throw planError('invalid-plan', `Cannot swap ${action.fromStockId}: ${action.toStockId} is not usable stock.`);
        }
        const quantity = Math.min(action.quantity, row.quantity);
        if (!Number.isInteger(quantity) || quantity < 1) {
          throw planError('invalid-plan', `Cannot swap ${action.fromStockId}: invalid quantity.`);
        }
        row.quantity -= quantity;
        if (row.quantity === 0) reservation.items = reservation.items.filter((item) => item !== row);
        const existing = reservation.items.find((item) => item.stockId === action.toStockId);
        if (existing) existing.quantity += quantity;
        else reservation.items.push({ stockId: action.toStockId, quantity });
        continue;
      }

      throw planError('invalid-plan', `Unknown plan action "${String(action.type)}".`);
    }

    // Whole-state cumulative check, target reservation's own quantity included.
    // Pre-existing conflicts such as the target are allowed to stay; the plan
    // must not create a new overbooking or increase an existing one.
    function usageFor(reservations) {
      const usage = new Map();
      for (const item of draft.equipment) usage.set(item.stockId, new Map());
      for (const reservation of reservations) {
        if (!selectors.blocksStock(reservation)) continue;
        const start = toDay(reservation.start);
        const end = toDay(reservation.end);
        if (start === null || end === null || start > end) {
          throw planError('invalid-plan', `Reservation ${reservation.id} has invalid dates.`);
        }
        for (const row of reservation.items) {
          if (!usage.has(row.stockId)) usage.set(row.stockId, new Map());
          const days = usage.get(row.stockId);
          for (let day = start; day <= end; day += 1) {
            days.set(day, (days.get(day) || 0) + row.quantity);
          }
        }
      }
      return usage;
    }

    const beforeUsage = usageFor(state.reservations);
    const afterUsage = usageFor(draft.reservations);
    for (const item of draft.equipment) {
      const beforeDays = beforeUsage.get(item.stockId);
      const afterDays = afterUsage.get(item.stockId);
      if (!afterDays) continue;
      for (const [day, quantity] of afterDays) {
        if (quantity > item.quantityOwned && quantity > (beforeDays.get(day) || 0)) {
          throw planError(
            'overbooked',
            `Cannot apply proposal: it would book ${item.name} (${item.stockId}) ${quantity} against ${item.quantityOwned} owned on ${isoFromDay(day)}.`,
          );
        }
      }
    }

    // No new conflict and no conflict may get worse.
    const beforeById = new Map(beforeConflicts.map((conflict) => [conflict.id, conflict]));
    for (const after of selectors.conflicts(draft)) {
      const before = beforeById.get(after.id);
      if (!before) {
        throw planError('new-conflict', `Cannot apply proposal: it creates a new conflict for ${after.stockId}.`);
      }
      if (after.overBy > before.overBy) {
        throw planError('worse-conflict', `Cannot apply proposal: it worsens the ${after.stockId} conflict.`);
      }
    }

    return draft.reservations;
  }

  const api = { buildProposals, applyProposal, recentCancellations };

  if (typeof module !== 'undefined') {
    module.exports = api;
  } else {
    globalThis.RentalProposals = api;
  }
})();
