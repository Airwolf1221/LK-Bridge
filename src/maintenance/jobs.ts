/**
 * The maintenance job registry: the implemented jobs and one placeholder (PLAN §8 page 6, docs/maintenance.md;
 * v2 A2 added the repository tree's sweep and check, replacing the `tree-snapshot` placeholder).
 * A placeholder has no `run`, cannot be enabled and cannot be run. Its real logic is a later chunk's work.
 */
import type { JobEngine } from '../jobs/index.js';
import type { LkClient } from '../lk/index.js';
import type { ProjectsRuntime } from '../projects/registry.js';
import type { Db } from '../db/open.js';
import type { ConnectionManager } from '../policy/connections.js';
import type { ProposalService } from '../policy/proposals.js';
import { assetJobs, type AssetMaintenance } from './asset-jobs.js';
import { afterNightChain, withWaitNote, type ChainBusy, type ChainWaitOptions } from './chain.js';
import type { MaintenanceContext, MaintenanceJobDef, MaintenanceResult } from './types.js';

/** v2 A2: what the tree jobs need from the repository tree (src/tree). */
export interface TreeMaintenance {
  sweep(projectId: string, trigger: string): Promise<MaintenanceResult>;
  check(projectId: string, trigger: string): Promise<MaintenanceResult>;
}

/** v2 C2c: what the link sweep needs from the lifecycle module (src/lifecycle). */
/** v2 D1: the chronology check (findings only). */
export interface ChronologyMaintenance {
  check(
    projectId: string,
    trigger: string,
  ): Promise<{ readonly summary: string; readonly changed: boolean; readonly skipped?: boolean }>;
}

/** v2 E2 (ADR 0044): the audits (findings only, read from the snapshots). */
export interface AuditMaintenance {
  run(
    projectId: string,
    trigger: 'manual' | 'schedule',
  ): Promise<{ readonly summary: string; readonly changed: boolean; readonly skipped?: boolean }>;
  /** v3 F9 (ADR 0074): whether an audit of the project is running now (the night's chain). */
  running?(projectId: string): boolean;
}

export interface LinkMaintenance {
  sweep(projectId: string): Promise<MaintenanceResult>;
}

/** v2 E1a (ADR 0042): the snapshot jobs (src/snapshots). */
export interface SnapshotMaintenance {
  full(projectId: string, trigger: string): Promise<MaintenanceResult>;
  prune(): Promise<{ removed: number; gc: { removed: number; freed: number; kept: number } }>;
  verify(): Promise<{ summary: string; missing: number; corrupt: number; badManifests: number }>;
  /** v3 F9 (ADR 0074): whether a full snapshot of the project is under way (or its after-snapshot hooks are). */
  fullInProgress?(projectId: string): boolean;
}

export interface BuiltinJobDeps {
  readonly engine: JobEngine;
  /** Every project with a governor (the budget sampler samples each, v2 A1). */
  readonly projects: Pick<ProjectsRuntime, 'activeIds' | 'anyClient'> & {
    clients?(): readonly { readonly id: string; readonly client: LkClient }[];
  };
  readonly db: Db;
  readonly proposals: Pick<ProposalService, 'expireDue' | 'pruneFinished'>;
  /** Hotfix (ADR 0033): the connection removal sweep. */
  readonly connections?: Pick<ConnectionManager, 'sweepInactive'>;
  /** POLICY_PROPOSAL_RETENTION_DAYS in milliseconds: what `proposal-prune` keeps. */
  readonly proposalRetentionMs: number;
  /** The proposal expiry sweep interval from the policy settings (POLICY_EXPIRY_SWEEP_SECONDS). */
  readonly expirySweepMs: number;
  /** v2 A2: the repository tree (its sweep and check). Without it the two tree jobs skip, saying why. */
  readonly tree?: TreeMaintenance;
  /** v2 A4: the asset tree (its refresh and check). Without it the two asset jobs skip, saying why. */
  readonly assets?: AssetMaintenance;
  /** v2 C2c: the link index (its sweep). Without it the link sweep skips, saying why. */
  readonly links?: LinkMaintenance;
  /** v2 D1: the chronology check. Without it the check skips, saying why. */
  readonly chronology?: ChronologyMaintenance;
  /** v2 E1a: snapshots (full, retention and collector, verify). Without them the jobs skip, saying why. */
  readonly snapshots?: SnapshotMaintenance;
  /** v2 E2: the audits. Without them the job skips, saying why. */
  readonly audits?: AuditMaintenance;
  /** v3 F3.5 (ADR 0056): the block-id sweep. Without it the job skips, saying why. */
  readonly blockIds?: BlockIdMaintenance;
  /** v3 F5b (ADR 0068): the automation framework. Without it the job skips, saying why. */
  readonly automation?: AutomationMaintenance;
  /**
   * v3 F9 (ADR 0074, B5): what the block-id sweep and the automation run wait for when scheduled (the night's full
   * snapshot and the audit after it), and the clock and stop signal of that wait. Without it they go at their time.
   */
  readonly chain?: { readonly busy: ChainBusy } & Omit<ChainWaitOptions, 'pollMs' | 'maxWaitMs'> &
    Partial<Pick<ChainWaitOptions, 'pollMs' | 'maxWaitMs'>>;
}

/** v3 F9 (ADR 0074): the night chain of a project, from the snapshots and the audits. */
export function nightChainBusy(snapshots?: SnapshotMaintenance, audits?: AuditMaintenance): ChainBusy {
  return (projectId) =>
    snapshots?.fullInProgress?.(projectId) === true
      ? 'the night’s full snapshot was still running'
      : audits?.running?.(projectId) === true
        ? 'the audit after the full snapshot was still running'
        : null;
}

/** Runs `run` once the project's night chain has finished (a scheduled run; a manual one goes at once). */
async function afterChain(
  chain: BuiltinJobDeps['chain'],
  ctx: MaintenanceContext,
  run: () => Promise<MaintenanceResult> | MaintenanceResult,
): Promise<MaintenanceResult> {
  if (!chain || !ctx.project) return run();
  const w = await afterNightChain(chain.busy, ctx.project.id, ctx.trigger, chain);
  if (!w.go) return w.result;
  return withWaitNote(await run(), w.waitedMs, w.waitedFor);
}

/** v3 F5b (ADR 0068, H5): what the automation job needs from src/automation. */
export interface AutomationMaintenance {
  run(projectId: string, trigger: 'nightly' | 'manual'): Promise<MaintenanceResult>;
}

/**
 * v3 F5b (ADR 0068, H5): `automation-run`. After the nightly audit (which follows the night's full snapshot at 00:30,
 * and the 06:00 fallback audit when that is on), each code the owner switched on, in a fixed order, at P3. It writes, so
 * read-only mode, a writes pause and draining skip it (the scheduler's rule); with no code switched on it does nothing.
 * Switched on by default: what runs is decided per code by the owner on the Automation page, where everything starts
 * Off.
 */
function automationJob(
  a: AutomationMaintenance | undefined,
  chain?: BuiltinJobDeps['chain'],
): MaintenanceJobDef {
  return {
    id: 'automation-run',
    name: 'Automation',
    description:
      'Runs the finding codes the owner switched on (Automation page), in a fixed order, after the nightly audit: each ' +
      'finding re-checked live, then one proposal per code (Propose automatically) or one verified direct write per ' +
      'page as the Automation principal (Apply automatically), within the caps, at the lowest priority. Every code ' +
      'starts Off; with none switched on this does nothing. Each switch is recorded in Repository Automation.',
    defaultSchedule: { kind: 'daily', time: '06:30' },
    defaultEnabled: true,
    implemented: true,
    writes: true,
    usesLk: true,
    record: 'on-change',
    scope: 'project',
    background: true,
    // v3 F9 (B5): a scheduled run waits for the night's full snapshot and its audit, whose findings it acts on.
    run: (ctx) =>
      a && ctx.project
        ? afterChain(chain, ctx, () =>
            a.run(ctx.project!.id, ctx.trigger === 'manual' ? 'manual' : 'nightly'),
          )
        : { skipped: true, summary: 'Skipped: automation is not running.' },
  };
}

/** v3 F3.5 (ADR 0056): what the block-id sweep job needs from src/blockids. */
export interface BlockIdMaintenance {
  run(projectId: string): Promise<MaintenanceResult>;
  /** Why the job cannot be enabled (no sandbox PASS for this version and no override), or null. */
  canEnable(): string | null;
  /** The owner enabled the job (a standing stop is acknowledged). */
  enabled(): void;
}

/**
 * v3 F3.5 (ADR 0056): `assign-block-ids-sweep`. Off by default; it cannot be enabled without the sandbox check's PASS
 * for this bridge version or the owner's override. Nightly at 05:30 London, after the night's full snapshot (00:30) and
 * the checks that follow it, so its candidates come from that snapshot. It writes, so read-only mode, a writes pause and
 * draining skip it (the scheduler's rule).
 */
function blockIdSweepJob(
  b: BlockIdMaintenance | undefined,
  chain?: BuiltinJobDeps['chain'],
): MaintenanceJobDef {
  return {
    id: 'assign-block-ids-sweep',
    name: 'Assign block IDs sweep',
    description:
      'Gives legacy page documents (a block without an id, or an id used twice) block ids, one assignBlockIds call per ' +
      'document, at most N documents a run at the lowest priority, each document its own job under the page lock, ' +
      'checked inside the lock and verified afterwards against its journalled pre-image. Candidates come from the latest ' +
      'snapshot. Off by default: it needs the sandbox check’s PASS for this bridge version, or the owner’s override. ' +
      'The approved-automation statement is on the card below.',
    defaultSchedule: { kind: 'daily', time: '05:30' },
    defaultEnabled: false,
    implemented: true,
    writes: true,
    usesLk: true,
    record: 'always',
    scope: 'project',
    background: true,
    canEnable: () => (b ? b.canEnable() : 'The block-id sweep is not running on this bridge.'),
    onEnabled: () => b?.enabled(),
    // v3 F9 (B5): a scheduled run waits for the night's full snapshot (its candidates come from it) and its audit.
    run: (ctx) =>
      b && ctx.project
        ? afterChain(chain, ctx, () => b.run(ctx.project!.id))
        : { skipped: true, summary: 'Skipped: the block-id sweep is not running.' },
  };
}

const NO_SNAPSHOTS: MaintenanceResult = { skipped: true, summary: 'Skipped: snapshots are not running.' };

const NOT_IMPLEMENTED = 'Not implemented yet';

/**
 * Ids of the placeholders, for tests and docs. (v2 A2: `tree-snapshot` became `tree-sweep` and `tree-check`; v3 F3.5,
 * ADR 0056: `assign-block-ids-sweep`, the last one, became the block-id sweep.) The framework still takes a placeholder
 * (`implemented: false`): it cannot be enabled, run or rescheduled.
 */
export const PLACEHOLDER_IDS: readonly string[] = [];

const NO_TREE: MaintenanceResult = { skipped: true, summary: 'Skipped: the repository tree is not running.' };

export function builtinJobs(d: BuiltinJobDeps): MaintenanceJobDef[] {
  return [
    {
      id: 'budget-sampler',
      name: 'Budget sampler',
      description:
        'Stores one snapshot of every project’s request budgets (each project has its own governor) every 10 seconds. The Request Budgets sparklines are drawn from these samples.',
      defaultSchedule: { kind: 'interval', everySeconds: 10 },
      defaultEnabled: true,
      implemented: true,
      writes: false,
      usesLk: false,
      record: 'on-change', // every 10 s: a job record only if it fails
      scope: 'bridge', // one run samples every project's governor
      run: () => {
        const sampled = d.projects.clients
          ? d.projects.clients().map((c) => ({ id: c.id, lk: c.client }))
          : d.projects.activeIds().map((id) => ({ id, lk: d.projects.anyClient(id)! }));
        for (const p of sampled) d.engine.recordBudgetSample(p.id, p.lk.governor.snapshot());
        return {
          summary: `Stored a budget sample for ${sampled.length} ${sampled.length === 1 ? 'project' : 'projects'}.`,
        };
      },
    },
    {
      id: 'journal-prune',
      name: 'Journal prune',
      description:
        'Removes write-journal entries older than the retention period, then the oldest ones if the journal is over its size limit. Covers every project.',
      defaultSchedule: { kind: 'daily', time: '03:30' },
      defaultEnabled: true,
      implemented: true,
      writes: false,
      usesLk: false,
      record: 'always',
      scope: 'bridge',
      run: () => {
        const r = d.engine.pruneJournal();
        const n = r.removedByAge + r.removedBySize;
        return {
          summary: `Removed ${n} journal ${n === 1 ? 'entry' : 'entries'} (${r.removedByAge} by age, ${r.removedBySize} by size).`,
          changed: n > 0,
        };
      },
    },
    {
      id: 'proposal-expiry',
      name: 'Proposal expiry',
      description:
        'Expires pending proposals that the owner has not decided before their expiry time, in every project.',
      defaultSchedule: { kind: 'interval', everySeconds: Math.max(10, Math.round(d.expirySweepMs / 1000)) },
      defaultEnabled: true,
      implemented: true,
      writes: false,
      usesLk: false,
      record: 'on-change', // a job record only when something expired (or the sweep failed)
      scope: 'bridge',
      run: () => {
        const n = d.proposals.expireDue();
        return {
          summary:
            n === 0 ? 'No proposals had expired.' : `Expired ${n} ${n === 1 ? 'proposal' : 'proposals'}.`,
          changed: n > 0,
        };
      },
    },
    {
      id: 'proposal-prune',
      name: 'Proposal prune',
      description: `Deletes, in every project, executed, rejected, expired and failed proposals that finished more than ${Math.round(d.proposalRetentionMs / 86_400_000)} days ago, with their stored before-state. Pending and conflicted proposals are never deleted; jobs and journal entries keep the proposal id.`,
      // Daily, a quarter of an hour after journal-prune, so the two never contend for the database.
      defaultSchedule: { kind: 'daily', time: '03:45' },
      defaultEnabled: true,
      implemented: true,
      writes: false,
      usesLk: false,
      record: 'always',
      scope: 'bridge',
      run: () => {
        const r = d.proposals.pruneFinished(d.proposalRetentionMs);
        return {
          summary: `Removed ${r.removed} finished ${r.removed === 1 ? 'proposal' : 'proposals'} that finished before ${new Date(r.cutoff).toISOString()}.`,
          changed: r.removed > 0,
        };
      },
    },
    {
      id: 'connection-removal',
      name: 'Connection removal',
      description:
        'Removes revoked and expired connections (OAuth grants and personal access tokens) once they have been dead for the number of days set on Clients & Access (connections.auto_remove_days, default 30; 0 = never). The day count starts at the revocation, or at the expiry for a connection that expired without being revoked. Their credentials are deleted; a tombstone keeps each name for the journal, proposals, jobs and errors. Audited as connection.remove by the system.',
      // Daily, after the other prunes.
      defaultSchedule: { kind: 'daily', time: '04:00' },
      defaultEnabled: true,
      implemented: true,
      writes: false,
      usesLk: false,
      record: 'on-change', // a job record only when something was removed (or the sweep failed)
      scope: 'bridge',
      run: () => {
        if (!d.connections) return { skipped: true, summary: 'Skipped: the policy layer is not running.' };
        const r = d.connections.sweepInactive();
        return {
          summary:
            r.removed === 0
              ? 'No revoked or expired connection was due for removal.'
              : `Removed ${r.removed} revoked or expired ${r.removed === 1 ? 'connection' : 'connections'}.`,
          changed: r.removed > 0,
        };
      },
    },
    {
      id: 'sqlite-optimise',
      name: 'SQLite optimise',
      description:
        'Runs PRAGMA optimize and checkpoints the write-ahead log, so the database file stays in good shape.',
      defaultSchedule: { kind: 'interval', everySeconds: 7 * 86_400 },
      defaultEnabled: true,
      implemented: true,
      writes: false,
      usesLk: false,
      record: 'always',
      scope: 'bridge',
      run: () => {
        d.db.pragma('optimize');
        const rows = d.db.pragma('wal_checkpoint(PASSIVE)') as {
          busy: number;
          log: number;
          checkpointed: number;
        }[];
        const c = rows[0];
        return {
          summary: c
            ? `Optimised; checkpointed ${c.checkpointed} of ${c.log} log pages${c.busy ? ' (a reader was busy)' : ''}.`
            : 'Optimised.',
        };
      },
    },
    {
      id: 'tree-sweep',
      name: 'Repository tree sweep',
      description:
        'Lists every resource of each project (about one request per 100 resources) and brings its repository tree in line: new pages, moves, renames, tags, aliases, documents and deletions made outside the bridge. Reads the properties of new and stale pages only. Can be switched off per project (Projects page). Skips projects whose tree is not configured or not built.',
      defaultSchedule: { kind: 'interval', everySeconds: 3600 },
      defaultEnabled: true,
      implemented: true,
      writes: false,
      usesLk: true,
      record: 'on-change', // hourly: a job record when it corrected something or failed
      scope: 'project',
      background: true,
      run: (ctx) => (d.tree && ctx.project ? d.tree.sweep(ctx.project.id, ctx.trigger) : NO_TREE),
    },
    {
      id: 'tree-check',
      budgetClass: 'P4', // v3 F9 (ADR 0074): a whole-repository pass
      name: 'Repository tree consistency check',
      description:
        'A full pass over each project’s repository tree at night: the structure, then every page’s properties (one request per page). Corrects the tree and records each correction (old and new values) in the correction log on the Repository Tree page.',
      defaultSchedule: { kind: 'daily', time: '02:30' },
      defaultEnabled: true,
      implemented: true,
      writes: false,
      usesLk: true,
      record: 'always',
      scope: 'project',
      background: true, // a full pass takes minutes: the sampler and the expiry sweep must not wait for it
      run: (ctx) => (d.tree && ctx.project ? d.tree.check(ctx.project.id, ctx.trigger) : NO_TREE),
    },
    // v3 F3.5 (ADR 0056): the block-id sweep, an approved narrow automation (kept where the placeholder was).
    blockIdSweepJob(d.blockIds, d.chain),
    automationJob(d.automation, d.chain),
    // v2 A4: the asset tree's refresh and check (kept after the placeholders so earlier positions do not move).
    ...assetJobs(d.assets),
    // v2 C2c (ADR 0035): the link index's sweep, for the related-pages report of archive_page and move_to_working.
    {
      id: 'link-sweep',
      budgetClass: 'P4', // v3 F9 (ADR 0074): a whole-repository pass
      name: 'Link index sweep',
      description:
        'Reads every page of each project’s AI REPOSITORY (its sidebar, for link collections, and each page document, for ' +
        'mentions) and refreshes the link index that archive_page and move_to_working use to list related pages. About ' +
        'two requests per page (one per page document more), at the lowest priority: it waits while agents’ work is ' +
        'queued, and a run that stops is continued by the next, never restarted. The bridge’s own writes keep the index ' +
        'up to date between sweeps. Skips projects whose tree is not built.',
      defaultSchedule: { kind: 'daily', time: '01:15' },
      defaultEnabled: true,
      implemented: true,
      writes: false,
      usesLk: true,
      record: 'always',
      scope: 'project',
      background: true,
      run: (ctx) =>
        d.links && ctx.project
          ? d.links.sweep(ctx.project.id)
          : { skipped: true, summary: 'Skipped: the link index is not running.' },
    },
    // v2 D1 (ADR 0038): the chronology check. The table is the authority; the check reports, it never repairs.
    {
      id: 'chronology-check',
      name: 'Chronology check',
      description:
        'Reads each project’s confirmed chronology (the Main table, every age table and every age timeline: about 15 ' +
        'requests plus one per 100 events) at the lowest priority, and reports table rows without a timeline event, events ' +
        'without a row, rows out of calendar order, wrong KCY values, Main counts that differ from the tables, and event ' +
        'links that do not point at their age’s table. Findings only: it never repairs anything. The findings are on the ' +
        'Chronology page. Skips projects whose chronology is not confirmed.',
      defaultSchedule: { kind: 'interval', everySeconds: 7 * 86_400 },
      defaultEnabled: true,
      implemented: true,
      writes: false,
      usesLk: true,
      record: 'always',
      scope: 'project',
      background: true,
      run: (ctx) =>
        d.chronology && ctx.project
          ? d.chronology.check(ctx.project.id, ctx.trigger)
          : { skipped: true, summary: 'Skipped: chronology sync is not running.' },
    },
    // v2 E2 (ADR 0044): the audits. They read the snapshots only, so a run costs no request to LegendKeeper.
    {
      id: 'audit-run',
      name: 'Audit',
      description:
        'Audits each project from its newest complete full snapshot (plus any later change snapshots), the type registry, ' +
        'the lifecycle records and the chronology check’s last run: the template and tag rules, internal references, ' +
        'unclassified pages, ordering, taxonomy drift, fact consistency, lifecycle consistency, keep-region health and the ' +
        'chronology’s findings. Findings only: nothing is changed and LegendKeeper is not read. An audit already runs by ' +
        'itself after each nightly full snapshot completes, so this schedule is a fallback and is off by default; the ' +
        'Run now button here, and on the Audits page, run one at once. The findings are on the Audits page.',
      defaultSchedule: { kind: 'daily', time: '06:00' },
      defaultEnabled: false,
      implemented: true,
      writes: false,
      usesLk: false,
      record: 'always',
      scope: 'project',
      run: (ctx) =>
        d.audits && ctx.project
          ? d.audits.run(ctx.project.id, ctx.trigger === 'manual' ? 'manual' : 'schedule')
          : { skipped: true, summary: 'Skipped: the audits are not running.' },
    },
    // v2 E1a (ADR 0042): snapshots.
    {
      id: 'snapshot-full',
      budgetClass: 'P4', // v3 F9 (ADR 0074): a whole-repository pass
      name: 'Full snapshot',
      description:
        'Every night, takes a full snapshot of each project (so edits made in the LegendKeeper app are caught within a day: ' +
        'LegendKeeper’s updatedAt does not track content, so there is no cheaper way to find them): every page under the AI REPOSITORY (its settings, sidebar and every ' +
        'document: page blocks, map features, timeline lanes and events, board content) and the whole asset library with ' +
        'every image’s bytes, into the bridge’s snapshot store. Each piece is stored once, so unchanged pages and images take ' +
        'no extra space, and an image whose id and URL have not changed is recorded from the earlier snapshot without ' +
        'being downloaded again (only new or replaced images download). About 2.2 requests per page at the lowest priority (P4, bulk: at most 30% of each tier by default, after routine maintenance) ' +
        '(downloads come from the asset host, which uses no request budget); it waits while agents’ work is queued, and a run that stops is continued, never restarted. ' +
        'Refused, with a message on the Snapshots page, when it would leave less free disk space than the minimum. Skips ' +
        'projects whose tree is not built.',
      defaultSchedule: { kind: 'daily', time: '00:30' },
      defaultEnabled: true,
      implemented: true,
      writes: false,
      usesLk: true,
      record: 'always',
      scope: 'project',
      background: true,
      run: (ctx) =>
        d.snapshots && ctx.project ? d.snapshots.full(ctx.project.id, ctx.trigger) : NO_SNAPSHOTS,
    },
    {
      id: 'snapshot-prune',
      name: 'Snapshot retention',
      description:
        'Removes the snapshots past their retention (every full snapshot for 30 days, then one a week, the latest of ' +
        'each ISO week, for 8 weeks; change snapshots for 30 days: SNAPSHOT_KEEP_FULL_DAYS, SNAPSHOT_KEEP_WEEKLY, ' +
        'SNAPSHOT_KEEP_DAYS), then the stored pieces no snapshot refers to any more, ' +
        'keeping the bytes kept before an asset delete for their own retention.',
      defaultSchedule: { kind: 'daily', time: '04:40' },
      defaultEnabled: true,
      implemented: true,
      writes: false,
      usesLk: false,
      record: 'always',
      scope: 'bridge',
      run: async () => {
        if (!d.snapshots) return NO_SNAPSHOTS;
        const r = await d.snapshots.prune();
        return {
          summary: `Removed ${r.removed} ${r.removed === 1 ? 'snapshot' : 'snapshots'} past their retention and ${r.gc.removed} unreferenced pieces (${r.gc.freed} bytes); ${r.gc.kept} pieces kept.`,
          changed: r.removed + r.gc.removed > 0,
        };
      },
    },
    {
      id: 'snapshot-verify',
      name: 'Snapshot verify',
      description:
        'Re-hashes every stored piece the snapshots (and the kept bytes) refer to, and reads every manifest. A missing or ' +
        'damaged piece is a finding on the Snapshots page, and every snapshot that uses it becomes partial. Reads the disk ' +
        'only; no request to LegendKeeper.',
      defaultSchedule: { kind: 'weekly', day: 'sun', time: '05:10' },
      defaultEnabled: true,
      implemented: true,
      writes: false,
      usesLk: false,
      record: 'always',
      scope: 'bridge',
      background: true,
      run: async () => {
        if (!d.snapshots) return NO_SNAPSHOTS;
        const r = await d.snapshots.verify();
        return { summary: r.summary, changed: r.missing + r.corrupt + r.badManifests > 0 };
      },
    },
  ];
}

export { NOT_IMPLEMENTED };
