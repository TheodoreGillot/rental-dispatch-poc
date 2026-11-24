/*
 * Acceptance checks A–E, runnable in Node with no browser:
 *   node tools/checks.js
 *
 * A and B prove that one write changes calendar counts, matrix cells, the
 * reservation list, KPIs and needs attention, with exactly one notification.
 * C proves an assistant cancellation frees stock and creates a proposal.
 * D proves both paths block an over-booking and return alternatives.
 * E reports the median solver time for the first pending seed proposal (200 runs).
 */
'use strict';

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
  const [year, month] = date.split('-').map(Number);
  const monthView = selectors.calendarMonth(state, year, month - 1);
  return monthView.days.find((day) => day.date === date).count;
}

function snapshot(state, itemId) {
  return {
    calendarDayCount: dayCount(state, TODAY),
    matrixBooked: selectors.matrixCell(state, itemId, TODAY).booked,
    reservationList: selectors.reservationsFor(state, {}).length,
    kpis: selectors.kpis(state, TODAY),
    needsAttention: selectors.needsAttention(state, TODAY).length,
  };
}

function print(title, data) {
  process.stdout.write(`\n${title}\n${JSON.stringify(data, null, 2)}\n`);
}

function checkA() {
  const { store } = setup();
  const state = store.getState();
  const item = freeItem(state, TODAY, TODAY, 2);
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });
  const before = snapshot(state, item.stockId);
  const result = store.commitReservation({
    customerId: state.customers[0].id,
    start: TODAY,
    end: TODAY,
    items: [{ stockId: item.stockId, quantity: 2 }],
  });
  assert.equal(result.ok, true);
  const after = snapshot(store.getState(), item.stockId);
  assert.equal(notifications, 1);
  assert.equal(after.calendarDayCount, before.calendarDayCount + 1);
  assert.equal(after.matrixBooked, before.matrixBooked + 2);
  assert.equal(after.reservationList, before.reservationList + 1);
  assert.equal(after.kpis.pickupsToday, before.kpis.pickupsToday + 1);
  assert.equal(after.kpis.equipmentOutToday, before.kpis.equipmentOutToday + 2);
  assert.equal(after.needsAttention, before.needsAttention + 1);
  print('A. Manual path', {
    created: result.reservation.id,
    item: item.stockId,
    notifications,
    before,
    after,
  });
}

function checkB() {
  const { store, assistant } = setup();
  const state = store.getState();
  const item = freeItem(state, TODAY, TODAY, 1);
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });
  const before = snapshot(state, item.stockId);
  const ask = assistant.handle(`Book 1 × ${item.stockId} for Nordlys Film from ${TODAY} to ${TODAY}`);
  assert.equal(ask.pending.type, 'confirm-create');
  assert.equal(notifications, 0);
  const done = assistant.handle('yes');
  assert.equal(done.status, 'ok');
  const after = snapshot(store.getState(), item.stockId);
  const id = store.getState().reservations.at(-1).id;
  assert.equal(notifications, 1);
  assert.equal(after.calendarDayCount, before.calendarDayCount + 1);
  assert.equal(after.matrixBooked, before.matrixBooked + 1);
  assert.equal(after.reservationList, before.reservationList + 1);
  assert.equal(after.kpis.pickupsToday, before.kpis.pickupsToday + 1);
  assert.equal(after.kpis.equipmentOutToday, before.kpis.equipmentOutToday + 1);
  assert.equal(after.needsAttention, before.needsAttention + 1);
  print('B. Assistant path', {
    created: id,
    item: item.stockId,
    notifications,
    before,
    after,
  });
}

function checkC() {
  const { store, assistant } = setup();
  const state = store.getState();
  const active = state.reservations.find((reservation) => reservation.status === 'confirmed' && reservation.items.length > 0);
  const row = active.items[0];
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });
  const before = selectors.matrixCell(state, row.stockId, active.start).booked;
  assistant.handle(`Cancel ${active.id}`);
  const done = assistant.handle('yes');
  assert.equal(done.status, 'ok');
  assert.equal(notifications, 1);
  const afterState = store.getState();
  const after = selectors.matrixCell(afterState, row.stockId, active.start).booked;
  const proposal = proposalsApi.buildProposals(afterState).find((item) => item.cancelledReservationId === active.id);
  assert.equal(after, before - row.quantity);
  assert.ok(proposal);
  print('C. Assistant cancel', {
    cancelled: active.id,
    item: row.stockId,
    date: active.start,
    matrixBookedBefore: before,
    matrixBookedAfter: after,
    freedQuantity: row.quantity,
    notifications,
    proposal: { id: proposal.id, reason: proposal.reason, status: proposal.status, feasibility: proposal.feasibility },
  });
}

function checkD() {
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
  const manualWrite = store.commitReservation(input);
  assert.equal(manualCheck.feasible, false);
  assert.equal(manualWrite.ok, false);
  assert.ok(manualCheck.alternatives.dates.length > 0 || manualCheck.alternatives.items.length > 0);

  const beforeCount = store.getState().reservations.length;
  const response = assistant.handle(`Book ${conflict.owned + 1} × ${conflict.stockId} for Nordlys Film from ${conflict.from} to ${conflict.to}`);
  assert.equal(response.status, 'error');
  assert.ok(response.alternatives);
  assert.equal(store.getState().reservations.length, beforeCount);
  print('D. Over-booking blocked on both paths', {
    stock: conflict.stockId,
    dates: `${conflict.from} to ${conflict.to}`,
    requested: conflict.owned + 1,
    owned: conflict.owned,
    manual: {
      blocked: manualWrite.ok === false,
      code: manualWrite.code,
      shortBy: manualCheck.items[0].short,
      alternativeDates: manualCheck.alternatives.dates.length,
      equivalentItems: manualCheck.alternatives.items.flatMap((item) => item.alternatives).length,
    },
    assistant: {
      blocked: response.status === 'error',
      text: response.text.split('.')[0],
      alternativeDates: (response.alternatives.dates || []).length,
      equivalentItems: (response.alternatives.items || []).flatMap((item) => item.alternatives || []).length,
    },
    reservationsBefore: beforeCount,
    reservationsAfter: store.getState().reservations.length,
  });
}

function checkE() {
  const store = createStore(seed, { now: CLOCK });
  const state = store.getState();
  const samples = [];
  const buildTimes = [];
  let firstId = null;
  for (let index = 0; index < 200; index += 1) {
    const started = performance.now();
    const proposals = proposalsApi.buildProposals(state);
    buildTimes.push(performance.now() - started);
    const first = proposals.find((proposal) => proposal.status === 'pending');
    if (!first) throw new Error('No pending proposal in the seed state');
    firstId = first.id;
    samples.push(first.solverMs);
  }
  samples.sort((a, b) => a - b);
  buildTimes.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const buildMedian = buildTimes[Math.floor(buildTimes.length / 2)];
  const proposals = proposalsApi.buildProposals(state);
  print('E. Solver time, default scenario', {
    firstPendingProposal: firstId,
    runs: samples.length,
    solverMedianMs: Number(median.toFixed(3)),
    solverMinMs: Number(samples[0].toFixed(3)),
    solverMaxMs: Number(samples[samples.length - 1].toFixed(3)),
    buildProposalsMedianMs: Number(buildMedian.toFixed(3)),
    proposalCount: proposals.length,
    pendingCount: proposals.filter((proposal) => proposal.status === 'pending').length,
    conflictCount: selectors.conflicts(state).length,
  });
  return { medianMs: median, firstId };
}

process.stdout.write('Atelier Lumière acceptance checks\n');
process.stdout.write(`Seed: ${seed.equipment.length} equipment, ${seed.customers.length} customers, ${seed.reservations.length} reservations\n`);
checkA();
checkB();
checkC();
checkD();
const e = checkE();
process.stdout.write(`\nAll A–D assertions passed. E solver median: ${e.medianMs.toFixed(3)} ms for ${e.firstId}.\n`);
