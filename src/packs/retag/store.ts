/**
 * The retag's own records (v3 F3f, ADR 0060; migration 3700): audit runs and their page verdicts, the owner's
 * classifications and agents' suggestions, pack tools' page records, apply batches and named reconciliations. The
 * bridge's database only: nothing here reads LegendKeeper.
 */
import { randomBytes } from 'node:crypto';
import type { Db } from '../../db/open.js';
import type { Disposition, RetagPolicy, RetagVerdict } from './engine.js';

type Obj = Record<string, unknown>;
const json = <T>(s: string | null | undefined, d: T): T => {
  if (s === null || s === undefined) return d;
  try {
    return JSON.parse(s) as T;
  } catch {
    return d;
  }
};

export const newId = (prefix: 'rtg' | 'rtb' | 'rtr'): string => `${prefix}_${randomBytes(8).toString('hex')}`;

/** What became of one page of an apply batch. */
export type Outcome = 'applied' | 'already_compliant' | 'held' | 'conflicted' | 'inaccessible';
export const OUTCOMES: readonly Outcome[] = [
  'applied',
  'already_compliant',
  'held',
  'conflicted',
  'inaccessible',
];

export interface RunCounts {
  readonly pages: number;
  readonly compliant: number;
  readonly correction: number;
  readonly hold: number;
  readonly exception: number;
  readonly lifecycleOnly: number;
  readonly lifecycleProblems: number;
  readonly excluded: number;
}

export interface RetagRun {
  readonly id: string;
  readonly projectId: string;
  readonly packId: string;
  readonly policy: RetagPolicy;
  readonly scope: Obj;
  readonly source: Obj;
  readonly counts: RunCounts;
  readonly reconciliationId: string | null;
  readonly actor: string;
  readonly createdAt: number;
}

export interface Classification {
  readonly projectId: string;
  readonly pageId: string;
  readonly pageName: string;
  readonly primary: string;
  readonly specialist: string | null;
  readonly reason: string;
  readonly by: string;
  readonly at: number;
}

export interface Suggestion {
  readonly id: number;
  readonly pageId: string;
  readonly primary: string;
  readonly specialist: string | null;
  readonly reason: string;
  readonly by: string;
  readonly at: number;
}

export interface PageRecord {
  readonly projectId: string;
  readonly pageId: string;
  readonly packId: string;
  readonly tool: string;
  readonly type: string;
  readonly role: string;
  readonly primary: string;
  readonly specialist: string | null;
  readonly proposalId: string | null;
  readonly jobId: string | null;
  readonly createdAt: number;
}

export interface BatchPage {
  readonly pageId: string;
  readonly name: string;
  readonly current: readonly string[];
  readonly proposed: readonly string[];
}

export interface BatchDisposition {
  readonly outcome: Outcome;
  readonly reason: string;
  /** The read-back: null when the page was not written. */
  readonly verified: boolean | null;
  readonly differences?: readonly string[];
}

export interface Batch {
  readonly id: string;
  readonly projectId: string;
  readonly runId: string;
  readonly reconciliationId: string | null;
  readonly proposalId: string | null;
  readonly jobId: string | null;
  readonly pages: readonly BatchPage[];
  readonly state: 'proposed' | 'running' | 'done' | 'stopped' | 'rejected';
  readonly dispositions: Readonly<Record<string, BatchDisposition>> | null;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Reconciliation {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly scope: Obj;
  readonly state: 'open' | 'closed';
  readonly createdBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ReconciliationPage {
  readonly pageId: string;
  readonly name: string;
  readonly disposition: Disposition | null;
  readonly outcome: Outcome | null;
  readonly stale: boolean;
  readonly inputsHash: string;
  readonly runId: string;
  readonly batchId: string | null;
  readonly updatedAt: number;
}

interface RunRow {
  id: string;
  project_id: string;
  pack_id: string;
  policy: string;
  scope: string;
  source: string;
  counts: string;
  reconciliation_id: string | null;
  actor: string;
  created_at: number;
}

const toRun = (r: RunRow): RetagRun => ({
  id: r.id,
  projectId: r.project_id,
  packId: r.pack_id,
  policy: json<RetagPolicy>(r.policy, {
    packId: r.pack_id,
    version: 0,
    label: null,
    sources: [],
    digest: '',
  }),
  scope: json<Obj>(r.scope, {}),
  source: json<Obj>(r.source, {}),
  counts: json<RunCounts>(r.counts, {
    pages: 0,
    compliant: 0,
    correction: 0,
    hold: 0,
    exception: 0,
    lifecycleOnly: 0,
    lifecycleProblems: 0,
    excluded: 0,
  }),
  reconciliationId: r.reconciliation_id,
  actor: r.actor,
  createdAt: r.created_at,
});

interface BatchRow {
  id: string;
  project_id: string;
  run_id: string;
  reconciliation_id: string | null;
  proposal_id: string | null;
  job_id: string | null;
  pages: string;
  state: Batch['state'];
  dispositions: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

const toBatch = (r: BatchRow): Batch => ({
  id: r.id,
  projectId: r.project_id,
  runId: r.run_id,
  reconciliationId: r.reconciliation_id,
  proposalId: r.proposal_id,
  jobId: r.job_id,
  pages: json<BatchPage[]>(r.pages, []),
  state: r.state,
  dispositions: json<Record<string, BatchDisposition> | null>(r.dispositions, null),
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** The runs kept per project when no reconciliation or batch names them. */
const KEEP_RUNS = 20;

export class RetagStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  // ============================================================================================ runs

  saveRun(run: Omit<RetagRun, 'createdAt'>, verdicts: readonly RetagVerdict[]): RetagRun {
    const at = this.now();
    const insert = this.db.prepare(
      `INSERT INTO retag_run_pages (run_id, page_id, name, scope, disposition, verdict, inputs_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO retag_runs (id, project_id, pack_id, policy, scope, source, counts, reconciliation_id, actor,
             created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.id,
          run.projectId,
          run.packId,
          JSON.stringify(run.policy),
          JSON.stringify(run.scope),
          JSON.stringify(run.source),
          JSON.stringify(run.counts),
          run.reconciliationId,
          run.actor,
          at,
        );
      for (const v of verdicts)
        insert.run(run.id, v.pageId, v.name, v.scope, v.disposition, JSON.stringify(v), v.inputsHash);
      this.prune(run.projectId);
    })();
    return this.run(run.id)!;
  }

  /** Old runs no reconciliation and no batch names, beyond the newest {@link KEEP_RUNS} of the project. */
  private prune(projectId: string): void {
    this.db
      .prepare(
        `DELETE FROM retag_runs WHERE project_id = ? AND reconciliation_id IS NULL
           AND id NOT IN (SELECT run_id FROM retag_batches WHERE project_id = ?)
           AND id NOT IN (SELECT run_id FROM retag_reconciliation_pages)
           AND id NOT IN (SELECT id FROM retag_runs WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)`,
      )
      .run(projectId, projectId, projectId, KEEP_RUNS);
  }

  run(id: string): RetagRun | null {
    const r = this.db.prepare('SELECT * FROM retag_runs WHERE id = ?').get(id) as RunRow | undefined;
    return r ? toRun(r) : null;
  }

  runs(projectId: string, limit = 20): RetagRun[] {
    return (
      this.db
        .prepare('SELECT * FROM retag_runs WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
        .all(projectId, limit) as RunRow[]
    ).map(toRun);
  }

  latestRun(projectId: string): RetagRun | null {
    return this.runs(projectId, 1)[0] ?? null;
  }

  verdicts(
    runId: string,
    f: { readonly disposition?: string; readonly scope?: string; readonly pageIds?: readonly string[] } = {},
  ): RetagVerdict[] {
    const rows = this.db
      .prepare(
        `SELECT verdict FROM retag_run_pages WHERE run_id = ?
           ${f.disposition ? 'AND disposition = @d' : ''} ${f.scope ? 'AND scope = @s' : ''} ORDER BY name, page_id`,
      )
      .all(runId, { ...(f.disposition ? { d: f.disposition } : {}), ...(f.scope ? { s: f.scope } : {}) }) as {
      verdict: string;
    }[];
    const all = rows.map((r) => JSON.parse(r.verdict) as RetagVerdict);
    if (!f.pageIds) return all;
    const want = new Set(f.pageIds);
    return all.filter((v) => want.has(v.pageId));
  }

  verdict(runId: string, pageId: string): RetagVerdict | null {
    const r = this.db
      .prepare('SELECT verdict FROM retag_run_pages WHERE run_id = ? AND page_id = ?')
      .get(runId, pageId) as { verdict: string } | undefined;
    return r ? (JSON.parse(r.verdict) as RetagVerdict) : null;
  }

  // ============================================================================================ classifications

  classification(projectId: string, pageId: string): Classification | null {
    const r = this.db
      .prepare('SELECT * FROM retag_classifications WHERE project_id = ? AND page_id = ?')
      .get(projectId, pageId) as Obj | undefined;
    return r ? toClassification(r) : null;
  }

  classifications(projectId: string): Classification[] {
    return (
      this.db
        .prepare('SELECT * FROM retag_classifications WHERE project_id = ? ORDER BY page_name, page_id')
        .all(projectId) as Obj[]
    ).map(toClassification);
  }

  setClassification(c: Classification): void {
    this.db
      .prepare(
        `INSERT INTO retag_classifications (project_id, page_id, page_name, primary_tag, specialist, reason, by, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (project_id, page_id) DO UPDATE SET page_name = excluded.page_name,
             primary_tag = excluded.primary_tag, specialist = excluded.specialist, reason = excluded.reason,
             by = excluded.by, at = excluded.at`,
      )
      .run(c.projectId, c.pageId, c.pageName, c.primary, c.specialist, c.reason, c.by, c.at);
  }

  clearClassification(projectId: string, pageId: string): boolean {
    return (
      this.db
        .prepare('DELETE FROM retag_classifications WHERE project_id = ? AND page_id = ?')
        .run(projectId, pageId).changes > 0
    );
  }

  suggest(projectId: string, s: Omit<Suggestion, 'id'>): Suggestion {
    const r = this.db
      .prepare(
        `INSERT INTO retag_suggestions (project_id, page_id, primary_tag, specialist, reason, by, at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(projectId, s.pageId, s.primary, s.specialist, s.reason, s.by, s.at);
    return { ...s, id: Number(r.lastInsertRowid) };
  }

  suggestions(projectId: string, pageId?: string): Suggestion[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM retag_suggestions WHERE project_id = ? ${pageId ? 'AND page_id = ?' : ''}
           ORDER BY at DESC, id DESC LIMIT 500`,
      )
      .all(...(pageId ? [projectId, pageId] : [projectId])) as Obj[];
    return rows.map((r) => ({
      id: Number(r.id),
      pageId: String(r.page_id),
      primary: String(r.primary_tag),
      specialist: (r.specialist as string | null) ?? null,
      reason: String(r.reason),
      by: String(r.by),
      at: Number(r.at),
    }));
  }

  // ============================================================================================ pack page records

  recordPages(records: readonly Omit<PageRecord, 'createdAt'>[]): void {
    const at = this.now();
    const ins = this.db.prepare(
      `INSERT INTO pack_page_records (project_id, page_id, pack_id, tool, type, role, primary_tag, specialist,
         proposal_id, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, page_id) DO UPDATE SET pack_id = excluded.pack_id, tool = excluded.tool,
           type = excluded.type, role = excluded.role, primary_tag = excluded.primary_tag,
           specialist = excluded.specialist, proposal_id = excluded.proposal_id, job_id = excluded.job_id,
           created_at = excluded.created_at`,
    );
    this.db.transaction(() => {
      for (const r of records)
        ins.run(
          r.projectId,
          r.pageId,
          r.packId,
          r.tool,
          r.type,
          r.role,
          r.primary,
          r.specialist,
          r.proposalId,
          r.jobId,
          at,
        );
    })();
  }

  pageRecord(projectId: string, pageId: string): PageRecord | null {
    const r = this.db
      .prepare('SELECT * FROM pack_page_records WHERE project_id = ? AND page_id = ?')
      .get(projectId, pageId) as Obj | undefined;
    if (!r) return null;
    return {
      projectId: String(r.project_id),
      pageId: String(r.page_id),
      packId: String(r.pack_id),
      tool: String(r.tool),
      type: String(r.type),
      role: String(r.role),
      primary: String(r.primary_tag),
      specialist: (r.specialist as string | null) ?? null,
      proposalId: (r.proposal_id as string | null) ?? null,
      jobId: (r.job_id as string | null) ?? null,
      createdAt: Number(r.created_at),
    };
  }

  // ============================================================================================ batches

  saveBatch(b: Omit<Batch, 'createdAt' | 'updatedAt' | 'dispositions'>): Batch {
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO retag_batches (id, project_id, run_id, reconciliation_id, proposal_id, job_id, pages, state,
           dispositions, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        b.id,
        b.projectId,
        b.runId,
        b.reconciliationId,
        b.proposalId,
        b.jobId,
        JSON.stringify(b.pages),
        b.state,
        b.createdBy,
        at,
        at,
      );
    return this.batch(b.id)!;
  }

  updateBatch(
    id: string,
    patch: {
      readonly jobId?: string | null;
      readonly state?: Batch['state'];
      readonly dispositions?: Readonly<Record<string, BatchDisposition>>;
    },
  ): void {
    const b = this.batch(id);
    if (!b) return;
    this.db
      .prepare(
        'UPDATE retag_batches SET job_id = ?, state = ?, dispositions = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        patch.jobId !== undefined ? patch.jobId : b.jobId,
        patch.state ?? b.state,
        patch.dispositions !== undefined
          ? JSON.stringify(patch.dispositions)
          : b.dispositions
            ? JSON.stringify(b.dispositions)
            : null,
        this.now(),
        id,
      );
  }

  batch(id: string): Batch | null {
    const r = this.db.prepare('SELECT * FROM retag_batches WHERE id = ?').get(id) as BatchRow | undefined;
    return r ? toBatch(r) : null;
  }

  batchByProposal(proposalId: string): Batch | null {
    const r = this.db
      .prepare('SELECT * FROM retag_batches WHERE proposal_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(proposalId) as BatchRow | undefined;
    return r ? toBatch(r) : null;
  }

  batchByJob(projectId: string, jobId: string): Batch | null {
    const r = this.db
      .prepare(
        'SELECT * FROM retag_batches WHERE project_id = ? AND job_id = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(projectId, jobId) as BatchRow | undefined;
    return r ? toBatch(r) : null;
  }

  batches(
    projectId: string,
    f: { readonly reconciliationId?: string; readonly limit?: number } = {},
  ): Batch[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM retag_batches WHERE project_id = ? ${f.reconciliationId ? 'AND reconciliation_id = ?' : ''}
             ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(...[projectId, ...(f.reconciliationId ? [f.reconciliationId] : []), f.limit ?? 50]) as BatchRow[]
    ).map(toBatch);
  }

  /** Batches whose proposal or job has not settled yet (a page in one is not proposed again). */
  openBatches(projectId: string): Batch[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM retag_batches WHERE project_id = ? AND state IN ('proposed', 'running', 'stopped')`,
        )
        .all(projectId) as BatchRow[]
    ).map(toBatch);
  }

  // ============================================================================================ reconciliations

  createReconciliation(r: Omit<Reconciliation, 'createdAt' | 'updatedAt' | 'state'>): Reconciliation {
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO retag_reconciliations (id, project_id, name, scope, state, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`,
      )
      .run(r.id, r.projectId, r.name, JSON.stringify(r.scope), r.createdBy, at, at);
    return this.reconciliation(r.id)!;
  }

  reconciliation(id: string): Reconciliation | null {
    const r = this.db.prepare('SELECT * FROM retag_reconciliations WHERE id = ?').get(id) as Obj | undefined;
    return r ? toReconciliation(r) : null;
  }

  reconciliationByName(projectId: string, name: string): Reconciliation | null {
    const r = this.db
      .prepare('SELECT * FROM retag_reconciliations WHERE project_id = ? AND name = ?')
      .get(projectId, name) as Obj | undefined;
    return r ? toReconciliation(r) : null;
  }

  reconciliations(projectId: string): Reconciliation[] {
    return (
      this.db
        .prepare('SELECT * FROM retag_reconciliations WHERE project_id = ? ORDER BY updated_at DESC, id DESC')
        .all(projectId) as Obj[]
    ).map(toReconciliation);
  }

  setReconciliationState(id: string, state: Reconciliation['state']): void {
    this.db
      .prepare('UPDATE retag_reconciliations SET state = ?, updated_at = ? WHERE id = ?')
      .run(state, this.now(), id);
  }

  touchReconciliation(id: string): void {
    this.db.prepare('UPDATE retag_reconciliations SET updated_at = ? WHERE id = ?').run(this.now(), id);
  }

  /** The latest verdicts of an audit run, laid over the reconciliation's pages (the last apply's outcome is kept). */
  absorbRun(reconciliationId: string, runId: string, verdicts: readonly RetagVerdict[]): void {
    const at = this.now();
    const up = this.db.prepare(
      `INSERT INTO retag_reconciliation_pages (reconciliation_id, page_id, name, disposition, outcome, stale,
         inputs_hash, run_id, batch_id, updated_at) VALUES (?, ?, ?, ?, NULL, 0, ?, ?, NULL, ?)
         ON CONFLICT (reconciliation_id, page_id) DO UPDATE SET name = excluded.name,
           disposition = excluded.disposition, stale = 0, inputs_hash = excluded.inputs_hash, run_id = excluded.run_id,
           updated_at = excluded.updated_at`,
    );
    this.db.transaction(() => {
      for (const v of verdicts) {
        if (v.scope !== 'grammar') continue;
        up.run(reconciliationId, v.pageId, v.name, v.disposition, v.inputsHash, runId, at);
      }
      this.touchReconciliation(reconciliationId);
    })();
  }

  setOutcome(
    reconciliationId: string,
    pageId: string,
    o: { readonly outcome: Outcome; readonly batchId: string; readonly inputsHash?: string },
  ): void {
    this.db
      .prepare(
        `UPDATE retag_reconciliation_pages SET outcome = ?, batch_id = ?, updated_at = ?
           ${o.inputsHash ? ', inputs_hash = ?' : ''} WHERE reconciliation_id = ? AND page_id = ?`,
      )
      .run(
        ...[
          o.outcome,
          o.batchId,
          this.now(),
          ...(o.inputsHash ? [o.inputsHash] : []),
          reconciliationId,
          pageId,
        ],
      );
  }

  markStale(reconciliationId: string, pageIds: readonly string[]): number {
    if (pageIds.length === 0) return 0;
    const st = this.db.prepare(
      'UPDATE retag_reconciliation_pages SET stale = 1, updated_at = ? WHERE reconciliation_id = ? AND page_id = ? AND stale = 0',
    );
    let n = 0;
    const at = this.now();
    this.db.transaction(() => {
      for (const id of pageIds) n += st.run(at, reconciliationId, id).changes;
    })();
    return n;
  }

  reconciliationPages(reconciliationId: string): ReconciliationPage[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM retag_reconciliation_pages WHERE reconciliation_id = ? ORDER BY name, page_id',
        )
        .all(reconciliationId) as Obj[]
    ).map((r) => ({
      pageId: String(r.page_id),
      name: String(r.name),
      disposition: (r.disposition as Disposition | null) ?? null,
      outcome: (r.outcome as Outcome | null) ?? null,
      stale: Number(r.stale) === 1,
      inputsHash: String(r.inputs_hash),
      runId: String(r.run_id),
      batchId: (r.batch_id as string | null) ?? null,
      updatedAt: Number(r.updated_at),
    }));
  }
}

function toClassification(r: Obj): Classification {
  return {
    projectId: String(r.project_id),
    pageId: String(r.page_id),
    pageName: String(r.page_name),
    primary: String(r.primary_tag),
    specialist: (r.specialist as string | null) ?? null,
    reason: String(r.reason),
    by: String(r.by),
    at: Number(r.at),
  };
}

function toReconciliation(r: Obj): Reconciliation {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    name: String(r.name),
    scope: json<Obj>(r.scope as string, {}),
    state: r.state === 'closed' ? 'closed' : 'open',
    createdBy: String(r.created_by),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}
