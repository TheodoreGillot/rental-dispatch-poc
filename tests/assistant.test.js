'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const seed = require('../data/seed.json');
const { createStore } = require('../src/store.js');
const { createAssistantTools } = require('../src/assistant-tools.js');
const assistantApi = require('../src/assistant.js');
const selectors = require('../src/selectors.js');

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

describe('transparency text', () => {
  test('the opening message states that it is an AI assistant and answers may need checking', () => {
    assert.match(assistantApi.OPENING, /AI assistant/);
    assert.match(assistantApi.OPENING, /answers may need checking/i);
    assert.equal(assistantApi.LLM_CALLS, 0);
  });
});

describe('clarifying questions', () => {
  test('asks which customer when a booking has dates and items but no customer', () => {
    const { store, assistant } = setup();
    const response = assistant.handle('Book 1 × LGT-020 from 2027-02-01 to 2027-02-02');
    assert.equal(response.status, 'ok');
    assert.match(response.text, /Which customer/);
    assert.equal(response.pending.type, 'collect-create');
    assert.equal(store.getState().reservations.length, 300);
  });

  test('asks which customer when the name is ambiguous and writes nothing', () => {
    const { store, assistant } = setup();
    const before = store.getState().reservations.length;
    const response = assistant.handle('Book 1 × LGT-020 for Studio from 2027-02-01 to 2027-02-02');
    assert.match(response.text, /Several customers match/);
    assert.ok(response.toolCalls.some((call) => call.name === 'get_customer'));
    assert.equal(store.getState().reservations.length, before);
  });

  test('asks for dates when they are missing', () => {
    const { assistant } = setup();
    const response = assistant.handle('Book 1 × LGT-020 for Nordlys Film');
    assert.match(response.text, /Which dates/);
  });
});

describe('create flow', () => {
  test('confirms with a summary card, then writes exactly once through the store', () => {
    const { store, assistant } = setup();
    const state = store.getState();
    const item = freeItem(state, '2027-03-01', '2027-03-03', 2);
    let notifications = 0;
    store.subscribe(() => { notifications += 1; });
    const message = `Book 2 × ${item.stockId} for Nordlys Film from 2027-03-01 to 2027-03-03`;
    const ask = assistant.handle(message);
    assert.equal(ask.status, 'ok');
    assert.equal(ask.pending.type, 'confirm-create');
    assert.equal(ask.confirmation.customerName, 'Nordlys Film');
    assert.equal(ask.confirmation.start, '2027-03-01');
    assert.equal(ask.confirmation.end, '2027-03-03');
    assert.equal(ask.confirmation.totalQuantity, 2);
    assert.deepEqual(ask.confirmation.items.map((row) => row.stockId), [item.stockId]);
    assert.ok(ask.toolCalls.some((call) => call.name === 'check_availability'));
    assert.equal(store.getState().reservations.length, 300);
    assert.equal(notifications, 0);

    const done = assistant.handle('yes');
    assert.equal(done.status, 'ok');
    assert.match(done.text, /Reservation RX-1301 created/);
    assert.ok(done.toolCalls.some((call) => call.name === 'create_reservation'));
    assert.equal(store.getState().reservations.length, 301);
    assert.equal(notifications, 1);
    const created = store.getState().reservations.at(-1);
    assert.equal(created.customerId, 'CUS-001');
    assert.deepEqual(created.items, [{ stockId: item.stockId, quantity: 2 }]);
  });

  test('"no" stops before any write', () => {
    const { store, assistant } = setup();
    const item = freeItem(store.getState(), '2027-03-01', '2027-03-03');
    assistant.handle(`Book 1 × ${item.stockId} for Nordlys Film from 2027-03-01 to 2027-03-03`);
    const stopped = assistant.handle('no');
    assert.match(stopped.text, /Stopped/);
    assert.equal(store.getState().reservations.length, 300);
    assert.equal(store.getState().events.length, 0);
  });

  test('an over-booking is blocked before confirmation with alternatives', () => {
    const { store, assistant } = setup();
    const conflict = selectors.conflicts(store.getState())[0];
    const response = assistant.handle(`Book ${conflict.owned + 1} × ${conflict.stockId} for Nordlys Film from ${conflict.from} to ${conflict.to}`);
    assert.equal(response.status, 'error');
    assert.match(response.text, /overbook/);
    assert.ok(response.alternatives);
    assert.ok(response.alternatives.dates.length > 0 || response.alternatives.items.length > 0);
    assert.equal(response.pending, null);
    assert.equal(store.getState().reservations.length, 300);
    assert.equal(store.getState().events.length, 0);
  });
});

describe('cancel flow', () => {
  test('confirms, then cancels through the store and names the Operations proposal', () => {
    const { store, assistant } = setup();
    const active = store.getState().reservations.find((reservation) => reservation.status === 'confirmed');
    let notifications = 0;
    store.subscribe(() => { notifications += 1; });
    const ask = assistant.handle(`Cancel ${active.id}`);
    assert.equal(ask.pending.type, 'confirm-cancel');
    assert.ok(ask.confirmation);
    assert.equal(ask.confirmation.totalQuantity, active.items.reduce((sum, item) => sum + item.quantity, 0));
    assert.equal(store.getState().reservations.find((row) => row.id === active.id).status, 'confirmed');
    assert.equal(notifications, 0);

    const done = assistant.handle('yes');
    assert.equal(done.status, 'ok');
    assert.match(done.text, /cancelled/);
    assert.match(done.text, /Operations proposal/);
    assert.equal(store.getState().reservations.find((row) => row.id === active.id).status, 'cancelled');
    assert.equal(notifications, 1);
  });

  test('cancelling by an exact customer name works when there is one open reservation', () => {
    const miniSeed = {
      version: 1,
      meta: { anchorDate: '2026-11-24' },
      equipment: [{ stockId: 'LGT-001', name: 'LED panel', brand: 'T', category: 'lighting', quantityOwned: 2, location: 'S', maintenance: 'ok' }],
      customers: [{ id: 'CUS-1', name: 'Nordlys Film', contact: { email: 'n@example.test', phone: '1' }, clientType: 'agency', history: {} }],
      reservations: [{
        id: 'RX-5001', customerId: 'CUS-1', start: '2026-12-01', end: '2026-12-03',
        status: 'confirmed', items: [{ stockId: 'LGT-001', quantity: 1 }],
      }],
    };
    const store = createStore(miniSeed, { now: CLOCK });
    const tools = createAssistantTools({ store });
    const assistant = assistantApi.createAssistant({ getTools: () => tools });
    const response = assistant.handle('Cancel Nordlys Film');
    assert.equal(response.status, 'ok');
    assert.equal(response.pending.type, 'confirm-cancel');
    assert.equal(response.confirmation.customerName, 'Nordlys Film');
    assert.equal(response.confirmation.items[0].stockId, 'LGT-001');
  });

  test('an unknown reservation id is an error, not an exception', () => {
    const { assistant } = setup();
    const response = assistant.handle('Cancel RX-9999');
    assert.equal(response.status, 'error');
    assert.match(response.text, /No reservation/);
  });
});

describe('availability flow', () => {
  test('checks live availability without writing', () => {
    const { store, assistant } = setup();
    const state = store.getState();
    const item = freeItem(state, '2027-02-01', '2027-02-02');
    const before = structuredClone(store.getState());
    const response = assistant.handle(`Check availability of ${item.stockId} from 2027-02-01 to 2027-02-02`);
    assert.equal(response.status, 'ok');
    assert.match(response.text, /free from 2027-02-01 to 2027-02-02/);
    const call = response.toolCalls.find((row) => row.name === 'check_availability');
    assert.ok(call);
    assert.equal(call.output.items[0].stockId, item.stockId);
    assert.equal(call.output.feasible, true);
    assert.deepEqual(store.getState(), before);
  });

  test('reports a shortfall and alternatives instead of inventing availability', () => {
    const { store, assistant } = setup();
    const conflict = selectors.conflicts(store.getState())[0];
    const response = assistant.handle(`Check availability of ${conflict.stockId} from ${conflict.from} to ${conflict.to}`);
    const call = response.toolCalls.find((row) => row.name === 'check_availability');
    assert.equal(call.output.feasible, false);
    assert.match(response.text, /Not enough stock/);
    assert.ok(response.alternatives);
    assert.equal(store.getState().events.length, 0);
  });
});

describe('lookups and questions', () => {
  test('looks up a reservation, customer and item with visible tool calls', () => {
    const { assistant } = setup();
    const reservation = assistant.handle('Show RX-1001');
    assert.equal(reservation.status, 'ok');
    assert.ok(reservation.toolCalls.some((call) => call.name === 'get_reservation'));

    const customer = assistant.handle('Show customer Nordlys Film');
    assert.equal(customer.status, 'ok');
    assert.match(customer.text, /Nordlys Film/);
    assert.ok(customer.toolCalls.some((call) => call.name === 'get_customer'));

    const item = assistant.handle('Show item LGT-004');
    assert.equal(item.status, 'ok');
    assert.match(item.text, /LGT-004/);
    assert.ok(item.toolCalls.some((call) => call.name === 'get_item'));
  });

  test('"Show reservation RX-1001" is a lookup, not a create', () => {
    const { assistant } = setup();
    assert.equal(assistantApi.parseIntent('Show reservation RX-1001'), 'lookup');
    const response = assistant.handle('Show reservation RX-1001');
    assert.equal(response.intent, 'lookup');
    assert.equal(response.status, 'ok');
    assert.ok(response.toolCalls.some((call) => call.name === 'get_reservation'));
  });

  test('money and contract questions go to a human without a write', () => {
    const { store, assistant } = setup();
    const response = assistant.handle('Can I get a refund of my deposit?');
    assert.match(response.text, /human dispatcher/);
    assert.equal(store.getState().events.length, 0);
  });
});

describe('quantity parsing', () => {
  test('decimal and negative quantities are rejected instead of truncated', () => {
    const { store, assistant } = setup();
    for (const message of [
      'Book 2.5 × LGT-004 for Nordlys Film from 2027-04-01 to 2027-04-02',
      'Book -3 × LGT-004 for Nordlys Film from 2027-04-01 to 2027-04-02',
    ]) {
      const before = store.getState().reservations.length;
      const response = assistant.handle(message);
      assert.equal(response.status, 'error', message);
      assert.match(response.text, /whole number of 1 or more/, message);
      assert.equal(response.pending, null);
      assert.equal(store.getState().reservations.length, before);
    }
  });

  test('stock ids match case-insensitively', () => {
    const { store, assistant } = setup();
    const item = freeItem(store.getState(), '2027-04-01', '2027-04-02');
    const response = assistant.handle(`Book 1 × ${item.stockId.toLowerCase()} for Nordlys Film from 2027-04-01 to 2027-04-02`);
    assert.equal(response.pending.type, 'confirm-create');
    assert.equal(response.confirmation.items[0].stockId, item.stockId);
  });
});

describe('multi-turn slot filling', () => {
  test('create collects customer, then dates, then confirms', () => {
    const { store, assistant } = setup();
    const item = freeItem(store.getState(), '2027-05-01', '2027-05-03');
    let response = assistant.handle(`Book 1 × ${item.stockId}`);
    assert.equal(response.pending.type, 'collect-create');
    assert.match(response.text, /Which customer/);

    response = assistant.handle('Nordlys Film');
    assert.equal(response.pending.type, 'collect-create');
    assert.match(response.text, /Which dates/);

    response = assistant.handle('2027-05-01 to 2027-05-03');
    assert.equal(response.pending.type, 'confirm-create');
    assert.equal(response.confirmation.customerName, 'Nordlys Film');
    assert.equal(response.confirmation.start, '2027-05-01');

    const done = assistant.handle('yes');
    assert.equal(done.status, 'ok');
    assert.match(done.text, /Reservation RX-\d+ created/);
    assert.equal(store.getState().reservations.at(-1).items[0].stockId, item.stockId);
  });

  test('availability collects dates, then the item', () => {
    const { store, assistant } = setup();
    const item = freeItem(store.getState(), '2027-06-01', '2027-06-02');
    let response = assistant.handle('Check availability from 2027-06-01 to 2027-06-02');
    assert.equal(response.pending.type, 'collect-availability');
    assert.match(response.text, /Which item/);

    response = assistant.handle(item.stockId.toLowerCase());
    assert.equal(response.status, 'ok');
    assert.match(response.text, /free from 2027-06-01 to 2027-06-02/);
  });

  test('cancel with several open reservations asks for an id and accepts it', () => {
    const miniSeed = {
      version: 1,
      meta: { anchorDate: '2026-11-24' },
      equipment: [{ stockId: 'LGT-001', name: 'LED panel', brand: 'T', category: 'lighting', quantityOwned: 4, location: 'S', maintenance: 'ok' }],
      customers: [{ id: 'CUS-1', name: 'Nordlys Film', contact: { email: 'n@example.test', phone: '1' }, clientType: 'agency', history: {} }],
      reservations: [
        { id: 'RX-5001', customerId: 'CUS-1', start: '2026-12-01', end: '2026-12-02', status: 'confirmed', items: [{ stockId: 'LGT-001', quantity: 1 }] },
        { id: 'RX-5002', customerId: 'CUS-1', start: '2026-12-03', end: '2026-12-04', status: 'confirmed', items: [{ stockId: 'LGT-001', quantity: 1 }] },
      ],
    };
    const store = createStore(miniSeed, { now: CLOCK });
    const tools = createAssistantTools({ store });
    const assistant = assistantApi.createAssistant({ getTools: () => tools });

    let response = assistant.handle('Cancel Nordlys Film');
    assert.equal(response.status, 'ok');
    assert.match(response.text, /several open reservations/);
    assert.equal(response.pending.type, 'collect-cancel');

    response = assistant.handle('RX-5001');
    assert.equal(response.pending.type, 'confirm-cancel');
    assert.equal(response.confirmation.items[0].stockId, 'LGT-001');

    const done = assistant.handle('yes');
    assert.equal(done.status, 'ok');
    assert.equal(store.getState().reservations.find((row) => row.id === 'RX-5001').status, 'cancelled');
  });

  test('an ambiguous customer prompt accepts a follow-up id or name', () => {
    const miniSeed = {
      version: 1,
      meta: { anchorDate: '2026-11-24' },
      equipment: [{ stockId: 'LGT-001', name: 'LED panel', brand: 'T', category: 'lighting', quantityOwned: 4, location: 'S', maintenance: 'ok' }],
      customers: [
        { id: 'CUS-1', name: 'Studio One', contact: { email: 'one@example.test', phone: '1' }, clientType: 'agency', history: {} },
        { id: 'CUS-2', name: 'Studio Two', contact: { email: 'two@example.test', phone: '2' }, clientType: 'agency', history: {} },
      ],
      reservations: [
        { id: 'RX-5001', customerId: 'CUS-1', start: '2026-12-01', end: '2026-12-02', status: 'confirmed', items: [{ stockId: 'LGT-001', quantity: 1 }] },
        { id: 'RX-5002', customerId: 'CUS-2', start: '2026-12-03', end: '2026-12-04', status: 'confirmed', items: [{ stockId: 'LGT-001', quantity: 1 }] },
      ],
    };
    const makeAssistant = () => {
      const store = createStore(miniSeed, { now: CLOCK });
      const tools = createAssistantTools({ store });
      return assistantApi.createAssistant({ getTools: () => tools });
    };

    let assistant = makeAssistant();
    let response = assistant.handle('Cancel Studio');
    assert.equal(response.pending.type, 'collect-cancel');
    assert.match(response.text, /Several customers match/);
    response = assistant.handle('RX-5001');
    assert.equal(response.pending.type, 'confirm-cancel');

    assistant = makeAssistant();
    assistant.handle('Cancel Studio');
    response = assistant.handle('Studio Two');
    assert.equal(response.pending.type, 'confirm-cancel');
    assert.equal(response.confirmation.customerName, 'Studio Two');
  });
});
