/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- parsed JSON tool results */
/**
 * Adversarial review of the lifecycle guard (ADR 0035, decisions 2, 3, 5, 7, 11, 12, 14). Each test asserts the SAFE
 * behaviour, so each one fails on the code as it stands: an agent at scope `write` makes a lifecycle change (Working /
 * Archived) without the four lifecycle tools and their canonical approval, or corrupts the lifecycle machinery.
 *
 * Mock LegendKeeper only (test/lifecycle/world.ts); nothing here calls a real service.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { P } from '../resources/world.js';
import { ROOT } from '../discover/world.js';
import { L, LIFECYCLE, lifecycleWorld, type LifecycleWorld } from './world.js';

type Obj = Record<string, unknown>;

let w: LifecycleWorld;
let writer: Client;
const call = (tool: string, args: Record<string, unknown>) =>
  w.stack.call(writer, tool, { project: 'test', ...args });
const LOCS = 'locs0001';

/** Waits for a job to finish; its final status. */
async function settle(jobId: string): Promise<string> {
  for (let i = 0; i < 300; i++) {
    const j = w.stack.runtime.engine.queries.getJob(PROJECT, jobId);
    if (j && ['succeeded', 'failed', 'cancelled'].includes(j.status)) return j.status;
    await new Promise((res) => setTimeout(res, 20));
  }
  return 'timeout';
}

/** A tool answer as `refused` (POLICY_DENIED), or what happened instead. */
async function outcome(r: { body: Obj; text: string }): Promise<string> {
  const err = r.body.error as { code?: string } | undefined;
  if (err?.code === 'POLICY_DENIED') return 'refused';
  if (err) return `error ${err.code}`;
  if (typeof r.body.jobId === 'string') {
    return `job ${await settle(r.body.jobId)}`;
  }
  return `status ${String(r.body.status)}`;
}

/** Live pages of the AI REPOSITORY whose name starts with a lifecycle prefix but which are not directly under its index. */
const strays = (prefix: '[BWRK] ' | '[BARC] ', index: string) =>
  w.repo
    .subtree(ROOT)
    .filter((r) => r.name.startsWith(prefix) && r.parentId !== index)
    .map((r) => `${r.name} @ ${r.parentId ?? 'root'}`);

/** The Status values of a modelled page, as the bridge's own facts code reads them. */
const statusOf = (page: string) =>
  w.sidebars
    .rows(page)
    .filter((r) => r.key === 'Status')
    .map((r) => r.text);

/** A fresh world for each group of attacks (they change the lifecycle indexes and pages). */
async function freshWorld(): Promise<void> {
  w = await lifecycleWorld({ env: { MCP_EXPOSE_PER_OP_TOOLS: 'true' } });
  writer = await w.stack.connect();
  // LegendKeeper's saveResourceAsTemplate (not in the resource model): a top-level template copied from the resource,
  // its sidebar included (spec: "The copy takes the resource's fields, properties and documents").
  w.overrides.set(/\/resources\/[^/]+\/save-as-template$/, (req) => {
    if (req.method !== 'POST') return undefined;
    const src = /\/resources\/([^/]+)\/save-as-template$/.exec(req.path.replace(/\/$/, ''))![1]!;
    const s = w.repo.live(src);
    if (!s) return { status: 404, body: { code: 'NOT_FOUND', message: 'not found' } };
    const body = (req.body ?? {}) as { id?: string; name?: string };
    const id = body.id ?? 'tplsaved';
    const t = w.repo.seed({ id, name: body.name ?? s.name, parentId: null, props: false });
    const sb = w.sidebars.pages.get(src);
    if (sb) w.sidebars.pages.set(id, structuredClone(sb));
    return { status: 201, body: w.repo.resourceView(t) };
  });
}

beforeEach(freshWorld);
afterEach(async () => w.close());

describe('F1: createResourceFromTemplate / saveResourceAsTemplate are only half judged', () => {
  it('a template copy with no client id and no name makes a [BWRK] page with Status Working outside [INDEX] Working', async () => {
    // Step 1 turns the Working page into a template (never judged); step 2 copies it with neither `id` nor `name`: the
    // guard reads the name as '' (guard.ts:285) and records the template's Status only when body.id is set (guard.ts:325).
    const r = await call('lk_api_batch', {
      calls: [
        {
          operationId: 'saveResourceAsTemplate',
          params: { path: { resourceId: L.ferry }, body: { id: 'tplfry01' } },
        },
        {
          operationId: 'createResourceFromTemplate',
          params: { body: { templateId: 'tplfry01', parentId: LOCS } },
        },
      ],
    });
    const got = await outcome(r);
    const copy = [...w.repo.res.values()].find(
      (x) => x.deletedAt === null && x.parentId === LOCS && x.name === '[BWRK] Sky Ferry',
    );
    expect({
      outcome: got,
      bwrkOutsideWorking: strays('[BWRK] ', LIFECYCLE.working),
      copyStatus: copy ? statusOf(copy.id) : null,
      treeKind: copy ? w.stack.runtime.tree.queries.node(PROJECT, copy.id).data?.kind : null,
    }).toEqual({ outcome: 'refused', bwrkOutsideWorking: [], copyStatus: null, treeKind: null });
  });

  it('a template copy named [BSRC] with no client id still gets the template’s Status Archived', async () => {
    // An Archived template (as saveResourceAsTemplate of any [BARC] page makes one); the agent names the copy [BSRC]
    // and leaves out `id`: Status Archived is set on a new page with no lifecycle tool and no approval.
    w.repo.seed({ id: 'tplarc01', name: '[BARC] Old Design', parentId: null, props: false });
    w.sidebars.page('tplarc01', [
      {
        id: 'kvtarc01',
        kind: 'keyValue',
        title: 'PROPERTIES',
        rows: [{ id: 'kvtarc01r1', rank: 'a', key: 'Status', content: [{ text: 'Archived' }] }],
      },
    ] as never);
    const r = await call('lk_api_write', {
      operationId: 'createResourceFromTemplate',
      params: { body: { templateId: 'tplarc01', parentId: LOCS, name: '[BSRC] Fresh Copy' } },
    });
    const got = await outcome(r);
    const copy = [...w.repo.res.values()].find((x) => x.deletedAt === null && x.name === '[BSRC] Fresh Copy');
    expect({ outcome: got, status: copy ? statusOf(copy.id) : null }).toEqual({
      outcome: 'refused',
      status: null,
    });
  });

  it('includeChildren copies a template’s [BARC] descendants (and a second “[INDEX] Archived”) anywhere', async () => {
    // saveResourceAsTemplate of [INDEX] Archived with its children, then a copy with includeChildren under Locations.
    // Neither the template's children nor the copy's default name are judged.
    w.repo.seed({ id: 'oldbarc1', name: '[BARC] Old Ferry', parentId: LIFECYCLE.archived });
    w.repo.seed({ id: 'tplaix01', name: '[INDEX] Archived', parentId: null });
    w.repo.seed({ id: 'tplaix02', name: '[BARC] Old Ferry', parentId: 'tplaix01' });
    const r = await call('lk_api_write', {
      operationId: 'createResourceFromTemplate',
      params: { body: { templateId: 'tplaix01', parentId: LOCS, includeChildren: true } },
    });
    const got = await outcome(r);
    expect({
      outcome: got,
      barcOutsideArchived: strays('[BARC] ', LIFECYCLE.archived),
      lookup: w.stack.runtime.lifecycle.find(PROJECT).archived.status,
    }).toEqual({ outcome: 'refused', barcOutsideArchived: [], lookup: 'found' });
  });
});

describe('F2: a Status value that is a mention is read by its id at the guard, by its name everywhere else', () => {
  it('Status set to a mention of a page named “Archived” passes the guard, then reads as Archived', async () => {
    // LegendKeeper fills a mention's read-only `name` on read (spec: "`name` is the resource's current name; it is
    // read-only"). Modelled: every stored mention run gets the page's current name.
    const enrich = (content: Obj[] | undefined) => {
      for (const run of content ?? []) {
        const m = run.mention as Obj | undefined;
        if (m && typeof m.resourceId === 'string') m.name = w.repo.live(m.resourceId)?.name ?? m.resourceId;
      }
    };
    w.sidebars.mangle = (_req, sb) => {
      for (const p of sb.props) for (const row of p.rows ?? []) enrich(row.content);
    };
    // An ordinary unclassified page named “Archived” (allowed anywhere).
    const made = await call('lk_api_write', {
      operationId: 'createResource',
      params: { body: { id: 'arcword1', name: 'Archived', parentId: LOCS } },
    });
    expect(made.body.error, made.text).toBeUndefined();
    const rowId = w.sidebars.pages.get(P.miyabi)!.props[0]!.rows!.find((x) => x.key === 'Status')!.id;
    const r = await call('lk_api_write', {
      operationId: 'updatePropertyRow',
      params: {
        path: { resourceId: P.miyabi, propertyId: 'kvmiya01', rowId },
        body: { content: [{ mention: { resourceId: 'arcword1' } }] },
      },
    });
    const got = await outcome(r);
    w.sidebars.mangle = null;
    // What the bridge's own tools now believe: archive_page refuses the page as inconsistent ([BSRC] but Archived).
    const probe = await call('archive_page', { page: P.miyabi, dryRun: true });
    expect({ outcome: got, archiveProbe: probe.body.error?.code ?? probe.body.status }).toEqual({
      outcome: 'refused',
      archiveProbe: 'dry_run',
    });
  });
});

describe('F3: onError "continue" desynchronises the entry simulation; an explicit ifMatch then skips the in-lock check', () => {
  it('a failing step (stale If-Match) hides a Status → Archived row write that is never judged on the real rows', async () => {
    // Ashgate ([BSRC], no Status row). An allowed write first: Scope = “Archived” (not a Status row).
    const prop = 'kvashg01';
    const scopeRow = w.sidebars.pages.get(P.ashgate)!.props[0]!.rows!.find((x) => x.key === 'Scope')!.id;
    const pre = await call('lk_api_write', {
      operationId: 'updatePropertyRow',
      params: {
        path: { resourceId: P.ashgate, propertyId: prop, rowId: scopeRow },
        body: { text: 'Archived' },
      },
    });
    expect(pre.body.error, pre.text).toBeUndefined();
    const version = `v${w.sidebars.pages.get(P.ashgate)!.version}`;
    const path = { resourceId: P.ashgate, propertyId: prop, rowId: scopeRow };
    const r = await call('lk_api_batch', {
      onError: 'continue',
      calls: [
        // Simulated at entry as "Scope emptied"; sent with a stale If-Match, so LegendKeeper refuses it (412).
        { operationId: 'updatePropertyRow', params: { path, ifMatch: 'v999', body: { content: [] } } },
        // Simulated as "an empty row keyed Status" (no lifecycle change); really: Status = Archived. Its explicit
        // ifMatch means no in-lock read, so guard.ts:481 returns without judging it.
        { operationId: 'updatePropertyRow', params: { path, ifMatch: version, body: { key: 'Status' } } },
      ],
    });
    const got = await outcome(r);
    expect({ outcome: got, status: statusOf(P.ashgate) }).toEqual({ outcome: 'refused', status: [] });
  });
});

describe('F4: a move judges where the page is from the tree, never from LegendKeeper', () => {
  it('a [BWRK] page the tree has not seen yet is moved out of [INDEX] Working', async () => {
    // The owner makes a Working page by hand in the app; the hourly sweep has not run.
    const hand = w.repo.outside.create('[BWRK] Hand Draft', LIFECYCLE.working, { tags: ['Working'] });
    w.repo.outside.setRow(hand.id, 'Status', 'Working');
    const r = await call('lk_api_write', {
      operationId: 'moveResource',
      params: { path: { resourceId: hand.id }, body: { parentId: LOCS } },
    });
    const got = await outcome(r);
    expect({ outcome: got, parent: w.repo.live(hand.id)!.parentId }).toEqual({
      outcome: 'refused',
      parent: LIFECYCLE.working,
    });
  });
});

describe('F5: delete and restore are not judged by the lifecycle guard', () => {
  it('deleting [INDEX] Working (cascade) and restoring one page puts a [BWRK] page at the root, out of Working', async () => {
    // No canon rule protects Working pages, so the cascade delete runs directly at scope write. restoreResource of one
    // page whose parent is still deleted restores it at the root (spec), then the index is restored.
    const r = await call('lk_api_batch', {
      calls: [
        {
          operationId: 'deleteResource',
          params: { path: { resourceId: LIFECYCLE.working }, query: { cascade: true } },
          confirm: 'cascade',
        },
        { operationId: 'restoreResource', params: { path: { resourceId: L.ferry } } },
        { operationId: 'restoreResource', params: { path: { resourceId: LIFECYCLE.working } } },
      ],
    });
    const got = await outcome(r);
    const ferry = w.repo.live(L.ferry);
    expect({
      outcome: got,
      ferry: ferry ? `${ferry.name} @ ${ferry.parentId ?? 'root'}` : 'gone',
      ferryStatus: statusOf(L.ferry),
    }).toEqual({
      outcome: 'refused',
      ferry: `[BWRK] Sky Ferry @ ${LIFECYCLE.working}`,
      ferryStatus: ['Working'],
    });
  });
});

describe('F6: the confirmed lifecycle indexes themselves are not protected', () => {
  it('one rename of [INDEX] Working stops every lifecycle tool and every Working create, and a decoy is then “found”', async () => {
    const before = w.repo.live(LIFECYCLE.working)!.name;
    const rename = await call('lk_api_write', {
      operationId: 'updateResource',
      params: { path: { resourceId: LIFECYCLE.working }, body: { name: '[INDEX] Working (old)' } },
    });
    const renamed = await outcome(rename);
    const decoy = await call('lk_api_write', {
      operationId: 'createResource',
      params: { body: { id: 'decoywrk', name: '[INDEX] Working', parentId: LOCS } },
    });
    const decoyMade = await outcome(decoy);
    const create = await call('create_bare_resource', { name: '[BWRK] Harmless Draft' });
    const lookup = w.stack.runtime.lifecycle.find(PROJECT).working;
    // Put things back for any later test.
    w.repo.res.get(LIFECYCLE.working)!.name = before;
    expect({
      rename: renamed,
      decoy: decoyMade,
      workingCreate: create.body.error?.code ?? create.body.status,
      dashboardLookupFinds: lookup.status === 'found' ? lookup.node!.id : lookup.status,
    }).toEqual({
      rename: 'refused',
      decoy: 'refused',
      workingCreate: 'written',
      dashboardLookupFinds: LIFECYCLE.working,
    });
  });
});

describe('F7: moving a lifecycle index out of the repository makes the guard forget its pages', () => {
  it('[INDEX] Working moved outside the AI REPOSITORY and back: a [BWRK] page is moved out of Working in between', async () => {
    // The index itself is "not inside" its own area (settings.ts areaOf: n.id !== x), so moving it is no lifecycle change.
    // Outside the root the tree drops it and its pages, so the guard's areaOfPage (tree) answers null for them.
    const out = await call('lk_api_write', {
      operationId: 'moveResource',
      params: { path: { resourceId: LIFECYCLE.working }, body: { parentId: 'outside1' } },
    });
    const indexOut = await outcome(out);
    const forgotten = w.stack.runtime.tree.queries.node(PROJECT, L.ferry).data === null;
    const page = await call('lk_api_write', {
      operationId: 'moveResource',
      params: { path: { resourceId: L.ferry }, body: { parentId: LOCS } },
    });
    const pageOut = await outcome(page);
    const back = await call('lk_api_write', {
      operationId: 'moveResource',
      params: { path: { resourceId: LIFECYCLE.working }, body: { parentId: ROOT } },
    });
    const indexBack = await outcome(back);
    const ferry = w.repo.live(L.ferry)!;
    // Either fix is safe: refuse moving the confirmed index, or judge the page's place live (not from the tree).
    expect(
      { pageOut, ferry: `${ferry.name} @ ${ferry.parentId}`, ferryStatus: statusOf(L.ferry) },
      JSON.stringify({ indexOut, treeForgotFerry: forgotten, indexBack }),
    ).toEqual({
      pageOut: 'refused',
      ferry: `[BWRK] Sky Ferry @ ${LIFECYCLE.working}`,
      ferryStatus: ['Working'],
    });
  });
});

describe('F8: the prefix is matched exactly; a name LegendKeeper (or a reader) would take as [BARC] is not', () => {
  it('if LegendKeeper trims names, “ [BARC] …” (leading space) renames a [BSRC] page to [BARC] with no lifecycle tool', async () => {
    // CONDITIONAL: the spec does not say whether names are trimmed. The guard classifies the requested name exactly
    // (classifyName: startsWith('[BARC] ')), the tree classifies what LegendKeeper stores: any normalisation between
    // the two (trim, zero-width removal, NFKC) turns a name the guard saw as unclassified into a lifecycle prefix.
    w.repo.nameFilter = (n) => n.trim();
    const r = await call('lk_api_write', {
      operationId: 'updateResource',
      params: { path: { resourceId: L.tides }, body: { name: ' [BARC] Tide Tables' } },
    });
    const got = await outcome(r);
    w.repo.nameFilter = (n) => n;
    expect({
      outcome: got,
      name: w.repo.live(L.tides)!.name,
      treeKind: w.stack.runtime.tree.queries.node(PROJECT, L.tides).data?.kind,
    }).toEqual({ outcome: 'refused', name: '[BSRC] Tide Tables', treeKind: 'bsrc' });
  });
});

describe('F9: a lookalike lifecycle prefix takes a page out of [BSRC] and reads as [BARC] in LegendKeeper', () => {
  it('lk_api_write renames [BSRC] Tide Tables to “[barc] …”, “[BARC]Tide…”, zero-width, NBSP, fullwidth or Cyrillic forms', async () => {
    // prefixChange(bsrc, unclassified) is null (guard.ts:127-129): neither side is [BWRK]/[BARC] by the exact match, so
    // the page silently leaves [BSRC] (the bridge then calls it unclassified; the lifecycle tools refuse it) while
    // LegendKeeper shows a name a reader takes as archived. update_resource refuses most of these names (cleanPrefixes
    // is case-insensitive), so the low-level route is the way through.
    const ch = (code: number) => String.fromCharCode(code);
    const names = [
      '[barc] Tide Tables', // lower case
      '[BARC]Tide Tables', // no space
      `${ch(0x200b)}[BARC] Tide Tables`, // zero-width space first
      `[BARC]${ch(0xa0)}Tide Tables`, // no-break space
      `${ch(0xff3b)}BARC${ch(0xff3d)} Tide Tables`, // fullwidth brackets
      `[B${ch(0x410)}RC] Tide Tables`, // Cyrillic A
    ];
    const results: string[] = [];
    for (const name of names) {
      const r = await call('lk_api_write', {
        operationId: 'updateResource',
        params: { path: { resourceId: L.tides }, body: { name } },
      });
      results.push(await outcome(r));
    }
    const probe = await call('archive_page', { page: L.tides, dryRun: true });
    expect({
      results,
      kind: w.stack.runtime.tree.queries.node(PROJECT, L.tides).data?.kind,
      archiveProbe: probe.body.error?.code ?? probe.body.status,
    }).toEqual({
      results: names.map(() => 'refused'),
      kind: 'bsrc',
      archiveProbe: 'dry_run',
    });
  });
});

describe('F10 (canon, decision 5): an Authoritative page created through the low-level route is no canonical proposal', () => {
  it('lk_api_write createResource “[BSRC] …” with the CANON tag is written directly at scope write', async () => {
    // create_resource / create_bare_resource with status "authoritative" are canonical proposals (createMarker); the
    // lifecycle guard sees no lifecycle change in a [BSRC] create and the canon guard judges only template copies.
    // C2d (ADR 0036 decision 7, accepted): a create body that adds the CANON status tag is refused outright, naming the
    // tool; the same create without it is the canonical proposal of decision 1 (accepted).
    const tagged = await call('lk_api_write', {
      operationId: 'createResource',
      params: { body: { name: '[BSRC] Instant Canon', parentId: LOCS, tags: ['CANON'] } },
    });
    expect(tagged.isError, tagged.text).toBe(true);
    expect(tagged.text).toMatch(/status tag CANON would be added — use promote_page/);
    // v3 F12 (ADR 0081): at scope propose it is that canonical proposal; at scope write a new Authoritative page is
    // direct (a job on the Review page).
    const proposer = await w.stack.connect(w.stack.newToken('f10-propose', 'propose').token);
    const p = await w.stack.call(proposer, 'lk_api_write', {
      project: 'test',
      operationId: 'createResource',
      params: { body: { name: '[BSRC] Instant Canon', parentId: LOCS } },
    });
    expect({ status: p.body.status, canonical: p.body.requiresCanonicalApproval ?? false }, p.text).toEqual({
      status: 'proposal_captured',
      canonical: true,
    });
    w.stack.runtime.policy.commands.reject('owner', String(p.body.proposalId), 'not now');
    const r = await call('lk_api_write', {
      operationId: 'createResource',
      params: { body: { name: '[BSRC] Instant Canon', parentId: LOCS } },
    });
    expect({ status: r.body.status, canonical: r.body.requiresCanonicalApproval ?? false }, r.text).toEqual({
      status: 'succeeded',
      canonical: false,
    });
  });
});
