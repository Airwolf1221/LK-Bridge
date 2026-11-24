/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- LK results are untyped JSON */
/**
 * v3 F9 (ADR 0074), opt-in: the bulk class on a REAL sandbox project. `deploy/sandbox-test.sh --project test -- bulk-f9`.
 * It WRITES (a throwaway subtree of a dozen pages), then deletes what it made.
 *
 * A small full snapshot (P4, bulk) with a change snapshot requested mid-way (a bridge write to one of its pages, whose
 * change snapshot is routine). The sandbox runtime's AI REPOSITORY is set, in its own temporary database only, to the
 * throwaway root, so the full snapshot takes that subtree (and the asset library, as every full snapshot does: downloads
 * come from the asset host, which uses no request budget), never the whole test world.
 *
 * Printed: each one's start and finish, and the classes its requests went at. What to look for:
 * - B1: every request of the full snapshot's run at P4;
 * - B2: the write and its change snapshot at P1 or P2 (never P4), finished before the full snapshot finished;
 * - B3: the full snapshot still finished, complete, with every page of the subtree.
 */
import type { Db } from '../../src/db/open.js';
import type { Governor } from '../../src/lk/governor/governor.js';
import type { ExecuteRequest, PriorityClass } from '../../src/lk/governor/types.js';
import type { Runtime } from '../../src/runtime.js';
import type { Finding, Verdict } from './smoke.js';
import type { HttpCounters } from './soak.js';
import { sandboxRun, StepTimeoutError, type SandboxRun } from './steps.js';
import { runSettled, type WaitOptions } from './wait.js';
import { wholeError } from './whole.js';

type Obj = Record<string, any>;

export interface BulkTarget {
  readonly runtime: Runtime;
  readonly db: Db;
  readonly projectId: string;
  readonly counters: HttpCounters;
}

export interface BulkOptions {
  readonly wait?: WaitOptions;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly run?: SandboxRun;
  /** Pages under the throwaway root (default 12). */
  readonly pages?: number;
}

export interface BulkTimeline {
  readonly full: { start: number; finish: number | null; classes: PriorityClass[]; requests: number };
  readonly change: {
    start: number | null;
    finish: number | null;
    classes: PriorityClass[];
    requests: number;
  };
}

export interface BulkReport {
  readonly findings: Finding[];
  readonly timeline: BulkTimeline | null;
}

class Fails extends Error {}

const uniq = (xs: readonly PriorityClass[]) => [...new Set(xs)].sort();

export async function runBulkSandbox(t: BulkTarget, o: BulkOptions = {}): Promise<BulkReport> {
  const steps = o.run ?? sandboxRun({ name: 'bulk-f9', out: () => undefined });
  const rt = t.runtime;
  const pid = t.projectId;
  const svc = rt.snapshots;
  const findings: Finding[] = [];
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const wait: WaitOptions = { ...(o.sleep ? { sleep: o.sleep } : {}), ...o.wait };
  const origin = { kind: 'test' as const, client: 'sandbox-bulk-f9', tool: 'sandbox-bulk-f9' };
  const record = (id: string, title: string, verdict: Verdict, detail: string) =>
    findings.push({ id, title, verdict, detail });
  const run = async (op: string, params: Obj = {}, extra: Obj = {}): Promise<any> =>
    runSettled(
      { engine: rt.engine, projectId: pid },
      op,
      params,
      { origin, priority: 'P1', project: pid, ...extra },
      wait,
    );
  const check = async (id: string, title: string, fn: () => Promise<string>) => {
    try {
      record(id, title, 'pass', await steps.step(id, title, fn));
    } catch (e) {
      const verdict: Verdict = e instanceof Fails || e instanceof StepTimeoutError ? 'fail' : 'inconclusive';
      record(id, title, verdict, e instanceof Fails ? e.message : `could not complete: ${wholeError(e)}`);
    }
  };

  // ---- guard: the key must belong to exactly this project --------------------------------------------------------
  const projects = (await steps.step('guard', 'the key belongs to exactly this project', () =>
    run('listProjects'),
  )) as { data?: { id: string }[] };
  const ids = (projects.data ?? []).map((x) => x.id);
  if (ids.length !== 1 || ids[0] !== pid)
    throw new Error(`Refusing to run: the key's projects are [${ids.join(', ')}], not exactly ${pid}.`);

  const base = `lk-bridge bulk-f9 ${new Date().toISOString()}`;
  let rootId = '';
  const pages: string[] = [];
  steps.defer('the throwaway subtree deleted', async () => {
    if (!rootId) return;
    try {
      await run(
        'deleteResource',
        { path: { resourceId: rootId }, query: { cascade: true } },
        { confirm: 'cascade' },
      );
      record('cleanup', 'everything the run made is deleted', 'pass', `root ${rootId} with its subtree`);
    } catch (e) {
      record('cleanup', 'everything the run made is deleted', 'fail', `left: ${rootId} (${wholeError(e)})`);
    }
  });

  // Every call the project's governor is asked for, with its class and time.
  const governor: Governor = rt.projects.client(pid)!.governor;
  const seen: { opId: string; p: PriorityClass; jobId: string | undefined; at: number }[] = [];
  const execute = governor.execute.bind(governor);
  (governor as { execute: Governor['execute'] }).execute = <T>(req: ExecuteRequest<T>) => {
    seen.push({ opId: req.opId, p: req.priority, jobId: req.jobId, at: Date.now() });
    return execute(req);
  };
  let timeline: BulkTimeline | null = null;
  try {
    await check('setup', `a throwaway root with ${o.pages ?? 12} pages, and its tree`, async () => {
      const root = await run('createResource', { body: { name: base } });
      rootId = root.id as string;
      rt.projects.setSetting(pid, 'aiRepositoryRootId', rootId);
      for (let i = 1; i <= (o.pages ?? 12); i++) {
        const p = await run('createResource', { body: { name: `${base} page ${i}`, parentId: rootId } });
        pages.push(p.id as string);
      }
      rt.tree.prepareBuild(pid, { trigger: 'sandbox-bulk-f9', autoConfirm: true });
      for (let i = 0; i < 600 && rt.tree.store.activePass(pid); i++) await sleep(500);
      return `root ${rootId}, ${pages.length} pages; tree ${rt.tree.meta(pid).status}`;
    });
    if (pages.length === 0) return { findings, timeline };

    const change = { start: null as number | null, finish: null as number | null, error: '' };
    const pending: { change: Promise<void> | null } = { change: null };
    let n = 0;
    const svcO = svc.o as { afterPage?: unknown };
    svcO.afterPage = () => {
      n++;
      if (n !== 3) return;
      // Mid-way: a bridge write to one of the subtree's pages (a P2 job), whose change snapshot follows it.
      change.start = Date.now();
      pending.change = run(
        'updateResource',
        { path: { resourceId: pages[0]! }, body: { name: `${base} page 1 (renamed mid-snapshot)` } },
        { priority: 'P2' },
      )
        .then(() => svc.settled())
        .then(() => {
          change.finish = Date.now();
        })
        .catch((e: unknown) => {
          change.error = wholeError(e);
        });
    };
    const full = {
      start: Date.now(),
      finish: null as number | null,
      runId: '',
      summary: '',
      complete: false,
      pages: 0,
    };
    try {
      const r = await steps.step(
        'full',
        'the small full snapshot, with a change snapshot requested mid-way',
        () => svc.full(pid, 'sandbox-bulk-f9'),
      );
      full.finish = Date.now();
      full.runId = r.runId ?? '';
      full.summary = r.summary;
      if (r.snapshotId) {
        const m = await svc.manifest(r.snapshotId);
        full.complete = m?.complete === true;
        full.pages = m?.pages.length ?? 0;
      }
    } finally {
      svcO.afterPage = undefined;
    }
    if (pending.change) await pending.change;

    const fullCalls = seen.filter((s) => s.jobId === `snapshot:${full.runId}`);
    const changeCalls =
      change.start === null
        ? []
        : seen.filter(
            (s) =>
              s.at >= change.start! &&
              s.at <= (change.finish ?? Date.now()) &&
              s.jobId !== `snapshot:${full.runId}`,
          );
    timeline = {
      full: {
        start: full.start,
        finish: full.finish,
        classes: uniq(fullCalls.map((s) => s.p)),
        requests: fullCalls.length,
      },
      change: {
        start: change.start,
        finish: change.finish,
        classes: uniq(changeCalls.map((s) => s.p)),
        requests: changeCalls.length,
      },
    };
    const tl = timeline;
    await check('B1', 'every request of the full snapshot went at P4 (bulk)', () => {
      if (tl.full.requests === 0) throw new Fails(`no request of the run was seen (${full.summary})`);
      if (tl.full.classes.join() !== 'P4') throw new Fails(`classes ${tl.full.classes.join(', ')}`);
      return Promise.resolve(`${tl.full.requests} requests, all P4`);
    });
    await check(
      'B2',
      'the change snapshot went at its job’s class and finished before the full snapshot',
      () => {
        if (change.error) throw new Fails(`the write or its change snapshot failed: ${change.error}`);
        if (tl.change.start === null) throw new Error('the full snapshot ended before the write was made');
        if (tl.change.classes.includes('P4')) throw new Fails(`classes ${tl.change.classes.join(', ')}`);
        if (tl.change.finish === null || tl.full.finish === null || tl.change.finish > tl.full.finish)
          throw new Fails('it finished after the full snapshot');
        const changes = svc.index.snapshots(pid, { kind: 'change', limit: 20 });
        if (changes.length === 0) throw new Fails('no change snapshot was written');
        return Promise.resolve(
          `${tl.change.requests} requests at ${tl.change.classes.join(', ') || '(none)'}, ` +
            `${tl.change.finish - tl.change.start} ms`,
        );
      },
    );
    await check('B3', 'the full snapshot still finished, complete, with every page', () => {
      if (full.finish === null) throw new Fails(full.summary || 'it did not finish');
      if (!full.complete) throw new Fails(`it is partial: ${full.summary}`);
      if (full.pages !== pages.length + 1) throw new Fails(`${full.pages} pages, not ${pages.length + 1}`);
      return Promise.resolve(`${full.pages} pages in ${full.finish - full.start} ms`);
    });
  } finally {
    (governor as { execute: Governor['execute'] }).execute = execute;
    await steps.cleanup();
  }
  return { findings, timeline };
}

export function formatBulkReport(r: BulkReport, total: { reads: number; writes: number }): string {
  const mark = {
    pass: 'PASS',
    fail: 'FAIL',
    inconclusive: 'INCONCLUSIVE',
    skipped: 'SKIPPED',
    noted: 'NOTED',
  } as const;
  const at = (ms: number | null) => (ms === null ? '—' : new Date(ms).toISOString().slice(11, 23));
  const tl = r.timeline;
  return [
    '',
    'LK-Bridge sandbox: the bulk class P4 (docs/adr/0074-v3-f9-the-bulk-class-p4.md)',
    '==========================================================================',
    ...(tl
      ? [
          `full snapshot   started ${at(tl.full.start)}  finished ${at(tl.full.finish)}  ${tl.full.requests} requests  classes ${tl.full.classes.join(', ') || '—'}`,
          `change snapshot started ${at(tl.change.start)}  finished ${at(tl.change.finish)}  ${tl.change.requests} requests  classes ${tl.change.classes.join(', ') || '—'}`,
          '',
        ]
      : []),
    ...r.findings.map((f) => `[${mark[f.verdict]}] ${f.id} ${f.title}: ${f.detail}`),
    '',
    `requests to LegendKeeper: ${total.reads} reads, ${total.writes} writes`,
    '',
  ].join('\n');
}
