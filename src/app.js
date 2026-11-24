/*
 * UI wiring for the Atelier Lumière back office.
 *
 * All rendering uses createElement() and textContent. The page loads one seed
 * file, builds one store, and every view renders from selectors. A single store
 * subscription re-renders every view after a write and shows the toast for the
 * operations event that write appended.
 */
(function () {
  'use strict';

  const selectors = globalThis.RentalSelectors;
  const storeApi = globalThis.RentalStore;
  const proposalsApi = globalThis.RentalProposals;
  const toolsApi = globalThis.RentalAssistantTools;
  const assistantApi = globalThis.RentalAssistant;
  const { toDay, rangeProblem, parseQuantityInput } = globalThis.RentalValidation;

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MONTHS_SHORT = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const TAB_NAMES = ['home', 'calendar', 'equipment', 'reservations', 'operations', 'assistant'];
  const STATUS_BADGES = {
    confirmed: { label: 'Confirmed', variant: 'confirmed' },
    held: { label: 'Held', variant: 'held' },
    returned: { label: 'Returned', variant: 'returned' },
    cancelled: { label: 'Cancelled', variant: 'cancelled' },
  };
  const FEASIBILITY_BADGES = {
    feasible: { label: 'Feasible', variant: 'feasible' },
    partial: { label: 'Partial', variant: 'partial' },
    none: { label: 'No plan', variant: 'none' },
  };
  const PROPOSAL_STATUS = {
    pending: { label: 'Pending', variant: 'pending' },
    approved: { label: 'Approved', variant: 'approved' },
    rejected: { label: 'Rejected', variant: 'rejected' },
    human: { label: 'Human dispatcher', variant: 'human' },
  };

  const $ = (id) => document.getElementById(id);

  const els = {
    bootState: $('boot-state'),
    bootError: $('boot-error'),
    menuToggle: $('menu-toggle'),
    navBackdrop: $('nav-backdrop'),
    navTabs: [...document.querySelectorAll('.nav-tab')],
    navOperationsCount: $('nav-operations-count'),
    topbarDate: $('topbar-date'),
    newReservation: $('new-reservation'),
    toast: $('toast'),
    toastText: $('toast-text'),
    toastLink: $('toast-link'),
    toastClose: $('toast-close'),
    homeDate: $('home-date'),
    homeTitle: $('home-title'),
    homeDayNumber: $('home-day-number'),
    homeDayMonth: $('home-day-month'),
    kpiPickups: $('kpi-pickups'),
    kpiReturns: $('kpi-returns'),
    kpiOut: $('kpi-out'),
    kpiConflicts: $('kpi-conflicts'),
    attentionCount: $('attention-count'),
    attentionState: $('attention-state'),
    attentionList: $('attention-list'),
    activityState: $('activity-state'),
    activityFeed: $('activity-feed'),
    toolGrid: $('tool-grid'),
    calPrev: $('cal-prev'),
    calNext: $('cal-next'),
    calToday: $('cal-today'),
    calMonth: $('cal-month'),
    calendarState: $('calendar-state'),
    calendarGrid: $('calendar-grid'),
    calendarMonthNote: $('calendar-month-note'),
    dayTitle: $('day-title'),
    dayCount: $('day-count'),
    dayState: $('day-state'),
    dayList: $('day-list'),
    equipmentSearch: $('equipment-search'),
    equipmentFilter: $('equipment-filter'),
    equipmentStatus: $('equipment-status'),
    equipmentCount: $('equipment-count'),
    equipmentState: $('equipment-state'),
    equipmentTableWrap: $('equipment-table-wrap'),
    equipmentRows: $('equipment-rows'),
    reservationSearch: $('reservation-search'),
    reservationFilter: $('reservation-filter'),
    reservationCount: $('reservation-count'),
    reservationsState: $('reservations-state'),
    reservationsTableWrap: $('reservations-table-wrap'),
    reservationRows: $('reservation-rows'),
    reservationDetail: $('reservation-detail'),
    reservationDetailTitle: $('reservation-detail-title'),
    reservationDetailBody: $('reservation-detail-body'),
    reservationDetailClose: $('reservation-detail-close'),
    proposalFilter: $('proposal-filter'),
    proposalCount: $('proposal-count'),
    proposalState: $('proposal-state'),
    proposalList: $('proposal-list'),
    chatLog: $('chat-log'),
    chatStatus: $('chat-status'),
    chatChips: $('chat-chips'),
    chatForm: $('chat-form'),
    chatInput: $('chat-input'),
    chatSend: $('chat-send'),
    panelBackdrop: $('panel-backdrop'),
    panel: $('reservation-panel'),
    panelClose: $('panel-close'),
    panelCancel: $('panel-cancel'),
    panelForm: $('reservation-form'),
    panelCustomerSearch: $('panel-customer-search'),
    panelCustomerResults: $('panel-customer-results'),
    panelCustomerSelected: $('panel-customer-selected'),
    panelStart: $('panel-start'),
    panelEnd: $('panel-end'),
    panelItemSearch: $('panel-item-search'),
    panelItemResults: $('panel-item-results'),
    panelItems: $('panel-items'),
    panelAvailability: $('panel-availability'),
    panelAlternatives: $('panel-alternatives'),
    panelError: $('panel-error'),
    panelSubmit: $('panel-submit'),
  };

  let store = null;
  let tools = null;
  let assistant = null;
  let anchorDate = '2026-11-24';
  let calendar = { year: 2026, month: 10, selected: null, ready: false };
  let equipmentSort = { key: 'name', dir: 'asc' };
  let reservationSort = { key: 'start', dir: 'asc' };
  let selectedReservationId = null;
  let assistantBusy = false;
  let toastTimer = null;
  let lastFocus = null;
  const panel = {
    customerId: null,
    customerName: null,
    items: [],
  };

  // --- DOM helpers ---------------------------------------------------------

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }

  function svgIcon(paths, size = 20) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('aria-hidden', 'true');
    for (const pathData of paths) {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', pathData);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.7');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.append(path);
    }
    return svg;
  }

  function cell(label, ...content) {
    const td = el('td');
    td.dataset.label = label;
    td.append(...content);
    return td;
  }

  function badge(label, variant) {
    return el('span', label, `badge badge-${variant}`);
  }

  function statusBadge(status) {
    const spec = STATUS_BADGES[status] || { label: status, variant: 'returned' };
    return badge(spec.label, spec.variant);
  }

  function setState(node, message, kind = 'empty') {
    if (!message) {
      node.hidden = true;
      node.textContent = '';
      node.className = 'state';
      return;
    }
    node.hidden = false;
    node.textContent = message;
    node.className = `state state-${kind}`;
  }

  function button(text, className, onClick) {
    const node = el('button', text, className);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  function parseIso(iso) {
    const day = toDay(iso);
    if (day === null) return null;
    const date = new Date(day * 86400000);
    return { year: date.getUTCFullYear(), month: date.getUTCMonth(), date: date.getUTCDate(), weekday: date.getUTCDay() };
  }

  function prettyDate(iso) {
    const parts = parseIso(iso);
    if (!parts) return iso;
    return `${WEEKDAYS_LONG[parts.weekday]} ${parts.date} ${MONTHS[parts.month]} ${parts.year}`;
  }

  function shortDate(iso) {
    const parts = parseIso(iso);
    return parts ? `${parts.date} ${MONTHS[parts.month].slice(0, 3)} ${parts.year}` : iso;
  }

  function isoFromParts(year, month, date) {
    return new Date(Date.UTC(year, month, date)).toISOString().slice(0, 10);
  }

  function eventTime(at) {
    if (!at) return '';
    const iso = String(at);
    if (iso.includes('T')) return `${iso.slice(8, 10)} ${MONTHS_SHORT[Number(iso.slice(5, 7)) - 1]} · ${iso.slice(11, 16)}`;
    return shortDate(iso);
  }

  // --- boot ----------------------------------------------------------------

  async function boot() {
    try {
      const response = await fetch('data/seed.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const seed = await response.json();
      start(seed);
    } catch (error) {
      els.bootState.hidden = true;
      els.bootError.hidden = false;
      els.bootError.textContent = `The studio data could not be loaded (${error instanceof Error ? error.message : String(error)}). Serve this folder from a static HTTP server and reload; opening index.html directly from file:// blocks the seed file request.`;
      els.newReservation.disabled = true;
    }
  }

  function start(seed) {
    anchorDate = seed.meta?.anchorDate || '2026-11-24';
    store = storeApi.createStore(seed);
    tools = toolsApi.createAssistantTools({ store });
    assistant = assistantApi.createAssistant({ getTools: () => tools });

    const anchor = parseIso(anchorDate);
    calendar = { year: anchor.year, month: anchor.month, selected: anchorDate, ready: true };

    populateCategoryFilter(seed);
    els.topbarDate.textContent = prettyDate(anchorDate);
    els.homeDate.textContent = prettyDate(anchorDate);
    els.homeDayNumber.textContent = String(anchor.date);
    els.homeDayMonth.textContent = MONTHS_SHORT[anchor.month];

    store.subscribe(onStoreChange);
    bindEvents();
    setupChatChips();
    renderAll();
    appendOpeningMessage();
    els.bootState.hidden = true;

    const initial = window.location.hash.replace('#', '');
    showTab(TAB_NAMES.includes(initial) ? initial : 'home', { focus: false, updateHash: false });
  }

  function onStoreChange(state) {
    renderAll(state);
    renderAssistantChips();
    if (openCheck()) updatePanelAvailability();
    const latest = state.events[state.events.length - 1];
    if (latest) toastForEvent(latest);
  }

  function openCheck() {
    return !els.panel.hidden;
  }

  // --- shell ---------------------------------------------------------------

  function closeMenu() {
    document.body.classList.remove('nav-open');
    els.menuToggle.setAttribute('aria-expanded', 'false');
    els.menuToggle.setAttribute('aria-label', 'Open navigation');
    els.navBackdrop.hidden = true;
  }

  function openMenu() {
    document.body.classList.add('nav-open');
    els.menuToggle.setAttribute('aria-expanded', 'true');
    els.menuToggle.setAttribute('aria-label', 'Close navigation');
    els.navBackdrop.hidden = false;
    if (els.navTabs[0]) els.navTabs[0].focus();
  }

  function showTab(name, options = {}) {
    const { focus = true, updateHash = true } = options;
    const tab = TAB_NAMES.includes(name) ? name : 'home';
    for (const tabButton of els.navTabs) {
      if (tabButton.dataset.tab === tab) tabButton.setAttribute('aria-current', 'page');
      else tabButton.removeAttribute('aria-current');
    }
    for (const candidate of TAB_NAMES) {
      const view = $(`view-${candidate}`);
      if (view) view.hidden = candidate !== tab;
    }
    if (tab === 'calendar') renderCalendar();
    if (tab === 'equipment') renderEquipment();
    if (tab === 'reservations') renderReservations();
    if (tab === 'operations') renderOperations();
    if (tab === 'assistant') {
      renderAssistantChips();
      setTimeout(() => els.chatInput.focus(), 0);
    }
    closeMenu();
    if (updateHash) {
      try {
        history.replaceState(null, '', `#${tab}`);
      } catch (error) {
        // Some file:// contexts refuse history changes; navigation still works.
      }
    }
    if (focus) {
      const heading = $(`${tab === 'home' ? 'home' : tab}-title`);
      if (heading) heading.focus();
    }
  }

  function onNavKeydown(event) {
    const index = els.navTabs.indexOf(document.activeElement);
    if (index < 0) return;
    let next = null;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % els.navTabs.length;
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + els.navTabs.length) % els.navTabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = els.navTabs.length - 1;
    if (next !== null) {
      event.preventDefault();
      els.navTabs[next].focus();
    }
  }

  function renderNav(state, proposals = proposalsApi.buildProposals(state)) {
    const open = selectors.proposalCounts(state, proposals).open;
    els.navOperationsCount.hidden = open === 0;
    els.navOperationsCount.textContent = String(open);
  }

  // --- home ----------------------------------------------------------------

  function renderHome(state, proposalRows = null) {
    const today = anchorDate;
    const stats = selectors.kpis(state, today);
    els.kpiPickups.textContent = String(stats.pickupsToday);
    els.kpiReturns.textContent = String(stats.returnsToday);
    els.kpiOut.textContent = String(stats.equipmentOutToday);
    els.kpiConflicts.textContent = String(stats.openConflicts);
    els.homeTitle.textContent = 'Good morning, Léa';

    let attention = [];
    try {
      attention = selectors.needsAttention(state, today, proposalRows);
    } catch (error) {
      setState(els.attentionState, `Attention list could not be read: ${error.message}`, 'error');
    }
    els.attentionCount.textContent = String(attention.length);
    els.attentionList.replaceChildren();
    if (attention.length === 0) {
      setState(els.attentionState, 'Nothing needs attention. Conflicts, proposals and expiring holds appear here.', 'empty');
    } else {
      setState(els.attentionState, '');
      for (const row of attention) {
        const item = el('li', undefined, `attention-item ${row.type === 'proposal' ? 'is-proposal' : row.type === 'hold' ? 'is-hold' : row.type === 'pickup' ? 'is-pickup' : ''}`);
        const icon = el('span', row.type === 'conflict' ? '!' : row.type === 'proposal' ? '→' : row.type === 'hold' ? 'H' : 'P', 'attention-icon');
        icon.setAttribute('aria-hidden', 'true');
        const body = el('div', undefined, 'attention-body');
        body.append(el('p', row.title, 'attention-title'), el('p', row.detail, 'attention-detail'));
        const link = button('Open', 'attention-link', () => {
          if (row.type === 'conflict' || row.type === 'proposal') {
            showTab('operations', { focus: false });
            if (row.proposalId) highlightProposal(row.proposalId);
          } else {
            openReservation(row.reservationId);
          }
        });
        link.setAttribute('aria-label', `Open ${row.title}`);
        item.append(icon, body, link);
        els.attentionList.append(item);
      }
    }

    const feed = selectors.activityFeed(state, 10);
    els.activityFeed.replaceChildren();
    if (feed.length === 0) {
      setState(els.activityState, 'No changes yet in this session.', 'empty');
    } else {
      setState(els.activityState, '');
      for (const event of feed) {
        const item = el('li', undefined, 'activity-item');
        item.append(el('span', undefined, 'activity-mark'));
        const body = el('div');
        body.append(el('p', event.summary, 'activity-text'), el('p', eventTime(event.at), 'activity-time'));
        item.append(body);
        els.activityFeed.append(item);
      }
    }

    renderToolGrid(state, proposalRows);
  }

  function renderToolGrid(state, proposalRows = null) {
    const proposals = proposalRows || proposalsApi.buildProposals(state);
    const proposalTotals = selectors.proposalCounts(state, proposals);
    const active = selectors.reservationCounts(state).active;
    const week = selectors.reservationsThisWeek(state, anchorDate);
    const out = selectors.kpis(state, anchorDate).equipmentOutToday;
    const cards = [
      {
        tab: 'calendar',
        title: 'Calendar',
        line: 'Month view of every booking',
        count: `${week} reservations this week`,
        icon: ['M4 5.5h16v14H4z', 'M4 9.5h16M8 3v4M16 3v4'],
      },
      {
        tab: 'equipment',
        title: 'Equipment',
        line: 'Stock, maintenance and availability',
        count: `${out} items out today`,
        icon: ['M4 8.5 12 4l8 4.5v7L12 20l-8-4.5v-7Z', 'M4 8.5 12 13l8-4.5M12 13v7'],
      },
      {
        tab: 'reservations',
        title: 'Reservations',
        line: 'Search, filter and open a booking',
        count: `${active} open reservations`,
        icon: ['M6 3.5h12a1 1 0 0 1 1 1V21l-7-4-7 4V4.5a1 1 0 0 1 1-1Z', 'M9 8h6M9 11.5h6'],
      },
      {
        tab: 'operations',
        title: 'Operations',
        line: 'Re-plan inbox for conflicts',
        count: `${proposalTotals.pending} proposals awaiting approval`,
        icon: ['M4 6h16M4 12h10M4 18h7', 'M17.5 10a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4Z'],
      },
      {
        tab: 'assistant',
        title: 'Assistant',
        line: 'Book, cancel or check availability',
        count: `${selectors.customerCount(state)} customers on file`,
        icon: ['M12 3.5 14.1 9l5.6 2.1-5.6 2.1L12 19l-2.1-5.8L4.3 11l5.6-2.1L12 3.5Z'],
      },
    ];
    els.toolGrid.replaceChildren();
    for (const card of cards) {
      const node = el('button', undefined, 'tool-card');
      node.type = 'button';
      const icon = el('span', undefined, 'tool-icon');
      icon.append(svgIcon(card.icon, 19));
      node.append(icon, el('span', card.title, 'tool-name'), el('span', card.line, 'tool-line'), el('span', card.count, 'tool-count'));
      node.addEventListener('click', () => showTab(card.tab));
      els.toolGrid.append(node);
    }
  }

  // --- calendar ------------------------------------------------------------

  function renderCalendar(state = store.getState()) {
    const month = selectors.calendarMonth(state, calendar.year, calendar.month);
    els.calMonth.textContent = month.label;
    setState(els.calendarState, '');
    const nodes = [];
    for (const name of WEEKDAYS_SHORT) {
      const header = el('span', name, 'cal-weekday');
      header.setAttribute('aria-hidden', 'true');
      nodes.push(header);
    }
    for (let index = 0; index < month.firstWeekday; index += 1) {
      const blank = el('span', undefined, 'cal-blank');
      blank.setAttribute('aria-hidden', 'true');
      nodes.push(blank);
    }
    for (const day of month.days) {
      const node = el('button', undefined, 'cal-day');
      node.type = 'button';
      node.dataset.date = day.date;
      node.setAttribute('aria-pressed', String(calendar.selected === day.date));
      node.setAttribute('aria-label', `${day.day} ${MONTHS[calendar.month]} ${calendar.year}, ${day.count} reservation${day.count === 1 ? '' : 's'}${day.hasConflict ? ', conflict' : ''}`);
      if (day.count > 0) node.classList.add('has-bookings');
      if (day.hasConflict) node.classList.add('is-conflict');
      node.append(el('span', String(day.day), 'cal-daynum'));
      if (day.count > 0) {
        const count = el('span', `${day.count} booking${day.count === 1 ? '' : 's'}`, 'cal-count');
        count.setAttribute('aria-hidden', 'true');
        node.append(count);
        if (day.reservations[0]) {
          const first = el('span', day.reservations[0].id, 'cal-id');
          first.setAttribute('aria-hidden', 'true');
          node.append(first);
        }
      }
      node.addEventListener('click', () => {
        calendar.selected = day.date;
        renderCalendar();
        renderDayList();
      });
      nodes.push(node);
    }
    els.calendarGrid.replaceChildren(...nodes);
    els.calendarMonthNote.textContent = month.totalReservations === 0
      ? 'No reservations this month.'
      : `${month.totalReservations} active reservation${month.totalReservations === 1 ? '' : 's'} across ${month.totalDays} day${month.totalDays === 1 ? '' : 's'}.`;
    renderDayList();
  }

  function renderDayList(state = store.getState()) {
    els.dayList.replaceChildren();
    els.dayCount.hidden = true;
    if (!calendar.selected) {
      els.dayTitle.textContent = 'Select a day';
      setState(els.dayState, 'Select a day to see its reservations.', 'empty');
      return;
    }
    const parts = parseIso(calendar.selected);
    els.dayTitle.textContent = `${parts.date} ${MONTHS[parts.month]} ${parts.year}`;
    const month = selectors.calendarMonth(state, parts.year, parts.month);
    const day = month.days.find((row) => row.date === calendar.selected);
    if (!day || day.count === 0) {
      setState(els.dayState, 'No reservations on this day.', 'empty');
      return;
    }
    setState(els.dayState, '');
    els.dayCount.hidden = false;
    els.dayCount.textContent = String(day.count);
    for (const reservation of day.reservations) {
      const item = el('li', undefined, 'day-item');
      const head = el('div', undefined, 'day-item-head');
      const open = button(reservation.id, 'reservation-link', () => openReservation(reservation.id));
      head.append(open, statusBadge(reservation.status));
      item.append(
        head,
        el('p', reservation.customerName, 'day-client'),
        el('p', `${reservation.start} to ${reservation.end}`, 'mono note'),
        el('p', reservation.itemsLabel, 'note'),
      );
      els.dayList.append(item);
    }
  }

  function shiftCalendar(delta) {
    const next = new Date(Date.UTC(calendar.year, calendar.month + delta, 1));
    calendar.year = next.getUTCFullYear();
    calendar.month = next.getUTCMonth();
    calendar.selected = null;
    renderCalendar();
  }

  // --- equipment -----------------------------------------------------------

  function populateCategoryFilter(seed) {
    const categories = [...new Set(seed.equipment.map((item) => item.category))].sort();
    for (const category of categories) {
      const option = el('option', category.charAt(0).toUpperCase() + category.slice(1));
      option.value = category;
      els.equipmentFilter.append(option);
    }
  }

  function renderEquipment(state = store.getState()) {
    const rows = selectors.equipmentRows(state, {
      query: els.equipmentSearch.value,
      category: els.equipmentFilter.value,
      maintenance: els.equipmentStatus.value,
      sort: equipmentSort.key,
      dir: equipmentSort.dir,
      today: anchorDate,
    });
    els.equipmentCount.textContent = `${rows.length} of ${selectors.equipmentCount(state)} stock lines`;
    updateSortHeaders(els.equipmentTableWrap, equipmentSort);
    if (rows.length === 0) {
      els.equipmentTableWrap.hidden = true;
      setState(els.equipmentState, 'No equipment matches these filters.', 'empty');
      return;
    }
    setState(els.equipmentState, '');
    els.equipmentTableWrap.hidden = false;
    const body = [];
    for (const item of rows) {
      const row = el('tr');
      const name = el('div');
      name.append(el('span', item.name, 'row-strong'), el('span', ` · ${item.brand}`, 'note'));
      const outCell = el('span', undefined, 'status-cell');
      outCell.append(el('span', `${item.out} of ${item.quantityOwned}`, item.out > item.quantityOwned ? 'qty-cell strong' : 'qty-cell'));
      if (item.out > item.quantityOwned) outCell.append(badge('Overbooked', 'conflict'));
      row.append(
        cell('Item', name, el('span', item.stockId, 'mono note')),
        cell('Category', document.createTextNode(item.category)),
        cell('Owned', el('span', String(item.quantityOwned), 'qty-cell')),
        cell('Out today', outCell),
        cell('Location', document.createTextNode(item.location)),
        cell('Maintenance', badge(item.maintenance === 'ok' ? 'OK' : item.maintenance === 'in repair' ? 'In repair' : 'Retired', item.maintenance === 'ok' ? 'ok' : item.maintenance === 'in repair' ? 'in-repair' : 'retired')),
      );
      if (item.out > item.quantityOwned) row.classList.add('is-conflict-row');
      body.push(row);
    }
    els.equipmentRows.replaceChildren(...body);
  }

  function updateSortHeaders(root, sort) {
    const table = root.querySelector ? root.querySelector('table') || root : null;
    if (!table) return;
    for (const th of table.querySelectorAll('th[aria-sort]')) {
      const sortButton = th.querySelector('.sort-button');
      if (!sortButton) continue;
      th.setAttribute('aria-sort', sortButton.dataset.sort === sort.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    }
  }

  // --- reservations --------------------------------------------------------

  function renderReservations(state = store.getState()) {
    const filter = {
      query: els.reservationSearch.value,
      status: els.reservationFilter.value,
      sort: reservationSort.key === 'qty' ? 'start' : reservationSort.key,
      dir: reservationSort.dir,
    };
    let rows = selectors.reservationsFor(state, filter);
    if (reservationSort.key === 'qty') {
      rows.sort((a, b) => (a.totalQuantity - b.totalQuantity) * (reservationSort.dir === 'desc' ? -1 : 1));
    }
    els.reservationCount.textContent = `${rows.length} of ${selectors.reservationCounts(state).total} reservations`;
    updateSortHeaders(els.reservationsTableWrap, reservationSort);
    if (rows.length === 0) {
      els.reservationsTableWrap.hidden = true;
      setState(els.reservationsState, 'No reservations match this filter.', 'empty');
      return;
    }
    setState(els.reservationsState, '');
    els.reservationsTableWrap.hidden = false;
    const body = [];
    for (const row of rows) {
      const tr = el('tr');
      tr.id = `reservation-row-${row.id}`;
      tr.tabIndex = -1;
      if (row.id === selectedReservationId) tr.classList.add('is-highlighted');
      tr.append(
        cell('Reservation', button(row.id, 'reservation-link', () => openReservation(row.id))),
        cell('Customer', document.createTextNode(row.customerName)),
        cell('Dates', el('span', `${row.start} to ${row.end}`, 'mono'), el('span', ` · ${row.status === 'returned' ? 'past' : 'booked'}`, 'note')),
        cell('Items', el('span', row.itemsLabel || 'No items', 'items-cell')),
        cell('Qty', el('span', String(row.totalQuantity), 'qty-cell')),
        cell('Status', statusBadge(row.status)),
      );
      body.push(tr);
    }
    els.reservationRows.replaceChildren(...body);
    if (selectedReservationId) renderReservationDetail(state);
  }

  function openReservation(id) {
    const state = store.getState();
    const view = selectors.getReservation(state, id);
    if (!view) {
      showTab('reservations', { focus: false });
      setState(els.reservationsState, `Reservation ${id} is not in the workspace.`, 'error');
      return;
    }
    selectedReservationId = id;
    els.reservationSearch.value = '';
    els.reservationFilter.value = '';
    showTab('reservations', { focus: false });
    renderReservations(state);
    renderReservationDetail(state);
    const row = $(`reservation-row-${id}`);
    if (row) {
      row.classList.add('is-highlighted');
      row.focus({ preventScroll: true });
      row.scrollIntoView({ block: 'center' });
    }
    els.reservationDetail.scrollIntoView({ block: 'nearest' });
  }

  function renderReservationDetail(state = store.getState()) {
    const view = selectedReservationId ? selectors.getReservation(state, selectedReservationId) : null;
    if (!view) {
      els.reservationDetail.hidden = true;
      els.reservationDetailBody.replaceChildren();
      return;
    }
    els.reservationDetail.hidden = false;
    els.reservationDetailTitle.textContent = `Reservation ${view.id}`;
    const grid = el('div', undefined, 'detail-grid');
    for (const [label, value] of [
      ['Customer', view.customerName],
      ['Type', view.customerType || '—'],
      ['Status', STATUS_BADGES[view.status]?.label || view.status],
      ['Pickup', shortDate(view.start)],
      ['Return', shortDate(view.end)],
      ['Total quantity', String(view.totalQuantity)],
    ]) {
      const block = el('div', undefined, 'detail-block');
      block.append(el('p', label, 'detail-label'), el('p', value, 'detail-value'));
      grid.append(block);
    }
    const items = el('ul', undefined, 'detail-items');
    for (const item of view.itemsDetailed) {
      const li = el('li');
      li.append(
        el('span', `${item.name} (${item.stockId})`),
        el('span', `${item.quantity} ×`, 'mono strong'),
      );
      items.append(li);
    }
    const note = el('p', 'This record is live. Changes from the assistant, the manual panel and Operations all update it.', 'note');
    els.reservationDetailBody.replaceChildren(grid, items, note);
  }

  // --- operations ----------------------------------------------------------

  function filterProposals(proposals) {
    const mode = els.proposalFilter.value;
    if (mode === 'all') return proposals;
    if (mode === 'pending' || mode === 'human') return proposals.filter((proposal) => proposal.status === mode);
    if (mode === 'resolved') return proposals.filter((proposal) => proposal.status === 'approved' || proposal.status === 'rejected');
    return proposals.filter((proposal) => proposal.status === 'pending' || proposal.status === 'human');
  }

  function renderOperations(state = store.getState(), highlightId = null, proposalRows = null) {
    let proposals;
    try {
      const rows = proposalRows || proposalsApi.buildProposals(state);
      proposals = filterProposals(rows);
    } catch (error) {
      setState(els.proposalState, `Proposals could not be built: ${error.message}`, 'error');
      return;
    }
    els.proposalCount.textContent = `${proposals.length} proposal${proposals.length === 1 ? '' : 's'}`;
    if (proposals.length === 0) {
      els.proposalList.replaceChildren();
      setState(els.proposalState, 'No proposals in this view. New cancellations and conflicts appear here automatically.', 'empty');
      return;
    }
    setState(els.proposalState, '');
    const nodes = proposals.map((proposal) => proposalCard(proposal, highlightId));
    els.proposalList.replaceChildren(...nodes);
    if (highlightId) {
      const node = els.proposalList.querySelector(`[data-proposal="${highlightId}"]`);
      if (node) {
        node.classList.add('is-highlighted');
        node.scrollIntoView({ block: 'center' });
      }
    }
  }

  function highlightProposal(id) {
    els.proposalFilter.value = 'all';
    renderOperations(store.getState(), id);
  }

  function proposalCard(proposal, highlightId) {
    const item = el('li', undefined, `proposal is-${proposal.status}${proposal.id === highlightId ? ' is-highlighted' : ''}`);
    item.dataset.proposal = proposal.id;

    const head = el('div', undefined, 'proposal-head');
    const titleWrap = el('div');
    titleWrap.append(
      el('p', `${proposal.id} · ${proposal.reason === 'cancellation' ? 'Cancellation' : 'Conflict'}`, 'proposal-id'),
      el('p', proposal.summary, 'proposal-title'),
    );
    const badges = el('div', undefined, 'proposal-badges');
    badges.append(
      badge(proposal.reason === 'cancellation' ? 'Cancellation' : 'Conflict', proposal.reason === 'cancellation' ? 'pending' : 'conflict'),
      badge(FEASIBILITY_BADGES[proposal.feasibility].label, FEASIBILITY_BADGES[proposal.feasibility].variant),
      badge(PROPOSAL_STATUS[proposal.status].label, PROPOSAL_STATUS[proposal.status].variant),
    );
    if (proposal.unresolved) badges.append(badge('Unresolved', 'conflict'));
    head.append(titleWrap, badges);

    const meta = el('div', undefined, 'proposal-meta');
    if (proposal.reservationId) {
      meta.append(button(`Reservation ${proposal.reservationId}`, 'proposal-link', () => openReservation(proposal.reservationId)));
    }
    meta.append(
      el('span', proposal.assignedTo === 'Human dispatcher' ? 'Assigned to a human dispatcher' : 'Assigned to Operations'),
      el('span', `Solver ${Number(proposal.solverMs).toFixed(2)} ms`, 'solver-time'),
    );

    const detail = el('p', proposal.detail, 'proposal-detail');

    const sections = [];
    if (proposal.freedItems.length) {
      const section = el('section', undefined, 'proposal-section');
      section.append(el('h4', 'Freed items'));
      const list = el('ul');
      for (const row of proposal.freedItems) {
        list.append(el('li', `${row.quantity} × ${row.name} (${row.stockId})`));
      }
      section.append(list);
      sections.push(section);
    }
    const moves = el('section', undefined, 'proposal-section');
    moves.append(el('h4', 'Plan actions'));
    if (proposal.actionLabels.length) {
      const list = el('ul');
      for (const label of proposal.actionLabels) list.append(el('li', label));
      moves.append(list);
    } else {
      moves.append(el('p', 'No plan actions. The proposal is assigned to a human dispatcher.', 'note'));
    }
    sections.push(moves);

    const actions = el('div', undefined, 'proposal-actions');
    if (proposal.status === 'pending') {
      actions.append(
        button('Approve plan', 'btn btn-primary', () => decideProposal(proposal.id, 'approve')),
        button('Reject', 'btn btn-secondary', () => decideProposal(proposal.id, 'reject')),
      );
    } else if (proposal.status === 'human') {
      actions.append(
        button('Dismiss proposal', 'btn btn-secondary', () => decideProposal(proposal.id, 'reject')),
      );
    } else {
      actions.append(el('span', proposal.status === 'approved' ? 'Plan applied to the reservations.' : 'Rejected. Reservations were left unchanged.', 'note'));
      if (proposal.unresolved) {
        actions.append(el('span', ' The conflict is still open; a new proposal version covers it.', 'note'));
      }
    }

    item.append(head, meta, detail, ...sections, actions);
    return item;
  }

  function decideProposal(id, decision) {
    const result = decision === 'approve' ? store.approveProposal(id) : store.rejectProposal(id);
    if (!result.ok) {
      setState(els.proposalState, result.error, 'error');
      return;
    }
    setState(els.proposalState, '');
  }

  // --- assistant -----------------------------------------------------------

  function appendOpeningMessage() {
    els.chatLog.replaceChildren();
    const item = el('li', undefined, 'chat-message chat-assistant');
    item.setAttribute('role', 'note');
    item.append(el('span', 'Assistant', 'sr-only'), el('p', assistantApi.OPENING));
    els.chatLog.append(item);
  }

  function setupChatChips() {
    renderAssistantChips();
  }

  function renderAssistantChips() {
    if (!store) return;
    const state = store.getState();
    const start = shiftIso(anchorDate, 10);
    const end = shiftIso(anchorDate, 12);
    let best = null;
    for (const item of state.equipment) {
      if (item.maintenance !== 'ok') continue;
      const free = selectors.availableQuantity(state, item.stockId, start, end);
      if (free > 0 && (!best || free > best.free)) best = { item, free };
    }
    const bookStart = shiftIso(anchorDate, 20);
    const bookEnd = shiftIso(anchorDate, 22);
    let bookItem = null;
    for (const item of state.equipment) {
      if (item.maintenance !== 'ok') continue;
      if (selectors.availableQuantity(state, item.stockId, bookStart, bookEnd) > 0) {
        bookItem = item;
        break;
      }
    }
    const active = state.reservations.find((reservation) => reservation.status === 'confirmed');
    const prompts = [];
    if (best) prompts.push(`Check availability of ${best.item.stockId} from ${start} to ${end}`);
    if (bookItem) prompts.push(`Book 1 × ${bookItem.stockId} for Nordlys Film from ${bookStart} to ${bookEnd}`);
    if (active) prompts.push(`Cancel ${active.id}`);
    prompts.push('Show customer Nordlys Film');
    els.chatChips.replaceChildren();
    for (const prompt of prompts) {
      const chip = button(prompt, 'chip', () => {
        els.chatInput.value = prompt;
        submitChat(new Event('submit', { cancelable: true }));
      });
      els.chatChips.append(chip);
    }
  }

  function shiftIso(iso, days) {
    const parts = parseIso(iso);
    return isoFromParts(parts.year, parts.month, parts.date + days);
  }

  function toolCallBlock(call) {
    const details = el('details', undefined, 'tool-call');
    details.append(el('summary', `Tool call: ${call.name}`));
    const body = el('div', undefined, 'tool-call-body');
    body.append(el('p', `Tool: ${call.name}`, 'tool-name-line'));
    const pre = el('pre');
    pre.textContent = JSON.stringify({ tool: call.name, input: call.input, output: call.output }, null, 2);
    body.append(pre);
    details.append(body);
    return details;
  }

  function confirmationCard(confirmation) {
    const wrap = el('div', undefined, 'confirm-card');
    wrap.append(el('h3', 'Confirm before saving'));
    const grid = el('div', undefined, 'confirm-grid');
    for (const [label, value] of [
      ['Customer', confirmation.customerName],
      ['Dates', `${confirmation.start} to ${confirmation.end}`],
      ['Lines', String(confirmation.items.length)],
      ['Total quantity', String(confirmation.totalQuantity)],
    ]) {
      const block = el('div');
      block.append(el('p', label, 'confirm-label'), el('p', value, 'confirm-value'));
      grid.append(block);
    }
    const items = el('ul', undefined, 'confirm-items');
    for (const row of confirmation.items) {
      items.append(el('li', `${row.name} (${row.stockId})`, el('span', `${row.quantity} ×`, 'mono')));
    }
    wrap.append(grid, items, el('p', `Total quantity: ${confirmation.totalQuantity}`, 'confirm-total'));
    return wrap;
  }

  function appendChatMessage(role, payload) {
    const failed = payload.status === 'error';
    const item = el('li', undefined, `chat-message chat-${role}${failed ? ' chat-error' : ''}`);
    if (failed) item.setAttribute('role', 'alert');
    item.append(el('span', role === 'user' ? 'You' : 'Assistant', 'sr-only'));
    for (const paragraph of String(payload.text || '').split('\n\n')) {
      if (paragraph.trim()) item.append(el('p', paragraph));
    }
    if (payload.confirmation && payload.confirmation.items) item.append(confirmationCard(payload.confirmation));
    const actions = el('div', undefined, 'chat-actions');
    for (const action of payload.actions || []) {
      if (action.type === 'open-reservation') {
        actions.append(button(action.label, 'btn btn-secondary chat-action', () => openReservation(action.reservationId)));
      }
      if (action.type === 'open-operations') {
        actions.append(button(action.label, 'btn btn-secondary chat-action', () => showTab('operations')));
      }
    }
    if (actions.childElementCount) item.append(actions);
    for (const call of payload.toolCalls || []) item.append(toolCallBlock(call));
    els.chatLog.append(item);
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }

  function submitChat(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (!store || assistantBusy) return;
    const text = els.chatInput.value.trim();
    if (!text) {
      els.chatStatus.textContent = 'Type a message first.';
      els.chatInput.focus();
      return;
    }
    appendChatMessage('user', { text });
    els.chatInput.value = '';
    assistantBusy = true;
    els.chatLog.setAttribute('aria-busy', 'true');
    els.chatSend.disabled = true;
    els.chatInput.disabled = true;
    els.chatStatus.textContent = 'Checking the live records…';
    setTimeout(() => {
      try {
        appendChatMessage('assistant', assistant.handle(text));
      } catch (error) {
        appendChatMessage('assistant', {
          status: 'error',
          text: `The assistant could not complete that request: ${error instanceof Error ? error.message : String(error)}. Nothing was changed.`,
        });
      } finally {
        assistantBusy = false;
        els.chatLog.setAttribute('aria-busy', 'false');
        els.chatSend.disabled = false;
        els.chatInput.disabled = false;
        els.chatStatus.textContent = '';
        els.chatInput.focus();
      }
    }, 0);
  }

  // --- manual panel --------------------------------------------------------

  function openPanel() {
    if (!store) return;
    lastFocus = document.activeElement;
    panel.customerId = null;
    panel.customerName = null;
    panel.items = [];
    els.panelCustomerSearch.value = '';
    els.panelCustomerResults.replaceChildren();
    els.panelCustomerSelected.hidden = true;
    els.panelCustomerSelected.replaceChildren();
    els.panelStart.value = shiftIso(anchorDate, 7);
    els.panelEnd.value = shiftIso(anchorDate, 9);
    els.panelItemSearch.value = '';
    els.panelItemResults.replaceChildren();
    setState(els.panelError, '');
    els.panelBackdrop.hidden = false;
    els.panel.hidden = false;
    renderPanelItems();
    updatePanelAvailability();
    setTimeout(() => els.panelCustomerSearch.focus(), 0);
    renderPanelCustomerResults('');
  }

  function closePanel() {
    els.panel.hidden = true;
    els.panelBackdrop.hidden = true;
    setState(els.panelError, '');
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  }

  function renderPanelCustomerResults(query) {
    els.panelCustomerResults.replaceChildren();
    const state = store.getState();
    const matches = selectors.customerMatches(state, query, 6);
    if (!query && matches.length === 0) return;
    for (const customer of matches) {
      const node = el('li');
      const result = button('', 'search-result', () => selectPanelCustomer(customer));
      const body = el('span');
      body.append(el('strong', customer.name), el('span', `${customer.id} · ${customer.clientType}`, 'search-result-meta'));
      result.append(body);
      node.append(result);
      els.panelCustomerResults.append(node);
    }
  }

  function selectPanelCustomer(customer) {
    panel.customerId = customer.id;
    panel.customerName = customer.name;
    els.panelCustomerSearch.value = customer.name;
    els.panelCustomerResults.replaceChildren();
    els.panelCustomerSelected.hidden = false;
    els.panelCustomerSelected.replaceChildren(
      el('strong', customer.name),
      el('span', `${customer.id} · ${customer.clientType}`, 'note'),
      el('span', `${customer.contact.email} · ${customer.contact.phone}`, 'note'),
    );
    updatePanelAvailability();
  }

  function renderPanelItemResults(query) {
    els.panelItemResults.replaceChildren();
    if (!query) return;
    const state = store.getState();
    const matches = selectors.itemMatches(state, query, 8).filter((item) => !panel.items.some((row) => row.stockId === item.stockId));
    for (const item of matches) {
      const start = els.panelStart.value.trim();
      const end = els.panelEnd.value.trim();
      const free = toDay(start) !== null && toDay(end) !== null
        ? selectors.availableQuantity(state, item.stockId, start, end)
        : null;
      const node = el('li');
      const result = button('', 'search-result', () => addPanelItem(item));
      const body = el('span');
      body.append(el('strong', `${item.name} (${item.stockId})`), el('span', `${item.category} · ${item.quantityOwned} owned${free === null ? '' : ` · ${free} free`}`, 'search-result-meta'));
      result.append(body, badge(item.maintenance === 'ok' ? 'OK' : item.maintenance, item.maintenance === 'ok' ? 'ok' : 'in-repair'));
      node.append(result);
      els.panelItemResults.append(node);
    }
  }

  function addPanelItem(item) {
    if (panel.items.some((row) => row.stockId === item.stockId)) return;
    panel.items.push({ stockId: item.stockId, name: item.name, quantityInput: '1' });
    els.panelItemSearch.value = '';
    els.panelItemResults.replaceChildren();
    renderPanelItems();
    updatePanelAvailability();
  }

  function renderPanelItems() {
    els.panelItems.replaceChildren();
    if (panel.items.length === 0) {
      els.panelItems.append(el('li', 'No items yet. Search above and add a line.', 'note'));
      return;
    }
    for (const row of panel.items) {
      const item = el('li', undefined, 'panel-item');
      const top = el('div', undefined, 'panel-item-top');
      const name = el('div');
      name.append(el('span', row.name, 'panel-item-name'), el('span', row.stockId, 'panel-item-meta'));
      const remove = el('button', 'Remove', 'btn btn-secondary');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${row.name}`);
      remove.addEventListener('click', () => {
        panel.items = panel.items.filter((candidate) => candidate.stockId !== row.stockId);
        renderPanelItems();
        updatePanelAvailability();
      });
      top.append(name, remove);

      const controls = el('div', undefined, 'panel-item-controls');
      const label = el('label', 'Quantity');
      label.htmlFor = `panel-qty-${row.stockId}`;
      const input = el('input');
      input.type = 'text';
      input.inputMode = 'numeric';
      input.pattern = '[0-9]*';
      input.autocomplete = 'off';
      input.id = `panel-qty-${row.stockId}`;
      input.dataset.stockId = row.stockId;
      input.className = 'qty-input';
      input.value = row.quantityInput === undefined ? String(row.quantity ?? '1') : row.quantityInput;
      input.addEventListener('input', () => {
        // Keep the raw string; validation happens in updatePanelAvailability and
        // again on submit, so "2.5" or "-3" is never silently coerced.
        row.quantityInput = input.value;
        updatePanelAvailability();
      });
      controls.append(label, input);
      const availability = el('p', '', 'item-availability');
      availability.dataset.for = row.stockId;
      item.append(top, controls, availability);
      els.panelItems.append(item);
    }
  }

  function updatePanelAvailability() {
    if (!store || els.panel.hidden) return;
    const state = store.getState();
    const start = els.panelStart.value.trim();
    const end = els.panelEnd.value.trim();
    const rows = [];
    const invalid = new Map();
    for (const row of panel.items) {
      const parsed = parseQuantityInput(row.quantityInput);
      if (parsed.ok) {
        row.quantity = parsed.quantity;
        rows.push({ stockId: row.stockId, quantity: parsed.quantity });
      } else {
        invalid.set(row.stockId, parsed.error);
      }
    }
    setState(els.panelError, '');
    els.panelAlternatives.hidden = true;
    els.panelAlternatives.replaceChildren();

    for (const node of els.panelItems.querySelectorAll('.item-availability')) {
      if (invalid.has(node.dataset.for)) {
        node.textContent = invalid.get(node.dataset.for);
        node.className = 'item-availability is-invalid';
      } else {
        node.textContent = '';
        node.className = 'item-availability';
      }
    }
    for (const input of els.panelItems.querySelectorAll('.qty-input')) {
      input.setAttribute('aria-invalid', invalid.has(input.dataset.stockId) ? 'true' : 'false');
    }
    if (invalid.size > 0) {
      els.panelAvailability.className = 'availability-box is-short';
      els.panelAvailability.textContent = 'Fix the highlighted quantity before saving.';
      els.panelSubmit.disabled = true;
      return;
    }

    if (rows.length === 0 || !start || !end) {
      els.panelAvailability.className = 'availability-box';
      els.panelAvailability.textContent = rows.length === 0
        ? 'Add at least one item to see availability.'
        : 'Add both dates to see availability.';
      els.panelSubmit.disabled = true;
      return;
    }

    const check = selectors.checkItems(state, { start, end, items: rows });
    const availabilityFor = new Map(check.items.map((item) => [item.stockId, item]));
    for (const node of els.panelItems.querySelectorAll('.item-availability')) {
      const item = availabilityFor.get(node.dataset.for);
      if (!item) continue;
      if (item.short > 0) {
        node.textContent = `${item.reason ? `${item.reason} ` : ''}Short by ${item.short}: ${item.available} available of ${item.requested}.`;
        node.className = 'item-availability is-short';
      } else {
        node.textContent = `${item.available} available of ${item.requested} requested.`;
        node.className = 'item-availability is-free';
      }
    }

    if (!check.ok) {
      els.panelAvailability.className = 'availability-box is-short';
      els.panelAvailability.textContent = check.error;
      els.panelSubmit.disabled = true;
      return;
    }

    if (check.feasible) {
      els.panelAvailability.className = 'availability-box is-free';
      els.panelAvailability.textContent = `Available for ${start} to ${end}. ${rows.reduce((sum, row) => sum + row.quantity, 0)} total item(s).`;
      els.panelSubmit.disabled = !panel.customerId;
      return;
    }

    els.panelAvailability.className = 'availability-box is-short';
    els.panelAvailability.textContent = `Blocked: ${check.items.filter((item) => item.short > 0).map((item) => item.reason || `${item.stockId} short by ${item.short}`).join('; ')}. Nothing will be saved.`;
    els.panelSubmit.disabled = true;
    renderPanelAlternatives(check.alternatives, start, end);
  }

  function renderPanelAlternatives(alternatives, start, end) {
    if (!alternatives) return;
    const dates = alternatives.dates || [];
    const itemRows = selectors.swapAlternatives(
      panel.items,
      (alternatives.items || []).filter((row) => row.alternatives && row.alternatives.length),
    );
    if (dates.length === 0 && itemRows.length === 0) return;
    els.panelAlternatives.hidden = false;
    const nodes = [el('h4', 'Nearest alternatives')];
    for (const row of dates) {
      nodes.push(button(`Use ${row.start} to ${row.end}`, 'chip', () => {
        els.panelStart.value = row.start;
        els.panelEnd.value = row.end;
        updatePanelAvailability();
      }));
    }
    for (const row of itemRows) {
      for (const alternative of row.alternatives) {
        nodes.push(button(`Swap ${row.stockId} for ${alternative.stockId} (${alternative.available} free)`, 'chip', () => {
          if (panel.items.some((item) => item.stockId === alternative.stockId)) return;
          const target = panel.items.find((item) => item.stockId === row.stockId);
          if (target) {
            target.stockId = alternative.stockId;
            target.name = alternative.name;
          }
          renderPanelItems();
          updatePanelAvailability();
        }));
      }
    }
    els.panelAlternatives.replaceChildren(...nodes);
  }

  function trapPanelFocus(event) {
    if (event.key !== 'Tab' || els.panel.hidden) return;
    const focusable = [...els.panel.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')]
      .filter((node) => !node.disabled && node.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function submitPanel(event) {
    event.preventDefault();
    if (!store) return;
    if (!panel.customerId) {
      setState(els.panelError, 'Choose a customer before saving.', 'error');
      els.panelCustomerSearch.focus();
      return;
    }
    if (panel.items.length === 0) {
      setState(els.panelError, 'Add at least one item before saving.', 'error');
      return;
    }
    const rows = [];
    for (const row of panel.items) {
      const parsed = parseQuantityInput(row.quantityInput);
      if (!parsed.ok) {
        setState(els.panelError, `Quantity for ${row.stockId}: ${parsed.error}`, 'error');
        const input = $(`panel-qty-${row.stockId}`);
        if (input) input.focus();
        return;
      }
      row.quantity = parsed.quantity;
      rows.push({ stockId: row.stockId, quantity: parsed.quantity });
    }
    const dateProblem = rangeProblem('Reservation', els.panelStart.value.trim(), els.panelEnd.value.trim());
    if (dateProblem) {
      setState(els.panelError, dateProblem, 'error');
      return;
    }
    const result = store.commitReservation({
      customerId: panel.customerId,
      start: els.panelStart.value.trim(),
      end: els.panelEnd.value.trim(),
      items: rows,
    });
    if (!result.ok) {
      setState(els.panelError, result.error, 'error');
      if (result.alternatives) renderPanelAlternatives(result.alternatives, els.panelStart.value.trim(), els.panelEnd.value.trim());
      return;
    }
    closePanel();
  }

  // --- toast ---------------------------------------------------------------

  function toastForEvent(event) {
    const labels = {
      'reservation.created': 'Open reservation',
      'reservation.cancelled': 'Open reservation',
      'proposal.approved': 'Open reservation',
      'proposal.rejected': 'Open reservation',
    };
    let summary = event.summary;
    if (!summary) {
      const known = {
        'reservation.created': 'Reservation created',
        'reservation.cancelled': 'Reservation cancelled',
        'proposal.approved': 'Proposal approved',
        'proposal.rejected': 'Proposal rejected',
        'store.reset': 'Workspace reset',
      };
      summary = known[event.type] || 'Change saved';
    }
    const reservationId = event.reservationId || event.proposal?.reservationId || null;
    const target = reservationId ? () => openReservation(reservationId) : null;
    showToast(summary, target ? `${labels[event.type] || 'Open'} ${reservationId}` : null, target);
  }

  function showToast(text, linkLabel, onClick) {
    if (toastTimer) clearTimeout(toastTimer);
    els.toastText.textContent = text;
    if (linkLabel && onClick) {
      els.toastLink.hidden = false;
      els.toastLink.textContent = linkLabel;
      els.toastLink.onclick = (event) => {
        if (event) event.preventDefault();
        hideToast();
        onClick();
      };
    } else {
      els.toastLink.hidden = true;
      els.toastLink.textContent = 'Open reservation';
      els.toastLink.onclick = null;
    }
    els.toast.hidden = false;
    toastTimer = setTimeout(hideToast, 7000);
  }

  function hideToast() {
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
    els.toast.hidden = true;
  }

  // --- render all ----------------------------------------------------------

  function renderAll(state = store.getState()) {
    try {
      let proposalRows = null;
      try {
        proposalRows = proposalsApi.buildProposals(state);
      } catch (error) {
        proposalRows = null;
      }
      renderHome(state, proposalRows);
      renderNav(state, proposalRows || undefined);
      renderCalendar(state);
      renderEquipment(state);
      renderReservations(state);
      renderOperations(state, null, proposalRows);
    } catch (error) {
      setState(els.attentionState, `The workspace could not be rendered: ${error.message}`, 'error');
    }
  }

  // --- events --------------------------------------------------------------

  function bindEvents() {
    for (const tabButton of els.navTabs) {
      tabButton.addEventListener('click', () => showTab(tabButton.dataset.tab));
    }
    document.querySelector('.primary-nav').addEventListener('keydown', onNavKeydown);
    els.menuToggle.addEventListener('click', () => {
      if (document.body.classList.contains('nav-open')) closeMenu();
      else openMenu();
    });
    els.navBackdrop.addEventListener('click', () => {
      closeMenu();
      els.menuToggle.focus();
    });

    els.calPrev.addEventListener('click', () => shiftCalendar(-1));
    els.calNext.addEventListener('click', () => shiftCalendar(1));
    els.calToday.addEventListener('click', () => {
      const parts = parseIso(anchorDate);
      calendar.year = parts.year;
      calendar.month = parts.month;
      calendar.selected = anchorDate;
      renderCalendar();
    });

    els.equipmentSearch.addEventListener('input', () => renderEquipment());
    els.equipmentFilter.addEventListener('change', () => renderEquipment());
    els.equipmentStatus.addEventListener('change', () => renderEquipment());
    for (const sortButton of els.equipmentTableWrap.querySelectorAll('.sort-button')) {
      sortButton.addEventListener('click', () => {
        const key = sortButton.dataset.sort;
        equipmentSort = { key, dir: equipmentSort.key === key && equipmentSort.dir === 'asc' ? 'desc' : 'asc' };
        renderEquipment();
      });
    }

    els.reservationSearch.addEventListener('input', () => renderReservations());
    els.reservationFilter.addEventListener('change', () => renderReservations());
    for (const sortButton of els.reservationsTableWrap.querySelectorAll('.sort-button')) {
      sortButton.addEventListener('click', () => {
        const key = sortButton.dataset.sort;
        reservationSort = { key, dir: reservationSort.key === key && reservationSort.dir === 'asc' ? 'desc' : 'asc' };
        renderReservations();
      });
    }
    els.reservationDetailClose.addEventListener('click', () => {
      selectedReservationId = null;
      els.reservationDetail.hidden = true;
      renderReservations();
    });

    els.proposalFilter.addEventListener('change', () => renderOperations());

    els.chatForm.addEventListener('submit', submitChat);

    els.newReservation.addEventListener('click', openPanel);
    els.panelClose.addEventListener('click', closePanel);
    els.panelCancel.addEventListener('click', closePanel);
    els.panelBackdrop.addEventListener('click', closePanel);
    els.panelForm.addEventListener('submit', submitPanel);
    els.panel.addEventListener('keydown', trapPanelFocus);
    els.panelCustomerSearch.addEventListener('input', () => {
      if (panel.customerId && els.panelCustomerSearch.value !== panel.customerName) {
        panel.customerId = null;
        panel.customerName = null;
        els.panelCustomerSelected.hidden = true;
        updatePanelAvailability();
      }
      renderPanelCustomerResults(els.panelCustomerSearch.value.trim());
    });
    els.panelItemSearch.addEventListener('input', () => renderPanelItemResults(els.panelItemSearch.value.trim()));
    els.panelStart.addEventListener('input', () => {
      updatePanelAvailability();
      if (els.panelItemSearch.value.trim()) renderPanelItemResults(els.panelItemSearch.value.trim());
    });
    els.panelEnd.addEventListener('input', () => {
      updatePanelAvailability();
      if (els.panelItemSearch.value.trim()) renderPanelItemResults(els.panelItemSearch.value.trim());
    });

    els.toastClose.addEventListener('click', hideToast);

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!els.panel.hidden) {
        event.preventDefault();
        closePanel();
      } else if (document.body.classList.contains('nav-open')) {
        closeMenu();
        els.menuToggle.focus();
      } else if (!els.toast.hidden) {
        hideToast();
      }
    });

    if (typeof window.matchMedia === 'function') {
      const desktop = window.matchMedia('(min-width: 1024px)');
      const onChange = () => {
        if (desktop.matches) closeMenu();
      };
      if (typeof desktop.addEventListener === 'function') desktop.addEventListener('change', onChange);
    }
  }

  boot();
})();
