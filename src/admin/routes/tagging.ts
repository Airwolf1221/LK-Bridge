/**
 * The Tagging page's API (v3 F3f, ADR 0060; docs/dashboard.md › Tagging), in the Repository group: the retag audit, the
 * holds with the owner's classification, the apply batches and the reconciliations.
 *
 * - `GET /tagging`: the policy (the approved pack version and its digest) or why the retag is unavailable, the latest
 *   runs, the owner's classifications, the reconciliations, the batches and the closed list;
 * - `POST /tagging/audit`: an audit of a page, a branch or everything (free: the snapshots);
 * - `GET /tagging/runs/:id`: a stored run's pages (filtered, paged);
 * - `GET /tagging/holds`: the latest run's holds, each with the agents' suggestions and the owner's classification;
 * - `POST /tagging/classify` (re-authenticated; audited `retag.classify`): the owner's classification of a page from the
 *   closed list, used by every later audit; `POST /tagging/unclassify` (re-authenticated; audited) withdraws it;
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
import { DEFAULT_WRITE_RAILS } from '../../policy/rails.js';
import { verdictView } from '../../mcp/tools/retag.js';
import { requireReauth } from '../guard.js';
import { AdminHttpError } from '../http.js';
import { parseInput, projectParam, type Register, type RouteProject } from './util.js';

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
};

const ORIGIN = (tool: string): JobOrigin => ({
  kind: 'ui',
  client: 'owner',
  tool,
  principal: SYSTEM_PRINCIPAL,
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
    const p = ctx.project(b.project);
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
    requireReauth(ctx.deps.services, req);
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
    const p = ctx.project(b.project);
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
    requireReauth(ctx.deps.services, req);
    const b = parseInput(
      z.object({ project: projectParam, pageId: pageIdSchema, confirm: z.literal(true) }).strict(),
      req.body,
    );
    const p = ctx.project(b.project);
    return wrap(() => ({ removed: retag().unclassify('owner', p.id, b.pageId) }));
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
    const p = ctx.project(b.project);
    // ADR 0062: the owner's own change of more than 10 pages at once (the bulk rail's size) needs the step-up.
    if (b.pageIds.length > DEFAULT_WRITE_RAILS.bulkPages) requireReauth(ctx.deps.services, req);
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
    const p = ctx.project(b.project);
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
    // ADR 0062: the next batch may hold up to the pack's batch size: a bulk change, so the step-up first.
    requireReauth(ctx.deps.services, req);
    const p = ctx.project(b.project);
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
