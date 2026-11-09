/**
 * `npm run projects -- <command>` (v2 A1): the projects this bridge's database knows, and the one flag the owner sets
 * here rather than on the dashboard: whether a project is a SANDBOX (the sandbox, soak and spike scripts refuse every
 * other project). Uses DB_PATH (default ./data/bridge.db). Run it on the server as the service user:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm run projects -- list
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm run projects -- sandbox test on
 *
 * A project appears here once the bridge has verified its key (or the migration registered the single-project form's
 * project). Changes are audited (`project.set_sandbox`, actor `owner`, via `projects-cli`). Keys are never read.
 */
import { pathToFileURL } from 'node:url';
import { defaultMigrationsDir, migrationContextFromEnv, runMigrations } from '../db/migrate.js';
import { openDatabase } from '../db/open.js';
import { PolicyStore } from '../policy/store.js';
import { ProjectStore } from './store.js';

const usage = `Usage:
  npm run projects -- list
  npm run projects -- sandbox <name> on|off     mark a project as a sandbox (test world only) or not`;

const iso = (t: number | null) => (t === null ? '-' : new Date(t).toISOString());

export function runProjectsCommand(
  argv: readonly string[],
  dbPath: string,
  out: (s: string) => void,
): number {
  const db = openDatabase(dbPath);
  try {
    runMigrations(db, defaultMigrationsDir(), { context: migrationContextFromEnv() });
    const store = new ProjectStore(db);
    const [cmd, ...rest] = argv;
    if (cmd === 'list') {
      const rows = store.list();
      if (rows.length === 0) {
        out('No project is registered yet: the bridge registers each project once its key is verified.');
        return 0;
      }
      for (const p of rows) {
        out(
          `${p.name}  id ${p.id}  ${p.displayName ? `"${p.displayName}"  ` : ''}` +
            `default ${p.isDefault ? 'yes' : 'no'}  sandbox ${p.isSandbox ? 'yes' : 'no'}  ` +
            `read-only ${p.readOnly ? 'yes' : 'no'}  verified ${iso(p.verifiedAt)}`,
        );
      }
      return 0;
    }
    if (cmd === 'sandbox') {
      const [name, value] = rest;
      if (!name || (value !== 'on' && value !== 'off')) {
        out(usage);
        return 2;
      }
      const p = store.byName(name.trim().toLowerCase());
      if (!p) {
        out(`No project named "${name}" is registered. \`npm run projects -- list\` shows them.`);
        return 1;
      }
      const sandbox = value === 'on';
      if (p.isSandbox === sandbox) {
        out(`Project "${p.name}" is already ${sandbox ? '' : 'not '}a sandbox. Nothing changed.`);
        return 0;
      }
      store.setSandbox(p.id, sandbox);
      new PolicyStore(db).audit(
        'owner',
        'project.set_sandbox',
        p.name,
        { isSandbox: p.isSandbox },
        { isSandbox: sandbox, via: 'projects-cli' },
      );
      out(
        sandbox
          ? `Project "${p.name}" (${p.id}) is now a sandbox: the sandbox, soak and spike scripts may write to it. ` +
              'Only ever do this for a test world.'
          : `Project "${p.name}" (${p.id}) is no longer a sandbox: the scripts refuse it.`,
      );
      return 0;
    }
    out(usage);
    return 2;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runProjectsCommand(
    process.argv.slice(2),
    process.env.DB_PATH ?? './data/bridge.db',
    (s) => process.stdout.write(`${s}\n`),
  );
}
