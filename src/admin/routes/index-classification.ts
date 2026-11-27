/**
 * The Index Classification page's API (v3 F6b, ADR 0079; design T12 step 1; docs/dashboard.md › Index Classification),
 * in the Repository group next to Reference Types: every current index with the role the rules propose, the rule that
 * decided it, and the owner's decisions.
 *
 * - `GET /index-classification`: the report (filtered, paged), the counts, the pack's rules (whether T11's order is in
 *   force, the tag section's state), the structural lists, and the ids "Approve all as proposed" offers in the filter;
 * - `POST /index-classification/decide` (audited `indexclassify.decide`): approve (as proposed), change (to
 *   nav or subject, with the subject's kind), or leave undecided;
 * - `POST /index-classification/bulk-approve` (audited `indexclassify.bulk_approve`): the rows named by
 *   `ids` (the page sends the proposed rows of its filter), or every proposed row of the filter; ONE transaction, at
 *   most INDEX_CLASSIFY_BULK_MAX rows, idempotent; it returns the rows it changed, not a report;
 * - `PUT /index-classification/structural`: the pack's exact-name lists edited: a NEW pack version the
 *   owner approves on the Packs page (audited by the pack, `pack.replace_rules`).
 *
 * Every route awaits the service's `prepare` first (the cached base brought up to date in chunks that yield), so no
 * request does work proportional to every page synchronously (F6a.1, F11).
 */
import * as z from 'zod';
import { IndexClassifyError, ROW_STATUSES, type IndexClassifyService } from '../../packs/indextax/service.js';
import { SUBJECT_KINDS } from '../../packs/indextax/rules.js';
import { AdminHttpError } from '../http.js';
import { parseInput, projectFor, projectParam, type Register } from './util.js';

const STATUS: Readonly<Record<string, number>> = {
  NO_INDEX_TAXONOMY: 409,
  NOT_OWNER: 403,
  NOT_AN_INDEX: 404,
  OUT_OF_SCOPE: 409,
  NOTHING_PROPOSED: 409,
  ROLE_REQUIRED: 400,
  INVALID_SUBJECT: 400,
  INVALID_LISTS: 400,
  BULK_TOO_LARGE: 413,
};

const filterShape = {
  status: z.union([z.enum(ROW_STATUSES), z.array(z.enum(ROW_STATUSES)).max(6)]).optional(),
  proposed: z.enum(['nav', 'subject', 'undecided']).optional(),
  rule: z.string().min(1).max(60).optional(),
  under: z.string().min(1).max(500).optional(),
  name: z.string().min(1).max(200).optional(),
};

const list = z.array(z.string().min(1).max(200)).max(200);

export const registerIndexClassification: Register = (api, ctx) => {
  const svc = (): IndexClassifyService => {
    const r = ctx.deps.runtime.indexClassify;
    if (!r) throw new AdminHttpError(503, 'UNAVAILABLE', 'The index classification service is not running.');
    return r;
  };
  const wrap = async <T>(f: () => T | Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      if (e instanceof IndexClassifyError)
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
      status?: string | string[] | undefined;
      proposed?: 'nav' | 'subject' | 'undecided' | undefined;
      rule?: string | undefined;
      under?: string | undefined;
      name?: string | undefined;
    },
  ) => {
    const u = underId(projectId, f.under);
    return {
      ...(f.status !== undefined
        ? { status: (Array.isArray(f.status) ? f.status : [f.status]) as (typeof ROW_STATUSES)[number][] }
        : {}),
      ...(f.proposed !== undefined ? { proposed: f.proposed } : {}),
      ...(f.rule !== undefined ? { rule: f.rule } : {}),
      ...(f.name !== undefined ? { nameContains: f.name } : {}),
      ...(u ? { underId: u } : {}),
    };
  };

  api.get('/index-classification', (req) => {
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
      return {
        project: p,
        report,
        approvable: s.approvable(p.id, filter),
        bulkMax: s.bulkMax(),
        subjects: SUBJECT_KINDS,
        now: ctx.now(),
      };
    });
  });

  api.post('/index-classification/decide', async (req) => {
    const b = parseInput(
      z
        .object({
          project: projectParam,
          pageId: z.string().min(1).max(64),
          action: z.enum(['approve', 'change', 'undecided']),
          role: z.enum(['nav', 'subject']).optional(),
          subject: z.enum(SUBJECT_KINDS).nullable().optional(),
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
      return s.decide('owner', p.id, {
        pageId: b.pageId,
        action: b.action,
        ...(b.role !== undefined ? { role: b.role } : {}),
        ...(b.subject !== undefined ? { subject: b.subject } : {}),
        ...(b.reason !== undefined ? { reason: b.reason } : {}),
      });
    });
  });

  api.post('/index-classification/bulk-approve', async (req) => {
    const b = parseInput(
      z
        .object({
          project: projectParam,
          ...filterShape,
          // The service bounds them by INDEX_CLASSIFY_BULK_MAX (BULK_TOO_LARGE); this is only the request's own limit.
          ids: z.array(z.string().min(1).max(64)).max(5000).optional(),
          confirm: z.literal(true),
        })
        .strict(),
      req.body,
    );
    const p = projectFor(ctx, req, b.project);
    return wrap(async () => {
      const s = svc();
      await s.prepare(p.id);
      const r = s.bulkApprove('owner', p.id, { ...filterOf(p.id, b), ...(b.ids ? { ids: b.ids } : {}) });
      return {
        approved: r.approved.length,
        skipped: r.skipped.length,
        remaining: r.remaining,
        max: r.max,
        decisions: r.approved,
        rows: r.rows,
        skippedRows: r.skipped,
      };
    });
  });

  api.put('/index-classification/structural', async (req) => {
    const b = parseInput(
      z
        .object({
          project: projectParam,
          structural: z
            .object({
              topLevel: list.optional(),
              named: list.optional(),
              continentCategories: list.optional(),
              continentParents: list.optional(),
              realmshipParents: list.optional(),
              settingFramework: z.string().min(1).max(200).optional(),
              settingFrameworkCategories: list.optional(),
              divineRealms: z.string().min(1).max(200).optional(),
              divineRealmCategories: list.optional(),
              nationSubindexes: list.optional(),
              cultureCategories: list.optional(),
              religionCategories: list.optional(),
            })
            .strict()
            .optional(),
          outOfScope: list.optional(),
          confirm: z.literal(true),
        })
        .strict(),
      req.body,
    );
    const p = projectFor(ctx, req, b.project);
    return wrap(() => {
      const r = svc().setStructural('owner', p.id, {
        ...(b.structural ? { structural: b.structural } : {}),
        ...(b.outOfScope ? { outOfScope: b.outOfScope } : {}),
      });
      return { changed: r.changed, pack: { id: r.pack.id, version: r.pack.version } };
    });
  });
};
