/**
 * v3 F10 (ADR 0078, C3): the chronology repaired soon after an edit.
 *
 * ChatGPT often edits an age table directly (write_page), so the timeline goes without its events until the chronology
 * check runs. When a job's change snapshot shows a chronology document changed (the Main table, an age table or an age
 * timeline), this schedules that project's chronology check `CHRONOLOGY_CHECK_DELAY_MS` (default 10 minutes) after the
 * last such change: debounced (a burst of edits gives one check), one run at a time per project, through the runtime's
 * background runner (src/background.ts: awaited on stop, never inside a request). When the check finishes, the
 * automation's chronology codes act on its findings straight away, within the caps, as the nightly run does.
 *
 * The chronology's own changes (the timeline tools, sync_timeline_event, the repairs, a rename's rows, a revert) keep
 * the table and the timeline in step and verify themselves, so their change snapshots schedule nothing. The table is
 * the authority: nothing here reads the timeline to change a table.
 */
import type { BackgroundRunner } from '../background.js';
import type { ChangeTaken } from '../snapshots/service.js';
import type { ChronologyConfig } from './settings.js';

/** The tools whose jobs keep the chronology in step themselves (their change snapshots schedule no check). */
export const CHRONOLOGY_JOB_TOOLS: ReadonlySet<string> = new Set([
  'create_timeline_event',
  'update_timeline_event',
  'delete_timeline_event',
  'sync_timeline_event',
  'chronology_propose_fix',
  'chronology_count_fix',
  'chronology_kcy_fix',
  'chronology_uri_fix',
  'chronology_order_fix',
  'chronology_style_fix',
  'job_revert',
]);

export const isChronologyJobTool = (tool: string | null): boolean =>
  tool !== null && (CHRONOLOGY_JOB_TOOLS.has(tool) || tool.startsWith('automation.chronology_'));

/**
 * The chronology documents a change snapshot took (by name: `Main`, `<Age> - Table`, `<Age> - Timeline`), or none.
 * A whole page taken (`all`) counts as all of them.
 */
export function chronologyDocumentsTouched(config: ChronologyConfig, change: ChangeTaken): string[] {
  if (!config.resourceId) return [];
  const page = change.pages.find((p) => p.pageId === config.resourceId);
  if (!page) return [];
  const docs = new Map<string, string>();
  if (config.mainDocumentId) docs.set(config.mainDocumentId, config.names.mainDocument);
  for (const a of config.ages) {
    docs.set(a.tableDocumentId, `${a.name}${config.names.tableSuffix}`);
    docs.set(a.timelineDocumentId, `${a.name}${config.names.timelineSuffix}`);
  }
  if (page.documents === 'all') return [...docs.values()];
  return page.documents.flatMap((d) => (docs.has(d) ? [docs.get(d)!] : []));
}

export interface AfterEditDeps {
  readonly chronology: {
    readiness(
      projectId: string,
    ): { readonly ok: true; readonly config: ChronologyConfig } | { readonly ok: false };
    check(
      projectId: string,
      trigger: string,
      priority?: 'P3',
    ): Promise<{ summary: string; skipped?: boolean }>;
  };
  /**
   * The automation's chronology codes (absent: the check alone). `workstreamOf` names, for an age, the workstream of
   * the table edit that caused the check (C5: its repairs are attributed to it), where one is recorded.
   */
  readonly automation?: {
    runChronology(
      projectId: string,
      o?: { readonly workstreamOf?: (age: string) => string | null },
    ): Promise<unknown>;
  };
  /** The workstream a job was labelled with (F5c), or null. */
  readonly workstreamOfJob?: (projectId: string, jobId: string) => string | null;
  readonly background: Pick<BackgroundRunner, 'trigger'>;
  /** CHRONOLOGY_CHECK_DELAY_MS, read on each use. */
  readonly delayMs: () => number;
  readonly log?: { info?(obj: Record<string, unknown>, msg: string): void };
}

/** The trigger key of a project's delayed check (one run at a time per project). */
export const afterEditKey = (projectId: string) => `chronology-check:${projectId}`;

/** The change-snapshot hook: schedules the delayed check when a chronology document changed. True when it did. */
export function createAfterEdit(d: AfterEditDeps): (projectId: string, change: ChangeTaken) => boolean {
  /** Per project, the workstream of the newest edit of each chronology document since its check last started. */
  const causes = new Map<string, Map<string, string>>();
  return (projectId, change) => {
    if (isChronologyJobTool(change.tool)) return false;
    const ready = d.chronology.readiness(projectId);
    if (!ready.ok) return false;
    const touched = chronologyDocumentsTouched(ready.config, change);
    if (touched.length === 0) return false;
    const ws = d.workstreamOfJob?.(projectId, change.jobId) ?? null;
    if (ws !== null) {
      const page = change.pages.find((p) => p.pageId === ready.config.resourceId);
      const c = ready.config;
      const docs =
        page?.documents === 'all'
          ? [c.mainDocumentId, ...c.ages.flatMap((a) => [a.tableDocumentId, a.timelineDocumentId])]
          : (page?.documents ?? []);
      const m = causes.get(projectId) ?? new Map<string, string>();
      for (const doc of docs) if (doc) m.set(doc, ws);
      causes.set(projectId, m);
    }
    const delay = d.delayMs();
    d.log?.info?.(
      { project: projectId, job: change.jobId, documents: touched, delayMs: delay },
      'a chronology document changed: its check is scheduled',
    );
    d.background.trigger(
      afterEditKey(projectId),
      'chronology check after an edit',
      async () => {
        // The edits this run answers: those up to its start (a later edit schedules the next run).
        const mine = causes.get(projectId) ?? new Map<string, string>();
        causes.delete(projectId);
        const r = await d.chronology.check(projectId, 'after-edit', 'P3');
        if (r.skipped === true) return;
        const now = d.chronology.readiness(projectId);
        const workstreamOf = (ageName: string): string | null => {
          if (!now.ok) return null;
          const a = now.config.ages.find((x) => x.name === ageName);
          return (
            (a ? (mine.get(a.tableDocumentId) ?? mine.get(a.timelineDocumentId)) : undefined) ??
            (now.config.mainDocumentId ? mine.get(now.config.mainDocumentId) : undefined) ??
            null
          );
        };
        await d.automation?.runChronology(projectId, mine.size > 0 ? { workstreamOf } : {});
      },
      { debounceMs: delay },
    );
    return true;
  };
}
