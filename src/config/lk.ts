/**
 * LegendKeeper client and Rate Governor settings (PLAN §1.2, §5).
 *
 * The env-driven values (tier limits, reserve floors, write spacing) are parsed in `./index.ts`. This file turns
 * them into the shape `src/lk` consumes and adds the code-level defaults that have no env variable (retry
 * matrix timings, timeouts). Values are only ever read inside functions, because `./index.ts` re-exports this
 * module and the two form an import cycle.
 */
import type { TierId } from '../lk/registry-types.js';
import { effectiveBulkFloor } from './floors.js';
import { DEFAULT_TIER_LIMITS, TIER_WINDOW_SECONDS, type Config } from './index.js';

export { bulkOrderMessage, DEFAULT_BULK_FLOOR, effectiveBulkFloor } from './floors.js';

/**
 * The governor's request classes (PLAN §5.2). P4 (bulk, v3 F9, ADR 0074) is the whole-repository and whole-library
 * walks: the nightly full snapshot, the full tree and asset passes. It is a request class only: a job row is never P4
 * (`src/jobs/types.ts` `PriorityClass` is P0 to P3).
 */
export type PriorityClass = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

/** The reserve floors given to `defaultGovernorSettings`: P4 may be left out (`effectiveBulkFloor` decides it). */
export type ReserveFloorsInput = Readonly<Omit<Record<PriorityClass, number>, 'P4'> & { P4?: number }>;

export interface RetrySettings {
  /** A 429 whose wait is at most this long is waited out and retried; longer waits surface `BudgetWaitError`. */
  readonly maxShortWaitMs: number;
  /** How many short 429 waits one call may take before it surfaces `BudgetWaitError` instead. */
  readonly maxRateLimitRetries: number;
  /** Transient failures (502/503/504, timeout, connection): exponential backoff `base * 2^n`, jittered, capped. */
  readonly backoffBaseMs: number;
  readonly backoffCapMs: number;
  /** Retries after the first attempt for transient failures (PLAN §5.3 "3 tries"). */
  readonly maxTransientRetries: number;
  /** `409 IN_PROGRESS`: short backoff, same idempotency key. */
  readonly inProgressBaseMs: number;
  readonly maxInProgressRetries: number;
  /** Upload tier has no published numbers: back off reactively from this delay, doubling up to the cap. */
  readonly uploadBackoffBaseMs: number;
  readonly uploadBackoffCapMs: number;
}

export interface GovernorSettings {
  /** Effective limit per tier; `null` = no published number (upload), handled reactively only. */
  readonly tierLimits: Readonly<Record<TierId, number | null>>;
  /** Window length per tier in ms; `null` for the reactive-only upload tier. */
  readonly tierWindowsMs: Readonly<Record<TierId, number | null>>;
  /** Fraction of each tier a class must leave untouched. P0 always 0. */
  readonly reserveFloors: Readonly<Record<PriorityClass, number>>;
  /** Minimum gap between write dispatches. */
  readonly writeSpacingMs: number;
  /** Gap used once the projected hourly write count would cross `stretchHourlyWrites`. */
  readonly writeSpacingStretchedMs: number;
  /** Projected writes per hour above which spacing stretches. Defaults to the write-hour limit. */
  readonly stretchHourlyWrites: number;
  /** A queued call whose earliest admission is further away than this surfaces `BudgetWaitError`. */
  readonly maxQueueWaitMs: number;
  /** Per-attempt timeout enforced by the governor (the SDK's own timeout is set just above it). */
  readonly requestTimeoutMs: number;
  /** Upper bound on concurrent in-flight LK requests, as a safety valve. */
  readonly maxInFlight: number;
  readonly retry: RetrySettings;
}

export interface LkSettings {
  readonly apiKey: string;
  readonly projectId: string;
  readonly baseUrl: string;
  readonly governor: GovernorSettings;
}

/** Defaults straight from PLAN §1.2, §5.2 and §5.3. */
export function defaultGovernorSettings(
  overrides: Partial<Omit<GovernorSettings, 'reserveFloors'>> & {
    readonly reserveFloors?: ReserveFloorsInput;
  } = {},
): GovernorSettings {
  const tierLimits = { ...DEFAULT_TIER_LIMITS, ...overrides.tierLimits };
  const tierWindowsMs = Object.fromEntries(
    Object.entries(TIER_WINDOW_SECONDS).map(([tier, s]) => [tier, s === null ? null : s * 1000]),
  ) as Record<TierId, number | null>;
  return {
    tierLimits,
    tierWindowsMs: { ...tierWindowsMs, ...overrides.tierWindowsMs },
    reserveFloors: floorsWithBulk({ P0: 0, P1: 0.1, P2: 0.25, P3: 0.5, ...overrides.reserveFloors }),
    writeSpacingMs: overrides.writeSpacingMs ?? 500,
    writeSpacingStretchedMs: overrides.writeSpacingStretchedMs ?? 1200,
    stretchHourlyWrites: overrides.stretchHourlyWrites ?? tierLimits['write-hour'] ?? 3000,
    maxQueueWaitMs: overrides.maxQueueWaitMs ?? 30_000,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 30_000,
    maxInFlight: overrides.maxInFlight ?? 16,
    retry: {
      maxShortWaitMs: 30_000,
      maxRateLimitRetries: 5,
      backoffBaseMs: 250,
      backoffCapMs: 8_000,
      maxTransientRetries: 3,
      inProgressBaseMs: 500,
      maxInProgressRetries: 5,
      uploadBackoffBaseMs: 1_000,
      uploadBackoffCapMs: 120_000,
      ...overrides.retry,
    },
  };
}

function floorsWithBulk(f: ReserveFloorsInput): Readonly<Record<PriorityClass, number>> {
  return { P0: f.P0, P1: f.P1, P2: f.P2, P3: f.P3, P4: effectiveBulkFloor(f.P3, f.P4) };
}

/** The governor settings every project's governor is built with (each project has its own governor, v2 A1). */
export function governorSettingsFrom(config: Config): GovernorSettings {
  const floors = config.governor.reserveFloors;
  return defaultGovernorSettings({
    tierLimits: config.lk.tierLimits,
    reserveFloors: { P0: 0, P1: floors.interactive, P2: floors.job, P3: floors.maintenance, P4: floors.bulk },
    writeSpacingMs: config.governor.writeSpacingMs,
    writeSpacingStretchedMs: config.governor.writeSpacingStretchedMs,
  });
}

/**
 * Builds the `src/lk` settings for ONE project from the validated application config: that project's key and its
 * LegendKeeper id (discovered from the key at start-up), and the shared governor settings.
 */
export function lkSettingsFor(config: Config, project: { apiKey: string; projectId: string }): LkSettings {
  return {
    apiKey: project.apiKey,
    projectId: project.projectId,
    baseUrl: config.lk.baseUrl,
    governor: governorSettingsFrom(config),
  };
}
