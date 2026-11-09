import { pathToFileURL } from 'node:url';
import { type DestinationStream, pino } from 'pino';
import { defaultMigrationsDir, migrationContextFromEnv, runMigrations } from '../../db/migrate.js';
import { openDatabase } from '../../db/open.js';
import { ensureProfile, DEFAULT_PAT_PROFILE } from '../../policy/consent.js';
import { PolicyStore } from '../../policy/store.js';
import { isScope, type ProfileKind } from '../../policy/types.js';
import { createAuthEventLogger } from '../events.js';
import { PatService } from '../pats.js';
import { AuthStore } from '../store.js';

/**
 * `npm run pat -- <command>`: manage personal access tokens on the server until the dashboard
 * (chunk 5) offers the same. Uses DB_PATH (default ./data/bridge.db).
 *
 *   create --name "Claude Code on my laptop" [--profile claude-code] [--scope read|propose|write] [--expires-days 90]
 *   list
 *   revoke <pat_id>
 */

const usage = `Usage:
  npm run pat -- create --name "<name>" [--profile <label>] [--scope read|propose|write] [--expires-days <n>]
      --profile  the policy profile the token acts under (default: claude-code); created if absent,
                 at the default scope for new connections (read) unless --scope is given
      --scope    with a new profile: its scope; with an existing one: changes that profile's scope
  npm run pat -- list
  npm run pat -- revoke <pat_id>`;

const iso = (t: number | null) => (t === null ? '-' : new Date(t * 1000).toISOString());

export function runPatCommand(
  argv: readonly string[],
  dbPath: string,
  out: (s: string) => void,
  logDestination: DestinationStream = pino.destination(2),
): number {
  const db = openDatabase(dbPath);
  try {
    runMigrations(db, defaultMigrationsDir(), { context: migrationContextFromEnv() });
    const log = pino({ level: 'info' }, logDestination);
    const policy = new PolicyStore(db);
    const pats = new PatService({
      store: new AuthStore(db),
      event: createAuthEventLogger(log),
      now: () => Math.floor(Date.now() / 1000),
    });
    const [cmd, ...rest] = argv;
    const opt = (name: string) => {
      const i = rest.indexOf(name);
      return i >= 0 ? rest[i + 1] : undefined;
    };
    if (cmd === 'create') {
      const name = opt('--name');
      const days = opt('--expires-days');
      const label = opt('--profile') ?? DEFAULT_PAT_PROFILE;
      const scope = opt('--scope');
      if (!name || (scope !== undefined && !isScope(scope))) {
        out(usage);
        return 2;
      }
      const kind: ProfileKind = label.toLowerCase() === DEFAULT_PAT_PROFILE ? 'claude-code' : 'other';
      const profile = policy.tx(() => {
        const { id, created } = ensureProfile(policy, label, kind, scope);
        const p = policy.getProfile(id)!;
        if (!created && scope !== undefined && p.scope !== scope) {
          policy.updateScope(id, scope);
          policy.audit('owner', 'profile.set_scope', id, { scope: p.scope }, { scope, via: 'pat-cli' });
        }
        return policy.getProfile(id)!;
      });
      const created = pats.create({
        name,
        profileId: profile.id,
        ...(days !== undefined ? { expiresInDays: Number(days) } : {}),
      });
      out(
        `Created ${created.pat.id} ("${created.pat.name}") on profile "${profile.label}" (scope ${profile.scope}). ` +
          `This token is shown once; store it now:\n\n` +
          `  ${created.token}\n\n` +
          'Connect Claude Code with:\n' +
          `  claude mcp add --transport http lk-bridge <BRIDGE_PUBLIC_URL>/mcp --scope user -H "Authorization: Bearer ${created.token}"`,
      );
      return 0;
    }
    if (cmd === 'list') {
      const list = pats.list();
      if (list.length === 0) out('No personal access tokens.');
      for (const p of list) {
        const status = p.revokedAt !== null ? 'revoked' : 'active';
        const profile = p.profileId ? policy.getProfile(p.profileId) : undefined;
        const prof = profile ? `${profile.label} (${profile.scope})` : '(no profile)';
        out(
          `${p.id}  ${status.padEnd(7)}  …${p.hint}  profile ${prof}  created ${iso(p.createdAt)}  last used ${iso(p.lastUsedAt)}  expires ${iso(p.expiresAt)}  ${p.name}`,
        );
      }
      return 0;
    }
    if (cmd === 'revoke' && rest[0]) {
      const ok = pats.revoke(rest[0]);
      out(ok ? `Revoked ${rest[0]}.` : `No active token with id ${rest[0]}.`);
      return ok ? 0 : 1;
    }
    out(usage);
    return 2;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = runPatCommand(process.argv.slice(2), process.env.DB_PATH ?? './data/bridge.db', (s) =>
      process.stdout.write(`${s}\n`),
    );
  } catch (err) {
    process.stderr.write(`pat: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}
