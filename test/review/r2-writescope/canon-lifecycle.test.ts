/**
 * CR-2026-11 round 2 (write scope): canon and lifecycle changes by an agent at scope `write` (DEFAULT rails), which
 * must stay proposals only the owner can approve, or be refused (ADR 0032, 0035, 0036 decisions 1 and 7, 0053, 0055).
 *
 * Every test asserts the SAFE behaviour: the request is refused (POLICY_DENIED) or captured as a CANONICAL proposal,
 * and the change is not made.
 *
 * Mock note: the spec says a template copy "takes the template's fields, properties and documents" and a saved template
 * "takes the resource's fields"; the mock tree keeps no tags on either. `modelTemplateFields` / `modelSaveAsTemplate`
 * (./helpers.ts) model the spec's behaviour for tags.
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- parsed JSON tool results */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { L, lifecycleWorld, type LifecycleWorld } from '../../lifecycle/world.js';
import { PROJECT } from '../../tools/helpers.js';
import { modelSaveAsTemplate, modelTemplateFields, writeAgent, type Agent } from './helpers.js';

let w: LifecycleWorld;
let a: Agent;
const OWNER_TEMPLATE = 'tplcanon';
const ARCHIVED_SET = 'oldflt01';

beforeAll(async () => {
  w = await lifecycleWorld({
    env: { LK_TIER_LIMITS: JSON.stringify({ 'key-min': 5000, 'write-min': 2000 }) },
    limits: { 'key-min': 5000, 'write-min': 2000 },
    seed: (world) => {
      // An owner's template that carries the CANON tag (its pages are meant to be canon once promoted) and no Status.
      world.repo.seed({ id: OWNER_TEMPLATE, name: 'Canon Source Template', parentId: null, tags: ['CANON'] });
      // An archived set's index inside the archive: an index carries no Status, only the Archived tag.
      world.repo.seed({
        id: ARCHIVED_SET,
        name: '[INDEX] Old Fleet',
        parentId: 'archive1',
        tags: ['Archived'],
      });
    },
  });
  modelTemplateFields(w);
  modelSaveAsTemplate(w);
  a = await writeAgent(w, 'r2-canon-agent');
}, 60_000);
afterAll(async () => w?.close());

const call = (tool: string, args: Record<string, unknown>) => w.stack.call(a.client, tool, args);
const safe = (r: { body: Record<string, any> }) =>
  r.body.error?.code === 'POLICY_DENIED' ||
  (r.body.status === 'proposal_captured' && r.body.requiresCanonicalApproval === true);
const newPagesTagged = (tag: string, before: Set<string>) =>
  [...w.repo.res.values()]
    .filter((r) => !before.has(r.id) && r.deletedAt === null && r.parentId !== null)
    .filter((r) => r.tags.some((t) => t.toLowerCase() === tag.toLowerCase()))
    .map((r) => `${r.name} [${r.tags.join(', ')}]`);

describe('status tags arriving through a template copy (ADR 0036 decision 7: added only by the lifecycle tools)', () => {
  it('D1a: a copy of a CANON-tagged template, with a plain name, is refused or a canonical proposal', async () => {
    const before = new Set(w.repo.res.keys());
    const r = await call('lk_api_write', {
      operationId: 'createResourceFromTemplate',
      params: { body: { templateId: OWNER_TEMPLATE, name: 'Lighthouse Keepers', parentId: 'locs0001' } },
    });
    expect({ safe: safe(r), made: newPagesTagged('CANON', before) }, r.text).toEqual({
      safe: true,
      made: [],
    });
  });

  it('D1b: save a CANON-tagged page as a template and copy it in one batch: refused or a canonical proposal', async () => {
    // Asagiri Kaede carries the tag `canon` (status tags are compared without case) and no Status row.
    const before = new Set(w.repo.res.keys());
    const r = await call('lk_api_batch', {
      calls: [
        {
          operationId: 'saveResourceAsTemplate',
          params: { path: { resourceId: 'kaede001' }, body: { id: 'tplkaed1', name: 'Kaede notes' } },
        },
        {
          operationId: 'createResourceFromTemplate',
          params: { body: { templateId: 'tplkaed1', name: 'Harbour Pilots', parentId: 'locs0001' } },
        },
      ],
    });
    if (typeof r.body.jobId === 'string') await w.stack.runtime.engine.wait(PROJECT, r.body.jobId, 20_000);
    expect({ safe: safe(r), made: newPagesTagged('canon', before) }, r.text).toEqual({
      safe: true,
      made: [],
    });
  });

  it('D1c: an archived set index saved as a template and copied outside the archive (tag Archived) is refused', async () => {
    const before = new Set(w.repo.res.keys());
    const r = await call('lk_api_batch', {
      calls: [
        {
          operationId: 'saveResourceAsTemplate',
          params: { path: { resourceId: ARCHIVED_SET }, body: { id: 'tplflt01', name: 'Fleet notes' } },
        },
        {
          operationId: 'createResourceFromTemplate',
          params: { body: { templateId: 'tplflt01', name: 'Fleet notes', parentId: 'locs0001' } },
        },
      ],
    });
    if (typeof r.body.jobId === 'string') await w.stack.runtime.engine.wait(PROJECT, r.body.jobId, 20_000);
    expect({ safe: safe(r), made: newPagesTagged('Archived', before) }, r.text).toEqual({
      safe: true,
      made: [],
    });
  });

  it('D1d (control): updateResource adding CANON to a plain page is refused', async () => {
    const r = await call('lk_api_write', {
      operationId: 'updateResource',
      params: { path: { resourceId: 'loose001' }, body: { tags: ['CANON'] } },
    });
    expect(safe(r), r.text).toBe(true);
    expect(w.repo.live('loose001')!.tags).not.toContain('CANON');
  });
});

describe('renaming canon (ADR 0035 decision 11, ADR 0036 decision 1, CR-14)', () => {
  it('C2b: renaming [BSRC] Old Harbour (Status Authoritative) to drop its [BSRC] prefix is refused or canonical', async () => {
    const r = await call('lk_api_write', {
      operationId: 'updateResource',
      params: { path: { resourceId: L.harbour }, body: { name: 'Old Harbour' } },
    });
    expect({ safe: safe(r), name: w.repo.live(L.harbour)!.name }, r.text).toEqual({
      safe: true,
      name: '[BSRC] Old Harbour',
    });
  });

  it('C2a (design probe): renaming an Authoritative page keeping its prefix is at least reviewable', async () => {
    const r = await call('update_resource', { page: L.tides, name: '[BSRC] Tide Almanac' });
    // ADR 0055 F: renames run directly at write scope (renames-and-moves rail off by default). Recorded here only.
    expect(['written', 'proposal_captured']).toContain(r.body.status);
  });

  it('C3: moving an Authoritative page into the templates root (out of the repository) is refused or proposed', async () => {
    // The world's `/templates$` override (listTemplates) also answers getResource('templates') with the template list,
    // an object with no parentId, which the guard reads as "not in a lifecycle area". LegendKeeper's `templates` is a
    // virtual parent, not a resource: model getResource('templates') as 404 (first in the map) so the guard's own
    // decision is what is judged. (Without this the bridge sends the move; see the report, INCONCLUSIVE.)
    const rest = [...w.overrides.entries()];
    w.overrides.clear();
    w.overrides.set(/\/resources\/templates$/, (req) =>
      req.method === 'GET'
        ? { status: 404, body: { code: 'NOT_FOUND', message: 'not a resource' } }
        : undefined,
    );
    for (const [k, v] of rest) w.overrides.set(k, v);
    const n = w.stack.mock.calls.length;
    const r = await call('lk_api_write', {
      operationId: 'moveResource',
      params: { path: { resourceId: L.guild }, body: { parentId: 'templates' } },
    });
    const sentMove = w.stack.mock.calls.slice(n).some((c) => c.method === 'POST' && c.path.includes('/move'));
    expect(
      { safe: r.body.status === 'proposal_captured' || r.body.error?.code === 'POLICY_DENIED', sentMove },
      r.text,
    ).toEqual({
      safe: true,
      sentMove: false,
    });
  });
});
