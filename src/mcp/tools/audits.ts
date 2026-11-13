/**
 * `audit_findings` (v2 E2, ADR 0044; PLAN-v2 4.12): lets an agent read the audits' findings. Read-only, free (the bridge's
 * own database: no request to LegendKeeper), paged. There is no agent tool to run, edit or acknowledge an audit: the
 * owner does that on the dashboard. An agent acts on a finding through the ordinary tools (set_facts, move_resource,
 * write_page, …), which go to proposals as usual; the dashboard's "Propose a fix" is the owner's.
 */
import * as z from 'zod';
import { CATEGORIES, SEVERITIES, CODES } from '../../audits/types.js';
import type { Finding } from '../../audits/types.js';
import type { McpToolProvider } from '../server.js';
import { defineTool, READ_ANNOTATIONS } from './define.js';
import { errorResult, projectArg, render, withProject, type ToolDeps } from './shape.js';

const ID_ONLY = /^(lk:\/\/resources\/)?([a-z][0-9a-z]{5,31})$/;

const csvArg = (what: string) =>
  z
    .union([z.string().min(1).max(500), z.array(z.string().min(1).max(100)).max(30)])
    .optional()
    .describe(what);
const list = (v: string | string[] | undefined): string[] | undefined =>
  v === undefined ? undefined : (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean);

const view = (f: Finding, full: boolean, latestRun: string | null) => ({
  id: f.id,
  code: f.code,
  category: f.category,
  severity: f.severity,
  page: f.pageId ? { id: f.pageId, name: f.pageName, path: f.pagePath } : null,
  ...(f.documentId ? { document: f.documentId } : {}),
  ...(f.blockId ? { block: f.blockId } : {}),
  message: f.message,
  ...(full ? { evidence: f.evidence } : {}),
  status: f.state === 'gone' ? 'gone' : f.firstSeenRun === latestRun ? 'new' : 'still_present',
  firstSeen: new Date(f.firstSeenAt).toISOString(),
  ...(f.resolvedAt ? { resolved: new Date(f.resolvedAt).toISOString() } : {}),
  source: {
    kind: f.source.kind,
    ...('snapshotId' in f.source ? { snapshot: f.source.snapshotId } : {}),
    ...('checkId' in f.source ? { chronologyCheck: f.source.checkId } : {}),
    takenAt: new Date(f.source.takenAt).toISOString(),
    ageMinutes: Math.round(f.source.ageMs / 60_000),
  },
  ...(f.acknowledgement ? { acknowledged: { reason: f.acknowledgement.reason } } : {}),
  ...(f.acknowledgementLapsed ? { acknowledgementLapsed: true } : {}),
  ...(f.fix ? { fixAvailable: f.fix.summary } : {}),
});

function auditFindingsTool(deps: ToolDeps): McpToolProvider {
  return defineTool({
    name: 'audit_findings',
    title: 'Read the audit findings',
    access: 'read',
    description:
      'Reads the findings of the bridge’s audits (findings only: an audit changes nothing). They come from the nightly snapshot and say how old it is, so they may not show later edits: read the page (get_resource, read_document) before acting. Filters: category, code, severity, page (a name, a path fragment or an id), `new`, `acknowledged` (hidden by default) and `state`; page with `limit` and `offset`; detail "full" adds evidence. Fix with the ordinary tools (set_facts, move_resource, write_page, update_resource: proposals as usual). Leave lifecycle and canon findings to the owner: never edit a prefix, Status or status tag to make a finding go away. You cannot run, edit or acknowledge an audit. Cost: none.',
    inputSchema: z.object({
      category: csvArg(`One or more of: ${CATEGORIES.join(', ')}.`),
      code: csvArg(
        `One or more finding codes, for example line_break_paragraph, out_of_order, deleted_target.`,
      ),
      severity: csvArg(`One or more of: ${SEVERITIES.join(', ')}.`),
      page: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('A page id, or a fragment of its name or path (case-insensitive).'),
      new: z.boolean().optional().describe('Only findings first seen in the latest audit run.'),
      acknowledged: z.enum(['hide', 'only', 'include']).optional(),
      state: z.enum(['open', 'gone', 'all']).optional().describe('open (default), gone (resolved), or all.'),
      limit: z.number().int().min(1).max(100).optional().describe('At most this many findings (default 25).'),
      offset: z.number().int().min(0).optional().describe('Skip this many (to read the next page).'),
      detail: z
        .enum(['summary', 'full'])
        .optional()
        .describe('`full` adds each finding’s evidence (what was expected and found).'),
      project: projectArg,
    }),
    annotations: READ_ANNOTATIONS,
    handler: (args) =>
      withProject(deps, args.project, 'read', (pd) => {
        const audits = pd.services?.audits;
        if (!audits)
          return errorResult(
            { code: 'TOOL_UNAVAILABLE', message: 'The audits are not running in this bridge.' },
            pd,
          );
        const bad = [...(list(args.category) ?? [])].filter(
          (c) => !(CATEGORIES as readonly string[]).includes(c),
        );
        if (bad.length > 0)
          return errorResult(
            {
              code: 'INVALID_INPUT',
              message: `Unknown categor${bad.length > 1 ? 'ies' : 'y'}: ${bad.join(', ')}.`,
              categories: CATEGORIES,
            },
            pd,
          );
        const badCodes = (list(args.code) ?? []).filter((c) => !Object.hasOwn(CODES, c));
        if (badCodes.length > 0)
          return errorResult(
            {
              code: 'INVALID_INPUT',
              message: `Unknown code${badCodes.length > 1 ? 's' : ''}: ${badCodes.join(', ')}.`,
              codes: Object.keys(CODES),
            },
            pd,
          );
        const idMatch = args.page ? ID_ONLY.exec(args.page.trim()) : null;
        const limit = args.limit ?? 25;
        const offset = args.offset ?? 0;
        const category = list(args.category);
        const code = list(args.code);
        const severity = list(args.severity);
        const r = audits.list(pd.project.id, {
          ...(category ? { category } : {}),
          ...(code ? { code } : {}),
          ...(severity ? { severity } : {}),
          ...(args.page && !idMatch ? { page: args.page } : {}),
          ...(idMatch ? { pageId: idMatch[2]! } : {}),
          ...(args.new ? { onlyNew: true } : {}),
          acknowledged: args.acknowledged ?? 'hide',
          state: args.state ?? 'open',
          limit,
          offset,
        });
        const run = audits.store.latestRun(pd.project.id);
        const summary = audits.store.summary(pd.project.id);
        const full = args.detail === 'full';
        const next = offset + r.findings.length;
        return render(
          {
            run: run
              ? {
                  id: run.id,
                  at: new Date(run.startedAt).toISOString(),
                  durationMs: run.durationMs,
                  snapshot: run.snapshotId,
                  snapshotAgeMinutes:
                    run.snapshotAgeMs === null ? null : Math.round(run.snapshotAgeMs / 60_000),
                  changeSnapshots: run.changeSnapshots,
                  stale: run.stale,
                  summary: run.summary,
                }
              : null,
            open: summary.open,
            acknowledged: summary.acknowledged,
            byCategory: Object.fromEntries(
              Object.entries(summary.byCategory).filter(([, v]) => v.error + v.warning + v.info > 0),
            ),
            total: r.total,
            count: r.findings.length,
            findings: r.findings.map((f) => view(f, full, r.latestRun)),
            ...(next < r.total ? { nextOffset: next } : {}),
            hint:
              run === null
                ? 'No audit has run yet: the first runs after the next nightly full snapshot, or the owner can run one on the dashboard.'
                : r.total === 0
                  ? 'No findings match.'
                  : 'Findings are reports from a snapshot, possibly out of date: check the page before acting, and make changes through the ordinary tools (they become proposals).',
          },
          pd,
        );
      }),
  });
}

export function auditTools(deps: ToolDeps): McpToolProvider[] {
  return [auditFindingsTool(deps)];
}
