/* eslint-disable @typescript-eslint/no-explicit-any -- LK results are untyped JSON */
/**
 * v3 F6d (ADR 0082; design T13 as amended on 26 November 2026), opt-in, WRITES then cleans up: templated source names on
 * a throwaway index, the report, the code `name_nontemplated` at Propose (one proposal, one item, approved) and at Apply
 * (a second page), everything read back live. Written for the owner; never run by an agent or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f6d-names
 *
 * It runs on a temporary database that starts as a READ-ONLY copy of the project's settings, repository tree and packs
 * from the bridge's database (`copyBridgeState`); it never writes to the bridge's database. The Arkona pack's governance
 * is pointed, in the TEMPORARY database only, at a throwaway governance page under the check's own index
 * (`ensureSandboxGovernance`, always), and the vocabulary is published THERE (never to the project's own Source
 * Formatting). Each step reports PASS or FAIL:
 *
 * - **N0** a throwaway index `[INDEX] lk-bridge f6d check <time>`, its governance page, the pack approved;
 * - **N1** four sources in it: one templated already (`<S> - Polity`), one to rename, one with no Subject, one with a
 *   specialist type; the specialist type recorded and the vocabulary published to the throwaway page, the pack approved
 *   again (temporary database); swept;
 * - **N2** a snapshot of only these pages;
 * - **N3** the audit, then the report's rows: templated, rename, held_no_subject, exempt_specialist;
 * - **N4** the code at Propose: ONE proposal with ONE item, approved (as canon: an Authoritative page's rename);
 * - **N5** a second page to rename, snapshotted and audited; the code at Apply: ONE direct job (an Authoritative page's
 *   rename included: the owner's ruling of the F6d follow-up), read back;
 * - **N6** read back live: the two new names, and the templated, no-Subject and specialist pages unchanged.
 *
 * Clean-up: the throwaway index deleted with everything under it, even after a failure or a step's timeout, and again
 * from the test file's `afterAll`. Cost: about 25 writes and 70 reads.
 */
import { ProjectStore } from '../../src/projects/index.js';
import type { RawLk } from './f4b-probe.js';
import { deleteProbe } from './f4b-probe.js';
import { ensureSandboxGovernance } from './governance.js';
import { snapshotPagesOnly } from './page-snapshot.js';
import type { SoakRuntime } from './soak.js';
import { sandboxRun, type SandboxRun } from './steps.js';
import { waitForJob, type WaitOptions } from './wait.js';
import { copyBridgeState } from './write-scope.js';

type Obj = Record<string, any>;
export interface NamesCheckItem {
  readonly id: string;
  readonly title: string;
  readonly verdict: 'pass' | 'fail';
  readonly detail: string;
}

const CODE = 'name_nontemplated';

export async function runNamesCheck(
  sb: SoakRuntime,
  raw: RawLk,
  name: string,
  o: { readonly bridgeDbPath: string; readonly run?: SandboxRun; readonly wait?: WaitOptions },
): Promise<NamesCheckItem[]> {
  const steps = o.run ?? sandboxRun({ name: 'f6d-names', out: () => undefined });
  const rt = sb.runtime;
  const pid = sb.projectId;
  const items: NamesCheckItem[] = [];
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
  if (!copied.packs.includes('arkona') || !pack?.rules.templatedNames) {
    items.push({
      id: 'N0',
      title: 'the Arkona pack, with templated names, is attached to this project',
      verdict: 'fail',
      detail: `packs attached: ${copied.packs.join(', ') || 'none'}; deploy F6d (the seed arkona-2026-11-29-f6d) first`,
    });
    return items;
  }
  const rootId = (new ProjectStore(sb.db).byId(pid)?.settings as Obj | undefined)?.aiRepositoryRootId as
    string | undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tag = stamp.slice(11, 19).replace(/-/g, '');
  const made: { index: string | null } = { index: null };
  const page: Record<string, string> = {};
  const subject = (k: string) => `Lkb${k}${tag}`;
  const specialistType = `Lkb Charter ${tag} Reference`;
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
  const approveAndWait = async (proposalId: string, what: string, only?: string[]): Promise<string> => {
    const p = rt.policy.proposals.get(proposalId)!;
    const opts = only ? { items: only } : undefined;
    if (p.requiresCanonicalApproval) await rt.policy.commands.approveAsCanon('owner', p.id, opts);
    else await rt.policy.commands.approve('owner', p.id, opts);
    let jobId: string | null = null;
    for (let i = 0; i < 600 && !jobId; i++) {
      jobId = rt.policy.proposals.get(p.id)?.jobId ?? null;
      if (!jobId) await new Promise((res) => setTimeout(res, 200));
    }
    if (!jobId) throw new Error(`${what}: the approved proposal made no job`);
    const job = await waitForJob(rt.engine, pid, jobId, what, o.wait);
    if (job.status !== 'succeeded')
      throw new Error(`${what}: job ${jobId} ${job.status} ${JSON.stringify(job.lastError)}`);
    return `proposal ${p.id}${p.requiresCanonicalApproval ? ' (approved as canon)' : ''}, job ${jobId}`;
  };
  const mkSource = async (key: string, n: string, rows: { key: string; text: string }[]) => {
    const r = await raw.request('createResource', 'POST', '/resources', {
      name: n,
      parentId: made.index,
      tags: ['CANON', 'Polity'],
    });
    page[key] = String(r.id);
    await raw.request('createProperty', 'POST', `/resources/${String(r.id)}/properties`, {
      kind: 'keyValue',
      title: 'PROPERTIES',
      rows: [{ key: 'Status', text: 'Authoritative' }, { key: 'Continuity Type', text: 'CANON' }, ...rows],
    });
    return page[key];
  };
  const sweep = async () => {
    await rt.tree.sweep(pid, 'manual');
    await rt.tree.whenIdle();
    for (const id of Object.values(page)) {
      const n = rt.tree.queries.node(pid, id).data;
      if (!n) throw new Error(`the tree's sweep did not find ${id}`);
      if (n.propertiesPending) throw new Error(`the tree has not read ${id}'s sidebar`);
    }
  };
  const snapshot = () => snapshotPagesOnly(sb, [made.index!, ...Object.values(page)], 'f6d-names');
  const auditAndRows = async () => {
    await snapshot();
    const r = await rt.audits.run(pid, 'manual');
    if (r.state !== 'succeeded') throw new Error(`the audit ${r.state}: ${r.summary}`);
    const mine = new Set(Object.values(page));
    return rt.templatedNames.report(pid, { limit: 500 }).rows.filter((x) => mine.has(x.pageId));
  };
  const runAt = async (mode: 'propose' | 'apply') => {
    await rt.automation.setMode('owner', pid, CODE, mode);
    const run = await rt.automation.run(pid, 'manual');
    return {
      run,
      items: rt.automation.store.items(run.id).filter((i) => i.code === CODE),
    };
  };
  try {
    const ok0 = await check(
      'N0',
      'a throwaway index and governance page; the pack approved (temporary database)',
      async () => {
        const index = await raw.request('createResource', 'POST', '/resources', {
          name: `[INDEX] lk-bridge f6d check ${stamp}`,
          ...(rootId ? { parentId: rootId } : {}),
        });
        made.index = String(index.id);
        // The vocabulary's section pinned in its source (as the F6a seed pins it), temporary database only: a copy whose
        // pack was stored before F6a's seed would otherwise never read the published section.
        const rtRules = rt.packs.get('arkona')!.rules.referenceTypes;
        if (rtRules) {
          const gov = rt.packs.get('arkona')!.governance;
          if (gov.some((x) => x.key === rtRules.source && !(x.sections ?? []).includes(rtRules.section)))
            rt.packs.store.setGovernance(
              'arkona',
              gov.map((x) =>
                x.key === rtRules.source ? { ...x, sections: [...(x.sections ?? []), rtRules.section] } : x,
              ),
            );
        }
        const g = await ensureSandboxGovernance({
          rt,
          raw,
          projectName: name,
          packId: 'arkona',
          parentId: made.index,
          label: `lk-bridge f6d governance ${stamp}`,
          always: true,
        });
        return `index ${made.index}; ${g.detail}`;
      },
    );
    if (!ok0) return items;

    const ok1 = await check(
      'N1',
      'four sources (templated, to rename, no Subject, a specialist type); the vocabulary published to the throwaway page',
      async () => {
        await mkSource('templated', `[BSRC] ${subject('Ost')} - Polity`, [
          { key: 'Reference Type', text: 'Polity Reference' },
          { key: 'Subject', text: subject('Ost') },
        ]);
        await mkSource('rename', `[BSRC] ${subject('Falk')} Polity Reference`, [
          { key: 'Reference Type', text: 'Polity Reference' },
          { key: 'Subject', text: subject('Falk') },
        ]);
        await mkSource('noSubject', `[BSRC] ${subject('Mith')} Polity Notes`, [
          { key: 'Reference Type', text: 'Polity Reference' },
        ]);
        await mkSource('specialist', `[BSRC] ${subject('Charter')} Charter`, [
          { key: 'Reference Type', text: specialistType },
          { key: 'Subject', text: subject('Charter') },
        ]);
        await sweep();
        await rt.referenceTypes.prepare(pid);
        rt.referenceTypes.decide('owner', pid, {
          value: specialistType,
          category: 'Polity',
          action: 'specialist',
          scope: 'pages',
          reason: 'the F6d sandbox check',
        });
        const pub = await rt.referenceTypes.publish('owner', pid);
        if (!pub.jobId) throw new Error('the vocabulary was not published');
        const job = await waitForJob(rt.engine, pid, pub.jobId, 'the vocabulary', o.wait);
        if (job.status !== 'succeeded') throw new Error(`publish: job ${pub.jobId} ${job.status}`);
        // The governance check the publication starts (background), then the new version approved as the owner would.
        // Every source points at the one throwaway page, so the publication reads as drift on each: approved, then the
        // offered version (the section as the authority) approved, as the owner would on the Packs page.
        await rt.referenceTypes.settled();
        let g = await rt.packs.governance('arkona');
        for (
          let i = 0;
          i < 3 && rt.packs.approvedRules('arkona')?.referenceTypes?.status !== 'published';
          i++
        ) {
          await rt.packs.commands.approve('owner', 'arkona').catch(() => undefined);
          g = await rt.packs.governance('arkona');
        }
        const status = rt.packs.approvedRules('arkona')?.referenceTypes?.status;
        if (status !== 'published')
          throw new Error(
            `the vocabulary is ${status ?? 'missing'} after publishing (governance ${g.state}: ${g.message}; its vocabulary ${JSON.stringify(g.referenceTypes ?? null)})`,
          );
        return `${Object.keys(page).length} pages; vocabulary published to the throwaway page (job ${pub.jobId})`;
      },
    );
    if (!ok1) return items;

    const ok2 = await check('N2', 'a snapshot of only these pages', snapshot);
    if (!ok2) return items;

    const ok3 = await check('N3', 'the audit, then the report’s rows', async () => {
      const rows = await auditAndRows();
      const by = (k: string) => rows.find((r) => r.pageId === page[k]);
      const want: Record<string, string> = {
        templated: 'templated',
        rename: 'rename',
        noSubject: 'held_no_subject',
        specialist: 'exempt_specialist',
      };
      const lines = rows.map(
        (r) => `ROW ${r.rawName} status=${r.status} → ${r.proposed ?? '-'} (${r.reason})`,
      );
      for (const [k, s] of Object.entries(want))
        if (by(k)?.status !== s)
          throw new Error(`${k}: ${by(k)?.status ?? 'no row'}, not ${s}\n${lines.join('\n')}`);
      if (by('rename')?.proposed !== `[BSRC] ${subject('Falk')} - Polity`)
        throw new Error(`the proposed name: ${by('rename')?.proposed ?? 'none'}`);
      return lines.join('\n        ');
    });
    if (!ok3) return items;

    const ok4 = await check('N4', 'the code at Propose: ONE proposal with ONE item, approved', async () => {
      const { run, items: its } = await runAt('propose');
      const mine = its.filter((i) => i.pageId === page.rename);
      if (its.length !== 1 || mine.length !== 1 || !mine[0]!.proposalId)
        throw new Error(
          `run ${run.id} (${run.summary}): ${its.map((i) => `${i.pageId} ${i.outcome}`).join('; ')}`,
        );
      const its2 = rt.policy.proposals.itemsOf(mine[0]!.proposalId)?.items ?? [];
      if (its2.length !== 1) throw new Error(`the proposal has ${its2.length} items`);
      return `run ${run.id}; ${await approveAndWait(mine[0]!.proposalId, 'the Propose run')}`;
    });
    if (!ok4) return items;

    const ok5 = await check('N5', 'a second page to rename; the code at Apply', async () => {
      await mkSource('second', `[BSRC] ${subject('Vald')} Overview`, [
        { key: 'Reference Type', text: 'Polity Reference' },
        { key: 'Subject', text: subject('Vald') },
      ]);
      await sweep();
      const rows = await auditAndRows();
      const row = rows.find((r) => r.pageId === page.second);
      if (row?.status !== 'rename') throw new Error(`the second page: ${row?.status ?? 'no row'}`);
      const { run, items: its } = await runAt('apply');
      await rt.automation.setMode('owner', pid, CODE, 'off');
      const it = its.find((i) => i.pageId === page.second);
      if (!it) throw new Error(`run ${run.id} (${run.summary}) took no item for the second page`);
      // The owner's ruling (F6d follow-up): an Authoritative page's rename at Apply is ONE direct job, no proposal.
      if (it.outcome === 'applied' && it.proposalId === null)
        return `run ${run.id}: job ${it.jobId} (Apply, direct), read back`;
      throw new Error(`run ${run.id}: ${it.outcome} ${it.reasonCode ?? ''} ${it.reason ?? ''}`);
    });
    if (!ok5) return items;

    await check('N6', 'read back live: the two new names; the others unchanged', async () => {
      const get = async (id: string) => await raw.request('getResource', 'GET', `/resources/${id}`);
      const want: Record<string, string> = {
        rename: `[BSRC] ${subject('Falk')} - Polity`,
        second: `[BSRC] ${subject('Vald')} - Polity`,
        templated: `[BSRC] ${subject('Ost')} - Polity`,
        noSubject: `[BSRC] ${subject('Mith')} Polity Notes`,
        specialist: `[BSRC] ${subject('Charter')} Charter`,
      };
      const out: string[] = [];
      for (const [k, n] of Object.entries(want)) {
        const r = await get(page[k]!);
        if (r.name !== n) throw new Error(`${k}: “${String(r.name)}”, expected “${n}”`);
        out.push(`"${String(r.name)}"`);
      }
      return `LIVE ${out.join('; ')}`;
    });
  } finally {
    await steps.cleanup();
  }
  return items;
}

/** The report as the real run prints it: every item whole. */
export function formatNamesReport(items: readonly NamesCheckItem[]): string {
  return [
    '',
    'LK-Bridge sandbox: templated source names (F6d, ADR 0082)',
    ...items.map((i) => `[${i.verdict.toUpperCase()}] (${i.id}) ${i.title}\n        ${i.detail}`),
    '',
  ].join('\n');
}
