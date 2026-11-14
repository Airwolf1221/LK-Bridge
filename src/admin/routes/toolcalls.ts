/**
 * The Tool calls page's API (v2 E3, ADR 0045; docs/dashboard.md): which tools each connection actually called, with a
 * short summary of the arguments (names and sizes, never page content or secrets), the outcome, the duration and the
 * request budget used. Owner only (the admin guard); no agent tool reads it.
 *
 * - `GET /tool-calls`: the log, newest first, filtered by connection, profile, tool, outcome, error code, project and
 *   time, paged by `before`; the filter choices; how long rows are kept.
 * - `PUT /tool-calls/retention`: how many days rows are kept (0 switches recording off). Audited.
 */
import * as z from 'zod';
import { MAX_RETENTION_DAYS } from '../../toolcalls/index.js';
import { AdminHttpError } from '../http.js';
import { idSchema, limitSchema, parseInput, type Register } from './util.js';

const query = z.object({
  principalId: idSchema.optional(),
  profile: idSchema.optional(),
  tool: idSchema.optional(),
  outcome: z.enum(['success', 'error', 'proposal', 'waiting', 'queued', 'not_success']).optional(),
  code: idSchema.optional(),
  project: idSchema.optional(),
  sinceMinutes: z.coerce
    .number()
    .min(1)
    .max(60 * 24 * MAX_RETENTION_DAYS)
    .optional(),
  before: z.coerce.number().int().min(1).optional(),
  limit: limitSchema(100, 500),
});

export const registerToolCalls: Register = (api, ctx) => {
  const log = () => {
    const l = ctx.deps.runtime.toolCalls;
    if (!l) throw new AdminHttpError(503, 'TOOL_CALLS_UNAVAILABLE', 'The tool-call log is not running.');
    return l;
  };
  const settings = () => {
    const l = log();
    return {
      retentionDays: l.retentionDays(),
      maxRetentionDays: MAX_RETENTION_DAYS,
      recording: l.retentionDays() > 0,
    };
  };

  api.get('/tool-calls', (req) => {
    const q = parseInput(query, req.query);
    const l = log();
    const { rows, hasMore } = l.list({
      ...(q.principalId ? { principalId: q.principalId } : {}),
      ...(q.profile ? { profile: q.profile } : {}),
      ...(q.tool ? { tool: q.tool } : {}),
      ...(q.outcome ? { outcome: q.outcome } : {}),
      ...(q.code ? { code: q.code } : {}),
      ...(q.project ? { project: q.project } : {}),
      ...(q.sinceMinutes ? { since: ctx.now() - q.sinceMinutes * 60_000 } : {}),
      ...(q.before !== undefined ? { before: q.before } : {}),
      limit: q.limit,
    });
    return {
      calls: rows,
      principals: ctx.principals(rows.flatMap((r) => (r.principalId ? [r.principalId] : []))),
      hasMore,
      nextBefore: hasMore ? (rows.at(-1)?.id ?? null) : null,
      facets: l.facets(),
      settings: settings(),
    };
  });

  api.put('/tool-calls/retention', (req) => {
    const b = parseInput(
      z.object({ days: z.number().int().min(0).max(MAX_RETENTION_DAYS), confirm: z.literal(true) }),
      req.body,
    );
    log().setRetentionDays(b.days);
    return { settings: settings() };
  });
};
