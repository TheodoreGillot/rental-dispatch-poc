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

describe('manual availability helper', () => {
  test('is a pure selector usable without a DOM', () => {
    const { store } = setup();
    const state = store.getState();
    const item = freeItem(state, '2027-02-01', '2027-02-02');
    const before = structuredClone(state);
    const result = selectors.checkItems(state, {
      start: '2027-02-01',
      end: '2027-02-02',
      items: [{ stockId: item.stockId, quantity: 1 }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.feasible, true);
    assert.deepEqual(state, before);
  });

  test('blocks an over-booking and returns nearest dates or equivalent items', () => {
    const { store } = setup();
    const state = store.getState();
    const conflict = selectors.conflicts(state)[0];
    const result = selectors.checkItems(state, {
      start: conflict.from,
      end: conflict.to,
      items: [{ stockId: conflict.stockId, quantity: conflict.owned + 1 }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.feasible, false);
    assert.ok(result.items[0].short > 0);
    assert.ok(result.alternatives.dates.length > 0 || result.alternatives.items.length > 0);
  });

  test('the store blocks the same over-booking and returns the same alternatives', () => {
    const { store } = setup();
    const state = store.getState();
    const conflict = selectors.conflicts(state)[0];
    const input = {
      customerId: state.customers[0].id,
      start: conflict.from,
      end: conflict.to,
      items: [{ stockId: conflict.stockId, quantity: conflict.owned + 1 }],
    };
    const check = selectors.checkItems(state, input);
    const result = store.commitReservation(input);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'unavailable');
    assert.deepEqual(result.alternatives, check.alternatives);
    assert.equal(store.getState().reservations.length, 300);
    assert.equal(store.getState().events.length, 0);
  });
});

describe('manual and assistant paths agree', () => {
  test('the same input produces the same store change through both paths', () => {
    const manual = setup();
    const viaAssistant = setup();
    const state = manual.store.getState();
    const item = freeItem(state, '2027-02-10', '2027-02-12', 3);
    const input = {
      customerId: state.customers[3].id,
      start: '2027-02-10',
      end: '2027-02-12',
      items: [{ stockId: item.stockId, quantity: 3 }],
    };

    const manualResult = manual.store.commitReservation(input);
    const assistantResult = viaAssistant.tools.create_reservation(input);
    assert.equal(manualResult.ok, true);
    assert.equal(assistantResult.ok, true);
    assert.deepEqual(manualResult.reservation, assistantResult.reservation);
    assert.deepEqual(manualResult.view, assistantResult.view);
    assert.deepEqual(manual.store.getState().reservations, viaAssistant.store.getState().reservations);
    assert.deepEqual(manual.store.getState().events, viaAssistant.store.getState().events);
    assert.deepEqual(
      selectors.kpis(manual.store.getState(), '2026-11-24'),
      selectors.kpis(viaAssistant.store.getState(), '2026-11-24'),
    );
  });

  test('the same over-booking is blocked through both paths with alternatives', () => {
    const manual = setup();
    const viaAssistant = setup();
    const state = manual.store.getState();
    const conflict = selectors.conflicts(state)[0];
    const input = {
      customerId: state.customers[0].id,
      start: conflict.from,
      end: conflict.to,
      items: [{ stockId: conflict.stockId, quantity: conflict.owned + 1 }],
    };
    const manualResult = manual.store.commitReservation(input);
    const assistantResult = viaAssistant.tools.create_reservation(input);
    assert.equal(manualResult.ok, false);
    assert.equal(assistantResult.ok, false);
    assert.equal(manualResult.code, assistantResult.code);
    assert.ok(manualResult.alternatives);
    assert.ok(assistantResult.alternatives);
    assert.equal(manual.store.getState().reservations.length, 300);
    assert.equal(viaAssistant.store.getState().reservations.length, 300);
  });
});
