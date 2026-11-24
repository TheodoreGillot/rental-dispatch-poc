'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const seed = require('../data/seed.json');
const { createStore } = require('../src/store.js');
const selectors = require('../src/selectors.js');

const CLOCK = () => '2026-11-24T09:00:00.000Z';
const TODAY = '2026-11-24';

function fresh() {
  return createStore(seed, { now: CLOCK });
}

/** First item that can take 2 units over the range. */
function freeInput(state, start, end, quantity = 2) {
  for (const item of state.equipment) {
    if (item.maintenance !== 'ok') continue;
    if (selectors.availableQuantity(state, item.stockId, start, end) >= quantity) {
      return {
        customerId: state.customers[0].id,
        start,
        end,
        items: [{ stockId: item.stockId, quantity }],
      };
    }
  }
  throw new Error('No free item for the test range');
}

function activeReservation(state) {
  return state.reservations.find((reservation) => reservation.status === 'confirmed' && reservation.items.length >= 2);
}

describe('store shape and subscriptions', () => {
  test('the state has exactly equipment, customers, reservations and events', () => {
    const store = fresh();
    assert.deepEqual(Object.keys(store.getState()).sort(), ['customers', 'equipment', 'events', 'reservations']);
    assert.equal(store.getState().reservations.length, 300);
    assert.equal(store.getState().events.length, 0);
    assert.equal(store.anchorDate, TODAY);
  });

  test('subscribe returns an unsubscribe function and delivers exactly one notification per write', () => {
    const store = fresh();
    let calls = 0;
    const unsubscribe = store.subscribe(() => { calls += 1; });
    const input = freeInput(store.getState(), '2027-01-10', '2027-01-12');
    store.commitReservation(input);
    assert.equal(calls, 1);
    store.cancelReservation(store.getState().reservations.at(-1).id);
    assert.equal(calls, 2);
    unsubscribe();
    store.commitReservation(freeInput(store.getState(), '2027-02-10', '2027-02-12'));
    assert.equal(calls, 2);
  });

  test('a failed write does not notify or mutate the state', () => {
    const store = fresh();
    let calls = 0;
    store.subscribe(() => { calls += 1; });
    const before = structuredClone(store.getState());
    const result = store.commitReservation({ customerId: 'CUS-001', start: '2026-13-01', end: '2026-13-02', items: [{ stockId: 'LGT-001', quantity: 1 }] });
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
    assert.deepEqual(store.getState(), before);
  });

  test('getState returns a copy so callers cannot mutate live state', () => {
    const store = fresh();
    const snapshot = store.getState();
    snapshot.reservations.push({ id: 'RX-BAD' });
    snapshot.equipment[0].quantityOwned = 999;
    assert.equal(store.getState().reservations.length, 300);
    assert.notEqual(store.getState().equipment[0].quantityOwned, 999);
  });
});

describe('commitReservation', () => {
  test('creates a confirmed reservation, one event and one notification', () => {
    const store = fresh();
    let calls = 0;
    store.subscribe(() => { calls += 1; });
    const input = freeInput(store.getState(), '2027-01-10', '2027-01-12');
    const result = store.commitReservation(input);
    assert.equal(result.ok, true);
    assert.equal(result.reservation.id, 'RX-1301');
    assert.equal(result.reservation.status, 'confirmed');
    assert.deepEqual(result.reservation.items, input.items);
    assert.equal(result.reservation.createdAt, CLOCK());
    assert.equal(store.getState().reservations.length, 301);
    assert.equal(store.getState().events.length, 1);
    assert.equal(store.getState().events[0].type, 'reservation.created');
    assert.equal(store.getState().events[0].summary, 'Reservation RX-1301 created');
    assert.equal(calls, 1);
  });

  test('rejects an unknown customer, bad dates, duplicate and zero quantities', () => {
    const store = fresh();
    const cases = [
      { customerId: 'CUS-999', start: '2026-12-01', end: '2026-12-02', items: [{ stockId: 'LGT-001', quantity: 1 }] },
      { customerId: 'CUS-001', start: '2026-12-03', end: '2026-12-02', items: [{ stockId: 'LGT-001', quantity: 1 }] },
      { customerId: 'CUS-001', start: '2026-12-01', end: '2026-12-02', items: [] },
      { customerId: 'CUS-001', start: '2026-12-01', end: '2026-12-02', items: [{ stockId: 'LGT-001', quantity: 0 }] },
      { customerId: 'CUS-001', start: '2026-12-01', end: '2026-12-02', items: [{ stockId: 'LGT-001', quantity: 1 }, { stockId: 'LGT-001', quantity: 2 }] },
      { customerId: 'CUS-001', start: '2026-12-01', end: '2026-12-02', items: [{ stockId: 'NOPE-1', quantity: 1 }] },
    ];
    for (const input of cases) {
      const result = store.commitReservation(input);
      assert.equal(result.ok, false, JSON.stringify(input));
      assert.ok(result.error.length > 0);
    }
    assert.equal(store.getState().reservations.length, 300);
  });

  test('an over-booking is blocked with typed alternatives and no event', () => {
    const store = fresh();
    const state = store.getState();
    const conflict = selectors.conflicts(state)[0];
    const result = store.commitReservation({
      customerId: state.customers[0].id,
      start: conflict.from,
      end: conflict.to,
      items: [{ stockId: conflict.stockId, quantity: conflict.owned + 1 }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'unavailable');
    assert.match(result.error, /Not enough stock/);
    assert.ok(result.short.length >= 1);
    assert.ok(result.alternatives);
    assert.equal(store.getState().events.length, 0);
    assert.equal(store.getState().reservations.length, 300);
  });
});

describe('cancelReservation', () => {
  test('cancels an open reservation, frees its items and appends one event', () => {
    const store = fresh();
    const reservation = activeReservation(store.getState());
    const result = store.cancelReservation(reservation.id);
    assert.equal(result.ok, true);
    assert.equal(result.reservation.status, 'cancelled');
    assert.equal(result.freedItems.length, reservation.items.length);
    assert.equal(store.getState().events.length, 1);
    assert.equal(store.getState().events[0].type, 'reservation.cancelled');
    assert.match(store.getState().events[0].summary, new RegExp(`Reservation ${reservation.id} cancelled`));
  });

  test('rejects unknown, already cancelled and returned reservations', () => {
    const store = fresh();
    assert.equal(store.cancelReservation('RX-9999').ok, false);
    const open = activeReservation(store.getState());
    store.cancelReservation(open.id);
    const again = store.cancelReservation(open.id);
    assert.equal(again.ok, false);
    assert.match(again.error, /already cancelled/);
    const returned = store.getState().reservations.find((reservation) => reservation.status === 'returned');
    const result = store.cancelReservation(returned.id);
    assert.equal(result.ok, false);
    assert.match(result.error, /already been returned/);
  });
});

describe('reset', () => {
  test('restores the seed, clears session writes and notifies once', () => {
    const store = fresh();
    let calls = 0;
    store.subscribe(() => { calls += 1; });
    store.commitReservation(freeInput(store.getState(), '2027-01-10', '2027-01-12'));
    const before = calls;
    const result = store.reset();
    assert.equal(result.ok, true);
    assert.equal(calls, before + 1);
    assert.equal(store.getState().reservations.length, 300);
    assert.equal(store.getState().events.length, 1);
    assert.equal(store.getState().events[0].type, 'store.reset');
    assert.ok(!store.getState().reservations.some((reservation) => reservation.id === 'RX-1301'));
  });
});
