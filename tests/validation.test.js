'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const data = require('../src/data.js');
const validation = require('../src/validation.js');

describe('toDay', () => {
  test('accepts real calendar dates, including leap days', () => {
    assert.notEqual(validation.toDay('2026-11-05'), null);
    assert.notEqual(validation.toDay('2028-02-29'), null);
    assert.equal(validation.toDay('1970-01-02') - validation.toDay('1970-01-01'), 1);
  });

  test('rejects impossible dates and anything that is not strict YYYY-MM-DD', () => {
    for (const bad of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-1-5', ' 2026-01-05', '2026-01-05 ', '20261105', '', undefined, null, 20261105]) {
      assert.equal(validation.toDay(bad), null, String(bad));
    }
  });
});

describe('inputProblem', () => {
  test('the seed data has no input problem', () => {
    assert.equal(validation.inputProblem(data), null);
  });

  test('reports the first bad field with its value', () => {
    const state = { resources: [], bookings: [], waitlist: [{ id: 'W-1', start: '2026-11-05', end: '2026-11-05', needs: [{ kind: 'camera', count: 0 }] }] };
    assert.equal(validation.inputProblem(state), 'Request W-1 asks for 0 x camera: no items requested.');
  });
});
