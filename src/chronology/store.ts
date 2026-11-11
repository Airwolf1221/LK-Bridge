/**
 * The chronology's own tables (v2 D1, ADR 0038; migration 1800): cached calendar definitions, the record of each
 * chronology change (for resuming one that stopped part-way), the links between the bridge's own rows and events, and
 * the chronology check's runs. Synchronous, like every other store.
 */
import type { Db } from '../db/open.js';

type Obj = Record<string, unknown>;
const json = (v: unknown) => JSON.stringify(v ?? null);
const parse = <T>(s: string | null | undefined, fallback: T): T => {
  if (s === null || s === undefined) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

// ============================================================================================ the record

export type ChronologyTool =
  'create_timeline_event' | 'update_timeline_event' | 'delete_timeline_event' | 'sync_timeline_event';

/** One write a change makes, as the record keeps it (what resuming checks against the documents as they are). */
export type TargetWrite =
  | {
      /**
       * Not a write: the table row, as the plan read it, must still be exactly so inside the lock (the compare-and-swap
       * of a repair that writes only the timeline and takes the row as its authority).
       */
      readonly kind: 'row.assert';
      readonly age: string;
      readonly resourceId: string;
      readonly documentId: string;
      readonly rowId: string;
      readonly texts: { readonly description: string; readonly date: string; readonly kcy: string };
    }
  | {
      readonly kind: 'row.insert';
      readonly age: string;
      readonly resourceId: string;
      readonly documentId: string;
      readonly rowId: string;
      /** The texts the row holds (description, Date, KCY), and the whole block as built. */
      readonly texts: { readonly description: string; readonly date: string; readonly kcy: string };
      readonly block: Obj;
    }
  | {
      readonly kind: 'row.delete';
      readonly age: string;
      readonly resourceId: string;
      readonly documentId: string;
      readonly rowId: string;
      readonly texts: { readonly description: string; readonly date: string; readonly kcy: string };
    }
  | {
      readonly kind: 'row.replace';
      readonly age: string;
      readonly resourceId: string;
      readonly documentId: string;
      readonly rowId: string;
      readonly before: { readonly description: string; readonly date: string; readonly kcy: string };
      readonly texts: { readonly description: string; readonly date: string; readonly kcy: string };
      readonly block: Obj;
    }
  | {
      readonly kind: 'event.create';
      readonly age: string;
      readonly resourceId: string;
      readonly documentId: string;
      readonly eventId: string;
      readonly body: Obj;
    }
  | {
      readonly kind: 'event.delete';
      readonly age: string;
      readonly resourceId: string;
      readonly documentId: string;
      readonly eventId: string;
    }
  | {
      readonly kind: 'event.update';
      readonly age: string;
      readonly resourceId: string;
      readonly documentId: string;
      readonly eventId: string;
      readonly fields: Obj;
    }
  | {
      readonly kind: 'count';
      readonly age: string;
      readonly resourceId: string;
      readonly documentId: string;
      readonly rowId: string;
      readonly delta: number;
    };

export interface ChronologyTarget {
  readonly writes: readonly TargetWrite[];
  /** The link the change leaves (row and event of one chronology event), or removes. */
  readonly link?: {
    readonly age: string;
    readonly tableDocumentId: string;
    readonly rowId: string;
    readonly timelineDocumentId: string;
    readonly eventId: string;
  } | null;
  readonly unlink?: { readonly tableDocumentId: string; readonly rowId: string } | null;
}

export interface ChronologyRecord {
  readonly id: number;
  readonly projectId: string;
  readonly tool: ChronologyTool;
  readonly requestKey: string;
  readonly ages: readonly string[];
  readonly summary: string;
  readonly target: ChronologyTarget;
  /** The Main counts as the first job's check found them, by Main row: before the change and after it. */
  readonly observed: { readonly counts?: Readonly<Record<string, { before: number; after: number }>> };
  readonly state: 'incomplete' | 'complete' | 'resolved';
  readonly jobId: string | null;
  readonly jobs: readonly string[];
  readonly principalId: string;
  readonly approver: string | null;
  readonly proposalId: string | null;
  readonly detail: Obj;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
}

interface RecordRow {
  id: number;
  project_id: string;
  tool: string;
  request_key: string;
  ages: string;
  summary: string;
  target: string;
  observed: string | null;
  state: string;
  job_id: string | null;
  jobs: string;
  principal_id: string;
  approver: string | null;
  proposal_id: string | null;
  detail: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

const recordOf = (r: RecordRow): ChronologyRecord => ({
  id: r.id,
  projectId: r.project_id,
  tool: r.tool as ChronologyTool,
  requestKey: r.request_key,
  ages: parse<string[]>(r.ages, []),
  summary: r.summary,
  target: parse<ChronologyTarget>(r.target, { writes: [] }),
  observed: parse<ChronologyRecord['observed']>(r.observed, {}),
  state: r.state as ChronologyRecord['state'],
  jobId: r.job_id,
  jobs: parse<string[]>(r.jobs, []),
  principalId: r.principal_id,
  approver: r.approver,
  proposalId: r.proposal_id,
  detail: parse<Obj>(r.detail, {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  completedAt: r.completed_at,
});

// ============================================================================================ the check

export interface CheckFinding {
  readonly kind:
    | 'row_without_event'
    | 'event_without_row'
    | 'date_mismatch'
    | 'row_out_of_order'
    | 'wrong_kcy'
    | 'count_mismatch'
    | 'wrong_uri'
    | 'unreadable_date'
    | 'date_text_differs'
    | 'not_found';
  readonly age: string;
  readonly message: string;
  readonly detail?: Obj;
}

export interface CheckRun {
  readonly id: number;
  readonly projectId: string;
  readonly trigger: string;
  readonly state: 'running' | 'succeeded' | 'failed';
  readonly requests: number;
  readonly summary: string | null;
  readonly findings: readonly CheckFinding[];
  readonly ages: readonly Obj[];
  readonly error: string | null;
  readonly startedAt: number;
  readonly finishedAt: number | null;
}

interface CheckRow {
  id: number;
  project_id: string;
  trigger: string;
  state: string;
  requests: number;
  summary: string | null;
  findings: string;
  ages: string;
  error: string | null;
  started_at: number;
  finished_at: number | null;
}

const checkOf = (r: CheckRow): CheckRun => ({
  id: r.id,
  projectId: r.project_id,
  trigger: r.trigger,
  state: r.state as CheckRun['state'],
  requests: r.requests,
  summary: r.summary,
  findings: parse<CheckFinding[]>(r.findings, []),
  ages: parse<Obj[]>(r.ages, []),
  error: r.error,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export interface ChronologyLink {
  readonly tableDocumentId: string;
  readonly rowId: string;
  readonly timelineDocumentId: string;
  readonly eventId: string;
  readonly age: string;
}

export class ChronologyStore {
  constructor(
    readonly db: Db,
    private readonly now: () => number,
  ) {}

  // ------------------------------------------------------------------------------------------ calendars

  cachedCalendar(
    projectId: string,
    calendarId: string,
  ): { definition: unknown; version: string | null; fetchedAt: number } | null {
    const r = this.db
      .prepare(
        'SELECT definition, version, fetched_at FROM chronology_calendars WHERE project_id = ? AND calendar_id = ?',
      )
      .get(projectId, calendarId) as
      { definition: string; version: string | null; fetched_at: number } | undefined;
    return r ? { definition: parse(r.definition, null), version: r.version, fetchedAt: r.fetched_at } : null;
  }

  cacheCalendar(
    projectId: string,
    def: { id: string; name: string; version?: string | undefined },
    raw: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT INTO chronology_calendars (project_id, calendar_id, name, version, definition, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, calendar_id) DO UPDATE SET name = excluded.name, version = excluded.version,
           definition = excluded.definition, fetched_at = excluded.fetched_at`,
      )
      .run(projectId, def.id, def.name, def.version ?? null, json(raw), this.now());
  }

  // ------------------------------------------------------------------------------------------ records

  begin(
    projectId: string,
    r: {
      readonly tool: ChronologyTool;
      readonly requestKey: string;
      readonly ages: readonly string[];
      readonly summary: string;
      readonly target: ChronologyTarget;
      readonly observed: ChronologyRecord['observed'];
      readonly principalId: string;
      readonly approver: string | null;
      readonly jobId: string;
      readonly proposalId: string | null;
      readonly resumeOf?: number;
      readonly detail?: Obj;
    },
  ): ChronologyRecord {
    const now = this.now();
    if (r.resumeOf !== undefined) {
      const prev = this.get(projectId, r.resumeOf);
      if (prev && prev.state === 'incomplete') {
        const jobs = prev.jobs.includes(r.jobId) ? prev.jobs : [...prev.jobs, r.jobId];
        // The first job's counts stay: they are what resuming is checked against.
        const observed = {
          ...r.observed,
          ...prev.observed,
          counts: { ...r.observed.counts, ...prev.observed.counts },
        };
        this.db
          .prepare(
            'UPDATE chronology_records SET job_id = ?, jobs = ?, observed = ?, updated_at = ? WHERE id = ?',
          )
          .run(r.jobId, json(jobs), json(observed), now, prev.id);
        return this.get(projectId, prev.id)!;
      }
    }
    // A restarted job runs its begin step again: the same record.
    const same = this.byJob(projectId, r.jobId);
    if (same) return same;
    const res = this.db
      .prepare(
        `INSERT INTO chronology_records (project_id, tool, request_key, ages, summary, target, observed, state, job_id,
           jobs, principal_id, approver, proposal_id, detail, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'incomplete', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        r.tool,
        r.requestKey,
        json(r.ages),
        r.summary,
        json(r.target),
        json(r.observed),
        r.jobId,
        json([r.jobId]),
        r.principalId,
        r.approver,
        r.proposalId,
        json(r.detail ?? {}),
        now,
        now,
      );
    return this.get(projectId, Number(res.lastInsertRowid))!;
  }

  complete(projectId: string, id: number, extra: Obj = {}): ChronologyRecord | null {
    const rec = this.get(projectId, id);
    if (!rec) return null;
    const now = this.now();
    this.db
      .prepare(
        "UPDATE chronology_records SET state = 'complete', detail = ?, updated_at = ?, completed_at = ? WHERE id = ?",
      )
      .run(json({ ...rec.detail, ...extra }), now, now, id);
    return this.get(projectId, id);
  }

  /** The owner's "mark resolved" (after fixing a stopped change by hand). */
  resolve(projectId: string, id: number, by: string): ChronologyRecord | null {
    const rec = this.get(projectId, id);
    if (!rec || rec.state !== 'incomplete') return rec;
    const now = this.now();
    this.db
      .prepare("UPDATE chronology_records SET state = 'resolved', detail = ?, updated_at = ? WHERE id = ?")
      .run(json({ ...rec.detail, resolvedBy: by, resolvedAt: now }), now, id);
    return this.get(projectId, id);
  }

  get(projectId: string, id: number): ChronologyRecord | null {
    const r = this.db
      .prepare('SELECT * FROM chronology_records WHERE project_id = ? AND id = ?')
      .get(projectId, id) as RecordRow | undefined;
    return r ? recordOf(r) : null;
  }

  byJob(projectId: string, jobId: string): ChronologyRecord | null {
    const r = this.db
      .prepare(
        'SELECT * FROM chronology_records WHERE project_id = ? AND job_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(projectId, jobId) as RecordRow | undefined;
    return r ? recordOf(r) : null;
  }

  /** Every incomplete record of a project (a stopped change waits on the ages it touches). */
  incomplete(projectId: string): ChronologyRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM chronology_records WHERE project_id = ? AND state = 'incomplete' ORDER BY id")
        .all(projectId) as RecordRow[]
    ).map(recordOf);
  }

  recent(projectId: string, o: { limit: number; offset?: number }): ChronologyRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM chronology_records WHERE project_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
        .all(projectId, o.limit, o.offset ?? 0) as RecordRow[]
    ).map(recordOf);
  }

  count(projectId: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM chronology_records WHERE project_id = ?').get(projectId) as {
        n: number;
      }
    ).n;
  }

  // ------------------------------------------------------------------------------------------ links

  link(projectId: string, l: ChronologyLink): void {
    this.db
      .prepare(
        `INSERT INTO chronology_links (project_id, table_document_id, row_id, timeline_document_id, event_id, age, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, table_document_id, row_id) DO UPDATE SET timeline_document_id = excluded.timeline_document_id,
           event_id = excluded.event_id, age = excluded.age, updated_at = excluded.updated_at`,
      )
      .run(projectId, l.tableDocumentId, l.rowId, l.timelineDocumentId, l.eventId, l.age, this.now());
  }

  unlink(projectId: string, tableDocumentId: string, rowId: string): void {
    this.db
      .prepare('DELETE FROM chronology_links WHERE project_id = ? AND table_document_id = ? AND row_id = ?')
      .run(projectId, tableDocumentId, rowId);
  }

  links(projectId: string, tableDocumentId?: string): ChronologyLink[] {
    const rows = (
      tableDocumentId
        ? this.db
            .prepare('SELECT * FROM chronology_links WHERE project_id = ? AND table_document_id = ?')
            .all(projectId, tableDocumentId)
        : this.db.prepare('SELECT * FROM chronology_links WHERE project_id = ?').all(projectId)
    ) as {
      table_document_id: string;
      row_id: string;
      timeline_document_id: string;
      event_id: string;
      age: string;
    }[];
    return rows.map((r) => ({
      tableDocumentId: r.table_document_id,
      rowId: r.row_id,
      timelineDocumentId: r.timeline_document_id,
      eventId: r.event_id,
      age: r.age,
    }));
  }

  // ------------------------------------------------------------------------------------------ checks

  startCheck(projectId: string, trigger: string): CheckRun {
    const res = this.db
      .prepare(
        "INSERT INTO chronology_checks (project_id, trigger, state, started_at) VALUES (?, ?, 'running', ?)",
      )
      .run(projectId, trigger, this.now());
    return this.check(projectId, Number(res.lastInsertRowid))!;
  }

  finishCheck(
    projectId: string,
    id: number,
    o: {
      state: 'succeeded' | 'failed';
      requests: number;
      summary: string;
      findings: readonly CheckFinding[];
      ages: readonly Obj[];
      error?: string;
    },
  ): CheckRun | null {
    this.db
      .prepare(
        `UPDATE chronology_checks SET state = ?, requests = ?, summary = ?, findings = ?, ages = ?, error = ?, finished_at = ?
         WHERE project_id = ? AND id = ?`,
      )
      .run(
        o.state,
        o.requests,
        o.summary,
        json(o.findings),
        json(o.ages),
        o.error ?? null,
        this.now(),
        projectId,
        id,
      );
    return this.check(projectId, id);
  }

  check(projectId: string, id: number): CheckRun | null {
    const r = this.db
      .prepare('SELECT * FROM chronology_checks WHERE project_id = ? AND id = ?')
      .get(projectId, id) as CheckRow | undefined;
    return r ? checkOf(r) : null;
  }

  lastCheck(projectId: string): CheckRun | null {
    const r = this.db
      .prepare('SELECT * FROM chronology_checks WHERE project_id = ? ORDER BY id DESC LIMIT 1')
      .get(projectId) as CheckRow | undefined;
    return r ? checkOf(r) : null;
  }

  runningCheck(projectId: string): CheckRun | null {
    const r = this.db
      .prepare(
        "SELECT * FROM chronology_checks WHERE project_id = ? AND state = 'running' ORDER BY id DESC LIMIT 1",
      )
      .get(projectId) as CheckRow | undefined;
    return r ? checkOf(r) : null;
  }

  /** A check left running by a restart is closed as failed. */
  closeStaleChecks(projectId: string): void {
    this.db
      .prepare(
        "UPDATE chronology_checks SET state = 'failed', error = 'interrupted (the bridge stopped)', finished_at = ? WHERE project_id = ? AND state = 'running'",
      )
      .run(this.now(), projectId);
  }
}
