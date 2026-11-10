/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * create_character (v2 C2b) end to end through the REAL server and the official MCP client: a Core with a new index,
 * a Core under an existing index, a Compact reference; return-existing for both; an unknown race to Undetermined /
 * Unknown with Unestablished; a declared race that does not resolve; Race / Species exactly as given; nothing invented;
 * placement, names, identity facts, Status Working, the template recorded in the tree, verify, dry run.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { childNames, facts, resourcesWorld, T, type ResourcesWorld } from './world.js';

let w: ResourcesWorld;
let client: Client;
const call = (args: Record<string, unknown>) =>
  w.stack.call(client, 'create_character', { project: 'test', ...args });
const node = (id: string) => w.stack.runtime.tree.queries.node(PROJECT, id).data;
const writes = () => w.seen.filter((l) => !l.startsWith('GET'));

beforeAll(async () => {
  w = await resourcesWorld();
  client = await w.stack.connect();
});
afterAll(async () => w.close());

describe('create_character: core', () => {
  it('a new core: the character index from the Index template, the Core beneath it, identity facts, Status Working', async () => {
    const before = writes().length;
    const r = await call({
      kind: 'core',
      name: 'Asagiri Ren',
      race: 'Foxian',
      facts: { Scope: 'Shrine guard' },
    });
    expect(r.body, r.text).toMatchObject({
      status: 'written',
      verified: true,
      character: 'Asagiri Ren',
      race: { given: 'Foxian', matched: 'Foxians', index: '[INDEX] Foxians' },
      species: { 'Race / Species': 'Foxian' },
    });
    const [idx, core] = r.body.pages;
    expect(idx).toMatchObject({ name: '[INDEX] Asagiri Ren', parent: { id: 'foxian01' } });
    expect(core).toMatchObject({ name: '[BSRC] Asagiri Ren - Character Core', parent: { id: idx.id } });
    // Alphabetical: after Asagiri Miyabi's index under Foxians (indexes first), the Core the only child of its index.
    expect(childNames(w, 'foxian01')).toEqual([
      '[INDEX] Asagiri Miyabi',
      '[INDEX] Asagiri Ren',
      '[BSRC] Asagiri Kaede',
    ]);
    expect(childNames(w, idx.id)).toEqual(['[BSRC] Asagiri Ren - Character Core']);
    // Identity facts exactly, Status Working, then the caller's facts, in the template's order.
    expect(facts(w, core.id)).toEqual([
      'Reference Type=Character Core',
      'Subject=Asagiri Ren',
      'Race / Species=Foxian',
      'Status=Working',
      'Continuity Type=',
      'Continuity=',
      'Scope=Shrine guard',
      'Canonical Display Name=Asagiri Ren',
    ]);
    // The index gets Status Working too (its template has a Status row).
    expect(facts(w, idx.id)).toContain('Status=Working');
    // Both templates recorded in the tree at once; the Core's Reference Type in the tree after the job's re-read.
    expect(node(idx.id)).toMatchObject({ templateId: T.index });
    expect(node(core.id)).toMatchObject({ templateId: T.core, referenceType: 'Character Core' });
    expect(r.body.factsVersions?.[core.name]).toMatch(/^fv1_/);
    // Writes: two creates (each with its place), then one row write per fact.
    const w2 = writes().slice(before);
    expect(w2.filter((l) => l.startsWith('POST /resources/from-template'))).toHaveLength(2);
    expect(w2.filter((l) => /^PATCH .*\/rows\//.test(l))).toHaveLength(7); // 6 facts on the core + Status on the index
  });

  it('the same request again returns the existing Core with a note: nothing is duplicated', async () => {
    const before = writes().length;
    const r = await call({ kind: 'core', name: 'asagiri  ren', race: 'Foxians' });
    expect(r.body, r.text).toMatchObject({
      status: 'existing',
      page: { name: '[BSRC] Asagiri Ren - Character Core' },
    });
    expect(r.body.note).toMatch(/already exists/);
    expect(r.body.factsVersion).toMatch(/^fv1_/);
    expect(writes().length).toBe(before);
  });

  it('a core under an existing index that has no Core reuses the index', async () => {
    // Inae Mikumo's page has no index; make one by hand (as the owner might), then ask for a core.
    w.repo.seed({ id: 'kiraidx1', name: '[INDEX] Kira Vale', parentId: 'moonelf1' });
    w.stack.runtime.tree.store.applyObservation(
      {
        projectId: PROJECT,
        rootId: 'airepo01',
        settings: w.stack.runtime.tree.settings(PROJECT),
        by: 'write',
      },
      {
        id: 'kiraidx1',
        name: '[INDEX] Kira Vale',
        parentId: 'moonelf1',
        rank: w.repo.res.get('kiraidx1')!.rank,
        tags: [],
        aliases: [],
        documents: [],
        isHidden: false,
      },
      Date.now() * 1000,
    );
    w.stack.runtime.tree.store.recomputePaths(PROJECT, 'airepo01');
    const r = await call({ kind: 'core', name: 'Kira Vale', race: 'Moon Elf' });
    expect(r.body, r.text).toMatchObject({
      status: 'written',
      characterIndex: { reused: '[INDEX] Kira Vale' },
    });
    expect(r.body.pages).toHaveLength(1);
    expect(r.body.pages[0]).toMatchObject({
      name: '[BSRC] Kira Vale - Character Core',
      parent: { id: 'kiraidx1' },
    });
    expect(facts(w, r.body.pages[0].id)).toContain('Race / Species=Moon Elf');
  });
});

describe('create_character: compact and races', () => {
  it('a compact reference goes directly under the race, with no index; then it is returned, not duplicated', async () => {
    const r = await call({ kind: 'compact', name: 'Oren Pike', race: 'Human' });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    expect(r.body.pages).toHaveLength(1);
    const p = r.body.pages[0];
    expect(p).toMatchObject({ name: '[BSRC] Oren Pike - Character Reference', parent: { id: 'humans01' } });
    expect(facts(w, p.id)).toEqual([
      'Reference Type=Compact Character Reference',
      'Subject=Oren Pike',
      'Race / Species=Human',
      'Status=Working',
      'Canonical Display Name=Oren Pike',
      'Scope=',
    ]);
    const again = await call({ kind: 'compact', name: '[BSRC] Oren Pike', race: 'Human' });
    expect(again.body).toMatchObject({ status: 'existing', page: { id: p.id } });
  });

  it('an unknown or omitted race goes to Undetermined / Unknown with Race / Species Unestablished', async () => {
    const r = await call({ kind: 'compact', name: 'Nobody Known' });
    expect(r.body, r.text).toMatchObject({
      status: 'written',
      race: { unknown: true, index: '[INDEX] Undetermined / Unknown' },
    });
    expect(r.body.pages[0].parent.id).toBe('unknown1');
    expect(facts(w, r.body.pages[0].id)).toContain('Race / Species=Unestablished');
    const r2 = await call({ kind: 'compact', name: 'Someone Else', race: 'Undetermined' });
    expect(r2.body.pages[0].parent.id).toBe('unknown1');
  });

  it('a declared race that does not resolve fails, and nothing is created or invented', async () => {
    const before = writes().length;
    const r = await call({ kind: 'core', name: 'Ghost Rider', race: 'Wraithkin' });
    expect(r.body.error).toMatchObject({ code: 'RACE_NOT_FOUND' });
    expect(r.body.error.message).toMatch(/never created automatically/);
    expect(writes().length).toBe(before);
  });

  it('keeps Race / Species exactly as given (an alias or singular places the page, the value is kept)', async () => {
    const r = await call({ kind: 'compact', name: 'Tal Rune', race: 'moon elf', dryRun: true });
    expect(r.body, r.text).toMatchObject({ status: 'dry_run', species: { 'Race / Species': 'moon elf' } });
    expect(r.body.pages[0].facts).toContainEqual({ key: 'Race / Species', value: 'moon elf' });
  });

  it('a dry run writes nothing and shows pages, names, parents, places and facts', async () => {
    const before = writes().length;
    const r = await call({ kind: 'core', name: 'Hana Sora', race: 'Qishen', dryRun: true });
    expect(r.body, r.text).toMatchObject({ status: 'dry_run' });
    expect(r.body.pages.map((p: { name: string }) => p.name)).toEqual([
      '[INDEX] Hana Sora',
      '[BSRC] Hana Sora - Character Core',
    ]);
    expect(writes().length).toBe(before);
    // No tag was ever invented.
    expect(JSON.stringify(r.body)).not.toMatch(/"tags"/);
  });
});
