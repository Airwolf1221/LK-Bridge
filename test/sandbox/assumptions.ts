/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- LK results are untyped JSON */
/**
 * CR-2026-11: the write layer's assumptions about LegendKeeper that were checked only against the mock, checked on a
 * REAL sandbox project (opt-in; see test/sandbox/README.md, "The write layer's assumptions"). Each check names the
 * assumption it confirms (docs/reviews/CR-2026-11.md, section 6, by its id: A1 … H1) and reports PASS, FAIL or
 * INCONCLUSIVE with what LegendKeeper answered.
 *
 * Safety, as the smoke script: it refuses to run unless the key's own project (listProjects) is exactly the sandbox
 * project; every call goes through the bridge's own engine and governor (as the system, at P1; the raw calls through
 * the governor's `call` and `fetch`); everything it creates lives under ONE throwaway root resource named
 * `lk-bridge assumptions <time>`, plus two templates (`lk-bridge assumptions template A1` and `… H1`), and all three are
 * deleted at the end, even after a failure (the report names any id to delete by hand). Plain names only: no `[BSRC]`,
 * `[BWRK]`, `[BARC]` or `[INDEX]` prefix, and no Status, Continuity Type or Continuity row, so the canon and lifecycle
 * guards never stand in the way. Cost: about 75 writes and 85 reads (plus up to 12 search polls), about 2 minutes at
 * the bridge's write pacing.
 */
import { BudgetExhaustedError } from '../../src/jobs/errors.js';
import { BridgeLkError, BudgetWaitError } from '../../src/lk/errors.js';
import { mintClientId } from '../../src/jobs/ids.js';
import {
  collectionState,
  factsVersionOf,
  rowsState,
  sidebarState,
  stableJson,
} from '../../src/jobs/sidebar-state.js';
import { matchCopy } from '../../src/jobs/step-exec.js';
import { parseEtag } from '../../src/lk/governor/headers.js';
import { compareStoredBlocks } from '../../src/jobs/verify-blocks.js';
import { fromMarkdown, stubResolver } from '../../src/markdown/index.js';
import { SandboxGuardError, type Finding, type SmokeTarget, type Verdict } from './smoke.js';

type Obj = Record<string, any>;

export interface AssumptionOptions {
  /** How long the content-search check waits for new text to become searchable (default 60 s). */
  readonly searchWaitMs?: number;
  /** Between search polls (default 5 s). */
  readonly searchPollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Thrown inside a check: the assumption does not hold (a FAIL with this message). */
class Fails extends Error {}
/** Thrown inside a check: it could not tell (INCONCLUSIVE with this message). */
class Unclear extends Error {}

const fail = (m: string): never => {
  throw new Fails(m);
};
const same = (a: unknown, b: unknown) => stableJson(a ?? null) === stableJson(b ?? null);

export async function runAssumptions(
  t: SmokeTarget,
  expectedProjectId: string,
  o: AssumptionOptions = {},
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const origin = { kind: 'test' as const, client: 'sandbox-assumptions', tool: 'sandbox-assumptions' };
  const record = (id: string, title: string, verdict: Verdict, detail: string) =>
    findings.push({ id, title, verdict, detail });

  const run = async (op: string, params: Obj = {}, extra: Obj = {}): Promise<any> => {
    let r: Awaited<ReturnType<typeof t.engine.run>> | undefined;
    // A read refused for budget (the key's minute) is made again once the budget allows (at most 5 times).
    for (let i = 0; !r; i++) {
      try {
        r = await t.engine.run(op, params, { origin, priority: 'P1', project: t.projectId, ...extra });
      } catch (e) {
        if (!(e instanceof BudgetExhaustedError) || i >= 5) throw e;
        await sleep(Math.max(1000, e.retryAtMs - Date.now()));
      }
    }
    if (r.status === 'succeeded') return r.result;
    // Parked for budget or queued behind the pacing: wait for it (at most 10 minutes), never send it again.
    if ((r.status === 'waiting_budget' || r.status === 'queued') && r.jobId) {
      for (let i = 0; i < 24; i++) {
        const job = await t.engine.wait(t.projectId, r.jobId, 25_000);
        if (job.status === 'succeeded') return t.engine.stepResults(t.projectId, r.jobId)?.[0]?.value;
        if (['failed', 'cancelled'].includes(job.status))
          throw new Error(`${op} ${job.status}: ${job.lastError?.message ?? ''}`);
      }
    }
    throw new Error(`${op} did not complete: ${r.status}`);
  };
  /** A raw call through the governor: the status, headers and body LegendKeeper answered, or its error. */
  const raw = async (
    operationId: string,
    method: string,
    suffix: string,
    x: { body?: unknown; ifMatch?: string; idempotencyKey?: string } = {},
  ): Promise<{ status: number; code?: string; headers?: Headers; body?: any }> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await rawOnce(operationId, method, suffix, x);
      } catch (e) {
        if (!(e instanceof BudgetWaitError) || attempt >= 5) throw e;
        await sleep(Math.max(1000, e.retryAtMs - Date.now()));
      }
    }
  };
  const rawOnce = async (
    operationId: string,
    method: string,
    suffix: string,
    x: { body?: unknown; ifMatch?: string; idempotencyKey?: string },
  ): Promise<{ status: number; code?: string; headers?: Headers; body?: any }> => {
    try {
      const res = await t.lk.call<Response>({
        operationId,
        priority: 'P1',
        ...(x.body !== undefined ? { input: { body: x.body } } : {}),
        ...(x.idempotencyKey ? { idempotencyKey: x.idempotencyKey } : {}),
        run: () =>
          t.lk.fetch(`${t.baseUrl}/api/v3/projects/${t.projectId}${suffix}`, {
            method,
            headers: {
              authorization: `Bearer ${t.apiKey}`,
              ...(x.body !== undefined ? { 'content-type': 'application/json' } : {}),
              ...(x.ifMatch ? { 'if-match': x.ifMatch } : {}),
            },
            ...(x.body !== undefined ? { body: JSON.stringify(x.body) } : {}),
          }),
      });
      const text = await res.text();
      return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
    } catch (e) {
      if (e instanceof BudgetWaitError) throw e;
      if (e instanceof BridgeLkError) return { status: e.status ?? 0, ...(e.code ? { code: e.code } : {}) };
      throw e;
    }
  };
  const check = async (id: string, title: string, fn: () => Promise<string>) => {
    try {
      record(id, title, 'pass', await fn());
    } catch (e) {
      if (e instanceof Fails) record(id, title, 'fail', e.message);
      else record(id, title, 'inconclusive', `the check could not complete: ${(e as Error).message}`);
    }
  };

  // ---- guard: the key must belong to exactly the sandbox project --------------------------------------------------
  const projects = (await run('listProjects')) as { data?: { id: string }[] };
  const ids = (projects.data ?? []).map((x) => x.id);
  if (ids.length !== 1 || ids[0] !== expectedProjectId || t.projectId !== expectedProjectId) {
    throw new SandboxGuardError(
      `Refusing to run: the key's project is [${ids.join(', ')}], not the sandbox project ${expectedProjectId}.`,
    );
  }

  // ---- helpers ----------------------------------------------------------------------------------------------------
  const root = (await run('createResource', {
    body: { name: `lk-bridge assumptions ${new Date().toISOString()}` },
  })) as Obj;
  const rootId = root.id as string;
  const extraCleanup: { id: string; what: string }[] = [];
  /** The pages made directly under the root, deleted one subtree at a time at the end (small cascades). */
  const topLevel: string[] = [];
  const mk = async (name: string, body: Obj = {}): Promise<Obj> => {
    const made = (await run('createResource', { body: { name, parentId: rootId, ...body } })) as Obj;
    if (body.parentId === undefined) topLevel.push(made.id as string);
    return made;
  };
  const children = async (parentId: string): Promise<Obj[]> => {
    const out: Obj[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = (await run('listResources', {
        query: { parentId, limit: 100, ...(cursor ? { cursor } : {}) },
      })) as Obj;
      out.push(...((page.data ?? []) as Obj[]));
      if (page.hasMore !== true || typeof page.nextCursor !== 'string') break;
      cursor = page.nextCursor;
    }
    return out;
  };
  const byRank = (list: Obj[]) =>
    [...list].sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1));
  const names = (list: Obj[]) => byRank(list).map((x) => x.name as string);
  const rowsOf = async (rid: string, pid: string) =>
    (await run('listPropertyRows', { path: { resourceId: rid, propertyId: pid } })) as {
      data: Obj[];
      version: string;
    };
  const keysByRank = (rows: Obj[]) => byRank(rows).map((r) => r.key as string);

  let tplA1: string | null = null;

  try {
    // ---- A1, A2: a template copy keeps the template's sidebar; client ids are kept -------------------------------
    await check(
      'A1',
      'a template copy keeps the template’s properties, keys, values, order, items and filter',
      async () => {
        const src = await mk('A1 source');
        const kv = (await run('createProperty', {
          path: { resourceId: src.id },
          body: {
            kind: 'keyValue',
            title: 'PROPERTIES',
            rows: [
              { key: 'Reference Type', text: 'General Source' },
              { key: 'Scope', text: 'Sandbox' },
              { key: 'Subject', text: 'Template check' },
            ],
          },
        })) as Obj;
        const r0 = await rowsOf(src.id, kv.id);
        // A row inserted mid-list: stored order and rank order now differ (C2a.1).
        await run('createPropertyRow', {
          path: { resourceId: src.id, propertyId: kv.id },
          body: { key: 'Mood', text: 'Calm', after: byRank(r0.data)[0]!.id },
          ifMatch: r0.version,
        });
        await run('createProperty', {
          path: { resourceId: src.id },
          body: {
            kind: 'resourceCollection',
            title: 'Dependencies',
            items: [{ resourceId: rootId }],
            filter: { type: 'filter', id: 'lkbf1', filterType: 'id', operator: 'in', ids: [rootId] },
          },
        });
        const tplId = mintClientId();
        const tpl = (await run('saveResourceAsTemplate', {
          path: { resourceId: src.id },
          body: { id: tplId, name: 'lk-bridge assumptions template A1' },
        })) as Obj;
        tplA1 = (tpl.id as string) ?? tplId;
        extraCleanup.push({ id: tplA1, what: 'template A1' });
        const tplProps = ((await run('listProperties', { path: { resourceId: tplA1 } })) as Obj)
          .data as Obj[];
        const expected = tplProps.map((p) => ({
          id: p.id as string,
          kind: p.kind as string,
          title: (p.title as string) ?? '',
          ...(p.kind === 'keyValue'
            ? { rows: rowsState(p.rows).map((r) => ({ id: r.id ?? '', key: r.key, content: r.content })) }
            : {}),
          ...(p.kind === 'resourceCollection'
            ? { items: collectionState(p).items.map((i) => i.id ?? '') }
            : {}),
        }));
        if (expected.length < 2)
          fail(`the template has ${expected.length} properties; its source page had 2`);
        const copyId = mintClientId();
        const made = (await run('createResourceFromTemplate', {
          body: { templateId: tplA1, id: copyId, name: 'A1 copy', parentId: rootId },
        })) as Obj;
        const copyProps = (await run('listProperties', { path: { resourceId: copyId } })) as Obj;
        const m = matchCopy('copy', expected, copyProps);
        if (m.differences.length > 0)
          fail(`the copy is not the template's layout: ${JSON.stringify(m.differences)}`);
        // C2d (the owner's run of 11 November 2026): LegendKeeper REUSES the template's property, row and item ids in a
        // copy (ids are unique only within a page). That is its behaviour, not a failure: the bridge keys everything of
        // a page by the page and the id together (ADR 0037), and the copy check's map is then the identity. A note.
        const reused = Object.entries(m.ids).filter(([a, b]) => a === b);
        const allIds = Object.keys(m.ids).length;
        const idNote =
          reused.length === 0
            ? 'new ids'
            : reused.length === allIds
              ? `the template's ids reused (${reused.length} of ${allIds}: ${reused
                  .slice(0, 6)
                  .map(([a]) => a)
                  .join(
                    ', ',
                  )}${reused.length > 6 ? ', …' : ''}; LegendKeeper's behaviour, noted, not a failure)`
              : `${reused.length} of ${allIds} of the template's ids reused (noted, not a failure)`;
        const tc = tplProps.find((p) => p.kind === 'resourceCollection');
        const cc = (copyProps.data as Obj[]).find((p) => p.kind === 'resourceCollection');
        if (!same(collectionState(tc).filter, collectionState(cc).filter))
          fail('the collection filter was not copied as it is');
        const ranks = (props: Obj[]) =>
          rowsState(props.find((p) => p.kind === 'keyValue')?.rows).map((r) => r.rank ?? '');
        return (
          `template ${tplA1}, copy ${made.id as string}: ${expected.length} properties matched in order, rows by key and value ` +
          `in rank order; ids: ${idNote}; filter kept; ranks ${same(ranks(tplProps), ranks(copyProps.data)) ? 'equal' : 'DIFFERENT (not relied on)'}`
        );
      },
    );

    await check(
      'A2',
      'client ids are kept by saveResourceAsTemplate and createResourceFromTemplate',
      async () => {
        const src = await mk('A2 source');
        const tid = mintClientId();
        const tpl = (await run('saveResourceAsTemplate', {
          path: { resourceId: src.id },
          body: { id: tid, name: 'lk-bridge assumptions template A2' },
        })) as Obj;
        extraCleanup.push({ id: tpl.id ?? tid, what: 'template A2' });
        const cid = mintClientId();
        const copy = (await run('createResourceFromTemplate', {
          body: { templateId: tpl.id ?? tid, id: cid, name: 'A2 copy', parentId: rootId },
        })) as Obj;
        if (tpl.id !== tid)
          fail(`saveResourceAsTemplate answered id ${tpl.id as string}, not the ${tid} sent`);
        if (copy.id !== cid)
          fail(`createResourceFromTemplate answered id ${copy.id as string}, not the ${cid} sent`);
        return `template ${tid} and copy ${cid} kept`;
      },
    );

    // ---- A3, A4, A6: placement with after / before; ranks -----------------------------------------------------------
    let aParent: Obj | null = null;
    await check(
      'A3',
      'createResource places a page with after / before, among siblings, others unchanged',
      async () => {
        const P = await mk('A3 parent');
        aParent = P;
        const B = await mk('B', { parentId: P.id });
        const D = await mk('D', { parentId: P.id });
        await mk('C', { parentId: P.id, after: B.id });
        await mk('A', { parentId: P.id, before: B.id });
        await mk('E', { parentId: P.id });
        const list = await children(P.id);
        const order = names(list);
        if (!same(order, ['A', 'B', 'C', 'D', 'E'])) fail(`order by rank is ${order.join(', ')}`);
        const rankOf = (id: string) => list.find((x) => x.id === id)?.rank;
        if (rankOf(B.id) !== B.rank || rankOf(D.id) !== D.rank)
          fail('a sibling’s rank changed when another was placed');
        return `A, B, C, D, E by rank; ranks ${list.map((x) => JSON.stringify(x.rank)).join(' ')}`;
      },
    );

    await check(
      'A4',
      'moveResource and createResourceFromTemplate follow after / before, into another parent too',
      async () => {
        if (!aParent) throw new Unclear('A3 did not set up its pages');
        const P = aParent;
        const list = await children(P.id);
        const id = (n: string) => list.find((x) => x.name === n)!.id as string;
        await run('moveResource', {
          path: { resourceId: id('E') },
          body: { parentId: P.id, before: id('A') },
        });
        const P2 = await mk('A4 other parent');
        const X = await mk('X', { parentId: P2.id });
        await mk('Y', { parentId: P2.id });
        await run('moveResource', { path: { resourceId: id('C') }, body: { parentId: P2.id, after: X.id } });
        if (tplA1)
          await run('createResourceFromTemplate', {
            body: { templateId: tplA1, name: 'Dt', parentId: P.id, after: id('D') },
          });
        const p1 = names(await children(P.id));
        const p2 = names(await children(P2.id));
        const want1 = tplA1 ? ['E', 'A', 'B', 'D', 'Dt'] : ['E', 'A', 'B', 'D'];
        if (!same(p1, want1)) fail(`first parent by rank: ${p1.join(', ')} (expected ${want1.join(', ')})`);
        if (!same(p2, ['X', 'C', 'Y'])) fail(`second parent by rank: ${p2.join(', ')} (expected X, C, Y)`);
        return `${p1.join(', ')}; ${p2.join(', ')}`;
      },
    );

    await check(
      'A6',
      'listResources gives every child once, each with a unique printable rank getResource agrees with',
      async () => {
        if (!aParent) throw new Unclear('A3 did not set up its pages');
        const list = await children(aParent.id);
        const ranks = list.map((x) => x.rank);
        if (ranks.some((r) => typeof r !== 'string' || r === '' || !/^[\x20-\x7e]+$/.test(r)))
          fail(`a rank that is missing or not printable ASCII: ${JSON.stringify(ranks)}`);
        if (new Set(ranks).size !== ranks.length) fail(`shared ranks: ${JSON.stringify(ranks)}`);
        if (new Set(list.map((x) => x.id)).size !== list.length) fail('a child listed twice');
        const one = (await run('getResource', { path: { resourceId: list[0]!.id } })) as Obj;
        if (one.rank !== list[0]!.rank)
          fail(`getResource gives rank ${String(one.rank)}, the listing ${String(list[0]!.rank)}`);
        return `${list.length} children, unique ranks, getResource agrees`;
      },
    );

    // ---- A5: createManyResources order ----------------------------------------------------------------------------
    await check(
      'A5',
      'createManyResources: shared after anchors sent in reverse land alphabetical; in-batch children in send order',
      async () => {
        const P = await mk('A5 parent');
        const B = await mk('B', { parentId: P.id });
        const q = mintClientId();
        await run('createManyResources', {
          body: {
            resources: [
              { name: 'Bb', parentId: P.id, after: B.id },
              { name: 'Ba', parentId: P.id, after: B.id },
              { id: q, name: 'Q', parentId: P.id },
              { name: 'q1', parentId: q },
              { name: 'q2', parentId: q },
              { name: 'q3', parentId: q },
            ],
          },
        });
        const top = names(await children(P.id));
        const under = names(await children(q));
        if (!same(top.slice(0, 3), ['B', 'Ba', 'Bb'])) fail(`under the parent by rank: ${top.join(', ')}`);
        if (!same(under, ['q1', 'q2', 'q3'])) fail(`under Q by rank: ${under.join(', ')}`);
        const q2 = mintClientId();
        const anchored = await raw('createManyResources', 'POST', '/resources/batch', {
          body: {
            resources: [
              { id: q2, name: 'Q2', parentId: P.id },
              { name: 'q2a', parentId: q2, after: B.id },
            ],
          },
          idempotencyKey: `lkb-assume-${mintClientId(8)}`,
        });
        return (
          `${top.join(', ')}; Q: ${under.join(', ')}; an in-batch child with an anchor answered ${anchored.status}` +
          `${anchored.code ? ` ${anchored.code}` : ''} (the spec says 400; the bridge never sends one)`
        );
      },
    );

    // ---- A8, A9: tags and names ------------------------------------------------------------------------------------
    await check(
      'A8',
      'updateResource tags replace the list, keep case, and read back in a stable order',
      async () => {
        const T = await mk('A8 tags', { tags: ['Lkb-Alpha', 'port', 'Zeta'] });
        await run('updateResource', {
          path: { resourceId: T.id },
          body: { tags: ['port', 'Lkb-Archived', 'alpha'] },
        });
        const a = (await run('getResource', { path: { resourceId: T.id } })) as Obj;
        const b = (await run('getResource', { path: { resourceId: T.id } })) as Obj;
        const l = (await children(rootId)).find((x) => x.id === T.id)!;
        if (!same([...a.tags].sort(), ['Lkb-Archived', 'alpha', 'port']))
          fail(`tags read back as ${JSON.stringify(a.tags)}`);
        if (!same(a.tags, b.tags) || !same(a.tags, l.tags))
          fail(`tag order differs between reads: ${JSON.stringify([a.tags, b.tags, l.tags])}`);
        await run('updateResource', { path: { resourceId: T.id }, body: { tags: ['Port', 'port'] } });
        const c = (await run('getResource', { path: { resourceId: T.id } })) as Obj;
        return `replaced; order as stored: ${JSON.stringify(a.tags)}; sent ["Port","port"], read ${JSON.stringify(c.tags)}`;
      },
    );

    await check(
      'A9',
      'names and settings are stored exactly as sent (no trimming or normalising)',
      async () => {
        const odd = 'A9 Ōkami  no – Mori';
        const N = await mk(odd);
        const lead = await mk(' A9 leading space');
        await run('updateResource', {
          path: { resourceId: N.id },
          body: { iconColor: '#c49454', isLocked: true },
        });
        const r = (await run('getResource', { path: { resourceId: N.id } })) as Obj;
        const l = (await run('getResource', { path: { resourceId: lead.id } })) as Obj;
        if (r.name !== odd) fail(`stored ${JSON.stringify(r.name)} for ${JSON.stringify(odd)}`);
        if (r.iconColor !== '#c49454' || r.isLocked !== true)
          fail(`settings read back as ${JSON.stringify({ iconColor: r.iconColor, isLocked: r.isLocked })}`);
        return `name kept byte for byte; a leading space ${l.name === ' A9 leading space' ? 'is kept' : `is NOT kept (${JSON.stringify(l.name)}): the lifecycle guard's loose prefix reading covers this (CR-14)`}`;
      },
    );

    // ---- A10: delete and restore ----------------------------------------------------------------------------------
    await check(
      'A10',
      'a delete is soft and immediate; restore brings back the pages deleted with it, not one deleted before',
      async () => {
        const P = await mk('A10 parent');
        const C = await mk('A10 child', { parentId: P.id });
        const G = await mk('A10 grandchild', { parentId: C.id });
        const D = await mk('A10 deleted first', { parentId: P.id });
        await run('deleteResource', { path: { resourceId: D.id } });
        await run(
          'deleteResource',
          { path: { resourceId: P.id }, query: { cascade: true } },
          { confirm: 'cascade' },
        );
        const gone = async (id: string) => {
          const r = await raw('getResource', 'GET', `/resources/${id}`);
          return r.status === 404 || typeof r.body?.deletedAt === 'string';
        };
        if (!(await gone(P.id)) || !(await gone(C.id))) fail('a deleted page still reads as live');
        if ((await children(rootId)).some((x) => x.id === P.id)) fail('the deleted page is still listed');
        await run('restoreResource', { path: { resourceId: P.id } });
        const c = (await run('getResource', { path: { resourceId: C.id } })) as Obj;
        const g = (await run('getResource', { path: { resourceId: G.id } })) as Obj;
        if (c.parentId !== P.id || g.parentId !== C.id)
          fail('the descendants did not come back under the same parents');
        if (!(await gone(D.id))) fail('the page deleted separately before came back too');
        return 'gone at once (404 or deletedAt), unlisted; the cascade came back, the earlier delete stayed deleted';
      },
    );

    // ---- B11–B17: sidebar rows ------------------------------------------------------------------------------------
    const R = await mk('B rows');
    const K = (await run('createProperty', {
      path: { resourceId: R.id },
      body: {
        kind: 'keyValue',
        title: 'PROPERTIES',
        rows: [
          { key: 'R1', text: 'one' },
          { key: 'R2', text: 'two' },
          { key: 'R3', text: 'three' },
        ],
      },
    })) as Obj;
    const rowPath = (rowId?: string) => ({ resourceId: R.id, propertyId: K.id, ...(rowId ? { rowId } : {}) });
    const rowId = async (key: string) =>
      (await rowsOf(R.id, K.id)).data.find((r) => r.key === key)!.id as string;

    await check('B11', 'listPropertyRows answers a version that row writes accept as If-Match', async () => {
      const r = await rowsOf(R.id, K.id);
      if (typeof r.version !== 'string' || r.version === '') fail(`no version: ${JSON.stringify(r.version)}`);
      await run('createPropertyRow', {
        path: rowPath(),
        body: { key: 'X', text: 'x', after: await rowId('R1') },
        ifMatch: r.version,
      });
      return `version ${r.version} accepted`;
    });

    await check(
      'B12',
      'a row write’s ETag is the version the next listPropertyRows gives, and LegendKeeper accepts it as If-Match',
      async () => {
        // v2 D1.1 (ADR 0039). The owner's run of 11 November 2026 showed that createPropertyRow and updatePropertyRow
        // answer no version in their body but send an ETag header (`6f78abcf9e74a430`, `f187b4e39467a0e4`), and that a
        // delete answering 204 sends one too (B13, D25). The bridge now uses the ETag (unquoted) as the write's new
        // version for the next chained If-Match (project setting `useEtagVersions`, default on). PASS only if BOTH hold,
        // for a create, an update and a delete: (1) the ETag equals the version the next listPropertyRows gives;
        // (2) it is accepted as If-Match by the next write (sent INSTEAD of the version read). Anything else is a FAIL
        // that says which of the two did not hold, and the owner switches `useEtagVersions` off.
        const P = await mk('B12 rows');
        const prop = (await run('createProperty', {
          path: { resourceId: P.id },
          body: { kind: 'keyValue', title: 'PROPERTIES', rows: [{ key: 'K1', text: 'one' }] },
        })) as Obj;
        const suffix = `/resources/${P.id as string}/properties/${prop.id as string}/rows`;
        const start = await rowsOf(P.id, prop.id);
        if (typeof start.version !== 'string' || start.version === '')
          throw new Unclear(`listPropertyRows gave no version: ${JSON.stringify(start.version)}`);
        const problems: string[] = [];
        const notes: string[] = [];
        const ok = (res: { status: number; code?: string }, what: string) => {
          if (res.status < 200 || res.status > 299)
            throw new Unclear(`${what} answered ${res.status}${res.code ? ` ${res.code}` : ''}`);
        };
        /** The ETag as the bridge reads it (unquoted), and the version in the body, if any. */
        const versions = (res: { body?: any; headers?: Headers }) => ({
          etag: res.headers ? (parseEtag(res.headers) ?? null) : null,
          rawEtag: res.headers?.get('etag') ?? null,
          body: typeof res.body?.version === 'string' ? (res.body.version as string) : null,
        });
        /** (1) the ETag equals the next read's version. */
        const equalsNext = (what: string, v: ReturnType<typeof versions>, next: string) => {
          if (v.etag === null) problems.push(`${what} sent no ETag header`);
          else if (v.etag !== next)
            problems.push(
              `${what}'s ETag ${JSON.stringify(v.rawEtag)} is not the next listPropertyRows version ${next}`,
            );
          if (v.body !== null && v.body !== next)
            notes.push(
              `${what} also answered a version in its body (${v.body}) that is not the next read's (${next})`,
            );
        };

        // A create: sent with the version read; its ETag is then sent as If-Match by an update.
        const created = await raw('createPropertyRow', 'POST', suffix, {
          body: { key: 'K2', text: 'two' },
          ifMatch: start.version,
          idempotencyKey: `lkb-assume-${mintClientId(8)}`,
        });
        ok(created, 'createPropertyRow');
        const cv = versions(created);
        const afterCreate = await rowsOf(P.id, prop.id);
        equalsNext('createPropertyRow', cv, afterCreate.version);
        const rowK2 = afterCreate.data.find((r) => r.key === 'K2');
        if (!rowK2) fail('the created row is not listed');

        // (2) the create's ETag, not the version read, as If-Match of an update.
        const updated = await raw('updatePropertyRow', 'PATCH', `${suffix}/${rowK2!.id as string}`, {
          body: { text: 'two, changed' },
          ifMatch: cv.etag ?? afterCreate.version,
        });
        if (cv.etag !== null && updated.status === 412)
          problems.push(
            `LegendKeeper refused the create's ETag ${cv.etag} as If-Match (412 ${updated.code ?? ''})`,
          );
        else ok(updated, 'updatePropertyRow');
        const uv = versions(updated);
        const afterUpdate = await rowsOf(P.id, prop.id);
        if (updated.status >= 200 && updated.status <= 299)
          equalsNext('updatePropertyRow', uv, afterUpdate.version);

        // A delete answers 204: its ETag, then, as If-Match of the next create.
        const deleted = await raw('deletePropertyRow', 'DELETE', `${suffix}/${rowK2!.id as string}`, {
          ifMatch: uv.etag ?? afterUpdate.version,
        });
        if (uv.etag !== null && deleted.status === 412)
          problems.push(
            `LegendKeeper refused the update's ETag ${uv.etag} as If-Match (412 ${deleted.code ?? ''})`,
          );
        else ok(deleted, 'deletePropertyRow');
        const dv = versions(deleted);
        const afterDelete = await rowsOf(P.id, prop.id);
        if (deleted.status >= 200 && deleted.status <= 299)
          equalsNext('deletePropertyRow (204)', dv, afterDelete.version);
        const again = await raw('createPropertyRow', 'POST', suffix, {
          body: { key: 'K3', text: 'three' },
          ifMatch: dv.etag ?? afterDelete.version,
          idempotencyKey: `lkb-assume-${mintClientId(8)}`,
        });
        if (dv.etag !== null && again.status === 412)
          problems.push(
            `LegendKeeper refused the delete's ETag ${dv.etag} as If-Match (412 ${again.code ?? ''})`,
          );
        else ok(again, 'createPropertyRow after the delete');

        if (problems.length > 0)
          fail(
            `${problems.join('; ')}. Switch the project setting useEtagVersions off (the bridge then re-reads, as before).`,
          );
        return (
          `each write's ETag equals the next listPropertyRows version, and each was accepted as If-Match: ` +
          `create ${cv.etag}, update ${uv.etag}, delete ${dv.etag}` +
          (notes.length > 0 ? ` (${notes.join('; ')})` : '; none answered a version in its body')
        );
      },
    );

    await check(
      'B15',
      'createPropertyRow places rows with after / before; several after one anchor land in reverse send order',
      async () => {
        let v = (await rowsOf(R.id, K.id)).version;
        for (const body of [
          { key: 'Y', text: 'y', after: await rowId('R1') },
          { key: 'Z', text: 'z', before: await rowId('R3') },
          { key: 'W', text: 'w' },
        ]) {
          v = ((await run('createPropertyRow', { path: rowPath(), body, ifMatch: v })) as Obj)
            .version as string;
        }
        const r = await rowsOf(R.id, K.id);
        const got = keysByRank(r.data);
        if (!same(got, ['R1', 'Y', 'X', 'R2', 'Z', 'R3', 'W'])) fail(`by rank: ${got.join(', ')}`);
        return `by rank: ${got.join(', ')}`;
      },
    );

    await check(
      'B14',
      'row order per endpoint: listPropertyRows by rank (code units); listProperties, getProperty, getResource as stored',
      async () => {
        const lr = (await rowsOf(R.id, K.id)).data;
        const lp = ((await run('listProperties', { path: { resourceId: R.id } })) as Obj).data.find(
          (p: Obj) => p.id === K.id,
        ).rows as Obj[];
        const gp = ((await run('getProperty', { path: { resourceId: R.id, propertyId: K.id } })) as Obj)
          .rows as Obj[];
        const gr = ((await run('getResource', { path: { resourceId: R.id } })) as Obj).properties.find(
          (p: Obj) => p.id === K.id,
        ).rows as Obj[];
        const keys = (l: Obj[]) => l.map((x) => x.key as string);
        const codeUnit = byRank(lr).map((x) => x.key);
        if (!same(keys(lr), codeUnit))
          fail(`listPropertyRows is not in code-unit rank order: ${keys(lr).join(', ')}`);
        const localeOrder = [...lr]
          .sort((a, b) => String(a.rank).localeCompare(String(b.rank)))
          .map((x) => x.key);
        const stored = ['R1', 'R2', 'R3', 'X', 'Y', 'Z', 'W'];
        const shapes = { listProperties: keys(lp), getProperty: keys(gp), getResource: keys(gr) };
        const notStored = Object.entries(shapes).filter(([, v]) => !same(v, stored));
        return (
          `listPropertyRows: ${keys(lr).join(', ')} (code-unit order${same(codeUnit, localeOrder) ? '; the same as locale order for these ranks, so collation is untested here' : '; locale order would differ'}); ` +
          (notStored.length === 0
            ? 'the other three in stored order'
            : `NOT in stored order: ${notStored.map(([k, v]) => `${k} ${v.join(', ')}`).join('; ')} (the bridge compares in rank order, so this is noted, not relied on)`)
        );
      },
    );

    await check(
      'B16',
      'row values round-trip: breaks, content wins over text, null content clears, a mention keeps its fields',
      async () => {
        let v = (await rowsOf(R.id, K.id)).version;
        const put = async (key: string, body: Obj) => {
          v = ((await run('updatePropertyRow', { path: rowPath(await rowId(key)), body, ifMatch: v })) as Obj)
            .version as string;
        };
        // C2d (the owner's run of 11 November 2026, and the OpenAPI schema): LegendKeeper trims a leading or trailing
        // `{ break: true }` from a row value, so the trimmed form is what must read back. Two at each end tell whether
        // it trims them all (as the bridge does before planning, ADR 0037) or only one.
        const breaks = [
          { break: true },
          { break: true },
          { text: 'a' },
          { break: true },
          { break: true },
          { text: 'b' },
          { break: true },
          { break: true },
        ];
        const trimmed = [{ text: 'a' }, { break: true }, { break: true }, { text: 'b' }];
        await put('X', { content: breaks });
        await put('Y', { content: [{ text: 'from content' }], text: 'from text' });
        await put('Z', { content: null });
        await put('W', { content: [{ mention: { resourceId: rootId, text: 'label' } }] });
        const rows = (await rowsOf(R.id, K.id)).data;
        const c = (k: string) => rows.find((r) => r.key === k)!.content as Obj[];
        const out: string[] = [];
        if (!same(c('X'), trimmed)) {
          const oneEach = [{ break: true }, ...trimmed, { break: true }];
          out.push(
            same(c('X'), oneEach)
              ? 'only ONE leading and ONE trailing break were trimmed (the bridge trims them all: tell the bridge’s developer)'
              : same(c('X'), breaks)
                ? 'leading and trailing breaks were kept (the bridge trims them: tell the bridge’s developer)'
                : `breaks read back as ${JSON.stringify(c('X'))}, not trimmed to ${JSON.stringify(trimmed)}`,
          );
        }
        if (!same(c('Y'), [{ text: 'from content' }]))
          out.push(`content and text read back as ${JSON.stringify(c('Y'))}`);
        if (!same(c('Z') ?? [], [])) out.push(`null content read back as ${JSON.stringify(c('Z'))}`);
        const m = c('W')[0]?.mention as Obj | undefined;
        if (!m || m.resourceId !== rootId || m.text !== 'label')
          out.push(`a mention read back as ${JSON.stringify(c('W'))}`);
        if (out.length > 0) fail(out.join('; '));
        return 'leading and trailing breaks trimmed (all of them), the inner ones kept; content over text; null clears; a mention kept';
      },
    );

    await check(
      'B13',
      'a stale If-Match is refused with 412 on row update and delete; a delete answers 204 and moves the version',
      async () => {
        const stale = (await rowsOf(R.id, K.id)).version;
        await run('updatePropertyRow', {
          path: rowPath(await rowId('R3')),
          body: { text: 'three, changed' },
          ifMatch: stale,
        });
        const x = await rowId('X');
        const patch = await raw(
          'updatePropertyRow',
          'PATCH',
          `/resources/${R.id}/properties/${K.id}/rows/${x}`,
          {
            body: { text: 'stale write' },
            ifMatch: stale,
          },
        );
        const del = await raw(
          'deletePropertyRow',
          'DELETE',
          `/resources/${R.id}/properties/${K.id}/rows/${x}`,
          {
            ifMatch: stale,
          },
        );
        const still = (await rowsOf(R.id, K.id)).data.find((r) => r.id === x);
        if (patch.status !== 412 || del.status !== 412)
          fail(
            `stale writes answered ${patch.status} ${patch.code ?? ''} and ${del.status} ${del.code ?? ''}`,
          );
        if (!still || same(still.content, [{ text: 'stale write' }]))
          fail('a refused stale write changed the row');
        const now = (await rowsOf(R.id, K.id)).version;
        const ok = await raw(
          'deletePropertyRow',
          'DELETE',
          `/resources/${R.id}/properties/${K.id}/rows/${x}`,
          {
            ifMatch: now,
          },
        );
        const after = (await rowsOf(R.id, K.id)).version;
        if (ok.status !== 204 && ok.status !== 200) fail(`a current delete answered ${ok.status}`);
        if (after === now) fail('the version did not move after a delete');
        return `412 ${patch.code ?? ''}; delete answered ${ok.status} (body ${ok.body === undefined ? 'empty' : JSON.stringify(ok.body).slice(0, 80)}, ETag ${ok.headers?.get('etag') ?? 'none'})`;
      },
    );

    await check(
      'B17',
      'sidebar property bodies carry no version (or the same one on every endpoint)',
      async () => {
        const lp = ((await run('listProperties', { path: { resourceId: R.id } })) as Obj).data.find(
          (p: Obj) => p.id === K.id,
        );
        const gp = (await run('getProperty', { path: { resourceId: R.id, propertyId: K.id } })) as Obj;
        const gr = ((await run('getResource', { path: { resourceId: R.id } })) as Obj).properties.find(
          (p: Obj) => p.id === K.id,
        );
        const vs = [lp?.version, gp.version, gr?.version];
        if (vs.every((v) => v === undefined)) return 'no version on any of the three';
        if (new Set(vs).size === 1) return `the same version on all three (${String(vs[0])})`;
        return fail(
          `different versions: ${JSON.stringify(vs)} (the bridge compares versions only between reads of one kind)`,
        );
      },
    );

    await check('H2', 'the rows version: what moves it (another property’s rows, a rename)', async () => {
      const v0 = (await rowsOf(R.id, K.id)).version;
      const K2 = (await run('createProperty', {
        path: { resourceId: R.id },
        body: { kind: 'keyValue', title: 'OTHER', rows: [{ key: 'O1', text: 'o' }] },
      })) as Obj;
      const v1b = (await rowsOf(R.id, K.id)).version;
      const k2v = (await rowsOf(R.id, K2.id)).version;
      await run('updateResource', { path: { resourceId: R.id }, body: { name: 'B rows (renamed)' } });
      const v2 = (await rowsOf(R.id, K.id)).version;
      return (
        `a new property ${v1b === v0 ? 'did not move' : 'MOVED'} the first property's rows version; the two properties' rows ` +
        `versions are ${k2v === v1b ? 'the same (page-wide)' : 'different (per property)'}; a rename ${v2 === v1b ? 'did not move' : 'MOVED'} it ` +
        '(the lifecycle tools read the rows in the lock before their first row write, so either is safe)'
      );
    });

    // ---- C18–C20: link collections ---------------------------------------------------------------------------------
    await check(
      'C18',
      'updateProperty items: kept items keep id, rank and order; a new one gets an id and a later rank; the filter is kept',
      async () => {
        const A = await mk('C linked A');
        const B = await mk('C linked B');
        const F = await mk('C filtered F');
        const filter = { type: 'filter', id: 'lkbf2', filterType: 'id', operator: 'in', ids: [F.id] };
        const col = (await run('createProperty', {
          path: { resourceId: R.id },
          body: { kind: 'resourceCollection', title: 'Links', items: [{ resourceId: A.id }], filter },
        })) as Obj;
        const g1 = (await run('getProperty', { path: { resourceId: R.id, propertyId: col.id } })) as Obj;
        const items1 = (g1.items ?? []) as Obj[];
        if (items1.some((i) => i.resourceId === F.id))
          fail('C20: a page the filter matches is listed among the items');
        const a = items1[0];
        if (!a) fail(`the collection was created without its item: ${JSON.stringify(g1)}`);
        await run('updateProperty', {
          path: { resourceId: R.id, propertyId: col.id },
          body: { items: [{ id: a!.id, rank: a!.rank, resourceId: A.id }, { resourceId: B.id }] },
        });
        const g2 = (await run('getProperty', { path: { resourceId: R.id, propertyId: col.id } })) as Obj;
        const items = (g2.items ?? []) as Obj[];
        if (items[0]?.id !== a!.id || items[0]?.rank !== a!.rank)
          fail(`the kept item changed: ${JSON.stringify(items[0])}`);
        if (!items[1]?.id || !(String(items[1].rank) > String(a!.rank)))
          fail(`the new item: ${JSON.stringify(items[1])}`);
        if (!same(g2.filter, g1.filter))
          fail(`the filter changed: ${JSON.stringify(g1.filter)} → ${JSON.stringify(g2.filter)}`);
        // C19: the same sidebar from two endpoints gives the same factsVersion.
        const viaList = factsVersionOf(
          R.id as string,
          sidebarState(await run('listProperties', { path: { resourceId: R.id } })),
        );
        const viaRes = factsVersionOf(
          R.id as string,
          sidebarState(await run('getResource', { path: { resourceId: R.id } })),
        );
        if (viaList !== viaRes)
          fail(`C19: factsVersion ${viaList} from listProperties, ${viaRes} from getResource`);
        return 'items kept, new item appended, filter kept; C20 filter matches not in items; C19 factsVersion equal';
      },
    );

    await check('G30b', 'updateProperty without children keeps a text field’s children', async () => {
      const tf = (await run('createProperty', {
        path: { resourceId: R.id },
        body: {
          kind: 'textField',
          title: 'Notes',
          children: [{ kind: 'paragraph', content: [{ text: 'kept' }] }],
        },
      })) as Obj;
      await run('updateProperty', {
        path: { resourceId: R.id, propertyId: tf.id },
        body: { title: 'Notes (renamed)' },
      });
      const g = (await run('getProperty', { path: { resourceId: R.id, propertyId: tf.id } })) as Obj;
      const text = JSON.stringify(g.children ?? []);
      if (!text.includes('kept')) fail(`children after a title-only update: ${text}`);
      return 'kept';
    });

    // ---- D21–D25: page content -------------------------------------------------------------------------------------
    const Dp = await mk('D blocks');
    const doc = (Dp.documents?.[0]?.id ?? '') as string;
    const dpath = { resourceId: Dp.id, documentId: doc };

    await check(
      'D23',
      'a new page’s Main is blank and empty; its first insert makes it a page named Main',
      async () => {
        const b = (await run('getDocumentBlocks', { path: dpath })) as Obj;
        if (typeof b.version !== 'string' || (b.blocks ?? []).length !== 0)
          fail(
            `a new Main reads as ${JSON.stringify({ version: b.version, blocks: (b.blocks ?? []).length })}`,
          );
        const id1 = mintClientId();
        await run('insertBlock', {
          path: dpath,
          body: { block: { id: id1, kind: 'paragraph', content: [{ text: 'first' }] } },
          ifMatch: b.version,
        });
        const docs = ((await run('listDocuments', { path: { resourceId: Dp.id } })) as Obj).data as Obj[];
        const main = docs.find((d) => d.id === doc);
        if (main?.type !== 'page' || main?.name !== 'Main') fail(`after the insert: ${JSON.stringify(main)}`);
        return 'blank and empty; a page named Main after the first insert';
      },
    );

    await check(
      'D24',
      'insertBlock keeps the id, goes first with before, and answers a new version reads then give',
      async () => {
        const b0 = (await run('getDocumentBlocks', { path: dpath })) as Obj;
        const id2 = mintClientId();
        const r = await raw('insertBlock', 'POST', `/resources/${Dp.id}/docs/${doc}/blocks`, {
          body: {
            block: { id: id2, kind: 'paragraph', content: [{ text: 'note' }] },
            before: b0.blocks[0].id,
          },
          ifMatch: b0.version,
          idempotencyKey: `lkb-assume-${mintClientId(8)}`,
        });
        if (r.status >= 300) fail(`insertBlock answered ${r.status} ${r.code ?? ''}`);
        const a = (await run('getDocumentBlocks', { path: dpath })) as Obj;
        const b = (await run('getDocumentBlocks', { path: dpath })) as Obj;
        if (a.blocks[0]?.id !== id2) fail(`the first block is ${String(a.blocks[0]?.id)}, not ${id2}`);
        const answered = r.body?.version ?? r.headers?.get('etag');
        if (a.version === b0.version) fail('the version did not change');
        if (a.version !== b.version) fail('the version changed between two reads');
        return `id kept, first; answered version ${String(answered)} (reads give ${String(a.version)})`;
      },
    );

    await check(
      'D21',
      'replaceDocumentBlocks stores the converter’s blocks as sent (ids kept, nothing added)',
      async () => {
        const md = [
          '# Heading',
          '',
          'Plain, **bold**, *italic*, `code`, a [link](https://example.com) and [a mention](lk://resources/' +
            rootId +
            ').',
          '',
          '- one',
          '- two',
          '',
          '3. three',
          '4. four',
          '',
          '> quoted',
          '',
          '```',
          'code block',
          '```',
          '',
          '---',
          '',
          '| a | b |',
          '| --- | --- |',
          '| 1 |  |',
        ].join('\n');
        const blocks = fromMarkdown(md, [], {
          resolveMention: stubResolver({}),
          mintBlockId: () => mintClientId(),
        }).blocks;
        const v = ((await run('getDocumentBlocks', { path: dpath })) as Obj).version as string;
        await run('replaceDocumentBlocks', { path: dpath, body: { blocks }, ifMatch: v });
        const stored = ((await run('getDocumentBlocks', { path: dpath })) as Obj).blocks;
        const cmp = compareStoredBlocks(blocks, stored);
        if (!cmp.ok) fail(`${cmp.count} difference(s), first: ${JSON.stringify(cmp.differences[0])}`);
        return `${blocks.length} blocks stored as sent (the verify step's rules)`;
      },
    );

    await check(
      'D22',
      'run normalisation and a mention’s name: neighbouring runs merged, empty ones dropped; name read-only',
      async () => {
        const id = mintClientId();
        const v = ((await run('getDocumentBlocks', { path: dpath })) as Obj).version as string;
        const runs = [{ text: 'a' }, { text: 'b' }, { text: 'c', bold: true }, { text: 'd', bold: true }];
        const sent = await raw('insertBlock', 'POST', `/resources/${Dp.id}/docs/${doc}/blocks`, {
          body: {
            block: {
              id,
              kind: 'paragraph',
              content: [...runs, { mention: { resourceId: rootId, text: 'label', name: 'A forged name' } }],
            },
          },
          ifMatch: v,
          idempotencyKey: `lkb-assume-${mintClientId(8)}`,
        });
        if (sent.status >= 300) {
          return `a mention sent with a name was refused (${sent.status} ${sent.code ?? ''}): the name cannot be forged in a write`;
        }
        const stored = ((await run('getDocumentBlocks', { path: dpath })) as Obj).blocks.find(
          (b: Obj) => b.id === id,
        );
        const content = (stored?.content ?? []) as Obj[];
        const m = content.find((r) => r.mention)?.mention as Obj | undefined;
        if (m?.name === 'A forged name') fail('the mention kept the forged name: a name is NOT read-only');
        const texts = content
          .filter((r) => typeof r.text === 'string')
          .map((r) => `${r.text}${r.bold ? '(b)' : ''}`);
        return `runs read back as ${texts.join(' | ')}; the mention's name reads as ${JSON.stringify(m?.name)} (text ${JSON.stringify(m?.text)})`;
      },
    );

    await check(
      'D25',
      'deleteBlock: a stale If-Match is refused with 412; a current one answers 204',
      async () => {
        const b = (await run('getDocumentBlocks', { path: dpath })) as Obj;
        const last = b.blocks[b.blocks.length - 1].id as string;
        const fresh = mintClientId();
        await run('insertBlock', {
          path: dpath,
          body: { block: { id: fresh, kind: 'paragraph', content: [{ text: 'moves the version on' }] } },
          ifMatch: b.version,
        });
        const stale = await raw('deleteBlock', 'DELETE', `/resources/${Dp.id}/docs/${doc}/blocks/${last}`, {
          ifMatch: b.version,
        });
        if (stale.status !== 412) fail(`a stale delete answered ${stale.status} ${stale.code ?? ''}`);
        const now = ((await run('getDocumentBlocks', { path: dpath })) as Obj).version as string;
        const ok = await raw('deleteBlock', 'DELETE', `/resources/${Dp.id}/docs/${doc}/blocks/${fresh}`, {
          ifMatch: now,
        });
        if (ok.status !== 204 && ok.status !== 200) fail(`a current delete answered ${ok.status}`);
        return `412 ${stale.code ?? ''}; current: ${ok.status} (body ${ok.body === undefined ? 'empty' : 'present'}, ETag ${ok.headers?.get('etag') ?? 'none'})`;
      },
    );

    // ---- E27: document settings in listDocuments ------------------------------------------------------------------
    await check(
      'E27',
      'listDocuments shows a document’s type, isFullWidth and calendarId as written',
      async () => {
        const cals = (((await run('listCalendars')) as Obj).data ?? []) as Obj[];
        const cal = cals[0]?.id as string | undefined;
        const d = (await run('createDocument', {
          path: { resourceId: Dp.id },
          body: {
            name: 'E27 timeline',
            type: 'time',
            isFullWidth: true,
            ...(cal ? { calendarId: cal } : {}),
          },
        })) as Obj;
        const find = async () =>
          (((await run('listDocuments', { path: { resourceId: Dp.id } })) as Obj).data as Obj[]).find(
            (x) => x.id === d.id,
          );
        const a = await find();
        await run('updateDocument', {
          path: { resourceId: Dp.id, documentId: d.id },
          body: { isFullWidth: false },
        });
        const b = await find();
        const out: string[] = [];
        if (a?.type !== 'time') out.push(`type ${String(a?.type)}`);
        if (a?.isFullWidth !== true || b?.isFullWidth !== false)
          out.push(`isFullWidth ${JSON.stringify([a?.isFullWidth, b?.isFullWidth])}`);
        if (cal && a?.calendarId !== cal)
          out.push(`calendarId ${JSON.stringify(a?.calendarId)} (sent ${cal})`);
        if (out.length > 0)
          fail(
            `listDocuments shows ${out.join(', ')}: create_document and update_document verify against it`,
          );
        return `type, isFullWidth${cal ? ' and calendarId' : ' (no calendar to try calendarId)'} as written`;
      },
    );

    // ---- G30a: idempotency keys -----------------------------------------------------------------------------------
    await check(
      'G30a',
      'an Idempotency-Key replays the stored answer; the same key with another body is refused',
      async () => {
        const key = `lkb-assume-${mintClientId(8)}`;
        const body = { name: 'G30 document', type: 'page' };
        const one = await raw('createDocument', 'POST', `/resources/${Dp.id}/docs`, {
          body,
          idempotencyKey: key,
        });
        const two = await raw('createDocument', 'POST', `/resources/${Dp.id}/docs`, {
          body,
          idempotencyKey: key,
        });
        const three = await raw('createDocument', 'POST', `/resources/${Dp.id}/docs`, {
          body: { ...body, name: 'G30 other' },
          idempotencyKey: key,
        });
        const docs = (
          ((await run('listDocuments', { path: { resourceId: Dp.id } })) as Obj).data as Obj[]
        ).filter((d) => d.name === 'G30 document');
        if (one.status >= 300) throw new Unclear(`the first create answered ${one.status}`);
        if (two.body?.id !== one.body?.id || docs.length !== 1)
          fail(
            `a replay made another document (${String(one.body?.id)}, ${String(two.body?.id)}; ${docs.length} listed)`,
          );
        return `replay header ${two.headers?.get('idempotent-replay') ?? '(none)'}, same id; another body answered ${three.status} ${three.code ?? ''}`;
      },
    );

    // ---- H1: a template copied with its children ------------------------------------------------------------------
    await check(
      'H1',
      'a template saved and copied with includeChildren copies every page under it with its sidebar',
      async () => {
        const src = await mk('H1 source');
        const kid = await mk('H1 child', { parentId: src.id });
        await run('createProperty', {
          path: { resourceId: kid.id },
          body: { kind: 'keyValue', title: 'PROPERTIES', rows: [{ key: 'Scope', text: 'child scope' }] },
        });
        const tid = mintClientId();
        const tpl = (await run('saveResourceAsTemplate', {
          path: { resourceId: src.id },
          body: { id: tid, name: 'lk-bridge assumptions template H1', includeChildren: true },
        })) as Obj;
        extraCleanup.push({ id: tpl.id ?? tid, what: 'template H1' });
        const cid = mintClientId();
        await run('createResourceFromTemplate', {
          body: {
            templateId: tpl.id ?? tid,
            id: cid,
            name: 'H1 copy',
            parentId: rootId,
            includeChildren: true,
          },
        });
        const kids = await children(cid);
        const copiedKid = kids.find((k) => k.name === 'H1 child');
        if (!copiedKid) fail(`no copied child (children: ${kids.map((k) => k.name).join(', ') || 'none'})`);
        const props = (await run('listProperties', { path: { resourceId: copiedKid!.id } })) as Obj;
        if (!JSON.stringify(props).includes('child scope'))
          fail('the copied child has no copy of its sidebar');
        return 'the child and its sidebar were copied (the canon and lifecycle guards judge every copied page, CR-10)';
      },
    );

    // ---- F29: content search --------------------------------------------------------------------------------------
    await check(
      'F29',
      'content search finds a page by its text, with its path; multi-word queries; deleted pages drop out',
      async () => {
        const token = `lkbsbx${mintClientId(8)}`;
        const S = await mk('F29 page');
        const sdoc = S.documents?.[0]?.id as string;
        const v = ((await run('getDocumentBlocks', { path: { resourceId: S.id, documentId: sdoc } })) as Obj)
          .version;
        await run('replaceDocumentBlocks', {
          path: { resourceId: S.id, documentId: sdoc },
          body: {
            blocks: [
              { id: mintClientId(), kind: 'paragraph', content: [{ text: `${token} alpha gamma beta` }] },
            ],
          },
          ifMatch: v,
        });
        const search = async (q: string) =>
          (((await run('search', { query: { q, limit: 25 } })) as Obj).data ?? []) as Obj[];
        const waitMs = o.searchWaitMs ?? 60_000;
        const poll = o.searchPollMs ?? 5_000;
        let hit: Obj | undefined;
        const started = Date.now();
        for (let waited = 0; waited <= waitMs; waited += poll) {
          hit = (await search(token)).find((h) => h.resource?.id === S.id);
          if (hit) break;
          await sleep(poll);
        }
        if (!hit) fail(`not found by its text after ${Math.round(waitMs / 1000)} s`);
        const shape = typeof hit!.resource?.name === 'string' && Array.isArray(hit!.resource?.path);
        const words = async (q: string) => (await search(q)).some((h) => h.resource?.id === S.id);
        const multi = {
          'alpha beta': await words(`${token} alpha beta`),
          'beta alpha': await words(`${token} beta alpha`),
          '"alpha beta"': await words(`${token} "alpha beta"`),
        };
        await run('deleteResource', { path: { resourceId: S.id } });
        const afterDelete = await words(token);
        if (!shape) fail(`a hit's resource has no name or path: ${JSON.stringify(hit!.resource)}`);
        if (afterDelete) fail('a deleted page is still found');
        return (
          `found after about ${Math.round((Date.now() - started) / 1000)} s with name and path; multi-word: ${JSON.stringify(multi)}; ` +
          'a deleted page is not found'
        );
      },
    );
  } finally {
    // Clean up: each check's pages (one small cascade each: the canon guard lists and reads every page of a cascade at
    // entry and again inside the lock), the templates (outside the root), then the root. A delete the guard could not
    // judge for lack of budget (the key's minute) is tried again after the minute.
    // C2d (the owner's run of 11 November 2026): a page that is already gone counts as cleaned. A page under one
    // already deleted by an earlier cascade answers "… is already deleted" (or 404): it was reported as left over
    // although a read showed it gone. Any other failure is confirmed by a read before it is reported.
    const goneAlready = (e: unknown): boolean => {
      const m = (e as Error).message ?? '';
      const lk = (e as { lk?: { status?: number; code?: string } }).lk;
      const codes = [(e as { code?: string }).code, lk?.code];
      return (
        /\b404\b|NOT_FOUND|ALREADY_DELETED|already deleted|is deleted|was deleted|not found/i.test(m) ||
        lk?.status === 404 ||
        codes.includes('NOT_FOUND') ||
        codes.includes('ALREADY_DELETED')
      );
    };
    const isGone = async (id: string): Promise<boolean> => {
      try {
        const r = await raw('getResource', 'GET', `/resources/${id}`);
        return r.status === 404 || r.code === 'NOT_FOUND' || (r.status === 200 && r.body?.deletedAt != null);
      } catch {
        return false;
      }
    };
    const remove = async (id: string): Promise<string | null> => {
      for (let attempt = 0; ; attempt++) {
        try {
          await run(
            'deleteResource',
            { path: { resourceId: id }, query: { cascade: true } },
            { confirm: 'cascade' },
          );
          return null;
        } catch (e) {
          if (goneAlready(e)) return null;
          const m = (e as Error).message;
          if (attempt >= 3 || !/could not (be read|be listed|all be checked)|budget/i.test(m))
            return (await isGone(id)) ? null : m;
          await sleep(65_000);
        }
      }
    };
    const left: string[] = [];
    for (const id of [...topLevel].reverse()) {
      const why = await remove(id);
      if (why) left.push(`${id} (${why})`);
    }
    for (const x of extraCleanup) {
      const why = await remove(x.id);
      if (why) left.push(`${x.what} ${x.id} (${why})`);
    }
    const why = await remove(rootId);
    if (why) left.push(`root ${rootId} (${why})`);
    if (left.length === 0)
      record(
        'cleanup',
        'throwaway root and templates deleted',
        'pass',
        [rootId, ...extraCleanup.map((x) => x.id)].join(', '),
      );
    else
      record('cleanup', 'throwaway pages deleted', 'fail', `left: ${left.join('; ')}. Delete them by hand.`);
  }
  return findings;
}

export function formatAssumptionsReport(findings: readonly Finding[]): string {
  const mark = { pass: 'PASS', fail: 'FAIL', inconclusive: 'INCONCLUSIVE', skipped: 'SKIPPED' } as const;
  const count = (v: Verdict) => findings.filter((f) => f.verdict === v && f.id !== 'cleanup').length;
  return [
    '',
    'LK-Bridge sandbox: the write layer’s assumptions about LegendKeeper (docs/reviews/CR-2026-11.md, section 6)',
    '=============================================================================================================',
    ...findings.map((f) => `[${mark[f.verdict]}] (${f.id}) ${f.title}\n        ${f.detail}`),
    '',
    `${count('pass')} PASS, ${count('fail')} FAIL, ${count('inconclusive')} INCONCLUSIVE`,
    '',
  ].join('\n');
}
