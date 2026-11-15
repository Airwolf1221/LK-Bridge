/**
 * Which LegendKeeper project the sandbox, soak, spike and round-trip scripts may use, and with which key.
 *
 * Each script takes `--project <name>` (the wrapper scripts pass it on; `npm run test:sandbox` reads it from
 * `LKB_SANDBOX_PROJECT`). The project must be registered in the BRIDGE'S database (`DB_PATH`), not removed on the
 * dashboard, and, for every script but the round trip, marked as a sandbox there (`is_sandbox`, set with
 * `npm run projects -- sandbox <name> on`); anything else is refused before any request is made. The Markdown round
 * trip alone (`resolveReadOnlyTarget`, v2 E5 hotfix, ADR 0046) accepts any registered project, because its runtime is
 * read-only by construction.
 *
 * The key is found exactly as the running bridge finds it (OPS2, ADR 0028; `resolveProjectKey` in src/secrets): the key
 * kept in the bridge's encrypted store for that project, opened with `SECRETS_MASTER_KEY`; only when nothing is stored
 * for it, the env file's `LK_PROJECT_<NAME>_API_KEY` (or, in the single-project form, `LK_API_KEY` for the project
 * named by `LK_PROJECT_NAME`, default `test`). A stored key that cannot be opened is refused, never replaced by the env
 * file's. The scripts then check that the key's own project is exactly the registered one, before anything is written.
 *
 * Where those few values come from: on the server the wrapper scripts (deploy/lib.sh, `sandbox_project_env`) export
 * `LKB_ENV_FILE`, and only the names listed in `keyNames` are read from that file (as `npm run db:migrate` does); the
 * master key is never put in any process's environment. Without `LKB_ENV_FILE` (a developer's machine) they come from
 * the environment.
 *
 * Nothing here prints a key. The bridge's database is opened read-only, to read that one project's row and its key.
 */
import { accessSync, constants, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import {
  DEFAULT_SINGLE_PROJECT_NAME,
  PROJECT_NAME_PATTERN,
  projectKeyVariable,
} from '../../src/config/index.js';
import { readEnvFileValues } from '../../src/db/migrate.js';
import { resolveProjectKey, type ProjectKeySource } from '../../src/secrets/index.js';
import { SandboxGuardError } from './smoke.js';

export interface SandboxTarget {
  /** The bridge's name for the project. */
  readonly name: string;
  /** Its LegendKeeper id, as registered by the bridge. */
  readonly projectId: string;
  /** Secret. */
  readonly apiKey: string;
  /** Where the key came from: the bridge's encrypted store, or the env file (nothing stored for the project). */
  readonly keySource: ProjectKeySource;
  /** The env variable that holds (or would hold) the key in the env file (for messages). */
  readonly keyVariable: string;
}

/** `--project NAME` or `--project=NAME` from an argument list; undefined when absent. */
export function projectFlag(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--project') return argv[i + 1];
    if (a.startsWith('--project=')) return a.slice('--project='.length);
  }
  return undefined;
}

/** The env variable holding `name`'s key: the multi-project form, or the single-project form's LK_API_KEY. */
export function keyVariableFor(name: string, env: Readonly<Record<string, string | undefined>>): string {
  const multi = (env.LK_PROJECTS ?? '').trim() !== '';
  const single = (env.LK_PROJECT_NAME?.trim().toLowerCase() || DEFAULT_SINGLE_PROJECT_NAME) === name;
  return !multi && single && (env.LK_API_KEY ?? '').trim() !== '' ? 'LK_API_KEY' : projectKeyVariable(name);
}

/** The only names read for project `name`: what says which variable holds its key, that variable, the master keys. */
export function keyNames(name: string): string[] {
  return [
    'LK_PROJECTS',
    'LK_PROJECT_NAME',
    'LK_API_KEY',
    projectKeyVariable(name),
    'SECRETS_MASTER_KEY',
    'SECRETS_MASTER_KEY_PREVIOUS',
  ];
}

/** Those values, from the file `LKB_ENV_FILE` names when it is set (the server), otherwise from `env`. */
function keyValues(
  name: string,
  env: NodeJS.ProcessEnv,
): { readonly values: Record<string, string | undefined>; readonly where: string } {
  const names = keyNames(name);
  const file = env.LKB_ENV_FILE?.trim();
  if (!file) {
    return { values: Object.fromEntries(names.map((k) => [k, env[k]])), where: 'the environment' };
  }
  try {
    accessSync(file, constants.R_OK);
  } catch (e) {
    throw new SandboxGuardError(
      `Cannot read the env file ${file} (${(e as NodeJS.ErrnoException).code ?? 'error'}). Run this as the service user: sudo -u lkbridge …`,
    );
  }
  return { values: readEnvFileValues(file, names), where: file };
}

/**
 * Resolves `name` to a sandbox project and its key, or throws `SandboxGuardError` saying why not (unknown, removed, not
 * a sandbox, no database, no key, a stored key that cannot be opened). Nothing is sent to LegendKeeper here.
 *
 * The sandbox, soak and spike scripts and every `test/sandbox/*.test.ts` use this one: they write.
 */
export function resolveSandboxTarget(
  name: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  dbPath: string = env.DB_PATH ?? './data/bridge.db',
): SandboxTarget {
  const { isSandbox: _isSandbox, ...target } = resolveTarget(name, env, dbPath, true);
  return target;
}

/** A project the read-only round trip may read, and whether it is a sandbox (the report's header says so). */
export interface ReadOnlyTarget extends SandboxTarget {
  readonly isSandbox: boolean;
}

/**
 * v2 E5 hotfix (ADR 0046): as {@link resolveSandboxTarget}, but any registered, not removed project is accepted,
 * sandbox or not (Arkona included). The key handling, the database opened read-only, the key's own-project check that
 * follows, and every refusal are the same. ONLY scripts/markdown-roundtrip.ts may use it, and only with the read-only
 * runtime (`createReadOnlyRuntime` in soak.ts: LK_READ_ONLY=true, the governor's allow-list, a reads-only transport);
 * test/unit/sandbox-target.test.ts checks that no other script or sandbox test does.
 */
export function resolveReadOnlyTarget(
  name: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  dbPath: string = env.DB_PATH ?? './data/bridge.db',
): ReadOnlyTarget {
  return resolveTarget(name, env, dbPath, false);
}

function resolveTarget(
  name: string | undefined,
  env: NodeJS.ProcessEnv,
  dbPath: string,
  requireSandbox: boolean,
): ReadOnlyTarget {
  const n = name?.trim().toLowerCase();
  if (!n) {
    throw new SandboxGuardError(
      requireSandbox
        ? 'Name the sandbox project with --project <name> (a project registered by the bridge and marked as a sandbox).'
        : 'Name the project with --project <name> (a project registered by the bridge).',
    );
  }
  if (!PROJECT_NAME_PATTERN.test(n))
    throw new SandboxGuardError(`"${n.slice(0, 40)}" is not a project name.`);
  if (!existsSync(dbPath)) {
    throw new SandboxGuardError(
      `There is no bridge database at ${dbPath} (DB_PATH). The project must be registered by the bridge first.`,
    );
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    let row: { id: string; name: string; is_sandbox: number; archived_at?: number | null } | undefined;
    try {
      db.pragma('busy_timeout = 5000');
      row = db.prepare('SELECT * FROM projects WHERE name = ?').get(n) as typeof row;
    } catch (e) {
      throw new SandboxGuardError(
        `Could not read the projects of the bridge database at ${dbPath}: ${(e as Error).message}`,
      );
    }
    if (!row) {
      throw new SandboxGuardError(
        `Project "${n}" is not registered in the bridge database at ${dbPath}. Refusing.`,
      );
    }
    if (row.archived_at != null) {
      throw new SandboxGuardError(
        `Project "${n}" was removed on the dashboard, so the bridge no longer serves it. Refusing.`,
      );
    }
    if (requireSandbox && row.is_sandbox !== 1) {
      throw new SandboxGuardError(
        `Project "${n}" is not marked as a sandbox project, so this script refuses to touch it. Only for a test world: ` +
          `npm run projects -- sandbox ${n} on (docs/runbook-deploy.md).`,
      );
    }
    const { values, where } = keyValues(n, env);
    const keyVariable = keyVariableFor(n, values);
    const key = resolveProjectKey(db, row.id, {
      masterKey: values.SECRETS_MASTER_KEY,
      previousMasterKey: values.SECRETS_MASTER_KEY_PREVIOUS,
      envKey: values[keyVariable],
    });
    if (!key.ok && key.reason === 'unreadable') {
      throw new SandboxGuardError(
        `The key of project "${n}" is kept in the bridge's encrypted store, which cannot be read here: ${key.detail ?? 'unknown reason'}. ` +
          `${keyVariable} from ${where} is not used instead (it may be an old key the dashboard replaced). ` +
          `Check SECRETS_MASTER_KEY in ${where} (npm run secrets -- status).`,
      );
    }
    if (!key.ok) {
      throw new SandboxGuardError(
        `Project "${n}" has no key: none is stored in the bridge's encrypted store, and ${keyVariable} is not set in ${where}. ` +
          `Add the project's key on the dashboard's Projects page (Replace key), then run this again.`,
      );
    }
    return {
      name: n,
      projectId: row.id,
      apiKey: key.apiKey,
      keySource: key.source,
      keyVariable,
      isSandbox: row.is_sandbox === 1,
    };
  } finally {
    db.close();
  }
}

/** One line for the scripts' log: where the key came from (never the key). */
export function keySourceLine(t: SandboxTarget): string {
  return t.keySource === 'store'
    ? `Project "${t.name}": using its key from the bridge's encrypted store.\n`
    : `Project "${t.name}": nothing is stored for it in the bridge's encrypted store, so using ${t.keyVariable}.\n`;
}
