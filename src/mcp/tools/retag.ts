/**
 * The Arkona pack's retag tools (v3 F3f, ADR 0060), the Controlled Native Tagging Standard's "read-only policy audit"
 * and "separately approved guarded apply":
 *
 * - `arkona_retag_audit`: read-only and free (the snapshots; `live: true` re-reads the pages concerned, one read each).
 *   Every page's resource ID, current and proposed arrays, a rationale per slot, the policy version and digest, and its
 *   disposition (compliant, deterministic correction, hold, exception). Stored as a run. A named `reconciliation` keeps
 *   the record across batches. An agent may `suggest` a classification for a hold (kept for the owner; never used).
 * - `arkona_retag_apply`: deterministic corrections of a stored run only, at most the pack's batch size, ONE proposal
 *   (each page an item the owner can leave out), always a proposal by default. Or `reconciliation`: a fresh audit of
 *   what remains, then its next batch.
 */
import * as z from 'zod';
import type { RetagVerdict } from '../../packs/retag/engine.js';
import { RetagError, type RetagService } from '../../packs/retag/service.js';
import type { McpToolContext, McpToolProvider, McpToolResult } from '../server.js';
import { liveReader } from './appraisal.js';
import { defineTool, READ_ANNOTATIONS } from './define.js';
import { finish, repoContext, resolvePage } from './repo.js';
import { CREATE_ANNOTATIONS } from './resources.js';
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
import { describeJob } from './write-job.js';

const ORDER = ['correction', 'hold', 'exception', 'compliant', 'lifecycle', 'excluded'] as const;
type Filter = (typeof ORDER)[number];
const filterOf = (v: RetagVerdict): Filter => (v.scope === 'grammar' ? v.disposition! : v.scope);

/** One page of a run, as the tools and the dashboard list it. */
export function verdictView(v: RetagVerdict, policy: { version: number; digest: string }, full: boolean) {
  return {
    pageId: v.pageId,
    name: v.name,
    disposition: v.scope === 'grammar' ? v.disposition : null,
    scope: v.scope,
    current: v.current,
    proposed: v.proposed,
    policy: `pack version ${policy.version}, digest ${policy.digest.slice(0, 16)}`,
    ...(v.excluded ? { excluded: v.excluded.reason } : {}),
    ...(v.lifecycleCheck
      ? {
          lifecycle: v.lifecycleCheck.ok
            ? `${v.lifecycleCheck.lifecycleTag} leads: the lifecycle grammar holds`
            : `lifecycle_tag_not_leading (${[v.lifecycleCheck.notFirst ? `${v.lifecycleCheck.lifecycleTag} is not first` : null, v.lifecycleCheck.statusTags.length ? `it still carries ${v.lifecycleCheck.statusTags.join(', ')}` : null].filter(Boolean).join('; ')}): the audits’ own finding and fix (audit_findings)`,
        }
      : {}),
    rationale: v.slots.map((s) => ({
      slot: s.slot,
      tag: s.tag,
      source: s.source,
      ...(s.held ? { held: s.held } : {}),
    })),
    ...(v.holds.length
      ? { holds: v.holds.map((h) => ({ kind: h.kind, slot: h.slot, reason: h.reason })) }
      : {}),
    ...(v.exceptions.length ? { exceptions: v.exceptions } : {}),
    ...(v.removals.length ? { removals: v.removals } : {}),
    ...(full ? { inputs: v.inputs, classification: v.classification } : {}),
  };
}

function refusal(e: unknown, pd: ProjectDeps): McpToolResult {
  if (e instanceof RetagError) return errorResult({ code: e.code, message: e.message, ...e.details }, pd);
  return errorFromThrown(e, pd);
}

function service(pd: ProjectDeps): { ok: true; r: RetagService } | { ok: false; result: McpToolResult } {
  const r = pd.services?.retag;
  if (!r)
    return {
      ok: false,
      result: errorResult(
        { code: 'TOOL_UNAVAILABLE', message: 'The retag tools are not available here.' },
        pd,
      ),
    };
  return { ok: true, r };
}

const actorOf = (mctx: McpToolContext, tool: string): string =>
  mcpOrigin(mctx, tool).principal?.principalId ?? 'agent';

const READ_ONLY =
  'Nothing was written. Deterministic corrections can be proposed with arkona_retag_apply { runId, pages } (at most the batch size, ONE proposal for the owner). Holds go to the owner: tell them, and suggest a classification with a reason if you can (suggest: { page, primary, specialist?, reason }); only the owner classifies, on the Tagging page. Exceptions are the owner’s judgement. Never retag by hand with update_resource.';

export function retagTools(deps: ToolDeps): McpToolProvider[] {
  const listed = () => deps.services?.packs?.toolListed('arkona') ?? false;
  return [
    defineTool({
      name: 'arkona_retag_audit',
      title: 'Audit native tags against the Tagging Standard (Arkona pack, read-only)',
      access: 'read',
      description:
        'The Arkona pack, read-only and free: the Controlled Native Tagging Standard’s policy audit. Each current Authoritative page (Main CANON, or AU under the owner’s ruling) of one page (`page`), a branch (`under`) or everything (`all: true`) gets its expected array from the closed grammar and the approved pack version: its resource ID, current array, proposed array, a rationale for each slot (the fact or record it comes from), the policy version and digest, and its disposition: compliant, deterministic correction, hold (with reasons: an uncertain category, a specialist, an identity token, a status tag), or exception (an owner-level judgement, such as an existing tag outside the grammar). Working and Archived pages are checked for the lifecycle grammar only (the audits’ lifecycle_tag_not_leading); the Legacy Canon Archive, Design References, navigation indexes and repository governance are never retagged by inference. The category comes only from deterministic evidence (the owner’s classification, the page’s own pack record, or exactly one valid primary tag its Reference Type does not contradict): never from a name, a parent or the body. No unknown token is ever generated. ' +
        'A run is stored: read it again a page at a time with `runId` (and `filter`). `reconciliation: "<name>"` starts or re-audits a named reconciliation (its record across batches). `suggest: { page, primary, specialist?, reason }` records your suggested classification for a hold, for the owner (never used until the owner classifies). `suggestRuling: { page, tag, action: keep_here | allow_everywhere, reason }` records your suggested ruling on an exception (only the owner rules). The Tagging Standard’s Approved Supplementary Tags (Cosmology, Chronology, Setting Framework, as the approved pack lists them) are kept wherever they appear, after the grammar, and never removed. Nothing is ever written to LegendKeeper. ' +
        'Cost: none (the snapshots). live: true re-reads each page now (1 read each, at most 50).',
      inputSchema: z.object({
        page: z.string().min(1).max(500).optional().describe('One page (name or id).'),
        under: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe('A branch: this page and everything beneath it.'),
        all: z.boolean().optional().describe('Everything in the AI REPOSITORY.'),
        live: z.boolean().optional().describe('Re-read the pages now (1 read each, at most 50).'),
        reconciliation: z
          .string()
          .min(1)
          .max(80)
          .optional()
          .describe(
            'A named reconciliation: started with this scope (default everything), or audited again.',
          ),
        runId: z
          .string()
          .regex(/^rtg_[0-9a-f]{16}$/)
          .optional()
          .describe('Read a stored run again (nothing re-run).'),
        filter: z
          .enum(ORDER)
          .optional()
          .describe('Only these pages: a disposition, lifecycle-only or excluded.'),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional().describe('Pages per answer. Default 50.'),
        detail: z.enum(['summary', 'full']).optional().describe('"full" adds each page’s inputs.'),
        suggest: z
          .object({
            page: z.string().min(1).max(500),
            primary: z.string().min(1).max(100),
            specialist: z.string().min(1).max(100).nullable().optional(),
            reason: z.string().min(1).max(1000),
          })
          .optional()
          .describe(
            'Suggest a classification for a hold, with your reason (kept for the owner; never used by itself).',
          ),
        suggestRuling: z
          .object({
            page: z.string().min(1).max(500),
            tag: z.string().min(1).max(100),
            action: z.enum(['keep_here', 'allow_everywhere']),
            reason: z.string().min(1).max(1000),
          })
          .optional()
          .describe(
            'Suggest the owner’s ruling on an exception, with your reason: keep_here (keep this tag on this page) or allow_everywhere (add it to the Tagging Standard’s Approved Supplementary Tags). Kept for the owner; only the owner takes either action.',
          ),
        project: projectArg,
      }),
      annotations: READ_ANNOTATIONS,
      listed,
      handler: (args, mctx) =>
        withProject(deps, args.project, 'read', async (pd) => {
          const s = service(pd);
          if (!s.ok) return s.result;
          const actor = actorOf(mctx, 'arkona_retag_audit');
          try {
            // v3 F5a (ADR 0067, H2): agents suggest a ruling on an exception; only the owner takes it.
            if (args.suggestRuling) {
              const rc = repoContext(pd);
              if (!rc.ok) return rc.result;
              const r = resolvePage(rc.ctx, args.suggestRuling.page);
              if (!r.ok) return r.result;
              const saved = s.r.suggestRuling(actor, pd.project.id, {
                pageId: r.node.id,
                tag: args.suggestRuling.tag,
                action: args.suggestRuling.action,
                reason: args.suggestRuling.reason,
              });
              return finish(
                pd,
                mctx,
                'arkona_retag_audit',
                {
                  suggestedRuling: { page: { id: r.node.id, name: r.node.rawName }, ...saved },
                  note: 'Recorded for the owner, beside the exception on the Tagging page. It is NOT a ruling: only the owner keeps a tag on a page or allows it everywhere; nothing changes until then.',
                  cost: 'none',
                },
                () => ({ suggestedRuling: saved.id }),
              );
            }
            if (args.suggest) {
              const rc = repoContext(pd);
              if (!rc.ok) return rc.result;
              const r = resolvePage(rc.ctx, args.suggest.page);
              if (!r.ok) return r.result;
              const saved = s.r.suggest(actor, pd.project.id, {
                pageId: r.node.id,
                primary: args.suggest.primary,
                specialist: args.suggest.specialist ?? null,
                reason: args.suggest.reason,
              });
              return finish(
                pd,
                mctx,
                'arkona_retag_audit',
                {
                  suggested: { page: { id: r.node.id, name: r.node.rawName }, ...saved },
                  note: 'Recorded for the owner, beside the hold on the Tagging page. It is NOT a classification: only the owner classifies a page; nothing changes until then.',
                  cost: 'none',
                },
                () => ({ suggested: saved.id }),
              );
            }
            let run;
            let verdicts: readonly RetagVerdict[];
            let reconciliation: Record<string, unknown> | undefined;
            if (args.runId) {
              run = s.r.store.run(args.runId);
              if (!run || run.projectId !== pd.project.id)
                return errorResult(
                  {
                    code: 'RUN_NOT_FOUND',
                    message: `No retag run ${args.runId} in this project (old runs are pruned: audit again).`,
                  },
                  pd,
                );
              verdicts = s.r.store.verdicts(run.id);
            } else {
              const given = [args.page, args.under, args.all ? 'all' : undefined].filter(
                (x) => x !== undefined,
              );
              if (given.length > 1 || (given.length === 0 && !args.reconciliation))
                return errorResult(
                  {
                    code: 'INVALID_PARAMS',
                    message: 'Give exactly one of page, under or all: true (or runId, or a reconciliation).',
                  },
                  pd,
                );
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
              const scope = {
                ...(pageId ? { pageId } : {}),
                ...(underId ? { underId } : {}),
                ...(args.all ? { all: true } : {}),
              };
              if (args.reconciliation) {
                const out = await s.r.reconcile({
                  projectId: pd.project.id,
                  actor,
                  name: args.reconciliation,
                  ...(given.length > 0 ? { scope } : {}),
                });
                run = out.result.run;
                verdicts = out.result.verdicts;
                reconciliation = {
                  id: out.reconciliation.id,
                  name: out.reconciliation.name,
                  created: out.created,
                };
              } else {
                const out = await s.r.audit({
                  projectId: pd.project.id,
                  actor,
                  scope,
                  ...(args.live ? { live: liveReader(pd, mctx, 'arkona_retag_audit') } : {}),
                });
                run = out.run;
                verdicts = out.verdicts;
              }
            }
            const sorted = [...verdicts].sort(
              (a, b) =>
                ORDER.indexOf(filterOf(a)) - ORDER.indexOf(filterOf(b)) || a.name.localeCompare(b.name),
            );
            const list = args.filter ? sorted.filter((v) => filterOf(v) === args.filter) : sorted;
            const from = args.offset ?? 0;
            const size = args.limit ?? 50;
            const page = list.slice(from, from + size);
            const reads = (run.source.live as { reads?: number } | undefined)?.reads ?? 0;
            return finish(
              pd,
              mctx,
              'arkona_retag_audit',
              {
                runId: run.id,
                policy: run.policy,
                source: run.source,
                scope: run.scope,
                counts: run.counts,
                ...(reconciliation ? { reconciliation } : {}),
                total: list.length,
                offset: from,
                nextOffset: from + page.length < list.length ? from + page.length : null,
                pages: page.map((v) => verdictView(v, run.policy, args.detail === 'full')),
                readOnly: READ_ONLY,
                cost: args.runId ? 'none (a stored run)' : reads > 0 ? `${reads} read(s) (live)` : 'none',
              },
              () => ({ runId: run.id, counts: run.counts }),
            );
          } catch (e) {
            return refusal(e, pd);
          }
        }),
    }),
    defineTool({
      name: 'arkona_retag_apply',
      title: 'Apply deterministic tag corrections (Arkona pack, a proposal)',
      access: 'write',
      description:
        'The Arkona pack: the Tagging Standard’s separately approved, guarded apply. Takes ONLY deterministic corrections from a stored arkona_retag_audit run (`runId` and the page ids, `pages`), at most the pack’s batch size (25): ONE proposal for the owner, each page an item they can leave out (always a proposal by the pack’s switch, whatever your scope). Holds and exceptions can never be applied (RETAG_NOT_DETERMINISTIC). Status and lifecycle tags are never added or removed: an existing status tag may only move to the front. ' +
        'When the owner approves, the job first compares the policy (pack version and digest, and its governance) with the audit’s: changed, the whole job stops (“policy changed since the audit; audit again”). Then per page: a fresh read (a page whose tags differ in any way from the audit’s current array is conflicted, skipped and recorded, never rebased onto the newer array; facts changed since: held; already the proposed array: already compliant; gone: inaccessible), the write inside the page’s lock, and an independent read-back (the exact array in order; name, aliases, parentage and sidebar unchanged; each page document’s body at the same version, and each board, map and timeline document’s content, read before and after). Last Major Revision is never set (tags are not a major revision). Resume and Revert work as for any package. ' +
        '`reconciliation: "<name>"` instead: a fresh audit of what remains of that reconciliation, then its next batch proposed. Never resubmit a captured proposal: follow it with bridge_proposal_status. ' +
        'Cost: none to propose (the run is stored); the job, when approved: 3 reads for the governance, then per page 3 reads (the fresh read, the in-lock read, the read-back), 2 more for each page or board document, 4 for each map and 6 or more for each timeline (its content before and after) and 1 write.',
      inputSchema: z.object({
        runId: z
          .string()
          .regex(/^rtg_[0-9a-f]{16}$/)
          .optional()
          .describe('The stored audit run (arkona_retag_audit).'),
        pages: z
          .array(z.string().min(1).max(64))
          .min(1)
          .max(100)
          .optional()
          .describe(
            'The page ids to correct: deterministic corrections of that run only, at most the batch size.',
          ),
        reconciliation: z
          .string()
          .min(1)
          .max(80)
          .optional()
          .describe('Resume a named reconciliation: a fresh audit of what remains, then its next batch.'),
        project: projectArg,
      }),
      annotations: CREATE_ANNOTATIONS,
      listed,
      handler: (args, mctx) =>
        withProject(deps, args.project, 'write', async (pd) => {
          const s = service(pd);
          if (!s.ok) return s.result;
          const origin = mcpOrigin(mctx, 'arkona_retag_apply');
          const actor = origin.principal?.principalId ?? 'agent';
          try {
            if (args.reconciliation) {
              if (args.runId || args.pages)
                return errorResult(
                  {
                    code: 'INVALID_PARAMS',
                    message: 'Give a reconciliation, or a runId with pages: not both.',
                  },
                  pd,
                );
              const rec = s.r.store.reconciliationByName(pd.project.id, args.reconciliation);
              if (!rec)
                return errorResult(
                  {
                    code: 'RECONCILIATION_NOT_FOUND',
                    message: `No reconciliation “${args.reconciliation}”: start one with arkona_retag_audit { reconciliation }.`,
                  },
                  pd,
                );
              const r = await s.r.resume({
                projectId: pd.project.id,
                reconciliationId: rec.id,
                actor,
                origin,
              });
              return render(
                {
                  status: r.status,
                  reconciliation: { id: rec.id, name: rec.name },
                  counts: r.view.counts,
                  ...(r.audit ? { runId: r.audit.run.id, audited: r.audit.run.counts } : {}),
                  ...(r.batch
                    ? {
                        batch: r.batch.batch.id,
                        pages: r.batch.batch.pages.map((p) => ({
                          id: p.pageId,
                          name: p.name,
                          from: p.current,
                          to: p.proposed,
                        })),
                        ...(r.batch.proposalId
                          ? {
                              proposalId: r.batch.proposalId,
                              hint: 'ONE proposal for the owner, NOT applied. Never resubmit it; follow it with bridge_proposal_status.',
                            }
                          : { jobId: r.batch.jobId }),
                      }
                    : {
                        message:
                          r.status === 'nothing_remaining'
                            ? 'Nothing remains to propose: every page is compliant, applied, held or an exception (holds and exceptions go to the owner).'
                            : 'The fresh audit found no deterministic correction among what remains (holds and exceptions go to the owner).',
                      }),
                  cost: 'none (the snapshots)',
                },
                pd,
              );
            }
            if (!args.runId || !args.pages)
              return errorResult(
                {
                  code: 'INVALID_PARAMS',
                  message:
                    'Give runId and pages (the deterministic corrections to apply), or a reconciliation.',
                },
                pd,
              );
            const plan = s.r.planApply({ projectId: pd.project.id, runId: args.runId, pageIds: args.pages });
            const sub = await s.r.submitApply(plan, { projectId: pd.project.id, origin, actor });
            if (sub.proposalId)
              return render(
                {
                  status: 'proposal_captured',
                  proposalId: sub.proposalId,
                  summary: sub.summary ?? plan.title,
                  batch: sub.batch.id,
                  runId: plan.runId,
                  policy: { version: plan.policy.version, digest: plan.policy.digest },
                  pages: plan.pages.map((p) => ({
                    id: p.pageId,
                    name: p.name,
                    from: p.current,
                    to: p.proposed,
                  })),
                  hint:
                    plan.mode === 'scope'
                      ? RAIL_HINT
                      : 'ONE proposal for the owner, each page an item; NOT applied. Never resubmit it; follow it with bridge_proposal_status.',
                  ...(plan.mode === 'scope'
                    ? railBody({ proposedBecause: 'the owner’s scope or safety rails' })
                    : {}),
                  cost: 'none until approved',
                },
                pd,
              );
            const view = await pd.engine.wait(pd.project.id, sub.jobId!, 25_000);
            return describeJob(pd, view, plan.labels, { batch: sub.batch.id, runId: plan.runId }).result;
          } catch (e) {
            return refusal(e, pd);
          }
        }),
    }),
  ];
}
