/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- parsed JSON tool results */
/**
 * move_to_working and promote_page (v2 C2c, ADR 0035): move_to_working changes only the place, prefix, Status and tag
 * and remembers where the page was; promote_page needs a destination (suggesting the remembered one), sets Last Major
 * Revision, keeps a Continuity Type of CANON or AU and makes anything else CANON; promoting a Working character's Core
 * takes its index with it, other pages under the index keeping their state.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isoDate } from '../../src/lifecycle/index.js';
import { PROJECT } from '../tools/helpers.js';
import { childNames, facts, T } from '../resources/world.js';
import { L, LIFECYCLE, lifecycleWorld, type LifecycleWorld } from './world.js';

let w: LifecycleWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const today = isoDate(Date.now());

beforeAll(async () => {
  w = await lifecycleWorld();
  client = await w.stack.connect();
});
afterAll(async () => w.close());

describe('move_to_working, then promote_page back', () => {
  it('move_to_working: under [INDEX] Working as [BWRK], Status Working, CANON → Working, nothing else', async () => {
    const before = facts(w, L.harbour);
    // v3 F12 (ADR 0081): at scope write the lifecycle tools are direct.
    const done = await call('move_to_working', { page: 'Old Harbour' });
    expect(done.body, done.text).toMatchObject({
      status: 'written',
      verified: true,
      newName: '[BWRK] Old Harbour',
      newParent: { id: LIFECYCLE.working },
    });
    expect(done.body.relatedPages).toBeDefined();
    expect(w.repo.live(L.harbour)).toMatchObject({ name: '[BWRK] Old Harbour', parentId: LIFECYCLE.working });
    expect(w.repo.live(L.harbour)!.tags).toEqual(['port', 'Working']);
    // Only Status changed.
    expect(facts(w, L.harbour)).toEqual(before.map((f) => (f.startsWith('Status=') ? 'Status=Working' : f)));
    expect(w.stack.runtime.lifecycle.store.latest(PROJECT, L.harbour, ['move_to_working'])).toMatchObject({
      state: 'complete',
      previousParentId: 'locs0001',
    });
  });

  it('promote_page needs destination and suggests the remembered one, in the refusal and the dry run', async () => {
    const r = await call('promote_page', { page: 'Old Harbour' });
    expect(r.body.error).toMatchObject({
      code: 'DESTINATION_REQUIRED',
      suggestedDestination: { id: 'locs0001', name: '[INDEX] Locations' },
    });
    const dry = await call('promote_page', { page: 'Old Harbour', dryRun: true });
    expect(dry.body.error.suggestedDestination.id).toBe('locs0001');
    const elsewhere = await call('promote_page', {
      page: 'Old Harbour',
      destination: 'Kumikas',
      dryRun: true,
    });
    expect(elsewhere.body.flags.join(' ')).toMatch(/it was under \[INDEX\] Locations before move_to_working/);
  });

  it('promote_page: back as [BSRC], Status Authoritative, Last Major Revision today, Continuity Type CANON kept, Working → CANON', async () => {
    const done = await call('promote_page', { page: 'Old Harbour', destination: 'locs0001' });
    expect(done.body, done.text).toMatchObject({ status: 'written', verified: true });
    expect(w.repo.live(L.harbour)).toMatchObject({ name: '[BSRC] Old Harbour', parentId: 'locs0001' });
    expect(w.repo.live(L.harbour)!.tags).toEqual(['port', 'CANON']);
    expect(facts(w, L.harbour)).toEqual(
      expect.arrayContaining([
        'Status=Authoritative',
        'Continuity Type=CANON',
        `Last Major Revision=${today}`,
      ]),
    );
  });
});

describe('promote_page: the Continuity Type rules', () => {
  const make = async (name: string, ct: string) => {
    const r = await call('create_resource', {
      name,
      template: T.general,
      facts: ct === '' ? { Scope: name } : { Scope: name, 'Continuity Type': ct },
    });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    return r.body.pages[0].id as string;
  };
  it('CANON and AU are kept; NON-CURRENT and empty become CANON', async () => {
    const ids = {
      canon: await make('Ct Canon', 'CANON'),
      au: await make('Ct Au', 'AU'),
      nonCurrent: await make('Ct Non Current', 'NON-CURRENT'),
      empty: await make('Ct Empty', ''),
    };
    const ct = (id: string) => facts(w, id).find((f) => f.startsWith('Continuity Type='));
    for (const [k, id] of Object.entries(ids)) {
      const done = await call('promote_page', { page: id, destination: 'Kumikas' });
      expect(done.body, `${k}: ${done.text}`).toMatchObject({ status: 'written', verified: true });
    }
    expect(ct(ids.canon)).toBe('Continuity Type=CANON');
    expect(ct(ids.au)).toBe('Continuity Type=AU');
    expect(ct(ids.nonCurrent)).toBe('Continuity Type=CANON');
    expect(ct(ids.empty)).toBe('Continuity Type=CANON');
    expect(childNames(w, 'kumi_idx')).toEqual([
      '[BSRC] Ashgate',
      '[BSRC] Ct Au',
      '[BSRC] Ct Canon',
      '[BSRC] Ct Empty',
      '[BSRC] Ct Non Current',
    ]);
  });
});
