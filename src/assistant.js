/*
 * Rule-based booking assistant. Fixed patterns, a small slot-filling and
 * confirmation state machine, and templates filled only from tool output.
 * It never mutates state itself: writes call store-backed tools.
 */
(function () {
  'use strict';

  const { toDay } = typeof module !== 'undefined'
    ? require('./validation.js')
    : globalThis.RentalValidation;

  const LLM_CALLS = 0;

  const OPENING = 'I am an AI assistant, and answers may need checking. I can check availability, create a reservation, cancel one, or look up a customer, item or reservation. Every write goes through the reservation store and waits for your confirmation.';

  const DATE = /\b(\d{4}-\d{2}-\d{2})\b/g;
  const STOCK_ID = /\b([A-Z]{2,4}-\d{2,4})\b/gi;
  const RESERVATION_ID = /\b(RX-\d{4})\b/i;
  const LOOKUP_WORDS = /\b(show|detail|details|status|look ?up|find|what is|tell me)\b/i;
  const FEE_WORDS = /\b(fee|fees|charge|charges|cost|costs|pay|payment|refund|refunds|deposit|deposits|money|bill|billed|price|liab\w*|contract|clause|terms|agreement)\b/i;
  const CANCEL_WORDS = /\b(cancel|cancelled|canceling|cancelling|release|drop)\b/i;
  const CREATE_WORDS = /\b(book|booking|reserve|reservation|rent|create)\b/i;
  const AVAILABILITY_WORDS = /\b(available|availability|free|check)\b/i;
  const HELP_WORDS = /^(hi|hello|hey|help)\b|\b(what can you do|how does this work)\b/i;

  function response(parts) {
    return {
      intent: 'question',
      status: 'ok',
      text: '',
      toolCalls: [],
      pending: null,
      actions: [],
      confirmation: null,
      alternatives: null,
      ...parts,
    };
  }

  function isYes(text) {
    return /^(y|yes|yeah|yep|confirm|confirmed|ok|okay|proceed|do it|go ahead)\b/i.test(String(text).trim());
  }

  function isNo(text) {
    return /^(n|no|nope|stop|don't|do not|never mind|nevermind|cancel that)\b/i.test(String(text).trim());
  }

  function parseIntent(text) {
    const value = String(text);
    if (FEE_WORDS.test(value)) return 'question';
    // A reservation id plus lookup wording is a lookup even though the word
    // "reservation" also appears in the create pattern.
    if (RESERVATION_ID.test(value) && LOOKUP_WORDS.test(value)) return 'lookup';
    if (CANCEL_WORDS.test(value)) return 'cancel';
    if (CREATE_WORDS.test(value)) return 'create';
    if (RESERVATION_ID.test(value)) return 'lookup';
    if (AVAILABILITY_WORDS.test(value)) return 'availability';
    return 'question';
  }

  function parseDates(text) {
    const found = [];
    const invalid = [];
    for (const match of String(text).matchAll(DATE)) {
      if (toDay(match[1]) === null) invalid.push(match[1]);
      else found.push(match[1]);
    }
    return { dates: found, invalid };
  }

  function dateRange(dates) {
    if (dates.length === 0) return null;
    if (dates.length === 1) return { start: dates[0], end: dates[0] };
    return { start: dates[0], end: dates[1] };
  }

  function createAssistant(deps = {}) {
    const getTools = typeof deps.getTools === 'function' ? deps.getTools : () => deps.tools;
    let pending = null;

    function record(calls, name, input, output) {
      calls.push({ name, input, output });
      return output;
    }

    function callCustomer(calls, query) {
      return record(calls, 'get_customer', { query }, getTools().get_customer(query));
    }

    function callItem(calls, query) {
      return record(calls, 'get_item', { query }, getTools().get_item(query));
    }

    function callReservation(calls, id) {
      return record(calls, 'get_reservation', { id }, getTools().get_reservation(id));
    }

    function summaryItems(itemRows) {
      return itemRows.map((row) => ({
        stockId: row.stockId,
        name: row.name || row.stockId,
        quantity: row.quantity,
      }));
    }

    function formatItems(items) {
      return items.map((row) => `${row.quantity} × ${row.name || row.stockId} (${row.stockId})`).join(', ');
    }

    function formatAlternatives(alternatives) {
      if (!alternatives) return '';
      const parts = [];
      const dates = alternatives.dates || [];
      if (dates.length) {
        parts.push(`nearest free dates: ${dates.map((row) => `${row.start} to ${row.end}`).join(', ')}`);
      }
      const items = (alternatives.items || []).filter((row) => row.alternatives && row.alternatives.length);
      if (items.length) {
        parts.push(items.map((row) => `${row.stockId} could be ${row.alternatives.map((alt) => `${alt.stockId} (${alt.name})`).join(' or ')}`).join('; '));
      }
      return parts.length ? ` ${parts.join('. ')}.` : '';
    }

    const QUANTITY_BEFORE = /(-?\d+(?:\.\d+)?)\s*(?:x|×)\s*$/i;

    function parseQuantityToken(token) {
      if (token === undefined || token === null || token === '') return { quantity: 1 };
      const value = Number(token);
      if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
        return { error: `Quantity must be a whole number of 1 or more, not "${token}". Nothing was changed.` };
      }
      return { quantity: value };
    }

    /**
     * Parse "2 × LGT-004" lines. The quantity token is anchored before the ×,
     * signed and decimal-aware, so "2.5" and "-3" are rejected instead of being
     * truncated to 5 and 3.
     */
    function parseStockSpecs(text) {
      const specs = [];
      const seen = new Set();
      for (const match of String(text).matchAll(STOCK_ID)) {
        const stockId = match[1].toUpperCase();
        if (seen.has(stockId)) continue;
        seen.add(stockId);
        const before = String(text).slice(Math.max(0, match.index - 20), match.index);
        const qty = QUANTITY_BEFORE.exec(before);
        const parsed = parseQuantityToken(qty ? qty[1] : undefined);
        if (parsed.error) return { specs: [], error: parsed.error };
        specs.push({
          stockId,
          quantity: parsed.quantity,
          explicitQuantity: Boolean(qty),
          query: stockId,
        });
      }
      if (specs.length) return { specs };

      const named = /(-?\d+(?:\.\d+)?)?\s*(?:x|×)\s+([A-Za-z][A-Za-z0-9 &.'-]{1,40}?)(?=\s+(?:for|from|on|between|starting)\b|,|$)/i.exec(String(text));
      if (named) {
        const parsed = parseQuantityToken(named[1]);
        if (parsed.error) return { specs: [], error: parsed.error };
        specs.push({
          stockId: null,
          quantity: parsed.quantity,
          explicitQuantity: Boolean(named[1]),
          query: named[2].trim(),
        });
      }
      return { specs };
    }

    function customerQueryFrom(text) {
      const quoted = /\bfor\s+["“]([^"”]+)["”]/i.exec(text);
      if (quoted) return quoted[1].trim();
      const forMatch = /\bfor\s+(.+?)(?=\s+from\b|\s+on\b|\s+between\b|\s+starting\b|\s+\d{4}-\d{2}-\d{2}|$)/i.exec(text);
      if (forMatch) return forMatch[1].replace(/\s+/g, ' ').trim();
      const customerMatch = /\b(?:customer|client)\s+(.+?)(?=\s+from\b|\s+on\b|\s+\d{4}-\d{2}-\d{2}|$)/i.exec(text);
      return customerMatch ? customerMatch[1].replace(/\s+/g, ' ').trim() : '';
    }

    function resolveCustomer(calls, query, slots) {
      if (!query) return { slots };
      const found = callCustomer(calls, query);
      if (found.matches.length === 0) {
        return { error: `No customer matches "${query}". Give the customer's full name or id.`, calls };
      }
      const exact = found.matches.find((customer) => customer.name.toLowerCase() === String(query).trim().toLowerCase()
        || customer.id.toLowerCase() === String(query).trim().toLowerCase());
      if (exact) {
        return { slots: { ...slots, customerId: exact.id, customerName: exact.name }, calls };
      }
      if (found.matches.length > 1) {
        const names = found.matches.slice(0, 6).map((customer) => `${customer.name} (${customer.id})`).join(', ');
        return {
          clarify: `Several customers match "${query}": ${names}. Which one should I use?`,
          slots: { ...slots, customerCandidates: found.matches.map((customer) => ({ id: customer.id, name: customer.name })) },
          calls,
        };
      }
      const [customer] = found.matches;
      return { slots: { ...slots, customerId: customer.id, customerName: customer.name }, calls };
    }

    function resolveItems(calls, specs, slots, previousItems) {
      if (specs.length === 0) return { slots };
      const items = [];
      for (const spec of specs) {
        const found = callItem(calls, spec.query);
        if (!found.found) {
          return { error: `No equipment matches "${spec.query}". Try a stock id such as LGT-004.`, calls };
        }
        if (found.matches.length > 1) {
          const names = found.matches.slice(0, 6).map((item) => `${item.stockId} ${item.name}`).join(', ');
          return {
            clarify: `Several items match "${spec.query}": ${names}. Give the stock id you want.`,
            slots: { ...slots, itemQueries: specs.map((row) => row.query) },
            calls,
          };
        }
        const [item] = found.matches;
        if (item.maintenance !== 'ok') {
          return { error: `${item.stockId} is ${item.maintenance} and cannot be booked.`, calls };
        }
        items.push({
          stockId: item.stockId,
          name: item.name,
          quantity: spec.quantity,
          category: item.category,
        });
      }
      if (items.length === 0 && Array.isArray(previousItems)) return { slots };
      return { slots: { ...slots, items } };
    }

    function nextMissing(slots) {
      if (!slots.customerId) return 'customer';
      if (!slots.start || !slots.end) return 'dates';
      if (!Array.isArray(slots.items) || slots.items.length === 0) return 'items';
      return null;
    }

    function clarify(missing, slots, calls, extra = '') {
      const prompts = {
        customer: 'Which customer is this reservation for? Give their name or customer id.',
        dates: 'Which dates? Give two dates as YYYY-MM-DD, for example 2026-12-10 to 2026-12-12.',
        items: 'Which items and quantities? For example "2 × LGT-004".',
      };
      return response({
        intent: 'create',
        status: 'ok',
        text: `${prompts[missing]}${extra}`,
        toolCalls: calls,
        pending: { type: 'collect-create', slots },
      });
    }

    /** Fill create slots from one message, then ask for the next missing field. */
    function collectCreate(text, startingSlots = {}, initialCalls = []) {
      const calls = [...initialCalls];
      let slots = { ...startingSlots };
      const parsed = parseDates(text);
      if (parsed.invalid.length) {
        return response({
          intent: 'create',
          status: 'error',
          text: `Not a real date: ${parsed.invalid.join(', ')}. Use YYYY-MM-DD.`,
          toolCalls: calls,
        });
      }
      if (parsed.dates.length) {
        const range = dateRange(parsed.dates);
        slots = { ...slots, ...range };
      }

      const parsedSpecs = parseStockSpecs(text);
      if (parsedSpecs.error) {
        return response({ intent: 'create', status: 'error', text: parsedSpecs.error, toolCalls: calls });
      }
      const specs = parsedSpecs.specs;
      let itemResult = { slots };
      if (specs.length) {
        itemResult = resolveItems(calls, specs, slots, slots.items);
        if (itemResult.error || itemResult.clarify) {
          if (itemResult.error) return response({ intent: 'create', status: 'error', text: itemResult.error, toolCalls: calls });
          return response({
            intent: 'create',
            text: itemResult.clarify,
            toolCalls: calls,
            pending: { type: 'collect-create', slots: itemResult.slots },
          });
        }
        slots = itemResult.slots;
      }

      let query = customerQueryFrom(text);
      if (!query && !slots.customerId) {
        // A short reply to "which customer?" is treated as the customer answer.
        const trimmed = text.trim();
        if (trimmed.length > 0 && trimmed.length <= 60 && specs.length === 0 && parsed.dates.length === 0) {
          query = trimmed;
        }
      }
      if (query) {
        const customerResult = resolveCustomer(calls, query, slots);
        if (customerResult.error) return response({ intent: 'create', status: 'error', text: customerResult.error, toolCalls: calls });
        if (customerResult.clarify) {
          return response({
            intent: 'create',
            text: customerResult.clarify,
            toolCalls: calls,
            pending: { type: 'collect-create', slots: customerResult.slots },
          });
        }
        slots = customerResult.slots;
      }

      const missing = nextMissing(slots);
      if (missing) return clarify(missing, slots, calls);

      const dateProblem = toDay(slots.start) > toDay(slots.end)
        ? `The range ends on ${slots.end}, before it starts on ${slots.start}.`
        : null;
      if (dateProblem) return response({ intent: 'create', status: 'error', text: dateProblem, toolCalls: calls });

      return proposeCreate(slots, calls);
    }

    function proposeCreate(slots, calls) {
      const input = {
        customerId: slots.customerId,
        start: slots.start,
        end: slots.end,
        items: slots.items.map((row) => ({ stockId: row.stockId, quantity: row.quantity })),
      };
      const check = record(calls, 'check_availability', { start: input.start, end: input.end, items: input.items }, getTools().check_availability({
        start: input.start,
        end: input.end,
        items: input.items,
      }));
      if (!check.ok) {
        return response({ intent: 'create', status: 'error', text: `The availability check failed: ${check.error}`, toolCalls: calls });
      }
      if (!check.feasible) {
        const shortList = check.items.filter((row) => row.short > 0)
          .map((row) => `${row.stockId} short by ${row.short} (${row.available} available of ${row.requested})`)
          .join('; ');
        pending = null;
        return response({
          intent: 'create',
          status: 'error',
          text: `That reservation would overbook: ${shortList}. Nothing was saved.${formatAlternatives(check.alternatives)}`,
          toolCalls: calls,
          alternatives: check.alternatives,
        });
      }
      const confirmation = {
        customerId: input.customerId,
        customerName: slots.customerName,
        start: input.start,
        end: input.end,
        items: summaryItems(slots.items),
        totalQuantity: slots.items.reduce((sum, row) => sum + row.quantity, 0),
      };
      pending = { type: 'confirm-create', input, confirmation };
      return response({
        intent: 'create',
        status: 'ok',
        text: `I can reserve ${formatItems(slots.items)} for ${slots.customerName}, ${input.start} to ${input.end}. Total quantity: ${confirmation.totalQuantity}. Everything is free. Reply "yes" to create it or "no" to stop.`,
        toolCalls: calls,
        confirmation,
        pending,
      });
    }

    function finishCreate(calls = []) {
      const input = pending.input;
      const confirmation = pending.confirmation;
      if (!input) {
        pending = null;
        return response({ intent: 'create', status: 'error', text: 'There is nothing waiting to confirm. Start a new request.' });
      }
      pending = null;
      const created = record(calls, 'create_reservation', input, getTools().create_reservation(input));
      if (!created.ok) {
        return response({
          intent: 'create',
          status: 'error',
          text: `I could not create the reservation: ${created.error}. Nothing was saved.${formatAlternatives(created.alternatives)}`,
          toolCalls: calls,
          alternatives: created.alternatives,
        });
      }
      return response({
        intent: 'create',
        status: 'ok',
        text: `Reservation ${created.reservation.id} created for ${created.view.customerName}, ${created.reservation.start} to ${created.reservation.end}: ${created.view.itemsLabel}. Total quantity: ${created.view.totalQuantity}.`,
        toolCalls: calls,
        confirmation,
        actions: [{ type: 'open-reservation', reservationId: created.reservation.id, label: `Open ${created.reservation.id}` }],
      });
    }

    function describeReservation(view) {
      return `${view.id}: ${view.customerName}, ${view.start} to ${view.end}, ${view.itemsLabel}. Total quantity ${view.totalQuantity}. Status ${view.status}.`;
    }

    function askCancel(text) {
      const calls = [];
      const idMatch = RESERVATION_ID.exec(text);
      let reservationId = idMatch ? idMatch[1].toUpperCase() : null;

      if (!reservationId) {
        const withoutVerb = String(text).replace(/\b(cancel|cancelled|canceling|cancelling|release|drop)\b/gi, '').trim();
        const query = withoutVerb.replace(/\breservation\b/gi, '').replace(/\bfor\b/gi, '').trim();
        if (!query) {
          return response({ intent: 'cancel', status: 'error', text: 'Which reservation should I cancel? Give an id such as RX-1001, or the customer name.' });
        }
        const found = callCustomer(calls, query);
        if (!found.found) {
          return response({ intent: 'cancel', status: 'error', text: `No customer matches "${query}". Give a reservation id or the customer's full name.`, toolCalls: calls });
        }
        if (found.matches.length > 1) {
          const names = found.matches.slice(0, 6).map((customer) => `${customer.name} (${customer.id})`).join(', ');
          return response({
            intent: 'cancel',
            text: `Several customers match "${query}": ${names}. Which customer?`,
            toolCalls: calls,
            pending: { type: 'collect-cancel', query },
          });
        }
        const [customer] = found.matches;
        const active = (customer.activeReservations || []).filter((row) => row.status === 'confirmed' || row.status === 'held');
        if (active.length === 0) {
          return response({ intent: 'cancel', status: 'error', text: `${customer.name} has no open reservation to cancel.`, toolCalls: calls });
        }
        if (active.length > 1) {
          const list = active.slice(0, 6).map((row) => `${row.id} (${row.start} to ${row.end})`).join(', ');
          return response({
            intent: 'cancel',
            text: `${customer.name} has several open reservations: ${list}. Which id should I cancel?`,
            toolCalls: calls,
            pending: { type: 'collect-cancel', customerId: customer.id, query: customer.name },
          });
        }
        reservationId = active[0].id;
      }

      const lookup = callReservation(calls, reservationId);
      if (!lookup.ok) return response({ intent: 'cancel', status: 'error', text: lookup.error, toolCalls: calls });
      const view = lookup.reservation;
      if (view.status === 'cancelled') {
        return response({ intent: 'cancel', status: 'error', text: `Reservation ${view.id} is already cancelled. Nothing was changed.`, toolCalls: calls });
      }
      if (view.status === 'returned') {
        return response({ intent: 'cancel', status: 'error', text: `Reservation ${view.id} has already been returned. Nothing was changed.`, toolCalls: calls });
      }
      const confirmation = {
        customerId: view.customerId,
        customerName: view.customerName,
        start: view.start,
        end: view.end,
        items: view.itemsDetailed.map((row) => ({ stockId: row.stockId, name: row.name, quantity: row.quantity })),
        totalQuantity: view.totalQuantity,
      };
      pending = { type: 'confirm-cancel', reservationId: view.id, confirmation };
      return response({
        intent: 'cancel',
        text: `You asked to cancel ${describeReservation(view)} That frees ${view.totalQuantity} item(s): ${view.itemsLabel}. Nothing changes until you confirm. Reply "yes" to cancel or "no" to stop.`,
        toolCalls: calls,
        confirmation,
        pending,
      });
    }

    function finishCancel(calls = []) {
      const id = pending.reservationId;
      const confirmation = pending.confirmation;
      pending = null;
      const cancelled = record(calls, 'cancel_reservation', { id }, getTools().cancel_reservation(id));
      if (!cancelled.ok) {
        return response({ intent: 'cancel', status: 'error', text: `I could not cancel ${id}: ${cancelled.error}. Nothing was changed.`, toolCalls: calls });
      }
      const proposalLine = cancelled.proposals && cancelled.proposals.length
        ? ` Operations proposal ${cancelled.proposals[0].id} is now in the inbox.`
        : '';
      return response({
        intent: 'cancel',
        status: 'ok',
        text: `Reservation ${id} cancelled. Freed: ${cancelled.freedItems.map((row) => `${row.quantity} × ${row.name}`).join(', ')}.${proposalLine}`,
        toolCalls: calls,
        confirmation,
        actions: [
          { type: 'open-reservation', reservationId: id, label: `Open ${id}` },
          { type: 'open-operations', label: 'Open Operations' },
        ],
      });
    }

    function fillAvailability(text, startingSlots = {}, initialCalls = []) {
      const calls = [...initialCalls];
      let slots = { ...startingSlots };
      const parsed = parseDates(text);
      if (parsed.invalid.length) {
        return response({ intent: 'availability', status: 'error', text: `Not a real date: ${parsed.invalid.join(', ')}.`, toolCalls: calls });
      }
      if (parsed.dates.length) slots = { ...slots, ...dateRange(parsed.dates) };
      const parsedSpecs = parseStockSpecs(text);
      if (parsedSpecs.error) {
        return response({ intent: 'availability', status: 'error', text: parsedSpecs.error, toolCalls: calls });
      }
      const specs = parsedSpecs.specs;
      if (specs.length) {
        const resolved = resolveItems(calls, specs, slots, slots.items);
        if (resolved.error) return response({ intent: 'availability', status: 'error', text: resolved.error, toolCalls: calls });
        if (resolved.clarify) {
          return response({
            intent: 'availability',
            text: resolved.clarify,
            toolCalls: calls,
            pending: { type: 'collect-availability', slots: resolved.slots },
          });
        }
        slots = resolved.slots;
      }
      let missing = null;
      if (!slots.start || !slots.end) missing = 'dates';
      else if (!Array.isArray(slots.items) || slots.items.length === 0) missing = 'items';
      if (missing) {
        const prompts = {
          dates: 'Which dates? Give two dates as YYYY-MM-DD.',
          items: 'Which item stock ids should I check? For example LGT-004.',
        };
        return response({
          intent: 'availability',
          text: prompts[missing],
          toolCalls: calls,
          pending: { type: 'collect-availability', slots },
        });
      }
      const items = slots.items.map((row) => ({ stockId: row.stockId, quantity: row.quantity }));
      const check = record(calls, 'check_availability', { start: slots.start, end: slots.end, items }, getTools().check_availability({
        start: slots.start,
        end: slots.end,
        items,
      }));
      if (!check.ok) return response({ intent: 'availability', status: 'error', text: `The check failed: ${check.error}`, toolCalls: calls });
      if (check.feasible) {
        return response({
          intent: 'availability',
          status: 'ok',
          text: `${formatItems(slots.items)} are free from ${slots.start} to ${slots.end}. Nothing has been reserved.`,
          toolCalls: calls,
        });
      }
      const shortList = check.items.filter((row) => row.short > 0)
        .map((row) => `${row.stockId}: ${row.available} available of ${row.requested}`)
        .join('; ');
      return response({
        intent: 'availability',
        status: 'ok',
        text: `${shortList}. Not enough stock for ${slots.start} to ${slots.end}.${formatAlternatives(check.alternatives)}`,
        toolCalls: calls,
        alternatives: check.alternatives,
      });
    }

    function answerQuestion(text) {
      const calls = [];
      const idMatch = RESERVATION_ID.exec(text);
      if (idMatch) {
        const lookup = callReservation(calls, idMatch[1].toUpperCase());
        if (!lookup.ok) return response({ intent: 'lookup', status: 'error', text: lookup.error, toolCalls: calls });
        return response({ intent: 'lookup', status: 'ok', text: describeReservation(lookup.reservation), toolCalls: calls });
      }
      if (/\b(customer|client)s?\b/i.test(text)) {
        const query = text.replace(/.*\b(customer|client)s?\b/i, '').replace(/^(named|called|is)\s+/i, '').trim();
        const found = callCustomer(calls, query);
        if (!found.found) return response({ intent: 'lookup', status: 'error', text: found.message, toolCalls: calls });
        const lines = found.matches.slice(0, 5).map((customer) => `${customer.name} (${customer.id}), ${customer.clientType}, ${customer.history.totalBookings} booking(s)`).join('; ');
        return response({ intent: 'lookup', status: 'ok', text: lines, toolCalls: calls });
      }
      if (/\b(item|equipment|stock|gear)\b/i.test(text)) {
        const query = text.replace(/.*\b(item|equipment|stock|gear)\b/i, '').replace(/^(named|called|is)\s+/i, '').trim();
        const found = callItem(calls, query);
        if (!found.found) return response({ intent: 'lookup', status: 'error', text: found.message, toolCalls: calls });
        const lines = found.matches.slice(0, 5).map((item) => `${item.stockId} ${item.name}, ${item.category}, ${item.quantityOwned} owned, ${item.maintenance}`).join('; ');
        return response({ intent: 'lookup', status: 'ok', text: lines, toolCalls: calls });
      }
      if (FEE_WORDS.test(text)) {
        return response({
          intent: 'question',
          text: 'Money and contract questions go to a human dispatcher; I cannot decide them. Nothing was changed.',
          toolCalls: calls,
        });
      }
      return response({
        intent: 'question',
        text: `I can check availability, create a reservation, cancel one, or look up a customer, item or reservation. Try "Check availability of LGT-004 from 2026-12-10 to 2026-12-12" or "Cancel RX-1001". ${OPENING.split('. ')[0]}.`,
        toolCalls: calls,
      });
    }

    /** Route one message. `handle` below persists any pending clarification. */
    function route(message) {
      const text = String(message == null ? '' : message).trim();
      if (!text) {
        return response({ status: 'error', text: 'Type a request, for example "Check availability of LGT-004 from 2026-12-10 to 2026-12-12".' });
      }

      if (pending) {
        if (pending.type === 'confirm-create') {
          if (isYes(text)) return finishCreate();
          if (isNo(text)) {
            pending = null;
            return response({ intent: 'confirmation', text: 'Stopped. Nothing was saved.' });
          }
          // A new request replaces the unconfirmed one.
          pending = null;
        } else if (pending.type === 'confirm-cancel') {
          if (isYes(text)) return finishCancel();
          if (isNo(text)) {
            pending = null;
            return response({ intent: 'confirmation', text: 'Stopped. Nothing was changed.' });
          }
          pending = null;
        } else if (pending.type === 'collect-create') {
          const slots = pending.slots;
          pending = null;
          return collectCreate(text, slots);
        } else if (pending.type === 'collect-availability') {
          const slots = pending.slots;
          pending = null;
          return fillAvailability(text, slots);
        } else if (pending.type === 'collect-cancel') {
          // The follow-up may be a reservation id or a customer name/id.
          pending = null;
          return askCancel(`cancel ${text}`);
        }
      }

      const intent = parseIntent(text);
      if (intent === 'cancel') return askCancel(text);
      if (intent === 'create') return collectCreate(text);
      if (intent === 'availability') return fillAvailability(text);
      if (HELP_WORDS.test(text) && !FEE_WORDS.test(text)) {
        return response({
          intent: 'question',
          text: `${OPENING} Try "Check availability of LGT-004 from 2026-12-10 to 2026-12-12" or "Cancel RX-1001".`,
        });
      }
      return answerQuestion(text);
    }

    function handle(message) {
      const result = route(message);
      // The only source of truth for the state machine: persist exactly what the
      // router asked the next turn to collect or confirm, clear it otherwise.
      pending = result.pending || null;
      return result;
    }

    function reset() {
      pending = null;
    }

    return { handle, reset };
  }

  const api = {
    LLM_CALLS,
    OPENING,
    parseIntent,
    parseDates,
    createAssistant,
  };

  if (typeof module !== 'undefined') {
    module.exports = api;
  } else {
    globalThis.RentalAssistant = api;
  }
})();
