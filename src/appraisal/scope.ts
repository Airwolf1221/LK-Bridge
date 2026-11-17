/**
 * The appraisal's scope and labels (v3 F3c, ADR 0054; the design's decision D1).
 *
 * - **Lifecycle**: Authoritative (`[BSRC]`), Working (`[BWRK]`, or anything inside the Working area), Archived
 *   (`[BARC]`, or anything inside the Archived area); an index outside both areas has none.
 * - **Branch**: the top-level index of the AI REPOSITORY a page sits in (`Characters`, `Continents`…).
 * - **Non-current areas**, excluded from the full-text search (and from a branch or whole-repository appraisal) unless
 *   asked for with `include`: the **Legacy Canon Archive** (`legacy`) and the **Design References** (`design`), each an
 *   index found by its name anywhere in the repository, as the lifecycle indexes are (never a hard-coded id); the design
 *   area also takes every index the owner lists as "Authoritative without CANON" (the lifecycle setting of E5.3).
 */
import { DEFAULT_LIFECYCLE, type LifecycleConfig } from '../lifecycle/settings.js';
import { nameKey } from '../tree/classify.js';

export type AreaKey = 'legacy' | 'design';

export interface AreaRule {
  readonly key: AreaKey;
  readonly label: string;
  /** The index names that mark the area (prefix aside, case and surrounding spaces ignored). */
  readonly names: readonly string[];
}

/** The non-current areas (the design's D1): data, so another project's names can be added here. */
export const NON_CURRENT_AREAS: readonly AreaRule[] = [
  { key: 'legacy', label: 'Legacy Canon Archive', names: ['Legacy Canon Archive'] },
  { key: 'design', label: 'Design References', names: ['Design References'] },
];

export const AREA_KEYS: readonly AreaKey[] = ['legacy', 'design'];

export type Lifecycle = 'Authoritative' | 'Working' | 'Archived';

export interface Labels {
  readonly lifecycle: Lifecycle | null;
  readonly branch: string | null;
  readonly area: AreaKey | null;
}

/** What labelling needs from the project's settings. */
export interface LabelContext {
  readonly rootId: string | null;
  readonly workingIndexId: string | null;
  readonly archiveIndexId: string | null;
  readonly indexNames: { readonly working: string; readonly archived: string };
  /** The design area's extra indexes (the lifecycle's canon-exempt indexes). */
  readonly designIndexIds: ReadonlySet<string>;
}

export function labelContext(
  rootId: string | null,
  lifecycle: Omit<LifecycleConfig, 'problem'> | null,
): LabelContext {
  const l = lifecycle ?? DEFAULT_LIFECYCLE;
  return {
    rootId,
    workingIndexId: l.workingIndexId,
    archiveIndexId: l.archiveIndexId,
    indexNames: l.indexNames,
    designIndexIds: new Set(l.canonExemptIndexes),
  };
}

const areaNames = new Map<string, AreaKey>(
  NON_CURRENT_AREAS.flatMap((a) => a.names.map((n) => [nameKey(n), a.key] as [string, AreaKey])),
);

/** A path from the root (both ends included): ids, display names and kinds. */
export interface LabelPath {
  readonly ids: readonly string[];
  readonly names: readonly string[];
  readonly kinds: readonly string[];
}

/**
 * A page's labels from its path. The root is `ids[0]` when the path starts at the root; the branch is the first index
 * below it. An area index labels itself and everything beneath.
 */
export function labelsOf(path: LabelPath, ctx: LabelContext): Labels {
  const n = path.ids.length;
  const kind = path.kinds[n - 1] ?? '';
  let area: AreaKey | null = null;
  let inWorking = false;
  let inArchived = false;
  for (let i = 0; i < n; i++) {
    const id = path.ids[i]!;
    const k = path.kinds[i] ?? '';
    const key = nameKey(path.names[i] ?? '');
    if (k === 'index' || k === 'root') {
      const a = areaNames.get(key);
      if (a && area === null) area = a;
      if (ctx.designIndexIds.has(id) && area === null) area = 'design';
    }
    if (i < n - 1 || k === 'index') {
      if (
        ctx.workingIndexId
          ? id === ctx.workingIndexId
          : k === 'index' && key === nameKey(ctx.indexNames.working)
      )
        inWorking = true;
      if (
        ctx.archiveIndexId
          ? id === ctx.archiveIndexId
          : k === 'index' && key === nameKey(ctx.indexNames.archived)
      )
        inArchived = true;
    }
  }
  const lifecycle: Lifecycle | null =
    kind === 'bsrc'
      ? 'Authoritative'
      : kind === 'bwrk'
        ? 'Working'
        : kind === 'barc'
          ? 'Archived'
          : inWorking
            ? 'Working'
            : inArchived
              ? 'Archived'
              : null;
  const fromRoot = ctx.rootId !== null && path.ids[0] === ctx.rootId ? 1 : 0;
  const branch = n > fromRoot ? (path.names[fromRoot] ?? null) : null;
  return { lifecycle, branch, area };
}

/** Whether a page with these labels is in the search's default scope, given what `include` asked for. */
export function inScope(l: Labels, include: ReadonlySet<string>): boolean {
  return l.area === null || include.has(l.area);
}
