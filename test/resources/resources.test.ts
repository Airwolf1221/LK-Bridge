/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * The Resources tools (v2 C2b) end to end through the REAL server and the official MCP client at scope `write`:
 * create_index, create_resource, create_bare_resource, create_many_resources (100 nested; the 101st refused; a bad
 * parent_key refused before anything is sent), update_resource (rename keeps the prefix and re-places), move_resource,
 * delete_resource and restore_resource; placement and ranks, names and prefixes, Status Working only where the template
 * has a Status row, the template recorded in the tree, verify, dry runs, and protected canon on create and delete.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { childNames, facts, resourcesWorld, T, type ResourcesWorld } from './world.js';

let w: ResourcesWorld;
let client: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const node = (id: string) => w.stack.runtime.tree.queries.node(PROJECT, id).data;
const writes = () => w.seen.filter((l) => !l.startsWith('GET'));
const proposals = () => w.stack.runtime.policy.proposals;
const settle = async (id: string) => {
  for (let i = 0; i < 300 && !['executed', 'failed', 'conflicted'].includes(proposals().get(id)!.state); i++)
    await new Promise((r) => setTimeout(r, 20));
  return proposals().get(id)!;
};

beforeAll(async () => {
  w = await resourcesWorld();
  client = await w.stack.connect();
});
afterAll(async () => w.close());

describe('create_index', () => {
  it('makes [INDEX] {name} from the type’s Index template under the category’s index, in alphabetical place, Status Working', async () => {
    const r = await call('create_index', { name: 'Shrine Families', type: 'Character', category: 'Foxians' });
    expect(r.body, r.text).toMatchObject({
      status: 'written',
      verified: true,
      type: 'Character',
      category: 'Foxians',
    });
    const p = r.body.pages[0];
    expect(p).toMatchObject({
      name: '[INDEX] Shrine Families',
      parent: { id: 'foxian01' },
      after: 'miyaidx1',
    });
    expect(childNames(w, 'foxian01')).toEqual([
      '[INDEX] Asagiri Miyabi',
      '[INDEX] Shrine Families',
      '[BSRC] Asagiri Kaede',
    ]);
    expect(facts(w, p.id)).toEqual(['Reference Type=', 'Index Scope=', 'Status=Working']);
    expect(node(p.id)).toMatchObject({ kind: 'index', templateId: T.index, parentId: 'foxian01' });
  });

  it('refuses an unknown type or category with the known ones, a duplicate name, and a parent under no type', async () => {
    const t = await call('create_index', { name: 'X', type: 'Vehicle', parent: 'Characters' });
    expect(t.body.error).toMatchObject({ code: 'UNKNOWN_TYPE', types: ['Character'] });
    const c = await call('create_index', { name: 'X', type: 'Character', category: 'Lizardfolk' });
    expect(c.body.error.code).toBe('UNKNOWN_CATEGORY');
    expect(c.body.error.categories).toEqual(expect.arrayContaining(['Foxians', 'Humans', 'Moon Elves']));
    const d = await call('create_index', { name: 'shrine  families', category: 'Foxians' });
    expect(d.body.error).toMatchObject({ code: 'INDEX_EXISTS' });
    const n = await call('create_index', { name: 'Ports', parent: 'Locations' });
    expect(n.body.error.code).toBe('UNKNOWN_TYPE');
    expect(n.body.error.message).toMatch(/under no type/);
  });
});

describe('create_resource and create_bare_resource', () => {
  it('a page from a template under an index: name, place, facts and links in the same job, Status Working', async () => {
    const before = writes().length;
    const r = await call('create_resource', {
      name: 'Hollow Court',
      template: '[BSRC] AI General Source',
      parent: 'Kumikas',
      facts: { Scope: 'A court of the Foxians', 'Reference Type': 'General Source' },
      links: { Dependencies: { add: ['ashg0001'] } },
      tags: ['draft'],
    });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    const p = r.body.pages[0];
    expect(p).toMatchObject({ name: '[BSRC] Hollow Court', parent: { id: 'kumi_idx' }, after: 'ashg0001' });
    expect(childNames(w, 'kumi_idx')).toEqual(['[BSRC] Ashgate', '[BSRC] Hollow Court']);
    expect(facts(w, p.id)).toEqual([
      'Reference Type=General Source',
      'Scope=A court of the Foxians',
      'Status=Working',
      'Continuity Type=',
    ]);
    expect(w.sidebars.items(p.id, 'Dependencies').map((i) => i.resourceId)).toEqual(['ashg0001']);
    expect(w.repo.res.get(p.id)!.tags).toEqual(['draft']);
    expect(node(p.id)).toMatchObject({ templateId: T.general, referenceType: 'General Source' });
    // One template copy, one updateResource (tags), 3 row writes, 1 collection write.
    const ws = writes().slice(before);
    expect(ws.filter((l) => l.startsWith('POST /resources/from-template'))).toHaveLength(1);
    expect(ws.filter((l) => /^PATCH \/resources\/[^/]+$/.test(l))).toHaveLength(1);
    expect(ws.filter((l) => /\/rows\//.test(l))).toHaveLength(3);
  });

  it('no Status row in the template: no Status is written', async () => {
    const r = await call('create_resource', {
      name: 'Margin Note',
      template: T.note,
      parent: 'Kumikas',
      facts: { Scope: 'A note' },
    });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    expect(facts(w, r.body.pages[0].id)).toEqual(['Reference Type=', 'Scope=A note']);
    expect(r.body.pages[0].statusNote).toBeUndefined();
  });

  it('refuses a character template, an index template, a duplicate, a page that is not an index, and a parent outside', async () => {
    expect(
      (await call('create_resource', { name: 'X', template: T.core, parent: 'Humans' })).body.error.code,
    ).toBe('CHARACTER_TEMPLATE');
    expect(
      (await call('create_resource', { name: 'X', template: T.index, parent: 'Humans' })).body.error.code,
    ).toBe('INDEX_TEMPLATE');
    expect(
      (await call('create_resource', { name: 'hollow court', template: T.general, parent: 'Kumikas' })).body
        .error.code,
    ).toBe('PAGE_EXISTS');
    expect(
      (await call('create_resource', { name: 'X', template: T.general, parent: 'World Maps' })).body.error
        .code,
    ).toBe('PARENT_NOT_INDEX');
    expect(
      (await call('create_resource', { name: 'X', template: T.general, parent: 'outside1' })).body.error.code,
    ).toBe('NOT_IN_REPOSITORY');
    expect(
      (await call('create_resource', { name: 'X', template: 'No Such Template', parent: 'Kumikas' })).body
        .error.code,
    ).toBe('TEMPLATE_NOT_FOUND');
  });

  it('a bare page: the name as given, its prefix by the registry’s rule; anything else refused', async () => {
    const r = await call('create_bare_resource', { name: '[INDEX] Coasts', parent: 'Locations' });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    // Locations' indexes are out of order in the fixture (Kumikas, Isar): a new page lands next to its correct
    // neighbour all the same (before Isar), and nothing else is moved.
    expect(childNames(w, 'locs0001').slice(0, 3)).toEqual([
      '[INDEX] Kumikas',
      '[INDEX] Coasts',
      '[INDEX] Isar',
    ]);
    expect(writes().filter((l) => l === 'POST /resources').length).toBeGreaterThan(0);
    for (const bad of [
      'Coasts Two',
      '[index] Coasts Two',
      '[BSRC]Coasts',
      '[BSRC] [BSRC] Coasts',
      '[INDEX] ',
    ])
      expect(
        (await call('create_bare_resource', { name: bad, parent: 'Locations' })).body.error.code,
        bad,
      ).toBe('INVALID_NAME');
  });

  it('a dry run writes nothing', async () => {
    const before = writes().length;
    const r = await call('create_resource', {
      name: 'Dry Court',
      template: T.general,
      parent: 'Kumikas',
      dryRun: true,
    });
    expect(r.body).toMatchObject({ status: 'dry_run', pages: [{ name: '[BSRC] Dry Court' }] });
    expect(writes().length).toBe(before);
  });
});

describe('create_many_resources', () => {
  it('templates and nesting together: a template page under a new index, a bare page under it', async () => {
    const r = await call('create_many_resources', {
      items: [
        { key: 'idx', name: '[INDEX] Mixed Batch', parent: 'Sources' },
        {
          key: 'src',
          name: 'Mixed Source',
          template: T.general,
          parent_key: 'idx',
          facts: { Scope: 'Mixed' },
        },
        { key: 'leaf', name: '[BSRC] Mixed Leaf', parent_key: 'src' },
        { key: 'b', name: '[BSRC] Another Leaf', parent_key: 'idx' },
      ],
    });
    expect(r.body, r.text.slice(0, 3000)).toMatchObject({ status: 'written', verified: true });
    const byName = Object.fromEntries(r.body.pages.map((p: { name: string; id: string }) => [p.name, p.id]));
    expect(childNames(w, byName['[INDEX] Mixed Batch'])).toEqual([
      '[BSRC] Another Leaf',
      '[BSRC] Mixed Source',
    ]);
    expect(childNames(w, byName['[BSRC] Mixed Source'])).toEqual(['[BSRC] Mixed Leaf']);
    expect(facts(w, byName['[BSRC] Mixed Source'])).toContain('Status=Working');
    expect(node(byName['[BSRC] Mixed Source'])).toMatchObject({ templateId: T.general });
  });

  it('refuses the 101st item, a bad parent_key and a loop before anything is sent', async () => {
    const before = w.seen.length;
    const many = Array.from({ length: 101 }, (_, i) => ({
      key: `k${i}`,
      name: `[BSRC] Too Many ${i}`,
      parent: 'Sources',
    }));
    const r = await call('create_many_resources', { items: many });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/100/);
    const bad = await call('create_many_resources', {
      items: [
        { key: 'a', name: 'Child', template: T.general, parent_key: 'nope' },
        { key: 'b', name: '[BSRC] B', parent: 'Sources' },
      ],
    });
    expect(bad.body.error).toMatchObject({ code: 'PARENT_KEY_NOT_FOUND', parent_key: 'nope' });
    const loop = await call('create_many_resources', {
      items: [
        { key: 'a', name: '[BSRC] A', parent_key: 'b' },
        { key: 'b', name: '[BSRC] B', parent_key: 'a' },
      ],
    });
    expect(loop.body.error.code).toBe('PARENT_KEY_LOOP');
    // Nothing reached LegendKeeper (not even the templates' reads).
    expect(w.seen.length).toBe(before);
  });
});

describe('update_resource and move_resource', () => {
  it('a rename keeps the prefix and re-places the page among its siblings in the same job', async () => {
    const r = await call('update_resource', { page: '[INDEX] Group 0', name: 'Zz Group' });
    expect(r.body, r.text).toMatchObject({
      status: 'written',
      verified: true,
      changes: { name: { before: '[INDEX] Group 0', after: '[INDEX] Zz Group' } },
    });
    expect(r.body.changes.place).toBeDefined();
    const kids = childNames(w, 'srcs0001').filter((n) => n.startsWith('[INDEX]'));
    expect(kids.at(-1)).toBe('[INDEX] Zz Group');
    expect(node('grp00000')).toMatchObject({ rawName: '[INDEX] Zz Group', kind: 'index' });
  });

  it('refuses a rename to a sibling’s name, and a change of prefix', async () => {
    expect((await call('update_resource', { page: 'Zz Group', name: 'Group 1' })).body.error.code).toBe(
      'NAME_TAKEN',
    );
    expect(
      (await call('update_resource', { page: 'Zz Group', name: '[BSRC] Zz Group' })).body.error.code,
    ).toBe('PREFIX_CHANGE');
  });

  it('tags, aliases, hidden and locked; an unchanged request sends nothing', async () => {
    const r = await call('update_resource', {
      page: 'ashg0001',
      tags: { add: ['port', 'walled'] },
      aliases: { add: ['Ash Gate'] },
      locked: true,
    });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    expect(w.repo.res.get('ashg0001')).toMatchObject({
      tags: ['port', 'walled'],
      aliases: ['Ash Gate'],
      isLocked: true,
    });
    const same = await call('update_resource', { page: 'ashg0001', tags: { add: ['port'] } });
    expect(same.body.status).toBe('no_change');
    const rm = await call('update_resource', { page: 'ashg0001', tags: { remove: ['PORT'] } });
    expect(rm.body.status).toBe('written');
    expect(w.repo.res.get('ashg0001')!.tags).toEqual(['walled']);
  });

  it('moves a page to a new parent in its alphabetical place; refuses a cycle and a destination outside', async () => {
    const r = await call('move_resource', { page: '[BSRC] Plot Board', to: 'Locations' });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true });
    // After the alphabetically last index (Kumikas): Locations' indexes are out of order in the fixture, and a page
    // lands next to its correct neighbour by the rule (A3), whatever the others' positions.
    const loc = childNames(w, 'locs0001');
    expect(loc[loc.indexOf('[INDEX] Kumikas') + 1]).toBe('[BSRC] Plot Board');
    expect(node('board001')).toMatchObject({ parentId: 'locs0001' });
    expect((await call('move_resource', { page: 'Locations', to: 'Kumikas' })).body.error.code).toBe(
      'MOVE_CYCLE',
    );
    expect((await call('move_resource', { page: 'Kumikas', to: 'outside1' })).body.error.code).toBe(
      'NOT_IN_REPOSITORY',
    );
    expect((await call('move_resource', { page: 'ashg0002', to: 'Kumikas' })).body.error.code).toBe(
      'NAME_TAKEN',
    );
  });
});

describe('delete_resource and restore_resource', () => {
  it('needs confirm; a page with children needs cascade, and the result lists every page removed', async () => {
    const noConfirm = await call('delete_resource', { page: 'Mixed Batch' });
    expect(noConfirm.isError).toBe(true);
    const kids = await call('delete_resource', { page: 'Mixed Batch', confirm: true });
    expect(kids.body.error).toMatchObject({ code: 'HAS_CHILDREN' });
    expect(kids.body.error.under).toHaveLength(3);
    const r = await call('delete_resource', { page: 'Mixed Batch', confirm: true, cascade: true });
    expect(r.body, r.text).toMatchObject({ status: 'written', verified: true, cascade: true });
    expect(r.body.removed.map((x: { name: string }) => x.name)).toEqual([
      '[INDEX] Mixed Batch',
      '[BSRC] Another Leaf',
      '[BSRC] Mixed Source',
      '[BSRC] Mixed Leaf',
    ]);
    const id = r.body.page.id;
    expect(node(id)).toBeNull();
    // The journal keeps the page and its subtree as the pre-image.
    const j = await call('bridge_journal_lookup', { jobId: r.body.jobId, includePreImage: true });
    expect(JSON.stringify(j.body)).toContain('Mixed Leaf');
    // Restored with its cascade, back in the tree, with no canonical approval.
    const back = await call('restore_resource', { page: id });
    expect(back.body, back.text).toMatchObject({ status: 'written', verified: true });
    expect(node(id)).toMatchObject({ rawName: '[INDEX] Mixed Batch' });
    expect(childNames(w, id)).toHaveLength(2);
  });

  it('restore refuses a page the bridge has no record of, and a page that is not deleted', async () => {
    expect((await call('restore_resource', { page: 'zzzz0000' })).body.error.code).toBe('NOT_IN_REPOSITORY');
    expect((await call('restore_resource', { page: 'ashg0001' })).body.error.code).toBe('NOT_DELETED');
  });

  it('deleting an Authoritative page is a canonical proposal at scope write; restoring needs none', async () => {
    const r = await call('delete_resource', { page: '[BSRC] Inae Mikumo', confirm: true });
    expect(r.body, r.text).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
    expect(r.body.reason).toMatch(/deleting “Inae Mikumo”, whose Status is Authoritative/);
    expect(w.repo.live('inae0001')).toBeDefined();
    const id = String(r.body.proposalId);
    await expect(w.stack.runtime.policy.commands.approve('owner', id)).rejects.toMatchObject({
      code: 'CANONICAL_APPROVAL_REQUIRED',
    });
    await w.stack.runtime.policy.commands.approveAsCanon('owner', id);
    expect((await settle(id)).state).toBe('executed');
    expect(w.repo.live('inae0001')).toBeUndefined();
    const back = await call('restore_resource', { page: 'inae0001' });
    expect(back.body, back.text).toMatchObject({ status: 'written', verified: true });
    expect(w.repo.live('inae0001')).toBeDefined();
  });

  it('a cascade holding an Authoritative page is a canonical proposal listing it; a dry run says so', async () => {
    const dry = await call('delete_resource', { page: 'Elves', confirm: true, cascade: true, dryRun: true });
    expect(dry.body).toMatchObject({ status: 'dry_run', requiresCanonicalApproval: true });
    const r = await call('delete_resource', { page: 'Elves', confirm: true, cascade: true });
    expect(r.body, r.text).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
    const p = proposals().detail(String(r.body.proposalId))!;
    expect(JSON.stringify(p.canonical)).toContain('Inae Mikumo');
    expect(w.repo.live('elves001')).toBeDefined();
    w.stack.runtime.policy.commands.reject('owner', String(r.body.proposalId), 'kept');
  });

  it('a plain delete (nothing protected) goes through with confirm alone', async () => {
    const r = await call('delete_resource', { page: 'Margin Note', confirm: true });
    expect(r.body, r.text).toMatchObject({
      status: 'written',
      verified: true,
      removed: [{ name: '[BSRC] Margin Note' }],
    });
  });
});

describe('Status and canon on create', () => {
  it('a create with Status Authoritative is a canonical proposal; accepted as canon it is written with its ids', async () => {
    const r = await call('create_resource', {
      name: 'Canon Court',
      template: T.general,
      parent: 'Kumikas',
      facts: { Status: 'Authoritative' },
    });
    expect(r.body, r.text).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
    const planned = r.body.pages[0].id;
    expect(w.repo.res.get(planned)).toBeUndefined();
    const id = String(r.body.proposalId);
    const view = proposals().detail(id)!;
    expect(view.pageSummary[0]!.label).toBe('New page [BSRC] Canon Court under [INDEX] Kumikas: 1 fact');
    await w.stack.runtime.policy.commands.approveAsCanon('owner', id);
    expect((await settle(id)).state).toBe('executed');
    expect(facts(w, planned)).toContain('Status=Authoritative');
  });

  it('another Status the agent passes is written as given', async () => {
    const r = await call('create_resource', {
      name: 'Archive Court',
      template: T.general,
      parent: 'Kumikas',
      facts: { Status: 'Archived' },
    });
    expect(r.body, r.text).toMatchObject({ status: 'written' });
    expect(facts(w, r.body.pages[0].id)).toContain('Status=Archived');
  });
});
