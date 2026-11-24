/**
 * The asset tree's maintenance jobs (v2 A4, docs/assets.md): the regular refresh (every 6 hours by default, can be
 * switched off per project) and the nightly check, which runs alongside the repository tree's check. Both walk every
 * folder of a project's asset library at P4 (bulk, v3 F9, ADR 0074), so they pace themselves and give way to agents'
 * work and to routine maintenance.
 */
import type { MaintenanceJobDef, MaintenanceResult } from './types.js';

/** What the asset jobs need from the asset tree (src/assets). */
export interface AssetMaintenance {
  refresh(projectId: string, trigger: string): Promise<MaintenanceResult>;
  check(projectId: string, trigger: string): Promise<MaintenanceResult>;
}

const NO_ASSETS: MaintenanceResult = { skipped: true, summary: 'Skipped: the asset tree is not running.' };

export function assetJobs(assets: AssetMaintenance | undefined): MaintenanceJobDef[] {
  return [
    {
      id: 'asset-refresh',
      budgetClass: 'P4', // v3 F9 (ADR 0074): a whole-library walk
      name: 'Asset tree refresh',
      description:
        'Walks every folder of each project’s asset library (one request per folder, plus one for every further 100 items) and brings the asset tree in line: new, moved, renamed and deleted folders and assets made outside the bridge. Paced, at P4 (bulk), so it gives way to agents’ work and to routine maintenance. Can be switched off per project (Projects page). Skips projects whose asset tree is not built.',
      defaultSchedule: { kind: 'interval', everySeconds: 6 * 3600 },
      defaultEnabled: true,
      implemented: true,
      writes: false,
      usesLk: true,
      record: 'on-change', // every 6 hours: a job record when it corrected something or failed
      scope: 'project',
      background: true,
      run: (ctx) => (assets && ctx.project ? assets.refresh(ctx.project.id, ctx.trigger) : NO_ASSETS),
    },
    {
      id: 'asset-check',
      budgetClass: 'P4', // v3 F9 (ADR 0074): a whole-library walk
      name: 'Asset tree consistency check',
      description:
        'A full walk of each project’s asset library at night, next to the repository tree’s check, that also audits the asset tree itself (cached folder paths against parent links). Corrects the asset tree and records each correction (old and new values) in the correction log on the Asset Tree page. Runs even when the regular refresh is switched off.',
      defaultSchedule: { kind: 'daily', time: '02:50' },
      defaultEnabled: true,
      implemented: true,
      writes: false,
      usesLk: true,
      record: 'always',
      scope: 'project',
      background: true,
      run: (ctx) => (assets && ctx.project ? assets.check(ctx.project.id, ctx.trigger) : NO_ASSETS),
    },
  ];
}
