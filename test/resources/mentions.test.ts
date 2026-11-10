/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * Mention targets for characters (v2 C2b, decided by the owner on 10 November 2026): `[[Name]]` matching several pages
 * of ONE character goes to its Core, else its Reference, else its index, and the result says which and why; different
 * subjects, or a page with no character role among them, stay ambiguous; a write target is never chosen this way.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { P, resourcesWorld, type ResourcesWorld } from './world.js';

let w: ResourcesWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const notes = () =>
  w.sidebars.pages
    .get(P.mehrana)!
    .props.find((p) => p.title === 'PROPERTIES')!
    .rows!.find((r) => r.key === 'Notes')!.content;

/** Adds a page to the model and the tree, as if the tree had read it. */
function addPage(id: string, name: string, parentId: string, referenceType?: string): void {
  w.repo.seed({ id, name, parentId, ...(referenceType ? { referenceType } : {}) });
  const tree = w.stack.runtime.tree;
  const view = w.repo.resourceView(w.repo.live(id)!);
  tree.store.applyObservation(
    { projectId: PROJECT, rootId: 'airepo01', settings: tree.settings(PROJECT), by: 'write' },
    {
      id,
      name,
      parentId,
      rank: view.rank,
      tags: [],
      aliases: [],
      documents: [],
      isHidden: false,
      props: {
        isLocked: false,
        sidebar: referenceType
          ? [
              {
                id: 'kv',
                kind: 'keyValue',
                title: 'PROPERTIES',
                rows: [{ key: 'Reference Type', text: referenceType }],
              },
            ]
          : [],
      },
    },
    Date.now() * 1000,
  );
  tree.store.recomputePaths(PROJECT, 'airepo01');
}

beforeAll(async () => {
  w = await resourcesWorld();
  client = await w.stack.connect();
});
afterAll(async () => w.close());

describe('mentions of one character', () => {
  it('the Core is preferred over the index; the result says which page and why', async () => {
    // [INDEX] Asagiri Miyabi and [BSRC] Asagiri Miyabi (its Character Core) share the name.
    const r = await call('set_facts', {
      page: P.mehrana,
      facts: { Notes: { markdown: 'Friend of [[Asagiri Miyabi]]' } },
    });
    expect(r.body, r.text).toMatchObject({ status: 'written' });
    expect(r.body.mentions).toEqual([
      expect.objectContaining({
        name: 'Asagiri Miyabi',
        chosen: { id: P.miyabi, name: '[BSRC] Asagiri Miyabi', role: 'Character Core' },
      }),
    ]);
    expect(r.body.mentions[0].why).toMatch(/Core, then Reference, then index/);
    expect(notes().find((x) => x.mention)).toMatchObject({ mention: { resourceId: P.miyabi } });
  });

  it('the Reference is preferred over the index when there is no Core', async () => {
    addPage('kumiidx1', '[INDEX] Kumi the Elder', 'humans01');
    const r = await call('set_facts', {
      page: P.mehrana,
      facts: { Notes: { markdown: 'Taught by [[Kumi the Elder]]' } },
    });
    expect(r.body, r.text).toMatchObject({ status: 'written' });
    expect(r.body.mentions[0].chosen).toMatchObject({ id: 'kumi0001', role: 'Character Reference' });
  });

  it('pages of different subjects stay ambiguous, with the candidates listed', async () => {
    const r = await call('set_facts', {
      page: P.mehrana,
      facts: { Notes: { markdown: 'Near [[Ashgate]]' } },
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/ashg0001/);
    expect(r.text).toMatch(/ashg0002/);
  });

  it('a write target is never chosen for the agent: the ambiguity lists each candidate with its role', async () => {
    const r = await call('set_facts', { page: 'Asagiri Miyabi', facts: { Notes: 'x' } });
    expect(r.body.error.code).toBe('AMBIGUOUS');
    expect(r.body.error.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: P.miyabi, role: 'Character Core' }),
        expect.objectContaining({ id: 'miyaidx1', role: 'character index' }),
      ]),
    );
  });

  it('write_page resolves a mention the same way and reports it', async () => {
    const r = await call('write_page', {
      page: P.miyabi,
      mode: 'append',
      markdown: 'See also [[Asagiri Miyabi]].',
    });
    expect(r.body, r.text).toMatchObject({ status: 'written' });
    expect(r.body.mentions[0].chosen).toMatchObject({ id: P.miyabi, role: 'Character Core' });
  });

  it('a page with no character role among the matches keeps the mention ambiguous', async () => {
    addPage('asaloc01', '[BSRC] Asagiri Miyabi', 'locs0001', 'General Source');
    const r = await call('set_facts', {
      page: P.mehrana,
      facts: { Notes: { markdown: '[[Asagiri Miyabi]]' } },
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/asaloc01/);
  });
});
