'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const data = require('../src/data.js');
const tools = require('../src/tools.js');
const assistant = require('../src/assistant.js');

function demoState() {
  const state = structuredClone(data);
  state.waitlist = [...state.waitlist, ...state.overflowWaitlist];
  return state;
}

function makeAssistant(log = []) {
  const real = tools.createTools(demoState);
  const spy = {
    cancel_reservation(bookingId) {
      log.push('cancel_reservation');
      return real.cancel_reservation(bookingId);
    },
    solve_replan(bookingId, releasedIds) {
      log.push('solve_replan');
      return real.solve_replan(bookingId, releasedIds);
    },
    check_availability(kind, start, end, mount) {
      log.push('check_availability');
      return real.check_availability(kind, start, end, mount);
    },
  };
  return assistant.createAssistant({ getTools: () => spy, getState: demoState });
}

describe('intent parsing', () => {
  test('recognises a cancellation request', () => {
    assert.equal(assistant.parseIntent('Cancel B-1001'), 'cancel');
    assert.equal(assistant.parseIntent('please drop reservation B-1002'), 'cancel');
    assert.equal(assistant.parseIntent('I want to cancel Client A'), 'cancel');
  });

  test('recognises an availability or reschedule enquiry', () => {
    assert.equal(assistant.parseIntent('Is a camera available 2026-12-05 to 2026-12-07?'), 'availability');
    assert.equal(assistant.parseIntent('Do you have a lens free from 2026-12-05 to 2026-12-06?'), 'availability');
    assert.equal(assistant.parseIntent('reschedule B-1002 to 2026-12-14'), 'availability');
  });

  test('everything else is a general question, including money questions', () => {
    assert.equal(assistant.parseIntent('What is the refund policy?'), 'question');
    assert.equal(assistant.parseIntent('Can I get a refund of my deposit?'), 'question');
    assert.equal(assistant.parseIntent('Who is liable for damage?'), 'question');
    assert.equal(assistant.parseIntent('hello'), 'question');
  });
});

describe('confirmation before acting', () => {
  test('a cancel request is restated and no tool runs until the user confirms', () => {
    const log = [];
    const bot = makeAssistant(log);
    const first = bot.handle('Cancel B-1001');
    assert.equal(first.intent, 'cancel');
    assert.equal(first.status, 'ok');
    assert.equal(first.pending.type, 'cancel');
    assert.equal(first.toolCalls.length, 0);
    assert.match(first.text, /B-1001/);
    assert.match(first.text, /Reply "yes" to confirm/);
    assert.deepEqual(log, []);

    const denied = bot.handle('no');
    assert.equal(denied.pending, null);
    assert.match(denied.text, /Nothing was changed/);
    assert.deepEqual(log, []);
  });

  test('yes runs cancel_reservation and then solve_replan', () => {
    const log = [];
    const bot = makeAssistant(log);
    bot.handle('Cancel B-1001');
    const reply = bot.handle('yes');
    assert.deepEqual(log, ['cancel_reservation', 'solve_replan']);
    assert.equal(reply.toolCalls[0].name, 'cancel_reservation');
    assert.equal(reply.toolCalls[1].name, 'solve_replan');
    assert.equal(reply.toolCalls[1].output.feasible, true);
    assert.match(reply.text, /full re-plan/);
    assert.match(reply.text, /Nothing is applied by this chat/);
  });

  test('a new request drops a pending action without calling any tool', () => {
    const log = [];
    const bot = makeAssistant(log);
    bot.handle('Cancel B-1001');
    const next = bot.handle('Is a lens available 2026-12-05 to 2026-12-06?');
    assert.equal(next.pending.type, 'availability');
    assert.deepEqual(log, []);
  });

  test('yes with nothing pending does not call a tool', () => {
    const log = [];
    const bot = makeAssistant(log);
    const reply = bot.handle('yes');
    assert.equal(reply.intent, 'question');
    assert.deepEqual(log, []);
  });
});

describe('cancel on an unknown id', () => {
  test('returns an error reply and does not crash or call a tool', () => {
    const log = [];
    const bot = makeAssistant(log);
    const reply = bot.handle('Cancel B-9999');
    assert.equal(reply.status, 'error');
    assert.match(reply.text, /No reservation B-9999 exists/);
    assert.equal(reply.pending, null);
    assert.deepEqual(log, []);
    assert.doesNotThrow(() => bot.handle('yes'));
    assert.deepEqual(log, []);
  });
});

describe('no feasible plan', () => {
  test('the no-plan scenario returns feasible false and no moves', () => {
    const bot = makeAssistant();
    bot.handle('Cancel B-1000');
    const reply = bot.handle('yes');
    const solveCall = reply.toolCalls.find((call) => call.name === 'solve_replan');
    assert.ok(solveCall, 'solve_replan was called');
    assert.equal(solveCall.output.feasible, false);
    assert.equal(solveCall.output.outcome, 'none');
    assert.deepEqual(solveCall.output.moves, []);
    assert.equal(solveCall.output.plan, null);
  });

  test('the reply says so plainly and hands off to a human with a Reservations link', () => {
    const bot = makeAssistant();
    bot.handle('Cancel B-1000');
    const reply = bot.handle('yes');
    assert.ok(reply.text.includes(assistant.HANDOFF_SENTENCE), reply.text);
    assert.match(reply.text, /human dispatcher/);
    assert.equal(reply.actions.length, 1);
    assert.equal(reply.actions[0].type, 'open-reservation');
    assert.equal(reply.actions[0].bookingId, 'B-1000');
    assert.match(reply.actions[0].label, /Reservations/);
  });

  test('no move is claimed anywhere for an infeasible result', () => {
    const bot = makeAssistant();
    bot.handle('Cancel B-1000');
    const reply = bot.handle('yes');
    const solveCall = reply.toolCalls.find((call) => call.name === 'solve_replan');
    assert.deepEqual(solveCall.output.moves, []);
    if (solveCall.output.plan) assert.fail('an infeasible result must not carry a plan');
    assert.doesNotMatch(reply.text, /Moves returned by the solver/);
    assert.doesNotMatch(reply.text, /offers \d+ of \d+/);
  });
});

describe('availability', () => {
  test('restates the request and asks for confirmation before the tool runs', () => {
    const log = [];
    const bot = makeAssistant(log);
    const first = bot.handle('Is a camera available 2026-12-05 to 2026-12-07?');
    assert.equal(first.intent, 'availability');
    assert.equal(first.pending.type, 'availability');
    assert.equal(first.toolCalls.length, 0);
    assert.match(first.text, /Reply "yes"/);
    assert.deepEqual(log, []);
  });

  test('yes calls check_availability and reports only solver ids', () => {
    const bot = makeAssistant();
    bot.handle('Is a camera available 2026-12-05 to 2026-12-07?');
    const reply = bot.handle('yes');
    const call = reply.toolCalls[0];
    assert.equal(call.name, 'check_availability');
    assert.equal(call.input.resourceKind, 'camera');
    assert.deepEqual(call.output.available, ['CAM-EF-01', 'CAM-Z-02', 'CAM-Z-03']);
    for (const id of call.output.available) assert.ok(reply.text.includes(id), id);
    assert.match(reply.text, /availability answer only/);
  });

  test('a reschedule enquiry is handled as an availability check, not a move', () => {
    const bot = makeAssistant();
    const first = bot.handle('reschedule B-1002 to 2026-12-14 to 2026-12-15');
    assert.equal(first.pending.kind, 'camera');
    assert.equal(first.pending.mount, 'Z');
    assert.equal(first.pending.reschedule, true);
    const reply = bot.handle('yes');
    assert.equal(reply.toolCalls[0].input.mount, 'Z');
    assert.match(reply.text, /cannot move a reservation myself/);
  });

  test('invalid dates, a backwards range and a missing kind are errors, not guesses', () => {
    const bot = makeAssistant();
    const badDate = bot.handle('Is a camera available 2026-02-30 to 2026-03-01?');
    assert.equal(badDate.status, 'error');
    assert.match(badDate.text, /Not a real date/);
    const backwards = bot.handle('Is a camera available 2026-12-07 to 2026-12-05?');
    assert.equal(backwards.status, 'error');
    const noKind = bot.handle('Is anything available 2026-12-05 to 2026-12-06?');
    assert.equal(noKind.status, 'error');
    assert.match(noKind.text, /Which kind of equipment/);
  });
});

describe('general questions', () => {
  test('a refund question is routed to a human with clause CL-4.2 and no tool call', () => {
    const bot = makeAssistant();
    const reply = bot.handle('Can I get a refund of my deposit?');
    assert.equal(reply.intent, 'question');
    assert.ok(reply.text.includes('CL-4.2'), reply.text);
    assert.match(reply.text, /human dispatcher/);
    assert.equal(reply.toolCalls.length, 0);
  });

  test('the assistant says it is rule-based and reports 0 LLM calls', () => {
    assert.equal(assistant.LLM_CALLS, 0);
    const bot = makeAssistant();
    const reply = bot.handle('hello');
    assert.match(reply.text, /rule-based assistant/);
    assert.match(reply.text, /0 LLM calls/);
  });
});
