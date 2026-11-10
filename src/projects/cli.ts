/**
 * `npm run projects -- <command>` (v2 A1): the projects this bridge's database knows, and the one flag the owner sets
 * here rather than on the dashboard: whether a project is a SANDBOX (the sandbox, soak and spike scripts refuse every
 * other project). Uses DB_PATH (default ./data/bridge.db). Run it on the server as the service user:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm run projects -- list
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm run projects -- sandbox test on
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/lk-run.sh npm run projects -- set test aiRepositoryRootId <id>
 *
 * v2 A2: `settings <name>` shows a project's settings and `set <name> <key> <value>` changes one (`-` clears it, so the
 * default applies again). The running bridge reads tree settings from the database, so a change applies without a
 * restart.
 *
 * A project appears here once the bridge has verified its key (or the migration registered the single-project form's
 * project). Changes are audited (`project.set_sandbox`, `project.set_setting`, actor `owner`, via `projects-cli`).
 * Keys are never read.
 */
import { pathToFileURL } from 'node:url';
import { defaultMigrationsDir, migrationContextFromEnv, runMigrations } from '../db/migrate.js';
import { openDatabase } from '../db/open.js';
import { PolicyStore } from '../policy/store.js';
import {
  PROJECT_SETTING_KEYS,
  SettingValueError,
  parseSettingValue,
  type ProjectSettings,
} from './settings.js';
import { ProjectStore } from './store.js';

const usage = `Usage:
  npm run projects -- list
  npm run projects -- sandbox <name> on|off     mark a project as a sandbox (test world only) or not
  npm run projects -- settings <name>           show a project's settings
  npm run projects -- set <name> <key> <value>  change one setting ("-" clears it); keys: ${PROJECT_SETTING_KEYS.filter(
    (k) => k.editable,
  )
    .map((k) => k.key)
    .join(', ')}`;

const showValue = (v: unknown): string =>
  v === undefined ? 'not set' : typeof v === 'string' ? v : JSON.stringify(v);

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
    if (cmd === 'settings' || cmd === 'set') {
      const [name, key, ...valueParts] = rest;
      if (!name || (cmd === 'set' && (!key || valueParts.length === 0))) {
        out(usage);
        return 2;
      }
      const p = store.byName(name.trim().toLowerCase());
      if (!p) {
        out(`No project named "${name}" is registered. \`npm run projects -- list\` shows them.`);
        return 1;
      }
      if (cmd === 'settings') {
        if (p.settingsProblem) out(`The stored settings could not be read: ${p.settingsProblem}`);
        const settings = p.settings as Record<string, unknown>;
        for (const k of PROJECT_SETTING_KEYS) {
          const v = settings[k.key];
          const shown =
            v === undefined && k.default !== undefined ? `${showValue(k.default)} (default)` : showValue(v);
          out(`${k.key}  ${shown}`);
        }
        for (const k of Object.keys(settings)) {
          if (!PROJECT_SETTING_KEYS.some((d) => d.key === k)) out(`${k}  ${showValue(settings[k])}`);
        }
        return 0;
      }
      let value: string | boolean | null;
      try {
        value = parseSettingValue(key!, valueParts.join(' '));
      } catch (e) {
        out(e instanceof SettingValueError ? e.message : String(e));
        return 2;
      }
      const before = (p.settings as Record<string, unknown>)[key!];
      if (JSON.stringify(before ?? null) === JSON.stringify(value)) {
        out(`${key} of "${p.name}" is already ${showValue(value ?? undefined)}. Nothing changed.`);
        return 0;
      }
      store.setSetting(p.id, key!, value);
      new PolicyStore(db).audit(
        'owner',
        'project.set_setting',
        p.name,
        { key, value: before ?? null },
        { key, value, via: 'projects-cli' },
      );
      const note: Partial<Record<keyof ProjectSettings, string>> = {
        aiRepositoryRootId:
          ' The repository tree of this project is now "not built": start its first build on the dashboard (Repository Tree).',
      };
      out(
        `${key} of "${p.name}" is now ${showValue(value ?? undefined)}.${note[key as keyof ProjectSettings] ?? ''}`,
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
