'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
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

describe('day arithmetic', () => {
  test('addDays crosses month and year boundaries', () => {
    assert.equal(validation.addDays('2026-11-30', 1), '2026-12-01');
    assert.equal(validation.addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(validation.addDays('2028-03-01', -1), '2028-02-29');
    assert.equal(validation.addDays('bad', 1), null);
  });

  test('daysBetween is inclusive-agnostic and eachDay is inclusive', () => {
    assert.equal(validation.daysBetween('2026-11-01', '2026-11-03'), 2);
    assert.deepEqual(validation.eachDay('2026-11-01', '2026-11-03'), ['2026-11-01', '2026-11-02', '2026-11-03']);
    assert.deepEqual(validation.eachDay('2026-11-03', '2026-11-01'), []);
  });
});

describe('range helpers', () => {
  test('rangeProblem names the invalid field and value', () => {
    assert.match(validation.rangeProblem('Reservation', '2026-02-30', '2026-03-01'), /invalid start date "2026-02-30"/);
    assert.match(validation.rangeProblem('Reservation', '2026-03-01', '2026-02-30'), /invalid end date/);
    assert.match(validation.rangeProblem('Reservation', '2026-03-02', '2026-03-01'), /before it starts/);
    assert.equal(validation.rangeProblem('Reservation', '2026-03-01', '2026-03-02'), null);
  });

  test('rangesOverlap is inclusive and invalid dates do not overlap', () => {
    assert.equal(validation.rangesOverlap('2026-11-01', '2026-11-03', '2026-11-03', '2026-11-05'), true);
    assert.equal(validation.rangesOverlap('2026-11-01', '2026-11-02', '2026-11-03', '2026-11-05'), false);
    assert.equal(validation.rangesOverlap('bad', '2026-11-02', '2026-11-03', '2026-11-05'), false);
  });
});

describe('parseQuantityInput', () => {
  test('accepts whole numbers of 1 or more and keeps the raw value out of the state', () => {
    assert.deepEqual(validation.parseQuantityInput('3'), { ok: true, quantity: 3, error: null });
    assert.deepEqual(validation.parseQuantityInput(' 4 '), { ok: true, quantity: 4, error: null });
  });

  test('rejects decimals, negatives, zero, blanks and junk without coercing', () => {
    for (const value of ['2.5', '-3', '0', '', '   ', '1e3', 'two', undefined, null]) {
      const result = validation.parseQuantityInput(value);
      assert.equal(result.ok, false, String(value));
      assert.equal(result.quantity, null, String(value));
      assert.match(result.error, /whole number of 1 or more/);
    }
  });
});
