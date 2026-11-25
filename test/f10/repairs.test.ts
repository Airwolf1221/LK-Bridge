/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest's asymmetric matchers (expect.any, expect.stringMatching) are typed any */
/**
 * v3 F10 (ADR 0078, C2): the four deterministic repairs, end to end through the real stack against the mock chronology
 * (each finding made "in the app", the check run, the fix proposed through the chronology's "Propose a fix", the
 * proposal approved, the check run again):
 *
 * - the KCY from the calendar engine for a complete date; a partial date's has no fix (`KCY_NOT_DETERMINED`);
 * - the event's link set to its age's table;
 * - the rows moved into calendar order only when the order is strict; a partial date that could fall either side stays
 *   a judgement (`ORDER_NOT_STRICT`);
 * - the date and KCY rewritten in the confirmed style;
 * - every proposal shows the before and after text per cell (or the order), F7.1a's text-change display.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatKcy } from '../../src/calendar/index.js';
import { CAL } from '../chronology/world.js';
import {
  approve,
  cellText,
  check,
  f10World,
  FOURTH,
  moveRowInApp,
  PROJECT,
  rowByDate,
  setCellInApp,
  tableRows,
  type F10World,
} from './world.js';

type Obj = Record<string, unknown>;
let w: F10World;
const chronology = () => w.stack.runtime.chronology;
const proposal = (id: string) => w.stack.runtime.policy.proposals.get(id)!;
const textChangesOf = (id: string): Obj[] => {
  const ops = (w.stack.runtime.policy.proposals.detail(id)?.operations ?? []) as Obj[];
  return ops.flatMap((o) => (Array.isArray(o.textChanges) ? (o.textChanges as Obj[]) : []));
};
const findingsOf = async (kind: string) => (await check(w)).findings.filter((f) => f.kind === kind);

beforeAll(async () => {
  w = await f10World();
}, 120_000);
afterAll(async () => w.close());

describe('the KCY fix (wrong_kcy)', () => {
  it('a complete date: the KCY cell set to the engine’s value, before and after shown; the check then finds nothing', async () => {
    const row = rowByDate(w, FOURTH, 'Azah 18th, 4A 1');
    const right = cellText(row, 2);
    const date = CAL.parser.parse('Azah 18th, 4A 1');
    const want = formatKcy(date.kcy, chronology().config(PROJECT).style.kcy);
    expect(right).toBe(want);
    const wrong = formatKcy({ start: date.kcy.start + 1, end: null }, chronology().config(PROJECT).style.kcy);
    setCellInApp(w, FOURTH, row, 2, wrong);
    const [f] = await findingsOf('wrong_kcy');
    expect(f).toBeDefined();
    const r = await chronology().proposeFix('owner', PROJECT, {
      kind: 'kcy',
      age: FOURTH,
      rowId: String(f!.detail!.rowId),
    });
    expect(r).toMatchObject({ status: 'proposal_captured' });
    const id = (r as { proposalId: string }).proposalId;
    expect(proposal(id).summary).toContain(`KCY “${wrong}” → “${want}”`);
    expect(textChangesOf(id)).toEqual([
      expect.objectContaining({ what: `${FOURTH} KCY cell`, before: wrong, after: want }),
    ]);
    const done = await approve(w, id);
    expect(done.state).toBe('executed');
    expect(cellText(rowByDate(w, FOURTH, 'Azah 18th, 4A 1'), 2)).toBe(want);
    expect(await findingsOf('wrong_kcy')).toEqual([]);
  });

  it('a partial date (a year alone): no fix, nothing proposed', async () => {
    const row = rowByDate(w, FOURTH, 'Unknown, 4A 101');
    const before = cellText(row, 2);
    const date = CAL.parser.parse('Unknown, 4A 101');
    setCellInApp(
      w,
      FOURTH,
      row,
      2,
      formatKcy({ start: date.kcy.start + 3, end: null }, chronology().config(PROJECT).style.kcy),
    );
    const [f] = await findingsOf('wrong_kcy');
    expect(f).toBeDefined();
    const open = w.stack.runtime.policy.proposals.list({ project: PROJECT, state: 'pending' }).length;
    await expect(
      chronology().proposeFix('owner', PROJECT, {
        kind: 'kcy',
        age: FOURTH,
        rowId: String(f!.detail!.rowId),
      }),
    ).rejects.toMatchObject({ code: 'KCY_NOT_DETERMINED' });
    expect(w.stack.runtime.policy.proposals.list({ project: PROJECT, state: 'pending' })).toHaveLength(open);
    setCellInApp(w, FOURTH, row, 2, before);
  });
});

describe('the link fix (wrong_uri)', () => {
  it('the event’s link set to its age’s table', async () => {
    const tl = w.ages[FOURTH]!.timeline;
    const ev = w.liveEvents(tl).find((e) => e.name === 'The Week of Lanterns')!;
    ev.uri = '';
    const [f] = await findingsOf('wrong_uri');
    expect(f).toMatchObject({ detail: { eventId: ev.id } });
    const r = await chronology().proposeFix('owner', PROJECT, {
      kind: 'uri',
      age: FOURTH,
      eventId: String(ev.id),
    });
    const id = (r as { proposalId: string }).proposalId;
    const want = `lk://resources/${chronology().config(PROJECT).resourceId!}/docs/${w.ages[FOURTH]!.table}`;
    expect(textChangesOf(id)).toEqual([expect.objectContaining({ before: '(none)', after: want })]);
    expect((await approve(w, id)).state).toBe('executed');
    expect(w.liveEvents(tl).find((e) => e.id === ev.id)!.uri).toBe(want);
    expect(await findingsOf('wrong_uri')).toEqual([]);
  });
});

describe('the order fix (row_out_of_order)', () => {
  it('strict: the fewest rows moved into calendar order, the order before and after shown, verified', async () => {
    const dates = () => tableRows(w, FOURTH).map((r) => cellText(r, 1));
    const sorted = dates();
    moveRowInApp(w, FOURTH, 0, 5); // “Azah 18th, 4A 1” dropped below the 4A 424 row
    expect(dates()).not.toEqual(sorted);
    expect((await findingsOf('row_out_of_order')).length).toBeGreaterThan(0);
    const r = await chronology().proposeFix('owner', PROJECT, { kind: 'order', age: FOURTH });
    const id = (r as { proposalId: string }).proposalId;
    expect(proposal(id).summary).toMatch(/1 row moved into calendar order \(“Azah 18th, 4A 1”\)/);
    const [tc] = textChangesOf(id);
    expect(tc).toMatchObject({ what: `${FOURTH} row order` });
    expect(String(tc!.after).indexOf('Azah 18th, 4A 1')).toBeLessThan(String(tc!.after).indexOf('4A 424'));
    expect((await approve(w, id)).state).toBe('executed');
    expect(dates()).toEqual(sorted);
    expect(await findingsOf('row_out_of_order')).toEqual([]);
  });

  it('a partial date that could fall either side: no fix, it stays a judgement', async () => {
    const dates = () => tableRows(w, FOURTH).map((r) => cellText(r, 1));
    const sorted = dates();
    const year = sorted.indexOf('4A 881');
    const day = sorted.indexOf('Kumikas 3rd, 4A 881');
    moveRowInApp(w, FOURTH, year, day); // the year alone above a day of the same year
    expect((await findingsOf('row_out_of_order')).length).toBeGreaterThan(0);
    await expect(
      chronology().proposeFix('owner', PROJECT, { kind: 'order', age: FOURTH }),
    ).rejects.toMatchObject({
      code: 'ORDER_NOT_STRICT',
      message: expect.stringMatching(/could fall either way|tie/),
    });
    moveRowInApp(w, FOURTH, day, year);
    expect(dates()).toEqual(sorted);
  });
});

describe('the style fix (date_text_differs)', () => {
  it('a right KCY written without its separators is rewritten in the confirmed style', async () => {
    const row = rowByDate(w, FOURTH, 'Kumikas 3rd, 4A 881');
    const want = cellText(row, 2);
    const bare = want.replace(/,/g, '');
    expect(bare).not.toBe(want);
    setCellInApp(w, FOURTH, row, 2, bare);
    const [f] = await findingsOf('date_text_differs');
    expect(f).toBeDefined();
    const r = await chronology().proposeFix('owner', PROJECT, {
      kind: 'style',
      age: FOURTH,
      rowId: String(f!.detail!.rowId),
    });
    const id = (r as { proposalId: string }).proposalId;
    expect(textChangesOf(id)).toEqual([expect.objectContaining({ before: bare, after: want })]);
    expect((await approve(w, id)).state).toBe('executed');
    expect(cellText(rowByDate(w, FOURTH, 'Kumikas 3rd, 4A 881'), 2)).toBe(want);
    expect(await findingsOf('date_text_differs')).toEqual([]);
  });
});
