/**
 * Maintenance Jobs page API (chunk 6, docs/maintenance.md). Every change goes through the owner commands
 * (`runtime.maintenance.commands`), which audit it and emit a `policy` event; a route only validates and calls.
 */
import { requireReauth } from '../guard.js';
import * as z from 'zod';
import { idSchema, parseInput, type Register } from './util.js';

/** v2 E4 (RV1-4): the maintenance jobs that keep the backups (switching one off needs re-authentication). */
const PROTECTING_JOBS = /^(snapshot-|offsite)/;

export const registerMaintenance: Register = (api, ctx) => {
  const { maintenance } = ctx.deps.runtime;
  const cmd = maintenance.commands;
  const params = z.object({ id: idSchema });

  api.get('/maintenance', () => ({
    jobs: cmd.list('owner'),
    schedulerEnabled: maintenance.scheduler.enabled,
    now: ctx.now(),
  }));

  api.get('/maintenance/:id', (req) => {
    const { id } = parseInput(params, req.params);
    return { job: cmd.get('owner', id) };
  });

  api.post('/maintenance/:id/enable', (req) => {
    const { id } = parseInput(params, req.params);
    return { job: cmd.enable('owner', id) };
  });

  api.post('/maintenance/:id/disable', (req) => {
    const { id } = parseInput(params, req.params);
    // v2 E4 (RV1-4; ADR 0046 decision 3): switching off a job that keeps the backups (the snapshots, their verify and
    // retention, the off-site copy) needs the owner's re-authentication; other jobs stay one click.
    if (PROTECTING_JOBS.test(id)) requireReauth(ctx.deps.services, req);
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

  /** Starts the run and answers at once with the job as `running`; the page follows it on its next refresh. */
  api.post('/maintenance/:id/run', (req, reply) => {
    const { id } = parseInput(params, req.params);
    const { job, done } = cmd.runNow('owner', id);
    done.catch(() => undefined); // failures are recorded on the run; nothing is left unhandled
    return reply.code(202).send({ job });
  });
};
