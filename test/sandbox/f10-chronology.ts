/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- LK results are untyped JSON */
/**
 * v3 F10 (ADR 0078), opt-in, WRITES then cleans up, on the test world only: a row added DIRECTLY to an age table with
 * write_page, its change snapshot, the chronology check a moment later (CHRONOLOGY_CHECK_DELAY_MS shortened in the
 * sandbox runtime), and the automation's sync at Apply: the row's event created and verified. Written for the owner;
 * never run by an agent or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- f10-chronology
 *
 * It runs on a temporary database that starts as a READ-ONLY copy of the project's settings, repository tree and packs
 * from the bridge's database (`copyBridgeState`); it never writes to the bridge's database, and it never touches test's
 * own chronology: it builds a THROWAWAY one (as F7.1's governance helper builds a throwaway governance page) and
 * confirms it in the temporary database only. Each step prints PASS or FAIL:
 *
 * - **K0** the Arkona pack's governance current in the temporary database (a throwaway governance page with Repository
 *   Automation's sections); every automation code Off there except `chronology_row_without_event`, at Apply;
 * - **K1** a throwaway chronology `lk-bridge f10 chronology <time>` under the AI REPOSITORY, made through the bridge's
 *   engine (so the tree follows it): a Main document with its index table, one age (the calendar's last era) with its
 *   table (one row) and its timeline (one lane, the row's event); confirmed in the temporary database; PRINTED as
 *   `F10 CHRONOLOGY …`;
 * - **K2** a second row added DIRECTLY to the age table with write_page (read first, its version passed back), as a
 *   write-scope principal: the result carries the chronology note; the change snapshot schedules the check;
 * - **K3** the delayed check runs by itself (a few seconds here), finds the row without its event, and the automation's
 *   chronology run applies the sync at once: PRINTED as `F10 SYNC …`: the job, its verification, the record;
 * - **K4** read back LIVE: the age's timeline holds two events, the new one at the new row's date, linked to the table.
 *
 * Clean-up: the throwaway chronology and the throwaway governance page deleted (with the raw client), even after a
 * failure (test/sandbox/steps.ts). Cost: about 15 writes and 40 reads.
 */
import { pino } from 'pino';
import { formatKcy } from '../../src/calendar/index.js';
import { PatService } from '../../src/auth/pats.js';
import { AuthStore } from '../../src/auth/store.js';
import { PROPOSE_ONLY, ELIGIBLE } from '../../src/automation/registry.js';
import { mintClientId } from '../../src/jobs/ids.js';
import type { OpParams, Principal } from '../../src/jobs/index.js';
import type { McpToolContext } from '../../src/mcp/server.js';
import type { RawLk } from './f4b-probe.js';
import { ensureSandboxGovernance } from './governance.js';
import type { SoakRuntime } from './soak.js';
import { sandboxRun, type SandboxRun } from './steps.js';
import { wholeError } from './whole.js';
import { copyBridgeState } from './write-scope.js';

type Obj = Record<string, any>;
export interface ChronologyRepairItem {
  readonly id: string;
  readonly title: string;
  readonly verdict: 'pass' | 'fail';
  readonly detail: string;
}

/** The check's delay before the chronology check runs (the runtime's CHRONOLOGY_CHECK_DELAY_MS must be this). */
export const F10_SANDBOX_DELAY_MS = 3_000;

const t = (text: string) => [{ text }];
const cell = (content: unknown[], header = false) => ({
  kind: 'tableCell',
  ...(header ? { header: true } : {}),
  children: [{ kind: 'paragraph', content }],
});
const row = (cells: unknown[][], header = false) => ({
  kind: 'tableRow',
  children: cells.map((c) => cell(c, header)),
});

export async function runChronologyRepairCheck(
  sb: SoakRuntime,
  raw: RawLk,
  name: string,
  o: { readonly bridgeDbPath: string; readonly run?: SandboxRun; readonly waitMs?: number },
): Promise<ChronologyRepairItem[]> {
  const steps = o.run ?? sandboxRun({ name: 'f10-chronology', out: () => undefined });
  const rt = sb.runtime;
  const pid = sb.projectId;
  const items: ChronologyRepairItem[] = [];
  const check = async (id: string, title: string, fn: () => Promise<string>): Promise<boolean> => {
    try {
      items.push({ id, title, verdict: 'pass', detail: await steps.step(id, title, fn) });
      return true;
    } catch (e) {
      items.push({ id, title, verdict: 'fail', detail: wholeError(e) });
      return false;
    }
  };
  copyBridgeState({ bridgeDbPath: o.bridgeDbPath, target: sb.db, projectId: pid, runtime: rt });
  const profile = rt.policy.commands.createProfile('owner', {
    label: `f10 check ${Date.now()}`,
    kind: 'other',
    scope: 'write',
  });
  rt.policy.commands.setRails('owner', profile.id, {
    deletes: false,
    bulk: false,
    renamesMoves: false,
    assets: false,
  });
  const pats = new PatService({
    store: new AuthStore(sb.db),
    event: () => undefined,
    now: () => Math.floor(Date.now() / 1000),
  });
  const who: Principal = rt.policy.store.lookupPrincipal(
    pats.create({ name: 'f10 check', profileId: profile.id, expiresInDays: 1 }).pat.id,
  )!.principal;
  const silent = pino({ level: 'silent' }) as unknown as McpToolContext['log'];
  const tool = async (tn: string, args: Obj): Promise<Obj> => {
    const provider = rt.tools.find((x) => x.name === tn);
    if (!provider) throw new Error(`${tn} is not a tool of this bridge`);
    const parsed = provider.inputSchema.safeParse({ project: name, ...args });
    if (!parsed.success) throw new Error(`${tn}: ${parsed.error.message}`);
    const res = await provider.handler(parsed.data, {
      caller: undefined,
      signal: AbortSignal.timeout(10 * 60_000),
      log: silent,
      principal: who,
      scope: 'write',
      showLowLevelTools: false,
    });
    const text = (res.content as readonly { text?: string }[]).map((c) => c.text ?? '').join('\n');
    const body = JSON.parse(text.split('\n').slice(0, -1).join('\n')) as Obj;
    if (res.isError === true)
      throw new Error(`${tn}: ${String(body.error?.code)} ${String(body.error?.message)}`);
    return body;
  };
  // The bridge's own writes (through the engine, so the repository tree follows the throwaway page).
  const run = async (op: string, params: OpParams): Promise<Obj> => {
    const r = await rt.engine.run(op, params, {
      project: pid,
      origin: { kind: 'test', client: 'sandbox', tool: 'f10-chronology' },
      priority: 'P1',
    });
    if (r.status !== 'succeeded') throw new Error(`${op}: ${r.status} ${JSON.stringify(r).slice(0, 400)}`);
    return r.result as Obj;
  };

  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const made: { chronology: string | null; governance: string | null } = {
    chronology: null,
    governance: null,
  };
  steps.defer('the throwaway chronology and governance page deleted', async () => {
    const left: string[] = [];
    for (const [what, id] of [
      ['chronology', made.chronology],
      ['governance page', made.governance],
    ] as const) {
      if (!id) continue;
      try {
        await raw.request('deleteResource', 'DELETE', `/resources/${id}?cascade=true`);
      } catch (e) {
        const m = (e as Error).message;
        if (!/404|NOT_FOUND|ALREADY_DELETED/i.test(m)) left.push(`${what} ${id}: ${m}`);
      }
    }
    items.push({
      id: 'cleanup',
      title: 'the throwaway chronology and governance page deleted (404 counts as cleaned)',
      verdict: left.length === 0 ? 'pass' : 'fail',
      detail: left.length === 0 ? 'nothing left' : `left behind: ${left.join('; ')}. Delete by hand.`,
    });
  });

  const ctx: {
    age: string;
    resourceId: string;
    tableDoc: string;
    timelineDoc: string;
    lane: string;
    dates: [string, string];
  } = { age: '', resourceId: '', tableDoc: '', timelineDoc: '', lane: '', dates: ['', ''] };
  let since = 0;
  try {
    const root = rt.projects.list().find((p) => p.id === pid)?.settings.aiRepositoryRootId;
    const k0 = await check(
      'K0',
      'the pack’s governance current (a throwaway page); only chronology_row_without_event on, at Apply',
      async () => {
        const g = await ensureSandboxGovernance({
          rt,
          raw,
          projectName: name,
          packId: 'arkona',
          ...(root ? { parentId: root } : {}),
          label: `lk-bridge f10 governance ${stamp}`,
          always: true,
          made: (id) => {
            made.governance = id;
          },
        });
        const a = rt.automation;
        for (const e of [...ELIGIBLE, ...PROPOSE_ONLY]) a.store.setMode(pid, e.code, 'off', 'owner');
        a.store.setMode(pid, 'chronology_row_without_event', 'apply', 'owner');
        const state = await a.governanceState(pid);
        if (!state.ok) throw new Error(`automation’s governance: ${state.message}`);
        return `${g.detail}; chronology_row_without_event at Apply (temporary database)`;
      },
    );
    if (!k0) return items;

    const k1 = await check(
      'K1',
      'a throwaway chronology, built and confirmed in the temporary database',
      async () => {
        const cals = ((await run('listCalendars', {})).data ?? []) as Obj[];
        const confirmed = rt.chronology.config(pid).calendarId;
        const def = cals.find((c) => c.id === confirmed) ?? (cals.length === 1 ? cals[0] : null);
        if (!def) throw new Error(`no calendar to use (${cals.length} calendars, none confirmed)`);
        const cal = rt.chronology.remember(pid, def);
        const era = cal.engine.eras[cal.engine.eras.length - 1]!;
        ctx.age = era.name;
        const y0 = cal.engine.eventDate(era.startsAt).year;
        const at = (n: number) => cal.engine.yearStart(era, y0 + n);
        const style = rt.chronology.config(pid).style;
        const date = (n: number) => cal.engine.formatTable(at(n), 1, style.date);
        ctx.dates = [date(2), date(3)];
        const kcy = (d: string) => formatKcy(cal.parser.parse(d, style.date).kcy, style.kcy);
        const page = await run('createResource', {
          body: {
            name: `lk-bridge f10 chronology ${stamp}`,
            ...(root ? { parentId: root } : {}),
            documents: [
              { name: 'Main', type: 'page' },
              { name: `${era.name} - Table`, type: 'page' },
            ],
          },
        });
        made.chronology = ctx.resourceId = String(page.id);
        const docs = (page.documents ?? []) as Obj[];
        const mainDoc = String(docs.find((d) => d.name === 'Main')?.id);
        ctx.tableDoc = String(docs.find((d) => d.name === `${era.name} - Table`)?.id);
        const tl = await run('createDocument', {
          path: { resourceId: ctx.resourceId },
          body: { name: `${era.name} - Timeline`, type: 'time', calendarId: String(def.id) },
        });
        ctx.timelineDoc = String(tl.id);
        ctx.lane = mintClientId(24);
        await run('createLane', {
          path: { resourceId: ctx.resourceId, documentId: ctx.timelineDoc },
          body: { id: ctx.lane, name: 'Historical Events', rank: 'aV', size: 'sm' },
        });
        const write = async (documentId: string, blocks: Obj[]) => {
          const path = { resourceId: ctx.resourceId, documentId };
          const doc = await run('getDocumentBlocks', { path });
          await run('replaceDocumentBlocks', { path, body: { blocks }, ifMatch: String(doc.version) });
        };
        await write(ctx.tableDoc, [
          { kind: 'heading', level: 1, content: t(`${era.name} - Table`) },
          {
            kind: 'table',
            children: [
              row([t('Historical Event'), t('Date'), t('KCY')], true),
              row([t('The f10 probe’s first event'), t(ctx.dates[0]), t(kcy(ctx.dates[0]))]),
            ],
          },
        ]);
        await write(mainDoc, [
          { kind: 'heading', level: 1, content: t('lk-bridge f10 chronology') },
          {
            kind: 'table',
            children: [
              row([t('Age'), t('Event count'), t('Complete dated table'), t('Interactive timeline')], true),
              row([
                t(era.name),
                t('1'),
                [
                  {
                    mention: {
                      resourceId: ctx.resourceId,
                      documentId: ctx.tableDoc,
                      text: `${era.name} - Table`,
                    },
                  },
                ],
                [
                  {
                    mention: {
                      resourceId: ctx.resourceId,
                      documentId: ctx.timelineDoc,
                      text: `${era.name} - Timeline`,
                    },
                  },
                ],
              ]),
            ],
          },
        ]);
        const first = cal.parser.parse(ctx.dates[0], style.date);
        await run('createEvent', {
          path: { resourceId: ctx.resourceId, documentId: ctx.timelineDoc },
          body: {
            id: mintClientId(24),
            laneId: ctx.lane,
            type: 'event',
            name: 'The f10 probe’s first event',
            start: first.start,
            detail: first.detail,
            uri: `lk://resources/${ctx.resourceId}/docs/${ctx.tableDoc}`,
          },
        });
        await rt.tree.processPending();
        // The temporary database only: the chronology is the throwaway one, found by its id and confirmed.
        rt.projects.setSetting(pid, 'chronology', null);
        rt.projects.setSetting(pid, 'chronologyResourceId', ctx.resourceId);
        const found = await rt.chronology.lookup(pid, 'P1');
        if (!found.proposed)
          throw new Error(`the throwaway chronology was not found: ${found.problems.join('; ')}`);
        rt.chronology.update('owner', pid, found.proposed);
        const ready = rt.chronology.readiness(pid);
        if (!ready.ok) throw new Error(`not ready: ${ready.message}`);
        return `F10 CHRONOLOGY page=${ctx.resourceId} age=${era.name} rows=1 events=1 calendar=${String(def.name)} confirmed (temporary database)`;
      },
    );
    if (!k1) return items;

    const k2 = await check(
      'K2',
      'a row added DIRECTLY with write_page: the result carries the chronology note',
      async () => {
        const read = await tool('read_document', {
          resource: ctx.resourceId,
          document: `${ctx.age} - Table`,
        });
        const style = rt.chronology.config(pid).style;
        const cal = rt.chronology.calendar(pid)!;
        const kcy = formatKcy(cal.parser.parse(ctx.dates[1], style.date).kcy, style.kcy);
        const lines = String(read.markdown).split('\n');
        const last = lines.reduce((at: number, l: string, i: number) => (l.startsWith('|') ? i : at), -1);
        lines.splice(last + 1, 0, `| The f10 probe’s second event | ${ctx.dates[1]} | ${kcy} |`);
        since = Date.now();
        const r = await tool('write_page', {
          page: ctx.resourceId,
          document: `${ctx.age} - Table`,
          mode: 'replace',
          markdown: lines.join('\n'),
          baseVersion: String(read.version),
          workstream: `f10-sandbox-${stamp}`,
        });
        if (r.status !== 'written')
          throw new Error(`write_page ${String(r.status)}: ${JSON.stringify(r).slice(0, 600)}`);
        if (typeof r.chronologyNote !== 'string') throw new Error('the result carries no chronology note');
        return `written; note: ${r.chronologyNote}`;
      },
    );
    if (!k2) return items;

    const k3 = await check(
      'K3',
      'the delayed check runs by itself; the sync is applied at once and verified',
      async () => {
        const deadline = Date.now() + (o.waitMs ?? 5 * 60_000);
        let runRow: Obj | undefined;
        while (Date.now() < deadline) {
          const last = rt.chronology.store.lastCheck(pid);
          runRow = rt.automation.store
            .runs(pid, { since, limit: 5 })
            .find((r) => r.trigger === 'chronology' && r.finishedAt !== null);
          if (last?.trigger === 'after-edit' && last.state !== 'running' && runRow) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        const last = rt.chronology.store.lastCheck(pid);
        if (last?.trigger !== 'after-edit')
          throw new Error(
            `no check after the edit within the wait (last: ${JSON.stringify(last ?? null).slice(0, 300)})`,
          );
        if (!runRow)
          throw new Error(`the check ran (${String(last.summary)}) but no automation run followed`);
        const item = rt.automation.store
          .items(String(runRow.id))
          .find((i) => i.code === 'chronology_row_without_event');
        if (item?.outcome !== 'applied' || !item.jobId)
          throw new Error(`not applied: ${JSON.stringify(item ?? null)} (run: ${String(runRow.summary)})`);
        const job = rt.engine.queries.getJob(pid, item.jobId)!;
        const rec = rt.chronology.store.byJob(pid, item.jobId);
        if (job.status !== 'succeeded' || rec?.state !== 'complete' || rec.detail.verified !== true)
          throw new Error(`job ${job.status}, record ${JSON.stringify(rec ?? null).slice(0, 400)}`);
        return `F10 SYNC check=${String(last.summary)} job=${item.jobId} ${job.status} verified=${String(rec.detail.verified)} workstream=${String(job.origin.workstream ?? '-')}`;
      },
    );
    if (!k3) return items;

    await check(
      'K4',
      'read back live: two events, the new one at the new row’s date, linked to the table',
      async () => {
        const list = ((
          await raw.request(
            'listEvents',
            'GET',
            `/resources/${ctx.resourceId}/docs/${ctx.timelineDoc}/events?limit=100`,
          )
        ).data ?? []) as Obj[];
        const cal = rt.chronology.calendar(pid)!;
        const want = cal.parser.parse(ctx.dates[1], rt.chronology.config(pid).style.date).start;
        const made2 = list.find((e) => e.start === want);
        const uri = `lk://resources/${ctx.resourceId}/docs/${ctx.tableDoc}`;
        if (list.length !== 2 || !made2 || made2.uri !== uri)
          throw new Error(`events: ${JSON.stringify(list.map((e) => [e.name, e.start, e.uri]))}`);
        return `F10 EVENTS ${list.length}: ${list.map((e) => `“${String(e.name)}” ${String(e.formattedStart ?? e.start)}`).join(', ')}`;
      },
    );
  } finally {
    await steps.cleanup();
  }
  return items;
}

export function formatChronologyRepairReport(items: readonly ChronologyRepairItem[]): string {
  return [
    'sandbox f10-chronology report',
    ...items.map((i) => `${i.verdict.toUpperCase().padEnd(6)} ${i.id} ${i.title}: ${i.detail}`),
    '',
  ].join('\n');
}
