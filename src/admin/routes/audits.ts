/**
 * Audits on the dashboard (v2 E2, ADR 0044; docs/dashboard.md): findings only, read from the snapshots.
 *
 * - the summary (by category and severity), the findings with their filters (category, code, severity, page path, new,
 *   acknowledged, gone), per-page grouping, and each finding's evidence, source snapshot and age;
 * - "Run an audit now" (reads the snapshot store and the bridge's own database; never LegendKeeper), the runs with their
 *   duration and snapshot;
 * - acknowledge (with a reason) and un-acknowledge;
 * - "Propose a fix" and "Re-check now": the only two requests that read LegendKeeper, each for one finding, each audited;
 *   a fix becomes an ordinary proposal on the Proposals page, never applied by the audit;
 * - the rules editor, the tag-definition source and the audit settings: saving needs the owner to have signed in again
 *   within the last 10 minutes (ADR 0062), as the canon rules do (ADR 0036 decision 4), and is audited.
 */
import * as z from 'zod';
import { AuditError, CATEGORIES, CODES, SEVERITIES, type Audits } from '../../audits/index.js';
import { ChronologyError } from '../../chronology/index.js';
import { requireReauth } from '../guard.js';
import { AdminHttpError } from '../http.js';
import { csv, limitSchema, parseInput, projectParam, type Register } from './util.js';

const STATUS: Readonly<Record<string, number>> = {
  NOT_FOUND: 404,
  INVALID_INPUT: 400,
  REASON_REQUIRED: 400,
  NO_FIX: 409,
  FINDING_GONE: 409,
  FIX_STALE: 409,
  FIX_NOT_APPLICABLE: 409,
  NOT_PROPOSED: 502,
  RECHECK_UNSUPPORTED: 409,
  NO_SNAPSHOT: 409,
  CHECK_FAILED: 500,
};

const idParam = z.object({ id: z.coerce.number().int().min(1) });

export const registerAudits: Register = (api, ctx) => {
  const audits = (): Audits => {
    const a = ctx.deps.runtime.audits;
    if (!a) throw new AdminHttpError(503, 'AUDITS_UNAVAILABLE', 'The audits are not running.');
    return a;
  };
  const wrap = async <T>(f: () => T | Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      if (e instanceof AuditError)
        throw new AdminHttpError(STATUS[e.code] ?? 400, e.code, e.message, { details: e.details });
      // v2 E6 (ADR 0048): a chronology fix's refusal (an ambiguous pairing, a shape change to confirm, an event that
      // has a row after all), with its reason, as the Chronology page gives it.
      if (e instanceof ChronologyError)
        throw new AdminHttpError(409, e.code, e.message, { details: e.details });
      throw e;
    }
  };

  /** What the page needs to open: the summary, the newest run, whether one is running, the codes with findings. */
  api.get('/audits', (req) => {
    const q = parseInput(z.object({ project: projectParam }), req.query);
    const p = ctx.project(q.project);
    const a = audits();
    const snapshots = ctx.deps.runtime.snapshots;
    const fulls = snapshots ? snapshots.index.snapshots(p.id, { kind: 'full', limit: 5 }) : [];
    const newestFull = fulls.find((s) => s.state === 'complete') ?? null;
    const cfg = a.store.config(p.id);
    return {
      project: p,
      summary: a.store.summary(p.id),
      latestRun: a.store.latestRun(p.id),
      running: a.store.runningRun(p.id),
      runs: a.store.runs(p.id, 20),
      codes: a.store.codes(p.id),
      catalogue: {
        categories: CATEGORIES,
        severities: SEVERITIES,
        codes: Object.entries(CODES).map(([code, c]) => ({ code, ...c })),
      },
      newestFullSnapshot: newestFull
        ? {
            id: newestFull.id,
            takenAt: newestFull.takenAt,
            ageMs: Math.max(0, ctx.now() - newestFull.takenAt),
          }
        : null,
      maxSnapshotAgeHours: cfg.settings.maxSnapshotAgeHours,
      now: ctx.now(),
    };
  });

  /** The findings, filtered. `group=page` adds a per-page grouping of the page of results. */
  api.get('/audits/findings', (req) => {
    const q = parseInput(
      z.object({
        project: projectParam,
        category: csv.optional(),
        code: csv.optional(),
        severity: csv.optional(),
        page: z.string().max(200).optional(),
        pageId: z.string().max(64).optional(),
        new: z.enum(['true', 'false']).optional(),
        acknowledged: z.enum(['hide', 'only', 'include']).default('hide'),
        state: z.enum(['open', 'gone', 'all']).default('open'),
        limit: limitSchema(100, 500),
        offset: z.coerce.number().int().min(0).default(0),
        group: z.enum(['page']).optional(),
      }),
      req.query,
    );
    const p = ctx.project(q.project);
    const r = audits().list(p.id, {
      ...(q.category ? { category: q.category } : {}),
      ...(q.code ? { code: q.code } : {}),
      ...(q.severity ? { severity: q.severity } : {}),
      ...(q.page ? { page: q.page } : {}),
      ...(q.pageId ? { pageId: q.pageId } : {}),
      onlyNew: q.new === 'true',
      acknowledged: q.acknowledged,
      state: q.state,
      limit: q.limit,
      offset: q.offset,
    });
    const groups =
      q.group === 'page'
        ? [
            ...r.findings
              .reduce((m, f) => {
                const key = f.pageId ?? `(${f.category})`;
                const g = m.get(key) ?? {
                  pageId: f.pageId,
                  pageName: f.pageName,
                  pagePath: f.pagePath,
                  findings: [] as number[],
                };
                g.findings.push(f.id);
                m.set(key, g);
                return m;
              }, new Map<string, { pageId: string | null; pageName: string | null; pagePath: string | null; findings: number[] }>())
              .values(),
          ]
        : undefined;
    return { project: p, ...r, ...(groups ? { groups } : {}), now: ctx.now() };
  });

  api.get('/audits/findings/:id', (req) => {
    const { id } = parseInput(idParam, req.params);
    const q = parseInput(z.object({ project: projectParam }), req.query);
    const p = ctx.project(q.project);
    const f = audits().store.get(p.id, id);
    if (!f) throw new AdminHttpError(404, 'NOT_FOUND', `No finding ${id}.`);
    return { project: p, finding: f, now: ctx.now() };
  });

  /** Runs an audit now, in the background (GET /audits follows it). Reads the snapshot store only. */
  api.post('/audits/run', (req) => {
    const b = parseInput(z.object({ confirm: z.literal(true), project: projectParam }), req.body);
    const p = ctx.project(b.project);
    const a = audits();
    if (a.store.runningRun(p.id))
      throw new AdminHttpError(409, 'AUDIT_RUNNING', 'An audit of this project is already running.');
    void a.run(p.id, 'manual').catch(() => undefined);
    return { started: true };
  });

  api.post('/audits/findings/:id/acknowledge', async (req) => {
    const { id } = parseInput(idParam, req.params);
    const b = parseInput(
      z.object({
        confirm: z.literal(true),
        project: projectParam,
        reason: z.string().trim().min(1).max(1000),
      }),
      req.body,
    );
    const p = ctx.project(b.project);
    return { finding: await wrap(() => audits().acknowledge('owner', p.id, id, b.reason)) };
  });

  api.post('/audits/findings/:id/unacknowledge', async (req) => {
    const { id } = parseInput(idParam, req.params);
    const b = parseInput(z.object({ confirm: z.literal(true), project: projectParam }), req.body);
    const p = ctx.project(b.project);
    return { finding: await wrap(() => audits().unacknowledge('owner', p.id, id)) };
  });

  /** "Propose a fix": re-reads the target live, then one ordinary proposal for the owner to approve. */
  api.post('/audits/findings/:id/propose-fix', async (req) => {
    const { id } = parseInput(idParam, req.params);
    const b = parseInput(
      z.object({
        confirm: z.literal(true),
        project: projectParam,
        // v2 E6 (ADR 0048): a chronology repair that turns a range into a single date (or the reverse).
        confirmShapeChange: z.boolean().optional(),
        // v3 F2.1: the owner's choice in a chronology tie: "Use this event", "Make a new event", "Pair with this row".
        eventId: z.string().min(1).max(64).optional(),
        createNew: z.boolean().optional(),
        rowId: z.string().min(1).max(64).optional(),
      }),
      req.body,
    );
    const p = ctx.project(b.project);
    if (b.createNew === true && b.eventId !== undefined)
      throw new AdminHttpError(400, 'INVALID_INPUT', 'createNew and eventId cannot be given together.');
    return wrap(() =>
      audits().proposeFix('owner', p.id, id, {
        ...(b.confirmShapeChange === true ? { confirmShapeChange: true } : {}),
        ...(b.eventId !== undefined ? { eventId: b.eventId } : {}),
        ...(b.createNew === true ? { createNew: true } : {}),
        ...(b.rowId !== undefined ? { rowId: b.rowId } : {}),
      }),
    );
  });

  /** "Re-check now": reads the finding's page live and runs its check again. */
  api.post('/audits/findings/:id/recheck', async (req) => {
    const { id } = parseInput(idParam, req.params);
    const b = parseInput(z.object({ confirm: z.literal(true), project: projectParam }), req.body);
    const p = ctx.project(b.project);
    return wrap(() => audits().recheck('owner', p.id, id));
  });

  // ------------------------------------------------------------------------------------------ rules and settings

  /** The rules (the owner's, or the seeded defaults), the tag source, the settings and what the editor offers. */
  const configView = (p: { id: string; name: string }) => {
    const cfg = audits().config(p.id);
    const types = ctx.deps.runtime.registry.forProject(p.id).store.listTypes();
    const node = (id: string) => {
      try {
        return ctx.deps.runtime.tree.queries.node(p.id, id).data;
      } catch {
        return null;
      }
    };
    const src = cfg.tagSource ? node(cfg.tagSource.pageId) : null;
    return {
      project: p,
      ...cfg,
      registryTypes: types.map((t) => ({
        id: t.id,
        singular: t.singular,
        plural: t.plural,
        roles: [
          ...(t.indexTemplateId ? ['index'] : []),
          ...t.pageTemplates.filter((x) => x.templateId).map((x) => x.role),
        ],
        placementKind: t.placementKind,
      })),
      tagSourcePage: src
        ? {
            id: src.id,
            name: src.rawName,
            path: src.path.names.join(' / '),
            documents: src.documents.map((d) => ({ id: d.id, name: d.name, type: d.type })),
          }
        : null,
    };
  };

  api.get('/audits/config', (req) => {
    const q = parseInput(z.object({ project: projectParam }), req.query);
    return configView(ctx.project(q.project));
  });

  /**
   * Saves the rules, the tag source and/or the settings (`rules: null` restores the seeded defaults; a field left out is
   * kept). `confirm: true` required, a step-up within the last 10 minutes required (ADR 0062), audited
   * (`audits.set_config`, with the old and new values).
   */
  api.put('/audits/config', async (req) => {
    requireReauth(ctx.deps.services, req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    parseInput(z.object({ confirm: z.literal(true) }).loose(), body);
    const { confirm: _c, project, ...rest } = body;
    const p = ctx.project(typeof project === 'string' ? project : undefined);
    await wrap(() => audits().setConfig('owner', p.id, rest));
    return configView(p);
  });
};
