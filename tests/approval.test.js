'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const data = require('../src/data.js');
const solver = require('../src/solver.js');
const approval = require('../src/approval.js');

const jury = () => ({ ...data, waitlist: data.waitlist.filter((r) => r.id === 'W-2002') });
const juryReleased = () => data.bookings.find((b) => b.id === 'B-1002').assigned.filter((id) => id !== 'LENS-Z-85');

describe('isCurrentPlan (kit changed after solve)', () => {
  test('the same plan from a fresh solve of the same kit is current', () => {
    const shown = solver.solve(jury(), { bookingId: 'B-1002', releasedIds: data.bookings[1].assigned, question: '' });
    const fresh = solver.solve(jury(), { bookingId: 'B-1002', releasedIds: data.bookings[1].assigned, question: '' });
    assert.equal(approval.isCurrentPlan(shown.plans[0], fresh), true);
  });

  test('a plan shown for the full kit is stale once a lens is unticked', () => {
    const shown = solver.solve(jury(), { bookingId: 'B-1002', releasedIds: data.bookings[1].assigned, question: '' });
    const fresh = solver.solve(jury(), { bookingId: 'B-1002', releasedIds: juryReleased(), question: '' });
    assert.equal(approval.isCurrentPlan(shown.plans[0], fresh), false);
  });

  test('a plan whose id no longer exists in the fresh result is stale', () => {
    const shown = solver.solve(jury(), { bookingId: 'B-1002', releasedIds: data.bookings[1].assigned, question: '' });
    const empty = solver.solve(jury(), { bookingId: 'B-1002', releasedIds: [], question: '' });
    assert.equal(approval.isCurrentPlan(shown.plans[0], empty), false);
  });

  test('an edited plan object is not current even with the same id', () => {
    const solution = solver.solve(jury(), { bookingId: 'B-1002', releasedIds: data.bookings[1].assigned, question: '' });
    const edited = { ...solution.plans[0], filled: 0 };
    assert.equal(approval.isCurrentPlan(edited, solution), false);
  });
});

describe('approvalMessage', () => {
  test('a partial plan says the client must consent before the booking is confirmed', () => {
    const plan = { id: 'P1', status: 'partial', filled: 2, required: 3, cancelledBookingId: 'B-1003', requestId: 'W-2003' };
    const text = approval.approvalMessage(plan);
    assert.ok(text.includes('The client must consent before the booking is confirmed.'), text);
    assert.ok(!text.includes('re-let'), text);
    assert.ok(!text.includes('as a new booking'), text);
  });

  test('a full plan says the request is re-let as a new booking', () => {
    const plan = { id: 'P1', status: 'full', filled: 6, required: 6, cancelledBookingId: 'B-1001', requestId: 'W-2001' };
    assert.match(approval.approvalMessage(plan), /W-2001 re-let as a new booking/);
  });
});
