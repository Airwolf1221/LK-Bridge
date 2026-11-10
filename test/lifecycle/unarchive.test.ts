/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * unarchive_page (v2 C2c, ADR 0035): both previous states from the lifecycle record; the note removed only when
 * unchanged, kept and flagged when edited; an edited Scope flagged (the recorded original restored); a missing previous
 * parent needs `destination`; a page archived by hand needs the values supplied, and says exactly what is missing.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isoDate } from '../../src/lifecycle/index.js';
import { PROJECT } from '../tools/helpers.js';
import { childNames, facts } from '../resources/world.js';
import { accept, L, LIFECYCLE, lifecycleWorld, textOf, type LifecycleWorld } from './world.js';

let w: LifecycleWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const today = isoDate(Date.now());
const archive = async (page: string) => {
  const r = await accept(w, await call('archive_page', { page }));
  expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
};
const rowId = (page: string, key: string) =>
  w.sidebars.pages.get(page)!.props[0]!.rows!.find((r) => r.key === key)!.id;

beforeAll(async () => {
  w = await lifecycleWorld();
  client = await w.stack.connect();
  await archive('Old Harbour');
  await archive('Sky Ferry');
});
afterAll(async () => w.close());

describe('unarchive_page from the record', () => {
  it('a formerly Authoritative page: back under its parent as [BSRC], values restored, CANON, the note removed', async () => {
    const r = await call('unarchive_page', { page: 'Old Harbour' });
    expect(r.body, r.text).toMatchObject({
      status: 'proposal_captured',
      requiresCanonicalApproval: true,
      newName: '[BSRC] Old Harbour',
      newParent: { id: 'locs0001' },
      note: { action: 'remove' },
    });
    const done = await accept(w, r);
    expect(done.body, done.text).toMatchObject({ status: 'written', verified: true });
    const p = w.repo.live(L.harbour)!;
    expect(p).toMatchObject({ name: '[BSRC] Old Harbour', parentId: 'locs0001' });
    expect(p.tags).toEqual(['port', 'CANON']);
    expect(facts(w, L.harbour)).toEqual([
      'Reference Type=General Source',
      'Status=Authoritative',
      'Continuity Type=CANON',
      'Scope=A harbour town on the Weeping Sea',
      'Temporal Scope=Fourth Age',
      `Last Major Revision=${today}`,
    ]);
    expect(w.blocks(w.main(L.harbour)).map((b) => b.id)).toEqual(['hb1', 'hb2', 'hb3']);
    // Placed alphabetically among Locations' pages.
    expect(childNames(w, 'locs0001').filter((n) => !n.startsWith('[INDEX]'))).toEqual([
      '[BSRC] Harbour Guild',
      '[BSRC] Old Harbour',
      '[BSRC] Tide Tables',
    ]);
    expect(w.stack.runtime.lifecycle.store.latest(PROJECT, L.harbour, ['unarchive'])).toMatchObject({
      state: 'complete',
      previousState: 'archived',
    });
  });

  it('a formerly Working page: back under [INDEX] Working as [BWRK], Status Working, tag Working; an edited note is kept and flagged; an edited Scope is flagged', async () => {
    // After archiving, someone edits the note and the Scope.
    const doc = w.main(L.ferry);
    const note = w.blocks(doc)[0]!;
    (note.content as { text: string }[])[0]!.text = 'Archived, but we may bring it back.';
    const sb = w.sidebars.pages.get(L.ferry)!;
    sb.props[0]!.rows!.find((r) => r.key === 'Scope')!.content = [{ text: 'A cloud ferry, retired' }];
    void rowId;
    const r = await call('unarchive_page', { page: 'Sky Ferry' });
    expect(r.body, r.text).toMatchObject({ status: 'proposal_captured', newName: '[BWRK] Sky Ferry' });
    expect(r.body.newParent.id).toBe(LIFECYCLE.working);
    expect(r.body.note).toBeUndefined();
    expect(r.body.flags.join(' ')).toMatch(/edited after archiving, so it is KEPT/);
    expect(r.body.flags.join(' ')).toMatch(
      /Scope was edited after archiving \(it is “A cloud ferry, retired”\)/,
    );
    const done = await accept(w, r);
    expect(done.body, done.text).toMatchObject({ status: 'written', verified: true });
    const p = w.repo.live(L.ferry)!;
    expect(p).toMatchObject({ name: '[BWRK] Sky Ferry', parentId: LIFECYCLE.working });
    expect(p.tags).toEqual(['Working']);
    expect(facts(w, L.ferry)).toEqual([
      'Reference Type=General Source',
      'Status=Working',
      'Continuity Type=',
      'Scope=A flying ferry',
      'Temporal Scope=',
      `Last Major Revision=${today}`,
    ]);
    expect(textOf(w.blocks(doc)[0])).toBe('Archived, but we may bring it back.');
  });
});

describe('unarchive_page without a usable record', () => {
  it('a previous parent that is gone needs destination', async () => {
    await archive('Tide Tables');
    // Its previous parent, Locations, is deleted outside the bridge … simulated by recording another parent.
    const rec = w.stack.runtime.lifecycle.store.latest(PROJECT, L.tides, ['archive'])!;
    w.stack.db
      .prepare('UPDATE lifecycle_records SET previous_parent_id = ? WHERE id = ?')
      .run('gone0001', rec.id);
    const r = await call('unarchive_page', { page: 'Tide Tables' });
    expect(r.body.error, r.text).toMatchObject({ code: 'DESTINATION_REQUIRED' });
    const ok = await call('unarchive_page', { page: 'Tide Tables', destination: 'Kumikas', dryRun: true });
    expect(ok.body, ok.text).toMatchObject({ status: 'dry_run', newParent: { id: 'kumi_idx' } });
  });

  it('a page archived by hand needs destination, previousState and the values, and says what is missing', async () => {
    w.repo.seed({
      id: 'handarc1',
      name: '[BARC] Old Lighthouse',
      parentId: LIFECYCLE.archived,
      tags: ['Archived'],
    });
    w.sidebars.page('handarc1', [
      {
        id: 'kvhand01',
        kind: 'keyValue',
        title: 'PROPERTIES',
        rows: [
          { id: 'hrow1', rank: 'a', key: 'Status', content: [{ text: 'Archived' }] },
          {
            id: 'hrow2',
            rank: 'b',
            key: 'Scope',
            content: [{ text: 'Archived record of the retired A lighthouse' }],
          },
        ],
      } as never,
    ]);
    w.stack.runtime.tree.store.applyObservation(
      {
        projectId: PROJECT,
        rootId: 'airepo01',
        settings: w.stack.runtime.tree.settings(PROJECT),
        by: 'write',
      },
      {
        id: 'handarc1',
        name: '[BARC] Old Lighthouse',
        parentId: LIFECYCLE.archived,
        rank: w.repo.res.get('handarc1')!.rank,
        tags: ['Archived'],
        aliases: [],
        documents: [],
        isHidden: false,
      },
      Date.now() * 1000,
    );
    w.stack.runtime.tree.store.recomputePaths(PROJECT, 'airepo01');
    const bare = await call('unarchive_page', { page: 'Old Lighthouse' });
    expect(bare.body.error).toMatchObject({ code: 'NO_LIFECYCLE_RECORD' });
    expect(bare.body.error.missing).toEqual([
      'previousState',
      'restore (continuityType, scope, temporalScope)',
      'destination',
    ]);
    const half = await call('unarchive_page', { page: 'Old Lighthouse', previousState: 'working' });
    expect(half.body.error.missing).toEqual(['restore (continuityType, scope, temporalScope)']);
    const full = await call('unarchive_page', {
      page: 'Old Lighthouse',
      previousState: 'authoritative',
      destination: 'Locations',
      restore: { continuityType: 'CANON', scope: 'A lighthouse', temporalScope: 'Fourth Age' },
    });
    expect(full.body, full.text).toMatchObject({
      status: 'proposal_captured',
      newName: '[BSRC] Old Lighthouse',
    });
    expect(full.body.flags.join(' ')).toMatch(/archived by hand/);
    const done = await accept(w, full);
    expect(done.body, done.text).toMatchObject({ status: 'written', verified: true });
    expect(facts(w, 'handarc1')).toEqual(
      expect.arrayContaining(['Status=Authoritative', 'Scope=A lighthouse', `Last Major Revision=${today}`]),
    );
  });
});
