/**
 * The audit service (v2 E2, ADR 0044): runs the audits, keeps the owner's rules, and tracks findings across runs.
 *
 * A run reads the snapshots (never LegendKeeper), builds the context, runs every check, and commits the findings
 * (new, still present, gone). Runs happen after each nightly full snapshot completes, on demand from the dashboard, and
 * from the maintenance job. Findings are never fixed here: "Propose a fix" and "Re-check now" (src/audits/fixes.ts) are
 * the only two things that read LegendKeeper live, each on the owner's request.
 */
import type { Db } from '../db/open.js';
import type { Chronology } from '../chronology/index.js';
import type { JobEngine } from '../jobs/index.js';
import { lifecycleFrom } from '../lifecycle/settings.js';
import type { Registry } from '../registry/index.js';
import type { SnapshotService } from '../snapshots/service.js';
import { treeSettingsFrom } from '../tree/classify.js';
import type { ProjectSettings } from '../projects/settings.js';
import { auditConfigInputSchema, effectiveRules, type AuditConfig, type AuditRule } from './config.js';
import { chronologyCheck, keepRegionsCheck, lifecycleCheck } from './checks/lifecycle.js';
import { orderingCheck, referencesCheck, unclassifiedCheck } from './checks/references.js';
import { rulesCheck, tagDefinitionOf } from './checks/rules.js';
import { factsCheck, taxonomyCheck } from './checks/taxonomy.js';
import {
  makeContext,
  pathOf,
  snapshotSource,
  type AuditContext,
  type Check,
  type IncompleteRecord,
} from './context.js';
import { AuditError } from './errors.js';
import { proposeFix as proposeFixVia, type FixResult } from './fixes.js';
import {
  extractResource,
  extractSidebar,
  scanDocument,
  type AuditPage,
  type DocumentInfo,
  type DocumentScan,
  type Ref,
} from './model.js';
import { buildModel, sourceOf, type AuditModel, type SnapshotSource } from './reader.js';
import { sidebarPiece } from '../snapshots/canonical.js';
import { classifyName } from '../tree/classify.js';
import { AuditStore, evidenceHashOf, fingerprintOf, type FindingFilter, type StoredDraft } from './store.js';
import {
  CODES,
  type AuditRun,
  type Finding,
  type FindingDraft,
  type FindingSource,
  type RunCounts,
} from './types.js';

/** The checks, in the order the dashboard lists their categories. */
export const CHECKS: readonly { readonly id: string; readonly run: Check }[] = [
  { id: 'rules', run: rulesCheck },
  { id: 'references', run: referencesCheck },
  { id: 'unclassified', run: unclassifiedCheck },
  { id: 'ordering', run: orderingCheck },
  { id: 'taxonomy', run: taxonomyCheck },
  { id: 'facts', run: factsCheck },
  { id: 'lifecycle', run: lifecycleCheck },
  { id: 'keep-regions', run: keepRegionsCheck },
  { id: 'chronology', run: chronologyCheck },
];

export interface AuditDeps {
  readonly db: Db;
  readonly snapshots: SnapshotService;
  readonly registry: Pick<Registry, 'forProject'>;
  readonly chronology: Pick<Chronology, 'config' | 'readiness' | 'store' | 'proposeFix'>;
  readonly tree: {
    readonly queries: {
      tombstone(projectId: string, id: string): { observedAt: number; reason: string } | null;
    };
  };
  readonly engine: Pick<JobEngine, 'internalRead' | 'submit' | 'queries' | 'wait'>;
  readonly projectSettings: (projectId: string) => Readonly<ProjectSettings>;
  readonly audit: (
    actor: string,
    action: string,
    target: string | null,
    before?: unknown,
    after?: unknown,
  ) => void;
  readonly now: () => number;
  readonly log?: { warn(obj: Record<string, unknown>, msg: string): void };
  /** Test seam: a snapshot source other than the service's own. */
  readonly source?: (projectId: string) => SnapshotSource;
}

export interface AuditOutcome {
  readonly runId: string;
  readonly state: AuditRun['state'];
  readonly summary: string;
  readonly changed: boolean;
  readonly skipped?: boolean;
}

/** The check that owns each page-local category (a re-check runs it again on the page read live). */
const RECHECKABLE: Partial<Record<string, Check>> = {
  rules: rulesCheck,
  template: rulesCheck,
  tags: rulesCheck,
  references: referencesCheck,
  unclassified: unclassifiedCheck,
  ordering: orderingCheck,
  facts: factsCheck,
  lifecycle: lifecycleCheck,
  keep_regions: keepRegionsCheck,
};

export class Audits {
  readonly store: AuditStore;
  private readonly running = new Set<string>();
  private readonly background = new Set<Promise<void>>();

  constructor(readonly d: AuditDeps) {
    this.store = new AuditStore(d.db, d.now);
  }

  /** Closes a run a restart interrupted. */
  start(): void {
    this.store.closeStaleRuns();
  }

  // ============================================================================================ config

  config(
    projectId: string,
  ): AuditConfig & { readonly effectiveRules: AuditRule[]; readonly seeded: boolean } {
    const cfg = this.store.config(projectId);
    const types = this.d.registry.forProject(projectId).store.listTypes();
    return { ...cfg, effectiveRules: effectiveRules(cfg, types), seeded: cfg.rules === null };
  }

  /** The owner's edit of the rules, the tag source or the settings. Audited. */
  setConfig(actor: string, projectId: string, input: unknown): ReturnType<Audits['config']> {
    const parsed = auditConfigInputSchema.safeParse(input ?? {});
    if (!parsed.success)
      throw new AuditError(
        'INVALID_INPUT',
        parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
      );
    const { before, after } = this.store.setConfig(projectId, parsed.data, actor);
    this.d.audit(actor, 'audits.set_config', projectId, summaryOf(before), summaryOf(after));
    return this.config(projectId);
  }

  // ============================================================================================ acknowledging

  acknowledge(actor: string, projectId: string, findingId: number, reason: string): Finding {
    const why = reason.trim();
    if (why === '') throw new AuditError('REASON_REQUIRED', 'An acknowledgement needs a reason.');
    const f = this.store.acknowledge(projectId, findingId, why.slice(0, 1000), actor);
    if (!f) throw new AuditError('NOT_FOUND', `No finding ${findingId}.`);
    this.d.audit(actor, 'audits.acknowledge', projectId, null, {
      finding: findingId,
      code: f.code,
      page: f.pageName,
      reason: why.slice(0, 200),
    });
    return f;
  }

  unacknowledge(actor: string, projectId: string, findingId: number): Finding {
    const f = this.store.unacknowledge(projectId, findingId);
    if (!f) throw new AuditError('NOT_FOUND', `No finding ${findingId}.`);
    this.d.audit(actor, 'audits.unacknowledge', projectId, { finding: findingId, code: f.code }, null);
    return f;
  }

  // ============================================================================================ reading

  list(projectId: string, f: FindingFilter = {}) {
    return this.store.list(projectId, f);
  }

  // ============================================================================================ running

  /** After a full snapshot completes (the snapshot service's hook): an audit of it, in the background. */
  afterFullSnapshot(projectId: string): void {
    const p = this.run(projectId, 'snapshot')
      .catch((e: unknown) =>
        this.d.log?.warn({ err: e, projectId }, 'the audit after the full snapshot failed'),
      )
      .then(() => undefined)
      .finally(() => this.background.delete(p));
    this.background.add(p);
  }

  /** Waits for the audits started after full snapshots (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  /** One audit run. Reads the snapshot store and the bridge's own database; never LegendKeeper. */
  async run(projectId: string, trigger: 'snapshot' | 'manual' | 'schedule'): Promise<AuditOutcome> {
    if (this.running.has(projectId))
      return {
        runId: this.store.runningRun(projectId)?.id ?? '',
        state: 'skipped',
        summary: 'Skipped: an audit of this project is already running.',
        changed: false,
        skipped: true,
      };
    this.running.add(projectId);
    const run = this.store.startRun(projectId, trigger);
    try {
      const startedAt = run.startedAt;
      const settings = this.d.projectSettings(projectId);
      const cfg = this.store.config(projectId);
      const registry = this.d.registry.forProject(projectId).store;
      const types = registry.listTypes();
      const treeSettings = treeSettingsFrom(settings);
      const source = this.d.source ? this.d.source(projectId) : sourceOf(this.d.snapshots);
      const built = await buildModel(source, projectId, {
        propertiesName: treeSettings.propertiesName,
        tagSource: cfg.tagSource,
      });
      if (!built.ok) {
        const summary =
          'Skipped: there is no complete full snapshot to audit yet (the first nightly snapshot makes one).';
        this.store.finishRun(run.id, { state: 'skipped', summary });
        return { runId: run.id, state: 'skipped', summary, changed: false, skipped: true };
      }
      const model = built.model;
      const ctx = this.context(projectId, model, cfg, types, treeSettings, settings);
      const drafts: FindingDraft[] = [];
      for (const c of CHECKS) {
        try {
          drafts.push(...c.run(ctx));
        } catch (e) {
          throw new AuditError(
            'CHECK_FAILED',
            `The ${c.id} check failed: ${e instanceof Error ? e.message : String(e)}. Nothing was committed; the earlier findings stand.`,
          );
        }
      }
      const ageMs = Math.max(0, startedAt - model.base.takenAt);
      const stale = ageMs > cfg.settings.maxSnapshotAgeHours * 3_600_000;
      if (stale)
        drafts.push({
          code: 'stale_snapshot',
          message: `The newest complete full snapshot is ${Math.round(ageMs / 3_600_000)} hours old (the audit allows ${cfg.settings.maxSnapshotAgeHours}); everything below is as of then, plus ${model.changes.length} later change snapshot${model.changes.length === 1 ? '' : 's'}. Edits made in the LegendKeeper app since are not seen until the next full snapshot.`,
          evidence: {
            snapshot: model.base.id,
            takenAt: new Date(model.base.takenAt).toISOString(),
            maxHours: cfg.settings.maxSnapshotAgeHours,
          },
          sourceKind: 'bridge',
        });
      const stored = drafts.map((d) => this.stored(ctx, d));
      const counts: RunCounts = this.store.commit(projectId, run.id, stored);
      const summary =
        `${counts.open} open finding${counts.open === 1 ? '' : 's'} (${counts.new} new, ${counts.still} still present, ${counts.gone} gone` +
        `${counts.acknowledged > 0 ? `, ${counts.acknowledged} acknowledged` : ''}) across ${model.pages.size} pages, from ${model.base.id}` +
        `${model.changes.length > 0 ? ` plus ${model.changes.length} change snapshot${model.changes.length === 1 ? '' : 's'}` : ''}` +
        `, ${Math.round(ageMs / 60_000)} minutes old${stale ? ' (stale)' : ''}.`;
      this.store.finishRun(run.id, {
        state: 'succeeded',
        snapshotId: model.base.id,
        snapshotTakenAt: model.base.takenAt,
        snapshotAgeMs: ageMs,
        changeSnapshots: model.changes.length,
        newestSnapshotId: model.newest.id,
        stale,
        pages: model.pages.size,
        counts,
        summary,
      });
      return { runId: run.id, state: 'succeeded', summary, changed: counts.new > 0 || counts.gone > 0 };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.store.finishRun(run.id, { state: 'failed', summary: 'The audit stopped.', error });
      throw e;
    } finally {
      this.running.delete(projectId);
    }
  }

  // ============================================================================================ propose a fix

  /**
   * "Propose a fix" for one finding: re-reads its target live (P1), then creates an ordinary proposal through the
   * machinery of an existing tool, with every guard. Nothing is applied; the owner approves it. Audited.
   */
  async proposeFix(
    actor: string,
    projectId: string,
    findingId: number,
    opts: { readonly confirmShapeChange?: boolean } = {},
  ): Promise<FixResult> {
    const f = this.store.get(projectId, findingId);
    if (!f) throw new AuditError('NOT_FOUND', `No finding ${findingId}.`);
    if (!f.fix)
      throw new AuditError('NO_FIX', 'This finding offers no fix: only the owner can decide what is right.');
    if (f.state !== 'open') throw new AuditError('FINDING_GONE', 'This finding is no longer present.');
    let r: FixResult;
    if (
      f.fix.kind === 'chronology_sync' ||
      f.fix.kind === 'chronology_count' ||
      f.fix.kind === 'chronology_orphan'
    ) {
      const kind = f.fix.kind;
      const c = await this.d.chronology.proposeFix(
        actor,
        projectId,
        kind === 'chronology_count'
          ? { kind: 'count', age: String(f.fix.args.age) }
          : kind === 'chronology_orphan'
            ? { kind: 'orphan', age: String(f.fix.args.age), eventId: String(f.fix.args.eventId) }
            : {
                age: String(f.fix.args.age),
                rowId: String(f.fix.args.rowId),
                // v2 E6 (ADR 0048): a range made a single date (or the reverse) only with the owner's confirmation.
                ...(opts.confirmShapeChange === true ? { confirmShapeChange: true } : {}),
              },
      );
      r =
        c.status === 'proposal_captured'
          ? { status: 'proposal_captured', proposalId: c.proposalId, summary: c.summary, fix: kind }
          : c;
    } else {
      r = await proposeFixVia({ engine: this.d.engine as never, now: this.d.now }, projectId, f, {
        propertiesName: treeSettingsFrom(this.d.projectSettings(projectId)).propertiesName,
      });
    }
    this.d.audit(actor, 'audits.propose_fix', projectId, null, {
      finding: findingId,
      code: f.code,
      page: f.pageName,
      fix: f.fix.kind,
      result: r.status,
      ...(r.status === 'proposal_captured' ? { proposalId: r.proposalId } : {}),
    });
    return r;
  }

  // ============================================================================================ re-check

  /**
   * "Re-check this finding now": the finding's page is read live (P1: its settings, sidebar and page documents; for an
   * ordering finding also its parent's children), swapped into the snapshot's model, and the check that made the finding
   * runs again. The finding is then still present (its evidence and source updated: the source says "live") or gone.
   * Only page-local findings can be re-checked; the rest say why. A re-check that finds a finding gone while the snapshot
   * still shows it brings it back as new at the next run, until the next full snapshot has the change.
   */
  async recheck(
    actor: string,
    projectId: string,
    findingId: number,
  ): Promise<{ status: 'still_present' | 'gone'; finding: Finding | null; reads: number }> {
    const f = this.store.get(projectId, findingId);
    if (!f) throw new AuditError('NOT_FOUND', `No finding ${findingId}.`);
    if (f.state !== 'open') throw new AuditError('FINDING_GONE', 'This finding is no longer present.');
    const check = RECHECKABLE[f.category];
    if (!check || f.pageId === null)
      throw new AuditError(
        'RECHECK_UNSUPPORTED',
        f.category === 'chronology'
          ? 'Chronology findings are re-checked by the chronology check itself (Chronology page: “Run the check now”).'
          : 'This finding is about more than one page (or about the audit itself), so it cannot be re-checked from one page. Run the audit again after the next full snapshot.',
      );
    const settings = this.d.projectSettings(projectId);
    const cfg = this.store.config(projectId);
    const types = this.d.registry.forProject(projectId).store.listTypes();
    const treeSettings = treeSettingsFrom(settings);
    const source = this.d.source ? this.d.source(projectId) : sourceOf(this.d.snapshots);
    const built = await buildModel(source, projectId, {
      propertiesName: treeSettings.propertiesName,
      tagSource: cfg.tagSource,
    });
    if (!built.ok) throw new AuditError('NO_SNAPSHOT', 'There is no complete full snapshot to compare with.');
    let reads = 0;
    const read = async (op: string, params: Record<string, unknown>): Promise<unknown> => {
      reads++;
      return this.d.engine.internalRead(projectId, op, params, { priority: 'P1' });
    };
    const pages = new Map(built.model.pages);
    const old = pages.get(f.pageId);
    const res = (await read('getResource', { path: { resourceId: f.pageId } })) as
      Record<string, unknown> | undefined;
    if (!res || typeof res !== 'object') {
      // The page is gone from LegendKeeper: whatever the finding said about it is moot.
      this.store.markGone(projectId, findingId, `recheck:${this.d.now()}`);
      this.d.audit(actor, 'audits.recheck', projectId, null, {
        finding: findingId,
        code: f.code,
        result: 'gone (the page no longer exists)',
      });
      return { status: 'gone', finding: this.store.get(projectId, findingId), reads };
    }
    const tagDoc = cfg.tagSource && cfg.tagSource.pageId === f.pageId ? cfg.tagSource.documentId : null;
    const live = await this.livePage(read, res, old, treeSettings.propertiesName, tagDoc);
    pages.set(f.pageId, live);
    if (f.category === 'ordering') {
      const parentId = String((f.evidence.parent as { id?: string } | undefined)?.id ?? live.parentId ?? '');
      let cursor: string | undefined;
      for (let i = 0; i < 100; i++) {
        const r = (await read('listResources', {
          query: { parentId, limit: 100, ...(cursor ? { cursor } : {}) },
        })) as { data?: unknown[]; hasMore?: unknown; nextCursor?: unknown } | undefined;
        for (const x of r?.data ?? []) {
          const o = x as Record<string, unknown>;
          const p = typeof o.id === 'string' ? pages.get(o.id) : undefined;
          if (p && typeof o.name === 'string')
            pages.set(p.id, {
              ...p,
              parentId: typeof o.parentId === 'string' ? o.parentId : p.parentId,
              rank: typeof o.rank === 'string' ? o.rank : p.rank,
              rawName: o.name,
              displayName: classifyName(o.name).displayName,
              kind: classifyName(o.name).kind,
            });
        }
        if (r?.hasMore !== true || typeof r.nextCursor !== 'string') break;
        cursor = r.nextCursor;
      }
    }
    const model: AuditModel = { ...built.model, pages };
    const ctx = this.context(projectId, model, cfg, types, treeSettings, settings);
    const drafts = check(ctx).map((d) => this.stored(ctx, d));
    const hit = drafts.find((d) => d.fingerprint === f.fingerprint);
    const now = this.d.now();
    let finding: Finding | null;
    if (hit) {
      this.store.touch(projectId, findingId, {
        evidence: hit.evidence,
        message: hit.message,
        source: { kind: 'live', takenAt: now, ageMs: 0, baseSnapshotId: built.model.base.id },
      });
      finding = this.store.get(projectId, findingId);
    } else {
      this.store.markGone(projectId, findingId, `recheck:${now}`);
      finding = this.store.get(projectId, findingId);
    }
    this.d.audit(actor, 'audits.recheck', projectId, null, {
      finding: findingId,
      code: f.code,
      page: f.pageName,
      result: hit ? 'still present' : 'gone',
    });
    return { status: hit ? 'still_present' : 'gone', finding, reads };
  }

  /** A page read live, as an `AuditPage` (its settings, sidebar and page documents). */
  private async livePage(
    read: (op: string, params: Record<string, unknown>) => Promise<unknown>,
    res: Record<string, unknown>,
    old: AuditPage | undefined,
    propertiesName: string,
    tagDoc: string | null,
  ): Promise<AuditPage> {
    const id = String(res.id);
    const rawName = typeof res.name === 'string' ? res.name : (old?.rawName ?? id);
    const side = extractSidebar(sidebarPiece(res.properties ?? []), propertiesName);
    const { tags, aliases } = extractResource(res);
    const docsRaw = (Array.isArray(res.documents) ? res.documents : []).filter(
      (x): x is Record<string, unknown> =>
        !!x &&
        typeof x === 'object' &&
        typeof (x as { id?: unknown }).id === 'string' &&
        !(x as { deletedAt?: unknown }).deletedAt,
    );
    const documents: DocumentInfo[] = docsRaw.map((x) => ({
      id: String(x.id),
      name: typeof x.name === 'string' ? x.name : null,
      type: typeof x.type === 'string' ? x.type : 'blank',
    }));
    const refs: Ref[] = [...side.refs];
    const scans: DocumentScan[] = [];
    for (const d of documents) {
      if (d.type !== 'page') continue;
      const body = (await read('getDocumentBlocks', { path: { resourceId: id, documentId: d.id } })) as
        { blocks?: unknown[] } | undefined;
      const { scan, refs: r } = scanDocument(d, Array.isArray(body?.blocks) ? body.blocks : [], {
        keepCode: tagDoc === d.id,
      });
      scans.push(scan);
      refs.push(...r);
    }
    const { kind, displayName } = classifyName(rawName);
    return {
      id,
      parentId: typeof res.parentId === 'string' ? res.parentId : null,
      rank: typeof res.rank === 'string' ? res.rank : (old?.rank ?? null),
      rawName,
      displayName,
      kind: old?.kind === 'root' ? 'root' : kind,
      tags,
      aliases,
      properties: side.properties,
      facts: side.facts,
      hasProperties: side.hasProperties,
      documents,
      scans,
      refs,
      sourceSnapshotId: old?.sourceSnapshotId ?? '',
      sourceTakenAt: this.d.now(),
      unreadable: [],
    };
  }

  // ============================================================================================ context

  private context(
    projectId: string,
    model: Awaited<ReturnType<typeof buildModel>> extends infer R
      ? R extends { ok: true; model: infer M }
        ? M
        : never
      : never,
    cfg: AuditConfig,
    types: ReturnType<ReturnType<Registry['forProject']>['store']['listTypes']>,
    treeSettings: ReturnType<typeof treeSettingsFrom>,
    settings: Readonly<ProjectSettings>,
  ): AuditContext {
    const registry = this.d.registry.forProject(projectId).store;
    const chron = this.d.chronology;
    const ready = chron.readiness(projectId);
    const lastChecks = chron.store.lastCheck(projectId);
    const lastGood = lastChecks && lastChecks.state === 'succeeded' ? lastChecks : null;
    const db = this.d.db;
    const recs = db
      .prepare(
        `SELECT id, page_id, page_name, action, created_at, job_id FROM lifecycle_records
         WHERE project_id = ? AND state = 'incomplete' AND set_id IS NULL ORDER BY id`,
      )
      .all(projectId) as {
      id: number;
      page_id: string;
      page_name: string;
      action: string;
      created_at: number;
      job_id: string | null;
    }[];
    const sets = db
      .prepare(
        `SELECT id, root_id, root_name, action, created_at, job_id, pages FROM lifecycle_sets
         WHERE project_id = ? AND state = 'incomplete' ORDER BY id`,
      )
      .all(projectId) as {
      id: number;
      root_id: string;
      root_name: string;
      action: string;
      created_at: number;
      job_id: string | null;
      pages: string;
    }[];
    const incompleteRecords: IncompleteRecord[] = recs.map((r) => ({
      id: r.id,
      pageId: r.page_id,
      pageName: r.page_name,
      action: r.action,
      createdAt: r.created_at,
      jobId: r.job_id,
    }));
    const incompleteSets: IncompleteRecord[] = sets.map((r) => ({
      id: r.id,
      pageId: r.root_id,
      pageName: r.root_name,
      action: r.action,
      createdAt: r.created_at,
      jobId: r.job_id,
      set: {
        rootId: r.root_id,
        pages: (safeJson(r.pages) as { id: string; name: string }[] | null) ?? [],
      },
    }));
    return makeContext({
      projectId,
      model,
      now: this.d.now(),
      treeSettings,
      lifecycle: lifecycleFrom(settings),
      types,
      entries: (typeId) => registry.entries(typeId),
      rules: effectiveRules(cfg, types),
      settings: cfg.settings,
      tagSource: cfg.tagSource,
      incompleteRecords,
      incompleteSets,
      chronologyConfigured: ready.ok,
      chronologyResourceId: ready.ok ? (chron.config(projectId).resourceId ?? null) : null,
      chronology: lastGood,
      tombstone: (id) => {
        try {
          return this.d.tree.queries.tombstone(projectId, id);
        } catch {
          return null;
        }
      },
      knownTemplateIds: new Set(registry.templates().templates.map((t) => t.id)),
      templateNames: [
        ...registry.templates().templates.map((t) => t.name),
        ...[...(model.templates?.values() ?? [])].map((t) => t.rawName),
      ],
      everSeen: (id) => {
        const rows = this.d.snapshots.index.pageHistory(projectId, id, { limit: 200 });
        if (rows.length === 0) return null;
        const named = rows.find((r) => r.name);
        return { name: named?.name ?? null, deleted: rows[0]!.piece === 'deleted' };
      },
    });
  }

  /** A draft as stored: the page's name and path, the category and severity of its code, its source, its fingerprint. */
  private stored(ctx: AuditContext, d: FindingDraft): StoredDraft {
    const info = CODES[d.code];
    const page = d.pageId ? ctx.model.pages.get(d.pageId) : undefined;
    const now = ctx.now;
    const source: FindingSource =
      d.sourceKind === 'bridge'
        ? { kind: 'bridge', takenAt: now, ageMs: 0 }
        : d.sourceKind === 'chronology-check' && d.source?.kind === 'chronology-check'
          ? {
              kind: 'chronology-check',
              checkId: d.source.checkId ?? 0,
              takenAt: d.source.takenAt ?? now,
              ageMs: Math.max(0, now - (d.source.takenAt ?? now)),
            }
          : snapshotSource(ctx, page ?? null);
    const pageId = d.pageId ?? null;
    const documentId = d.documentId ?? null;
    const blockId = d.blockId ?? null;
    return {
      fingerprint: fingerprintOf(ctx.projectId, { code: d.code, pageId, documentId, blockId, key: d.key }),
      code: d.code,
      category: info.category,
      severity: info.severity,
      pageId,
      pageName: page?.rawName ?? null,
      pagePath: page ? pathOf(ctx, page) : null,
      documentId,
      blockId,
      message: d.message,
      evidence: { ...d.evidence },
      source,
      fix: d.fix ?? null,
    };
  }
}

const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

const summaryOf = (c: AuditConfig) => ({
  rules:
    c.rules === null
      ? 'defaults'
      : c.rules.map((r) => ({ id: r.id, enabled: r.enabled, selectors: r.selectors, template: r.template })),
  tagSource: c.tagSource,
  settings: c.settings,
});

export { AuditError, evidenceHashOf, tagDefinitionOf };
