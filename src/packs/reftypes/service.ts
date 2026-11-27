/**
 * v3 F6a (ADR 0076; design T1, T2, T3): the Reference Type vocabulary's service.
 *
 * - **The report** (`arkona_reference_types`, the dashboard's Reference Types page): every Reference Type value in use
 *   across the AI REPOSITORY, from the bridge's stored sidebars (free), the Legacy Canon Archive, the Design References,
 *   Working, Archived and Narratives pages left out (and counted). One row per value and primary category: its count, its
 *   pages, the suggestion (by rules only: src/packs/reftypes/suggest.ts) and its status (`canonical`, `mapped`,
 *   `specialist`, `rejected`, `open`). Coverage is stated as `query_facts` states it: a stale or missing read is shown,
 *   never silently skipped.
 * - **The owner's decisions** (dashboard only, audited): accept, edit (another canonical value, or a new
 *   one added to the category with its role word), reject, keep as specialist; bulk accept; undo before applied.
 * - **Publish** the vocabulary to Source Formatting's "Reference Type Vocabulary" (under "Sidebar Metadata"): ONE job of
 *   the bridge's (`replaceDocumentBlocks`, If-Match the version read, journalled, verified); publishing again replaces
 *   the section in place. Once it has run, the governance check offers the pack's new version (the section as the
 *   authority), which the owner approves on the Packs page.
 *
 * The vocabulary the bridge works with (`effective`): the pack version's own list (the draft, or the section as the
 * version read it), plus the additions of decisions not published yet (a new canonical value, a specialist type). When
 * the published section and a decision disagree (the owner edited the section by hand), the section wins: the decision
 * is marked as conflicting and adds nothing.
 */
import { createHash } from 'node:crypto';
import type { BackgroundRunner } from '../../background.js';
import type { Db } from '../../db/open.js';
import { prepared } from '../../db/statements.js';
import { SYSTEM_PRINCIPAL, type JobEngine, type JobView } from '../../jobs/index.js';
import { labelContext, labelsOf } from '../../appraisal/scope.js';
import { lifecycleFrom } from '../../lifecycle/settings.js';
import type { ProjectSettings } from '../../projects/settings.js';
import type { TreeQueries } from '../../tree/index.js';
import { categoryFromTags, vocabularyOf } from '../retag/engine.js';
import type { Packs } from '../service.js';
import type { Pack, PackRules, ReferenceTypeRules } from '../types.js';
import { ReferenceTypeStore, type ReferenceTypeDecision } from './store.js';
import { suggest, type Suggestion } from './suggest.js';
import { sectionLines, spliceSection, typeKey, type VocabularyLists } from './vocabulary.js';

export class ReferenceTypeError extends Error {
  override readonly name = 'ReferenceTypeError';
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

export const PUBLISH_TOOL = 'reftypes.publish';
/** A stored sidebar read longer ago than this is `stale` (the tree's own "confirmed within 26 hours", as query_facts). */
export const STALE_AFTER_MS = 26 * 3_600_000;
export const STATUSES = ['canonical', 'mapped', 'specialist', 'rejected', 'open'] as const;
export type RowStatus = (typeof STATUSES)[number];

export interface ReferenceTypeDeps {
  readonly db: Db;
  readonly packs: Pick<Packs, 'forProject' | 'approvedRules' | 'get' | 'governance'>;
  readonly tree: { readonly queries: TreeQueries };
  readonly projectSettings: (projectId: string) => Readonly<ProjectSettings>;
  readonly engine: Pick<JobEngine, 'internalRead' | 'submit' | 'events'> & {
    readonly queries: { getJob(projectId: string, id: string): JobView | undefined };
  };
  readonly projectName: (projectId: string) => string | null;
  readonly audit: (
    actor: string,
    action: string,
    target: string | null,
    before?: unknown,
    after?: unknown,
  ) => void;
  readonly now: () => number;
  readonly log?: { warn(obj: Record<string, unknown>, msg: string): void };
  /**
   * v3 F6a.1: the runtime's background work: the governance check after a publication goes through it (debounced, one at
   * a time per pack, at P3, aborted and awaited on stop). Without it (a bare test), the check is awaited inline.
   */
  readonly background?: BackgroundRunner;
  /** v3 F6a.1: REFTYPE_BULK_MAX, read on each use (default 500). */
  readonly bulkMax?: () => number | undefined;
}

/** v3 F6a.1: REFTYPE_BULK_MAX's default. */
export const DEFAULT_BULK_MAX = 500;

/** v3 F6a.1: a row's stable id (its value and primary category), what the page sends to "Accept all". */
export function rowIdOf(value: string, category: string): string {
  return `rtr_${createHash('sha256')
    .update(`${value}\u0000${typeKey(category)}`)
    .digest('hex')
    .slice(0, 16)}`;
}

/** v3 F6a.1: a page in the report's scope, as the cached base keeps it. */
interface ScopePage {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly pathIds: readonly string[];
  /** The primary category ('' when none). */
  readonly category: string;
  readonly lifecycle: string | null;
  /** The Reference Type as stored ('' when none). */
  readonly value: string;
  /** Its properties were never read. */
  readonly missing: boolean;
  readonly lastReadAt: number;
  readonly stale: boolean;
}

/** v3 F6a.1: the report's cached base (see `prepare`). */
interface Base {
  readonly key: string;
  readonly pages: readonly ScopePage[];
  readonly excluded: Readonly<Record<string, number>>;
  readonly rules: PackRules;
  readonly approved: boolean;
  readonly pack: Pack;
}

/** v3 F6a.1: the rows built from a base under the decisions in force (cached on both). */
interface Assembled {
  readonly key: string;
  readonly rows: readonly ReportRow[];
  readonly head: Omit<Report, 'rows' | 'totalRows'>;
  readonly effective: EffectiveVocabulary;
}

/** v3 F6a.1: a row "Accept all" left as it was, and why. */
export interface BulkSkip {
  readonly id: string;
  readonly value: string | null;
  readonly category: string | null;
  readonly reason:
    'not_in_use' | 'already_decided' | 'already_canonical' | 'not_open' | 'no_confident_suggestion';
}

export interface BulkAcceptResult {
  readonly accepted: readonly ReferenceTypeDecision[];
  /** The rows it changed, as they now stand. */
  readonly rows: readonly ReportRow[];
  readonly skipped: readonly BulkSkip[];
  /** A filter's confident rows beyond REFTYPE_BULK_MAX, left for the next request. */
  readonly remaining: number;
  readonly max: number;
}

/** The vocabulary in force, with what the decisions add and where they conflict with the published section. */
export interface EffectiveVocabulary {
  readonly status: ReferenceTypeRules['status'];
  readonly lists: VocabularyLists;
  /** Decision id → why the published section contradicts it (the section wins). */
  readonly conflicts: ReadonlyMap<string, string>;
  /** Decisions whose additions are not in the version's vocabulary yet (the next publish writes them). */
  readonly pending: readonly string[];
}

export interface ReportPage {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly category: string | null;
  readonly lifecycle: string | null;
  readonly coverage: 'ok' | 'stale';
  readonly readAt: string;
  /** A specialist decision (or listed type) covers this page. */
  readonly specialist?: boolean;
}

export interface ReportRow {
  /** v3 F6a.1: the row's stable id (`rowIdOf`). */
  readonly id: string;
  readonly value: string;
  /** The pages' primary category ('' when they have none). */
  readonly category: string;
  readonly count: number;
  readonly pages: readonly ReportPage[];
  readonly status: RowStatus;
  readonly suggestion: {
    readonly value: string | null;
    readonly kind: Suggestion['kind'];
    readonly reason: string;
    readonly moved: Suggestion['moved'];
    readonly synonyms: readonly string[];
    readonly candidates: Suggestion['candidates'];
    readonly canonicalIn?: string;
  };
  readonly decision: ReferenceTypeDecision | null;
  /** The published section contradicts this row's decision (the section wins). */
  readonly conflict: string | null;
}

export interface ReportFilter {
  readonly category?: string | undefined;
  readonly status?: readonly RowStatus[] | undefined;
  readonly minCount?: number | undefined;
  /** A branch's page id: only pages under it (it included). */
  readonly underId?: string | undefined;
  /** v3 F6a.1: values containing this text (any case): the page's "Value contains", on the server so paging holds. */
  readonly valueContains?: string | undefined;
}

export interface Report {
  readonly pack: { readonly id: string; readonly version: number; readonly approvedVersion: number | null };
  readonly vocabulary: { readonly status: ReferenceTypeRules['status']; readonly approved: boolean };
  readonly rows: readonly ReportRow[];
  readonly totalRows: number;
  readonly coverage: {
    readonly pages: number;
    readonly ok: number;
    readonly stale: number;
    readonly missing: number;
    readonly withoutReferenceType: number;
    readonly oldestRead: string | null;
    /** Pages whose sidebar was never read (their Reference Type is unknown), at most 50. */
    readonly unread: readonly { readonly id: string; readonly name: string; readonly path: string }[];
    readonly tree: {
      readonly status: string;
      readonly confirmedAt: string | null;
      readonly reason?: string;
    };
  };
  readonly excluded: Readonly<Record<string, number>>;
}

type Obj = Record<string, unknown>;

/** The vocabulary in force given the version's rules and the decisions (see the module comment). */
export function effectiveVocabulary(
  rt: ReferenceTypeRules,
  decisions: readonly ReferenceTypeDecision[],
): EffectiveVocabulary {
  const categories = rt.categories.map((c) => ({ category: c.category, types: [...c.types] }));
  const specialist = [...rt.specialist];
  const conflicts = new Map<string, string>();
  const pending: string[] = [];
  const has = (name: string) =>
    categories
      .flatMap((c) => c.types.map((t) => ({ c: c.category, t })))
      .find((x) => typeKey(x.t.name) === typeKey(name));
  const published = rt.status === 'published';
  // A decision the published section already holds (or contradicts) adds nothing; one not published yet adds.
  for (const d of decisions) {
    const carry = !published || d.publishedAt === null;
    if (d.action === 'map' && d.target !== null && d.targetNew) {
      const there = has(d.target);
      if (there) continue;
      if (carry) {
        let cat = categories.find((c) => typeKey(c.category) === typeKey(d.category));
        if (!cat) {
          cat = { category: d.category, types: [] };
          categories.push(cat);
        }
        cat.types.push({ name: d.target, role: d.role ?? d.target });
        pending.push(d.id);
      } else
        conflicts.set(
          d.id,
          `the published vocabulary has no “${d.target}” (the section was edited): the section wins`,
        );
    } else if (d.action === 'specialist') {
      const there = specialist.find((s) => s.type === d.value && typeKey(s.category) === typeKey(d.category));
      if (there) continue;
      if (carry) {
        specialist.push({
          type: d.value,
          category: d.category,
          pages: d.pages === null ? null : [...d.pages],
        });
        pending.push(d.id);
      } else
        conflicts.set(
          d.id,
          `the published vocabulary does not list “${d.value}” as a specialist type of ${d.category || 'no category'} (the section was edited): the section wins`,
        );
    }
  }
  // A mapping whose target the vocabulary does not hold, a rejected value the section made canonical.
  for (const d of decisions) {
    if (conflicts.has(d.id)) continue;
    if (d.action === 'map' && d.target !== null && !has(d.target))
      conflicts.set(d.id, `“${d.target}” is not in the vocabulary in force: the section wins`);
    if (d.action === 'reject' && published && has(d.value))
      conflicts.set(d.id, `the published section makes “${d.value}” canonical`);
  }
  return { status: rt.status, lists: { rule: rt.rule, categories, specialist }, conflicts, pending };
}

/** The canonical names of a vocabulary, by type key → category. */
export function canonicalIndex(
  v: VocabularyLists,
): Map<string, { name: string; category: string; role: string }> {
  const out = new Map<string, { name: string; category: string; role: string }>();
  for (const c of v.categories)
    for (const t of c.types) out.set(t.name, { name: t.name, category: c.category, role: t.role });
  return out;
}

/** Whether `value` is an approved specialist type for this page (its category, and the page when restricted). */
export function isSpecialist(
  v: VocabularyLists,
  value: string,
  category: string,
  pageId: string | null,
): boolean {
  return v.specialist.some(
    (s) =>
      s.type === value &&
      typeKey(s.category) === typeKey(category) &&
      (s.pages === null || (pageId !== null && s.pages.some((p) => p.id === pageId))),
  );
}

/** What a creation tool says about a Reference Type (design T1 step 6): `ok`, `warn` (draft) or `refuse` (published). */
export function creationCheck(
  rules: PackRules | null,
  value: string,
  category: string | null,
): {
  readonly verdict: 'ok' | 'warn' | 'refuse';
  readonly message?: string;
  readonly nearest?: string | null;
} {
  const rt = rules?.referenceTypes;
  if (!rt || value.trim() === '') return { verdict: 'ok' };
  const v: VocabularyLists = { rule: rt.rule, categories: rt.categories, specialist: rt.specialist };
  if (canonicalIndex(v).has(value.trim())) return { verdict: 'ok' };
  if (
    category !== null &&
    v.specialist.some(
      (s) => s.type === value.trim() && typeKey(s.category) === typeKey(category) && s.pages === null,
    )
  )
    return { verdict: 'ok' };
  const s = suggest(value, category, v, rt.normalise);
  const nearest = s.value ?? s.candidates[0]?.name ?? null;
  const said = `“${value}” is not in the Reference Type vocabulary${category ? ` for ${category}` : ''}${nearest ? `; the nearest canonical value is “${nearest}”` : ''}. A Reference Type names the page’s role: use the vocabulary (arkona_reference_types shows it), never invent a type.`;
  return rt.status === 'published'
    ? { verdict: 'refuse', message: `${said} An approved specialist type is accepted.`, nearest }
    : {
        verdict: 'warn',
        message: `${said} (The vocabulary is still a draft: this is a warning only.)`,
        nearest,
      };
}

/**
 * v3 F6a (ADR 0076): promote_page's warning when a page being promoted has a Reference Type outside the vocabulary (a
 * Working page is checked at promotion), or null. `sidebar`: the page's properties as read live.
 */
export function promotionWarning(
  rules: PackRules | null,
  page: { readonly name: string; readonly tags: readonly string[] },
  sidebar: readonly {
    readonly kind: string;
    readonly title: string;
    readonly rows?: readonly { readonly key: string; readonly content?: unknown }[];
  }[],
  propertyTitle: string,
): string | null {
  const rt = rules?.referenceTypes;
  if (!rules || !rt) return null;
  const kv = sidebar.find(
    (x) => x.kind === 'keyValue' && x.title.trim().toLowerCase() === propertyTitle.trim().toLowerCase(),
  );
  const row = kv?.rows?.find((r) => r.key.trim().toLowerCase() === 'reference type');
  const value = row ? runsPlain(row.content).trim() : '';
  if (value === '') return null;
  const v: VocabularyLists = { rule: rt.rule, categories: rt.categories, specialist: rt.specialist };
  if (canonicalIndex(v).has(value)) return null;
  const c = categoryFromTags(page.tags, vocabularyOf(rules));
  const category = 'primary' in c ? c.primary : null;
  if (
    category !== null &&
    v.specialist.some(
      (s) => s.type === value && typeKey(s.category) === typeKey(category) && s.pages === null,
    )
  )
    return null;
  const s = suggest(value, category, v, rt.normalise);
  return `${page.name}: its Reference Type “${value}” is not in the vocabulary${s.value ? ` (suggested: “${s.value}”)` : ''}; the owner decides it on the Reference Types page before or after promoting`;
}

const runsPlain = (content: unknown): string =>
  Array.isArray(content)
    ? (content as Obj[])
        .map((r) =>
          typeof r.text === 'string'
            ? r.text
            : r.mention && typeof (r.mention as Obj).text === 'string'
              ? ((r.mention as Obj).text as string)
              : '',
        )
        .join('')
    : '';

export class ReferenceTypeService {
  readonly store: ReferenceTypeStore;
  private offs: (() => void)[] = [];

  constructor(private readonly d: ReferenceTypeDeps) {
    this.store = new ReferenceTypeStore(d.db, d.now);
  }

  start(): () => void {
    const on = this.d.engine.events.on('job', (e: { type: string; job: JobView }) => {
      try {
        this.onJob(e.job);
      } catch (err) {
        this.d.log?.warn({ err, jobId: e.job.id }, 'a vocabulary publication could not follow its job');
      }
    });
    this.offs.push(on);
    return () => this.stop();
  }

  /** Without a runner: the governance checks started inline (awaited by `settled`). */
  private readonly inline = new Set<Promise<unknown>>();

  stop(): void {
    for (const off of this.offs.splice(0)) off();
  }

  /** The background work this service started has finished (tests). */
  async settled(): Promise<void> {
    await this.d.background?.settled();
    while (this.inline.size > 0) await Promise.allSettled([...this.inline]);
  }

  // ============================================================================================ the pack

  /** The project's pack with a vocabulary: the APPROVED rules (null: none approved) and the current version's. */
  packFor(projectId: string): {
    readonly pack: Pack;
    readonly approved: PackRules | null;
    readonly current: PackRules;
  } | null {
    for (const p of this.d.packs.forProject(projectId)) {
      const approved = this.d.packs.approvedRules(p.id);
      if (approved?.referenceTypes || p.rules.referenceTypes)
        return { pack: p, approved: approved?.referenceTypes ? approved : null, current: p.rules };
    }
    return null;
  }

  private requirePack(projectId: string) {
    const p = this.packFor(projectId);
    if (!p)
      throw new ReferenceTypeError(
        'NO_VOCABULARY',
        'No setting pack with a Reference Type vocabulary is attached to this project (the Arkona pack from version arkona-2026-11-24-f6a has one: approve it on the Packs page).',
      );
    return p;
  }

  /** The rules the report, the checks and the guards use: the approved version's, else the current one's (flagged). */
  private rulesFor(projectId: string): { rules: PackRules; approved: boolean; pack: Pack } {
    const p = this.requirePack(projectId);
    return p.approved
      ? { rules: p.approved, approved: true, pack: p.pack }
      : { rules: p.current, approved: false, pack: p.pack };
  }

  /** The vocabulary in force for a project (approved rules + decisions). */
  effective(
    projectId: string,
  ): EffectiveVocabulary & { readonly rules: PackRules; readonly approved: boolean } {
    const r = this.rulesFor(projectId);
    return {
      ...effectiveVocabulary(r.rules.referenceTypes!, this.store.decisions(projectId)),
      rules: r.rules,
      approved: r.approved,
    };
  }

  // ============================================================================================ the report

  /*
   * v3 F6a.1 (ADR 0076 amendment 1): the report in two layers, each cached.
   *
   * 1. The BASE: every page in scope with its value, category, lifecycle and read times, from ONE light scan of the tree
   *    (`pageScan`) and ONE query of the kinds (`kinds`). Cached on the tree's version (migration 4510), the pack's
   *    approved version and the project's settings, so a reload, a decision and a bulk accept reuse it. Built by
   *    `prepare` in chunks that yield to the event loop (the routes await it), or at once by a synchronous caller.
   * 2. The ROWS: the base grouped by value and category, with each row's suggestion and status under the vocabulary in
   *    force. Cached on the base and the decisions' version; rebuilt from the base in memory (no tree read).
   *
   * Before F6a.1 every report built the scope by asking the tree for each id on every page's path (1,700 status reads,
   * each with freshly prepared statements, at Arkona's scale), and a decision rebuilt the whole report first: "Accept
   * all" was one synchronous loop of 131 report builds that never let the native memory go (the 24 November hang).
   */

  /** Pages handled between yields while the base is built by `prepare`. */
  static readonly CHUNK = 250;

  private bases = new Map<string, Base>();
  private building = new Map<string, Promise<Base>>();
  private assembled = new Map<string, Assembled>();
  private applied = new Map<string, { key: string; counts: Map<string, number> }>();

  /** What the base depends on, besides the tree's version (the rules and the project's lifecycle and narratives). */
  private baseKey(projectId: string): string {
    const p = this.requirePack(projectId);
    const rulesVersion = p.approved ? `a${p.pack.approved?.version ?? 0}` : `c${p.pack.version}`;
    return [
      this.d.tree.queries.version(projectId),
      p.pack.id,
      rulesVersion,
      JSON.stringify(this.d.projectSettings(projectId)),
    ].join('|');
  }

  /** The base's steps: a generator, so `prepare` yields between chunks and a synchronous caller runs it through. */
  private *baseSteps(projectId: string, key: string): Generator<void, Base> {
    const q = this.d.tree.queries;
    const meta = q.status(projectId);
    const lifecycle = lifecycleFrom(this.d.projectSettings(projectId));
    const lc = labelContext(meta.rootId, lifecycle);
    const kinds = q.kinds(projectId);
    const { rules, approved, pack } = this.rulesFor(projectId);
    const vocab = vocabularyOf(rules);
    // Narratives: every page under the one index the pack's narrative rules name (never by inference).
    const narratives = new Set<string>();
    const nName = rules.narrative?.indexes.narratives;
    if (nName) {
      const idx = [
        ...new Set(
          q
            .findByName(projectId, nName, { fields: ['display'] })
            .data.filter((x) => x.node.kind === 'index')
            .map((x) => x.node.id),
        ),
      ];
      if (idx.length === 1) narratives.add(idx[0]!);
    }
    yield;
    const scan = q.pageScan(projectId).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const excluded: Record<string, number> = {};
    const add = (k: string) => (excluded[k] = (excluded[k] ?? 0) + 1);
    const pages: ScopePage[] = [];
    let i = 0;
    for (const n of scan) {
      if (++i % ReferenceTypeService.CHUNK === 0) yield;
      const l = labelsOf(
        { ids: n.pathIds, names: n.pathNames, kinds: n.pathIds.map((id) => kinds.get(id) ?? '') },
        lc,
      );
      if (l.area === 'legacy') add('Legacy Canon Archive');
      else if (l.area === 'design') add('Design References');
      else if (n.pathIds.some((id) => narratives.has(id))) add('Narratives');
      else if (l.lifecycle === 'Working') add('Working');
      else if (l.lifecycle === 'Archived') add('Archived');
      else {
        const c = categoryFromTags(n.tags, vocab);
        pages.push({
          id: n.id,
          name: n.rawName,
          path: n.pathNames.join(' / '),
          pathIds: n.pathIds,
          category: 'primary' in c ? c.primary : '',
          lifecycle: l.lifecycle,
          value: n.referenceType?.trim() ?? '',
          missing: n.propertiesPending || n.propertiesFound === null,
          lastReadAt: n.lastReadAt,
          stale: n.stale,
        });
      }
    }
    return { key, pages, excluded, rules, approved, pack };
  }

  /** The base, built now if the cached one is out of date (synchronous callers: the tool, the tests). */
  private baseNow(projectId: string): Base {
    const key = this.baseKey(projectId);
    const had = this.bases.get(projectId);
    if (had?.key === key) return had;
    const steps = this.baseSteps(projectId, key);
    let r = steps.next();
    while (!r.done) r = steps.next();
    this.bases.set(projectId, r.value);
    return r.value;
  }

  /**
   * Makes the report's base current, yielding to the event loop between chunks of pages (one build at a time per
   * project: a second caller waits for the first). The dashboard's routes await this before they read or decide.
   */
  async prepare(projectId: string): Promise<void> {
    for (;;) {
      const key = this.baseKey(projectId);
      if (this.bases.get(projectId)?.key === key) return;
      const running = this.building.get(projectId);
      if (running) {
        await running.catch(() => undefined);
        continue;
      }
      const p = (async () => {
        const steps = this.baseSteps(projectId, key);
        let r = steps.next();
        while (!r.done) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          r = steps.next();
        }
        this.bases.set(projectId, r.value);
        return r.value;
      })();
      this.building.set(projectId, p);
      try {
        await p;
      } finally {
        this.building.delete(projectId);
      }
      return;
    }
  }

  /** How the caches stand (tests, and the hang's diagnostics). */
  cacheState(projectId: string): { readonly base: string | null; readonly rows: string | null } {
    return { base: this.bases.get(projectId)?.key ?? null, rows: this.assembled.get(projectId)?.key ?? null };
  }

  /**
   * The mappings' fixes written so far, from the write journal in ONE scan (cached on the journal's newest entries),
   * kept on the decisions: an applied one cannot be undone.
   */
  private syncApplied(projectId: string, decisions: readonly ReferenceTypeDecision[]): boolean {
    if (!decisions.some((d) => d.action === 'map')) return false;
    let key: string;
    try {
      const r = prepared(
        this.d.db,
        `SELECT (SELECT MAX(id) FROM write_journal WHERE project_id = ?) AS a,
                (SELECT MAX(id) FROM write_journal WHERE outcome = 'applied') AS b`,
      ).get(projectId) as { a: number | null; b: number | null };
      key = `${r.a ?? 0}:${r.b ?? 0}`;
    } catch {
      return false;
    }
    let counts = this.applied.get(projectId);
    if (counts?.key !== key) {
      counts = { key, counts: this.appliedCounts(projectId) };
      this.applied.set(projectId, counts);
    }
    let changed = false;
    for (const d of decisions) {
      if (d.action !== 'map') continue;
      const n = counts.counts.get(d.id) ?? 0;
      for (let i = d.appliedCount; i < n; i++) {
        this.store.markApplied(projectId, d.id);
        changed = true;
      }
    }
    return changed;
  }

  /** Decision id → the distinct jobs whose applied writes carry it (one scan of the journal). */
  private appliedCounts(projectId: string): Map<string, number> {
    const out = new Map<string, Set<string>>();
    try {
      const rows = prepared(
        this.d.db,
        `SELECT job_id, operation FROM write_journal WHERE project_id = ? AND outcome = 'applied' AND operation LIKE '%"referenceTypeDecision":"rtd_%'`,
      ).all(projectId) as { job_id: string; operation: string }[];
      for (const r of rows)
        for (const m of r.operation.matchAll(/"referenceTypeDecision":"(rtd_[0-9a-f]{16})"/g)) {
          const s = out.get(m[1]!) ?? new Set<string>();
          s.add(r.job_id);
          out.set(m[1]!, s);
        }
    } catch {
      // No journal (a bare test database): nothing applied.
    }
    return new Map([...out].map(([k, v]) => [k, v.size]));
  }

  private appliedWrites(projectId: string, decisionId: string): number {
    try {
      const r = this.d.db
        .prepare(
          `SELECT COUNT(DISTINCT job_id) AS n FROM write_journal WHERE project_id = ? AND outcome = 'applied' AND operation LIKE ?`,
        )
        .get(projectId, `%"referenceTypeDecision":"${decisionId}"%`) as { n: number } | undefined;
      return r?.n ?? 0;
    } catch {
      return 0;
    }
  }

  /** The rows of every page in scope (or under a branch), with their suggestions: from the base, in memory. */
  private assemble(projectId: string, base: Base, underId?: string): Assembled {
    const decisions0 = this.store.decisions(projectId);
    const decisions = this.syncApplied(projectId, decisions0) ? this.store.decisions(projectId) : decisions0;
    const now = this.d.now();
    // The coverage's "stale" moves with the clock: the rows are kept for a minute at most.
    const key = `${base.key}|${this.store.version()}|${underId ?? ''}|${Math.floor(now / 60_000)}`;
    const had = underId === undefined ? this.assembled.get(projectId) : undefined;
    if (had?.key === key) return had;
    const rt = base.rules.referenceTypes!;
    const eff = effectiveVocabulary(rt, decisions);
    const canon = canonicalIndex(eff.lists);
    const pages =
      underId === undefined
        ? base.pages
        : base.pages.filter((n) => n.id === underId || n.pathIds.includes(underId));
    const groups = new Map<string, { value: string; category: string; pages: ReportPage[] }>();
    const cov = { ok: 0, stale: 0, missing: 0, withoutReferenceType: 0 };
    const unread: { id: string; name: string; path: string }[] = [];
    let oldest: number | null = null;
    for (const n of pages) {
      if (n.missing) {
        cov.missing++;
        if (unread.length < 50) unread.push({ id: n.id, name: n.name, path: n.path });
        continue;
      }
      const readAt = Math.min(n.lastReadAt, now);
      const stale = n.stale || now - n.lastReadAt > STALE_AFTER_MS;
      if (stale) cov.stale++;
      else cov.ok++;
      oldest = oldest === null ? readAt : Math.min(oldest, readAt);
      if (n.value === '') {
        cov.withoutReferenceType++;
        continue;
      }
      const k = `${n.value}\u0000${typeKey(n.category)}`;
      let g = groups.get(k);
      if (!g) {
        g = { value: n.value, category: n.category, pages: [] };
        groups.set(k, g);
      }
      g.pages.push({
        id: n.id,
        name: n.name,
        path: n.path,
        category: n.category || null,
        lifecycle: n.lifecycle,
        coverage: stale ? 'stale' : 'ok',
        readAt: new Date(readAt).toISOString(),
      });
    }
    const byDecision = new Map(decisions.map((x) => [`${x.value}\u0000${typeKey(x.category)}`, x]));
    const rows: ReportRow[] = [...groups.entries()].map(([k, g]) =>
      this.rowFrom(g, byDecision.get(k) ?? null, eff, canon, rt),
    );
    rows.sort(
      (a, b) => b.count - a.count || a.value.localeCompare(b.value) || a.category.localeCompare(b.category),
    );
    const meta = this.d.tree.queries.status(projectId);
    const out: Assembled = {
      key,
      rows,
      head: {
        pack: {
          id: base.pack.id,
          version: base.pack.version,
          approvedVersion: base.pack.approved?.version ?? null,
        },
        vocabulary: { status: rt.status, approved: base.approved },
        coverage: {
          pages: pages.length,
          ...cov,
          oldestRead: oldest === null ? null : new Date(oldest).toISOString(),
          unread,
          tree: {
            status: meta.status,
            confirmedAt: meta.confirmedAt === null ? null : new Date(meta.confirmedAt).toISOString(),
            ...(meta.reason ? { reason: meta.reason } : {}),
          },
        },
        excluded: base.excluded,
      },
      effective: eff,
    };
    if (underId === undefined) this.assembled.set(projectId, out);
    return out;
  }

  /** One row: its pages, suggestion, status, decision and conflict. */
  private rowFrom(
    g: { value: string; category: string; pages: ReportPage[] },
    decision: ReferenceTypeDecision | null,
    eff: EffectiveVocabulary,
    canon: ReturnType<typeof canonicalIndex>,
    rt: ReferenceTypeRules,
  ): ReportRow {
    const s = suggest(g.value, g.category || null, eff.lists, rt.normalise);
    const spec = g.pages.map((p) => isSpecialist(eff.lists, g.value, g.category, p.id));
    const status: RowStatus = decision
      ? decision.action === 'map'
        ? 'mapped'
        : decision.action === 'reject'
          ? 'rejected'
          : 'specialist'
      : canon.has(g.value)
        ? 'canonical'
        : spec.some((x) => x)
          ? 'specialist'
          : 'open';
    return {
      id: rowIdOf(g.value, g.category),
      value: g.value,
      category: g.category,
      count: g.pages.length,
      pages: g.pages.map((p, i) =>
        spec[i] ||
        (decision?.action === 'specialist' &&
          (decision.pages === null || decision.pages.some((x) => x.id === p.id)))
          ? { ...p, specialist: true }
          : p,
      ),
      status,
      suggestion: {
        value: s.value,
        kind: s.kind,
        reason: s.reason,
        moved: s.moved,
        synonyms: s.synonyms,
        candidates: s.candidates,
        ...(s.canonicalIn ? { canonicalIn: s.canonicalIn } : {}),
      },
      decision,
      conflict: decision ? (eff.conflicts.get(decision.id) ?? null) : null,
    };
  }

  private static filtered(rows: readonly ReportRow[], filter: ReportFilter): ReportRow[] {
    let out = [...rows];
    if (filter.category !== undefined) {
      const want = filter.category.trim().toLowerCase() === 'none' ? '' : typeKey(filter.category);
      out = out.filter((r) => typeKey(r.category) === want);
    }
    if (filter.status && filter.status.length > 0) out = out.filter((r) => filter.status!.includes(r.status));
    if (filter.minCount !== undefined) out = out.filter((r) => r.count >= filter.minCount!);
    if (filter.valueContains !== undefined && filter.valueContains.trim() !== '') {
      const t = filter.valueContains.trim().toLowerCase();
      out = out.filter((r) => r.value.toLowerCase().includes(t));
    }
    return out;
  }

  /** Every row (no paging), with the coverage of the pages read. */
  rows(
    projectId: string,
    filter: ReportFilter = {},
  ): Omit<Report, 'rows' | 'totalRows'> & { rows: ReportRow[] } {
    const a = this.assemble(projectId, this.baseNow(projectId), filter.underId);
    return { ...a.head, rows: ReferenceTypeService.filtered(a.rows, filter) };
  }

  /** The report, paged by row. */
  report(projectId: string, filter: ReportFilter, page: { offset?: number; limit?: number } = {}): Report {
    const all = this.rows(projectId, filter);
    const offset = page.offset ?? 0;
    const limit = page.limit ?? 50;
    return { ...all, totalRows: all.rows.length, rows: all.rows.slice(offset, offset + limit) };
  }

  /** The open rows with a confident suggestion in a filter (what "Accept all" offers), by id. */
  confident(
    projectId: string,
    filter: ReportFilter,
  ): {
    readonly count: number;
    readonly ids: readonly string[];
    /** The first 30, for the confirmation (value → suggestion, pages). */
    readonly sample: readonly {
      readonly value: string;
      readonly suggestion: string;
      readonly count: number;
    }[];
  } {
    const rows = this.rows(projectId, { ...filter, status: ['open'] }).rows.filter(
      (r) => r.suggestion.kind === 'suggested' && r.suggestion.value !== null,
    );
    return {
      count: rows.length,
      ids: rows.map((r) => r.id),
      sample: rows
        .slice(0, 30)
        .map((r) => ({ value: r.value, suggestion: r.suggestion.value!, count: r.count })),
    };
  }

  /** The most rows one bulk accept decides (REFTYPE_BULK_MAX, read on each use). */
  bulkMax(): number {
    return this.d.bulkMax?.() ?? DEFAULT_BULK_MAX;
  }

  // ============================================================================================ the owner's decisions

  /** One row as it stands now, from the cached base (no tree read): the row a decision is about, or null. */
  private rowNow(projectId: string, value: string, category: string): ReportRow | null {
    const a = this.assemble(projectId, this.baseNow(projectId));
    return a.rows.find((r) => r.value === value && typeKey(r.category) === typeKey(category)) ?? null;
  }

  decide(
    actor: string,
    projectId: string,
    o: {
      readonly value: string;
      readonly category: string;
      readonly action: 'accept' | 'edit' | 'reject' | 'specialist';
      readonly target?: string | undefined;
      /** edit: a new canonical value's role word (the value is then added to the category). */
      readonly role?: string | undefined;
      /** specialist: `pages` (exactly the pages listed now) or `category` (any page in this category). */
      readonly scope?: 'pages' | 'category' | undefined;
      readonly reason?: string | undefined;
      readonly via?: 'bulk';
    },
  ): ReferenceTypeDecision {
    if (actor !== 'owner')
      throw new ReferenceTypeError(
        'NOT_OWNER',
        'Only the owner decides a Reference Type; an agent reads the report.',
      );
    const row = this.rowNow(projectId, o.value, o.category);
    if (!row)
      throw new ReferenceTypeError(
        'VALUE_NOT_IN_USE',
        `No page in scope uses the Reference Type “${o.value}” in ${o.category || 'no category'} (as the stored sidebars read now).`,
      );
    if (row.decision)
      throw new ReferenceTypeError(
        'ALREADY_DECIDED',
        `“${o.value}” (${o.category || 'no category'}) is already decided (${row.decision.action}); undo that first.`,
        { decision: row.decision },
      );
    if (row.status === 'canonical')
      throw new ReferenceTypeError(
        'ALREADY_CANONICAL',
        `“${o.value}” is already canonical: there is nothing to decide.`,
      );
    const eff = this.assemble(projectId, this.baseNow(projectId)).effective;
    const canon = canonicalIndex(eff.lists);
    const base = {
      projectId,
      value: o.value,
      category: row.category,
      suggestion: row.suggestion.value,
      reason: (o.reason ?? '').trim(),
      by: actor,
      pages: null as ReferenceTypeDecision['pages'],
      target: null as string | null,
      targetNew: false,
      role: null as string | null,
    };
    let d: ReferenceTypeDecision;
    if (o.action === 'accept') {
      if (row.suggestion.kind !== 'suggested' || !row.suggestion.value)
        throw new ReferenceTypeError(
          'NO_CONFIDENT_SUGGESTION',
          `“${o.value}” has no confident suggestion (${row.suggestion.reason}): choose a value (Edit), reject it, or keep it as specialist.`,
        );
      d = this.store.insert({ ...base, action: 'map', target: row.suggestion.value, via: o.via ?? 'accept' });
    } else if (o.action === 'edit') {
      const target = (o.target ?? '').trim();
      if (target === '')
        throw new ReferenceTypeError('TARGET_REQUIRED', 'Edit needs the canonical value to map to.');
      if (target === o.value)
        throw new ReferenceTypeError(
          'TARGET_IS_VALUE',
          'Map the value to another value, or keep it as specialist.',
        );
      const there = canon.get(target);
      if (there) {
        if (typeKey(there.category) !== typeKey(row.category))
          throw new ReferenceTypeError(
            'TARGET_OTHER_CATEGORY',
            `“${target}” is canonical in ${there.category}, not ${row.category || 'no category'}: the category is the owner’s to change on the page (its primary tag), never by a mapping.`,
          );
        d = this.store.insert({ ...base, action: 'map', target, via: 'edit' });
      } else {
        const role = (o.role ?? '').trim();
        if (role === '')
          throw new ReferenceTypeError(
            'ROLE_REQUIRED',
            `“${target}” is not in the vocabulary of ${row.category || 'no category'}: a new canonical value needs its role word (the word templated names use).`,
          );
        if (row.category === '')
          throw new ReferenceTypeError(
            'CATEGORY_REQUIRED',
            'These pages have no primary category tag, so a new canonical value cannot be added to a category for them.',
          );
        for (const s of [target, role])
          if (/[;():]/.test(s) || /,\s*also\b/i.test(s) || s.length > 200)
            throw new ReferenceTypeError(
              'NAME_NOT_WRITABLE',
              `“${s}” cannot be written in the vocabulary (no ; ( ) : or “, also”).`,
            );
        d = this.store.insert({ ...base, action: 'map', target, targetNew: true, role, via: 'edit' });
      }
    } else if (o.action === 'reject') {
      d = this.store.insert({ ...base, action: 'reject', via: 'reject' });
    } else {
      if (/[;():]/.test(o.value) || /,\s*also\b/i.test(o.value))
        throw new ReferenceTypeError(
          'NAME_NOT_WRITABLE',
          `“${o.value}” cannot be written in the vocabulary (no ; ( ) : or “, also”).`,
        );
      const scope = o.scope ?? 'pages';
      if (scope === 'category' && row.category === '')
        throw new ReferenceTypeError(
          'CATEGORY_REQUIRED',
          'These pages have no primary category: keep it for the pages listed.',
        );
      d = this.store.insert({
        ...base,
        action: 'specialist',
        pages: scope === 'category' ? null : row.pages.map((p) => ({ id: p.id, name: p.name })),
        via: 'specialist',
      });
    }
    this.auditDecision(actor, projectId, d, row.count);
    return d;
  }

  private auditDecision(actor: string, projectId: string, d: ReferenceTypeDecision, pages: number): void {
    this.d.audit(actor, 'reftypes.decide', projectId, null, {
      decision: d.id,
      value: d.value,
      category: d.category,
      action: d.action,
      via: d.via,
      ...(d.target ? { target: d.target } : {}),
      ...(d.targetNew ? { newCanonical: { name: d.target, role: d.role } } : {}),
      ...(d.action === 'specialist'
        ? { pages: d.pages === null ? 'any page in this category' : d.pages.map((p) => p.id) }
        : {}),
      suggestion: d.suggestion,
      pages,
    });
  }

  /** The row as it stands after a decision (from the cached base; no tree read). */
  rowAfter(projectId: string, d: ReferenceTypeDecision): ReportRow | null {
    return this.rowNow(projectId, d.value, d.category);
  }

  /**
   * "Accept all confident suggestions" (v3 F6a.1): the rows named by `ids` (as the page lists them), or, without ids,
   * the open rows with a confident suggestion in `filter`. ONE transaction: every decision and its audit row, or none.
   * Bounded by REFTYPE_BULK_MAX: more ids than that are refused (`BULK_TOO_LARGE`); a filter takes the first that many
   * and says how many remain. Idempotent: a row already decided, canonical now, or with no confident suggestion is
   * skipped with its reason and nothing is written for it, so running it again touches only the rows still open.
   * Returns the rows it changed as they now stand (not the whole report).
   */
  bulkAccept(
    actor: string,
    projectId: string,
    sel: ReportFilter & { readonly ids?: readonly string[] | undefined },
  ): BulkAcceptResult {
    if (actor !== 'owner')
      throw new ReferenceTypeError('NOT_OWNER', 'Only the owner decides a Reference Type.');
    const max = this.bulkMax();
    if (sel.ids !== undefined && sel.ids.length > max)
      throw new ReferenceTypeError(
        'BULK_TOO_LARGE',
        `At most ${max} rows can be accepted at once (REFTYPE_BULK_MAX); ${sel.ids.length} were sent. Accept them in parts.`,
        { max, sent: sel.ids.length },
      );
    const a = this.assemble(projectId, this.baseNow(projectId), sel.underId);
    const byId = new Map(a.rows.map((r) => [r.id, r]));
    const skipped: BulkSkip[] = [];
    let targets: ReportRow[];
    let remaining = 0;
    if (sel.ids !== undefined) {
      targets = [];
      for (const id of new Set(sel.ids)) {
        const r = byId.get(id);
        if (!r) skipped.push({ id, value: null, category: null, reason: 'not_in_use' });
        else targets.push(r);
      }
    } else {
      const open = ReferenceTypeService.filtered(a.rows, { ...sel, status: ['open'] }).filter(
        (r) => r.suggestion.kind === 'suggested' && r.suggestion.value !== null,
      );
      targets = open.slice(0, max);
      remaining = Math.max(0, open.length - max);
    }
    const decided: { d: ReferenceTypeDecision; pages: number }[] = [];
    this.d.db.transaction(() => {
      for (const r of targets) {
        const skip = (reason: BulkSkip['reason']) =>
          skipped.push({ id: r.id, value: r.value, category: r.category, reason });
        // Read inside the transaction: a decision recorded since the report was built is never written twice.
        if (this.store.decisionFor(projectId, r.value, r.category)) skip('already_decided');
        else if (r.status === 'canonical') skip('already_canonical');
        else if (r.status !== 'open') skip('not_open');
        else if (r.suggestion.kind !== 'suggested' || !r.suggestion.value) skip('no_confident_suggestion');
        else {
          const d = this.store.insert({
            projectId,
            value: r.value,
            category: r.category,
            action: 'map',
            target: r.suggestion.value,
            targetNew: false,
            role: null,
            pages: null,
            via: 'bulk',
            suggestion: r.suggestion.value,
            reason: '',
            by: actor,
          });
          this.auditDecision(actor, projectId, d, r.count);
          decided.push({ d, pages: r.count });
        }
      }
    })();
    const after = decided.length > 0 ? this.assemble(projectId, this.baseNow(projectId), sel.underId) : a;
    const now = new Map(after.rows.map((r) => [r.id, r]));
    return {
      accepted: decided.map((x) => x.d),
      rows: decided.map((x) => now.get(rowIdOf(x.d.value, x.d.category))).filter((r): r is ReportRow => !!r),
      skipped,
      remaining,
      max,
    };
  }

  /** Undoes a decision that has not been applied (no fix written with it) nor published. */
  undo(actor: string, projectId: string, id: string): ReferenceTypeDecision {
    if (actor !== 'owner') throw new ReferenceTypeError('NOT_OWNER', 'Only the owner undoes a decision.');
    const d = this.store.decision(projectId, id);
    if (!d) throw new ReferenceTypeError('DECISION_NOT_FOUND', `No decision ${id}.`);
    const applied = Math.max(d.appliedCount, d.action === 'map' ? this.appliedWrites(projectId, d.id) : 0);
    for (let i = d.appliedCount; i < applied; i++) this.store.markApplied(projectId, d.id);
    if (applied > 0)
      throw new ReferenceTypeError(
        'DECISION_APPLIED',
        `The mapping “${d.value}” → “${d.target}” has been applied to ${applied} page(s) already: it cannot be undone (Revert those writes on the Review page first, if that is what you want).`,
      );
    if (d.publishedAt !== null)
      throw new ReferenceTypeError(
        'DECISION_PUBLISHED',
        'This decision is in the published vocabulary: change the section in Source Formatting (the section wins), or decide again after publishing.',
      );
    this.store.remove(projectId, id);
    this.d.audit(actor, 'reftypes.undo', projectId, d, null);
    return d;
  }

  // ============================================================================================ publish

  async publish(
    actor: string,
    projectId: string,
    o: { readonly dryRun?: boolean } = {},
  ): Promise<{
    readonly dryRun: boolean;
    readonly lines: readonly string[];
    readonly replaced: boolean;
    readonly confirmation: string;
    readonly decisions: number;
    readonly jobId: string | null;
    readonly page: { readonly id: string; readonly documentId: string; readonly name: string };
  }> {
    if (actor !== 'owner')
      throw new ReferenceTypeError('NOT_OWNER', 'Only the owner publishes the vocabulary.');
    const { pack, current } = this.requirePack(projectId);
    const rt = current.referenceTypes;
    if (!rt)
      throw new ReferenceTypeError(
        'NO_VOCABULARY',
        'The pack’s current version has no Reference Type vocabulary.',
      );
    const src = pack.governance.find((g) => g.key === rt.source);
    const here = this.d.projectName(projectId);
    if (
      !src ||
      src.resourceId === '' ||
      src.documentId === '' ||
      here === null ||
      here.toLowerCase() !== src.project.toLowerCase()
    )
      throw new ReferenceTypeError(
        'SOURCE_ELSEWHERE',
        `${src?.name ?? rt.source} is not a page of this project, so the vocabulary cannot be published from here.`,
      );
    const read = (await this.d.engine.internalRead(
      projectId,
      'getDocumentBlocks',
      { path: { resourceId: src.resourceId, documentId: src.documentId } },
      { priority: 'P1' },
    )) as { version?: unknown; blocks?: unknown } | null;
    if (!read || typeof read.version !== 'string' || !Array.isArray(read.blocks))
      throw new ReferenceTypeError('SOURCE_UNREADABLE', `${src.name} could not be read.`);
    const decisions = this.store.decisions(projectId);
    const eff = effectiveVocabulary(rt, decisions);
    const splice = spliceSection(read.blocks, rt.under, rt.section, eff.lists);
    if (!splice.ok) throw new ReferenceTypeError(splice.code, `${splice.reason}. Nothing was written.`);
    const lines = sectionLines(eff.lists, rt.section);
    const confirmation = `This writes the section “${rt.section}” ${splice.replaced ? 'in place of the one there now' : `under “${rt.under}”`} in ${src.name} (${lines.length - 1} paragraphs). The governance page changes, so the Packs page will ask you to approve the ${pack.name} pack again; until you do, the pack's tools wait, as for any governance change. Once approved, the section is the vocabulary's authority.`;
    const page = { id: src.resourceId, documentId: src.documentId, name: src.name };
    const carried = decisions
      .filter((x) => !eff.conflicts.has(x.id) && x.action !== 'reject')
      .map((x) => x.id);
    if (o.dryRun === true)
      return {
        dryRun: true,
        lines,
        replaced: splice.replaced,
        confirmation,
        decisions: carried.length,
        jobId: null,
        page,
      };
    const r = await this.d.engine.submit({
      kind: 'batch_ops',
      project: projectId,
      steps: [
        {
          op: 'replaceDocumentBlocks',
          params: {
            path: { resourceId: src.resourceId, documentId: src.documentId },
            ifMatch: read.version,
            body: { blocks: splice.blocks },
          },
          verifyAfterWrite: true,
          journalOperation: {
            tool: PUBLISH_TOOL,
            page: { id: src.resourceId, name: src.name },
            section: rt.section,
            replaced: splice.replaced,
            text: lines.join('\n').slice(0, 4000),
          },
        },
      ],
      onError: 'stop',
      priority: 'P1',
      origin: { kind: 'ui', client: 'owner', tool: PUBLISH_TOOL, principal: SYSTEM_PRINCIPAL },
      title: `Publish the Reference Type vocabulary: ${src.name}’s ${rt.section}`.slice(0, 300),
      internal: true,
      lastMajorRevision: 'skip',
    });
    const jobId = 'jobId' in r && typeof r.jobId === 'string' ? r.jobId : null;
    const pub = this.store.recordPublication({
      projectId,
      jobId,
      replaced: splice.replaced,
      text: lines.join('\n'),
      decisions: carried,
      by: actor,
    });
    this.d.audit(actor, 'reftypes.publish', src.resourceId, null, {
      project: projectId,
      publication: pub.id,
      jobId,
      replaced: splice.replaced,
      decisions: carried.length,
      text: lines.join('\n').slice(0, 4000),
    });
    if (jobId) {
      const job = this.d.engine.queries.getJob(projectId, jobId);
      if (job) this.onJob(job);
    }
    return {
      dryRun: false,
      lines,
      replaced: splice.replaced,
      confirmation,
      decisions: carried.length,
      jobId,
      page,
    };
  }

  /** Whether a job is a vocabulary publication (Revert applies to it, as to the owner's other governance edits). */
  isPublishJob(jobId: string): boolean {
    return this.store.publicationByJob(jobId) !== null;
  }

  private onJob(job: JobView): void {
    if (job.origin.tool !== PUBLISH_TOOL) return;
    const pub = this.store.publicationByJob(job.id);
    if (!pub || pub.state !== 'submitted') return;
    if (job.status === 'succeeded') {
      this.store.setPublicationState(pub.id, 'succeeded');
      this.store.markPublished(pub.projectId, pub.decisions, this.d.now());
      const p = this.packFor(pub.projectId);
      if (p) {
        const packId = p.pack.id;
        // v3 F6a.1: no longer `void …catch()`: the sandbox saw it run after the database closed. The runtime owns it.
        if (this.d.background)
          this.d.background.trigger(
            `governance:${packId}`,
            'the governance check after publishing the vocabulary',
            (signal) => this.d.packs.governance(packId, { signal, priority: 'P3' }),
          );
        else {
          const run: Promise<unknown> = this.d.packs
            .governance(packId)
            .catch((err: unknown) => {
              this.d.log?.warn(
                { err, jobId: job.id },
                'the governance check after publishing the vocabulary failed',
              );
            })
            .finally(() => this.inline.delete(run));
          this.inline.add(run);
        }
      }
    } else if (job.status === 'failed' || job.status === 'cancelled')
      this.store.setPublicationState(pub.id, 'failed');
  }

  /** A decision as it stands now, with its conflict (the `reference_type` fix asks before it plans). */
  decisionNow(
    projectId: string,
    id: string,
  ): { readonly action: string; readonly target: string | null; readonly conflict: string | null } | null {
    const d = this.store.decision(projectId, id);
    if (!d) return null;
    let conflict: string | null;
    try {
      conflict = this.effective(projectId).conflicts.get(id) ?? null;
    } catch {
      conflict = null;
    }
    return { action: d.action, target: d.target, conflict };
  }

  // ============================================================================================ the checks' input

  /** What the audits' two checks need (null: no vocabulary approved for this project). */
  auditInput(projectId: string): ReferenceTypeAuditInput | null {
    const p = this.packFor(projectId);
    if (!p?.approved?.referenceTypes) return null;
    const rules = p.approved;
    const decisions = this.store.decisions(projectId);
    const eff = effectiveVocabulary(rules.referenceTypes!, decisions);
    return { rules, effective: eff, decisions };
  }
}

/** v3 F6a: what the audits' `reference_type_*` checks need. */
export interface ReferenceTypeAuditInput {
  readonly rules: PackRules;
  readonly effective: EffectiveVocabulary;
  readonly decisions: readonly ReferenceTypeDecision[];
}
