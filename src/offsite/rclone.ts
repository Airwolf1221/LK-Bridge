/**
 * rclone, as the off-site runner uses it (v2 E1b, ADR 0043).
 *
 * - **Version:** at least 1.60.0 (`MIN_RCLONE`). Everything used exists there: the `drive` backend with `scope =
 *   drive.file` and a supplied OAuth token, the `crypt` backend with `filename_encryption = standard` and
 *   `directory_name_encryption`, `obscure -` (from standard input), `copy`, `copyto`, `sync` with `--backup-dir`,
 *   `--min-age`, `--files-from`, `lsjson`, `lsf`, `purge`, `--use-json-log` with its stats, `--bwlimit`, `--transfers`,
 *   `--fast-list` and `--drive-stop-on-upload-limit`. The runbook recommends rclone's current release (Ubuntu 24.04's own
 *   package is 1.60.1 from 2022 and misses years of fixes), and the runner refuses anything older than 1.60 with a clear
 *   message.
 * - **Config:** a temporary file (0600, in a 0700 directory under the unit's PrivateTmp, removed on exit, even after a
 *   failure) with a `drive` remote and a `crypt` remote over it. The crypt password and salt are written in rclone's
 *   obscured form, made by rclone itself from standard input, so a key never appears on a command line.
 * - **Environment:** rclone gets a minimal environment (PATH, HOME and TMPDIR inside the temporary directory, LANG): no
 *   variable of the runner's, so never SECRETS_MASTER_KEY, and no stray RCLONE_* setting.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { redactSecrets } from './google.js';

export const MIN_RCLONE: readonly [number, number, number] = [1, 60, 0];
export const DRIVE_REMOTE = 'lkdrive';
export const CRYPT_REMOTE = 'lkcrypt';

export interface RcloneStats {
  bytes: number;
  files: number;
  errors: number;
  checks: number;
  deletes: number;
}

export interface RcloneResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  /** The last lines of rclone's log, redacted (never a token). */
  readonly logTail: string[];
  readonly stats: RcloneStats | null;
  readonly ms: number;
}

export interface RcloneRunner {
  readonly bin: string;
  /** Extra environment for rclone (tests only: the fake rclone's settings). */
  readonly env?: Readonly<Record<string, string>>;
  /** HOME and TMPDIR for rclone. */
  readonly home: string;
}

/** The rclone processes running now, so a stop (SIGTERM) can end them before the runner exits. */
export const children = new Set<ChildProcess>();

export function versionAtLeast(
  v: readonly [number, number, number],
  min: readonly [number, number, number],
): boolean {
  for (let i = 0; i < 3; i++) {
    if (v[i]! > min[i]!) return true;
    if (v[i]! < min[i]!) return false;
  }
  return true;
}

export function parseVersion(out: string): [number, number, number] | null {
  const m = /rclone v(\d+)\.(\d+)\.(\d+)/.exec(out);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function childEnv(r: RcloneRunner): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: r.home,
    TMPDIR: r.home,
    LANG: 'C.UTF-8',
    ...r.env,
  };
}

export function rcloneRun(
  r: RcloneRunner,
  args: readonly string[],
  o: { stdin?: string; secrets?: readonly string[]; onLine?: (line: string) => void } = {},
): Promise<RcloneResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(r.bin, [...args], { env: childEnv(r), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({
        code: 127,
        signal: null,
        stdout: '',
        logTail: [redactSecrets(String((e as Error).message))],
        stats: null,
        ms: Date.now() - started,
      });
      return;
    }
    children.add(child);
    let stdout = '';
    let errBuf = '';
    const tail: string[] = [];
    let stats: RcloneStats | null = null;
    const line = (l: string) => {
      if (l.trim() === '') return;
      let text = l;
      try {
        const j = JSON.parse(l) as { msg?: unknown; level?: unknown; stats?: Record<string, unknown> };
        if (j.stats && typeof j.stats === 'object') {
          const n = (k: string) => (typeof j.stats![k] === 'number' ? j.stats![k] : 0);
          stats = {
            bytes: n('bytes'),
            files: n('transfers'),
            errors: n('errors'),
            checks: n('checks'),
            deletes: n('deletes'),
          };
        }
        text = `${typeof j.level === 'string' ? `${j.level}: ` : ''}${typeof j.msg === 'string' ? j.msg : ''}`;
      } catch {
        // a plain line
      }
      const safe = redactSecrets(text, o.secrets ?? []).slice(0, 500);
      tail.push(safe);
      if (tail.length > 30) tail.shift();
      o.onLine?.(safe);
    };
    child.stdout!.setEncoding('utf8').on('data', (d: string) => {
      if (stdout.length < 64 * 1024 * 1024) stdout += d;
    });
    child.stderr!.setEncoding('utf8').on('data', (d: string) => {
      errBuf += d;
      let i: number;
      while ((i = errBuf.indexOf('\n')) >= 0) {
        line(errBuf.slice(0, i));
        errBuf = errBuf.slice(i + 1);
      }
    });
    child.on('error', (e) => {
      tail.push(redactSecrets(e.message));
    });
    child.on('close', (code, signal) => {
      children.delete(child);
      if (errBuf) line(errBuf);
      resolve({
        code: code ?? (signal ? null : 1),
        signal,
        stdout,
        logTail: tail,
        stats,
        ms: Date.now() - started,
      });
    });
    child.stdin!.on('error', () => undefined);
    child.stdin!.end(o.stdin ?? '');
  });
}

/** The installed rclone's version, or why it cannot be used. */
export async function checkRclone(
  r: RcloneRunner,
): Promise<{ ok: true; version: string } | { ok: false; version: string | null; message: string }> {
  const res = await rcloneRun(r, ['version']);
  if (res.code === 127 || (res.code !== 0 && res.stdout === '')) {
    return {
      ok: false,
      version: null,
      message: `rclone is not installed (or "${r.bin}" cannot be run). Install it: see the runbook, "Off-site copy to Google Drive" (one command).`,
    };
  }
  const v = parseVersion(res.stdout);
  if (!v) return { ok: false, version: null, message: 'rclone did not report its version.' };
  const text = v.join('.');
  if (!versionAtLeast(v, MIN_RCLONE)) {
    return {
      ok: false,
      version: text,
      message: `rclone ${text} is too old: the off-site copy needs ${MIN_RCLONE.join('.')} or newer. Install the current release (runbook, "Off-site copy to Google Drive").`,
    };
  }
  return { ok: true, version: text };
}

/** rclone's obscured form of a value, made by rclone itself (`obscure -` reads standard input). */
export async function obscure(r: RcloneRunner, value: string): Promise<string> {
  const res = await rcloneRun(r, ['obscure', '-'], { stdin: `${value}\n`, secrets: [value] });
  const out = res.stdout.trim();
  if (res.code !== 0 || out === '' || /\s/.test(out)) {
    throw new Error(`rclone could not obscure a key (exit ${res.code ?? res.signal ?? '?'}).`);
  }
  return out;
}

export interface ConfigInput {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  /** The Drive folder the crypt remote encrypts into (its own name is not encrypted). */
  readonly folder: string;
  readonly obscuredPassword: string;
  readonly obscuredSalt: string;
}

/** The rclone config: a drive remote (drive.file, the owner's client, the token) and a crypt remote over a folder. */
export function configText(c: ConfigInput): string {
  const token = JSON.stringify({
    access_token: c.accessToken,
    token_type: 'Bearer',
    refresh_token: c.refreshToken,
    expiry: new Date(c.expiresAt).toISOString(),
  });
  for (const v of [c.clientId, c.clientSecret, c.folder, c.obscuredPassword, c.obscuredSalt]) {
    if (/[\r\n]/.test(v)) throw new Error('a config value spans lines');
  }
  return [
    `[${DRIVE_REMOTE}]`,
    'type = drive',
    'scope = drive.file',
    `client_id = ${c.clientId}`,
    `client_secret = ${c.clientSecret}`,
    `token = ${token}`,
    '',
    `[${CRYPT_REMOTE}]`,
    'type = crypt',
    `remote = ${DRIVE_REMOTE}:${c.folder}`,
    'filename_encryption = standard',
    'directory_name_encryption = true',
    `password = ${c.obscuredPassword}`,
    `password2 = ${c.obscuredSalt}`,
    '',
  ].join('\n');
}

/** The refresh token in a config rclone may have rewritten (it refreshes tokens itself during a long run). */
export function tokenFromConfig(text: string): { refreshToken: string | null; accessToken: string | null } {
  let inDrive = false;
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (l.startsWith('[')) {
      inDrive = l === `[${DRIVE_REMOTE}]`;
      continue;
    }
    if (!inDrive) continue;
    const m = /^token\s*=\s*(.+)$/.exec(l);
    if (!m) continue;
    try {
      const j = JSON.parse(m[1]!) as { refresh_token?: unknown; access_token?: unknown };
      return {
        refreshToken: typeof j.refresh_token === 'string' && j.refresh_token !== '' ? j.refresh_token : null,
        accessToken: typeof j.access_token === 'string' ? j.access_token : null,
      };
    } catch {
      return { refreshToken: null, accessToken: null };
    }
  }
  return { refreshToken: null, accessToken: null };
}
