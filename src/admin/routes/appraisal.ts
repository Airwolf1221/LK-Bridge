/**
 * The Appraisal page's API (v3 F3c, ADR 0054; the design's decision D4; docs/dashboard.md): the Arkona pack's four
 * read-only appraisal tools run from the dashboard, their stored reports, and "Propose a fix".
 *
 * - `GET /appraisal`: the full-text index (its snapshots, freshness, size and timings), the non-current areas, the latest
 *   stored runs;
 * - `POST /appraisal/run`: runs A2 (`owner`), A3 (`impact`), A4 (`digest`) or A5 (`visual`) on a page or a branch (a name,
 *   a path or an id) and stores the report; nothing is read from LegendKeeper and nothing is written anywhere but the
 *   bridge's own database;
 * - `GET /appraisal/runs/:id`: a stored report;
 * - `POST /appraisal/findings/:id/propose-fix`: the finding's target re-read live (one read), then ONE ordinary proposal
 *   for the owner to approve on the Proposals page; audited (`appraisal.propose_fix`);
 * - `POST /appraisal/index/rebuild`: the index built again from the snapshot store (free).
 */
import * as z from 'zod';
import { AppraisalError, NON_CURRENT_AREAS, type Appraisal } from '../../appraisal/index.js';
import { AuditError } from '../../audits/index.js';
import { SYSTEM_PRINCIPAL } from '../../jobs/index.js';
import { RegistryError } from '../../registry/index.js';
import { nameKey } from '../../tree/classify.js';
import { AdminHttpError } from '../http.js';
import { parseInput, projectParam, type Register, type RouteProject, projectFor } from './util.js';

const STATUS: Readonly<Record<string, number>> = {
  PACK_NOT_ATTACHED: 409,
  NO_SNAPSHOT: 409,
  FINDING_NOT_FOUND: 404,
  NO_FIX: 409,
  FIX_STALE: 409,
  FIX_NOT_APPLICABLE: 409,
  NOT_PROPOSED: 502,
  PROPOSAL_NOT_FOUND: 404,
  PROPOSAL_NOT_PENDING: 409,
  LIVE_TOO_MANY: 400,
  INVALID_INPUT: 400,
  READ_DELAYED: 503,
  NOT_FOUND: 404,
  FINDING_GONE: 409,
};

const runBody = z.object({
  confirm: z.literal(true),
  project: projectParam,
  tool: z.enum(['owner', 'impact', 'digest', 'visual', 'split']),
  page: z.string().min(1).max(500).optional(),
  under: z.string().min(1).max(500).optional(),
  all: z.boolean().optional(),
  include: z
    .array(z.enum(['legacy', 'design', 'archived']))
    .max(3)
    .optional(),
  renameTo: z.string().min(1).max(500).optional(),
  proposal: z
    .string()
    .regex(/^prop_[a-z0-9]+$/)
    .optional(),
  sinceDays: z.number().min(0).max(3650).optional(),
});

export const registerAppraisal: Register = (api, ctx) => {
  const appraisal = (): Appraisal => {
    const a = ctx.deps.runtime.appraisal;
    if (!a) throw new AdminHttpError(503, 'APPRAISAL_UNAVAILABLE', 'The appraisal is not running.');
    return a;
  };
  const wrap = async <T>(f: () => T | Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      if (e instanceof AppraisalError || e instanceof AuditError)
        throw new AdminHttpError(STATUS[e.code] ?? 400, e.code, e.message, { details: e.details });
      if (e instanceof RegistryError)
        throw new AdminHttpError(400, e.code, e.message, { details: e.details });
      throw e;
    }
  };
  /** A page by its name, path or id, as the tools resolve it (an ambiguity lists the candidates). */
  const pageId = (p: RouteProject, ref: string): string => {
    const r = ctx.deps.runtime.registry.forProject(p.id).resolve(ref);
    if (r.status === 'resolved') return r.node.id;
    if (r.status === 'ambiguous')
      throw new AdminHttpError(
        409,
        'AMBIGUOUS',
        `“${ref}” names ${r.candidates.length} pages: give its id.`,
        {
          details: {
            candidates: r.candidates.map((c) => ({
              id: c.id,
              name: c.displayName,
              path: c.path,
            })),
          },
        },
      );
    throw new AdminHttpError(404, 'NOT_FOUND', `No page inside the AI REPOSITORY is named “${ref}”.`);
  };

  /** The index, the non-current areas found and the latest runs. */
  api.get('/appraisal', (req) => {
    const q = parseInput(z.object({ project: projectParam }), req.query);
    const p = ctx.project(q.project);
    const a = appraisal();
    const st = a.index.state(p.id);
    const pages = a.index.pages(p.id);
    const areas = NON_CURRENT_AREAS.map((area) => ({
      key: area.key,
      label: area.label,
      found: [...pages.values()]
        .filter((x) => x.kind === 'index' && area.names.some((n) => nameKey(n) === nameKey(x.displayName)))
        .map((x) => ({ id: x.id, name: x.rawName })),
    }));
    const pack = ctx.deps.runtime.packs?.get('arkona') ?? null;
    return {
      project: p,
      attached: !!pack && !!ctx.deps.runtime.packs?.attachment('arkona', p.id),
      index: st
        ? {
            ...st,
            freshness: a.freshness(p.id, st),
          }
        : null,
      areas,
      runs: a.store.runs(p.id, { limit: 40 }),
      now: ctx.now(),
    };
  });

  /** Runs one appraisal tool (free: the snapshots, the audits, the bridge's own database) and stores its report. */
  api.post('/appraisal/run', async (req) => {
    const b = parseInput(runBody, req.body);
    const p = projectFor(ctx, req, b.project);
    const a = appraisal();
    return wrap(async () => {
      const page = b.page ? pageId(p, b.page) : undefined;
      const under = b.under ? pageId(p, b.under) : undefined;
      if (b.tool === 'owner' || b.tool === 'visual') {
        if (b.tool === 'owner' && [page, under, b.all ? 'all' : undefined].filter(Boolean).length !== 1)
          throw new AdminHttpError(
            400,
            'INVALID_INPUT',
            'Give exactly one of a page, a branch or everything.',
          );
        const scope = {
          ...(page ? { pageId: page } : {}),
          ...(under ? { underId: under } : {}),
          ...(b.all || (!page && !under) ? { all: true } : {}),
          ...(b.include ? { include: b.include } : {}),
        };
        const report =
          b.tool === 'owner'
            ? await a.appraiseOwner({ projectId: p.id, actor: 'owner', scope })
            : await a.visualHygiene({ projectId: p.id, actor: 'owner', scope });
        return { report };
      }
      // v3 F3e (ADR 0059): the split appraisal (A6) of a page or a branch.
      if (b.tool === 'split') {
        if ([page, under].filter(Boolean).length !== 1)
          throw new AdminHttpError(400, 'INVALID_INPUT', 'Give exactly one of a page or a branch.');
        const report = await a.splitAppraisal({
          projectId: p.id,
          actor: 'owner',
          scope: {
            ...(page ? { pageId: page } : {}),
            ...(under ? { underId: under } : {}),
            ...(b.include ? { include: b.include } : {}),
          },
        });
        return { report };
      }
      if (b.tool === 'impact') {
        if (!page && !b.proposal)
          throw new AdminHttpError(
            400,
            'INVALID_INPUT',
            'Give a page (and renameTo for a rename) or a proposal.',
          );
        const report = await a.changeImpact({
          projectId: p.id,
          actor: 'owner',
          ...(page ? { pageId: page } : {}),
          ...(b.renameTo ? { renameTo: b.renameTo } : {}),
          ...(b.proposal ? { proposalId: b.proposal } : {}),
        });
        return { report };
      }
      const report = await a.workingDigest({
        projectId: p.id,
        actor: 'owner',
        sinceMs: b.sinceDays !== undefined ? b.sinceDays * 86_400_000 : null,
      });
      return { report };
    });
  });

  /** A stored report. */
  api.get('/appraisal/runs/:id', (req) => {
    const { id } = parseInput(z.object({ id: z.string().regex(/^apr_[0-9a-f]{16}$/) }), req.params);
    const q = parseInput(z.object({ project: projectParam }), req.query);
    const p = ctx.project(q.project);
    const report = appraisal().store.report(p.id, id);
    if (!report)
      throw new AdminHttpError(
        404,
        'NOT_FOUND',
        `No stored run ${id} (only the latest of each scope is kept).`,
      );
    return { report };
  });

  /** "Propose a fix": one live re-read, then ONE ordinary proposal for the owner. Audited. */
  api.post('/appraisal/findings/:id/propose-fix', async (req) => {
    const { id } = parseInput(z.object({ id: z.string().regex(/^af_[0-9a-f]{20}$/) }), req.params);
    const b = parseInput(z.object({ confirm: z.literal(true), project: projectParam }), req.body);
    const p = projectFor(ctx, req, b.project);
    const engine = ctx.deps.runtime.engine;
    return wrap(() =>
      appraisal().proposeFix({
        projectId: p.id,
        findingId: id,
        actor: 'owner',
        origin: { kind: 'ui', client: 'owner', tool: 'appraisal.propose_fix', principal: SYSTEM_PRINCIPAL },
        read: (op, params) => engine.internalRead(p.id, op, params, { priority: 'P1' }),
      }),
    );
  });

  /** The index built again from the snapshot store (free). */
  api.post('/appraisal/index/rebuild', async (req) => {
    const b = parseInput(z.object({ confirm: z.literal(true), project: projectParam }), req.body);
    const p = projectFor(ctx, req, b.project);
    const a = appraisal();
    const out = await a.ensureIndex(p.id, { rebuild: true });
    return {
      index: out.state ? { ...out.state, freshness: a.freshness(p.id, out.state) } : null,
      reason: out.reason ?? null,
    };
  });
};
