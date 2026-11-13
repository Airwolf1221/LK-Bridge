/**
 * The off-site runner (v2 E1b, ADR 0043): `lk-bridge-offsite.service`, a separate process from the bridge, started by
 * its timer (every quarter hour; the schedule itself is in the database) and by its path unit (a request file from the
 * dashboard or after a nightly full snapshot). It:
 *
 * 1. reads the Drive client, the refresh token and the crypt keys from the encrypted secret store (SECRETS_MASTER_KEY
 *    from the env file, as the bridge reads it);
 * 2. gets a fresh access token (a refusal turns the dashboard's card red: "Reconnect");
 * 3. writes a temporary rclone config (0600, in a 0700 directory under the unit's PrivateTmp; removed on exit, also after
 *    a failure or a stop);
 * 4. copies, in this order: `objects/` (new pieces only), then `manifests/` (sync, only manifests older than the run, so
 *    every manifest on Drive has its objects there first), then `objects/` again as a sync (the pieces E1a's clean-up
 *    removed, now that no manifest on Drive names them), then `STORE.json`, then the nightly database copies. Every sync
 *    moves what it replaces or removes into `deleted/<date>/`, kept for `deletedRetentionDays` (30), then purged;
 * 5. records the run for the dashboard (start, end, bytes, files, errors, rclone's exit code), and saves a refresh token
 *    rclone renewed during the run back into the store.
 *
 * It also verifies the copy (monthly and on request) and pulls it back for a disaster recovery (`restore`).
 */
import { createHash, randomBytes } from 'node:crypto';
import { rmSync, type Dirent } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import type { Db } from '../db/open.js';
import { OFFSITE_SCOPE, type SecretStore } from '../secrets/store.js';
import { manifestPieces, type Manifest } from '../snapshots/manifest.js';
import { OffsiteDb, type FindingKind, type FolderRow, type RunTrigger } from './db.js';
import {
  GoogleError,
  GoogleOAuth,
  reconnectReason,
  redactSecrets,
  type GoogleOAuthOptions,
} from './google.js';
import {
  checkRclone,
  configText,
  CRYPT_REMOTE,
  DRIVE_REMOTE,
  obscure,
  rcloneRun,
  tokenFromConfig,
  type RcloneResult,
  type RcloneRunner,
} from './rclone.js';
import { takeRequests, type OffsiteRequest } from './requests.js';
import { isDue, latestDailySlot, latestMonthlySlot } from './schedule.js';
import { serverNameOf, type OffsiteSettings } from './settings.js';
import { hostname } from 'node:os';

export interface RunnerOptions {
  readonly db: Db;
  readonly secrets: SecretStore;
  readonly dbPath: string;
  readonly snapshotDir: string;
  readonly backupDir: string;
  readonly requestDir: string;
  /** BRIDGE_PUBLIC_URL (names the default folder). */
  readonly publicUrl?: string;
  readonly rcloneBin: string;
  /** Extra environment for rclone (tests: the fake rclone's settings). */
  readonly rcloneEnv?: Readonly<Record<string, string>>;
  readonly google?: GoogleOAuthOptions;
  readonly now?: () => number;
  /** Where the private temporary directory goes (default: the system's, which is the unit's PrivateTmp). */
  readonly tmpRoot?: string;
  readonly log?: (line: string) => void;
  /** Test seam: called with the temporary config's path once it is written. */
  readonly onConfig?: (path: string) => void | Promise<void>;
}

export class RunnerRefusal extends Error {
  override readonly name = 'RunnerRefusal';
}

/** Temporary directories in use: removed by the process's exit handler if a run never reached its own clean-up. */
export const liveTmpDirs = new Set<string>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const d of liveTmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // nothing more can be done at exit; PrivateTmp is removed by systemd when the unit stops
      }
    }
  });
}

const OBJECT_PATH = /^objects\/([0-9a-f]{2})\/([0-9a-f]{64})\.gz$/;
const MANIFEST_PATH = /^manifests\/[^/]+\/[^/]+\.json\.gz$/;
const DB_COPY = /^(nightly|pre-deploy)-(\d{8}T\d{6}Z)\.db\.gz$/;
const DELETED_DIR = /^(\d{4}-\d{2}-\d{2})\/?$/;

interface Session {
  readonly rc: (args: readonly string[]) => Promise<RcloneResult>;
  readonly tmp: string;
  readonly cfg: string;
  readonly version: string;
  readonly folder: string;
  readonly common: string[];
}

interface StepRecord {
  name: string;
  code: number | null;
  bytes: number;
  files: number;
  errors: number;
  ms: number;
}

export class OffsiteRunner {
  readonly store: OffsiteDb;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly google: GoogleOAuth;
  readonly serverName: string;

  constructor(readonly o: RunnerOptions) {
    this.now = o.now ?? Date.now;
    this.store = new OffsiteDb(o.db, this.now);
    this.log = o.log ?? ((l) => process.stdout.write(`${l}\n`));
    this.google = new GoogleOAuth({ ...o.google, now: this.now });
    this.serverName = serverNameOf(o.publicUrl, hostname());
  }

  settings(): OffsiteSettings {
    return this.store.settings(this.serverName).settings;
  }

  private rclone(home: string): RcloneRunner {
    return { bin: this.o.rcloneBin, home, ...(this.o.rcloneEnv ? { env: this.o.rcloneEnv } : {}) };
  }

  configured(): boolean {
    const s = this.o.secrets;
    return (
      s.has(OFFSITE_SCOPE, 'drive_client_id') &&
      s.has(OFFSITE_SCOPE, 'drive_client_secret') &&
      s.has(OFFSITE_SCOPE, 'drive_refresh_token') &&
      s.has(OFFSITE_SCOPE, 'drive_crypt_password') &&
      s.has(OFFSITE_SCOPE, 'drive_crypt_salt')
    );
  }

  // ============================================================================================ the timer and path unit

  /**
   * What `lk-bridge-offsite.service` does at each start: take every request (first, so a request is never seen twice),
   * then do what is requested or due: old folders to delete, a copy, a verify (after the copy).
   */
  async tick(): Promise<{ did: string[] }> {
    this.store.interruptStale(pidAlive);
    const { requests, bad } = await takeRequests(this.o.requestDir);
    if (bad.length) this.log(`Ignored ${bad.length} unreadable request file(s).`);
    const did: string[] = [];
    for (const r of requests.filter((x) => x.kind === 'delete_folder')) {
      if (r.generation !== undefined) {
        await this.deleteFolder(r.generation);
        did.push(`delete_folder ${r.generation}`);
      }
    }
    if (!this.configured()) {
      if (requests.some((r) => r.kind !== 'delete_folder'))
        this.log(
          'The off-site copy is not set up (Google client, connection or keys missing); nothing to do.',
        );
      return { did };
    }
    const settings = this.settings();
    const now = this.now();
    const copyReq = requests.find((r) => r.kind === 'copy');
    const lastCopy = this.store.lastRun('copy');
    const copyDue = isDue(latestDailySlot(now, settings.copyTime), lastCopy?.startedAt);
    if (copyReq || copyDue) {
      await this.copy(copyReq ? triggerOf(copyReq) : 'schedule');
      did.push('copy');
    }
    const verifyReq = requests.find((r) => r.kind === 'verify');
    const lastVerify = this.store.lastRun('verify');
    const anyCopy = this.store.lastRun('copy', { states: ['succeeded'] }) !== undefined;
    const verifyDue =
      settings.verifyEnabled &&
      anyCopy &&
      isDue(latestMonthlySlot(now, settings.verifyDay, settings.verifyTime), lastVerify?.startedAt);
    if (verifyReq || verifyDue) {
      await this.verify(verifyReq ? 'request' : 'schedule');
      did.push('verify');
    }
    return { did };
  }

  // ============================================================================================ the session

  /**
   * Checks rclone, reads the secrets, refreshes the token, writes the temporary config and runs `fn`; then saves a token
   * rclone renewed and removes the temporary directory, whatever happened.
   */
  private async session<T>(folder: string, fn: (s: Session) => Promise<T>): Promise<T> {
    const tmp = await mkdtemp(join(this.o.tmpRoot ?? tmpdir(), 'lkb-offsite-'));
    liveTmpDirs.add(tmp);
    installExitHook();
    await chmod(tmp, 0o700);
    const secrets: string[] = [];
    try {
      const rc = this.rclone(tmp);
      const check = await checkRclone(rc);
      if (!check.ok) throw new RunnerRefusal(check.message);
      const read = (p: Parameters<SecretStore['read']>[1]): string => {
        const r = this.o.secrets.read(OFFSITE_SCOPE, p);
        if (!r.ok) {
          throw new RunnerRefusal(
            r.reason === 'not_stored'
              ? 'The off-site copy is not set up on the dashboard (Google client, connection and keys).'
              : `A stored off-site secret cannot be read: ${r.message}`,
          );
        }
        secrets.push(r.value);
        return r.value;
      };
      const client = { clientId: read('drive_client_id'), clientSecret: read('drive_client_secret') };
      const refreshToken = read('drive_refresh_token');
      const password = read('drive_crypt_password');
      const salt = read('drive_crypt_salt');
      let tokens;
      try {
        tokens = await this.google.refresh(client, refreshToken);
      } catch (e) {
        if (e instanceof GoogleError && e.needsReconnect) {
          this.store.setBroken(reconnectReason(e));
          throw new RunnerRefusal(reconnectReason(e));
        }
        throw new RunnerRefusal(
          e instanceof Error ? redactSecrets(e.message, secrets) : 'the token refresh failed',
        );
      }
      this.store.setTokenOk();
      secrets.push(tokens.accessToken);
      const latestRefresh = tokens.refreshToken ?? refreshToken;
      if (latestRefresh !== refreshToken) {
        this.o.secrets.write(OFFSITE_SCOPE, 'drive_refresh_token', latestRefresh, { source: 'dashboard' });
        secrets.push(latestRefresh);
      }
      const cfg = join(tmp, 'rclone.conf');
      await writeFile(
        cfg,
        configText({
          ...client,
          accessToken: tokens.accessToken,
          refreshToken: latestRefresh,
          expiresAt: tokens.expiresAt,
          folder,
          obscuredPassword: await obscure(rc, password),
          obscuredSalt: await obscure(rc, salt),
        }),
        { mode: 0o600 },
      );
      await chmod(cfg, 0o600);
      await this.o.onConfig?.(cfg);
      const settings = this.settings();
      const common = [
        '--config',
        cfg,
        '--use-json-log',
        '--stats',
        '1m',
        '--stats-log-level',
        'NOTICE',
        '--transfers',
        String(settings.transfers),
        '--checkers',
        '8',
        '--retries',
        '3',
        '--low-level-retries',
        '10',
        '--fast-list',
        '--drive-stop-on-upload-limit',
        ...(settings.bandwidthLimit && settings.bandwidthLimit.toLowerCase() !== 'off'
          ? ['--bwlimit', settings.bandwidthLimit]
          : []),
      ];
      const session: Session = {
        rc: (args) => rcloneRun(rc, args, { secrets }),
        tmp,
        cfg,
        version: check.version,
        folder,
        common,
      };
      try {
        return await fn(session);
      } finally {
        // rclone refreshes the access token itself on a long run and writes it back to the config; if Google issued a
        // new refresh token with it, keep that one (the old one may stop working).
        try {
          const back = tokenFromConfig(await readFile(cfg, 'utf8'));
          if (back.refreshToken && back.refreshToken !== latestRefresh) {
            this.o.secrets.write(OFFSITE_SCOPE, 'drive_refresh_token', back.refreshToken, {
              source: 'dashboard',
            });
            this.log('Saved the refresh token rclone renewed during the run.');
          }
        } catch {
          // the config is gone or unreadable: nothing to save
        }
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
      liveTmpDirs.delete(tmp);
    }
  }

  // ============================================================================================ copy

  async copy(trigger: RunTrigger): Promise<number> {
    const settings = this.settings();
    const folder = this.store.currentFolder(settings.folder);
    const runId = this.store.startRun({
      kind: 'copy',
      trigger,
      generation: folder.generation,
      folder: folder.path,
      pid: process.pid,
    });
    this.log(`Off-site copy ${runId} (${trigger}) into "${folder.path}" ...`);
    const steps: StepRecord[] = [];
    let version: string | null = null;
    try {
      const marker = join(this.o.snapshotDir, 'STORE.json');
      if (!(await exists(marker))) {
        throw new RunnerRefusal(
          `There is no snapshot store at ${this.o.snapshotDir} yet: take a full snapshot first (Snapshots page).`,
        );
      }
      const manifests = await countFiles(join(this.o.snapshotDir, 'manifests'));
      if (manifests === 0) {
        throw new RunnerRefusal(
          'The local snapshot store holds no manifests. Refusing to mirror an empty store over the Drive copy (take a full snapshot first, or restore the store).',
        );
      }
      const t0 = this.now();
      const result = await this.session(folder.path, async (s) => {
        version = s.version;
        await this.refuseForeign(s, folder);
        const day = new Date(t0).toISOString().slice(0, 10);
        const backup = (sub: string) => ['--backup-dir', `${CRYPT_REMOTE}:deleted/${day}/${sub}`];
        const snap = this.o.snapshotDir;
        const minAge = () => `${Math.max(1, Math.ceil((this.now() - t0) / 1000))}s`;
        const plan: { name: string; args: () => string[]; optional?: boolean }[] = [
          { name: 'objects', args: () => ['copy', join(snap, 'objects'), `${CRYPT_REMOTE}:store/objects`] },
          {
            name: 'manifests',
            args: () => [
              'sync',
              join(snap, 'manifests'),
              `${CRYPT_REMOTE}:store/manifests`,
              ...backup('store/manifests'),
              '--min-age',
              minAge(),
            ],
          },
          {
            name: 'objects-removed',
            args: () => [
              'sync',
              join(snap, 'objects'),
              `${CRYPT_REMOTE}:store/objects`,
              ...backup('store/objects'),
            ],
          },
          {
            name: 'store-marker',
            args: () => ['copyto', join(snap, 'STORE.json'), `${CRYPT_REMOTE}:store/STORE.json`],
          },
        ];
        if (await exists(this.o.backupDir)) {
          plan.push({
            name: 'database',
            args: () => [
              'sync',
              this.o.backupDir,
              `${CRYPT_REMOTE}:database`,
              ...backup('database'),
              '--include',
              'nightly-*.db.gz',
              '--include',
              'pre-deploy-*.db.gz',
            ],
          });
        }
        for (const p of plan) {
          const r = await s.rc([...p.args(), ...s.common]);
          steps.push(stepOf(p.name, r));
          this.log(
            `  ${p.name}: exit ${r.code ?? r.signal}, ${r.stats?.files ?? 0} files, ${r.stats?.bytes ?? 0} bytes`,
          );
          if (r.code !== 0) {
            return {
              ok: false,
              exitCode: r.code ?? 128,
              message: `rclone ${p.name} failed (exit ${r.code ?? r.signal}): ${r.logTail.slice(-3).join(' | ') || 'no message'}`,
            };
          }
        }
        const purge = await this.purgeDeleted(s, settings.deletedRetentionDays, t0);
        return {
          ok: true,
          exitCode: 0,
          message: purge.message,
          purged: purge.purged,
          purgeErrors: purge.errors,
        };
      });
      const totals = sumSteps(steps);
      this.store.markCopied(folder.generation, result.ok);
      this.store.finishRun(runId, {
        state: result.ok ? 'succeeded' : 'failed',
        bytes: totals.bytes,
        files: totals.files,
        errors: totals.errors + (('purgeErrors' in result ? result.purgeErrors : 0) ?? 0),
        exitCode: result.exitCode,
        rcloneVersion: version,
        message: result.ok
          ? `Copied ${totals.files} files (${totals.bytes} bytes) into "${folder.path}".${result.message ? ` ${result.message}` : ''}`
          : result.message,
        detail: { steps, ...('purged' in result ? { purged: result.purged } : {}) },
      });
      this.log(
        result.ok ? `Off-site copy ${runId} succeeded.` : `Off-site copy ${runId} FAILED: ${result.message}`,
      );
    } catch (e) {
      const refused = e instanceof RunnerRefusal;
      const message = redactSecrets(e instanceof Error ? e.message : String(e));
      const totals = sumSteps(steps);
      this.store.finishRun(runId, {
        state: refused ? 'refused' : 'failed',
        bytes: totals.bytes,
        files: totals.files,
        errors: totals.errors,
        rcloneVersion: version,
        message,
        detail: { steps },
      });
      this.log(`Off-site copy ${runId} ${refused ? 'refused' : 'FAILED'}: ${message}`);
    }
    return runId;
  }

  /** A folder this database never copied into, that already holds something, is not overwritten unless adopted. */
  private async refuseForeign(s: Session, folder: FolderRow): Promise<void> {
    if (folder.firstCopyAt !== null || folder.adoptedAt !== null) return;
    const r = await s.rc(['lsjson', `${DRIVE_REMOTE}:${folder.path}`, '--max-depth', '1', ...s.common]);
    if (r.code === 3) return; // the folder does not exist yet
    if (r.code !== 0) {
      throw new Error(
        `rclone could not list "${folder.path}" (exit ${r.code ?? r.signal}): ${r.logTail.slice(-2).join(' | ')}`,
      );
    }
    let entries: unknown[];
    try {
      entries = JSON.parse(r.stdout || '[]') as unknown[];
    } catch {
      entries = [{}];
    }
    if (entries.length > 0) {
      throw new RunnerRefusal(
        `The Drive folder "${folder.path}" already holds a copy this database did not make (after a recovery from a fresh database, say). Nothing was copied. Restore from it first (runbook, disaster recovery), or confirm "Use this folder" on the dashboard, or choose another folder.`,
      );
    }
  }

  private async purgeDeleted(
    s: Session,
    days: number,
    now: number,
  ): Promise<{ purged: string[]; errors: number; message: string | null }> {
    const r = await s.rc(['lsf', '--dirs-only', `${CRYPT_REMOTE}:deleted`, ...s.common]);
    if (r.code === 3) return { purged: [], errors: 0, message: null };
    if (r.code !== 0)
      return { purged: [], errors: 1, message: 'The deleted/ area could not be listed for its clean-up.' };
    const cutoff = now - days * 86_400_000;
    const purged: string[] = [];
    let errors = 0;
    for (const line of r.stdout.split('\n')) {
      const m = DELETED_DIR.exec(line.trim());
      if (!m) continue;
      const at = Date.parse(`${m[1]}T00:00:00Z`);
      if (!Number.isFinite(at) || at >= cutoff) continue;
      const p = await s.rc([
        'purge',
        `${CRYPT_REMOTE}:deleted/${m[1]}`,
        '--drive-use-trash=false',
        ...s.common,
      ]);
      if (p.code === 0) purged.push(m[1]!);
      else errors++;
    }
    return {
      purged,
      errors,
      message: purged.length
        ? `Purged ${purged.length} day(s) of removed pieces older than ${days} days.`
        : errors
          ? 'Some old removed pieces could not be purged (next run tries again).'
          : null,
    };
  }

  // ============================================================================================ verify

  async verify(trigger: RunTrigger): Promise<number> {
    const settings = this.settings();
    const folder = this.store.currentFolder(settings.folder);
    const runId = this.store.startRun({
      kind: 'verify',
      trigger,
      generation: folder.generation,
      folder: folder.path,
      pid: process.pid,
    });
    this.log(`Off-site verify ${runId} of "${folder.path}" ...`);
    let version: string | null = null;
    try {
      const out = await this.session(folder.path, async (s) => {
        version = s.version;
        return checkRemote(s, {
          samplePercent: settings.verifySamplePercent,
          sampleMin: settings.verifySampleMin,
          everyObject: false,
        });
      });
      this.store.addFindings(runId, out.findings);
      const ok = out.findings.length === 0;
      this.store.finishRun(runId, {
        state: ok ? 'succeeded' : 'failed',
        bytes: out.bytes,
        files: out.downloaded,
        errors: out.findings.length,
        exitCode: 0,
        rcloneVersion: version,
        message: summarise(out),
        detail: out.counts,
      });
      this.log(`Off-site verify ${runId}: ${summarise(out)}`);
    } catch (e) {
      const refused = e instanceof RunnerRefusal;
      const message = redactSecrets(e instanceof Error ? e.message : String(e));
      this.store.finishRun(runId, { state: refused ? 'refused' : 'failed', rcloneVersion: version, message });
      this.log(`Off-site verify ${runId} ${refused ? 'refused' : 'FAILED'}: ${message}`);
    }
    return runId;
  }

  // ============================================================================================ deleting an old folder

  async deleteFolder(generation: number): Promise<number> {
    const f = this.store.folder(generation);
    const runId = this.store.startRun({
      kind: 'delete_folder',
      trigger: 'request',
      generation,
      folder: f?.path ?? null,
      pid: process.pid,
    });
    try {
      if (!f) throw new RunnerRefusal(`There is no folder generation ${generation}.`);
      if (f.generation === this.store.state().generation)
        throw new RunnerRefusal('The current folder is never deleted.');
      // The crypt remote is not needed: the folder goes as a whole, to Drive's bin (emptied by Google after 30 days).
      const r = await this.session(this.store.currentFolder(this.settings().folder).path, (s) =>
        s.rc(['purge', `${DRIVE_REMOTE}:${f.path}`, ...s.common]),
      );
      if (r.code === 0 || r.code === 3) {
        this.store.markDeleted(generation);
        this.store.finishRun(runId, {
          state: 'succeeded',
          exitCode: r.code,
          message: `Deleted "${f.path}" (moved to Drive’s bin).`,
        });
      } else {
        this.store.finishRun(runId, {
          state: 'failed',
          exitCode: r.code,
          message: `rclone could not delete "${f.path}": ${r.logTail.slice(-2).join(' | ')}`,
        });
      }
    } catch (e) {
      this.store.finishRun(runId, {
        state: e instanceof RunnerRefusal ? 'refused' : 'failed',
        message: redactSecrets(e instanceof Error ? e.message : String(e)),
      });
    }
    return runId;
  }

  // ============================================================================================ restore (disaster recovery)

  /**
   * Pulls the store and the newest database copy from Drive into `dest` and checks them: every object re-hashed against
   * its name, every manifest's pieces present, the database copy through SQLite's integrity_check. Never touches the
   * live data: the report says how to move them into place.
   */
  async restore(o: {
    dest: string;
    folder?: string;
  }): Promise<{ ok: boolean; report: string[]; runId: number }> {
    const settings = this.settings();
    const folderPath = o.folder ?? this.store.currentFolder(settings.folder).path;
    const runId = this.store.startRun({
      kind: 'restore',
      trigger: 'cli',
      folder: folderPath,
      pid: process.pid,
    });
    const report: string[] = [];
    try {
      if (await exists(o.dest)) {
        if ((await readdir(o.dest)).length > 0)
          throw new RunnerRefusal(`${o.dest} is not empty; choose a new directory.`);
      }
      await mkdir(o.dest, { recursive: true, mode: 0o700 });
      const storeDir = join(o.dest, 'snapshots');
      const backupsDir = join(o.dest, 'backups');
      const out = await this.session(folderPath, async (s) => {
        const steps: StepRecord[] = [];
        for (const [name, args] of [
          ['objects', ['copy', `${CRYPT_REMOTE}:store/objects`, join(storeDir, 'objects')]],
          ['manifests', ['copy', `${CRYPT_REMOTE}:store/manifests`, join(storeDir, 'manifests')]],
          ['store-marker', ['copyto', `${CRYPT_REMOTE}:store/STORE.json`, join(storeDir, 'STORE.json')]],
        ] as const) {
          const r = await s.rc([...args, ...s.common]);
          steps.push(stepOf(name, r));
          report.push(`pulled ${name}: exit ${r.code ?? r.signal}, ${r.stats?.files ?? 0} files`);
          if (r.code !== 0) throw new Error(`rclone ${name} failed: ${r.logTail.slice(-2).join(' | ')}`);
        }
        const db = await newestDatabase(s);
        let dbFile: string | null = null;
        if (db) {
          await mkdir(backupsDir, { recursive: true, mode: 0o700 });
          dbFile = join(backupsDir, db);
          const r = await s.rc(['copyto', `${CRYPT_REMOTE}:database/${db}`, dbFile, ...s.common]);
          steps.push(stepOf('database', r));
          if (r.code !== 0) throw new Error(`rclone could not pull the database copy ${db}.`);
          report.push(`pulled the newest database copy: ${db}`);
        }
        return { steps, dbFile, dbName: db };
      });
      const check = await checkLocalStore(storeDir);
      const findings = [...check.findings];
      let dbOk = false;
      if (out.dbFile) {
        const d = await checkDatabaseCopy(out.dbFile, join(o.dest, 'bridge.db'));
        if (d.ok) dbOk = true;
        else findings.push({ kind: 'database_bad', path: out.dbName, detail: d.detail });
      } else
        findings.push({ kind: 'database_missing', path: 'database/', detail: 'no database copy on Drive' });
      await chmodTree(o.dest);
      this.store.addFindings(runId, findings);
      const ok = findings.length === 0;
      report.push(
        `checked ${check.objects} objects against their names, ${check.manifests} manifests (${check.referenced} pieces named): ${findings.length === 0 ? 'all good' : `${findings.length} problem(s)`}`,
      );
      if (out.dbFile)
        report.push(
          `database copy ${out.dbName}: ${dbOk ? 'integrity_check ok, unpacked to bridge.db' : 'FAILED its check'}`,
        );
      for (const f of findings.slice(0, 20))
        report.push(`  ${f.kind}: ${f.path ?? ''} ${f.detail ?? ''}`.trimEnd());
      this.store.finishRun(runId, {
        state: ok ? 'succeeded' : 'failed',
        files: check.objects + check.manifests,
        errors: findings.length,
        exitCode: 0,
        message: report.join('\n').slice(0, 2000),
        detail: { steps: out.steps },
      });
      return { ok, report, runId };
    } catch (e) {
      const message = redactSecrets(e instanceof Error ? e.message : String(e));
      this.store.finishRun(runId, { state: e instanceof RunnerRefusal ? 'refused' : 'failed', message });
      report.push(`FAILED: ${message}`);
      return { ok: false, report, runId };
    }
  }

  /** The Drive folders under the folder setting (for a recovery: which `copy-<n>` exist). */
  async listGenerations(): Promise<string[]> {
    const settings = this.settings();
    return this.session(this.store.currentFolder(settings.folder).path, async (s) => {
      const r = await s.rc(['lsf', '--dirs-only', `${DRIVE_REMOTE}:${settings.folder}`, ...s.common]);
      if (r.code !== 0) return [];
      return r.stdout
        .split('\n')
        .map((l) => l.trim().replace(/\/$/, ''))
        .filter((l) => /^copy-\d+$/.test(l));
    });
  }
}

// ================================================================================================ checks

interface Finding {
  kind: FindingKind;
  path: string | null;
  detail: string | null;
}

interface RemoteCheck {
  findings: Finding[];
  downloaded: number;
  bytes: number;
  counts: Record<string, number | string | null>;
}

async function newestDatabase(s: Session): Promise<string | null> {
  const r = await s.rc(['lsjson', '--files-only', `${CRYPT_REMOTE}:database`, ...s.common]);
  if (r.code !== 0) return null;
  let list: { Path?: unknown; Name?: unknown }[] = [];
  try {
    list = JSON.parse(r.stdout || '[]') as typeof list;
  } catch {
    return null;
  }
  const names = list
    .map((x) => (typeof x.Path === 'string' ? x.Path : typeof x.Name === 'string' ? x.Name : ''))
    .filter((n) => DB_COPY.test(n));
  // Newest by its time; a nightly copy wins over a pre-deploy one of the same second.
  names.sort((a, b) => {
    const ta = DB_COPY.exec(a)![2]!;
    const tb = DB_COPY.exec(b)![2]!;
    return ta === tb ? (a.startsWith('nightly') ? -1 : 1) : tb.localeCompare(ta);
  });
  return names[0] ?? null;
}

async function checkRemote(
  s: Session,
  o: { samplePercent: number; sampleMin: number; everyObject: boolean },
): Promise<RemoteCheck> {
  const findings: Finding[] = [];
  const list = await s.rc(['lsjson', '-R', '--files-only', `${CRYPT_REMOTE}:store`, ...s.common]);
  if (list.code === 3) {
    return {
      findings: [
        { kind: 'store_missing', path: 'store/', detail: 'there is no copy of the store in this folder' },
      ],
      downloaded: 0,
      bytes: 0,
      counts: {},
    };
  }
  if (list.code !== 0) throw new Error(`rclone could not list the store (exit ${list.code ?? list.signal}).`);
  const entries = (JSON.parse(list.stdout || '[]') as { Path: string; Size: number }[]).filter(
    (e) => typeof e.Path === 'string',
  );
  const objects = new Map<string, string>(); // sha → path
  const manifests: string[] = [];
  for (const e of entries) {
    const m = OBJECT_PATH.exec(e.Path);
    if (m && m[1] === m[2]!.slice(0, 2)) objects.set(m[2]!, e.Path);
    else if (MANIFEST_PATH.test(e.Path)) manifests.push(e.Path);
  }
  const all = [...objects.values()];
  const want = o.everyObject
    ? all.length
    : Math.min(all.length, Math.max(o.sampleMin, Math.ceil((all.length * o.samplePercent) / 100)));
  const sample = pickRandom(all, want);
  const listFile = join(s.tmp, 'files-from.txt');
  await writeFile(listFile, `${[...manifests, ...sample].join('\n')}\n`, { mode: 0o600 });
  const into = join(s.tmp, 'sample');
  await mkdir(into, { mode: 0o700 });
  const dl = await s.rc(['copy', `${CRYPT_REMOTE}:store`, into, '--files-from', listFile, ...s.common]);
  // Whatever arrived is checked; a piece that did not arrive is a finding below.
  let bytes = dl.stats?.bytes ?? 0;
  let referenced = 0;
  const referencedSet = new Set<string>();
  for (const mp of manifests) {
    let man: Manifest;
    try {
      man = JSON.parse(gunzipSync(await readFile(join(into, mp))).toString('utf8')) as Manifest;
      if (!Array.isArray(man.pages)) throw new Error('not a manifest');
    } catch (e) {
      findings.push({ kind: 'manifest_unreadable', path: `store/${mp}`, detail: shortErr(e) });
      continue;
    }
    for (const p of manifestPieces(man)) {
      if (!p.sha256) continue;
      referenced++;
      if (referencedSet.has(p.sha256)) continue;
      referencedSet.add(p.sha256);
      if (!objects.has(p.sha256)) {
        findings.push({
          kind: 'missing',
          path: `store/objects/${p.sha256.slice(0, 2)}/${p.sha256}.gz`,
          detail: `named by ${mp.split('/').pop()} (${p.piece}${p.pageId !== '*' ? ` of page ${p.pageId}` : ''}) but not on Drive`,
        });
      }
    }
  }
  let checked = 0;
  for (const op of sample) {
    const sha = OBJECT_PATH.exec(op)![2]!;
    try {
      const raw = gunzipSync(await readFile(join(into, op)));
      const got = createHash('sha256').update(raw).digest('hex');
      if (got !== sha)
        findings.push({
          kind: 'corrupt',
          path: `store/${op}`,
          detail: `decrypts and unpacks, but hashes to ${got.slice(0, 16)}…`,
        });
      checked++;
    } catch (e) {
      findings.push({
        kind: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'corrupt',
        path: `store/${op}`,
        detail:
          (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'listed but could not be downloaded' : shortErr(e),
      });
    }
  }
  // The newest database copy, through SQLite's own check.
  const db = await newestDatabase(s);
  let dbResult: string | null = null;
  if (!db)
    findings.push({ kind: 'database_missing', path: 'database/', detail: 'no database copy on Drive' });
  else {
    const gz = join(s.tmp, db);
    const r = await s.rc(['copyto', `${CRYPT_REMOTE}:database/${db}`, gz, ...s.common]);
    bytes += r.stats?.bytes ?? 0;
    const c =
      r.code === 0
        ? await checkDatabaseCopy(gz, join(s.tmp, 'check.db'))
        : { ok: false, detail: 'could not be downloaded' };
    dbResult = c.ok ? `${db}: ok` : `${db}: ${c.detail}`;
    if (!c.ok) findings.push({ kind: 'database_bad', path: `database/${db}`, detail: c.detail });
  }
  return {
    findings,
    downloaded: manifests.length + checked + (db ? 1 : 0),
    bytes,
    counts: {
      objectsOnDrive: objects.size,
      manifests: manifests.length,
      piecesNamed: referenced,
      sampled: sample.length,
      sampleChecked: checked,
      database: dbResult,
    },
  };
}

/** Every object under `dir/objects` re-hashed against its name, and every manifest's pieces present. */
async function checkLocalStore(
  dir: string,
): Promise<{ findings: Finding[]; objects: number; manifests: number; referenced: number }> {
  const findings: Finding[] = [];
  const have = new Set<string>();
  let objects = 0;
  for (const rel of await walk(join(dir, 'objects'))) {
    const p = `objects/${rel}`;
    const m = OBJECT_PATH.exec(p);
    if (!m) continue;
    objects++;
    try {
      const got = createHash('sha256')
        .update(gunzipSync(await readFile(join(dir, p))))
        .digest('hex');
      if (got === m[2]) have.add(m[2]);
      else findings.push({ kind: 'corrupt', path: p, detail: `hashes to ${got.slice(0, 16)}…` });
    } catch (e) {
      findings.push({ kind: 'corrupt', path: p, detail: shortErr(e) });
    }
  }
  let manifests = 0;
  let referenced = 0;
  for (const rel of await walk(join(dir, 'manifests'))) {
    if (!rel.endsWith('.json.gz')) continue;
    manifests++;
    try {
      const man = JSON.parse(
        gunzipSync(await readFile(join(dir, 'manifests', rel))).toString('utf8'),
      ) as Manifest;
      for (const p of manifestPieces(man)) {
        if (!p.sha256) continue;
        referenced++;
        if (!have.has(p.sha256) && !findings.some((f) => f.path?.includes(p.sha256!)))
          findings.push({
            kind: 'missing',
            path: `objects/${p.sha256.slice(0, 2)}/${p.sha256}.gz`,
            detail: `named by ${rel}`,
          });
      }
    } catch (e) {
      findings.push({ kind: 'manifest_unreadable', path: `manifests/${rel}`, detail: shortErr(e) });
    }
  }
  if (!(await exists(join(dir, 'STORE.json'))))
    findings.push({ kind: 'store_missing', path: 'STORE.json', detail: 'the store marker was not pulled' });
  return { findings, objects, manifests, referenced };
}

/** Unpacks a `.db.gz` copy to `out` and runs SQLite's integrity_check; also checks it is a bridge database. */
async function checkDatabaseCopy(gz: string, out: string): Promise<{ ok: boolean; detail: string }> {
  try {
    await writeFile(out, gunzipSync(await readFile(gz)), { mode: 0o600 });
  } catch (e) {
    return { ok: false, detail: `does not unpack: ${shortErr(e)}` };
  }
  let db: Database.Database | undefined;
  try {
    db = new Database(out, { readonly: true, fileMustExist: true });
    const r = db.pragma('integrity_check', { simple: true });
    if (r !== 'ok') return { ok: false, detail: `integrity_check: ${String(r).slice(0, 200)}` };
    const n = db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'schema_migrations'")
      .get() as { n: number };
    if (n.n !== 1) return { ok: false, detail: 'not a bridge database (no schema_migrations table)' };
    return { ok: true, detail: 'ok' };
  } catch (e) {
    return { ok: false, detail: `SQLite cannot open it: ${shortErr(e)}` };
  } finally {
    db?.close();
  }
}

// ================================================================================================ helpers

function triggerOf(r: OffsiteRequest): RunTrigger {
  return r.trigger === 'after_full' ? 'after_full' : 'request';
}

function stepOf(name: string, r: RcloneResult): StepRecord {
  return {
    name,
    code: r.code,
    bytes: r.stats?.bytes ?? 0,
    files: r.stats?.files ?? 0,
    errors: r.stats?.errors ?? (r.code === 0 ? 0 : 1),
    ms: r.ms,
  };
}

function sumSteps(steps: readonly StepRecord[]): { bytes: number; files: number; errors: number } {
  return steps.reduce(
    (a, s) => ({ bytes: a.bytes + s.bytes, files: a.files + s.files, errors: a.errors + s.errors }),
    {
      bytes: 0,
      files: 0,
      errors: 0,
    },
  );
}

function summarise(c: RemoteCheck): string {
  const k = c.counts;
  const head = `${k.objectsOnDrive ?? 0} objects and ${k.manifests ?? 0} manifests on Drive; ${k.piecesNamed ?? 0} pieces named, ${k.sampleChecked ?? 0} of ${k.sampled ?? 0} sampled objects re-hashed; database ${k.database ?? 'none'}`;
  if (c.findings.length === 0) return `All good: ${head}.`;
  const by = new Map<string, number>();
  for (const f of c.findings) by.set(f.kind, (by.get(f.kind) ?? 0) + 1);
  return `${c.findings.length} problem(s) (${[...by].map(([kk, n]) => `${n} ${kk}`).join(', ')}): ${head}.`;
}

function pickRandom<T>(items: readonly T[], n: number): T[] {
  if (n >= items.length) return [...items];
  const a = [...items];
  for (let i = 0; i < n; i++) {
    const j = i + (randomBytes(4).readUInt32BE(0) % (a.length - i));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}

function shortErr(e: unknown): string {
  return redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 200);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir: string, prefix = ''): Promise<string[]> {
  let names: Dirent[];
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const d of names) {
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...(await walk(join(dir, d.name), rel)));
    else if (d.isFile()) out.push(rel);
  }
  return out;
}

async function countFiles(dir: string): Promise<number> {
  return (await walk(dir)).length;
}

async function chmodTree(dir: string): Promise<void> {
  for (const rel of await walk(dir)) await chmod(join(dir, rel), 0o600).catch(() => undefined);
}

export function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
