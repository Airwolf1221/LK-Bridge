/**
 * Chronology sync on the dashboard (v2 D1, ADR 0038; docs/dashboard.md):
 *
 * - each project's chronology settings: what a lookup by naming convention finds in the tree (free), "Read the
 *   chronology" (reads the calendar, the Main table, each age table and timeline: about 3 requests per age) and the
 *   owner's confirmation of what it found, including how the tables write dates and KCY values (learned from the rows),
 *   which needs the step-up (CR-2026-11-R4; a reset is one click); every change audited (`project.set_chronology`).
 *   Until confirmed, the chronology tools refuse;
 * - the chronology changes (the record each timeline tool's job writes), newest first, with "Mark resolved" for a
 *   change that stopped part-way and was fixed by hand (audited `chronology.resolve`);
 * - the chronology check's last findings, and a button that runs it now (findings only, never repairs);
 * - "Propose a fix" for a finding (a row without an event, or a row and its event disagreeing about the date): ONE
 *   `sync_timeline_event` proposal for the owner to approve as normal on the Proposals page (v2 D1.1, ADR 0039).
 */
import * as z from 'zod';
import { ChronologyError, chronologySchema } from '../../chronology/index.js';
import { requireReauth } from '../guard.js';
import { AdminHttpError } from '../http.js';
import { limitSchema, parseInput, projectParam, type Register, projectFor } from './util.js';

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

  /**
   * The owner's confirmation (`settings` as the lookup proposed them, perhaps edited) or `reset: true`. Audited.
   * CR-2026-11-R4 (SE-16): the settings are a project's settings (the chronology tools write by them), so confirming or
   * changing them needs the step-up (ADR 0062 decision 5); a reset makes the tools refuse until the owner confirms
   * again, a tightening, so it stays one click (decision 6).
   */
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
    else if (body.settings) {
      requireReauth(ctx.deps.services, req);
      wrap(() => chronology().update('owner', p.id, body.settings!));
    } else throw new AdminHttpError(400, 'INVALID_INPUT', 'Send settings to confirm, or reset: true.');
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
    const p = projectFor(ctx, req, b.project);
    wrap(() => chronology().resolve('owner', p.id, id));
    return { ok: true, record: chronology().store.get(p.id, id) };
  });

  /** The chronology check's last run (findings only). */
  /**
   * v3 F10 (ADR 0078, C5): what the automation's chronology codes did (the rows and events it synced or proposed), and
   * when the automation last ran.
   */
  api.get('/chronology/automation', (req) => {
    const q = parseInput(z.object({ project: projectParam }), req.query);
    const p = ctx.project(q.project);
    const a = ctx.deps.runtime.automation;
    if (!a) return { project: p, available: false };
    return { project: p, available: true, ...a.chronologyView(p.id) };
  });

  api.get('/chronology/check', (req) => {
    const q = parseInput(z.object({ project: projectParam }), req.query);
    const p = ctx.project(q.project);
    const store = chronology().store;
    return { project: p, last: store.lastCheck(p.id), running: store.runningCheck(p.id) !== null };
  });

  /** Runs the chronology check now (in the background; GET /chronology/check follows it). Reads only. */
  api.post('/chronology/check', (req) => {
    const b = parseInput(z.object({ confirm: z.literal(true), project: projectParam }), req.body);
    const p = projectFor(ctx, req, b.project);
    const c = chronology();
    if (c.store.runningCheck(p.id))
      throw new AdminHttpError(409, 'CHECK_RUNNING', 'A chronology check is already running.');
    const ready = c.readiness(p.id);
    if (!ready.ok) throw new AdminHttpError(409, ready.code, ready.message);
    // v3 F6a.1: owned by the runtime (a stop waits for it before the database closes).
    const run = c.check(p.id, 'manual', 'P2');
    if (ctx.deps.runtime.background)
      void ctx.deps.runtime.background.track('the chronology check (Check now)', run);
    else void run.catch(() => undefined);
    return { started: true };
  });

  /**
   * "Propose a fix" for one finding of the check: `sync_timeline_event` for that table row, or (v2 E5 hotfix,
   * `kind: 'count'`) the age's Main count set to its table's row count, captured as ONE proposal (the owner approves it
   * as normal on the Proposals page). Reads about 3 requests to plan (the count fix: the calendar, the Main document,
   * the age table and one page of events per 100); writes nothing. Audited `chronology.propose_fix`.
   */
  api.post('/chronology/propose-fix', async (req) => {
    const b = parseInput(
      z
        .object({
          confirm: z.literal(true),
          project: projectParam,
          age: z.string().min(1).max(200),
          // v2 E5 hotfix: `count` proposes the Main count of the age set to its table's row count (no row).
          // v2 E6 (ADR 0048): `orphan` proposes deleting an event without a row (only the event).
          // v3 F10 (ADR 0078): `kcy`, `style` (a row), `uri` (an event) and `order` (an age), the four repairs.
          kind: z.enum(['sync', 'count', 'orphan', 'kcy', 'style', 'uri', 'order']).optional(),
          rowId: z.string().min(1).max(64).optional(),
          eventId: z.string().min(1).max(64).optional(),
          // v2 E6: a repair that turns a range into a single date (or the reverse) is confirmed by the owner.
          confirmShapeChange: z.boolean().optional(),
          // v3 F2.1: "Make a new event" (a sync fix whose candidates the owner passes over). With `eventId` on a sync
          // fix: "Use this event" / "Pair with this row".
          createNew: z.boolean().optional(),
        })
        .strict()
        .refine((x) => !(x.createNew === true && x.eventId !== undefined), {
          message: 'createNew and eventId cannot be given together',
          path: ['createNew'],
        })
        .refine(
          (x) =>
            x.kind === 'count' ||
            x.kind === 'orphan' ||
            x.kind === 'uri' ||
            x.kind === 'order' ||
            x.rowId !== undefined,
          {
            message: 'rowId is required unless kind is count, orphan, uri or order',
            path: ['rowId'],
          },
        )
        .refine((x) => (x.kind !== 'orphan' && x.kind !== 'uri') || x.eventId !== undefined, {
          message: 'eventId is required when kind is orphan or uri',
          path: ['eventId'],
        }),
      req.body,
    );
    const p = projectFor(ctx, req, b.project);
    try {
      return await chronology().proposeFix(
        'owner',
        p.id,
        b.kind === 'count'
          ? { kind: 'count', age: b.age }
          : b.kind === 'orphan'
            ? { kind: 'orphan', age: b.age, eventId: b.eventId! }
            : b.kind === 'uri'
              ? { kind: 'uri', age: b.age, eventId: b.eventId! }
              : b.kind === 'order'
                ? { kind: 'order', age: b.age }
                : b.kind === 'kcy' || b.kind === 'style'
                  ? { kind: b.kind, age: b.age, rowId: b.rowId! }
                  : {
                      age: b.age,
                      rowId: b.rowId!,
                      ...(b.confirmShapeChange === true ? { confirmShapeChange: true } : {}),
                      ...(b.eventId !== undefined ? { eventId: b.eventId } : {}),
                      ...(b.createNew === true ? { createNew: true } : {}),
                    },
      );
    } catch (e) {
      if (e instanceof ChronologyError) throw chronologyHttpError(e);
      throw e;
    }
  });

  /** v2 E6 (ADR 0048): the table-only marks of the `project` query parameter's project. */
  api.get('/chronology/table-only', (req) => {
    const q = parseInput(z.object({ project: projectParam }), req.query);
    const p = ctx.project(q.project);
    return { project: p, marks: chronology().store.tableOnly(p.id) };
  });

  /**
   * v2 E6 (ADR 0048): marks a row table-only (the owner never wants it on the timeline), or clears the mark
   * (`tableOnly: false`). Marking reads the age table once (the row's cells are kept with the mark: it holds while
   * they are unchanged). Audited `chronology.table_only`.
   */
  api.post('/chronology/table-only', async (req) => {
    const b = parseInput(
      z
        .object({
          confirm: z.literal(true),
          project: projectParam,
          age: z.string().min(1).max(200),
          rowId: z.string().min(1).max(64),
          tableOnly: z.boolean(),
          reason: z.string().max(500).optional(),
        })
        .strict(),
      req.body,
    );
    const p = projectFor(ctx, req, b.project);
    try {
      if (!b.tableOnly) {
        chronology().unmarkTableOnly('owner', p.id, { age: b.age, rowId: b.rowId });
        return { ok: true, mark: null };
      }
      const mark = await chronology().markTableOnly('owner', p.id, {
        age: b.age,
        rowId: b.rowId,
        reason: b.reason ?? null,
      });
      return { ok: true, mark };
    } catch (e) {
      if (e instanceof ChronologyError) throw chronologyHttpError(e);
      throw e;
    }
  });
};

/** A chronology refusal as the dashboard gets it: 409 when the state is the reason, 404 for what is gone. */
function chronologyHttpError(e: ChronologyError): AdminHttpError {
  const conflict = [
    'PAIRING_AMBIGUOUS',
    'EVENT_AMBIGUOUS',
    'CHRONOLOGY_INCOMPLETE',
    'CHRONOLOGY_NOT_CONFIGURED',
    'CHRONOLOGY_CHANGED',
    'EVENT_TAKEN',
    'MAIN_ROW_NOT_FOUND',
    'COUNT_UNREADABLE',
    // v2 E6 (ADR 0048)
    'SHAPE_CHANGE_UNCONFIRMED',
    'EVENT_HAS_ROW',
    'ROW_TABLE_ONLY',
  ];
  const gone = ['ROW_NOT_FOUND', 'NOT_FOUND', 'EVENT_NOT_FOUND', 'AGE_NOT_FOUND'];
  return new AdminHttpError(
    conflict.includes(e.code) ? 409 : gone.includes(e.code) ? 404 : 400,
    e.code,
    e.message,
    e.details,
  );
}
