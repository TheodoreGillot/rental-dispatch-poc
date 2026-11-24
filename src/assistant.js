/*
 * Rule-based assistant. It reads fixed patterns, restates the request, asks for
 * confirmation, and only then calls the pure tools in tools.js. There is no LLM,
 * no network call and no free-text generation: every sentence is a template
 * filled from parsed input or structured solver output.
 *
 * Loaded as a classic script before app.js. Node tests read it through module.exports.
 */
(function () {
  'use strict';

  const solver = typeof module !== 'undefined'
    ? require('./solver.js')
    : globalThis.RentalSolver;

  const { toDay } = typeof module !== 'undefined'
    ? require('./validation.js')
    : globalThis.RentalValidation;

  // There is no model client in this project. The number is a constant so the
  // UI and the scope card can state the same value.
  const LLM_CALLS = 0;

  const HANDOFF_SENTENCE = 'No feasible re-plan, so this goes to a human dispatcher. Open the reservation in the Reservations tab.';

  const BOOKING_ID = /\bB-\d{4}\b/i;
  const DATE = /\b(\d{4}-\d{2}-\d{2})\b/g;
  const CANCEL_VERB = /\b(cancel|cancelling|canceling|drop|release)\b/i;
  const FEE_WORDS = /\b(fee|fees|charge|charges|cost|costs|pay|payment|refund|refunds|deposit|deposits|money|bill|billed|price|liab\w*|contract|clause|terms|agreement)\b/i;
  const AVAILABILITY_WORDS = /\b(available|availability|free|reschedule|rescheduling|move|shift|change(\s+the)?\s+dates?)\b/i;
  const RESCHEDULE_WORDS = /\b(reschedule|rescheduling|move|shift|change(\s+the)?\s+dates?)\b/i;
  const HELP_WORDS = /^(hi|hello|hey|help)\b|\b(what can you do|how does this work)\b/i;

  const KINDS = [
    { kind: 'camera', pattern: /\b(cameras?|bodies|body|dslrs?|mirrorless)\b/i },
    { kind: 'lens', pattern: /\b(lens|lenses|glass)\b/i },
    { kind: 'light', pattern: /\b(lights?|leds?|lighting)\b/i },
    { kind: 'audio', pattern: /\b(audio|mics?|microphones?|recorders?|sound)\b/i },
    { kind: 'studio', pattern: /\b(studios?|spaces?|rooms?)\b/i },
  ];

  /** One of 'cancel', 'availability' or 'question'. Cancelling money questions stay questions. */
  function parseIntent(text) {
    const value = typeof text === 'string' ? text : '';
    if (CANCEL_VERB.test(value) && !FEE_WORDS.test(value)) return 'cancel';
    if (AVAILABILITY_WORDS.test(value)) return 'availability';
    return 'question';
  }

  /** Two real ISO dates in order, one date as a single-day range, or an invalid marker. */
  function parseDates(text) {
    const found = [];
    const invalid = [];
    for (const match of String(text).matchAll(DATE)) {
      if (toDay(match[1]) === null) invalid.push(match[1]);
      else found.push(match[1]);
    }
    if (invalid.length) return { dates: [], invalid };
    if (found.length === 0) return { dates: [], invalid: [] };
    if (found.length === 1) return { dates: [found[0], found[0]], invalid: [] };
    return { dates: [found[0], found[1]], invalid: [] };
  }

  function parseKind(text) {
    const value = String(text);
    let best = null;
    for (const entry of KINDS) {
      const match = entry.pattern.exec(value);
      if (match && (best === null || match.index < best.index)) best = { kind: entry.kind, index: match.index };
    }
    return best ? best.kind : null;
  }

  function parseMount(text) {
    const match = /\b(EF|Z)(?:-mount|\s+mount)\b/i.exec(String(text));
    return match ? match[1].toUpperCase() : null;
  }

  function isYes(text) {
    return /^(y|yes|yeah|yep|confirm|confirmed|ok|okay|proceed|do it|go ahead)\b/i.test(String(text).trim());
  }

  function isNo(text) {
    return /^(n|no|nope|stop|don't|do not|never mind|nevermind|cancel that)\b/i.test(String(text).trim());
  }

  function response(parts) {
    return {
      intent: 'question',
      status: 'ok',
      text: '',
      toolCalls: [],
      pending: null,
      actions: [],
      ...parts,
    };
  }

  function listIds(items) {
    return items.map((item) => item.id).join(', ');
  }

  function describeClause(handoff) {
    if (!handoff.clause) return handoff.reason;
    return `${handoff.reason} Clause ${handoff.clause.id} (${handoff.clause.title}): ${handoff.clause.text}`;
  }

  /**
   * @param {{getTools: () => object, getState: () => object}} deps
   *   getTools returns the three tools from tools.js; getState returns the live demo state.
   */
  function createAssistant({ getTools, getState }) {
    let pending = null;

    function readState() {
      return typeof getState === 'function' ? getState() : getState;
    }

    function findBooking(text) {
      const state = readState();
      const id = BOOKING_ID.exec(text);
      if (id) {
        const wanted = id[0].toUpperCase();
        return { id: wanted, booking: state.bookings.find((b) => b.id === wanted) || null };
      }
      const lower = text.toLowerCase();
      const booking = state.bookings.find((b) => {
        const name = b.client.replace(/\s*\(fictional\)/i, '').trim().toLowerCase();
        return name.length > 0 && lower.includes(name);
      });
      return booking ? { id: booking.id, booking } : null;
    }

    function finishCancel() {
      const tools = getTools();
      const bookingId = pending.bookingId;
      const input = { bookingId };
      const cancelled = tools.cancel_reservation(bookingId);
      const toolCalls = [{ name: 'cancel_reservation', input, output: cancelled }];
      pending = null;
      if (!cancelled.ok) {
        return response({
          intent: 'cancel',
          status: 'error',
          text: `I could not cancel ${bookingId}: ${cancelled.error} Nothing was changed.`,
          toolCalls,
        });
      }

      const solveInput = { bookingId, releasedIds: cancelled.releasedIds };
      const solved = tools.solve_replan(bookingId, cancelled.releasedIds);
      toolCalls.push({ name: 'solve_replan', input: solveInput, output: solved });
      const released = `${cancelled.released.length} item(s) would be released: ${listIds(cancelled.released)}.`;
      if (!solved.ok) {
        return response({
          intent: 'cancel',
          status: 'error',
          text: `I validated the cancellation, but the re-plan search failed: ${solved.error} Nothing was applied.`,
          toolCalls,
        });
      }

      const actions = [];
      if (!solved.feasible) {
        actions.push({
          type: 'open-reservation',
          bookingId,
          label: `Open ${bookingId} in Reservations`,
        });
        return response({
          intent: 'cancel',
          status: 'ok',
          text: `Cancellation request for ${bookingId}. ${released} The solver returned outcome "none": ${solved.reason} ${HANDOFF_SENTENCE}`,
          toolCalls,
          actions,
        });
      }

      const plan = solved.plan;
      const moveIds = solved.moves.map((move) => move.resourceId).join(', ');
      const statusLine = plan.status === 'full'
        ? 'a full re-plan'
        : 'a partial re-plan, which needs client consent';
      return response({
        intent: 'cancel',
        status: 'ok',
        text: `Cancellation request for ${bookingId}. ${released} The solver returned ${statusLine}: ${plan.id} offers ${plan.filled} of ${plan.required} item(s) to ${plan.client} for ${plan.start} to ${plan.end}. Moves returned by the solver: ${moveIds}. Nothing is applied by this chat; a dispatcher approves the plan in Dispatch.`,
        toolCalls,
        actions,
      });
    }

    function finishAvailability() {
      const tools = getTools();
      const { kind, start, end, mount, reschedule } = pending;
      const input = { resourceKind: kind, start, end, mount };
      const report = tools.check_availability(kind, start, end, mount);
      const toolCalls = [{ name: 'check_availability', input, output: report }];
      pending = null;
      if (!report.ok) {
        return response({
          intent: 'availability',
          status: 'error',
          text: `The availability check failed: ${report.error} Nothing was booked or moved.`,
          toolCalls,
        });
      }
      const intro = reschedule
        ? 'I cannot move a reservation myself, but I can check whether the kit is free.'
        : 'Availability check.';
      if (report.available.length === 0) {
        const reasons = report.unavailable.map((item) => item.reason).join(' ');
        return response({
          intent: 'availability',
          status: 'ok',
          text: `${intro} No ${kind} item is free from ${start} to ${end}. ${reasons} A human dispatcher can review alternatives; nothing is reserved.`,
          toolCalls,
        });
      }
      const unavailable = report.unavailable.length
        ? ` Unavailable: ${report.unavailable.map((item) => item.reason).join(' ')}`
        : '';
      return response({
        intent: 'availability',
        status: 'ok',
        text: `${intro} ${report.available.length} ${kind} item(s) are free from ${start} to ${end}: ${report.available.join(', ')}.${unavailable} This is an availability answer only; nothing is reserved or moved.`,
        toolCalls,
      });
    }

    function askCancel(text) {
      const found = findBooking(text);
      if (!found) {
        return response({
          intent: 'cancel',
          status: 'error',
          text: 'Which reservation should I cancel? Give an id such as B-1001, or the client name.',
        });
      }
      if (!found.booking) {
        return response({
          intent: 'cancel',
          status: 'error',
          text: `No reservation ${found.id} exists. Nothing was changed. Check the Reservations tab for a valid id.`,
        });
      }
      const { booking } = found;
      if (booking.status === 'cancelled') {
        return response({
          intent: 'cancel',
          status: 'error',
          text: `Reservation ${booking.id} is already cancelled. Nothing was changed.`,
        });
      }
      const items = booking.assigned.map((id) => {
        const res = readState().resources.find((candidate) => candidate.id === id);
        return res ? res.id : id;
      });
      pending = { type: 'cancel', bookingId: booking.id };
      return response({
        intent: 'cancel',
        text: `You asked to cancel reservation ${booking.id} for ${booking.client}, ${booking.start} to ${booking.end}. That would release ${items.length} item(s): ${items.join(', ')}. I will then run the re-plan search. Nothing changes until you confirm. Reply "yes" to confirm or "no" to stop.`,
        pending: { type: 'cancel', bookingId: booking.id },
      });
    }

    function askAvailability(text) {
      const parsed = parseDates(text);
      if (parsed.invalid.length) {
        return response({
          intent: 'availability',
          status: 'error',
          text: `Not a real date: ${parsed.invalid.join(', ')}. Use YYYY-MM-DD, for example 2026-12-05.`,
        });
      }
      if (parsed.dates.length === 0) {
        return response({
          intent: 'availability',
          status: 'error',
          text: 'Which dates should I check? Use two YYYY-MM-DD dates, for example 2026-12-05 to 2026-12-07.',
        });
      }
      const found = findBooking(text);
      const booking = found && found.booking ? found.booking : null;
      let kind = parseKind(text);
      if (!kind && booking) {
        const first = readState().resources.find((res) => res.id === booking.assigned[0]);
        kind = first ? first.kind : null;
      }
      if (!kind) {
        return response({
          intent: 'availability',
          status: 'error',
          text: 'Which kind of equipment should I check? I know camera, lens, light, audio and studio.',
        });
      }
      const mount = parseMount(text) || (booking ? booking.mount : null);
      const [start, end] = parsed.dates;
      if (toDay(start) > toDay(end)) {
        return response({
          intent: 'availability',
          status: 'error',
          text: `The range ends on ${end}, before it starts on ${start}. Give the earlier date first.`,
        });
      }
      const reschedule = RESCHEDULE_WORDS.test(text);
      pending = { type: 'availability', kind, start, end, mount, reschedule };
      const mountLine = mount ? ` for ${mount} mount` : '';
      return response({
        intent: 'availability',
        text: `You asked about ${kind} availability${mountLine} from ${start} to ${end}. Reply "yes" to run the availability check, or "no" to stop. This checks availability only; it does not book or move anything.`,
        pending: { type: 'availability', kind, start, end, mount, reschedule },
      });
    }

    function helpReply() {
      return response({
        intent: 'question',
        text: `I am a rule-based assistant with ${LLM_CALLS} LLM calls. I can cancel a reservation or check equipment availability from the solver. Try "Cancel B-1001" or "Is a camera available 2026-12-05 to 2026-12-07?".`,
      });
    }

    function answerQuestion(text) {
      if (HELP_WORDS.test(text) && !FEE_WORDS.test(text)) return helpReply();
      const state = readState();
      const handoffs = solver.routeHandoffs(text, state.clauses || {});
      if (handoffs.length) {
        const handoff = handoffs[0];
        return response({
          intent: 'question',
          text: `${describeClause(handoff)} This goes to a human dispatcher. I am a rule-based assistant with ${LLM_CALLS} LLM calls; I do not decide money or contract questions.`,
        });
      }
      return helpReply();
    }

    /** Handle one user message and return a structured, template-based reply. */
    function handle(message) {
      const text = String(message == null ? '' : message).trim();
      if (!text) {
        return response({
          intent: 'question',
          status: 'error',
          text: 'Type a request, for example "Cancel B-1001" or "Is a lens available 2026-12-05 to 2026-12-07?".',
        });
      }

      if (pending) {
        if (isYes(text)) {
          return pending.type === 'cancel' ? finishCancel() : finishAvailability();
        }
        if (isNo(text)) {
          pending = null;
          return response({
            intent: 'confirmation',
            text: 'Stopped. Nothing was changed and no tool was called.',
          });
        }
        // A new request replaces the pending one; nothing is acted on without "yes".
        pending = null;
      }

      const intent = parseIntent(text);
      if (intent === 'cancel') return askCancel(text);
      if (intent === 'availability') return askAvailability(text);
      return answerQuestion(text);
    }

    function reset() {
      pending = null;
    }

    return { handle, reset };
  }

  const api = {
    LLM_CALLS,
    HANDOFF_SENTENCE,
    parseIntent,
    parseDates,
    parseKind,
    parseMount,
    createAssistant,
  };

  if (typeof module !== 'undefined') {
    module.exports = api;
  } else {
    globalThis.RentalAssistant = api;
  }
})();
