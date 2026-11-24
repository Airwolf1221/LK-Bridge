/**
 * The configuration as the bridge runs it (v3 F8, ADR 0073): every loader run on the environment with the dashboard's
 * stored values on top. Precedence (the owner's): dashboard value → environment → default.
 *
 * `src/server.ts` validates the environment alone first (a file the bridge would refuse still stops it, as before),
 * opens the database, then loads again with the dashboard's values. A stored value is validated when it is saved; if
 * the environment has changed since and a stored value now makes a loader fail, that value is left out (named in the
 * warnings, never its value) rather than stop the bridge.
 */
import type { Db } from '../db/open.js';
import { loadAdminConfig, type AdminSettings } from './admin.js';
import { loadAuthConfig, type AuthConfig } from './auth.js';
import { loadConfig, type Config } from './index.js';
import { envString, envWithOverrides, readConfigOverrides, type OverrideValue } from './live.js';
import { loadMaintenanceConfig, type MaintenanceSettings } from './maintenance.js';
import { loadPolicyConfig, type PolicySettings } from './policy.js';
import { schemaField, type EnvSchemaName, type SettingEntry } from './registry.js';
import { loadToolsConfig, type ToolsSettings } from './tools.js';

export interface ConfigBundle {
  readonly config: Config;
  readonly authConfig: AuthConfig;
  readonly policySettings: PolicySettings;
  readonly toolsSettings: ToolsSettings;
  readonly adminSettings: AdminSettings;
  readonly maintenanceSettings: MaintenanceSettings;
}

type Env = Readonly<Record<string, string | undefined>>;

/** The loader of each schema the registry reads. */
export const LOADERS: Readonly<Record<EnvSchemaName, (env: NodeJS.ProcessEnv) => unknown>> = {
  main: loadConfig,
  auth: loadAuthConfig,
  policy: loadPolicyConfig,
  tools: loadToolsConfig,
  admin: loadAdminConfig,
  maintenance: loadMaintenanceConfig,
};

/** Every loader on `env`. Throws the first loader's error (ConfigError, AuthConfigError, ...). */
export function loadConfigBundle(env: Env): ConfigBundle {
  const e = env as NodeJS.ProcessEnv;
  return {
    config: loadConfig(e),
    authConfig: loadAuthConfig(e),
    policySettings: loadPolicyConfig(e),
    toolsSettings: loadToolsConfig(e),
    adminSettings: loadAdminConfig(e),
    maintenanceSettings: loadMaintenanceConfig(e),
  };
}

/** The issues a loader reports on `env` (none: it loads). Never throws; names only, as the loaders word them. */
function issuesOf(load: (env: NodeJS.ProcessEnv) => unknown, env: Env): string[] {
  try {
    load(env);
    return [];
  } catch (err) {
    const list = (err as { issues?: unknown }).issues;
    return Array.isArray(list) ? list.map(String) : [err instanceof Error ? err.name : 'error'];
  }
}

/**
 * The configuration with the dashboard's values applied, for the start. Values that would make a loader fail (with
 * the environment as it is now) are left out, one key at a time, and named in `dropped`.
 */
export function loadEffectiveConfiguration(
  env: Env,
  db: Pick<Db, 'prepare'>,
): {
  readonly bundle: ConfigBundle;
  readonly applied: readonly string[];
  readonly dropped: readonly string[];
} {
  const { values } = readConfigOverrides(db);
  const kept: Record<string, OverrideValue> = { ...values };
  const dropped: string[] = [];
  for (let attempt = 0; attempt <= Object.keys(values).length; attempt++) {
    try {
      return { bundle: loadConfigBundle(envWithOverrides(env, kept)), applied: Object.keys(kept), dropped };
    } catch {
      // Leave out the first value whose own loader fails with it and not without it; else all that remain.
      const culprit = Object.keys(kept).find((k) => {
        const without = { ...kept };
        delete without[k];
        return Object.values(LOADERS).some(
          (load) =>
            issuesOf(load, envWithOverrides(env, kept)).length >
            issuesOf(load, envWithOverrides(env, without)).length,
        );
      });
      const out = culprit ? [culprit] : Object.keys(kept);
      for (const k of out) {
        delete kept[k];
        dropped.push(k);
      }
    }
  }
  return { bundle: loadConfigBundle(env), applied: [], dropped: [...dropped, ...Object.keys(kept)] };
}

export class SettingValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingValueError';
  }
}

/**
 * Checks a dashboard value for a `dash.cfg.` setting: its type, then its schema field (range, enum, format), then
 * every loader that reads it, with the environment and the other dashboard values, for rules between settings (such as
 * AUTH_REFRESH_FAMILY_MAX_SECONDS ≥ AUTH_REFRESH_TOKEN_TTL_SECONDS). Only issues the value itself brings count: a
 * problem the configuration already had is not blamed on it. Returns the value to store.
 */
export function validateSettingValue(
  e: SettingEntry,
  value: unknown,
  env: Env,
  overrides: Readonly<Record<string, OverrideValue>>,
): OverrideValue {
  const wanted =
    e.type === 'boolean' ? 'boolean' : e.type === 'integer' || e.type === 'number' ? 'number' : 'string';
  if (typeof value !== wanted)
    throw new SettingValueError(`${e.key} takes a ${wanted}, not a ${typeof value}.`);
  const v = value as OverrideValue;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new SettingValueError(`${e.key}: not a number.`);
    if (e.integer && !Number.isInteger(v)) throw new SettingValueError(`${e.key} must be a whole number.`);
    if (e.min !== null && v < e.min) throw new SettingValueError(`${e.key} must be at least ${e.min}.`);
    if (e.max !== null && v > e.max) throw new SettingValueError(`${e.key} must be at most ${e.max}.`);
  }
  if (typeof v === 'string' && e.enum && !e.enum.includes(v)) {
    throw new SettingValueError(`${e.key} must be one of ${e.enum.join(', ')}.`);
  }
  for (const schema of e.schemas) {
    const field = schemaField(schema, e.key);
    const r = field?.safeParse(envString(v));
    if (r && !r.success) {
      throw new SettingValueError(`${e.key}: ${r.error.issues.map((i) => i.message).join('; ')}`);
    }
  }
  const others = { ...overrides };
  delete others[e.key];
  const before = envWithOverrides(env, others);
  const after = envWithOverrides(env, { ...others, [e.key]: v });
  for (const schema of e.schemas) {
    const had = new Set(issuesOf(LOADERS[schema], before));
    const brought = issuesOf(LOADERS[schema], after).filter((i) => !had.has(i));
    if (brought.length > 0) throw new SettingValueError(brought.join('; '));
  }
  return v;
}
