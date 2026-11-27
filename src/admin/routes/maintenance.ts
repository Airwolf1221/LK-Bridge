/**
 * Maintenance Jobs page API (chunk 6, docs/maintenance.md). Every change goes through the owner commands
 * (`runtime.maintenance.commands`), which audit it and emit a `policy` event; a route only validates and calls.
 */
import * as z from 'zod';
import { BlockIdSweepError, SWEEP_JOB_ID, type BlockIdSweep } from '../../blockids/index.js';
import { AdminHttpError } from '../http.js';
import { idSchema, parseInput, projectParam, type Register, projectFor } from './util.js';

/** v3 F3.5 (ADR 0056): the block-id sweep's own routes, under its job's path. */
const SWEEP = `/maintenance/${SWEEP_JOB_ID}`;

/** The sweep's errors as HTTP answers (the owner's input, or a sweep the runtime did not build). */
function sweepCall<T>(sweep: BlockIdSweep | null, fn: (s: BlockIdSweep) => T): T {
  if (!sweep)
    throw new AdminHttpError(409, 'NOT_RUNNING', 'The block-id sweep is not running on this bridge.');
  try {
    return fn(sweep);
  } catch (e) {
    if (e instanceof BlockIdSweepError)
      throw new AdminHttpError(e.code === 'NOT_OWNER' ? 403 : 400, e.code, e.message);
    throw e;
  }
}

export const registerMaintenance: Register = (api, ctx) => {
  const { maintenance } = ctx.deps.runtime;
  const cmd = maintenance.commands;
  const params = z.object({ id: idSchema });

  // ------------------------------------------------------------------------------ v3 F3.5: the block-id sweep's card

  /**
   * The card: the six-point approved-automation statement, prerequisite 2 (the sandbox PASS for this bridge version, or
   * the override), the most documents a run does, a standing stop, and each served project's candidates from its latest
   * snapshot (no LegendKeeper request).
   */
  api.get(`${SWEEP}/card`, async () => ({ card: await sweepCall(maintenance.blockIds, (s) => s.card()) }));

  /** What the next run would do in one project (documents, counts, estimated cost). Writes nothing, reads nothing. */
  api.post(`${SWEEP}/dry-run`, async (req) => {
    const body = parseInput(z.object({ project: projectParam }).strict(), req.body ?? {});
    const p = projectFor(ctx, req, body.project);
    return { dryRun: await sweepCall(maintenance.blockIds, (s) => s.dryRun(p.id)) };
  });

  /** The owner's override of the sandbox check: both ways are audited (ADR 0081: no fresh code). */
  api.put(`${SWEEP}/override`, (req) => {
    const body = parseInput(z.object({ on: z.boolean() }).strict(), req.body);
    return { prerequisite: sweepCall(maintenance.blockIds, (s) => s.setOverride('owner', body.on)) };
  });

  /** The most documents one run does (1 to 500; default 20). Audited. */
  api.put(`${SWEEP}/limit`, (req) => {
    const body = parseInput(z.object({ maxPerRun: z.unknown() }).strict(), req.body);
    return { maxPerRun: sweepCall(maintenance.blockIds, (s) => s.setMaxPerRun('owner', body.maxPerRun)) };
  });

  api.get('/maintenance', () => ({
    jobs: cmd.list('owner'),
    schedulerEnabled: maintenance.scheduler.enabled,
    now: ctx.now(),
  }));

  /** v2 E5.1: `?project=` narrows the history to that project's runs; without it, every project's (each row names it). */
  api.get('/maintenance/:id', (req) => {
    const { id } = parseInput(params, req.params);
    const q = parseInput(z.object({ project: projectParam }), req.query);
    const p = q.project !== undefined ? ctx.project(q.project) : null;
    return { job: cmd.get('owner', id, p?.id) };
  });

  api.post('/maintenance/:id/enable', (req) => {
    const { id } = parseInput(params, req.params);
    return { job: cmd.enable('owner', id) };
  });

  api.post('/maintenance/:id/disable', (req) => {
    const { id } = parseInput(params, req.params);
    return { job: cmd.disable('owner', id) };
  });

  /** `schedule: null` restores the default. The schedule itself is validated by the scheduler. */
  api.put('/maintenance/:id/schedule', (req) => {
    const { id } = parseInput(params, req.params);
    const body = parseInput(
      z.object({ schedule: z.unknown() }).refine((b) => b.schedule !== undefined, 'schedule is required'),
      req.body,
    );
    return { job: cmd.setSchedule('owner', id, body.schedule) };
  });

  /**
   * Starts the run and answers at once with the job as `running`; the page follows it on its next refresh. v2 E5.1: an
   * optional `project` (in the body) runs a per-project job for that project only; a bridge-wide job ignores it.
   */
  api.post('/maintenance/:id/run', (req, reply) => {
    const { id } = parseInput(params, req.params);
    const body = parseInput(z.object({ project: projectParam }).strict(), req.body ?? {});
    const address = parseInput(z.object({ project: projectParam }).loose(), req.query ?? {}).project;
    const project =
      body.project !== undefined || address !== undefined ? projectFor(ctx, req, body.project) : undefined;
    const { job, done } = cmd.runNow('owner', id, project);
    done.catch(() => undefined); // failures are recorded on the run; nothing is left unhandled
    return reply.code(202).send({ job });
  });
};
