/**
 * Which LegendKeeper project the sandbox, soak and spike scripts may use (v2 A1: the sandbox settings are retired).
 *
 * Each script takes `--project <name>` (the wrapper scripts pass it on; `npm run test:sandbox` reads it from
 * `LKB_SANDBOX_PROJECT`). The project must be registered in the BRIDGE'S database (`DB_PATH`) and marked as a sandbox
 * there (`is_sandbox`, set with `npm run projects -- sandbox <name> on`); anything else is refused before any request
 * is made. Its key comes from the env variable the bridge itself uses for it, `LK_PROJECT_<NAME>_API_KEY` (or, in the
 * single-project form, `LK_API_KEY` for the project named by `LK_PROJECT_NAME`, default `test`). The scripts then
 * check that the key's own project is exactly the registered one, before anything is written.
 *
 * Nothing here prints a key. The bridge's database is opened read-only, and only to read that one project's row.
 */
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import {
  DEFAULT_SINGLE_PROJECT_NAME,
  PROJECT_NAME_PATTERN,
  projectKeyVariable,
} from '../../src/config/index.js';
import { SandboxGuardError } from './smoke.js';

export interface SandboxTarget {
  /** The bridge's name for the project. */
  readonly name: string;
  /** Its LegendKeeper id, as registered by the bridge. */
  readonly projectId: string;
  /** Secret. */
  readonly apiKey: string;
  /** The env variable that held the key (for messages). */
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
export function keyVariableFor(name: string, env: NodeJS.ProcessEnv): string {
  const multi = (env.LK_PROJECTS ?? '').trim() !== '';
  const single = (env.LK_PROJECT_NAME?.trim().toLowerCase() || DEFAULT_SINGLE_PROJECT_NAME) === name;
  return !multi && single && (env.LK_API_KEY ?? '').trim() !== '' ? 'LK_API_KEY' : projectKeyVariable(name);
}

/**
 * Resolves `name` to a sandbox project, or throws `SandboxGuardError` saying why not (unknown, not a sandbox, no
 * database, no key). Nothing is sent to LegendKeeper here.
 */
export function resolveSandboxTarget(
  name: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  dbPath: string = env.DB_PATH ?? './data/bridge.db',
): SandboxTarget {
  const n = name?.trim().toLowerCase();
  if (!n) {
    throw new SandboxGuardError(
      'Name the sandbox project with --project <name> (a project registered by the bridge and marked as a sandbox).',
    );
  }
  if (!PROJECT_NAME_PATTERN.test(n))
    throw new SandboxGuardError(`"${n.slice(0, 40)}" is not a project name.`);
  if (!existsSync(dbPath)) {
    throw new SandboxGuardError(
      `There is no bridge database at ${dbPath} (DB_PATH). The project must be registered by the bridge first.`,
    );
  }
  let row: { id: string; name: string; is_sandbox: number } | undefined;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    row = db.prepare('SELECT id, name, is_sandbox FROM projects WHERE name = ?').get(n) as typeof row;
  } catch (e) {
    throw new SandboxGuardError(
      `Could not read the projects of the bridge database at ${dbPath}: ${(e as Error).message}`,
    );
  } finally {
    db.close();
  }
  if (!row) {
    throw new SandboxGuardError(
      `Project "${n}" is not registered in the bridge database at ${dbPath}. Refusing.`,
    );
  }
  if (row.is_sandbox !== 1) {
    throw new SandboxGuardError(
      `Project "${n}" is not marked as a sandbox project, so this script refuses to touch it. Only for a test world: ` +
        `npm run projects -- sandbox ${n} on (docs/runbook-deploy.md).`,
    );
  }
  const keyVariable = keyVariableFor(n, env);
  const apiKey = env[keyVariable]?.trim();
  if (!apiKey) throw new SandboxGuardError(`${keyVariable} is empty: the key of project "${n}" is needed.`);
  return { name: n, projectId: row.id, apiKey, keyVariable };
}
