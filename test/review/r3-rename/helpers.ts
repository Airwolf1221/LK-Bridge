/**
 * CR-2026-11 round 3 (renames): shared helpers for the adversarial review of `arkona_rename` (ADR 0058 and its
 * Amendment of 18 November 2026). Every attack runs against the mock LegendKeeper of the rename world
 * (test/packs/rename-world.ts); nothing here touches a live system.
 *
 * Each attempt is a test that asserts the SAFE behaviour: when it passes, the attempt held; when it fails, it is a
 * finding (a bypass).
 */
import { expect } from 'vitest';
import type { MockRequest, MockResponse } from '../../contract/mock-lk.js';
import { C, PROJECT, type RenameWorld } from '../../packs/rename-world.js';
import type { JobOrigin } from '../../../src/jobs/types.js';

export type Obj = Record<string, unknown>;

export const OLD = 'Nadira al-Khalid';
export const NEW = 'Laila al-Khalid';

export const OWNER_ORIGIN = {
  kind: 'ui',
  client: 'owner',
  tool: 'job.resume',
  principal: { principalId: 'system', profile: 'owner', label: 'owner' },
} as unknown as JobOrigin;

/**
 * Runs `fn` on each request matching `method` and `path`, before the mock answers it (first in line). `fn` may change
 * the mock (an edit in the app landing just then) and return undefined to let the mock answer as usual.
 */
export function intercept(
  w: RenameWorld,
  method: string,
  path: RegExp,
  fn: (n: number, req: MockRequest) => MockResponse | undefined,
): { count: () => number } {
  let n = 0;
  const hook = (req: MockRequest) => {
    if (req.method !== method || !path.test(req.path.replace(/\/$/, ''))) return undefined;
    return fn(n++, req);
  };
  const rest = [...w.overrides.entries()];
  w.overrides.clear();
  w.overrides.set(/./, hook);
  for (const [re, f] of rest) w.overrides.set(re, f);
  return { count: () => n };
}

/** The Main document of a page, as the mock stores it. */
export const mainDoc = (w: RenameWorld, pageId: string) => w.repo.blocks.get(w.mainOf(pageId))!;

/** A block anywhere in a page's Main document, by id (the stored object itself). */
export function blockIn(w: RenameWorld, pageId: string, blockId: string): Obj {
  const find = (list: Obj[]): Obj | null => {
    for (const b of list) {
      if (b.id === blockId) return b;
      if (Array.isArray(b.children)) {
        const hit = find(b.children as Obj[]);
        if (hit) return hit;
      }
    }
    return null;
  };
  const hit = find(mainDoc(w, pageId).blocks as Obj[]);
  if (!hit) throw new Error(`no block ${blockId} on ${pageId}`);
  return hit;
}

/** An edit in the app: a block's runs replaced, the document's version moved on. */
export function outsideEdit(w: RenameWorld, pageId: string, blockId: string, content: string | Obj[]): void {
  const b = blockIn(w, pageId, blockId);
  b.content = typeof content === 'string' ? [{ text: content }] : content;
  mainDoc(w, pageId).version += 1;
}

/** A block's visible text (its runs, a mention by its label). */
export function textOf(w: RenameWorld, pageId: string, blockId: string): string {
  const b = blockIn(w, pageId, blockId);
  return ((b.content as Obj[] | undefined) ?? [])
    .map((r) => {
      if (typeof r.text === 'string') return r.text;
      const label = (r.mention as Obj | undefined)?.text;
      return typeof label === 'string' ? label : '';
    })
    .join('');
}

/** A mention run's custom label ('' for a plain mention or another run). */
export function labelOf(run: Obj): string {
  const label = (run.mention as Obj | undefined)?.text;
  return typeof label === 'string' ? label : '';
}

/** A page's sidebar facts (the SidebarModel's PROPERTIES), by key. */
export function factsOf(w: RenameWorld, id: string): Record<string, string> {
  const kv = w.sidebars.pages.get(id)?.props.find((p) => p.kind === 'keyValue');
  if (!kv) return {};
  return Object.fromEntries(
    kv.rows!.map((r) => [
      r.key,
      (r.content as Obj[]).map((x) => (typeof x.text === 'string' ? x.text : labelOf(x))).join(''),
    ]),
  );
}

/** The items of a dry run, flattened, with their group. */
export const dryItems = (body: Obj) =>
  ((body.groups as { group: string; items: Obj[] }[]) ?? []).flatMap((g) =>
    g.items.map((i) => ({ ...i, group: g.group })),
  ) as (Obj & { id: string; ticked: boolean; group: string; why?: string; label: string; diff?: Obj })[];

/** Proposes the character rename (Nadira al-Khalid → Laila al-Khalid), returning the proposal id. */
export async function proposeNadira(w: RenameWorld, more: Obj = {}): Promise<string> {
  const r = await w.call('arkona_rename', { subject: C.nadira, newName: NEW, given: 'Laila', ...more });
  expect(r.body.status, r.text).toBe('proposal_captured');
  return String(r.body.proposalId);
}

/** The items of a proposal (as captured). */
export const itemsOf = (w: RenameWorld, proposalId: string) =>
  w.stack.runtime.policy.proposals.itemsOf(proposalId)!.items;

/** The captured steps of a proposal (from proposal_ops). */
export function stepsOf(w: RenameWorld, proposalId: string): { op: string; params: Obj; options: Obj }[] {
  return (
    w.stack.db
      .prepare('SELECT idx, op_id, params, options FROM proposal_ops WHERE proposal_id = ? ORDER BY idx')
      .all(proposalId) as { op_id: string; params: string; options: string | null }[]
  ).map((r) => ({
    op: r.op_id,
    params: JSON.parse(r.params) as Obj,
    options: (r.options ? JSON.parse(r.options) : {}) as Obj,
  }));
}

/** Waits for a job to end. */
export async function settle(w: RenameWorld, jobId: string) {
  for (let i = 0; i < 1500; i++) {
    const j = w.stack.runtime.engine.queries.getJob(PROJECT, jobId)!;
    if (['succeeded', 'failed', 'cancelled'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the job did not settle');
}

/**
 * The owner approves a canonical proposal (as canon), optionally only `items` (a closed selection), and waits for its
 * job to end.
 */
export async function approveAs(w: RenameWorld, proposalId: string, items?: readonly string[]) {
  const policy = w.stack.runtime.policy;
  await policy.commands.approveAsCanon('owner', proposalId, items ? { items } : undefined);
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

/** Every item that a selection must keep for `keep` to be closed (its dependencies, transitively). */
export function closedSelection(
  items: readonly { id: string; dependsOn: readonly string[] }[],
  keep: readonly string[],
): string[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out = new Set<string>();
  const add = (id: string) => {
    if (out.has(id)) return;
    out.add(id);
    for (const d of byId.get(id)?.dependsOn ?? []) add(d);
  };
  for (const k of keep) add(k);
  return [...out];
}

/** A table row's cells' texts (its description paragraph's runs, each cell joined by " | "). */
export function rowCells(row: Obj): string[] {
  return ((row.children as Obj[]) ?? []).map((cell) =>
    ((cell.children as Obj[]) ?? [])
      .map((p) =>
        ((p.content as Obj[]) ?? []).map((r) => (typeof r.text === 'string' ? r.text : '')).join(''),
      )
      .join(' '),
  );
}

/** A row of an age's table, by id (the stored object itself). */
export function tableRow(w: RenameWorld, age: string, rowId: string): Obj {
  const doc = w.repo.blocks.get(w.ages[age]!.table)!;
  const find = (list: Obj[]): Obj | null => {
    for (const b of list) {
      if (b.id === rowId) return b;
      if (Array.isArray(b.children)) {
        const hit = find(b.children as Obj[]);
        if (hit) return hit;
      }
    }
    return null;
  };
  return find(doc.blocks as Obj[])!;
}
