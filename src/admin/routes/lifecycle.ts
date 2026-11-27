/**
 * The page lifecycle on the dashboard (v2 C2c, ADR 0035; docs/dashboard.md):
 *
 * - each project's lifecycle settings: `[INDEX] Working` and `[INDEX] Archived` found by name through the tree (never by
 *   id or position) and confirmed by the owner, and the status values, tags, field names, Continuity Types and archive
 *   texts (the owner's values by default). Every change is audited (`project.set_lifecycle`);
 * - the "Archive and lifecycle" list, read-only: the lifecycle record (never pruned), newest first, with each change's
 *   page, action, date, previous state, state and jobs (linked to the journal); and the link index's freshness.
 */
import * as z from 'zod';
import { LifecycleError } from '../../lifecycle/index.js';
import { AdminHttpError } from '../http.js';
import { limitSchema, parseInput, projectParam, type Register } from './util.js';

const nameParam = z.object({ name: z.string().min(1).max(64) });
const text = (max: number) => z.string().trim().min(1).max(max);

const patchSchema = z
  .object({
    workingIndexId: z.string().min(1).max(64).nullable().optional(),
    archiveIndexId: z.string().min(1).max(64).nullable().optional(),
    indexNames: z
      .object({ working: text(200), archived: text(200) })
      .strict()
      .optional(),
    status: z
      .object({ authoritative: text(100), working: text(100), archived: text(100) })
      .strict()
      .optional(),
    tags: z
      .object({ canon: text(100), working: text(100), archived: text(100) })
      .strict()
      .optional(),
    fields: z
      .object({
        status: text(256),
        continuityType: text(256),
        scope: text(256),
        temporalScope: text(256),
        lastMajorRevision: text(256),
      })
      .strict()
      .optional(),
    continuityTypes: z
      .object({ canon: text(100), au: text(100), nonCurrent: text(100) })
      .strict()
      .optional(),
    texts: z
      .object({
        noteFromAuthoritative: text(2000),
        noteFromWorking: text(2000),
        scopePrefix: text(500),
        temporalFromAuthoritative: text(500),
        temporalFromWorking: text(500),
        // C2d (ADR 0037): the note an index of an archived set gets (a proposed default; the owner edits it here).
        noteForIndex: text(2000).optional(),
      })
      .strict()
      .optional(),
    // E5.3 (ADR 0046 decision 13): indexes whose pages are Authoritative without CANON.
    canonExemptIndexes: z.array(z.string().min(1).max(64)).max(100).optional(),
  })
  .strict();

export const registerLifecycle: Register = (api, ctx) => {
  const { projects } = ctx.deps.runtime;
  const lifecycle = () => {
    const l = ctx.deps.runtime.lifecycle;
    if (!l) throw new AdminHttpError(503, 'LIFECYCLE_UNAVAILABLE', 'The page lifecycle is not running.');
    return l;
  };
  const projectByName = (name: string) => {
    const p = projects.find(name);
    if (!p?.id) throw new AdminHttpError(404, 'UNKNOWN_PROJECT', `No project ${name} with stored data`);
    if (p.status === 'archived') throw new AdminHttpError(409, 'PROJECT_ARCHIVED', `${p.name} is removed.`);
    return { id: p.id, name: p.name };
  };
  const view = (id: string, name: string) => {
    const f = lifecycle().find(id);
    return { project: name, ...f };
  };

  /** The settings and what a lookup by name finds now (both indexes), and whether the stored ones still hold. */
  api.get('/projects/:name/lifecycle', (req) => {
    const p = projectByName(parseInput(nameParam, req.params).name);
    return view(p.id, p.name);
  });

  /**
   * Confirms the indexes and edits the values (`reset: true` restores the defaults and clears the confirmation);
   * `confirm: true` required. Audited as `project.set_lifecycle` with the old and new values.
   */
  api.put('/projects/:name/lifecycle', (req) => {
    // ADR 0081: no fresh code (C2d, ADR 0036 decision 4, had asked one).
    const p = projectByName(parseInput(nameParam, req.params).name);
    const body = (req.body ?? {}) as Record<string, unknown>;
    parseInput(z.object({ confirm: z.literal(true) }).loose(), body);
    const { confirm: _c, reset, ...rest } = body as { confirm?: unknown; reset?: unknown };
    try {
      if (reset === true) lifecycle().update('owner', p.id, null);
      else lifecycle().update('owner', p.id, parseInput(patchSchema, rest));
    } catch (e) {
      if (e instanceof LifecycleError) throw new AdminHttpError(400, e.code, e.message);
      throw e;
    }
    return view(p.id, p.name);
  });

  /** The "Archive and lifecycle" list of the `project` query parameter's project, and the link index's freshness. */
  api.get('/lifecycle/records', (req) => {
    const q = parseInput(
      z.object({
        project: projectParam,
        limit: limitSchema(100, 500),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      req.query,
    );
    const p = ctx.project(q.project);
    const store = lifecycle().store;
    const rows = store.recent(p.id, { limit: q.limit, offset: q.offset });
    const last = store.lastSweep(p.id);
    const running = store.runningSweep(p.id);
    return {
      project: p,
      total: store.count(p.id),
      records: rows.map((r) => ({
        id: r.id,
        pageId: r.pageId,
        pageName: r.pageName,
        action: r.action,
        date: r.date,
        state: r.state,
        previousState: r.previousState,
        previousName: r.previousName,
        previousParentId: r.previousParentId,
        target: { name: r.target.name, parentId: r.target.parentId },
        tagsRemoved: r.tagsRemoved,
        tagsAdded: r.tagsAdded,
        principalId: r.principalId,
        approver: r.approver,
        jobId: r.jobId,
        jobs: r.jobs,
        proposalId: r.proposalId,
        detail: r.detail ?? {},
        // C2d (ADR 0037): the whole-set change this page's record belongs to, if any.
        setId: r.setId ?? null,
        createdAt: r.createdAt,
        completedAt: r.completedAt,
      })),
      // C2d: the newest whole-set changes (the root, the action, how many pages, complete or not).
      sets: store.recentSets(p.id, { limit: 20 }).map((x) => ({
        id: x.id,
        rootId: x.rootId,
        rootName: x.rootName,
        action: x.action,
        date: x.date,
        state: x.state,
        pages: x.pages.length,
        previousState: x.previousState,
        jobs: x.jobs,
        proposalId: x.proposalId,
      })),
      principals: ctx.principals(rows.map((r) => r.principalId)),
      links: {
        total: store.linkCount(p.id),
        lastSweep: last,
        running,
      },
    };
  });
};
