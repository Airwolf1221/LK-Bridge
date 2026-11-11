/**
 * Bridge-awareness tools (PLAN §5.4, §6, §7): info, budget, estimate, job status / wait / cancel, recent errors,
 * the write journal and paging of stored results. None of them is an LK write; `bridge_info` may make up to two
 * cached reads, everything else costs no LegendKeeper budget.
 */
import * as z from 'zod';
import type { JobView, JobWithSteps, StepView } from '../../jobs/index.js';
import type { McpToolContext } from '../server.js';
import { TERMINAL_JOB_STATUSES } from '../../jobs/index.js';
import type { BudgetSnapshot, TierSnapshot } from '../../lk/index.js';
import { defineTool, READ_ANNOTATIONS } from './define.js';
import {
  errorFromThrown,
  errorResult,
  footerFor,
  mcpOrigin,
  project,
  projectArg,
  render,
  summarise,
  withProject,
  type ProjectDeps,
  type ToolDeps,
} from './shape.js';

const iso = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? null : new Date(ms).toISOString();

// ------------------------------------------------------------------------------------------------ info

interface ProjectLookup {
  readonly name: string | null;
  readonly role: 'ADMIN' | 'MEMBER' | 'unknown';
  readonly at: number;
  readonly note?: string;
}

const LOOKUP_TTL_MS = 10 * 60_000;

/**
 * The shared lookup's own origin (v1.0.1, F-21). The lookup is the bridge's work, cached for every caller, so its reads
 * and any error they record belong to the `system` principal (the origin carries no principal), not to whichever
 * connection happened to trigger the refresh. P1, as an interactive call would be: it runs while an agent waits.
 */
export const BRIDGE_INFO_LOOKUP_ORIGIN = {
  kind: 'system',
  client: 'bridge',
  tool: 'bridge_info',
  detail: 'shared project lookup (cached 10 minutes)',
} as const;

/**
 * Project name and the key's role, from LK, cached per project (each project has its own key): bridge_info must stay
 * cheap and must never fail on budget.
 */
function projectLookup(deps: ToolDeps) {
  const cache = new Map<string, ProjectLookup>();
  const inFlight = new Map<string, Promise<ProjectLookup>>();
  const now = deps.now ?? Date.now;
  return async (ctx: Parameters<typeof mcpOrigin>[0], projectId: string): Promise<ProjectLookup> => {
    // Only a caller with a principal gets here at all (mcpOrigin refuses one without), but the lookup itself runs
    // as the bridge's own work.
    mcpOrigin(ctx, 'bridge_info');
    const cached = cache.get(projectId);
    if (cached && now() - cached.at < LOOKUP_TTL_MS) return cached;
    let pending = inFlight.get(projectId);
    if (!pending) {
      pending = (async () => {
        let name: string | null = null;
        let role: ProjectLookup['role'] = 'unknown';
        let note: string | undefined;
        try {
          const origin = BRIDGE_INFO_LOOKUP_ORIGIN;
          const priority = 'P1';
          // The registry takes no projectId: the client supplies the configured project (as the dashboard's health
          // check does). Passing `{ path: … }` is rejected by the registry's schema, which left role and name unknown.
          const p = await deps.engine.run('getProject', {}, { origin, priority, project: projectId });
          if (p.status === 'succeeded')
            name = ((p.result as { name?: unknown })?.name as string | undefined) ?? null;
          const m = await deps.engine.run('listMembers', {}, { origin, priority, project: projectId });
          if (m.status === 'succeeded') {
            // LK shows member emails only to ADMIN keys: that is the cheapest honest probe of the key's role.
            const members = ((m.result as { data?: { email?: unknown }[] })?.data ?? []) as {
              email?: unknown;
            }[];
            if (members.some((x) => typeof x.email === 'string')) role = 'ADMIN';
            else if (members.length > 0) role = 'MEMBER';
            note = 'role inferred from listMembers (emails are visible to ADMIN keys only)';
          }
        } catch (e) {
          note = `LegendKeeper lookup unavailable (${(e as { code?: string }).code ?? 'error'}); showing what is known`;
        }
        const value: ProjectLookup = { name, role, at: now(), ...(note ? { note } : {}) };
        cache.set(projectId, value);
        return value;
      })().finally(() => {
        inFlight.delete(projectId);
      });
      inFlight.set(projectId, pending);
    }
    return pending;
  };
}

function infoTool(deps: ToolDeps) {
  const lookup = projectLookup(deps);
  return defineTool({
    name: 'bridge_info',
    title: 'Bridge information',
    access: 'read',
    description:
      'Shows the LK-Bridge version, the LegendKeeper project asked for (default: the default project; its name, id and the key’s role), ' +
      'the read-only flags (the bridge’s and the project’s own), the writer pool, whether writes are paused or the bridge is draining, ' +
      'the other projects this bridge serves, and which connection is calling with its profile and scope (read, propose or write). ' +
      'Cost: up to 2 cached reads (10 minutes), usually none. Risk: none. Call it first to learn whether writes are possible.',
    inputSchema: z.object({ project: projectArg }),
    annotations: READ_ANNOTATIONS,
    handler: ({ project: asked }, ctx) =>
      withProject(deps, asked, 'read', async (pd) => {
        const bridgeControls = deps.engine.queries.controls();
        const controls = deps.engine.queries.controls(pd.project.id);
        const writers = deps.engine.queries.writers();
        const available = controls.project?.available ?? false;
        const looked = available
          ? await lookup(ctx, pd.project.id)
          : { name: null, role: 'unknown' as const, note: 'the project is not served now' };
        const view = deps.projects.resolve(pd.project.id);
        return render(
          {
            bridge: 'LK-Bridge',
            version: deps.version,
            project: pd.project.name,
            // `project` (the name) is on every result; the details of the project asked for are here.
            projectInfo: {
              name: pd.project.name,
              id: pd.project.id,
              // LegendKeeper's own name for it: looked up live (cached), else as it was at the last key check.
              displayName: looked.name ?? view?.displayName ?? null,
              default: pd.project.isDefault,
              readOnly: controls.project?.readOnly ?? false,
              available,
            },
            projects: deps.projects.configuredNames(),
            key: { role: looked.role, ...(looked.note ? { note: looked.note } : {}) },
            readOnly: {
              effective: controls.readOnly,
              bridge: bridgeControls.readOnly,
              project: controls.project?.readOnly ?? false,
              configured: deps.configuredReadOnly,
              overridden: controls.readOnlyOverride !== null,
            },
            writes: {
              paused: controls.writesPaused,
              draining: controls.draining,
              canWrite: available && !controls.readOnly && !controls.writesPaused && !controls.draining,
            },
            writers: { max: controls.writersMax, busy: writers.busy, waiting: writers.waiting.length },
            memberAdminEnabled: controls.allowMemberAdmin,
            uploads: {
              maxBytes: deps.settings.upload.maxBytes,
              urlSource: deps.settings.upload.allowUrlSource,
            },
            caller: ctx.caller
              ? { kind: ctx.caller.kind, clientId: ctx.caller.clientId, label: ctx.caller.label ?? null }
              : null,
            // The calling connection's policy profile and its live scope (docs/policy.md).
            profile: ctx.principal?.profile ?? null,
            scope: ctx.scope ?? null,
            principalId: ctx.principal?.principalId ?? null,
            canWriteAs:
              ctx.scope === 'write'
                ? 'direct'
                : ctx.scope === 'propose'
                  ? 'proposal (the owner approves)'
                  : 'no (read-only)',
          },
          pd,
        );
      }),
  });
}

// ------------------------------------------------------------------------------------------------ projects

function listProjectsTool(deps: ToolDeps) {
  return defineTool({
    name: 'list_projects',
    title: 'List projects',
    access: 'read',
    description:
      'Lists the LegendKeeper projects this bridge serves: name (pass it as `project` to any tool), LegendKeeper id, display ' +
      'name, which is the default (reads without `project` use it) and whether the project is read-only. Writes must name ' +
      'their project when there are several. Cost: none. Risk: none.',
    inputSchema: z.object({}),
    annotations: READ_ANNOTATIONS,
    handler: () => {
      const all = deps.projects.list().filter((p) => p.configured);
      const def = deps.projects.defaultProject();
      // Never the sandbox flag, never a key or the name of its variable.
      const body = {
        project: def.name,
        count: all.length,
        default: def.name,
        writesNeedProject: deps.selector.requireForWrites && all.length > 1,
        projects: all.map((p) => ({
          name: p.name,
          id: p.id,
          displayName: p.displayName,
          default: p.isDefault,
          readOnly: p.readOnly,
          available: p.status === 'active',
          ...(p.status !== 'active' && p.reason ? { reason: p.reason } : {}),
        })),
      };
      const text = `${JSON.stringify(body)}\n${footerFor(deps, def.id, def.name)}`;
      return { content: [{ type: 'text' as const, text }] };
    },
  });
}

// ------------------------------------------------------------------------------------------------ budget

function tierRow(t: TierSnapshot, now: number) {
  return {
    tier: t.tier,
    used: t.used,
    limit: t.limit,
    remaining: t.remaining,
    ...(t.resetAtMs !== null ? { resetsInSeconds: Math.max(0, Math.ceil((t.resetAtMs - now) / 1000)) } : {}),
    ...(t.blockedUntilMs !== null
      ? { blockedForSeconds: Math.max(0, Math.ceil((t.blockedUntilMs - now) / 1000)) }
      : {}),
    ...(t.reactiveOnly ? { reactiveOnly: true } : {}),
    ...(t.drift && Math.abs(t.drift.delta) > 0 ? { drift: t.drift.delta } : {}),
  };
}

export function budgetBody(s: BudgetSnapshot) {
  return {
    tiers: Object.values(s.tiers).map((t) => tierRow(t, s.atMs)),
    queues: s.queues,
    inFlight: s.inFlight,
    writeSpacingMs: s.writeSpacingMs,
    nextWriteInSeconds:
      s.nextWriteAtMs === null ? 0 : Math.max(0, Math.ceil((s.nextWriteAtMs - s.atMs) / 1000)),
    note: 'Interactive calls (P1) may use down to the interactive reserve; jobs (P2) leave more headroom.',
  };
}

// ------------------------------------------------------------------------------------------------ jobs

const SECRET_KEYS = new Set(['uploadUrl', 'headers', 'uploadKey']);

/** Strips signed-URL material from anything shown to an agent. */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SECRET_KEYS.has(k) ? '[redacted]' : redact(v),
      ]),
    );
  }
  return value;
}

function stepRow(s: StepView) {
  return {
    step: s.stepNo,
    op: s.opId,
    status: s.status,
    attempts: s.attempts,
    ...(s.requestIds.length > 0 ? { requestIds: s.requestIds.slice(-3) } : {}),
    ...(s.error
      ? { error: { code: s.error.code, message: s.error.message, requestId: s.error.requestId } }
      : {}),
    ...(s.status === 'succeeded' && s.resultSummary ? { result: project(redact(s.resultSummary)) } : {}),
  };
}

export function jobBody(job: JobView | JobWithSteps, detail: 'summary' | 'steps') {
  const steps = 'steps' in job ? job.steps : [];
  const interesting = steps.filter((s) => s.status === 'failed' || s.status === 'uncertain');
  return {
    jobId: job.id,
    kind: job.kind,
    title: job.title,
    status: job.status,
    done: TERMINAL_JOB_STATUSES.has(job.status),
    progress: job.progress,
    ...(job.currentStep !== null ? { currentStep: job.currentStep } : {}),
    ...(job.resumeAt !== null ? { resumeAt: iso(job.resumeAt) } : {}),
    ...(job.waitReason ? { waitReason: job.waitReason } : {}),
    ...(job.uncertain
      ? { uncertain: true, hint: 'A step may or may not have applied; check LegendKeeper before retrying.' }
      : {}),
    ...(job.lastError
      ? {
          lastError: {
            code: job.lastError.code,
            message: job.lastError.message,
            requestId: job.lastError.requestId,
            stepNo: job.lastError.stepNo,
          },
        }
      : {}),
    ...(job.result ? { result: redact(job.result) } : {}),
    createdAt: iso(job.createdAt),
    ...(job.finishedAt !== null ? { finishedAt: iso(job.finishedAt) } : {}),
    ...(detail === 'steps'
      ? {
          steps: steps.slice(0, 100).map(stepRow),
          ...(steps.length > 100 ? { stepsTruncated: steps.length - 100 } : {}),
        }
      : interesting.length > 0
        ? { failedSteps: interesting.slice(0, 20).map(stepRow) }
        : {}),
  };
}

// ------------------------------------------------------------------------------------------------ visibility

/**
 * Agents see only their OWN jobs, errors and stored results (chunk 2b): those whose principal is the caller's. A job
 * of another principal answers exactly like an unknown id, so its existence is never revealed.
 */
function callerId(ctx: McpToolContext): string | undefined {
  return ctx.principal?.principalId;
}

/** The caller's own job in the call's project; another principal's job, or another project's, is "not found". */
function ownJob(deps: ProjectDeps, ctx: McpToolContext, id: string): JobWithSteps | undefined {
  const who = callerId(ctx);
  const job = who === undefined ? undefined : deps.engine.queries.getJob(deps.project.id, id);
  return job && job.principalId === who ? job : undefined;
}

const jobNotFound = (deps: ProjectDeps, id: string) =>
  errorResult(
    {
      code: 'JOB_NOT_FOUND',
      message: `No job ${id} in project "${deps.project.name}"`,
      hint: 'Jobs belong to a project: pass the project the job was started in.',
    },
    deps,
  );

function jobTools(deps: ToolDeps) {
  const jobId = z.string().min(1).max(100);
  return [
    defineTool({
      name: 'bridge_job_status',
      title: 'Job status',
      access: 'read',
      description:
        'Shows one job (from lk_api_batch, lk_api_paginate_all, lk_upload_image or a queued write): status, progress, the current step, ' +
        'the last error and its result. Without jobId, lists your recent jobs. Only your own jobs are visible. Cost: none. Risk: none.',
      inputSchema: z.object({
        jobId: jobId.optional(),
        steps: z
          .boolean()
          .optional()
          .describe('Include a row per step (first 100). Failed steps are always shown.'),
        status: z
          .enum([
            'queued',
            'running',
            'waiting_budget',
            'waiting_lock',
            'paused',
            'succeeded',
            'failed',
            'cancelled',
          ])
          .optional()
          .describe('When listing: only jobs in this status.'),
        limit: z.number().int().min(1).max(50).optional().describe('When listing: default 10.'),
        project: projectArg,
      }),
      annotations: READ_ANNOTATIONS,
      handler: ({ jobId: id, steps, status, limit, project: asked }, ctx) =>
        withProject(deps, asked, 'read', (pd) => {
          if (id === undefined) {
            const who = callerId(ctx);
            const jobs =
              who === undefined
                ? []
                : deps.engine.queries.listJobs(pd.project.id, {
                    principalId: who,
                    ...(status ? { status } : {}),
                    limit: limit ?? 10,
                  });
            return render(
              {
                count: jobs.length,
                jobs: jobs.map((j) => ({
                  jobId: j.id,
                  kind: j.kind,
                  title: j.title,
                  status: j.status,
                  progress: j.progress,
                  createdAt: iso(j.createdAt),
                })),
              },
              pd,
            );
          }
          const job = ownJob(pd, ctx, id);
          if (!job) return jobNotFound(pd, id);
          return render(jobBody(job, steps ? 'steps' : 'summary'), pd);
        }),
    }),
    defineTool({
      name: 'bridge_job_wait',
      title: 'Wait for a job',
      access: 'read',
      description:
        'Waits for a job to finish, at most 25 seconds, then returns its status as it then stands (done: true when finished). ' +
        'Call it again if done is false. Cost: none. Risk: none.',
      inputSchema: z.object({
        jobId,
        seconds: z.number().min(1).max(25).optional().describe('How long to wait, 1-25. Default 20.'),
        project: projectArg,
      }),
      annotations: READ_ANNOTATIONS,
      handler: ({ jobId: id, seconds, project: asked }, ctx) =>
        withProject(deps, asked, 'read', async (pd) => {
          // Checked before waiting, so another principal's job returns at once, exactly like an unknown id.
          if (!ownJob(pd, ctx, id)) return jobNotFound(pd, id);
          try {
            await deps.engine.wait(pd.project.id, id, Math.min(25, seconds ?? 20) * 1000);
            const job = ownJob(pd, ctx, id);
            return job ? render(jobBody(job, 'summary'), pd) : jobNotFound(pd, id);
          } catch (e) {
            return errorFromThrown(e, pd);
          }
        }),
    }),
    defineTool({
      name: 'bridge_job_cancel',
      title: 'Cancel a job',
      access: 'write',
      description:
        'Cancels a job: the step in flight finishes, nothing further is sent, and the remaining steps are cancelled. ' +
        'Steps already done are not undone. Cost: none. Risk: low (stops pending work).',
      inputSchema: z.object({ jobId, project: projectArg }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: ({ jobId: id, project: asked }, ctx) =>
        withProject(deps, asked, 'write', (pd) => {
          const own = ownJob(pd, ctx, id);
          if (!own) return jobNotFound(pd, id);
          // CR-2026-11 (CR-19): an approved proposal's job runs as its proposer, but it is the owner's work now; stopping
          // it part-way (a lifecycle change, canon accepted) is the owner's decision, on the dashboard.
          if (own.approvedBy !== null) {
            return errorResult(
              {
                code: 'OWNER_APPROVED_JOB',
                message: `Job ${id} runs work the owner approved; only the owner can cancel it (on the dashboard's Jobs page). Nothing was changed.`,
              },
              pd,
            );
          }
          try {
            const job = deps.engine.controls.cancel(pd.project.id, id);
            return render(jobBody(deps.engine.queries.getJob(pd.project.id, job.id) ?? job, 'summary'), pd);
          } catch (e) {
            return errorFromThrown(e, pd);
          }
        }),
    }),
  ];
}

// ------------------------------------------------------------------------------------------------ the rest

function otherTools(deps: ToolDeps) {
  return [
    defineTool({
      name: 'bridge_budget',
      title: 'Rate budget',
      access: 'read',
      description:
        'Shows every rate tier of one project (used, limit, remaining, time to reset, any block after a 429), the queue depth per ' +
        'priority class and the write pacing. Each project has its own key and so its own budget; allProjects: true shows every ' +
        'project side by side. The same numbers, in one line, end every tool result. Cost: none. Risk: none.',
      inputSchema: z.object({
        project: projectArg,
        allProjects: z.boolean().optional().describe('Every project’s budget, side by side.'),
      }),
      annotations: READ_ANNOTATIONS,
      handler: ({ project: asked, allProjects }) =>
        withProject(deps, asked, 'read', (pd) => {
          if (allProjects === true) {
            return render(
              {
                project: pd.project.name,
                allProjects: deps.projects
                  .list()
                  .filter((p) => p.configured)
                  .map((p) => {
                    const lk = p.id !== null ? deps.projects.anyClient(p.id) : undefined;
                    return {
                      name: p.name,
                      id: p.id,
                      available: p.status === 'active',
                      ...(lk ? { budget: budgetBody(lk.governor.snapshot()) } : { budget: null }),
                    };
                  }),
              },
              pd,
            );
          }
          const lk = deps.projects.anyClient(pd.project.id);
          if (!lk) {
            return errorResult(
              { code: 'PROJECT_UNAVAILABLE', message: `Project "${pd.project.name}" has no budget now.` },
              pd,
            );
          }
          return render(budgetBody(lk.governor.snapshot()), pd);
        }),
    }),
    defineTool({
      name: 'bridge_estimate',
      title: 'Estimate a workload',
      access: 'read',
      description:
        'Projects how long a planned workload takes under the current budget and whether it fits today: ' +
        'give counts of reads, writes and createMany items. Call it BEFORE any large workload (hundreds of calls). ' +
        'Cost: none. Risk: none.',
      inputSchema: z.object({
        reads: z.number().int().min(0).max(1_000_000).optional(),
        writes: z.number().int().min(0).max(1_000_000).optional(),
        createManyItems: z
          .number()
          .int()
          .min(0)
          .max(1_000_000)
          .optional()
          .describe('Items created through createManyResources.'),
        priority: z
          .enum(['P1', 'P2', 'P3'])
          .optional()
          .describe('P1 interactive, P2 job (default), P3 maintenance.'),
        project: projectArg,
      }),
      annotations: READ_ANNOTATIONS,
      handler: ({ reads, writes, createManyItems, priority, project: asked }) =>
        withProject(deps, asked, 'read', (pd) => {
          const lk = deps.projects.anyClient(pd.project.id);
          if (!lk) {
            return errorResult(
              { code: 'PROJECT_UNAVAILABLE', message: `Project "${pd.project.name}" has no budget now.` },
              pd,
            );
          }
          const e = lk.governor.estimate({
            reads: reads ?? 0,
            writes: writes ?? 0,
            createManyItems: createManyItems ?? 0,
            priority: priority ?? 'P2',
          });
          const minutes = Math.round((e.wallClockMs / 60_000) * 10) / 10;
          return render(
            {
              wallClockSeconds: Math.round(e.wallClockMs / 1000),
              wallClock: minutes < 1 ? `${Math.round(e.wallClockMs / 1000)} s` : `${minutes} min`,
              tightestTier: e.tightestTier,
              fitsToday: e.fitsToday,
              dayRemaining: e.dayRemaining,
              dayNeeded: e.dayNeeded,
              calls: e.calls,
              advice: !e.fitsToday
                ? 'This does not fit in today’s request budget. Split it over several days or reduce it.'
                : e.wallClockMs > 60_000
                  ? 'Run it with lk_api_batch (a job), not as a loop of single calls.'
                  : 'Fits comfortably.',
            },
            pd,
          );
        }),
    }),
    defineTool({
      name: 'bridge_errors_recent',
      title: 'Recent errors',
      access: 'read',
      description:
        'Lists recent failures of YOUR calls: grouped by operation, code and path with counts (default), or one row each. ' +
        'Each carries the LegendKeeper requestId. Cost: none. Risk: none.',
      inputSchema: z.object({
        grouped: z.boolean().optional().describe('Default true: one row per fingerprint with a count.'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 20.'),
        sinceMinutes: z
          .number()
          .min(1)
          .max(60 * 24 * 30)
          .optional(),
        jobId: z.string().max(100).optional().describe('Only when grouped is false.'),
        project: projectArg,
      }),
      annotations: READ_ANNOTATIONS,
      handler: ({ grouped, limit, sinceMinutes, jobId, project: asked }, ctx) =>
        withProject(deps, asked, 'read', (pd) => {
          const since = sinceMinutes ? (deps.now ?? Date.now)() - sinceMinutes * 60_000 : undefined;
          // Only the caller's own failures (by principal); nobody else's errors, request ids or job ids.
          const principalId = callerId(ctx) ?? 'unknown-caller';
          if (grouped === false) {
            const rows = deps.engine.queries.listErrors(pd.project.id, {
              principalId,
              limit: limit ?? 20,
              ...(since !== undefined ? { since } : {}),
              ...(jobId ? { jobId } : {}),
            });
            return render(
              {
                count: rows.length,
                errors: rows.map((r) => ({
                  at: iso(r.at),
                  op: r.opId,
                  status: r.status,
                  code: r.code,
                  message: r.message,
                  requestId: r.requestId,
                  classification: r.classification,
                  jobId: r.jobId,
                  retryable: r.retryable,
                })),
              },
              pd,
            );
          }
          const groups = deps.engine.queries.listErrorGroups(pd.project.id, {
            principalId,
            limit: limit ?? 20,
            ...(since !== undefined ? { since } : {}),
          });
          return render(
            {
              count: groups.length,
              groups: groups.map((g) => ({
                op: g.opId,
                code: g.code,
                path: g.path || undefined,
                classification: g.classification,
                count: g.count,
                firstSeen: iso(g.firstSeen),
                lastSeen: iso(g.lastSeen),
                resolved: g.resolved,
                lastMessage: g.lastMessage,
                lastRequestId: g.lastRequestId,
                lastJobId: g.lastJobId,
              })),
            },
            pd,
          );
        }),
    }),
    defineTool({
      name: 'bridge_journal_lookup',
      title: 'Write journal',
      access: 'read',
      description:
        'Looks up the write journal: EVERY write the bridge has sent (creates, inserts, updates and deletes), newest first, with ' +
        'its operation, target, time, outcome, principal (the connection’s name, with “removed <date>” once the owner has removed it), profile and approver. Destructive writes also keep a pre-image ' +
        '(previous blocks, board, metadata, or ids). Use it to see what changed and who changed it: it shows every connection’s ' +
        'writes, so agents can cross-check each other; job ids appear on your own entries only. Filter by resource, document, ' +
        'target id, operation, principal, profile or outcome; page older entries with before (the nextBefore of the previous page). ' +
        'Pre-images can be large (they are paged like other big results). Cost: none. Risk: none.',
      inputSchema: z.object({
        resourceId: z.string().max(256).optional(),
        documentId: z.string().max(256).optional(),
        targetId: z
          .string()
          .max(256)
          .optional()
          .describe(
            'Also finds every resource a createManyResources created. A property, row, link-item or block id is unique ' +
              'only within its page (copies of one template share them): give resourceId with it, or only page and ' +
              'document targets match.',
          ),
        operationId: z.string().max(100).optional(),
        jobId: z.string().max(100).optional(),
        principalId: z
          .string()
          .max(100)
          .optional()
          .describe('Only this connection’s writes (grant_… or pat_…).'),
        profile: z
          .string()
          .max(100)
          .optional()
          .describe('Only writes made under this profile, e.g. "chatgpt".'),
        outcome: z
          .enum(['applied', 'pending', 'not_applied', 'unknown'])
          .optional()
          .describe(
            'applied: LegendKeeper made the change; not_applied: refused; unknown: could not be confirmed.',
          ),
        withPreImage: z.boolean().optional().describe('Only destructive writes, which keep a pre-image.'),
        before: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Paging: entries older than this journal id (nextBefore of the previous page).'),
        sinceMinutes: z
          .number()
          .min(1)
          .max(60 * 24 * 365)
          .optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Default 10.'),
        includePreImage: z
          .boolean()
          .optional()
          .describe('Default false: metadata only. True adds the stored pre-images.'),
        project: projectArg,
      }),
      annotations: READ_ANNOTATIONS,
      handler: (
        {
          project: asked,
          resourceId,
          documentId,
          targetId,
          operationId,
          jobId,
          principalId,
          profile,
          outcome,
          withPreImage,
          before,
          sinceMinutes,
          limit,
          includePreImage,
        },
        ctx,
      ) =>
        withProject(deps, asked, 'read', (pd) => {
          // Every principal's entries are shown (agents cross-check each other's edits), each with its principal and
          // profile; job ids, which the job tools keep private, only on the caller's own entries.
          const who = callerId(ctx);
          const foreignJob = jobId !== undefined && !ownJob(pd, ctx, jobId);
          const entries = foreignJob
            ? []
            : deps.engine.queries.journalLookup(pd.project.id, {
                ...(resourceId ? { resourceId } : {}),
                ...(documentId ? { documentId } : {}),
                ...(targetId ? { targetId } : {}),
                ...(operationId ? { opId: operationId } : {}),
                ...(jobId ? { jobId } : {}),
                ...(principalId ? { principalId } : {}),
                ...(profile ? { profile } : {}),
                ...(outcome ? { outcome } : {}),
                ...(withPreImage === true ? { withPreImage: true } : {}),
                ...(before !== undefined ? { before } : {}),
                ...(sinceMinutes ? { since: (deps.now ?? Date.now)() - sinceMinutes * 60_000 } : {}),
                limit: limit ?? 10,
                includePreImage: includePreImage === true,
              });
          const pageSize = limit ?? 10;
          // A removed connection is still named (from its tombstone): never a bare id, never an empty name.
          const names = deps.principalNames?.(entries.map((e) => e.principalId));
          const body = {
            count: entries.length,
            // Paging (chunk 8): the journal records every write, so there are many entries; ask again with before.
            nextBefore: entries.length === pageSize ? (entries.at(-1)?.id ?? null) : null,
            entries: entries.map((e) => ({
              id: e.id,
              at: iso(e.at),
              op: e.opId,
              risk: e.risk,
              outcome: e.outcome,
              target: {
                kind: e.targetKind,
                id: e.targetId,
                resourceId: e.resourceId,
                documentId: e.documentId,
              },
              version: e.version,
              // v2 C1: the high-level operation (write_page: mode, section, a hash of the Markdown…).
              ...(e.operation !== null && e.operation !== undefined ? { operation: e.operation } : {}),
              jobId: e.principalId === who ? e.jobId : null,
              principalId: e.principalId,
              principal: names?.get(e.principalId)?.name ?? `${e.profile} connection`,
              profile: e.profile,
              approvedBy: e.approvedBy,
              mine: e.principalId === who,
              bytes: e.bytes,
              ...(includePreImage === true ? { preImage: e.preImage } : {}),
            })),
          };
          if (JSON.stringify(body).length <= deps.settings.resultMaxChars) return render(body, pd);
          const stored = deps.engine.recordResult({
            project: pd.project.id,
            opId: 'bridge_journal_lookup',
            params: {},
            value: body,
            origin: mcpOrigin(ctx, 'bridge_journal_lookup'),
            title: 'journal lookup (stored result)',
          });
          return render(
            {
              status: 'stored',
              handle: stored.artifactId,
              count: entries.length,
              hint: 'Too large to return at once. Page it with bridge_result_page({ handle, offset }), or look up fewer entries.',
            },
            pd,
          );
        }),
    }),
    defineTool({
      name: 'bridge_result_page',
      title: 'Page a stored result',
      access: 'read',
      description:
        'Pages a stored result by handle: the items of a lk_api_paginate_all job (offset and limit count items), or an oversized result ' +
        'another tool stored (offset counts characters). Each page stays well under the output limit; use nextOffset for the next one. ' +
        'Items are summarised unless detail is "full". Cost: none. Risk: none.',
      inputSchema: z.object({
        handle: z.string().min(1).max(100),
        offset: z.number().int().min(0).optional().describe('Default 0.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('Items per page (item handles). Default 50.'),
        detail: z.enum(['summary', 'full']).optional().describe('Items only. Default summary.'),
        project: projectArg,
      }),
      annotations: READ_ANNOTATIONS,
      handler: ({ handle, offset, limit, detail, project: asked }, ctx) =>
        withProject(deps, asked, 'read', (pd) => {
          const page = deps.engine.queries.readArtifact(pd.project.id, handle, {
            offset: offset ?? 0,
            limit: Math.min(limit ?? 50, 500),
          });
          // A stored result belongs to the job that stored it: someone else's handle is "not found".
          if (!page || !ownJob(pd, ctx, page.artifact.jobId))
            return errorResult(
              {
                code: 'HANDLE_NOT_FOUND',
                message: `No stored result ${handle} in project "${pd.project.name}"`,
              },
              pd,
            );
          const maxChars = Math.floor(deps.settings.resultMaxChars * 0.75);
          const a = page.artifact;
          if (page.items) {
            // Trim the page to the output budget: never return more than maxChars of items.
            const shaped = page.items.map((x) => (detail === 'full' ? x : project(x)));
            const kept: unknown[] = [];
            let chars = 0;
            for (const item of shaped) {
              const n = (JSON.stringify(item) ?? '').length + 1;
              if (kept.length > 0 && chars + n > maxChars) break;
              kept.push(item);
              chars += n;
            }
            const start = offset ?? 0;
            const next = start + kept.length;
            return render(
              {
                handle,
                kind: 'items',
                total: a.itemCount,
                offset: start,
                count: kept.length,
                nextOffset: next < a.itemCount ? next : null,
                ...(a.truncated ? { truncated: true, truncatedReason: a.truncatedReason } : {}),
                items: kept,
              },
              pd,
            );
          }
          const text = JSON.stringify(page.data) ?? 'null';
          const start = Math.min(offset ?? 0, text.length);
          const end = Math.min(text.length, start + maxChars);
          return render(
            {
              handle,
              kind: 'result',
              totalChars: text.length,
              offset: start,
              nextOffset: end < text.length ? end : null,
              note: 'A slice of the stored JSON text; concatenate the slices in order.',
              text: text.slice(start, end),
            },
            pd,
          );
        }),
    }),
  ];
}

export function bridgeTools(deps: ToolDeps) {
  const other = otherTools(deps);
  return [listProjectsTool(deps), infoTool(deps), ...other.slice(0, 2), ...jobTools(deps), ...other.slice(2)];
}

// `summarise` is part of the shaping contract; re-exported for tests.
export { summarise };
