/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * The costs docs/tools.md states for v2 C2b's tools (reads and writes per typical call, the tree's re-reads included),
 * measured against the mock LegendKeeper so the documented numbers stay true.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { resourcesWorld, T, type ResourcesWorld } from './world.js';

let w: ResourcesWorld;
beforeAll(async () => {
  w = await resourcesWorld();
});
afterAll(async () => w.close());

it('reads and writes per typical call', async () => {
  const c = await w.stack.connect();
  const got: Record<string, [number, number]> = {};
  const measure = async (label: string, tool: string, args: Record<string, unknown>) => {
    const a = w.seen.length;
    const r = await w.stack.call(c, tool, { project: 'test', ...args });
    expect(r.isError, `${label}: ${r.text}`).toBe(false);
    const lines = w.seen.slice(a);
    got[label] = [
      lines.filter((l) => l.startsWith('GET')).length,
      lines.filter((l) => !l.startsWith('GET')).length,
    ];
    return r;
  };
  await measure('core, new index, 1 fact', 'create_character', {
    kind: 'core',
    name: 'Cost Core',
    race: 'Humans',
    facts: { Scope: 'x' },
  });
  await measure('compact, no facts', 'create_character', {
    kind: 'compact',
    name: 'Cost Compact',
    race: 'Humans',
  });
  await measure('existing', 'create_character', { kind: 'compact', name: 'Cost Compact', race: 'Humans' });
  await measure('create_resource, 2 facts, 1 link', 'create_resource', {
    name: 'Cost Res',
    template: T.general,
    facts: { Scope: 'a', 'Reference Type': 'General Source' },
    links: { Dependencies: { add: ['ashg0001'] } },
  });
  await measure('bare', 'create_bare_resource', { name: '[BSRC] Cost Bare' });
  await measure('rename, re-placed', 'update_resource', { page: 'Cost Bare', name: 'Aaa Cost Bare' });
  // v2 C2c: a Working page stays under [INDEX] Working (a move out is promote_page's), so the move is of an index.
  await measure('move', 'move_resource', { page: '[INDEX] Isar', to: 'Kumikas' });
  const d = await measure('delete', 'delete_resource', { page: 'Aaa Cost Bare', confirm: true });
  await measure('restore', 'restore_resource', { page: d.body.page.id as string });
  await measure('create_document', 'create_document', { page: 'board001', name: 'Cost Map', type: 'map' });
  await measure('update_document', 'update_document', {
    page: 'board001',
    document: 'Cost Map',
    name: 'Cost Map 2',
  });
  await measure('delete_document', 'delete_document', {
    page: 'board001',
    document: 'Cost Map 2',
    confirm: true,
  });
  await measure('set_facts, 2 facts', 'set_facts', { page: 'mehran01', facts: { Notes: 'n', Scope: 's' } });
  // v2 C2c: the creates are Working (the default): the index gets no Status (fewer reads and writes); a page from a
  // template gets its status tag in one more write; the only Working page needs no re-placing after its rename; a
  // document delete reads the page's facts and the document for the delete-document canon rule.
  // v2 E1a (ADR 0042): every write is followed, inside its job, by the change snapshot of what it changed; it reuses the
  // reads the job made after its writes (the verify step, the tree's re-read) and reads the rest. Its extra reads are in
  // the second comment column (set_facts, rename, move and delete need none). v3 F12 (ADR 0081): each property row
  // update after the first reads the rows for its journal pre-image (op-meta), and a delete first takes
  // a recoverable copy of the page (D3: its resource and documents).
  expect(got).toEqual({
    'core, new index, 1 fact': [19, 9], // +3: both new pages' documents, and one page's resource; +5 pre-images
    'compact, no facts': [13, 7], // +1: the new page's document; +4 pre-images
    existing: [1, 0],
    'create_resource, 2 facts, 1 link': [12, 6], // +1: the new page's document; +1 pre-image
    bare: [3, 1], // +1: the new page's document
    'rename, re-placed': [4, 1],
    move: [3, 1],
    delete: [6, 1], // +2: the copy (the page and its document)
    restore: [4, 1], // +1: the restored page's document
    create_document: [4, 1], // +2: the new map (its settings and features)
    update_document: [6, 1], // +2: the map read whole (its settings and features)
    delete_document: [9, 1], // +5: the copy (the page and each of its documents)
    'set_facts, 2 facts': [5, 2], // +1 pre-image
  });
});
