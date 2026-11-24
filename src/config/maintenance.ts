/**
 * Maintenance scheduler settings (chunk 6, docs/maintenance.md). All optional, parsed on their own like the admin,
 * policy and auth settings so `loadConfig()` keeps its required variables unchanged.
 */
import * as z from 'zod';
import { bool, intFrom } from './schema-helpers.js';

export interface MaintenanceSettings {
  /** False: the scheduler is built (the pages work) but never runs anything by itself. Default true. */
  readonly enabled: boolean;
  /** When a job that calls LegendKeeper finds P1 or P2 work queued, it looks again after this long. Default 15 s. */
  readonly deferMs: number;
  /** Run records kept per job (the last run is always kept). Default 50. */
  readonly historyPerJob: number;
}

export class MaintenanceConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid maintenance configuration:\n - ${issues.join('\n - ')}`);
    this.name = 'MaintenanceConfigError';
  }
}

export function defaultMaintenanceSettings(
  overrides: Partial<MaintenanceSettings> = {},
): MaintenanceSettings {
  const s: MaintenanceSettings = {
    enabled: overrides.enabled ?? true,
    deferMs: overrides.deferMs ?? 15_000,
    historyPerJob: overrides.historyPerJob ?? 50,
  };
  const issues: string[] = [];
  if (!(s.deferMs >= 10)) issues.push('deferMs must be at least 10');
  if (!(Number.isInteger(s.historyPerJob) && s.historyPerJob >= 1))
    issues.push('historyPerJob must be a whole number of at least 1');
  if (issues.length > 0) throw new MaintenanceConfigError(issues);
  return s;
}

/** Exported for the settings registry (v3 F8, ADR 0073). */
export const MAINTENANCE_ENV_SCHEMA = z.object({
  MAINTENANCE_ENABLED: bool(true),
  MAINTENANCE_DEFER_SECONDS: intFrom(15, 1, 3600),
  MAINTENANCE_HISTORY_RUNS: intFrom(50, 1, 10_000),
});

/** Reads MAINTENANCE_* from the environment (names in .env.example). Never echoes values. */
export function loadMaintenanceConfig(env: NodeJS.ProcessEnv = process.env): MaintenanceSettings {
  const parsed = MAINTENANCE_ENV_SCHEMA.safeParse(env);
  if (!parsed.success) {
    throw new MaintenanceConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = parsed.data;
  return defaultMaintenanceSettings({
    enabled: e.MAINTENANCE_ENABLED,
    deferMs: e.MAINTENANCE_DEFER_SECONDS * 1000,
    historyPerJob: e.MAINTENANCE_HISTORY_RUNS,
  });
}
