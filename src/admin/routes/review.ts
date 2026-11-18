/**
 * v3 F3.4 (ADR 0055): the Review page's API (the queue of agents' direct writes at scope `write`) and Revert (from the
 * Review and Jobs pages). Reviewing changes nothing in LegendKeeper. Revert needs the owner's re-authentication, is
 * audited (`job.revert`), and is refused with the targets listed (409) when it would not revert everything and the owner
 * has not confirmed a partial revert. Every route acts within one project (`?project=`, default: the default project).
 */
import * as z from 'zod';
import { RevertError } from '../../review/revert.js';
import type { ReviewService } from '../../review/service.js';
import type { RevertService } from '../../review/revert.js';
import { requireReauth } from '../guard.js';
import { AdminHttpError } from '../http.js';
import { redactDeep } from '../redact.js';
import { idSchema, limitSchema, parseInput, projectParam, type Register } from './util.js';

const projectQuery = z.object({ project: projectParam });
const filterQuery = z.object({
  project: projectParam,
  state: z.enum(['unreviewed', 'reviewed', 'all']).default('unreviewed'),
  profile: z.string().min(1).max(64).optional(),
  tool: z.string().min(1).max(200).optional(),
  before: z.coerce.number().int().optional(),
  limit: limitSchema(50, 200),
});

function services(ctx: Parameters<Register>[1]): { review: ReviewService; reverts: RevertService } {
  const { review, reverts } = ctx.deps.runtime;
  if (!review || !reverts)
    throw new AdminHttpError(
      503,
      'REVIEW_UNAVAILABLE',
      'The review of direct writes is not available in this bridge.',
    );
  return { review, reverts };
}

const REVERT_STATUS: Readonly<Record<string, number>> = {
  JOB_NOT_FOUND: 404,
  NOT_OWNER: 403,
  READ_FAILED: 502,
};

export const registerReview: Register = (api, ctx) => {
  /** The queue, newest first (unreviewed by default), with the filters' choices and the count. */
  api.get('/review', (req) => {
    const q = parseInput(filterQuery, req.query);
    const project = ctx.project(q.project);
    const { review } = services(ctx);
    const where = {
      state: q.state,
      ...(q.profile ? { profile: q.profile } : {}),
      ...(q.tool ? { tool: q.tool } : {}),
    };
    const items = review.list(project.id, {
      ...where,
      ...(q.before !== undefined ? { before: q.before } : {}),
      limit: q.limit,
    });
    return redactDeep({
      project,
      items,
      facets: review.store.facets(project.id),
      counts: {
        unreviewed: review.store.count(project.id, { state: 'unreviewed' }),
        matching: review.store.count(project.id, where),
      },
      // CR-2026-11-R2 (R2-09): the exact set "Mark all reviewed" would mark for these filters, echoed by the request.
      markAll: review.markAllSet(project.id, {
        ...(q.profile ? { profile: q.profile } : {}),
        ...(q.tool ? { tool: q.tool } : {}),
      }),
    });
  });

  /** The badge: the unreviewed count of this project, and of every project by name. */
  api.get('/review/counts', (req) => {
    const project = ctx.project(parseInput(projectQuery, req.query).project);
    const { review } = services(ctx);
    const c = review.counts(project.id);
    const byProject: Record<string, number> = {};
    for (const p of ctx.deps.runtime.projects.list())
      if (p.id) byProject[p.name] = c.byProject.get(p.id) ?? 0;
    return { project, unreviewed: c.unreviewed, byProject };
  });

  /** One item: what the job changed, page by page (its diffs). */
  api.get('/review/:jobId', (req) => {
    const { jobId } = parseInput(z.object({ jobId: idSchema }), req.params);
    const project = ctx.project(parseInput(projectQuery, req.query).project);
    const item = services(ctx).review.detail(project.id, jobId);
    if (!item)
      throw new AdminHttpError(
        404,
        'NOT_A_DIRECT_WRITE',
        `Job ${jobId} is not a direct write in this project.`,
      );
    // v3 F3d (ADR 0058): a stopped package's Resume, beside its Revert (the alternative for a direct job).
    const resume = ctx.deps.runtime.resume;
    const stop = resume?.stopOf(project.id, jobId) ?? null;
    return redactDeep(
      { item, ...(stop ? { resume: resume!.view(project.id, jobId) } : {}) },
      { maxString: 200_000, maxItems: 5000, maxKeys: 1000, maxDepth: 64 },
    );
  });

  /** Marks items reviewed (each audited as `review.mark`). */
  api.post('/review/mark', (req) => {
    const project = ctx.project(parseInput(projectQuery, req.query).project);
    const b = parseInput(z.object({ ids: z.array(idSchema).min(1).max(200) }).strict(), req.body);
    return { marked: services(ctx).review.markReviewed('owner', project.id, b.ids) };
  });

  /**
   * "Mark all reviewed" for a filtered set, after the owner's confirmation of how many (`expect`): when more arrived
   * since, nothing is marked and the new count comes back (409). Audited once as `review.mark_all`.
   */
  api.post('/review/mark-all', (req) => {
    const project = ctx.project(parseInput(projectQuery, req.query).project);
    const b = parseInput(
      z
        .object({
          filter: z
            .object({
              profile: z.string().min(1).max(64).optional(),
              tool: z.string().min(1).max(200).optional(),
            })
            .strict()
            .default({}),
          expect: z.number().int().min(0),
          // R2-09: the fingerprint the list answered for this set (the dashboard always sends it).
          fingerprint: z
            .string()
            .regex(/^[0-9a-f]{32}$/)
            .optional(),
          confirm: z.literal(true),
        })
        .strict(),
      req.body,
    );
    const filter = {
      ...(b.filter.profile ? { profile: b.filter.profile } : {}),
      ...(b.filter.tool ? { tool: b.filter.tool } : {}),
    };
    const r = services(ctx).review.markAll('owner', project.id, filter, b.expect, b.fingerprint);
    if (r.changed)
      throw new AdminHttpError(
        409,
        'REVIEW_CHANGED',
        `The filter now matches ${r.count} unreviewed items, not ${b.expect}: nothing was marked. Look again and confirm.`,
        { count: r.count },
      );
    return { marked: r.marked };
  });

  /** What a revert of the job would do now: each target read live (reads only; nothing is written). */
  api.get('/jobs/:id/revert', async (req) => {
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    const project = ctx.project(parseInput(projectQuery, req.query).project);
    try {
      return redactDeep(
        { preview: await services(ctx).reverts.preview(project.id, id) },
        { maxString: 20_000 },
      );
    } catch (e) {
      if (e instanceof RevertError) throw new AdminHttpError(REVERT_STATUS[e.code] ?? 409, e.code, e.message);
      throw e;
    }
  });

  /**
   * Reverts a finished direct-write job (owner, re-authenticated, confirmed). A refusal is 409 with the targets and why
   * each is not reverted; `confirmPartial: true` with `confirmed` (the ready targets the owner saw) reverts exactly
   * those when some cannot be.
   */
  api.post('/jobs/:id/revert', async (req) => {
    requireReauth(ctx.deps.services, req);
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    const project = ctx.project(parseInput(projectQuery, req.query).project);
    const b = parseInput(
      z
        .object({
          confirm: z.literal(true),
          confirmPartial: z.boolean().default(false),
          // CR-2026-11-R2 (R2-23): the targets the owner confirmed (the preview's ready set): a partial revert reverts
          // exactly these, and is refused (409 REVERT_CHANGED) when what can be reverted now differs.
          confirmed: z.array(z.string().min(1).max(600)).max(1000).optional(),
        })
        .strict(),
      req.body,
    );
    let r;
    try {
      r = await services(ctx).reverts.revert('owner', project.id, id, {
        confirmPartial: b.confirmPartial,
        ...(b.confirmed ? { confirmed: b.confirmed } : {}),
      });
    } catch (e) {
      if (e instanceof RevertError) throw new AdminHttpError(REVERT_STATUS[e.code] ?? 409, e.code, e.message);
      throw e;
    }
    if (r.status === 'refused')
      throw new AdminHttpError(REVERT_STATUS[r.code] ?? 409, r.code, r.message, {
        targets: redactDeep(r.targets, { maxString: 20_000 }),
      });
    return redactDeep({ revert: r }, { maxString: 20_000 });
  });
};
