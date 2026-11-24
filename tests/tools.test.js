'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const data = require('../src/data.js');
const tools = require('../src/tools.js');

// The assistant searches the whole demo waitlist, so the tools are given both lists.
function demoState() {
  const state = structuredClone(data);
  state.waitlist = [...state.waitlist, ...state.overflowWaitlist];
  return state;
}

function freshTools() {
  return tools.createTools(demoState);
}

function booking(id) {
  return data.bookings.find((b) => b.id === id);
}

describe('cancel_reservation', () => {
  test('returns the released items for a cancellable booking without changing state', () => {
    const state = demoState();
    const before = structuredClone(state);
    const result = freshTools().cancel_reservation('B-1001');
    assert.equal(result.ok, true);
    assert.equal(result.bookingId, 'B-1001');
    assert.equal(result.client, 'Client A (fictional)');
    assert.deepEqual(result.releasedIds, booking('B-1001').assigned);
    assert.equal(result.released.length, 6);
    assert.ok(result.released.every((item) => item.id && item.label && item.kind));
    assert.deepEqual(state, before);
  });

  test('an unknown id returns an error object, not a crash', () => {
    const result = freshTools().cancel_reservation('B-9999');
    assert.equal(result.ok, false);
    assert.match(result.error, /No reservation B-9999 exists/);
  });

  test('a cancelled booking is refused', () => {
    const state = demoState();
    state.bookings.find((b) => b.id === 'B-1001').status = 'cancelled';
    const result = tools.createTools(state).cancel_reservation('B-1001');
    assert.equal(result.ok, false);
    assert.match(result.error, /already cancelled/);
  });

  test('a booking with no items is refused', () => {
    const state = demoState();
    state.bookings.find((b) => b.id === 'B-1001').assigned = [];
    const result = tools.createTools(state).cancel_reservation('B-1001');
    assert.equal(result.ok, false);
    assert.match(result.error, /no items to release/);
  });

  test('a missing id is refused with guidance', () => {
    const result = freshTools().cancel_reservation('');
    assert.equal(result.ok, false);
    assert.match(result.error, /reservation id is required/i);
  });
});

describe('solve_replan', () => {
  test('the happy path returns a feasible full plan with solver moves', () => {
    const result = freshTools().solve_replan('B-1001', booking('B-1001').assigned);
    assert.equal(result.ok, true);
    assert.equal(result.feasible, true);
    assert.equal(result.outcome, 'full');
    assert.equal(result.moves.length, 6);
    assert.equal(result.missing.length, 0);
    assert.deepEqual(result.handoffs, []);
    assert.equal(result.plan.requestId, 'W-2001');
    assert.equal(result.plan.filled, 6);
    assert.equal(result.plan.required, 6);
    assert.equal(typeof result.solverMs, 'number');
    assert.ok(result.solverMs >= 0);
    assert.ok(result.moves.every((move) => move.requestId === 'W-2001'));
  });

  test('the partial edge scenario reports missing items and only solver-returned moves', () => {
    const result = freshTools().solve_replan('B-1003', booking('B-1003').assigned);
    assert.equal(result.feasible, true);
    assert.equal(result.outcome, 'partial');
    assert.equal(result.plan.filled, 2);
    assert.equal(result.plan.required, 3);
    assert.equal(result.moves.length, 2);
    assert.deepEqual(result.moves.map((move) => move.resourceId).sort(), ['CAM-Z-03', 'LENS-Z-24']);
    assert.equal(result.missing.length, 1);
  });

  test('the no-plan scenario returns feasible false with no moves', () => {
    const result = freshTools().solve_replan('B-1000', booking('B-1000').assigned);
    assert.equal(result.ok, true);
    assert.equal(result.feasible, false);
    assert.equal(result.outcome, 'none');
    assert.deepEqual(result.moves, []);
    assert.equal(result.missing.length, 1);
    assert.match(result.reason, /Missing 1 x camera/);
    assert.match(result.reason, /CAM-EF-01: mount EF does not fit request mount Z/);
    assert.match(result.reason, /CAM-Z-BK: in maintenance until 2026-12-20/);
  });

  test('only waitlist requests whose dates overlap the cancelled booking are searched', () => {
    // W-2002 is waiting for 2026-12-10 to 12-12, far from B-1001 (12-02 to 12-04).
    const result = freshTools().solve_replan('B-1001', booking('B-1001').assigned);
    assert.equal(result.plan.requestId, 'W-2001');
    assert.ok(result.moves.every((move) => move.requestId === 'W-2001'));
  });

  test('an unknown booking returns an error', () => {
    const result = freshTools().solve_replan('B-9999', []);
    assert.equal(result.ok, false);
    assert.match(result.error, /No reservation B-9999 exists/);
  });

  test('a released id outside the booking is refused', () => {
    const result = freshTools().solve_replan('B-1001', ['CAM-Z-02']);
    assert.equal(result.ok, false);
    assert.match(result.error, /Not part of reservation B-1001: CAM-Z-02/);
  });

  test('an empty release list yields a truthful no-plan result', () => {
    const result = freshTools().solve_replan('B-1001', []);
    assert.equal(result.ok, true);
    assert.equal(result.feasible, false);
    assert.deepEqual(result.moves, []);
    assert.match(result.reason, /every item of the booking is held/);
  });
});

describe('check_availability', () => {
  test('lists free ids and reasons for blocked items', () => {
    const result = freshTools().check_availability('camera', '2026-12-05', '2026-12-07');
    assert.equal(result.ok, true);
    assert.equal(result.resourceKind, 'camera');
    assert.deepEqual(result.available, ['CAM-EF-01', 'CAM-Z-02', 'CAM-Z-03']);
    const reasons = result.unavailable.map((item) => `${item.id}: ${item.reason}`).join(' ');
    assert.match(reasons, /CAM-Z-01: booked as B-1001/);
    assert.match(reasons, /CAM-Z-BK: in maintenance until 2026-12-20/);
  });

  test('a supplied mount filters incompatible kit', () => {
    const result = freshTools().check_availability('camera', '2026-12-05', '2026-12-07', 'Z');
    assert.deepEqual(result.available, ['CAM-Z-02', 'CAM-Z-03']);
    assert.match(result.unavailable.find((item) => item.id === 'CAM-EF-01').reason, /mount EF does not fit request mount Z/);
  });

  test('a lowercase mount is treated the same as uppercase', () => {
    const lower = freshTools().check_availability('camera', '2026-12-05', '2026-12-07', 'z');
    const upper = freshTools().check_availability('camera', '2026-12-05', '2026-12-07', 'Z');
    assert.deepEqual(lower.available, upper.available);
    assert.deepEqual(lower.unavailable, upper.unavailable);
  });

  test('a fully blocked range has no available ids', () => {
    const result = freshTools().check_availability('camera', '2026-12-18', '2026-12-19');
    assert.deepEqual(result.available, []);
    assert.match(result.unavailable.find((item) => item.id === 'CAM-Z-03').reason, /booked as B-1003/);
  });

  test('staff-held kit is unavailable with the hold reason', () => {
    const state = demoState();
    const held = state.bookings.find((b) => b.id === 'B-1002');
    held.status = 'cancelled';
    held.held = ['LENS-Z-85'];
    const result = tools.createTools(state).check_availability('lens', '2026-12-05', '2026-12-07');
    assert.ok(!result.available.includes('LENS-Z-85'));
    assert.match(result.unavailable.find((item) => item.id === 'LENS-Z-85').reason, /held by staff/);
  });

  test('invalid dates and backwards ranges return an error object', () => {
    for (const [start, end] of [['2026-02-30', '2026-03-01'], ['2026-12-07', '2026-12-05'], ['tomorrow', '2026-12-05']]) {
      const result = freshTools().check_availability('camera', start, end);
      assert.equal(result.ok, false, `${start} to ${end}`);
      assert.ok(result.error.length > 0);
    }
  });

  test('an unknown kind returns an empty, truthful report', () => {
    const result = freshTools().check_availability('drone', '2026-12-05', '2026-12-07');
    assert.equal(result.ok, true);
    assert.deepEqual(result.available, []);
    assert.deepEqual(result.unavailable, []);
  });
});
