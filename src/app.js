/*
 * UI wiring for the dispatch demo. Calls the solver, renders plans, and applies
 * approved plans to an in-memory copy of the state. Every user-visible value is
 * written with textContent or as a text node; nothing is parsed as HTML. No network, no LLM.
 */
(function () {
  'use strict';

  const { house, resources, bookings, waitlist, clauses, scenarios } = globalThis.RentalData;
  const solver = globalThis.RentalSolver;
  const approval = globalThis.RentalApproval;

  const PLACEHOLDER = 'Results appear here after you solve. Nothing is applied until you approve a plan.';
  const STALE = 'The cancellation or kit changed. Solve again to see a current re-plan.';
  const VERDICTS = {
    full: 'Full re-plan',
    partial: 'Partial re-plan: client consent needed',
    none: 'No feasible re-plan',
  };

  const els = {
    scenarios: document.getElementById('scenarios'),
    detail: document.getElementById('scenario-detail'),
    summary: document.getElementById('scenario-summary'),
    question: document.getElementById('question'),
    waitlistLine: document.getElementById('waitlist-line'),
    kitPlaceholder: document.getElementById('kit-placeholder'),
    kitPanel: document.getElementById('kit-panel'),
    kitCount: document.getElementById('kit-count'),
    kit: document.getElementById('kit-options'),
    kitNote: document.getElementById('kit-note'),
    solve: document.getElementById('solve'),
    solveHint: document.getElementById('solve-hint'),
    results: document.getElementById('results'),
    resultsEmpty: document.getElementById('results-empty'),
    resultsBody: document.getElementById('results-body'),
    verdict: document.getElementById('verdict'),
    timing: document.getElementById('timing'),
    outcome: document.getElementById('outcome'),
    humanNote: document.getElementById('human-note'),
    plansBlock: document.getElementById('plans-block'),
    planRows: document.getElementById('plan-rows'),
    planDetails: document.getElementById('plan-details'),
    reject: document.getElementById('reject-all'),
    noPlanBlock: document.getElementById('no-plan-block'),
    noPlan: document.getElementById('no-plan'),
    handoffs: document.getElementById('handoffs'),
    decisionBlock: document.getElementById('decision-block'),
    decision: document.getElementById('decision'),
    inventory: document.getElementById('inventory'),
    draft: document.getElementById('draft'),
  };

  // Inventory after approvals. Starts from the demo data and is kept for the page session only.
  let live = { resources, bookings, clauses, waitlist };
  let selectedId = null;
  // The solve on screen: whether staff has decided. Null when no result is shown.
  let session = null;
  let busy = false;

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

  function bookingFor(scenario) {
    return live.bookings.find((b) => b.id === scenario.cancellation.bookingId);
  }

  function selectedScenario() {
    return scenarios.find((scenario) => scenario.id === selectedId) ?? null;
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
    if (requests.length === 0) return 'Waitlist: nobody is waiting for this cancellation.';
    const list = requests.map((r) => `${r.id} ${r.client}, ${r.start} to ${r.end}`).join('; ');
    return `Waitlist: ${list}.`;
  }

  function scenarioCard(scenario) {
    const booking = bookingFor(scenario);
    const button = el('button', undefined, 'scenario');
    button.type = 'button';
    button.dataset.id = scenario.id;
    button.setAttribute('aria-pressed', 'false');
    button.append(
      el('span', scenario.title, 'scenario-title'),
      el('span', `${booking.start} to ${booking.end}`, 'scenario-date'),
      el('span', `Customer: ${booking.client}`, 'scenario-meta'),
      el('span', `Items: ${booking.assigned.join(', ')}`, 'scenario-meta mono'),
      el('span', `Releases: all ${booking.assigned.length} items by default`, 'scenario-meta'),
      el('span', 'Select', 'scenario-state'),
    );
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
      button.querySelector('.scenario-state').textContent = pressed ? 'Selected' : 'Select';
    }
    renderScenario();
  }

  function kitRow(resourceId) {
    const res = resources.find((r) => r.id === resourceId);
    const item = el('li');
    const label = el('label', undefined, 'kit-row');
    const input = el('input');
    input.type = 'checkbox';
    input.value = res.id;
    input.checked = true;
    const name = el('span', undefined, 'kit-name');
    name.append(el('span', res.id, 'mono kit-id'), el('span', res.label, 'kit-label'));
    label.append(input, name, el('span', 'Released', 'kit-state'));
    item.append(label);
    return item;
  }

  // Live count and effect of the current kit ticks. Keeps the state in text, not colour alone.
  function updateKitState() {
    const inputs = kitInputs();
    const released = inputs.filter((input) => input.checked).length;
    for (const input of inputs) {
      input.closest('.kit-row').querySelector('.kit-state').textContent = input.checked ? 'Released' : 'Held back';
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

  // Shows a message in place of the result. Used before the first solve, after a kit change, and on a refused approval.
  function hideResults(message = PLACEHOLDER) {
    session = null;
    els.resultsEmpty.textContent = message;
    els.resultsEmpty.hidden = false;
    els.resultsBody.hidden = true;
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
    // Any kit change makes the displayed plans stale: hide them until the user solves again.
    if (session) hideResults(STALE);
  }

  function onSolve() {
    const scenario = selectedScenario();
    if (!scenario || busy) return;
    busy = true;
    renderSolveState();
    els.results.setAttribute('aria-busy', 'true');
    // Yield once so the "Solving..." state is painted before the synchronous solve runs.
    setTimeout(() => runSolve(scenario), 0);
  }

  function runSolve(scenario) {
    let solution;
    let elapsed;
    try {
      const started = performance.now();
      solution = solver.solve(stateFor(scenario), cancellationFor(scenario));
      elapsed = performance.now() - started;
    } finally {
      busy = false;
      els.results.setAttribute('aria-busy', 'false');
      renderSolveState();
    }
    session = { decided: false };
    renderSolution(solution, elapsed);
  }

  function renderSolution(solution, elapsedMs) {
    els.resultsEmpty.hidden = true;
    els.resultsBody.hidden = false;
    els.decisionBlock.hidden = true;
    els.verdict.textContent = VERDICTS[solution.outcome];
    els.timing.textContent = `Solved in ${elapsedMs.toFixed(2)} ms`;
    els.outcome.textContent = solution.reason;
    els.humanNote.hidden = solution.outcome !== 'none';

    els.plansBlock.hidden = solution.plans.length === 0;
    els.planRows.replaceChildren(...solution.plans.map(planRow));
    els.planDetails.replaceChildren(...solution.plans.map(planDetail));
    els.reject.disabled = solution.plans.length === 0;

    renderNoPlan(solution.rejected);
    renderHandoffs(solution.handoffs);
  }

  function planRow(plan) {
    const row = el('tr');
    const approve = el('button', `Approve ${plan.id}`, 'approve');
    approve.type = 'button';
    approve.addEventListener('click', () => approvePlan(plan));

    const moves = el('ul', undefined, 'moves');
    for (const action of plan.actions) {
      const item = el('li');
      item.append(el('span', action.resourceId, 'mono'), document.createTextNode(` ${action.label}, from ${action.source}`));
      moves.append(item);
    }

    row.append(
      cell('Plan', el('span', plan.id, 'mono')),
      cell('To', document.createTextNode(plan.client)),
      cell('From booking', el('span', plan.cancelledBookingId, 'mono')),
      cell('What moved', moves),
      cell('Status', document.createTextNode(`${plan.status === 'full' ? 'Full' : 'Partial'}, ${plan.filled} of ${plan.required} items`)),
      cell('Decision', approve),
    );
    return row;
  }

  // Partial plans show their missing items first; the checks and changes stay one click away.
  function planDetail(plan) {
    const wrap = el('article', undefined, 'plan-detail');
    if (plan.status === 'partial') {
      wrap.append(listBlock(`Missing from ${plan.id}: ${plan.filled} of ${plan.required} items offered`, plan.missing, 'callout'));
    }
    const details = el('details');
    details.append(
      el('summary', `Checks, changes and open items for ${plan.id}`),
      listBlock('Constraints checked', plan.checks),
      listBlock('What changes', plan.changes.map((c) => `${c.client}: ${c.text}`)),
      listBlock('Left open', plan.open.length ? plan.open : ['Nothing']),
    );
    wrap.append(details);
    return wrap;
  }

  function renderNoPlan(rejected) {
    els.noPlanBlock.hidden = rejected.length === 0;
    els.noPlan.replaceChildren(...rejected.map((r) => el('li', `${r.requestId} (${r.client}): ${r.reason}`)));
  }

  function renderHandoffs(handoffs) {
    els.handoffs.replaceChildren();
    if (handoffs.length === 0) {
      els.handoffs.append(el('li', 'No hand-off needed: the client has no question on this cancellation.'));
    }
    for (const h of handoffs) {
      const clause = h.clause ? ` Clause ${h.clause.id} (${h.clause.title}): ${h.clause.text}` : '';
      els.handoffs.append(el('li', `${h.topic}: ${h.reason}${clause}`));
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
    const fresh = solver.solve(stateFor(scenario), cancellationFor(scenario));
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
  }

  function rejectAll() {
    if (!session || session.decided) return;
    lockDecision('Rejected the re-plan. No changes applied; the released kit stays with staff for manual handling. Inventory unchanged below.');
    renderInventory(live);
    els.draft.textContent = 'No client message drafted for a rejected re-plan.';
  }

  function resourceStatus(state, res) {
    const heldBy = state.bookings.find((b) => b.status === 'cancelled' && (b.held ?? []).includes(res.id));
    if (heldBy) return `held by staff (${heldBy.id} cancelled)`;
    if (res.status === 'ok') return 'available';
    if (res.status === 'maintenance') return `maintenance until ${res.maintenanceUntil ?? 'unknown'}`;
    return `${res.status} (not offered)`;
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
        .filter((b) => b.status !== 'cancelled' && b.assigned.includes(res.id))
        .map((b) => `${b.id} ${b.start} to ${b.end}`);
      const row = el('tr');
      row.append(
        cell('Item', el('span', res.id, 'mono'), document.createTextNode(` ${res.label}`)),
        cell('Status', document.createTextNode(resourceStatus(state, res))),
        cell('Active bookings', document.createTextNode(holds.join('; ') || 'none')),
      );
      body.append(row);
    }
    els.inventory.replaceChildren(thead, body);
  }

  // Fixed template. Filled from solver output only; no LLM, not sent anywhere.
  function draftClientMessage(plan) {
    const items = plan.actions.map((a) => a.label).join(', ');
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

  for (const scenario of scenarios) els.scenarios.append(scenarioCard(scenario));
  els.kit.addEventListener('change', onKitChange);
  els.solve.addEventListener('click', onSolve);
  els.reject.addEventListener('click', rejectAll);
  renderSolveState();
  hideResults();
})();
