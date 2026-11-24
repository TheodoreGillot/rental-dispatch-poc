/*
 * Deterministic seed generator for Atelier Lumière.
 *
 * Run `node tools/generate-seed.js` to rewrite data/seed.json byte-identically.
 * The PRNG is mulberry32 with a fixed seed and every date is derived from the
 * fixed anchor date, so the output does not depend on the clock or the machine.
 *
 * The file is also a module: tests require it and compare the generated JSON
 * with the committed data/seed.json.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const selectors = require('../src/selectors.js');
const solver = require('../src/solver.js');

const SEED = 1337;
const ANCHOR = '2026-11-24';
const DAY_MS = 24 * 60 * 60 * 1000;

function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toDay(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new Error(`Bad date ${iso}`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS;
}

function isoFromDay(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function addDays(iso, days) {
  return isoFromDay(toDay(iso) + days);
}

const BRANDS = [
  'Ardent', 'Basalt', 'Cirrus', 'Dune', 'Ember', 'Fjord', 'Gale', 'Harbor',
  'Iris', 'Juniper', 'Kelvin', 'Larch', 'Meridian', 'Nimbus', 'Orchard', 'Pike',
];

const CATEGORIES = [
  { key: 'lighting', prefix: 'LGT', count: 24, minQty: 2, maxQty: 8,
    names: ['LED panel', 'Softbox kit', 'Fresnel', 'Tube light', 'Beauty dish', 'Strip light'] },
  { key: 'grip and rigging', prefix: 'GRP', count: 20, minQty: 2, maxQty: 8,
    names: ['C-stand', 'Sandbag set', 'Boom arm', 'Butterfly frame', 'Clamp set', 'Dolly plate'] },
  { key: 'camera', prefix: 'CAM', count: 20, minQty: 1, maxQty: 5,
    names: ['Mirrorless body', 'Cinema body', 'Prime lens', 'Zoom lens', 'Monitor', 'Follow focus'] },
  { key: 'audio', prefix: 'AUD', count: 18, minQty: 1, maxQty: 6,
    names: ['Wireless mic set', 'Boom microphone', 'Field recorder', 'Timecode box', 'Mixer', 'Monitor set'] },
  { key: 'power and distribution', prefix: 'PWR', count: 16, minQty: 2, maxQty: 10,
    names: ['Power station', 'Distribution box', 'Battery block', 'Extension reel', 'Ramp', 'Cable protector'] },
  { key: 'staging', prefix: 'STG', count: 14, minQty: 1, maxQty: 4,
    names: ['Modular riser', 'Studio cyc section', 'Apple box set', 'Step unit', 'Platform', 'Rail kit'] },
  { key: 'backdrops', prefix: 'BDK', count: 14, minQty: 1, maxQty: 6,
    names: ['Seamless paper roll', 'Canvas backdrop', 'Backdrop stand', 'Muslin cloth', 'Floor sweep', 'Print backdrop'] },
  { key: 'cables and accessories', prefix: 'CBL', count: 24, minQty: 3, maxQty: 12,
    names: ['HDMI cable', 'XLR cable', 'USB-C cable', 'Battery charger', 'Memory card wallet', 'Gaffer tape'] },
];

const LOCATIONS = [
  'Shelf A-01', 'Shelf A-04', 'Shelf B-02', 'Shelf B-07', 'Shelf C-03',
  'Shelf C-09', 'Shelf D-01', 'Shelf D-06', 'Room North', 'Room South',
  'Room East', 'Room West', 'Bay 1', 'Bay 2', 'Cage 1', 'Cage 2',
];

const FIRST_NAMES = [
  'Alma', 'Anders', 'Bea', 'Bram', 'Cleo', 'Dario', 'Edda', 'Elias', 'Faye', 'Felix',
  'Greta', 'Hugo', 'Ida', 'Iris', 'Jonas', 'Juna', 'Kai', 'Lena', 'Leo', 'Mara',
  'Milo', 'Nadia', 'Nils', 'Noor', 'Odin', 'Olive', 'Pia', 'Quinn', 'Remy', 'Rhea',
];

const LAST_NAMES = [
  'Adler', 'Berg', 'Costa', 'Dahl', 'Eriksen', 'Falk', 'Grimm', 'Holm', 'Ivers',
  'Jansen', 'Keller', 'Lind', 'Moreau', 'Neri', 'Oakes', 'Pell', 'Quist', 'Rask',
  'Soler', 'Thorne', 'Ueda', 'Vale', 'Wren', 'Yarrow',
];

const COMPANIES = [
  'Nordlys Film', 'Kestrel Hollow', 'Alder & Pine', 'Halden Works', 'Marrow House',
  'Fieldnote Films', 'Glasshouse North', 'Northline Row', 'Palefire Room',
  'Rook & Reed', 'Saltmarsh Studio', 'Tandem House', 'Vantage Row',
  'Westward Lane', 'Wildacre Room', 'Lowtide Studio', 'Paper Lantern',
  'Copperline Room', 'Quiet Hour Films', 'Meridian Yard',
];

const CLIENT_TYPES = [
  'production company', 'agency', 'freelance photographer', 'event organiser',
];

function pick(random, list) {
  return list[Math.floor(random() * list.length)];
}

function intBetween(random, min, max) {
  return min + Math.floor(random() * (max - min + 1));
}

function makeEquipment(random) {
  const equipment = [];
  for (const category of CATEGORIES) {
    for (let index = 0; index < category.count; index += 1) {
      const serial = String(index + 1).padStart(3, '0');
      const statusRoll = random();
      const maintenance = statusRoll < 0.06 ? 'in repair' : statusRoll < 0.085 ? 'retired' : 'ok';
      equipment.push({
        stockId: `${category.prefix}-${serial}`,
        name: `${pick(random, category.names)} ${serial}`,
        brand: pick(random, BRANDS),
        category: category.key,
        quantityOwned: intBetween(random, category.minQty, category.maxQty),
        location: pick(random, LOCATIONS),
        maintenance,
      });
    }
  }
  return equipment;
}

function makeCustomers(random) {
  const customers = [];
  for (let index = 0; index < 60; index += 1) {
    const clientType = pick(random, CLIENT_TYPES);
    const person = random() < 0.35;
    const name = person
      ? `${pick(random, FIRST_NAMES)} ${pick(random, LAST_NAMES)}`
      : COMPANIES[index % COMPANIES.length] + (index >= COMPANIES.length ? ` ${Math.floor(index / COMPANIES.length) + 1}` : '');
    const local = name.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
    customers.push({
      id: `CUS-${String(index + 1).padStart(3, '0')}`,
      name,
      contact: {
        email: `${local}@atelier-mail.test`,
        phone: `+44 7700 9${String(10000 + index).slice(-4)}`,
      },
      clientType,
      history: { totalBookings: 0, lastBookingDate: null, reservationIds: [] },
    });
  }
  return customers;
}

function makeReservations(random, equipment, customers) {
  const anchor = toDay(ANCHOR);
  const usable = equipment.filter((item) => item.maintenance !== 'retired');
  const ledger = new Map(); // stockId -> Map(day -> quantity used)

  function used(stockId, day) {
    return ledger.get(stockId)?.get(day) ?? 0;
  }

  function usableQty(item, startDay, endDay) {
    let free = item.quantityOwned;
    for (let day = startDay; day <= endDay; day += 1) {
      free = Math.min(free, item.quantityOwned - used(item.stockId, day));
    }
    return free;
  }

  function hold(item, startDay, endDay, quantity) {
    if (!ledger.has(item.stockId)) ledger.set(item.stockId, new Map());
    const days = ledger.get(item.stockId);
    for (let day = startDay; day <= endDay; day += 1) {
      days.set(day, (days.get(day) ?? 0) + quantity);
    }
  }

  const reservations = [];
  let nextId = 1001;

  function addReservation({ start, end, status, items, cancelledAt = null, customerId = null }) {
    const id = `RX-${nextId}`;
    nextId += 1;
    const customer = customerId || pick(random, customers).id;
    const reservation = {
      id,
      customerId: customer,
      start,
      end,
      items,
      status,
      createdAt: addDays(start, -intBetween(random, 4, 21)),
    };
    if (cancelledAt) reservation.cancelledAt = cancelledAt;
    reservations.push(reservation);
    return reservation;
  }

  // 284 ordinary reservations spread over two months back and four months ahead.
  let attempts = 0;
  while (reservations.length < 284 && attempts < 6000) {
    attempts += 1;
    const offset = intBetween(random, -60, 120);
    const startDay = anchor + offset;
    const endDay = startDay + intBetween(random, 1, 6);
    const start = isoFromDay(startDay);
    const end = isoFromDay(endDay);

    const chosen = [];
    const wanted = intBetween(random, 2, 6);
    const shuffled = [...usable].sort(() => random() - 0.5);
    for (const item of shuffled) {
      if (chosen.length >= wanted) break;
      const quantity = intBetween(random, 1, Math.min(3, item.quantityOwned));
      if (usableQty(item, startDay, endDay) < quantity) continue;
      chosen.push({ stockId: item.stockId, quantity });
      hold(item, startDay, endDay, quantity);
    }
    if (chosen.length < 2) {
      for (const item of usable) {
        const entry = chosen.find((row) => row.stockId === item.stockId);
        if (!entry) continue;
        hold(item, startDay, endDay, -entry.quantity);
      }
      continue;
    }

    let status;
    if (endDay < anchor - 1) status = random() < 0.8 ? 'returned' : 'cancelled';
    else if (random() < 0.12) status = 'held';
    else if (random() < 0.08) status = 'cancelled';
    else status = 'confirmed';

    addReservation({
      start,
      end,
      status,
      items: chosen,
      // A cancellation is recorded in the week before the studio date, never in the future.
      cancelledAt: status === 'cancelled' ? addDays(ANCHOR, -intBetween(random, 1, 7)) : null,
    });
  }

  // Two holds expire within 48 hours of the studio date, so Home exercises that
  // rule on first load. They reuse existing ids and only move into free cable stock.
  const holdStart = anchor + 1;
  const holdEnd = anchor + 2;
  const returnedRows = reservations.filter((row) => row.status === 'returned').slice(0, 2);
  for (const sample of returnedRows) {
    const picks = [];
    for (const item of usable) {
      if (item.category !== 'cables and accessories') continue;
      if (picks.length >= 2) break;
      if (usableQty(item, holdStart, holdEnd) < 1) continue;
      picks.push({ stockId: item.stockId, quantity: 1 });
      hold(item, holdStart, holdEnd, 1);
    }
    if (picks.length < 2) continue;
    sample.status = 'held';
    sample.start = isoFromDay(holdStart);
    sample.end = isoFromDay(holdEnd);
    sample.items = picks;
    delete sample.cancelledAt;
  }

  // Deliberate over-bookings. Each pair overlaps only on one stock at the full
  // owned quantity, in a window where no other reservation uses that stock, so
  // exactly one move or swap clears the conflict. The build asserts this.
  function rangeFree(stockId, startDay, endDay) {
    for (let day = startDay; day <= endDay; day += 1) {
      if (used(stockId, day) > 0) return false;
    }
    return true;
  }

  function findFreeRun(stockId, peerId, length, blockStart, blockEnd) {
    for (let shift = 1; shift <= 60; shift += 1) {
      for (const direction of [1, -1]) {
        const start = blockStart + direction * shift;
        const end = start + length - 1;
        if (start <= blockEnd && end >= blockStart) continue;
        if (rangeFree(stockId, start, end) && rangeFree(peerId, start, end)) return start;
      }
    }
    return null;
  }

  const conflictStocks = ['LGT-004', 'CAM-007', 'GRP-003', 'AUD-005', 'STG-002'];
  for (const stockId of conflictStocks) {
    const item = equipment.find((row) => row.stockId === stockId);
    if (!item) continue;
    const peers = usable.filter((row) => row.category === item.category && row.stockId !== stockId);
    let placed = false;
    const length = 3;
    for (const peer of peers) {
      for (let offset = 3; offset <= 90 && !placed; offset += 1) {
        const firstStart = anchor + offset;
        const firstEnd = firstStart + length - 1;
        const secondStart = firstStart + 1;
        const secondEnd = firstStart + length;
        if (!rangeFree(stockId, firstStart, secondEnd)) continue;
        if (!rangeFree(peer.stockId, firstStart, secondEnd)) continue;
        if (findFreeRun(stockId, peer.stockId, length, firstStart, secondEnd) === null) continue;
        const itemsA = [
          { stockId, quantity: item.quantityOwned },
          { stockId: peer.stockId, quantity: 1 },
        ];
        const itemsB = itemsA.map((row) => ({ ...row }));
        addReservation({ start: isoFromDay(firstStart), end: isoFromDay(firstEnd), status: 'confirmed', items: itemsA });
        addReservation({ start: isoFromDay(secondStart), end: isoFromDay(secondEnd), status: 'confirmed', items: itemsB });
        hold(item, firstStart, firstEnd, item.quantityOwned);
        hold(item, secondStart, secondEnd, item.quantityOwned);
        hold(peer, firstStart, firstEnd, 1);
        hold(peer, secondStart, secondEnd, 1);
        placed = true;
      }
      if (placed) break;
    }
    if (!placed) throw new Error(`Could not place a single-action conflict for ${stockId}.`);
  }

  // Recent cancellations, including some around the deliberate conflicts, so
  // the proposal inbox has cancellation context. A cancellation only claims a
  // conflict when it freed the same stock id on overlapping dates.
  const recent = [
    { stockId: 'LGT-004', offset: -4 },
    { stockId: 'CAM-007', offset: -2 },
    { stockId: 'GRP-003', offset: 5 },
    { stockId: 'AUD-005', offset: 8 },
    { stockId: 'STG-002', offset: -1 },
    { stockId: 'CBL-002', offset: 2 },
  ];
  for (const entry of recent) {
    const item = equipment.find((row) => row.stockId === entry.stockId);
    if (!item) continue;
    const startDay = anchor + entry.offset;
    const endDay = startDay + 3;
    const peers = usable.filter((row) => row.category === item.category && row.stockId !== entry.stockId);
    addReservation({
      start: isoFromDay(startDay),
      end: isoFromDay(endDay),
      status: 'cancelled',
      cancelledAt: isoFromDay(anchor - intBetween(random, 1, 5)),
      items: [
        { stockId: entry.stockId, quantity: Math.min(2, item.quantityOwned) },
        ...(peers.length ? [{ stockId: pick(random, peers).stockId, quantity: 1 }] : []),
      ],
    });
  }

  return { reservations, anchor };
}

/**
 * Seed-time guard: every deliberate conflict must be clearable by a single
 * solver action, and that action must actually make the conflict disappear.
 */
function assertDeliberateConflictsClearable(seed) {
  const state = {
    equipment: seed.equipment,
    customers: seed.customers,
    reservations: seed.reservations,
    events: [],
  };
  const conflicts = selectors.conflicts(state);
  assert.equal(conflicts.length, 5, `expected five deliberate conflicts, found ${conflicts.length}`);
  for (const conflict of conflicts) {
    const result = solver.solveConflict(state, conflict);
    assert.equal(result.feasibility, 'feasible', `${conflict.id} must be feasible`);
    assert.equal(result.actions.length, 1, `${conflict.id} must clear with one action, got ${result.actions.length}`);
    const draft = {
      equipment: seed.equipment,
      customers: seed.customers,
      reservations: JSON.parse(JSON.stringify(seed.reservations)),
      events: [],
    };
    solver.applyActions(draft.reservations, result.actions);
    assert.ok(
      !selectors.conflicts(draft).some((row) => row.id === conflict.id),
      `${conflict.id} must be gone after applying its single-action plan`,
    );
  }
}

function buildSeed() {
  const random = mulberry32(SEED);
  const equipment = makeEquipment(random);
  const customers = makeCustomers(random);
  const { reservations } = makeReservations(random, equipment, customers);

  // Past booking history derived from the reserved rows, not from the clock.
  const byCustomer = new Map();
  for (const reservation of reservations) {
    if (!byCustomer.has(reservation.customerId)) byCustomer.set(reservation.customerId, []);
    byCustomer.get(reservation.customerId).push(reservation);
  }
  const anchor = toDay(ANCHOR);
  for (const customer of customers) {
    const rows = (byCustomer.get(customer.id) || []).sort((a, b) => a.start.localeCompare(b.start));
    const past = rows.filter((row) => toDay(row.end) < anchor);
    customer.history = {
      totalBookings: past.length,
      lastBookingDate: past.length ? past[past.length - 1].end : null,
      reservationIds: past.map((row) => row.id),
    };
  }

  const seed = {
    version: 1,
    meta: {
      house: 'Atelier Lumière',
      anchorDate: ANCHOR,
      generator: 'tools/generate-seed.js',
      seed: SEED,
    },
    equipment,
    customers,
    reservations,
  };
  assertDeliberateConflictsClearable(seed);
  return seed;
}

function serialise(seed) {
  return `${JSON.stringify(seed, null, 2)}\n`;
}

if (require.main === module) {
  const target = path.join(__dirname, '..', 'data', 'seed.json');
  fs.writeFileSync(target, serialise(buildSeed()), 'utf8');
  process.stdout.write(`Wrote ${target}\n`);
}

module.exports = { SEED, ANCHOR, buildSeed, serialise, mulberry32, addDays, DAY_MS, assertDeliberateConflictsClearable };
