/*
 * Pure read models for every view. No DOM, no store mutation, no clock reads
 * (callers pass the studio date). The same functions run in the browser and in
 * the Node test suite, so view logic is testable without a DOM.
 *
 * Loaded as a classic script after validation.js, before solver.js and store.js.
 */
(function () {
  'use strict';

  const { toDay, isoFromDay, addDays, daysBetween, eachDay } = typeof module !== 'undefined'
    ? require('./validation.js')
    : globalThis.RentalValidation;

  const OPEN_STATUSES = ['confirmed', 'held'];
  const USABLE_MAINTENANCE = ['ok'];

  function cloneValue(value) {
    return typeof structuredClone === 'function'
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  }

  function isOpen(reservation) {
    return OPEN_STATUSES.includes(reservation.status);
  }

  function blocksStock(reservation) {
    return reservation.status !== 'cancelled' && reservation.status !== 'returned';
  }

  function customerFor(state, customerId) {
    return state.customers.find((customer) => customer.id === customerId) || null;
  }

  function equipmentFor(state, stockId) {
    return state.equipment.find((item) => item.stockId === stockId) || null;
  }

  function quantityOf(reservation, stockId) {
    return reservation.items
      .filter((row) => row.stockId === stockId)
      .reduce((sum, row) => sum + row.quantity, 0);
  }

  /** Quantities held by reservations that overlap the range, excluding named reservations. */
  function bookedQuantity(state, stockId, start, end, excludeReservationIds = []) {
    const a = toDay(start);
    const b = toDay(end);
    if (a === null || b === null || a > b) return 0;
    const exclude = new Set(excludeReservationIds);
    let booked = 0;
    for (const reservation of state.reservations) {
      if (exclude.has(reservation.id) || !blocksStock(reservation)) continue;
      const r1 = toDay(reservation.start);
      const r2 = toDay(reservation.end);
      if (r1 === null || r2 === null || r1 > b || r2 < a) continue;
      booked += quantityOf(reservation, stockId);
    }
    return booked;
  }

  function availableQuantity(state, stockId, start, end, excludeReservationIds = []) {
    const item = equipmentFor(state, stockId);
    if (!item || !USABLE_MAINTENANCE.includes(item.maintenance)) return 0;
    return Math.max(0, item.quantityOwned - bookedQuantity(state, stockId, start, end, excludeReservationIds));
  }

  function stockAvailability(state, stockId, start, end, excludeReservationIds = []) {
    const item = equipmentFor(state, stockId);
    if (!item) return { stockId, item: null, owned: 0, booked: 0, available: 0, usable: false, reason: `${stockId} is not in the inventory.` };
    const booked = bookedQuantity(state, stockId, start, end, excludeReservationIds);
    let reason = null;
    if (item.maintenance === 'retired') reason = `${stockId} is retired and cannot be booked.`;
    else if (item.maintenance === 'in repair') reason = `${stockId} is in repair and cannot be booked.`;
    else if (booked >= item.quantityOwned) reason = `${stockId} is fully booked for these dates.`;
    return {
      stockId,
      item,
      owned: item.quantityOwned,
      booked,
      available: item.maintenance === 'ok' ? Math.max(0, item.quantityOwned - booked) : 0,
      usable: item.maintenance === 'ok',
      reason,
    };
  }

  /**
   * Free quantity per day for a set of stock lines across a window. One pass
   * over reservations, using day-number arrays, replaces repeated availability
   * scans during date search. Returns Map(stockId -> { owned, startDay, free: Int32Array }).
   */
  function availabilitySeries(state, stockIds, start, end, excludeReservationIds = []) {
    const startDay = toDay(start);
    const endDay = toDay(end);
    const series = new Map();
    if (startDay === null || endDay === null || startDay > endDay) return series;
    const length = endDay - startDay + 1;
    const unique = [...new Set(stockIds)];
    for (const stockId of unique) {
      const item = equipmentFor(state, stockId);
      const owned = item && item.maintenance === 'ok' ? item.quantityOwned : 0;
      const free = new Int32Array(length);
      free.fill(owned);
      series.set(stockId, { stockId, owned, startDay, endDay, free });
    }
    const exclude = new Set(excludeReservationIds);
    for (const reservation of state.reservations) {
      if (exclude.has(reservation.id) || !blocksStock(reservation)) continue;
      const reservationStart = toDay(reservation.start);
      const reservationEnd = toDay(reservation.end);
      if (reservationStart === null || reservationEnd === null) continue;
      const low = Math.max(startDay, reservationStart);
      const high = Math.min(endDay, reservationEnd);
      if (low > high) continue;
      for (const row of reservation.items) {
        const entry = series.get(row.stockId);
        if (!entry) continue;
        for (let day = low; day <= high; day += 1) {
          const index = day - startDay;
          entry.free[index] = Math.max(0, entry.free[index] - row.quantity);
        }
      }
    }
    return series;
  }

  function minimumFreeDays(series, stockId, startDay, endDay) {
    const entry = series.get(stockId);
    if (!entry) return 0;
    const low = Math.max(startDay, entry.startDay);
    const high = Math.min(endDay, entry.endDay);
    if (low > high) return 0;
    let minimum = Infinity;
    for (let day = low; day <= high; day += 1) {
      minimum = Math.min(minimum, entry.free[day - entry.startDay]);
    }
    return minimum === Infinity ? 0 : minimum;
  }

  function minimumFree(series, stockId, start, end) {
    const startDay = toDay(start);
    const endDay = toDay(end);
    if (startDay === null || endDay === null) return 0;
    return minimumFreeDays(series, stockId, startDay, endDay);
  }

  function fitsSeriesDays(series, items, startDay, endDay) {
    return items.every((row) => minimumFreeDays(series, row.stockId, startDay, endDay) >= row.quantity);
  }

  /** Alternative same-category stock with enough free quantity over the range. */
  function equivalentItems(state, stockId, start, end, quantity, excludeReservationIds = [], limit = 3) {
    const item = equipmentFor(state, stockId);
    if (!item) return [];
    const candidates = state.equipment
      .filter((candidate) => candidate.category === item.category
        && candidate.stockId !== stockId
        && candidate.maintenance === 'ok');
    if (candidates.length === 0) return [];
    const series = availabilitySeries(state, candidates.map((candidate) => candidate.stockId), start, end, excludeReservationIds);
    return candidates
      .map((candidate) => ({
        stockId: candidate.stockId,
        name: candidate.name,
        brand: candidate.brand,
        available: minimumFree(series, candidate.stockId, start, end),
      }))
      .filter((row) => row.available >= quantity)
      .sort((a, b) => b.available - a.available || a.stockId.localeCompare(b.stockId))
      .slice(0, limit);
  }

  /**
   * Drop suggested swaps that would collide with a line the panel already holds.
   * The manual panel treats stock ids as unique, so offering a swap to a stock
   * id already in the list would create a duplicate row.
   */
  function swapAlternatives(items, itemRows = []) {
    const held = new Set((Array.isArray(items) ? items : []).map((row) => row.stockId));
    return (Array.isArray(itemRows) ? itemRows : [])
      .map((row) => ({
        ...row,
        alternatives: (row.alternatives || []).filter((alternative) => !held.has(alternative.stockId)),
      }))
      .filter((row) => row.alternatives.length > 0);
  }

  /**
   * Nearest alternative ranges that fit the whole item set, expanding outwards
   * one day at a time to 60 days. The current range is not returned.
   */
  function freeDateAlternatives(state, { start, end, items, excludeReservationId = null, limit = 3, maxShift = 60 }) {
    const startDay = toDay(start);
    const endDay = toDay(end);
    if (startDay === null || endDay === null || startDay > endDay || !Array.isArray(items) || items.length === 0) return [];
    const length = endDay - startDay;
    const exclude = excludeReservationId ? [excludeReservationId] : [];
    const windowStart = isoFromDay(startDay - maxShift);
    const windowEnd = isoFromDay(endDay + maxShift);
    const series = availabilitySeries(state, items.map((row) => row.stockId), windowStart, windowEnd, exclude);
    const found = [];
    for (let shift = 1; shift <= maxShift && found.length < limit; shift += 1) {
      for (const direction of [1, -1]) {
        const candidateStart = startDay + direction * shift;
        const candidateEnd = candidateStart + length;
        if (fitsSeriesDays(series, items, candidateStart, candidateEnd)) {
          found.push({ start: isoFromDay(candidateStart), end: isoFromDay(candidateEnd), shift: direction * shift });
          break;
        }
      }
    }
    return found;
  }

  /**
   * Availability for an item set. Used by the manual panel, the assistant tool
   * and store validation, so all three agree.
   */
  function checkItems(state, input = {}) {
    const start = input.start;
    const end = input.end;
    const excludeReservationId = input.excludeReservationId || null;
    const exclude = excludeReservationId ? [excludeReservationId] : [];
    const rows = Array.isArray(input.items) ? input.items : [];
    const rangeError = toDay(start) === null
      ? `Invalid start date "${String(start)}". Use YYYY-MM-DD.`
      : toDay(end) === null
        ? `Invalid end date "${String(end)}". Use YYYY-MM-DD.`
        : toDay(start) > toDay(end)
          ? `The range ends on ${end}, before it starts on ${start}.`
          : null;
    if (!rangeError && rows.length === 0) {
      return { ok: false, feasible: false, error: 'Add at least one item.', start, end, items: [], alternatives: { dates: [], items: [] } };
    }
    if (!rangeError && rows.some((row) => !Number.isInteger(row.quantity) || row.quantity < 1)) {
      return { ok: false, feasible: false, error: 'Every quantity must be a whole number of 1 or more.', start, end, items: [], alternatives: { dates: [], items: [] } };
    }
    if (!rangeError && rows.length > 0) {
      const seen = new Set();
      for (const row of rows) {
        const stockId = row && typeof row.stockId === 'string' ? row.stockId.trim() : '';
        if (!stockId) continue;
        if (seen.has(stockId)) {
          return { ok: false, feasible: false, error: `List ${stockId} once and give it a single quantity.`, start, end, items: [], alternatives: { dates: [], items: [] } };
        }
        seen.add(stockId);
      }
    }

    const items = rangeError ? [] : rows.map((row) => {
      const status = stockAvailability(state, row.stockId, start, end, exclude);
      const short = Math.max(0, row.quantity - status.available);
      return {
        stockId: row.stockId,
        name: status.item ? status.item.name : row.stockId,
        category: status.item ? status.item.category : null,
        requested: row.quantity,
        owned: status.owned,
        booked: status.booked,
        available: status.available,
        short,
        reason: status.reason,
        alternatives: short > 0
          ? equivalentItems(state, row.stockId, start, end, row.quantity, exclude)
          : [],
      };
    });
    const feasible = !rangeError && items.length > 0 && items.every((item) => item.short === 0);
    let dates = [];
    if (!feasible && !rangeError) {
      const validRows = rows.filter((row) => equipmentFor(state, row.stockId));
      dates = freeDateAlternatives(state, { start, end, items: validRows, excludeReservationId });
    }
    return {
      ok: !rangeError,
      feasible,
      error: rangeError,
      start,
      end,
      items,
      alternatives: { dates, items: items.filter((item) => item.short > 0) },
    };
  }

  // --- conflicts -----------------------------------------------------------

  /**
   * One conflict per overbooked stock line. A line is overbooked when active
   * reservations on overlapping dates ask for more than quantityOwned.
   */
  function conflicts(state) {
    const groups = new Map();
    for (const reservation of state.reservations) {
      if (!blocksStock(reservation)) continue;
      for (const row of reservation.items) {
        if (!groups.has(row.stockId)) groups.set(row.stockId, []);
        groups.get(row.stockId).push({ reservation, quantity: row.quantity });
      }
    }

    const found = [];
    for (const item of state.equipment) {
      const rows = groups.get(item.stockId);
      if (!rows || rows.length === 0) continue;
      const days = new Map();
      for (const row of rows) {
        const start = toDay(row.reservation.start);
        const end = toDay(row.reservation.end);
        if (start === null || end === null) continue;
        for (let day = start; day <= end; day += 1) {
          if (!days.has(day)) days.set(day, { quantity: 0, reservations: new Set() });
          const entry = days.get(day);
          entry.quantity += row.quantity;
          entry.reservations.add(row.reservation.id);
        }
      }
      const over = [...days.entries()].filter(([, entry]) => entry.quantity > item.quantityOwned);
      if (over.length === 0) continue;
      const dates = over.map(([day]) => day).sort((a, b) => a - b);
      const reservationIds = [...new Set(over.flatMap(([, entry]) => [...entry.reservations]))].sort();
      const maxBooked = Math.max(...over.map(([, entry]) => entry.quantity));
      found.push({
        id: `CF-${item.stockId}`,
        stockId: item.stockId,
        name: item.name,
        category: item.category,
        location: item.location,
        owned: item.quantityOwned,
        maxBooked,
        overBy: maxBooked - item.quantityOwned,
        from: isoFromDay(dates[0]),
        to: isoFromDay(dates[dates.length - 1]),
        reservationIds,
        summary: `${item.name} (${item.stockId}) is booked ${maxBooked} times against ${item.quantityOwned} owned.`,
      });
    }
    return found.sort((a, b) => a.stockId.localeCompare(b.stockId));
  }

  // --- reservations --------------------------------------------------------

  function reservationRow(state, reservation) {
    const customer = customerFor(state, reservation.customerId);
    const items = reservation.items.map((row) => {
      const item = equipmentFor(state, row.stockId);
      return { ...row, name: item ? item.name : row.stockId, category: item ? item.category : null };
    });
    return {
      ...reservation,
      items: items.map((row) => ({ stockId: row.stockId, quantity: row.quantity })),
      customerName: customer ? customer.name : reservation.customerId,
      customerType: customer ? customer.clientType : null,
      itemCount: items.length,
      totalQuantity: items.reduce((sum, row) => sum + row.quantity, 0),
      itemsDetailed: items,
      itemsLabel: items.map((row) => `${row.quantity} × ${row.name}`).join(', '),
    };
  }

  /**
   * Filtered and sorted reservation rows. filter: { query, status, customerId,
   * sort: 'id'|'customer'|'start'|'end'|'status', dir: 'asc'|'desc' }.
   */
  function reservationsFor(state, filter = {}) {
    const query = String(filter.query || '').trim().toLowerCase();
    const status = filter.status || '';
    let rows = state.reservations.map((reservation) => reservationRow(state, reservation));
    if (status) rows = rows.filter((row) => row.status === status);
    if (filter.customerId) rows = rows.filter((row) => row.customerId === filter.customerId);
    if (query) {
      rows = rows.filter((row) => row.id.toLowerCase().includes(query)
        || row.customerName.toLowerCase().includes(query)
        || row.itemsDetailed.some((item) => item.stockId.toLowerCase().includes(query) || item.name.toLowerCase().includes(query)));
    }
    const sort = filter.sort || 'start';
    const direction = filter.dir === 'desc' ? -1 : 1;
    const value = (row) => {
      if (sort === 'customer') return row.customerName.toLowerCase();
      if (sort === 'end') return row.end;
      if (sort === 'status') return row.status;
      if (sort === 'id') return row.id;
      return row.start;
    };
    rows.sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      if (av < bv) return -1 * direction;
      if (av > bv) return 1 * direction;
      return a.id.localeCompare(b.id);
    });
    return rows;
  }

  function getReservation(state, id) {
    const reservation = state.reservations.find((row) => row.id === id);
    return reservation ? reservationRow(state, reservation) : null;
  }

  /**
   * Equipment table rows with today's out count, filtered and sorted. Sorting
   * supports name, category, owned, out and maintenance so the table is testable
   * without a DOM.
   */
  function equipmentRows(state, filter = {}) {
    const query = String(filter.query || '').trim().toLowerCase();
    const category = filter.category || '';
    const maintenance = filter.maintenance || '';
    const key = filter.sort || 'name';
    const direction = filter.dir === 'desc' ? -1 : 1;
    let rows = state.equipment.filter((item) => {
      if (category && item.category !== category) return false;
      if (maintenance && item.maintenance !== maintenance) return false;
      if (!query) return true;
      return item.stockId.toLowerCase().includes(query)
        || item.name.toLowerCase().includes(query)
        || item.brand.toLowerCase().includes(query)
        || item.location.toLowerCase().includes(query);
    }).map((item) => ({
      ...item,
      out: matrixCell(state, item.stockId, filter.today).booked,
    }));
    rows.sort((a, b) => {
      let av;
      let bv;
      if (key === 'owned') {
        av = a.quantityOwned;
        bv = b.quantityOwned;
      } else if (key === 'out') {
        av = a.out;
        bv = b.out;
      } else {
        av = String(a[key] ?? '').toLowerCase();
        bv = String(b[key] ?? '').toLowerCase();
      }
      if (av < bv) return -1 * direction;
      if (av > bv) return 1 * direction;
      return a.stockId.localeCompare(b.stockId);
    });
    return rows;
  }

  // --- calendar ------------------------------------------------------------

  const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  function calendarMonth(state, year, month) {
    const safeYear = Number.isInteger(year) ? year : 2026;
    const safeMonth = Number.isInteger(month) && month >= 0 && month <= 11 ? month : 0;
    const conflictDates = new Set();
    for (const conflict of conflicts(state)) {
      for (const day of eachDay(conflict.from, conflict.to)) conflictDates.add(day);
    }
    const active = state.reservations.filter(isOpen);
    const days = [];
    const distinct = new Set();
    for (let date = 1; date <= 31; date += 1) {
      const iso = isoFromDay(Date.UTC(safeYear, safeMonth, date) / (24 * 60 * 60 * 1000));
      if (!iso || toDay(iso) === null) break;
      const parts = iso.split('-').map(Number);
      if (parts[0] !== safeYear || parts[1] !== safeMonth + 1) break;
      const covering = active.filter((reservation) => toDay(reservation.start) <= toDay(iso) && toDay(iso) <= toDay(reservation.end));
      for (const reservation of covering) distinct.add(reservation.id);
      days.push({
        date: iso,
        day: date,
        reservations: covering.map((reservation) => reservationRow(state, reservation)),
        count: covering.length,
        itemsOut: covering.reduce((sum, reservation) => sum + reservation.items.reduce((qty, row) => qty + row.quantity, 0), 0),
        hasConflict: conflictDates.has(iso),
      });
    }
    return {
      year: safeYear,
      month: safeMonth,
      monthKey: `${safeYear}-${String(safeMonth + 1).padStart(2, '0')}`,
      label: `${MONTH_NAMES[safeMonth]} ${safeYear}`,
      firstWeekday: (new Date(Date.UTC(safeYear, safeMonth, 1)).getUTCDay() + 6) % 7,
      daysInMonth: days.length,
      days,
      totalReservations: distinct.size,
      totalDays: days.filter((day) => day.count > 0).length,
    };
  }

  // --- matrix and KPIs -----------------------------------------------------

  function matrixCell(state, itemId, date) {
    const item = equipmentFor(state, itemId);
    const reservations = state.reservations
      .filter((reservation) => blocksStock(reservation)
        && toDay(reservation.start) !== null
        && toDay(reservation.start) <= toDay(date)
        && toDay(date) <= toDay(reservation.end)
        && quantityOf(reservation, itemId) > 0)
      .map((reservation) => ({
        id: reservation.id,
        customerId: reservation.customerId,
        status: reservation.status,
        quantity: quantityOf(reservation, itemId),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const booked = reservations.reduce((sum, row) => sum + row.quantity, 0);
    const owned = item ? item.quantityOwned : 0;
    return {
      stockId: itemId,
      date,
      name: item ? item.name : null,
      category: item ? item.category : null,
      maintenance: item ? item.maintenance : null,
      owned,
      booked,
      available: item && item.maintenance === 'ok' ? Math.max(0, owned - booked) : 0,
      overbooked: booked > owned,
      reservations,
    };
  }

  function equipmentOutOn(state, date) {
    let total = 0;
    for (const reservation of state.reservations) {
      if (!blocksStock(reservation)) continue;
      if (toDay(reservation.start) <= toDay(date) && toDay(date) <= toDay(reservation.end)) {
        total += reservation.items.reduce((sum, row) => sum + row.quantity, 0);
      }
    }
    return total;
  }

  function kpis(state, today) {
    const active = state.reservations.filter(isOpen);
    return {
      today,
      pickupsToday: active.filter((reservation) => reservation.start === today).length,
      returnsToday: active.filter((reservation) => reservation.end === today).length,
      equipmentOutToday: equipmentOutOn(state, today),
      openConflicts: conflicts(state).length,
      activeReservations: active.length,
    };
  }

  function reservationsThisWeek(state, today) {
    const end = addDays(today, 6);
    return state.reservations.filter((reservation) => {
      if (!isOpen(reservation)) return false;
      return toDay(reservation.start) <= toDay(end) && toDay(reservation.end) >= toDay(today);
    }).length;
  }

  /** Counts the views need, derived from the state in one place. */
  function reservationCounts(state) {
    const rows = Array.isArray(state.reservations) ? state.reservations : [];
    return {
      total: rows.length,
      active: rows.filter(isOpen).length,
      confirmed: rows.filter((row) => row.status === 'confirmed').length,
      held: rows.filter((row) => row.status === 'held').length,
      returned: rows.filter((row) => row.status === 'returned').length,
      cancelled: rows.filter((row) => row.status === 'cancelled').length,
    };
  }

  function equipmentCount(state) {
    return Array.isArray(state.equipment) ? state.equipment.length : 0;
  }

  function customerCount(state) {
    return Array.isArray(state.customers) ? state.customers.length : 0;
  }

  /**
   * Proposal counts from already-built rows when the caller has them, so the
   * inbox is not built twice during one render.
   */
  function proposalCounts(state, proposalRows = null) {
    let rows = proposalRows;
    if (!Array.isArray(rows)) {
      try {
        const api = typeof module !== 'undefined'
          ? require('./proposals.js')
          : globalThis.RentalProposals;
        rows = api && typeof api.buildProposals === 'function' ? api.buildProposals(state) : [];
      } catch (error) {
        rows = [];
      }
    }
    const count = (status) => rows.filter((row) => row.status === status).length;
    return {
      total: rows.length,
      pending: count('pending'),
      human: count('human'),
      approved: count('approved'),
      rejected: count('rejected'),
      open: count('pending') + count('human'),
    };
  }

  // --- needs attention and activity ---------------------------------------

  function pendingProposalRows(state, proposalRows = null) {
    if (Array.isArray(proposalRows)) {
      return proposalRows.filter((proposal) => proposal.status === 'pending' || proposal.status === 'human');
    }
    try {
      const api = typeof module !== 'undefined'
        ? require('./proposals.js')
        : globalThis.RentalProposals;
      if (!api || typeof api.buildProposals !== 'function') return [];
      return api.buildProposals(state).filter((proposal) => proposal.status === 'pending' || proposal.status === 'human');
    } catch (error) {
      return [];
    }
  }

  function needsAttention(state, today, proposalRows = null) {
    const rows = [];
    const openProposals = pendingProposalRows(state, proposalRows);
    for (const conflict of conflicts(state)) {
      const active = openProposals.find((proposal) => proposal.reason === 'conflict'
        && proposal.conflict
        && proposal.conflict.id === conflict.id);
      rows.push({
        type: 'conflict',
        id: conflict.id,
        title: `Overbooked: ${conflict.name}`,
        detail: `${conflict.maxBooked} booked against ${conflict.owned} owned, ${conflict.from} to ${conflict.to}`,
        reservationId: conflict.reservationIds[0] || null,
        proposalId: active ? active.id : `RP-${conflict.id}`,
        tab: 'operations',
      });
    }
    for (const proposal of openProposals) {
      rows.push({
        type: 'proposal',
        id: proposal.id,
        title: proposal.status === 'human' ? `Proposal ${proposal.id} needs a human dispatcher` : `Proposal ${proposal.id} awaits approval`,
        detail: proposal.summary,
        reservationId: proposal.reservationId,
        proposalId: proposal.id,
        tab: 'operations',
      });
    }
    for (const reservation of state.reservations) {
      if (reservation.status === 'held') {
        const days = daysBetween(today, reservation.end);
        if (days !== null && days >= 0 && days <= 2) {
          rows.push({
            type: 'hold',
            id: `HOLD-${reservation.id}`,
            title: `Hold ${reservation.id} expires in ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'}`}`,
            detail: `${customerFor(state, reservation.customerId)?.name || reservation.customerId}, ${reservation.start} to ${reservation.end}`,
            reservationId: reservation.id,
            tab: 'reservations',
          });
        }
      }
      if (reservation.status === 'confirmed') {
        const pickup = daysBetween(today, reservation.start);
        if (pickup !== null && pickup >= 0 && pickup <= 2) {
          rows.push({
            type: 'pickup',
            id: `PICKUP-${reservation.id}`,
            title: `Pickup ${pickup === 0 ? 'today' : pickup === 1 ? 'tomorrow' : 'in 2 days'}: ${reservation.id}`,
            detail: `${customerFor(state, reservation.customerId)?.name || reservation.customerId}, ${reservation.items.length} item line(s)`,
            reservationId: reservation.id,
            tab: 'reservations',
          });
        }
      }
    }
    return rows;
  }

  function activityFeed(state, n = 10) {
    const limit = Number.isInteger(n) && n > 0 ? n : 10;
    return cloneValue(state.events.slice(-limit).reverse());
  }

  function customerMatches(state, query, limit = 10) {
    const text = String(query || '').trim().toLowerCase();
    const rows = state.customers.filter((customer) => !text
      || customer.name.toLowerCase().includes(text)
      || customer.id.toLowerCase().includes(text)
      || customer.contact.email.toLowerCase().includes(text));
    return rows.slice(0, limit).map((customer) => ({
      ...cloneValue(customer),
      totalBookings: customer.history?.totalBookings ?? 0,
      lastBookingDate: customer.history?.lastBookingDate ?? null,
    }));
  }

  function itemMatches(state, query, limit = 10) {
    const text = String(query || '').trim().toLowerCase();
    return cloneValue(state.equipment.filter((item) => !text
      || item.stockId.toLowerCase().includes(text)
      || item.name.toLowerCase().includes(text)
      || item.brand.toLowerCase().includes(text)
      || item.category.toLowerCase().includes(text))
      .slice(0, limit));
  }

  const api = {
    blocksStock,
    equipmentFor,
    availableQuantity,
    equivalentItems,
    swapAlternatives,
    freeDateAlternatives,
    checkItems,
    conflicts,
    reservationsFor,
    getReservation,
    equipmentRows,
    calendarMonth,
    matrixCell,
    kpis,
    reservationsThisWeek,
    reservationCounts,
    equipmentCount,
    customerCount,
    proposalCounts,
    needsAttention,
    activityFeed,
    customerMatches,
    itemMatches,
  };

  if (typeof module !== 'undefined') {
    module.exports = api;
  } else {
    globalThis.RentalSelectors = api;
  }
})();
