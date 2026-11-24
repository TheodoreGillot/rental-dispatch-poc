'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const data = require('../src/data.js');
const summary = require('../src/summary.js');

describe('open reservations', () => {
  test('counts every booking that is not cancelled', () => {
    assert.equal(summary.openReservations(data), 6);
    const state = structuredClone(data);
    state.bookings.find((b) => b.id === 'B-1002').status = 'cancelled';
    assert.equal(summary.openReservations(state), 5);
  });
});

describe('equipment at capacity', () => {
  test('the documented rule counts maintenance plus bookings covering 2026-12-02', () => {
    const atCapacity = summary.equipmentAtCapacity(data).map((res) => res.id).sort();
    assert.deepEqual(atCapacity, [
      'CAM-Z-01', 'LENS-Z-24', 'LENS-Z-50', 'LIGHT-01', 'LIGHT-02', 'STUDIO-A', 'CAM-Z-BK',
    ].sort());
    assert.equal(atCapacity.length, 7);
  });

  test('the reference date changes the result using the same rule', () => {
    const atCapacity = summary.equipmentAtCapacity(data, '2026-12-18').map((res) => res.id).sort();
    assert.deepEqual(atCapacity, ['CAM-Z-01', 'CAM-Z-02', 'CAM-Z-03', 'LIGHT-01', 'STUDIO-B', 'CAM-Z-BK'].sort());
  });

  test('a cancelled booking no longer occupies its items', () => {
    const state = structuredClone(data);
    state.bookings.find((b) => b.id === 'B-1001').status = 'cancelled';
    const atCapacity = summary.equipmentAtCapacity(state).map((res) => res.id);
    assert.deepEqual(atCapacity, ['CAM-Z-BK']);
  });

  test('an invalid reference date gives an empty list rather than an exception', () => {
    assert.deepEqual(summary.equipmentAtCapacity(data, 'not-a-date'), []);
  });
});

describe('summaryStats', () => {
  test('re-plans run starts at 0 and is carried through', () => {
    assert.equal(summary.summaryStats(data).replansRun, 0);
    assert.equal(summary.summaryStats(data, 3).replansRun, 3);
    assert.equal(summary.DEMO_REFERENCE_DATE, '2026-12-02');
  });

  test('returns the three card values together', () => {
    const stats = summary.summaryStats(data, 2);
    assert.deepEqual(stats, { openReservations: 6, equipmentAtCapacity: 7, replansRun: 2 });
  });
});
