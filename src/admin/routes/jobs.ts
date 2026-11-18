import * as z from 'zod';
import type { JobStatus, JobWithSteps, StepView } from '../../jobs/index.js';
import { SYSTEM_PRINCIPAL, TERMINAL_JOB_STATUSES } from '../../jobs/index.js';
import { ResumeError } from '../../resume/service.js';
import { AdminHttpError } from '../http.js';
import { redactDeep } from '../redact.js';
import { csv, idSchema, limitSchema, parseInput, projectParam, type Register } from './util.js';

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
        project: projectParam,
      }),
      req.query,
    );
    const project = ctx.project(q.project);
    let status: readonly JobStatus[] | undefined;
    if (q.status && q.status.length > 0) {
      const bad = q.status.filter((s) => !STATUSES.has(s));
      if (bad.length > 0) throw new AdminHttpError(400, 'INVALID_INPUT', `Unknown status: ${bad.join(', ')}`);
      status = q.status as JobStatus[];
    } else if (q.view === 'active') status = ACTIVE;
    else if (q.view === 'history') status = HISTORY;
    const jobs = engine.queries.listJobs(project.id, {
      ...(status ? { status } : {}),
      ...(q.origin ? { originKind: q.origin } : {}),
      ...(q.principalId ? { principalId: q.principalId } : {}),
      ...(q.profile ? { profile: q.profile } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.before !== undefined ? { before: q.before } : {}),
      limit: q.limit,
    });
    return {
      project,
      jobs: redactDeep(jobs),
      hasMore: jobs.length === q.limit,
      principals: ctx.principals(jobs.map((j) => j.principalId)),
    };
  });

  const projectQuery = z.object({ project: projectParam });

  api.get('/jobs/:id', (req) => {
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    const project = ctx.project(parseInput(projectQuery, req.query).project);
    const job = engine.queries.getJob(project.id, id);
    if (!job) throw new AdminHttpError(404, 'JOB_NOT_FOUND', `No job ${id} in project ${project.name}`);
    const steps = job.steps.map((s) => ({ ...s, retry: retryAdvice(job, s) }));
    // v3 F3d (ADR 0058): where a package or a rename stopped, and whether Resume applies now.
    const resume = ctx.deps.runtime.resume;
    const stop = resume?.stopOf(project.id, id) ?? null;
    return {
      job: redactDeep({ ...job, steps }, { maxString: 4000 }),
      principals: ctx.principals([job.principalId]),
      ...(stop ? { stop, resume: resume!.view(project.id, id) } : {}),
    };
  });

  /**
   * v3 F3d (ADR 0058; the design's section 3): what Resume would do for a job that stopped part-way (a package, a
   * rename, a recreate): where it stopped, its last verified step, the steps left and the checks run again first; or why
   * it cannot be resumed. Reads nothing from LegendKeeper.
   */
  api.get('/jobs/:id/resume-stopped', (req) => {
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    const project = ctx.project(parseInput(projectQuery, req.query).project);
    const resume = ctx.deps.runtime.resume;
    if (!resume) throw new AdminHttpError(503, 'UNAVAILABLE', 'Resuming jobs is not available here.');
    return { resume: resume.view(project.id, id) };
  });

  /**
   * Resumes it (`{ confirm: true }`): no fresh approval for an approved plan (decision D6), audited `job.resume`. A
   * refusal is 409 with its code and reason; a recreate answers with the proposal its finish made.
   */
  api.post('/jobs/:id/resume-stopped', async (req) => {
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    parseInput(z.object({ confirm: z.literal(true) }), req.body);
    const project = ctx.project(parseInput(projectQuery, req.query).project);
    const resume = ctx.deps.runtime.resume;
    if (!resume) throw new AdminHttpError(503, 'UNAVAILABLE', 'Resuming jobs is not available here.');
    try {
      const r = await resume.resume(
        project.id,
        id,
        { kind: 'owner' },
        { kind: 'ui', client: 'owner', tool: 'job.resume', detail: `resume:${id}`, principal: SYSTEM_PRINCIPAL },
      );
      return { resume: redactDeep(r, { maxString: 4000 }) };
    } catch (e) {
      if (e instanceof ResumeError)
        throw new AdminHttpError(e.code === 'JOB_NOT_FOUND' ? 404 : 409, e.code, e.message, e.details);
      throw e;
    }
  });

  api.get('/jobs/:id/artifacts/:artifactId', (req) => {
    const p = parseInput(z.object({ id: idSchema, artifactId: idSchema }), req.params);
    const q = parseInput(
      z.object({
        offset: z.coerce.number().int().min(0).default(0),
        limit: limitSchema(50, 200),
        project: projectParam,
      }),
      req.query,
    );
    const project = ctx.project(q.project);
    const page = engine.queries.readArtifact(project.id, p.artifactId, { offset: q.offset, limit: q.limit });
    if (!page || page.artifact.jobId !== p.id) {
      throw new AdminHttpError(404, 'ARTIFACT_NOT_FOUND', `No artefact ${p.artifactId} on job ${p.id}`);
    }
    return redactDeep(page, { maxString: 4000 });
  });

  // Job controls act within the project the page shows (?project=, default: the default project).
  api.post('/jobs/:id/cancel', (req) => {
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    const project = ctx.project(parseInput(projectQuery, req.query).project);
    return { job: redactDeep(actions.cancelJob(project.id, id)) };
  });
  api.post('/jobs/:id/pause', (req) => {
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    const project = ctx.project(parseInput(projectQuery, req.query).project);
    return { job: redactDeep(actions.pauseJob(project.id, id)) };
  });
  api.post('/jobs/:id/resume', (req) => {
    const { id } = parseInput(z.object({ id: idSchema }), req.params);
    const project = ctx.project(parseInput(projectQuery, req.query).project);
    return { job: redactDeep(actions.resumeJob(project.id, id)) };
  });
  api.post('/jobs/:id/steps/:stepNo/retry', (req) => {
    const p = parseInput(z.object({ id: idSchema, stepNo: z.coerce.number().int().min(0) }), req.params);
    const b = parseInput(z.object({ force: z.boolean().default(false) }), req.body);
    const project = ctx.project(parseInput(projectQuery, req.query).project);
    return { job: redactDeep(actions.retryStep(project.id, p.id, p.stepNo, b.force)) };
  });

  // ------------------------------------------------------------------------------------------------ errors

  api.get('/errors', (req) => {
    const q = parseInput(
      z.object({
        resolved: z.enum(['true', 'false', 'all']).default('false'),
        principalId: idSchema.optional(),
        limit: limitSchema(100, 500),
        project: projectParam,
      }),
      req.query,
    );
    const project = ctx.project(q.project);
    const groups = engine.queries.listErrorGroups(project.id, {
      ...(q.resolved === 'all' ? {} : { resolved: q.resolved === 'true' }),
      ...(q.principalId ? { principalId: q.principalId } : {}),
      limit: q.limit,
    });
    return { project, groups: redactDeep(groups) };
  });

  api.get('/errors/group', (req) => {
    const q = parseInput(
      z.object({ fingerprint: z.string().min(1).max(500), project: projectParam }),
      req.query,
    );
    const project = ctx.project(q.project);
    const [group] = engine.queries.listErrorGroups(project.id, { fingerprint: q.fingerprint, limit: 1 });
    if (!group) throw new AdminHttpError(404, 'ERROR_GROUP_NOT_FOUND', 'No such error group');
    const occurrences = engine.queries.listErrors(project.id, { fingerprint: q.fingerprint, limit: 50 });
    return {
      group: redactDeep(group),
      occurrences: redactDeep(occurrences, { maxString: 8000 }),
      principals: ctx.principals(occurrences.map((o) => o.principalId)),
    };
  });

  api.post('/errors/resolve', (req) => {
    const b = parseInput(z.object({ fingerprint: z.string().min(1).max(500) }), req.body);
    const project = ctx.project(parseInput(projectQuery, req.query).project);
    return { resolved: actions.resolveErrorGroup(project.id, b.fingerprint) };
  });
};
