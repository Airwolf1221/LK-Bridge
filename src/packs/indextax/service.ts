/**
 * v3 F6b (ADR 0079; design T11, T12): the index classification service.
 *
 * - **The report** (`arkona_index_classify`, the dashboard's Index Classification page): every current index with the
 *   role the rules propose (`nav`, `subject` or `undecided`) and the rule that decided it (src/packs/indextax/classify.ts),
 *   its current prefix and tags, and the owner's decision. Out-of-scope areas are reported, never proposed. Read-only and
 *   free: the repository tree, the registry and the pack only.
 * - **Cached and paged** (F6a.1's lesson): the base (every verdict) is built in chunks that yield to the event loop and
 *   cached on the tree's version, the pack's rules version and the registry's character taxonomy; the rows are built from
 *   the base under the decisions in memory. A decision never rebuilds the base.
 * - **The owner's decisions** (dashboard only, the step-up, audited): approve (as proposed), change (to nav or subject),
 *   leave undecided; a bulk approve within a filter, ONE request by ids, ONE transaction, bounded by
 *   INDEX_CLASSIFY_BULK_MAX and idempotent.
 * - **The structural lists** (the pack's exact names) edited on the page: a new pack version the owner approves.
 * - **The audits' input**: the approved rows and the approved pack's rule (`auditInput`), for `index_prefix`,
 *   `index_tags` and T11's ordering.
 *
 * Nothing here renames, moves or retags a page: the approved rows become proposals through the audits (T12 step 2).
 */
import type { Db } from '../../db/open.js';
import type { IndexRole } from '../../tree/classify.js';
import type { TreeQueries } from '../../tree/index.js';
import type { RegistryStore } from '../../registry/store.js';
import type { Packs } from '../service.js';
import { packRulesSchema, type IndexTaxonomyRules, type Pack, type PackRules } from '../types.js';
import { classifySteps, nameKeyOf, RULE_TEXT, type CharacterTaxonomy, type Verdict } from './classify.js';
import { navOrderingInForce, SUBJECT_KINDS, type SubjectKind } from './rules.js';
import { IndexRoleStore, type IndexRoleDecision } from './store.js';

export class IndexClassifyError extends Error {
  override readonly name = 'IndexClassifyError';
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

/** INDEX_CLASSIFY_BULK_MAX's default. */
export const DEFAULT_BULK_MAX = 500;

export const ROW_STATUSES = [
  'proposed',
  'undecided',
  'approved',
  'changed',
  'left_undecided',
  'out_of_scope',
] as const;
export type RowStatus = (typeof ROW_STATUSES)[number];

export interface IndexClassifyDeps {
  readonly db: Db;
  readonly packs: Pick<Packs, 'forProject' | 'approvedRules' | 'get'> & {
    readonly commands: Pick<Packs['commands'], 'replaceRules'>;
  };
  readonly tree: { readonly queries: TreeQueries };
  readonly registry: { forProject(projectId: string): { readonly store: RegistryStore } };
  readonly audit: (
    actor: string,
    action: string,
    target: string | null,
    before?: unknown,
    after?: unknown,
  ) => void;
  readonly now: () => number;
  /** INDEX_CLASSIFY_BULK_MAX, read on each use (default 500). */
  readonly bulkMax?: () => number | undefined;
}

export interface ReportRow {
  /** The index page's id (the row's id). */
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly path: string;
  /** The role its prefix gives now. */
  readonly currentRole: IndexRole;
  readonly tags: readonly string[];
  readonly proposed: Verdict['proposed'];
  readonly subject: SubjectKind | null;
  readonly rule: Verdict['rule'];
  readonly why: string;
  readonly matched: readonly string[];
  readonly scope: 'in' | 'out';
  readonly area: string | null;
  readonly status: RowStatus;
  readonly decision: IndexRoleDecision | null;
  /** The role in force for the migration (an approved or changed decision), or null. */
  readonly approvedRole: IndexRole | null;
  readonly approvedSubject: SubjectKind | null;
  /** The decision was made on another proposal than today's (the rules or the tree changed since). */
  readonly drifted: boolean;
}

export interface ReportFilter {
  readonly status?: readonly RowStatus[] | undefined;
  readonly proposed?: Verdict['proposed'] | undefined;
  readonly rule?: string | undefined;
  readonly underId?: string | undefined;
  readonly nameContains?: string | undefined;
}

export interface Report {
  readonly pack: { readonly id: string; readonly version: number; readonly approvedVersion: number | null };
  readonly rules: {
    readonly approved: boolean;
    readonly tagSection: IndexTaxonomyRules['status'];
    readonly orderingInForce: boolean;
    readonly structural: IndexTaxonomyRules['structural'];
    readonly outOfScope: readonly string[];
    readonly templates: IndexTaxonomyRules['templates'];
  };
  readonly rows: readonly ReportRow[];
  readonly totalRows: number;
  readonly counts: Readonly<Record<RowStatus, number>>;
  readonly ruleText: Readonly<Record<string, string>>;
  readonly tree: { readonly status: string; readonly confirmedAt: number | null; readonly version: number };
}

interface Base {
  readonly key: string;
  readonly verdicts: ReadonlyMap<string, Verdict>;
  readonly nodes: ReadonlyMap<
    string,
    {
      name: string;
      displayName: string;
      path: string;
      pathIds: readonly string[];
      role: IndexRole;
      tags: string[];
    }
  >;
  readonly order: readonly string[];
  readonly rules: IndexTaxonomyRules;
  readonly approved: boolean;
  readonly pack: Pack;
}

export interface BulkSkip {
  readonly id: string;
  readonly reason: 'not_an_index' | 'out_of_scope' | 'undecided' | 'already_decided';
}

export interface BulkApproveResult {
  readonly approved: readonly IndexRoleDecision[];
  readonly rows: readonly ReportRow[];
  readonly skipped: readonly BulkSkip[];
  readonly remaining: number;
  readonly max: number;
}

/** What the audits read (null: no approved index taxonomy). */
export interface IndexTaxonomyAuditInput {
  readonly rules: IndexTaxonomyRules;
  /** T11's order is in force (the approved version carries it). */
  readonly navOrdering: boolean;
  /** The tag rule is the Tagging Standard's published section (a draft: `index_tags` reports nothing). */
  readonly tagsInForce: boolean;
  /** The approved rows: page id → role (and subject for a subject index). */
  readonly approved: ReadonlyMap<string, { readonly role: IndexRole; readonly subject: SubjectKind | null }>;
}

export class IndexClassifyService {
  readonly store: IndexRoleStore;
  /** Indexes handled between yields while the base is built. */
  static readonly CHUNK = 100;
  private bases = new Map<string, Base>();
  private building = new Map<string, Promise<Base>>();
  private rowsCache = new Map<string, { key: string; rows: ReportRow[] }>();

  constructor(private readonly d: IndexClassifyDeps) {
    this.store = new IndexRoleStore(d.db, d.now);
  }

  // ============================================================================================ the pack

  /** The project's pack with an index taxonomy: the APPROVED rules (null: none approved) and the current version's. */
  packFor(projectId: string): { pack: Pack; approved: PackRules | null; current: PackRules } | null {
    for (const p of this.d.packs.forProject(projectId)) {
      const approved = this.d.packs.approvedRules(p.id);
      if (approved?.indexTaxonomy || p.rules.indexTaxonomy)
        return { pack: p, approved: approved?.indexTaxonomy ? approved : null, current: p.rules };
    }
    return null;
  }

  private rulesFor(projectId: string): { rules: PackRules; approved: boolean; pack: Pack } {
    const p = this.packFor(projectId);
    if (!p)
      throw new IndexClassifyError(
        'NO_INDEX_TAXONOMY',
        'No setting pack with the navigation and subject index rules is attached to this project (the Arkona pack from version arkona-2026-11-25-f6b has them: approve it on the Packs page).',
      );
    return p.approved
      ? { rules: p.approved, approved: true, pack: p.pack }
      : { rules: p.current, approved: false, pack: p.pack };
  }

  bulkMax(): number {
    const v = this.d.bulkMax?.();
    return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : DEFAULT_BULK_MAX;
  }

  // ============================================================================================ the base

  private characters(projectId: string): CharacterTaxonomy[] {
    const store = this.d.registry.forProject(projectId).store;
    const out: CharacterTaxonomy[] = [];
    for (const t of store.listTypes()) {
      if (t.placementKind !== 'character' || !t.placement || !t.rootIndexId) continue;
      out.push({
        rootIndexId: t.rootIndexId,
        unknownIndexName: t.placement.unknownIndexName,
        entryIds: new Set(store.entries(t.id).map((e) => e.sourceNodeId)),
        identityTypes: [t.placement.referenceTypes.core, t.placement.referenceTypes.compact],
      });
    }
    return out;
  }

  private baseKey(projectId: string, chars: readonly CharacterTaxonomy[]): string {
    const r = this.rulesFor(projectId);
    const rulesVersion = r.approved ? `a${r.pack.approved?.version ?? 0}` : `c${r.pack.version}`;
    const charKey = chars
      .map((c) => `${c.rootIndexId}:${c.unknownIndexName}:${[...c.entryIds].sort().join(',')}`)
      .join(';');
    return [this.d.tree.queries.version(projectId), r.pack.id, rulesVersion, charKey].join('|');
  }

  private *baseSteps(projectId: string, key: string, chars: CharacterTaxonomy[]): Generator<void, Base> {
    const q = this.d.tree.queries;
    const { rules, approved, pack } = this.rulesFor(projectId);
    const tax = rules.indexTaxonomy!;
    const meta = q.status(projectId);
    const scan = q.nodeScan(projectId);
    yield;
    const verdicts = new Map<string, Verdict>();
    const g = classifySteps(
      {
        nodes: scan,
        rootId: meta.rootId,
        rules: tax,
        owners: rules.owners
          ? { nations: rules.owners.nations, worldPrefix: rules.owners.worldPrefix }
          : null,
        narrative: rules.narrative ?? null,
        characters: chars,
      },
      IndexClassifyService.CHUNK,
    );
    let r = g.next();
    while (!r.done) {
      yield;
      r = g.next();
    }
    for (const v of r.value) verdicts.set(v.pageId, v);
    const nodes = new Map<string, Base['nodes'] extends ReadonlyMap<string, infer V> ? V : never>();
    const order: string[] = [];
    // In path order (the tree's own reading order).
    const sorted = scan
      .filter((n) => verdicts.has(n.id))
      .sort((a, b) => {
        const pa = a.pathNames.join('\u0000');
        const pb = b.pathNames.join('\u0000');
        return pa < pb ? -1 : pa > pb ? 1 : a.id < b.id ? -1 : 1;
      });
    for (const n of sorted) {
      nodes.set(n.id, {
        name: n.rawName,
        displayName: n.displayName,
        path: n.pathNames.join(' / '),
        pathIds: n.pathIds,
        role: n.indexRole ?? 'subject',
        tags: [...n.tags],
      });
      order.push(n.id);
    }
    return { key, verdicts, nodes, order, rules: tax, approved, pack };
  }

  private baseNow(projectId: string): Base {
    const chars = this.characters(projectId);
    const key = this.baseKey(projectId, chars);
    const had = this.bases.get(projectId);
    if (had?.key === key) return had;
    const steps = this.baseSteps(projectId, key, chars);
    let r = steps.next();
    while (!r.done) r = steps.next();
    this.bases.set(projectId, r.value);
    return r.value;
  }

  /** Makes the base current, yielding between chunks (one build at a time per project). The routes await this. */
  async prepare(projectId: string): Promise<void> {
    for (;;) {
      const chars = this.characters(projectId);
      const key = this.baseKey(projectId, chars);
      if (this.bases.get(projectId)?.key === key) return;
      const running = this.building.get(projectId);
      if (running) {
        await running.catch(() => undefined);
        continue;
      }
      const p = (async () => {
        const steps = this.baseSteps(projectId, key, chars);
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

  /** How the caches stand (tests). */
  cacheState(projectId: string): { readonly base: string | null; readonly rows: string | null } {
    return { base: this.bases.get(projectId)?.key ?? null, rows: this.rowsCache.get(projectId)?.key ?? null };
  }

  // ============================================================================================ the rows

  private rowOf(base: Base, id: string, decision: IndexRoleDecision | null): ReportRow | null {
    const v = base.verdicts.get(id);
    const n = base.nodes.get(id);
    if (!v || !n) return null;
    const decided = decision && decision.action !== 'undecided' ? decision : null;
    const status: RowStatus =
      v.scope === 'out'
        ? 'out_of_scope'
        : decision?.action === 'approve'
          ? 'approved'
          : decision?.action === 'change'
            ? 'changed'
            : decision?.action === 'undecided'
              ? 'left_undecided'
              : v.proposed === 'undecided'
                ? 'undecided'
                : 'proposed';
    return {
      id,
      name: n.name,
      displayName: n.displayName,
      path: n.path,
      currentRole: n.role,
      tags: n.tags,
      proposed: v.proposed,
      subject: v.subject,
      rule: v.rule,
      why: v.why,
      matched: v.matched,
      scope: v.scope,
      area: v.area,
      status,
      decision,
      approvedRole: v.scope === 'in' ? (decided?.role ?? null) : null,
      approvedSubject: v.scope === 'in' && decided?.role === 'subject' ? (decided.subject ?? null) : null,
      drifted:
        decision !== null &&
        decision.action === 'approve' &&
        (decision.proposed !== v.proposed || (decision.role === 'subject' && decision.subject !== v.subject)),
    };
  }

  private rows(projectId: string, base: Base): ReportRow[] {
    const key = `${base.key}|${this.store.version()}`;
    const had = this.rowsCache.get(projectId);
    if (had?.key === key) return had.rows;
    const decisions = new Map(this.store.decisions(projectId).map((d) => [d.pageId, d]));
    const rows: ReportRow[] = [];
    for (const id of base.order) {
      const r = this.rowOf(base, id, decisions.get(id) ?? null);
      if (r) rows.push(r);
    }
    this.rowsCache.set(projectId, { key, rows });
    return rows;
  }

  private static filtered(base: Base, rows: readonly ReportRow[], f: ReportFilter): ReportRow[] {
    const want = f.nameContains?.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!f.status || f.status.length === 0 || f.status.includes(r.status)) &&
        (f.proposed === undefined || r.proposed === f.proposed) &&
        (f.rule === undefined || r.rule === f.rule) &&
        (f.underId === undefined || (base.nodes.get(r.id)?.pathIds ?? []).includes(f.underId)) &&
        (!want || r.name.toLowerCase().includes(want)),
    );
  }

  report(
    projectId: string,
    filter: ReportFilter = {},
    page: { offset?: number; limit?: number } = {},
  ): Report {
    const base = this.baseNow(projectId);
    const all = this.rows(projectId, base);
    const rows = IndexClassifyService.filtered(base, all, filter);
    const counts = Object.fromEntries(ROW_STATUSES.map((s) => [s, 0])) as Record<RowStatus, number>;
    for (const r of all) counts[r.status]++;
    const offset = Math.max(0, page.offset ?? 0);
    const limit = Math.min(500, Math.max(1, page.limit ?? 100));
    const meta = this.d.tree.queries.status(projectId);
    return {
      pack: {
        id: base.pack.id,
        version: base.pack.version,
        approvedVersion: base.pack.approved?.version ?? null,
      },
      rules: {
        approved: base.approved,
        tagSection: base.rules.status,
        orderingInForce: base.approved && navOrderingInForce(base.rules),
        structural: base.rules.structural,
        outOfScope: base.rules.outOfScope,
        templates: base.rules.templates,
      },
      rows: rows.slice(offset, offset + limit),
      totalRows: rows.length,
      counts,
      ruleText: RULE_TEXT,
      tree: {
        status: meta.status,
        confirmedAt: meta.confirmedAt,
        version: this.d.tree.queries.version(projectId),
      },
    };
  }

  /** The ids "Approve all" offers in a filter: rows still proposed (nav or subject, in scope, no decision). */
  approvable(projectId: string, filter: ReportFilter = {}): string[] {
    const base = this.baseNow(projectId);
    return IndexClassifyService.filtered(base, this.rows(projectId, base), {
      ...filter,
      status: ['proposed'],
    }).map((r) => r.id);
  }

  row(projectId: string, pageId: string): ReportRow | null {
    const base = this.baseNow(projectId);
    return this.rowOf(base, pageId, this.store.decision(projectId, pageId));
  }

  // ============================================================================================ decisions

  /** One decision on one row (the owner only: the dashboard's step-up). Audited `indexclassify.decide`. */
  decide(
    actor: string,
    projectId: string,
    i: {
      readonly pageId: string;
      readonly action: 'approve' | 'change' | 'undecided';
      readonly role?: IndexRole;
      readonly subject?: SubjectKind | null;
      readonly reason?: string;
    },
  ): { decision: IndexRoleDecision; row: ReportRow } {
    if (actor !== 'owner')
      throw new IndexClassifyError('NOT_OWNER', 'Only the owner decides an index’s role.');
    const base = this.baseNow(projectId);
    const v = base.verdicts.get(i.pageId);
    const n = base.nodes.get(i.pageId);
    if (!v || !n)
      throw new IndexClassifyError('NOT_AN_INDEX', `${i.pageId} is not an index of the repository tree now.`);
    if (v.scope === 'out')
      throw new IndexClassifyError(
        'OUT_OF_SCOPE',
        `${n.name} is under ${v.area}: reported, never proposed. Move it out first if it should be classified.`,
      );
    let role: IndexRole | null;
    let subject: SubjectKind | null = null;
    if (i.action === 'approve') {
      if (v.proposed === 'undecided')
        throw new IndexClassifyError(
          'NOTHING_PROPOSED',
          `No rule proposes a role for ${n.name} (${v.why}). Change it to nav or subject, or leave it undecided.`,
        );
      role = v.proposed;
      subject = v.subject;
    } else if (i.action === 'change') {
      if (!i.role) throw new IndexClassifyError('ROLE_REQUIRED', 'Say which role: nav or subject.');
      role = i.role;
      if (role === 'subject') {
        if (i.subject !== undefined && i.subject !== null && !SUBJECT_KINDS.includes(i.subject))
          throw new IndexClassifyError('INVALID_SUBJECT', `“${String(i.subject)}” is not a kind of subject.`);
        subject = i.subject ?? (v.proposed === 'subject' ? v.subject : null);
      }
    } else role = null;
    const before = this.store.decision(projectId, i.pageId);
    const decision = this.store.put(projectId, actor, {
      pageId: i.pageId,
      pageName: n.name,
      action: i.action,
      role,
      subject,
      proposed: v.proposed,
      rule: v.rule,
      via: i.action,
      reason: i.reason ?? '',
    });
    this.d.audit(
      actor,
      'indexclassify.decide',
      projectId,
      before ? { role: before.role, subject: before.subject, action: before.action } : null,
      {
        page: { id: i.pageId, name: n.name },
        action: i.action,
        role,
        subject,
        proposed: v.proposed,
        rule: v.rule,
      },
    );
    return { decision, row: this.rowOf(base, i.pageId, decision)! };
  }

  /**
   * "Approve all as proposed" within a filter (F6a.1's lesson): ONE request by ids (or every proposed row of the
   * filter), ONE transaction, at most INDEX_CLASSIFY_BULK_MAX rows, idempotent (a row already decided is skipped).
   */
  bulkApprove(
    actor: string,
    projectId: string,
    o: ReportFilter & { readonly ids?: readonly string[] },
  ): BulkApproveResult {
    if (actor !== 'owner')
      throw new IndexClassifyError('NOT_OWNER', 'Only the owner decides an index’s role.');
    const max = this.bulkMax();
    const base = this.baseNow(projectId);
    const all = this.rows(projectId, base);
    const byId = new Map(all.map((r) => [r.id, r]));
    const ids = o.ids
      ? [...new Set(o.ids)]
      : IndexClassifyService.filtered(base, all, { ...o, status: ['proposed'] }).map((r) => r.id);
    if (o.ids && ids.length > max)
      throw new IndexClassifyError(
        'BULK_TOO_LARGE',
        `${ids.length} rows were sent; at most ${max} are approved in one request (INDEX_CLASSIFY_BULK_MAX). Send them in parts.`,
        { max },
      );
    const skipped: BulkSkip[] = [];
    const take: ReportRow[] = [];
    for (const id of ids) {
      const r = byId.get(id);
      if (!r) skipped.push({ id, reason: 'not_an_index' });
      else if (r.scope === 'out') skipped.push({ id, reason: 'out_of_scope' });
      else if (r.decision !== null) skipped.push({ id, reason: 'already_decided' });
      else if (r.proposed === 'undecided') skipped.push({ id, reason: 'undecided' });
      else take.push(r);
    }
    const now = take.slice(0, max);
    const approved = this.store.putMany(
      projectId,
      actor,
      now.map((r) => ({
        pageId: r.id,
        pageName: r.name,
        action: 'approve' as const,
        role: r.proposed as IndexRole,
        subject: r.proposed === 'subject' ? r.subject : null,
        proposed: r.proposed,
        rule: r.rule,
        via: 'bulk' as const,
        reason: '',
      })),
    );
    if (approved.length > 0)
      this.d.audit(actor, 'indexclassify.bulk_approve', projectId, null, {
        approved: approved.length,
        pages: approved.map((d) => d.pageId),
      });
    const decided = new Map(approved.map((d) => [d.pageId, d]));
    return {
      approved,
      rows: now.map((r) => this.rowOf(base, r.id, decided.get(r.id) ?? null)!),
      skipped,
      remaining: take.length - now.length,
      max,
    };
  }

  // ============================================================================================ the pack's lists

  /** The owner edits the structural lists (exact names): a NEW pack version, waiting for approval. Audited by the pack. */
  setStructural(
    actor: string,
    projectId: string,
    change: {
      readonly structural?: {
        readonly [K in keyof IndexTaxonomyRules['structural']]?:
          IndexTaxonomyRules['structural'][K] | undefined;
      };
      readonly outOfScope?: readonly string[];
    },
  ): { pack: Pack; changed: boolean } {
    if (actor !== 'owner') throw new IndexClassifyError('NOT_OWNER', 'Only the owner edits the pack.');
    const p = this.packFor(projectId);
    if (!p || !p.current.indexTaxonomy)
      throw new IndexClassifyError(
        'NO_INDEX_TAXONOMY',
        'The current pack version has no navigation and subject index rules, so it has no structural lists.',
      );
    const before = p.current.indexTaxonomy;
    const tidy = (xs: readonly string[]) => {
      const out: string[] = [];
      for (const x of xs) {
        const v = x.replace(/\s+/g, ' ').trim();
        if (v !== '' && !out.some((y) => nameKeyOf(y) === nameKeyOf(v))) out.push(v);
      }
      return out;
    };
    const structural = { ...before.structural };
    for (const [k, v] of Object.entries(change.structural ?? {})) {
      if (Array.isArray(v)) (structural as Record<string, unknown>)[k] = tidy(v);
      else if (typeof v === 'string') (structural as Record<string, unknown>)[k] = v.trim();
    }
    const next = {
      ...before,
      structural,
      ...(change.outOfScope ? { outOfScope: tidy(change.outOfScope) } : {}),
    };
    if (JSON.stringify(next) === JSON.stringify(before)) return { pack: p.pack, changed: false };
    let rules: PackRules;
    try {
      rules = packRulesSchema.parse({ ...p.current, indexTaxonomy: next });
    } catch (e) {
      throw new IndexClassifyError(
        'INVALID_LISTS',
        `The lists cannot be stored: ${(e as Error).message.slice(0, 500)}`,
      );
    }
    const pack = this.d.packs.commands.replaceRules(
      actor,
      p.pack.id,
      rules,
      'index structural names edited on the Index Classification page',
    );
    return { pack, changed: true };
  }

  // ============================================================================================ the audits

  /** The approved taxonomy and the approved rows (null: no approved version carries the index taxonomy). */
  auditInput(projectId: string): IndexTaxonomyAuditInput | null {
    const p = this.packFor(projectId);
    const rules = p?.approved?.indexTaxonomy;
    if (!rules) return null;
    const approved = new Map<string, { role: IndexRole; subject: SubjectKind | null }>();
    // Only rows still in scope and still indexes count (the base says so); a decision on a page that left is ignored.
    let base: Base | null;
    try {
      base = this.baseNow(projectId);
    } catch {
      base = null;
    }
    for (const d of this.store.decisions(projectId)) {
      if (d.action === 'undecided' || d.role === null) continue;
      const v = base?.verdicts.get(d.pageId);
      if (!v || v.scope === 'out') continue;
      approved.set(d.pageId, { role: d.role, subject: d.role === 'subject' ? d.subject : null });
    }
    return {
      rules,
      navOrdering: navOrderingInForce(rules),
      tagsInForce: rules.status === 'published',
      approved,
    };
  }
}
