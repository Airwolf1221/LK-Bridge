/**
 * Chronology sync on the dashboard (v2 D1, ADR 0038; docs/dashboard.md):
 *
 * - each project's chronology settings: what a lookup by naming convention finds in the tree (free), "Read the
 *   chronology" (reads the calendar, the Main table, each age table and timeline: about 3 requests per age) and the
 *   owner's confirmation of what it found, including how the tables write dates and KCY values (learned from the rows);
 *   every change audited (`project.set_chronology`). Until confirmed, the chronology tools refuse;
 * - the chronology changes (the record each timeline tool's job writes), newest first, with "Mark resolved" for a
 *   change that stopped part-way and was fixed by hand (audited `chronology.resolve`);
 * - the chronology check's last findings, and a button that runs it now (findings only, never repairs).
 */
import * as z from 'zod';
import { ChronologyError, chronologySchema } from '../../chronology/index.js';
import { AdminHttpError } from '../http.js';
import { limitSchema, parseInput, projectParam, type Register } from './util.js';

const nameParam = z.object({ name: z.string().min(1).max(64) });

export const registerChronology: Register = (api, ctx) => {
  const { projects } = ctx.deps.runtime;
  const chronology = () => {
    const c = ctx.deps.runtime.chronology;
    if (!c) throw new AdminHttpError(503, 'CHRONOLOGY_UNAVAILABLE', 'Chronology sync is not running.');
    return c;
  };
  const projectByName = (name: string) => {
    const p = projects.find(name);
    if (!p?.id) throw new AdminHttpError(404, 'UNKNOWN_PROJECT', `No project ${name} with stored data`);
    if (p.status === 'archived') throw new AdminHttpError(409, 'PROJECT_ARCHIVED', `${p.name} is removed.`);
    return { id: p.id, name: p.name };
  };
  const view = (id: string, name: string) => {
    const c = chronology();
    const config = c.config(id);
    return {
      project: name,
      config,
      find: c.find(id),
      ready: c.readiness(id),
      calendarCached: config.calendarId ? c.calendar(id) !== null : false,
    };
  };
  const wrap = <T>(f: () => T): T => {
    try {
      return f();
    } catch (e) {
      if (e instanceof ChronologyError) throw new AdminHttpError(400, e.code, e.message);
      throw e;
    }
  };

  /** The settings, what the lookup by name finds in the tree, and whether the confirmed settings still hold. */
  api.get('/projects/:name/chronology', (req) => {
    const p = projectByName(parseInput(nameParam, req.params).name);
    return view(p.id, p.name);
  });

  /** "Read the chronology": the calendar, the Main table, each age table and timeline (about 3 reads per age). */
  api.post('/projects/:name/chronology/lookup', async (req) => {
    const p = projectByName(parseInput(nameParam, req.params).name);
    const found = await chronology().lookup(p.id, 'P1');
    return { project: p.name, ...found };
  });

  /** The owner's confirmation (`settings` as the lookup proposed them, perhaps edited) or `reset: true`. Audited. */
  api.put('/projects/:name/chronology', (req) => {
    const p = projectByName(parseInput(nameParam, req.params).name);
    const body = parseInput(
      z
        .object({
          confirm: z.literal(true),
          reset: z.boolean().optional(),
          settings: chronologySchema.optional(),
        })
        .strict(),
      req.body,
    );
    if (body.reset === true) wrap(() => chronology().update('owner', p.id, null));
    else if (body.settings) wrap(() => chronology().update('owner', p.id, body.settings!));
    else throw new AdminHttpError(400, 'INVALID_INPUT', 'Send settings to confirm, or reset: true.');
    return view(p.id, p.name);
  });

  /** The chronology changes of the `project` query parameter's project, newest first. */
  api.get('/chronology/records', (req) => {
    const q = parseInput(
      z.object({
        project: projectParam,
        limit: limitSchema(100, 500),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      req.query,
    );
    const p = ctx.project(q.project);
    const store = chronology().store;
    const rows = store.recent(p.id, { limit: q.limit, offset: q.offset });
    return {
      project: p,
      total: store.count(p.id),
      incomplete: store.incomplete(p.id).length,
      records: rows.map((r) => ({
        id: r.id,
        tool: r.tool,
        summary: r.summary,
        ages: r.ages,
        state: r.state,
        jobId: r.jobId,
        jobs: r.jobs,
        principalId: r.principalId,
        approver: r.approver,
        proposalId: r.proposalId,
        writes: r.target.writes.map((w) => w.kind),
        detail: r.detail,
        createdAt: r.createdAt,
        completedAt: r.completedAt,
      })),
      principals: ctx.principals(rows.map((r) => r.principalId)),
    };
  });

  /** "Mark resolved": a change that stopped part-way and was finished or undone by hand. Audited. */
  api.post('/chronology/records/:id/resolve', (req) => {
    const id = parseInput(z.object({ id: z.coerce.number().int().min(1) }), req.params).id;
    const b = parseInput(z.object({ confirm: z.literal(true), project: projectParam }), req.body);
    const p = ctx.project(b.project);
    wrap(() => chronology().resolve('owner', p.id, id));
    return { ok: true, record: chronology().store.get(p.id, id) };
  });

  /** The chronology check's last run (findings only). */
  api.get('/chronology/check', (req) => {
    const q = parseInput(z.object({ project: projectParam }), req.query);
    const p = ctx.project(q.project);
    const store = chronology().store;
    return { project: p, last: store.lastCheck(p.id), running: store.runningCheck(p.id) !== null };
  });

  /** Runs the chronology check now (in the background; GET /chronology/check follows it). Reads only. */
  api.post('/chronology/check', (req) => {
    const b = parseInput(z.object({ confirm: z.literal(true), project: projectParam }), req.body);
    const p = ctx.project(b.project);
    const c = chronology();
    if (c.store.runningCheck(p.id))
      throw new AdminHttpError(409, 'CHECK_RUNNING', 'A chronology check is already running.');
    const ready = c.readiness(p.id);
    if (!ready.ok) throw new AdminHttpError(409, ready.code, ready.message);
    void c.check(p.id, 'manual', 'P2').catch(() => undefined);
    return { started: true };
  });
};
