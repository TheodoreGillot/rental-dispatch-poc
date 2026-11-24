'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const seed = require('../data/seed.json');
const { createStore } = require('../src/store.js');
const { createAssistantTools } = require('../src/assistant-tools.js');
const assistantApi = require('../src/assistant.js');
const selectors = require('../src/selectors.js');
const proposalsApi = require('../src/proposals.js');

const TODAY = '2026-11-24';
const CLOCK = () => '2026-11-24T09:00:00.000Z';

function setup() {
  const store = createStore(seed, { now: CLOCK });
  const tools = createAssistantTools({ store });
  const assistant = assistantApi.createAssistant({ getTools: () => tools });
  return { store, tools, assistant };
}

function freeItem(state, start, end, quantity = 1) {
  return state.equipment.find((item) => item.maintenance === 'ok'
    && selectors.availableQuantity(state, item.stockId, start, end) >= quantity);
}

function dayCount(state, date) {
  const parts = date.split('-').map(Number);
  const month = selectors.calendarMonth(state, parts[0], parts[1] - 1);
  return month.days.find((day) => day.date === date).count;
}

describe('check A: manual path changes every live view at once', () => {
  test('one commit updates calendar, matrix, list, KPIs and needs attention with one notification', () => {
    const { store } = setup();
    const state = store.getState();
    const item = freeItem(state, TODAY, TODAY, 2);
    let notifications = 0;
    store.subscribe(() => { notifications += 1; });
    const before = {
      day: dayCount(state, TODAY),
      matrix: selectors.matrixCell(state, item.stockId, TODAY).booked,
      list: selectors.reservationsFor(state, {}).length,
      kpis: selectors.kpis(state, TODAY),
      attention: selectors.needsAttention(state, TODAY).length,
    };
    const result = store.commitReservation({
      customerId: state.customers[0].id,
      start: TODAY,
      end: TODAY,
      items: [{ stockId: item.stockId, quantity: 2 }],
    });
    assert.equal(result.ok, true);
    const after = store.getState();
    assert.equal(notifications, 1);
    assert.equal(dayCount(after, TODAY), before.day + 1);
    assert.equal(selectors.matrixCell(after, item.stockId, TODAY).booked, before.matrix + 2);
    assert.ok(selectors.reservationsFor(after, { query: result.reservation.id }).length === 1);
    assert.equal(selectors.reservationsFor(after, {}).length, before.list + 1);
    assert.equal(selectors.kpis(after, TODAY).pickupsToday, before.kpis.pickupsToday + 1);
    assert.equal(selectors.kpis(after, TODAY).equipmentOutToday, before.kpis.equipmentOutToday + 2);
    const attention = selectors.needsAttention(after, TODAY);
    assert.equal(attention.length, before.attention + 1);
    assert.ok(attention.some((row) => row.reservationId === result.reservation.id));
  });
});

describe('check B: assistant path changes the same live views', () => {
  test('a confirmed assistant booking updates every selector with one notification', () => {
    const { store, assistant } = setup();
    const state = store.getState();
    const item = freeItem(state, TODAY, TODAY, 1);
    let notifications = 0;
    store.subscribe(() => { notifications += 1; });
    const before = {
      day: dayCount(state, TODAY),
      matrix: selectors.matrixCell(state, item.stockId, TODAY).booked,
      kpis: selectors.kpis(state, TODAY),
    };
    const ask = assistant.handle(`Book 1 × ${item.stockId} for Nordlys Film from ${TODAY} to ${TODAY}`);
    assert.equal(ask.pending.type, 'confirm-create');
    assert.equal(notifications, 0);
    const done = assistant.handle('yes');
    assert.equal(done.status, 'ok');
    const after = store.getState();
    const id = after.reservations.at(-1).id;
    assert.equal(notifications, 1);
    assert.equal(dayCount(after, TODAY), before.day + 1);
    assert.equal(selectors.matrixCell(after, item.stockId, TODAY).booked, before.matrix + 1);
    assert.equal(selectors.reservationsFor(after, { query: id }).length, 1);
    assert.equal(selectors.kpis(after, TODAY).pickupsToday, before.kpis.pickupsToday + 1);
    assert.equal(selectors.kpis(after, TODAY).equipmentOutToday, before.kpis.equipmentOutToday + 1);
  });
});

describe('check C: assistant cancel frees stock and creates a proposal', () => {
  test('matrix quantities fall and buildProposals contains the cancellation proposal', () => {
    const { store, assistant } = setup();
    const state = store.getState();
    const active = state.reservations.find((reservation) => reservation.status === 'confirmed' && reservation.items.length > 0);
    const row = active.items[0];
    const before = selectors.matrixCell(state, row.stockId, active.start).booked;
    let notifications = 0;
    store.subscribe(() => { notifications += 1; });
    assistant.handle(`Cancel ${active.id}`);
    const done = assistant.handle('yes');
    assert.equal(done.status, 'ok');
    assert.equal(notifications, 1);
    const after = store.getState();
    assert.equal(selectors.matrixCell(after, row.stockId, active.start).booked, before - row.quantity);
    const proposal = proposalsApi.buildProposals(after).find((item) => item.cancelledReservationId === active.id);
    assert.ok(proposal);
    assert.equal(proposal.reason, 'cancellation');
  });
});

describe('check D: over-booking is blocked on both paths', () => {
  test('manual and assistant both refuse the same over-booking with alternatives', () => {
    const { store, assistant } = setup();
    const state = store.getState();
    const conflict = selectors.conflicts(state)[0];
    const input = {
      customerId: state.customers[0].id,
      start: conflict.from,
      end: conflict.to,
      items: [{ stockId: conflict.stockId, quantity: conflict.owned + 1 }],
    };
    const manualCheck = selectors.checkItems(state, input);
    assert.equal(manualCheck.feasible, false);
    assert.ok(manualCheck.alternatives.dates.length > 0 || manualCheck.alternatives.items.length > 0);
    const manualWrite = store.commitReservation(input);
    assert.equal(manualWrite.ok, false);
    assert.equal(manualWrite.code, 'unavailable');

    const before = store.getState().reservations.length;
    const response = assistant.handle(`Book ${conflict.owned + 1} × ${conflict.stockId} for Nordlys Film from ${conflict.from} to ${conflict.to}`);
    assert.equal(response.status, 'error');
    assert.match(response.text, /overbook/);
    assert.ok(response.alternatives);
    assert.ok(response.alternatives.dates.length > 0 || response.alternatives.items.length > 0);
    assert.equal(store.getState().reservations.length, before);
  });
});
