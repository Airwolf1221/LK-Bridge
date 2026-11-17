/**
 * The appraisal service (v3 F3c, ADR 0054; the owner-approved design docs/design/F3c-appraisal.md): the full-text index
 * (A1), the four read-only appraisal tools (A2 to A5), their stored runs (D4) and "Propose a fix" (section F).
 *
 * Every tool reads the snapshot overlay (the nightly full snapshot plus the change snapshots since), the audits' store,
 * the bridge's asset tree and its own database: **no LegendKeeper read** unless the caller asks for `live: true` (A2 and
 * A3 re-read the pages concerned) or proposes a fix (one re-read, then the proposal). **No tool writes to LegendKeeper**:
 * a fix is always ONE ordinary proposal for the owner to approve.
 */
import { createHash } from 'node:crypto';
import type { Audits } from '../audits/index.js';
import { sourceOf, type SnapshotSource } from '../audits/reader.js';
import type { Db } from '../db/open.js';
import { extractSidebar } from '../audits/model.js';
import type { JobOrigin } from '../jobs/index.js';
import { lifecycleFrom } from '../lifecycle/settings.js';
import type { Packs } from '../packs/service.js';
import type { PackRules } from '../packs/types.js';
import { textKey } from '../packs/engine/text.js';
import type { ProposalDetail } from '../policy/proposals.js';
import type { ProposalState, ProposalView } from '../policy/types.js';
import type { JobEngine } from '../jobs/index.js';
import type { ProjectSettings } from '../projects/settings.js';
import type { SnapshotService } from '../snapshots/service.js';
import { treeSettingsFrom } from '../tree/classify.js';
import type { TreeNode } from '../tree/index.js';
import { workingDigest } from './digest.js';
import { proposeAppraisalFix, type FixResult } from './fixes.js';
import { FullText } from './fts.js';
import { effectsOfProposal, impactOf, type PlannedEffect } from './impact.js';
import { AppraisalIndex, type IndexState } from './overlay.js';
import { appraisePage, type Draft } from './owner.js';
import { PageReader, type LiveRead } from './reader.js';
import { CHECKS, FIX_CHANGE } from './rules.js';
import { inScope, labelContext } from './scope.js';
import { AppraisalStore, newRunId } from './store.js';
import {
  AppraisalError,
  TOOL_GROUPS,
  type AppraisalFinding,
  type AppraisalReport,
  type AppraisalTool,
  type FollowUp,
  type ReportSource,
} from './types.js';
import { headOf, sniff, visualHygiene, type LibraryAsset, type ShownImage } from './visual.js';

type Obj = Record<string, unknown>;

/** The pack whose tools these are. */
export const PACK_ID = 'arkona';

/** The most pages one appraisal reads (a whole-repository run of Arkona is about 1,500). */
export const MAX_PAGES = 5000;
/** The most pages `live: true` re-reads in one appraisal (2 reads each). */
export const MAX_LIVE_PAGES = 25;

export interface AppraisalDeps {
  readonly db: Db;
  readonly snapshots: SnapshotService;
  readonly audits: Pick<Audits, 'store' | 'proposeFix'>;
  readonly packs: Pick<Packs, 'get' | 'attachment'>;
  readonly tree: {
    readonly queries: {
      node(projectId: string, id: string): { readonly data: TreeNode | null };
      children(projectId: string, id: string): { readonly data: readonly TreeNode[] };
    };
  };
  readonly assets: {
    readonly queries: { status(projectId: string): { status: string; confirmedAt: number | null } };
  };
  readonly proposals: {
    list(f: { project: string; state?: readonly ProposalState[]; limit?: number }): ProposalView[];
    detail(id: string): ProposalDetail | undefined;
    get(id: string): ProposalView | undefined;
  };
  readonly chronologyDocuments: (projectId: string) => readonly string[];
  /** The character's expected asset folder (the image planner's, as the pack's art tool uses it). */
  readonly characterFolder: (
    projectId: string,
    subject: string,
    race: string | null,
  ) => readonly string[] | null;
  readonly engine: Pick<JobEngine, 'internalRead' | 'submit'>;
  readonly projectSettings: (projectId: string) => Readonly<ProjectSettings>;
  readonly assetHosts: readonly string[];
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

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
};
const iso = (t: number) => new Date(t).toISOString();

/**
 * The snapshots the appraisal reads: the audits' source (ADR 0044), except that the newest full snapshot is taken
 * **complete or partial**. A partial one is complete but for the pieces it lists as missing (an image its page shows that
 * could not be downloaded, a map LegendKeeper cannot list); the overlay records each as the page's blocked case, so one
 * broken image (A5's very finding) never stops every appraisal. A damaged piece is likewise reported, never guessed.
 */
export function appraisalSource(svc: SnapshotService): SnapshotSource {
  const base = sourceOf(svc);
  return {
    ...base,
    fulls: (projectId) =>
      svc.index
        .snapshots(projectId, { kind: 'full', limit: 100 })
        .map((s) => ({ id: s.id, takenAt: s.takenAt })),
  };
}

/** The fingerprint a finding is known by in every run. */
export function findingId(projectId: string, tool: string, d: Draft): string {
  const h = createHash('sha1')
    .update(
      [projectId, tool, d.check, d.pageId ?? '', d.documentId ?? '', d.blockId ?? '', d.key ?? ''].join(
        '\u0001',
      ),
    )
    .digest('hex');
  return `af_${h.slice(0, 20)}`;
}

/** What a scope asked for, as a stable key (the stored run it replaces). */
const scopeKeyOf = (o: Readonly<Record<string, unknown>>): string =>
  JSON.stringify(
    Object.keys(o)
      .sort()
      .map((k) => [k, o[k]]),
  );

export interface ScopeInput {
  /** One page (an id). */
  readonly pageId?: string;
  /** A branch: this page and everything beneath it (an id). */
  readonly underId?: string;
  /** Everything (bounded). */
  readonly all?: boolean;
  /** Non-current areas brought in (`legacy`, `design`; for A2 also `archived`). */
  readonly include?: readonly string[];
}

export class Appraisal {
  readonly index: AppraisalIndex;
  readonly fullText: FullText;
  readonly store: AppraisalStore;

  constructor(readonly d: AppraisalDeps) {
    const source = d.source ?? ((_projectId: string) => appraisalSource(d.snapshots));
    this.index = new AppraisalIndex({
      db: d.db,
      source,
      propertiesName: (projectId) => treeSettingsFrom(d.projectSettings(projectId)).propertiesName,
      now: d.now,
      ...(d.log ? { log: d.log } : {}),
    });
    this.fullText = new FullText(d.db);
    this.store = new AppraisalStore(d.db, d.now);
  }

  // ============================================================================================ the index (A1)

  /** After a full snapshot completes (the snapshot service's hook): the overlay and the index rebuilt from it. */
  afterFullSnapshot(projectId: string): void {
    this.index.afterFullSnapshot(projectId);
  }

  /** Brings the index up to date (free: the snapshot store only). */
  ensureIndex(projectId: string, o: { readonly rebuild?: boolean } = {}) {
    return this.index.ensure(projectId, o);
  }

  /** How fresh the index is, as every answer states it. */
  freshness(projectId: string, st: IndexState | null = this.index.state(projectId)): ReportSource['index'] {
    if (!st) return null;
    const now = this.d.now();
    return {
      base: { id: st.baseSnapshotId, takenAt: iso(st.baseTakenAt) },
      newest: { id: st.newestSnapshotId, takenAt: iso(st.newestTakenAt) },
      changeSnapshots: st.changes,
      age: ago(now - st.newestTakenAt),
      ageMs: Math.max(0, now - st.newestTakenAt),
    };
  }

  /** The pack's rules (the appraisal's data), when the pack is attached to the project. */
  rules(projectId: string): PackRules {
    const pack = this.d.packs.get(PACK_ID);
    if (!pack || !this.d.packs.attachment(PACK_ID, projectId))
      throw new AppraisalError(
        'PACK_NOT_ATTACHED',
        'The Arkona pack is not attached to this project, so its appraisal tools do not apply here.',
      );
    return pack.rules;
  }

  private packSource(): ReportSource['pack'] {
    const pack = this.d.packs.get(PACK_ID);
    if (!pack) return undefined;
    return { version: pack.version, approvedVersion: pack.approved?.version ?? null };
  }

  /** The overlay's reader for one request (or the refusal when there is no snapshot yet). */
  async reader(projectId: string): Promise<{ reader: PageReader; state: IndexState }> {
    const e = await this.ensureIndex(projectId);
    if (!e.state)
      throw new AppraisalError(
        'NO_SNAPSHOT',
        'There is no complete full snapshot yet, so there is nothing to appraise (the first nightly snapshot makes one).',
      );
    const settings = this.d.projectSettings(projectId);
    const ts = treeSettingsFrom(settings);
    const reader = new PageReader({
      pages: this.index.pages(projectId),
      piece: (sha) => this.d.snapshots.store.getJson(sha),
      propertiesName: ts.propertiesName,
      labels: labelContext(e.state.rootId, lifecycleFrom(settings)),
    });
    return { reader, state: e.state };
  }

  // ============================================================================================ findings and reports

  private toFinding(
    projectId: string,
    tool: AppraisalTool,
    reader: PageReader,
    d: Draft,
    now: number,
  ): AppraisalFinding {
    const info = CHECKS[d.check] as (typeof CHECKS)[keyof typeof CHECKS] & {
      fix?: string;
      judgement?: { tool: string; decide: string };
      none?: string;
    };
    const id = findingId(projectId, tool, d);
    const page = d.pageId ? reader.page(d.pageId) : null;
    let followUp: FollowUp;
    let fix: AppraisalFinding['fix'];
    if (d.auditFix) {
      followUp = {
        kind: 'fix',
        tool: 'arkona_appraisal_fix',
        args: { findingId: id },
        change: `the audit’s own “Propose a fix”: ${d.auditFix.summary}`,
        via: 'audit',
      };
      fix = { kind: 'audit', args: { auditFindingId: d.auditFix.findingId } };
    } else if (info.fix && info.fix !== 'audit' && d.fixArgs) {
      followUp = {
        kind: 'fix',
        tool: 'arkona_appraisal_fix',
        args: { findingId: id },
        change: FIX_CHANGE[info.fix as keyof typeof FIX_CHANGE],
      };
      fix = { kind: info.fix as Exclude<keyof typeof FIX_CHANGE, 'audit'>, args: d.fixArgs };
    } else if (d.judgement ?? info.judgement) {
      const j = (d.judgement ?? info.judgement)!;
      followUp = { kind: 'judgement', tool: j.tool, decide: j.decide };
    } else if (info.fix === 'audit') {
      followUp = {
        kind: 'judgement',
        tool: d.check === 'sibling_order' ? 'move_resource' : 'update_resource',
        decide: 'the audit offers no exact repair for this one: where it belongs is the owner’s call',
      };
    } else followUp = { kind: 'none', reason: d.noFix ?? info.none ?? 'report only' };
    const source =
      d.source ??
      (page
        ? page.sourceSnapshotId === 'live'
          ? { kind: 'live' as const, takenAt: page.sourceTakenAt, ageMs: 0 }
          : {
              kind: 'snapshot' as const,
              snapshotId: page.sourceSnapshotId,
              takenAt: page.sourceTakenAt,
              ageMs: Math.max(0, now - page.sourceTakenAt),
            }
        : { kind: 'bridge' as const, takenAt: now, ageMs: 0 });
    const labels = page ? reader.labels(page.id) : null;
    return {
      id,
      tool,
      check: d.check,
      group: d.group ?? info.group,
      evidence: d.evidence ?? info.evidence,
      rule: d.rule ?? info.rule,
      page: page ? { id: page.id, name: page.rawName, path: reader.pathText(page.id) } : null,
      ...(d.documentId !== undefined ? { documentId: d.documentId } : {}),
      ...(d.blockId !== undefined ? { blockId: d.blockId } : {}),
      message: d.message,
      details: d.details,
      followUp,
      ...(fix ? { fix } : {}),
      source,
      ...(labels ? { labels: { lifecycle: labels.lifecycle, branch: labels.branch } } : {}),
    };
  }

  private report(
    projectId: string,
    tool: AppraisalTool,
    o: {
      readonly reader: PageReader;
      readonly state: IndexState | null;
      readonly drafts: readonly Draft[];
      readonly scope: Readonly<Record<string, unknown>>;
      readonly inspected: Readonly<Record<string, unknown>>;
      readonly couldNotCheck: readonly string[];
      readonly extraSource?: Partial<ReportSource>;
      readonly actor: string;
      readonly startedAt: number;
    },
  ): AppraisalReport {
    const now = this.d.now();
    const seen = new Set<string>();
    const findings: AppraisalFinding[] = [];
    for (const d of o.drafts) {
      const f = this.toFinding(projectId, tool, o.reader, d, now);
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      findings.push(f);
    }
    const order = TOOL_GROUPS[tool];
    findings.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
    const counts: Record<string, number> = { total: findings.length };
    for (const g of order) counts[g] = findings.filter((f) => f.group === g).length;
    counts.fixable = findings.filter((f) => f.followUp.kind === 'fix').length;
    const report: AppraisalReport = {
      tool,
      runId: newRunId(),
      scope: o.scope,
      createdAt: iso(now),
      source: (() => {
        const pack = this.packSource();
        return { index: this.freshness(projectId, o.state), ...(pack ? { pack } : {}), ...o.extraSource };
      })(),
      inspected: o.inspected,
      couldNotCheck: [...(o.state?.notes ?? []), ...o.couldNotCheck],
      counts,
      findings,
    };
    return this.store.save(projectId, {
      report,
      scopeKey: scopeKeyOf(o.scope),
      actor: o.actor,
      startedAt: o.startedAt,
    });
  }

  /** The pages a scope covers (a branch and everything leave the non-current areas out unless asked for). */
  private pagesOf(reader: PageReader, s: ScopeInput): { ids: string[]; left: number } {
    const include = new Set(s.include ?? []);
    if (s.pageId) return { ids: [s.pageId], left: 0 };
    const candidates = s.underId
      ? [...(reader.page(s.underId) ? [reader.page(s.underId)!] : []), ...reader.descendants(s.underId)]
      : reader.all().filter((p) => p.kind !== 'root');
    let left = 0;
    const ids: string[] = [];
    for (const p of candidates) {
      const l = reader.labels(p.id);
      const archived = l.lifecycle === 'Archived' && !include.has('archived');
      if (!inScope(l, include) || archived) {
        left++;
        continue;
      }
      ids.push(p.id);
    }
    return { ids: ids.slice(0, MAX_PAGES), left: left + Math.max(0, ids.length - MAX_PAGES) };
  }

  // ============================================================================================ A2

  async appraiseOwner(o: {
    readonly projectId: string;
    readonly actor: string;
    readonly scope: ScopeInput;
    readonly live?: LiveRead;
  }): Promise<AppraisalReport> {
    const startedAt = this.d.now();
    const rules = this.rules(o.projectId);
    const { reader, state } = await this.reader(o.projectId);
    const settings = this.d.projectSettings(o.projectId);
    const ts = treeSettingsFrom(settings);
    const lc = lifecycleFrom(settings);
    const { ids, left } = this.pagesOf(reader, o.scope);
    const couldNotCheck: string[] = [];
    let reads = 0;
    if (o.live) {
      if (ids.length > MAX_LIVE_PAGES)
        throw new AppraisalError(
          'LIVE_TOO_MANY',
          `live: true re-reads every page appraised (2 reads each); this scope has ${ids.length} pages, more than ${MAX_LIVE_PAGES}. Appraise a smaller branch live, or leave live out (free, from the snapshots).`,
          { pages: ids.length, limit: MAX_LIVE_PAGES },
        );
      for (const id of ids) reads += (await reader.readLive(id, o.live, this.d.now())).reads;
    }
    // The audits' open findings, gathered once (reused, never re-checked).
    const auditRows = this.d.audits.store.list(o.projectId, { state: 'open', limit: 100_000 });
    const byPage = new Map<string, typeof auditRows.findings>();
    for (const f of auditRows.findings) {
      if (!f.pageId) continue;
      const l = byPage.get(f.pageId) ?? [];
      l.push(f);
      byPage.set(f.pageId, l);
    }
    const attachment = this.d.packs.attachment(PACK_ID, o.projectId);
    const templates = new Map(this.index.templates(o.projectId).map((t) => [t.id, t]));
    const tplRows = new Map<string, readonly string[] | null>();
    const ctx = {
      projectId: o.projectId,
      reader,
      rules,
      propertiesName: ts.propertiesName,
      indexScopeRow: ts.indexScopeRow,
      referenceTypeRow: ts.referenceTypeRow,
      lifecycleIndexIds: new Set([lc.workingIndexId, lc.archiveIndexId].filter((x): x is string => !!x)),
      auditFindings: (pageId: string) => byPage.get(pageId) ?? [],
      templateFor: async (role: string, pageId: string) => {
        let recorded: string | null;
        try {
          recorded = this.d.tree.queries.node(o.projectId, pageId).data?.templateId ?? null;
        } catch {
          recorded = null;
        }
        const id = recorded ?? attachment?.templates[role] ?? null;
        if (!id) return null;
        const t = templates.get(id);
        if (!t || !t.sidebarSha)
          return {
            unavailable: `the snapshot holds no template ${id} (${role}); the next full snapshot takes the templates`,
          };
        let keys = tplRows.get(id);
        if (keys === undefined) {
          const piece = await this.d.snapshots.store.getJson(t.sidebarSha);
          keys =
            piece === null
              ? null
              : (extractSidebar(piece, ts.propertiesName)
                  .properties.find(
                    (p) => p.kind === 'keyValue' && textKey(p.title ?? '') === textKey(ts.propertiesName),
                  )
                  ?.rows?.map((r) => r.key) ?? []);
          tplRows.set(id, keys);
        }
        if (keys === null)
          return { unavailable: `the template ${t.name}’s sidebar could not be read from the store` };
        return { id, name: t.name, keys };
      },
    };
    const drafts: Draft[] = [];
    for (const id of ids) drafts.push(...(await appraisePage(ctx, id)));
    const latest = this.d.audits.store.latestRun(o.projectId);
    if (!latest)
      couldNotCheck.push(
        'No audit has run yet, so sibling order and the tag grammar (the audits’ checks) were not gathered.',
      );
    else if (latest.snapshotId && latest.snapshotId !== state.baseSnapshotId)
      couldNotCheck.push(
        `The audit findings are from the run of ${latest.finishedAt ? iso(latest.finishedAt) : 'an earlier time'} (snapshot ${latest.snapshotId}), not the overlay’s base snapshot ${state.baseSnapshotId}.`,
      );
    if (this.index.templates(o.projectId).length === 0)
      couldNotCheck.push('The base full snapshot holds no templates, so template fields were not compared.');
    if (left > 0)
      couldNotCheck.push(
        `${left} page(s) in non-current areas (Legacy Canon Archive, Design References, Archived) were left out; include: ["legacy", "design", "archived"] brings them in.`,
      );
    const scope = {
      ...(o.scope.pageId ? { page: o.scope.pageId } : {}),
      ...(o.scope.underId ? { under: o.scope.underId } : {}),
      ...(o.scope.all ? { all: true } : {}),
      ...(o.scope.include?.length ? { include: [...o.scope.include].sort() } : {}),
      ...(o.live ? { live: true } : {}),
    };
    return this.report(o.projectId, 'arkona_appraise_owner', {
      reader,
      state,
      drafts,
      scope,
      inspected: { pages: ids.length, ...(left ? { leftOut: left } : {}) },
      couldNotCheck,
      extraSource: {
        audit: {
          runAt: latest?.finishedAt ? iso(latest.finishedAt) : null,
          snapshotId: latest?.snapshotId ?? null,
        },
        ...(o.live ? { live: { reads, at: iso(this.d.now()) } } : {}),
      },
      actor: o.actor,
      startedAt,
    });
  }

  // ============================================================================================ A3

  async changeImpact(o: {
    readonly projectId: string;
    readonly actor: string;
    readonly pageId?: string;
    readonly renameTo?: string;
    readonly proposalId?: string;
    readonly live?: LiveRead;
  }): Promise<AppraisalReport> {
    const startedAt = this.d.now();
    const rules = this.rules(o.projectId);
    const { reader, state } = await this.reader(o.projectId);
    let effects: PlannedEffect[];
    const couldNotCheck: string[] = [];
    if (o.proposalId) {
      const p = this.d.proposals.get(o.proposalId);
      if (!p || p.projectId !== o.projectId)
        throw new AppraisalError('PROPOSAL_NOT_FOUND', `No proposal ${o.proposalId} in this project.`);
      if (p.state !== 'pending' && p.state !== 'conflicted' && p.state !== 'approved')
        throw new AppraisalError(
          'PROPOSAL_NOT_PENDING',
          `Proposal ${o.proposalId} is ${p.state}; only a pending one is analysed (what it did is in its job).`,
        );
      const detail = this.d.proposals.detail(o.proposalId);
      effects = effectsOfProposal((detail?.ops ?? []).map((x) => ({ op: x.op, params: x.params })));
      if (effects.length === 0) couldNotCheck.push('The proposal names no page.');
    } else if (o.pageId) effects = [{ pageId: o.pageId, ...(o.renameTo ? { renameTo: o.renameTo } : {}) }];
    else
      throw new AppraisalError(
        'INVALID_INPUT',
        'Name a page (with renameTo for a planned rename) or a proposal.',
      );
    let reads = 0;
    let liveName: string | undefined;
    let liveAliases: string[] | undefined;
    if (o.live && o.pageId) {
      // The name and aliases are the resource's: one read (the body stays the snapshot's).
      const r = await reader.readLive(o.pageId, o.live, this.d.now(), { body: false });
      reads += r.reads;
      if (r.page) {
        liveName = r.page.page.rawName;
        const a = r.page.resource?.aliases;
        liveAliases = Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
      }
    }
    const drafts: Draft[] = [];
    for (const e of effects) {
      if (!reader.page(e.pageId) && !e.deleted)
        couldNotCheck.push(
          `${e.pageId} is not in the snapshots (made since the last one?): only links the snapshots hold to it were found.`,
        );
      drafts.push(
        ...(await impactOf(
          {
            db: this.d.db,
            projectId: o.projectId,
            reader,
            fullText: this.fullText,
            dependenciesTitle: rules.sidebar.dependencies,
            relatedTitle: rules.sidebar.related,
            chronologyDocuments: new Set(this.d.chronologyDocuments(o.projectId)),
            ...(liveName && e.pageId === o.pageId ? { currentName: liveName } : {}),
            ...(liveAliases && e.pageId === o.pageId ? { currentAliases: liveAliases } : {}),
          },
          e,
        )),
      );
    }
    if (this.d.chronologyDocuments(o.projectId).length === 0)
      couldNotCheck.push(
        'The chronology is not confirmed for this project, so no row is told apart as a chronology row.',
      );
    const scope = {
      ...(o.pageId ? { page: o.pageId } : {}),
      ...(o.renameTo ? { renameTo: o.renameTo } : {}),
      ...(o.proposalId ? { proposal: o.proposalId } : {}),
      ...(o.live ? { live: true } : {}),
    };
    return this.report(o.projectId, 'arkona_change_impact', {
      reader,
      state,
      drafts,
      scope,
      inspected: {
        subjects: effects.map((e) => ({
          id: e.pageId,
          name: reader.page(e.pageId)?.rawName ?? null,
          ...(e.renameTo ? { renameTo: e.renameTo } : {}),
          ...(e.deleted ? { deleted: true } : {}),
          ...(e.becomes ? { becomes: e.becomes } : {}),
        })),
      },
      couldNotCheck,
      ...(o.live ? { extraSource: { live: { reads, at: iso(this.d.now()) } } } : {}),
      actor: o.actor,
      startedAt,
    });
  }

  // ============================================================================================ A4

  async workingDigest(o: {
    readonly projectId: string;
    readonly actor: string;
    readonly sinceMs?: number | null;
  }): Promise<AppraisalReport> {
    const startedAt = this.d.now();
    const rules = this.rules(o.projectId);
    const { reader, state } = await this.reader(o.projectId);
    const settings = this.d.projectSettings(o.projectId);
    const ts = treeSettingsFrom(settings);
    const lc = lifecycleFrom(settings);
    const now = this.d.now();
    const t = rules.types.find((x) => x.hook === 'character');
    const packTools = new Set<string>([
      'arkona_create_character',
      'arkona_create_owner',
      'arkona_create_relationship',
      'arkona_add_character_art',
      ...rules.types.map((x) => `arkona_${x.tool}`),
    ]);
    const since = o.sinceMs != null ? now - o.sinceMs : null;
    const r = await workingDigest({
      projectId: o.projectId,
      reader,
      index: this.d.snapshots.index,
      proposals: this.d.proposals,
      packTools,
      unresolvedHeading: t?.text.unresolved ?? rules.owners?.text.unresolved ?? 'Unresolved Material',
      statusRow: lc.fields.status,
      scopeRow: ts.scopeRow,
      lmrRow: lc.fields.lastMajorRevision,
      now,
      since,
    });
    return this.report(o.projectId, 'arkona_working_digest', {
      reader,
      state,
      drafts: r.drafts,
      scope: o.sinceMs != null ? { sinceMs: o.sinceMs } : {},
      inspected: r.inspected,
      couldNotCheck: [],
      actor: o.actor,
      startedAt,
    });
  }

  // ============================================================================================ A5

  async visualHygiene(o: {
    readonly projectId: string;
    readonly actor: string;
    readonly scope: ScopeInput;
  }): Promise<AppraisalReport> {
    const startedAt = this.d.now();
    const rules = this.rules(o.projectId);
    const { reader, state } = await this.reader(o.projectId);
    const ts = treeSettingsFrom(this.d.projectSettings(o.projectId));
    const scoped =
      o.scope.all || (!o.scope.pageId && !o.scope.underId)
        ? null
        : new Set(this.pagesOf(reader, o.scope).ids);
    await this.loadLibrary(o.projectId);
    const assets = this.libraryAssets(o.projectId, state);
    const images = (
      this.d.db
        .prepare(
          `SELECT page_id, document_id, block_id, kind, url, url_path, label, interpretation, section
           FROM appraisal_images WHERE project_id = ?`,
        )
        .all(o.projectId) as Obj[]
    ).map((r): ShownImage => ({
      pageId: String(r.page_id),
      documentId: (r.document_id as string | null) ?? null,
      blockId: (r.block_id as string | null) ?? null,
      kind: r.kind === 'block' ? 'block' : 'other',
      url: String(r.url),
      urlPath: String(r.url_path),
      label: (r.label as string | null) ?? null,
      interpretation: Number(r.interpretation) === 1,
      section: (r.section as string | null) ?? null,
    }));
    const formats = new Map<string, string | null>();
    const r = await visualHygiene({
      projectId: o.projectId,
      reader,
      rules,
      assets,
      images,
      assetHosts: this.d.assetHosts,
      characterFolder: (subject, race) => this.d.characterFolder(o.projectId, subject, race),
      formatOf: async (sha) => {
        if (formats.has(sha)) return formats.get(sha)!;
        const head = await headOf(this.d.snapshots.store.objectPath(sha));
        const f = head ? sniff(head) : null;
        formats.set(sha, f);
        return f;
      },
      referenceTypeRow: ts.referenceTypeRow,
      pageIds: scoped,
    });
    const tree = this.d.assets.queries.status(o.projectId);
    const couldNotCheck: string[] = [];
    if (tree.status !== 'ready' && tree.status !== 'stale')
      couldNotCheck.push(`The asset tree is ${tree.status}, so the library could not be checked.`);
    if (scoped) couldNotCheck.push('Orphan candidates are only looked for in a whole-library run.');
    return this.report(o.projectId, 'arkona_visual_hygiene', {
      reader,
      state,
      drafts: r.drafts,
      scope: {
        ...(o.scope.pageId ? { page: o.scope.pageId } : {}),
        ...(o.scope.underId ? { under: o.scope.underId } : {}),
        ...(scoped === null ? { all: true } : {}),
      },
      inspected: r.inspected,
      couldNotCheck,
      extraSource: {
        assetTree: { status: tree.status, confirmedAt: tree.confirmedAt ? iso(tree.confirmedAt) : null },
      },
      actor: o.actor,
      startedAt,
    });
  }

  /** The library as the asset tree holds it, with each asset's stored bytes from the snapshot library. */
  private libraryAssets(projectId: string, state: IndexState): LibraryAsset[] {
    const db = this.d.db;
    const folders = new Map(
      (
        db.prepare('SELECT id, path_names FROM asset_folders WHERE project_id = ?').all(projectId) as {
          id: string;
          path_names: string;
        }[]
      ).map((f) => {
        let path: string[];
        try {
          const v = JSON.parse(f.path_names) as unknown;
          path = Array.isArray(v) ? v.map(String) : [];
        } catch {
          path = [];
        }
        return [f.id, path] as [string, string[]];
      }),
    );
    // The library piece's hashes (the snapshot store holds the bytes): one read of the piece, from the store.
    const shaById = new Map<string, string | null>();
    const lib = state.librarySha ? this.libraryCache.get(state.librarySha) : undefined;
    if (lib) for (const [k, v] of lib) shaById.set(k, v);
    const rows = db
      .prepare(
        'SELECT id, name, folder_id, type, url, is_hidden, sha256 FROM asset_items WHERE project_id = ?',
      )
      .all(projectId) as Obj[];
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      type: String(r.type),
      folderId: (r.folder_id as string | null) ?? null,
      path: typeof r.folder_id === 'string' ? (folders.get(r.folder_id) ?? []) : [],
      url: (r.url as string | null) ?? null,
      hidden: Number(r.is_hidden) === 1,
      sha256: shaById.get(String(r.id)) ?? ((r.sha256 as string | null) || null),
    }));
  }

  private readonly libraryCache = new Map<string, Map<string, string | null>>();

  /** Loads the snapshot library's asset hashes into the cache (called before A5 reads them). */
  async loadLibrary(projectId: string): Promise<void> {
    const st = this.index.state(projectId);
    if (!st?.librarySha || this.libraryCache.has(st.librarySha)) return;
    const piece = await this.d.snapshots.store.getJson<{ assets?: Obj[] }>(st.librarySha);
    const m = new Map<string, string | null>();
    for (const a of piece?.assets ?? [])
      if (typeof a.id === 'string') m.set(a.id, typeof a.sha256 === 'string' ? a.sha256 : null);
    this.libraryCache.set(st.librarySha, m);
  }

  // ============================================================================================ F: propose a fix

  finding(projectId: string, id: string): AppraisalFinding {
    const hit = this.store.finding(projectId, id);
    if (!hit)
      throw new AppraisalError(
        'FINDING_NOT_FOUND',
        `No appraisal finding ${id} in this project’s stored runs (run the appraisal again: ids are kept with the latest run of each scope).`,
      );
    return hit.finding;
  }

  /**
   * "Propose a fix": the finding's target re-read live (one read), the finding checked, then ONE ordinary proposal,
   * whatever the caller's scope. The audits' own fixes (sibling order, tags) are handed over to them. Audited.
   */
  async proposeFix(o: {
    readonly projectId: string;
    readonly findingId: string;
    readonly actor: string;
    readonly origin: JobOrigin;
    readonly read: LiveRead;
  }): Promise<FixResult> {
    const f = this.finding(o.projectId, o.findingId);
    if (f.followUp.kind !== 'fix' || !f.fix)
      throw new AppraisalError(
        'NO_FIX',
        f.followUp.kind === 'judgement'
          ? `This finding has no single right repair, so there is no “Propose a fix”: ${f.followUp.decide} (${f.followUp.tool}).`
          : 'This finding is reported only; there is nothing to propose.',
      );
    let r: FixResult;
    if (f.fix.kind === 'audit') {
      const auditId = Number(f.fix.args.auditFindingId);
      const a = await this.d.audits.proposeFix(o.actor, o.projectId, auditId, { origin: o.origin });
      r =
        a.status === 'proposal_captured'
          ? {
              status: 'proposal_captured',
              proposalId: a.proposalId,
              summary: a.summary,
              fix: `audit:${a.fix}`,
              reads: 1,
            }
          : { status: 'nothing_to_do', message: a.message, reads: 1 };
    } else {
      const settings = this.d.projectSettings(o.projectId);
      r = await proposeAppraisalFix(
        {
          projectId: o.projectId,
          read: o.read,
          submit: (req) => this.d.engine.submit(req as never) as unknown as Promise<Record<string, unknown>>,
          origin: o.origin,
          node: (id) => {
            try {
              return this.d.tree.queries.node(o.projectId, id).data;
            } catch {
              return null;
            }
          },
          children: (pid) => {
            try {
              return this.d.tree.queries.children(o.projectId, pid).data;
            } catch {
              return [];
            }
          },
          assetsIn: (folderId) =>
            (folderId === null
              ? this.d.db
                  .prepare('SELECT id, name FROM asset_items WHERE project_id = ? AND folder_id IS NULL')
                  .all(o.projectId)
              : this.d.db
                  .prepare('SELECT id, name FROM asset_items WHERE project_id = ? AND folder_id = ?')
                  .all(o.projectId, folderId)) as { id: string; name: string }[],
          propertiesName: treeSettingsFrom(settings).propertiesName,
        },
        f,
      );
    }
    this.d.audit(o.actor, 'appraisal.propose_fix', o.projectId, null, {
      finding: f.id,
      check: f.check,
      page: f.page?.name ?? null,
      fix: f.fix.kind,
      result: r.status,
      ...(r.status === 'proposal_captured' ? { proposalId: r.proposalId } : {}),
    });
    return r;
  }
}

export type { FixResult };
