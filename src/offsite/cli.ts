/**
 * The off-site runner's command line (v2 E1b, ADR 0043), run as the service user (`lkbridge`):
 *
 *   node dist/offsite/cli.js run                     what lk-bridge-offsite.service runs (deploy/offsite.sh): requests
 *                                                    and whatever the schedule says is due
 *   node dist/offsite/cli.js copy | verify           a copy or a verify now
 *   node dist/offsite/cli.js status                  the connection, keys, folder and the last runs (no secret)
 *   node dist/offsite/cli.js check-rclone            whether rclone is installed and new enough
 *   node dist/offsite/cli.js set-client              the Google client ID and secret, from standard input (two lines)
 *   node dist/offsite/cli.js connect                 Google's sign-in without the dashboard: prints the address to
 *                                                    open, then reads the address Google sent the browser back to
 *   node dist/offsite/cli.js set-keys                the encryption password and salt, from standard input (two lines)
 *   node dist/offsite/cli.js generations             the copy-<n> folders on Drive under the folder setting
 *   node dist/offsite/cli.js restore --dest DIR [--folder PATH]
 *                                                    pulls the store and the newest database copy and checks them
 *   (any command) --env-file FILE                    the env file (default LKB_ENV_FILE, else /etc/lk-bridge/lk-bridge.env)
 *
 * The CLI equivalents of the dashboard (set-client, connect, set-keys) are for a disaster recovery before the dashboard
 * is up. Secrets are only ever read from standard input, never from arguments, and nothing prints a value.
 *
 * Settings read from the env file: SECRETS_MASTER_KEY (and _PREVIOUS), DB_PATH, BRIDGE_PUBLIC_URL, SNAPSHOT_DIR,
 * BACKUP_DIR. `LKB_RCLONE` (environment) names the rclone binary (default: `rclone` on PATH).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { parseEnvFile } from '../config/check.js';
import { openDatabase } from '../db/open.js';
import { OFFSITE_SCOPE, SecretStore } from '../secrets/store.js';
import { OffsiteDb } from './db.js';
import {
  GoogleOAuth,
  pkcePair,
  randomState,
  reconnectReason,
  GoogleError,
  type GoogleEndpoints,
} from './google.js';
import { children } from './rclone.js';
import { checkRclone } from './rclone.js';
import { requestDir } from './requests.js';
import { OffsiteRunner } from './runner.js';
import { OffsiteService } from './service.js';

const DEFAULT_ENV_FILE = '/etc/lk-bridge/lk-bridge.env';
const DEFAULT_DB = '/var/lib/lk-bridge/bridge.db';

interface Ctx {
  readonly env: Record<string, string>;
  readonly dbPath: string;
}

function readEnvFile(file: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(
      `Cannot read the env file ${file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}. Run this as lkbridge.`,
      {
        cause: e,
      },
    );
  }
}

/** Test seam (NODE_ENV=test only): a mock Google at LKB_TEST_GOOGLE_BASE, and the fake rclone's FAKE_RCLONE_* settings. */
function testSeams(): { endpoints?: GoogleEndpoints; rcloneEnv?: Record<string, string> } {
  if (process.env.NODE_ENV !== 'test') return {};
  const base = process.env.LKB_TEST_GOOGLE_BASE;
  const rcloneEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (k.startsWith('FAKE_RCLONE_') && v !== undefined) rcloneEnv[k] = v;
  return {
    ...(base
      ? {
          endpoints: {
            authorize: `${base}/authorize`,
            token: `${base}/token`,
            revoke: `${base}/revoke`,
            drive: `${base}/drive/v3`,
          },
        }
      : {}),
    rcloneEnv,
  };
}

async function readLines(n: number, prompt: (i: number) => string): Promise<string[]> {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const out: string[] = [];
  const it = rl[Symbol.asyncIterator]();
  for (let i = 0; i < n; i++) {
    process.stderr.write(prompt(i));
    const r = await it.next();
    if (r.done) break;
    out.push(String(r.value).trim());
  }
  rl.close();
  return out;
}

export async function runOffsiteCli(
  argv: readonly string[],
  out: (s: string) => void = (s) => process.stdout.write(`${s}\n`),
): Promise<number> {
  const args = [...argv];
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const envFile = opt('--env-file') ?? process.env.LKB_ENV_FILE ?? DEFAULT_ENV_FILE;
  const dest = opt('--dest');
  const folder = opt('--folder');
  const cmd = args[0] ?? 'run';
  const env = readEnvFile(envFile);
  const ctx: Ctx = { env, dbPath: env.DB_PATH || process.env.DB_PATH || DEFAULT_DB };
  if (!existsSync(ctx.dbPath)) {
    out(
      `ERROR: no bridge database at ${ctx.dbPath}. Install and start the bridge first (it creates and migrates it).`,
    );
    return 1;
  }
  const db = openDatabase(ctx.dbPath);
  try {
    const hasTable = db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'offsite_state'")
      .get() as { n: number };
    if (hasTable.n !== 1) {
      out('ERROR: the database has no off-site tables yet: deploy this release (its migrations) first.');
      return 1;
    }
    const secrets = new SecretStore(db, {
      masterKey: env.SECRETS_MASTER_KEY,
      previousMasterKey: env.SECRETS_MASTER_KEY_PREVIOUS,
    });
    const seams = testSeams();
    const dataDir = dirname(ctx.dbPath);
    const runner = new OffsiteRunner({
      db,
      secrets,
      dbPath: ctx.dbPath,
      snapshotDir: env.SNAPSHOT_DIR || join(dataDir, 'snapshots'),
      backupDir: env.BACKUP_DIR || join(dataDir, 'backups'),
      requestDir: requestDir(ctx.dbPath),
      ...(env.BRIDGE_PUBLIC_URL ? { publicUrl: env.BRIDGE_PUBLIC_URL } : {}),
      rcloneBin: process.env.LKB_RCLONE || 'rclone',
      ...(seams.rcloneEnv ? { rcloneEnv: seams.rcloneEnv } : {}),
      ...(seams.endpoints ? { google: { endpoints: seams.endpoints } } : {}),
      log: out,
    });
    const store = new OffsiteDb(db);
    switch (cmd) {
      case 'run': {
        const r = await runner.tick();
        if (r.did.length) out(`Done: ${r.did.join(', ')}.`);
        return 0;
      }
      case 'copy': {
        const id = await runner.copy('cli');
        return store.run(id)?.state === 'succeeded' ? 0 : 1;
      }
      case 'verify': {
        const id = await runner.verify('cli');
        const run = store.run(id);
        out(run?.message ?? '');
        for (const f of store.findings(id, 50))
          out(`  ${f.kind}: ${f.path ?? ''} ${f.detail ?? ''}`.trimEnd());
        return run?.state === 'succeeded' ? 0 : 1;
      }
      case 'check-rclone': {
        const r = await checkRclone({ bin: process.env.LKB_RCLONE || 'rclone', home: '/tmp' });
        out(r.ok ? `rclone ${r.version}: OK` : `ERROR: ${r.message}`);
        return r.ok ? 0 : 1;
      }
      case 'status': {
        const st = store.state();
        const settings = runner.settings();
        const f = store.currentFolder(settings.folder);
        out(`Google client: ${secrets.has(OFFSITE_SCOPE, 'drive_client_id') ? 'saved' : 'not set'}`);
        out(
          `Connection: ${st.connection}${st.accountEmail ? ` (${st.accountEmail})` : ''}${st.brokenReason ? ` — ${st.brokenReason}` : ''}`,
        );
        out(
          `Encryption keys: ${secrets.has(OFFSITE_SCOPE, 'drive_crypt_password') ? `set ${st.keysSetAt ? new Date(st.keysSetAt).toISOString() : ''}` : 'not set'}`,
        );
        out(`Drive folder: ${f.path}`);
        for (const r of store.runs({ limit: 5 }))
          out(
            `  run ${r.id} ${r.kind} (${r.trigger}) ${new Date(r.startedAt).toISOString()} ${r.state}${r.message ? `: ${r.message.split('\n')[0]}` : ''}`,
          );
        return 0;
      }
      case 'set-client': {
        const [id, secret] = await readLines(2, (i) => (i === 0 ? 'Client ID: ' : 'Client secret: '));
        const svc = new OffsiteService({
          db,
          secrets,
          publicUrl: env.BRIDGE_PUBLIC_URL ?? 'https://localhost',
          requestDir: requestDir(ctx.dbPath),
        });
        await svc.saveClient(id ?? '', secret ?? '');
        out('Saved the Google client in the encrypted store.');
        return 0;
      }
      case 'set-keys': {
        const [pw, salt] = await readLines(2, (i) =>
          i === 0 ? 'Encryption password: ' : 'Salt (second password): ',
        );
        const svc = new OffsiteService({
          db,
          secrets,
          publicUrl: env.BRIDGE_PUBLIC_URL ?? 'https://localhost',
          requestDir: requestDir(ctx.dbPath),
        });
        svc.setOwnKeys({ password: pw ?? '', salt: salt ?? '', acknowledgeNewFolder: true });
        out('Saved the encryption keys in the encrypted store.');
        return 0;
      }
      case 'connect': {
        if (!env.BRIDGE_PUBLIC_URL) {
          out('ERROR: BRIDGE_PUBLIC_URL is not set in the env file (the redirect address is built from it).');
          return 1;
        }
        const svc = new OffsiteService({
          db,
          secrets,
          publicUrl: env.BRIDGE_PUBLIC_URL,
          requestDir: requestDir(ctx.dbPath),
          ...(seams.endpoints ? { google: { endpoints: seams.endpoints } } : {}),
        });
        const idR = secrets.read(OFFSITE_SCOPE, 'drive_client_id');
        const secR = secrets.read(OFFSITE_SCOPE, 'drive_client_secret');
        if (!idR.ok || !secR.ok) {
          out('ERROR: save the Google client first (set-client).');
          return 1;
        }
        const google = new GoogleOAuth(seams.endpoints ? { endpoints: seams.endpoints } : {});
        const state = randomState();
        const { verifier, challenge } = pkcePair();
        out('Open this address in a browser, sign in and allow access:');
        out(google.authorizeUrl({ clientId: idR.value, redirectUri: svc.redirectUri, state, challenge }));
        out(
          'Google then sends the browser to the bridge’s address. Use this only while the bridge is not answering (the page does not load, so the address stays in the bar); when it is up, connect on the dashboard instead.',
        );
        const [pasted] = await readLines(1, () => 'Paste the whole address from the browser’s address bar: ');
        let back: URL;
        try {
          back = new URL(pasted ?? '');
        } catch {
          out('ERROR: that is not an address.');
          return 1;
        }
        if (back.searchParams.get('state') !== state) {
          out('ERROR: the address does not belong to this sign-in (its state differs). Nothing was changed.');
          return 1;
        }
        const code = back.searchParams.get('code');
        if (!code) {
          out(`ERROR: Google sent no code (${back.searchParams.get('error') ?? 'no reason'}).`);
          return 1;
        }
        try {
          const t = await google.exchange(
            { clientId: idR.value, clientSecret: secR.value },
            { code, verifier, redirectUri: svc.redirectUri },
          );
          // v2 E4 (RV1-5): the dashboard's two checks (ADR 0043): a grant without drive.file is revoked and refused,
          // and the token it replaces is revoked so it cannot linger.
          if (!t.scope.split(/\s+/).includes('https://www.googleapis.com/auth/drive.file')) {
            await google.revoke(t.refreshToken ?? t.accessToken).catch(() => undefined);
            out(
              'ERROR: Google did not grant the drive.file permission (it must be ticked on the consent page). Nothing was kept; connect again.',
            );
            return 1;
          }
          const old = secrets.read(OFFSITE_SCOPE, 'drive_refresh_token');
          secrets.write(OFFSITE_SCOPE, 'drive_refresh_token', t.refreshToken!, { source: 'dashboard' });
          if (old.ok && old.value !== t.refreshToken) await google.revoke(old.value).catch(() => undefined);
          const account = await google.account(t.accessToken).catch(() => ({ email: null, name: null }));
          store.setConnected(account);
          out(`Connected${account.email ? ` as ${account.email}` : ''}.`);
          return 0;
        } catch (e) {
          out(`ERROR: ${e instanceof GoogleError ? reconnectReason(e) : (e as Error).message}`);
          return 1;
        }
      }
      case 'generations': {
        for (const g of await runner.listGenerations()) out(g);
        return 0;
      }
      case 'restore': {
        if (!dest) {
          out('usage: restore --dest DIR [--folder "LK-Bridge backups/<server>/copy-<n>"]');
          return 2;
        }
        const r = await runner.restore({ dest, ...(folder ? { folder } : {}) });
        for (const l of r.report) out(l);
        out(r.ok ? 'RESTORE CHECK PASSED' : 'RESTORE CHECK FAILED');
        return r.ok ? 0 : 1;
      }
      default:
        out(
          `Unknown command "${cmd}". Commands: run, copy, verify, status, check-rclone, set-client, connect, set-keys, generations, restore.`,
        );
        return 2;
    }
  } finally {
    db.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // A stop (systemctl stop, a shutdown) ends rclone first; the exit handler then removes the temporary config.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      for (const c of children) c.kill('SIGTERM');
      process.stdout.write(`Stopped by ${sig}.\n`);
      process.exit(sig === 'SIGTERM' ? 143 : 130);
    });
  }
  runOffsiteCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`ERROR: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
