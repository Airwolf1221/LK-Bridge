import * as z from 'zod';
import type { JobStatus, JobWithSteps, StepView } from '../../jobs/index.js';
import { TERMINAL_JOB_STATUSES } from '../../jobs/index.js';
import { AdminHttpError } from '../http.js';
import { redactDeep } from '../redact.js';
import { csv, idSchema, limitSchema, parseInput, type Register } from './util.js';

const ACTIVE: readonly JobStatus[] = ['queued', 'running', 'waiting_budget', 'waiting_lock', 'paused'];
const HISTORY: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled'];
const STATUSES = new Set<string>([...ACTIVE, ...HISTORY]);

/** What the Retry control may do with a step, and what the owner must be told before using it. */
function retryAdvice(job: JobWithSteps, step: StepView) {
  const retryable =
    TERMINAL_JOB_STATUSES.has(job.status) &&
    job.status !== 'cancelled' &&
    (step.status === 'failed' || step.status === 'uncertain');
  if (!retryable) return { allowed: false, ambiguous: false, warning: null };
  const ambiguous = step.maybeSent || step.status === 'uncertain';
  return {
    allowed: true,
    ambiguous,
    warning: ambiguous
      ? 'This step may already have reached LegendKeeper. A normal retry checks first and never duplicates. “Force” sends it again as new work: use it only after checking LegendKeeper yourself.'
      : null,
  };
}

export const registerJobs: Register = (api, ctx) => {
  const { engine } = ctx.deps.runtime;
  const { actions } = ctx;

  api.get('/jobs', (req) => {
    const q = parseInput(
      z.object({
        view: z.enum(['active', 'history', 'all']).default('all'),
        status: csv.optional(),
        origin: z.enum(['mcp', 'ui', 'system', 'maintenance', 'test']).optional(),
        principalId: idSchema.optional(),
        profile: idSchema.optional(),
        kind: z.enum(['single_op', 'batch_ops', 'paginate_all', 'upload_image']).optional(),
        before: z.coerce.number().int().optional(),
        limit: limitSchema(50, 200),
      }),
      req.query,
    );
    let status: readonly JobStatus[] | undefined;
    if (q.status && q.status.length > 0) {
      const bad = q.status.filter((s) => !STATUSES.has(s));
      if (bad.length > 0) throw new AdminHttpError(400, 'INVALID_INPUT', `Unknown status: ${bad.join(', ')}`);
      status = q.status as JobStatus[];
    } else if (q.view === 'active') status = ACTIVE;
    else if (q.view === 'history') status = HISTORY;
    const jobs = engine.queries.listJobs({
      ...(status ? { status } : {}),
      ...(q.origin ? { originKind: q.origin } : {}),
      ...(q.principalId ? { principalId: q.principalId } : {}),
      ...(q.profile ? { profile: q.profile } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.before !== undefined ? { before: q.before } : {}),
      limit: q.limit,
    });
    return { jobs: redactDeep(jobs), hasMore: jobs.length === q.limit };
  });

  api.get('/jobs/:id', (req) => {
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    const job = engine.queries.getJob(id);
    if (!job) throw new AdminHttpError(404, 'JOB_NOT_FOUND', `No job ${id}`);
    const steps = job.steps.map((s) => ({ ...s, retry: retryAdvice(job, s) }));
    return { job: redactDeep({ ...job, steps }, { maxString: 4000 }) };
  });

  api.get('/jobs/:id/artifacts/:artifactId', (req) => {
    const p = parseInput(z.object({ id: idSchema, artifactId: idSchema }), req.params);
    const q = parseInput(
      z.object({ offset: z.coerce.number().int().min(0).default(0), limit: limitSchema(50, 200) }),
      req.query,
    );
    const page = engine.queries.readArtifact(p.artifactId, q);
    if (!page || page.artifact.jobId !== p.id) {
      throw new AdminHttpError(404, 'ARTIFACT_NOT_FOUND', `No artefact ${p.artifactId} on job ${p.id}`);
    }
    return redactDeep(page, { maxString: 4000 });
  });

  api.post('/jobs/:id/cancel', (req) => {
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    return { job: redactDeep(actions.cancelJob(id)) };
  });
  api.post('/jobs/:id/pause', (req) => {
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    return { job: redactDeep(actions.pauseJob(id)) };
  });
  api.post('/jobs/:id/resume', (req) => {
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    return { job: redactDeep(actions.resumeJob(id)) };
  });
  api.post('/jobs/:id/steps/:stepNo/retry', (req) => {
    const p = parseInput(z.object({ id: idSchema, stepNo: z.coerce.number().int().min(0) }), req.params);
    const b = parseInput(z.object({ force: z.boolean().default(false) }), req.body);
    return { job: redactDeep(actions.retryStep(p.id, p.stepNo, b.force)) };
  });

  // ------------------------------------------------------------------------------------------------ errors

  api.get('/errors', (req) => {
    const q = parseInput(
      z.object({
        resolved: z.enum(['true', 'false', 'all']).default('false'),
        principalId: idSchema.optional(),
        limit: limitSchema(100, 500),
      }),
      req.query,
    );
    const groups = engine.queries.listErrorGroups({
      ...(q.resolved === 'all' ? {} : { resolved: q.resolved === 'true' }),
      ...(q.principalId ? { principalId: q.principalId } : {}),
      limit: q.limit,
    });
    return { groups: redactDeep(groups) };
  });

  api.get('/errors/group', (req) => {
    const q = parseInput(z.object({ fingerprint: z.string().min(1).max(500) }), req.query);
    const group = engine.queries
      .listErrorGroups({ limit: 1000 })
      .find((g) => g.fingerprint === q.fingerprint);
    if (!group) throw new AdminHttpError(404, 'ERROR_GROUP_NOT_FOUND', 'No such error group');
    const occurrences = engine.queries.listErrors({ fingerprint: q.fingerprint, limit: 50 });
    return { group: redactDeep(group), occurrences: redactDeep(occurrences, { maxString: 8000 }) };
  });

  api.post('/errors/resolve', (req) => {
    const b = parseInput(z.object({ fingerprint: z.string().min(1).max(500) }), req.body);
    return { resolved: actions.resolveErrorGroup(b.fingerprint) };
  });
};
