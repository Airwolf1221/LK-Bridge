/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- LK results are untyped JSON */
/**
 * v3 F4c (ADR 0065), opt-in, WRITES then cleans up: the narrative tools end to end on the real API. Written for the
 * owner; never run by an agent or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- narrative-f4c
 *
 * It runs on a temporary database that starts as a READ-ONLY copy of the project's settings, repository tree and packs
 * from the bridge's database (`copyBridgeState`, as the write-scope rehearsal does), so the APPROVED Arkona pack version
 * `arkona-2026-11-20-f4c` or later (its narrative rules) applies; it never writes to the bridge's database. The tools are called
 * as the MCP server calls them, for a temporary write-scope principal with the rails off. Each step reports PASS or FAIL:
 *
 * - **C1** the chronology's calendar, kept (copied from the bridge's database) or read now (ADR 0064 amendment 2);
 * - **N1** Narratives is found by name; Main CANON is found, or made (a plain index, with the sandbox's RAW client, as
 *   the consistency-f4b check makes its probe: the audit's "Propose a fix" is the owner's route on Arkona);
 * - **N2** `arkona_story_create`: a throwaway story `lk-bridge f4c check <time>` with one act (its Story Map first, its
 *   act index and Act Map);
 * - **N3** two Chapter Plans (gate closed) and two chapters (`arkona_chapter_save`), each read back word for word, its
 *   dateline first;
 * - **N4** `arkona_chapter_insert` at 2: chapter 2 becomes 3, plan 2 becomes 3, a new Chapter 2 Plan: names and Chapter
 *   Number fields read back live;
 * - **N5** `arkona_chapter_check` on chapter 1, then a full snapshot and an audit: the story's narrative findings listed.
 *
 * Clean-up: the throwaway story deleted with everything under it, and Main CANON if this run made it, with the raw
 * client, even after a failure; the report names what must be deleted by hand. Cost: about 60 writes and 40 reads, plus
 * a full snapshot of the test world.
 */
import { pino } from 'pino';
import { PatService } from '../../src/auth/pats.js';
import { AuthStore } from '../../src/auth/store.js';
import type { Principal } from '../../src/jobs/index.js';
import type { McpToolContext } from '../../src/mcp/server.js';
import { firstDifference, wordsOf } from '../../src/mcp/tools/narrative.js';
import { deleteProbe, type RawLk } from './f4b-probe.js';
import type { SoakRuntime } from './soak.js';
import { copyBridgeState } from './write-scope.js';

type Obj = Record<string, any>;
export interface NarrativeCheckItem {
  readonly id: string;
  readonly title: string;
  readonly verdict: 'pass' | 'fail';
  readonly detail: string;
}

/**
 * The check's steps (C1, N1 to N5), for the real run (`narrative-f4c.test.ts`) and, CR-2026-11-R4 (the owner's request
 * S), the ordinary suite's run against the mock (`test/sandbox-mock/narrative-f4c.test.ts`), through the same runtime
 * and harness. `bridgeDbPath`: the bridge's database the state is copied from, read-only.
 */
export async function runNarrativeCheck(
  sb: SoakRuntime,
  raw: RawLk,
  name: string,
  o: { readonly bridgeDbPath: string },
): Promise<NarrativeCheckItem[]> {
  const rt = sb.runtime;
  const pid = sb.projectId;
  const items: NarrativeCheckItem[] = [];
  const check = async (id: string, title: string, fn: () => Promise<string>): Promise<boolean> => {
    try {
      items.push({ id, title, verdict: 'pass', detail: await fn() });
      return true;
    } catch (e) {
      items.push({ id, title, verdict: 'fail', detail: (e as Error).message });
      return false;
    }
  };
  const copied = copyBridgeState({
    bridgeDbPath: o.bridgeDbPath,
    target: sb.db,
    projectId: pid,
    runtime: rt,
  });
  const pack = rt.packs.get('arkona');
  if (
    !copied.packs.includes('arkona') ||
    !pack?.approved ||
    pack.approved.version !== pack.version ||
    !pack.rules.narrative
  ) {
    items.push({
      id: 'N0',
      title: 'the approved Arkona pack has narrative rules',
      verdict: 'fail',
      detail: 'approve arkona-2026-11-21-r4 (or arkona-2026-11-20-f41, -f4c) on the Packs page first',
    });
    return items;
  }
  const rules = pack.rules.narrative;
  // A temporary write-scope principal, the rails off (as the write-scope rehearsal's).
  const profile = rt.policy.commands.createProfile('owner', {
    label: `f4c check ${Date.now()}`,
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
    pats.create({ name: 'f4c check', profileId: profile.id, expiresInDays: 1 }).pat.id,
  )!.principal;
  const silent = pino({ level: 'silent' }) as unknown as McpToolContext['log'];
  const tool = async (t: string, args: Obj): Promise<Obj> => {
    const provider = rt.tools.find((x) => x.name === t)!;
    const parsed = provider.inputSchema.safeParse({ project: name, ...args });
    if (!parsed.success) throw new Error(`${t}: ${parsed.error.message}`);
    const res = await provider.handler(parsed.data, {
      caller: undefined,
      signal: AbortSignal.timeout(15 * 60_000),
      log: silent,
      principal: who,
      scope: 'write',
      showLowLevelTools: true,
    });
    const text = (res.content as readonly { text?: string }[]).map((c) => c.text ?? '').join('\n');
    const body = JSON.parse(text.split('\n').slice(0, -1).join('\n')) as Obj;
    if (res.isError === true)
      throw new Error(`${t}: ${String(body.error?.code)} ${String(body.error?.message)}`);
    return body;
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const title = `lk-bridge f4c check ${stamp}`;
  const made: { main: string | null; story: string | null } = { main: null, story: null };
  const find = (parent: string, display: string) =>
    rt.tree.queries
      .children(pid, parent)
      .data.find((n) => n.displayName.toLowerCase() === display.toLowerCase()) ?? null;
  try {
    // ADR 0064 amendment 2: the chronology's calendar first, as consistency-f4b's F1 does (the owner's run of 20 November
    // 2026 failed at N3 with CALENDAR_UNAVAILABLE: the copied state lacked the kept calendar). Through the loader every
    // date-reading tool uses: kept (copied from the bridge's database), else read now (one request).
    const ok0 = await check('C1', 'the chronology’s calendar, as the chronology tools keep it', async () => {
      const calendarId = rt.chronology.config(pid).calendarId;
      if (!calendarId) throw new Error('the chronology’s calendar is not confirmed on this project');
      const r = await rt.chronology.loadCalendar(pid);
      if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
      return `calendar ${r.calendar.engine.name} (${calendarId}), ${r.source}; ${copied.calendars} calendar(s) copied from the bridge’s database`;
    });
    if (!ok0) return items;
    const ok1 = await check('N1', 'Narratives found by name; Main CANON found or made', async () => {
      const narr = rt.tree.queries
        .findByName(pid, rules.indexes.narratives, { fields: ['display'] })
        .data.filter((m) => m.node.kind === 'index');
      if (narr.length !== 1) throw new Error(`${narr.length} indexes are named ${rules.indexes.narratives}`);
      const narratives = narr[0]!.node.id;
      if (!find(narratives, rules.indexes.main)) {
        const r = await raw.request('createResource', 'POST', '/resources', {
          name: `[INDEX] ${rules.indexes.main}`,
          parentId: narratives,
          tags: [rules.tags.narrative],
        });
        made.main = String(r.id);
        await rt.tree.sweep(pid, 'manual');
        await rt.tree.whenIdle();
      }
      return made.main ? `made ${made.main}` : 'found';
    });
    if (!ok1) return items;
    const pov = rt.tree.queries.byKind(pid, 'bsrc').data.find((n) => n.referenceType === 'Character Core');
    if (!pov) {
      items.push({
        id: 'N0',
        title: 'a Character Core for the POV',
        verdict: 'fail',
        detail: 'the test world has no Character Core',
      });
      return items;
    }
    const ok2 = await check('N2', 'arkona_story_create: one act, the Story Map first', async () => {
      const b = await tool('arkona_story_create', { continuity: rules.indexes.main, title, acts: ['One'] });
      if (b.status !== 'written')
        throw new Error(`status ${String(b.status)}; the whole answer: ${JSON.stringify(b)}`);
      made.story = String(b.story.id);
      const kids = rt.tree.queries.children(pid, made.story).data.map((n) => n.displayName);
      if (kids[0] !== rules.names.storyMap) throw new Error(`children: ${kids.join(', ')}`);
      return kids.join(', ');
    });
    if (!ok2) return items;
    const ok3 = await check(
      'N3',
      'two plans and two chapters, each read back word for word, its dateline first',
      async () => {
        const seen: string[] = [];
        for (const n of [1, 2]) {
          await tool('arkona_chapter_plan', { story: title, number: n, act: 1, questionGate: 'closed' });
          const b = await tool('arkona_chapter_save', {
            story: title,
            number: n,
            act: 1,
            title: n === 1 ? 'First' : 'Second',
            inWorldDate: '5A 931',
            place: 'the test harbour',
            pov: pov.id,
            charactersPresent: [pov.id],
            locations: [],
            draftStatus: 'Draft',
            markdown: `The probe chapter ${n}, written by the sandbox check.`,
          });
          // CR-2026-11-R4 (the owner's run: N3 failed with the answer cut at 400 characters, so which condition
          // failed was lost): a job still running after the tool's inline wait is followed to its end and read back
          // here as the tool reads back (what the job sent, to the document it sent it to); every failure says which
          // condition failed and carries the whole answer.
          let readBack = b.readBack as Obj | undefined;
          if (b.status === 'queued' || b.status === 'waiting_budget') {
            const job = await settleJob(rt, pid, String(b.jobId));
            if (job.status !== 'succeeded')
              throw new Error(
                `the save's job ${String(b.jobId)} ended ${job.status}, not succeeded; the whole answer: ${JSON.stringify(b)}`,
              );
            readBack = await readBackSent(rt, raw, pid, String(b.jobId), String(b.chapter?.id ?? ''));
          } else if (b.status !== 'written')
            throw new Error(
              `status ${String(b.status)} (not written); the whole answer: ${JSON.stringify(b)}`,
            );
          if (readBack?.matches !== true)
            throw new Error(
              `the read-back did not match (readBack.matches is ${JSON.stringify(readBack?.matches ?? null)}): ${JSON.stringify(readBack ?? null)}; the whole answer: ${JSON.stringify(b)}`,
            );
          seen.push(
            `chapter ${n}: ${String(readBack.words)} words read back (${String(readBack.compared ?? 'the Markdown')})`,
          );
        }
        return `chapters 1 and 2 saved and read back: ${seen.join('; ')}`;
      },
    );
    if (!ok3) return items;
    await check(
      'N4',
      'arkona_chapter_insert at 2: the later chapter and plan renumbered, read back live',
      async () => {
        const b = await tool('arkona_chapter_insert', { story: title, at: 2, title: 'Inserted' });
        if (b.status !== 'written')
          throw new Error(`status ${String(b.status)}; the whole answer: ${JSON.stringify(b)}`);
        const live = async (id: string) => await raw.request('getResource', 'GET', `/resources/${id}`);
        const out: string[] = [];
        for (const r of b.renumbered as Obj[]) {
          const now = await live(String(r.id));
          if (now.name !== r.to)
            throw new Error(`${String(r.from)} reads back as ${String(now.name)}, not ${String(r.to)}`);
          out.push(`${String(r.from)} → ${String(now.name)}`);
        }
        return out.join('; ');
      },
    );
    await check(
      'N5',
      'a full snapshot, arkona_chapter_check, then the audit’s narrative findings for the story',
      async () => {
        // CR-2026-11-R4: the snapshot first. The check reads the chapter and canon through the snapshots, and this run's
        // own database has none until it takes one (on the mock, N5 answered CHAPTER_UNREADABLE).
        await rt.snapshots.full(pid, 'manual');
        const c = await tool('arkona_chapter_check', { story: title, number: 1 });
        await rt.audits.run(pid, 'manual');
        const f = rt.audits
          .list(pid, { category: ['narrative'], limit: 1000 })
          .findings.filter(
            (x) =>
              x.pageName?.includes('f4c check') ||
              (x.pageId && rt.tree.queries.node(pid, x.pageId).data?.path.ids.includes(made.story!)),
          );
        return `check: ${JSON.stringify(c.counts)}; audit: ${f.map((x) => x.code).join(', ') || 'no narrative finding on the story'}`;
      },
    );
  } finally {
    for (const [what, id] of [
      ['the throwaway story', made.story],
      ['Main CANON (made by this run)', made.main],
    ] as const)
      if (id)
        try {
          await deleteProbe(raw, id);
        } catch (e) {
          items.push({
            id: 'cleanup',
            title: `${what} deleted`,
            verdict: 'fail',
            detail: `${id}: ${(e as Error).message}. Delete it by hand.`,
          });
        }
  }
  return items;
}

/** A job followed to its end (at most ten minutes). */
async function settleJob(rt: SoakRuntime['runtime'], pid: string, jobId: string) {
  const end = Date.now() + 10 * 60_000;
  for (;;) {
    const j = rt.engine.queries.getJob(pid, jobId);
    if (!j) throw new Error(`no job ${jobId}`);
    if (['succeeded', 'failed', 'cancelled'].includes(j.status) || Date.now() > end) return j;
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/**
 * CR-2026-11-R4: a chapter read back as `arkona_chapter_save` reads it back once its job is done: what the job sent as
 * the chapter's text (its last `replaceDocumentBlocks` step, as stored once bound and filled), against that document
 * read now with the raw client, word for word.
 */
async function readBackSent(
  rt: SoakRuntime['runtime'],
  raw: RawLk,
  pid: string,
  jobId: string,
  chapterId: string,
): Promise<Obj> {
  const job = rt.engine.queries.getJob(pid, jobId)!;
  for (const s of [...job.steps].reverse()) {
    if (s.opId !== 'replaceDocumentBlocks') continue;
    const params = (s.params ??
      (s.paramsArtifactId
        ? rt.engine.queries.readArtifact(pid, s.paramsArtifactId)?.data
        : null)) as Obj | null;
    if (params?.path?.resourceId !== chapterId || typeof params.path.documentId !== 'string') continue;
    const got = await raw.request(
      'getDocumentBlocks',
      'GET',
      `/resources/${chapterId}/docs/${String(params.path.documentId)}/blocks`,
    );
    const want = wordsOf((params.body?.blocks ?? []) as unknown[]);
    const diff = firstDifference(want, wordsOf((got.blocks ?? []) as unknown[]));
    return {
      matches: diff === null,
      words: want.length,
      documentId: String(params.path.documentId),
      compared: 'what the job sent',
      ...(diff ? { firstDifference: diff } : {}),
    };
  }
  return { matches: null, note: `the job ${jobId} holds no text step for ${chapterId}` };
}

/** The report as the real run prints it: every item whole (CR-2026-11-R4: never a slice of a tool's answer). */
export function formatNarrativeReport(items: readonly NarrativeCheckItem[]): string {
  return [
    '',
    'LK-Bridge sandbox: the narrative tools (F4c, ADR 0065)',
    ...items.map((i) => `[${i.verdict.toUpperCase()}] (${i.id}) ${i.title}\n        ${i.detail}`),
    '',
  ].join('\n');
}
