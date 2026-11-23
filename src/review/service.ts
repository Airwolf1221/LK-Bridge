/**
 * The review of direct writes (v3 F3.4, ADR 0055 decision A). At scope `write` an agent's ordinary changes run without
 * the owner seeing them first, so the bridge keeps a queue of them to look at afterwards: every job an agent ran
 * directly (newest first), with the agent, the tool, the summary its proposal would have shown and the pages it
 * touched, each expandable to its diff. The owner marks items reviewed (one, or all of a filtered set) or reverts one
 * (src/review/revert.ts). Approved proposals and the bridge's own work are never listed.
 *
 * Recording: a listener on the engine's job events records a job when it is created by an agent principal without an
 * approval and holds a write step. Nothing here reads LegendKeeper.
 */
import { createHash } from 'node:crypto';
import type { Db } from '../db/open.js';
import type { ChronologyStore } from '../chronology/store.js';
import type { JobEngine } from '../jobs/engine.js';
import { SYSTEM_PRINCIPAL, TERMINAL_JOB_STATUSES, type JobView } from '../jobs/types.js';
import { DEFAULT_STAGING_FOLDER, type ImageService } from '../images/service.js';
import { isBridgeStep, londonDate, LMR_STEP } from '../jobs/internal-steps.js';
import { proposalSummary } from '../policy/proposals.js';
import { isStagingName, REVERT_TOOL } from './revert-plan.js';
import type { PolicyStore } from '../policy/store.js';
import { changeView, type ChangeView } from './changes.js';
import { ReviewStore, type DirectWriteRow, type ReviewFilter } from './store.js';
import { jobTargets, type JobRecord, type LaterWrite, type Target } from './targets.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The most items "Mark all reviewed" marks in one go. */
export const MARK_ALL_LIMIT = 1000;

/**
 * CR-2026-11-R2 (R2-09): a fingerprint of the exact set "Mark all reviewed" would mark (the ids, newest first). The list
 * answers it and the request echoes it, so a set that changed under the same count (one item reviewed elsewhere, a new
 * one arrived) is refused rather than marking an item the owner never saw.
 */
export function markAllFingerprint(ids: readonly string[]): string {
  return createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 32);
}

export interface ReviewDeps {
  readonly db: Db;
  readonly engine: Pick<JobEngine, 'events' | 'queries' | 'stepRecords'>;
  readonly policy: Pick<PolicyStore, 'audit' | 'describePrincipals'>;
  readonly now: () => number;
  readonly pageName?: (projectId: string, id: string) => string | null;
  readonly documentName?: (projectId: string, resourceId: string, documentId: string) => string | null;
  readonly folderName?: (projectId: string, id: string | null) => string | null;
  readonly chronology?: Pick<ChronologyStore, 'byJob'>;
  /**
   * v3 F3.4 (ADR 0055 decision B5): the staged images' records and the staging folder's name, to tell the placement of
   * a staged image from an ordinary asset move.
   */
  readonly images?: Pick<ImageService, 'store' | 'stagingFolderName'>;
  readonly log?: { warn(o: unknown, m: string): void };
}

export interface RevertSummary {
  readonly id: number;
  readonly revertJobId: string;
  readonly state: 'submitted' | 'succeeded' | 'failed' | 'cancelled';
  readonly partial: boolean;
  readonly createdAt: number;
  readonly finishedAt: number | null;
}

export interface ReviewItem {
  readonly jobId: string;
  readonly projectId: string;
  readonly createdAt: number;
  readonly finishedAt: number | null;
  /** The job's own status (a failed job may have written part of its work). */
  readonly status: JobView['status'];
  readonly agent: { readonly principalId: string; readonly name: string; readonly profile: string };
  readonly tool: string | null;
  /**
   * In the words a proposal would have used: the tool's own summary; for a low-level job (`lk_api_*`, `lk_op_*`) the
   * bridge's description of its operations (CR-2026-11-R2, E1), never the title the agent chose; else the job's title.
   */
  readonly summary: string;
  /** CR-2026-11-R2 (R2-06): the title the agent gave a low-level job, shown only as a secondary label. */
  readonly agentTitle?: string;
  readonly pages: readonly { readonly id: string; readonly name: string | null }[];
  readonly reviewed: { readonly at: number; readonly by: string; readonly via: string } | null;
  readonly revert: RevertSummary | null;
}

export interface ReviewDetail extends ReviewItem {
  /** What the job changed, page by page (the pages it touched, then changes with no page, such as an image). */
  readonly pageChanges: readonly {
    readonly page: { readonly id: string; readonly name: string | null } | null;
    readonly changes: readonly ChangeView[];
  }[];
  /** Whether the job is a revert itself (a revert is never reverted) or still running. */
  readonly revertable: { readonly ok: boolean; readonly reason: string | null };
}

/**
 * CR-2026-11-R2 (R2-06): what the Review page says a job did: the tool's own summary; for a low-level job the bridge's
 * description of its operations, with the agent's title only beside it; else the job's title.
 */
function summaryOf(
  note: Obj,
  tool: string | null,
  title: string,
  ops: () => string | null,
): { summary: string; agentTitle?: string } {
  if (typeof note.summary === 'string' && note.summary !== '') return { summary: note.summary };
  if (tool !== null && /^lk_(api|op)_/.test(tool)) {
    const said = ops();
    if (said) return { summary: said, ...(title ? { agentTitle: title } : {}) };
  }
  return { summary: title };
}

/** The tool a job was made by (its origin's), for an agent's job. */
function toolOf(job: JobView): string | null {
  return typeof job.origin.tool === 'string' ? job.origin.tool : null;
}

export class ReviewService {
  readonly store: ReviewStore;
  private off: (() => void) | undefined;

  constructor(private readonly d: ReviewDeps) {
    this.store = new ReviewStore(d.db, d.now);
  }

  /** Records direct-write jobs as the engine creates them. Returns a detach. */
  attach(): () => void {
    const handler = (e: { type: string; job: JobView }) => {
      if (e.type !== 'created') return;
      try {
        this.consider(e.job);
      } catch (err) {
        this.d.log?.warn({ err, jobId: e.job.id }, 'a direct write could not be recorded for review');
      }
    };
    this.off = this.d.engine.events.on('job', handler);
    return () => this.detach();
  }

  detach(): void {
    this.off?.();
    this.off = undefined;
  }

  /** Records the job when an agent runs it directly (no approval) and it writes. */
  consider(job: JobView): boolean {
    if (job.principalId === SYSTEM_PRINCIPAL.principalId || job.approvedBy !== null) return false;
    if (job.origin.approval !== undefined || job.kind === 'paginate_all') return false;
    const full = this.d.engine.queries.getJob(job.projectId, job.id);
    if (!full?.steps.some((s) => s.opKind !== 'read')) return false;
    this.store.record({
      jobId: job.id,
      projectId: job.projectId,
      principalId: job.principalId,
      profile: job.profile,
      tool: toolOf(job),
      createdAt: job.createdAt,
    });
    return true;
  }

  // ---------------------------------------------------------------------------------------------- reading

  /** Everything the bridge holds about a job (steps in full, journal entries with pre-images, its chronology record). */
  record(projectId: string, jobId: string): JobRecord | null {
    const job = this.d.engine.queries.getJob(projectId, jobId);
    const steps = this.d.engine.stepRecords(projectId, jobId);
    if (!job || !steps) return null;
    const journal = this.d.engine.queries
      .journalLookup(projectId, { jobId, includePreImage: true, limit: 1000 })
      .slice()
      .reverse();
    let chronology: ReturnType<NonNullable<ReviewDeps['chronology']>['byJob']> | null;
    try {
      chronology = this.d.chronology?.byJob(projectId, jobId) ?? null;
    } catch {
      chronology = null;
    }
    return { job, steps, journal, chronology };
  }

  /** `o.placeAsLeft`: R3-57 (ADR 0061 part B decision 5), a retag batch's pages keep their name and parent too. */
  targets(projectId: string, jobId: string, o: { readonly placeAsLeft?: boolean } = {}): Target[] | null {
    const rec = this.record(projectId, jobId);
    if (!rec) return null;
    const images = this.d.images;
    const stagingNames = () =>
      images ? [images.stagingFolderName(projectId), DEFAULT_STAGING_FOLDER] : [DEFAULT_STAGING_FOLDER];
    return jobTargets(rec, {
      pageName: (id) => this.d.pageName?.(projectId, id) ?? null,
      documentName: (r, doc) => this.d.documentName?.(projectId, r, doc) ?? null,
      // CR-2026-11-R2 (R2-22): the staging folder by every name it can have; the folder itself is read live by Revert.
      stagingNames,
      ...(images
        ? {
            placedStaged: (assetId: string) => {
              const row = images.store.byAsset(projectId, assetId);
              return row && row.placementJobId === jobId ? row.id : null;
            },
            isStagingFolder: (folderId: string | null) => {
              if (folderId === null) return false;
              const name = this.d.folderName?.(projectId, folderId);
              return typeof name === 'string' && isStagingName(name, stagingNames());
            },
          }
        : {}),
      laterLmr: (resourceId, date) => this.laterLmr(projectId, rec.job, resourceId, date),
      laterWrites: () => this.laterWrites(projectId, jobId),
      ...(o.placeAsLeft === true ? { placeAsLeft: true } : {}),
    });
  }

  /**
   * CR-2026-11-R2 (R2-18): a later job that relied on a Last Major Revision date this job set on a page: one whose own
   * decision that day was a major revision of the page (it set the date, or found it already said so), or one that wrote
   * the page's text that day. Reverts are left out (they set no date of their own).
   */
  private laterLmr(projectId: string, job: JobView, resourceId: string, date: string): string | null {
    const isRevert = (id: string) => this.d.engine.queries.getJob(projectId, id)?.origin.tool === REVERT_TOOL;
    const lmrJobs = this.d.db
      .prepare(
        `SELECT DISTINCT s.job_id AS id FROM steps s JOIN jobs j ON j.id = s.job_id
         WHERE j.project_id = ? AND s.op_id = ? AND s.status = 'succeeded' AND s.job_id != ? AND j.created_at >= ?`,
      )
      .all(projectId, LMR_STEP, job.id, job.createdAt) as { id: string }[];
    for (const { id } of lmrJobs) {
      if (isRevert(id)) continue;
      for (const st of this.d.engine.stepRecords(projectId, id) ?? []) {
        if (st.opId !== LMR_STEP || !isObj(st.result)) continue;
        const body = isObj(st.params.body) ? st.params.body : {};
        if (body.resourceId !== resourceId || st.result.date !== date) continue;
        const skip = typeof st.result.skip === 'string' ? st.result.skip : '';
        if (isObj(st.result.lmr) || /already says/.test(skip)) return id;
      }
    }
    const last = this.lastJournalId(projectId, job.id);
    const texts = this.d.db
      .prepare(
        `SELECT job_id AS id, at FROM write_journal
         WHERE project_id = ? AND resource_id = ? AND id > ? AND job_id IS NOT NULL AND job_id != ?
           AND outcome IN ('applied', 'unknown', 'superseded')
           AND op_id IN ('replaceDocumentBlocks', 'insertBlock', 'replaceBlock', 'updateBlock', 'deleteBlock', 'moveBlock')
         ORDER BY id`,
      )
      .all(projectId, resourceId, last, job.id) as { id: string; at: number }[];
    for (const r of texts) if (londonDate(r.at) === date && !isRevert(r.id)) return r.id;
    return null;
  }

  private lastJournalId(projectId: string, jobId: string): number {
    return (
      this.d.db
        .prepare('SELECT COALESCE(MAX(id), 0) AS n FROM write_journal WHERE project_id = ? AND job_id = ?')
        .get(projectId, jobId) as { n: number }
    ).n;
  }

  /**
   * CR-2026-11-R2 (R2-28): the applied (or possibly applied) journal entries of the jobs after this one, but reverts and
   * jobs fully reverted since (their writes no longer stand).
   */
  private laterWrites(projectId: string, jobId: string): LaterWrite[] {
    const rows = this.d.db
      .prepare(
        `SELECT job_id, op_id, target_id, resource_id, document_id, params FROM write_journal
         WHERE project_id = ? AND id > ? AND job_id IS NOT NULL AND job_id != ? AND outcome IN ('applied', 'unknown', 'superseded')
           AND job_id NOT IN (SELECT revert_job_id FROM job_reverts WHERE project_id = ?)
           AND job_id NOT IN (SELECT job_id FROM job_reverts WHERE project_id = ? AND state = 'succeeded' AND partial = 0)
         ORDER BY id LIMIT 5000`,
      )
      .all(projectId, this.lastJournalId(projectId, jobId), jobId, projectId, projectId) as {
      job_id: string;
      op_id: string;
      target_id: string | null;
      resource_id: string | null;
      document_id: string | null;
      params: string | null;
    }[];
    return rows.map((r) => {
      let params: unknown;
      try {
        params = r.params ? (JSON.parse(r.params) as unknown) : null;
      } catch {
        params = null;
      }
      return {
        jobId: r.job_id,
        opId: r.op_id,
        targetId: r.target_id,
        resourceId: r.resource_id,
        documentId: r.document_id,
        params,
      };
    });
  }

  /** CR-2026-11-R2 (R2-06): a low-level job's operations, in the words a proposal of them would use. */
  private opsSummary(projectId: string, jobId: string): string | null {
    const ops = (this.d.engine.stepRecords(projectId, jobId) ?? [])
      .filter((st) => st.opKind !== 'read' && !isBridgeStep(st.opId) && st.options.decisionFrom === undefined)
      .map((st) => ({ op: st.opId, params: st.params }));
    if (ops.length === 0) return null;
    return proposalSummary(ops).replace(/^Proposed /, '');
  }

  private latestRevert(projectId: string, jobId: string): RevertSummary | null {
    const r = this.d.db
      .prepare(
        `SELECT id, revert_job_id, state, partial, created_at, finished_at FROM job_reverts
         WHERE project_id = ? AND job_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(projectId, jobId) as
      | {
          id: number;
          revert_job_id: string;
          state: RevertSummary['state'];
          partial: number;
          created_at: number;
          finished_at: number | null;
        }
      | undefined;
    return r
      ? {
          id: r.id,
          revertJobId: r.revert_job_id,
          state: r.state,
          partial: r.partial === 1,
          createdAt: r.created_at,
          finishedAt: r.finished_at,
        }
      : null;
  }

  /** The pages a job's journal names (cheap: no target extraction), first seen first. */
  private journalPages(projectId: string, jobId: string): string[] {
    return (
      this.d.db
        .prepare(
          `SELECT resource_id AS id, MIN(id) AS first FROM write_journal
           WHERE job_id = ? AND project_id = ? AND resource_id IS NOT NULL AND outcome IN ('applied', 'unknown', 'superseded')
           GROUP BY resource_id ORDER BY first`,
        )
        .all(jobId, projectId) as { id: string }[]
    ).map((r) => r.id);
  }

  private item(row: DirectWriteRow, names: Map<string, { name: string }>): ReviewItem | null {
    const job = this.d.engine.queries.getJob(row.projectId, row.jobId);
    if (!job) return null;
    const note = isObj(this.optionsOf(row.projectId, row.jobId).review)
      ? (this.optionsOf(row.projectId, row.jobId).review as Obj)
      : {};
    const notePages = Array.isArray(note.pages) ? (note.pages as Obj[]) : [];
    const ids = [
      ...new Set([...notePages.map((p) => String(p.id)), ...this.journalPages(row.projectId, row.jobId)]),
    ].slice(0, 50);
    return {
      jobId: row.jobId,
      projectId: row.projectId,
      createdAt: row.createdAt,
      finishedAt: job.finishedAt,
      status: job.status,
      agent: {
        principalId: row.principalId,
        name: names.get(row.principalId)?.name ?? row.principalId,
        profile: row.profile,
      },
      tool: row.tool,
      ...summaryOf(note, row.tool, job.title, () => this.opsSummary(row.projectId, row.jobId)),
      pages: ids.map((id) => ({
        id,
        name:
          this.d.pageName?.(row.projectId, id) ??
          (notePages.find((p) => p.id === id)?.name as string | undefined) ??
          null,
      })),
      reviewed:
        row.reviewedAt !== null
          ? { at: row.reviewedAt, by: row.reviewedBy ?? 'owner', via: row.reviewedVia ?? 'review' }
          : null,
      revert: this.latestRevert(row.projectId, row.jobId),
    };
  }

  private optionsOf(projectId: string, jobId: string): Obj {
    const r = this.d.db
      .prepare('SELECT options FROM jobs WHERE id = ? AND project_id = ?')
      .get(jobId, projectId) as { options: string | null } | undefined;
    if (!r?.options) return {};
    try {
      const o = JSON.parse(r.options) as unknown;
      return isObj(o) ? o : {};
    } catch {
      return {};
    }
  }

  /** Newest first. */
  list(projectId: string, f: ReviewFilter = {}): ReviewItem[] {
    const rows = this.store.list(projectId, f);
    const names = this.d.policy.describePrincipals(rows.map((r) => r.principalId));
    return rows.map((r) => this.item(r, names)).filter((x): x is ReviewItem => x !== null);
  }

  /** The unreviewed count of a project (its badge), and of every project. */
  counts(projectId: string): { unreviewed: number; byProject: Map<string, number> } {
    return {
      unreviewed: this.store.count(projectId, { state: 'unreviewed' }),
      byProject: this.store.unreviewedByProject(),
    };
  }

  /** One item with what it changed, page by page. Null when the job is not a direct write of this project. */
  detail(projectId: string, jobId: string): ReviewDetail | null {
    const row = this.store.get(projectId, jobId);
    if (!row) return null;
    const names = this.d.policy.describePrincipals([row.principalId]);
    const item = this.item(row, names);
    if (!item) return null;
    const targets = this.targets(projectId, jobId) ?? [];
    const groups = new Map<
      string,
      { page: { id: string; name: string | null } | null; changes: ChangeView[] }
    >();
    const view = (t: Target) =>
      changeView(t, {
        pageName: (id) => this.d.pageName?.(projectId, id) ?? null,
        folderName: (id) => this.d.folderName?.(projectId, id) ?? null,
      });
    for (const t of targets) {
      const k = t.page?.id ?? '';
      const g = groups.get(k) ?? { page: t.page, changes: [] as ChangeView[] };
      g.changes.push(view(t));
      groups.set(k, g);
    }
    const pageChanges = [...groups.entries()]
      .sort(([a], [b]) => (a === '' ? 1 : 0) - (b === '' ? 1 : 0))
      .map(([, g]) => g);
    const job = this.d.engine.queries.getJob(projectId, jobId)!;
    const revertable = !TERMINAL_JOB_STATUSES.has(job.status)
      ? { ok: false, reason: 'the job is still running' }
      : { ok: true, reason: null };
    return { ...item, pageChanges, revertable };
  }

  // ---------------------------------------------------------------------------------------------- the owner

  /** Marks items reviewed. Audited `review.mark` per item. Returns those marked now (others were already). */
  markReviewed(actor: 'owner', projectId: string, jobIds: readonly string[]): string[] {
    if (actor !== 'owner') throw new Error('Only the owner reviews direct writes');
    const done = this.store.markReviewed(projectId, jobIds, 'owner', 'review');
    for (const id of done)
      this.d.policy.audit('owner', 'review.mark', id, { reviewed: false }, { reviewed: true });
    return done;
  }

  /**
   * "Mark all reviewed" for a filtered set (at most MARK_ALL_LIMIT, newest first). `expect` is the count the owner
   * confirmed: when more items arrived since, nothing is marked and the new count is returned. Audited once,
   * `review.mark_all`, with the filter and the ids.
   */
  markAll(
    actor: 'owner',
    projectId: string,
    filter: ReviewFilter,
    expect: number,
    fingerprint?: string,
  ): { marked: string[]; count: number; changed: boolean } {
    if (actor !== 'owner') throw new Error('Only the owner reviews direct writes');
    const ids = this.store.unreviewedIds(projectId, filter, MARK_ALL_LIMIT);
    if (ids.length !== expect || (fingerprint !== undefined && markAllFingerprint(ids) !== fingerprint))
      return { marked: [], count: ids.length, changed: true };
    const done = this.store.markReviewed(projectId, ids, 'owner', 'bulk');
    this.d.policy.audit(
      'owner',
      'review.mark_all',
      projectId,
      { filter, count: ids.length },
      { marked: done },
    );
    return { marked: done, count: ids.length, changed: false };
  }

  /** R2-09: the count and the fingerprint of the set "Mark all reviewed" would mark now, for a filter. */
  markAllSet(projectId: string, filter: ReviewFilter): { count: number; fingerprint: string } {
    const ids = this.store.unreviewedIds(projectId, filter, MARK_ALL_LIMIT);
    return { count: ids.length, fingerprint: markAllFingerprint(ids) };
  }

  /** Marks one item reviewed because the owner reverted it (bridge code: the revert service). */
  markReverted(projectId: string, jobId: string): void {
    this.store.markReviewed(projectId, [jobId], 'owner', 'revert');
  }
}
