/**
 * The maintenance job registry: four implemented jobs and four placeholders (PLAN §8 page 6, docs/maintenance.md).
 * A placeholder has no `run`, cannot be enabled and cannot be run. Its real logic is a later chunk's work.
 */
import type { JobEngine } from '../jobs/index.js';
import type { LkClient } from '../lk/index.js';
import type { Db } from '../db/open.js';
import type { ProposalService } from '../policy/proposals.js';
import type { MaintenanceJobDef } from './types.js';

export interface BuiltinJobDeps {
  readonly engine: JobEngine;
  readonly lk: LkClient;
  readonly db: Db;
  readonly proposals: Pick<ProposalService, 'expireDue'>;
  /** The proposal expiry sweep interval from the policy settings (POLICY_EXPIRY_SWEEP_SECONDS). */
  readonly expirySweepMs: number;
}

const NOT_IMPLEMENTED = 'Not implemented yet';

const placeholder = (
  id: string,
  name: string,
  description: string,
  writes: boolean,
  everySeconds = 86_400,
): MaintenanceJobDef => ({
  id,
  name,
  description,
  defaultSchedule: { kind: 'interval', everySeconds },
  defaultEnabled: false,
  implemented: false,
  writes,
  usesLk: true,
  record: 'always',
});

/** Ids of the placeholders, for tests and docs. */
export const PLACEHOLDER_IDS = [
  'assign-block-ids-sweep',
  'tree-snapshot',
  'orphan-and-link-audit',
  'tag-audit',
] as const;

export function builtinJobs(d: BuiltinJobDeps): MaintenanceJobDef[] {
  return [
    {
      id: 'budget-sampler',
      name: 'Budget sampler',
      description:
        'Stores one snapshot of the request budgets every 10 seconds. The Request Budgets sparklines are drawn from these samples.',
      defaultSchedule: { kind: 'interval', everySeconds: 10 },
      defaultEnabled: true,
      implemented: true,
      writes: false,
      usesLk: false,
      record: 'on-change', // every 10 s: a job record only if it fails
      run: () => {
        d.engine.recordBudgetSample(d.lk.governor.snapshot());
        return { summary: 'Stored a budget sample.' };
      },
    },
    {
      id: 'journal-prune',
      name: 'Journal prune',
      description:
        'Removes write-journal entries older than the retention period, then the oldest ones if the journal is over its size limit.',
      defaultSchedule: { kind: 'daily', time: '03:30' },
      defaultEnabled: true,
      implemented: true,
      writes: false,
      usesLk: false,
      record: 'always',
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
      description: 'Expires pending proposals that the owner has not decided before their expiry time.',
      defaultSchedule: { kind: 'interval', everySeconds: Math.max(10, Math.round(d.expirySweepMs / 1000)) },
      defaultEnabled: true,
      implemented: true,
      writes: false,
      usesLk: false,
      record: 'on-change', // a job record only when something expired (or the sweep failed)
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
    placeholder(
      'assign-block-ids-sweep',
      'Assign block IDs sweep',
      'Will give legacy documents addressable block ids (assignBlockIds), a page at a time within the P3 budget.',
      true,
    ),
    placeholder(
      'tree-snapshot',
      'Tree snapshot',
      'Will store a snapshot of the whole resource tree so changes can be compared over time.',
      false,
    ),
    placeholder(
      'orphan-and-link-audit',
      'Orphan and link audit',
      'Will report resources with no parent links and links that point nowhere.',
      false,
    ),
    placeholder('tag-audit', 'Tag audit', 'Will report unused, duplicate and near-duplicate tags.', false),
  ];
}

export { NOT_IMPLEMENTED };
