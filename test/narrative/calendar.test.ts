/* eslint-disable @typescript-eslint/no-unsafe-member-access -- tool results are JSON */
/**
 * ADR 0064 amendment 2 and ADR 0065 amendment 1 (v3 F4.1): the calendar on demand. The owner's `narrative-f4c` sandbox
 * failed at N3 (`arkona_chapter_save` refused CALENDAR_UNAVAILABLE) although the bridge had the test world's calendar
 * cached: the sandbox runtime's copied state lacked the kept calendar (test/review/rehearsal-dryrun.test.ts pins the
 * copy now). Every tool that reads dates now loads the chronology's calendar itself when it is not kept (one read, the
 * loader `calendar_date` uses):
 *
 * - a COLD cache: the first save loads the calendar (one `listCalendars`) and succeeds; the next makes no such read;
 * - a calendar that truly cannot be read is still refused with the existing message (and why it could not be read);
 * - `arkona_as_of`, `arkona_as_of_coverage`, `arkona_chapter_check` and `calendar_date` share the loader.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
import { narrativeWorld, PROJECT, type NarrativeWorld } from './world.js';

const ORACLE = JSON.parse(
  readFileSync(new URL('../fixtures/calendar/oracle.json', import.meta.url), 'utf8'),
) as { calendar: Record<string, unknown> };

let w: NarrativeWorld;
/** What the mock answers to listCalendars (the oracle's calendar, or none). */
let calendars: Record<string, unknown>[] = [ORACLE.calendar];
/** The listCalendars requests the mock answered. */
let listed = 0;
beforeAll(async () => {
  w = await narrativeWorld();
  w.overrides.set(/\/calendars$/, (req: MockRequest): MockResponse | undefined =>
    req.method === 'GET'
      ? (listed++, { status: 200, body: { data: calendars, hasMore: false, nextCursor: null } })
      : undefined,
  );
  await w.snapshot();
}, 180_000);
afterAll(async () => {
  await w?.close();
});

/** Forgets the kept calendar, as a fresh runtime (or the owner's sandbox copy before F4.1) has none. */
const cold = () => w.stack.db.prepare('DELETE FROM chronology_calendars WHERE project_id = ?').run(PROJECT);
const listCalendarsCalls = () => listed;

const save = (n: number, extra: Record<string, unknown> = {}) => ({
  story: 'Cold Calendar',
  number: n,
  title: `Night ${n}`,
  inWorldDate: 'Camue 3rd, 4A 400',
  pov: 'Leila Darvish',
  charactersPresent: ['Leila Darvish'],
  locations: [],
  draftStatus: 'Draft',
  markdown: 'Leila crossed the harbour at dusk.',
  ...extra,
});

describe('the calendar on demand (the narrative tools)', () => {
  it('a cold cache: the first save loads the calendar (one read) and succeeds; the next reads it from the cache', async () => {
    expect(
      (await w.tool('arkona_story_create', { continuity: 'Main CANON', title: 'Cold Calendar' })).status,
    ).toBe('written');
    for (const n of [1, 2])
      expect(
        (await w.tool('arkona_chapter_plan', { story: 'Cold Calendar', number: n, questionGate: 'closed' }))
          .status,
      ).toBe('written');
    cold();
    expect(w.stack.runtime.chronology.calendar(PROJECT)).toBeNull();
    const before = listCalendarsCalls();
    const b = await w.tool('arkona_chapter_save', save(1));
    expect(b.status, JSON.stringify(b)).toBe('written');
    expect(listCalendarsCalls() - before).toBe(1);
    expect(w.stack.runtime.chronology.calendar(PROJECT)).not.toBeNull();
    const again = await w.tool('arkona_chapter_save', save(2));
    expect(again.status, JSON.stringify(again)).toBe('written');
    expect(listCalendarsCalls() - before).toBe(1);
  });

  it('a calendar that truly cannot be read is still refused with the existing message, and says why', async () => {
    cold();
    calendars = [];
    try {
      const b = await w.tool('arkona_chapter_save', save(3, { title: 'Never' }));
      expect(b.error).toMatchObject({
        code: 'CALENDAR_UNAVAILABLE',
        message:
          'The chronology’s calendar is not available to the bridge yet (the chronology tools read and keep it), so no date can be read; nothing was written.',
      });
      expect(b.error.loading).toMatch(/No calendar is named or numbered/);
    } finally {
      calendars = [ORACLE.calendar];
    }
  });

  it('arkona_chapter_check loads it too (cold), and checks as of the date', async () => {
    cold();
    const b = await w.tool('arkona_chapter_check', { story: 'Cold Calendar', number: 1 });
    expect(JSON.stringify(b.notes ?? [])).not.toMatch(/cannot be read: nothing was checked/);
    expect(w.stack.runtime.chronology.calendar(PROJECT)).not.toBeNull();
  });
});

describe('the calendar on demand (as of a date, coverage, calendar_date)', () => {
  it('arkona_as_of with a cold cache loads it (one read) and reads the dates', async () => {
    cold();
    const before = listCalendarsCalls();
    const b = await w.tool('arkona_as_of', { characters: ['Yasmin al-Naim'], date: '4A 120' });
    expect(b.characters[0].born).toMatchObject({ value: 'Camue 1st, 4A 100' });
    expect(listCalendarsCalls() - before).toBe(1);
  });

  it('arkona_as_of_coverage with a cold cache loads it, and with none readable says why', async () => {
    cold();
    const ok = await w.tool('arkona_as_of_coverage', {});
    expect(ok.counts.readableBirth).toBeGreaterThan(0);
    cold();
    calendars = [];
    try {
      const none = await w.tool('arkona_as_of_coverage', {});
      expect(none.counts.readableBirth).toBe(0);
      expect(JSON.stringify(none.couldNotCheck)).toMatch(/reading it now failed: No calendar is named/);
    } finally {
      calendars = [ORACLE.calendar];
    }
  });

  it('calendar_date shares the loader: cached, else read now', async () => {
    cold();
    const first = await w.tool('calendar_date', { date: 'Camue 1st, 4A 100' });
    expect(first.calendar.source).toBe('read now');
    const second = await w.tool('calendar_date', { date: 'Camue 1st, 4A 100' });
    expect(second.calendar.source).toBe('cached');
  });
});
