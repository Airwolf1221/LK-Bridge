/**
 * v3 F3c (ADR 0051 decision 1): the chronology tools under the owner's rule. A chronology row counts when its date or
 * description cell changes (a row added or removed changes both); punctuation alone does not. The chronology plan
 * attaches each row's cells to its table write, so the rule is decided when the change is planned.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { londonDate } from '../../src/jobs/internal-steps.js';
import { PROJECT } from '../tools/helpers.js';
import { SidebarModel } from '../resources/world.js';
import { C, chronologyWorld, type ChronologyWorld } from '../chronology/world.js';

let w: ChronologyWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const OLD = '2026-11-01';
const lmr = () => w.sidebars.rows(C.resource).find((r) => r.key === 'Last Major Revision')!.text;
const setLmr = (text: string) => {
  const row = w.sidebars.pages.get(C.resource)!.props[0]!.rows!.find((r) => r.key === 'Last Major Revision')!;
  row.content = [{ text }];
};

beforeAll(async () => {
  w = await chronologyWorld({
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
  });
  client = await w.stack.connect();
  // The chronology page with a Last Major Revision row, in LegendKeeper and as the tree knows it.
  w.sidebars.page(C.resource, [
    SidebarModel.kv('kvchron1', 'PROPERTIES', [
      ['Reference Type', 'General Source'],
      ['Status', 'Authoritative'],
      ['Continuity Type', 'CANON'],
      ['Last Major Revision', OLD],
    ]),
  ]);
  w.stack.db.prepare('UPDATE tree_nodes SET sidebar = ? WHERE project_id = ? AND id = ?').run(
    JSON.stringify([
      {
        id: 'kvchron1',
        kind: 'keyValue',
        title: 'PROPERTIES',
        rows: [
          { key: 'Status', text: 'Authoritative' },
          { key: 'Last Major Revision', text: OLD },
        ],
      },
    ]),
    PROJECT,
    C.resource,
  );
});
afterAll(async () => w.close());
beforeEach(() => setLmr(OLD));

const FALL = { date: 'Kumikas 3rd, 4A 881', description: 'Ashgate falls to the Isar host' };

describe('chronology rows', () => {
  it('a description changed only in its punctuation: not set', async () => {
    const r = await call('update_timeline_event', {
      event: FALL,
      description: 'Ashgate falls to the Isar host.',
    });
    expect(r.body.status, r.text).toBe('written');
    expect(lmr()).toBe(OLD);
    expect(r.body.lastMajorRevision).toBe(
      'Last Major Revision skipped: a chronology row: only punctuation, dashes, whitespace or capitalisation changed, not a major revision',
    );
  });

  it('a description changed by one real word: set (a chronology row needs no 8 words)', async () => {
    const r = await call('update_timeline_event', {
      event: { ...FALL, description: 'Ashgate falls to the Isar host.' },
      description: 'Ashgate falls to the Menkhet host.',
    });
    expect(r.body.status, r.text).toBe('written');
    expect(lmr()).toBe(londonDate(Date.now()));
    expect(r.body.lastMajorRevision).toContain('(auto: a chronology row’s description changed)');
  });

  it('a row added: set', async () => {
    const r = await call('create_timeline_event', {
      date: 'Isar 5th, 4A 882',
      name: 'Gates reopened',
      description: 'The gates of Ashgate are reopened',
    });
    expect(r.body.status, r.text).toBe('written');
    expect(lmr()).toBe(londonDate(Date.now()));
    expect(r.body.lastMajorRevision).toContain('(auto: a chronology row added)');
  });

  it('a row added with lastMajorRevision "skip": not set', async () => {
    const r = await call('create_timeline_event', {
      date: 'Isar 6th, 4A 882',
      name: 'Gates guarded',
      description: 'The gates of Ashgate are guarded',
      lastMajorRevision: 'skip',
    });
    expect(r.body.status, r.text).toBe('written');
    expect(lmr()).toBe(OLD);
  });
});
