/**
 * The Workstreams page's API (v3 F5c, ADR 0069, H8; docs/dashboard.md › Workstreams): the workstream labels agents
 * worked under, and each one's report. Read-only: the bridge's own records, nothing read from LegendKeeper.
 *
 * - `GET /workstreams?project=`: each label of the project (its principals, first and last activity, counts).
 * - `GET /workstreams/report?project=&workstream=` (or `since`, `principal`): the report `bridge_workstream_report` gives.
 */
import * as z from 'zod';
import { AdminHttpError } from '../http.js';
import { parseInput, projectParam, type Register } from './util.js';

export const registerWorkstreams: Register = (api, ctx) => {
  const reports = () => {
    const r = ctx.deps.runtime.workstreamReports;
    if (!r) throw new AdminHttpError(503, 'WORKSTREAMS_UNAVAILABLE', 'Workstream reports are not available here.');
    return r;
  };

  api.get('/workstreams', (req) => {
    const q = parseInput(
      z.object({ project: projectParam, limit: z.coerce.number().int().min(1).max(500).optional() }),
      req.query,
    );
    const p = ctx.project(q.project);
    return { project: p, workstreams: reports().list(p.id, q.limit !== undefined ? { limit: q.limit } : {}) };
  });

  api.get('/workstreams/report', (req) => {
    const q = parseInput(
      z.object({
        project: projectParam,
        workstream: z.string().min(1).max(80).optional(),
        since: z.string().min(4).max(40).optional(),
        principal: z.string().min(1).max(100).optional(),
      }),
      req.query,
    );
    const p = ctx.project(q.project);
    const since = q.since !== undefined ? Date.parse(q.since) : undefined;
    if (since !== undefined && Number.isNaN(since))
      throw new AdminHttpError(400, 'INVALID_INPUT', 'since: not a date or time');
    if (q.workstream === undefined && since === undefined && q.principal === undefined)
      throw new AdminHttpError(400, 'INVALID_INPUT', 'Name a workstream, a since time or a principal.');
    return {
      project: p,
      report: reports().report(p.id, {
        ...(q.workstream !== undefined ? { workstream: q.workstream } : {}),
        ...(since !== undefined ? { since } : {}),
        ...(q.principal !== undefined ? { principal: q.principal } : {}),
      }),
    };
  });
};
