/**
 * Maintenance Jobs page API (chunk 6, docs/maintenance.md). Every change goes through the owner commands
 * (`runtime.maintenance.commands`), which audit it and emit a `policy` event; a route only validates and calls.
 */
import * as z from 'zod';
import { idSchema, parseInput, type Register } from './util.js';

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
