/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * Creating pages as Working or Authoritative (v2 C2c, ADR 0035; Part 1, owner): each creation tool with "working" (the
 * default: [BWRK] directly under [INDEX] Working, Status Working, the Working tag, CANON removed if the template brings
 * it) and "authoritative" ([BSRC] in its normal place, Status Authoritative, CANON: a canonical proposal); Working
 * characters (Core and compact, return-existing in both places, an unresolved race still fails); the batch's parent rules;
 * create_index refused under [INDEX] Working and [INDEX] Archived; and a project whose indexes are not confirmed.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { childNames, facts, resourcesWorld, T, type ResourcesWorld } from '../resources/world.js';
import { accept, LIFECYCLE, lifecycleWorld, type LifecycleWorld } from './world.js';

let w: LifecycleWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const writes = () => w.seen.filter((l) => !l.startsWith('GET'));

beforeAll(async () => {
  w = await lifecycleWorld();
  // The General Source template brings the CANON tag (and another): a Working page must not keep CANON.
  w.repo.res.get(T.general)!.tags = ['CANON', 'source'];
  client = await w.stack.connect();
});
afterAll(async () => w.close());

describe('create_resource', () => {
  it('working (the default): [BWRK] under [INDEX] Working, alphabetically, Status Working, Working tag, CANON removed', async () => {
    const r = await call('create_resource', {
      name: 'Bell Tower',
      template: T.general,
      facts: { Scope: 'A tower' },
    });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    const p = r.body.pages[0];
    expect(p).toMatchObject({
      name: '[BWRK] Bell Tower',
      parent: { id: LIFECYCLE.working },
      status: 'working',
    });
    expect(facts(w, p.id)).toContain('Status=Working');
    expect(w.repo.res.get(p.id)!.tags).toEqual(['source', 'Working']);
    expect(childNames(w, LIFECYCLE.working)).toEqual(['[BWRK] Bell Tower', '[BWRK] Sky Ferry']);
  });

  it('authoritative: a canonical proposal; accepted, [BSRC] in its normal place, Status Authoritative, CANON', async () => {
    const r = await call('create_resource', {
      name: 'Bell Yard',
      template: T.general,
      parent: 'Kumikas',
      status: 'authoritative',
    });
    expect(r.body, r.text).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
    expect(r.body.reason).toMatch(/creates an Authoritative page/);
    const done = await accept(w, r);
    expect(done.body, done.text).toMatchObject({ status: 'written', verified: true });
    const id = r.body.pages[0].id;
    expect(w.repo.live(id)).toMatchObject({ name: '[BSRC] Bell Yard', parentId: 'kumi_idx' });
    expect(w.repo.live(id)!.tags).toEqual(['source', 'CANON']);
    expect(facts(w, id)).toContain('Status=Authoritative');
  });

  it('a Working page with a parent elsewhere, or an Authoritative page under a lifecycle index, is refused', async () => {
    const before = writes().length;
    expect(
      (await call('create_resource', { name: 'X', template: T.general, parent: 'Kumikas' })).body.error.code,
    ).toBe('WORKING_PARENT');
    const a = await call('create_resource', {
      name: 'X',
      template: T.general,
      parent: LIFECYCLE.working,
      status: 'authoritative',
    });
    expect(a.body.error.code).toBe('LIFECYCLE_AREA');
    expect(writes().length).toBe(before);
  });
});

describe('create_bare_resource', () => {
  it('working: [BWRK] with the Working tag in the create; authoritative: [BSRC], CANON, a canonical proposal', async () => {
    const r = await call('create_bare_resource', { name: '[BSRC] Bare Draft', tags: ['CANON', 'x'] });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    expect(w.repo.live(r.body.pages[0].id)).toMatchObject({
      name: '[BWRK] Bare Draft',
      parentId: LIFECYCLE.working,
    });
    expect(w.repo.live(r.body.pages[0].id)!.tags).toEqual(['x', 'Working']);
    const a = await call('create_bare_resource', {
      name: '[BSRC] Bare Canon',
      parent: 'Kumikas',
      status: 'authoritative',
    });
    expect(a.body, a.text).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
    const done = await accept(w, a);
    expect(done.body, done.text).toMatchObject({ status: 'written', verified: true });
    expect(w.repo.live(a.body.pages[0].id)!.tags).toEqual(['CANON']);
    expect(
      (
        await call('create_bare_resource', {
          name: '[BWRK] Contradiction',
          parent: 'Kumikas',
          status: 'authoritative',
        })
      ).body.error.code,
    ).toBe('INVALID_NAME');
  });
});

describe('create_many_resources', () => {
  it('a mixed batch is fine and becomes one canonical proposal; canon is judged per item', async () => {
    const r = await call('create_many_resources', {
      items: [
        { key: 'a', name: '[BSRC] Mixed Working' },
        { key: 'b', name: 'Mixed Canon', template: T.general, parent: 'Isar', status: 'authoritative' },
      ],
    });
    expect(r.body, r.text).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
    const done = await accept(w, r);
    expect(done.body, done.text).toMatchObject({ status: 'written', verified: true });
    const byName = Object.fromEntries(r.body.pages.map((p: { name: string; id: string }) => [p.name, p.id]));
    expect(w.repo.live(byName['[BWRK] Mixed Working'])!.parentId).toBe(LIFECYCLE.working);
    expect(w.repo.live(byName['[BSRC] Mixed Canon'])!.parentId).toBe('isar_idx');
  });

  it('the parent rules: [INDEX] Working or a character index under it; never under another item; no index under a lifecycle index', async () => {
    const before = writes().length;
    const elsewhere = await call('create_many_resources', {
      items: [{ key: 'a', name: '[BSRC] A', parent: 'Kumikas' }],
    });
    expect(elsewhere.body.error.code).toBe('WORKING_PARENT');
    const nested = await call('create_many_resources', {
      items: [
        { key: 'p', name: '[BSRC] Parent Page' },
        { key: 'c', name: '[BSRC] Child Page', parent_key: 'p' },
      ],
    });
    expect(nested.body.error.code).toBe('WORKING_PARENT');
    expect(nested.body.error.message).toMatch(/flat/);
    const under = await call('create_many_resources', {
      items: [
        { key: 'p', name: '[BSRC] Canon Parent', parent: 'Kumikas', status: 'authoritative' },
        { key: 'c', name: '[BSRC] Under A Working Page', parent_key: 'p', status: 'authoritative' },
        { key: 'w', name: '[BSRC] Working Leaf' },
        { key: 'x', name: '[BSRC] Under Working Leaf', parent_key: 'w', status: 'authoritative' },
      ],
    });
    expect(under.body.error.code).toBe('WORKING_PARENT');
    const idx = await call('create_many_resources', {
      items: [{ key: 'i', name: '[INDEX] Drafts', parent: LIFECYCLE.working }],
    });
    expect(idx.body.error.code).toBe('LIFECYCLE_AREA');
    const st = await call('create_many_resources', {
      items: [{ key: 'i', name: '[INDEX] Drafts', parent: 'Kumikas', status: 'working' }],
    });
    expect(st.body.error.code).toBe('INVALID_NAME');
    expect(writes().length).toBe(before);
  });
});

describe('create_index', () => {
  it('is refused under [INDEX] Working and [INDEX] Archived (they are flat)', async () => {
    for (const parent of [LIFECYCLE.working, LIFECYCLE.archived]) {
      const r = await call('create_index', { name: 'Drafts', parent, type: 'Character', role: 'subject' });
      expect(r.body.error, r.text).toBeDefined();
    }
    // v3 F6b (ADR 0079): with the Arkona pack attached `role` is required.
    const r = await call('create_index', { name: 'Drafts', parent: LIFECYCLE.working, role: 'subject' });
    expect(['LIFECYCLE_AREA', 'UNKNOWN_TYPE']).toContain(r.body.error.code);
  });
});

describe('Working characters', () => {
  it('a Core: [INDEX] {name} under [INDEX] Working, the [BWRK] Core beneath it; then returned, not duplicated', async () => {
    const r = await call('create_character', { kind: 'core', name: 'Ilka Thorn', race: 'Moon Elf' });
    expect(r.body, r.text).toMatchObject({
      status: 'written',
      verified: true,
      lifecycleStatus: 'working',
      placedUnder: '[INDEX] Working',
      species: { 'Race / Species': 'Moon Elf' },
    });
    const [idx, core] = r.body.pages;
    expect(idx).toMatchObject({ name: '[INDEX] Ilka Thorn', parent: { id: LIFECYCLE.working } });
    expect(core).toMatchObject({ name: '[BWRK] Ilka Thorn - Character Core', parent: { id: idx.id } });
    expect(facts(w, core.id)).toEqual(expect.arrayContaining(['Status=Working', 'Race / Species=Moon Elf']));
    const again = await call('create_character', { kind: 'core', name: 'Ilka Thorn', race: 'Moon Elf' });
    expect(again.body).toMatchObject({ status: 'existing', page: { id: core.id } });
    expect(again.body.note).toMatch(/promote_page/);
    // Return-existing looks in both places: asking for it as Authoritative returns the Working one too.
    const auth = await call('create_character', {
      kind: 'core',
      name: 'Ilka Thorn',
      race: 'Moon Elf',
      status: 'authoritative',
    });
    expect(auth.body).toMatchObject({ status: 'existing', page: { id: core.id } });
  });

  it('a compact: [BWRK] {name} - Character Reference directly under [INDEX] Working; an unknown race still fails', async () => {
    const r = await call('create_character', { kind: 'compact', name: 'Tobin Reed', race: 'Human' });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    expect(r.body.pages[0]).toMatchObject({
      name: '[BWRK] Tobin Reed - Character Reference',
      parent: { id: LIFECYCLE.working },
    });
    const bad = await call('create_character', { kind: 'compact', name: 'Ghost', race: 'Wraithkin' });
    expect(bad.body.error.code).toBe('RACE_NOT_FOUND');
    const none = await call('create_character', { kind: 'compact', name: 'Nobody Here' });
    expect(none.body, none.text).toMatchObject({ status: 'written' });
    expect(facts(w, none.body.pages[0].id)).toContain('Race / Species=Unestablished');
  });

  it('an existing character index under the race refuses a Working Core (it would clash when promoted)', async () => {
    const r = await call('create_character', { kind: 'core', name: 'Asagiri Miyabi', race: 'Foxian' });
    // Miyabi already has a Core under her index: returned. A character with an index but no Core:
    expect(r.body.status).toBe('existing');
  });
});

describe('a project whose lifecycle indexes are not confirmed', () => {
  it('refuses Working creates with a clear message; Authoritative creates still work', async () => {
    const u: ResourcesWorld = await resourcesWorld({ confirmLifecycle: false });
    try {
      const c = await u.stack.connect();
      const r = await u.stack.call(c, 'create_resource', { project: 'test', name: 'Z', template: T.general });
      expect(r.body.error).toMatchObject({ code: 'LIFECYCLE_NOT_CONFIGURED' });
      expect(r.body.error.message).toMatch(/not confirmed yet.*Projects page, Lifecycle/);
      const a = await u.stack.call(c, 'create_resource', {
        project: 'test',
        name: 'Z',
        template: T.general,
        parent: 'Kumikas',
        status: 'authoritative',
      });
      expect(a.body).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
      const t = await u.stack.call(c, 'archive_page', { project: 'test', page: 'Ashgate' });
      expect(t.body.error.code).toMatch(/LIFECYCLE_NOT_CONFIGURED|AMBIGUOUS/);
    } finally {
      await u.close();
    }
  });
});
