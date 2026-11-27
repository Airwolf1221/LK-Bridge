/**
 * CR-2026-11 round 2 (write scope): canon and lifecycle changes by an agent at scope `write` (ADR 0032, 0035, 0036
 * decisions 1 and 7, 0053, 0055, 0081).
 *
 * A status tag arriving where no lifecycle tool adds it is refused (POLICY_DENIED) or (where a test allows it) captured
 * as a CANONICAL proposal, and is not made. v3 F12 (ADR 0081): a canon rename at scope `write` is direct, one job on the
 * owner's Review page with Revert.
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
/** A direct job's outcome: settled, on the owner's Review page, revertible. */
async function direct(r: { body: Record<string, any> }) {
  const jobId = String(r.body.jobId);
  const job = await w.stack.runtime.engine.wait(PROJECT, jobId, 20_000);
  const item = w.stack.runtime.review
    .list(PROJECT, { state: 'all', limit: 500 })
    .find((i) => i.jobId === jobId);
  return { status: job.status, onReview: item !== undefined, revertible: item?.revertible === true };
}
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
  // v3 F12 (ADR 0081): canon changes at scope `write` are direct; each is a job on the owner's Review page, with Revert.
  // v3 F12 follow-up (the owner, 27 November 2026): a rename that takes [BSRC] off an Authoritative page leaves its prefix
  // disagreeing with its Status: refused at every scope, naming the tools that keep them in step.
  it('C2b: renaming [BSRC] Old Harbour (Status Authoritative) to drop its [BSRC] prefix is refused, naming archive_page or move_to_working', async () => {
    const r = await call('lk_api_write', {
      operationId: 'updateResource',
      params: { path: { resourceId: L.harbour }, body: { name: 'Old Harbour' } },
    });
    expect(r.body.error?.code, r.text).toBe('POLICY_DENIED');
    expect(r.body.error?.message, r.text).toMatch(/archive_page or move_to_working/);
    expect(w.repo.live(L.harbour)!.name).toBe('[BSRC] Old Harbour');
  });

  // ADR 0057 decision 5 (WS-C2a), v3 F12 (ADR 0081): renaming an Authoritative page by every route is a direct job at
  // scope write, on the owner's Review page.
  it('C2a: update_resource renaming [BSRC] Tide Tables to [BSRC] Tide Almanac runs directly, on Review', async () => {
    const r = await call('update_resource', { page: L.tides, name: '[BSRC] Tide Almanac' });
    expect(r.body.status, r.text).toBe('written');
    expect(await direct(r), r.text).toEqual({ status: 'succeeded', onReview: true, revertible: true });
    expect(w.repo.live(L.tides)!.name).toBe('[BSRC] Tide Almanac');
  });

  it.each([
    [
      'lk_api_write',
      {
        operationId: 'updateResource',
        params: { path: { resourceId: L.guild }, body: { name: '[BSRC] Harbour Guildhall' } },
      },
    ],
    [
      'lk_api_batch',
      {
        calls: [
          {
            operationId: 'updateResource',
            params: { path: { resourceId: L.guild }, body: { name: '[BSRC] Harbour Hall' } },
          },
        ],
      },
    ],
  ])('C2a: %s renaming an Authoritative page keeping [BSRC] runs directly, on Review', async (tool, args) => {
    const r = await call(tool, args);
    expect(r.body.status, r.text).not.toBe('proposal_captured');
    expect(await direct(r), r.text).toEqual({ status: 'succeeded', onReview: true, revertible: true });
    const name = tool === 'lk_api_write' ? '[BSRC] Harbour Guildhall' : '[BSRC] Harbour Hall';
    expect(w.repo.live(L.guild)!.name).toBe(name);
  });

  it('C2a (control): renaming a Working page runs directly', async () => {
    const r = await call('update_resource', { page: L.ferry, name: '[BWRK] Sky Ferry Line' });
    if (typeof r.body.jobId === 'string') await w.stack.runtime.engine.wait(PROJECT, r.body.jobId, 20_000);
    expect(r.body.status, r.text).not.toBe('proposal_captured');
    expect(w.repo.live(L.ferry)!.name).toBe('[BWRK] Sky Ferry Line');
  });

  it('C3: moving an Authoritative page into the templates root (out of the repository) is refused', async () => {
    // W18: LegendKeeper accepts the move (the page then reads parentId "templates"); the bridge refuses the destination
    // for every caller, whatever getResource('templates') answers (the world answers it with the template list).
    const n = w.stack.mock.calls.length;
    const r = await call('lk_api_write', {
      operationId: 'moveResource',
      params: { path: { resourceId: L.guild }, body: { parentId: 'templates' } },
    });
    const sentMove = w.stack.mock.calls.slice(n).some((c) => c.method === 'POST' && c.path.includes('/move'));
    expect({ code: String(r.body.error?.code), sentMove }, r.text).toEqual({
      code: 'TEMPLATES_DESTINATION',
      sentMove: false,
    });
  });
});
