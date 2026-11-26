/**
 * The Tagging page's API (v3 F3f, ADR 0060; docs/dashboard.md › Tagging), in the Repository group: the retag audit, the
 * holds with the owner's classification, the apply batches and the reconciliations.
 *
 * - `GET /tagging`: the policy (the approved pack version and its digest) or why the retag is unavailable, the latest
 *   runs, the owner's classifications, the reconciliations, the batches and the closed list;
 * - `POST /tagging/audit`: an audit of a page, a branch or everything (free: the snapshots);
 * - `GET /tagging/runs/:id`: a stored run's pages (filtered, paged);
 * - `GET /tagging/holds`: the latest run's holds, each with the agents' suggestions and the owner's classification;
 * - `POST /tagging/classify` (audited `retag.classify`): the owner's classification of a page from the
 *   closed list, used by every later audit; `POST /tagging/unclassify` (audited) withdraws it;
 * - `POST /tagging/batches`: deterministic corrections of a run proposed as ONE batch (a proposal for the Proposals
 *   page, where the owner approves it with its own confirmation);
 * - `POST /tagging/reconciliations` (start, with a first audit), `GET /tagging/reconciliations/:id` (stale pages
 *   marked), `POST /tagging/reconciliations/:id/resume` (a fresh audit of what remains, then the next batch proposed).
 *
 * Nothing here writes to LegendKeeper: an audit is free, and every write is a proposal the owner approves.
 */
import * as z from 'zod';
import { SYSTEM_PRINCIPAL, type JobOrigin } from '../../jobs/index.js';
import { RetagError, type RetagService } from '../../packs/retag/service.js';
import { verdictView } from '../../mcp/tools/retag.js';
import { AdminHttpError } from '../http.js';
import { parseInput, projectParam, type Register, type RouteProject, projectFor } from './util.js';

const STATUS: Readonly<Record<string, number>> = {
  PACK_NOT_ATTACHED: 409,
  PACK_NOT_CURRENT: 409,
  RETAG_UNAVAILABLE: 409,
  NO_SNAPSHOT: 409,
  RUN_NOT_FOUND: 404,
  PAGE_NOT_IN_RUN: 409,
  RETAG_NOT_DETERMINISTIC: 409,
  RETAG_BATCH_TOO_LARGE: 400,
  RETAG_PAGE_IN_BATCH: 409,
  RETAG_POLICY_CHANGED: 409,
  NOT_ON_CLOSED_LIST: 400,
  REASON_REQUIRED: 400,
  NOT_OWNER: 403,
  RECONCILIATION_NOT_FOUND: 404,
  RECONCILIATION_CLOSED: 409,
  INVALID_PARAMS: 400,
  SCOPE_TOO_LARGE: 400,
  // v3 F5a (ADR 0067, H2)
  PAGE_NOT_FOUND: 404,
  TAG_NOT_ON_PAGE: 409,
  NOT_AN_EXCEPTION: 409,
  SOURCE_ELSEWHERE: 409,
  SECTION_NOT_READABLE: 409,
  SECTION_NOT_EDITABLE: 409,
  TAG_NOT_LISTABLE: 400,
  ALREADY_LISTED: 409,
};

/**
 * The owner's tagging actions (each confirmed in its dialog, `confirm: true`). v3 F12 (ADR 0081): a retag batch the
 * owner asks for runs at once as one job (no proposal to approve next).
 */
const ORIGIN = (tool: string): JobOrigin => ({
  kind: 'ui',
  client: 'owner',
  tool,
  principal: SYSTEM_PRINCIPAL,
  ownerConfirmed: true,
});

const scopeBody = {
  page: z.string().min(1).max(500).optional(),
  under: z.string().min(1).max(500).optional(),
  all: z.boolean().optional(),
};
const pageIdSchema = z.string().min(1).max(64);
const runIdSchema = z.string().regex(/^rtg_[0-9a-f]{16}$/);
const recIdSchema = z.string().regex(/^rtr_[0-9a-f]{16}$/);

export const registerTagging: Register = (api, ctx) => {
  const retag = (): RetagService => {
    const r = ctx.deps.runtime.retag;
    if (!r) throw new AdminHttpError(503, 'RETAG_UNAVAILABLE', 'The retag tools are not running.');
    return r;
  };
  const wrap = async <T>(f: () => T | Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      if (e instanceof RetagError)
        throw new AdminHttpError(STATUS[e.code] ?? 400, e.code, e.message, { details: e.details });
      const code = (e as { code?: unknown } | null)?.code;
      if (code === 'NO_SNAPSHOT') throw new AdminHttpError(409, 'NO_SNAPSHOT', (e as Error).message);
      throw e;
    }
  };
  const pageId = (p: RouteProject, ref: string): string => {
    const r = ctx.deps.runtime.registry.forProject(p.id).resolve(ref);
    if (r.status === 'resolved') return r.node.id;
    if (r.status === 'ambiguous')
      throw new AdminHttpError(409, 'AMBIGUOUS', `“${ref}” names ${r.candidates.length} pages: give its id.`);
    throw new AdminHttpError(404, 'NOT_FOUND', `No page inside the AI REPOSITORY is named “${ref}”.`);
  };
  const scopeOf = (
    p: RouteProject,
    b: { page?: string | undefined; under?: string | undefined; all?: boolean | undefined },
  ) => {
    const n = [b.page, b.under, b.all ? 'all' : undefined].filter((x) => x !== undefined).length;
    if (n !== 1)
      throw new AdminHttpError(400, 'INVALID_INPUT', 'Give exactly one of a page, a branch or everything.');
    return b.page ? { pageId: pageId(p, b.page) } : b.under ? { underId: pageId(p, b.under) } : { all: true };
  };
  const nameOf = (p: RouteProject, id: string) =>
    ctx.deps.runtime.tree.queries.node(p.id, id).data?.rawName ?? id;

  api.get('/tagging', (req) => {
    const q = parseInput(z.object({ project: projectParam }), req.query);
    const p = ctx.project(q.project);
    const r = retag();
    let policy = null;
    let unavailable: { code: string; message: string } | null = null;
    let closedList: ReturnType<RetagService['closedList']> = [];
    try {
      policy = r.policyFor(p.id).policy;
      closedList = r.closedList(p.id);
    } catch (e) {
      unavailable =
        e instanceof RetagError
          ? { code: e.code, message: e.message }
          : { code: 'UNAVAILABLE', message: String(e) };
    }
    const batches = r.store.batches(p.id, { limit: 40 });
    for (const b of batches) r.syncBatch(b);
    return {
      project: p,
      policy,
      unavailable,
      closedList,
      runs: r.store.runs(p.id, 20),
      classifications: r.store.classifications(p.id),
      reconciliations: r.store.reconciliations(p.id),
      batches: r.store.batches(p.id, { limit: 40 }),
      now: ctx.now(),
    };
  });

  api.post('/tagging/audit', async (req) => {
    const b = parseInput(z.object({ project: projectParam, ...scopeBody }).strict(), req.body);
    const p = projectFor(ctx, req, b.project);
    return wrap(async () => {
      const out = await retag().audit({ projectId: p.id, actor: 'owner', scope: scopeOf(p, b) });
      return { run: out.run };
    });
  });

  api.get('/tagging/runs/:id', (req) => {
    const { id } = parseInput(z.object({ id: runIdSchema }), req.params);
    const q = parseInput(
      z.object({
        project: projectParam,
        filter: z.enum(['correction', 'hold', 'exception', 'compliant', 'lifecycle', 'excluded']).optional(),
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
      req.query,
    );
    const p = ctx.project(q.project);
    const r = retag();
    const run = r.store.run(id);
    if (!run || run.projectId !== p.id) throw new AdminHttpError(404, 'RUN_NOT_FOUND', `No retag run ${id}.`);
    const all = r.store.verdicts(id);
    const list = q.filter
      ? all.filter((v) => (v.scope === 'grammar' ? v.disposition : v.scope) === q.filter)
      : all;
    return {
      run,
      total: list.length,
      pages: list.slice(q.offset, q.offset + q.limit).map((v) => verdictView(v, run.policy, true)),
    };
  });

  api.get('/tagging/holds', (req) => {
    const q = parseInput(z.object({ project: projectParam, run: runIdSchema.optional() }), req.query);
    const p = ctx.project(q.project);
    const r = retag();
    const run = q.run ? r.store.run(q.run) : r.store.latestRun(p.id);
    if (!run || run.projectId !== p.id) return { run: null, holds: [] };
    return {
      run,
      holds: r.store.verdicts(run.id, { disposition: 'hold' }).map((v) => ({
        ...verdictView(v, run.policy, true),
        uncertainCategory: v.holds.some((h) => h.kind === 'uncertain_category' || h.kind === 'specialist'),
        // CR-2026-11-R3 (R3-47): each page's own suggestions (not a project-wide list then filtered per page).
        suggestions: r.store.suggestions(p.id, v.pageId),
        classification: r.store.classification(p.id, v.pageId),
      })),
    };
  });

  api.post('/tagging/classify', async (req) => {
    const b = parseInput(
      z
        .object({
          project: projectParam,
          pageId: pageIdSchema,
          primary: z.string().min(1).max(100),
          specialist: z.string().min(1).max(100).nullable(),
          reason: z.string().min(1).max(1000),
          confirm: z.literal(true),
        })
        .strict(),
      req.body,
    );
    const p = projectFor(ctx, req, b.project);
    return wrap(() => {
      retag().classify('owner', p.id, {
        pageId: b.pageId,
        pageName: nameOf(p, b.pageId),
        primary: b.primary,
        specialist: b.specialist,
        reason: b.reason,
      });
      return { classification: retag().store.classification(p.id, b.pageId) };
    });
  });

  api.post('/tagging/unclassify', async (req) => {
    const b = parseInput(
      z.object({ project: projectParam, pageId: pageIdSchema, confirm: z.literal(true) }).strict(),
      req.body,
    );
    const p = projectFor(ctx, req, b.project);
    return wrap(() => ({ removed: retag().unclassify('owner', p.id, b.pageId) }));
  });

  // ---------------------------------------------------------------------------------- v3 F5a (ADR 0067, H2)

  /** The latest run's exceptions, each with the owner's rulings and the agents' suggestions, and the supplementary list. */
  api.get('/tagging/exceptions', (req) => {
    const q = parseInput(z.object({ project: projectParam, run: runIdSchema.optional() }), req.query);
    const p = ctx.project(q.project);
    const r = retag();
    let supplementary: readonly string[];
    try {
      supplementary = r.policyFor(p.id).rules.retag?.supplementary?.tags ?? [];
    } catch {
      supplementary = [];
    }
    const run = q.run ? r.store.run(q.run) : r.store.latestRun(p.id);
    if (!run || run.projectId !== p.id) return { run: null, exceptions: [], supplementary };
    return {
      run,
      supplementary,
      exceptions: r.store.verdicts(run.id, { disposition: 'exception' }).map((v) => ({
        ...verdictView(v, run.policy, true),
        rulings: r.store.rulings(p.id, v.pageId),
        suggestions: r.store.rulingSuggestions(p.id, v.pageId),
      })),
    };
  });

  /** "Keep this tag here": the owner's ruling for one page (audited `retag.keep_here`). */
  api.post('/tagging/keep-here', async (req) => {
    const b = parseInput(
      z
        .object({
          project: projectParam,
          pageId: pageIdSchema,
          tag: z.string().min(1).max(100),
          reason: z.string().min(1).max(1000),
          confirm: z.literal(true),
        })
        .strict(),
      req.body,
    );
    const p = projectFor(ctx, req, b.project);
    return wrap(async () => ({
      ruling: await retag().keepHere('owner', p.id, { pageId: b.pageId, tag: b.tag, reason: b.reason }),
    }));
  });

  /** Withdraws a "Keep this tag here" ruling: a tightening, one click (ADR 0062's rule). */
  api.post('/tagging/unkeep', async (req) => {
    const b = parseInput(
      z
        .object({
          project: projectParam,
          pageId: pageIdSchema,
          tag: z.string().min(1).max(100),
          confirm: z.literal(true),
        })
        .strict(),
      req.body,
    );
    const p = projectFor(ctx, req, b.project);
    return wrap(() => ({ removed: retag().unkeep('owner', p.id, b.pageId, b.tag) }));
  });

  /**
   * "Allow this tag everywhere": the bridge edits the Tagging Standard's Approved Supplementary Tags to add the tag, as
   * the owner's action. `dryRun` (one read) returns the paragraph before and after; the edit itself runs as one job
   * (journalled, revertible) and is audited `retag.allow_everywhere`.
   */
  api.post('/tagging/allow-everywhere', async (req) => {
    const b = parseInput(
      z
        .object({
          project: projectParam,
          tag: z.string().min(1).max(100),
          pageId: pageIdSchema.optional(),
          dryRun: z.boolean().optional(),
          confirm: z.literal(true).optional(),
        })
        .strict(),
      req.body,
    );
    if (b.dryRun !== true) {
      if (b.confirm !== true)
        throw new AdminHttpError(
          400,
          'CONFIRM_REQUIRED',
          'Confirm the edit (confirm: true), or ask for a dry run.',
        );
    }
    const p = projectFor(ctx, req, b.project);
    return wrap(async () =>
      retag().allowEverywhere('owner', p.id, {
        tag: b.tag,
        pageId: b.pageId ?? null,
        ...(b.dryRun === true ? { dryRun: true } : {}),
      }),
    );
  });

  api.post('/tagging/batches', async (req) => {
    const b = parseInput(
      z
        .object({
          project: projectParam,
          runId: runIdSchema,
          pageIds: z.array(pageIdSchema).min(1).max(100),
          confirm: z.literal(true),
        })
        .strict(),
      req.body,
    );
    const p = projectFor(ctx, req, b.project);
    return wrap(async () => {
      const r = retag();
      const plan = r.planApply({ projectId: p.id, runId: b.runId, pageIds: b.pageIds });
      const sub = await r.submitApply(plan, {
        projectId: p.id,
        origin: ORIGIN('tagging.propose_batch'),
        actor: 'owner',
      });
      return { batch: sub.batch, proposalId: sub.proposalId, jobId: sub.jobId };
    });
  });

  /**
   * v3 F5a (ADR 0067, H4): "Apply all corrections" of a run: every deterministic correction not in an open batch, in
   * the usual bounded batches (the pack's batch size, each page an item), each ONE proposal (ADR 0081: no fresh code).
   */
  api.post('/tagging/apply-all', async (req) => {
    const b = parseInput(
      z.object({ project: projectParam, runId: runIdSchema, confirm: z.literal(true) }).strict(),
      req.body,
    );
    const p = projectFor(ctx, req, b.project);
    return wrap(async () => {
      const r = retag();
      const chunks = r.correctionBatches(p.id, b.runId);
      const pages = chunks.reduce((n, c) => n + c.length, 0);
      const batches: { batchId: string; proposalId: string | null; jobId: string | null; pages: number }[] =
        [];
      for (const ids of chunks) {
        const plan = r.planApply({ projectId: p.id, runId: b.runId, pageIds: ids });
        const sub = await r.submitApply(plan, {
          projectId: p.id,
          origin: ORIGIN('tagging.apply_all'),
          actor: 'owner',
        });
        batches.push({
          batchId: sub.batch.id,
          proposalId: sub.proposalId,
          jobId: sub.jobId,
          pages: ids.length,
        });
      }
      return { pages, batches };
    });
  });

  /**
   * v3 F5a (ADR 0067, H4): "Approve all these batches": the retag batches' proposals approved together, each whole, one
   * at a time (ADR 0081: no fresh code). Only retag batch proposals of this project are taken.
   */
  api.post('/tagging/approve-batches', async (req) => {
    const b = parseInput(
      z
        .object({
          project: projectParam,
          proposalIds: z.array(z.string().min(1).max(100)).min(1).max(200),
          confirm: z.literal(true),
        })
        .strict(),
      req.body,
    );
    const p = projectFor(ctx, req, b.project);
    const r = retag();
    const notBatches = b.proposalIds.filter((id) => !r.isBatchProposal(p.id, id));
    if (notBatches.length > 0)
      throw new AdminHttpError(
        400,
        'NOT_A_RETAG_BATCH',
        `Not retag batches of this project: ${notBatches.join(', ')}. Approve other proposals on the Proposals page.`,
      );
    return { results: await ctx.actions.bulkApprove(p.id, b.proposalIds) };
  });

  api.post('/tagging/reconciliations', async (req) => {
    const b = parseInput(
      z
        .object({
          project: projectParam,
          name: z.string().min(1).max(80),
          ...scopeBody,
          confirm: z.literal(true),
        })
        .strict(),
      req.body,
    );
    const p = projectFor(ctx, req, b.project);
    return wrap(async () => {
      const scope = b.page || b.under || b.all ? scopeOf(p, b) : { all: true };
      const out = await retag().reconcile({ projectId: p.id, actor: 'owner', name: b.name, scope });
      return { reconciliation: out.reconciliation, created: out.created, run: out.result.run };
    });
  });

  api.get('/tagging/reconciliations/:id', async (req) => {
    const { id } = parseInput(z.object({ id: recIdSchema }), req.params);
    const q = parseInput(z.object({ project: projectParam }), req.query);
    const p = ctx.project(q.project);
    return wrap(() => retag().view(p.id, id));
  });

  api.post('/tagging/reconciliations/:id/resume', async (req) => {
    const { id } = parseInput(z.object({ id: recIdSchema }), req.params);
    const b = parseInput(z.object({ project: projectParam, confirm: z.literal(true) }).strict(), req.body);
    const p = projectFor(ctx, req, b.project);
    return wrap(async () => {
      const out = await retag().resume({
        projectId: p.id,
        reconciliationId: id,
        actor: 'owner',
        origin: ORIGIN('tagging.resume'),
      });
      return {
        status: out.status,
        view: out.view,
        run: out.audit?.run ?? null,
        batch: out.batch ? { ...out.batch.batch, proposalId: out.batch.proposalId } : null,
      };
    });
  });
};
