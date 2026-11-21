/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- LK results are untyped JSON */
/**
 * v2 E2 (ADR 0044), opt-in: the audits' assumptions on a REAL sandbox project (test/sandbox/README.md, "Audits (v2 E2)"):
 * `deploy/sandbox-test.sh --project test -- audits`. It WRITES (one throwaway subtree, and the paragraph fix's blocks), then
 * cleans up everything it made. Each check prints PASS, FAIL, INCONCLUSIVE or NOTED with its cost. WRITTEN, NOT RUN: the
 * owner runs it; the same script is dry-run against the mock in test/audits/sandbox-dryrun.test.ts.
 *
 * As the snapshot sandbox does, the runtime is the bridge's own (a temporary database and snapshot store) and its AI REPOSITORY
 * is the throwaway root.
 *
 * 1. setup: a page whose Main document holds a paragraph with a line break INSIDE one text run, a tidy paragraph, and a table
 *    whose cell holds another such paragraph (the nested case). Whether LegendKeeper keeps the `\n` in one run is the first
 *    assumption (the owner's 32 paragraphs say it does).
 * 2. T: the full snapshot holds the project's templates (a `templates` list in its manifest), and what they cost.
 * 3. A: an audit makes ZERO requests to LegendKeeper, finds both paragraphs, and records the snapshot and its age.
 * 4. F1: "Propose a fix" for the top-level paragraph: a proposal that writes nothing, approved here as the owner would; the
 *    block is replaced keeping its id (`replaceBlock` with its own id in the body), the rest inserted after it (`insertBlock`
 *    with `after`), the rest of the page untouched, and the job's own verify step passes.
 * 5. F2 (NOTED either way): the same for the paragraph inside the table cell, which asks whether `insertBlock` takes `after` a
 *    block inside a container. The audit offers the fix for any paragraph; the verify step catches a refusal.
 * 6. R: another full snapshot and audit: the fixed paragraph's finding is gone.
 * 7. Clean-up: the root (cascade).
 */
import type { Db } from '../../src/db/open.js';
import type { Runtime } from '../../src/runtime.js';
import type { Finding, Verdict } from './smoke.js';
import type { HttpCounters } from './soak.js';
import { runSettled, waitForJob, type WaitOptions } from './wait.js';
import { wholeError } from './whole.js';

type Obj = Record<string, any>;

export interface AuditsTarget {
  readonly runtime: Runtime;
  readonly db: Db;
  readonly projectId: string;
  readonly counters: HttpCounters;
}

export interface AuditsOptions {
  readonly wait?: WaitOptions;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface AuditsReport {
  readonly findings: Finding[];
}

class Fails extends Error {}

const text = (b: Obj): string =>
  ((b.content as Obj[] | undefined) ?? []).map((r) => String(r.text ?? '')).join('');

export async function runAuditsSandbox(t: AuditsTarget, o: AuditsOptions = {}): Promise<AuditsReport> {
  const rt = t.runtime;
  const pid = t.projectId;
  const findings: Finding[] = [];
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const wait: WaitOptions = { ...(o.sleep ? { sleep: o.sleep } : {}), ...o.wait };
  const origin = { kind: 'test' as const, client: 'sandbox-audits', tool: 'sandbox-audits' };
  const record = (id: string, title: string, verdict: Verdict, detail: string) =>
    findings.push({ id, title, verdict, detail });
  const mark = () => ({ r: t.counters.reads, w: t.counters.writes });
  const costText = (b: { r: number; w: number }) =>
    `cost: ${t.counters.reads - b.r} reads, ${t.counters.writes - b.w} writes`;
  const check = async (id: string, title: string, fn: () => Promise<string | { noted: string }>) => {
    const before = mark();
    try {
      const r = await fn();
      if (typeof r === 'string') record(id, title, 'pass', `${r}; ${costText(before)}`);
      else record(id, title, 'noted', `${r.noted}; ${costText(before)}`);
    } catch (e) {
      const verdict: Verdict = e instanceof Fails ? 'fail' : 'inconclusive';
      record(id, title, verdict, `${wholeError(e)}; ${costText(before)}`);
    }
  };
  const run = async (op: string, params: Obj = {}, extra: Obj = {}): Promise<any> =>
    runSettled(
      { engine: rt.engine, projectId: pid },
      op,
      params,
      { origin, priority: 'P1', project: pid, ...extra },
      wait,
    );
  const approve = async (proposalId: string, what: string) => {
    await rt.policy.commands.approve('owner', proposalId);
    let jobId: string | null = null;
    for (let i = 0; i < 100 && !jobId; i++) {
      jobId = rt.policy.proposals.get(proposalId)?.jobId ?? null;
      if (!jobId) await sleep(100);
    }
    if (!jobId) throw new Error(`${what}: the approved proposal started no job`);
    await waitForJob(rt.engine, pid, jobId, what, wait);
    for (let i = 0; i < 100 && rt.policy.proposals.get(proposalId)?.state !== 'executed'; i++)
      await sleep(100);
    const state = rt.policy.proposals.get(proposalId)?.state;
    if (state !== 'executed') throw new Fails(`${what}: the proposal ended ${state ?? 'unknown'}`);
    return waitForJob(rt.engine, pid, jobId, what, wait);
  };

  // ---- guard: the key must belong to exactly this project --------------------------------------------------------
  const projects = (await run('listProjects')) as { data?: { id: string }[] };
  const ids = (projects.data ?? []).map((x) => x.id);
  if (ids.length !== 1 || ids[0] !== pid)
    throw new Error(`Refusing to run: the key's projects are [${ids.join(', ')}], not exactly ${pid}.`);

  const base = `lk-bridge audits ${new Date().toISOString()}`;
  let rootId = '';
  let pageId = '';
  let docId = '';
  const blocksNow = async (): Promise<Obj[]> =>
    ((await run('getDocumentBlocks', { path: { resourceId: pageId, documentId: docId } })) as Obj)
      .blocks as Obj[];
  const flat = (bs: Obj[]): Obj[] => bs.flatMap((b) => [b, ...flat((b.children as Obj[] | undefined) ?? [])]);
  const audit = async () => {
    await rt.snapshots.full(pid, 'sandbox-audits');
    await rt.audits.settled();
    return rt.audits.list(pid, { code: ['line_break_paragraph'], limit: 50 }).findings;
  };

  try {
    await check(
      'setup',
      'a throwaway page with paragraphs holding a line break inside one text run',
      async () => {
        const root = await run('createResource', { body: { name: base } });
        rootId = root.id as string;
        rt.projects.setSetting(pid, 'aiRepositoryRootId', rootId);
        const page = await run('createResource', { body: { name: `${base} page`, parentId: rootId } });
        pageId = page.id as string;
        const res = (await run('getResource', { path: { resourceId: pageId } })) as Obj;
        docId = String((res.documents as Obj[]).find((d) => d.type === 'blank' || d.type === 'page')!.id);
        await run('replaceDocumentBlocks', {
          path: { resourceId: pageId, documentId: docId },
          body: {
            blocks: [
              { id: 'sb-h', kind: 'heading', level: 1, content: [{ text: 'Audit test' }] },
              {
                id: 'sb-p1',
                kind: 'paragraph',
                content: [{ text: 'first line\nsecond ' }, { text: 'line', bold: true }],
              },
              { id: 'sb-p2', kind: 'paragraph', content: [{ text: 'a tidy paragraph' }] },
              {
                id: 'sb-t',
                kind: 'table',
                children: [
                  {
                    id: 'sb-tr',
                    kind: 'tableRow',
                    children: [
                      {
                        id: 'sb-tc',
                        kind: 'tableCell',
                        children: [
                          {
                            id: 'sb-p3',
                            kind: 'paragraph',
                            content: [{ text: 'in a cell\nover two lines' }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        });
        const back = flat(await blocksNow()).find((b) => b.id === 'sb-p1');
        if (!back || !/first line\nsecond/.test(text(back)))
          throw new Fails(
            `LegendKeeper did not keep the newline inside one text run: ${JSON.stringify(back?.content)}`,
          );
        rt.tree.prepareBuild(pid, { trigger: 'sandbox-audits', autoConfirm: true });
        for (let i = 0; i < 600 && rt.tree.store.activePass(pid); i++) await sleep(500);
        return `root ${rootId}, page ${pageId}; the newline stays inside one text run; tree ${rt.tree.meta(pid).status}`;
      },
    );
    if (!pageId) return { findings };

    let found = [] as Awaited<ReturnType<typeof audit>>;
    await check('T', 'a full snapshot holds the project’s templates', async () => {
      const r = await rt.snapshots.full(pid, 'sandbox-audits');
      await rt.audits.settled();
      const m = r.snapshotId ? await rt.snapshots.manifest(r.snapshotId) : null;
      if (!m) throw new Fails(r.summary);
      if (!m.templates || m.templates.length === 0)
        throw new Fails('the manifest has no templates (the template read failed, or the project has none)');
      return `${m.id}: ${m.templates.length} templates (${m.templates
        .map((x) => x.name)
        .join(', ')
        .slice(0, 200)}); ${m.counts.reads} reads in all`;
    });

    await check(
      'A',
      'an audit makes no request, finds both paragraphs, and records its snapshot and age',
      async () => {
        const before = mark();
        const out = await rt.audits.run(pid, 'manual');
        const spent = { r: t.counters.reads - before.r, w: t.counters.writes - before.w };
        if (out.state !== 'succeeded') throw new Fails(out.summary);
        if (spent.r !== 0 || spent.w !== 0)
          throw new Fails(
            `the audit made ${spent.r} reads and ${spent.w} writes to LegendKeeper (it must make none)`,
          );
        found = rt.audits.list(pid, { code: ['line_break_paragraph'], limit: 50 }).findings;
        const ids2 = found.map((f) => f.blockId).sort();
        if (!ids2.includes('sb-p1') || !ids2.includes('sb-p3'))
          throw new Fails(`the line-break findings are [${ids2.join(', ')}], not both sb-p1 and sb-p3`);
        const f = found[0]!;
        if (f.source.kind !== 'snapshot' || f.source.ageMs < 0)
          throw new Fails('a finding does not record its snapshot and age');
        return `0 requests; ${found.length} line-break findings; the newest from ${(f.source as { snapshotId: string }).snapshotId}, ${Math.round(f.source.ageMs / 1000)} s old`;
      },
    );

    await check('F1', '“Propose a fix” splits the top-level paragraph block by block', async () => {
      const f = found.find((x) => x.blockId === 'sb-p1');
      if (!f) throw new Fails('no finding for sb-p1');
      const before = (await blocksNow()).map((b) => JSON.stringify(b));
      const r = await rt.audits.proposeFix('owner', pid, f.id);
      if (r.status !== 'proposal_captured') throw new Fails(`not proposed: ${JSON.stringify(r)}`);
      const unchanged = (await blocksNow()).map((b) => JSON.stringify(b));
      if (JSON.stringify(unchanged) !== JSON.stringify(before))
        throw new Fails('the proposal changed the page');
      const job = await approve(r.proposalId, 'the paragraph split');
      const after = await blocksNow();
      const top = after.map((b) => String(b.id));
      const idx = top.indexOf('sb-p1');
      const parts = [after[idx], after[idx + 1]].map((b) => (b ? text(b) : ''));
      if (idx !== 1 || parts[0] !== 'first line' || parts[1] !== 'second line')
        throw new Fails(
          `the page reads back as [${after.map((b) => `${String(b.id)}: ${text(b)}`).join(' | ')}]`,
        );
      if (
        JSON.stringify(after[idx + 1]!.content) !==
        JSON.stringify([{ text: 'second ' }, { text: 'line', bold: true }])
      )
        throw new Fails('the bold mark did not stay with its words');
      if (!after.some((b) => b.id === 'sb-p2') || !after.some((b) => b.id === 'sb-t'))
        throw new Fails('another block was lost');
      return `proposal ${r.proposalId} approved; sb-p1 kept its id and ${after.length - before.length} paragraph was inserted after it; verified: ${String((job.result as Obj)?.verified)}`;
    });

    await check(
      'F2',
      'the same fix for a paragraph inside a table cell (insertBlock after a nested block)',
      async () => {
        const f = rt.audits
          .list(pid, { code: ['line_break_paragraph'], limit: 50 })
          .findings.find((x) => x.blockId === 'sb-p3');
        if (!f?.fix) throw new Fails('no fix is offered for sb-p3');
        try {
          const r = await rt.audits.proposeFix('owner', pid, f.id);
          if (r.status !== 'proposal_captured') return { noted: `not proposed: ${JSON.stringify(r)}` };
          await approve(r.proposalId, 'the nested paragraph split');
          const cell = flat(await blocksNow()).find((b) => b.id === 'sb-tc');
          return {
            noted: `ACCEPTED: the cell now holds ${((cell?.children as Obj[] | undefined) ?? []).map(text).join(' | ')}`,
          };
        } catch (e) {
          return {
            noted: `REFUSED or stopped (${(e as Error).message}); nothing else changed. The fix should then be offered only for top-level paragraphs.`,
          };
        }
      },
    );

    await check('R', 'after the next full snapshot the fixed paragraph’s finding is gone', async () => {
      const left = await audit();
      if (left.some((x) => x.blockId === 'sb-p1')) throw new Fails('the finding for sb-p1 is still there');
      const gone = rt.audits
        .list(pid, { state: 'gone', limit: 50 })
        .findings.some((x) => x.blockId === 'sb-p1');
      if (!gone) throw new Fails('the finding for sb-p1 is not listed as resolved');
      return `still open: [${left.map((x) => x.blockId).join(', ')}]; sb-p1 resolved`;
    });
  } finally {
    const before = mark();
    let left = '';
    if (rootId) {
      try {
        await run(
          'deleteResource',
          { path: { resourceId: rootId }, query: { cascade: true } },
          { confirm: 'cascade' },
        );
      } catch (e) {
        const m = (e as Error).message;
        if (!/404|not found|already deleted|NOT_FOUND|gone/i.test(m)) left = `root ${rootId} (${m})`;
      }
    }
    record(
      'cleanup',
      'everything the run made is deleted',
      left === '' ? 'pass' : 'fail',
      left === ''
        ? `root ${rootId || '(none)'} with its subtree; ${costText(before)}`
        : `left: ${left}. Delete it by hand.`,
    );
  }
  return { findings };
}

export function formatAuditsReport(r: AuditsReport, total: { reads: number; writes: number }): string {
  const mark = {
    pass: 'PASS',
    fail: 'FAIL',
    inconclusive: 'INCONCLUSIVE',
    skipped: 'SKIPPED',
    noted: 'NOTED',
  } as const;
  const count = (v: Verdict) => r.findings.filter((f) => f.verdict === v).length;
  return [
    '',
    'LK-Bridge sandbox: audits (docs/adr/0044-audits.md)',
    '====================================================',
    ...r.findings.map((f) => `[${mark[f.verdict]}] (${f.id}) ${f.title}\n        ${f.detail}`),
    '',
    `${count('pass')} PASS, ${count('fail')} FAIL, ${count('inconclusive')} INCONCLUSIVE, ${count('skipped')} SKIPPED, ${count('noted')} NOTED`,
    `Total: ${total.reads} reads, ${total.writes} writes to LegendKeeper.`,
    '',
  ].join('\n');
}
