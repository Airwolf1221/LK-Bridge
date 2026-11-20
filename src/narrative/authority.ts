/**
 * v3 F4c (ADR 0065, design E2): narrative pages are never canon evidence. The consistency check's facts index (F4b) is
 * built from the appraisal's snapshot overlay; it is handed a view of the overlay WITHOUT the pages under Narratives, so
 * no date, birth, death or identity fact is ever taken from a story (and one taken before is dropped at the next
 * update, as a page gone). Nothing in the consistency check itself changes: the exclusion is the overlay it is given.
 */
import type { Appraisal } from '../appraisal/service.js';
import type { OverlayPage } from '../appraisal/overlay.js';

const key = (s: string) => s.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-GB');

/** The overlay's pages without those under the one index named `narratives` (all of them when it is missing or twice). */
export function withoutNarratives(
  pages: ReadonlyMap<string, OverlayPage>,
  narratives: string | null,
): ReadonlyMap<string, OverlayPage> {
  if (!narratives) return pages;
  const roots = [...pages.values()].filter(
    (p) => p.kind === 'index' && key(p.displayName) === key(narratives),
  );
  if (roots.length !== 1) return pages;
  const root = roots[0]!.id;
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
      if (cur.parentId === root) {
        found = true;
        break;
      }
      cur = cur.parentId ? pages.get(cur.parentId) : undefined;
    }
    for (const id of seen) under.set(id, found);
    return found;
  };
  const out = new Map<string, OverlayPage>();
  for (const [id, p] of pages) if (id === root || !isUnder(p)) out.set(id, p);
  return out;
}

/**
 * The appraisal as the consistency check sees it: everything as it is, but `index.pages` without the narrative pages
 * (the approved pack's Narratives index, found by name). The filtered map is cached by the overlay's own map, which the
 * overlay keeps while it is unchanged.
 */
export function narrativeBlindAppraisal<
  A extends Pick<Appraisal, 'rules' | 'reader' | 'index' | 'store' | 'freshness'>,
>(appraisal: A, narrativesName: (projectId: string) => string | null): A {
  const cache = new WeakMap<object, { name: string | null; pages: ReadonlyMap<string, OverlayPage> }>();
  const index = Object.create(appraisal.index) as A['index'];
  Object.defineProperty(index, 'pages', {
    value: (projectId: string) => {
      const all = appraisal.index.pages(projectId);
      const name = narrativesName(projectId);
      const hit = cache.get(all);
      if (hit && hit.name === name) return hit.pages;
      const pages = withoutNarratives(all, name);
      cache.set(all, { name, pages });
      return pages;
    },
  });
  const out = Object.create(appraisal) as A;
  Object.defineProperty(out, 'index', { value: index });
  return out;
}
