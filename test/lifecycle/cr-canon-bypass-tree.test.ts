/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * Adversarial review (tree-shaped attacks): deleting or copying canon by changing the tree in the same request, which
 * the canon guard judges from the tree as it was at entry. Each test asserts the SAFE behaviour.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
import { ROOT } from '../discover/world.js';
import { PROJECT } from '../tools/helpers.js';
import { SidebarModel } from '../resources/world.js';
import { L, lifecycleWorld, type LifecycleWorld } from './world.js';

const C = {
  /** A plain page (Status Outline, no children): the container the agent deletes with a cascade. */
  box1: 'crbox001',
  box2: 'crbox002',
  /** Authoritative pages under Locations. */
  canon1: 'crcanon1',
  canon2: 'crcanon2',
  canon3: 'crcanon3',
  /** F1c: a plain box with an Authoritative child the tree already knows. */
  box3: 'crbox003',
  canon4: 'crcanon4',
} as const;

/**
 * The safe outcome of a protected change by a side route: a canonical proposal, or (when the lifecycle guard sees a
 * lifecycle change in it) a refusal. Either way nothing was written.
 */
const proposedOrRefused = (body: Record<string, unknown>, text: string) => {
  const err = body.error as { code?: string } | undefined;
  if (err) expect(err.code, text).toBe('POLICY_DENIED');
  else expect(body, text).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
};

let w: LifecycleWorld;
let writer: Client;
const live = (id: string) => w.repo.live(id) !== undefined;
const statusOf = (id: string) =>
  w.sidebars.pages.has(id) ? w.sidebars.rows(id).find((r) => r.key === 'Status')?.text : undefined;

beforeAll(async () => {
  w = await lifecycleWorld({
    seed: (world) => {
      world.repo.seed({ id: C.box1, name: '[BSRC] CR Box One', parentId: ROOT });
      world.repo.seed({ id: C.box2, name: '[BSRC] CR Box Two', parentId: ROOT });
      world.repo.seed({ id: C.canon1, name: '[BSRC] CR Canon One', parentId: 'locs0001' });
      world.repo.seed({ id: C.canon2, name: '[BSRC] CR Canon Two', parentId: 'locs0001' });
      world.repo.seed({ id: C.canon3, name: '[BSRC] CR Canon Three', parentId: 'locs0001' });
      world.repo.seed({ id: C.box3, name: '[BSRC] CR Box Three', parentId: ROOT });
      world.repo.seed({ id: C.canon4, name: '[BSRC] CR Canon Four', parentId: C.box3 });
    },
  });
  for (const id of [C.box1, C.box2, C.box3])
    w.sidebars.page(id, [SidebarModel.kv(`kv${id.slice(2)}`, 'PROPERTIES', [['Status', 'Outline']])]);
  for (const id of [C.canon1, C.canon2, C.canon3, C.canon4])
    w.sidebars.page(id, [SidebarModel.kv(`kv${id.slice(2)}`, 'PROPERTIES', [['Status', 'Authoritative']])]);

  // LegendKeeper copies EVERY page of a template copy with its properties (includeChildren). The resources world copies
  // only the top page's modelled sidebar; extend it to the copied descendants (matched by name under each parent).
  const key = [...w.overrides.keys()].find((re) => re.source.includes('from-template'))!;
  const orig = w.overrides.get(key)!;
  const kids = (id: string) =>
    [...w.repo.res.values()].filter((r) => r.parentId === id && r.deletedAt === null);
  let n = 0;
  const copyTree = (from: string, to: string) => {
    for (const k of kids(from)) {
      const twin = kids(to).find((c) => c.name === k.name);
      if (!twin) continue;
      const src = w.sidebars.pages.get(k.id);
      if (src) {
        w.sidebars.pages.set(twin.id, {
          version: 1,
          props: src.props.map((p) => ({
            ...structuredClone(p),
            id: `cp${(++n).toString(36).padStart(6, '0')}`,
            ...(p.rows
              ? { rows: p.rows.map((r) => ({ ...structuredClone(r), id: `cw${(++n).toString(36)}` })) }
              : {}),
          })),
        });
      }
      copyTree(k.id, twin.id);
    }
  };
  w.overrides.set(key, (req: MockRequest): MockResponse | undefined => {
    const r = orig(req);
    if (r?.status === 201 && (req.body as { includeChildren?: boolean }).includeChildren === true) {
      copyTree((req.body as { templateId: string }).templateId, (r.body as { id: string }).id);
    }
    return r;
  });
  writer = await w.stack.connect();
});
afterAll(async () => w.close());

describe('F4: an Authoritative page moved under a plain page and deleted with it by a cascade, in ONE batch', () => {
  // canonical.ts entry: the cascade's pages come from the tree as it is at entry (the move has not run yet); inLock
  // (deleteInLock) re-reads only the page named in the path, never the subtree.
  it('deletes the Authoritative page without canonical approval', async () => {
    expect(statusOf(C.canon1)).toBe('Authoritative');
    const r = await w.stack.call(writer, 'lk_api_batch', {
      project: 'test',
      calls: [
        {
          operationId: 'moveResource',
          params: { path: { resourceId: C.canon1 }, body: { parentId: C.box1 } },
        },
        {
          operationId: 'deleteResource',
          params: { path: { resourceId: C.box1 }, query: { cascade: true } },
          confirm: 'cascade',
        },
      ],
    });
    if (r.body.jobId) await w.stack.runtime.engine.wait(PROJECT, String(r.body.jobId), 10_000);
    // SAFE: the Authoritative page is still there, and the request became a canonical proposal.
    expect(live(C.canon1), r.text).toBe(true);
    expect(r.body).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
  });

  it('the same race from outside: the subtree changed after the tree was last read (only the page is re-read in the lock)', async () => {
    // The page is moved under the box in the app (the tree has not seen it yet); then the agent deletes the box.
    w.repo.outside.move(C.canon3, C.box2);
    const r = await w.stack.call(writer, 'lk_api_write', {
      project: 'test',
      operationId: 'deleteResource',
      params: { path: { resourceId: C.box2 }, query: { cascade: true } },
      confirm: 'cascade',
    });
    expect(live(C.canon3), r.text).toBe(true);
  });
});

describe('F1c: the template-id seed also blinds a cascade (no ifMatch needed)', () => {
  // canonical.ts entry: createResourceFromTemplate { id: <existing child> } seeds that id's simulated sidebar with the
  // template's (here: none, the template does not exist), so the cascade's Authoritative child reads as plain; the step
  // fails (404), onError "continue" runs the delete, and deleteInLock re-reads only the box.
  it('deletes an Authoritative child the tree knows about', async () => {
    expect(statusOf(C.canon4)).toBe('Authoritative');
    const r = await w.stack.call(writer, 'lk_api_batch', {
      project: 'test',
      onError: 'continue',
      calls: [
        {
          operationId: 'createResourceFromTemplate',
          params: { body: { templateId: 'nosuchtp', id: C.canon4 } },
        },
        {
          operationId: 'deleteResource',
          params: { path: { resourceId: C.box3 }, query: { cascade: true } },
          confirm: 'cascade',
        },
      ],
    });
    if (r.body.jobId) await w.stack.runtime.engine.wait(PROJECT, String(r.body.jobId), 10_000);
    expect(live(C.canon4), r.text).toBe(true);
    expect(r.body).toMatchObject({ status: 'proposal_captured', requiresCanonicalApproval: true });
  });
});

describe('F1d: the same seed defeats the lifecycle guard too (Working -> Authoritative, no promote_page)', () => {
  it('Sky Ferry [BWRK] Status Working becomes Authoritative by lk_api_batch', async () => {
    const rows = await w.stack.call(writer, 'lk_api_read', {
      project: 'test',
      operationId: 'listPropertyRows',
      params: { path: { resourceId: L.ferry, propertyId: 'kvferr01' } },
      detail: 'full',
    });
    const v = String(rows.body.result?.version ?? rows.body.version);
    const statusRow = w.sidebars.rows(L.ferry).find((x) => x.key === 'Status')!.id;
    const r = await w.stack.call(writer, 'lk_api_batch', {
      project: 'test',
      onError: 'continue',
      calls: [
        {
          operationId: 'createResourceFromTemplate',
          params: { body: { templateId: 'nosuchtp', id: L.ferry } },
        },
        {
          operationId: 'updatePropertyRow',
          params: {
            path: { resourceId: L.ferry, propertyId: 'kvferr01', rowId: statusRow },
            ifMatch: v,
            body: { content: [{ text: 'Authoritative' }] },
          },
        },
      ],
    });
    if (r.body.jobId) await w.stack.runtime.engine.wait(PROJECT, String(r.body.jobId), 10_000);
    // SAFE: refused (POLICY_DENIED, use promote_page) or a canonical proposal; Status still Working.
    expect(statusOf(L.ferry), r.text).toBe('Working');
  });
});

describe('F5: createResourceFromTemplate with includeChildren copies canon the guard never looked at', () => {
  // canonical.ts entry judges only the TOP template's facts (read(templateId)); includeChildren copies every descendant
  // with its sidebar. The agent first hangs an Authoritative page under a template (moveResource is not a canon change).
  it('creates a new Status: Authoritative page without canonical approval', async () => {
    const r = await w.stack.call(writer, 'lk_api_batch', {
      project: 'test',
      calls: [
        {
          operationId: 'moveResource',
          params: { path: { resourceId: C.canon2 }, body: { parentId: L.template } },
        },
        {
          operationId: 'createResourceFromTemplate',
          params: {
            body: {
              templateId: L.template,
              id: 'crcopy01',
              name: '[BSRC] CR Copy',
              parentId: ROOT,
              includeChildren: true,
            },
          },
        },
        {
          operationId: 'moveResource',
          params: { path: { resourceId: C.canon2 }, body: { parentId: 'locs0001' } },
        },
      ],
    });
    if (r.body.jobId) await w.stack.runtime.engine.wait(PROJECT, String(r.body.jobId), 10_000);
    const copies = [...w.repo.res.values()].filter(
      (x) => x.deletedAt === null && x.parentId === 'crcopy01' && statusOf(x.id) === 'Authoritative',
    );
    // SAFE: no new Authoritative page exists, and the request became a canonical proposal.
    expect(
      copies.map((x) => `${x.name}: Status=${statusOf(x.id)}`),
      r.text,
    ).toEqual([]);
    proposedOrRefused(r.body, r.text);
  });
});
