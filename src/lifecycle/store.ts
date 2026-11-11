/**
 * The lifecycle record and the link index (v2 C2c, ADR 0035; migration 1600). Synchronous, like every other store.
 *
 * - `lifecycle_records`: one row per lifecycle change, never pruned. Written by the change's own job (the bridge's
 *   `bridge.record` step): `begin` when it starts (incomplete), `complete` at its end. A resumed change keeps its row
 *   and adds its new job to `jobs`.
 * - `link_index`: which page links to which (a link collection, or a mention in a document), with when it was seen.
 */
import type { Db } from '../db/open.js';

export type LifecycleAction = 'archive' | 'unarchive' | 'move_to_working' | 'promote';
export type LifecycleState = 'authoritative' | 'working' | 'archived' | 'unknown';

/** The five lifecycle facts, by role, as they were (null: the page had no such row, or it was empty). */
export interface LifecycleFacts {
  readonly status: string | null;
  readonly continuityType: string | null;
  readonly scope: string | null;
  readonly temporalScope: string | null;
  readonly lastMajorRevision: string | null;
}

/** What a change aims at (and resumes towards). */
export interface LifecycleTarget {
  readonly name: string;
  readonly parentId: string;
  /** Each fact's value to write: text, or null to remove the row (a restore of a fact the page did not have). */
  readonly facts: Readonly<Partial<Record<keyof LifecycleFacts, string | null>>>;
  readonly tagsRemove: readonly string[];
  readonly tagsAdd: readonly string[];
  /** Archive: the note to insert. Unarchive: the note to remove (only if unchanged). */
  readonly note?: {
    readonly action: 'insert' | 'remove';
    readonly blockId: string;
    readonly documentId: string;
    readonly block?: Readonly<Record<string, unknown>>;
  };
  /** promote_page of a Working character: its index moves with it. */
  readonly moveIndex?: { readonly id: string; readonly name: string; readonly parentId: string } | null;
}

/** The record as the bridge's `bridge.record` step writes it when the change's job starts. */
export interface LifecycleRecordInput {
  readonly pageId: string;
  readonly pageName: string;
  readonly action: LifecycleAction;
  readonly date: string;
  readonly previousState: LifecycleState;
  readonly previousParentId: string | null;
  readonly previousRank: string | null;
  readonly previousName: string;
  readonly previousPrefix: string;
  readonly previousFacts: LifecycleFacts;
  readonly tagsRemoved: readonly string[];
  readonly tagsAdded: readonly string[];
  readonly noteBlockId?: string | null;
  readonly noteContent?: unknown;
  readonly target: LifecycleTarget;
  readonly detail?: Readonly<Record<string, unknown>>;
  /** C2d (ADR 0037): the set record this page's record belongs to (a whole-set change), or absent. */
  readonly setId?: number | null;
}

export interface LifecycleRecord extends LifecycleRecordInput {
  readonly id: number;
  readonly projectId: string;
  readonly principalId: string;
  readonly approver: string | null;
  readonly jobId: string | null;
  readonly jobs: readonly string[];
  readonly proposalId: string | null;
  readonly state: 'incomplete' | 'complete';
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
}

interface RecordRow {
  id: number;
  project_id: string;
  page_id: string;
  page_name: string;
  action: LifecycleAction;
  date: string;
  principal_id: string;
  approver: string | null;
  job_id: string | null;
  jobs: string;
  proposal_id: string | null;
  state: 'incomplete' | 'complete';
  previous_state: LifecycleState;
  previous_parent_id: string | null;
  previous_rank: string | null;
  previous_name: string;
  previous_prefix: string;
  previous_facts: string;
  tags_removed: string;
  tags_added: string;
  note_block_id: string | null;
  note_content: string | null;
  target: string;
  detail: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  set_id?: number | null;
}

function parse<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

const EMPTY_FACTS: LifecycleFacts = {
  status: null,
  continuityType: null,
  scope: null,
  temporalScope: null,
  lastMajorRevision: null,
};

function toRecord(r: RecordRow): LifecycleRecord {
  return {
    id: r.id,
    projectId: r.project_id,
    pageId: r.page_id,
    pageName: r.page_name,
    action: r.action,
    date: r.date,
    principalId: r.principal_id,
    approver: r.approver,
    jobId: r.job_id,
    jobs: parse<string[]>(r.jobs, []),
    proposalId: r.proposal_id,
    state: r.state,
    previousState: r.previous_state,
    previousParentId: r.previous_parent_id,
    previousRank: r.previous_rank,
    previousName: r.previous_name,
    previousPrefix: r.previous_prefix,
    previousFacts: { ...EMPTY_FACTS, ...parse<Partial<LifecycleFacts>>(r.previous_facts, {}) },
    tagsRemoved: parse<string[]>(r.tags_removed, []),
    tagsAdded: parse<string[]>(r.tags_added, []),
    noteBlockId: r.note_block_id,
    noteContent: parse<unknown>(r.note_content, null),
    target: parse<LifecycleTarget>(r.target, {
      name: '',
      parentId: '',
      facts: {},
      tagsRemove: [],
      tagsAdd: [],
    }),
    detail: parse<Record<string, unknown>>(r.detail, {}),
    setId: r.set_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
  };
}

// ============================================================================================ sets (C2d, ADR 0037)

/** One page of a set, as captured. `role`: an index (no lifecycle state of its own) or a content page. */
export interface SetPage {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly kind: string;
  readonly role: 'index' | 'page';
}

/** What a set change aims at: where its root goes, the state its content pages take, and each page's own target. */
export interface SetTarget {
  readonly parentId: string;
  readonly state: 'authoritative' | 'working' | 'archived';
  readonly pages: Readonly<Record<string, LifecycleTarget>>;
}

export interface LifecycleSetInput {
  readonly rootId: string;
  readonly rootName: string;
  readonly action: LifecycleAction;
  readonly date: string;
  readonly previousState: LifecycleState;
  readonly previousParentId: string | null;
  readonly previousRank: string | null;
  readonly pages: readonly SetPage[];
  readonly target: SetTarget;
  readonly summary?: Readonly<Record<string, unknown>>;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface LifecycleSet extends LifecycleSetInput {
  readonly id: number;
  readonly projectId: string;
  readonly principalId: string;
  readonly approver: string | null;
  readonly jobId: string | null;
  readonly jobs: readonly string[];
  readonly proposalId: string | null;
  readonly state: 'incomplete' | 'complete';
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
}

interface SetRow {
  id: number;
  project_id: string;
  root_id: string;
  root_name: string;
  action: LifecycleAction;
  date: string;
  principal_id: string;
  approver: string | null;
  job_id: string | null;
  jobs: string;
  proposal_id: string | null;
  state: 'incomplete' | 'complete';
  previous_state: LifecycleState;
  previous_parent_id: string | null;
  previous_rank: string | null;
  pages: string;
  target: string;
  summary: string | null;
  detail: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

function toSet(r: SetRow): LifecycleSet {
  return {
    id: r.id,
    projectId: r.project_id,
    rootId: r.root_id,
    rootName: r.root_name,
    action: r.action,
    date: r.date,
    principalId: r.principal_id,
    approver: r.approver,
    jobId: r.job_id,
    jobs: parse<string[]>(r.jobs, []),
    proposalId: r.proposal_id,
    state: r.state,
    previousState: r.previous_state,
    previousParentId: r.previous_parent_id,
    previousRank: r.previous_rank,
    pages: parse<SetPage[]>(r.pages, []),
    target: parse<SetTarget>(r.target, { parentId: '', state: 'archived', pages: {} }),
    summary: parse<Record<string, unknown>>(r.summary, {}),
    detail: parse<Record<string, unknown>>(r.detail, {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
  };
}

/** One link of the index. */
export interface LinkRow {
  readonly fromId: string;
  readonly kind: 'collection' | 'mention';
  /** The collection's title, or the document's id. */
  readonly via: string;
  readonly toId: string;
  readonly viaName: string | null;
  readonly seenAt: number;
  readonly source: 'write' | 'sweep';
}

/** One outgoing link, as a page's sidebar or a document shows it. */
export interface FoundLink {
  readonly kind: 'collection' | 'mention';
  readonly via: string;
  readonly viaName?: string | null;
  readonly toId: string;
}

export interface SweepRow {
  readonly id: string;
  readonly projectId: string;
  readonly status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly finishedAt: number | null;
  readonly cursor: string | null;
  readonly pagesTotal: number | null;
  readonly pagesDone: number;
  readonly documentsRead: number;
  readonly requests: number;
  readonly links: number;
  readonly error: string | null;
}

export class LifecycleStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  // ============================================================================================ records

  /** `bridge.record` begin: a new incomplete record, or (a resume) the existing one with this job added. */
  begin(
    projectId: string,
    input: LifecycleRecordInput & {
      readonly principalId: string;
      readonly approver: string | null;
      readonly jobId: string;
      readonly proposalId: string | null;
      /** A resume names the record it continues. */
      readonly resumeOf?: number;
    },
  ): LifecycleRecord {
    const at = this.now();
    if (input.resumeOf !== undefined) {
      const had = this.record(projectId, input.resumeOf);
      if (!had) throw new Error(`lifecycle record ${input.resumeOf} is not in project ${projectId}`);
      const jobs = had.jobs.includes(input.jobId) ? had.jobs : [...had.jobs, input.jobId];
      this.db
        .prepare(
          `UPDATE lifecycle_records SET job_id = ?, jobs = ?, approver = COALESCE(?, approver),
             proposal_id = COALESCE(?, proposal_id), state = 'incomplete', updated_at = ?,
             detail = ? WHERE project_id = ? AND id = ?`,
        )
        .run(
          input.jobId,
          JSON.stringify(jobs),
          input.approver,
          input.proposalId,
          at,
          JSON.stringify({ ...(had.detail ?? {}), ...(input.detail ?? {}), resumed: true }),
          projectId,
          input.resumeOf,
        );
      return this.record(projectId, input.resumeOf)!;
    }
    // The same job starting again (a restart re-runs this step): the row it already wrote.
    const again = this.db
      .prepare('SELECT * FROM lifecycle_records WHERE project_id = ? AND job_id = ? AND page_id = ?')
      .get(projectId, input.jobId, input.pageId) as RecordRow | undefined;
    if (again) return toRecord(again);
    const r = this.db
      .prepare(
        `INSERT INTO lifecycle_records (project_id, page_id, page_name, action, date, principal_id, approver, job_id,
           jobs, proposal_id, state, previous_state, previous_parent_id, previous_rank, previous_name, previous_prefix,
           previous_facts, tags_removed, tags_added, note_block_id, note_content, target, detail, created_at, updated_at,
           set_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'incomplete', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        input.pageId,
        input.pageName.slice(0, 500),
        input.action,
        input.date,
        input.principalId,
        input.approver,
        input.jobId,
        JSON.stringify([input.jobId]),
        input.proposalId,
        input.previousState,
        input.previousParentId,
        input.previousRank,
        input.previousName,
        input.previousPrefix,
        JSON.stringify(input.previousFacts),
        JSON.stringify(input.tagsRemoved),
        JSON.stringify(input.tagsAdded),
        input.noteBlockId ?? null,
        input.noteContent === undefined ? null : JSON.stringify(input.noteContent),
        JSON.stringify(input.target),
        input.detail ? JSON.stringify(input.detail) : null,
        at,
        at,
        input.setId ?? null,
      );
    return this.record(projectId, Number(r.lastInsertRowid))!;
  }

  // ------------------------------------------------------------------------------------------ sets (C2d)

  /**
   * `bridge.record` begin_set: the set record and one record per page (linked to it), incomplete, in one transaction;
   * or (a resume, `resumeOf` naming the set) the existing ones with this job added. The same job starting again (a
   * restart re-runs this step) gets the rows it already wrote.
   */
  beginSet(
    projectId: string,
    input: LifecycleSetInput & {
      readonly principalId: string;
      readonly approver: string | null;
      readonly jobId: string;
      readonly proposalId: string | null;
      readonly resumeOf?: number;
      readonly records: readonly LifecycleRecordInput[];
    },
  ): { set: LifecycleSet; records: LifecycleRecord[] } {
    return this.db.transaction(() => {
      const at = this.now();
      if (input.resumeOf !== undefined) {
        const had = this.set(projectId, input.resumeOf);
        if (!had) throw new Error(`lifecycle set ${input.resumeOf} is not in project ${projectId}`);
        const jobs = had.jobs.includes(input.jobId) ? had.jobs : [...had.jobs, input.jobId];
        this.db
          .prepare(
            `UPDATE lifecycle_sets SET job_id = ?, jobs = ?, approver = COALESCE(?, approver),
               proposal_id = COALESCE(?, proposal_id), state = 'incomplete', updated_at = ?, detail = ?
             WHERE project_id = ? AND id = ?`,
          )
          .run(
            input.jobId,
            JSON.stringify(jobs),
            input.approver,
            input.proposalId,
            at,
            JSON.stringify({ ...(had.detail ?? {}), ...(input.detail ?? {}), resumed: true }),
            projectId,
            had.id,
          );
        for (const rec of this.setRecords(projectId, had.id)) {
          if (rec.state === 'complete' && rec.jobs.length > 0) continue;
          this.begin(projectId, {
            ...rec,
            principalId: input.principalId,
            approver: input.approver,
            jobId: input.jobId,
            proposalId: input.proposalId,
            resumeOf: rec.id,
          });
        }
        return { set: this.set(projectId, had.id)!, records: this.setRecords(projectId, had.id) };
      }
      const again = this.db
        .prepare('SELECT * FROM lifecycle_sets WHERE project_id = ? AND job_id = ? AND root_id = ?')
        .get(projectId, input.jobId, input.rootId) as SetRow | undefined;
      if (again) return { set: toSet(again), records: this.setRecords(projectId, again.id) };
      const r = this.db
        .prepare(
          `INSERT INTO lifecycle_sets (project_id, root_id, root_name, action, date, principal_id, approver, job_id, jobs,
             proposal_id, state, previous_state, previous_parent_id, previous_rank, pages, target, summary, detail,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'incomplete', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          projectId,
          input.rootId,
          input.rootName.slice(0, 500),
          input.action,
          input.date,
          input.principalId,
          input.approver,
          input.jobId,
          JSON.stringify([input.jobId]),
          input.proposalId,
          input.previousState,
          input.previousParentId,
          input.previousRank,
          JSON.stringify(input.pages),
          JSON.stringify(input.target),
          input.summary ? JSON.stringify(input.summary) : null,
          input.detail ? JSON.stringify(input.detail) : null,
          at,
          at,
        );
      const setId = Number(r.lastInsertRowid);
      for (const rec of input.records) {
        this.begin(projectId, {
          ...rec,
          setId,
          principalId: input.principalId,
          approver: input.approver,
          jobId: input.jobId,
          proposalId: input.proposalId,
        });
      }
      return { set: this.set(projectId, setId)!, records: this.setRecords(projectId, setId) };
    })();
  }

  /** `bridge.record` complete_set: the set and every page's record are done. */
  completeSet(
    projectId: string,
    id: number,
    detail?: Readonly<Record<string, unknown>>,
  ): LifecycleSet | null {
    const had = this.set(projectId, id);
    if (!had) return null;
    return this.db.transaction(() => {
      const at = this.now();
      this.db
        .prepare(
          `UPDATE lifecycle_sets SET state = 'complete', completed_at = ?, updated_at = ?, detail = ?
           WHERE project_id = ? AND id = ?`,
        )
        .run(at, at, JSON.stringify({ ...(had.detail ?? {}), ...(detail ?? {}) }), projectId, id);
      for (const rec of this.setRecords(projectId, id))
        if (rec.state !== 'complete') this.complete(projectId, rec.id, detail);
      return this.set(projectId, id);
    })();
  }

  set(projectId: string, id: number): LifecycleSet | null {
    const r = this.db
      .prepare('SELECT * FROM lifecycle_sets WHERE project_id = ? AND id = ?')
      .get(projectId, id) as SetRow | undefined;
    return r ? toSet(r) : null;
  }

  /** The set a job is working on. */
  setByJob(projectId: string, jobId: string): LifecycleSet | null {
    const r = this.db
      .prepare('SELECT * FROM lifecycle_sets WHERE project_id = ? AND job_id = ? ORDER BY id DESC LIMIT 1')
      .get(projectId, jobId) as SetRow | undefined;
    return r ? toSet(r) : null;
  }

  /** The page records of a set, in page order. */
  setRecords(projectId: string, setId: number): LifecycleRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM lifecycle_records WHERE project_id = ? AND set_id = ? ORDER BY id')
        .all(projectId, setId) as RecordRow[]
    ).map(toRecord);
  }

  /** A root's newest set records (complete or not), newest first. */
  setsForRoot(projectId: string, rootId: string, limit = 20): LifecycleSet[] {
    return (
      this.db
        .prepare('SELECT * FROM lifecycle_sets WHERE project_id = ? AND root_id = ? ORDER BY id DESC LIMIT ?')
        .all(projectId, rootId, limit) as SetRow[]
    ).map(toSet);
  }

  /** The newest set records of a project (the dashboard). */
  recentSets(projectId: string, o: { limit?: number; offset?: number } = {}): LifecycleSet[] {
    return (
      this.db
        .prepare('SELECT * FROM lifecycle_sets WHERE project_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
        .all(projectId, o.limit ?? 100, o.offset ?? 0) as SetRow[]
    ).map(toSet);
  }

  /** `bridge.record` complete: the change is done. */
  complete(
    projectId: string,
    id: number,
    detail?: Readonly<Record<string, unknown>>,
  ): LifecycleRecord | null {
    const had = this.record(projectId, id);
    if (!had) return null;
    const at = this.now();
    this.db
      .prepare(
        `UPDATE lifecycle_records SET state = 'complete', completed_at = ?, updated_at = ?, detail = ?
         WHERE project_id = ? AND id = ?`,
      )
      .run(at, at, JSON.stringify({ ...(had.detail ?? {}), ...(detail ?? {}) }), projectId, id);
    return this.record(projectId, id);
  }

  record(projectId: string, id: number): LifecycleRecord | null {
    const r = this.db
      .prepare('SELECT * FROM lifecycle_records WHERE project_id = ? AND id = ?')
      .get(projectId, id) as RecordRow | undefined;
    return r ? toRecord(r) : null;
  }

  /** The record a job is working on (the job named in `job_id`). */
  byJob(projectId: string, jobId: string): LifecycleRecord | null {
    const r = this.db
      .prepare('SELECT * FROM lifecycle_records WHERE project_id = ? AND job_id = ? ORDER BY id DESC LIMIT 1')
      .get(projectId, jobId) as RecordRow | undefined;
    return r ? toRecord(r) : null;
  }

  /** A page's records, newest first. */
  forPage(projectId: string, pageId: string, limit = 50): LifecycleRecord[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM lifecycle_records WHERE project_id = ? AND page_id = ? ORDER BY id DESC LIMIT ?',
        )
        .all(projectId, pageId, limit) as RecordRow[]
    ).map(toRecord);
  }

  /** The page's newest record of these actions (complete or not). */
  latest(projectId: string, pageId: string, actions: readonly LifecycleAction[]): LifecycleRecord | null {
    return this.forPage(projectId, pageId).find((r) => actions.includes(r.action)) ?? null;
  }

  /** The page's newest record that is still incomplete, if any. */
  incomplete(projectId: string, pageId: string): LifecycleRecord | null {
    const r = this.db
      .prepare(
        "SELECT * FROM lifecycle_records WHERE project_id = ? AND page_id = ? AND state = 'incomplete' ORDER BY id DESC LIMIT 1",
      )
      .get(projectId, pageId) as RecordRow | undefined;
    return r ? toRecord(r) : null;
  }

  /** The newest records of a project (the dashboard's "Archive and lifecycle" list). */
  recent(projectId: string, o: { limit?: number; offset?: number } = {}): LifecycleRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM lifecycle_records WHERE project_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
        .all(projectId, o.limit ?? 100, o.offset ?? 0) as RecordRow[]
    ).map(toRecord);
  }

  count(projectId: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM lifecycle_records WHERE project_id = ?').get(projectId) as {
        n: number;
      }
    ).n;
  }

  // ============================================================================================ the link index

  /**
   * Replaces what one source of a page links to: its link collections (`sidebar`: every `collection` row of the page)
   * or one document (`document`: every `mention` row via that document). Run in one transaction.
   */
  replaceLinks(
    projectId: string,
    fromId: string,
    source:
      | { readonly kind: 'sidebar' }
      | { readonly kind: 'collection'; readonly title: string }
      | {
          readonly kind: 'document';
          readonly documentId: string;
        },
    links: readonly FoundLink[],
    by: 'write' | 'sweep',
    at: number = this.now(),
  ): void {
    const del =
      source.kind === 'sidebar'
        ? this.db.prepare(
            "DELETE FROM link_index WHERE project_id = ? AND from_id = ? AND kind = 'collection'",
          )
        : source.kind === 'collection'
          ? this.db.prepare(
              "DELETE FROM link_index WHERE project_id = ? AND from_id = ? AND kind = 'collection' AND via = ?",
            )
          : this.db.prepare(
              "DELETE FROM link_index WHERE project_id = ? AND from_id = ? AND kind = 'mention' AND via = ?",
            );
    const ins = this.db.prepare(
      `INSERT OR REPLACE INTO link_index (project_id, from_id, kind, via, to_id, via_name, seen_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      if (source.kind === 'sidebar') del.run(projectId, fromId);
      else if (source.kind === 'collection') del.run(projectId, fromId, source.title);
      else del.run(projectId, fromId, source.documentId);
      for (const l of links) {
        if (l.toId === fromId) continue;
        ins.run(projectId, fromId, l.kind, l.via, l.toId, l.viaName ?? null, at, by);
      }
    })();
  }

  /** Adds links (an inserted block's mentions) without removing any. */
  addLinks(projectId: string, fromId: string, links: readonly FoundLink[], by: 'write' | 'sweep'): void {
    const at = this.now();
    const ins = this.db.prepare(
      `INSERT OR REPLACE INTO link_index (project_id, from_id, kind, via, to_id, via_name, seen_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const l of links) {
        if (l.toId !== fromId) ins.run(projectId, fromId, l.kind, l.via, l.toId, l.viaName ?? null, at, by);
      }
    })();
  }

  /** Removes every link from these pages (deleted), or via one document of a page (deleted). */
  removeFrom(projectId: string, fromIds: readonly string[]): void {
    const del = this.db.prepare('DELETE FROM link_index WHERE project_id = ? AND from_id = ?');
    this.db.transaction(() => {
      for (const id of fromIds) del.run(projectId, id);
    })();
  }

  /** Drops a page's mention rows of documents it no longer has. */
  retainDocuments(projectId: string, fromId: string, documentIds: readonly string[]): void {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT via FROM link_index WHERE project_id = ? AND from_id = ? AND kind = 'mention'",
      )
      .all(projectId, fromId) as { via: string }[];
    for (const r of rows) if (!documentIds.includes(r.via)) this.removeDocument(projectId, fromId, r.via);
  }

  /** Whether the index holds a mention row via this document (a partial block write then re-reads it). */
  hasMentionsVia(projectId: string, fromId: string, documentId: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM link_index WHERE project_id = ? AND from_id = ? AND kind = 'mention' AND via = ? LIMIT 1",
        )
        .get(projectId, fromId, documentId) !== undefined
    );
  }

  removeDocument(projectId: string, fromId: string, documentId: string): void {
    this.db
      .prepare("DELETE FROM link_index WHERE project_id = ? AND from_id = ? AND kind = 'mention' AND via = ?")
      .run(projectId, fromId, documentId);
  }

  /** The links TO a page (who links to it), newest first. */
  linksTo(projectId: string, toId: string, limit = 500): LinkRow[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM link_index WHERE project_id = ? AND to_id = ? ORDER BY from_id, kind, via LIMIT ?',
        )
        .all(projectId, toId, limit) as {
        from_id: string;
        kind: 'collection' | 'mention';
        via: string;
        to_id: string;
        via_name: string | null;
        seen_at: number;
        source: 'write' | 'sweep';
      }[]
    ).map((r) => ({
      fromId: r.from_id,
      kind: r.kind,
      via: r.via,
      toId: r.to_id,
      viaName: r.via_name,
      seenAt: r.seen_at,
      source: r.source,
    }));
  }

  linkCount(projectId: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM link_index WHERE project_id = ?').get(projectId) as {
        n: number;
      }
    ).n;
  }

  /** Removes rows a finished sweep did not see again (seen before it started, and not by a write since). */
  pruneBefore(projectId: string, t: number): number {
    return Number(
      this.db.prepare('DELETE FROM link_index WHERE project_id = ? AND seen_at < ?').run(projectId, t)
        .changes,
    );
  }

  // ============================================================================================ sweeps

  sweep(id: string): SweepRow | null {
    const r = this.db.prepare('SELECT * FROM link_sweeps WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    return r ? toSweep(r) : null;
  }

  runningSweep(projectId: string): SweepRow | null {
    const r = this.db
      .prepare("SELECT * FROM link_sweeps WHERE project_id = ? AND status = 'running'")
      .get(projectId) as Record<string, unknown> | undefined;
    return r ? toSweep(r) : null;
  }

  lastSweep(projectId: string, status: SweepRow['status'] | null = 'succeeded'): SweepRow | null {
    const r = (
      status === null
        ? this.db
            .prepare('SELECT * FROM link_sweeps WHERE project_id = ? ORDER BY started_at DESC LIMIT 1')
            .get(projectId)
        : this.db
            .prepare(
              'SELECT * FROM link_sweeps WHERE project_id = ? AND status = ? ORDER BY started_at DESC LIMIT 1',
            )
            .get(projectId, status)
    ) as Record<string, unknown> | undefined;
    return r ? toSweep(r) : null;
  }

  startSweep(id: string, projectId: string, total: number): SweepRow {
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO link_sweeps (id, project_id, status, started_at, updated_at, pages_total)
         VALUES (?, ?, 'running', ?, ?, ?)`,
      )
      .run(id, projectId, at, at, total);
    return this.sweep(id)!;
  }

  progressSweep(
    id: string,
    p: { cursor: string; pages: number; documents: number; requests: number; links: number },
  ): void {
    this.db
      .prepare(
        `UPDATE link_sweeps SET cursor = ?, pages_done = pages_done + ?, documents_read = documents_read + ?,
           requests = requests + ?, links = links + ?, updated_at = ? WHERE id = ?`,
      )
      .run(p.cursor, p.pages, p.documents, p.requests, p.links, this.now(), id);
  }

  /** A run of the pass stopped (the pass stays running, to be continued). */
  noteSweepError(id: string, error: string): void {
    this.db
      .prepare('UPDATE link_sweeps SET error = ?, updated_at = ? WHERE id = ?')
      .run(error.slice(0, 1000), this.now(), id);
  }

  finishSweep(id: string, status: 'succeeded' | 'failed' | 'interrupted', error: string | null = null): void {
    const at = this.now();
    this.db
      .prepare('UPDATE link_sweeps SET status = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ?')
      .run(status, error, at, at, id);
  }
}

function toSweep(r: Record<string, unknown>): SweepRow {
  const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0));
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    status: r.status as SweepRow['status'],
    startedAt: n(r.started_at),
    updatedAt: n(r.updated_at),
    finishedAt: r.finished_at == null ? null : n(r.finished_at),
    cursor: (r.cursor as string | null) ?? null,
    pagesTotal: r.pages_total == null ? null : n(r.pages_total),
    pagesDone: n(r.pages_done),
    documentsRead: n(r.documents_read),
    requests: n(r.requests),
    links: n(r.links),
    error: (r.error as string | null) ?? null,
  };
}
