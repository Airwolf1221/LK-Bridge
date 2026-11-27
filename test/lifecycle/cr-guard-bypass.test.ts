/**
 * Security review (cr): MCP write paths. Each test asserts the SAFE behaviour. v3 F12 (ADR 0081): at scope `write` a
 * canon change (a delete of an Authoritative page, a Status leaving Authoritative) is direct, so the attacks on the
 * canon guard are made at scope `propose`, where canon must still become a CANONICAL proposal; the lifecycle guard's
 * refusals hold at every scope.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { L, LIFECYCLE, lifecycleWorld, type LifecycleWorld } from './world.js';
import { facts, SidebarModel } from '../resources/world.js';

let w: LifecycleWorld;
let client: Client;
let proposer: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(client, tool, { project: 'test', ...args });
const propose = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(proposer, tool, { project: 'test', ...args });

beforeAll(async () => {
  w = await lifecycleWorld({
    seed: (world) => {
      // A plain index the tree knows, with nothing protected under it when the tree is built.
      world.repo.seed({ id: 'staging1', name: '[INDEX] Staging', parentId: 'locs0001' });
    },
  });
  client = await w.stack.connect();
  proposer = await w.stack.connect(w.stack.newToken('cr-guard-propose', 'propose').token);
});
afterAll(async () => w.close());

describe('cascade delete and the canon guard', () => {
  it('a cascade delete whose subtree gained an Authoritative page since the tree was last read needs canonical approval', async () => {
    // The owner adds a canon page under Staging in the LegendKeeper app; the bridge's tree has not swept since.
    w.repo.seed({ id: 'canonch1', name: '[BSRC] Canon Child', parentId: 'staging1' });
    w.sidebars.page('canonch1', [
      SidebarModel.kv('kvcanch1', 'PROPERTIES', [
        ['Reference Type', 'General Source'],
        ['Status', 'Authoritative'],
      ]),
    ]);
    expect(w.stack.runtime.tree.queries.node('proj_mock', 'canonch1').data).toBeNull();

    // An agent at scope propose deletes the parent with cascade.
    const r = await propose('lk_api_write', {
      operationId: 'deleteResource',
      params: { path: { resourceId: 'staging1' }, query: { cascade: true } },
      confirm: 'cascade',
    });
    // SAFE: canonical proposal; nothing deleted.
    expect(r.body, r.text).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
    expect(w.repo.live('canonch1')).toBeDefined();
  });
});

describe('moves and the lifecycle guard', () => {
  it('moving a page out of [INDEX] Archived is refused even when the tree has not seen it there yet', async () => {
    // The owner archives a page by hand in the LegendKeeper app; the tree has not swept since.
    w.repo.seed({ id: 'oldfort1', name: '[BARC] Old Fort', parentId: LIFECYCLE.archived });
    expect(w.stack.runtime.tree.queries.node('proj_mock', 'oldfort1').data).toBeNull();
    const r = await call('lk_api_write', {
      operationId: 'moveResource',
      params: { path: { resourceId: 'oldfort1' }, body: { parentId: 'locs0001' } },
    });
    // SAFE: refused, naming unarchive_page; the page stays in the archive.
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toMatch(/unarchive_page/);
    expect(w.repo.live('oldfort1')!.parentId).toBe(LIFECYCLE.archived);
  });
});

describe('a template copy with includeChildren', () => {
  it('copying a template whose DESCENDANT is Authoritative (or [BARC]) is judged like creating those pages', async () => {
    // A template tree: a plain top page, with a canon child and an archived-looking child (templates sit outside the root).
    w.repo.seed({ id: 'tplbund1', name: '[BSRC] AI Bundle', parentId: null, props: false });
    w.repo.seed({ id: 'tplcanc1', name: '[BSRC] Canon Seed', parentId: 'tplbund1', props: false });
    w.repo.seed({ id: 'tplarch1', name: '[BARC] Relic', parentId: 'tplbund1', props: false });
    w.sidebars.page('tplbund1', [SidebarModel.kv('kvbund01', 'PROPERTIES', [['Scope', '']])]);
    w.sidebars.page('tplcanc1', [
      SidebarModel.kv('kvcanc01', 'PROPERTIES', [
        ['Status', 'Authoritative'],
        ['Continuity Type', 'CANON'],
      ]),
    ]);
    w.sidebars.page('tplarch1', [SidebarModel.kv('kvarch01', 'PROPERTIES', [['Status', 'Archived']])]);
    // LegendKeeper copies every descendant's properties too (the world's mock copies only the top page's sidebar).
    const key = [...w.overrides.keys()].find((k) => k.source.includes('from-template'))!;
    const inner = w.overrides.get(key)!;
    w.overrides.set(key, (req) => {
      const r = inner(req);
      if (r?.status === 201) {
        const copyKids = (tplId: string, copyId: string) => {
          const ts = w.repo.children(tplId);
          const cs = w.repo.children(copyId);
          ts.forEach((t, i) => {
            const src = w.sidebars.pages.get(t.id);
            if (src && cs[i]) w.sidebars.pages.set(cs[i].id, structuredClone(src));
            if (cs[i]) copyKids(t.id, cs[i].id);
          });
        };
        copyKids(
          String((req.body as { templateId: string }).templateId),
          String((r.body as { id: string }).id),
        );
      }
      return r;
    });
    const before = [...w.repo.res.values()].filter((x) => x.deletedAt === null).length;
    const r = await call('lk_api_write', {
      operationId: 'createResourceFromTemplate',
      params: {
        body: { templateId: 'tplbund1', name: 'Bundle Copy', parentId: 'locs0001', includeChildren: true },
      },
    });
    const made = [...w.repo.res.values()].filter((x) => x.deletedAt === null).length - before;
    const canon = [...w.repo.res.values()].find(
      (x) => x.deletedAt === null && x.name === '[BSRC] Canon Seed' && x.id !== 'tplcanc1',
    );
    const relic = [...w.repo.res.values()].find(
      (x) => x.deletedAt === null && x.name === '[BARC] Relic' && x.id !== 'tplarch1',
    );
    // SAFE: nothing is created without the owner's canonical approval (a canonical proposal, or a refusal).
    expect(
      { made, canonCopy: canon ? facts(w, canon.id) : null, relicCopy: relic?.parentId ?? null },
      r.text,
    ).toEqual({ made: 0, canonCopy: null, relicCopy: null });
  });
});

describe('the entry check simulates a batch; an agent controls a template copy’s id', () => {
  it('a template copy given an EXISTING page’s id cannot blind the canon and lifecycle guards to a later Status write', async () => {
    const prop = w.sidebars.pages.get(L.harbour)!.props[0]!;
    const statusRow = prop.rows!.find((r) => r.key === 'Status')!.id;
    // The agent reads the rows' version, as any agent can.
    const read = await call('lk_api_read', {
      operationId: 'listPropertyRows',
      params: { path: { resourceId: L.harbour, propertyId: prop.id } },
      detail: 'full',
    });
    const version = String((read.body.result as { version?: string }).version);
    expect(version).toMatch(/^v\d+$/);
    expect(facts(w, L.harbour)).toContain('Status=Authoritative');

    const r = await propose('lk_api_batch', {
      onError: 'continue',
      calls: [
        // Fails at LegendKeeper (409 DUPLICATE_ID), but the guards' simulation now treats Old Harbour as a blank copy.
        {
          operationId: 'createResourceFromTemplate',
          params: { body: { templateId: L.template, id: L.harbour, name: 'Decoy', parentId: 'locs0001' } },
        },
        // Status Authoritative -> Draft on the real canon page, with the version the agent read (so no read in the lock).
        {
          operationId: 'updatePropertyRow',
          params: {
            path: { resourceId: L.harbour, propertyId: prop.id, rowId: statusRow },
            ifMatch: version,
            body: { content: [{ text: 'Draft' }] },
          },
        },
      ],
    });
    if (r.body.jobId) await w.stack.runtime.engine.wait('proj_mock', String(r.body.jobId), 10_000);
    // SAFE: a canonical proposal (or a refusal); canon unchanged.
    expect(facts(w, L.harbour)).toContain('Status=Authoritative');
    expect(r.body, r.text).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
  });

  it('the same trick archives a page by hand (lifecycle guard), without archive_page', async () => {
    const prop = w.sidebars.pages.get(L.guild)!.props[0]!;
    const statusRow = prop.rows!.find((r) => r.key === 'Status')!.id;
    const version = `v${w.sidebars.pages.get(L.guild)!.version}`;
    const r = await call('lk_api_batch', {
      onError: 'continue',
      calls: [
        {
          operationId: 'createResourceFromTemplate',
          params: { body: { templateId: L.template, id: L.guild, name: 'Decoy', parentId: 'locs0001' } },
        },
        {
          operationId: 'updatePropertyRow',
          params: {
            path: { resourceId: L.guild, propertyId: prop.id, rowId: statusRow },
            ifMatch: version,
            body: { content: [{ text: 'Archived' }] },
          },
        },
      ],
    });
    if (r.body.jobId) await w.stack.runtime.engine.wait('proj_mock', String(r.body.jobId), 10_000);
    // SAFE: refused (POLICY_DENIED naming archive_page) or a canonical proposal; the page is still Authoritative.
    expect(facts(w, L.guild)).toContain('Status=Authoritative');
    expect(facts(w, L.guild)).not.toContain('Status=Archived');
  });
});
