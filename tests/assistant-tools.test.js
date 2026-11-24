'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const seed = require('../data/seed.json');
const { createStore } = require('../src/store.js');
const { createAssistantTools } = require('../src/assistant-tools.js');
const selectors = require('../src/selectors.js');

const CLOCK = () => '2026-11-24T09:00:00.000Z';

function setup() {
  const store = createStore(seed, { now: CLOCK });
  const tools = createAssistantTools({ store });
  return { store, tools };
}

function freeItem(state, start, end, quantity = 1) {
  return state.equipment.find((item) => item.maintenance === 'ok'
    && selectors.availableQuantity(state, item.stockId, start, end) >= quantity);
}

function overbookInput(state) {
  const conflict = selectors.conflicts(state)[0];
  return {
    customerId: state.customers[0].id,
    start: conflict.from,
    end: conflict.to,
    items: [{ stockId: conflict.stockId, quantity: conflict.owned + 1 }],
  };
}

describe('check_availability', () => {
  test('reports exactly what the selectors report, with alternatives', () => {
    const { store, tools } = setup();
    const state = store.getState();
    const item = freeItem(state, '2027-02-01', '2027-02-02');
    const input = { start: '2027-02-01', end: '2027-02-02', items: [{ stockId: item.stockId, quantity: 1 }] };
    const output = tools.check_availability(input);
    const direct = selectors.checkItems(state, input);
    assert.equal(output.ok, true);
    assert.equal(output.feasible, true);
    assert.equal(output.feasible, direct.feasible);
    assert.equal(output.items.length, direct.items.length);
    for (let index = 0; index < direct.items.length; index += 1) {
      assert.equal(output.items[index].stockId, direct.items[index].stockId);
      assert.equal(output.items[index].available, direct.items[index].available);
      assert.equal(output.items[index].short, direct.items[index].short);
      assert.deepEqual(output.items[index].alternatives, direct.items[index].alternatives);
    }
  });

  test('an overbooked request reports the shortfall and never claims availability', () => {
    const { store, tools } = setup();
    const input = overbookInput(store.getState());
    const output = tools.check_availability({ start: input.start, end: input.end, items: input.items });
    assert.equal(output.ok, true);
    assert.equal(output.feasible, false);
    const short = output.items.filter((item) => item.short > 0);
    assert.ok(short.length >= 1);
    assert.ok(output.alternatives.dates.length > 0 || output.alternatives.items.length > 0);
    assert.ok(short.every((item) => item.available < item.requested));
  });

  test('invalid input returns a typed error', () => {
    const { tools } = setup();
    assert.equal(tools.check_availability({ start: '2026-02-30', end: '2026-03-01', items: [{ stockId: 'LGT-001', quantity: 1 }] }).ok, false);
    assert.equal(tools.check_availability({ start: '2026-12-01', end: '2026-12-02', items: [] }).ok, false);
    assert.equal(tools.check_availability({ start: '2026-12-01', end: '2026-12-02', items: [{ stockId: 'LGT-001', quantity: 0 }] }).ok, false);
  });

  test('duplicate stock rows are rejected with the store message', () => {
    const { tools } = setup();
    const output = tools.check_availability({
      start: '2027-02-01',
      end: '2027-02-02',
      items: [{ stockId: 'LGT-001', quantity: 4 }, { stockId: 'LGT-001', quantity: 4 }],
    });
    assert.equal(output.ok, false);
    assert.equal(output.code, 'validation');
    assert.match(output.error, /List LGT-001 once and give it a single quantity/);
  });
});

describe('create_reservation', () => {
  test('writes through the store and reports the created record', () => {
    const { store, tools } = setup();
    const state = store.getState();
    const item = freeItem(state, '2027-02-01', '2027-02-02', 2);
    let notifications = 0;
    store.subscribe(() => { notifications += 1; });
    const output = tools.create_reservation({
      customerId: state.customers[2].id,
      start: '2027-02-01',
      end: '2027-02-02',
      items: [{ stockId: item.stockId, quantity: 2 }],
    });
    assert.equal(output.ok, true);
    assert.equal(output.reservation.id, 'RX-1301');
    assert.equal(output.view.customerName, state.customers[2].name);
    assert.equal(notifications, 1);
    assert.equal(store.getState().reservations.length, 301);
    assert.equal(store.getState().events[0].type, 'reservation.created');
  });

  test('an over-booking is rejected with alternatives and no write', () => {
    const { store, tools } = setup();
    let notifications = 0;
    store.subscribe(() => { notifications += 1; });
    const output = tools.create_reservation(overbookInput(store.getState()));
    assert.equal(output.ok, false);
    assert.equal(output.code, 'unavailable');
    assert.match(output.error, /Not enough stock/);
    assert.ok(output.alternatives);
    assert.equal(notifications, 0);
    assert.equal(store.getState().reservations.length, 300);
  });

  test('unknown customer and invalid dates are typed errors', () => {
    const { tools } = setup();
    const missing = tools.create_reservation({ customerId: 'CUS-999', start: '2026-12-01', end: '2026-12-02', items: [{ stockId: 'LGT-001', quantity: 1 }] });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /No customer/);
    const dates = tools.create_reservation({ customerId: 'CUS-001', start: '2026-12-05', end: '2026-12-01', items: [{ stockId: 'LGT-001', quantity: 1 }] });
    assert.equal(dates.ok, false);
    assert.match(dates.error, /before it starts/);
  });
});

describe('cancel_reservation', () => {
  test('cancels through the store, returns freed items and names the proposal', () => {
    const { store, tools } = setup();
    const active = store.getState().reservations.find((reservation) => reservation.status === 'confirmed');
    const output = tools.cancel_reservation(active.id);
    assert.equal(output.ok, true);
    assert.equal(output.reservation.status, 'cancelled');
    assert.equal(output.freedItems.length, active.items.length);
    assert.ok(output.proposals.length >= 1);
    assert.match(output.proposals[0].id, new RegExp(`RP-${active.id}`));
    assert.equal(store.getState().reservations.find((row) => row.id === active.id).status, 'cancelled');
  });

  test('unknown and already cancelled ids return errors', () => {
    const { store, tools } = setup();
    assert.equal(tools.cancel_reservation('RX-9999').ok, false);
    const active = store.getState().reservations.find((reservation) => reservation.status === 'confirmed');
    tools.cancel_reservation(active.id);
    const again = tools.cancel_reservation(active.id);
    assert.equal(again.ok, false);
    assert.match(again.error, /already cancelled/);
  });
});

describe('read-only lookups', () => {
  test('get_reservation returns an enriched record or a typed error', () => {
    const { tools } = setup();
    const found = tools.get_reservation('RX-1001');
    assert.equal(found.ok, true);
    assert.equal(found.reservation.id, 'RX-1001');
    assert.ok(found.reservation.customerName);
    const missing = tools.get_reservation('RX-9999');
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'not_found');
  });

  test('get_customer finds exact and partial matches, with active reservations', () => {
    const { tools } = setup();
    const exact = tools.get_customer('Nordlys Film');
    assert.equal(exact.ok, true);
    assert.equal(exact.found, true);
    assert.equal(exact.matches[0].id, 'CUS-001');
    assert.ok(Array.isArray(exact.matches[0].activeReservations));
    const none = tools.get_customer('Nobody At All');
    assert.equal(none.ok, true);
    assert.equal(none.found, false);
  });

  test('get_item finds stock lines and never mutates', () => {
    const { store, tools } = setup();
    const before = structuredClone(store.getState());
    const found = tools.get_item('LGT-004');
    assert.equal(found.ok, true);
    assert.equal(found.matches[0].stockId, 'LGT-004');
    assert.equal(tools.get_item('No Such Gear').found, false);
    assert.deepEqual(store.getState(), before);
  });

  test('tool outputs do not expose live state references', () => {
    const { store, tools } = setup();
    const found = tools.get_reservation('RX-1001');
    found.reservation.items[0].quantity = 999;
    found.reservation.start = '1999-01-01';
    const current = store.getState().reservations.find((row) => row.id === 'RX-1001');
    assert.notEqual(current.start, '1999-01-01');
    assert.notEqual(current.items[0].quantity, 999);
  });
});
