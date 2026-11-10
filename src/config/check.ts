/**
 * `npm run config:check -- --file /etc/lk-bridge/lk-bridge.env` (OPS1, ADR 0024): validates an env file with every
 * config loader the bridge runs at start-up, without starting anything. No database, no network: a project's key is
 * checked for its format only (a bearer token, RFC 6750), never against LegendKeeper.
 *
 * deploy/env-sync.sh and deploy/deploy.sh run it as the service user before the service is (re)started, so a file the
 * bridge would refuse is caught, and restored from its backup, while the old one can still be put back.
 *
 * Output: one line per problem, naming the variable; never a value. Any text that happens to equal the value of a
 * credential-shaped variable is replaced with `[redacted]` before it is printed, as a second guard.
 * Exit status: 0 valid, 1 invalid, 2 the file could not be read.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadAdminConfig } from './admin.js';
import { loadAuthConfig } from './auth.js';
import { loadConfig, projectsFrom } from './index.js';
import { loadMaintenanceConfig } from './maintenance.js';
import { loadPolicyConfig } from './policy.js';
import { loadToolsConfig } from './tools.js';

/** Every loader `src/server.ts` runs before it builds anything. */
export const CONFIG_LOADERS: readonly (readonly [string, (env: NodeJS.ProcessEnv) => unknown])[] = [
  ['loadConfig', loadConfig],
  ['loadAuthConfig', loadAuthConfig],
  ['loadPolicyConfig', loadPolicyConfig],
  ['loadToolsConfig', loadToolsConfig],
  ['loadAdminConfig', loadAdminConfig],
  ['loadMaintenanceConfig', loadMaintenanceConfig],
];

/**
 * A key as it can travel in `Authorization: Bearer …` (RFC 6750 b64token), and long enough to be a real one. Catches a
 * pasted space, quote or line break, which LegendKeeper would refuse at start-up.
 */
const BEARER_TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;
const MIN_KEY_LENGTH = 16;

/** OPS2: whether `key` could be a LegendKeeper API key (a bearer token of a sensible length). Never says why: no echo. */
export function plausibleApiKey(key: string): boolean {
  return key.length >= MIN_KEY_LENGTH && key.length <= 512 && BEARER_TOKEN.test(key);
}

/** Names whose values must never be printed, even by accident. */
const CREDENTIAL_NAME = /(SECRET|KEY|HASH|TOKEN|PASSWORD)/;

/**
 * Parses an env file the way systemd's EnvironmentFile= and deploy/lib.sh's `env_file_get` do: `NAME=value` lines
 * (leading whitespace allowed), the last assignment wins, surrounding whitespace and one pair of matching quotes
 * removed. Comments and anything else are ignored.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.replace(/\r$/, ''));
    if (!m?.[1]) continue;
    let v = (m[2] ?? '').trim();
    const q = /^'(.*)'$/.exec(v) ?? /^"(.*)"$/.exec(v);
    if (q) v = q[1] ?? '';
    out[m[1]] = v;
  }
  return out;
}

export interface CheckResult {
  readonly ok: boolean;
  /** One line per problem, each starting with the variable's name (or the loader's, for an unexpected failure). */
  readonly issues: readonly string[];
  /** Start-up warnings the bridge would log (names only). */
  readonly warnings: readonly string[];
}

/** Runs every loader against `env`, and checks each configured project's key format. Never throws. */
export function checkConfig(env: NodeJS.ProcessEnv): CheckResult {
  const issues = new Set<string>();
  const warnings: string[] = [];
  for (const [name, load] of CONFIG_LOADERS) {
    try {
      load(env);
    } catch (err) {
      const list = (err as { issues?: unknown }).issues;
      if (Array.isArray(list)) {
        for (const i of list) issues.add(String(i));
      } else {
        // Never the message: an unexpected error might quote its input.
        issues.add(`${name}: failed unexpectedly (${err instanceof Error ? err.name : 'error'})`);
      }
    }
  }
  const projects = projectsFrom(env);
  warnings.push(...projects.warnings);
  // OPS2: the bridge only warns about its master key (a bad one must never stop it from starting, ADR 0028); an edit
  // that would make it unusable is still caught here, before a deploy or env-sync keeps it.
  const master = (env.SECRETS_MASTER_KEY ?? '').trim();
  const previous = (env.SECRETS_MASTER_KEY_PREVIOUS ?? '').trim();
  if (master === '') {
    warnings.push(
      'SECRETS_MASTER_KEY is not set: keys and the owner credentials cannot be kept in the encrypted store (env-sync generates it).',
    );
  } else if (master.length < 32) {
    issues.add('SECRETS_MASTER_KEY: at least 32 characters (env-sync generates one; never shorten it)');
  } else if (master === (env.SESSION_SECRET ?? '').trim() || master === (env.JWT_SIGNING_KEY ?? '').trim()) {
    issues.add('SECRETS_MASTER_KEY: must differ from SESSION_SECRET and JWT_SIGNING_KEY');
  }
  if (previous !== '' && previous === master) {
    issues.add(
      'SECRETS_MASTER_KEY_PREVIOUS: must differ from SECRETS_MASTER_KEY (it is the key before a rotation)',
    );
  }
  for (const p of projects.projects) {
    if (p.apiKey.length < MIN_KEY_LENGTH || !BEARER_TOKEN.test(p.apiKey)) {
      issues.add(
        `${p.keyVariable}: not a valid API key (a single token of letters, digits and - . _ ~ + /, at least ${MIN_KEY_LENGTH} characters; check for a space, a quote or a line break pasted with it)`,
      );
    }
  }
  return { ok: issues.size === 0, issues: [...issues], warnings };
}

/** Replaces every credential value in `text` with `[redacted]` (longest first, so one value inside another goes too). */
export function redact(text: string, env: Readonly<Record<string, string | undefined>>): string {
  const values = Object.entries(env)
    .filter(([k, v]) => CREDENTIAL_NAME.test(k) && typeof v === 'string' && v.length >= 4)
    .map(([, v]) => v as string)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const v of values) out = out.split(v).join('[redacted]');
  return out;
}

function main(argv: readonly string[]): number {
  const i = argv.indexOf('--file');
  const file = i >= 0 ? argv[i + 1] : undefined;
  let env: Record<string, string>;
  if (file) {
    try {
      env = parseEnvFile(readFileSync(file, 'utf8'));
    } catch (err) {
      process.stderr.write(
        `config check: cannot read ${file} (${(err as NodeJS.ErrnoException).code ?? 'error'})\n`,
      );
      return 2;
    }
  } else {
    env = Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
  }
  const result = checkConfig(env);
  const say = (line: string) => redact(line, env);
  for (const w of result.warnings) process.stdout.write(`${say(`warning: ${w}`)}\n`);
  if (result.ok) {
    process.stdout.write('config check: OK (every setting the bridge reads at start-up is valid)\n');
    return 0;
  }
  for (const issue of result.issues) process.stdout.write(`${say(`issue: ${issue}`)}\n`);
  process.stdout.write(
    `config check: FAILED (${result.issues.length} problem(s); the bridge would not start)\n`,
  );
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
