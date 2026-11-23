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
import {
  builtinJobs,
  type AuditMaintenance,
  type ChronologyMaintenance,
  type SnapshotMaintenance,
  type TreeMaintenance,
  type LinkMaintenance,
  type AutomationMaintenance,
} from './jobs.js';
import { MaintenanceScheduler } from './scheduler.js';
import { SWEEP_JOB_ID } from '../blockids/statement.js';
import type { MaintenanceJobDef } from './types.js';
import type { BlockIdSweep } from '../blockids/index.js';

export interface Maintenance {
  readonly scheduler: MaintenanceScheduler;
  readonly commands: MaintenanceCommands;
  /** v3 F3.5 (ADR 0056): the block-id sweep (its card, dry run and settings), when the runtime built it. */
  readonly blockIds: BlockIdSweep | null;
  start(): void;
  /** CR-2026-11-R3 (fix A): `waitMs` bounds the wait for runs in flight (a restart). */
  stop(waitMs?: number): Promise<void>;
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
  readonly log?: {
    warn(o: Record<string, unknown>, m: string): void;
    info?(o: Record<string, unknown>, m: string): void;
  };
  /** v2 A2: the repository tree, for the `tree-sweep` and `tree-check` jobs. */
  readonly tree?: TreeMaintenance;
  /** v2 A4: the asset tree, for the `asset-refresh` and `asset-check` jobs. */
  readonly assets?: AssetMaintenance;
  /** v2 C2c: the link index, for the `link-sweep` job. */
  readonly links?: LinkMaintenance;
  /** v2 D1: the chronology check, for the `chronology-check` job. */
  readonly chronology?: ChronologyMaintenance;
  /** v2 E1a: snapshots, for the `snapshot-*` jobs. */
  readonly snapshots?: SnapshotMaintenance;
  /** v2 E2: the audits, for the `audit-run` job. */
  readonly audits?: AuditMaintenance;
  /** v3 F3.5 (ADR 0056): the block-id sweep, for `assign-block-ids-sweep`. */
  readonly blockIds?: BlockIdSweep;
  /** v3 F5b (ADR 0068): the automation framework, for `automation-run`. */
  readonly automation?: AutomationMaintenance;
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
        ...(o.chronology ? { chronology: o.chronology } : {}),
        ...(o.snapshots ? { snapshots: o.snapshots } : {}),
        ...(o.audits ? { audits: o.audits } : {}),
        ...(o.blockIds
          ? {
              blockIds: {
                run: (projectId: string) => o.blockIds!.run(projectId),
                canEnable: () => o.blockIds!.canEnable(),
                enabled: () => o.blockIds!.enabled(),
              },
            }
          : {}),
        ...(o.automation ? { automation: o.automation } : {}),
      }),
      ...(o.extraJobs ?? []),
    ],
    ...(o.log ? { log: o.log } : {}),
  });
  // v3 F3.5 (ADR 0056): a verification failure stops the block-id sweep: the job disables itself (audited as the system's).
  const offStop = o.blockIds?.onStop((s) => {
    try {
      const before = scheduler.get(SWEEP_JOB_ID);
      if (!before.enabled) return;
      const after = scheduler.setEnabled(SWEEP_JOB_ID, false);
      o.policy.store.audit(
        'system',
        'maintenance.disable',
        SWEEP_JOB_ID,
        { enabled: before.enabled },
        { enabled: after.enabled, reason: `verification failed on ${s.page ?? s.documentId} (${s.project})` },
      );
    } catch (e) {
      o.log?.warn({ err: e }, 'could not disable the block-id sweep after its stop');
    }
  });
  return {
    scheduler,
    commands: createMaintenanceCommands({ scheduler, store: o.policy.store }),
    blockIds: o.blockIds ?? null,
    start: () => scheduler.start(),
    stop: async (waitMs?: number) => {
      offStop?.();
      await scheduler.stop(waitMs);
    },
  };
}

export { MaintenanceScheduler, MaintenanceError, type MaintenanceErrorCode } from './scheduler.js';
export { createMaintenanceCommands, type MaintenanceCommands } from './commands.js';
export { builtinJobs, PLACEHOLDER_IDS, type TreeMaintenance, type BlockIdMaintenance } from './jobs.js';
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
  ProjectRunLine,
} from './types.js';
