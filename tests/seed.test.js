'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const generator = require('../tools/generate-seed.js');
const selectors = require('../src/selectors.js');
const solver = require('../src/solver.js');

const root = path.join(__dirname, '..');
const file = path.join(root, 'data', 'seed.json');
const raw = fs.readFileSync(file, 'utf8');
const seed = JSON.parse(raw);

describe('seed data', () => {
  test('the committed file matches the generator byte for byte', () => {
    assert.equal(generator.serialise(generator.buildSeed()), raw);
  });

  test('generation is deterministic across repeated runs', () => {
    assert.deepEqual(generator.buildSeed(), generator.buildSeed());
  });

  test('the file stays below the size budget', () => {
    const bytes = fs.statSync(file).size;
    assert.ok(bytes < 1024 * 1024, `${bytes} bytes`);
  });

  test('equipment covers the eight categories with about 150 lines', () => {
    const categories = new Set(seed.equipment.map((item) => item.category));
    assert.deepEqual([...categories].sort(), [
      'audio', 'backdrops', 'cables and accessories', 'camera',
      'grip and rigging', 'lighting', 'power and distribution', 'staging',
    ]);
    assert.ok(seed.equipment.length >= 145 && seed.equipment.length <= 155);
    const stockIds = seed.equipment.map((item) => item.stockId);
    assert.equal(new Set(stockIds).size, stockIds.length);
    for (const item of seed.equipment) {
      assert.ok(item.stockId && item.name && item.brand && item.category, item.stockId);
      assert.ok(Number.isInteger(item.quantityOwned) && item.quantityOwned >= 1, item.stockId);
      assert.ok(item.location);
      assert.ok(['ok', 'in repair', 'retired'].includes(item.maintenance), item.stockId);
    }
  });

  test('customers have contacts, client types and derived booking history', () => {
    assert.equal(seed.customers.length, 60);
    const ids = seed.customers.map((customer) => customer.id);
    assert.equal(new Set(ids).size, ids.length);
    const types = new Set(seed.customers.map((customer) => customer.clientType));
    assert.deepEqual([...types].sort(), ['agency', 'event organiser', 'freelance photographer', 'production company']);
    for (const customer of seed.customers) {
      assert.match(customer.contact.email, /@atelier-mail\.test$/);
      assert.match(customer.contact.phone, /^\+44 7700 9/);
      assert.ok(customer.history.totalBookings >= 0);
      assert.ok(Array.isArray(customer.history.reservationIds));
    }
  });

  test('reservations span two months back and four months ahead with all four statuses', () => {
    assert.equal(seed.reservations.length, 300);
    const statuses = new Set(seed.reservations.map((reservation) => reservation.status));
    assert.deepEqual([...statuses].sort(), ['cancelled', 'confirmed', 'held', 'returned']);
    const starts = seed.reservations.map((reservation) => reservation.start).sort();
    assert.ok(starts[0] <= '2026-09-30', starts[0]);
    assert.ok(starts[starts.length - 1] >= '2027-03-01', starts[starts.length - 1]);
    for (const reservation of seed.reservations) {
      assert.match(reservation.id, /^RX-\d{4}$/);
      assert.ok(reservation.items.length >= 2, reservation.id);
      const stockIds = reservation.items.map((item) => item.stockId);
      assert.equal(new Set(stockIds).size, stockIds.length, reservation.id);
      for (const item of reservation.items) {
        assert.ok(seed.equipment.some((line) => line.stockId === item.stockId), `${reservation.id} ${item.stockId}`);
        assert.ok(Number.isInteger(item.quantity) && item.quantity >= 1);
      }
    }
    assert.equal(seed.reservations[0].id, 'RX-1001');
  });

  test('deliberate overbookings produce real conflicts', () => {
    const state = { equipment: seed.equipment, customers: seed.customers, reservations: seed.reservations, events: [] };
    const conflicts = selectors.conflicts(state);
    assert.ok(conflicts.length >= 5, `${conflicts.length} conflicts`);
    for (const conflict of conflicts) {
      assert.ok(conflict.maxBooked > conflict.owned);
      assert.ok(conflict.reservationIds.length >= 2);
      assert.ok(conflict.from && conflict.to);
    }
  });

  test('every deliberate conflict is clearable by one verified solver action', () => {
    generator.assertDeliberateConflictsClearable(seed);
    const state = { equipment: seed.equipment, customers: seed.customers, reservations: seed.reservations, events: [] };
    for (const conflict of selectors.conflicts(state)) {
      const result = solver.solveConflict(state, conflict);
      assert.equal(result.feasibility, 'feasible', conflict.id);
      assert.equal(result.actions.length, 1, conflict.id);
      const draft = {
        equipment: seed.equipment,
        customers: seed.customers,
        reservations: structuredClone(seed.reservations),
        events: [],
      };
      solver.applyActions(draft.reservations, result.actions);
      assert.ok(!selectors.conflicts(draft).some((row) => row.id === conflict.id), conflict.id);
    }
  });
});
