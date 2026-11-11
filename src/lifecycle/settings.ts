/**
 * The page lifecycle's settings per project (v2 C2c, ADR 0035), stored in the project's settings under `lifecycle`,
 * edited on the dashboard (Projects page, Lifecycle section) and audited.
 *
 * Three states, each with a prefix, a Status value, a status tag and a place:
 * - Authoritative: `[BSRC]`, Status `Authoritative`, tag `CANON`, in its normal place (the registry's placement rules);
 * - Working: `[BWRK]`, Status `Working`, tag `Working`, directly under `[INDEX] Working`, flat, alphabetical;
 * - Archived: `[BARC]`, Status `Archived`, tag `Archived`, directly under `[INDEX] Archived`, flat, alphabetical.
 *
 * The two indexes are found by name through the tree (never by a hard-coded id or position) and stored once the owner
 * confirms them. Every other value defaults to the owner's (decided 10 November 2026); Arkona and the test world use
 * the defaults. An invalid stored value falls back to the defaults (the safe side), with the reason.
 */
import * as z from 'zod';
import type { TreeNode } from '../tree/index.js';
import { nameKey } from '../tree/index.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const id = z.string().regex(/^[a-z][0-9a-z]{1,63}$/, 'a LegendKeeper resource id');

export const lifecycleSchema = z
  .object({
    /** `[INDEX] Working` and `[INDEX] Archived`, as the owner confirmed them. */
    workingIndexId: id.nullable().optional(),
    archiveIndexId: id.nullable().optional(),
    /** The display names the two indexes are found by. */
    indexNames: z
      .object({ working: text(200), archived: text(200) })
      .strict()
      .optional(),
    /** The Status values of the three states. */
    status: z
      .object({ authoritative: text(100), working: text(100), archived: text(100) })
      .strict()
      .optional(),
    /** The status tags of the three states. */
    tags: z
      .object({ canon: text(100), working: text(100), archived: text(100) })
      .strict()
      .optional(),
    /** The facts the tools write. */
    fields: z
      .object({
        status: text(256),
        continuityType: text(256),
        scope: text(256),
        temporalScope: text(256),
        lastMajorRevision: text(256),
      })
      .strict()
      .optional(),
    /** The Continuity Type values: CANON, AU, and NON-CURRENT for archived pages. */
    continuityTypes: z
      .object({ canon: text(100), au: text(100), nonCurrent: text(100) })
      .strict()
      .optional(),
    /** The archive texts; `{date}` and `{source}` are filled in. */
    texts: z
      .object({
        noteFromAuthoritative: text(2000),
        noteFromWorking: text(2000),
        scopePrefix: text(500),
        temporalFromAuthoritative: text(500),
        temporalFromWorking: text(500),
        /** C2d (ADR 0037): an index of an archived set gets this note (optional: settings stored before keep working). */
        noteForIndex: text(2000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type StoredLifecycle = z.infer<typeof lifecycleSchema>;

export interface LifecycleConfig {
  readonly workingIndexId: string | null;
  readonly archiveIndexId: string | null;
  readonly indexNames: { readonly working: string; readonly archived: string };
  readonly status: { readonly authoritative: string; readonly working: string; readonly archived: string };
  readonly tags: { readonly canon: string; readonly working: string; readonly archived: string };
  readonly fields: {
    readonly status: string;
    readonly continuityType: string;
    readonly scope: string;
    readonly temporalScope: string;
    readonly lastMajorRevision: string;
  };
  readonly continuityTypes: { readonly canon: string; readonly au: string; readonly nonCurrent: string };
  readonly texts: {
    readonly noteFromAuthoritative: string;
    readonly noteFromWorking: string;
    readonly scopePrefix: string;
    readonly temporalFromAuthoritative: string;
    readonly temporalFromWorking: string;
    /** C2d (ADR 0037): the note an index of an archived set gets as its first block. */
    readonly noteForIndex: string;
  };
  /** Why the stored value could not be used (the defaults then apply), or null. */
  readonly problem: string | null;
}

/** The owner's values (decided 10 November 2026). */
export const DEFAULT_LIFECYCLE: Omit<LifecycleConfig, 'problem'> = Object.freeze({
  workingIndexId: null,
  archiveIndexId: null,
  indexNames: { working: 'Working', archived: 'Archived' },
  status: { authoritative: 'Authoritative', working: 'Working', archived: 'Archived' },
  tags: { canon: 'CANON', working: 'Working', archived: 'Archived' },
  fields: {
    status: 'Status',
    continuityType: 'Continuity Type',
    scope: 'Scope',
    temporalScope: 'Temporal Scope',
    lastMajorRevision: 'Last Major Revision',
  },
  continuityTypes: { canon: 'CANON', au: 'AU', nonCurrent: 'NON-CURRENT' },
  texts: {
    noteFromAuthoritative:
      'Archived - {date}. The author retired {source} and its applications from Main CANON. The text below records the former design for provenance.',
    noteFromWorking:
      'Archived - {date}. The author retired {source}, a Working concept, without adopting it into Main CANON. The text below records the former design for provenance.',
    scopePrefix: 'Archived record of the retired',
    temporalFromAuthoritative: 'Former Main CANON. Retired on {date}.',
    temporalFromWorking: 'Former Working concept. Retired on {date}.',
    // C2d (ADR 0037): the owner's proposed wording for an index archived with its set, to be confirmed by the owner.
    noteForIndex:
      'Archived - {date}. The author retired {source} and the pages beneath it. They are kept for provenance.',
  },
});

/** The lifecycle settings of a project, with the defaults filled in. Never throws. */
export function lifecycleFrom(settings: Readonly<Record<string, unknown>> | undefined): LifecycleConfig {
  const raw = settings?.lifecycle;
  if (raw === undefined || raw === null) return { ...DEFAULT_LIFECYCLE, problem: null };
  const r = lifecycleSchema.safeParse(raw);
  if (!r.success) {
    return {
      ...DEFAULT_LIFECYCLE,
      problem: `the stored lifecycle settings are not valid (${r.error.issues[0]?.message ?? 'invalid'}); the defaults apply and the indexes are not confirmed`,
    };
  }
  const d = r.data;
  return {
    workingIndexId: d.workingIndexId ?? null,
    archiveIndexId: d.archiveIndexId ?? null,
    indexNames: d.indexNames ?? DEFAULT_LIFECYCLE.indexNames,
    status: d.status ?? DEFAULT_LIFECYCLE.status,
    tags: d.tags ?? DEFAULT_LIFECYCLE.tags,
    fields: d.fields ?? DEFAULT_LIFECYCLE.fields,
    continuityTypes: d.continuityTypes ?? DEFAULT_LIFECYCLE.continuityTypes,
    // C2d: a text missing from settings stored before it existed (noteForIndex) takes its default.
    texts: {
      ...DEFAULT_LIFECYCLE.texts,
      ...(d.texts ?? {}),
      noteForIndex: d.texts?.noteForIndex ?? DEFAULT_LIFECYCLE.texts.noteForIndex,
    },
    problem: null,
  };
}

/** The stored form of a config (what the settings column keeps): only what differs from nothing. */
export function storedLifecycle(c: Omit<LifecycleConfig, 'problem'>): StoredLifecycle {
  return {
    workingIndexId: c.workingIndexId,
    archiveIndexId: c.archiveIndexId,
    indexNames: { ...c.indexNames },
    status: { ...c.status },
    tags: { ...c.tags },
    fields: { ...c.fields },
    continuityTypes: { ...c.continuityTypes },
    texts: { ...c.texts },
  };
}

/** `{date}` and `{source}` filled in. */
export function fillText(template: string, v: { readonly date: string; readonly source?: string }): string {
  return template
    .split('{date}')
    .join(v.date)
    .split('{source}')
    .join(v.source ?? '');
}

/** Today's date on the bridge's clock (Europe/London, as maintenance schedules and proposals use), in ISO form. */
export function isoDate(ms: number): string {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** The archive Scope: the prefix, one space, the original kept whole (the prefix alone when there was none). */
export function archivedScope(c: LifecycleConfig, original: string): string {
  return original === '' ? c.texts.scopePrefix : `${c.texts.scopePrefix} ${original}`;
}

// ============================================================================================ the two indexes

/** What a search for one lifecycle index by name found. */
export type IndexLookup =
  | { readonly status: 'found'; readonly node: TreeNode }
  | { readonly status: 'missing'; readonly name: string }
  | { readonly status: 'ambiguous'; readonly name: string; readonly candidates: readonly TreeNode[] };

/**
 * The index named `name` (its display name, without case) anywhere in the repository tree: exactly one, or why not.
 * Never by id or position.
 */
export function findIndexByName(nodes: Iterable<TreeNode>, name: string): IndexLookup {
  const want = nameKey(name.trim());
  const hits = [...nodes].filter((n) => n.kind === 'index' && nameKey(n.displayName.trim()) === want);
  if (hits.length === 1) return { status: 'found', node: hits[0]! };
  if (hits.length === 0) return { status: 'missing', name };
  return { status: 'ambiguous', name, candidates: hits };
}

/** The two indexes as configured, checked against the tree now. */
export type LifecycleIndexes =
  | { readonly ok: true; readonly working: TreeNode; readonly archived: TreeNode }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * The confirmed Working and Archive indexes, checked against the tree: each confirmed, still in the tree, still an
 * index, and still named as configured. Anything else is a clear refusal (the lifecycle tools never guess one).
 */
export function lifecycleIndexes(
  c: LifecycleConfig,
  node: (id: string) => TreeNode | null,
): LifecycleIndexes {
  if (c.problem) return { ok: false, code: 'LIFECYCLE_NOT_CONFIGURED', message: `The ${c.problem}.` };
  const check = (
    which: 'Working' | 'Archive',
    stored: string | null,
    name: string,
  ): TreeNode | { code: string; message: string } => {
    if (!stored) {
      return {
        code: 'LIFECYCLE_NOT_CONFIGURED',
        message: `The project's ${which} index ([INDEX] ${name}) is not confirmed yet. The owner finds and confirms it on the dashboard (Projects page, Lifecycle); until then the lifecycle tools refuse.`,
      };
    }
    const n = node(stored);
    if (!n) {
      return {
        code: 'LIFECYCLE_INDEX_MISSING',
        message: `The confirmed ${which} index (${stored}) is no longer in the repository tree. The owner confirms it again on the dashboard (Projects page, Lifecycle).`,
      };
    }
    if (n.kind !== 'index' || nameKey(n.displayName.trim()) !== nameKey(name.trim())) {
      return {
        code: 'LIFECYCLE_INDEX_CHANGED',
        message: `The confirmed ${which} index (${stored}) is now “${n.rawName}”, not “[INDEX] ${name}”. The owner confirms it again on the dashboard (Projects page, Lifecycle).`,
      };
    }
    return n;
  };
  const w = check('Working', c.workingIndexId, c.indexNames.working);
  if (!('id' in w)) return { ok: false, ...w };
  const a = check('Archive', c.archiveIndexId, c.indexNames.archived);
  if (!('id' in a)) return { ok: false, ...a };
  if (w.id === a.id) {
    return {
      ok: false,
      code: 'LIFECYCLE_NOT_CONFIGURED',
      message:
        'The Working and Archive indexes are the same page; the owner confirms them again on the dashboard.',
    };
  }
  if (w.path.ids.includes(a.id) || a.path.ids.includes(w.id)) {
    return {
      ok: false,
      code: 'LIFECYCLE_NOT_CONFIGURED',
      message: 'One lifecycle index is under the other; the owner confirms them again on the dashboard.',
    };
  }
  return { ok: true, working: w, archived: a };
}

/** Where a page is, in lifecycle terms: under the Working index, under the Archive index, or neither. */
export function areaOf(
  n: Pick<TreeNode, 'id' | 'path'>,
  ids: { readonly workingIndexId: string | null; readonly archiveIndexId: string | null },
): 'working' | 'archived' | null {
  const inside = (x: string | null) => x !== null && n.id !== x && n.path.ids.includes(x);
  if (inside(ids.workingIndexId)) return 'working';
  if (inside(ids.archiveIndexId)) return 'archived';
  return null;
}
