/**
 * Public surface of `src/maintenance` (docs/maintenance.md): the job registry, the scheduler, and the owner commands.
 *
 * ```ts
 * const maintenance = createMaintenance({ db, engine, projects, policy, clock, settings, expirySweepMs });
 * maintenance.start();            // after the engine has started
 * await maintenance.stop();       // on shutdown, before the engine stops
 * maintenance.commands            // owner commands for the admin routes (never for MCP)
 * ```
 */
import type { MaintenanceSettings } from '../config/maintenance.js';
import type { Db } from '../db/open.js';
import type { JobEngine } from '../jobs/index.js';
import type { Clock } from '../lk/index.js';
import type { ProjectRegistry, ProjectsRuntime } from '../projects/registry.js';
import type { Policy } from '../policy/index.js';
import { createMaintenanceCommands, type MaintenanceCommands } from './commands.js';
import type { AssetMaintenance } from './asset-jobs.js';
import { builtinJobs, type TreeMaintenance, type LinkMaintenance } from './jobs.js';
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
  /** Every project's governor, and which projects are served (v2 A1). */
  readonly projects: ProjectsRuntime & Partial<Pick<ProjectRegistry, 'clients'>>;
  readonly policy: Policy;
  readonly clock: Clock;
  readonly settings: MaintenanceSettings;
  /** POLICY_EXPIRY_SWEEP_SECONDS in milliseconds: the default schedule of `proposal-expiry`. */
  readonly expirySweepMs: number;
  /** POLICY_PROPOSAL_RETENTION_DAYS in milliseconds: what `proposal-prune` keeps. Default 90 days. */
  readonly proposalRetentionMs?: number;
  readonly log?: { warn(o: Record<string, unknown>, m: string): void };
  /** v2 A2: the repository tree, for the `tree-sweep` and `tree-check` jobs. */
  readonly tree?: TreeMaintenance;
  /** v2 A4: the asset tree, for the `asset-refresh` and `asset-check` jobs. */
  readonly assets?: AssetMaintenance;
  /** v2 C2c: the link index, for the `link-sweep` job. */
  readonly links?: LinkMaintenance;
  /** Test seam: extra job definitions registered after the built-in ones. */
  readonly extraJobs?: readonly MaintenanceJobDef[];
}

export function createMaintenance(o: CreateMaintenanceOptions): Maintenance {
  const scheduler = new MaintenanceScheduler({
    db: o.db,
    engine: o.engine,
    projects: o.projects,
    clock: o.clock,
    settings: o.settings,
    jobs: [
      ...builtinJobs({
        engine: o.engine,
        projects: o.projects,
        db: o.db,
        proposals: o.policy.proposals,
        connections: o.policy.connections,
        expirySweepMs: o.expirySweepMs,
        proposalRetentionMs: o.proposalRetentionMs ?? 90 * 86_400_000,
        ...(o.tree ? { tree: o.tree } : {}),
        ...(o.assets ? { assets: o.assets } : {}),
        ...(o.links ? { links: o.links } : {}),
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
export { builtinJobs, PLACEHOLDER_IDS, type TreeMaintenance } from './jobs.js';
export { assetJobs, type AssetMaintenance } from './asset-jobs.js';
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
