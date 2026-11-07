import { pathToFileURL } from 'node:url';
import { pino } from 'pino';
import { runMigrations } from '../../db/migrate.js';
import { openDatabase } from '../../db/open.js';
import { createAuthEventLogger } from '../events.js';
import { PatService } from '../pats.js';
import { AuthStore } from '../store.js';

/**
 * `npm run pat -- <command>`: manage personal access tokens on the server until the dashboard
 * (chunk 5) offers the same. Uses DB_PATH (default ./data/bridge.db).
 *
 *   create --name "Claude Code on my laptop" [--expires-days 90]
 *   list
 *   revoke <pat_id>
 */

const usage = `Usage:
  npm run pat -- create --name "<name>" [--expires-days <n>]
  npm run pat -- list
  npm run pat -- revoke <pat_id>`;

const iso = (t: number | null) => (t === null ? '-' : new Date(t * 1000).toISOString());

export function runPatCommand(argv: readonly string[], dbPath: string, out: (s: string) => void): number {
  const db = openDatabase(dbPath);
  try {
    runMigrations(db);
    const log = pino({ level: 'info' }, pino.destination(2));
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
      if (!name) {
        out(usage);
        return 2;
      }
      const created = pats.create({ name, ...(days !== undefined ? { expiresInDays: Number(days) } : {}) });
      out(
        `Created ${created.pat.id} ("${created.pat.name}"). This token is shown once; store it now:\n\n` +
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
        out(
          `${p.id}  ${status.padEnd(7)}  …${p.hint}  created ${iso(p.createdAt)}  last used ${iso(p.lastUsedAt)}  expires ${iso(p.expiresAt)}  ${p.name}`,
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
