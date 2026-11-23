/**
 * v3 F5c (ADR 0069, H8): `bridge_workstream_report`, one report of the work done under a workstream label (or since a
 * time, by a principal, or for named jobs). Read-only and free: the bridge's own tables (jobs, steps, the write journal
 * and its reconciliations, proposals, the audits' findings, `arkona_identity_reconcile`'s records); nothing is read from
 * LegendKeeper.
 *
 * The groups are the ones ChatGPT asked for:
 * - **written and verified**: every page changed, each write with its version before and after and who made it, and
 *   what the job's verification (or read-back) found;
 * - **accepted but not yet run**: jobs queued, running or waiting; proposals approved but not executed;
 * - **deliberately excluded**: items the owner left unticked, items a job skipped (changed meanwhile, FIX_STALE) and
 *   items refused before anything was planned, each with why;
 * - **awaiting the author's judgement**: pending and conflicted proposals, and tags held for the owner;
 * - **residual inconsistencies**: writes whose outcome was unknown (and how each was settled), verifications that
 *   found a difference, failed jobs, and audit findings still open on the pages touched (consistency included).
 *
 * "Still to do" is drawn only from those groups; nothing is invented.
 */
import type { Db } from '../db/open.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const parse = (s: unknown): unknown => {
  if (typeof s !== 'string') return null;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
};
const iso = (t: number | null | undefined) => (typeof t === 'number' ? new Date(t).toISOString() : null);

/** What a report covers (at least one; together they narrow). */
export interface ReportScope {
  readonly workstream?: string;
  /** Milliseconds since the epoch. */
  readonly since?: number;
  readonly principal?: string;
  readonly jobIds?: readonly string[];
}

/** The most jobs and proposals one report reads (the oldest beyond it are counted, not listed). */
export const REPORT_MAX_JOBS = 300;
const LIST_MAX = 200;

export interface WorkstreamReportDeps {
  readonly db: Db;
  readonly now: () => number;
  /** A page's name (the tree's), for pages a journal entry does not name. */
  readonly pageName?: (projectId: string, pageId: string) => string | null;
  /** A principal's display name (a connection's label). */
  readonly principalName?: (principalId: string) => string | null;
  /** A project's name (the tool-call log names projects by name). */
  readonly projectName?: (projectId: string) => string | null;
}

interface JobRow {
  id: string;
  title: string;
  status: string;
  principal_id: string;
  approved_by: string | null;
  origin: string;
  result: string | null;
  last_error: string | null;
  workstream: string | null;
  created_at: number;
  finished_at: number | null;
}

interface JournalRow {
  id: number;
  at: number;
  job_id: string | null;
  step_no: number | null;
  op_id: string;
  principal_id: string;
  approved_by: string | null;
  resource_id: string | null;
  document_id: string | null;
  target_kind: string;
  target_id: string | null;
  version: string | null;
  outcome: string;
  operation: string | null;
}

interface ProposalRow {
  id: string;
  title: string;
  summary: string;
  state: string;
  principal_id: string;
  created_at: number;
  decided_at: number | null;
  job_id: string | null;
  conflict: string | null;
  items: string | null;
  omitted_items: string | null;
  operation: string | null;
  workstream: string | null;
}

export class WorkstreamReports {
  constructor(private readonly d: WorkstreamReportDeps) {}

  /** The workstreams of a project (or every project): label, principals, first and last activity, counts. */
  list(projectId: string | null, o: { readonly limit?: number } = {}): Obj[] {
    const limit = Math.min(Math.max(o.limit ?? 100, 1), 500);
    const where = projectId ? 'AND project_id = ?' : '';
    const args = projectId ? [projectId] : [];
    const jobs = this.d.db
      .prepare(
        `SELECT project_id, workstream, COUNT(*) AS jobs, MIN(created_at) AS first, MAX(COALESCE(finished_at, created_at)) AS last,
           SUM(CASE WHEN status IN ('queued', 'running', 'waiting_budget', 'waiting_lock', 'paused') THEN 1 ELSE 0 END) AS open,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
           GROUP_CONCAT(DISTINCT principal_id) AS principals
         FROM jobs WHERE workstream IS NOT NULL ${where} GROUP BY project_id, workstream`,
      )
      .all(...args) as {
      project_id: string;
      workstream: string;
      jobs: number;
      first: number;
      last: number;
      open: number;
      failed: number;
      principals: string | null;
    }[];
    const props = this.d.db
      .prepare(
        `SELECT project_id, workstream, COUNT(*) AS n, MIN(created_at) AS first, MAX(updated_at) AS last,
           SUM(CASE WHEN state IN ('pending', 'conflicted') THEN 1 ELSE 0 END) AS waiting,
           GROUP_CONCAT(DISTINCT principal_id) AS principals
         FROM proposals WHERE workstream IS NOT NULL ${where} GROUP BY project_id, workstream`,
      )
      .all(...args) as {
      project_id: string;
      workstream: string;
      n: number;
      first: number;
      last: number;
      waiting: number;
      principals: string | null;
    }[];
    const writes = this.d.db
      .prepare(
        `SELECT project_id, workstream, COUNT(*) AS n, COUNT(DISTINCT resource_id) AS pages,
           SUM(CASE WHEN outcome IN ('unknown') THEN 1 ELSE 0 END) AS unknown
         FROM write_journal WHERE workstream IS NOT NULL ${where} GROUP BY project_id, workstream`,
      )
      .all(...args) as { project_id: string; workstream: string; n: number; pages: number; unknown: number }[];
    const by = new Map<string, Obj>();
    const key = (p: string, w: string) => `${p}\u0001${w}`;
    const get = (p: string, w: string) => {
      let e = by.get(key(p, w));
      if (!e) {
        e = {
          projectId: p,
          workstream: w,
          principals: new Set<string>(),
          first: Number.MAX_SAFE_INTEGER,
          last: 0,
          jobs: 0,
          openJobs: 0,
          failedJobs: 0,
          proposals: 0,
          awaitingOwner: 0,
          writes: 0,
          pages: 0,
          unknownOutcomes: 0,
        };
        by.set(key(p, w), e);
      }
      return e as Obj & { principals: Set<string>; first: number; last: number };
    };
    for (const r of jobs) {
      const e = get(r.project_id, r.workstream);
      for (const p of (r.principals ?? '').split(',').filter(Boolean)) e.principals.add(p);
      e.first = Math.min(e.first, r.first);
      e.last = Math.max(e.last, r.last);
      Object.assign(e, { jobs: r.jobs, openJobs: r.open, failedJobs: r.failed });
    }
    for (const r of props) {
      const e = get(r.project_id, r.workstream);
      for (const p of (r.principals ?? '').split(',').filter(Boolean)) e.principals.add(p);
      e.first = Math.min(e.first, r.first);
      e.last = Math.max(e.last, r.last);
      Object.assign(e, { proposals: r.n, awaitingOwner: r.waiting });
    }
    for (const r of writes) {
      const e = get(r.project_id, r.workstream);
      Object.assign(e, { writes: r.n, pages: r.pages, unknownOutcomes: r.unknown });
    }
    return [...by.values()]
      .map((e) => {
        const x = e as Obj & { principals: Set<string>; first: number; last: number };
        const principals = [...x.principals].sort();
        return {
          ...x,
          principals: principals.map((p) => ({ id: p, name: this.d.principalName?.(p) ?? null })),
          first: iso(x.first),
          last: iso(x.last),
          lastAt: x.last,
        };
      })
      .sort((a, b) => (b.lastAt as number) - (a.lastAt as number))
      .slice(0, limit)
      .map(({ lastAt: _l, ...rest }) => rest);
  }

  /** The report (see the module's comment). Throws a plain Error when the scope names nothing. */
  report(projectId: string, scope: ReportScope): Obj {
    if (
      scope.workstream === undefined &&
      scope.since === undefined &&
      scope.principal === undefined &&
      (scope.jobIds === undefined || scope.jobIds.length === 0)
    )
      throw new Error('Name a workstream, a since time, a principal or jobIds.');
    const db = this.d.db;
    const conds: string[] = ['project_id = ?'];
    const args: unknown[] = [projectId];
    if (scope.workstream !== undefined) {
      conds.push('workstream = ?');
      args.push(scope.workstream);
    }
    if (scope.since !== undefined) {
      conds.push('created_at >= ?');
      args.push(scope.since);
    }
    if (scope.principal !== undefined) {
      conds.push('principal_id = ?');
      args.push(scope.principal);
    }
    const jobIds = scope.jobIds && scope.jobIds.length > 0 ? [...new Set(scope.jobIds)].slice(0, 500) : null;
    const jobConds = [...conds];
    const jobArgs = [...args];
    if (jobIds) {
      jobConds.push(`id IN (${jobIds.map(() => '?').join(',')})`);
      jobArgs.push(...jobIds);
    }
    // The bridge's own work (a revert, the reconciler, maintenance) is reported only when asked for by id or principal.
    if (!jobIds && scope.principal === undefined && scope.workstream === undefined)
      jobConds.push("principal_id <> 'system'");
    const jobTotal = (
      db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE ${jobConds.join(' AND ')}`).get(...jobArgs) as {
        n: number;
      }
    ).n;
    const jobs = db
      .prepare(
        `SELECT id, title, status, principal_id, approved_by, origin, result, last_error, workstream, created_at, finished_at
           FROM jobs WHERE ${jobConds.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...jobArgs, REPORT_MAX_JOBS) as JobRow[];
    // Proposals: by the same scope; with jobIds, those whose job is named.
    const propConds = [...conds];
    const propArgs = [...args];
    if (jobIds) {
      propConds.push(`job_id IN (${jobIds.map(() => '?').join(',')})`);
      propArgs.push(...jobIds);
    }
    const proposals = db
      .prepare(
        `SELECT id, title, summary, state, principal_id, created_at, decided_at, job_id, conflict, items, omitted_items,
           operation, workstream FROM proposals WHERE ${propConds.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...propArgs, REPORT_MAX_JOBS) as ProposalRow[];
    // An approved proposal's job belongs to the report too (it carries the proposal's workstream; with `principal`, the
    // proposer's principal: both already match), and one named only through its proposal is added.
    const have = new Set(jobs.map((j) => j.id));
    const extra = proposals.map((p) => p.job_id).filter((id): id is string => !!id && !have.has(id));
    if (extra.length > 0)
      jobs.push(
        ...(db
          .prepare(
            `SELECT id, title, status, principal_id, approved_by, origin, result, last_error, workstream, created_at, finished_at
               FROM jobs WHERE project_id = ? AND id IN (${extra.map(() => '?').join(',')})`,
          )
          .all(projectId, ...extra) as JobRow[]),
      );
    const ids = jobs.map((j) => j.id);
    const journal: JournalRow[] =
      ids.length === 0
        ? []
        : (db
            .prepare(
              `SELECT id, at, job_id, step_no, op_id, principal_id, approved_by, resource_id, document_id, target_kind,
                 target_id, version, outcome, operation FROM write_journal
               WHERE project_id = ? AND job_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
            )
            .all(projectId, ...ids) as JournalRow[]);
    // H10: every write whose outcome was unknown at some point (it has a reconciliation), settled or not.
    const reconciliations = new Map<number, Obj>();
    if (journal.length > 0) {
      const rows = db
        .prepare(
          `SELECT journal_id, state, outcome, attempts, settled_at, settled_by, reason FROM write_reconciliations
           WHERE journal_id IN (${journal.map(() => '?').join(',')})`,
        )
        .all(...journal.map((j) => j.id)) as Obj[];
      for (const r of rows) reconciliations.set(r.journal_id as number, r);
    }
    const unsettled = journal.filter(
      (j) => j.outcome === 'unknown' || j.outcome === 'superseded' || reconciliations.has(j.id),
    );
    // The version each write left (its step's result), for "before → after".
    const after = new Map<string, string>();
    if (ids.length > 0) {
      const rows = db
        .prepare(
          `SELECT job_id, step_no, result_summary FROM steps WHERE job_id IN (${ids.map(() => '?').join(',')})
             AND status = 'succeeded' AND result_summary LIKE '%version%'`,
        )
        .all(...ids) as { job_id: string; step_no: number; result_summary: string | null }[];
      for (const r of rows) {
        const v = parse(r.result_summary);
        if (isObj(v) && (typeof v.version === 'string' || typeof v.version === 'number'))
          after.set(`${r.job_id}:${r.step_no}`, String(v.version));
      }
    }
    const jobById = new Map(jobs.map((j) => [j.id, j]));
    const nameOf = (pageId: string | null, op: Obj | null): string | null => {
      const n = op && isObj(op.page) && typeof op.page.name === 'string' ? op.page.name : null;
      return n ?? (pageId ? (this.d.pageName?.(projectId, pageId) ?? null) : null);
    };
    const who = (principal: string, approvedBy: string | null) => ({
      principal,
      ...(this.d.principalName?.(principal) ? { name: this.d.principalName(principal) } : {}),
      ...(approvedBy ? { approvedBy } : {}),
    });

    // ---- written (and verified)
    const pages = new Map<string, Obj & { writes: Obj[]; jobs: Set<string> }>();
    for (const j of journal) {
      if (j.outcome === 'not_applied' || j.outcome === 'pending') continue;
      const op = parse(j.operation) as Obj | null;
      const pageId = j.resource_id ?? j.target_id ?? '(none)';
      let p = pages.get(pageId);
      if (!p) {
        p = { page: { id: pageId, name: nameOf(j.resource_id, op) }, writes: [], jobs: new Set<string>() };
        pages.set(pageId, p);
      }
      p.jobs.add(j.job_id ?? '');
      p.writes.push({
        journalId: j.id,
        at: iso(j.at),
        jobId: j.job_id,
        op: j.op_id,
        ...(op && typeof op.write === 'string' ? { what: op.write } : {}),
        ...(op && typeof op.tool === 'string' ? { tool: op.tool } : {}),
        ...(j.document_id ? { documentId: j.document_id } : {}),
        versionBefore: j.version,
        versionAfter: j.job_id && j.step_no !== null ? (after.get(`${j.job_id}:${j.step_no}`) ?? null) : null,
        outcome: j.outcome,
        by: who(j.principal_id, j.approved_by),
      });
    }
    const verificationOf = (jobId: string): { verified: boolean | null; detail: unknown } => {
      const j = jobById.get(jobId);
      const r = parse(j?.result) as Obj | null;
      if (!r) return { verified: null, detail: null };
      const v = r.verification;
      const list = Array.isArray(v) ? v : v ? [v] : [];
      const brief = list.filter(isObj).map((x) => ({
        stepNo: x.stepNo ?? null,
        status: x.status ?? null,
        ...(Array.isArray(x.targets)
          ? {
              targets: (x.targets as Obj[]).slice(0, 20).map((t) => ({
                label: t.label,
                status: t.status,
                ...(t.reason ? { reason: t.reason } : {}),
              })),
            }
          : {}),
      }));
      return { verified: typeof r.verified === 'boolean' ? r.verified : null, detail: brief };
    };
    const written: Obj[] = [];
    const mismatches: Obj[] = [];
    for (const p of pages.values()) {
      const jobsOf = [...p.jobs].filter((x) => x !== '');
      const ver = jobsOf.map((id) => ({ jobId: id, ...verificationOf(id) }));
      const verified = ver.length > 0 && ver.every((v) => v.verified === true);
      const entry = {
        page: p.page,
        writes: p.writes.slice(0, 50),
        ...(p.writes.length > 50 ? { moreWrites: p.writes.length - 50 } : {}),
        verified: ver.some((v) => v.verified === false) ? false : verified ? true : null,
        verification: ver.map((v) => ({ jobId: v.jobId, verified: v.verified, steps: v.detail })),
      };
      written.push(entry);
      for (const v of ver)
        if (v.verified === false)
          mismatches.push({ page: p.page, jobId: v.jobId, verification: v.detail, why: 'written but not as planned' });
    }

    // ---- accepted but not yet run
    const OPEN = new Set(['queued', 'running', 'waiting_budget', 'waiting_lock', 'paused']);
    const notRun: Obj[] = [
      ...jobs
        .filter((j) => OPEN.has(j.status))
        .map((j) => ({ kind: 'job', jobId: j.id, title: j.title, status: j.status, by: who(j.principal_id, j.approved_by) })),
      ...proposals
        .filter((p) => p.state === 'approved' || p.state === 'executing')
        .map((p) => ({ kind: 'proposal', proposalId: p.id, title: p.title, state: p.state, jobId: p.job_id })),
    ];

    // ---- awaiting the author's judgement
    const awaiting: Obj[] = proposals
      .filter((p) => p.state === 'pending' || p.state === 'conflicted')
      .map((p) => ({
        kind: 'proposal',
        proposalId: p.id,
        state: p.state,
        title: p.title,
        summary: p.summary.slice(0, 300),
        createdAt: iso(p.created_at),
        ...(p.state === 'conflicted' && p.conflict ? { conflict: parse(p.conflict) } : {}),
      }));

    // ---- deliberately excluded
    const excluded: Obj[] = [];
    for (const p of proposals) {
      const omitted = parse(p.omitted_items);
      if (!Array.isArray(omitted) || omitted.length === 0) continue;
      const items = parse(p.items);
      const label = (id: string) =>
        Array.isArray(items)
          ? ((items as Obj[]).find((i) => i.id === id)?.label as string | undefined)
          : undefined;
      for (const id of omitted as string[])
        excluded.push({
          kind: 'unticked',
          proposalId: p.id,
          item: id,
          ...(label(id) ? { label: label(id) } : {}),
          why: 'left out by the owner when approving',
        });
    }
    if (ids.length > 0) {
      const rows = db
        .prepare(
          `SELECT job_id, step_no, result_summary FROM steps WHERE job_id IN (${ids.map(() => '?').join(',')})
             AND result_summary LIKE '%skippedItems%' ORDER BY job_id, step_no`,
        )
        .all(...ids) as { job_id: string; step_no: number; result_summary: string | null }[];
      const seen = new Set<string>();
      for (const r of rows) {
        const v = parse(r.result_summary);
        const list = isObj(v) && Array.isArray(v.skippedItems) ? (v.skippedItems as Obj[]) : [];
        for (const s of list) {
          const k = `${r.job_id}:${String(s.item)}`;
          if (seen.has(k)) continue;
          seen.add(k);
          excluded.push({
            kind: 'skipped',
            jobId: r.job_id,
            item: s.item,
            why: s.reason ?? 'skipped',
            ...(s.before !== undefined ? { before: s.before } : {}),
            ...(s.after !== undefined ? { after: s.after } : {}),
            ...(s.where !== undefined ? { where: s.where } : {}),
          });
        }
      }
    }
    // FIX_STALE and the like: an agent's call or a fix refused because its finding no longer held, recorded on a job's
    // error (nothing was written).
    for (const j of jobs) {
      const e = parse(j.last_error) as Obj | null;
      if (j.status === 'failed' && e && (e.code === 'FIX_STALE' || e.code === 'RETAG_POLICY_CHANGED'))
        excluded.push({ kind: 'refused', jobId: j.id, code: e.code, why: e.message ?? e.code });
    }

    // Refusals that made no job (FIX_STALE, an unmapped value, a rename steered elsewhere): the tool-call log keeps the
    // label each write tool's result echoed.
    const projectName = this.d.projectName?.(projectId) ?? null;
    if (scope.workstream !== undefined || scope.principal !== undefined || scope.since !== undefined) {
      const c: string[] = ["outcome = 'error'", 'workstream IS NOT NULL'];
      const a: unknown[] = [];
      if (scope.workstream !== undefined) {
        c.push('workstream = ?');
        a.push(scope.workstream);
      }
      if (scope.principal !== undefined) {
        c.push('principal_id = ?');
        a.push(scope.principal);
      }
      if (scope.since !== undefined) {
        c.push('at >= ?');
        a.push(scope.since);
      }
      if (projectName !== null) {
        c.push('(project IS NULL OR project = ?)');
        a.push(projectName);
      }
      try {
        const rows = db
          .prepare(
            `SELECT id, at, tool, code, job_id FROM tool_calls WHERE ${c.join(' AND ')} AND job_id IS NULL ORDER BY at DESC LIMIT ?`,
          )
          .all(...a, LIST_MAX) as { id: number; at: number; tool: string; code: string | null }[];
        for (const r of rows)
          excluded.push({
            kind: 'refused',
            tool: r.tool,
            code: r.code,
            at: iso(r.at),
            why: `${r.tool} was refused${r.code ? ` (${r.code})` : ''}; nothing was written`,
          });
      } catch {
        // No tool-call log (tests of the report alone).
      }
    }

    // ---- arkona_identity_reconcile's records (refused, held, skipped and failed items, and follow-ups)
    const idConds = ['project_id = ?'];
    const idArgs: unknown[] = [projectId];
    if (scope.workstream !== undefined) {
      idConds.push('workstream = ?');
      idArgs.push(scope.workstream);
    }
    if (scope.since !== undefined) {
      idConds.push('created_at >= ?');
      idArgs.push(scope.since);
    }
    if (scope.principal !== undefined) {
      idConds.push('principal_id = ?');
      idArgs.push(scope.principal);
    }
    if (jobIds) {
      idConds.push(`job_id IN (${jobIds.map(() => '?').join(',')})`);
      idArgs.push(...jobIds);
    }
    let identityRows: { id: string; job_id: string | null; proposal_id: string | null; plan: string; outcome: string | null }[] =
      [];
    try {
      identityRows = db
        .prepare(
          `SELECT id, job_id, proposal_id, plan, outcome FROM identity_reconciles WHERE ${idConds.join(' AND ')}
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(...idArgs, REPORT_MAX_JOBS) as typeof identityRows;
    } catch {
      identityRows = [];
    }
    const followUps: Obj[] = [];
    for (const r of identityRows) {
      const plan = parse(r.plan) as Obj | null;
      const outcome = parse(r.outcome) as Obj | null;
      const planned = Array.isArray(plan?.items) ? (plan.items as Obj[]) : [];
      const done = Array.isArray(outcome?.items) ? (outcome.items as Obj[]) : [];
      for (const it of planned) {
        if (it.status === 'refused')
          excluded.push({
            kind: 'refused',
            reconcileId: r.id,
            character: it.character,
            code: (it.refusal as Obj | undefined)?.code ?? null,
            why: (it.refusal as Obj | undefined)?.message ?? 'refused',
          });
      }
      for (const it of done) {
        if (it.status === 'partly_done' || (isObj(it.tags) && it.tags.status === 'held'))
          awaiting.push({
            kind: 'tags_held',
            reconcileId: r.id,
            jobId: r.job_id,
            character: it.character,
            page: it.page,
            why: isObj(it.tags) ? (it.tags.reason ?? 'tags held') : 'tags held',
          });
        if (Array.isArray(it.followUps))
          for (const f of it.followUps as Obj[])
            followUps.push({ reconcileId: r.id, character: it.character, page: it.page, ...f });
      }
    }

    // ---- residual inconsistencies
    const unknownWrites = unsettled.map((j) => {
      const rec = reconciliations.get(j.id) ?? null;
      const op = parse(j.operation) as Obj | null;
      return {
        journalId: j.id,
        jobId: j.job_id,
        op: j.op_id,
        page: { id: j.resource_id, name: nameOf(j.resource_id, op) },
        outcome: j.outcome,
        reconciliation: rec
          ? {
              state: rec.state,
              outcome: rec.outcome ?? null,
              attempts: rec.attempts,
              settledAt: iso(rec.settled_at as number | null),
              by: rec.settled_by ?? null,
              reason: rec.reason ?? null,
            }
          : null,
      };
    });
    const failed = jobs
      .filter((j) => j.status === 'failed' || j.status === 'cancelled')
      .map((j) => {
        const e = parse(j.last_error) as Obj | null;
        return {
          jobId: j.id,
          title: j.title,
          status: j.status,
          ...(e ? { code: e.code ?? null, message: e.message ?? null } : {}),
        };
      });
    const touched = [...pages.keys()].filter((x) => x !== '(none)');
    let findings: Obj[] = [];
    if (touched.length > 0) {
      try {
        findings = (
          db
            .prepare(
              `SELECT f.id, f.code, f.category, f.severity, f.page_id, f.page_name, f.message FROM audit_findings f
               WHERE f.project_id = ? AND f.state = 'open' AND f.page_id IN (${touched.map(() => '?').join(',')})
                 AND NOT EXISTS (SELECT 1 FROM audit_acks a WHERE a.project_id = f.project_id AND a.fingerprint = f.fingerprint)
               ORDER BY f.severity, f.page_name LIMIT ?`,
            )
            .all(projectId, ...touched, LIST_MAX) as Obj[]
        ).map((f) => ({
          findingId: f.id,
          code: f.code,
          category: f.category,
          severity: f.severity,
          page: { id: f.page_id, name: f.page_name },
          message: f.message,
        }));
      } catch {
        findings = [];
      }
    }
    // Follow-ups the reconcile's consistency check listed (open or new), not already among the audits' findings.
    const residual = {
      unknownOutcomes: unknownWrites,
      verificationMismatches: mismatches,
      failedJobs: failed,
      openFindings: findings,
      consistencyFollowUps: followUps.slice(0, LIST_MAX),
    };

    // ---- still to do (only from the groups above)
    const todo: string[] = [];
    for (const a of awaiting)
      todo.push(
        a.kind === 'proposal'
          ? `${a.state === 'conflicted' ? 'Conflicted' : 'Pending'} proposal ${String(a.proposalId)} waits for the owner: ${String(a.title)}`
          : `Tags of ${String(a.character ?? (a.page as Obj | undefined)?.name ?? 'a page')} held: ${String(a.why)}`,
      );
    for (const n of notRun)
      todo.push(
        n.kind === 'job'
          ? `Job ${String(n.jobId)} is ${String(n.status)}: ${String(n.title)}`
          : `Approved proposal ${String(n.proposalId)} is ${String(n.state)}`,
      );
    for (const u of unknownWrites)
      if (!(u.reconciliation && u.reconciliation.state === 'settled'))
        todo.push(
          `Write ${u.journalId} (${u.op} on ${u.page.name ?? u.page.id ?? '?'}) has an unknown outcome: read the page before anything else`,
        );
    for (const m of mismatches)
      todo.push(`Job ${String(m.jobId)} wrote ${String((m.page as Obj).name ?? (m.page as Obj).id)} but its read-back differs`);
    for (const f of failed)
      todo.push(`Job ${f.jobId} ${f.status}${'code' in f && f.code ? ` (${String(f.code)})` : ''}: ${f.title}`);
    for (const e of excluded)
      if (e.kind === 'skipped' || e.kind === 'refused')
        todo.push(
          `${e.kind === 'skipped' ? 'Skipped' : 'Refused'}: ${String(e.character ?? e.item ?? e.jobId)}: ${String(e.why)}`,
        );
    for (const f of findings)
      todo.push(`Open ${String(f.severity)} finding ${String(f.code)} on ${String((f.page as Obj).name ?? (f.page as Obj).id)}`);
    for (const f of followUps.slice(0, 50))
      todo.push(`Consistency on ${String(f.character ?? '?')}: ${String(f.message ?? f.code ?? 'a disagreement')}`);

    const verifiedPages = written.filter((w) => w.verified === true).length;
    return {
      scope: {
        ...(scope.workstream !== undefined ? { workstream: scope.workstream } : {}),
        ...(scope.since !== undefined ? { since: iso(scope.since) } : {}),
        ...(scope.principal !== undefined ? { principal: scope.principal } : {}),
        ...(jobIds ? { jobIds } : {}),
      },
      cost: 'free: the bridge’s own records; nothing was read from LegendKeeper',
      generatedAt: iso(this.d.now()),
      counts: {
        jobs: jobs.length,
        ...(jobTotal > REPORT_MAX_JOBS ? { jobsNotListed: jobTotal - REPORT_MAX_JOBS } : {}),
        proposals: proposals.length,
        pagesChanged: written.length,
        pagesVerified: verifiedPages,
        writes: written.reduce((n, w) => n + (w.writes as unknown[]).length, 0),
        acceptedNotRun: notRun.length,
        excluded: excluded.length,
        awaitingJudgement: awaiting.length,
        unknownOutcomes: unknownWrites.length,
        openFindings: findings.length,
      },
      groups: {
        writtenAndVerified: written.slice(0, LIST_MAX),
        acceptedNotYetRun: notRun.slice(0, LIST_MAX),
        deliberatelyExcluded: excluded.slice(0, LIST_MAX),
        awaitingJudgement: awaiting.slice(0, LIST_MAX),
        residualInconsistencies: residual,
      },
      stillToDo: todo.slice(0, LIST_MAX),
      ...(todo.length > LIST_MAX ? { stillToDoMore: todo.length - LIST_MAX } : {}),
    };
  }
}
