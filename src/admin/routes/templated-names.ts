/**
 * v3 F6d (ADR 0082; docs/dashboard.md › Templated Names):
 *
 * - `GET /templated-names`: the report the newest audit run judged (paged, filtered by status and primary category, one
 *   page by id or name), the counts per status under the category filter, the categories, and the run it came from.
 *   Read from the bridge's database in SQL (O(rows)), never rebuilt per request; free.
 * - `POST /templated-names/keep` (audited `templatednames.keep`): "Keep this name", a ruling tied to the page's Subject,
 *   Reference Type and name; the page's open `name_nontemplated` finding goes with it.
 * - `POST /templated-names/undo` (audited `templatednames.undo`): the ruling goes; the next audit judges the page again.
 *
 * No other decision: renames are what `name_nontemplated`'s fix does under automation (Automation page).
 */
import * as z from 'zod';
import { STATUSES } from '../../packs/names/template.js';
import { TemplatedNamesError, type TemplatedNamesService } from '../../packs/names/service.js';
import { AdminHttpError } from '../http.js';
import { parseInput, projectFor, projectParam, type Register } from './util.js';

const STATUS: Readonly<Record<string, number>> = {
  NOT_FOUND: 404,
  NOTHING_TO_KEEP: 409,
  REASON_REQUIRED: 400,
};

export const registerTemplatedNames: Register = (api, ctx) => {
  const svc = (): TemplatedNamesService => {
    const r = ctx.deps.runtime.templatedNames;
    if (!r) throw new AdminHttpError(503, 'UNAVAILABLE', 'The Templated Names service is not running.');
    return r;
  };
  const wrap = <T>(f: () => T): T => {
    try {
      return f();
    } catch (e) {
      if (e instanceof TemplatedNamesError)
        throw new AdminHttpError(STATUS[e.code] ?? 400, e.code, e.message);
      throw e;
    }
  };

  api.get('/templated-names', (req) => {
    const q = parseInput(
      z.object({
        project: projectParam,
        status: z.union([z.enum(STATUSES), z.array(z.enum(STATUSES)).max(STATUSES.length)]).optional(),
        category: z.string().min(1).max(100).optional(),
        page: z.string().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
      req.query,
    );
    const p = ctx.project(q.project);
    return wrap(() => ({
      project: p,
      statuses: STATUSES,
      report: svc().report(p.id, {
        ...(q.status !== undefined ? { status: Array.isArray(q.status) ? q.status : [q.status] } : {}),
        ...(q.category !== undefined ? { category: q.category } : {}),
        ...(q.page !== undefined ? { page: q.page } : {}),
        offset: q.offset,
        limit: q.limit,
      }),
      now: ctx.now(),
    }));
  });

  api.post('/templated-names/keep', (req) => {
    const b = parseInput(
      z
        .object({
          project: projectParam,
          pageId: z.string().min(1).max(64),
          reason: z.string().trim().min(1).max(1000),
          confirm: z.literal(true),
        })
        .strict(),
      req.body,
    );
    const p = projectFor(ctx, req, b.project);
    return wrap(() => {
      const ruling = svc().keep('owner', p.id, b.pageId, b.reason);
      // Its open finding goes with it (the next audit leaves the page out while the ruling holds).
      const audits = ctx.deps.runtime.audits;
      if (audits)
        for (const f of audits.store.list(p.id, { code: ['name_nontemplated'], state: 'open', limit: 5000 })
          .findings)
          if (f.pageId === b.pageId) audits.store.markGone(p.id, f.id, `keep-name:${ctx.now()}`);
      return { ruling };
    });
  });

  api.post('/templated-names/undo', (req) => {
    const b = parseInput(
      z
        .object({ project: projectParam, pageId: z.string().min(1).max(64), confirm: z.literal(true) })
        .strict(),
      req.body,
    );
    const p = projectFor(ctx, req, b.project);
    return wrap(() => svc().undo('owner', p.id, b.pageId));
  });
};
