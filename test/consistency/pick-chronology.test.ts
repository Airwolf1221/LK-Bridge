/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mock documents */
/**
 * v3 F4b (ADR 0064, D6): a pick that edits a chronology row goes through the F2 row tools (`update_timeline_event`'s own
 * plan), so the row's Date and KCY cells and its timeline event change together, in ONE job (v3 F12; a proposal before). Against the
 * chronology world (a confirmed Universal Chronology on the mock LegendKeeper, Arkona's own calendar).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatKcy, DEFAULT_KCY_STYLE } from '../../src/calendar/index.js';
import { PROJECT } from '../tools/helpers.js';
import { C, CAL, chronologyWorld, type ChronologyWorld } from '../chronology/world.js';

let w: ChronologyWorld;
const FOURTH = 'Fourth Arkonan Age';

beforeAll(async () => {
  w = await chronologyWorld({
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
}, 180_000);
afterAll(async () => {
  await w?.close();
});

/** The table row (block) whose cells read this date and description. */
function rowOf(date: string): any {
  const blocks = w.repo.blocks.get(w.ages[FOURTH]!.table)!.blocks as any[];
  const table = blocks.find((b) => b.kind === 'table');
  const text = (b: any): string =>
    [
      ...(b.content ?? []).map((r: any) => r.text ?? r.mention?.text ?? ''),
      ...(b.children ?? []).map(text),
    ].join(' ');
  return (table.children as any[]).find((r) => text(r).includes(date));
}

describe('a pick that edits a chronology row (D6)', () => {
  it('is ONE job (v3 F12) of one item, edited through the row tools: the Date, the KCY and the timeline event together', async () => {
    const row = rowOf('Azah 18th, 4A 1');
    expect(row).toBeDefined();
    const before = w.events(w.ages[FOURTH]!.timeline).find((e) => String(e.name).includes('Divine System'))!;
    const rt = w.stack.runtime;
    const r = await rt.consistency.propose({
      projectId: PROJECT,
      edits: [
        {
          kind: 'row',
          pageId: C.resource,
          pageName: '[BSRC] Universal Chronology',
          documentId: w.ages[FOURTH]!.table,
          rowId: row.id,
          from: 'Azah 18th, 4A 1',
          to: 'Azah 20th, 4A 1',
        },
      ],
      title: 'Pick the right value: a test row → Azah 20th, 4A 1',
      operation: { tool: 'arkona_consistency' },
    });
    expect(r.notPlanned).toEqual([]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.diff?.changes?.[0]).toMatchObject({
      before: 'Azah 18th, 4A 1',
      after: 'Azah 20th, 4A 1',
    });
    // v3 F12 (ADR 0081): the owner's confirmed pick runs at once as ONE job, no proposal.
    expect(r.proposalId).toBe('');
    expect(r.jobId).toEqual(expect.any(String));
    for (let i = 0; i < 500; i++) {
      const job = rt.engine.queries.getJob(PROJECT, r.jobId!);
      if (job && ['succeeded', 'failed', 'cancelled'].includes(job.status)) {
        expect(job.status, JSON.stringify(job.lastError ?? null)).toBe('succeeded');
        break;
      }
      await new Promise((res) => setTimeout(res, 20));
    }
    const date = CAL.parser.parse('Azah 20th, 4A 1');
    const kcy = formatKcy(date.kcy, DEFAULT_KCY_STYLE);
    expect(w.rows(FOURTH).find((x) => x.startsWith('Azah 20th, 4A 1'))).toMatch(
      new RegExp(`\\| ${kcy.replace(/,/g, ',')}$`),
    );
    const after = w.events(w.ages[FOURTH]!.timeline).find((e) => e.id === before.id)!;
    expect(after.start).toBe(date.start);
    expect(after.start).not.toBe(before.start);
  });
});
