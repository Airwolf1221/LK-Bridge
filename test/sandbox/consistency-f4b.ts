/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- LK results are untyped JSON */
/**
 * v3 F4b (ADR 0064), opt-in, WRITES then cleans up: the consistency check and "Pick the right value" end to end on the
 * real API. Written for the owner; never run by an agent or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- consistency-f4b
 *
 * It runs on a temporary database that starts as a READ-ONLY copy of the project's settings, repository tree and setting
 * packs from the bridge's database (as the write-scope rehearsal does: `copyBridgeState`), so the Arkona pack attached to
 * the test world and its consistency rules apply; it never writes to the bridge's database and never reads another
 * project. Each step reports PASS, FAIL or NOTED:
 *
 * - **F1** the calendar: the chronology's calendar read (one request), as the chronology tools keep it;
 * - **F2** two pages that restate one birth differently: a throwaway Character Core `[BSRC] F4b Probe <time> - Character
 *   Core` (Temporal Scope "Born Camue 1st, 4A 100") and a plain page saying "F4b Probe <time> was born on Camue 1st, 4A
 *   103.", under one plain throwaway index `lk-bridge f4b check <time>`. They are made with the sandbox's RAW client
 *   (the governor paces and counts them; no job, proposal or guard of the bridge is involved), as the assumptions checks
 *   make theirs: the Core is canon, which the bridge's governed route rightly refuses to make (the owner's sandbox run of
 *   20 November 2026). A tree sweep then shows them to the bridge;
 * - **F3** a full snapshot, then `arkona_consistency` for the probe: one Contradictory finding, the Core's value first;
 * - **F4** the owner's pick of the Core's value: ONE proposal with one item (the restating page), the Core untouched;
 * - **F5** approved, its job succeeds, and the page read live says "Camue 1st, 4A 100" in that sentence, the rest as it
 *   was; the Core's Temporal Scope is unchanged;
 * - **F6** the check run again over the job's change snapshot finds the pages agreeing.
 *
 * Clean-up: the throwaway index is deleted with everything under it (cascade), with the raw client, even after a failure;
 * the report names it if it must be deleted by hand. Cost: a full snapshot of the test world (its pages' reads), about 12 writes and 15 other
 * reads.
 *
 * The thin wrapper for the real run is `consistency-f4b.test.ts`; the ordinary suite runs these steps against the mock in
 * `test/sandbox-mock/consistency-f4b.test.ts`.
 */
import type { OpParams, StepOptions } from '../../src/jobs/index.js';
import { ProjectStore } from '../../src/projects/store.js';
import type { SoakRuntime } from './soak.js';
import { copyBridgeState } from './write-scope.js';
import { createProbePages, deleteProbe, type RawLk } from './f4b-probe.js';
import { notSucceeded, wholeError } from './whole.js';

type Obj = Record<string, any>;

export interface ConsistencyCheckItem {
  readonly id: string;
  readonly title: string;
  readonly verdict: 'pass' | 'fail' | 'noted';
  readonly detail: string;
}
type Item = ConsistencyCheckItem;

/**
 * The check's steps (F1 to F6), for the real run (`consistency-f4b.test.ts`) and, CR-2026-11-R4 (the owner's request S),
 * the ordinary suite's run against the mock (`test/sandbox-mock/consistency-f4b.test.ts`), through the same runtime and
 * harness. `bridgeDbPath`: the bridge's database the state is copied from, read-only.
 */
export async function runConsistencyCheck(
  sb: SoakRuntime,
  raw: RawLk,
  o: { readonly bridgeDbPath: string },
): Promise<ConsistencyCheckItem[]> {
  const rt = sb.runtime;
  const pid = sb.projectId;
  const items: Item[] = [];
  const record = (id: string, title: string, verdict: Item['verdict'], detail: string) =>
    items.push({ id, title, verdict, detail });
  const origin = { kind: 'test' as const, client: 'sandbox', tool: 'consistency-f4b' };
  const run = async (op: string, params: OpParams, options: StepOptions = {}) => {
    const r = await rt.engine.run(op, params, { project: pid, origin, priority: 'P1', ...options });
    if (r.status !== 'succeeded') throw notSucceeded(op, r);
    return r.result as Obj;
  };
  const check = async (id: string, title: string, fn: () => Promise<string>): Promise<boolean> => {
    try {
      record(id, title, 'pass', await fn());
      return true;
    } catch (e) {
      record(id, title, 'fail', wholeError(e));
      return false;
    }
  };
  const copied = copyBridgeState({
    bridgeDbPath: o.bridgeDbPath,
    target: sb.db,
    projectId: pid,
    runtime: rt,
  });
  if (!copied.packs.includes('arkona')) {
    record(
      'F0',
      'the Arkona pack is attached to this project',
      'fail',
      `packs attached: ${copied.packs.join(', ') || 'none'}`,
    );
    return items;
  }
  const rootId = (new ProjectStore(sb.db).byId(pid)?.settings as Obj | undefined)?.aiRepositoryRootId as
    string | undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const subject = `F4b Probe ${stamp}`;
  // Assigned inside the steps' closures (a holder, so the clean-up sees it).
  const made: { index: string | null } = { index: null };
  let coreId = '';
  let pageId = '';
  let pageDoc = '';
  try {
    const ok1 = await check(
      'F1',
      'the chronology’s calendar, read as the chronology tools keep it',
      async () => {
        const calendarId = rt.chronology.config(pid).calendarId;
        if (!calendarId) throw new Error('the chronology’s calendar is not confirmed on this project');
        const list = ((await run('listCalendars', {})).data ?? []) as Obj[];
        const def = list.find((c) => c.id === calendarId);
        if (!def) throw new Error(`calendar ${calendarId} not found`);
        rt.chronology.remember(pid, def);
        return `calendar ${calendarId}`;
      },
    );
    if (!ok1) return items;

    const ok2 = await check('F2', 'two pages restating one birth with different dates', async () => {
      // The owner's sandbox run of 20 November 2026: the Core is canon, so the governed route (rightly) refuses to make
      // it. The probe's pages are made with the raw client, as the assumptions checks make theirs (f4b-probe.ts).
      const probe = await createProbePages(raw, {
        rootId,
        stamp,
        subject,
        made: (id) => {
          made.index = id;
        },
      });
      coreId = probe.core;
      pageId = probe.page;
      pageDoc = probe.pageDoc;
      // The bridge did not make them, so its tree learns of them from a sweep (one listing of the project).
      await rt.tree.sweep(pid, 'manual');
      await rt.tree.whenIdle();
      if (!rt.tree.queries.node(pid, coreId).data)
        throw new Error(`the tree's sweep did not find the probe's Core ${coreId}`);
      return `index ${made.index}, Core ${coreId}, restatement ${pageId} (made with the raw client)`;
    });
    if (!ok2) return items;

    let findingId = '';
    let side = '';
    const ok3 = await check(
      'F3',
      'a full snapshot, then arkona_consistency finds one Contradictory birth',
      async () => {
        await rt.snapshots.full(pid, 'manual');
        await rt.appraisal.index.settled();
        const report = await rt.consistency.run({ projectId: pid, subject: coreId, actor: 'owner' });
        const f = report.findings.find((x) => x.group === 'contradictory' && x.check === 'consistency_birth');
        if (!f) throw new Error(`no Contradictory birth: ${JSON.stringify(report.counts)}`);
        const d = f.details as Obj;
        if (d.reference.value !== 'Camue 1st, 4A 100' || d.restatements[0]?.value !== 'Camue 1st, 4A 103')
          throw new Error(
            `unexpected values: ${JSON.stringify([d.reference.value, (d.restatements as Obj[]).map((r) => r.value as unknown)])}`,
          );
        findingId = f.id;
        side = d.reference.key as string;
        return `${f.id}: ${f.message}`;
      },
    );
    if (!ok3) return items;

    let proposalId = '';
    const ok4 = await check(
      'F4',
      'the owner’s pick of the Core’s value: ONE proposal, one item, the Core untouched',
      async () => {
        const r = await rt.consistency.pick({
          projectId: pid,
          identityPageId: coreId,
          continuity: 'Main CANON',
          findingId,
          side,
          actor: 'owner',
        });
        const its = r.items as Obj[];
        if (its.length !== 1 || its[0]!.page.id !== pageId) throw new Error(`items: ${JSON.stringify(its)}`);
        proposalId = String(r.proposalId);
        return `proposal ${proposalId}`;
      },
    );
    if (!ok4) return items;

    await check('F5', 'approved: the job succeeds and only the date in the sentence changes', async () => {
      await rt.policy.commands.approve('owner', proposalId);
      let job: ReturnType<typeof rt.engine.queries.getJob>;
      for (let i = 0; i < 600; i++) {
        const p = rt.policy.proposals.get(proposalId);
        job = p?.jobId ? rt.engine.queries.getJob(pid, p.jobId) : undefined;
        if (job && ['succeeded', 'failed', 'cancelled'].includes(String(job.status))) break;
        await new Promise((res) => setTimeout(res, 500));
      }
      if (job?.status !== 'succeeded')
        throw new Error(`the job ${String(job?.id)} is ${String(job?.status)}`);
      const back = await run('getDocumentBlocks', { path: { resourceId: pageId, documentId: pageDoc } });
      const text = JSON.stringify(back.blocks ?? []);
      if (!text.includes(`${subject} was born on Camue 1st, 4A 100, in the harbour quarter.`))
        throw new Error(`the sentence reads ${text}`);
      if (!text.includes('This line stays as it is.')) throw new Error('the other line changed');
      const core = await run('getResource', { path: { resourceId: coreId } });
      if (!JSON.stringify(core.properties ?? []).includes('Born Camue 1st, 4A 100'))
        throw new Error('the Core changed');
      return `job ${String(job.id)}`;
    });

    await check('F6', 'the check over the job’s change snapshot finds the pages agreeing', async () => {
      await rt.snapshots.settled();
      const report = await rt.consistency.run({ projectId: pid, subject: coreId, actor: 'owner' });
      const open = report.findings.filter((x) => x.check === 'consistency_birth');
      if (open.length > 0) throw new Error(`still: ${open.map((x) => x.message).join(' | ')}`);
      return 'no birth finding';
    });
  } finally {
    if (made.index)
      try {
        await deleteProbe(raw, made.index);
      } catch (e) {
        record(
          'cleanup',
          'the throwaway index deleted',
          'fail',
          `${made.index}: ${wholeError(e)}. Delete it by hand.`,
        );
      }
  }
  return items;
}

/** The report as the real run prints it: every item whole (CR-2026-11-R4: never a slice of what LegendKeeper answered). */
export function formatConsistencyReport(items: readonly ConsistencyCheckItem[]): string {
  const mark = { pass: 'PASS', fail: 'FAIL', noted: 'NOTED' } as const;
  return [
    '',
    'LK-Bridge sandbox: the consistency check and "Pick the right value" (F4b, ADR 0064)',
    '====================================================================================',
    ...items.map((i) => `[${mark[i.verdict]}] (${i.id}) ${i.title}\n        ${i.detail}`),
    '',
  ].join('\n');
}
