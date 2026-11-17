/**
 * The Arkona pack's appraisal tools (v3 F3c, ADR 0054; the owner-approved design docs/design/F3c-appraisal.md). Four
 * read-only reports and one way to act on a finding:
 *
 * - `arkona_appraise_owner` (A2): a page, a branch or everything against Source Formatting, in Repository Automation's
 *   four groups (required defects, optional polish, architectural candidates, blocked cases);
 * - `arkona_change_impact` (A3): what depends on a page, a planned rename or a pending proposal (proven breakage and
 *   review candidates);
 * - `arkona_working_digest` (A4): Working pages, open proposals, approved-but-unpromoted sets, declared contradictions;
 * - `arkona_visual_hygiene` (A5): the visual references (candidates only);
 * - `arkona_appraisal_fix`: "Propose a fix" for a finding whose follow-up is a `fix`: ONE ordinary proposal for the
 *   owner, whatever the caller's scope; never applied by the appraisal.
 *
 * The reports read the snapshot overlay, the audits and the bridge's own database: free, unless `live: true` (A2, A3).
 * Each run is kept (the latest per scope) so a long report is read a page at a time with `runId` and `offset`.
 */
import * as z from 'zod';
import {
  AppraisalError,
  GROUP_LABEL,
  type AppraisalFinding,
  type AppraisalReport,
} from '../../appraisal/index.js';
import type { LiveRead } from '../../appraisal/index.js';
import type { McpToolContext, McpToolProvider, McpToolResult } from '../server.js';
import { defineTool, READ_ANNOTATIONS } from './define.js';
import { finish, repoContext, resolvePage } from './repo.js';
import {
  errorFromThrown,
  errorResult,
  mcpOrigin,
  projectArg,
  RAIL_HINT,
  railBody,
  render,
  withProject,
  type ProjectDeps,
  type ToolDeps,
} from './shape.js';
import { CREATE_ANNOTATIONS } from './resources.js';
import { describeJob } from './write-job.js';

const GROUPS = [
  'required',
  'polish',
  'architectural',
  'blocked',
  'proven',
  'candidates',
  'working',
  'proposals',
  'unpromoted',
  'contradictions',
] as const;

const pageArg = z.string().min(1).max(500);
const pagingArgs = {
  runId: z
    .string()
    .regex(/^apr_[0-9a-f]{16}$/)
    .optional()
    .describe('Read a stored run again (from an earlier answer), a page at a time: nothing is re-run.'),
  group: z.enum(GROUPS).optional().describe('Only this group’s findings.'),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(200).optional().describe('Findings per answer. Default 50.'),
  detail: z.enum(['summary', 'full']).optional().describe('"full" adds each finding’s evidence.'),
};

/** A finding as the tools list it. */
export function findingView(f: AppraisalFinding, full: boolean): Record<string, unknown> {
  return {
    id: f.id,
    group: f.group,
    check: f.check,
    evidence: f.evidence,
    rule: [f.rule.page, f.rule.section, f.rule.rule].filter(Boolean).join(' › '),
    ...(f.page ? { page: f.page } : {}),
    ...(f.labels ? { lifecycle: f.labels.lifecycle, branch: f.labels.branch } : {}),
    message: f.message,
    followUp: f.followUp,
    source: {
      kind: f.source.kind,
      ...(f.source.snapshotId ? { snapshot: f.source.snapshotId } : {}),
      ...(f.source.takenAt !== undefined ? { takenAt: new Date(f.source.takenAt).toISOString() } : {}),
      ...(f.source.auditFindingId !== undefined ? { auditFinding: f.source.auditFindingId } : {}),
    },
    ...(full
      ? {
          details: f.details,
          ...(f.documentId ? { document: f.documentId } : {}),
          ...(f.blockId ? { block: f.blockId } : {}),
        }
      : {}),
  };
}

/** One page of a report as an answer. */
function answer(
  pd: ProjectDeps,
  mctx: McpToolContext,
  tool: string,
  r: AppraisalReport,
  o: {
    group?: string | undefined;
    offset?: number | undefined;
    limit?: number | undefined;
    detail?: string | undefined;
  },
  cost: string,
): McpToolResult {
  const list = o.group ? r.findings.filter((f) => f.group === o.group) : r.findings;
  const from = o.offset ?? 0;
  const size = o.limit ?? 50;
  const page = list.slice(from, from + size);
  const groups = Object.fromEntries(
    [...new Set(r.findings.map((f) => f.group))].map((g) => [
      g,
      { label: GROUP_LABEL[g], count: r.counts[g] ?? 0 },
    ]),
  );
  return finish(
    pd,
    mctx,
    tool,
    {
      runId: r.runId,
      scope: r.scope,
      createdAt: r.createdAt,
      source: r.source,
      inspected: r.inspected,
      couldNotCheck: r.couldNotCheck,
      counts: r.counts,
      groups,
      ...(r.compared ? { comparedWithLastRun: r.compared } : {}),
      total: list.length,
      offset: from,
      nextOffset: from + page.length < list.length ? from + page.length : null,
      findings: page.map((f) => findingView(f, o.detail === 'full')),
      readOnly:
        'Nothing was written. A finding whose followUp is "fix" can become ONE proposal with arkona_appraisal_fix { findingId }; a "judgement" names the tool and what has to be decided (ask the owner, never guess).',
      cost,
    },
    () => ({
      runId: r.runId,
      counts: r.counts,
      first: page.slice(0, 5).map((f) => ({ id: f.id, check: f.check })),
    }),
  );
}

/** Who asked: the calling principal (for the stored run and the audit row). */
const actorOf = (mctx: McpToolContext, tool: string): string =>
  mcpOrigin(mctx, tool).principal?.principalId ?? 'agent';

/** A governed live read at interactive priority, for `live: true` and the fixes (throws when it could not run now). */
export function liveReader(pd: ProjectDeps, mctx: McpToolContext, tool: string): LiveRead {
  return async (op, params) => {
    const r = await pd.engine.run(op, params, {
      project: pd.project.id,
      origin: mcpOrigin(mctx, tool),
      priority: 'P1',
      signal: mctx.signal,
    });
    if (r.status === 'succeeded') return r.result;
    throw new AppraisalError(
      'READ_DELAYED',
      'LegendKeeper’s rate budget is busy, so the live read was queued instead of run. Nothing was proposed; try again later, or leave live out.',
      r.status === 'queued' || r.status === 'waiting_budget' ? { jobId: r.jobId } : {},
    );
  };
}

function refusal(e: unknown, pd: ProjectDeps): McpToolResult {
  if (e instanceof AppraisalError) return errorResult({ code: e.code, message: e.message, ...e.details }, pd);
  return errorFromThrown(e, pd);
}

/** The appraisal service, or the refusal when the pack does not apply here. */
function service(pd: ProjectDeps) {
  const a = pd.services?.appraisal;
  if (!a)
    return {
      ok: false as const,
      result: errorResult({ code: 'TOOL_UNAVAILABLE', message: 'The appraisal is not available here.' }, pd),
    };
  return { ok: true as const, a };
}

/** A stored run, for `runId`. */
function stored(pd: ProjectDeps, runId: string, tool: string): AppraisalReport | McpToolResult {
  const r = pd.services!.appraisal!.store.report(pd.project.id, runId);
  if (!r || r.tool !== tool)
    return errorResult(
      {
        code: 'RUN_NOT_FOUND',
        message: `No stored ${tool} run ${runId} in this project (only the latest run of each scope is kept: run it again).`,
      },
      pd,
    );
  return r;
}

const isResult = (x: unknown): x is McpToolResult =>
  typeof x === 'object' &&
  x !== null &&
  'content' in x &&
  Array.isArray((x as { content?: unknown }).content);

/** `since` as milliseconds: `24h`, `7d`, `2w`, or a number of days. */
export function sinceMs(v: string | number | undefined): number | null {
  if (v === undefined) return null;
  if (typeof v === 'number') return v * 86_400_000;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([hdw])\s*$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  return n * (unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 7 * 86_400_000);
}

export function appraisalTools(deps: ToolDeps): McpToolProvider[] {
  const listed = () => deps.services?.packs?.toolListed('arkona') ?? false;
  return [
    defineTool({
      name: 'arkona_appraise_owner',
      title: 'Appraise owner pages against Source Formatting (Arkona pack, read-only)',
      access: 'read',
      description:
        'The Arkona pack, read-only: appraises one page (`page`), a branch (`under`: the page and everything beneath it) or everything (`all: true`) against Source Formatting, in Repository Automation’s four groups: required defects, optional polish, architectural candidates, blocked cases. Each finding names its rule (governance page and section), its evidence class and its follow-up: `fix` (arkona_appraisal_fix makes ONE proposal), `judgement` (the tool to use and what has to be decided: ask the owner, never guess) or `none`. The page’s open audit findings are gathered (sibling order, tags…), never re-checked. A branch or everything leaves out the Legacy Canon Archive, Design References and Archived pages unless `include` names them. Nothing is ever written. ' +
        'Long reports come a page at a time: `runId` and `offset` read the stored run again (nothing re-run). ' +
        'Cost: none (the snapshots, the audits and the bridge’s own database). live: true re-reads each page appraised now (2 reads each, at most 25 pages).',
      inputSchema: z.object({
        page: pageArg.optional().describe('One page (name or id).'),
        under: pageArg.optional().describe('A branch: this page and everything beneath it (name or id).'),
        all: z.boolean().optional().describe('Everything in the AI REPOSITORY (bounded and paged).'),
        include: z
          .array(z.enum(['legacy', 'design', 'archived']))
          .max(3)
          .optional()
          .describe('Bring the non-current areas into a branch or everything.'),
        live: z.boolean().optional().describe('Re-read the pages now (2 reads each, at most 25).'),
        ...pagingArgs,
        project: projectArg,
      }),
      annotations: READ_ANNOTATIONS,
      listed,
      handler: (args, mctx) =>
        withProject(deps, args.project, 'read', async (pd) => {
          const s = service(pd);
          if (!s.ok) return s.result;
          if (args.runId) {
            const r = stored(pd, args.runId, 'arkona_appraise_owner');
            return isResult(r)
              ? r
              : answer(pd, mctx, 'arkona_appraise_owner', r, args, 'none (a stored run)');
          }
          const given = [args.page, args.under, args.all ? 'all' : undefined].filter((x) => x !== undefined);
          if (given.length !== 1)
            return errorResult(
              {
                code: 'INVALID_PARAMS',
                message: 'Give exactly one of page, under or all: true (or runId to read a stored run).',
              },
              pd,
            );
          const rc = repoContext(pd);
          if (!rc.ok) return rc.result;
          let pageId: string | undefined;
          let underId: string | undefined;
          if (args.page) {
            const r = resolvePage(rc.ctx, args.page);
            if (!r.ok) return r.result;
            pageId = r.node.id;
          }
          if (args.under) {
            const r = resolvePage(rc.ctx, args.under, { what: `under:${args.under}` });
            if (!r.ok) return r.result;
            underId = r.node.id;
          }
          try {
            const report = await s.a.appraiseOwner({
              projectId: pd.project.id,
              actor: actorOf(mctx, 'arkona_appraise_owner'),
              scope: {
                ...(pageId ? { pageId } : {}),
                ...(underId ? { underId } : {}),
                ...(args.all ? { all: true } : {}),
                ...(args.include ? { include: args.include } : {}),
              },
              ...(args.live ? { live: liveReader(pd, mctx, 'arkona_appraise_owner') } : {}),
            });
            const reads = report.source.live?.reads ?? 0;
            return answer(
              pd,
              mctx,
              'arkona_appraise_owner',
              report,
              args,
              reads > 0 ? `${reads} read(s) (live)` : 'none',
            );
          } catch (e) {
            return refusal(e, pd);
          }
        }),
    }),
    defineTool({
      name: 'arkona_change_impact',
      title: 'What depends on this page (Arkona pack, read-only)',
      access: 'read',
      description:
        'The Arkona pack, read-only: everything connected to a page (`page`), a planned rename (`page` + `renameTo`, the new name without its prefix) or a pending proposal (`proposal`: each page it changes), in two groups. **Proven breakage**: Dependencies or an Authoritative page’s Related Sources pointing at a page that is (or will be) deleted, archived or Working; mentions whose target is gone; for a rename, mentions and chronology rows whose displayed text will no longer match. **Review candidates**: incoming links and mentions, chronology rows naming the subject, and textual restatements (other pages’ text naming it, by its name and aliases, through the full-text index): a restatement is never proof anything changed. Each with its page, section and a snippet. Nothing is ever written. ' +
        'Cost: none (the snapshots and the full-text index). live: true re-reads the subject now (1 read): its name and aliases; the linking pages are the snapshots’.',
      inputSchema: z.object({
        page: pageArg.optional().describe('The page (name or id).'),
        renameTo: z.string().min(1).max(500).optional().describe('A planned new name (without its prefix).'),
        proposal: z
          .string()
          .regex(/^prop_[a-z0-9]+$/)
          .optional()
          .describe('A pending proposal: each page it changes is analysed.'),
        live: z.boolean().optional().describe('Re-read the subject page now (1 read).'),
        ...pagingArgs,
        project: projectArg,
      }),
      annotations: READ_ANNOTATIONS,
      listed,
      handler: (args, mctx) =>
        withProject(deps, args.project, 'read', async (pd) => {
          const s = service(pd);
          if (!s.ok) return s.result;
          if (args.runId) {
            const r = stored(pd, args.runId, 'arkona_change_impact');
            return isResult(r) ? r : answer(pd, mctx, 'arkona_change_impact', r, args, 'none (a stored run)');
          }
          if ((args.page === undefined) === (args.proposal === undefined))
            return errorResult(
              {
                code: 'INVALID_PARAMS',
                message: 'Give a page (with renameTo for a planned rename) or a proposal, not both.',
              },
              pd,
            );
          if (args.renameTo && !args.page)
            return errorResult(
              { code: 'INVALID_PARAMS', message: 'renameTo needs the page it renames.' },
              pd,
            );
          let pageId: string | undefined;
          if (args.page) {
            const rc = repoContext(pd);
            if (!rc.ok) return rc.result;
            const r = resolvePage(rc.ctx, args.page);
            if (!r.ok) return r.result;
            pageId = r.node.id;
          }
          try {
            const report = await s.a.changeImpact({
              projectId: pd.project.id,
              actor: actorOf(mctx, 'arkona_change_impact'),
              ...(pageId ? { pageId } : {}),
              ...(args.renameTo ? { renameTo: args.renameTo } : {}),
              ...(args.proposal ? { proposalId: args.proposal } : {}),
              ...(args.live && pageId ? { live: liveReader(pd, mctx, 'arkona_change_impact') } : {}),
            });
            const reads = report.source.live?.reads ?? 0;
            return answer(
              pd,
              mctx,
              'arkona_change_impact',
              report,
              args,
              reads > 0 ? `${reads} read(s) (live)` : 'none',
            );
          } catch (e) {
            return refusal(e, pd);
          }
        }),
    }),
    defineTool({
      name: 'arkona_working_digest',
      title: 'What is in progress (Arkona pack, read-only)',
      access: 'read',
      description:
        'The Arkona pack, read-only: every Working page (its Status, Scope, Last Major Revision, when the snapshots first saw it and when it last changed), every pending or conflicted proposal, the Working sets whose package was approved but whose pages are still [BWRK], and the Working pages whose Unresolved Material says “contradict”, “conflict” or “supersede”. Age is shown, never judged: there is no “stale” threshold (Repository Automation: age alone is a review signal). Ordered by the most recent change; `since` (`24h`, `7d`, `2w`, or a number of days) keeps only what changed in that window. ' +
        'Cost: none (the snapshots, the proposals and the bridge’s own database).',
      inputSchema: z.object({
        since: z
          .union([z.string().max(20), z.number().min(0).max(3650)])
          .optional()
          .describe('Only what changed in this window: "24h", "7d", "2w", or days.'),
        ...pagingArgs,
        project: projectArg,
      }),
      annotations: READ_ANNOTATIONS,
      listed,
      handler: (args, mctx) =>
        withProject(deps, args.project, 'read', async (pd) => {
          const s = service(pd);
          if (!s.ok) return s.result;
          if (args.runId) {
            const r = stored(pd, args.runId, 'arkona_working_digest');
            return isResult(r)
              ? r
              : answer(pd, mctx, 'arkona_working_digest', r, args, 'none (a stored run)');
          }
          const since = sinceMs(args.since);
          if (args.since !== undefined && since === null)
            return errorResult(
              { code: 'INVALID_PARAMS', message: 'since is "24h", "7d", "2w" or a number of days.' },
              pd,
            );
          try {
            const report = await s.a.workingDigest({
              projectId: pd.project.id,
              actor: actorOf(mctx, 'arkona_working_digest'),
              sinceMs: since,
            });
            return answer(pd, mctx, 'arkona_working_digest', report, args, 'none');
          } catch (e) {
            return refusal(e, pd);
          }
        }),
    }),
    defineTool({
      name: 'arkona_visual_hygiene',
      title: 'Check the visual references (Arkona pack, read-only)',
      access: 'read',
      description:
        'The Arkona pack, read-only: the asset library and the images pages show, as CANDIDATES only (never defects repaired automatically): asset names with a file extension (the one with a fix: a rename, as a proposal), non-WebP images, an image outside its character’s folder (Characters / race path / Name / Forms | Outfits | Details), orphan candidates (no page shows them; a whole-library run only), image blocks whose asset is gone, Art page images with no interpretation text, and two images labelled as one subject’s Primary Reference. Default: the whole library; `page` or `under` narrows it to the images those pages show. Nothing is ever written. ' +
        'Cost: none (the bridge’s asset tree and the snapshots).',
      inputSchema: z.object({
        page: pageArg.optional().describe('Only the images this page shows.'),
        under: pageArg.optional().describe('Only the images this branch shows.'),
        ...pagingArgs,
        project: projectArg,
      }),
      annotations: READ_ANNOTATIONS,
      listed,
      handler: (args, mctx) =>
        withProject(deps, args.project, 'read', async (pd) => {
          const s = service(pd);
          if (!s.ok) return s.result;
          if (args.runId) {
            const r = stored(pd, args.runId, 'arkona_visual_hygiene');
            return isResult(r)
              ? r
              : answer(pd, mctx, 'arkona_visual_hygiene', r, args, 'none (a stored run)');
          }
          if (args.page && args.under)
            return errorResult({ code: 'INVALID_PARAMS', message: 'Give page or under, not both.' }, pd);
          let pageId: string | undefined;
          let underId: string | undefined;
          if (args.page || args.under) {
            const rc = repoContext(pd);
            if (!rc.ok) return rc.result;
            const r = resolvePage(rc.ctx, (args.page ?? args.under)!);
            if (!r.ok) return r.result;
            if (args.page) pageId = r.node.id;
            else underId = r.node.id;
          }
          try {
            const report = await s.a.visualHygiene({
              projectId: pd.project.id,
              actor: actorOf(mctx, 'arkona_visual_hygiene'),
              scope: {
                ...(pageId ? { pageId } : {}),
                ...(underId ? { underId } : {}),
                ...(!pageId && !underId ? { all: true } : {}),
              },
            });
            return answer(pd, mctx, 'arkona_visual_hygiene', report, args, 'none');
          } catch (e) {
            return refusal(e, pd);
          }
        }),
    }),
    defineTool({
      name: 'arkona_appraisal_fix',
      title: 'Fix an appraisal finding (Arkona pack)',
      access: 'write',
      description:
        'The Arkona pack: the fix for ONE appraisal finding whose followUp is `fix` (its `findingId` from an appraisal report). It re-reads the page (or asset) live and checks the finding still holds (FIX_STALE otherwise: nothing is done). Then it follows the pack’s switch for this tool, set by the owner: “follow the agent’s scope” (the default) makes the fix at once at scope write (the owner reviews it afterwards) and ONE proposal at scope propose; “always propose” makes ONE ordinary proposal for the owner whatever your scope. Canon, lifecycle and the owner’s safety rails still make a proposal. The fixes: an em dash in a page name (update_resource) or in its headings and prose (block by block, every other character kept); decorative blank paragraphs removed; a heading’s link dropped (its text kept); an asset name’s file extension dropped (refused when the folder holds that name); a Working or Archived page removed from an Authoritative page’s Related Sources; sibling order and tags handed to the audits’ own fix. Last Major Revision follows the owner’s rule (a dash or a blank paragraph is not a major revision). A `judgement` finding has no fix: ask the owner. Sibling order and tags go to the audits’ own fix, always a proposal. Never resubmit a captured proposal (follow it with bridge_proposal_status) or a job (bridge_job_status). ' +
        'The fix checks its target again inside its job before it writes (an asset renamed or moved, a linked page made current meanwhile: FIX_STALE, nothing written). ' +
        'Cost: 1 read (2 for a Related Sources link: the linked page is read too), then the fix’s own writes (at once, or when the owner approves the proposal).',
      inputSchema: z.object({
        findingId: z
          .string()
          .regex(/^af_[0-9a-f]{20}$/)
          .describe('The finding’s id (from arkona_appraise_owner or arkona_visual_hygiene).'),
        project: projectArg,
      }),
      annotations: CREATE_ANNOTATIONS,
      listed,
      handler: (args, mctx) =>
        withProject(deps, args.project, 'write', async (pd) => {
          const s = service(pd);
          if (!s.ok) return s.result;
          try {
            const origin = mcpOrigin(mctx, 'arkona_appraisal_fix');
            // v3 F3.4 (ADR 0055 decision D): the pack's switch, from the version the owner approved; CR-2026-11-R2 (R2-11):
            // a switch to "always propose" waiting for approval applies at once (the stricter of the two).
            const mode = pd.services?.packs?.strictToolMode('arkona', 'arkona_appraisal_fix') ?? 'propose';
            const r = await s.a.proposeFix({
              projectId: pd.project.id,
              findingId: args.findingId,
              actor: origin.principal?.principalId ?? 'agent',
              origin,
              read: liveReader(pd, mctx, 'arkona_appraisal_fix'),
              forceProposal: mode === 'propose',
            });
            if (r.status === 'submitted') {
              // At scope write, as one job: the owner reviews it afterwards (the Review page).
              const view = await pd.engine.wait(pd.project.id, r.jobId, 25_000);
              return describeJob(pd, view, [], { fix: r.fix, summary: r.summary, reads: r.reads }).result;
            }
            return render(
              r.status === 'proposal_captured'
                ? {
                    status: 'proposal_captured',
                    proposalId: r.proposalId,
                    summary: r.summary,
                    fix: r.fix,
                    ...(r.requiresCanonicalApproval ? { requiresCanonicalApproval: true } : {}),
                    ...(r.proposedBecause ? railBody({ proposedBecause: r.proposedBecause }) : {}),
                    reads: r.reads,
                    hint: r.proposedBecause
                      ? RAIL_HINT
                      : 'ONE proposal for the owner, NOT applied. Never resubmit it; follow it with bridge_proposal_status.',
                  }
                : { status: 'nothing_to_do', message: r.message, reads: r.reads },
              pd,
            );
          } catch (e) {
            return refusal(e, pd);
          }
        }),
    }),
  ];
}
