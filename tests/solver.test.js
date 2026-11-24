'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const solver = require('../src/solver.js');
const selectors = require('../src/selectors.js');

function item(stockId, overrides = {}) {
  return {
    stockId,
    name: `Test item ${stockId}`,
    brand: 'Test Brand',
    category: 'camera',
    quantityOwned: 1,
    location: 'Shelf T-1',
    maintenance: 'ok',
    ...overrides,
  };
}

function reservation(id, start, end, stockIds, status = 'confirmed') {
  return {
    id,
    customerId: 'CUS-001',
    start,
    end,
    status,
    items: stockIds.map((stockId) => ({ stockId, quantity: 1 })),
  };
}

function miniState({ equipment, reservations }) {
  return {
    equipment,
    customers: [{ id: 'CUS-001', name: 'Test Customer', contact: {}, clientType: 'agency', history: {} }],
    reservations,
    events: [],
  };
}

function conflictOf(state) {
  const conflicts = selectors.conflicts(state);
  assert.equal(conflicts.length, 1);
  return conflicts[0];
}

describe('solveConflict', () => {
  test('moves the latest-starting affected reservation to the nearest free dates', () => {
    const state = miniState({
      equipment: [item('CAM-A')],
      reservations: [
        reservation('RX-1', '2026-06-01', '2026-06-03', ['CAM-A']),
        reservation('RX-2', '2026-06-02', '2026-06-04', ['CAM-A']),
      ],
    });
    const result = solver.solveConflict(state, conflictOf(state));
    assert.equal(result.feasibility, 'feasible');
    assert.equal(result.reservationId, 'RX-2');
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].type, 'move');
    assert.equal(result.actions[0].from.start, '2026-06-02');
    assert.notEqual(result.actions[0].to.start, result.actions[0].from.start);
    const move = result.actions[0].to;
    assert.ok(move.end < '2026-06-01' || move.start > '2026-06-03', `${move.start} to ${move.end} must clear RX-1`);
    assert.ok(result.actionLabels[0].startsWith('Move RX-2'));
    assert.equal(typeof result.solverMs, 'number');
    assert.ok(result.solverMs >= 0);
  });

  test('swaps to equivalent stock when no dates are free, and verifies it clears', () => {
    const state = miniState({
      equipment: [item('CAM-A'), item('CAM-B')],
      reservations: [
        reservation('RX-1', '2026-01-01', '2026-12-31', ['CAM-A']),
        reservation('RX-2', '2026-06-01', '2026-06-02', ['CAM-A']),
      ],
    });
    const result = solver.solveConflict(state, conflictOf(state));
    assert.equal(result.feasibility, 'feasible');
    assert.ok(result.actions.length >= 1);
    assert.ok(result.actions.every((action) => action.type === 'swap' && action.toStockId === 'CAM-B'));
    assert.match(result.reason, /clears/);
    const draft = structuredClone(state);
    solver.applyActions(draft.reservations, result.actions);
    assert.equal(selectors.conflicts(draft).length, 0);
  });

  test('searches a bounded combination when no single action can clear', () => {
    const state = miniState({
      equipment: [item('CAM-A', { quantityOwned: 3 })],
      reservations: [
        reservation('RX-1', '2026-01-01', '2026-01-03', ['CAM-A']),
        reservation('RX-2', '2026-01-02', '2026-01-04', ['CAM-A']),
        reservation('RX-3', '2026-01-03', '2026-01-05', ['CAM-A']),
      ],
    });
    for (const row of state.reservations) row.items = [{ stockId: 'CAM-A', quantity: 2 }];
    const conflict = conflictOf(state);
    assert.ok(conflict.overBy > 0);
    const result = solver.solveConflict(state, conflict);
    assert.equal(result.feasibility, 'feasible');
    assert.ok(result.actions.length >= 2 && result.actions.length <= 3);
    const draft = structuredClone(state);
    solver.applyActions(draft.reservations, result.actions);
    assert.equal(selectors.conflicts(draft).length, 0);
  });

  test('reports a partial reduction with what remains when three actions cannot clear', () => {
    const state = miniState({
      equipment: [item('CAM-A', { quantityOwned: 2 })],
      reservations: [
        reservation('RX-1', '2026-01-01', '2026-01-02', ['CAM-A']),
        reservation('RX-2', '2026-01-01', '2026-01-02', ['CAM-A']),
        reservation('RX-3', '2026-01-01', '2026-01-02', ['CAM-A']),
        reservation('RX-4', '2026-01-01', '2026-01-02', ['CAM-A']),
        reservation('RX-5', '2026-01-01', '2026-01-02', ['CAM-A']),
      ],
    });
    for (const row of state.reservations) row.items = [{ stockId: 'CAM-A', quantity: 2 }];
    const result = solver.solveConflict(state, conflictOf(state));
    assert.equal(result.feasibility, 'partial');
    assert.ok(result.actions.length <= 3);
    assert.ok(result.overByRemaining > 0);
    assert.match(result.reason, /cannot clear/);
  });

  test('returns no plan when there are no free dates and no equivalent stock', () => {
    const state = miniState({
      equipment: [item('CAM-A')],
      reservations: [
        reservation('RX-1', '2026-01-01', '2026-12-31', ['CAM-A']),
        reservation('RX-2', '2026-06-01', '2026-06-02', ['CAM-A']),
      ],
    });
    const result = solver.solveConflict(state, conflictOf(state));
    assert.equal(result.feasibility, 'none');
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.actionLabels, []);
    assert.match(result.reason, /human dispatcher/);
    assert.equal(result.reservationId, 'RX-2');
  });

  test('is deterministic and does not mutate its input', () => {
    const state = miniState({
      equipment: [item('CAM-A')],
      reservations: [
        reservation('RX-1', '2026-06-01', '2026-06-03', ['CAM-A']),
        reservation('RX-2', '2026-06-02', '2026-06-04', ['CAM-A']),
      ],
    });
    const before = structuredClone(state);
    const first = solver.solveConflict(state, conflictOf(state));
    const second = solver.solveConflict(state, conflictOf(state));
    assert.deepEqual({ ...first, solverMs: 0 }, { ...second, solverMs: 0 });
    assert.deepEqual(state, before);
  });
});

describe('solveCancellation', () => {
  test('finds a same-stock conflict whose dates overlap the cancellation and solves it', () => {
    const state = miniState({
      equipment: [item('CAM-A')],
      reservations: [
        reservation('RX-1', '2026-06-01', '2026-06-03', ['CAM-A']),
        reservation('RX-2', '2026-06-02', '2026-06-04', ['CAM-A']),
        reservation('RX-3', '2026-06-02', '2026-06-03', ['CAM-A'], 'cancelled'),
      ],
    });
    const cancelled = state.reservations.find((row) => row.id === 'RX-3');
    const result = solver.solveCancellation(state, cancelled, selectors.conflicts(state));
    assert.equal(result.feasibility, 'feasible');
    assert.ok(result.conflict);
    assert.equal(result.conflict.category, 'camera');
    assert.ok(result.freedQuantity >= 1);
  });

  test('does not claim a same-stock conflict on non-overlapping dates', () => {
    const state = miniState({
      equipment: [item('CAM-A')],
      reservations: [
        reservation('RX-1', '2026-06-01', '2026-06-03', ['CAM-A']),
        reservation('RX-2', '2026-06-02', '2026-06-04', ['CAM-A']),
        reservation('RX-3', '2026-06-20', '2026-06-21', ['CAM-A'], 'cancelled'),
      ],
    });
    const cancelled = state.reservations.find((row) => row.id === 'RX-3');
    const result = solver.solveCancellation(state, cancelled, selectors.conflicts(state));
    assert.equal(result.feasibility, 'none');
    assert.match(result.reason, /no open conflict needs those items/);
  });

  test('reports honestly when no conflict needs the freed category', () => {
    const state = miniState({
      equipment: [item('CAM-A'), item('LGT-A', { category: 'lighting' })],
      reservations: [
        reservation('RX-1', '2026-06-01', '2026-06-03', ['CAM-A']),
        reservation('RX-2', '2026-06-02', '2026-06-04', ['CAM-A']),
      ],
    });
    const cancelled = reservation('RX-9', '2026-06-10', '2026-06-11', ['LGT-A'], 'cancelled');
    state.reservations.push(cancelled);
    const result = solver.solveCancellation(state, cancelled, selectors.conflicts(state));
    assert.equal(result.feasibility, 'none');
    assert.deepEqual(result.actions, []);
    assert.match(result.reason, /no open conflict/);
  });
});
