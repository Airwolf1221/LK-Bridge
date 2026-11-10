/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * The page kinds of the lifecycle (v2 C2c, ADR 0035; Part 0): `[BWRK]` (bwrk) and `[BARC]` (barc) beside `[INDEX]`,
 * `[BSRC]` and unclassified, in classification and stray-prefix clean-up, the tree, search (`kind:`),
 * browse_repository_tree and get_resource; name handling treats them like `[BSRC]` (display names, ordering, character
 * roles); and a mention prefers the current page: [BSRC], then [BWRK], then [BARC], for one subject.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanPrefixes } from '../../src/registry/names.js';
import { compareSiblings } from '../../src/registry/ordering.js';
import { classifyName, isPageKind } from '../../src/tree/index.js';
import { PROJECT } from '../tools/helpers.js';
import { LIFECYCLE, lifecycleWorld, type LifecycleWorld } from './world.js';

describe('classification (pure)', () => {
  it('[BWRK] and [BARC] are kinds; display names without the prefix; unclassified otherwise', () => {
    expect(classifyName('[BWRK] Sky Ferry')).toEqual({ kind: 'bwrk', displayName: 'Sky Ferry' });
    expect(classifyName('[BARC] Old Pier')).toEqual({ kind: 'barc', displayName: 'Old Pier' });
    expect(classifyName('[BSRC] Ashgate')).toEqual({ kind: 'bsrc', displayName: 'Ashgate' });
    expect(classifyName('[bwrk] lower')).toEqual({ kind: 'unclassified', displayName: '[bwrk] lower' });
    expect(classifyName('[BWRK]NoSpace').kind).toBe('unclassified');
    expect(['bsrc', 'bwrk', 'barc'].every(isPageKind)).toBe(true);
    expect(isPageKind('index')).toBe(false);
  });
  it('stray prefixes are cleaned in any case; the last one given is the kind', () => {
    expect(cleanPrefixes('[bwrk] Sky Ferry')).toEqual({ name: 'Sky Ferry', prefix: 'bwrk' });
    expect(cleanPrefixes('[BSRC] [BARC] Old Pier')).toEqual({ name: 'Old Pier', prefix: 'barc' });
  });
  it('[BSRC], [BWRK] and [BARC] sort together by name, after [INDEX]', () => {
    const names = [
      { displayName: 'B', kind: 'barc' },
      { displayName: 'A', kind: 'bwrk' },
      { displayName: 'C', kind: 'bsrc' },
      { displayName: 'Z', kind: 'index' },
    ] as const;
    expect([...names].sort(compareSiblings).map((n) => n.displayName)).toEqual(['Z', 'A', 'B', 'C']);
  });
});

let w: LifecycleWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });

beforeAll(async () => {
  w = await lifecycleWorld({
    seed: (world) => {
      // One subject in three lifecycle states, and an archived page.
      world.repo.seed({ id: 'lantbsrc', name: '[BSRC] Lantern', parentId: 'locs0001' });
      world.repo.seed({ id: 'lantbwrk', name: '[BWRK] Lantern', parentId: 'working1' });
      world.repo.seed({ id: 'lantbarc', name: '[BARC] Lantern', parentId: 'archive1' });
      world.repo.seed({ id: 'pierbarc', name: '[BARC] Old Pier', parentId: 'archive1' });
      world.repo.seed({ id: 'pierbwrk', name: '[BWRK] Old Pier', parentId: 'working1' });
    },
  });
  client = await w.stack.connect();
});
afterAll(async () => w.close());

describe('the tree, search, browse and get_resource', () => {
  it('the tree holds the kinds and counts them', () => {
    const q = w.stack.runtime.tree.queries;
    expect(q.node(PROJECT, 'skyferr1').data).toMatchObject({ kind: 'bwrk', displayName: 'Sky Ferry' });
    expect(q.node(PROJECT, 'pierbarc').data).toMatchObject({ kind: 'barc', displayName: 'Old Pier' });
    const c = q.counts(PROJECT).data.byKind;
    expect(c.bwrk).toBe(3);
    expect(c.barc).toBe(2);
  });
  it('search kind:bwrk and kind:barc', async () => {
    const wk = await call('search', { query: 'kind:bwrk' });
    expect(wk.body.results.map((r: { name: string }) => r.name).sort()).toEqual([
      'Lantern',
      'Old Pier',
      'Sky Ferry',
    ]);
    expect(wk.body.results.every((r: { kind: string }) => r.kind === 'bwrk')).toBe(true);
    const ar = await call('search', { query: 'kind:barc' });
    expect(ar.body.results.map((r: { name: string }) => r.name).sort()).toEqual(['Lantern', 'Old Pier']);
    expect(ar.body.results.every((r: { kind: string }) => r.kind === 'barc')).toBe(true);
  });
  it('browse_repository_tree keeps only the kinds asked for; get_resource shows the kind', async () => {
    const b = await call('browse_repository_tree', { path: LIFECYCLE.working, kinds: ['bwrk'] });
    expect(
      b.body.node.children.map((c: { name: string; kind: string }) => `${c.kind} ${c.name}`).sort(),
    ).toEqual(['bwrk Lantern', 'bwrk Old Pier', 'bwrk Sky Ferry']);
    const g = await call('get_resource', { resource: 'skyferr1' });
    expect(JSON.stringify(g.body), g.text).toMatch(/"kind":"bwrk"/);
  });
});

describe('name handling treats them like [BSRC]', () => {
  it('a name matching one subject in several states resolves a mention to [BSRC], then [BWRK], then [BARC]', () => {
    const types = w.stack.runtime.registry.forProject(PROJECT);
    const choices: { role: string; chosen: { id: string } }[] = [];
    const m = types.mentionResolver({ onChoice: (c) => choices.push(c) });
    expect(m('Lantern')).toEqual({ status: 'resolved', resourceId: 'lantbsrc' });
    expect(choices.at(-1)!.role).toBe('bsrc');
    // Without a current page: the Working one, before the archived one.
    expect(m('Old Pier')).toEqual({ status: 'resolved', resourceId: 'pierbwrk' });
    // A write target is never chosen this way: an exact name is still ambiguous for the resolver.
    expect(types.resolve('Lantern').status).toBe('ambiguous');
    // A stray prefix tells them apart.
    expect(types.resolve('[BARC] Lantern')).toMatchObject({ status: 'resolved', node: { id: 'lantbarc' } });
  });
});
