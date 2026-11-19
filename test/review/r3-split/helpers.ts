/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * CR-2026-11-R3 (splits, pass 1): what the adversarial split tests share, on top of the F3e test world
 * (test/packs/split-world.ts) and its helpers (test/packs/split-helpers.ts). Everything runs against the in-repo mock
 * LegendKeeper; nothing here talks to a live system.
 *
 * - `holders`: every LIVE page whose live documents hold a block id, at any depth (where a block "is" after a split);
 * - `editBody`: an edit of a page's main document as the LegendKeeper app would make it (the version moves on);
 * - `surviving`: the Ostrand statutes split with the source surviving (an interface summary per moved section);
 * - small block builders.
 */
import { expect } from 'vitest';
import { PROJECT, S, type SplitWorld } from '../../packs/split-world.js';
import { statutesSplit } from '../../packs/split-inputs.js';
import { recordOf, settle, split, type Obj } from '../../packs/split-helpers.js';

export { PROJECT, S };

export const heading = (id: string, level: number, text: string): Obj => ({
  id,
  kind: 'heading',
  level,
  content: [{ text }],
});
export const para = (id: string, text: string): Obj => ({ id, kind: 'paragraph', content: [{ text }] });

/** A block found by id at any depth. */
export function findDeep(blocks: readonly unknown[], id: string): Obj | undefined {
  for (const b of blocks) {
    if (typeof b !== 'object' || b === null) continue;
    const o = b as Obj;
    if (o.id === id) return o;
    if (Array.isArray(o.children)) {
      const hit = findDeep(o.children as unknown[], id);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** Every live page (and its document) whose live documents hold `blockId` at any depth, with the block as held. */
export function holders(w: SplitWorld, blockId: string): { pageId: string; name: string; block: Obj }[] {
  const out: { pageId: string; name: string; block: Obj }[] = [];
  for (const d of w.repo.docs.values()) {
    if (d.deletedAt !== null) continue;
    const res = w.repo.live(d.resourceId);
    if (!res) continue;
    const blocks = w.repo.blocks.get(d.id)?.blocks ?? [];
    const hit = findDeep(blocks, blockId);
    if (hit) out.push({ pageId: res.id, name: res.name, block: hit });
  }
  return out;
}

/** Every live page whose live documents hold a block with exactly this plain text (whatever its id). */
export function textHolders(w: SplitWorld, text: string): string[] {
  const out: string[] = [];
  const walk = (list: readonly unknown[]): boolean =>
    list.some((b) => {
      if (typeof b !== 'object' || b === null) return false;
      const o = b as Obj;
      const t = Array.isArray(o.content)
        ? (o.content as Obj[]).map((r) => (typeof r.text === 'string' ? r.text : '')).join('')
        : '';
      if (t === text) return true;
      return Array.isArray(o.children) && walk(o.children as unknown[]);
    });
  for (const d of w.repo.docs.values()) {
    if (d.deletedAt !== null) continue;
    const res = w.repo.live(d.resourceId);
    if (!res) continue;
    if (walk(w.repo.blocks.get(d.id)?.blocks ?? [])) out.push(res.id);
  }
  return out;
}

/** An edit of a page's main document as the app would make it: `f` changes the blocks in place; the version moves on. */
export function editBody(w: SplitWorld, pageId: string, f: (blocks: Obj[]) => void): void {
  const doc = w.repo.blocks.get(w.mainOf(pageId))!;
  f(doc.blocks as Obj[]);
  doc.version += 1;
}

/** A page's main document replaced whole (a fixture set before planning). */
export function setBody(w: SplitWorld, pageId: string, blocks: readonly Obj[]): void {
  const doc = w.repo.blocks.get(w.mainOf(pageId));
  if (doc) {
    doc.blocks = structuredClone(blocks) as unknown[];
    doc.version += 1;
  } else w.repo.blocks.set(w.mainOf(pageId), { version: 1, blocks: structuredClone(blocks) as unknown[] });
}

/** A tree of blocks without `version` fields (what was planned against what is held). */
export function noVersions(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(noVersions);
  if (typeof v !== 'object' || v === null) return v;
  const o: Obj = {};
  for (const [k, x] of Object.entries(v as Obj)) if (k !== 'version') o[k] = noVersions(x);
  return o;
}

/** The Ostrand statutes split with the source SURVIVING: each moved section keeps an interface summary. */
export function surviving(more: Record<string, unknown> = {}) {
  return statutesSplit({
    retire: false,
    map: [
      { section: 'Purpose', to: 'stays' },
      { section: 'Overview', to: 'stays' },
      { section: 'Law and Courts', to: 'law', summary: 'The statutes and the courts have their own page.' },
      { section: 'Faith and Worship', to: 'rite', summary: 'The rite is told with the Sun Rite.' },
      { section: 'Source Boundaries', to: 'stays' },
      { section: 'Unresolved Material', to: 'stays' },
    ],
    ...more,
  });
}

/** Proposes a split (expects a proposal), returning the proposal and the destination pages by key. */
export async function propose(w: SplitWorld, args: Obj) {
  const r = await split(w, args);
  expect(r.body.status, r.text).toBe('proposal_captured');
  const pages = new Map<string, { id: string; name: string }>();
  for (const d of r.body.destinations as any[])
    if (d.page) pages.set(d.key as string, d.page as { id: string; name: string });
  return {
    r,
    proposalId: String(r.body.proposalId),
    pages,
    items: (r.body.items.list as any[]).map((i) => i.id),
  };
}

/** The owner's revert of a job, with the confirmation of a partial revert when one is needed (the preview first). */
export async function ownerRevert(w: SplitWorld, jobId: string, confirmPartial = false) {
  const reverts = w.stack.runtime.reverts;
  const preview = await reverts.preview(PROJECT, jobId);
  const rv = await reverts.revert('owner', PROJECT, jobId, confirmPartial ? { confirmPartial: true } : {});
  const job = rv.status === 'submitted' ? await settle(w, rv.revertJobId) : null;
  return { preview, rv, job };
}

/** The split record once it is reverted (the deletion proposal it made, if any). */
export const reverted = (w: SplitWorld, jobId: string) => recordOf(w, jobId, (x) => x.state === 'reverted');
