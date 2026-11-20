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
 *   103.", under one plain throwaway index `lk-bridge f4b check <time>`;
 * - **F3** a full snapshot, then `arkona_consistency` for the probe: one Contradictory finding, the Core's value first;
 * - **F4** the owner's pick of the Core's value: ONE proposal with one item (the restating page), the Core untouched;
 * - **F5** approved, its job succeeds, and the page read live says "Camue 1st, 4A 100" in that sentence, the rest as it
 *   was; the Core's Temporal Scope is unchanged;
 * - **F6** the check run again over the job's change snapshot finds the pages agreeing.
 *
 * Clean-up: the throwaway index is deleted with everything under it (cascade), even after a failure; the report names it
 * if it must be deleted by hand. Cost: a full snapshot of the test world (its pages' reads), about 12 writes and 15 other
 * reads.
 */
import { describe, expect, it } from 'vitest';
import type { OpParams, StepOptions } from '../../src/jobs/index.js';
import { ProjectStore } from '../../src/projects/store.js';
import { createSoakRuntime, type SoakRuntime } from './soak.js';
import { resolveSandboxTarget } from './target.js';
import { copyBridgeState } from './write-scope.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

type Obj = Record<string, any>;

interface Item {
  readonly id: string;
  readonly title: string;
  readonly verdict: 'pass' | 'fail' | 'noted';
  readonly detail: string;
}

async function runCheck(sb: SoakRuntime): Promise<Item[]> {
  const rt = sb.runtime;
  const pid = sb.projectId;
  const items: Item[] = [];
  const record = (id: string, title: string, verdict: Item['verdict'], detail: string) =>
    items.push({ id, title, verdict, detail });
  const origin = { kind: 'test' as const, client: 'sandbox', tool: 'consistency-f4b' };
  const run = async (op: string, params: OpParams, options: StepOptions = {}) => {
    const r = await rt.engine.run(op, params, { project: pid, origin, priority: 'P1', ...options });
    if (r.status !== 'succeeded') throw new Error(`${op}: ${r.status}`);
    return r.result as Obj;
  };
  const check = async (id: string, title: string, fn: () => Promise<string>): Promise<boolean> => {
    try {
      record(id, title, 'pass', await fn());
      return true;
    } catch (e) {
      record(id, title, 'fail', (e as Error).message);
      return false;
    }
  };
  const copied = copyBridgeState({
    bridgeDbPath: process.env.DB_PATH ?? './data/bridge.db',
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
      const index = await run('createResource', {
        body: { name: `lk-bridge f4b check ${stamp}`, ...(rootId ? { parentId: rootId } : {}) },
      });
      made.index = String(index.id);
      const core = await run('createResource', {
        body: { name: `[BSRC] ${subject} - Character Core`, parentId: made.index },
      });
      coreId = String(core.id);
      await run('createProperty', {
        path: { resourceId: coreId },
        body: {
          kind: 'keyValue',
          title: 'PROPERTIES',
          rows: [
            { key: 'Subject', text: subject },
            { key: 'Reference Type', text: 'Character Core' },
            { key: 'Temporal Scope', text: 'Born Camue 1st, 4A 100' },
          ],
        },
      });
      const page = await run('createResource', {
        body: { name: `lk-bridge f4b restatement ${stamp}`, parentId: made.index },
      });
      pageId = String(page.id);
      pageDoc = String(page.documents?.[0]?.id ?? '');
      await run('replaceDocumentBlocks', {
        path: { resourceId: pageId, documentId: pageDoc },
        body: {
          blocks: [
            {
              kind: 'paragraph',
              content: [{ text: `${subject} was born on Camue 1st, 4A 103, in the harbour quarter.` }],
            },
            { kind: 'paragraph', content: [{ text: 'This line stays as it is.' }] },
          ],
        },
      });
      await rt.tree.whenIdle();
      return `index ${made.index}, Core ${coreId}, restatement ${pageId}`;
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
        throw new Error(`the sentence reads ${text.slice(0, 300)}`);
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
        await run(
          'deleteResource',
          { path: { resourceId: made.index }, query: { cascade: true } },
          { confirm: 'cascade' },
        );
      } catch (e) {
        record(
          'cleanup',
          'the throwaway index deleted',
          'fail',
          `${made.index}: ${(e as Error).message}. Delete it by hand.`,
        );
      }
  }
  return items;
}

describe.skipIf(!projectName)(
  'LegendKeeper sandbox: the consistency check and the owner’s pick (F4b, F1–F6)',
  () => {
    it('finds a birth restated differently, proposes the owner’s pick, applies it on approval, and cleans up', async () => {
      // Refuses (throws) before any request unless the project is a registered sandbox with a key.
      const target = resolveSandboxTarget(projectName);
      const sb = await createSoakRuntime({
        apiKey: target.apiKey,
        project: target.name,
        ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
      });
      try {
        const items = await runCheck(sb);
        const mark = { pass: 'PASS', fail: 'FAIL', noted: 'NOTED' } as const;
        process.stdout.write(
          [
            '',
            'LK-Bridge sandbox: the consistency check and "Pick the right value" (F4b, ADR 0064)',
            '====================================================================================',
            ...items.map((i) => `[${mark[i.verdict]}] (${i.id}) ${i.title}\n        ${i.detail}`),
            '',
          ].join('\n'),
        );
        expect(items.filter((i) => i.verdict === 'fail').map((i) => `${i.id}: ${i.detail}`)).toEqual([]);
      } finally {
        await sb.close();
      }
    }, 1_800_000);
  },
);
