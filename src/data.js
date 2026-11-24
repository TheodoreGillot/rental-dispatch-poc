/*
 * Fictional mock data for the "Atelier Lumière (fictional)" dispatch demo.
 * Nothing here describes a real person, company, client or contract.
 * Dates are ISO strings (YYYY-MM-DD); booking and request ranges are inclusive.
 *
 * Loaded as a classic script so it also works from file://. Node tests read it
 * through module.exports; the browser reads it from globalThis.RentalData.
 */
(function () {
  'use strict';

  const house = 'Atelier Lumière (fictional)';

  function item(id, kind, mount, label) {
    return { id, kind, mount, label, status: 'ok' };
  }

  // mount null = mount-free kit (lights, audio, studio slots) that fits any request.
  const resources = [
    item('CAM-Z-01', 'camera', 'Z', 'Mirrorless body 01 (fictional)'),
    item('CAM-Z-02', 'camera', 'Z', 'Mirrorless body 02 (fictional)'),
    item('CAM-Z-03', 'camera', 'Z', 'Mirrorless body 03 (fictional)'),
    { ...item('CAM-Z-BK', 'camera', 'Z', 'Backup body (fictional)'), status: 'maintenance', maintenanceUntil: '2026-12-20' },
    item('CAM-EF-01', 'camera', 'EF', 'DSLR body, EF mount (fictional)'),
    item('LENS-Z-24', 'lens', 'Z', '24 mm lens (fictional)'),
    item('LENS-Z-50', 'lens', 'Z', '50 mm lens (fictional)'),
    item('LENS-Z-85', 'lens', 'Z', '85 mm lens (fictional)'),
    item('LENS-EF-35', 'lens', 'EF', '35 mm lens, EF mount (fictional)'),
    item('LIGHT-01', 'light', null, 'LED panel 01 (fictional)'),
    item('LIGHT-02', 'light', null, 'LED panel 02 (fictional)'),
    item('LIGHT-03', 'light', null, 'LED panel 03 (fictional)'),
    item('AUDIO-01', 'audio', null, 'Wireless microphone set (fictional)'),
    item('AUDIO-02', 'audio', null, 'Recorder kit (fictional)'),
    item('STUDIO-A', 'studio', null, 'Studio North slot (fictional)'),
    item('STUDIO-B', 'studio', null, 'Studio South slot (fictional)'),
  ];

  function booking(id, client, start, end, mount, assigned) {
    return { id, client, start, end, mount, status: 'confirmed', assigned };
  }

  // Active bookings. No item is double-booked once the buffer is applied (tested).
  const bookings = [
    booking('B-1001', 'Client A (fictional)', '2026-12-02', '2026-12-04', 'Z',
      ['CAM-Z-01', 'LENS-Z-24', 'LENS-Z-50', 'LIGHT-01', 'LIGHT-02', 'STUDIO-A']),
    booking('B-1002', 'Client B (fictional)', '2026-12-10', '2026-12-11', 'Z',
      ['CAM-Z-02', 'LENS-Z-85', 'LIGHT-03', 'AUDIO-01']),
    booking('B-1003', 'Client C (fictional)', '2026-12-18', '2026-12-19', 'Z',
      ['CAM-Z-03', 'LIGHT-01', 'STUDIO-B']),
    booking('B-1004', 'Client D (fictional)', '2026-12-17', '2026-12-20', 'Z', ['CAM-Z-01']),
    booking('B-1005', 'Client E (fictional)', '2026-12-17', '2026-12-20', 'Z', ['CAM-Z-02']),
  ];

  function request(id, client, start, end, mount, needs) {
    return { id, client, start, end, mount, needs };
  }

  const need = (kind, count) => ({ kind, count });

  // Waitlist in priority order. Each scenario picks its own subset.
  const waitlist = [
    request('W-2001', 'Client F (fictional)', '2026-12-02', '2026-12-04', 'Z',
      [need('camera', 1), need('lens', 2), need('light', 2), need('studio', 1)]),
    request('W-2002', 'Client G (fictional)', '2026-12-10', '2026-12-12', 'Z',
      [need('camera', 1), need('lens', 1), need('light', 1), need('audio', 1)]),
    request('W-2003', 'Client H (fictional)', '2026-12-18', '2026-12-19', 'Z',
      [need('camera', 2), need('lens', 1)]),
  ];

  // Fictional clauses. The rule check in solver.js routes questions about these topics to a human.
  const clauses = {
    'CL-4.2': {
      title: 'Deposit refunds',
      text: 'Deposits are refunded within 14 days of cancellation, less documented damage. Refund amounts are decided by the house manager (fictional clause).',
    },
    'CL-5.1': {
      title: 'Cancellation fees',
      text: 'Cancellations made fewer than 14 days before pickup may incur a fee of 25 percent of the rental value (fictional clause).',
    },
    'CL-9.1': {
      title: 'Contract questions',
      text: 'Questions about liability, terms or amendments are referred to the house manager (fictional clause).',
    },
  };

  const scenarios = [
    {
      id: 'happy-path',
      title: '1. Happy path: 3-day package cancelled',
      summary: 'Client A cancels a 3-day package. Client F on the waitlist needs the same kit and studio for the same dates.',
      cancellation: { bookingId: 'B-1001', question: '' },
      waitlistIds: ['W-2001'],
    },
    {
      id: 'jury-kit-mix',
      title: '2. Jury input: a different kit mix',
      summary: 'Client B cancels a camera body, a lens, a light and an audio kit. Untick LENS-Z-85 before solving to hold that lens back; the solver then offers LENS-Z-24 from free stock in its place.',
      cancellation: { bookingId: 'B-1002', question: '' },
      waitlistIds: ['W-2002'],
    },
    {
      id: 'backup-and-refund',
      title: '3. Edge case: backup body in maintenance, refund question',
      summary: 'Client C cancels and asks about the deposit. The waitlisted client needs two bodies and a lens. Only CAM-Z-03 is released; CAM-Z-01 and CAM-Z-02 are booked by B-1004 and B-1005 (2026-12-17 to 2026-12-20), CAM-EF-01 is the wrong mount, and the backup CAM-Z-BK is in maintenance until 2026-12-20. The best plan is partial: CAM-Z-03 and LENS-Z-24 from free stock, 2 of 3 items.',
      cancellation: { bookingId: 'B-1003', question: 'Can I get a refund of my deposit after cancelling?' },
      waitlistIds: ['W-2003'],
    },
  ];

  const exported = { house, resources, bookings, waitlist, clauses, scenarios };

  if (typeof module !== 'undefined') {
    module.exports = exported;
  } else {
    globalThis.RentalData = exported;
  }
})();
