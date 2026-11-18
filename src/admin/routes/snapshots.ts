/**
 * The Snapshots page's API (v2 E1a, ADR 0042; docs/dashboard.md › Snapshots), behind the owner session and CSRF like
 * every admin route:
 *
 * - `GET /snapshots`: the store (its size, the deduplication ratio, the disk's free space against the minimum), the
 *   project's snapshots, runs, findings (missing or damaged pieces) and notices, the next full snapshot's estimate, the
 *   restores proposed, the rehearsals, the snapshot jobs' schedules and the nightly database copies with their age.
 * - `GET /snapshots/pages` and `GET /snapshots/pages/:pageId`: the pages the snapshots hold (a deleted page too) and one
 *   page's history, newest first, piece by piece. Free: the bridge's own index.
 * - `GET /snapshots/diff`: one piece's Markdown diff between a snapshot and the page now (a few reads at P1) or between
 *   two snapshots (free).
 * - `POST /snapshots/full`: a full snapshot of the project now (the nightly one runs on its own);
 *   `POST /snapshots/runs/:id/abandon`: stops an interrupted run for good.
 * - `POST /snapshots/restore` and `POST /snapshots/restore-image`: "Propose a restore". ALWAYS a proposal, approved as
 *   normal on the Proposals page; `dryRun` shows the plan without proposing.
 * - `POST /snapshots/rehearsals/plan`, `POST /snapshots/rehearsals`, `POST /snapshots/rehearsals/:id/delete-root`: the
 *   restore rehearsal into a sandbox project's throwaway root (its estimate first; the owner starts it).
 *
 * Every change is audited (`snapshots.full`, `snapshots.abandon`, `snapshots.restore`, `snapshots.rehearsal`,
 * `snapshots.rehearsal_delete_root`).
 */
import * as z from 'zod';
import { ResumeError } from '../../resume/service.js';
import { SYSTEM_PRINCIPAL, type JobOrigin } from '../../jobs/index.js';
import { diffText } from '../../snapshots/diff.js';
import { documentsOf, historyOf, pieceNow, pieceThen } from '../../snapshots/history.js';
import { missingPiecesOf } from '../../snapshots/manifest.js';

/** v3 F2: at most this many missing pieces are listed per snapshot (the rest are counted). */
const MISSING_SHOWN = 200;
import { imageRestoreDeps, restoreImage } from '../../snapshots/image-restore.js';
import type { Rehearsals } from '../../snapshots/rehearsal.js';
import { RestoreError } from '../../snapshots/restore.js';
import type { Restores } from '../../snapshots/restores.js';
import type { SnapshotService } from '../../snapshots/service.js';
import { AdminHttpError } from '../http.js';
import { limitSchema, parseInput, projectParam, type Register } from './util.js';

const PAGE_ID = z.string().regex(/^[a-z][0-9a-z]{5,31}$/, 'a LegendKeeper resource id');
const SNAPSHOT_ID = z.string().regex(/^\d{8}T\d{6}Z-(full|change|daily)-[0-9a-f]{1,32}$/, 'a snapshot id');
const ASSET_ID = z.string().min(1).max(64);
const projectQuery = z.object({ project: projectParam });
const pieceQuery = z.object({
  piece: z.enum(['resource', 'sidebar', 'document']).optional(),
  ref: z.string().min(1).max(64).optional(),
});
const SNAPSHOT_JOBS = ['snapshot-full', 'snapshot-prune', 'snapshot-verify'];

const ORIGIN = (tool: string): JobOrigin => ({ kind: 'ui', tool, principal: SYSTEM_PRINCIPAL });

interface Services {
  readonly svc: SnapshotService;
  readonly restores: Restores;
  readonly rehearsals: Rehearsals;
}

/** A refusal from the snapshot code, as a 409 with its code (never a 500). */
function refusal(e: unknown): never {
  if (e instanceof RestoreError) throw new AdminHttpError(409, e.code, e.message, e.details);
  throw e;
}

export const registerSnapshots: Register = (api, ctx) => {
  const rt = ctx.deps.runtime;
  const services = (): Services => {
    if (!rt.snapshots || !rt.restores || !rt.rehearsals)
      throw new AdminHttpError(503, 'SNAPSHOTS_UNAVAILABLE', 'Snapshots are not running in this bridge.');
    return { svc: rt.snapshots, restores: rt.restores, rehearsals: rt.rehearsals };
  };
  const audit = (action: string, target: string, after?: unknown) =>
    rt.policy.store.audit('owner', action, target, undefined, after);
  const pageName = (projectId: string, pageId: string): string | null => {
    try {
      return rt.tree.queries.node(projectId, pageId).data?.rawName ?? null;
    } catch {
      return null;
    }
  };
  const sandboxes = () =>
    rt.projects
      .list()
      .filter((p) => p.isSandbox && p.id)
      .map((p) => ({ name: p.name, id: p.id, active: p.status === 'active' }));
  const jobs = () =>
    SNAPSHOT_JOBS.map((id) => {
      try {
        const j = rt.maintenance.commands.get('owner', id);
        return {
          id: j.id,
          name: j.name,
          enabled: j.enabled,
          scheduleText: j.scheduleText,
          nextRunAt: (j as { nextRunAt?: number | null }).nextRunAt ?? null,
          lastRun: (j as { lastRun?: unknown }).lastRun ?? null,
        };
      } catch {
        return null;
      }
    }).filter((j) => j !== null);

  api.get('/snapshots', async (req) => {
    const q = parseInput(
      z.object({
        project: projectParam,
        kind: z.enum(['full', 'change']).optional(),
        limit: limitSchema(100, 1000),
      }),
      req.query,
    );
    const project = ctx.project(q.project);
    const { svc, restores } = services();
    const [overview, backups] = await Promise.all([svc.overview(project.id), svc.databaseBackups()]);
    // v3 F2 (ADR 0049 decision 4): a partial snapshot lists its missing pieces (page, piece, reference, reason), from
    // its manifest, read once per snapshot in this request (snapshots are small; only partial ones are read).
    const rows = svc.index.snapshots(project.id, { ...(q.kind ? { kind: q.kind } : {}), limit: q.limit });
    const snapshots = await Promise.all(
      rows.map(async (row) => {
        if (row.missing === 0) return row;
        const m = await svc.manifest(row.id).catch(() => null);
        if (!m) return { ...row, missingPieces: null };
        const pieces = missingPiecesOf(m);
        return {
          ...row,
          missingPieces: pieces.slice(0, MISSING_SHOWN),
          ...(pieces.length > MISSING_SHOWN ? { missingMore: pieces.length - MISSING_SHOWN } : {}),
        };
      }),
    );
    return {
      project: project.name,
      overview,
      snapshots,
      restores: restores.list(project.id, { limit: 50 }),
      rehearsals: svc.index.rehearsals(project.id, 50),
      sandboxes: sandboxes(),
      jobs: jobs(),
      backups,
      now: ctx.now(),
    };
  });

  /** The pages the snapshots hold (by name), newest first. A page deleted since is listed with `deleted`. */
  api.get('/snapshots/pages', (req) => {
    const q = parseInput(
      z.object({ project: projectParam, q: z.string().max(200).optional(), limit: limitSchema(200, 2000) }),
      req.query,
    );
    const project = ctx.project(q.project);
    const { svc } = services();
    return {
      project: project.name,
      pages: svc.index.pagesWithHistory(project.id, {
        ...(q.q?.trim() ? { query: q.q.trim() } : {}),
        limit: q.limit,
      }),
    };
  });

  /** One page's snapshots, newest first, piece by piece (free), and the documents its snapshots know. */
  api.get('/snapshots/pages/:pageId', (req) => {
    const { pageId } = parseInput(z.object({ pageId: PAGE_ID }), req.params);
    const q = parseInput(projectQuery.merge(pieceQuery).extend({ limit: limitSchema(50, 500) }), req.query);
    const project = ctx.project(q.project);
    const { svc, restores } = services();
    const live = pageName(project.id, pageId);
    const known = svc.index.pagesWithHistory(project.id, { limit: 100_000 }).find((p) => p.pageId === pageId);
    if (!live && !known) throw new AdminHttpError(404, 'NOT_FOUND', `No snapshot holds the page ${pageId}.`);
    const f = q.piece ? { piece: q.piece, ...(q.ref ? { ref: q.ref } : {}) } : {};
    return {
      project: project.name,
      page: { id: pageId, name: live ?? known?.name ?? pageId, live: live !== null },
      documents: [...documentsOf(svc, project.id, pageId)].map(([id, name]) => ({ id, name })),
      history: historyOf(svc, project.id, pageId, f, q.limit),
      restores: restores.list(project.id, { pageId, limit: 20 }),
    };
  });

  /** A piece's diff: `from` a snapshot `to` another (free) or to the page now (`to` left out: a few reads at P1). */
  api.get('/snapshots/diff', async (req) => {
    const q = parseInput(
      z
        .object({ project: projectParam, page: PAGE_ID, from: SNAPSHOT_ID, to: SNAPSHOT_ID.optional() })
        .merge(pieceQuery)
        .refine((v) => v.piece !== undefined, 'piece is required')
        .refine((v) => v.piece !== 'document' || v.ref !== undefined, 'a document needs ref (its id)'),
      req.query,
    );
    const project = ctx.project(q.project);
    const { svc } = services();
    const f = { piece: q.piece!, ...(q.ref ? { ref: q.ref } : {}) };
    try {
      const before = await pieceThen(svc, project.id, q.page, f, q.from);
      let after: string;
      let reads = 0;
      if (q.to) after = await pieceThen(svc, project.id, q.page, f, q.to);
      else {
        const now = await pieceNow(svc, project.id, q.page, f);
        after = now.text;
        reads = now.reads;
      }
      const d = diffText(before, after);
      return {
        project: project.name,
        page: q.page,
        piece: q.piece,
        ref: q.ref ?? null,
        from: q.from,
        to: q.to ?? 'now',
        identical: d.identical,
        added: d.diff.added,
        removed: d.diff.removed,
        diff: d.diff,
        text: d.text,
        before,
        after,
        reads,
      };
    } catch (e) {
      refusal(e);
    }
  });

  /** A full snapshot of the project now; it runs in the background (the page follows its run). */
  api.post('/snapshots/full', async (req, reply) => {
    const q = parseInput(projectQuery, req.query);
    const project = ctx.project(q.project);
    const { svc } = services();
    const running = svc.index.runningRun(project.id, 'full');
    const done = svc.full(project.id, 'manual');
    done.catch(() => undefined); // a failure is recorded on the run
    // Answer once the run is recorded (or refused, or already finished).
    const first = await Promise.race([
      done.then((r) => ({ finished: r })),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 300)),
    ]);
    const run = svc.index.runs(project.id, 1)[0] ?? null;
    audit('snapshots.full', project.id, { continued: running?.id ?? null, run: run?.id ?? null });
    return reply.code(202).send({
      project: project.name,
      run,
      ...(first ? { outcome: first.finished } : {}),
    });
  });

  api.post('/snapshots/runs/:id/abandon', (req) => {
    const { id } = parseInput(z.object({ id: z.string().regex(/^run_[0-9a-f]{16}$/) }), req.params);
    parseInput(z.object({ confirm: z.literal(true) }), req.body);
    const { svc } = services();
    if (!svc.abandonRun(id)) throw new AdminHttpError(409, 'NOT_RUNNING', 'That run is not running.');
    audit('snapshots.abandon', id);
    return { run: svc.index.run(id) };
  });

  /** "Propose a restore": always a proposal, approved as normal on the Proposals page. `dryRun`: the plan only. */
  /**
   * v3 F2 (ADR 0049 decision 6): "Finish" a recreate that stopped part-way: the same request proposed again, planning
   * only what the page it made still lacks. Audited `snapshots.finish_recreate`.
   */
  api.post('/snapshots/restores/:id/finish', async (req) => {
    const q = parseInput(projectQuery, req.query);
    const { id } = parseInput(z.object({ id: z.string().regex(/^rst_[0-9a-f]{16}$/) }), req.params);
    const project = ctx.project(q.project);
    const { restores } = services();
    try {
      // v3 F3d (ADR 0058): the same mechanism as Resume on the Jobs page: the recreate's job (when it has one that can
      // be resumed) is resumed, which finishes it exactly as before (only what is missing, as a proposal).
      const resume = ctx.deps.runtime.resume;
      const jobId = restoreJob(ctx.deps.runtime.policy, restores, project.id, id);
      if (resume && jobId && resume.view(project.id, jobId).resumable) {
        const r = await resume.resume(
          project.id,
          jobId,
          { kind: 'owner' },
          ORIGIN('snapshots.finish_recreate'),
        );
        if (r.status === 'nothing_to_do') return { status: 'nothing_to_do', summary: r.summary };
        if (r.status === 'proposal_captured') {
          audit('snapshots.finish_recreate', r.proposalId, { project: project.id, restoreId: id, jobId });
          return { status: 'proposal_captured', proposalId: r.proposalId, summary: r.summary };
        }
      }
      const r = await restores.finish(project.id, id, ORIGIN('snapshots.finish_recreate'), 'owner');
      if (r.status === 'nothing_to_do') return { status: 'nothing_to_do', summary: r.plan.summary };
      audit('snapshots.finish_recreate', r.proposalId, { project: project.id, restoreId: id });
      return { status: 'proposal_captured', proposalId: r.proposalId, summary: r.summary };
    } catch (e) {
      if (e instanceof RestoreError) throw new AdminHttpError(409, e.code, e.message, e.details);
      if (e instanceof ResumeError) throw new AdminHttpError(409, e.code, e.message, e.details);
      throw e;
    }
  });

  api.post('/snapshots/restore', async (req) => {
    const q = parseInput(projectQuery, req.query);
    const b = parseInput(
      z
        .object({
          page: PAGE_ID,
          snapshot: SNAPSHOT_ID,
          scope: z.enum(['page', 'sidebar', 'document', 'deleted']),
          document: z.string().min(1).max(64).optional(),
          mode: z.enum(['auto', 'undelete', 'recreate']).optional(),
          ids: z.enum(['original', 'new']).optional(),
          parent: PAGE_ID.optional(),
          dryRun: z.boolean().optional(),
        })
        .strict()
        .refine((v) => v.scope !== 'document' || v.document !== undefined, 'scope "document" needs document'),
      req.body,
    );
    const project = ctx.project(q.project);
    const { restores } = services();
    const input = {
      projectId: project.id,
      pageId: b.page,
      snapshotId: b.snapshot,
      scope: b.scope,
      ...(b.document ? { documentId: b.document } : {}),
      ...(b.mode ? { mode: b.mode } : {}),
      ...(b.ids ? { ids: b.ids } : {}),
      ...(b.parent ? { parentId: b.parent } : {}),
    } as const;
    try {
      const plan = await restores.plan(input);
      const view = {
        page: plan.page,
        scope: plan.scope,
        mode: plan.mode ?? null,
        snapshot: {
          id: plan.snapshot.id,
          takenAt: plan.snapshot.takenAt,
          kind: plan.snapshot.kind,
        },
        summary: plan.summary,
        pieces: plan.pieces.map((p) => ({ label: p.label, diff: p.diff })),
        writes: plan.steps.filter((s) => !s.op.startsWith('bridge.')).length,
        lost: plan.lost,
        kept: plan.kept,
        notRestored: plan.notRestored,
        warnings: plan.warnings,
        idMap: plan.idMap ?? null,
        followUp: plan.followUp ?? null,
        reads: plan.reads,
        // v2 E5.5: how long it should take once approved, and the figures used.
        estimate: plan.estimate ?? null,
      };
      if (plan.empty) return { status: 'nothing_to_do', plan: view };
      if (b.dryRun) return { status: 'dry_run', plan: view };
      const r = await restores.propose(input, ORIGIN('snapshots.restore'), 'owner', plan);
      if (r.status === 'nothing_to_do') return { status: 'nothing_to_do', plan: view };
      audit('snapshots.restore', r.proposalId, {
        project: project.id,
        page: b.page,
        snapshot: b.snapshot,
        scope: b.scope,
        restoreId: r.restoreId,
      });
      return {
        status: 'proposal_captured',
        proposalId: r.proposalId,
        restoreId: r.restoreId,
        ...(r.canonical ? { canonical: r.canonical } : {}),
        plan: view,
      };
    } catch (e) {
      refusal(e);
    }
  });

  /**
   * A deleted image back as a NEW asset (new URL): staged (hidden) first, then one proposal places it; with
   * `updateReferences` (the owner's tick) the same proposal updates the pages that showed the old URL.
   */
  api.post('/snapshots/restore-image', async (req) => {
    const q = parseInput(projectQuery, req.query);
    const b = parseInput(
      z
        .object({
          snapshot: SNAPSHOT_ID,
          asset: ASSET_ID,
          updateReferences: z.boolean().default(false),
          dryRun: z.boolean().optional(),
        })
        .strict(),
      req.body,
    );
    const project = ctx.project(q.project);
    const { svc } = services();
    if (!rt.images)
      throw new AdminHttpError(503, 'IMAGES_UNAVAILABLE', 'The image pipeline is not available.');
    try {
      const r = await restoreImage(
        imageRestoreDeps({
          svc,
          engine: rt.engine,
          images: rt.images,
          assets: rt.assets,
          tree: rt.tree,
          projectId: project.id,
        }),
        {
          projectId: project.id,
          snapshotId: b.snapshot,
          assetId: b.asset,
          updateReferences: b.updateReferences,
        },
        ORIGIN('snapshots.restore_image'),
        { ...(b.dryRun ? { dryRun: true } : {}) },
      );
      if (r.status === 'proposal_captured')
        audit('snapshots.restore', r.proposalId, {
          project: project.id,
          asset: b.asset,
          snapshot: b.snapshot,
          scope: 'image',
          updateReferences: b.updateReferences,
        });
      return r;
    } catch (e) {
      refusal(e);
    }
  });

  /** A rehearsal's plan: the pages, what they cover and its estimate (no request to LegendKeeper). */
  api.post('/snapshots/rehearsals/plan', async (req) => {
    const b = parseInput(
      z
        .object({
          target: z.string().min(1).max(64),
          snapshot: SNAPSHOT_ID,
          mode: z.enum(['sampled', 'full']),
          max: z.number().int().min(1).max(500).optional(),
        })
        .strict(),
      req.body,
    );
    const { rehearsals } = services();
    try {
      const { plan } = await rehearsals.plan({
        targetProject: b.target,
        snapshotId: b.snapshot,
        mode: b.mode,
        ...(b.max ? { max: b.max } : {}),
      });
      return { plan };
    } catch (e) {
      refusal(e);
    }
  });

  /** Starts a rehearsal (the owner's job): it runs in the background, and its row records its progress and results. */
  api.post('/snapshots/rehearsals', async (req, reply) => {
    const b = parseInput(
      z
        .object({
          target: z.string().min(1).max(64),
          snapshot: SNAPSHOT_ID,
          mode: z.enum(['sampled', 'full']),
          keep: z.boolean().default(false),
          max: z.number().int().min(1).max(500).optional(),
          confirm: z.literal(true),
        })
        .strict(),
      req.body,
    );
    const { rehearsals } = services();
    try {
      const row = await rehearsals.start({
        targetProject: b.target,
        snapshotId: b.snapshot,
        mode: b.mode,
        keep: b.keep,
        by: 'owner',
        ...(b.max ? { max: b.max } : {}),
      });
      audit('snapshots.rehearsal', row.id, {
        target: row.projectId,
        source: row.sourceProjectId,
        snapshot: row.snapshotId,
        mode: row.mode,
        keep: row.keep,
      });
      return reply.code(202).send({ rehearsal: row });
    } catch (e) {
      refusal(e);
    }
  });

  api.get('/snapshots/rehearsals/:id', (req) => {
    const { id } = parseInput(z.object({ id: z.string().regex(/^rh_[0-9a-f]{16}$/) }), req.params);
    const { svc } = services();
    const row = svc.index.rehearsal(id);
    if (!row) throw new AdminHttpError(404, 'NOT_FOUND', `No rehearsal ${id}.`);
    return { rehearsal: row };
  });

  /** Deletes a kept rehearsal's root (and everything under it), and its asset folder. */
  api.post('/snapshots/rehearsals/:id/delete-root', async (req) => {
    const { id } = parseInput(z.object({ id: z.string().regex(/^rh_[0-9a-f]{16}$/) }), req.params);
    parseInput(z.object({ confirm: z.literal(true) }), req.body);
    const { rehearsals } = services();
    try {
      const row = await rehearsals.deleteRoot(id);
      audit('snapshots.rehearsal_delete_root', id, { root: row.rootId, state: row.rootState });
      return { rehearsal: row };
    } catch (e) {
      refusal(e);
    }
  });
};

/** v3 F3d (ADR 0058): the job a restore's proposal ran as, when it has one. */
function restoreJob(
  policy: { readonly proposals: { get(id: string): { readonly jobId: string | null } | undefined } },
  restores: { record(projectId: string, id: string): { readonly proposalId: string | null } | null },
  projectId: string,
  restoreId: string,
): string | null {
  const rec = restores.record(projectId, restoreId);
  if (!rec?.proposalId) return null;
  return policy.proposals.get(rec.proposalId)?.jobId ?? null;
}
