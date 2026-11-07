/**
 * Job engine settings (PLAN §6). The env-driven values (WRITERS_MAX, LK_READ_ONLY, LK_ALLOW_MEMBER_ADMIN and the
 * journal retention) are parsed in `./index.ts`; this file adds the code-level defaults that have no env variable.
 * Values are only read inside functions, because `./index.ts` re-exports this module (import cycle, as in lk.ts).
 */
import type { Config } from './index.js';

export const WRITERS_MIN = 1;
export const WRITERS_LIMIT = 8;

export interface PaginateSettings {
  /** Page size asked for when the caller gives none (LK maximum is 100). */
  readonly pageSize: number;
  /** Hard caps for one `paginate_all` result set. Hitting one ends the job early with `truncated: true`. */
  readonly maxPages: number;
  readonly maxItems: number;
  readonly maxBytes: number;
}

export interface JobsSettings {
  /** Writer slots at start-up (1–8). A value saved at runtime in `runtime_settings` wins. */
  readonly writersMax: number;
  /** LK_READ_ONLY. A runtime override saved in `runtime_settings` wins. */
  readonly readOnly: boolean;
  /** LK_ALLOW_MEMBER_ADMIN: member and invite writes refuse unless true (PLAN §4 rule 4). */
  readonly allowMemberAdmin: boolean;
  readonly journal: { readonly retentionDays: number; readonly maxBytes: number };
  /** `engine.run` queues instead of running inline when the governor predicts longer than this (PLAN §6.1). */
  readonly inlineMaxEstimateMs: number;
  /** Upper bound of `engine.wait` (PLAN §6.1: at most 25 s). */
  readonly maxWaitMs: number;
  /**
   * How long a POST may be re-sent with its original Idempotency-Key and be trusted to replay. LK keeps keys for
   * 24 h; the default leaves an hour of margin. Beyond it, a step that cannot be verified another way is marked
   * `uncertain` instead of being re-sent.
   */
  readonly idempotencyWindowMs: number;
  /** Jobs the engine runs at once (reads need no writer slot, so this bounds concurrent read jobs). */
  readonly maxActiveJobs: number;
  /** Step params larger than this (JSON bytes) are stored as a `params` artefact. */
  readonly largeParamsBytes: number;
  /** Step results larger than this are stored whole as a `result` artefact; the step keeps a summary. */
  readonly resultSummaryBytes: number;
  readonly paginate: PaginateSettings;
}

export function defaultJobsSettings(overrides: Partial<JobsSettings> = {}): JobsSettings {
  return {
    writersMax: overrides.writersMax ?? 2,
    readOnly: overrides.readOnly ?? true,
    allowMemberAdmin: overrides.allowMemberAdmin ?? false,
    journal: { retentionDays: 30, maxBytes: 2 * 1024 ** 3, ...overrides.journal },
    inlineMaxEstimateMs: overrides.inlineMaxEstimateMs ?? 20_000,
    maxWaitMs: overrides.maxWaitMs ?? 25_000,
    idempotencyWindowMs: overrides.idempotencyWindowMs ?? 23 * 3_600_000,
    maxActiveJobs: overrides.maxActiveJobs ?? 16,
    largeParamsBytes: overrides.largeParamsBytes ?? 64 * 1024,
    resultSummaryBytes: overrides.resultSummaryBytes ?? 4 * 1024,
    paginate: {
      pageSize: 100,
      maxPages: 1_000,
      maxItems: 100_000,
      maxBytes: 64 * 1024 ** 2,
      ...overrides.paginate,
    },
  };
}

/** Builds the job engine settings from the validated application config. */
export function jobsSettingsFrom(config: Config, overrides: Partial<JobsSettings> = {}): JobsSettings {
  return defaultJobsSettings({
    writersMax: config.writers.max,
    readOnly: config.lk.readOnly,
    allowMemberAdmin: config.lk.allowMemberAdmin,
    journal: { retentionDays: config.journal.retentionDays, maxBytes: config.journal.maxBytes },
    ...overrides,
  });
}
