'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const seed = require('../data/seed.json');
const { createStore } = require('../src/store.js');
const proposalsApi = require('../src/proposals.js');
const selectors = require('../src/selectors.js');

const CLOCK = () => '2026-11-24T09:00:00.000Z';
const fresh = () => createStore(seed, { now: CLOCK });

function humanState() {
  return {
    equipment: [{
      stockId: 'CAM-A',
      name: 'Solo camera',
      brand: 'Test',
      category: 'camera',
      quantityOwned: 1,
      location: 'Shelf',
      maintenance: 'ok',
    }],
    customers: [{ id: 'CUS-1', name: 'Customer One', contact: {}, clientType: 'agency', history: {} }],
    reservations: [
      {
        id: 'RX-2001', customerId: 'CUS-1', start: '2026-01-01', end: '2026-12-31',
        status: 'confirmed', items: [{ stockId: 'CAM-A', quantity: 1 }],
      },
      {
        id: 'RX-2002', customerId: 'CUS-1', start: '2026-06-01', end: '2026-06-02',
        status: 'confirmed', items: [{ stockId: 'CAM-A', quantity: 1 }],
      },
    ],
    events: [],
  };
}

describe('buildProposals from the seed', () => {
  test('builds conflict and cancellation proposals with the required fields', () => {
    const store = fresh();
    const proposals = proposalsApi.buildProposals(store.getState());
    assert.ok(proposals.length >= 8);
    for (const proposal of proposals) {
      assert.match(proposal.id, /^RP-/);
      assert.ok(['cancellation', 'conflict'].includes(proposal.reason));
      assert.ok(proposal.reservationId);
      assert.ok(Array.isArray(proposal.freedItems));
      assert.ok(Array.isArray(proposal.actions));
      assert.ok(['feasible', 'partial', 'none'].includes(proposal.feasibility));
      assert.ok(['pending', 'approved', 'rejected', 'human'].includes(proposal.status));
      assert.equal(typeof proposal.solverMs, 'number');
      assert.ok(proposal.solverMs >= 0);
    }
    const firstPending = proposals.find((proposal) => proposal.status === 'pending');
    assert.equal(firstPending.id, 'RP-CF-AUD-005');
    assert.equal(firstPending.reason, 'conflict');
    assert.equal(firstPending.feasibility, 'feasible');
  });

  test('cancelling a reservation adds its proposal to the inbox', () => {
    const store = fresh();
    const active = store.getState().reservations.find((reservation) => reservation.status === 'confirmed');
    const cancelled = store.cancelReservation(active.id);
    assert.equal(cancelled.ok, true);
    const proposal = proposalsApi.buildProposals(store.getState())
      .find((row) => row.cancelledReservationId === active.id);
    assert.ok(proposal);
    assert.equal(proposal.reason, 'cancellation');
    assert.equal(proposal.freedItems.length, active.items.length);
    assert.match(proposal.summary, new RegExp(active.id));
  });

  test('proposal ids and order are deterministic for the same state', () => {
    const state = fresh().getState();
    const first = proposalsApi.buildProposals(state).map((row) => `${row.id}:${row.status}:${row.feasibility}`);
    const second = proposalsApi.buildProposals(state).map((row) => `${row.id}:${row.status}:${row.feasibility}`);
    assert.deepEqual(first, second);
  });
});

describe('status transitions', () => {
  test('approving a feasible proposal applies its moves and records approval', () => {
    const store = fresh();
    const before = structuredClone(store.getState().reservations);
    const conflictsBefore = selectors.conflicts(store.getState()).length;
    const proposal = proposalsApi.buildProposals(store.getState()).find((row) => row.status === 'pending');
    const target = proposal.actions[0].reservationId;
    const beforeRow = before.find((row) => row.id === target);
    let notifications = 0;
    store.subscribe(() => { notifications += 1; });

    const result = store.approveProposal(proposal.id);
    assert.equal(result.ok, true);
    assert.equal(notifications, 1);
    assert.equal(result.proposal.status, 'approved');
    const afterRow = store.getState().reservations.find((row) => row.id === target);
    if (proposal.actions[0].type === 'move') {
      assert.equal(afterRow.start, proposal.actions[0].to.start);
      assert.equal(afterRow.end, proposal.actions[0].to.end);
      assert.notEqual(afterRow.start, beforeRow.start);
    }
    assert.ok(selectors.conflicts(store.getState()).length < conflictsBefore);
    const rebuilt = proposalsApi.buildProposals(store.getState()).find((row) => row.id === proposal.id);
    assert.equal(rebuilt.status, 'approved');
    assert.equal(store.getState().events.at(-1).type, 'proposal.approved');
  });

  test('rejecting leaves reservations untouched and records rejection', () => {
    const store = fresh();
    const before = structuredClone(store.getState().reservations);
    const proposal = proposalsApi.buildProposals(store.getState()).find((row) => row.status === 'pending');
    let notifications = 0;
    store.subscribe(() => { notifications += 1; });
    const result = store.rejectProposal(proposal.id);
    assert.equal(result.ok, true);
    assert.equal(notifications, 1);
    assert.equal(result.proposal.status, 'rejected');
    assert.deepEqual(store.getState().reservations, before);
    const rebuilt = proposalsApi.buildProposals(store.getState()).find((row) => row.id === proposal.id);
    assert.equal(rebuilt.status, 'rejected');
    assert.equal(store.getState().events.at(-1).type, 'proposal.rejected');
  });

  test('a proposal with no plan is assigned to a human and cannot be approved', () => {
    const store = createStore({
      version: 1,
      meta: { anchorDate: '2026-11-24' },
      equipment: humanState().equipment,
      customers: humanState().customers,
      reservations: humanState().reservations,
    }, { now: CLOCK });
    const proposal = proposalsApi.buildProposals(store.getState())[0];
    assert.equal(proposal.feasibility, 'none');
    assert.equal(proposal.status, 'human');
    assert.equal(proposal.assignedTo, 'Human dispatcher');
    assert.deepEqual(proposal.actions, []);
    assert.ok(proposal.reservationId);
    const result = store.approveProposal(proposal.id);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'human');
    const rejected = store.rejectProposal(proposal.id);
    assert.equal(rejected.ok, true);
    const rebuilt = proposalsApi.buildProposals(store.getState()).find((row) => row.id === proposal.id);
    assert.equal(rebuilt.status, 'rejected');
    // The conflict is still open, so a new version is actionable.
    const next = proposalsApi.buildProposals(store.getState())
      .find((row) => row.id === `${proposal.id}-2`);
    assert.ok(next);
    assert.equal(next.conflict.id, proposal.conflict.id);
  });

  test('an already resolved proposal cannot be applied twice', () => {
    const store = fresh();
    const proposal = proposalsApi.buildProposals(store.getState())[0];
    store.rejectProposal(proposal.id);
    assert.equal(store.rejectProposal(proposal.id).ok, false);
    assert.equal(store.approveProposal(proposal.id).ok, false);
  });
});

describe('applyProposal validation', () => {
  test('refuses a move that is no longer free without changing reservations', () => {
    const store = fresh();
    const proposal = proposalsApi.buildProposals(store.getState()).find((row) => row.status === 'pending');
    const action = proposal.actions[0];
    assert.equal(action.type, 'move');
    const blocker = store.getState().reservations.find((row) => row.id !== action.reservationId);
    // Fill the target range with the moved reservation's own item, outside the store, then apply.
    const state = structuredClone(store.getState());
    state.reservations.push({
      id: 'RX-9999',
      customerId: state.customers[0].id,
      start: action.to.start,
      end: action.to.end,
      status: 'confirmed',
      items: [{ stockId: state.reservations.find((row) => row.id === action.reservationId).items[0].stockId, quantity: 99 }],
    });
    const before = structuredClone(state.reservations);
    assert.throws(() => proposalsApi.applyProposal(state, proposal), /Cannot apply proposal/);
    assert.deepEqual(state.reservations, before);
    assert.ok(blocker);
  });

  test('cumulative validation rejects two swaps that only fit when own holdings are excluded', () => {
    const state = {
      equipment: [
        { stockId: 'CAM-A', name: 'Camera A', brand: 'T', category: 'camera', quantityOwned: 1, location: 'S', maintenance: 'ok' },
        { stockId: 'CAM-B', name: 'Camera B', brand: 'T', category: 'camera', quantityOwned: 1, location: 'S', maintenance: 'ok' },
        { stockId: 'CAM-D', name: 'Camera D', brand: 'T', category: 'camera', quantityOwned: 1, location: 'S', maintenance: 'ok' },
      ],
      customers: [{ id: 'CUS-1', name: 'One', contact: {}, clientType: 'agency', history: {} }],
      reservations: [
        { id: 'RX-1', customerId: 'CUS-1', start: '2026-06-01', end: '2026-06-03', status: 'confirmed', items: [{ stockId: 'CAM-A', quantity: 1 }] },
        { id: 'RX-2', customerId: 'CUS-1', start: '2026-06-02', end: '2026-06-04', status: 'confirmed', items: [{ stockId: 'CAM-A', quantity: 1 }, { stockId: 'CAM-D', quantity: 1 }] },
      ],
      events: [],
    };
    const before = structuredClone(state.reservations);
    const proposal = {
      id: 'RP-TEST',
      reservationId: 'RX-2',
      conflict: { id: 'CF-CAM-A' },
      actions: [
        { type: 'swap', reservationId: 'RX-2', fromStockId: 'CAM-A', toStockId: 'CAM-B', quantity: 1 },
        { type: 'swap', reservationId: 'RX-2', fromStockId: 'CAM-D', toStockId: 'CAM-B', quantity: 1 },
      ],
    };
    assert.throws(() => proposalsApi.applyProposal(state, proposal), (error) => {
      assert.equal(error.code, 'overbooked');
      assert.match(error.message, /CAM-B/);
      return true;
    });
    assert.deepEqual(state.reservations, before);
  });
});

describe('conflict approval clears the target conflict', () => {
  test('the first pending seed proposal removes its own conflict and leaves no overBy', () => {
    const store = fresh();
    const proposal = proposalsApi.buildProposals(store.getState()).find((row) => row.status === 'pending');
    const conflictId = proposal.conflict.id;
    const stockId = proposal.conflict.stockId;
    const date = proposal.conflict.from;
    const result = store.approveProposal(proposal.id);
    assert.equal(result.ok, true);
    const state = store.getState();
    assert.ok(!selectors.conflicts(state).some((conflict) => conflict.id === conflictId));
    assert.equal(selectors.conflicts(state).find((conflict) => conflict.id === conflictId), undefined);
    assert.equal(selectors.matrixCell(state, stockId, date).overbooked, false);
  });

  test('a decided card renders the recorded applied actions', () => {
    const store = fresh();
    const proposal = proposalsApi.buildProposals(store.getState()).find((row) => row.status === 'pending');
    const recordedLabels = [...proposal.actionLabels];
    assert.ok(recordedLabels.length > 0);
    store.approveProposal(proposal.id);
    const decided = proposalsApi.buildProposals(store.getState()).find((row) => row.id === proposal.id);
    assert.equal(decided.status, 'approved');
    assert.deepEqual(decided.actionLabels, recordedLabels);
    assert.deepEqual(decided.actions, proposal.actions);
  });

  test('rejecting a still-present conflict creates a new pending proposal version', () => {
    const store = fresh();
    const proposal = proposalsApi.buildProposals(store.getState()).find((row) => row.status === 'pending');
    const result = store.rejectProposal(proposal.id);
    assert.equal(result.ok, true);
    const rebuilt = proposalsApi.buildProposals(store.getState());
    assert.equal(rebuilt.find((row) => row.id === proposal.id).status, 'rejected');
    const next = rebuilt.find((row) => row.id === `${proposal.id}-2`);
    assert.ok(next);
    assert.equal(next.status, 'pending');
    assert.equal(next.feasibility, 'feasible');
    assert.equal(next.conflict.id, proposal.conflict.id);
  });

  test('an approved proposal whose conflict remains is shown unresolved with a new version', () => {
    const state = fresh().getState();
    const proposal = proposalsApi.buildProposals(state).find((row) => row.status === 'pending');
    state.events.push({
      id: 'EV-1',
      type: 'proposal.approved',
      proposal: { ...proposal, status: 'approved' },
    });
    const rebuilt = proposalsApi.buildProposals(state);
    const decided = rebuilt.find((row) => row.id === proposal.id);
    assert.equal(decided.status, 'approved');
    assert.equal(decided.unresolved, true);
    assert.deepEqual(decided.actionLabels, proposal.actionLabels);
    const next = rebuilt.find((row) => row.id === `${proposal.id}-2`);
    assert.ok(next);
    assert.equal(next.conflict.id, proposal.conflict.id);
  });
});

describe('cancellation proposals are truthful and deduplicated', () => {
  function cancellationState() {
    return {
      equipment: [
        { stockId: 'CAM-A', name: 'Camera A', brand: 'T', category: 'camera', quantityOwned: 1, location: 'S', maintenance: 'ok' },
        { stockId: 'CAM-B', name: 'Camera B', brand: 'T', category: 'camera', quantityOwned: 1, location: 'S', maintenance: 'ok' },
        { stockId: 'LGT-A', name: 'Light A', brand: 'T', category: 'lighting', quantityOwned: 1, location: 'S', maintenance: 'ok' },
      ],
      customers: [{ id: 'CUS-1', name: 'One', contact: {}, clientType: 'agency', history: {} }],
      reservations: [
        { id: 'RX-1', customerId: 'CUS-1', start: '2026-06-01', end: '2026-06-03', status: 'confirmed', items: [{ stockId: 'CAM-A', quantity: 1 }] },
        { id: 'RX-2', customerId: 'CUS-1', start: '2026-06-02', end: '2026-06-04', status: 'confirmed', items: [{ stockId: 'CAM-A', quantity: 1 }] },
        { id: 'RX-8', customerId: 'CUS-1', start: '2026-06-02', end: '2026-06-03', status: 'cancelled', cancelledAt: '2026-05-02', items: [{ stockId: 'CAM-A', quantity: 1 }] },
        { id: 'RX-9', customerId: 'CUS-1', start: '2026-06-02', end: '2026-06-03', status: 'cancelled', cancelledAt: '2026-05-01', items: [{ stockId: 'CAM-A', quantity: 1 }] },
        { id: 'RX-10', customerId: 'CUS-1', start: '2026-06-02', end: '2026-06-03', status: 'cancelled', cancelledAt: '2026-05-03', items: [{ stockId: 'LGT-A', quantity: 1 }] },
      ],
      events: [],
    };
  }

  test('an unrelated freed stock claims no conflict', () => {
    const proposals = proposalsApi.buildProposals(cancellationState());
    const unrelated = proposals.find((row) => row.cancelledReservationId === 'RX-10');
    assert.ok(unrelated);
    assert.equal(unrelated.conflict, null);
    assert.deepEqual(unrelated.actions, []);
    assert.match(unrelated.summary, /no open conflict/);
  });

  test('identical moves from several cancellations appear only once', () => {
    const proposals = proposalsApi.buildProposals(cancellationState());
    const labels = proposals.flatMap((row) => row.actionLabels);
    assert.equal(new Set(labels).size, labels.length, labels.join(' | '));
    const cancellations = proposals.filter((row) => row.reason === 'cancellation' && row.cancelledReservationId);
    const claiming = cancellations.filter((row) => row.conflict);
    assert.ok(claiming.length >= 1);
    for (const row of claiming) {
      assert.equal(row.actions.length, 0);
      assert.match(row.summary, /same plan|already proposed/);
    }
  });
});
