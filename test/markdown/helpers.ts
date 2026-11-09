/** Helpers for the Markdown converter tests. */
import { parseDrafts, type Draft } from '../../src/markdown/parse.js';
import type { LkBlock } from '../../src/markdown/types.js';

/** What the parser makes of Markdown, as projections (keep regions as `{ kind: '@keep', id }`), without a base page. */
export function parsedProjection(md: string): LkBlock[] {
  const conv = (d: Draft): LkBlock => {
    if (d.t === 'keep') return { kind: '@keep', id: d.id };
    if (d.t === 'raw') return { kind: '@raw', block: d.block };
    return d.children ? { ...d.own, children: d.children.map(conv) } : d.own;
  };
  return parseDrafts(md).drafts.map(conv);
}

/** Removes every `id` (to compare blocks made from Markdown alone with the originals). */
export function stripIds<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripIds) as T;
  if (typeof v !== 'object' || v === null) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (k !== 'id') out[k] = stripIds(x);
  return out as T;
}

/** All blocks of a tree, depth first. */
export function allBlocks(blocks: readonly LkBlock[]): LkBlock[] {
  const out: LkBlock[] = [];
  const walk = (list: readonly unknown[]) => {
    for (const b of list) {
      if (typeof b !== 'object' || b === null) continue;
      out.push(b as LkBlock);
      const kids = (b as LkBlock).children;
      if (Array.isArray(kids)) walk(kids);
    }
  };
  walk(blocks);
  return out;
}

export const p = (text: string, id?: string): LkBlock => ({
  ...(id ? { id } : {}),
  kind: 'paragraph',
  content: text === '' ? [] : [{ text }],
});
export const h = (level: number, text: string, id?: string): LkBlock => ({
  ...(id ? { id } : {}),
  kind: 'heading',
  level,
  content: [{ text }],
});
