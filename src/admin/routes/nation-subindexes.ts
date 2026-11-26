/**
 * v3 F6c (ADR 0080; docs/dashboard.md › Nation Subindexes, › Repository Mappings › Territories and nations):
 *
 * - `GET /nation-subindexes`: the report (filtered, paged), the counts, the nations, the roles and variants;
 * - `POST /nation-subindexes/decide` (the step-up; audited `nationsubindex.decide`): accept, map to a role, keep as a
 *   specialist subindex, or not a subindex;
 * - `POST /nation-subindexes/map-all` (the step-up; audited `nationsubindex.map_all`): the mapping for every nation's
 *   child of that exact name, ONE transaction, at most NATION_SUBINDEX_BULK_MAX rows;
 * - `POST /nation-subindexes/undo` (the step-up; audited `nationsubindex.undo`): until the rename is applied;
 * - `GET /registry/structural`: the five structural types' state; `GET /registry/structural/:kind`: one type's entries
 *   and role bindings; `POST /registry/structural/:kind/seed` and `/add-missing` (the step-up; audited);
 * - `POST /audits/findings/:id/keep-home` (the step-up; audited `audits.keep_home`): "Keep it here" for a
 *   `category_home_mismatch` page, until its tags or parent change.
 *
 * Every report route awaits `prepare` first (the cached bases brought up to date in chunks that yield), so no request
 * does work proportional to every page synchronously (F6a.1, F11).
 */
import * as z from 'zod';
import {
  NationTaxonomyError,
  SUBINDEX_STATUSES,
  type NationTaxonomyService,
} from '../../packs/nations/service.js';
import { TAXONOMY_KINDS } from '../../registry/types.js';
import { requireReauth } from '../guard.js';
import { AdminHttpError } from '../http.js';
import { parseInput, projectFor, projectParam, type Register } from './util.js';

const STATUS: Readonly<Record<string, number>> = {
  NO_NATION_ROLES: 409,
  NOT_OWNER: 403,
  NOT_A_CANDIDATE: 404,
  NOTHING_MATCHED: 409,
  ROLE_UNKNOWN: 400,
  BULK_TOO_LARGE: 413,
  DECISION_NOT_FOUND: 404,
  DECISION_APPLIED: 409,
  REASON_REQUIRED: 400,
};

export const registerNationSubindexes: Register = (api, ctx) => {
  const svc = (): NationTaxonomyService => {
    const r = ctx.deps.runtime.nationTaxonomy;
    if (!r) throw new AdminHttpError(503, 'UNAVAILABLE', 'The territory and nation service is not running.');
    return r;
  };
  const wrap = async <T>(f: () => T | Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      if (e instanceof NationTaxonomyError)
        throw new AdminHttpError(STATUS[e.code] ?? 400, e.code, e.message, { details: e.details });
      throw e;
    }
  };

  api.get('/nation-subindexes', (req) => {
    const q = parseInput(
      z.object({
        project: projectParam,
        status: z.union([z.enum(SUBINDEX_STATUSES), z.array(z.enum(SUBINDEX_STATUSES)).max(6)]).optional(),
        nation: z.string().min(1).max(64).optional(),
        role: z.string().min(1).max(100).optional(),
        name: z.string().min(1).max(200).optional(),
        collision: z.enum(['true', 'false']).optional(),
        page: z.string().min(1).max(64).optional(),
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
      req.query,
    );
    const p = ctx.project(q.project);
    return wrap(async () => {
      const s = svc();
      await s.prepare(p.id);
      const report = s.report(
        p.id,
        {
          ...(q.status !== undefined ? { status: Array.isArray(q.status) ? q.status : [q.status] } : {}),
          ...(q.nation !== undefined ? { nationId: q.nation } : {}),
          ...(q.role !== undefined ? { role: q.role } : {}),
          ...(q.name !== undefined ? { nameContains: q.name } : {}),
          ...(q.collision !== undefined ? { collision: q.collision === 'true' } : {}),
        },
        { offset: q.offset, limit: q.limit },
      );
      return {
        project: p,
        report,
        ...(q.page ? { focus: s.row(p.id, q.page) } : {}),
        bulkMax: s.bulkMax(),
        now: ctx.now(),
      };
    });
  });

  api.post('/nation-subindexes/decide', async (req) => {
    requireReauth(ctx.deps.services, req);
    const b = parseInput(
      z
        .object({
          project: projectParam,
          pageId: z.string().min(1).max(64),
          action: z.enum(['accept', 'map', 'specialist', 'not_subindex']),
          role: z.string().min(1).max(100).optional(),
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
        ...(b.reason !== undefined ? { reason: b.reason } : {}),
      });
    });
  });

  api.post('/nation-subindexes/map-all', async (req) => {
    requireReauth(ctx.deps.services, req);
    const b = parseInput(
      z
        .object({
          project: projectParam,
          pageId: z.string().min(1).max(64),
          role: z.string().min(1).max(100),
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
      const r = s.mapAll('owner', p.id, {
        pageId: b.pageId,
        role: b.role,
        ...(b.reason !== undefined ? { reason: b.reason } : {}),
      });
      return {
        mapped: r.decisions.length,
        skipped: r.skipped,
        max: r.max,
        decisions: r.decisions,
        rows: r.rows,
      };
    });
  });

  api.post('/nation-subindexes/undo', async (req) => {
    requireReauth(ctx.deps.services, req);
    const b = parseInput(
      z
        .object({ project: projectParam, pageId: z.string().min(1).max(64), confirm: z.literal(true) })
        .strict(),
      req.body,
    );
    const p = projectFor(ctx, req, b.project);
    return wrap(async () => {
      const s = svc();
      await s.prepare(p.id);
      const undone = s.undo('owner', p.id, b.pageId);
      return { undone, row: s.row(p.id, b.pageId) };
    });
  });

  // ------------------------------------------------------------------------------------- the structural types

  api.get('/registry/structural', (req) => {
    const q = parseInput(z.object({ project: projectParam }).loose(), req.query);
    const p = ctx.project(q.project);
    return wrap(async () => {
      const s = svc();
      await ctx.deps.runtime.indexClassify?.prepare(p.id).catch(() => undefined);
      return {
        project: p,
        types: s.typeStatus(p.id),
        rules: s.rulesFor(p.id) ? { approved: s.rulesFor(p.id)!.approved } : null,
      };
    });
  });

  api.get('/registry/structural/:kind', (req) => {
    const { kind } = parseInput(z.object({ kind: z.enum(TAXONOMY_KINDS) }), req.params);
    const q = parseInput(z.object({ project: projectParam }).loose(), req.query);
    const p = ctx.project(q.project);
    const store = ctx.deps.runtime.registry.forProject(p.id).store;
    const type = store.typeByKind(kind);
    if (!type) return { kind, type: null, entries: [] };
    const tree = ctx.deps.runtime.tree.queries;
    return {
      kind,
      type: { id: type.id, singular: type.singular, plural: type.plural, seededAt: type.taxonomySeededAt },
      entries: store.entries(type.id).map((e) => {
        const n = tree.node(p.id, e.sourceNodeId).data;
        return {
          ...e,
          source: n ? { id: n.id, name: n.rawName, path: n.path.names.join(' / ') } : null,
          bindings: store.bindings(e.id).map((b) => {
            const bn = tree.node(p.id, b.nodeId).data;
            return { ...b, node: bn ? { id: bn.id, name: bn.rawName } : null };
          }),
        };
      }),
    };
  });

  for (const mode of ['seed', 'add-missing'] as const)
    api.post(`/registry/structural/:kind/${mode}`, async (req) => {
      requireReauth(ctx.deps.services, req);
      const { kind } = parseInput(z.object({ kind: z.enum(TAXONOMY_KINDS) }), req.params);
      const b = parseInput(z.object({ project: projectParam, confirm: z.literal(true) }).strict(), req.body);
      const p = projectFor(ctx, req, b.project);
      return wrap(async () => {
        await ctx.deps.runtime.indexClassify?.prepare(p.id).catch(() => undefined);
        return { result: svc().seed('owner', p.id, kind, mode === 'seed' ? 'seed' : 'add_missing') };
      });
    });

  // ------------------------------------------------------------------------------------- keep it here

  api.post('/audits/findings/:id/keep-home', async (req) => {
    requireReauth(ctx.deps.services, req);
    const { id } = parseInput(z.object({ id: z.coerce.number().int().min(1) }), req.params);
    const b = parseInput(
      z
        .object({
          project: projectParam,
          reason: z.string().trim().min(1).max(1000),
          confirm: z.literal(true),
        })
        .strict(),
      req.body,
    );
    const p = projectFor(ctx, req, b.project);
    const audits = ctx.deps.runtime.audits;
    if (!audits) throw new AdminHttpError(503, 'UNAVAILABLE', 'The audits are not running.');
    const f = audits.store.get(p.id, id);
    if (!f) throw new AdminHttpError(404, 'NOT_FOUND', `No finding ${id}.`);
    if (f.code !== 'category_home_mismatch' || !f.pageId)
      throw new AdminHttpError(
        409,
        'NOT_KEEPABLE',
        'Only a source outside its category’s homes (category_home_mismatch) can be kept where it is.',
      );
    const ev = f.evidence as { tags?: unknown; home?: { id?: unknown } };
    const pageId = f.pageId;
    return wrap(() => {
      const ruling = svc().keepHome('owner', p.id, {
        pageId,
        pageName: f.pageName ?? pageId,
        tags: Array.isArray(ev.tags) ? ev.tags.filter((t): t is string => typeof t === 'string') : [],
        parentId: typeof ev.home?.id === 'string' ? ev.home.id : null,
        reason: b.reason,
      });
      audits.store.markGone(p.id, id, `keep-home:${ctx.now()}`);
      return { ruling, finding: audits.store.get(p.id, id) };
    });
  });
};
