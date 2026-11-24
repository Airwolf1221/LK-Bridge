/**
 * `arkona_reference_types` (v3 F6a, ADR 0076; design T2): the Reference Type values in use across the AI REPOSITORY,
 * read-only and free (the bridge's stored sidebars), the Legacy Canon Archive, the Design References, Working, Archived
 * and Narratives pages left out. One row per value and primary category: its count, its pages, the suggested canonical
 * value with the reason (or "no confident suggestion" with candidates), and its status. The owner decides each row on
 * the dashboard's Reference Types page; agents read, never decide.
 */
import * as z from 'zod';
import { ReferenceTypeError, STATUSES } from '../../packs/reftypes/service.js';
import type { McpToolProvider } from '../server.js';
import { defineTool, READ_ANNOTATIONS } from './define.js';
import { ago, finish, repoContext, resolvePage } from './repo.js';
import { errorResult, projectArg, withProject, type ToolDeps } from './shape.js';

export const MAX_ROWS = 200;
export const DEFAULT_ROWS = 50;

export function referenceTypesTool(deps: ToolDeps): McpToolProvider {
  const packs = () => deps.services?.packs;
  // CR-2026-11-R4 (LD-01): listed while the APPROVED version of the pack has a vocabulary.
  const listed = () =>
    (packs()?.toolListed('arkona') ?? false) &&
    packs()?.approvedRules('arkona')?.referenceTypes !== undefined;
  return defineTool({
    name: 'arkona_reference_types',
    title: 'Reference Types in use, with suggestions (Arkona pack, read-only)',
    access: 'read',
    description:
      'The Arkona pack, read-only and free: every Reference Type value in use across the AI REPOSITORY (the Legacy Canon Archive, Design References, Working, Archived and Narratives pages left out), from the bridge’s stored sidebars. One row per value and primary category: its count, its pages (id, name, path, category, lifecycle), the suggested canonical value with the reason (synonyms, time words moved to Temporal Scope, scope words moved to placement or Scope) or “no confident suggestion” with candidates, and its status: canonical, mapped (the owner approved a mapping), specialist (an approved additional type), rejected or open. A Reference Type names the page’s ROLE from a closed list per primary category: never invent one. The owner decides each value on the dashboard’s Reference Types page; you may only report. Filters: category ("none" for pages without a primary category tag), status, minCount, under (a branch). Paged: limit up to 200, offset. `coverage` gives the age of the stored sidebars, and pages whose sidebar was never read are listed, never silently skipped. Cost: none.',
    inputSchema: z.object({
      category: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe('A primary category (e.g. Polity), or "none".'),
      status: z
        .union([z.enum(STATUSES), z.array(z.enum(STATUSES)).min(1).max(5)])
        .optional()
        .describe('canonical, mapped, specialist, rejected or open (one or several).'),
      minCount: z
        .number()
        .int()
        .min(1)
        .max(100_000)
        .optional()
        .describe('Only values used on at least this many pages.'),
      under: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe('A branch: the page (name or id) whose subtree is read.'),
      pages: z
        .boolean()
        .optional()
        .describe('List each row’s pages (default true; false gives counts only).'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_ROWS)
        .optional()
        .describe(`Rows per page (default ${DEFAULT_ROWS}).`),
      offset: z.number().int().min(0).max(100_000).optional(),
      project: projectArg,
    }),
    annotations: READ_ANNOTATIONS,
    listed,
    handler: (args, mctx) =>
      withProject(deps, args.project, 'read', (pd) => {
        const svc = pd.services?.referenceTypes;
        if (!svc)
          return errorResult(
            { code: 'TOOL_UNAVAILABLE', message: 'The Reference Type report is not available here.' },
            pd,
          );
        const rc = repoContext(pd);
        if (!rc.ok) return rc.result;
        let underId: string | undefined;
        if (args.under !== undefined) {
          const r = resolvePage(rc.ctx, args.under, { what: 'the branch' });
          if (!r.ok) return r.result;
          underId = r.node.id;
        }
        try {
          const offset = args.offset ?? 0;
          const limit = args.limit ?? DEFAULT_ROWS;
          const report = svc.report(
            pd.project.id,
            {
              ...(args.category !== undefined ? { category: args.category } : {}),
              ...(args.status !== undefined
                ? { status: Array.isArray(args.status) ? args.status : [args.status] }
                : {}),
              ...(args.minCount !== undefined ? { minCount: args.minCount } : {}),
              ...(underId ? { underId } : {}),
            },
            { offset, limit },
          );
          const now = rc.ctx.now;
          const rows = report.rows.map((r) => ({
            value: r.value,
            category: r.category || null,
            count: r.count,
            status: r.status,
            suggestion: r.suggestion.value,
            reason: r.suggestion.reason,
            ...(r.suggestion.moved.time.length > 0 || r.suggestion.moved.scope.length > 0
              ? { moved: r.suggestion.moved }
              : {}),
            ...(r.suggestion.candidates.length > 0
              ? { candidates: r.suggestion.candidates.map((c) => `${c.name} (${c.category})`) }
              : {}),
            ...(r.decision
              ? {
                  decision: {
                    action: r.decision.action,
                    ...(r.decision.target ? { target: r.decision.target } : {}),
                    at: new Date(r.decision.at).toISOString(),
                  },
                }
              : {}),
            ...(r.conflict ? { conflict: r.conflict } : {}),
            ...(args.pages === false
              ? {}
              : {
                  pages: r.pages.map((p) => ({
                    id: p.id,
                    name: p.name,
                    path: p.path,
                    category: p.category,
                    lifecycle: p.lifecycle,
                    ...(p.coverage !== 'ok' ? { coverage: p.coverage } : {}),
                    ...(p.specialist ? { specialist: true } : {}),
                  })),
                }),
          }));
          const next = offset + report.rows.length < report.totalRows ? offset + report.rows.length : null;
          const body = {
            vocabulary: {
              status: report.vocabulary.status,
              approved: report.vocabulary.approved,
              pack: `${report.pack.id} version ${report.pack.version}${report.pack.approvedVersion !== null ? ` (approved ${report.pack.approvedVersion})` : ' (not approved)'}`,
            },
            totalRows: report.totalRows,
            offset,
            returned: rows.length,
            ...(next !== null ? { nextOffset: next } : {}),
            coverage: {
              ...report.coverage,
              source: 'the repository tree’s stored sidebars',
              ...(report.coverage.oldestRead
                ? { oldest: ago(now - Date.parse(report.coverage.oldestRead)) }
                : {}),
            },
            excluded: report.excluded,
            rows,
            hint: 'The owner decides each value (accept, choose another, reject, keep as specialist) on the dashboard’s Reference Types page. Never set a Reference Type outside the vocabulary.',
            cost: 'none',
          };
          return finish(pd, mctx, 'arkona_reference_types', body, () => ({
            totalRows: report.totalRows,
            rows: rows.slice(0, 5),
          }));
        } catch (e) {
          if (e instanceof ReferenceTypeError) return errorResult({ code: e.code, message: e.message }, pd);
          throw e;
        }
      }),
  });
}
