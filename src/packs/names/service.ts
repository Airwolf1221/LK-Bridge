/**
 * v3 F6d (ADR 0082; design T13 as amended on 26 November 2026): the Templated Names service.
 *
 * - **The audit's input** (`auditInput`): the APPROVED pack's rules (they must carry `templatedNames`), the vocabulary as
 *   that version states it (its status and its lists: once published, the section in Source Formatting; the role words
 *   are read from it, never hard-coded), the owner's "Keep this name" rulings and the project's switch.
 * - **The report** (the dashboard's Templated Names page): what the newest audit run judged, stored by `sink` (one
 *   transaction), paged and filtered in SQL, the rulings laid over it. Free: nothing is read from LegendKeeper.
 * - **The owner's ruling** "Keep this name" (step-up-free, audited `templatednames.keep`) and its Undo
 *   (`templatednames.undo`). No other decision: renames are what `name_nontemplated`'s fix does under automation.
 */
import type { Db } from '../../db/open.js';
import type { ProjectSettings } from '../../projects/settings.js';
import type { TemplatedNamesAuditInput } from '../../audits/checks/templated-names.js';
import type { Packs } from '../service.js';
import type { PackRules } from '../types.js';
import { TemplatedNameStore, type NameRuling, type ReportMeta, type RowFilter } from './store.js';
import { STATUSES, type TemplatedRow, type TemplatedStatus, type TemplateVocabulary } from './template.js';

export class TemplatedNamesError extends Error {
  override readonly name = 'TemplatedNamesError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface TemplatedNamesDeps {
  readonly db: Db;
  readonly packs: Pick<Packs, 'forProject' | 'approvedRules'>;
  readonly projectSettings: (projectId: string) => Readonly<ProjectSettings>;
  readonly audit: (actor: string, action: string, target: string, before: unknown, after: unknown) => void;
  readonly now: () => number;
}

/** The statuses a "Keep this name" may be given on (a templated or exempt row has nothing to keep). */
const KEEPABLE: ReadonlySet<TemplatedStatus> = new Set([
  'rename',
  'held_collision',
  'held_no_subject',
  'held_type',
]);

export interface TemplatedNamesReportView {
  /** `ready`; `no_rules`: the approved pack carries no templated names; `no_run`: no audit has judged them yet. */
  readonly state: 'ready' | 'no_rules' | 'no_run';
  readonly message: string | null;
  readonly vocabulary: 'draft' | 'published' | null;
  readonly meta: ReportMeta | null;
  readonly counts: Record<TemplatedStatus, number>;
  readonly total: number;
  readonly rows: readonly (TemplatedRow & { readonly ruling: NameRuling | null })[];
  readonly categories: readonly string[];
  readonly offset: number;
  readonly limit: number;
  readonly check: boolean;
}

export class TemplatedNamesService {
  readonly store: TemplatedNameStore;

  constructor(private readonly d: TemplatedNamesDeps) {
    this.store = new TemplatedNameStore(d.db, d.now);
  }

  /** The approved rules with templated names (null: none approved). */
  rulesFor(projectId: string): PackRules | null {
    for (const p of this.d.packs.forProject(projectId)) {
      const approved = this.d.packs.approvedRules(p.id);
      if (approved?.templatedNames) return approved;
    }
    return null;
  }

  /** The vocabulary the approved version states (null: none). */
  static vocabularyOf(rules: PackRules): TemplateVocabulary | null {
    const rt = rules.referenceTypes;
    if (!rt) return null;
    return {
      status: rt.status,
      lists: { rule: rt.rule, categories: rt.categories, specialist: rt.specialist },
    };
  }

  /** `checkTemplatedNames` (default on). */
  checkOn(projectId: string): boolean {
    return this.d.projectSettings(projectId).checkTemplatedNames !== false;
  }

  /** The audit's input (null: the approved pack carries no templated names). */
  auditInput(projectId: string): Omit<TemplatedNamesAuditInput, 'characterPages'> | null {
    const rules = this.rulesFor(projectId);
    if (!rules) return null;
    return {
      rules,
      vocabulary: TemplatedNamesService.vocabularyOf(rules),
      rulings: new Map(this.store.rulings(projectId).map((r) => [r.pageId, r.hash])),
      check: this.checkOn(projectId),
    };
  }

  /** Where each audit run's report goes. */
  sink(projectId: string, meta: Omit<ReportMeta, 'builtAt'>, rows: readonly TemplatedRow[]): void {
    this.store.replace(projectId, meta, rows);
  }

  report(projectId: string, f: RowFilter = {}): TemplatedNamesReportView {
    const rules = this.rulesFor(projectId);
    const empty = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<TemplatedStatus, number>;
    const limit = Math.max(1, Math.min(f.limit ?? 100, 500));
    const offset = Math.max(0, f.offset ?? 0);
    const base = {
      vocabulary: rules?.referenceTypes?.status ?? null,
      counts: empty,
      total: 0,
      rows: [],
      categories: [],
      offset,
      limit,
      check: this.checkOn(projectId),
    };
    if (!rules)
      return {
        ...base,
        state: 'no_rules',
        message:
          'The approved pack carries no templated names: approve the Arkona pack’s version arkona-2026-11-29-f6d (or later) on the Packs page.',
        meta: null,
      };
    const meta = this.store.meta(projectId);
    if (!meta)
      return {
        ...base,
        state: 'no_run',
        message:
          'No audit has judged the names yet: run the audit (Audits page, “Run audit now”), or wait for the next one.',
        meta: null,
      };
    const r = this.store.rows(projectId, { ...f, offset, limit });
    const rulings = new Map(this.store.rulings(projectId).map((x) => [x.pageId, x]));
    return {
      ...base,
      state: 'ready',
      message:
        rules.referenceTypes?.status !== 'published'
          ? 'The Reference Type vocabulary is not published yet, so no name has a template: every row is held_type until the owner publishes it (Reference Types page) and approves the pack again.'
          : null,
      meta,
      counts: r.counts,
      total: r.total,
      rows: r.rows.map((x) => ({ ...x, ruling: rulings.get(x.pageId) ?? null })),
      categories: r.categories,
    };
  }

  /** "Keep this name": a ruling tied to the row's Subject, Reference Type and name as the report judged them. */
  keep(actor: string, projectId: string, pageId: string, reason: string): NameRuling {
    const row = this.store.row(projectId, pageId);
    if (!row)
      throw new TemplatedNamesError('NOT_FOUND', `No row for ${pageId} in the Templated Names report.`);
    if (!KEEPABLE.has(row.status))
      throw new TemplatedNamesError(
        'NOTHING_TO_KEEP',
        row.status === 'kept'
          ? `${row.rawName} is kept already.`
          : `${row.rawName} is ${row.status === 'templated' ? 'named by the template already' : 'exempt as a specialist source'}: there is nothing to keep.`,
      );
    const r = reason.trim();
    if (r.length < 3)
      throw new TemplatedNamesError('REASON_REQUIRED', 'Say why the name is kept (a few words).');
    const ruling = this.store.keep(projectId, actor, {
      pageId,
      pageName: row.rawName,
      subject: row.subject,
      referenceType: row.referenceType,
      hash: row.hash,
      reason: r,
    });
    this.d.audit(
      actor,
      'templatednames.keep',
      `${projectId}:${pageId}`,
      { status: row.status },
      {
        page: row.rawName,
        subject: row.subject,
        referenceType: row.referenceType,
        reason: r,
      },
    );
    return ruling;
  }

  /** Undo: the ruling goes, and the row is judged again (now, from the stored report; the next audit reports it). */
  undo(actor: string, projectId: string, pageId: string): { removed: boolean } {
    const before = this.store.ruling(projectId, pageId);
    if (!before) throw new TemplatedNamesError('NOT_FOUND', `No “Keep this name” ruling on ${pageId}.`);
    const removed = this.store.remove(projectId, pageId);
    this.d.audit(actor, 'templatednames.undo', `${projectId}:${pageId}`, before, null);
    return { removed };
  }
}
