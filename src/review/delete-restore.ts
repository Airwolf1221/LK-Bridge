/**
 * v3 F12 (ADR 0081, D3): Revert's follow-ups for a deletion LegendKeeper can no longer undo itself, once the revert job
 * (which checked the target inside its lock) has succeeded.
 *
 * - **A page** (and, for a cascade, every page under it): made again from the copy kept before the delete
 *   (src/snapshots/delete-copy.ts), parents first, each under its parent's new id, by the snapshot restore's own
 *   `recreate` (its documents, their content and its sidebar), as the owner's confirmed action. The ids change: the
 *   result maps each old id to its new one and lists the pages that linked to the old ids (the link index), for the owner
 *   to relink. A page that cannot be made again stops the rest (its children would have no parent), with why.
 * - **An asset**: uploaded again from the bytes kept before its delete, as a new asset in the same folder under the
 *   same name (the image restore's own path), the pages that showed its old URL relinked where they have not changed
 *   since, the rest listed.
 */
import type { Db } from '../db/open.js';
import { SYSTEM_PRINCIPAL, type JobEngine, type JobOrigin, type JobView } from '../jobs/index.js';
import type { CopiedPage } from '../snapshots/delete-copy.js';
import type { Restores } from '../snapshots/restores.js';

type Obj = Record<string, unknown>;

/** The owner's confirmed action, as a Revert is: it runs at once. */
const ORIGIN: JobOrigin = {
  kind: 'ui',
  client: 'dashboard',
  tool: 'job.revert',
  detail: 'revert: brought back from its copy',
  principal: SYSTEM_PRINCIPAL,
  ownerConfirmed: true,
};

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** Waits for a job to end (bounded: ten minutes). */
async function settle(engine: Pick<JobEngine, 'wait'>, projectId: string, jobId: string): Promise<JobView> {
  let job = await engine.wait(projectId, jobId, 25_000);
  for (let i = 0; i < 24 && !TERMINAL.has(job.status); i++) job = await engine.wait(projectId, jobId, 25_000);
  return job;
}

export interface RecreateDeps {
  readonly db: Db;
  readonly engine: Pick<JobEngine, 'wait' | 'submit' | 'internalRead'>;
  readonly restores: Pick<Restores, 'propose'>;
  /** The pages that link to a page (the link index), by id and name. */
  readonly linksTo?: (projectId: string, pageId: string) => readonly { id: string; name: string | null }[];
}

/** One LegendKeeper restore as the owner's confirmed action (a job), and whether it went through. */
async function restoreOp(
  d: Pick<RecreateDeps, 'engine'>,
  projectId: string,
  op: 'restoreResource' | 'restoreDocument',
  path: Record<string, string>,
): Promise<{ readonly ok: boolean; readonly jobId: string | null; readonly why: string | null }> {
  try {
    const r = await d.engine.submit({
      kind: 'batch_ops',
      project: projectId,
      steps: [{ op, params: { path }, journalOperation: { tool: 'job.revert', write: 'restored from LegendKeeper’s bin' } }],
      onError: 'stop',
      priority: 'P1',
      origin: ORIGIN,
      title: `Revert: ${op}`,
    });
    if (!('jobId' in r)) return { ok: false, jobId: null, why: 'it was not run' };
    const job = await settle(d.engine, projectId, r.jobId);
    return job.status === 'succeeded'
      ? { ok: true, jobId: job.id, why: null }
      : { ok: false, jobId: job.id, why: job.lastError?.message ?? job.status };
  } catch (e) {
    return { ok: false, jobId: null, why: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * A deleted page (and the pages under it): LegendKeeper's own restore first (it brings back the pages deleted with it),
 * checked page by page; else made again from the copy kept before its delete.
 */
export async function recreatePagesFromCopy(
  d: RecreateDeps,
  projectId: string,
  snapshotId: string,
  rootId: string,
): Promise<Obj> {
  const restored = await restoreOp(d, projectId, 'restoreResource', { resourceId: rootId });
  if (restored.ok) {
    const copied = snapshotId
      ? (
          d.db
            .prepare(
              'SELECT pages FROM delete_copies WHERE project_id = ? AND snapshot_id = ? AND resource_id = ? ORDER BY id DESC LIMIT 1',
            )
            .get(projectId, snapshotId, rootId) as { pages: string } | undefined
        )?.pages
      : undefined;
    const pages = copied ? (JSON.parse(copied) as CopiedPage[]) : [];
    const missing: string[] = [];
    for (const p of pages) {
      const r = await d.engine
        .internalRead(projectId, 'getResource', { path: { resourceId: p.id } }, { priority: 'P1', notFoundIsAnswer: true })
        .catch(() => undefined);
      if (!r || (typeof r === 'object' && typeof (r as Obj).deletedAt === 'string')) missing.push(p.name);
    }
    return {
      restoredBy: 'LegendKeeper',
      jobId: restored.jobId,
      pages: Math.max(pages.length, 1),
      ...(missing.length > 0 ? { notBack: missing } : {}),
    };
  }
  if (!snapshotId)
    throw new Error(`LegendKeeper did not restore it (${restored.why ?? 'refused'}), and no copy was kept`);
  const row = d.db
    .prepare(
      'SELECT pages FROM delete_copies WHERE project_id = ? AND snapshot_id = ? AND resource_id = ? ORDER BY id DESC LIMIT 1',
    )
    .get(projectId, snapshotId, rootId) as { pages: string } | undefined;
  if (!row) throw new Error(`no copy of ${rootId} is recorded with snapshot ${snapshotId}`);
  const pages = JSON.parse(row.pages) as CopiedPage[];
  const newIds = new Map<string, string>();
  const recreated: Obj[] = [];
  for (const p of pages) {
    const parent = p.parentId ? newIds.get(p.parentId) : undefined;
    const r = await d.restores.propose(
      {
        projectId,
        pageId: p.id,
        snapshotId,
        scope: 'deleted',
        mode: 'recreate',
        ids: 'new',
        ...(parent ? { parentId: parent } : {}),
      },
      ORIGIN,
      'owner',
    );
    if (r.status === 'nothing_to_do') {
      newIds.set(p.id, p.id);
      continue;
    }
    if (r.status !== 'submitted')
      return { recreated, problem: `${p.name} was proposed instead of made again (${r.status}); the rest was not made` };
    const job = await settle(d.engine, projectId, r.jobId);
    if (job.status !== 'succeeded')
      return {
        recreated,
        problem: `${p.name} could not be made again (job ${job.id}: ${job.lastError?.message ?? job.status}); the pages under it were not made either`,
      };
    const id = r.plan.idMap?.[p.id] ?? p.id;
    newIds.set(p.id, id);
    recreated.push({ oldId: p.id, newId: id, name: p.name, jobId: job.id });
  }
  // The pages that linked to the old ids, for the owner to relink (the ids changed).
  const linkedFrom = recreated
    .filter((x) => x.oldId !== x.newId)
    .map((x) => ({
      oldId: x.oldId,
      newId: x.newId,
      pages: d.linksTo?.(projectId, String(x.oldId)) ?? [],
    }))
    .filter((x) => x.pages.length > 0);
  return {
    restoredBy: 'the copy',
    restoreRefused: restored.why,
    recreated,
    idsChanged: recreated.some((x) => x.oldId !== x.newId),
    linkedFrom,
  };
}

/** A deleted document: LegendKeeper's own restore; when it no longer holds it, where its copy is. */
export async function restoreDocumentOrSay(
  d: Pick<RecreateDeps, 'engine'>,
  projectId: string,
  resourceId: string,
  documentId: string,
  snapshotId: string | null,
): Promise<Obj> {
  const r = await restoreOp(d, projectId, 'restoreDocument', { resourceId, documentId });
  if (r.ok) return { restoredBy: 'LegendKeeper', jobId: r.jobId };
  return {
    problem: `LegendKeeper did not restore the document (${r.why ?? 'refused'})${snapshotId ? `; its copy is snapshot ${snapshotId}: restore it from the Snapshots page` : ''}`,
  };
}

export interface ReuploadDeps {
  readonly engine: Pick<JobEngine, 'wait'>;
  /** The newest snapshot of a project (the image restore reads the library from it, else the kept bytes). */
  readonly latestSnapshot: (projectId: string) => string | null;
  readonly restoreImage: (
    input: {
      readonly projectId: string;
      readonly snapshotId: string;
      readonly assetId: string;
      readonly updateReferences: boolean;
      readonly known?: { readonly name?: string | null; readonly folderId?: string | null; readonly url?: string | null };
    },
    origin: JobOrigin,
  ) => Promise<{ readonly status: string; readonly jobId?: string; readonly references?: unknown; readonly notes?: unknown }>;
}

/** A deleted asset uploaded again from its kept bytes (a new asset, the same folder and name; pages relinked). */
export async function reuploadAssetFromKept(
  d: ReuploadDeps,
  projectId: string,
  assetId: string,
  before: Obj,
): Promise<Obj> {
  const snapshotId = d.latestSnapshot(projectId);
  if (!snapshotId) throw new Error('the project has no snapshot to restore the image through');
  const r = await d.restoreImage(
    {
      projectId,
      snapshotId,
      assetId,
      updateReferences: true,
      known: {
        name: typeof before.name === 'string' ? before.name : null,
        folderId: typeof before.folderId === 'string' ? before.folderId : null,
        url: typeof before.url === 'string' ? before.url : null,
      },
    },
    ORIGIN,
  );
  if (r.status !== 'submitted' || !r.jobId) return { problem: `the image was ${r.status}, not uploaded again` };
  const job = await settle(d.engine, projectId, r.jobId);
  return {
    jobId: job.id,
    status: job.status,
    ...(job.lastError ? { problem: job.lastError.message } : {}),
    references: r.references ?? [],
    notes: r.notes ?? [],
  };
}
