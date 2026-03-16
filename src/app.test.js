import { parsePdfText, calculateSchedule, firstInspiresPdfUrl } from './app.js';

// Helper to build a PDF.js-style text item at the given Y coordinate.
function makeItem(str, y) {
  return { str, transform: [1, 0, 0, 1, 0, y] };
}

// ── parsePdfText ───────────────────────────────────────────────────────────

describe('parsePdfText', () => {
  test('returns 0 when there are no qual rows', () => {
    const items = [
      makeItem('Opening Ceremony', 700),
      makeItem('9:00 AM', 700),
      makeItem('10:00 AM', 700),
    ];
    expect(parsePdfText(items)).toBe(0);
  });

  test('parses a single qual row with start and end times', () => {
    // 9:00 AM – 12:35 PM = 215 min
    const items = [
      makeItem('Qualification Matches', 700),
      makeItem('9:00 AM', 700),
      makeItem('12:35 PM', 700),
    ];
    expect(parsePdfText(items)).toBe(215);
  });

  test('sums three qual rows on the same page correctly (665 min total)', () => {
    // Simulates the 2026 NYSU scenario with 3 qual sessions on a single page.
    // Session 1: 9:00 AM – 12:35 PM = 215 min  (Y=700)
    // Session 2: 1:30 PM – 5:45 PM  = 255 min  (Y=500)
    // Session 3: 8:30 AM – 11:45 AM = 195 min  (Y=300) — e.g. day-2 block
    const items = [
      makeItem('Qualification Matches', 700),
      makeItem('9:00 AM', 700),
      makeItem('12:35 PM', 700),

      makeItem('Qualification Matches', 500),
      makeItem('1:30 PM', 500),
      makeItem('5:45 PM', 500),

      makeItem('Qualification Matches', 300),
      makeItem('8:30 AM', 300),
      makeItem('11:45 AM', 300),
    ];
    expect(parsePdfText(items)).toBe(665);
  });

  test('handles qual rows where label and times are on slightly different baselines', () => {
    // Label at Y=700, times at Y=698 (±2 rounding → same row after Math.round)
    const items = [
      makeItem('Qualification Matches', 700),
      makeItem('9:00 AM', 698),
      makeItem('12:35 PM', 698),
    ];
    // After rounding, Y=700 and Y=698 map to separate rows (700 and 698).
    // The label row (Y=700) therefore contains no parseable times on its own;
    // the adjacent-row fallback merges it with the times row (Y=698) to
    // recover the start and end times and compute the correct duration.
    const result = parsePdfText(items);
    expect(result).toBe(215);
  });

  test('does not double-count when qual label and times are on separate but adjacent rows', () => {
    // Label row has no times; times are on the very next row (non-qual).
    // 9:00 AM – 12:35 PM = 215 min
    const items = [
      makeItem('Qualification Matches', 600),   // label row, no times
      makeItem('9:00 AM', 590),                 // times row, no "qual"
      makeItem('12:35 PM', 590),
    ];
    expect(parsePdfText(items)).toBe(215);
  });

  test('returns 0 when qual row has no associated times anywhere nearby', () => {
    const items = [makeItem('Qualification Matches', 500)];
    expect(parsePdfText(items)).toBe(0);
  });
});

// ── Multi-page collision regression test ──────────────────────────────────

describe('parsePdfText multi-page collision (regression)', () => {
  /**
   * This test documents the bug that occurs when items from two PDF pages
   * are merged into a single flat array WITHOUT any Y-offset to separate them.
   *
   * In that case, items at the same Y on different pages collapse into one row,
   * causing the algorithm to compute a single wrong duration instead of the
   * correct two separate durations.
   *
   * The fix lives in parsePdfAgenda, which now calls parsePdfText once per
   * page rather than concatenating all pages into a single item array.
   * To exercise that the fix works at the parsePdfText level, tests above
   * use distinct Y values (as if offsets were applied).
   */
  test('produces wrong total when page-2 items share Y coords with page-1 items', () => {
    // Page 1: one qual session 9:00 AM – 12:35 PM = 215 min  at Y=700
    // Page 2: one qual session 8:30 AM – 11:45 AM = 195 min  at Y=700 (collision!)
    // Without any offset the two sets of times merge into one row.
    // min across all four times = 8:30 AM = 510 min
    // max across all four times = 12:35 PM = 755 min
    // wrong duration = 755 – 510 = 245  (≠ 215 + 195 = 410)
    const page1Items = [
      makeItem('Qualification Matches', 700),
      makeItem('9:00 AM', 700),
      makeItem('12:35 PM', 700),
    ];
    const page2Items = [
      makeItem('Qualification Matches', 700),
      makeItem('8:30 AM', 700),
      makeItem('11:45 AM', 700),
    ];
    const collided = parsePdfText([...page1Items, ...page2Items]);
    expect(collided).not.toBe(410); // demonstrates the bug when pages collide
  });

  test('produces correct total when page items have distinct Y coords (offset applied)', () => {
    // Same sessions as the test above, but page-2 items have a Y offset applied
    // (simulating what parsePdfAgenda now does).
    const page1Items = [
      makeItem('Qualification Matches', 700),
      makeItem('9:00 AM', 700),
      makeItem('12:35 PM', 700),
    ];
    // Page-2 items offset by -10000 so they cannot collide with page-1 items.
    const page2Items = [
      makeItem('Qualification Matches', 700 - 10000),
      makeItem('8:30 AM', 700 - 10000),
      makeItem('11:45 AM', 700 - 10000),
    ];
    expect(parsePdfText([...page1Items, ...page2Items])).toBe(410); // 215 + 195
  });
});

// ── calculateSchedule ─────────────────────────────────────────────────────

describe('calculateSchedule', () => {
  test('basic case with no surrogates', () => {
    // 30 teams × 10 matches = 300 plays; 300 % 6 = 0 → no surrogates
    const result = calculateSchedule({
      numTeams: 30,
      matchesPerTeam: 10,
      cycleTimeMin: 7,
      qualTimeMin: 350,
    });
    expect(result.surrogates).toBe(0);
    expect(result.totalMatches).toBe(50);
    expect(result.timeNeededMin).toBe(350);
    expect(result.fits).toBe(true);
    expect(result.deltaMin).toBe(0);
  });

  test('adds surrogates to reach a multiple of 6', () => {
    // 40 teams × 10 matches = 400 plays; 400 % 6 = 4 → surrogates = 2
    const result = calculateSchedule({
      numTeams: 40,
      matchesPerTeam: 10,
      cycleTimeMin: 7,
      qualTimeMin: 500,
    });
    expect(result.surrogates).toBe(2);
    expect(result.totalPlays).toBe(402);
    expect(result.totalMatches).toBe(67);
  });

  test('fits is false when time needed exceeds time available', () => {
    const result = calculateSchedule({
      numTeams: 60,
      matchesPerTeam: 12,
      cycleTimeMin: 8,
      qualTimeMin: 400,
    });
    expect(result.fits).toBe(false);
    expect(result.deltaMin).toBeLessThan(0);
  });
});

// ── firstInspiresPdfUrl ────────────────────────────────────────────────────

describe('firstInspiresPdfUrl', () => {
  test('builds the correct URL for 2026nysu', () => {
    expect(firstInspiresPdfUrl('2026nysu')).toBe(
      'https://info.firstinspires.org/hubfs/web/event/frc/2026/2026_NYSU_Agenda.pdf',
    );
  });

  test('uppercases the event code', () => {
    expect(firstInspiresPdfUrl('2024miket')).toBe(
      'https://info.firstinspires.org/hubfs/web/event/frc/2024/2024_MIKET_Agenda.pdf',
    );
  });

  test('throws for an invalid (too-short) event key', () => {
    expect(() => firstInspiresPdfUrl('abc')).toThrow();
  });
});
