'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const data = require('../src/data.js');
const solver = require('../src/solver.js');

function scenario(id) {
  return data.scenarios.find((s) => s.id === id);
}

function stateFor(sc) {
  return { ...data, waitlist: data.waitlist.filter((r) => sc.waitlistIds.includes(r.id)) };
}

// Runs a seeded scenario; releasedIds defaults to the whole cancelled booking.
function runScenario(id, releasedIds) {
  const sc = scenario(id);
  const booking = data.bookings.find((b) => b.id === sc.cancellation.bookingId);
  return solver.solve(stateFor(sc), {
    bookingId: booking.id,
    question: sc.cancellation.question,
    releasedIds: releasedIds || booking.assigned,
  });
}

// Minimal hand-made inventory for boundary tests.
function miniState({ resources, bookings = [], waitlist }) {
  const released = {
    id: 'B-X', client: 'Client X (fictional)', start: '2026-11-01', end: '2026-11-02',
    mount: 'Z', status: 'confirmed', assigned: ['CAM-T'],
  };
  return { resources, bookings: [released, ...bookings], waitlist, clauses: data.clauses };
}

const CAM_T = { id: 'CAM-T', kind: 'camera', mount: 'Z', label: 'Test body', status: 'ok' };
const requestNeeding = (start, end, count = 1) => ({
  id: 'W-1', client: 'Client Y (fictional)', start, end, mount: 'Z',
  needs: [{ kind: 'camera', count }],
});
const holdingBooking = (start, end, assigned) => ({
  id: 'B-O', client: 'Client Z (fictional)', start, end, mount: 'Z', status: 'confirmed', assigned,
});
const solveMini = (state) => solver.solve(state, { bookingId: 'B-X', releasedIds: ['CAM-T'], question: '' });

describe('normal behaviour', () => {
  test('happy path re-lets the freed kit and studio to the waitlisted client', () => {
    const result = runScenario('happy-path');
    assert.equal(result.outcome, 'full');
    const [plan] = result.plans;
    assert.equal(plan.requestId, 'W-2001');
    assert.equal(plan.client, 'Client F (fictional)');
    assert.deepEqual(
      plan.actions.map((a) => a.resourceId).sort(),
      ['CAM-Z-01', 'LENS-Z-24', 'LENS-Z-50', 'LIGHT-01', 'LIGHT-02', 'STUDIO-A'],
    );
    assert.ok(plan.actions.every((a) => a.source === 'released'));
    assert.equal(plan.freeStockCount, 0);
    assert.ok(plan.changes.some((c) => c.client === 'Client A (fictional)' && c.text.includes('cancelled')));
    assert.ok(!plan.open.some((line) => line.startsWith('Released but not used')));
    assert.deepEqual(result.handoffs, []);
  });

  test('solver does not mutate the state it is given', () => {
    const state = stateFor(scenario('happy-path'));
    const before = structuredClone(state);
    solver.solve(state, { bookingId: 'B-1001', releasedIds: data.bookings[0].assigned, question: '' });
    assert.deepEqual(state, before);
  });

  test('solver does not mutate its input on the validation, duplicate-need and held-kit paths', () => {
    const invalid = miniState({ resources: [CAM_T], waitlist: [requestNeeding('2026-11-07', '2026-11-06')] });
    const duplicate = miniState({
      resources: [CAM_T],
      waitlist: [{ ...requestNeeding('2026-11-06', '2026-11-07'), needs: [{ kind: 'camera', count: 1 }, { kind: 'camera', count: 1 }] }],
    });
    const held = stateFor(scenario('jury-kit-mix'));
    for (const [state, cancellation] of [
      [invalid, { bookingId: 'B-X', releasedIds: ['CAM-T'], question: 'Can I get a refund?' }],
      [duplicate, { bookingId: 'B-X', releasedIds: ['CAM-T'], question: '' }],
      [held, { bookingId: 'B-1002', releasedIds: ['CAM-Z-02'], question: '' }],
    ]) {
      const before = structuredClone(state);
      solver.solve(state, cancellation);
      assert.deepEqual(state, before);
    }
  });

  test('seed bookings never double-book an item inside the buffer', () => {
    const active = data.bookings;
    for (const res of data.resources) {
      const holds = active.filter((b) => b.assigned.includes(res.id));
      for (let i = 0; i < holds.length; i += 1) {
        for (let j = i + 1; j < holds.length; j += 1) {
          assert.equal(
            solver.overlapsWithBuffer(holds[i], holds[j], solver.BUFFER_DAYS),
            false,
            `${res.id} double-booked by ${holds[i].id} and ${holds[j].id}`,
          );
        }
      }
    }
  });
});

describe('boundaries', () => {
  test('item is available when the gap is exactly the buffer', () => {
    // Other booking ends 2026-11-04; buffer 1 day blocks 11-05 only.
    const state = miniState({
      resources: [CAM_T],
      bookings: [holdingBooking('2026-11-02', '2026-11-04', ['CAM-T'])],
      waitlist: [requestNeeding('2026-11-06', '2026-11-07')],
    });
    const result = solveMini(state);
    assert.equal(result.outcome, 'full');
    assert.equal(result.plans[0].actions[0].resourceId, 'CAM-T');
  });

  test('item is blocked when the gap is one day short of the buffer', () => {
    const state = miniState({
      resources: [CAM_T],
      bookings: [holdingBooking('2026-11-02', '2026-11-04', ['CAM-T'])],
      waitlist: [requestNeeding('2026-11-05', '2026-11-07')],
    });
    const result = solveMini(state);
    assert.equal(result.outcome, 'none');
    assert.match(result.reason, /inside the 1-day buffer/);
  });

  test('buffer applies before a later booking as well', () => {
    const ok = miniState({
      resources: [CAM_T],
      bookings: [holdingBooking('2026-11-10', '2026-11-12', ['CAM-T'])],
      waitlist: [requestNeeding('2026-11-07', '2026-11-08')],
    });
    const clash = miniState({
      resources: [CAM_T],
      bookings: [holdingBooking('2026-11-10', '2026-11-12', ['CAM-T'])],
      waitlist: [requestNeeding('2026-11-08', '2026-11-09')],
    });
    assert.equal(solveMini(ok).outcome, 'full');
    assert.equal(solveMini(clash).outcome, 'none');
  });

  test('maintenance returning on the pickup day still blocks the item', () => {
    const body = { ...CAM_T, id: 'CAM-M', status: 'maintenance', maintenanceUntil: '2026-11-05' };
    const state = miniState({
      resources: [CAM_T, body],
      waitlist: [{ ...requestNeeding('2026-11-05', '2026-11-06', 2) }],
    });
    const result = solveMini(state);
    assert.equal(result.outcome, 'partial');
    assert.match(result.reason, /CAM-M: in maintenance until 2026-11-05/);
  });

  test('maintenance returning the day before pickup allows the item', () => {
    const body = { ...CAM_T, id: 'CAM-M', status: 'maintenance', maintenanceUntil: '2026-11-04' };
    const state = miniState({
      resources: [CAM_T, body],
      waitlist: [{ ...requestNeeding('2026-11-05', '2026-11-06', 2) }],
    });
    assert.equal(solveMini(state).outcome, 'full');
  });
});

describe('failure modes', () => {
  test('no candidate for a needed kind returns an explicit no-plan reason', () => {
    const state = miniState({
      resources: [CAM_T],
      waitlist: [{
        id: 'W-9', client: 'Client Y (fictional)', start: '2026-11-05', end: '2026-11-06', mount: 'Z',
        needs: [{ kind: 'audio', count: 1 }],
      }],
    });
    const result = solveMini(state);
    assert.equal(result.outcome, 'none');
    assert.equal(result.plans.length, 0);
    assert.match(result.reason, /No feasible plan/);
    assert.match(result.reason, /W-9: Missing 1 x audio: no audio item in inventory/);
  });

  test('backup body in maintenance gives an explicit reason and the next-best partial plan', () => {
    const result = runScenario('backup-and-refund');
    assert.equal(result.outcome, 'partial');
    assert.match(result.reason, /No full re-plan/);
    assert.match(result.reason, /CAM-Z-BK: in maintenance until 2026-12-20, after pickup on 2026-12-18/);

    const [plan] = result.plans;
    assert.equal(plan.status, 'partial');
    assert.deepEqual(plan.actions.map((a) => a.resourceId).sort(), ['CAM-Z-03', 'LENS-Z-24']);
    assert.ok(plan.open.some((line) => line.startsWith('Partial kit: client consent needed')));
  });

  test('every released item held by staff yields an explicit no-plan result', () => {
    const result = runScenario('happy-path', []);
    assert.equal(result.outcome, 'none');
    assert.match(result.reason, /every item of the booking is held/);
  });

  test('unknown booking id returns an explicit no-plan result', () => {
    const sc = scenario('happy-path');
    const result = solver.solve(stateFor(sc), { bookingId: 'B-9999', releasedIds: [], question: '' });
    assert.equal(result.outcome, 'none');
    assert.match(result.reason, /No active booking B-9999/);
  });

  test('empty waitlist returns an explicit no-plan result', () => {
    const state = { ...data, waitlist: [] };
    const result = solver.solve(state, { bookingId: 'B-1001', releasedIds: data.bookings[0].assigned, question: '' });
    assert.equal(result.outcome, 'none');
    assert.match(result.reason, /The waitlist is empty/);
  });
});

describe('input validation: dates and ranges', () => {
  const baseRequest = requestNeeding('2026-11-06', '2026-11-07');
  const withRequest = (request, bookings = []) => miniState({ resources: [CAM_T], bookings, waitlist: [request] });

  test('an invalid booking date is an explicit no-plan result, never a free item', () => {
    const result = solveMini(withRequest(baseRequest, [holdingBooking('2026-02-30', '2026-11-04', ['CAM-T'])]));
    assert.equal(result.outcome, 'none');
    assert.equal(result.plans.length, 0);
    assert.ok(result.reason.includes('Booking B-O has an invalid start date "2026-02-30"'), result.reason);
  });

  test('an invalid booking end date is named in the reason', () => {
    const result = solveMini(withRequest(baseRequest, [holdingBooking('2026-11-02', '2026-11-31', ['CAM-T'])]));
    assert.equal(result.outcome, 'none');
    assert.ok(result.reason.includes('Booking B-O has an invalid end date "2026-11-31"'), result.reason);
  });

  test('invalid request start or end dates return an explicit no-plan result naming the field and value', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2026-1-5', ' 2026-11-06', '2026-11-06T00:00:00Z', 'tomorrow', '']) {
      const start = solveMini(withRequest({ ...baseRequest, start: bad }));
      assert.equal(start.outcome, 'none', bad);
      assert.ok(start.reason.includes(`Request W-1 has an invalid start date "${bad}"`), start.reason);

      const end = solveMini(withRequest({ ...baseRequest, end: bad }));
      assert.equal(end.outcome, 'none', bad);
      assert.ok(end.reason.includes(`Request W-1 has an invalid end date "${bad}"`), end.reason);
    }
  });

  test('a real leap day is accepted and an impossible one is rejected', () => {
    const leap = solveMini(withRequest(requestNeeding('2028-02-29', '2028-03-01')));
    assert.equal(leap.outcome, 'full');
    const impossible = solveMini(withRequest(requestNeeding('2026-02-29', '2026-03-01')));
    assert.equal(impossible.outcome, 'none');
    assert.ok(impossible.reason.includes('invalid start date "2026-02-29"'));
  });

  test('an invalid maintenanceUntil date is an explicit no-plan result naming the item and value', () => {
    const body = { ...CAM_T, id: 'CAM-M', status: 'maintenance', maintenanceUntil: '2026-99-01' };
    const result = solveMini(miniState({ resources: [CAM_T, body], waitlist: [baseRequest] }));
    assert.equal(result.outcome, 'none');
    assert.ok(result.reason.includes('Resource CAM-M has an invalid maintenanceUntil date "2026-99-01"'), result.reason);
  });

  test('a maintenance item with no return date is unavailable, not free', () => {
    const body = { ...CAM_T, id: 'CAM-M', status: 'maintenance' };
    const result = solveMini(miniState({ resources: [CAM_T, body], waitlist: [requestNeeding('2026-11-05', '2026-11-06', 2)] }));
    assert.equal(result.outcome, 'partial');
    assert.ok(result.plans[0].actions.every((a) => a.resourceId !== 'CAM-M'));
    assert.match(result.reason, /CAM-M: in maintenance with no return date, not offered/);
  });

  test('an unknown status is unavailable, not free', () => {
    const body = { ...CAM_T, id: 'CAM-X', status: 'broken' };
    const result = solveMini(miniState({ resources: [CAM_T, body], waitlist: [requestNeeding('2026-11-05', '2026-11-06', 2)] }));
    assert.equal(result.outcome, 'partial');
    assert.ok(result.plans[0].actions.every((a) => a.resourceId !== 'CAM-X'));
    assert.match(result.reason, /CAM-X: unknown status "broken", not offered/);
  });

  test('a request that ends before it starts returns an explicit no-plan result', () => {
    const result = solveMini(withRequest(requestNeeding('2026-11-07', '2026-11-06')));
    assert.equal(result.outcome, 'none');
    assert.match(result.reason, /Request W-1 ends on 2026-11-06, before it starts on 2026-11-07/);
  });

  test('a booking that ends before it starts returns an explicit no-plan result', () => {
    const result = solveMini(withRequest(baseRequest, [holdingBooking('2026-11-04', '2026-11-02', ['CAM-T'])]));
    assert.equal(result.outcome, 'none');
    assert.match(result.reason, /Booking B-O ends on 2026-11-02, before it starts on 2026-11-04/);
  });
});

describe('input validation: counts and empty needs', () => {
  const CAM_U = { ...CAM_T, id: 'CAM-U' };
  const withCount = (count) => miniState({
    resources: [CAM_T, CAM_U],
    waitlist: [requestNeeding('2026-11-06', '2026-11-07', count)],
  });

  test('a negative count returns no plan and does not assign all stock', () => {
    const result = solveMini(withCount(-1));
    assert.equal(result.outcome, 'none');
    assert.equal(result.plans.length, 0);
    assert.match(result.reason, /asks for -1 x camera: the count must be a positive integer/);
  });

  test('a fractional count returns no plan and does not assign all stock', () => {
    const result = solveMini(withCount(1.5));
    assert.equal(result.outcome, 'none');
    assert.equal(result.plans.length, 0);
    assert.match(result.reason, /asks for 1.5 x camera/);
  });

  test('a string count is rejected rather than coerced', () => {
    assert.equal(solveMini(withCount('2')).outcome, 'none');
  });

  test('a zero count returns no plan with a non-empty reason', () => {
    const result = solveMini(withCount(0));
    assert.equal(result.outcome, 'none');
    assert.match(result.reason, /no items requested/);
  });

  test('a request with no needs returns no plan with a non-empty reason', () => {
    const request = { ...requestNeeding('2026-11-06', '2026-11-07'), needs: [] };
    const result = solveMini(miniState({ resources: [CAM_T], waitlist: [request] }));
    assert.equal(result.outcome, 'none');
    assert.match(result.reason, /Request W-1 has no items requested/);
  });
});

describe('duplicate-kind needs', () => {
  const twoCameras = () => ({
    ...requestNeeding('2026-11-06', '2026-11-07'),
    needs: [{ kind: 'camera', count: 1 }, { kind: 'camera', count: 1 }],
  });

  test('two needs of the same kind never reuse one item', () => {
    const state = miniState({ resources: [CAM_T], waitlist: [twoCameras()] });
    const result = solveMini(state);
    assert.equal(result.outcome, 'partial');
    assert.deepEqual(result.plans[0].actions.map((a) => a.resourceId), ['CAM-T']);
    assert.match(result.reason, /CAM-T: already assigned to this request/);
  });

  test('two needs of the same kind get two distinct items when two are free', () => {
    const state = miniState({ resources: [CAM_T, { ...CAM_T, id: 'CAM-U' }], waitlist: [twoCameras()] });
    const result = solveMini(state);
    assert.equal(result.outcome, 'full');
    assert.deepEqual(result.plans[0].actions.map((a) => a.resourceId).sort(), ['CAM-T', 'CAM-U']);
  });
});

describe('kit selection (jury input)', () => {
  test('a lens held back by staff is not offered and a free-stock substitute is used', () => {
    const released = data.bookings.find((b) => b.id === 'B-1002').assigned.filter((id) => id !== 'LENS-Z-85');
    const result = runScenario('jury-kit-mix', released);
    assert.equal(result.outcome, 'full');
    const [plan] = result.plans;
    const lens = plan.actions.find((a) => a.kind === 'lens');
    assert.equal(lens.resourceId, 'LENS-Z-24');
    assert.equal(lens.source, 'free stock');
    assert.ok(!plan.actions.some((a) => a.resourceId === 'LENS-Z-85'));
    assert.ok(plan.checks.includes('Staff hold: not offered LENS-Z-85'));
  });

  test('with the full kit selected, the released lens is used first', () => {
    const result = runScenario('jury-kit-mix');
    const lens = result.plans[0].actions.find((a) => a.kind === 'lens');
    assert.equal(lens.resourceId, 'LENS-Z-85');
    assert.equal(lens.source, 'released');
  });
});

describe('ranking', () => {
  test('equal share ranks the plan with fewer free-stock items first, ahead of an earlier waitlist position', () => {
    const resources = [CAM_T, { ...CAM_T, id: 'CAM-E', mount: 'EF' }, { ...CAM_T, id: 'CAM-F' }];
    const earlierEf = { id: 'W-A', client: 'Client A (fictional)', start: '2026-11-06', end: '2026-11-07', mount: 'EF', needs: [{ kind: 'camera', count: 1 }] };
    const laterZ = { id: 'W-B', client: 'Client B (fictional)', start: '2026-11-06', end: '2026-11-07', mount: 'Z', needs: [{ kind: 'camera', count: 1 }] };
    const result = solveMini(miniState({ resources, waitlist: [earlierEf, laterZ] }));
    assert.deepEqual(result.plans.map((p) => p.requestId), ['W-B', 'W-A']);
    assert.equal(result.plans[0].freeStockCount, 0);
    assert.equal(result.plans[1].freeStockCount, 1);
  });
});

describe('hand-off routing', () => {
  test('refund question goes to a human with the refund clause text', () => {
    const [handoff] = solver.routeHandoffs('Can I get a refund of my deposit?', data.clauses);
    assert.equal(handoff.topic, 'refund');
    assert.equal(handoff.clause.id, 'CL-4.2');
    assert.equal(handoff.clause.text, data.clauses['CL-4.2'].text);
    assert.match(handoff.reason, /human/);
  });

  test('cancellation fee and contract questions are routed too', () => {
    assert.equal(solver.routeHandoffs('What is the cancellation fee?', data.clauses)[0].topic, 'cancellation fee');
    assert.equal(solver.routeHandoffs('Does the contract cover this?', data.clauses)[0].topic, 'contract question');
  });

  test('liable, liability and liabilities route to the contract clause CL-9.1', () => {
    const [handoff] = solver.routeHandoffs('Who is liable for damage?', data.clauses);
    assert.equal(handoff.topic, 'contract question');
    assert.equal(handoff.clause.id, 'CL-9.1');
    assert.equal(handoff.clause.text, data.clauses['CL-9.1'].text);
    for (const question of ['Who has liability for damage?', 'Who bears the liabilities?']) {
      assert.equal(solver.routeHandoffs(question, data.clauses)[0].clause.id, 'CL-9.1', question);
    }
  });

  test('an empty or missing question routes nothing', () => {
    assert.deepEqual(solver.routeHandoffs('', data.clauses), []);
    assert.deepEqual(solver.routeHandoffs('   ', data.clauses), []);
    assert.deepEqual(solver.routeHandoffs(undefined, data.clauses), []);
  });

  test('an ordinary question with no rule match still goes to a human, without a clause', () => {
    const [handoff] = solver.routeHandoffs('Can I change the pickup time?', data.clauses);
    assert.equal(handoff.topic, 'unclassified question');
    assert.equal(handoff.clause, null);
  });

  test('the edge scenario lists the refund hand-off and the open decision on the plan', () => {
    const result = runScenario('backup-and-refund');
    assert.deepEqual(result.handoffs.map((h) => h.topic), ['refund']);
    assert.ok(result.plans[0].open.includes('Human decision pending: refund (clause CL-4.2)'));
  });

  test('an unclassified question is listed as a pending human decision on the plan', () => {
    const state = stateFor(scenario('happy-path'));
    const result = solver.solve(state, {
      bookingId: 'B-1001', releasedIds: data.bookings[0].assigned, question: 'Can I change the pickup time?',
    });
    assert.ok(result.plans[0].open.includes('Human decision pending: unclassified question'));
  });
});

describe('money and contract phrasings never slip through', () => {
  const phrasings = [
    ['How much will cancelling cost me?', 'cancellation fee', 'CL-5.1'],
    ['Will I be billed for this?', 'cancellation fee', 'CL-5.1'],
    ['Can I get reimbursed?', 'refund', 'CL-4.2'],
    ['Is this a money-back booking?', 'refund', 'CL-4.2'],
    ['Will I have to pay anything if I cancel?', 'cancellation fee', 'CL-5.1'],
    ['Will there be a surcharge?', 'cancellation fee', 'CL-5.1'],
  ];

  for (const [question, topic, clauseId] of phrasings) {
    test(`"${question}" goes to a human as ${topic} with clause ${clauseId}`, () => {
      const [handoff] = solver.routeHandoffs(question, data.clauses);
      assert.equal(handoff.topic, topic);
      assert.equal(handoff.clause.id, clauseId);
      assert.equal(handoff.clause.text, data.clauses[clauseId].text);
    });
  }

  test('each phrasing reaches the hand-off list of a full solve', () => {
    for (const [question] of phrasings) {
      const result = solver.solve(stateFor(scenario('happy-path')), {
        bookingId: 'B-1001', releasedIds: data.bookings[0].assigned, question,
      });
      assert.equal(result.handoffs.length, 1, question);
    }
  });
});

describe('applyPlan', () => {
  test('approving a full plan cancels the booking, books the request and clears the waitlist entry', () => {
    const sc = scenario('happy-path');
    const state = stateFor(sc);
    const result = solver.solve(state, { bookingId: 'B-1001', releasedIds: data.bookings[0].assigned, question: '' });
    const next = solver.applyPlan(state, result.plans[0]);

    assert.equal(next.bookings.find((b) => b.id === 'B-1001').status, 'cancelled');
    const newBooking = next.bookings.find((b) => b.id === 'B-1006');
    assert.equal(newBooking.status, 'confirmed');
    assert.equal(newBooking.assigned.length, 6);
    assert.equal(next.waitlist.length, 0);
    assert.equal(state.bookings.find((b) => b.id === 'B-1001').status, 'confirmed');
  });

  test('approving a partial plan marks the booking as awaiting client consent', () => {
    const state = stateFor(scenario('backup-and-refund'));
    const result = solver.solve(state, { bookingId: 'B-1003', releasedIds: data.bookings[2].assigned, question: '' });
    const next = solver.applyPlan(state, result.plans[0]);
    assert.equal(next.bookings.find((b) => b.id === 'B-1006').status, 'awaiting-client-consent');
  });

  test('applying an unknown plan throws instead of silently continuing', () => {
    const state = stateFor(scenario('happy-path'));
    assert.throws(() => solver.applyPlan(state, { id: 'P9', requestId: 'W-0', cancelledBookingId: 'B-1001' }), /not found/);
  });

  test('applying one plan keeps the other waitlist requests', () => {
    const state = data; // full waitlist: W-2001, W-2002, W-2003
    const plan = solver.solve(stateFor(scenario('jury-kit-mix')), {
      bookingId: 'B-1002', releasedIds: data.bookings[1].assigned, question: '',
    }).plans[0];
    const next = solver.applyPlan(state, plan);
    assert.deepEqual(next.waitlist.map((r) => r.id), ['W-2001', 'W-2003']);
  });

  test('a new booking id is max-plus-one and never collides with an existing id', () => {
    const state = stateFor(scenario('happy-path'));
    const renamed = { ...state, waitlist: [{ ...state.waitlist[0], id: 'W-1001' }] };
    const result = solver.solve(renamed, { bookingId: 'B-1001', releasedIds: data.bookings[0].assigned, question: '' });
    const next = solver.applyPlan(renamed, result.plans[0]);
    const ids = next.bookings.map((b) => b.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.at(-1), 'B-1006');
    assert.ok(!ids.slice(0, -1).includes(ids.at(-1)));
  });

  test('applying a plan after LIGHT-02 is booked fails instead of double-booking', () => {
    const state = stateFor(scenario('happy-path'));
    const plan = solver.solve(state, { bookingId: 'B-1001', releasedIds: data.bookings[0].assigned, question: '' }).plans[0];
    const booked = {
      ...state,
      bookings: [...state.bookings, {
        id: 'B-1009', client: 'Client Q (fictional)', start: '2026-12-03', end: '2026-12-03',
        mount: 'Z', status: 'confirmed', assigned: ['LIGHT-02'],
      }],
    };
    const before = structuredClone(booked);
    assert.throws(() => solver.applyPlan(booked, plan), /LIGHT-02: booked as B-1009/);
    assert.deepEqual(booked, before);
  });

  test('applying a plan fails when an action is no longer in inventory', () => {
    const state = stateFor(scenario('happy-path'));
    const plan = solver.solve(state, { bookingId: 'B-1001', releasedIds: data.bookings[0].assigned, question: '' }).plans[0];
    const pruned = { ...state, resources: state.resources.filter((r) => r.id !== 'STUDIO-A') };
    assert.throws(() => solver.applyPlan(pruned, plan), /STUDIO-A: not in inventory/);
  });

  test('applyPlan rejects a plan that repeats an item and leaves the input state unchanged', () => {
    const state = stateFor(scenario('happy-path'));
    const plan = solver.solve(state, { bookingId: 'B-1001', releasedIds: data.bookings[0].assigned, question: '' }).plans[0];
    const doubled = { ...plan, actions: [...plan.actions, { ...plan.actions[0] }] };
    const before = structuredClone(state);
    assert.throws(() => solver.applyPlan(state, doubled), /duplicate item.*CAM-Z-01/);
    assert.deepEqual(state, before);
  });
});

describe('held kit stays with the cancelled booking', () => {
  const jury = () => stateFor(scenario('jury-kit-mix'));
  const juryReleased = () => data.bookings.find((b) => b.id === 'B-1002').assigned.filter((id) => id !== 'LENS-Z-85');

  test('applyPlan records the held items on the cancelled booking', () => {
    const state = jury();
    const plan = solver.solve(state, { bookingId: 'B-1002', releasedIds: juryReleased(), question: '' }).plans[0];
    const next = solver.applyPlan(state, plan);
    assert.deepEqual(next.bookings.find((b) => b.id === 'B-1002').held, ['LENS-Z-85']);
  });

  test('after applying a plan that excludes a held item, the next solve does not offer it as free stock', () => {
    const state = jury();
    const plan = solver.solve(state, { bookingId: 'B-1002', releasedIds: juryReleased(), question: '' }).plans[0];
    const afterApply = solver.applyPlan(state, plan);
    const later = {
      ...afterApply,
      waitlist: [{
        id: 'W-3001', client: 'Client Q (fictional)', start: '2026-12-10', end: '2026-12-11',
        mount: 'Z', needs: [{ kind: 'lens', count: 3 }],
      }],
    };
    const next = solver.solve(later, { bookingId: 'B-1004', releasedIds: ['CAM-Z-01'], question: '' });
    assert.ok(next.plans[0].actions.every((a) => a.resourceId !== 'LENS-Z-85'));
    assert.match(next.reason, /LENS-Z-85: held by staff, not offered/);
  });
});

describe('solve does not mutate its input on failure paths', () => {
  test('a rejected request leaves the input unchanged', () => {
    const state = { ...stateFor(scenario('happy-path')), waitlist: [{ ...data.waitlist[0], start: '2026-02-30' }] };
    const before = structuredClone(state);
    solver.solve(state, { bookingId: 'B-1001', releasedIds: data.bookings[0].assigned, question: 'refund?' });
    assert.deepEqual(state, before);
  });
});
