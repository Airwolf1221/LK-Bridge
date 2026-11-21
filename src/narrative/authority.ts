/**
 * v3 F4c (ADR 0065, design E2): narrative pages are never canon evidence. The consistency check's facts index (F4b) is
 * built from the appraisal's snapshot overlay; it is handed a view of the overlay WITHOUT the pages under Narratives, so
 * no date, birth, death or identity fact is ever taken from a story (and one taken before is dropped at the next
 * update, as a page gone). Nothing in the consistency check itself changes: the exclusion is the overlay it is given.
 *
 * CR-2026-11-R4 (F4; ADR 0065 amendment 2): Narratives is resolved as the narrative tools resolve it (the tree's one
 * index, by id: `narrativeAuthorityRoots`), so the facts index and the tools never disagree about which pages are
 * stories; when there are several indexes of that name, the pages under EVERY one of them are left out (fail closed for
 * authority). Only when the tree cannot answer is the overlay's own name rule used, every candidate left out too.
 */
import type { Appraisal } from '../appraisal/service.js';
import type { OverlayPage } from '../appraisal/overlay.js';
import { lifecyclePrefix } from './signals.js';

const key = (s: string) => s.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-GB');

/** Which Narratives indexes to leave out: their ids (the tree's), else (null) the overlay's indexes of that name. */
export interface NarrativeRoots {
  readonly name: string | null;
  readonly roots: readonly string[] | null;
}

/**
 * The overlay's pages without those under the Narratives indexes (each index itself is kept). CR-2026-11-R4 (NA-43): a
 * page under Narratives whose name carries a lifecycle prefix (`[BSRC]`, `[BWRK]`, `[BARC]`, read as the lifecycle
 * guard reads it) is canon filed there, not fiction: it stays evidence, so a canon set moved into Narratives (by the
 * owner's approval, or in the app) never takes its births and deaths out of the checks. The narrative audit reports it
 * (`narrative_lifecycle_page`) and the writing tools refuse its story.
 */
export function withoutNarratives(
  pages: ReadonlyMap<string, OverlayPage>,
  narratives: NarrativeRoots | string | null,
): ReadonlyMap<string, OverlayPage> {
  const given =
    typeof narratives === 'string' || narratives === null ? { name: narratives, roots: null } : narratives;
  const roots = new Set(
    given.roots ??
      (given.name === null
        ? []
        : [...pages.values()]
            .filter((p) => p.kind === 'index' && key(p.displayName) === key(given.name!))
            .map((p) => p.id)),
  );
  if (roots.size === 0) return pages;
  const under = new Map<string, boolean>();
  const isUnder = (p: OverlayPage): boolean => {
    const seen: string[] = [];
    let cur: OverlayPage | undefined = p;
    let found = false;
    for (let i = 0; cur && i < 200; i++) {
      const had = under.get(cur.id);
      if (had !== undefined) {
        found = had;
        break;
      }
      seen.push(cur.id);
      if (cur.parentId !== null && roots.has(cur.parentId)) {
        found = true;
        break;
      }
      cur = cur.parentId ? pages.get(cur.parentId) : undefined;
    }
    for (const id of seen) under.set(id, found);
    return found;
  };
  const out = new Map<string, OverlayPage>();
  const canonFiled = (p: OverlayPage) => typeof p.rawName === 'string' && lifecyclePrefix(p.rawName) !== null;
  for (const [id, p] of pages) if (roots.has(id) || !isUnder(p) || canonFiled(p)) out.set(id, p);
  return out;
}

/**
 * The appraisal as the consistency check sees it: everything as it is, but `index.pages` without the narrative pages
 * (the approved pack's Narratives, resolved as the narrative tools resolve it). The filtered map is cached by the
 * overlay's own map, which the overlay keeps while it is unchanged.
 */
export function narrativeBlindAppraisal<
  A extends Pick<Appraisal, 'rules' | 'reader' | 'index' | 'store' | 'freshness'>,
>(appraisal: A, narratives: (projectId: string) => NarrativeRoots | string | null): A {
  const cache = new WeakMap<object, { key: string; pages: ReadonlyMap<string, OverlayPage> }>();
  const index = Object.create(appraisal.index) as A['index'];
  Object.defineProperty(index, 'pages', {
    value: (projectId: string) => {
      const all = appraisal.index.pages(projectId);
      const which = narratives(projectId);
      const k = JSON.stringify(which);
      const hit = cache.get(all);
      if (hit && hit.key === k) return hit.pages;
      const pages = withoutNarratives(all, which);
      cache.set(all, { key: k, pages });
      return pages;
    },
  });
  const out = Object.create(appraisal) as A;
  Object.defineProperty(out, 'index', { value: index });
  return out;
}
