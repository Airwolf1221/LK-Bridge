/**
 * The off-site copy's rows (v2 E1b, ADR 0043; migration 2200). Used by the bridge (the dashboard reads them, the owner's
 * actions write the connection, keys and settings) and by the separate runner (runs, findings, folder progress). Both
 * open the same SQLite database in WAL mode, so each write is one short statement or transaction.
 *
 * No token, client secret or key is ever stored here: those live in the encrypted secret store (scope `offsite`).
 */
import type { Db } from '../db/open.js';
import { generationPath, parseOffsiteSettings, type OffsiteSettings } from './settings.js';

export type ConnectionState = 'none' | 'connected' | 'broken';
export type RunKind = 'copy' | 'verify' | 'delete_folder' | 'restore';
export type RunTrigger = 'schedule' | 'request' | 'after_full' | 'cli';
export type RunState = 'running' | 'succeeded' | 'failed' | 'interrupted' | 'refused';
export type FindingKind =
  'missing' | 'corrupt' | 'manifest_unreadable' | 'database_bad' | 'database_missing' | 'store_missing';

export interface OffsiteStateRow {
  readonly connection: ConnectionState;
  readonly accountEmail: string | null;
  readonly accountName: string | null;
  readonly connectedAt: number | null;
  readonly brokenAt: number | null;
  readonly brokenReason: string | null;
  readonly tokenCheckedAt: number | null;
  readonly clientSavedAt: number | null;
  readonly keysSetAt: number | null;
  readonly keysSource: 'generated' | 'entered' | null;
  readonly generation: number;
  readonly settingsJson: string;
  readonly updatedAt: number;
}

export interface FolderRow {
  readonly generation: number;
  readonly path: string;
  readonly createdAt: number;
  readonly firstCopyAt: number | null;
  readonly lastGoodCopyAt: number | null;
  readonly adoptedAt: number | null;
  readonly retiredAt: number | null;
  readonly retiredReason: string | null;
  readonly deleteRequestedAt: number | null;
  readonly deletedAt: number | null;
}

export interface RunRow {
  readonly id: number;
  readonly kind: RunKind;
  readonly trigger: RunTrigger;
  readonly generation: number | null;
  readonly folder: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly state: RunState;
  readonly bytes: number | null;
  readonly files: number | null;
  readonly errors: number | null;
  readonly exitCode: number | null;
  readonly rcloneVersion: string | null;
  readonly message: string | null;
  readonly detail: unknown;
  readonly pid: number | null;
}

export interface FindingRow {
  readonly id: number;
  readonly runId: number;
  readonly kind: FindingKind;
  readonly path: string | null;
  readonly detail: string | null;
}

const camel = (s: string) => s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
function mapRow<T>(r: Record<string, unknown> | undefined): T | undefined {
  if (!r) return undefined;
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) o[camel(k)] = v;
  return o as T;
}

function toRun(r: Record<string, unknown>): RunRow {
  const m = mapRow<Record<string, unknown>>(r)!;
  let detail: unknown = null;
  if (typeof m.detailJson === 'string') {
    try {
      detail = JSON.parse(m.detailJson);
    } catch {
      detail = null;
    }
  }
  delete m.detailJson;
  return { ...(m as unknown as RunRow), detail };
}

export class OffsiteDb {
  constructor(
    readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  // ============================================================================================ state

  state(): OffsiteStateRow {
    const r = this.db.prepare('SELECT * FROM offsite_state WHERE id = 1').get() as
      Record<string, unknown> | undefined;
    if (!r) {
      // A database the migration seeded always has the row; recreate it if someone removed it.
      this.db.prepare('INSERT OR IGNORE INTO offsite_state (id, updated_at) VALUES (1, ?)').run(this.now());
      return this.state();
    }
    return mapRow<OffsiteStateRow>(r)!;
  }

  settings(serverName: string): { settings: OffsiteSettings; problems: string[] } {
    return parseOffsiteSettings(this.state().settingsJson, serverName);
  }

  saveSettingsJson(json: string): void {
    this.db
      .prepare('UPDATE offsite_state SET settings_json = ?, updated_at = ? WHERE id = 1')
      .run(json, this.now());
  }

  setConnected(account: { email: string | null; name: string | null }): void {
    const at = this.now();
    this.db
      .prepare(
        `UPDATE offsite_state SET connection = 'connected', account_email = ?, account_name = ?, connected_at = ?,
           broken_at = NULL, broken_reason = NULL, token_checked_at = ?, updated_at = ? WHERE id = 1`,
      )
      .run(account.email, account.name, at, at, at);
  }

  /** Google refused the refresh token (or the client): the card turns red with "Reconnect". */
  setBroken(reason: string): void {
    const at = this.now();
    this.db
      .prepare(
        `UPDATE offsite_state SET connection = 'broken', broken_at = COALESCE(broken_at, ?), broken_reason = ?,
           token_checked_at = ?, updated_at = ? WHERE id = 1 AND connection != 'none'`,
      )
      .run(at, reason.slice(0, 500), at, at);
  }

  /** A refresh worked: a broken connection is healthy again. */
  setTokenOk(): void {
    const at = this.now();
    this.db
      .prepare(
        `UPDATE offsite_state SET connection = 'connected', broken_at = NULL, broken_reason = NULL,
           token_checked_at = ?, updated_at = ? WHERE id = 1 AND connection != 'none'`,
      )
      .run(at, at);
  }

  setDisconnected(): void {
    this.db
      .prepare(
        `UPDATE offsite_state SET connection = 'none', account_email = NULL, account_name = NULL, connected_at = NULL,
           broken_at = NULL, broken_reason = NULL, token_checked_at = NULL, updated_at = ? WHERE id = 1`,
      )
      .run(this.now());
  }

  setClientSaved(at: number | null): void {
    this.db
      .prepare('UPDATE offsite_state SET client_saved_at = ?, updated_at = ? WHERE id = 1')
      .run(at, this.now());
  }

  setKeys(source: 'generated' | 'entered'): void {
    const at = this.now();
    this.db
      .prepare('UPDATE offsite_state SET keys_set_at = ?, keys_source = ?, updated_at = ? WHERE id = 1')
      .run(at, source, at);
  }

  // ============================================================================================ folders

  /** The current generation's folder, created (from the settings' folder) when it has no row yet. */
  currentFolder(settingsFolder: string): FolderRow {
    const g = this.state().generation;
    const row = this.folder(g);
    if (row) return row;
    this.db
      .prepare('INSERT INTO offsite_folders (generation, path, created_at) VALUES (?, ?, ?)')
      .run(g, generationPath(settingsFolder, g), this.now());
    return this.folder(g)!;
  }

  folder(generation: number): FolderRow | undefined {
    return mapRow<FolderRow>(
      this.db.prepare('SELECT * FROM offsite_folders WHERE generation = ?').get(generation) as
        Record<string, unknown> | undefined,
    );
  }

  folders(): FolderRow[] {
    return (
      this.db.prepare('SELECT * FROM offsite_folders ORDER BY generation DESC').all() as Record<
        string,
        unknown
      >[]
    ).map((r) => mapRow<FolderRow>(r)!);
  }

  /**
   * Moves to a new folder (keys or the folder setting changed after a copy exists): the current folder is retired (kept
   * on Drive until the owner deletes it) and the next generation starts in `<settingsFolder>/copy-<n+1>`. When nothing
   * was copied into the current folder yet, it is simply re-pointed (no new generation). Returns the new current folder.
   */
  newGenerationIfCopied(settingsFolder: string, reason: string): { folder: FolderRow; started: boolean } {
    return this.db.transaction(() => {
      const cur = this.currentFolder(settingsFolder);
      if (cur.firstCopyAt === null && cur.adoptedAt === null) {
        this.db
          .prepare('UPDATE offsite_folders SET path = ? WHERE generation = ?')
          .run(generationPath(settingsFolder, cur.generation), cur.generation);
        return { folder: this.folder(cur.generation)!, started: false };
      }
      const at = this.now();
      this.db
        .prepare('UPDATE offsite_folders SET retired_at = ?, retired_reason = ? WHERE generation = ?')
        .run(at, reason, cur.generation);
      const max = (this.db.prepare('SELECT MAX(generation) AS g FROM offsite_folders').get() as { g: number })
        .g;
      const next = max + 1;
      this.db.prepare('UPDATE offsite_state SET generation = ?, updated_at = ? WHERE id = 1').run(next, at);
      this.db
        .prepare('INSERT INTO offsite_folders (generation, path, created_at) VALUES (?, ?, ?)')
        .run(next, generationPath(settingsFolder, next), at);
      return { folder: this.folder(next)!, started: true };
    })();
  }

  markCopied(generation: number, ok: boolean): void {
    const at = this.now();
    this.db
      .prepare(
        `UPDATE offsite_folders SET first_copy_at = COALESCE(first_copy_at, ?),
           last_good_copy_at = CASE WHEN ? THEN ? ELSE last_good_copy_at END WHERE generation = ?`,
      )
      .run(at, ok ? 1 : 0, at, generation);
  }

  markAdopted(generation: number): void {
    this.db
      .prepare('UPDATE offsite_folders SET adopted_at = ? WHERE generation = ?')
      .run(this.now(), generation);
  }

  requestDelete(generation: number): void {
    this.db
      .prepare('UPDATE offsite_folders SET delete_requested_at = ? WHERE generation = ?')
      .run(this.now(), generation);
  }

  markDeleted(generation: number): void {
    this.db
      .prepare('UPDATE offsite_folders SET deleted_at = ? WHERE generation = ?')
      .run(this.now(), generation);
  }

  // ============================================================================================ runs

  startRun(o: {
    kind: RunKind;
    trigger: RunTrigger;
    generation?: number | null;
    folder?: string | null;
    pid?: number;
  }): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO offsite_runs (kind, trigger, generation, folder, started_at, state, pid)
           VALUES (?, ?, ?, ?, ?, 'running', ?)`,
        )
        .run(o.kind, o.trigger, o.generation ?? null, o.folder ?? null, this.now(), o.pid ?? null)
        .lastInsertRowid,
    );
  }

  finishRun(
    id: number,
    r: {
      state: Exclude<RunState, 'running'>;
      bytes?: number | null;
      files?: number | null;
      errors?: number | null;
      exitCode?: number | null;
      rcloneVersion?: string | null;
      message?: string | null;
      detail?: unknown;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE offsite_runs SET state = ?, ended_at = ?, bytes = ?, files = ?, errors = ?, exit_code = ?,
           rclone_version = COALESCE(?, rclone_version), message = ?, detail_json = ? WHERE id = ?`,
      )
      .run(
        r.state,
        this.now(),
        r.bytes ?? null,
        r.files ?? null,
        r.errors ?? null,
        r.exitCode ?? null,
        r.rcloneVersion ?? null,
        r.message?.slice(0, 2000) ?? null,
        r.detail === undefined ? null : JSON.stringify(r.detail),
        id,
      );
  }

  /** Runs still marked running whose process is gone (a crash, a kill, a reboot): marked interrupted. */
  interruptStale(alive: (pid: number) => boolean): number {
    const rows = this.db.prepare("SELECT id, pid FROM offsite_runs WHERE state = 'running'").all() as {
      id: number;
      pid: number | null;
    }[];
    let n = 0;
    for (const r of rows) {
      if (r.pid !== null && alive(r.pid)) continue;
      this.db
        .prepare(
          "UPDATE offsite_runs SET state = 'interrupted', ended_at = ?, message = COALESCE(message, ?) WHERE id = ?",
        )
        .run(this.now(), 'the runner stopped before the run finished', r.id);
      n++;
    }
    return n;
  }

  run(id: number): RunRow | undefined {
    const r = this.db.prepare('SELECT * FROM offsite_runs WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    return r ? toRun(r) : undefined;
  }

  runs(o: { kind?: RunKind; limit?: number } = {}): RunRow[] {
    const rows = (
      o.kind
        ? this.db
            .prepare('SELECT * FROM offsite_runs WHERE kind = ? ORDER BY started_at DESC, id DESC LIMIT ?')
            .all(o.kind, o.limit ?? 50)
        : this.db
            .prepare('SELECT * FROM offsite_runs ORDER BY started_at DESC, id DESC LIMIT ?')
            .all(o.limit ?? 50)
    ) as Record<string, unknown>[];
    return rows.map(toRun);
  }

  lastRun(
    kind: RunKind,
    o: { states?: readonly RunState[]; triggers?: readonly RunTrigger[] } = {},
  ): RunRow | undefined {
    return this.runs({ kind, limit: 500 }).find(
      (r) => (!o.states || o.states.includes(r.state)) && (!o.triggers || o.triggers.includes(r.trigger)),
    );
  }

  running(): RunRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM offsite_runs WHERE state = 'running' ORDER BY started_at DESC LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    return r ? toRun(r) : undefined;
  }

  addFindings(
    runId: number,
    findings: readonly { kind: FindingKind; path?: string | null; detail?: string | null }[],
  ): void {
    const ins = this.db.prepare(
      'INSERT INTO offsite_findings (run_id, kind, path, detail) VALUES (?, ?, ?, ?)',
    );
    this.db.transaction(() => {
      for (const f of findings) ins.run(runId, f.kind, f.path ?? null, f.detail?.slice(0, 1000) ?? null);
    })();
  }

  findings(runId: number, limit = 200): FindingRow[] {
    return (
      this.db
        .prepare('SELECT * FROM offsite_findings WHERE run_id = ? ORDER BY id LIMIT ?')
        .all(runId, limit) as Record<string, unknown>[]
    ).map((r) => mapRow<FindingRow>(r)!);
  }

  findingCount(runId: number): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM offsite_findings WHERE run_id = ?').get(runId) as {
        n: number;
      }
    ).n;
  }
}
