/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverWorld, type DiscoverWorld } from './world.js';

let w: DiscoverWorld;
let c: Client;
const call = (name: string, args: Record<string, unknown> = {}) => w.stack.call(c, name, args);
/** The plan's estimate: 3.5 characters per token. */
const tokens = (text: string) => Math.ceil(text.length / 3.5);
const LIMIT = 20_000;

beforeAll(async () => {
  w = await discoverWorld({ ageRows: 800 });
  c = await w.stack.connect();
});
afterAll(() => w.close());

describe('result sizes (3.5 characters per token, under 20,000 tokens)', () => {
  it('the default result for the largest subtree', async () => {
    const world = await call('browse_repository_tree');
    const sources = await call('browse_repository_tree', { path: 'Sources' }); // 1,221 pages below it
    const big = await call('browse_repository_tree', { path: 'Great Chronicles', depth: 6 }); // 300 children
    for (const r of [world, sources, big]) {
      expect(r.isError).toBe(false);
      expect(tokens(r.text)).toBeLessThan(LIMIT);
    }
    expect(sources.body.truncated).toBe(true);
    expect(sources.body.shown).toBe(150);
    expect(big.body.truncated).toBe(true);
    expect(tokens(sources.text)).toBeGreaterThan(2_000); // it is a real listing, not an empty one
  });
  it('the largest listing a caller can ask for is stored as a handle rather than sent', async () => {
    const r = await call('browse_repository_tree', { path: 'Sources', depth: 6, limit: 400 });
    expect(r.isError).toBe(false);
    expect(tokens(r.text)).toBeLessThan(LIMIT);
    if (r.body.status === 'stored') {
      expect(r.body.handle).toBeTruthy();
      expect(r.body.preview.shown).toBe(400);
    }
  });
  it('a 100-result search', async () => {
    const r = await call('search', { query: 'source', limit: 100 });
    expect(r.body.count).toBe(100);
    expect(tokens(r.text)).toBeLessThan(LIMIT);
    const wide = await call('search', { query: 'cycle OR source OR chronicles', limit: 100, content: false });
    expect(tokens(wide.text)).toBeLessThan(LIMIT);
  });
  it('the Fourth Age table page', async () => {
    const r = await call('read_document', { resource: 'Fourth Age - Table' });
    expect(r.body.status).toBe('stored');
    expect(tokens(r.text)).toBeLessThan(LIMIT);
    const detail = await call('read_document', { resource: 'Fourth Age - Table', format: 'json' });
    expect(tokens(detail.text)).toBeLessThan(LIMIT);
    // A section of it stays readable on its own.
    const sec = await call('read_document', { resource: 'Fourth Age - Table', outline: true });
    expect(tokens(sec.text)).toBeLessThan(2_000);
  });
  it('a full sidebar, 25 pages at once, tags, assets and templates', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `bk${i.toString(36).padStart(6, '0')}`);
    const many = await call('get_resources', { resources: ids, confirm: true, live: false });
    expect(tokens(many.text)).toBeLessThan(LIMIT);
    for (const [n, a] of [
      ['list_tags', {}],
      ['list_assets', { folder: 'Maps to get started', limit: 200 }],
      ['browse_asset_tree', { depth: 6, includeAssets: true, assetsPerFolder: 100 }],
      ['list_templates', {}],
    ] as const) {
      const r = await call(n, a);
      expect(r.isError, n).toBe(false);
      expect(tokens(r.text), n).toBeLessThan(LIMIT);
    }
  });
});
