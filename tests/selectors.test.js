'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const seed = require('../data/seed.json');
const { createStore } = require('../src/store.js');
const selectors = require('../src/selectors.js');

const TODAY = '2026-11-24';
const CLOCK = () => '2026-11-24T09:00:00.000Z';

function baseState() {
  return {
    equipment: structuredClone(seed.equipment),
    customers: structuredClone(seed.customers),
    reservations: structuredClone(seed.reservations),
    events: [],
  };
}

function freeItem(state, start, end, quantity = 1) {
  return state.equipment.find((item) => item.maintenance === 'ok'
    && selectors.availableQuantity(state, item.stockId, start, end) >= quantity);
}

describe('KPIs', () => {
  test('seed KPIs are derived from reservations and conflicts, not the wall clock', () => {
    const state = baseState();
    const kpis = selectors.kpis(state, TODAY);
    assert.deepEqual(kpis, {
      today: TODAY,
      pickupsToday: 3,
      returnsToday: 2,
      equipmentOutToday: 103,
      openConflicts: 5,
      activeReservations: 202,
    });
  });

  test('a KPI changes when the studio date moves', () => {
    const state = baseState();
    const next = selectors.kpis(state, '2026-11-25');
    assert.notEqual(next.pickupsToday, selectors.kpis(state, TODAY).pickupsToday);
  });
});

describe('conflicts and matrix', () => {
  test('conflict rows report owned, booked and overbooked quantities', () => {
    const state = baseState();
    const conflicts = selectors.conflicts(state);
    assert.equal(conflicts.length, 5);
    for (const conflict of conflicts) {
      assert.ok(conflict.maxBooked > conflict.owned);
      assert.equal(conflict.overBy, conflict.maxBooked - conflict.owned);
      assert.ok(selectors.equipmentFor(state, conflict.stockId));
    }
  });

  test('matrixCell reports the bookings that make a conflict', () => {
    const state = baseState();
    const conflict = selectors.conflicts(state)[0];
    const cell = selectors.matrixCell(state, conflict.stockId, conflict.from);
    assert.equal(cell.overbooked, true);
    assert.equal(cell.booked, conflict.maxBooked);
    assert.ok(cell.available === 0);
    assert.ok(cell.reservations.length >= 2);
    assert.ok(cell.reservations.every((row) => row.quantity > 0));
  });

  test('matrixCell changes immediately after a create and a cancel', () => {
    const store = createStore(seed, { now: CLOCK });
    const state = store.getState();
    const item = freeItem(state, TODAY, TODAY, 2);
    const before = selectors.matrixCell(state, item.stockId, TODAY).booked;
    const created = store.commitReservation({
      customerId: state.customers[0].id,
      start: TODAY,
      end: TODAY,
      items: [{ stockId: item.stockId, quantity: 2 }],
    });
    assert.equal(created.ok, true);
    assert.equal(selectors.matrixCell(store.getState(), item.stockId, TODAY).booked, before + 2);
    store.cancelReservation(created.reservation.id);
    assert.equal(selectors.matrixCell(store.getState(), item.stockId, TODAY).booked, before);
  });
});

describe('calendarMonth', () => {
  test('returns real days, reservation counts and item totals', () => {
    const state = baseState();
    const month = selectors.calendarMonth(state, 2026, 10);
    assert.equal(month.label, 'November 2026');
    assert.equal(month.days.length, 30);
    assert.ok(month.totalReservations > 0);
    const day = month.days.find((row) => row.date === TODAY);
    assert.ok(day.count >= 3);
    assert.equal(day.count, day.reservations.length);
    assert.ok(day.itemsOut > 0);
  });

  test('a create and a cancel change the same day count at once', () => {
    const store = createStore(seed, { now: CLOCK });
    const state = store.getState();
    const item = freeItem(state, TODAY, TODAY, 1);
    const before = selectors.calendarMonth(state, 2026, 10).days.find((row) => row.date === TODAY).count;
    const created = store.commitReservation({
      customerId: state.customers[0].id,
      start: TODAY,
      end: TODAY,
      items: [{ stockId: item.stockId, quantity: 1 }],
    });
    const afterCreate = selectors.calendarMonth(store.getState(), 2026, 10).days.find((row) => row.date === TODAY).count;
    assert.equal(afterCreate, before + 1);
    store.cancelReservation(created.reservation.id);
    const afterCancel = selectors.calendarMonth(store.getState(), 2026, 10).days.find((row) => row.date === TODAY).count;
    assert.equal(afterCancel, before);
  });
});

describe('equipmentRows', () => {
  test('filters by category and maintenance, and sorts by name or owned', () => {
    const state = baseState();
    const lighting = selectors.equipmentRows(state, { category: 'lighting', today: TODAY });
    assert.ok(lighting.length > 0);
    assert.ok(lighting.every((item) => item.category === 'lighting'));
    const retired = selectors.equipmentRows(state, { maintenance: 'retired', today: TODAY });
    assert.ok(retired.every((item) => item.maintenance === 'retired'));

    const byName = selectors.equipmentRows(state, { sort: 'name', dir: 'asc', today: TODAY }).map((item) => item.name);
    assert.deepEqual(byName, [...byName].sort((a, b) => a.localeCompare(b)));
    const byOwned = selectors.equipmentRows(state, { sort: 'owned', dir: 'desc', today: TODAY }).map((item) => item.quantityOwned);
    for (let index = 1; index < byOwned.length; index += 1) assert.ok(byOwned[index - 1] >= byOwned[index]);
  });

  test('out today reflects active reservation quantities', () => {
    const state = baseState();
    const conflict = selectors.conflicts(state)[0];
    const rows = selectors.equipmentRows(state, { query: conflict.stockId, today: conflict.from });
    assert.equal(rows.length, 1);
    assert.ok(rows[0].out > rows[0].quantityOwned);
  });
});

describe('reservationsFor', () => {
  test('filters by status and query, and sorts deterministically', () => {
    const state = baseState();
    const confirmed = selectors.reservationsFor(state, { status: 'confirmed' });
    assert.ok(confirmed.length > 0);
    assert.ok(confirmed.every((row) => row.status === 'confirmed'));

    const one = selectors.reservationsFor(state, { query: 'RX-1001' });
    assert.equal(one.length, 1);
    assert.equal(one[0].id, 'RX-1001');

    const ids = selectors.reservationsFor(state, { sort: 'id', dir: 'asc' }).map((row) => row.id);
    assert.equal(ids[0], 'RX-1001');
    assert.equal(ids[ids.length - 1], 'RX-1300');

    const names = selectors.reservationsFor(state, { sort: 'customer', dir: 'asc' }).map((row) => row.customerName);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(names, sorted);
  });

  test('a new reservation appears in the list immediately', () => {
    const store = createStore(seed, { now: CLOCK });
    const state = store.getState();
    const item = freeItem(state, '2027-02-01', '2027-02-02');
    const created = store.commitReservation({
      customerId: state.customers[1].id,
      start: '2027-02-01',
      end: '2027-02-02',
      items: [{ stockId: item.stockId, quantity: 1 }],
    });
    const rows = selectors.reservationsFor(store.getState(), { query: created.reservation.id });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].customerName, store.getState().customers[1].name);
  });
});

describe('needsAttention and activity', () => {
  test('lists conflicts, pending proposals, expiring holds and upcoming pickups with links', () => {
    const state = baseState();
    const held = state.reservations.find((reservation) => reservation.status === 'confirmed');
    held.status = 'held';
    held.end = '2026-11-25';
    const rows = selectors.needsAttention(state, TODAY);
    const types = new Set(rows.map((row) => row.type));
    assert.ok(types.has('conflict'));
    assert.ok(types.has('proposal'));
    assert.ok(types.has('hold'));
    assert.ok(types.has('pickup'));
    for (const row of rows) {
      assert.ok(row.reservationId || row.proposalId, row.title);
      assert.ok(['operations', 'reservations'].includes(row.tab));
    }
  });

  test('a new pickup today appears in needs attention at once', () => {
    const store = createStore(seed, { now: CLOCK });
    const state = store.getState();
    const item = freeItem(state, TODAY, TODAY);
    const before = selectors.needsAttention(state, TODAY).length;
    store.commitReservation({
      customerId: state.customers[0].id,
      start: TODAY,
      end: TODAY,
      items: [{ stockId: item.stockId, quantity: 1 }],
    });
    const after = selectors.needsAttention(store.getState(), TODAY);
    assert.equal(after.length, before + 1);
    assert.ok(after.some((row) => row.type === 'pickup' && row.reservationId === 'RX-1301'));
  });

  test('the activity feed is newest first and limited', () => {
    const store = createStore(seed, { now: CLOCK });
    const state = store.getState();
    const item = freeItem(state, '2027-02-01', '2027-02-02');
    store.commitReservation({ customerId: state.customers[0].id, start: '2027-02-01', end: '2027-02-02', items: [{ stockId: item.stockId, quantity: 1 }] });
    const feed = selectors.activityFeed(store.getState(), 10);
    assert.equal(feed.length, 1);
    assert.equal(feed[0].type, 'reservation.created');
    assert.match(feed[0].summary, /created/);
  });
});

describe('checkItems and alternatives', () => {
  test('free stock is feasible and a conflict line is short with alternatives', () => {
    const state = baseState();
    const item = freeItem(state, '2027-02-01', '2027-02-02');
    const free = selectors.checkItems(state, { start: '2027-02-01', end: '2027-02-02', items: [{ stockId: item.stockId, quantity: 1 }] });
    assert.equal(free.ok, true);
    assert.equal(free.feasible, true);
    assert.equal(free.items[0].short, 0);

    const conflict = selectors.conflicts(state)[0];
    const short = selectors.checkItems(state, {
      start: conflict.from,
      end: conflict.to,
      items: [{ stockId: conflict.stockId, quantity: conflict.owned + 1 }],
    });
    assert.equal(short.ok, true);
    assert.equal(short.feasible, false);
    assert.ok(short.items[0].short > 0);
    assert.ok(short.alternatives.dates.length > 0 || short.alternatives.items.length > 0);
  });

  test('invalid dates and quantities return a typed error', () => {
    const state = baseState();
    const badDate = selectors.checkItems(state, { start: '2026-02-30', end: '2026-03-01', items: [{ stockId: 'LGT-001', quantity: 1 }] });
    assert.equal(badDate.ok, false);
    assert.match(badDate.error, /Invalid start date/);
    const badQty = selectors.checkItems(state, { start: '2026-12-01', end: '2026-12-02', items: [{ stockId: 'LGT-001', quantity: 1.5 }] });
    assert.equal(badQty.ok, false);
    assert.match(badQty.error, /whole number/);
  });

  test('two rows for the same stock id are rejected as a duplicate, not summed', () => {
    const state = baseState();
    const result = selectors.checkItems(state, {
      start: '2027-02-01',
      end: '2027-02-02',
      items: [{ stockId: 'LGT-001', quantity: 4 }, { stockId: 'LGT-001', quantity: 4 }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.feasible, false);
    assert.match(result.error, /List LGT-001 once and give it a single quantity/);
  });

  test('retired stock is never available', () => {
    const state = baseState();
    const retired = state.equipment.find((item) => item.maintenance === 'retired');
    if (!retired) return;
    const result = selectors.checkItems(state, { start: '2027-02-01', end: '2027-02-02', items: [{ stockId: retired.stockId, quantity: 1 }] });
    assert.equal(result.feasible, false);
    assert.match(result.items[0].reason, /retired/);
  });
});

describe('view counts and panel swap suggestions', () => {
  test('count selectors derive totals without the views reading raw state', () => {
    const state = baseState();
    assert.equal(selectors.equipmentCount(state), state.equipment.length);
    assert.equal(selectors.customerCount(state), state.customers.length);
    const reservations = selectors.reservationCounts(state);
    assert.equal(reservations.total, state.reservations.length);
    assert.equal(reservations.active, state.reservations.filter((row) => row.status === 'confirmed' || row.status === 'held').length);
    const proposals = selectors.proposalCounts(state);
    assert.equal(proposals.total, proposals.pending + proposals.human + proposals.approved + proposals.rejected);
    assert.equal(proposals.open, proposals.pending + proposals.human);
  });

  test('a suggested swap never duplicates a stock line already in the panel', () => {
    const items = [{ stockId: 'LGT-001' }, { stockId: 'LGT-002' }];
    const rows = selectors.swapAlternatives(items, [
      { stockId: 'LGT-001', alternatives: [{ stockId: 'LGT-002' }, { stockId: 'LGT-003' }] },
      { stockId: 'LGT-002', alternatives: [{ stockId: 'LGT-001' }] },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].stockId, 'LGT-001');
    assert.deepEqual(rows[0].alternatives.map((row) => row.stockId), ['LGT-003']);
  });
});
