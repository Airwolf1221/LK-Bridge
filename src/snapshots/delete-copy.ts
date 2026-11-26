/**
 * v3 F12 (ADR 0081, D3): the restorable copy kept before an agent's delete of a page or a document. Every delete is
 * recoverable: before a `deleteResource` (the page, and for a cascade every page under it) or a `deleteDocument` (the
 * page that holds it) is sent, the pages are read live, every piece of each (documents, their blocks, the sidebar, maps,
 * timelines and boards), and kept as a change snapshot; the copy's record (`delete_copies`) names it, with the pages in
 * order (the root first, parents before children) and what it cost. Review's Revert brings the pages back from it: by
 * LegendKeeper's own restore while it still holds the page, otherwise by recreating them from the copy.
 *
 * Whose deletes: an agent's (its own principal), and Revert's (`job.revert`: a page a job made, deleted again by the
 * owner's Revert). The bridge's own deletes (its maintenance, the rehearsal's throwaway root) keep none.
 *
 * A copy that cannot be taken (a read refused by the budget, a page that cannot be read, a cascade larger than the bridge
 * copies) refuses the delete: nothing is sent, and the job stops with `DELETE_COPY_FAILED` naming why. Never a delete
 * without the copy. The copy is kept for DELETE_COPY_RETENTION_DAYS (the snapshot pruner keeps it), then goes.
 *
 * Cost: per page, one `getResource` (to list it), its sidebar (one `listProperties`), and one read per document (its
 * blocks, features, lanes and events, or board); a cascade adds one `listResources` per page with children. All at P1,
 * in the job's name.
 */
import type { Db } from '../db/open.js';
import { JobsError, SYSTEM_PRINCIPAL, type DeleteCopier, type OpParams } from '../jobs/index.js';
import { classifyName } from '../tree/index.js';
import type { PageNode } from './capture.js';
import type { SnapshotService } from './service.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** The most pages one cascade's copy holds; a larger cascade is refused (delete it in smaller parts). */
export const DELETE_COPY_MAX_PAGES = 1000;

/** The tool of Revert's own jobs (src/review/revert-plan.ts `REVERT_TOOL`; a literal here to avoid a cycle). */
const REVERT_TOOL = 'job.revert';

/** One page of a copy, as kept (the root first, parents before children). */
export interface CopiedPage {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly rank: string | null;
}

/** A copy's record. */
export interface DeleteCopy {
  readonly id: number;
  readonly projectId: string;
  readonly jobId: string;
  readonly stepNo: number;
  readonly op: 'deleteResource' | 'deleteDocument';
  readonly resourceId: string;
  readonly documentId: string | null;
  readonly snapshotId: string;
  readonly pages: readonly CopiedPage[];
  readonly reads: number;
  readonly at: number;
}

class CopyFailed extends JobsError {
  constructor(message: string) {
    super(
      'DELETE_COPY_FAILED',
      `Nothing was deleted: the bridge keeps a restorable copy before every delete, and it could not be taken (${message}).`,
      {},
    );
  }
}

const pageNodeOf = (r: Obj, fallback: { id: string; parentId: string | null }): PageNode => {
  const name = str(r.name) ?? fallback.id;
  return {
    id: str(r.id) ?? fallback.id,
    parentId: str(r.parentId) ?? fallback.parentId,
    rank: str(r.rank),
    name,
    kind: classifyName(name).kind,
  };
};

export interface DeleteCopierDeps {
  readonly db: Db;
  readonly snapshots: () => SnapshotService | undefined;
  readonly now: () => number;
}

/** Whether a job's deletes keep a copy (an agent's, and Revert's). */
export function copiesFor(job: { readonly principalId: string; readonly origin: { readonly tool?: string } }): boolean {
  if (job.origin.tool === REVERT_TOOL) return true;
  return job.principalId !== SYSTEM_PRINCIPAL.principalId && job.principalId !== 'automation';
}

/** The engine's `DeleteCopier` (see the module comment). */
export function createDeleteCopier(d: DeleteCopierDeps): DeleteCopier {
  return async (ctx) => {
    if (!copiesFor(ctx.job)) return {};
    const projectId = ctx.job.projectId;
    // A restart after the copy was taken: the same copy.
    const had = copyOf(d.db, ctx.job.id, ctx.step.stepNo);
    if (had) return { copy: { snapshotId: had.snapshotId, pages: had.pages.length, reads: had.reads } };
    const svc = d.snapshots();
    if (!svc) throw new CopyFailed('the snapshot store is not running');
    const rid = ctx.params.path?.resourceId;
    if (!rid) throw new CopyFailed('the delete names no page');
    const read = async (op: string, params: OpParams): Promise<unknown> => {
      try {
        return await ctx.read(op, params);
      } catch (e) {
        throw new CopyFailed(`${op} could not be read: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    let reads = 0;
    const root = await read('getResource', { path: { resourceId: rid } });
    reads++;
    if (!isObj(root)) throw new CopyFailed(`the page ${rid} could not be read`);
    const nodes: PageNode[] = [pageNodeOf(root, { id: rid, parentId: null })];
    const cascade = ctx.params.query?.cascade === true || ctx.params.query?.cascade === 'true';
    if (ctx.opId === 'deleteResource' && cascade) {
      // Breadth first, so every parent comes before its children (a recreate makes them in this order).
      let level = [rid];
      while (level.length > 0) {
        const next: string[] = [];
        for (const parentId of level) {
          let cursor: string | undefined;
          for (let page = 0; page < 50; page++) {
            const body = await read('listResources', {
              query: { parentId, limit: 100, ...(cursor ? { cursor } : {}) },
            });
            reads++;
            const data = isObj(body) && Array.isArray(body.data) ? body.data : [];
            for (const r of data) {
              if (!isObj(r) || typeof r.id !== 'string' || r.id === rid) continue;
              nodes.push(pageNodeOf(r, { id: r.id, parentId }));
              next.push(r.id);
              if (nodes.length > DELETE_COPY_MAX_PAGES)
                throw new CopyFailed(
                  `the cascade holds more than ${DELETE_COPY_MAX_PAGES} pages, more than the bridge copies before one delete; delete it in smaller parts`,
                );
            }
            if (!isObj(body) || body.hasMore !== true || typeof body.nextCursor !== 'string') break;
            cursor = body.nextCursor;
          }
        }
        level = next;
      }
    }
    let taken;
    try {
      taken = await svc.captureNodes(projectId, nodes, {
        trigger: { kind: 'delete_copy', jobId: ctx.job.id, stepNo: ctx.step.stepNo, op: ctx.opId },
        priority: 'P1',
      });
    } catch (e) {
      throw new CopyFailed(e instanceof Error ? e.message : String(e));
    }
    if (!taken.snapshotId) throw new CopyFailed(taken.summary);
    reads += taken.reads ?? 0;
    const pages: CopiedPage[] = nodes.map((n) => ({
      id: n.id,
      name: n.name,
      parentId: n.parentId,
      rank: n.rank,
    }));
    d.db
      .prepare(
        `INSERT OR IGNORE INTO delete_copies (project_id, job_id, step_no, op, resource_id, document_id, snapshot_id,
           pages, reads, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        ctx.job.id,
        ctx.step.stepNo,
        ctx.opId,
        rid,
        ctx.params.path?.documentId ?? null,
        taken.snapshotId,
        JSON.stringify(pages),
        reads,
        d.now(),
      );
    return { copy: { snapshotId: taken.snapshotId, pages: pages.length, reads } };
  };
}

type Row = Record<string, unknown>;
const toCopy = (r: Row): DeleteCopy => ({
  id: Number(r.id),
  projectId: String(r.project_id),
  jobId: String(r.job_id),
  stepNo: Number(r.step_no),
  op: r.op as DeleteCopy['op'],
  resourceId: String(r.resource_id),
  documentId: typeof r.document_id === 'string' ? r.document_id : null,
  snapshotId: String(r.snapshot_id),
  pages: (() => {
    try {
      return JSON.parse(String(r.pages)) as CopiedPage[];
    } catch {
      return [];
    }
  })(),
  reads: Number(r.reads),
  at: Number(r.at),
});

/** The copy a job's delete step kept, or null. */
export function copyOf(db: Db, jobId: string, stepNo: number): DeleteCopy | null {
  const r = db.prepare('SELECT * FROM delete_copies WHERE job_id = ? AND step_no = ?').get(jobId, stepNo) as
    Row | undefined;
  return r ? toCopy(r) : null;
}
