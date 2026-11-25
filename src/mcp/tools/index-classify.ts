/**
 * `arkona_index_classify` (v3 F6b, ADR 0079; design T12 step 1): every current index of the AI REPOSITORY with the role
 * the rules propose (`nav`, `subject` or `undecided`) and the rule that decided it, read-only and free (the repository
 * tree, the registry and the pack). Pages under Working, Archive, the Legacy Canon Archive and the Design References are
 * reported, never proposed. The owner approves, changes or leaves each row on the dashboard's Index Classification page;
 * agents read, never decide, and never rename, move or retag an index from this report.
 */
import * as z from 'zod';
import { IndexClassifyError, ROW_STATUSES } from '../../packs/indextax/service.js';
import type { McpToolProvider } from '../server.js';
import { defineTool, READ_ANNOTATIONS } from './define.js';
import { finish, repoContext, resolvePage } from './repo.js';
import { errorResult, projectArg, withProject, type ToolDeps } from './shape.js';

export const MAX_ROWS = 200;
export const DEFAULT_ROWS = 50;

export function indexClassifyTool(deps: ToolDeps): McpToolProvider {
  const packs = () => deps.services?.packs;
  // CR-2026-11-R4 (LD-01): listed while the APPROVED version of the pack carries the index rules.
  const listed = () =>
    (packs()?.toolListed('arkona') ?? false) && packs()?.approvedRules('arkona')?.indexTaxonomy !== undefined;
  return defineTool({
    name: 'arkona_index_classify',
    title: 'Index classification: [NAV] or [INDEX] (Arkona pack, read-only)',
    access: 'read',
    description:
      'The Arkona pack, read-only and free: every current index with the role the rules propose: nav ([NAV], an index that only groups or routes: a top-level branch, a race or racial group, a continent’s or Realmship’s category index, a nation subindex, a continuity or act index…) or subject ([INDEX], an index about one subject: a character, a nation or polity, a continent, a Realmship, a named Divine Realm, a culture or religion family, a story), or undecided (no rule settles it, or two rules disagree: the owner decides). Each row names the rule that decided it, the current prefix and tags, and the owner’s decision. Rules use only the bridge’s data (the registry, the narrative layout, the pack’s exact-name lists, position); a page’s kind is NEVER guessed from its name or body. Working, Archive, Legacy and Design References pages are reported, never proposed. The owner approves each row on the dashboard’s Index Classification page; you may only report. Nothing is renamed, moved or retagged from here: approved rows become proposals through the audits (index_prefix, index_tags). Filters: status, proposed, rule, under (a branch), name. Paged: limit up to 200, offset. Cost: none.',
    inputSchema: z.object({
      status: z
        .union([z.enum(ROW_STATUSES), z.array(z.enum(ROW_STATUSES)).min(1).max(6)])
        .optional()
        .describe('proposed, undecided, approved, changed, left_undecided or out_of_scope (one or several).'),
      proposed: z
        .enum(['nav', 'subject', 'undecided'])
        .optional()
        .describe('Only rows the rules propose so.'),
      rule: z
        .string()
        .min(1)
        .max(60)
        .optional()
        .describe('Only rows a rule decided (its id, e.g. race, nation).'),
      under: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe('A branch: the page (name or id) whose subtree is read.'),
      name: z.string().min(1).max(200).optional().describe('Only indexes whose name contains this text.'),
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
      withProject(deps, args.project, 'read', async (pd) => {
        const svc = pd.services?.indexClassify;
        if (!svc)
          return errorResult(
            { code: 'TOOL_UNAVAILABLE', message: 'The index classification report is not available here.' },
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
          await svc.prepare(pd.project.id);
          const offset = args.offset ?? 0;
          const limit = args.limit ?? DEFAULT_ROWS;
          const report = svc.report(
            pd.project.id,
            {
              ...(args.status !== undefined
                ? { status: Array.isArray(args.status) ? args.status : [args.status] }
                : {}),
              ...(args.proposed !== undefined ? { proposed: args.proposed } : {}),
              ...(args.rule !== undefined ? { rule: args.rule } : {}),
              ...(args.name !== undefined ? { nameContains: args.name } : {}),
              ...(underId ? { underId } : {}),
            },
            { offset, limit },
          );
          const rows = report.rows.map((r) => ({
            id: r.id,
            name: r.name,
            path: r.path,
            current: r.currentRole,
            proposed: r.proposed,
            ...(r.subject ? { subject: r.subject } : {}),
            rule: r.rule,
            why: r.why,
            status: r.status,
            tags: r.tags,
            ...(r.area ? { area: r.area } : {}),
            ...(r.decision
              ? {
                  decision: {
                    action: r.decision.action,
                    ...(r.decision.role ? { role: r.decision.role } : {}),
                    ...(r.decision.subject ? { subject: r.decision.subject } : {}),
                    at: new Date(r.decision.at).toISOString(),
                  },
                }
              : {}),
            ...(r.drifted ? { drifted: true } : {}),
          }));
          const next = offset + report.rows.length < report.totalRows ? offset + report.rows.length : null;
          const body = {
            rules: {
              pack: `${report.pack.id} version ${report.pack.version}${report.pack.approvedVersion !== null ? ` (approved ${report.pack.approvedVersion})` : ' (not approved)'}`,
              approved: report.rules.approved,
              tagSection: report.rules.tagSection,
              orderingInForce: report.rules.orderingInForce,
            },
            counts: report.counts,
            totalRows: report.totalRows,
            offset,
            returned: rows.length,
            ...(next !== null ? { nextOffset: next } : {}),
            rows,
            hint: 'The owner approves, changes or leaves each row on the dashboard’s Index Classification page. Never rename an index’s prefix or retag it from this report: approved rows become proposals through the audits (index_prefix, index_tags).',
            cost: 'none',
          };
          return finish(pd, mctx, 'arkona_index_classify', body, () => ({
            totalRows: report.totalRows,
            counts: report.counts,
            rows: rows.slice(0, 5),
          }));
        } catch (e) {
          if (e instanceof IndexClassifyError) return errorResult({ code: e.code, message: e.message }, pd);
          throw e;
        }
      }),
  });
}
