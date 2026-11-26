/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- parsed JSON and mock documents */
/**
 * CR-2026-11-R4 (pass 2, "Pick the right value"): shared helpers for the adversarial review of the owner's pick (ADR 0064
 * D6 and its amendments). Every attempt runs on F4b's test world (test/consistency/world.ts: the REAL server, runtime,
 * MCP transport, policy, engine and audits against the mock LegendKeeper), with characters of its own added through the
 * world's seed hook, exactly as test/consistency/audit-pick.test.ts adds Leila Darvish's notes. Nothing here touches a
 * live system.
 *
 * A "person" is an identity page (a Character Core under the Humans index, its sidebar built as F4b's world builds its
 * own), and "pages": other pages that restate the person (their bodies, and optionally a sidebar whose Subject is the
 * person, which makes its identity fields and Temporal Scope a restatement).
 */
import { expect } from 'vitest';
import type { Finding } from '../../../src/audits/types.js';
import { SidebarModel } from '../../resources/world.js';
import { approve, IDENTITY_KEYS } from '../../packs/world.js';
import { C, f4bWorld, ownerClient, PROJECT, type F4bWorld } from '../../consistency/world.js';

export { C, PROJECT, ownerClient, approve };
export type { F4bWorld };

type Obj = Record<string, any>;
/** A sidebar value: plain text, or LegendKeeper runs (bold, links, breaks, mentions). */
export type Value = string | Obj[];

export const t = (text: string, marks: Obj = {}): Obj => ({ text, ...marks });
export const para = (id: string, ...runs: Obj[]): Obj => ({ id, kind: 'paragraph', content: runs });
export const heading = (id: string, text: string, level = 2): Obj => ({
  id,
  kind: 'heading',
  level,
  content: [{ text }],
});

export interface PageSpec {
  readonly id: string;
  readonly name: string;
  /** Default: the Humans index. */
  readonly parent?: string;
  /** Default: CANON (an Authoritative page: a disagreement with the Core is Contradictory, so the audit lists it). */
  readonly tags?: readonly string[];
  readonly referenceType?: string;
  readonly blocks: readonly Obj[];
  /** Identity rows (Subject …) when the page restates the person in its sidebar. */
  readonly sidebar?: Readonly<Record<string, Value>>;
}

export interface Person {
  /** Four lowercase letters: the ids are `<key>idx1` (index) and `<key>cor1` (Core). */
  readonly key: string;
  readonly name: string;
  readonly given: string;
  readonly family: string;
  /** The Core's identity values over the defaults (Temporal Scope, Life State, Race / Species …). */
  readonly core: Readonly<Record<string, Value>>;
  readonly coreBlocks?: readonly Obj[];
  readonly pages?: readonly PageSpec[];
}

export const coreOf = (p: Person) => `${p.key}cor1`;
export const indexOf = (p: Person) => `${p.key}idx1`;

const canon = {
  Status: 'Authoritative',
  'Continuity Type': 'CANON',
  Continuity: 'Main',
  Inheritance: 'None',
};

/** F4b's world with these people and their pages, the tree rebuilt and one full snapshot taken (the audit runs). */
export async function r4World(people: readonly Person[]): Promise<F4bWorld> {
  const w = await f4bWorld({
    seed: (world) => {
      const r = world.repo;
      for (const p of people) {
        r.seed({ id: indexOf(p), name: `[INDEX] ${p.name}`, parentId: C.humans });
        r.seed({
          id: coreOf(p),
          name: `[BSRC] ${p.name} - Character Core`,
          parentId: indexOf(p),
          referenceType: 'Character Core',
          canonical: p.name,
          tags: ['CANON', 'Character', 'Human'],
        });
        for (const pg of p.pages ?? [])
          r.seed({
            id: pg.id,
            name: pg.name,
            parentId: pg.parent ?? C.humans,
            ...(pg.referenceType ? { referenceType: pg.referenceType } : {}),
            tags: [...(pg.tags ?? ['CANON'])],
          });
      }
    },
  });
  const kv = (id: string, v: Readonly<Record<string, Value>>, keys: readonly string[]) =>
    w.sidebars.page(id, [
      SidebarModel.kv(
        `kv${id}`.slice(0, 8),
        'PROPERTIES',
        keys.map((k) => [k, v[k] ?? ''] as [string, string | Obj[]]),
      ),
      SidebarModel.links(`dp${id}`.slice(0, 8), 'Dependencies', []),
      SidebarModel.links(`rl${id}`.slice(0, 8), 'Related Sources', []),
      { id: `tg${id}`.slice(0, 8), kind: 'unsupported' as const, title: 'TAGS' },
    ]);
  for (const p of people) {
    kv(
      coreOf(p),
      {
        ...canon,
        Subject: p.name,
        'Canonical Display Name': p.name,
        'Personal / Given Name': p.given,
        'Family / Surname': p.family,
        'Naming Culture': 'Velaran',
        'Reference Type': 'Character Core',
        Scope: `${p.name}, a person of Arkona`,
        'Race / Species': 'Human',
        'Life State': 'Alive',
        'Last Major Revision': '2026-11-01',
        Supersedes: 'None',
        ...p.core,
      },
      IDENTITY_KEYS,
    );
    w.setBody(coreOf(p), [
      heading(`${p.key}c1`, 'Purpose'),
      para(`${p.key}c2`, t(`The identity of ${p.name}.`)),
      ...(p.coreBlocks ?? []),
    ]);
    for (const pg of p.pages ?? []) {
      if (pg.sidebar)
        kv(pg.id, { ...canon, 'Reference Type': 'General Source', ...pg.sidebar }, IDENTITY_KEYS);
      w.setBody(pg.id, [...pg.blocks]);
    }
  }
  w.rebuildTree();
  await w.snapshot();
  return w;
}

// ------------------------------------------------------------------------------------------------ findings and picks

export const audits = (w: F4bWorld) => w.stack.runtime.audits;

/** The open consistency finding of a subject with this code (a birth, a death, an identity fact, a chronology row). */
export function findingOf(w: F4bWorld, subject: string, code: string): Finding {
  const all = audits(w).list(PROJECT, {
    category: ['consistency'],
    acknowledged: 'include',
    limit: 500,
  }).findings;
  const f = all.find((x) => x.code === code && x.evidence.subject === subject && x.state === 'open');
  expect(
    f,
    `no open ${code} finding for ${subject}: ${JSON.stringify(all.map((x) => [x.code, x.evidence.subject]))}`,
  ).toBeDefined();
  return f!;
}

/** The finding's values as the dashboard shows them (the identity page's first). */
export async function valuesOf(w: F4bWorld, f: Finding): Promise<Obj[]> {
  const r = await ownerClient(w).get(`/audits/findings/${f.id}/consistency?project=test`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.values as Obj[];
}

/** The owner's pick, with the step-up done on the session first. */
export async function pick(
  w: F4bWorld,
  f: Finding,
  body: { side?: string; value?: string },
): Promise<{ status: number; json: Obj }> {
  const o = ownerClient(w);
  o.reauth();
  return o.post(`/audits/findings/${f.id}/consistency-pick?project=test`, { confirm: true, ...body });
}

/** The owner picks the side whose page is `pageId` (its value as the dashboard shows it). */
export async function pickPage(w: F4bWorld, f: Finding, pageId: string) {
  const values = await valuesOf(w, f);
  const side = values.find((v) => v.page.id === pageId);
  expect(side, `no value of ${pageId} in ${JSON.stringify(values)}`).toBeDefined();
  return { shown: side!, r: await pick(w, f, { side: side!.key as string }) };
}

/** Approves a proposal (with a selection of items when given) and waits for its job. */
export async function approveAndWait(w: F4bWorld, proposalId: string, items?: readonly string[]) {
  const policy = w.stack.runtime.policy;
  if (items) await policy.commands.approve('owner', proposalId, { items });
  else return approve(w, proposalId);
  for (let i = 0; i < 1500; i++) {
    const p = policy.proposals.get(proposalId)!;
    if (['executed', 'failed', 'conflicted'].includes(p.state)) {
      const job = p.jobId ? w.stack.runtime.engine.queries.getJob(PROJECT, p.jobId) : undefined;
      if (job && !['succeeded', 'failed', 'cancelled'].includes(job.status)) {
        await new Promise((r) => setTimeout(r, 20));
        continue;
      }
      return { state: p.state, jobId: p.jobId, job };
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the proposal did not finish');
}

/**
 * v3 F12 (ADR 0081): the owner's pick, confirmed, runs its edits at once as ONE job (no proposal). Waits for that job
 * and answers as `approveAndWait` did (`state` 'executed' for a job that succeeded, 'failed' otherwise).
 */
export async function pickDone(w: F4bWorld, json: Obj) {
  expect(typeof json.jobId, JSON.stringify(json)).toBe('string');
  expect(json.proposalId, 'a confirmed pick makes no proposal').toBeUndefined();
  const job = await settle(w, String(json.jobId));
  return { state: job.status === 'succeeded' ? 'executed' : 'failed', jobId: job.id, job };
}

/**
 * v3 F12: holds every write (the engine's kill switch) so that a test can change a page between the pick (its plan)
 * and its job's run, as it could before between the pick and its approval. Answers the release.
 */
export function holdWrites(w: F4bWorld): () => void {
  w.stack.runtime.engine.controls.pauseWrites('test');
  return () => void w.stack.runtime.engine.controls.resumeWrites('test');
}

/** Waits until a job has stopped. */
export async function settle(w: F4bWorld, jobId: string) {
  for (let i = 0; i < 1500; i++) {
    const j = w.stack.runtime.engine.queries.getJob(PROJECT, jobId);
    if (j && ['succeeded', 'failed', 'cancelled'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the job did not settle');
}

/** Reverts a job as the owner does (confirming a partial revert when asked) and waits for the revert job. */
export async function revert(w: F4bWorld, jobId: string, o: { confirmPartial?: boolean } = {}) {
  const r = (await w.stack.runtime.reverts.revert('owner', PROJECT, jobId, o)) as Obj;
  if (r.status !== 'submitted') return { r, job: undefined };
  return { r, job: await settle(w, String(r.revertJobId)) };
}

// ------------------------------------------------------------------------------------------------ the mock's pages

/** A page's Main document as the mock holds it. */
export const docOf = (w: F4bWorld, pageId: string) => w.repo.blocks.get(w.mainOf(pageId))!;

function findBlock(list: readonly Obj[], id: string): Obj | undefined {
  for (const b of list) {
    if (b.id === id) return b;
    if (Array.isArray(b.children)) {
      const hit = findBlock(b.children as Obj[], id);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** One block's runs, as the mock holds them. */
export const runsOf = (w: F4bWorld, pageId: string, blockId: string): Obj[] =>
  structuredClone((findBlock(docOf(w, pageId).blocks as Obj[], blockId)?.content ?? []) as Obj[]);

/** One block's plain text (a mention by its label). */
export const textOf = (w: F4bWorld, pageId: string, blockId: string): string =>
  runsOf(w, pageId, blockId)
    .map((r) =>
      typeof r.text === 'string' ? r.text : typeof r.mention?.text === 'string' ? r.mention.text : '',
    )
    .join('');

/** An edit in the LegendKeeper app: a block's runs replaced, the document's version moved on. */
export function outsideBlock(w: F4bWorld, pageId: string, blockId: string, runs: Obj[]): void {
  const doc = docOf(w, pageId);
  const b = findBlock(doc.blocks as Obj[], blockId)!;
  b.content = runs;
  doc.version += 1;
}

/** An edit in the LegendKeeper app: a block inserted at the top of the page. */
export function outsideInsert(w: F4bWorld, pageId: string, block: Obj, at = 0): void {
  const doc = docOf(w, pageId);
  (doc.blocks as Obj[]).splice(at, 0, block);
  doc.version += 1;
}

/** A sidebar row's runs, as the mock holds them. */
export function rowRuns(w: F4bWorld, pageId: string, key: string): Obj[] {
  const p = w.sidebars.pages.get(pageId)!.props.find((x) => x.title === 'PROPERTIES')!;
  return structuredClone((p.rows ?? []).find((r) => r.key === key)?.content ?? []);
}

/** A sidebar row's text (a break as a new line, a mention by its label). */
export const rowText = (w: F4bWorld, pageId: string, key: string): string =>
  rowRuns(w, pageId, key)
    .map((r) =>
      typeof r.text === 'string'
        ? r.text
        : r.break === true
          ? '\n'
          : typeof r.mention?.text === 'string'
            ? r.mention.text
            : '',
    )
    .join('');

/** An edit in the LegendKeeper app: a sidebar row's value (or key) changed, the sidebar's version moved on. */
export function outsideRow(w: F4bWorld, pageId: string, key: string, value: Value, newKey?: string): void {
  w.sidebars.outside(pageId, (sb) => {
    const p = sb.props.find((x) => x.title === 'PROPERTIES')!;
    const row = (p.rows ?? []).find((r) => r.key === key)!;
    row.content = typeof value === 'string' ? (value === '' ? [] : [{ text: value }]) : value;
    if (newKey !== undefined) row.key = newKey;
  });
}

/** Runs `fn` on each request matching `method` and `path`, before the mock answers it (first in line). */
export function intercept(
  w: F4bWorld,
  method: string,
  path: RegExp,
  fn: (n: number) => void,
): { count: () => number; off: () => void } {
  let n = 0;
  let on = true;
  const ws = w as unknown as { overrides: Map<RegExp, (req: { method: string; path: string }) => undefined> };
  const rest = [...ws.overrides.entries()];
  ws.overrides.clear();
  ws.overrides.set(new RegExp('.'), (req) => {
    if (on && req.method === method && path.test(req.path.replace(/\/$/, ''))) fn(n++);
    return undefined;
  });
  for (const [re, f] of rest) ws.overrides.set(re, f);
  return { count: () => n, off: () => (on = false) };
}

/** The writes (non-GET requests) the mock received so far whose path matches `re`. */
export const writesTo = (w: F4bWorld, re: RegExp) =>
  w.stack.mock.calls.filter((c) => c.method !== 'GET' && re.test(c.path.replace(/\/$/, ''))).length;

/** Every proposal of the project (any state). */
export const proposalCount = (w: F4bWorld) =>
  w.stack.runtime.policy.proposals.list({ project: PROJECT, limit: 1000 }).length;
