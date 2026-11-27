/**
 * The audit service (v2 E2, ADR 0044): runs the audits, keeps the owner's rules, and tracks findings across runs.
 *
 * A run reads the snapshots (never LegendKeeper), builds the context, runs every check, and commits the findings
 * (new, still present, gone). Runs happen after each nightly full snapshot completes, on demand from the dashboard, and
 * from the maintenance job. Findings are never fixed here: "Propose a fix" and "Re-check now" (src/audits/fixes.ts) are
 * the only two things that read LegendKeeper live, each on the owner's request.
 */
import { indexTaxonomyCheck } from './checks/index-taxonomy.js';
import { compareSiblingsNav } from '../registry/ordering.js';
import type { IndexTaxonomyAuditInput } from '../packs/indextax/service.js';
import { loggedTask } from '../maintenance/task-log.js';
import type { Db } from '../db/open.js';
import type { Chronology } from '../chronology/index.js';
import type { JobEngine, JobOrigin } from '../jobs/index.js';
import { lifecycleFrom } from '../lifecycle/settings.js';
import type { LifecycleTagRules } from '../lifecycle/tags.js';
import type { Registry } from '../registry/index.js';
import type { SnapshotService } from '../snapshots/service.js';
import { treeSettingsFrom } from '../tree/classify.js';
import type { ProjectSettings } from '../projects/settings.js';
import { auditConfigInputSchema, effectiveRules, type AuditConfig, type AuditRule } from './config.js';
import { chronologyCheck, keepRegionsCheck, lifecycleCheck } from './checks/lifecycle.js';
import { duplicateFoldersCheck, type AssetLibrary } from './checks/assets.js';
import { artLayoutCheck, auditLibraryView, characterFolders, type ArtPageText } from './checks/art-layout.js';
import type { OutfitRecord } from '../art/store.js';
import {
  governanceCheck,
  type GovernanceAuditInput,
  type GovernanceDocument,
  type KnownNames,
} from './checks/governance.js';
import type { GovernanceAuditRules } from '../packs/types.js';
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
  type NarrativeAuditInput,
  type RetagAuditHook,
} from './context.js';
import { narrativeCompare } from '../narrative/names.js';
import { AuditError } from './errors.js';
import {
  proposeFix as proposeFixVia,
  type CoreUpgrader,
  type FixResult,
  type TemplatedRenamer,
  type TerritoryCategoryCreator,
} from './fixes.js';
import type { NationAuditInput } from '../packs/nations/service.js';
import { nationTaxonomyCheck } from './checks/nation-taxonomy.js';
import {
  templatedNamesCheck,
  templatedNamesReport,
  type TemplatedNamesAuditInput,
} from './checks/templated-names.js';
import type { TemplatedRow } from '../packs/names/template.js';
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
import { consistencyCheck } from './checks/consistency.js';
import { narrativeCheck } from './checks/narrative.js';
import { writesCheck } from './checks/writes.js';
import { referenceTypesCheck } from './checks/reference-types.js';
import type { ReferenceTypeAuditInput } from '../packs/reftypes/service.js';
import type { UnknownWriteItem } from '../jobs/reconcile.js';
import type { ConsistencyAuditItem } from './context.js';
import {
  CODES,
  type AuditRun,
  type Finding,
  type FindingDraft,
  type FindingSource,
  type RunCounts,
} from './types.js';

/** v3 F7.1 (ADR 0072): the pages whose blocks the `core_compact_wording` check reads (a Core and an Art page). */
const CORE_OR_ART_PAGE = /\s-\sCharacter (Core|Art)\s*$/i;

/** The checks, in the order the dashboard lists their categories. */
export const CHECKS: readonly { readonly id: string; readonly run: Check }[] = [
  { id: 'rules', run: rulesCheck },
  { id: 'references', run: referencesCheck },
  { id: 'unclassified', run: unclassifiedCheck },
  { id: 'ordering', run: orderingCheck },
  { id: 'taxonomy', run: taxonomyCheck },
  // v3 F6a (ADR 0076): the Reference Type vocabulary (category taxonomy; the noncanonical fix is the owner's mapping).
  { id: 'reference-types', run: referenceTypesCheck },
  // v3 F6b (ADR 0079): approved index classifications not yet carried out (index_prefix, index_tags).
  { id: 'index-taxonomy', run: indexTaxonomyCheck },
  // v3 F6c (ADR 0080): territories, nations and their subindexes (each of the three switchable per project).
  { id: 'nation-taxonomy', run: nationTaxonomyCheck },
  // v3 F6d (ADR 0082): templated source names (switchable per project; the report is built once per run).
  { id: 'templated-names', run: templatedNamesCheck },
  { id: 'facts', run: factsCheck },
  { id: 'lifecycle', run: lifecycleCheck },
  { id: 'keep-regions', run: keepRegionsCheck },
  { id: 'chronology', run: chronologyCheck },
  { id: 'assets', run: duplicateFoldersCheck },
  // v3 F7 (ADR 0070, G7): the art layout (read-only; every fix a proposal).
  { id: 'art-layout', run: artLayoutCheck },
  // v3 F4a (ADR 0063): the governance documents against the bridge (report only).
  { id: 'governance', run: governanceCheck },
  // v3 F4b (ADR 0064): dates and identity facts restated differently on Authoritative pages (Contradictory only).
  { id: 'consistency', run: consistencyCheck },
  // v3 F4c (ADR 0065): Narratives' layout, numbering, plans and chapters, datelines (report only; mechanical fixes).
  { id: 'narrative', run: narrativeCheck },
  // v3 F5a (ADR 0067, H10): the bridge's own writes whose outcome is still unknown (report only).
  { id: 'writes', run: writesCheck },
];

/**
 * v3 F4a (ADR 0063): what the governance check needs of the bridge for one project: the drift rules of the pack that
 * governs it, the pages its governance sources sit on in this project (the governance root, whose tabs are read from the
 * snapshots), and the names the bridge knows.
 */
export interface GovernanceAuditHook {
  readonly rules: GovernanceAuditRules;
  readonly packName: string;
  readonly roots: readonly string[];
  readonly known: KnownNames;
}

export interface AuditDeps {
  readonly db: Db;
  readonly snapshots: SnapshotService;
  readonly registry: Pick<Registry, 'forProject'>;
  readonly chronology: Pick<Chronology, 'config' | 'readiness' | 'store' | 'proposeFix'>;
  readonly tree: {
    readonly queries: {
      tombstone(projectId: string, id: string): { observedAt: number; reason: string } | null;
      /** v3 F7 (G7): a character's repository index by its name, and the pages under it (their blocks are kept). */
      findByDisplayName?(
        projectId: string,
        name: string,
      ): { data: readonly { node: { id: string; kind: string } }[] };
      subtree?(projectId: string, id: string): { data: { entries: readonly { node: { id: string } }[] } };
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
  readonly log?: {
    warn(obj: Record<string, unknown>, msg: string): void;
    info?(obj: Record<string, unknown>, msg: string): void;
  };
  /** v3 F2: the asset library from the bridge's asset tree (null when it is not built), for duplicate folders. */
  readonly assetLibrary?: (projectId: string) => AssetLibrary | null;
  /** v3 F7 (ADR 0070, G7): a character folder's outfit record, for the art layout check. */
  readonly outfits?: { forCharacter(projectId: string, characterFolderId: string): readonly OutfitRecord[] };
  /** v3 F3d (ADR 0053): a project's lifecycle tag rules (`Packs.lifecycleRules`); absent: the defaults. */
  readonly lifecycleTags?: (projectId: string) => LifecycleTagRules;
  /** v3 F3f (ADR 0060): the retag engine's hook for a project (null: its approved pack has no retag rules). */
  readonly retag?: (projectId: string) => RetagAuditHook | null;
  /** v3 F4a (ADR 0063): the governance check's hook for a project (null: no pack's drift rules govern it). */
  readonly governance?: (projectId: string) => GovernanceAuditHook | null;
  /**
   * v3 F4b (ADR 0064): the consistency check's Contradictory findings for a project (null: the consistency rules do not
   * apply here). Free: the consistency service's facts index over the same snapshots.
   */
  readonly consistency?: (projectId: string) => Promise<readonly ConsistencyAuditItem[] | null>;
  /** v3 F5a (ADR 0067, H10): the writes whose outcome the reconciler could not settle (the `writes` category). */
  readonly unknownWrites?: (projectId: string) => readonly UnknownWriteItem[];
  /**
   * v3 F4c (ADR 0065): the narrative rules of the project's approved pack and the chronology's calendar (null: no
   * narrative audit; Narratives is then ordinary content).
   */
  readonly narrative?: (projectId: string) => NarrativeAuditInput | null;
  /** v3 F6a (ADR 0076): the Reference Type vocabulary and the owner's decisions for a project (null: none approved). */
  readonly referenceTypes?: (projectId: string) => ReferenceTypeAuditInput | null;
  /** v3 F6b (ADR 0079): the approved index taxonomy and rows. */
  readonly indexTaxonomy?: (projectId: string) => IndexTaxonomyAuditInput | null;
  /** v3 F6c (ADR 0080): territories, nations and their subindexes (the three checks). */
  readonly nationTaxonomy?: (projectId: string) => Promise<NationAuditInput | null>;
  /** v3 F6c: a nation subindex decision as it stands now, for the rename fix (null: undone). */
  readonly nationSubindexDecision?: (
    projectId: string,
    pageId: string,
  ) => { readonly id: string; readonly action: string; readonly role: string | null } | null;
  /** v3 F6a: a decision as it stands now, for the `reference_type` fix (null: undone). */
  readonly referenceTypeDecision?: (
    projectId: string,
    id: string,
  ) => { readonly action: string; readonly target: string | null; readonly conflict: string | null } | null;
  /**
   * v3 F6d (ADR 0082): templated source names' input for a project (null: the approved pack carries none). The pages
   * under a character's repository index are added by the run.
   */
  readonly templatedNames?: (projectId: string) => Omit<TemplatedNamesAuditInput, 'characterPages'> | null;
  /** v3 F6d: where each run's Templated Names report goes (the Templated Names page reads it). */
  readonly templatedNamesSink?: (
    projectId: string,
    meta: {
      readonly runId: string;
      readonly snapshotId: string;
      readonly takenAt: number;
      readonly excluded: Readonly<Record<string, number>>;
    },
    rows: readonly TemplatedRow[],
  ) => void;
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

  /** v3 F7.1 (ADR 0072): the `core_upgrade` fix's planner, set by the runtime once the tool layer exists. */
  private coreUpgrader: CoreUpgrader | null = null;
  setCoreUpgrader(u: CoreUpgrader | null): void {
    this.coreUpgrader = u;
  }

  /** v3 F6d (ADR 0082): the `templated_name` fix's renamer (the rename engine's page mode), set by the runtime. */
  private templatedRenamer: TemplatedRenamer | null = null;
  setTemplatedRenamer(r: TemplatedRenamer | null): void {
    this.templatedRenamer = r;
  }

  /** v3 F6c (ADR 0080): the `territory_category` fix's creator (create_index's role form), set by the runtime. */
  private territoryCreator: TerritoryCategoryCreator | null = null;
  setTerritoryCategoryCreator(c: TerritoryCategoryCreator | null): void {
    this.territoryCreator = c;
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

  /**
   * v3 F4a (ADR 0063): the owner allows the skill a `governance_external_name` finding names (a real skill used
   * elsewhere): the name joins the audit settings' allowed names, the governance check never reports it again, and its
   * open findings go now. Audited (`audits.allow_name`). Withdrawn by removing it from the allowed names in the audit
   * settings.
   */
  allowName(
    actor: string,
    projectId: string,
    findingId: number,
  ): { readonly finding: Finding | null; readonly name: string; readonly allowed: readonly string[] } {
    const f = this.store.get(projectId, findingId);
    if (!f) throw new AuditError('NOT_FOUND', `No finding ${findingId}.`);
    if (f.code !== 'governance_external_name')
      throw new AuditError(
        'NOT_ALLOWABLE',
        'Only an external skill name (governance_external_name) can be allowed; acknowledge any other finding instead.',
      );
    const name = typeof f.evidence.name === 'string' ? f.evidence.name.trim() : '';
    if (name === '') throw new AuditError('NOT_ALLOWABLE', 'This finding names no skill.');
    const had = this.store.config(projectId).settings.governanceAllowedNames;
    const known = had.some((n) => n.toLowerCase() === name.toLowerCase());
    const allowed = known ? had : [...had, name];
    if (!known)
      this.store.setConfig(projectId, { settings: { governanceAllowedNames: [...allowed] } }, actor);
    const runId = `allow:${this.d.now()}`;
    for (const x of this.store.list(projectId, {
      code: ['governance_external_name'],
      acknowledged: 'include',
      limit: 1000,
    }).findings)
      if (typeof x.evidence.name === 'string' && x.evidence.name.toLowerCase() === name.toLowerCase())
        this.store.markGone(projectId, x.id, runId);
    this.d.audit(actor, 'audits.allow_name', projectId, known ? { name } : null, {
      finding: findingId,
      name,
      allowed: allowed.length,
    });
    return { finding: this.store.get(projectId, findingId), name, allowed };
  }

  // ============================================================================================ reading

  list(projectId: string, f: FindingFilter = {}) {
    return this.store.list(projectId, f);
  }

  // ============================================================================================ running

  /** After a full snapshot completes (the snapshot service's hook): an audit of it, in the background. */
  afterFullSnapshot(projectId: string): void {
    // CR-2026-11-R3 (R3-65): background work: its start and finish in the log, with the memory.
    const log = this.d.log;
    const p = loggedTask(
      log?.info ? { info: (obj, msg) => log.info!(obj, msg) } : undefined,
      'audit after the full snapshot',
      { project: projectId },
      () => this.run(projectId, 'snapshot'),
    )
      .catch((e: unknown) =>
        this.d.log?.warn({ err: e, projectId }, 'the audit after the full snapshot failed'),
      )
      .then(() => undefined)
      .finally(() => this.background.delete(p));
    this.background.add(p);
  }

  /**
   * v3 F7 (ADR 0070, G7): the pages whose blocks the art layout check reads: every page under each character's
   * repository index (an index named as a character folder of the asset library), the index included.
   */
  private characterPageIds(projectId: string): Set<string> {
    const out = new Set<string>();
    const q = this.d.tree.queries;
    let lib: AssetLibrary | null;
    try {
      lib = this.d.assetLibrary?.(projectId) ?? null;
    } catch {
      lib = null;
    }
    if (!lib || !q.findByDisplayName || !q.subtree) return out;
    const view = auditLibraryView(lib);
    for (const id of characterFolders(lib, view)) {
      const name = view.folder(id)?.name;
      if (!name) continue;
      for (const m of q.findByDisplayName(projectId, name).data) {
        if (m.node.kind !== 'index') continue;
        out.add(m.node.id);
        for (const e of q.subtree(projectId, m.node.id).data.entries) out.add(e.node.id);
      }
    }
    return out;
  }

  /** v3 F9 (ADR 0074, B5): whether an audit of the project is running now. */
  isRunning(projectId: string): boolean {
    return this.running.has(projectId);
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
      // v3 F4a (ADR 0063): the governance root's tabs are kept whole for the governance check (only those pages).
      const governance = this.governanceHook(projectId);
      const characterPages = this.characterPageIds(projectId);
      const built = await buildModel(source, projectId, {
        propertiesName: treeSettings.propertiesName,
        tagSource: cfg.tagSource,
        ...(governance ? { keepBlocksOf: new Set(governance.roots) } : {}),
        // v3 F7 (G7): every page under each character's repository index, whose lines may name asset folders.
        keepBlocksWhere: (p) => characterPages.has(p.id) || CORE_OR_ART_PAGE.test(p.name),
      });
      if (!built.ok) {
        const summary =
          'Skipped: there is no complete full snapshot to audit yet (the first nightly snapshot makes one).';
        this.store.finishRun(run.id, { state: 'skipped', summary });
        return { runId: run.id, state: 'skipped', summary, changed: false, skipped: true };
      }
      const model = built.model;
      const ctx = this.context(
        projectId,
        model,
        cfg,
        types,
        treeSettings,
        settings,
        governance ? governanceInput(governance, model, cfg) : null,
        await this.consistencyItems(projectId),
        await this.nationTaxonomyInput(projectId),
        this.templatedNamesInput(projectId, characterPages),
      );
      const drafts: FindingDraft[] = [];
      for (const c of CHECKS) {
        // v3 F6a.1 (ADR 0076 amendment 1): each check is a synchronous pass over every page; the run yields to the event
        // loop between them, so a whole-repository audit cannot hold every request and the scheduler for its length.
        await new Promise<void>((resolve) => setImmediate(resolve));
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
      // v3 F6d (ADR 0082): the Templated Names report the run worked out (once, memoised), for the dashboard.
      const names = this.d.templatedNamesSink ? templatedNamesReport(ctx) : null;
      if (names)
        try {
          this.d.templatedNamesSink!(
            projectId,
            {
              runId: run.id,
              snapshotId: model.newest.id,
              takenAt: model.newest.takenAt,
              excluded: names.excluded,
            },
            names.rows,
          );
        } catch (e) {
          this.d.log?.warn({ err: e, projectId }, 'the Templated Names report could not be stored');
        }
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
   * machinery of an existing tool, with every guard. Nothing is applied; the owner approves it. Audited. v3 F12 (ADR
   * 0081): the owner's own "Apply fix" (`origin.ownerConfirmed`, confirmed in its dialog) runs it at once as one job.
   */
  async proposeFix(
    actor: string,
    projectId: string,
    findingId: number,
    opts: {
      readonly confirmShapeChange?: boolean;
      /** v3 F2.1: "Use this event" on a refused, ambiguous sync fix. */
      readonly eventId?: string;
      /** v3 F2.1: "Make a new event" on a refused, ambiguous sync fix. */
      readonly createNew?: boolean;
      /** v3 F2.1: "Pair with this row" on an event in a tie: which candidate row. */
      readonly rowId?: string;
      /**
       * v3 F3c (ADR 0054): an agent's `arkona_appraisal_fix` handing sibling order or tags over to this fix: the
       * proposal is the agent's own. Absent: the owner's, from the dashboard.
       */
      readonly origin?: JobOrigin;
      /**
       * v3 F5b (ADR 0068): the automation engine plans the fix through these instead of the engine's own (its reads at
       * P3, and the planned job captured rather than submitted, so the engine can apply it or gather it into one
       * proposal). Bridge code only.
       */
      readonly engine?: {
        internalRead(
          projectId: string,
          op: string,
          params: Record<string, unknown>,
          o: object,
        ): Promise<unknown>;
        submit(req: Record<string, unknown>): Promise<Record<string, unknown>>;
      };
      /** v3 F7.1 (ADR 0072): the automation's Apply of a code allowing it: submitted as a job (guards judging it). */
      readonly direct?: boolean;
    } = {},
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
      f.fix.kind === 'chronology_orphan' ||
      f.fix.kind === 'chronology_pair' ||
      f.fix.kind === 'chronology_kcy' ||
      f.fix.kind === 'chronology_style' ||
      f.fix.kind === 'chronology_uri' ||
      f.fix.kind === 'chronology_order'
    ) {
      const kind = f.fix.kind;
      if (kind === 'chronology_pair') {
        const rows = Array.isArray(f.fix.args.candidates)
          ? (f.fix.args.candidates as { rowId?: unknown }[]).map((c) => c.rowId)
          : [];
        if (opts.rowId === undefined || !rows.includes(opts.rowId))
          throw new AuditError(
            'FIX_NOT_APPLICABLE',
            'Pick one of the rows this event is tied with (Pair with this row); nothing was proposed.',
          );
      }
      const c = await this.d.chronology.proposeFix(
        actor,
        projectId,
        kind === 'chronology_kcy' || kind === 'chronology_style'
          ? {
              kind: kind === 'chronology_kcy' ? 'kcy' : 'style',
              age: String(f.fix.args.age),
              rowId: String(f.fix.args.rowId),
            }
          : kind === 'chronology_uri'
            ? { kind: 'uri', age: String(f.fix.args.age), eventId: String(f.fix.args.eventId) }
            : kind === 'chronology_order'
              ? { kind: 'order', age: String(f.fix.args.age) }
              : kind === 'chronology_count'
                ? { kind: 'count', age: String(f.fix.args.age) }
                : kind === 'chronology_orphan'
                  ? { kind: 'orphan', age: String(f.fix.args.age), eventId: String(f.fix.args.eventId) }
                  : kind === 'chronology_pair'
                    ? {
                        age: String(f.fix.args.age),
                        rowId: opts.rowId!,
                        eventId: String(f.fix.args.eventId),
                        ...(opts.confirmShapeChange === true ? { confirmShapeChange: true } : {}),
                      }
                    : {
                        age: String(f.fix.args.age),
                        rowId: String(f.fix.args.rowId),
                        // v2 E6 (ADR 0048): a range made a single date (or the reverse) only with the owner's confirmation.
                        ...(opts.confirmShapeChange === true ? { confirmShapeChange: true } : {}),
                        // v3 F2.1: the owner's choice after a refused, ambiguous pairing.
                        ...(opts.eventId !== undefined ? { eventId: opts.eventId } : {}),
                        ...(opts.createNew === true ? { createNew: true } : {}),
                      },
        // v3 F12 (ADR 0081): the owner's confirmed "Apply fix" runs at once.
        opts.origin?.ownerConfirmed === true ? { ownerConfirmed: true } : undefined,
      );
      r =
        c.status === 'proposal_captured'
          ? { status: 'proposal_captured', proposalId: c.proposalId, summary: c.summary, fix: kind }
          : c.status === 'job_submitted'
            ? { status: 'job_submitted', jobId: c.jobId, summary: c.summary, fix: kind }
            : c;
    } else {
      r = await proposeFixVia(
        {
          engine: (opts.engine ?? this.d.engine) as never,
          now: this.d.now,
          ...(opts.origin ? { origin: opts.origin } : {}),
          ...(this.coreUpgrader ? { coreUpgrade: this.coreUpgrader } : {}),
          ...(opts.direct === true ? { direct: true } : {}),
          ...(this.d.referenceTypeDecision ? { referenceTypeDecision: this.d.referenceTypeDecision } : {}),
          ...(this.d.nationSubindexDecision ? { nationSubindexDecision: this.d.nationSubindexDecision } : {}),
          ...(this.territoryCreator ? { territoryCategory: this.territoryCreator } : {}),
          ...(this.templatedRenamer ? { templatedRename: this.templatedRenamer } : {}),
          // v3 F6b (ADR 0079): T11's order where the approved pack carries it (and as the narrative order's fallback).
          ...(this.indexTaxonomyInput(projectId)?.navOrdering ? { navOrder: true } : {}),
          narrativeOrder: (() => {
            const n = this.narrativeInput(projectId);
            if (!n) return null;
            return this.indexTaxonomyInput(projectId)?.navOrdering
              ? narrativeCompare(n.rules, compareSiblingsNav)
              : narrativeCompare(n.rules);
          })(),
        },
        projectId,
        f,
        {
          propertiesName: treeSettingsFrom(this.d.projectSettings(projectId)).propertiesName,
        },
      );
    }
    this.d.audit(actor, 'audits.propose_fix', projectId, null, {
      finding: findingId,
      code: f.code,
      page: f.pageName,
      fix: f.fix.kind,
      result: r.status,
      ...(r.status === 'proposal_captured' ? { proposalId: r.proposalId } : {}),
      ...(r.status === 'job_submitted' ? { jobId: r.jobId } : {}),
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
          : f.category === 'governance'
            ? 'Governance findings are checked against the whole repository and the bridge’s tools, so they are not re-checked from one page: run the audit again once the snapshots hold the edited governance page (the next change snapshot or full snapshot).'
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

  /** v3 F4b (ADR 0064): the consistency check's findings, or null (not configured here, or it could not be read). */
  private async consistencyItems(projectId: string): Promise<readonly ConsistencyAuditItem[] | null> {
    if (!this.d.consistency) return null;
    try {
      return await this.d.consistency(projectId);
    } catch (e) {
      this.d.log?.warn({ err: e, projectId }, 'the consistency check could not run; it is skipped');
      return null;
    }
  }

  /** v3 F4c (ADR 0065): the narrative audit's input for a project, or null. */
  /** v3 F6b (ADR 0079): the approved index taxonomy and rows, or null (none, or unreadable: logged). */
  /** v3 F6c (ADR 0080): the three territory and nation checks' input (null: none, or it could not be read). */
  async nationTaxonomyInput(projectId: string): Promise<NationAuditInput | null> {
    if (!this.d.nationTaxonomy) return null;
    try {
      return await this.d.nationTaxonomy(projectId);
    } catch (e) {
      this.d.log?.warn({ err: e, projectId }, 'the territory and nation checks’ input could not be read');
      return null;
    }
  }

  /** v3 F6d (ADR 0082): templated names' input (null: none, or it could not be read: logged). */
  templatedNamesInput(
    projectId: string,
    characterPages?: ReadonlySet<string>,
  ): TemplatedNamesAuditInput | null {
    if (!this.d.templatedNames) return null;
    try {
      const i = this.d.templatedNames(projectId);
      return i ? { ...i, ...(characterPages ? { characterPages } : {}) } : null;
    } catch (e) {
      this.d.log?.warn({ err: e, projectId }, 'templated names could not be read; the check is skipped');
      return null;
    }
  }

  indexTaxonomyInput(projectId: string): IndexTaxonomyAuditInput | null {
    if (!this.d.indexTaxonomy) return null;
    try {
      return this.d.indexTaxonomy(projectId);
    } catch (e) {
      this.d.log?.warn({ err: e, projectId }, 'the index taxonomy could not be read; its checks are skipped');
      return null;
    }
  }

  narrativeInput(projectId: string): NarrativeAuditInput | null {
    if (!this.d.narrative) return null;
    try {
      return this.d.narrative(projectId);
    } catch (e) {
      this.d.log?.warn(
        { err: e, projectId },
        'the narrative rules could not be read; the narrative audit is skipped',
      );
      return null;
    }
  }

  /** v3 F4a (ADR 0063): the governance check's hook for a project, or null (none, or it could not be worked out). */
  private governanceHook(projectId: string): GovernanceAuditHook | null {
    if (!this.d.governance) return null;
    try {
      const h = this.d.governance(projectId);
      return h && h.roots.length > 0 ? h : null;
    } catch (e) {
      this.d.log?.warn({ err: e, projectId }, 'the governance check could not be set up; it is skipped');
      return null;
    }
  }

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
    governance: GovernanceAuditInput | null = null,
    consistency: readonly ConsistencyAuditItem[] | null = null,
    nationTaxonomy: NationAuditInput | null = null,
    templatedNames: TemplatedNamesAuditInput | null = null,
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
    const narrative = this.narrativeInput(projectId);
    return makeContext({
      projectId,
      model,
      ...(narrative ? { narrative } : {}),
      now: this.d.now(),
      treeSettings,
      lifecycle: lifecycleFrom(settings),
      ...(this.d.lifecycleTags ? { lifecycleTags: this.d.lifecycleTags(projectId) } : {}),
      ...(this.d.retag
        ? {
            retag: (() => {
              try {
                return this.d.retag(projectId);
              } catch {
                return null;
              }
            })(),
          }
        : {}),
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
      assetLibrary: (() => {
        try {
          return this.d.assetLibrary?.(projectId) ?? null;
        } catch {
          return null;
        }
      })(),
      ...(this.d.outfits ? { outfitsOf: (id: string) => this.d.outfits!.forCharacter(projectId, id) } : {}),
      mainBlocks: (pageId: string) => {
        const p = model.pages.get(pageId);
        if (!p || !model.blocks) return null;
        const doc = p.documents.find((d) => d.name === 'Main') ?? p.documents.find((d) => d.type === 'page');
        const blocks = doc ? model.blocks.get(doc.id) : undefined;
        return doc && blocks ? { documentId: doc.id, blocks } : null;
      },
      characterPages: (character: string): ArtPageText[] => {
        // v3 F7 (G7): every page under the character's repository index (the index too), from the snapshots.
        const out: ArtPageText[] = [];
        if (!model.blocks) return out;
        const key = character.normalize('NFC').toLowerCase();
        const indexes = [...model.pages.values()].filter(
          (p) => p.kind === 'index' && p.displayName.normalize('NFC').toLowerCase() === key,
        );
        const under = new Set(indexes.map((p) => p.id));
        for (let grew = true; grew;) {
          grew = false;
          for (const p of model.pages.values())
            if (p.parentId && under.has(p.parentId) && !under.has(p.id)) {
              under.add(p.id);
              grew = true;
            }
        }
        for (const p of model.pages.values()) {
          if (!under.has(p.id)) continue;
          for (const doc of p.documents) {
            const blocks = model.blocks.get(doc.id);
            if (blocks) out.push({ pageId: p.id, documentId: doc.id, blocks });
          }
        }
        return out;
      },
      tombstone: (id) => {
        try {
          return this.d.tree.queries.tombstone(projectId, id);
        } catch {
          return null;
        }
      },
      unknownWrites: (() => {
        try {
          return this.d.unknownWrites?.(projectId) ?? [];
        } catch {
          return [];
        }
      })(),
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
      ...(governance ? { governance } : {}),
      ...(consistency ? { consistency } : {}),
      ...(this.d.referenceTypes
        ? {
            referenceTypes: (() => {
              try {
                return this.d.referenceTypes(projectId);
              } catch {
                return null;
              }
            })(),
          }
        : {}),
      ...(this.d.indexTaxonomy ? { indexTaxonomy: this.indexTaxonomyInput(projectId) } : {}),
      ...(nationTaxonomy ? { nationTaxonomy } : {}),
      ...(templatedNames ? { templatedNames } : {}),
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

/**
 * v3 F4a (ADR 0063): the governance check's input: every page document of the governance root (its tabs), with their
 * blocks as the snapshots hold them (null for a piece the store could not give), and the names the owner allowed.
 */
function governanceInput(h: GovernanceAuditHook, model: AuditModel, cfg: AuditConfig): GovernanceAuditInput {
  const documents: GovernanceDocument[] = [];
  for (const root of h.roots) {
    const page = model.pages.get(root);
    if (!page) continue;
    for (const d of page.documents) {
      if (d.type !== 'page') continue;
      documents.push({
        pageId: root,
        documentId: d.id,
        name: d.name,
        blocks: model.blocks?.get(d.id) ?? null,
      });
    }
  }
  return {
    rules: h.rules,
    packName: h.packName,
    documents,
    known: h.known,
    allowed: new Set(cfg.settings.governanceAllowedNames.map((n) => n.toLowerCase())),
  };
}

const summaryOf = (c: AuditConfig) => ({
  rules:
    c.rules === null
      ? 'defaults'
      : c.rules.map((r) => ({ id: r.id, enabled: r.enabled, selectors: r.selectors, template: r.template })),
  tagSource: c.tagSource,
  settings: c.settings,
});

export { AuditError, evidenceHashOf, tagDefinitionOf };
