/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- parsed JSON tool results */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectStore } from '../../src/projects/index.js';
import { PROJECT } from '../tools/helpers.js';
import { buildModels, discoverWorld, ROOT, type DiscoverWorld } from './world.js';

let w: DiscoverWorld;
let c: Client;
const call = (name: string, args: Record<string, unknown> = {}) => w.stack.call(c, name, args);

beforeAll(async () => {
  w = await discoverWorld({ build: false, bulk: 20 });
  c = await w.stack.connect();
});
afterAll(() => w.close());

const TREE_TOOLS: [string, Record<string, unknown>][] = [
  ['browse_repository_tree', {}],
  ['search', { query: 'miyabi' }],
  ['get_resource', { resource: 'miyabi01' }],
  ['get_resource', { resources: ['miyabi01'] }],
  ['read_document', { resource: 'miyabi01' }],
  ['list_tags', {}],
];

describe('a tree that cannot answer', () => {
  it('says it is not configured, spends nothing, and still ends with the budget line', async () => {
    const before = w.stack.mock.calls.length;
    for (const [name, args] of TREE_TOOLS) {
      const r = await call(name, args);
      expect(r.isError, name).toBe(true);
      expect(r.body.error.code, name).toBe('TREE_NOT_CONFIGURED');
      expect(r.body.error.message, name).toMatch(/No AI REPOSITORY root is set/);
      expect(r.body.error.message, name).toMatch(/lk_api_read/);
      expect(r.body.error.tree.status, name).toBe('not_configured');
      expect(r.footer, name).toMatch(/^budget \(test\)/);
    }
    expect(w.stack.mock.calls.length).toBe(before);
  });

  it('says it has not been built, then that it is being built', async () => {
    new ProjectStore(w.stack.db).setSetting(PROJECT, 'aiRepositoryRootId', ROOT);
    for (const [name, args] of TREE_TOOLS) {
      const r = await call(name, args);
      expect(r.body.error.code, name).toBe('TREE_NOT_READY');
      expect(r.body.error.message, name).toMatch(/has not been built yet/);
      expect(r.body.error.tree.status, name).toBe('not_built');
    }
    // list_templates and list_calendars do not use the tree.
    expect((await call('list_calendars')).isError).toBe(false);
    expect((await call('list_templates')).isError).toBe(false);
  });

  it('falls back to a live read only for a plain-text content search, confined to the root', async () => {
    const before = w.seen.length;
    const r = await call('search', { query: 'quietly', content: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.source).toMatch(/page-text search only/);
    expect(r.body.tree.status).toBe('not_built');
    // The page outside the root, which LegendKeeper returned too, is dropped by its ancestry; the duplicate is removed.
    expect(r.body.results.map((x: any) => x.id)).toEqual(['kaede001', 'mehran01']);
    expect(r.body.results[0].path).toMatch(/^AI REPOSITORY \/ Characters/);
    expect(r.body.note).toMatch(/Incomplete/);
    expect(w.seen.slice(before).filter((l) => l.startsWith('GET /search'))).toHaveLength(1);
    // Operators need the tree.
    const ops = await call('search', { query: 'quietly tag:elder', content: true });
    expect(ops.body.error.code).toBe('TREE_NOT_READY');
    const noContent = await call('search', { query: 'quietly' });
    expect(noContent.body.error.code).toBe('TREE_NOT_READY');
  });

  it('answers from a stale tree, and says so, with how long ago it was confirmed', async () => {
    buildModels(w.stack, w.repo, w.assets);
    const fresh = await call('search', { query: 'kaede' });
    expect(fresh.body.tree.status).toBe('ready');
    w.stack.db
      .prepare('UPDATE tree_state SET confirmed_at = ? WHERE project_id = ?')
      .run(Date.now() - 30 * 3_600_000, PROJECT);
    for (const [name, args] of TREE_TOOLS.filter(
      ([n]) => n !== 'get_resources' && n !== 'get_resource' && n !== 'read_document',
    )) {
      const r = await call(name, args);
      expect(r.isError, `${name}: ${r.text}`).toBe(false);
      expect(r.body.tree.status, name).toBe('stale');
      expect(r.body.tree.confirmed, name).toBe('30 h ago');
      expect(r.body.tree.note, name).toMatch(/26 hours|confirm/i);
    }
    const stale = await call('search', { query: 'kaede' });
    expect(stale.body.results.map((x: any) => x.id)).toEqual(['kaede001']);
  });
});

describe('an asset tree that cannot answer', () => {
  it('says it has not been built', async () => {
    const w2 = await discoverWorld({ build: false, bulk: 5 });
    try {
      const c2 = await w2.stack.connect();
      for (const [name, args] of [
        ['browse_asset_tree', {}],
        ['list_assets', {}],
      ] as const) {
        const r = await w2.stack.call(c2, name, args);
        expect(r.isError, name).toBe(true);
        expect(r.body.error.code, name).toBe('ASSET_TREE_NOT_READY');
        expect(r.body.error.message, name).toMatch(/not been built/);
        expect(r.body.error.assetTree.status).toBe('not_built');
        expect(r.footer).toMatch(/^budget \(test\)/);
      }
    } finally {
      await w2.close();
    }
  });
});
