/**
 * Bridge-awareness tools (PLAN §5.4, §6, §7): info, budget, estimate, job status / wait / cancel, recent errors,
 * the write journal and paging of stored results. None of them is an LK write; `bridge_info` may make up to two
 * cached reads, everything else costs no LegendKeeper budget.
 */
import * as z from 'zod';
import type { JobView, JobWithSteps, StepView } from '../../jobs/index.js';
import type { McpToolContext } from '../server.js';
import { TERMINAL_JOB_STATUSES } from '../../jobs/index.js';
import type { BudgetSnapshot, OperationTierSnapshot, TierSnapshot } from '../../lk/index.js';
import { defineTool, READ_ANNOTATIONS, renamedTool } from './define.js';
import { ResumeError } from '../../resume/service.js';
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
      'Shows the bridge version, the project’s name and your key’s role, the read-only and paused flags, the writer pool, and who YOU are: your profile, your live scope (read, propose or write) and whether your writes are direct or proposals. Use it to learn what you may do; for the budget use bridge_budget. Cost: usually none (cached for 10 minutes).',
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
      'Lists the projects this bridge serves: name (pass it as `project`), id, which is the default (reads without `project` use it) and whether it is read-only. Use it when unsure which project to use; a write must name its project when there are several. Cost: none.',
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

/** v2 E5.5: a limit LegendKeeper reported for one operation group (it paces only that group's calls). */
function learnedRow(t: OperationTierSnapshot, now: number) {
  return {
    group: t.group,
    ops: t.ops,
    limit: t.limit,
    window: t.windowMs <= 60_000 ? 'minute' : t.windowMs <= 3_600_000 ? 'hour' : 'day',
    remaining: t.remaining,
    lastSeenSecondsAgo: Math.max(0, Math.round((now - t.lastSeenAtMs) / 1000)),
    expiresInSeconds: Math.max(0, Math.ceil((t.expiresAtMs - now) / 1000)),
    ...(t.blockedUntilMs !== null
      ? { blockedForSeconds: Math.max(0, Math.ceil((t.blockedUntilMs - now) / 1000)) }
      : {}),
  };
}

export function budgetBody(s: BudgetSnapshot) {
  const learned = s.operationTiers ?? [];
  return {
    tiers: Object.values(s.tiers).map((t) => tierRow(t, s.atMs)),
    ...(learned.length > 0 ? { learnedOperationLimits: learned.map((t) => learnedRow(t, s.atMs)) } : {}),
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
        'Shows one job (status, progress, current step, last error, result; `done` is true when it has finished) or, without jobId, your recent jobs. Use it for work that returned queued or waiting_budget: that work is not lost and is never resubmitted. Pass `wait_seconds` (1 to 25) with a jobId to wait for it to finish first: use that instead of polling in a loop, and call again if `done` is false. Only your own jobs are visible. Cost: none.',
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
        wait_seconds: z
          .number()
          .min(1)
          .max(25)
          .optional()
          .describe('With jobId: wait up to this many seconds (1 to 25) for the job to finish, then answer.'),
        project: projectArg,
      }),
      annotations: READ_ANNOTATIONS,
      handler: ({ jobId: id, steps, status, limit, wait_seconds: wait, project: asked }, ctx) =>
        withProject(deps, asked, 'read', async (pd) => {
          if (id === undefined && wait !== undefined) {
            return errorResult(
              {
                code: 'JOB_ID_REQUIRED',
                message: 'wait_seconds needs a jobId: it waits for one job.',
                hint: 'Pass the jobId a result gave you, or leave wait_seconds out to list your recent jobs.',
              },
              pd,
            );
          }
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
          // Checked before waiting, so another principal's job returns at once, exactly like an unknown id.
          if (!ownJob(pd, ctx, id)) return jobNotFound(pd, id);
          if (wait !== undefined) {
            try {
              await deps.engine.wait(pd.project.id, id, Math.min(25, wait) * 1000);
            } catch (e) {
              return errorFromThrown(e, pd);
            }
          }
          const job = ownJob(pd, ctx, id);
          if (!job) return jobNotFound(pd, id);
          // v3 F3d (ADR 0058): where a package or a rename stopped, and whether you may resume it.
          const stop = pd.services?.resume?.stopOf(pd.project.id, id) ?? null;
          const resume =
            stop && pd.services?.resume
              ? pd.services.resume.view(pd.project.id, id, {
                  kind: 'agent',
                  principalId: ctx.principal?.principalId ?? '',
                  scope: ctx.scope,
                })
              : null;
          return render(
            {
              ...jobBody(job, steps ? 'steps' : 'summary'),
              ...(stop
                ? {
                    stoppedAt: {
                      lastVerifiedStep: stop.lastVerifiedStep,
                      ...(stop.lastVerifiedLabel ? { lastVerified: stop.lastVerifiedLabel } : {}),
                      stoppedStep: stop.stoppedStep,
                      ...(stop.stoppedLabel ? { stopped: stop.stoppedLabel } : {}),
                      ...(stop.reason ? { reason: stop.reason } : {}),
                      resumes: stop.resumes,
                      youMayResume: resume?.resumable === true,
                      ...(resume && !resume.resumable && resume.reason ? { why: resume.reason.message } : {}),
                    },
                  }
                : {}),
            },
            pd,
          );
        }),
    }),
    /** The old name, kept one release (ADR 0045, P3). */
    renamedTool(
      'bridge_job_wait',
      'bridge_job_status',
      'pass the same jobId with `wait_seconds` (1 to 25) to wait for the job; `done: true` means it finished.',
    ),
    defineTool({
      name: 'bridge_job_cancel',
      title: 'Cancel a job',
      access: 'write',
      description:
        'Cancels one of your own jobs: the step in flight finishes, nothing further is sent, finished steps are not undone. A job the owner approved can only be stopped by the owner. Use it only when asked to stop work. Cost: none.',
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
            // R3-54: the agent's own cancel, recorded as its own (it may resume what it cancelled itself).
            const job = deps.engine.controls.cancel(pd.project.id, id, own.principalId);
            return render(jobBody(deps.engine.queries.getJob(pd.project.id, job.id) ?? job, 'summary'), pd);
          } catch (e) {
            return errorFromThrown(e, pd);
          }
        }),
    }),
    // v3 F3d (ADR 0058; the design's section 3): resuming one of the agent's own jobs that stopped part-way.
    defineTool({
      name: 'bridge_job_resume',
      title: 'Resume a job that stopped part-way',
      access: 'write',
      description:
        'Resumes one of your own jobs that stopped part-way: a setting-pack package (or a rename) that failed or was cancelled after doing some of its work. It continues where it stopped, in the same job: its own checks run again first (inside its locks), every step that is left re-reads its page and checks it as it would have, a step that succeeded is never repeated, and no page or document is ever made twice. A step that is no longer safe (its page changed since) is refused with its reason: then read the pages and tell the user; never work around it. ' +
        'Only at scope write, and only for your own direct jobs: a job the owner approved (a proposal, a rename) is the owner’s to resume, on the dashboard, and so is a job the owner cancelled (CANCELLED_BY_OWNER: the cancel stands; tell the person). Your connection’s safety rails are judged again on the steps left: when one now covers a step, the rest becomes ONE proposal for the owner (proposal_captured: never resume or redo it; follow it with bridge_proposal_status). bridge_job_status shows where a job stopped (stoppedAt). Cost: the job’s remaining steps, nothing more.',
      inputSchema: z.object({ jobId, project: projectArg }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      handler: ({ jobId: id, project: asked }, ctx) =>
        withProject(deps, asked, 'write', async (pd) => {
          const own = ownJob(pd, ctx, id);
          if (!own) return jobNotFound(pd, id);
          const svc = pd.services?.resume;
          if (!svc)
            return errorResult(
              { code: 'TOOL_UNAVAILABLE', message: 'Resuming jobs is not available here.' },
              pd,
            );
          const who = ctx.principal!;
          try {
            const r = await svc.resume(
              pd.project.id,
              id,
              { kind: 'agent', principalId: who.principalId, scope: ctx.scope },
              mcpOrigin(ctx, 'bridge_job_resume'),
            );
            if (r.status !== 'resumed') return render({ ...r }, pd);
            const now = (await deps.engine.wait(pd.project.id, id, 25_000)) ?? r.job;
            return render(
              {
                status: 'resumed',
                jobId: id,
                from: r.from,
                rechecked: r.rechecked,
                job: jobBody(deps.engine.queries.getJob(pd.project.id, id) ?? now, 'summary'),
                hint: 'Follow it with bridge_job_status; never resubmit the original request.',
              },
              pd,
            );
          } catch (e) {
            if (e instanceof ResumeError) return errorResult(e.toJSON() as never, pd);
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
        'Shows one project’s request budget: every rate tier (used, limit, time to reset), the queue and the write pacing; allProjects: true lists every project. The same one-line summary ends every result. Use it when a result says the budget is low, and before bulk work (then bridge_estimate). Cost: none.',
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
        'Projects how long a planned workload takes under the current budget (counts of reads, writes and createMany items) and whether it fits today. Call it BEFORE hundreds of calls, and instead of reading pages to test the budget. Cost: none.',
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
              // v2 E5.5: the time per write the pacing assumes, and where it came from.
              secondsPerWrite: Math.round(e.perWrite.ms / 100) / 10,
              perWriteFrom:
                e.perWrite.source === 'measured'
                  ? `the median of the last ${e.perWrite.measured?.samples ?? 0} write steps`
                  : 'the configured write spacing',
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
        'Lists your recent failed calls, grouped by operation, code and path (or one row each), with LegendKeeper request ids. Use it to report a failure to the owner, not to retry. Cost: none.',
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
        'Looks up the write journal: every write the bridge has sent (creates, updates, deletes), newest first, with operation, target, time, outcome, who made it and who approved it. Destructive writes keep a pre-image. Use it to see who changed a page, what a delete removed (and the id to restore it with), or whether an OUTCOME_UNKNOWN write was made. Filter by resource, document, target, operation, principal, profile or outcome; page back with `before`. Cost: none.',
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
        'Pages a stored result by handle: the items of a lk_api_paginate_all job (offset and limit count items) or an oversized result another tool stored (offset counts characters; join the slices in order). Use it whenever a result says stored with a handle; never run the tool again. Cost: none.',
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
