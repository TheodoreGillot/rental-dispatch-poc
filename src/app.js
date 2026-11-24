/*
 * UI wiring for the dispatch demo. Calls the solver, renders plans, and applies
 * approved plans to an in-memory copy of the state. Every user-visible value is
 * written with textContent; nothing is parsed as HTML. No network, no LLM.
 */
(function () {
  'use strict';

  const { house, resources, bookings, waitlist, clauses, scenarios } = globalThis.RentalData;
  const solver = globalThis.RentalSolver;
  const approval = globalThis.RentalApproval;

  const els = {
    scenario: document.getElementById('scenario'),
    summary: document.getElementById('scenario-summary'),
    question: document.getElementById('question'),
    kit: document.getElementById('kit-options'),
    solve: document.getElementById('solve'),
    timing: document.getElementById('timing'),
    plansSection: document.getElementById('plans-section'),
    outcome: document.getElementById('outcome'),
    plans: document.getElementById('plans'),
    reject: document.getElementById('reject-all'),
    handoffSection: document.getElementById('handoff-section'),
    handoffs: document.getElementById('handoffs'),
    resultSection: document.getElementById('result-section'),
    decision: document.getElementById('decision'),
    inventory: document.getElementById('inventory'),
    draft: document.getElementById('draft'),
  };

  // Inventory after approvals. Starts from the demo data and is kept for the page session only.
  let live = { resources, bookings, clauses, waitlist };
  // The solve on screen: its result and whether staff has decided.
  let session = null;

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function section(title, items) {
    const wrap = el('div', undefined, 'block');
    const list = el('ul');
    for (const item of items) list.append(el('li', item));
    wrap.append(el('h4', title), list);
    return wrap;
  }

  function stateFor(scenario) {
    return {
      ...live,
      waitlist: live.waitlist.filter((request) => scenario.waitlistIds.includes(request.id)),
    };
  }

  function selectedScenario() {
    return scenarios.find((scenario) => scenario.id === els.scenario.value);
  }

  function releasedIds() {
    return [...els.kit.querySelectorAll('input:checked')].map((input) => input.value);
  }

  function cancellationFor(scenario) {
    return {
      bookingId: scenario.cancellation.bookingId,
      question: scenario.cancellation.question,
      releasedIds: releasedIds(),
    };
  }

  function kitOption(resourceId) {
    const res = resources.find((r) => r.id === resourceId);
    const label = el('label', undefined, 'kit-option');
    const input = el('input');
    input.type = 'checkbox';
    input.value = res.id;
    input.checked = true;
    label.append(input, document.createTextNode(` ${res.id} · ${res.label}`));
    return label;
  }

  function hideResults() {
    session = null;
    els.timing.textContent = 'not run yet';
    els.plansSection.hidden = true;
    els.handoffSection.hidden = true;
    els.resultSection.hidden = true;
    els.reject.disabled = true;
  }

  function renderScenario() {
    const scenario = selectedScenario();
    const booking = live.bookings.find((b) => b.id === scenario.cancellation.bookingId);
    const question = scenario.cancellation.question;
    els.summary.textContent = `${scenario.summary} Cancelled booking: ${booking.id}, ${booking.client}, ${booking.start} to ${booking.end}.`;
    els.question.textContent = question
      ? `Client question on this cancellation: "${question}"`
      : 'No client question on this cancellation.';
    els.kit.replaceChildren(...booking.assigned.map(kitOption));
    hideResults();
  }

  function onSolve() {
    const scenario = selectedScenario();

    const started = performance.now();
    const solution = solver.solve(stateFor(scenario), cancellationFor(scenario));
    const elapsed = performance.now() - started;

    els.timing.textContent = `${elapsed.toFixed(2)} ms`;
    session = { decided: false };
    renderSolution(solution);
  }

  function renderSolution(solution) {
    els.outcome.textContent = solution.reason;
    const cards = solution.plans.map(renderPlan);
    if (solution.rejected.length) {
      cards.push(section('Requests with no plan', solution.rejected.map((r) => `${r.requestId} (${r.client}): ${r.reason}`)));
    }
    els.plans.replaceChildren(...cards);
    els.reject.disabled = solution.plans.length === 0;
    els.plansSection.hidden = false;

    els.handoffs.replaceChildren();
    if (solution.handoffs.length === 0) {
      els.handoffs.append(el('li', 'No hand-off needed: the client has no question on this cancellation.'));
    }
    for (const h of solution.handoffs) {
      const clause = h.clause ? ` Clause ${h.clause.id} (${h.clause.title}): ${h.clause.text}` : '';
      els.handoffs.append(el('li', `${h.topic}: ${h.reason}${clause}`));
    }
    els.handoffSection.hidden = false;
    els.resultSection.hidden = true;
  }

  function renderPlan(plan) {
    const card = el('article', undefined, 'plan');
    card.append(el('h3', `${plan.id}: ${plan.client}, ${plan.status} kit (${plan.filled} of ${plan.required})`));
    card.append(
      section('Actions', plan.actions.map((a) => `${a.resourceId} (${a.label}) from ${a.source}`)),
      section('Constraints checked', plan.checks),
      section('What changes', plan.changes.map((c) => `${c.client}: ${c.text}`)),
      section('Left open', plan.open.length ? plan.open : ['Nothing']),
    );
    const button = el('button', `Approve ${plan.id}`);
    button.type = 'button';
    button.addEventListener('click', () => approvePlan(plan));
    card.append(button);
    return card;
  }

  function lockDecision(text) {
    session.decided = true;
    els.decision.textContent = text;
    for (const button of els.plansSection.querySelectorAll('button')) button.disabled = true;
    els.resultSection.hidden = false;
  }

  function refuse(message) {
    hideResults();
    els.decision.textContent = message;
    els.resultSection.hidden = false;
  }

  function approvePlan(plan) {
    if (!session || session.decided) return;
    const scenario = selectedScenario();
    const fresh = solver.solve(stateFor(scenario), cancellationFor(scenario));
    if (!approval.isCurrentPlan(plan, fresh)) {
      refuse('Not applied: the kit selection or inventory no longer matches this re-plan. Solve again before approving.');
      return;
    }
    let next;
    try {
      next = solver.applyPlan(live, plan);
    } catch (error) {
      refuse(`Not applied. ${error.message}. Solve again before approving.`);
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
    const table = el('table');
    const head = el('tr');
    for (const title of ['Item', 'Status', 'Active bookings']) head.append(el('th', title));
    const thead = el('thead');
    thead.append(head);
    const body = el('tbody');
    for (const res of state.resources) {
      const holds = state.bookings
        .filter((b) => b.status !== 'cancelled' && b.assigned.includes(res.id))
        .map((b) => `${b.id} ${b.start} to ${b.end}`);
      const row = el('tr');
      row.append(el('td', `${res.id} · ${res.label}`), el('td', resourceStatus(state, res)), el('td', holds.join('; ') || 'none'));
      body.append(row);
    }
    table.append(thead, body);
    els.inventory.replaceChildren(table);
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

  for (const scenario of scenarios) {
    const option = el('option', scenario.title);
    option.value = scenario.id;
    els.scenario.append(option);
  }
  els.scenario.addEventListener('change', renderScenario);
  // Any kit change makes the displayed plans stale: hide them until the user solves again.
  els.kit.addEventListener('change', hideResults);
  els.solve.addEventListener('click', onSolve);
  els.reject.addEventListener('click', rejectAll);
  renderScenario();
})();
