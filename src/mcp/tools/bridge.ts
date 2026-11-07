/**
 * Bridge-awareness tools (PLAN §5.4, §6, §7): info, budget, estimate, job status / wait / cancel, recent errors,
 * the write journal and paging of stored results. None of them is an LK write; `bridge_info` may make up to two
 * cached reads, everything else costs no LegendKeeper budget.
 */
import * as z from 'zod';
import type { JobView, JobWithSteps, StepView } from '../../jobs/index.js';
import { TERMINAL_JOB_STATUSES } from '../../jobs/index.js';
import type { BudgetSnapshot, TierSnapshot } from '../../lk/index.js';
import { defineTool, READ_ANNOTATIONS } from './define.js';
import {
  errorFromThrown,
  errorResult,
  originFor,
  principalFor,
  project,
  render,
  summarise,
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

/** Project name and the key's role, from LK, cached: bridge_info must stay cheap and must never fail on budget. */
function projectLookup(deps: ToolDeps) {
  let cached: ProjectLookup | undefined;
  let inFlight: Promise<ProjectLookup> | undefined;
  const now = deps.now ?? Date.now;
  return async (ctx: Parameters<typeof originFor>[1]): Promise<ProjectLookup> => {
    if (cached && now() - cached.at < LOOKUP_TTL_MS) return cached;
    inFlight ??= (async () => {
      const origin = originFor('bridge_info', ctx);
      let name: string | null = null;
      let role: ProjectLookup['role'] = 'unknown';
      let note: string | undefined;
      try {
        const p = await deps.engine.run('getProject', { path: { projectId: deps.projectId } }, { origin });
        if (p.status === 'succeeded')
          name = ((p.result as { name?: unknown })?.name as string | undefined) ?? null;
        const m = await deps.engine.run('listMembers', { path: {} }, { origin });
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
      return (cached = { name, role, at: now(), ...(note ? { note } : {}) });
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}

function infoTool(deps: ToolDeps) {
  const lookup = projectLookup(deps);
  return defineTool({
    name: 'bridge_info',
    title: 'Bridge information',
    access: 'read',
    description:
      'Shows the LK-Bridge version, the LegendKeeper project (id and name) and the key’s role, the read-only flag, the writer pool, ' +
      'whether writes are paused or the bridge is draining, and which connection is calling. Cost: up to 2 cached reads (10 minutes), ' +
      'usually none. Risk: none. Call it first to learn whether writes are possible.',
    inputSchema: z.object({}),
    annotations: READ_ANNOTATIONS,
    handler: async (_input, ctx) => {
      const controls = deps.engine.queries.controls();
      const writers = deps.engine.queries.writers();
      const looked = await lookup(ctx);
      const principal = principalFor(ctx.caller);
      return render(
        {
          bridge: 'LK-Bridge',
          version: deps.version,
          project: { id: deps.projectId, name: looked.name },
          key: { role: looked.role, ...(looked.note ? { note: looked.note } : {}) },
          readOnly: {
            effective: controls.readOnly,
            configured: deps.configuredReadOnly,
            overridden: controls.readOnlyOverride !== null,
          },
          writes: {
            paused: controls.writesPaused,
            draining: controls.draining,
            canWrite: !controls.readOnly && !controls.writesPaused && !controls.draining,
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
          profile: principal.profile,
          principalId: principal.principalId,
        },
        deps,
      );
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

function jobTools(deps: ToolDeps) {
  const jobId = z.string().min(1).max(100);
  return [
    defineTool({
      name: 'bridge_job_status',
      title: 'Job status',
      access: 'read',
      description:
        'Shows one job (from lk_api_batch, lk_api_paginate_all, lk_upload_image or a queued write): status, progress, the current step, ' +
        'the last error and its result. Without jobId, lists recent jobs. Cost: none. Risk: none.',
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
      }),
      annotations: READ_ANNOTATIONS,
      handler: ({ jobId: id, steps, status, limit }) => {
        if (id === undefined) {
          const jobs = deps.engine.queries.listJobs({ ...(status ? { status } : {}), limit: limit ?? 10 });
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
            deps,
          );
        }
        const job = deps.engine.queries.getJob(id);
        if (!job) return errorResult({ code: 'JOB_NOT_FOUND', message: `No job ${id}` }, deps);
        return render(jobBody(job, steps ? 'steps' : 'summary'), deps);
      },
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
      }),
      annotations: READ_ANNOTATIONS,
      handler: async ({ jobId: id, seconds }) => {
        try {
          await deps.engine.wait(id, Math.min(25, seconds ?? 20) * 1000);
          const job = deps.engine.queries.getJob(id);
          return job
            ? render(jobBody(job, 'summary'), deps)
            : errorResult({ code: 'JOB_NOT_FOUND', message: `No job ${id}` }, deps);
        } catch (e) {
          return errorFromThrown(e, deps);
        }
      },
    }),
    defineTool({
      name: 'bridge_job_cancel',
      title: 'Cancel a job',
      access: 'write',
      description:
        'Cancels a job: the step in flight finishes, nothing further is sent, and the remaining steps are cancelled. ' +
        'Steps already done are not undone. Cost: none. Risk: low (stops pending work).',
      inputSchema: z.object({ jobId }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: ({ jobId: id }) => {
        try {
          const job = deps.engine.controls.cancel(id);
          return render(jobBody(deps.engine.queries.getJob(job.id) ?? job, 'summary'), deps);
        } catch (e) {
          return errorFromThrown(e, deps);
        }
      },
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
        'Shows every rate tier (used, limit, remaining, time to reset, any block after a 429), the queue depth per priority class and ' +
        'the write pacing. The same numbers, in one line, end every tool result. Cost: none. Risk: none.',
      inputSchema: z.object({}),
      annotations: READ_ANNOTATIONS,
      handler: () => render(budgetBody(deps.lk.governor.snapshot()), deps),
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
      }),
      annotations: READ_ANNOTATIONS,
      handler: ({ reads, writes, createManyItems, priority }) => {
        const e = deps.lk.governor.estimate({
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
          deps,
        );
      },
    }),
    defineTool({
      name: 'bridge_errors_recent',
      title: 'Recent errors',
      access: 'read',
      description:
        'Lists recent failures the bridge recorded: grouped by operation, code and path with counts (default), or one row each. ' +
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
      }),
      annotations: READ_ANNOTATIONS,
      handler: ({ grouped, limit, sinceMinutes, jobId }) => {
        const since = sinceMinutes ? (deps.now ?? Date.now)() - sinceMinutes * 60_000 : undefined;
        if (grouped === false) {
          const rows = deps.engine.queries.listErrors({
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
            deps,
          );
        }
        const groups = deps.engine.queries.listErrorGroups({
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
          deps,
        );
      },
    }),
    defineTool({
      name: 'bridge_journal_lookup',
      title: 'Write journal',
      access: 'read',
      description:
        'Looks up the write journal: before each destructive write the bridge stores the pre-image (previous blocks, board, metadata, ids). ' +
        'Filter by resource, document, target id or operation, newest first. Use it to see what a write replaced. ' +
        'Pre-images can be large (they are paged like other big results). Cost: none. Risk: none.',
      inputSchema: z.object({
        resourceId: z.string().max(256).optional(),
        documentId: z.string().max(256).optional(),
        targetId: z.string().max(256).optional(),
        operationId: z.string().max(100).optional(),
        jobId: z.string().max(100).optional(),
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
      }),
      annotations: READ_ANNOTATIONS,
      handler: (
        { resourceId, documentId, targetId, operationId, jobId, sinceMinutes, limit, includePreImage },
        ctx,
      ) => {
        const entries = deps.engine.queries.journalLookup({
          ...(resourceId ? { resourceId } : {}),
          ...(documentId ? { documentId } : {}),
          ...(targetId ? { targetId } : {}),
          ...(operationId ? { opId: operationId } : {}),
          ...(jobId ? { jobId } : {}),
          ...(sinceMinutes ? { since: (deps.now ?? Date.now)() - sinceMinutes * 60_000 } : {}),
          limit: limit ?? 10,
          includePreImage: includePreImage === true,
        });
        const body = {
          count: entries.length,
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
            jobId: e.jobId,
            principalId: e.principalId,
            bytes: e.bytes,
            ...(includePreImage === true ? { preImage: e.preImage } : {}),
          })),
        };
        if (JSON.stringify(body).length <= deps.settings.resultMaxChars) return render(body, deps);
        const stored = deps.engine.recordResult({
          opId: 'bridge_journal_lookup',
          params: {},
          value: body,
          origin: originFor('bridge_journal_lookup', ctx),
          title: 'journal lookup (stored result)',
        });
        return render(
          {
            status: 'stored',
            handle: stored.artifactId,
            count: entries.length,
            hint: 'Too large to return at once. Page it with bridge_result_page({ handle, offset }), or look up fewer entries.',
          },
          deps,
        );
      },
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
      }),
      annotations: READ_ANNOTATIONS,
      handler: ({ handle, offset, limit, detail }) => {
        const page = deps.engine.queries.readArtifact(handle, {
          offset: offset ?? 0,
          limit: Math.min(limit ?? 50, 500),
        });
        if (!page)
          return errorResult({ code: 'HANDLE_NOT_FOUND', message: `No stored result ${handle}` }, deps);
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
            deps,
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
          deps,
        );
      },
    }),
  ];
}

export function bridgeTools(deps: ToolDeps) {
  return [infoTool(deps), ...otherTools(deps).slice(0, 2), ...jobTools(deps), ...otherTools(deps).slice(2)];
}

// `summarise` is part of the shaping contract; re-exported for tests.
export { summarise };
