/**
 * What a page links to (v2 C2c, ADR 0035; Part 4), read from what LegendKeeper returns. Pure.
 *
 * - Link collections: every `resourceCollection` / `resourceLink` property of a sidebar (Dependencies, Related Sources,
 *   or any other), each item's page, `via` the collection's title.
 * - Mentions: every mention run in a document's blocks (`{ mention: { resourceId } }`), and any `lk://resources/<id>`
 *   link a block holds (a link mark's `href`, a block's `uri`), `via` the document's id.
 */
import type { FoundLink } from './store.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const LK_LINK = /lk:\/\/resources\/([a-z][0-9a-z]{1,63})/g;

/** The link collections of a sidebar (`listProperties`' `data`, `getResource`'s `properties`, or the list). */
export function collectionLinks(sidebar: unknown): FoundLink[] {
  const list = Array.isArray(sidebar)
    ? sidebar
    : isObj(sidebar) && Array.isArray(sidebar.data)
      ? sidebar.data
      : isObj(sidebar) && Array.isArray(sidebar.properties)
        ? sidebar.properties
        : [];
  const out: FoundLink[] = [];
  for (const p of list as unknown[]) {
    if (!isObj(p)) continue;
    out.push(...propertyLinks(p));
  }
  return out;
}

/** The links of one property (a link collection's items; nothing for any other kind). */
export function propertyLinks(p: Obj): FoundLink[] {
  if (p.kind !== 'resourceCollection' && p.kind !== 'resourceLink') return [];
  const title = typeof p.title === 'string' ? p.title : '';
  const items = Array.isArray(p.items) ? (p.items as unknown[]) : [];
  const out: FoundLink[] = [];
  for (const it of items) {
    if (!isObj(it)) continue;
    const id = typeof it.resourceId === 'string' ? it.resourceId : null;
    if (id) out.push({ kind: 'collection', via: title, toId: id });
  }
  return out;
}

/** The pages mentioned or linked anywhere in a document's blocks (each page once). */
export function mentionLinks(blocks: unknown, documentId: string, documentName: string | null): FoundLink[] {
  const ids = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 200) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (!isObj(v)) {
      if (typeof v === 'string' && v.includes('lk://resources/')) {
        for (const m of v.matchAll(LK_LINK)) ids.add(m[1]!);
      }
      return;
    }
    const m = v.mention;
    if (isObj(m) && typeof m.resourceId === 'string') ids.add(m.resourceId);
    for (const [k, x] of Object.entries(v)) {
      if (k === 'mention') continue;
      walk(x, depth + 1);
    }
  };
  walk(blocks, 0);
  return [...ids].map((toId) => ({ kind: 'mention' as const, via: documentId, viaName: documentName, toId }));
}
