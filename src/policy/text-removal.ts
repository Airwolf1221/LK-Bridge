/**
 * CR-2026-11-R3, R3-53 (ADR 0061 part B decision 1, the owner's (b)): text emptied through a low-level tool. The deletes
 * rail compared block ids only (ADR 0057 decision 4), so `lk_api_write` `replaceDocumentBlocks` keeping every id, or
 * `lk_api_batch` `updateBlock` on each paragraph, could empty a pack page's text as a direct write, where `write_page`
 * refuses the same with `USE_ARKONA_SPLIT`. Now a low-level write that takes the pack's `splits.guardWords` words or more
 * off a pack page (the split guard's own test: a page of a character's set, a page with a Subject fact, a pack owner) is
 * a removal for the deletes rail, so it becomes a proposal. The words are counted over the whole request, per page, on
 * what LegendKeeper holds now (read live); a page whose document cannot be read counts as a removal (the rail fails
 * closed). Pages that are not pack pages, and projects without an approved pack with split rules, are not read at all.
 */
import type { RailRequestItem } from '../jobs/policy.js';
import type { OpParams } from '../jobs/types.js';
import type { Packs } from '../packs/service.js';
import { packPageReason, shownWords, splitGuardWords } from '../packs/split/guard.js';
import type { TreeNode } from '../tree/types.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A pack page a request takes the guard's words or more off. */
export interface TextRemoval {
  readonly resourceId: string;
  readonly name: string;
  /** The words the request takes off the page; null when its document could not be read (counted as a removal). */
  readonly words: number | null;
  /** The pack's threshold (`splits.guardWords`). */
  readonly limit: number;
  /** Why the page is a pack page (as the split guard says it). */
  readonly why: string;
}

/** The low-level writes that can take text off a page document without dropping a block. */
const TEXT_WRITES = new Set(['replaceDocumentBlocks', 'updateBlock', 'replaceBlock']);

export interface TextRemovalDeps {
  readonly packs: Pick<Packs, 'forProject'> | undefined;
  readonly node: (
    projectId: string,
    id: string,
  ) => Pick<TreeNode, 'id' | 'kind' | 'displayName' | 'tags'> | null;
  readonly characterOf: (projectId: string, id: string) => boolean;
  /** The page's sidebar fact keys, or null when not known. */
  readonly factKeys: (projectId: string, id: string) => readonly string[] | null;
  readonly read: (projectId: string, opId: string, params: OpParams) => Promise<unknown>;
}

/** `blocks` with the block `id` (at any depth) replaced by `f(block)`. */
function withBlock(blocks: readonly unknown[], id: string, f: (b: Obj) => Obj): unknown[] {
  return blocks.map((b) => {
    if (!isObj(b)) return b;
    if (b.id === id) return f(b);
    return Array.isArray(b.children) ? { ...b, children: withBlock(b.children as unknown[], id, f) } : b;
  });
}

/** The pack pages `items` (one request) take the guard's words or more off; read live (see the module comment). */
export function textRemovalReader(
  d: TextRemovalDeps,
): (projectId: string, items: readonly RailRequestItem[]) => Promise<readonly TextRemoval[]> {
  return async (projectId, items) => {
    const limit = splitGuardWords(d.packs, projectId);
    if (limit === null) return [];
    // The text writes, by page document, in the order the request sends them.
    const docs = new Map<string, { resourceId: string; documentId: string; items: RailRequestItem[] }>();
    for (const it of items) {
      if (it.kind === 'read' || !TEXT_WRITES.has(it.opId)) continue;
      const { resourceId, documentId } = it.params.path ?? {};
      if (!resourceId || !documentId) continue;
      const key = `${resourceId}\u0000${documentId}`;
      const g = docs.get(key) ?? { resourceId, documentId, items: [] };
      g.items.push(it);
      docs.set(key, g);
    }
    const byPage = new Map<string, TextRemoval>();
    for (const g of docs.values()) {
      const node = d.node(projectId, g.resourceId);
      if (!node) continue;
      const why = packPageReason({
        packs: d.packs,
        projectId,
        node,
        characterOf: (id) => d.characterOf(projectId, id),
        factKeys: d.factKeys(projectId, g.resourceId),
      });
      if (why === null) continue;
      let before: unknown[] | null;
      try {
        const cur = await d.read(projectId, 'getDocumentBlocks', {
          path: { resourceId: g.resourceId, documentId: g.documentId },
        });
        before = isObj(cur) && Array.isArray(cur.blocks) ? (cur.blocks as unknown[]) : null;
      } catch {
        before = null; // unreadable: counted as a removal (the rail fails closed)
      }
      let removed: number | null = null;
      if (before !== null) {
        let after: unknown[] = before;
        for (const it of g.items) {
          const body = isObj(it.params.body) ? it.params.body : {};
          if (it.opId === 'replaceDocumentBlocks') {
            after = Array.isArray(body.blocks) ? (body.blocks as unknown[]) : [];
            continue;
          }
          const blockId = it.params.path?.blockId;
          if (!blockId) continue;
          after = withBlock(after, blockId, (b) =>
            it.opId === 'replaceBlock' ? { ...body, id: b.id } : { ...b, ...body },
          );
        }
        removed = shownWords(before) - shownWords(after);
      }
      const prev = byPage.get(g.resourceId);
      const words = removed === null || prev?.words === null ? null : (prev?.words ?? 0) + removed;
      byPage.set(g.resourceId, { resourceId: g.resourceId, name: node.displayName, words, limit, why });
    }
    return [...byPage.values()].filter((r) => r.words === null || r.words >= limit);
  };
}
