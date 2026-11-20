/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- LK results are untyped JSON */
/**
 * v3 F4c (ADR 0065), opt-in, WRITES then cleans up: the narrative tools end to end on the real API. Written for the
 * owner; never run by an agent or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- narrative-f4c
 *
 * It runs on a temporary database that starts as a READ-ONLY copy of the project's settings, repository tree and packs
 * from the bridge's database (`copyBridgeState`, as the write-scope rehearsal does), so the APPROVED Arkona pack version
 * `arkona-2026-11-20-f4c` (its narrative rules) applies; it never writes to the bridge's database. The tools are called
 * as the MCP server calls them, for a temporary write-scope principal with the rails off. Each step reports PASS or FAIL:
 *
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
import { describe, expect, it } from 'vitest';
import { PatService } from '../../src/auth/pats.js';
import { AuthStore } from '../../src/auth/store.js';
import type { Principal } from '../../src/jobs/index.js';
import type { McpToolContext } from '../../src/mcp/server.js';
import { deleteProbe, rawLk, type RawLk } from './f4b-probe.js';
import { createSoakRuntime, type SoakRuntime } from './soak.js';
import { resolveSandboxTarget } from './target.js';
import { copyBridgeState } from './write-scope.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;
type Obj = Record<string, any>;
interface Item {
  readonly id: string;
  readonly title: string;
  readonly verdict: 'pass' | 'fail';
  readonly detail: string;
}

async function runCheck(sb: SoakRuntime, raw: RawLk, name: string): Promise<Item[]> {
  const rt = sb.runtime;
  const pid = sb.projectId;
  const items: Item[] = [];
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
    bridgeDbPath: process.env.DB_PATH ?? './data/bridge.db',
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
      detail: 'approve arkona-2026-11-20-f4c on the Packs page first',
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
      if (b.status !== 'written') throw new Error(JSON.stringify(b).slice(0, 300));
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
          if (b.status !== 'written' || b.readBack?.matches !== true)
            throw new Error(JSON.stringify(b).slice(0, 400));
        }
        return 'chapters 1 and 2 saved and read back';
      },
    );
    if (!ok3) return items;
    await check(
      'N4',
      'arkona_chapter_insert at 2: the later chapter and plan renumbered, read back live',
      async () => {
        const b = await tool('arkona_chapter_insert', { story: title, at: 2, title: 'Inserted' });
        if (b.status !== 'written') throw new Error(JSON.stringify(b).slice(0, 400));
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
    await check('N5', 'arkona_chapter_check, then the audit’s narrative findings for the story', async () => {
      const c = await tool('arkona_chapter_check', { story: title, number: 1 });
      await rt.snapshots.full(pid, 'manual');
      await rt.audits.run(pid, 'manual');
      const f = rt.audits
        .list(pid, { category: ['narrative'], limit: 1000 })
        .findings.filter(
          (x) =>
            x.pageName?.includes('f4c check') ||
            (x.pageId && rt.tree.queries.node(pid, x.pageId).data?.path.ids.includes(made.story!)),
        );
      return `check: ${JSON.stringify(c.counts)}; audit: ${f.map((x) => x.code).join(', ') || 'no narrative finding on the story'}`;
    });
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

describe.skipIf(!projectName)('LegendKeeper sandbox: the narrative tools (F4c, N1–N5)', () => {
  it('makes a story, saves and renumbers chapters, checks and audits them, and cleans up', async () => {
    const target = resolveSandboxTarget(projectName);
    const sb = await createSoakRuntime({
      apiKey: target.apiKey,
      project: target.name,
      ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
    });
    try {
      const raw = rawLk({
        lk: sb.lk,
        projectId: sb.projectId,
        apiKey: target.apiKey,
        ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
      });
      const items = await runCheck(sb, raw, target.name);
      process.stdout.write(
        [
          '',
          'LK-Bridge sandbox: the narrative tools (F4c, ADR 0065)',
          ...items.map((i) => `[${i.verdict.toUpperCase()}] (${i.id}) ${i.title}\n        ${i.detail}`),
          '',
        ].join('\n'),
      );
      expect(items.filter((i) => i.verdict === 'fail').map((i) => `${i.id}: ${i.detail}`)).toEqual([]);
    } finally {
      await sb.close();
    }
  }, 1_800_000);
});
