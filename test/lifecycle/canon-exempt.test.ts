/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * E5.3 (ADR 0046 decision 13, the owner's rule of 15 November 2026): pages beneath an index the owner lists ("Design
 * References") are `[BSRC]` and Authoritative WITHOUT the CANON tag. The lifecycle tools that make a page Authoritative
 * there (promote_page, unarchive_page, an Authoritative create) add no CANON; archive_page removes nothing it did not
 * find; a lifecycle tool does not refuse such a page as inconsistent; pages elsewhere still get CANON.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonExemptionOf, LifecycleError } from '../../src/lifecycle/index.js';
import { ROOT } from '../discover/world.js';
import { facts, SidebarModel, T } from '../resources/world.js';
import { PROJECT } from '../tools/helpers.js';
import { LIFECYCLE, lifecycleWorld, type LifecycleWorld } from './world.js';

const D = { refs: 'desref01', nest: 'desnest1', fiction: 'fiction1', plot: 'plotwrk1' } as const;

let w: LifecycleWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const live = (id: unknown) => w.repo.live(String(id))!;

beforeAll(async () => {
  w = await lifecycleWorld({
    seed: (world) => {
      world.repo.seed({ id: D.refs, name: '[INDEX] Design References', parentId: ROOT });
      world.repo.seed({ id: D.nest, name: '[INDEX] Writing Craft', parentId: D.refs });
      world.repo.seed({
        id: D.fiction,
        name: '[BSRC] Arkona - Fiction Writing Reference',
        parentId: D.nest,
        tags: ['craft'],
      });
      world.repo.seed({
        id: D.plot,
        name: '[BWRK] Story Planning Workflow',
        parentId: LIFECYCLE.working,
        tags: ['Working'],
      });
    },
  });
  w.sidebars.page(D.fiction, [
    SidebarModel.kv('kvfict01', 'PROPERTIES', [
      ['Reference Type', 'General Source'],
      ['Status', 'Authoritative'],
      ['Continuity Type', 'CANON'],
      ['Scope', 'How Arkona is written'],
      ['Temporal Scope', ''],
    ]),
  ]);
  w.sidebars.page(D.plot, [
    SidebarModel.kv('kvplot01', 'PROPERTIES', [
      ['Reference Type', 'General Source'],
      ['Status', 'Working'],
      ['Continuity Type', ''],
      ['Scope', 'Planning and drafting'],
    ]),
  ]);
  client = await w.stack.connect();
  w.stack.runtime.lifecycle.update('owner', PROJECT, { canonExemptIndexes: [D.refs] });
});
afterAll(async () => w.close());

describe('the setting', () => {
  it('beneath a listed index at any depth, never inside the Working or Archived area', () => {
    const c = {
      canonExemptIndexes: [D.refs],
      workingIndexId: LIFECYCLE.working,
      archiveIndexId: LIFECYCLE.archived,
    };
    expect(canonExemptionOf(c, [ROOT, D.refs])).toBe(D.refs);
    expect(canonExemptionOf(c, [ROOT, D.refs, D.nest])).toBe(D.refs);
    expect(canonExemptionOf(c, [ROOT, 'locs0001'])).toBeNull();
    expect(canonExemptionOf(c, [ROOT, LIFECYCLE.working, D.refs])).toBeNull();
    expect(canonExemptionOf(c, [ROOT, LIFECYCLE.archived, D.refs])).toBeNull();
    expect(canonExemptionOf({ ...c, canonExemptIndexes: [] }, [ROOT, D.refs])).toBeNull();
  });

  it('only an index in the tree, and not a lifecycle index, can be listed', () => {
    const lc = w.stack.runtime.lifecycle;
    expect(() => lc.update('owner', PROJECT, { canonExemptIndexes: ['nowhere1'] })).toThrow(LifecycleError);
    expect(() => lc.update('owner', PROJECT, { canonExemptIndexes: [D.fiction] })).toThrow(
      /not an \[INDEX\]/,
    );
    expect(() => lc.update('owner', PROJECT, { canonExemptIndexes: [LIFECYCLE.working] })).toThrow(
      /lifecycle index/,
    );
    expect(lc.find(PROJECT).config.canonExemptIndexes).toEqual([D.refs]);
  });
});

describe('the lifecycle tools beneath Design References', () => {
  it('promote_page: [BSRC], Status Authoritative and the Continuity Type rules as usual, but no CANON', async () => {
    // F12 (ADR 0081): at scope write the lifecycle tools are direct (a job on the Review page).
    const done = await call('promote_page', { page: D.plot, destination: D.nest });
    expect(done.body, done.text).toMatchObject({ status: 'written', verified: true });
    expect(JSON.stringify(done.body.flags)).toMatch(/Authoritative without CANON/);
    expect(live(D.plot)).toMatchObject({ name: '[BSRC] Story Planning Workflow', parentId: D.nest });
    expect(live(D.plot).tags).toEqual([]);
    expect(facts(w, D.plot)).toEqual(
      expect.arrayContaining(['Status=Authoritative', 'Continuity Type=CANON']),
    );
  });

  it('archive_page from there is not refused, removes nothing it did not find and adds Archived', async () => {
    const done = await call('archive_page', { page: D.fiction });
    expect(done.body, done.text).toMatchObject({ status: 'written', verified: true });
    expect(live(D.fiction)).toMatchObject({ parentId: LIFECYCLE.archived });
    expect(live(D.fiction).tags).toEqual(['craft', 'Archived']);
    expect(w.stack.runtime.lifecycle.store.latest(PROJECT, D.fiction, ['archive'])).toMatchObject({
      state: 'complete',
      tagsRemoved: [],
      tagsAdded: ['Archived'],
    });
  });

  it('unarchive_page back beneath Design References: Archived removed, no CANON added', async () => {
    const done = await call('unarchive_page', { page: D.fiction });
    expect(done.body, done.text).toMatchObject({ status: 'written', verified: true });
    expect(live(D.fiction)).toMatchObject({
      name: '[BSRC] Arkona - Fiction Writing Reference',
      parentId: D.nest,
    });
    expect(live(D.fiction).tags).toEqual(['craft']);
  });

  it('move_to_working does not refuse an exempt page as inconsistent (it has no CANON to remove)', async () => {
    const dry = await call('move_to_working', { page: D.fiction, dryRun: true });
    expect(dry.body.error, dry.text).toBeUndefined();
    expect(dry.text).not.toMatch(/LIFECYCLE_INCONSISTENT/);
  });

  it('creates with status authoritative beneath it add no CANON; elsewhere they still do', async () => {
    const bare = await call('create_bare_resource', {
      name: '[BSRC] Drafting Checklist',
      parent: D.nest,
      status: 'authoritative',
      tags: ['CANON', 'craft'],
    });
    expect(bare.body, bare.text).toMatchObject({ status: 'written' });
    expect(bare.body).not.toHaveProperty('requiresCanonicalApproval');
    expect(live(bare.body.pages[0].id).tags).toEqual(['craft']);

    const fromTemplate = await call('create_resource', {
      name: 'Voice and Tone',
      template: T.general,
      parent: D.refs,
      status: 'authoritative',
    });
    expect(fromTemplate.body, fromTemplate.text).toMatchObject({ status: 'written' });
    expect(live(fromTemplate.body.pages[0].id).tags).not.toContain('CANON');

    const many = await call('create_many_resources', {
      items: [
        { key: 'idx', name: 'Genre Notes', template: T.index, parent: D.refs },
        { key: 'a', name: 'Pacing', template: T.general, parent_key: 'idx', status: 'authoritative' },
        { key: 'b', name: 'Harbour Lore', template: T.general, parent: 'locs0001', status: 'authoritative' },
      ],
    });
    expect(many.body, many.text).toMatchObject({ status: 'written' });
    const pages = many.body.pages as { name: string; id: string }[];
    const byName = Object.fromEntries(pages.map((p) => [p.name, p.id]));
    expect(live(byName['[BSRC] Pacing']).tags).not.toContain('CANON');
    // Outside the area a page still needs CANON.
    expect(live(byName['[BSRC] Harbour Lore']).tags).toContain('CANON');
    const outside = await call('create_bare_resource', {
      name: '[BSRC] Harbour Notes',
      parent: 'locs0001',
      status: 'authoritative',
    });
    expect(outside.body, outside.text).toMatchObject({ status: 'written' });
    expect(live(outside.body.pages[0].id).tags).toEqual(['CANON']);
  });
});
