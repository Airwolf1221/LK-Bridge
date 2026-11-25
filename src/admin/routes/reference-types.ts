/**
 * The Reference Types page's API (v3 F6a, ADR 0076; docs/dashboard.md › Reference Types), in the Repository group next
 * to Repository Mappings: the report of every Reference Type value in use, the owner's decisions and the vocabulary's
 * publication to governance.
 *
 * - `GET /reference-types`: the report (filtered, paged), the vocabulary in force with its status, the conflicts with a
 *   published section, the decisions not published yet, the latest publications;
 * - `POST /reference-types/decide` (the step-up; audited `reftypes.decide`): accept, edit (another canonical value, or a
 *   new one with its role word), reject, keep as specialist (the pages listed, or any page in the category);
 * - `POST /reference-types/bulk-accept` (the step-up): v3 F6a.1 (ADR 0076 amendment 1): the rows named by `ids` (the
 *   page sends the confident rows it offers), or every confident suggestion of the open rows a filter matches; ONE
 *   transaction, at most REFTYPE_BULK_MAX rows, idempotent; it returns the rows it changed, not a report;
 * - `POST /reference-types/undo` (the step-up; audited `reftypes.undo`): a decision not applied and not published;
 * - `POST /reference-types/publish`: `dryRun` (one read, no step-up) returns the section's exact text and the
 *   confirmation; otherwise the step-up, ONE job of the bridge's, audited `reftypes.publish`.
 *
 * v3 F6a.1: every route awaits the service's `prepare` first, which brings the report's cached base up to date in chunks
 * that yield to the event loop; a reload while nothing changed rebuilds nothing, and a decision never rebuilds the report.
 */
import * as z from 'zod';
import { ReferenceTypeError, STATUSES, type ReferenceTypeService } from '../../packs/reftypes/service.js';
import { requireReauth } from '../guard.js';
import { AdminHttpError } from '../http.js';
import { parseInput, projectFor, projectParam, type Register } from './util.js';

const STATUS: Readonly<Record<string, number>> = {
  NO_VOCABULARY: 409,
  NOT_OWNER: 403,
  VALUE_NOT_IN_USE: 404,
  ALREADY_DECIDED: 409,
  ALREADY_CANONICAL: 409,
  NO_CONFIDENT_SUGGESTION: 409,
  TARGET_REQUIRED: 400,
  TARGET_IS_VALUE: 400,
  TARGET_OTHER_CATEGORY: 409,
  ROLE_REQUIRED: 400,
  CATEGORY_REQUIRED: 409,
  NAME_NOT_WRITABLE: 400,
  DECISION_NOT_FOUND: 404,
  DECISION_APPLIED: 409,
  DECISION_PUBLISHED: 409,
  SOURCE_ELSEWHERE: 409,
  SOURCE_UNREADABLE: 502,
  SECTION_AMBIGUOUS: 409,
  SECTION_PARENT_MISSING: 409,
  BULK_TOO_LARGE: 413,
};

const filterShape = {
  category: z.string().min(1).max(100).optional(),
  status: z.union([z.enum(STATUSES), z.array(z.enum(STATUSES)).max(5)]).optional(),
  minCount: z.coerce.number().int().min(1).max(100_000).optional(),
  under: z.string().min(1).max(500).optional(),
  /** v3 F6a.1: the page's "Value contains" (server side, so paging holds). */
  value: z.string().min(1).max(200).optional(),
};

export const registerReferenceTypes: Register = (api, ctx) => {
  const svc = (): ReferenceTypeService => {
    const r = ctx.deps.runtime.referenceTypes;
    if (!r) throw new AdminHttpError(503, 'UNAVAILABLE', 'The Reference Type service is not running.');
    return r;
  };
  const wrap = async <T>(f: () => T | Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      if (e instanceof ReferenceTypeError)
        throw new AdminHttpError(STATUS[e.code] ?? 400, e.code, e.message, { details: e.details });
      throw e;
    }
  };
  const underId = (projectId: string, ref: string | undefined): string | undefined => {
    if (ref === undefined) return undefined;
    const r = ctx.deps.runtime.registry.forProject(projectId).resolve(ref);
    if (r.status === 'resolved') return r.node.id;
    if (r.status === 'ambiguous')
      throw new AdminHttpError(409, 'AMBIGUOUS', `“${ref}” names ${r.candidates.length} pages: give its id.`);
    throw new AdminHttpError(404, 'NOT_FOUND', `No page inside the AI REPOSITORY is named “${ref}”.`);
  };
  const filterOf = (
    projectId: string,
    f: {
      category?: string | undefined;
      status?: string | string[] | undefined;
      minCount?: number | undefined;
      under?: string | undefined;
      value?: string | undefined;
    },
  ) => {
    const u = underId(projectId, f.under);
    return {
      ...(f.category !== undefined ? { category: f.category } : {}),
      ...(f.status !== undefined
        ? { status: (Array.isArray(f.status) ? f.status : [f.status]) as (typeof STATUSES)[number][] }
        : {}),
      ...(f.minCount !== undefined ? { minCount: f.minCount } : {}),
      ...(f.value !== undefined ? { valueContains: f.value } : {}),
      ...(u ? { underId: u } : {}),
    };
  };

  api.get('/reference-types', (req) => {
    const q = parseInput(
      z.object({
        project: projectParam,
        ...filterShape,
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
      req.query,
    );
    const p = ctx.project(q.project);
    return wrap(async () => {
      const s = svc();
      await s.prepare(p.id);
      const filter = filterOf(p.id, q);
      const report = s.report(p.id, filter, { offset: q.offset, limit: q.limit });
      const confident = s.confident(p.id, filter);
      const eff = s.effective(p.id);
      const decisions = s.store.decisions(p.id);
      return {
        project: p,
        report,
        vocabulary: {
          status: eff.status,
          approved: eff.approved,
          rule: eff.lists.rule,
          categories: eff.lists.categories,
          specialist: eff.lists.specialist,
          pending: eff.pending,
        },
        conflicts: decisions
          .filter((d) => eff.conflicts.has(d.id))
          .map((d) => ({ decision: d, reason: eff.conflicts.get(d.id)! })),
        decisions,
        publications: s.store.publications(p.id, 10),
        // v3 F6a.1: what "Accept all confident suggestions" offers in this filter (every page of it), and its bound.
        confident,
        bulkMax: s.bulkMax(),
        now: ctx.now(),
      };
    });
  });

  api.post('/reference-types/decide', async (req) => {
    requireReauth(ctx.deps.services, req);
    const b = parseInput(
      z
        .object({
          project: projectParam,
          value: z.string().min(1).max(500),
          category: z.string().max(100),
          action: z.enum(['accept', 'edit', 'reject', 'specialist']),
          target: z.string().min(1).max(200).optional(),
          role: z.string().min(1).max(200).optional(),
          scope: z.enum(['pages', 'category']).optional(),
          reason: z.string().max(1000).optional(),
          confirm: z.literal(true),
        })
        .strict(),
      req.body,
    );
    const p = projectFor(ctx, req, b.project);
    return wrap(async () => {
      const s = svc();
      await s.prepare(p.id);
      const decision = s.decide('owner', p.id, {
        value: b.value,
        category: b.category,
        action: b.action,
        ...(b.target !== undefined ? { target: b.target } : {}),
        ...(b.role !== undefined ? { role: b.role } : {}),
        ...(b.scope !== undefined ? { scope: b.scope } : {}),
        ...(b.reason !== undefined ? { reason: b.reason } : {}),
      });
      // The row as it now stands (from the cached base), not a report.
      return { decision, row: s.rowAfter(p.id, decision) };
    });
  });

  api.post('/reference-types/bulk-accept', async (req) => {
    requireReauth(ctx.deps.services, req);
    const b = parseInput(
      z
        .object({
          project: projectParam,
          ...filterShape,
          // The service bounds them by REFTYPE_BULK_MAX (BULK_TOO_LARGE); this is only the request's own limit.
          ids: z
            .array(z.string().regex(/^rtr_[0-9a-f]{16}$/))
            .max(5000)
            .optional(),
          confirm: z.literal(true),
        })
        .strict(),
      req.body,
    );
    const p = projectFor(ctx, req, b.project);
    return wrap(async () => {
      const s = svc();
      await s.prepare(p.id);
      const r = s.bulkAccept('owner', p.id, { ...filterOf(p.id, b), ...(b.ids ? { ids: b.ids } : {}) });
      return {
        accepted: r.accepted.length,
        skipped: r.skipped.length,
        remaining: r.remaining,
        max: r.max,
        decisions: r.accepted,
        rows: r.rows,
        skippedRows: r.skipped,
      };
    });
  });

  api.post('/reference-types/undo', async (req) => {
    requireReauth(ctx.deps.services, req);
    const b = parseInput(
      z
        .object({
          project: projectParam,
          id: z.string().regex(/^rtd_[0-9a-f]{16}$/),
          confirm: z.literal(true),
        })
        .strict(),
      req.body,
    );
    const p = projectFor(ctx, req, b.project);
    return wrap(() => ({ undone: svc().undo('owner', p.id, b.id) }));
  });

  api.post('/reference-types/publish', async (req) => {
    const b = parseInput(
      z
        .object({
          project: projectParam,
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
          'Confirm the publication (confirm: true), or ask for a preview.',
        );
      requireReauth(ctx.deps.services, req);
    }
    const p = projectFor(ctx, req, b.project);
    return wrap(() => svc().publish('owner', p.id, b.dryRun === true ? { dryRun: true } : {}));
  });
};
