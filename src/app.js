/*
 * UI wiring for the fictional Atelier Lumière dispatch console.
 *
 * Everything is rendered with createElement() and textContent. There is no
 * HTML-string injection, no network call and no LLM. The assistant calls the pure
 * tools in tools.js, which call the deterministic solver in solver.js.
 */
(function () {
  'use strict';

  const { house, resources, bookings, waitlist, overflowWaitlist, clauses, scenarios } = globalThis.RentalData;
  const solver = globalThis.RentalSolver;
  const approval = globalThis.RentalApproval;
  const summaryApi = globalThis.RentalSummary;
  const toolsApi = globalThis.RentalTools;
  const assistantApi = globalThis.RentalAssistant;
  const { toDay } = globalThis.RentalValidation;

  const PLACEHOLDER = 'Results appear here after you solve. Nothing is applied until you approve a plan.';
  const STALE = 'The cancellation or kit changed. Solve again to see a current re-plan.';
  const VERDICTS = {
    full: 'Full re-plan',
    partial: 'Partial re-plan: client consent needed',
    none: 'No feasible re-plan',
  };
  const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const TAB_NAMES = ['dispatch', 'calendar', 'equipment', 'reservations', 'assistant'];
  const DAY_MS = 24 * 60 * 60 * 1000;

  const $ = (id) => document.getElementById(id);

  const els = {
    // shell
    main: $('main'),
    sidebar: $('sidebar'),
    menuToggle: $('menu-toggle'),
    navBackdrop: $('nav-backdrop'),
    navTabs: [...document.querySelectorAll('.nav-tab')],
    // dispatch
    scenarios: $('scenarios'),
    detail: $('scenario-detail'),
    summary: $('scenario-summary'),
    question: $('question'),
    waitlistLine: $('waitlist-line'),
    kitPlaceholder: $('kit-placeholder'),
    kitPanel: $('kit-panel'),
    kitCount: $('kit-count'),
    kit: $('kit-options'),
    kitNote: $('kit-note'),
    solve: $('solve'),
    solveHint: $('solve-hint'),
    results: $('results'),
    resultsEmpty: $('results-empty'),
    resultsError: $('results-error'),
    resultsBody: $('results-body'),
    verdict: $('verdict'),
    timing: $('timing'),
    outcome: $('outcome'),
    humanNote: $('human-note'),
    plansBlock: $('plans-block'),
    planRows: $('plan-rows'),
    planDetails: $('plan-details'),
    reject: $('reject-all'),
    noPlanBlock: $('no-plan-block'),
    noPlan: $('no-plan'),
    handoffs: $('handoffs'),
    decisionBlock: $('decision-block'),
    decision: $('decision'),
    inventory: $('inventory'),
    draft: $('draft'),
    statOpen: $('stat-open'),
    statCapacity: $('stat-capacity'),
    statReplans: $('stat-replans'),
    // calendar
    calPrev: $('cal-prev'),
    calNext: $('cal-next'),
    calMonth: $('cal-month'),
    calendarState: $('calendar-state'),
    calendarGrid: $('calendar-grid'),
    calendarMonthNote: $('calendar-month-note'),
    dayTitle: $('day-title'),
    dayState: $('day-state'),
    dayList: $('day-list'),
    // equipment
    equipmentFilter: $('equipment-filter'),
    equipmentCount: $('equipment-count'),
    equipmentState: $('equipment-state'),
    equipmentTableWrap: $('equipment-table-wrap'),
    equipmentRows: $('equipment-rows'),
    // reservations
    reservationSearch: $('reservation-search'),
    reservationFilter: $('reservation-filter'),
    reservationCount: $('reservation-count'),
    reservationsState: $('reservations-state'),
    reservationsTableWrap: $('reservations-table-wrap'),
    reservationRows: $('reservation-rows'),
    // assistant
    chatLog: $('chat-log'),
    chatStatus: $('chat-status'),
    chatForm: $('chat-form'),
    chatInput: $('chat-input'),
    chatSend: $('chat-send'),
    // scope
    scopeCard: $('scope-card'),
    scopeLink: $('scope-link'),
    scopeClose: $('scope-close'),
    scopeTitle: $('scope-title'),
  };

  // Live state for this page session. Approvals replace it; the assistant only reads it.
  let live = {
    resources,
    bookings,
    clauses,
    waitlist: [...waitlist, ...overflowWaitlist],
  };
  let selectedId = null;
  let session = null;
  let busy = false;
  let replansRun = 0;
  let activeTab = 'dispatch';
  let assistantBusy = false;
  let calendar = { year: 2026, month: 11, selected: null, ready: false };
  const loaded = { calendar: false, equipment: false, reservations: false };

  // --- small DOM helpers ---------------------------------------------------

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function cell(label, ...content) {
    const td = el('td');
    td.dataset.label = label;
    td.append(...content);
    return td;
  }

  function listBlock(title, items, className = 'block') {
    const wrap = el('div', undefined, className);
    const list = el('ul');
    for (const item of items) list.append(el('li', item));
    wrap.append(el('h4', title), list);
    return wrap;
  }

  function badge(label, variant) {
    return el('span', label, `badge badge-${variant}`);
  }

  function setState(node, message, kind = 'empty') {
    if (!message) {
      node.hidden = true;
      node.textContent = '';
      node.className = 'state';
      node.removeAttribute('role');
      return;
    }
    node.hidden = false;
    node.textContent = message;
    node.className = `state state-${kind}`;
    node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  }

  function isoToDay(iso) {
    return typeof iso === 'string' ? toDay(iso) : null;
  }

  function dayToParts(dayNumber) {
    const date = new Date(dayNumber * DAY_MS);
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth(),
      day: date.getUTCDate(),
      iso: date.toISOString().slice(0, 10),
    };
  }

  function prettyDate(iso) {
    const day = isoToDay(iso);
    if (day === null) return iso;
    const { year, month, day: date } = dayToParts(day);
    return `${date} ${MONTHS[month]} ${year}`;
  }

  function activeBookings() {
    return live.bookings.filter((booking) => booking.status !== 'cancelled');
  }

  // --- shell: tabs, menu, focus -------------------------------------------

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
    const tab = TAB_NAMES.includes(name) ? name : 'dispatch';
    activeTab = tab;
    for (const button of els.navTabs) {
      if (button.dataset.tab === tab) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    for (const candidate of TAB_NAMES) {
      const view = $(`view-${candidate}`);
      if (view) view.hidden = candidate !== tab;
    }
    if (tab === 'dispatch') renderSummary();
    if (tab === 'calendar') loadCalendar();
    if (tab === 'equipment') loadEquipment();
    if (tab === 'reservations') loadReservations();
    closeMenu();
    if (updateHash) {
      try {
        history.replaceState(null, '', `#${tab}`);
      } catch (error) {
        // file:// in some browsers refuses history changes; the tabs still work.
      }
    }
    if (focus) {
      const heading = $(`${tab}-title`);
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

  // --- Dispatch summary ----------------------------------------------------

  function renderSummary() {
    const stats = summaryApi.summaryStats(live, replansRun);
    els.statOpen.textContent = String(stats.openReservations);
    els.statCapacity.textContent = String(stats.equipmentAtCapacity);
    els.statReplans.textContent = String(stats.replansRun);
  }

  function renderDataViews() {
    renderSummary();
    if (loaded.equipment) renderEquipment();
    if (loaded.reservations) renderReservations();
    if (loaded.calendar) renderCalendar();
  }

  // --- Dispatch: scenarios, kit, solve ------------------------------------

  function bookingFor(scenario) {
    return live.bookings.find((booking) => booking.id === scenario.cancellation.bookingId) || null;
  }

  function selectedScenario() {
    return scenarios.find((scenario) => scenario.id === selectedId) || null;
  }

  function stateFor(scenario) {
    return {
      ...live,
      waitlist: live.waitlist.filter((request) => scenario.waitlistIds.includes(request.id)),
    };
  }

  function kitInputs() {
    return [...els.kit.querySelectorAll('input')];
  }

  function releasedIds() {
    return kitInputs().filter((input) => input.checked).map((input) => input.value);
  }

  function cancellationFor(scenario) {
    return {
      bookingId: scenario.cancellation.bookingId,
      question: scenario.cancellation.question,
      releasedIds: releasedIds(),
    };
  }

  function waitlistLine(scenario) {
    const requests = stateFor(scenario).waitlist;
    if (requests.length === 0) return 'Waitlist: nobody is waiting for dates that overlap this cancellation.';
    const list = requests.map((request) => `${request.id} ${request.client}, ${request.start} to ${request.end}`).join('; ');
    return `Waitlist: ${list}.`;
  }

  function scenarioCard(scenario) {
    const booking = bookingFor(scenario);
    const button = el('button', undefined, 'scenario');
    button.type = 'button';
    button.dataset.id = scenario.id;
    button.setAttribute('aria-pressed', 'false');
    button.append(el('span', scenario.title, 'scenario-title'));
    if (booking) {
      button.append(
        el('span', `${booking.start} to ${booking.end}`, 'scenario-date'),
        el('span', `Customer: ${booking.client}`, 'scenario-meta'),
        el('span', `Items: ${booking.assigned.join(', ')}`, 'scenario-meta mono'),
        el('span', `Releases: all ${booking.assigned.length} items by default`, 'scenario-meta'),
      );
    } else {
      button.append(el('span', 'This reservation is no longer in local data.', 'scenario-meta'));
    }
    button.append(el('span', 'Select', 'scenario-state'));
    button.addEventListener('click', () => selectScenario(scenario.id));
    const item = el('li');
    item.append(button);
    return item;
  }

  function selectScenario(id) {
    selectedId = id;
    for (const button of els.scenarios.querySelectorAll('button')) {
      const pressed = button.dataset.id === id;
      button.setAttribute('aria-pressed', String(pressed));
      const state = button.querySelector('.scenario-state');
      if (state) state.textContent = pressed ? 'Selected' : 'Select';
    }
    renderScenario();
  }

  function kitRow(resourceId) {
    const res = live.resources.find((candidate) => candidate.id === resourceId);
    const item = el('li');
    const label = el('label', undefined, 'kit-row');
    const input = el('input');
    input.type = 'checkbox';
    input.value = resourceId;
    input.checked = true;
    const name = el('span', undefined, 'kit-name');
    name.append(
      el('span', resourceId, 'mono kit-id'),
      el('span', res ? res.label : 'Unknown item', 'kit-label'),
    );
    label.append(input, name, el('span', 'Released', 'kit-state'));
    item.append(label);
    return item;
  }

  function updateKitState() {
    const inputs = kitInputs();
    const released = inputs.filter((input) => input.checked).length;
    for (const input of inputs) {
      const row = input.closest('.kit-row');
      if (row) row.querySelector('.kit-state').textContent = input.checked ? 'Released' : 'Held back';
    }
    els.kitCount.textContent = `${released} of ${inputs.length} units available`;
    if (released === 0) {
      els.kitNote.textContent = 'No kit is released. Solving will report that every item is held.';
    } else if (released < inputs.length) {
      els.kitNote.textContent = `${inputs.length - released} held back: staff keep them and they are not offered to the waitlist.`;
    } else {
      els.kitNote.textContent = 'All kit is released and can be offered to the waitlist.';
    }
  }

  function renderSolveState() {
    const scenario = selectedScenario();
    els.solve.disabled = busy || !scenario;
    els.solve.textContent = busy ? 'Solving...' : 'Solve re-plan';
    els.solve.setAttribute('aria-busy', String(busy));
    if (busy) {
      els.solveHint.textContent = 'Solver running in this page.';
    } else if (scenario) {
      els.solveHint.textContent = 'Uses the kit ticked in step 2.';
    } else {
      els.solveHint.textContent = 'Pick a cancellation in step 1 first.';
    }
  }

  function hideResults(message = PLACEHOLDER) {
    session = null;
    setState(els.resultsError, '');
    els.timing.hidden = true;
    els.timing.textContent = '';
    els.resultsEmpty.textContent = message;
    els.resultsEmpty.hidden = false;
    els.resultsBody.hidden = true;
  }

  function showResultsError(message) {
    session = null;
    els.resultsEmpty.hidden = true;
    els.resultsBody.hidden = true;
    els.timing.hidden = true;
    setState(els.resultsError, message, 'error');
  }

  function renderScenario() {
    const scenario = selectedScenario();
    if (!scenario) {
      els.detail.hidden = true;
      els.kitPanel.hidden = true;
      els.kitPlaceholder.hidden = false;
      renderSolveState();
      hideResults();
      return;
    }
    const booking = bookingFor(scenario);
    if (!booking) {
      els.detail.hidden = true;
      els.kitPanel.hidden = true;
      els.kitPlaceholder.hidden = false;
      renderSolveState();
      showResultsError(`Reservation ${scenario.cancellation.bookingId} is no longer in local data. Pick another cancellation.`);
      return;
    }
    const question = scenario.cancellation.question;
    els.summary.textContent = `${scenario.summary} Cancelled booking: ${booking.id}, ${booking.client}, ${booking.start} to ${booking.end}.`;
    els.question.textContent = question
      ? `Client question on this cancellation: "${question}"`
      : 'No client question on this cancellation.';
    els.waitlistLine.textContent = waitlistLine(scenario);
    els.detail.hidden = false;
    els.kit.replaceChildren(...booking.assigned.map(kitRow));
    els.kitPlaceholder.hidden = true;
    els.kitPanel.hidden = false;
    updateKitState();
    renderSolveState();
    hideResults();
  }

  function onKitChange() {
    updateKitState();
    if (session) hideResults(STALE);
  }

  function onSolve() {
    const scenario = selectedScenario();
    if (!scenario || busy) return;
    busy = true;
    renderSolveState();
    els.results.setAttribute('aria-busy', 'true');
    setState(els.resultsError, '');
    els.resultsEmpty.textContent = 'Running the deterministic solver in this page...';
    els.resultsEmpty.hidden = false;
    els.resultsBody.hidden = true;
    // Yield once so the loading state is painted before the synchronous solve runs.
    setTimeout(() => runSolve(scenario), 0);
  }

  function runSolve(scenario) {
    let solution;
    let elapsed;
    try {
      const started = performance.now();
      solution = solver.solve(stateFor(scenario), cancellationFor(scenario));
      elapsed = performance.now() - started;
      replansRun += 1;
    } catch (error) {
      session = null;
      showResultsError(`The solve failed: ${error instanceof Error ? error.message : String(error)}. Nothing was applied.`);
      return;
    } finally {
      busy = false;
      els.results.setAttribute('aria-busy', 'false');
      renderSolveState();
    }
    session = { decided: false };
    renderSolution(solution, elapsed);
    renderSummary();
  }

  function renderSolution(solution, elapsedMs) {
    setState(els.resultsError, '');
    els.resultsEmpty.hidden = true;
    els.resultsBody.hidden = false;
    els.decisionBlock.hidden = true;
    els.timing.hidden = false;
    els.verdict.textContent = VERDICTS[solution.outcome];
    els.timing.textContent = `Solved in ${elapsedMs.toFixed(2)} ms`;
    els.outcome.textContent = solution.reason;
    els.humanNote.hidden = solution.outcome !== 'none';

    els.plansBlock.hidden = solution.plans.length === 0;
    els.planRows.replaceChildren(...solution.plans.map(planRow));
    els.planDetails.replaceChildren(...solution.plans.map(planDetail));
    els.reject.disabled = solution.plans.length === 0;

    renderNoPlan(solution.rejected);
    renderHandoffs(solution.handoffs, solution.outcome);
  }

  function planRow(plan) {
    const row = el('tr');
    const approve = el('button', `Approve ${plan.id}`, 'btn btn-secondary approve');
    approve.type = 'button';
    approve.addEventListener('click', () => approvePlan(plan));

    const moves = el('ul', undefined, 'moves');
    for (const action of plan.actions) {
      const item = el('li');
      item.append(
        el('span', action.resourceId, 'mono'),
        document.createTextNode(` ${action.label}, from ${action.source}`),
      );
      moves.append(item);
    }

    const status = el('span', undefined, 'status-cell');
    status.append(
      badge(plan.status === 'full' ? 'Full' : 'Partial', plan.status === 'full' ? 'booked' : 'warn'),
      document.createTextNode(`${plan.filled} of ${plan.required} items`),
    );

    row.append(
      cell('Plan', el('span', plan.id, 'mono')),
      cell('To', document.createTextNode(plan.client)),
      cell('From booking', el('span', plan.cancelledBookingId, 'mono')),
      cell('What moved', moves),
      cell('Status', status),
      cell('Decision', approve),
    );
    return row;
  }

  function planDetail(plan) {
    const wrap = el('article', undefined, 'plan-detail');
    if (plan.status === 'partial') {
      wrap.append(listBlock(`Missing from ${plan.id}: ${plan.filled} of ${plan.required} items offered`, plan.missing, 'callout'));
    }
    const details = el('details');
    details.append(
      el('summary', `Checks, changes and open items for ${plan.id}`),
      listBlock('Constraints checked', plan.checks),
      listBlock('What changes', plan.changes.map((change) => `${change.client}: ${change.text}`)),
      listBlock('Left open', plan.open.length ? plan.open : ['Nothing']),
    );
    wrap.append(details);
    return wrap;
  }

  function renderNoPlan(rejected) {
    els.noPlanBlock.hidden = rejected.length === 0;
    els.noPlan.replaceChildren(...rejected.map((item) => el('li', `${item.requestId} (${item.client}): ${item.reason}`)));
  }

  function renderHandoffs(handoffs, outcome) {
    els.handoffs.replaceChildren();
    if (handoffs.length === 0) {
      els.handoffs.append(el('li', outcome === 'none'
        ? 'No feasible plan: the cancellation goes to a human dispatcher.'
        : 'No hand-off needed: the client has no question on this cancellation.'));
    }
    for (const handoff of handoffs) {
      const clause = handoff.clause
        ? ` Clause ${handoff.clause.id} (${handoff.clause.title}): ${handoff.clause.text}`
        : '';
      els.handoffs.append(el('li', `${handoff.topic}: ${handoff.reason}${clause}`));
    }
  }

  function lockDecision(text) {
    session.decided = true;
    els.decision.textContent = text;
    for (const button of els.resultsBody.querySelectorAll('button')) button.disabled = true;
    els.decisionBlock.hidden = false;
  }

  function approvePlan(plan) {
    if (!session || session.decided) return;
    const scenario = selectedScenario();
    if (!scenario) return;
    let fresh;
    try {
      fresh = solver.solve(stateFor(scenario), cancellationFor(scenario));
    } catch (error) {
      hideResults(`Not applied: the solver failed (${error.message}). Solve again before approving.`);
      return;
    }
    if (!approval.isCurrentPlan(plan, fresh)) {
      hideResults('Not applied: the kit selection or inventory no longer matches this re-plan. Solve again before approving.');
      return;
    }
    let next;
    try {
      next = solver.applyPlan(live, plan);
    } catch (error) {
      hideResults(`Not applied. ${error.message}. Solve again before approving.`);
      return;
    }
    live = next;
    lockDecision(approval.approvalMessage(plan));
    renderInventory(live);
    els.draft.textContent = draftClientMessage(plan);
    renderDataViews();
  }

  function rejectAll() {
    if (!session || session.decided) return;
    lockDecision('Rejected the re-plan. No changes applied; the released kit stays with staff for manual handling. Inventory unchanged below.');
    renderInventory(live);
    els.draft.textContent = 'No client message drafted for a rejected re-plan.';
  }

  function inventoryStatus(state, res) {
    const heldBy = state.bookings.find((booking) => booking.status === 'cancelled' && (booking.held || []).includes(res.id));
    if (heldBy) return `held by staff (${heldBy.id} cancelled)`;
    if (res.status === 'ok') return 'available';
    if (res.status === 'maintenance') return `maintenance until ${res.maintenanceUntil || 'unknown'}`;
    return `${res.status} (not offered)`;
  }

  function inventoryBadge(state, res) {
    const text = inventoryStatus(state, res);
    if (text.startsWith('held')) return badge('Held', 'held');
    if (text.startsWith('maintenance')) return badge('Maintenance', 'maintenance');
    if (text === 'available') return badge('Available', 'available');
    return badge(res.status, 'muted');
  }

  function renderInventory(state) {
    const head = el('tr');
    for (const title of ['Item', 'Status', 'Active bookings']) {
      const th = el('th', title);
      th.scope = 'col';
      head.append(th);
    }
    const thead = el('thead');
    thead.append(head);
    const body = el('tbody');
    for (const res of state.resources) {
      const holds = state.bookings
        .filter((booking) => booking.status !== 'cancelled' && booking.assigned.includes(res.id))
        .map((booking) => `${booking.id} ${booking.start} to ${booking.end}`);
      const status = el('span', undefined, 'status-cell');
      status.append(inventoryBadge(state, res), el('span', inventoryStatus(state, res), 'note'));
      const row = el('tr');
      row.append(
        cell('Item', el('span', res.id, 'mono'), document.createTextNode(` ${res.label}`)),
        cell('Status', status),
        cell('Active bookings', document.createTextNode(holds.join('; ') || 'none')),
      );
      body.append(row);
    }
    els.inventory.replaceChildren(thead, body);
  }

  // Fixed template. Filled from solver output only; no LLM, not sent anywhere.
  function draftClientMessage(plan) {
    const items = plan.actions.map((action) => action.label).join(', ');
    const consent = plan.status === 'full'
      ? 'Please reply to confirm.'
      : `We can offer ${plan.filled} of ${plan.required} requested items for these dates. Please reply to tell us whether this works for you.`;
    return [
      `To: ${plan.client}`,
      `Subject: Kit and studio for ${plan.start} to ${plan.end}`,
      '',
      `Hello ${plan.client},`,
      '',
      `We can offer the following for ${plan.start} to ${plan.end}: ${items}.`,
      consent,
      '',
      'Kind regards,',
      `${house} operations team`,
      '',
      '(Template draft for demo purposes. Not sent.)',
    ].join('\n');
  }

  // --- Calendar ------------------------------------------------------------

  function bookingsOnDay(iso) {
    const day = isoToDay(iso);
    if (day === null) return [];
    return activeBookings().filter((booking) => {
      const start = isoToDay(booking.start);
      const end = isoToDay(booking.end);
      return start !== null && end !== null && start <= day && day <= end;
    });
  }

  function initialiseCalendar() {
    const starts = activeBookings()
      .map((booking) => booking.start)
      .filter((iso) => isoToDay(iso) !== null)
      .sort();
    const base = starts[0] || summaryApi.DEMO_REFERENCE_DATE;
    const day = isoToDay(base);
    const parts = dayToParts(day);
    calendar = { year: parts.year, month: parts.month, selected: null, ready: true };
  }

  function loadCalendar() {
    if (!loaded.calendar) {
      loaded.calendar = true;
      setState(els.calendarState, 'Loading calendar...', 'loading');
      setTimeout(() => {
        try {
          if (!calendar.ready) initialiseCalendar();
          renderCalendar();
        } catch (error) {
          setState(els.calendarState, `Calendar could not be read: ${error.message}`, 'error');
        }
      }, 0);
      return;
    }
    renderCalendar();
  }

  function renderCalendar() {
    if (!calendar.ready) initialiseCalendar();
    setState(els.calendarState, '');
    const { year, month } = calendar;
    els.calMonth.textContent = `${MONTHS[month]} ${year}`;

    const first = new Date(Date.UTC(year, month, 1));
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const leading = (first.getUTCDay() + 6) % 7;
    const monthBookings = new Set();

    const nodes = [];
    for (const name of WEEKDAYS) {
      const header = el('span', name, 'cal-weekday');
      header.setAttribute('aria-hidden', 'true');
      nodes.push(header);
    }
    for (let i = 0; i < leading; i += 1) {
      const blank = el('span', undefined, 'cal-blank');
      blank.setAttribute('aria-hidden', 'true');
      nodes.push(blank);
    }

    for (let date = 1; date <= daysInMonth; date += 1) {
      const dayNumber = Date.UTC(year, month, date) / DAY_MS;
      const iso = dayToParts(dayNumber).iso;
      const dayBookings = bookingsOnDay(iso);
      for (const booking of dayBookings) monthBookings.add(booking.id);
      const button = el('button', undefined, 'cal-day');
      button.type = 'button';
      button.dataset.iso = iso;
      button.setAttribute('aria-pressed', String(calendar.selected === iso));
      button.setAttribute(
        'aria-label',
        `${date} ${MONTHS[month]} ${year}, ${dayBookings.length} reservation${dayBookings.length === 1 ? '' : 's'}`,
      );
      if (dayBookings.length) button.classList.add('has-bookings');
      button.append(el('span', String(date), 'cal-daynum'));
      if (dayBookings.length) {
        const count = el('span', String(dayBookings.length), 'cal-count');
        count.setAttribute('aria-hidden', 'true');
        const firstId = el('span', dayBookings[0].id, 'cal-id');
        firstId.setAttribute('aria-hidden', 'true');
        button.append(count, firstId);
      }
      button.addEventListener('click', () => selectCalendarDay(iso));
      nodes.push(button);
    }
    els.calendarGrid.replaceChildren(...nodes);

    if (monthBookings.size === 0) {
      els.calendarMonthNote.textContent = 'No reservations this month.';
    } else {
      els.calendarMonthNote.textContent = `${monthBookings.size} active reservation${monthBookings.size === 1 ? '' : 's'} this month.`;
    }
    renderDayList();
    if (monthBookings.size === 0 && !calendar.selected) {
      setState(els.dayState, 'No reservations this month. Select another month.', 'empty');
    }
  }

  function selectCalendarDay(iso) {
    calendar.selected = iso;
    for (const button of els.calendarGrid.querySelectorAll('.cal-day')) {
      button.setAttribute('aria-pressed', String(button.dataset.iso === iso));
    }
    renderDayList();
  }

  function renderDayList() {
    els.dayList.replaceChildren();
    const iso = calendar.selected;
    if (!iso) {
      els.dayTitle.textContent = 'Select a day';
      setState(els.dayState, 'Select a day to see its reservations.', 'empty');
      return;
    }
    const parts = dayToParts(isoToDay(iso));
    els.dayTitle.textContent = `Reservations on ${parts.day} ${MONTHS[parts.month]} ${parts.year}`;
    const list = bookingsOnDay(iso);
    if (list.length === 0) {
      setState(els.dayState, 'No reservations on this day.', 'empty');
      return;
    }
    setState(els.dayState, '');
    for (const booking of list) {
      const item = el('li', undefined, 'day-item');
      const head = el('div', undefined, 'day-item-head');
      head.append(el('span', booking.id, 'mono strong'), statusBadge(booking.status));
      item.append(
        head,
        el('p', booking.client, 'day-client'),
        el('p', `${booking.start} to ${booking.end}`, 'mono note'),
        el('p', `Items: ${booking.assigned.join(', ')}`, 'mono note'),
      );
      els.dayList.append(item);
    }
  }

  function shiftMonth(delta) {
    const next = new Date(Date.UTC(calendar.year, calendar.month + delta, 1));
    calendar.year = next.getUTCFullYear();
    calendar.month = next.getUTCMonth();
    calendar.selected = null;
    setState(els.calendarState, 'Loading calendar...', 'loading');
    setTimeout(() => {
      try {
        renderCalendar();
      } catch (error) {
        setState(els.calendarState, `Calendar could not be read: ${error.message}`, 'error');
      }
    }, 0);
  }

  // --- Equipment -----------------------------------------------------------

  const EQUIPMENT_STATUS = {
    available: { label: 'Available', variant: 'available' },
    booked: { label: 'Booked', variant: 'booked' },
    maintenance: { label: 'Maintenance', variant: 'maintenance' },
    held: { label: 'Held', variant: 'held' },
  };

  function equipmentStatus(res) {
    const heldBy = live.bookings.find((booking) => booking.status === 'cancelled' && (booking.held || []).includes(res.id));
    if (heldBy) {
      return {
        label: EQUIPMENT_STATUS.held.label,
        variant: EQUIPMENT_STATUS.held.variant,
        booking: `Held by staff after ${heldBy.id} was cancelled`,
      };
    }
    if (res.status === 'maintenance') {
      return {
        label: EQUIPMENT_STATUS.maintenance.label,
        variant: EQUIPMENT_STATUS.maintenance.variant,
        booking: `Maintenance until ${res.maintenanceUntil || 'an unknown date'}`,
      };
    }
    const holds = live.bookings.filter((booking) => booking.status !== 'cancelled' && booking.assigned.includes(res.id));
    if (holds.length) {
      return {
        label: EQUIPMENT_STATUS.booked.label,
        variant: EQUIPMENT_STATUS.booked.variant,
        booking: holds.map((booking) => `${booking.id} (${booking.start} to ${booking.end})`).join('; '),
      };
    }
    return {
      label: EQUIPMENT_STATUS.available.label,
      variant: EQUIPMENT_STATUS.available.variant,
      booking: 'No active booking',
    };
  }

  function loadEquipment() {
    if (!loaded.equipment) {
      loaded.equipment = true;
      setState(els.equipmentState, 'Loading equipment...', 'loading');
      setTimeout(() => {
        try {
          renderEquipment();
        } catch (error) {
          setState(els.equipmentState, `Equipment could not be read: ${error.message}`, 'error');
        }
      }, 0);
      return;
    }
    renderEquipment();
  }

  function renderEquipment() {
    const kind = els.equipmentFilter.value;
    const rows = live.resources.filter((res) => !kind || res.kind === kind);
    els.equipmentCount.textContent = `${rows.length} of ${live.resources.length} items`;
    if (rows.length === 0) {
      els.equipmentTableWrap.hidden = true;
      setState(els.equipmentState, 'No equipment matches this filter.', 'empty');
      return;
    }
    setState(els.equipmentState, '');
    els.equipmentTableWrap.hidden = false;
    const body = [];
    for (const res of rows) {
      const status = equipmentStatus(res);
      const row = el('tr');
      const item = el('div', undefined, 'table-stack');
      item.append(el('span', res.id, 'mono strong'), el('span', res.label, 'note'));
      row.append(
        cell('Item', item),
        cell('Kind', document.createTextNode(res.kind)),
        cell('Mount', el('span', res.mount || 'Any', res.mount ? 'mono' : 'note')),
        cell('Status', badge(status.label, status.variant)),
        cell('Current booking', document.createTextNode(status.booking)),
      );
      body.push(row);
    }
    els.equipmentRows.replaceChildren(...body);
  }

  // --- Reservations --------------------------------------------------------

  function statusBadge(status) {
    if (status === 'cancelled') return badge('Cancelled', 'muted');
    if (status === 'awaiting-client-consent') return badge('Awaiting consent', 'warn');
    if (status === 'confirmed') return badge('Confirmed', 'booked');
    return badge(status, 'muted');
  }

  function loadReservations() {
    if (!loaded.reservations) {
      loaded.reservations = true;
      setState(els.reservationsState, 'Loading reservations...', 'loading');
      setTimeout(() => {
        try {
          renderReservations();
        } catch (error) {
          setState(els.reservationsState, `Reservations could not be read: ${error.message}`, 'error');
        }
      }, 0);
      return;
    }
    renderReservations();
  }

  function renderReservations() {
    const filter = els.reservationFilter.value;
    const query = els.reservationSearch.value.trim().toLowerCase();
    const all = live.bookings;
    const rows = all.filter((booking) => {
      if (filter && booking.status !== filter) return false;
      if (!query) return true;
      return booking.id.toLowerCase().includes(query) || booking.client.toLowerCase().includes(query);
    });
    els.reservationCount.textContent = `${rows.length} of ${all.length} reservations`;
    if (rows.length === 0) {
      els.reservationsTableWrap.hidden = true;
      setState(els.reservationsState, 'No reservations match this filter.', 'empty');
      return;
    }
    setState(els.reservationsState, '');
    els.reservationsTableWrap.hidden = false;
    const body = [];
    for (const booking of rows) {
      const row = el('tr');
      row.id = `reservation-row-${booking.id}`;
      row.tabIndex = -1;
      row.append(
        cell('Reservation', el('span', booking.id, 'mono strong')),
        cell('Client', document.createTextNode(booking.client)),
        cell('Dates', el('span', `${booking.start} to ${booking.end}`, 'mono')),
        cell('Items', el('span', booking.assigned.join(', ') || 'None', 'mono items-cell')),
        cell('Status', statusBadge(booking.status)),
      );
      body.push(row);
    }
    els.reservationRows.replaceChildren(...body);
  }

  function openReservation(bookingId) {
    els.reservationSearch.value = '';
    els.reservationFilter.value = '';
    loaded.reservations = true;
    showTab('reservations', { focus: false });
    renderReservations();
    const row = $(`reservation-row-${bookingId}`);
    if (!row) {
      setState(els.reservationsState, `Reservation ${bookingId} is not in local data.`, 'error');
      return;
    }
    for (const candidate of els.reservationRows.querySelectorAll('tr')) candidate.classList.remove('is-highlighted');
    row.classList.add('is-highlighted');
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: 'center' });
  }

  // --- Assistant -----------------------------------------------------------

  const assistant = assistantApi.createAssistant({
    getTools: () => {
      const base = toolsApi.createTools(() => live);
      return {
        cancel_reservation: base.cancel_reservation,
        check_availability: base.check_availability,
        solve_replan(bookingId, releasedIds) {
          const result = base.solve_replan(bookingId, releasedIds);
          if (result.ok) {
            replansRun += 1;
            renderSummary();
          }
          return result;
        },
      };
    },
    getState: () => live,
  });

  function solverCallBlock(call) {
    const details = el('details', undefined, 'solver-call');
    details.append(el('summary', `Solver call: ${call.name}`));
    const body = el('div', undefined, 'solver-call-body');
    body.append(el('p', `Tool: ${call.name}`, 'solver-tool'));
    const pre = el('pre');
    pre.textContent = JSON.stringify({ tool: call.name, input: call.input, output: call.output }, null, 2);
    body.append(pre);
    details.append(body);
    return details;
  }

  function appendChatMessage(role, response) {
    const failed = response.status === 'error';
    const item = el('li', undefined, `chat-message chat-${role}${failed ? ' chat-error' : ''}`);
    if (failed) item.setAttribute('role', 'alert');
    item.append(el('span', role === 'user' ? 'You' : 'Assistant', 'sr-only'));
    for (const paragraph of String(response.text || '').split('\n\n')) {
      if (paragraph.trim()) item.append(el('p', paragraph));
    }
    for (const action of response.actions || []) {
      if (action.type !== 'open-reservation') continue;
      const button = el('button', action.label, 'btn btn-secondary chat-action');
      button.type = 'button';
      button.addEventListener('click', () => openReservation(action.bookingId));
      item.append(button);
    }
    for (const call of response.toolCalls || []) item.append(solverCallBlock(call));
    if (role === 'assistant') {
      item.append(el('p', `Rule-based reply · ${assistantApi.LLM_CALLS} LLM calls`, 'assistant-meta'));
    }
    els.chatLog.append(item);
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }

  function submitChat(event) {
    event.preventDefault();
    if (assistantBusy) return;
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
    els.chatStatus.textContent = 'Checking the rule set and the deterministic solver...';
    // One frame is enough for the loading state; there is no artificial delay.
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

  // --- Scope card ----------------------------------------------------------

  function openScope() {
    els.scopeCard.hidden = false;
    els.scopeLink.setAttribute('aria-expanded', 'true');
    els.scopeCard.scrollIntoView({ block: 'nearest' });
    els.scopeTitle.focus();
  }

  function closeScope() {
    els.scopeCard.hidden = true;
    els.scopeLink.setAttribute('aria-expanded', 'false');
    els.scopeLink.focus();
  }

  // --- init ----------------------------------------------------------------

  function populateFilters() {
    const kinds = [...new Set(live.resources.map((res) => res.kind))].sort();
    for (const kind of kinds) {
      const option = el('option', kind.charAt(0).toUpperCase() + kind.slice(1));
      option.value = kind;
      els.equipmentFilter.append(option);
    }
  }

  function updateLlmLabels() {
    for (const node of document.querySelectorAll('.js-llm-calls')) {
      node.textContent = node.classList.contains('badge')
        ? `LLM calls: ${assistantApi.LLM_CALLS}`
        : `${assistantApi.LLM_CALLS} LLM calls`;
    }
  }

  for (const scenario of scenarios) els.scenarios.append(scenarioCard(scenario));
  els.kit.addEventListener('change', onKitChange);
  els.solve.addEventListener('click', onSolve);
  els.reject.addEventListener('click', rejectAll);

  for (const button of els.navTabs) {
    button.addEventListener('click', () => showTab(button.dataset.tab));
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

  els.calPrev.addEventListener('click', () => shiftMonth(-1));
  els.calNext.addEventListener('click', () => shiftMonth(1));
  els.equipmentFilter.addEventListener('change', renderEquipment);
  els.reservationSearch.addEventListener('input', renderReservations);
  els.reservationFilter.addEventListener('change', renderReservations);

  els.chatForm.addEventListener('submit', submitChat);
  for (const chip of document.querySelectorAll('.chip')) {
    chip.addEventListener('click', () => {
      els.chatInput.value = chip.dataset.prompt || '';
      if (typeof els.chatForm.requestSubmit === 'function') els.chatForm.requestSubmit();
      else els.chatForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });
  }

  els.scopeLink.addEventListener('click', () => {
    if (els.scopeCard.hidden) openScope();
    else closeScope();
  });
  els.scopeClose.addEventListener('click', closeScope);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!els.scopeCard.hidden) {
      event.preventDefault();
      closeScope();
    } else if (document.body.classList.contains('nav-open')) {
      closeMenu();
      els.menuToggle.focus();
    }
  });

  if (typeof window.matchMedia === 'function') {
    const desktop = window.matchMedia('(min-width: 1024px)');
    const onChange = () => {
      if (desktop.matches) closeMenu();
    };
    if (typeof desktop.addEventListener === 'function') desktop.addEventListener('change', onChange);
  }

  populateFilters();
  updateLlmLabels();
  renderSummary();
  renderSolveState();
  hideResults();
  appendChatMessage('assistant', {
    status: 'ok',
    text: 'Rule-based assistant with 0 LLM calls. I can cancel a reservation or check equipment availability from the deterministic solver. I restate every request and wait for your "yes" before calling a tool; this chat never applies a plan.',
    toolCalls: [],
    actions: [],
  });

  const initial = window.location.hash.replace('#', '');
  showTab(TAB_NAMES.includes(initial) ? initial : 'dispatch', { focus: false, updateHash: false });
})();
