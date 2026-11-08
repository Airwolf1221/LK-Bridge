/**
 * Public surface of `src/maintenance` (docs/maintenance.md): the job registry, the scheduler, and the owner commands.
 *
 * ```ts
 * const maintenance = createMaintenance({ db, engine, lk, policy, clock, settings, expirySweepMs });
 * maintenance.start();            // after the engine has started
 * await maintenance.stop();       // on shutdown, before the engine stops
 * maintenance.commands            // owner commands for the admin routes (never for MCP)
 * ```
 */
import type { MaintenanceSettings } from '../config/maintenance.js';
import type { Db } from '../db/open.js';
import type { JobEngine } from '../jobs/index.js';
import type { Clock, LkClient } from '../lk/index.js';
import type { Policy } from '../policy/index.js';
import { createMaintenanceCommands, type MaintenanceCommands } from './commands.js';
import { builtinJobs } from './jobs.js';
import { MaintenanceScheduler } from './scheduler.js';
import type { MaintenanceJobDef } from './types.js';

export interface Maintenance {
  readonly scheduler: MaintenanceScheduler;
  readonly commands: MaintenanceCommands;
  start(): void;
  stop(): Promise<void>;
}

export interface CreateMaintenanceOptions {
  readonly db: Db;
  readonly engine: JobEngine;
  readonly lk: LkClient;
  readonly policy: Policy;
  readonly clock: Clock;
  readonly settings: MaintenanceSettings;
  /** POLICY_EXPIRY_SWEEP_SECONDS in milliseconds: the default schedule of `proposal-expiry`. */
  readonly expirySweepMs: number;
  readonly log?: { warn(o: Record<string, unknown>, m: string): void };
  /** Test seam: extra job definitions registered after the built-in ones. */
  readonly extraJobs?: readonly MaintenanceJobDef[];
}

export function createMaintenance(o: CreateMaintenanceOptions): Maintenance {
  const scheduler = new MaintenanceScheduler({
    db: o.db,
    engine: o.engine,
    lk: o.lk,
    clock: o.clock,
    settings: o.settings,
    jobs: [
      ...builtinJobs({
        engine: o.engine,
        lk: o.lk,
        db: o.db,
        proposals: o.policy.proposals,
        expirySweepMs: o.expirySweepMs,
      }),
      ...(o.extraJobs ?? []),
    ],
    ...(o.log ? { log: o.log } : {}),
  });
  return {
    scheduler,
    commands: createMaintenanceCommands({ scheduler, store: o.policy.store }),
    start: () => scheduler.start(),
    stop: () => scheduler.stop(),
  };
}

export { MaintenanceScheduler, MaintenanceError, type MaintenanceErrorCode } from './scheduler.js';
export { createMaintenanceCommands, type MaintenanceCommands } from './commands.js';
export { builtinJobs, PLACEHOLDER_IDS } from './jobs.js';
export {
  scheduleSchema,
  parseSchedule,
  nextRun,
  nextDailyRun,
  describeSchedule,
  londonOffsetMinutes,
  londonToUtc,
  type Schedule,
} from './schedule.js';
export type {
  MaintenanceJobDef,
  MaintenanceJobView,
  MaintenanceContext,
  MaintenanceResult,
  RunView,
  RunOutcome,
  RunTrigger,
} from './types.js';
