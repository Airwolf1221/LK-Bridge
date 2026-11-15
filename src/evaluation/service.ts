/**
 * The Evaluation helper (v2 E3, ADR 0045): runs the scripted scenarios (docs/reviews/scenarios.json) and keeps what the
 * owner saw. Owner only (the dashboard's Tool calls page, `/api/admin/evaluation`); no agent tool reads or names it.
 *
 * How a scenario is recorded. The owner chooses an assistant (ChatGPT or Claude) and a set (core or all) and makes a
 * **run**. For each scenario the owner presses **Start**, pastes the prompt into a fresh chat, and presses **Done**. The
 * calls in between are NOT copied: the tool-call log already holds them. The scenario's result stores the window (the id
 * of the newest call when Start was pressed, the id of the newest when Done was), the connections it is about, and a
 * compact copy of the calls in that window (tool, outcome, code), so the result survives the log's pruning.
 *
 * - **Only the chosen assistant's calls count.** A window's calls are those with an id inside it AND made by the
 *   scenario's connections. With ChatGPT and Claude both connected, the other assistant's calls (and anything made
 *   before Start or after Done) are never in a result.
 * - **Which connections.** The owner may pick them for the run or for one scenario. Otherwise the classifier
 *   (src/evaluation/classify.ts) picks the active connections that are the chosen assistant's at Start; at Done it also
 *   takes in a connection of that assistant that made calls meanwhile (one made during the scenario). If it recognises
 *   none, Start is refused and says to pick one.
 * - **Recording must be on.** Start is refused when the log's retention is 0 days (nothing would be recorded).
 */
import { randomBytes } from 'node:crypto';
import type { Db } from '../db/open.js';
import type { PolicyStore } from '../policy/store.js';
import type { ToolCallLog, ToolCallRow } from '../toolcalls/index.js';
import { classifyConnection, type Classification, type ConnectionFacts } from './classify.js';
import { autoGrade, canonicalTool, type AutoGrade, type RecordedCall } from './grade.js';
import { compareRuns, type Comparison } from './compare.js';
import {
  ASSISTANTS,
  loadScenarios,
  promptsToCopy,
  scenariosFor,
  SCENARIO_SETS,
  type Assistant,
  type Scenario,
  type ScenarioFile,
  type ScenarioSet,
} from './scenarios.js';
import { buildResultsTable, formatToolSequence, type OwnerGrade } from './table.js';

export type EvaluationErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'RECORDING_OFF'
  | 'NO_CONNECTION'
  | 'RUN_FINISHED'
  | 'ALREADY_RECORDING'
  | 'WRONG_STATE'
  | 'UNKNOWN_CONNECTION';

export class EvaluationError extends Error {
  override readonly name = 'EvaluationError';
  constructor(
    readonly code: EvaluationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type ResultState = 'pending' | 'recording' | 'done';
export type RunStatus = 'in_progress' | 'finished';
export const OWNER_GRADES = ['right', 'partly', 'wrong'] as const;
const MAX_NOTE = 2000;

export interface EvaluationOptions {
  readonly db: Db;
  readonly log: ToolCallLog;
  readonly store: Pick<PolicyStore, 'listConnections' | 'getConnection' | 'getTombstone' | 'audit'>;
  /** The bridge's version (what bridge_info reports). */
  readonly version: string;
  readonly now?: () => number;
  /** Test seam: the scenarios (default: docs/reviews/scenarios.json). */
  readonly scenarios?: () => ScenarioFile;
}

export interface ResultView {
  readonly scenarioId: number;
  readonly title: string;
  readonly state: ResultState;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  /** The window: calls with an id above `startCallId` and up to `endCallId` (null while recording). */
  readonly startCallId: number | null;
  readonly endCallId: number | null;
  readonly principalIds: string[];
  readonly connectionMode: 'auto' | 'manual';
  readonly calls: RecordedCall[];
  /** The calls as the results table writes them (`guide ×3, search`), so the page and the table agree. */
  readonly sequence: string;
  readonly autoGrade: AutoGrade | null;
  readonly ownerGrade: OwnerGrade | null;
  readonly note: string;
  /** While recording: how many calls the window holds so far, and their tools. */
  readonly live?: { readonly callCount: number; readonly tools: string[] };
}

export interface RunSummary {
  readonly id: string;
  readonly createdAt: number;
  readonly assistant: Assistant;
  readonly set: ScenarioSet;
  readonly bridgeVersion: string;
  readonly status: RunStatus;
  readonly finishedAt: number | null;
  readonly progress: { readonly total: number; readonly done: number; readonly graded: number };
}

export interface RunView extends RunSummary {
  /** Connections the owner picked for the whole run; null when the classifier chooses at each Start. */
  readonly principalIds: string[] | null;
  readonly results: ResultView[];
}

export interface EvaluationConnection {
  readonly id: string;
  readonly name: string;
  readonly type: 'grant' | 'pat';
  readonly profile: string | null;
  readonly scope: string | null;
  readonly active: boolean;
  /** Gone from Clients & Access, but it made calls that are still in the log. */
  readonly removed: boolean;
  readonly lastUsedAt: number | null;
  /** Calls of this connection in the log now, and the time of the newest. */
  readonly calls: number;
  readonly lastCallAt: number | null;
  readonly assistant: Assistant | null;
  readonly reason: string;
}

interface RunRow {
  id: string;
  created_at: number;
  assistant: Assistant;
  scenario_set: ScenarioSet;
  bridge_version: string;
  status: RunStatus;
  finished_at: number | null;
  principal_ids: string | null;
}

interface ResultRow {
  run_id: string;
  scenario_id: number;
  title: string;
  state: ResultState;
  started_at: number | null;
  finished_at: number | null;
  start_call_id: number | null;
  end_call_id: number | null;
  principal_ids: string;
  connection_mode: 'auto' | 'manual';
  calls: string;
  auto_grade: string | null;
  owner_grade: OwnerGrade | null;
  note: string;
}

const json = <T>(text: string | null, fallback: T): T => {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

/** What a run keeps of a logged call. */
export function recordCall(r: ToolCallRow): RecordedCall {
  const live = r.args.find((a) => a.name === 'live' && a.type === 'boolean')?.value;
  return {
    tool: r.tool,
    outcome: r.outcome,
    code: r.code,
    ...(typeof live === 'boolean' && canonicalTool(r.tool) === 'get_resource' ? { live } : {}),
    ...(r.noBaseVersion ? { noBase: true as const } : {}),
  };
}

export class Evaluation {
  private readonly now: () => number;
  private readonly scenarioFile: () => ScenarioFile;

  constructor(private readonly o: EvaluationOptions) {
    this.now = o.now ?? (() => Date.now());
    this.scenarioFile = o.scenarios ?? loadScenarios;
  }

  // ------------------------------------------------------------------------------------------ scenarios

  /** The scenarios with what the owner copies for each (the preamble in front of the first prompt of a fresh chat). */
  scenarios(): {
    preamble: string;
    scenarios: (Scenario & { copy: string[] })[];
    coreIds: number[];
  } {
    const f = this.scenarioFile();
    return {
      preamble: f.preamble,
      scenarios: f.scenarios.map((s) => ({ ...s, copy: promptsToCopy(f, s) })),
      coreIds: f.scenarios.filter((s) => s.core).map((s) => s.id),
    };
  }

  // ----------------------------------------------------------------------------------------- connections

  private redirectUris(clientId: string | null): string[] {
    if (clientId === null) return [];
    const r = this.o.db
      .prepare('SELECT redirect_uris FROM auth_clients WHERE client_id = ?')
      .get(clientId) as { redirect_uris: string } | undefined;
    const list = json<unknown>(r?.redirect_uris ?? null, []);
    return Array.isArray(list) ? list.filter((u): u is string => typeof u === 'string') : [];
  }

  /** Classifies a connection by id, live or removed (a removed one by its tombstone); null when nothing is known. */
  classifyId(id: string): Classification {
    const live = this.o.store.getConnection(id);
    const facts = live
      ? { type: live.type, label: live.label, clientId: live.clientId, profileLabel: live.profile }
      : (() => {
          const t = this.o.store.getTombstone(id);
          return t
            ? { type: t.type, label: t.label, clientId: t.clientId, profileLabel: t.profileLabel }
            : undefined;
        })();
    if (!facts) return { assistant: null, reason: 'no signal' };
    const c: ConnectionFacts = {
      type: facts.type,
      label: facts.label,
      redirectUris: this.redirectUris(facts.clientId),
      profileLabel: facts.profileLabel,
    };
    return classifyConnection(c);
  }

  /** Every connection that exists, and every one that made calls still in the log, with what the classifier made of it. */
  connections(): EvaluationConnection[] {
    const usage = new Map(
      (
        this.o.db
          .prepare(
            `SELECT principal_id AS id, COUNT(*) AS n, MAX(at) AS last FROM tool_calls
             WHERE principal_id IS NOT NULL GROUP BY principal_id`,
          )
          .all() as { id: string; n: number; last: number }[]
      ).map((r) => [r.id, r]),
    );
    const out: EvaluationConnection[] = [];
    const seen = new Set<string>();
    for (const c of this.o.store.listConnections()) {
      seen.add(c.id);
      const cls = this.classifyId(c.id);
      out.push({
        id: c.id,
        name: c.label,
        type: c.type,
        profile: c.profile,
        scope: c.scope,
        active: c.active,
        removed: false,
        lastUsedAt: c.lastUsedAt,
        calls: usage.get(c.id)?.n ?? 0,
        lastCallAt: usage.get(c.id)?.last ?? null,
        assistant: cls.assistant,
        reason: cls.reason,
      });
    }
    for (const [id, u] of usage) {
      if (seen.has(id)) continue;
      const t = this.o.store.getTombstone(id);
      const cls = this.classifyId(id);
      out.push({
        id,
        name: t?.label ?? 'Removed connection',
        type: t?.type ?? (id.startsWith('grant_') ? 'grant' : 'pat'),
        profile: t?.profileLabel ?? null,
        scope: null,
        active: false,
        removed: true,
        lastUsedAt: null,
        calls: u.n,
        lastCallAt: u.last,
        assistant: cls.assistant,
        reason: cls.reason,
      });
    }
    return out.sort((a, b) => (b.lastCallAt ?? 0) - (a.lastCallAt ?? 0) || a.name.localeCompare(b.name));
  }

  private knownConnection(id: string): boolean {
    return this.o.store.getConnection(id) !== undefined || this.o.store.getTombstone(id) !== undefined;
  }

  private checkedIds(ids: readonly string[]): string[] {
    const out = [...new Set(ids)];
    for (const id of out) {
      if (!this.knownConnection(id))
        throw new EvaluationError('UNKNOWN_CONNECTION', `There is no connection ${id.slice(0, 80)}.`);
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------- runs

  private runRow(id: string): RunRow {
    const r = this.o.db.prepare('SELECT * FROM evaluation_runs WHERE id = ?').get(id) as RunRow | undefined;
    if (!r) throw new EvaluationError('NOT_FOUND', 'There is no such evaluation run.');
    return r;
  }

  private resultRows(runId: string): ResultRow[] {
    return this.o.db
      .prepare('SELECT * FROM evaluation_results WHERE run_id = ? ORDER BY scenario_id')
      .all(runId) as ResultRow[];
  }

  private resultRow(runId: string, scenarioId: number): ResultRow {
    const r = this.o.db
      .prepare('SELECT * FROM evaluation_results WHERE run_id = ? AND scenario_id = ?')
      .get(runId, scenarioId) as ResultRow | undefined;
    if (!r) throw new EvaluationError('NOT_FOUND', `Scenario ${scenarioId} is not in this run.`);
    return r;
  }

  private summary(r: RunRow): RunSummary {
    const p = this.o.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(state = 'done') AS done, SUM(owner_grade IS NOT NULL) AS graded
         FROM evaluation_results WHERE run_id = ?`,
      )
      .get(r.id) as { total: number; done: number | null; graded: number | null };
    return {
      id: r.id,
      createdAt: r.created_at,
      assistant: r.assistant,
      set: r.scenario_set,
      bridgeVersion: r.bridge_version,
      status: r.status,
      finishedAt: r.finished_at,
      progress: { total: p.total, done: p.done ?? 0, graded: p.graded ?? 0 },
    };
  }

  private resultView(r: ResultRow): ResultView {
    const principalIds = json<string[]>(r.principal_ids, []);
    const calls = json<RecordedCall[]>(r.calls, []);
    const base: ResultView = {
      scenarioId: r.scenario_id,
      title: r.title,
      state: r.state,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      startCallId: r.start_call_id,
      endCallId: r.end_call_id,
      principalIds,
      connectionMode: r.connection_mode,
      calls,
      sequence: formatToolSequence(calls),
      autoGrade: json<AutoGrade | null>(r.auto_grade, null),
      ownerGrade: r.owner_grade,
      note: r.note,
    };
    if (r.state !== 'recording' || r.start_call_id === null) return base;
    const rows = this.o.log.window({ principalIds, afterId: r.start_call_id });
    return { ...base, live: { callCount: rows.length, tools: rows.map((x) => x.tool) } };
  }

  listRuns(): { runs: RunSummary[]; recording: boolean; retentionDays: number } {
    const rows = this.o.db
      .prepare('SELECT * FROM evaluation_runs ORDER BY created_at DESC, id DESC')
      .all() as RunRow[];
    const days = this.o.log.retentionDays();
    return { runs: rows.map((r) => this.summary(r)), recording: days > 0, retentionDays: days };
  }

  getRun(id: string): RunView {
    const run = this.runRow(id);
    return {
      ...this.summary(run),
      principalIds: run.principal_ids === null ? null : json<string[]>(run.principal_ids, []),
      results: this.resultRows(id).map((r) => this.resultView(r)),
    };
  }

  createRun(input: { assistant: Assistant; set: ScenarioSet; principalIds?: readonly string[] }): RunView {
    if (!ASSISTANTS.includes(input.assistant) || !SCENARIO_SETS.includes(input.set))
      throw new EvaluationError('INVALID_INPUT', 'Choose ChatGPT or Claude, and the core or all scenarios.');
    const picked =
      input.principalIds && input.principalIds.length > 0 ? this.checkedIds(input.principalIds) : null;
    const file = this.scenarioFile();
    const list = scenariosFor(file, input.set, input.assistant);
    const id = `evr_${randomBytes(9).toString('base64url').replace(/[-_]/g, 'x').toLowerCase()}`;
    const at = this.now();
    this.o.db.transaction(() => {
      this.o.db
        .prepare(
          `INSERT INTO evaluation_runs (id, created_at, assistant, scenario_set, bridge_version, status, principal_ids)
           VALUES (?, ?, ?, ?, ?, 'in_progress', ?)`,
        )
        .run(id, at, input.assistant, input.set, this.o.version, picked ? JSON.stringify(picked) : null);
      const ins = this.o.db.prepare(
        `INSERT INTO evaluation_results (run_id, scenario_id, title, state) VALUES (?, ?, ?, 'pending')`,
      );
      for (const s of list) ins.run(id, s.id, s.shortTitle);
    })();
    return this.getRun(id);
  }

  /** Owner command: removes a run and its results. Audited. */
  deleteRun(id: string, by = 'owner'): void {
    const run = this.runRow(id);
    const before = this.summary(run);
    this.o.db.prepare('DELETE FROM evaluation_runs WHERE id = ?').run(id);
    this.o.store.audit(by, 'evaluation.delete_run', id, {
      assistant: before.assistant,
      set: before.set,
      createdAt: before.createdAt,
      status: before.status,
      scenariosDone: before.progress.done,
    });
  }

  finishRun(id: string): RunView {
    const run = this.runRow(id);
    if (run.status === 'finished') return this.getRun(id);
    if (this.resultRows(id).some((r) => r.state === 'recording'))
      throw new EvaluationError(
        'ALREADY_RECORDING',
        'A scenario is still recording: press Done for it first.',
      );
    this.o.db
      .prepare(`UPDATE evaluation_runs SET status = 'finished', finished_at = ? WHERE id = ?`)
      .run(this.now(), id);
    return this.getRun(id);
  }

  // ------------------------------------------------------------------------------------ start, done

  private scenario(id: number): Scenario {
    const s = this.scenarioFile().scenarios.find((x) => x.id === id);
    if (!s) throw new EvaluationError('NOT_FOUND', `There is no scenario ${id}.`);
    return s;
  }

  /** The active connections that are `assistant`'s, as the classifier sees them. */
  private classifiedActive(assistant: Assistant): string[] {
    return this.o.store
      .listConnections()
      .filter((c) => c.active && this.classifyId(c.id).assistant === assistant)
      .map((c) => c.id);
  }

  startScenario(runId: string, scenarioId: number, principalIds?: readonly string[]): RunView {
    const run = this.runRow(runId);
    if (run.status === 'finished')
      throw new EvaluationError('RUN_FINISHED', 'This run is finished: make a new run to record more.');
    const r = this.resultRow(runId, scenarioId);
    if (r.state === 'recording')
      throw new EvaluationError('ALREADY_RECORDING', 'This scenario is already recording.');
    if (r.state === 'done')
      throw new EvaluationError('WRONG_STATE', 'This scenario is recorded: redo it to record it again.');
    if (this.resultRows(runId).some((x) => x.state === 'recording'))
      throw new EvaluationError(
        'ALREADY_RECORDING',
        'Another scenario is recording: press Done for it first.',
      );
    const days = this.o.log.retentionDays();
    if (days === 0) {
      throw new EvaluationError(
        'RECORDING_OFF',
        'Recording of tool calls is switched off (retention 0 days), so nothing could be evaluated. Set a number of days under “How long calls are kept”, then start again.',
      );
    }
    const label = run.assistant === 'chatgpt' ? 'ChatGPT' : 'Claude';
    let ids: string[];
    let mode: 'auto' | 'manual';
    if (principalIds && principalIds.length > 0) {
      ids = this.checkedIds(principalIds);
      mode = 'manual';
    } else if (run.principal_ids !== null) {
      ids = json<string[]>(run.principal_ids, []);
      mode = 'manual';
    } else {
      ids = this.classifiedActive(run.assistant);
      mode = 'auto';
      if (ids.length === 0) {
        throw new EvaluationError(
          'NO_CONNECTION',
          `No active connection is recognised as ${label}. Choose the connection to record yourself.`,
        );
      }
    }
    this.o.db
      .prepare(
        `UPDATE evaluation_results SET state = 'recording', started_at = ?, finished_at = NULL, start_call_id = ?,
           end_call_id = NULL, principal_ids = ?, connection_mode = ?, calls = '[]', auto_grade = NULL
         WHERE run_id = ? AND scenario_id = ?`,
      )
      .run(this.now(), this.o.log.lastId(), JSON.stringify(ids), mode, runId, scenarioId);
    return this.getRun(runId);
  }

  doneScenario(runId: string, scenarioId: number): RunView {
    const run = this.runRow(runId);
    const r = this.resultRow(runId, scenarioId);
    if (r.state !== 'recording' || r.start_call_id === null)
      throw new EvaluationError('WRONG_STATE', 'This scenario is not recording: press Start first.');
    if (this.o.log.retentionDays() === 0) {
      throw new EvaluationError(
        'RECORDING_OFF',
        'Recording of tool calls was switched off while this scenario was recording, so its calls were removed. Switch it back on and redo the scenario.',
      );
    }
    const upTo = this.o.log.lastId();
    let ids = json<string[]>(r.principal_ids, []);
    if (r.connection_mode === 'auto') {
      const extra = this.o.log
        .principalsSince(r.start_call_id)
        .filter((p) => !ids.includes(p) && this.classifyId(p).assistant === run.assistant);
      ids = [...ids, ...extra];
    }
    const calls = this.o.log
      .window({ principalIds: ids, afterId: r.start_call_id, upToId: upTo })
      .map(recordCall);
    const grade = autoGrade(this.scenario(scenarioId), calls);
    this.o.db
      .prepare(
        `UPDATE evaluation_results SET state = 'done', finished_at = ?, end_call_id = ?, principal_ids = ?, calls = ?,
           auto_grade = ? WHERE run_id = ? AND scenario_id = ?`,
      )
      .run(
        this.now(),
        upTo,
        JSON.stringify(ids),
        JSON.stringify(calls),
        JSON.stringify(grade),
        runId,
        scenarioId,
      );
    return this.getRun(runId);
  }

  /** Back to pending: the recording or the result is dropped (with the owner's grade and note) so it can be done again. */
  resetScenario(runId: string, scenarioId: number): RunView {
    const run = this.runRow(runId);
    if (run.status === 'finished')
      throw new EvaluationError('RUN_FINISHED', 'This run is finished: make a new run to record more.');
    this.resultRow(runId, scenarioId);
    this.o.db
      .prepare(
        `UPDATE evaluation_results SET state = 'pending', started_at = NULL, finished_at = NULL, start_call_id = NULL,
           end_call_id = NULL, principal_ids = '[]', connection_mode = 'auto', calls = '[]', auto_grade = NULL,
           owner_grade = NULL, note = '' WHERE run_id = ? AND scenario_id = ?`,
      )
      .run(runId, scenarioId);
    return this.getRun(runId);
  }

  /** The owner's one-click grade (null clears it) and optional note. The auto-grade never sets it. */
  grade(runId: string, scenarioId: number, input: { grade: OwnerGrade | null; note?: string }): RunView {
    this.runRow(runId);
    const r = this.resultRow(runId, scenarioId);
    if (r.state !== 'done')
      throw new EvaluationError('WRONG_STATE', 'Only a recorded scenario can be graded: press Done first.');
    if (input.grade !== null && !OWNER_GRADES.includes(input.grade))
      throw new EvaluationError('INVALID_INPUT', 'The grade is Right, Partly or Wrong.');
    const note = (input.note ?? r.note).slice(0, MAX_NOTE);
    this.o.db
      .prepare('UPDATE evaluation_results SET owner_grade = ?, note = ? WHERE run_id = ? AND scenario_id = ?')
      .run(input.grade, note, runId, scenarioId);
    return this.getRun(runId);
  }

  // ---------------------------------------------------------------------------- table and comparison

  /** The recorded scenarios of a run as a Markdown table (src/evaluation/table.ts). */
  table(runId: string): string {
    const run = this.getRun(runId);
    const titles = new Map(this.scenarioFile().scenarios.map((s) => [s.id, s.shortTitle]));
    return buildResultsTable(
      run.results
        .filter((r) => r.state === 'done')
        .map((r) => ({
          scenarioId: r.scenarioId,
          shortTitle: titles.get(r.scenarioId) ?? r.title,
          assistant: run.assistant,
          calls: r.calls,
          ownerGrade: r.ownerGrade,
          note: r.note,
          autoGrade: r.autoGrade,
        })),
    );
  }

  /** `a` is the earlier run, `b` the later. */
  compare(aId: string, bId: string): Comparison {
    const view = (id: string) => {
      const run = this.getRun(id);
      return {
        id: run.id,
        createdAt: run.createdAt,
        assistant: run.assistant,
        scenarios: run.results.map((r) => ({
          scenarioId: r.scenarioId,
          shortTitle: r.title,
          done: r.state === 'done',
          calls: r.calls,
          ownerGrade: r.ownerGrade,
        })),
      };
    };
    return compareRuns(view(aId), view(bId));
  }
}
