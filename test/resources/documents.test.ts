/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * The Documents tools (v2 C2b): create_document (a map, timeline or board), update_document (settings only; pages and
 * blank documents refused), delete_document (confirm; a page's last document or only page document refused); each
 * verified, journalled, and a dry run writes nothing.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { resourcesWorld, type ResourcesWorld } from './world.js';

let w: ResourcesWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const docs = (id: string) => w.stack.runtime.tree.queries.node(PROJECT, id).data!.documents;
const writes = () => w.seen.filter((l) => !l.startsWith('GET'));

beforeAll(async () => {
  w = await resourcesWorld();
  client = await w.stack.connect();
});
afterAll(async () => w.close());

describe('documents', () => {
  it('adds a timeline to a page, verified, and the tree learns it; a document of the same name is refused', async () => {
    const r = await call('create_document', {
      page: '[BSRC] Plot Board',
      name: 'Plot Timeline',
      type: 'timeline',
    });
    expect(r.body, r.text).toMatchObject({
      status: 'written',
      verified: true,
      document: { name: 'Plot Timeline', type: 'timeline' },
    });
    expect(docs('board001').map((d) => d.name)).toContain('Plot Timeline');
    expect(
      (await call('create_document', { page: 'board001', name: 'plot timeline', type: 'map' })).body.error
        .code,
    ).toBe('DOCUMENT_EXISTS');
    expect(
      (
        await call('create_document', {
          page: 'board001',
          name: 'X',
          type: 'map',
          calendar: 'Kumikan Epochal',
        })
      ).body.error.code,
    ).toBe('INVALID_PARAMS');
  });

  it('changes a document’s settings; refuses a page or blank document', async () => {
    const r = await call('update_document', {
      page: 'board001',
      document: 'Plot Timeline',
      name: 'Plot Line',
      hidden: true,
    });
    expect(r.body, r.text).toMatchObject({
      status: 'written',
      verified: true,
      changes: { name: 'Plot Line', isHidden: true },
    });
    expect(docs('board001').map((d) => d.name)).toContain('Plot Line');
    const page = await call('update_document', { page: 'miyabi01', document: 'Main', name: 'Other' });
    expect(page.body.error.code).toBe('DOCUMENT_IS_PAGE');
    expect(
      (await call('update_document', { page: 'board001', document: 'Plot Line', hidden: true })).body.status,
    ).toBe('no_change');
  });

  it('deletes a document with confirm; refuses the last document and the only page document', async () => {
    expect((await call('delete_document', { page: 'board001', document: 'Plot Line' })).isError).toBe(true); // no confirm
    const before = writes().length;
    const dry = await call('delete_document', {
      page: 'board001',
      document: 'Plot Line',
      confirm: true,
      dryRun: true,
    });
    expect(dry.body.status).toBe('dry_run');
    expect(writes().length).toBe(before);
    const r = await call('delete_document', { page: 'board001', document: 'Plot Line', confirm: true });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    expect(docs('board001').map((d) => d.name)).not.toContain('Plot Line');
    // World Maps holds only its map: the last document.
    expect(
      (await call('delete_document', { page: 'maps0001', document: 'Arkona map', confirm: true })).body.error
        .code,
    ).toBe('DOCUMENT_LAST');
    // Asagiri Miyabi's Main is its only page document (add a board so it is not the last one).
    await call('create_document', { page: 'miyabi01', name: 'Relations Board', type: 'board' });
    expect(
      (await call('delete_document', { page: 'miyabi01', document: 'Main', confirm: true })).body.error.code,
    ).toBe('DOCUMENT_ONLY_PAGE');
  });
});
