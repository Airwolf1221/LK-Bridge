/**
 * R2-revert, attack (d): the wrong target after a rename.
 *
 * src/review/revert-plan.ts `planFactsTarget` reads the job's key-value property by its id and finds it exactly as the
 * job left it, but then plans the revert with set_facts' planner by the property's TITLE as it was at the job
 * (`propertyTitle: t.property.title`, the check's label; link collections likewise by `c.title`), and set_facts'
 * `findProperty` (src/facts/plan.ts) picks whatever property carries that title NOW. The owner renames the job's
 * PROPERTIES and gives another key-value property the title PROPERTIES (a new sheet, a template re-applied): the revert
 * writes the old values into the other property, which the job never touched, and reports success, leaving the job's
 * own property as the job left it.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { factsWorld, P, type FactsWorld } from '../../facts/world.js';
import { PROJECT, jobOf, revertAndWait, writeAgent } from './helpers.js';

let w: FactsWorld;
let agent: Client;

beforeAll(async () => {
  w = await factsWorld({
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  agent = (await writeAgent(w.stack, 'r2-rename-agent')).client;
});
afterAll(async () => w.close());

const rt = () => w.stack.runtime;
const prop = (id: string) => w.sidebars.pages.get(P.miyabi)!.props.find((p) => p.id === id)!;
const rowText = (id: string, key: string) =>
  (prop(id).rows!.find((r) => r.key === key)?.content ?? [])
    .map((c) => String((c as { text?: string }).text ?? ''))
    .join('');

describe('a renamed property', () => {
  it('the job’s PROPERTIES renamed and another property titled PROPERTIES: the revert must not write into the other one', async () => {
    const r = await w.stack.call(agent, 'set_facts', {
      project: 'test',
      page: P.miyabi,
      facts: { Notes: 'Set before the sheet was renamed' },
    });
    expect(r.body.status, r.text).toBe('written');
    const jobId = jobOf(r);
    await rt().engine.wait(PROJECT, jobId, 25_000);
    // In the app: the old sheet renamed, a new key-value property titled PROPERTIES added.
    w.sidebars.outside(P.miyabi, (sb) => {
      sb.props.find((p) => p.id === 'kvmiya01')!.title = 'PROPERTIES (old sheet)';
      sb.props.push({
        id: 'kvnewsh1',
        kind: 'keyValue',
        title: 'PROPERTIES',
        rank: 'z',
        rows: [
          { id: 'kvnewr01', rank: 'a', key: 'Notes', content: [{ text: 'The new sheet’s own notes' }] },
          { id: 'kvnewr02', rank: 'b', key: 'Scope', content: [{ text: 'The new sheet’s scope' }] },
        ],
      });
    });

    const { r: rv, job } = await revertAndWait(w.stack, jobId);
    expect(
      { newSheetNotes: rowText('kvnewsh1', 'Notes'), oldSheetNotes: rowText('kvmiya01', 'Notes') },
      `revert ${rv.status}, job ${job?.status ?? '-'}`,
    ).toEqual({
      newSheetNotes: 'The new sheet’s own notes', // never touched by the job: never written by its revert
      oldSheetNotes: rv.status === 'submitted' ? 'First notes' : 'Set before the sheet was renamed',
    });
  });
});
