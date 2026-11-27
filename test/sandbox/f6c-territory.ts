/* eslint-disable @typescript-eslint/no-explicit-any -- LK results are untyped JSON */
/**
 * v3 F6c (ADR 0080; design T3 to T5), opt-in, WRITES then cleans up: a throwaway territory and nation, the seed of the
 * Territory and Nation types, the owner's Nation Subindexes decisions, the two renames and the two category indexes
 * applied as the automation's Apply submits them, everything read back live. Written for the owner; never run by an
 * agent or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f6c-territory
 *
 * It runs on a temporary database that starts as a READ-ONLY copy of the project's settings, repository tree and packs
 * from the bridge's database (`copyBridgeState`); it never writes to the bridge's database. The Arkona pack's governance
 * is pointed, in the TEMPORARY database only, at a throwaway governance page under the check's own index
 * (`ensureSandboxGovernance`). Each step reports PASS or FAIL:
 *
 * - **T0** a throwaway index `[INDEX] lk-bridge f6c check <time>`, its governance page, the pack approved (temporary
 *   database);
 * - **T1** inside it `[NAV] Arkona’s Continents` (the pack's continents parent) and a territory `[INDEX] lk-bridge f6c
 *   territory <time>` with the governance's required categories except Unique Magic & Technologies (and no Religions,
 *   which is recognised but never required), its Historical Events without Conflicts;
 *   in its Polities a nation `[INDEX] lk-bridge f6c nation <time>` with three children: `[NAV] Government &
 *   Institutions`, `[NAV] Military & Naval Affairs` and a subject index; swept and snapshotted (only these pages);
 * - **T2** the classification approved for the territory, the nation and the first child (temporary database); the
 *   Territory and Nation types seeded (or "Add missing", when the copy has them seeded already);
 * - **T3** the decisions (temporary database): accept the first child; map the second to Military & Technology; the third
 *   not a subindex; the nation's short name set;
 * - **T4** the audit: `nation_subindex_nonstandard` ×2 and `territory_category_missing` ×2 (Unique Magic & Technologies,
 *   and Conflicts inside Historical Events) applied as the automation's Apply submits them;
 * - **T5** read back live: `<Short> Government & Administration` and `<Short> Military & Technology`, the two new [NAV]
 *   category indexes where they belong, and their role bindings.
 *
 * Clean-up: the throwaway index deleted with everything under it (its governance page included), even after a failure
 * or a step's timeout, and again from the test file's `afterAll`. Cost: about 25 writes and 60 reads.
 */
import { ProjectStore } from '../../src/projects/index.js';
import { AUTOMATION_PRINCIPAL } from '../../src/jobs/types.js';
import type { RawLk } from './f4b-probe.js';
import { deleteProbe } from './f4b-probe.js';
import { ensureSandboxGovernance } from './governance.js';
import { snapshotPagesOnly } from './page-snapshot.js';
import type { SoakRuntime } from './soak.js';
import { sandboxRun, type SandboxRun } from './steps.js';
import { waitForJob, type WaitOptions } from './wait.js';
import { copyBridgeState } from './write-scope.js';

type Obj = Record<string, any>;
export interface TerritoryCheckItem {
  readonly id: string;
  readonly title: string;
  readonly verdict: 'pass' | 'fail';
  readonly detail: string;
}

export async function runTerritoryCheck(
  sb: SoakRuntime,
  raw: RawLk,
  name: string,
  o: { readonly bridgeDbPath: string; readonly run?: SandboxRun; readonly wait?: WaitOptions },
): Promise<TerritoryCheckItem[]> {
  const steps = o.run ?? sandboxRun({ name: 'f6c-territory', out: () => undefined });
  const rt = sb.runtime;
  const pid = sb.projectId;
  const items: TerritoryCheckItem[] = [];
  const check = async (id: string, title: string, fn: () => Promise<string>): Promise<boolean> => {
    try {
      items.push({ id, title, verdict: 'pass', detail: await steps.step(id, title, fn) });
      return true;
    } catch (e) {
      items.push({ id, title, verdict: 'fail', detail: e instanceof Error ? e.message : String(e) });
      return false;
    }
  };
  const copied = copyBridgeState({
    bridgeDbPath: o.bridgeDbPath,
    target: sb.db,
    projectId: pid,
    runtime: rt,
    registry: true,
  });
  const pack = rt.packs.get('arkona');
  if (!copied.packs.includes('arkona') || !pack?.rules.indexTaxonomy?.nationRoles) {
    items.push({
      id: 'T0',
      title: 'the Arkona pack, with its nation roles, is attached to this project',
      verdict: 'fail',
      detail: `packs attached: ${copied.packs.join(', ') || 'none'}; deploy F6c (the seed arkona-2026-11-27-f6c) first`,
    });
    return items;
  }
  const rootId = (new ProjectStore(sb.db).byId(pid)?.settings as Obj | undefined)?.aiRepositoryRootId as
    string | undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const short = `lkb f6c ${stamp.slice(11, 19)}`;
  const made: { index: string | null } = { index: null };
  const page: Record<string, string> = {};
  steps.defer('the throwaway index deleted with everything under it', async () => {
    if (!made.index) return;
    try {
      await deleteProbe(raw, made.index);
    } catch (e) {
      items.push({
        id: 'cleanup',
        title: 'the throwaway index deleted',
        verdict: 'fail',
        detail: `${made.index}: ${(e as Error).message}. Delete it by hand.`,
      });
      throw e;
    }
  });
  const approveAndWait = async (proposalId: string, what: string): Promise<string> => {
    const p = rt.policy.proposals.get(proposalId)!;
    if (p.requiresCanonicalApproval) await rt.policy.commands.approveAsCanon('owner', p.id);
    else await rt.policy.commands.approve('owner', p.id);
    let jobId: string | null = null;
    for (let i = 0; i < 600 && !jobId; i++) {
      jobId = rt.policy.proposals.get(p.id)?.jobId ?? null;
      if (!jobId) await new Promise((res) => setTimeout(res, 200));
    }
    if (!jobId) throw new Error(`${what}: the approved proposal made no job`);
    const job = await waitForJob(rt.engine, pid, jobId, what, o.wait);
    if (job.status !== 'succeeded')
      throw new Error(`${what}: job ${jobId} ${job.status} ${JSON.stringify(job.lastError)}`);
    return `proposal ${p.id}, job ${jobId}`;
  };
  /** As the automation's Apply submits a proposal-first code's fix: a direct job, every guard allowing or refusing it. */
  const apply = async (code: string, f: { id: number }): Promise<string> => {
    // As the automation's Apply submits it: the Automation principal's maintenance origin with its Apply marker (the
    // owner's ruling, F6d follow-up: direct, canon included).
    const r = await rt.audits.proposeFix('automation', pid, f.id, {
      direct: true,
      origin: {
        kind: 'maintenance',
        client: 'automation',
        tool: `automation.${code}`,
        principal: AUTOMATION_PRINCIPAL,
        automationApply: true,
      },
    });
    if (r.status === 'job_submitted') {
      const job = await waitForJob(rt.engine, pid, r.jobId, code, o.wait);
      if (job.status !== 'succeeded')
        throw new Error(`${code}: job ${r.jobId} ${job.status} ${JSON.stringify(job.lastError)}`);
      return `${code}: job ${r.jobId} (Apply)`;
    }
    if (r.status === 'proposal_captured')
      return `${code}: a guard made it a proposal; ${await approveAndWait(r.proposalId, code)}`;
    throw new Error(`${code}: ${r.status}`);
  };
  const open = (code: string) =>
    rt.audits.store.list(pid, { code: [code], state: 'open', limit: 500 }).findings;
  const territoryName = `lk-bridge f6c territory ${stamp}`;
  const nationName = `lk-bridge f6c nation ${stamp}`;
  const snapshot = () => snapshotPagesOnly(sb, [made.index!, ...Object.values(page)], 'f6c-territory');
  try {
    const ok0 = await check(
      'T0',
      'a throwaway index and governance page; the pack approved (temporary database)',
      async () => {
        const index = await raw.request('createResource', 'POST', '/resources', {
          name: `[INDEX] lk-bridge f6c check ${stamp}`,
          ...(rootId ? { parentId: rootId } : {}),
        });
        made.index = String(index.id);
        const g = await ensureSandboxGovernance({
          rt,
          raw,
          projectName: name,
          packId: 'arkona',
          parentId: made.index,
          label: `lk-bridge f6c governance ${stamp}`,
          always: true,
        });
        return `index ${made.index}; ${g.detail}`;
      },
    );
    if (!ok0) return items;

    const ok1 = await check(
      'T1',
      'a territory with every REQUIRED category but Unique Magic & Technologies (Historical Events without Conflicts), a nation with three children',
      async () => {
        const mk = async (key: string, n: string, parentId: string, tags: string[]) => {
          page[key] = String(
            (await raw.request('createResource', 'POST', '/resources', { name: n, parentId, tags })).id,
          );
          return page[key];
        };
        const continents = await mk('continents', '[NAV] Arkona’s Continents', made.index!, ['Navigation']);
        const t = await mk('territory', `[INDEX] ${territoryName}`, continents, ['Place']);
        for (const c of [
          'Polities',
          'Cultures',
          'Historical Events',
          'Institutions',
          'Regions',
          'Settlements & Locations',
        ])
          await mk(`cat:${c}`, `[NAV] ${territoryName} ${c}`, t, ['Navigation']);
        const n = await mk('nation', `[INDEX] ${nationName}`, page['cat:Polities']!, ['Polity']);
        await mk('gov', '[NAV] Government & Institutions', n, ['Navigation']);
        await mk('mil', '[NAV] Military & Naval Affairs', n, ['Navigation']);
        await mk('subject', `[INDEX] lk-bridge f6c subject ${stamp}`, n, ['Place']);
        await rt.tree.sweep(pid, 'manual');
        await rt.tree.whenIdle();
        for (const id of Object.values(page))
          if (!rt.tree.queries.node(pid, id).data) throw new Error(`the tree's sweep did not find ${id}`);
        return `${Object.keys(page).length} pages; ${await snapshot()}`;
      },
    );
    if (!ok1) return items;

    const ok2 = await check(
      'T2',
      'the classification approved; Territory and Nation seeded (temporary database)',
      async () => {
        await rt.indexClassify.prepare(pid);
        for (const id of [page.territory!, page.nation!, page.gov!]) {
          const row = rt.indexClassify.row(pid, id);
          if (!row || row.proposed === 'undecided')
            throw new Error(`${id}: no rule proposes a role (${row?.why ?? 'not in the report'})`);
          rt.indexClassify.decide('owner', pid, {
            pageId: id,
            action: 'approve',
            reason: 'the F6c sandbox check',
          });
        }
        await rt.indexClassify.prepare(pid);
        const store = rt.registry.forProject(pid).store;
        const out: string[] = [];
        for (const kind of ['territory', 'nation'] as const) {
          const seeded = store.typeByKind(kind)?.taxonomySeededAt != null;
          const r = rt.nationTaxonomy.seed('owner', pid, kind, seeded ? 'add_missing' : 'seed');
          out.push(
            `${kind}: ${seeded ? 'add missing' : 'seed'}, ${r.created.length} new, ${r.bound.length} bound`,
          );
        }
        const t = store.entryBySource(page.territory!);
        const n = store.entryBySource(page.nation!);
        if (!t || !n) throw new Error(`entries: territory ${t?.id ?? 'none'}, nation ${n?.id ?? 'none'}`);
        if (store.binding(t.id, 'Historical Events')?.nodeId !== page['cat:Historical Events'])
          throw new Error('the territory’s Historical Events is not bound');
        return out.join('; ');
      },
    );
    if (!ok2) return items;

    const ok3 = await check('T3', 'the decisions and the short name (temporary database)', async () => {
      await rt.nationTaxonomy.prepare(pid);
      const reason = 'the F6c sandbox check';
      rt.nationTaxonomy.decide('owner', pid, { pageId: page.gov!, action: 'accept', reason });
      rt.nationTaxonomy.decide('owner', pid, {
        pageId: page.mil!,
        action: 'map',
        role: 'Military & Technology',
        reason,
      });
      rt.nationTaxonomy.decide('owner', pid, { pageId: page.subject!, action: 'not_subindex', reason });
      const e = rt.registry.forProject(pid).store.entryBySource(page.nation!)!;
      rt.registry.forProject(pid).commands.updateEntry('owner', e.id, { shortName: short });
      const rows = rt.nationTaxonomy.report(pid, { nationId: page.nation! }).rows;
      return rows
        .map((r) => `ROW ${r.name} status=${r.status} role=${r.role ?? '-'} → ${r.proposedName ?? '-'}`)
        .join('\n        ');
    });
    if (!ok3) return items;

    const ok4 = await check(
      'T4',
      'the audit: nation_subindex_nonstandard ×2 and territory_category_missing ×2 applied (the automation’s Apply)',
      async () => {
        await snapshot();
        await rt.audits.run(pid, 'manual');
        const renames = open('nation_subindex_nonstandard').filter(
          (f) => f.pageId === page.gov || f.pageId === page.mil,
        );
        const missing = open('territory_category_missing').filter((f) => f.pageId === page.territory);
        const cats = missing.map((f) => String(f.evidence.category)).sort();
        if (renames.length !== 2) throw new Error(`${renames.length} rename finding(s), expected 2`);
        if (cats.join(', ') !== 'Conflicts, Unique Magic & Technologies')
          throw new Error(`missing categories: ${cats.join(', ') || 'none'}`);
        const out: string[] = [];
        for (const f of [...renames, ...missing]) out.push(await apply(f.code, f));
        await rt.tree.whenIdle();
        return out.join('; ');
      },
    );
    if (!ok4) return items;

    await check(
      'T5',
      'read back live: the names, the new [NAV] category indexes and their bindings',
      async () => {
        const get = async (id: string) => await raw.request('getResource', 'GET', `/resources/${id}`);
        const gov = await get(page.gov!);
        const mil = await get(page.mil!);
        if (gov.name !== `[NAV] ${short} Government & Administration`)
          throw new Error(`gov: ${String(gov.name)}`);
        if (mil.name !== `[NAV] ${short} Military & Technology`) throw new Error(`mil: ${String(mil.name)}`);
        const kids = async (id: string) =>
          ((await raw.request('listResources', 'GET', `/resources?parentId=${id}&limit=100`)).data ??
            []) as Obj[];
        const umt = (await kids(page.territory!)).find(
          (x) => x.name === `[NAV] ${territoryName} Unique Magic & Technologies`,
        );
        const conflicts = (await kids(page['cat:Historical Events']!)).find(
          (x) => x.name === `[NAV] ${territoryName} Conflicts`,
        );
        if (!umt || !conflicts)
          throw new Error(`made: UM&T ${umt?.id ?? 'missing'}, Conflicts ${conflicts?.id ?? 'missing'}`);
        const store = rt.registry.forProject(pid).store;
        const t = store.entryBySource(page.territory!)!;
        const b1 = store.binding(t.id, 'Unique Magic & Technologies')?.nodeId;
        const b2 = store.binding(t.id, 'Conflicts')?.nodeId;
        if (b1 !== umt.id || b2 !== conflicts.id)
          throw new Error(`bindings: UM&T ${b1 ?? 'none'}, Conflicts ${b2 ?? 'none'}`);
        return `LIVE "${String(gov.name)}"; "${String(mil.name)}"; "${String(umt.name)}" (bound); "${String(conflicts.name)}" in Historical Events (bound)`;
      },
    );
  } finally {
    await steps.cleanup();
  }
  return items;
}

/** The report as the real run prints it: every item whole. */
export function formatTerritoryReport(items: readonly TerritoryCheckItem[]): string {
  return [
    '',
    'LK-Bridge sandbox: territories, nations and their subindexes (F6c, ADR 0080)',
    ...items.map((i) => `[${i.verdict.toUpperCase()}] (${i.id}) ${i.title}\n        ${i.detail}`),
    '',
  ].join('\n');
}
