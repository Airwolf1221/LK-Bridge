/* eslint-disable @typescript-eslint/no-explicit-any -- mock LK JSON */
/**
 * The block-id sweep's test world (v3 F3.5, ADR 0056): E1a's snapshots world (the REAL server, runtime, policy, engine,
 * tree, snapshot store, appraisal overlay and MCP transport against the mock LegendKeeper) with legacy pages seeded under
 * AI REPOSITORY, and the mock's `assignBlockIds` (the mock model has none): it gives every block without an id a new
 * one and the second of two blocks sharing an id a new one, moves the version, and answers `{ assigned, version }`.
 * `mode` makes it misbehave for the verification tests (it changes a text, or drops an `unsupported` block).
 *
 * Mocks and fixtures only: nothing here reaches LegendKeeper.
 */
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
import { ROOT } from '../discover/world.js';
import { SidebarModel } from '../resources/world.js';
import { S, snapshotsWorld, type SnapshotsWorld } from '../snapshots/world.js';
import { PROJECT } from '../tools/helpers.js';

export { PROJECT, S };

/** The seeded pages. */
export const B = {
  shelf: 'bidshelf',
  /** Blocks without ids (a nested list item, an `unsupported` block with its id), and a Last Major Revision row. */
  missing: 'bidmiss1',
  /** Two blocks sharing an id. */
  duplicate: 'biddupl1',
  /** Every block with its own id: never a candidate. */
  clean: 'bidclean',
  /** A third and a fourth legacy page (the limit test). */
  third: 'bidthrd1',
  fourth: 'bidfrth1',
} as const;

type Obj = Record<string, any>;

export const missingBlocks = (): Obj[] => [
  { kind: 'heading', level: 1, content: [{ text: 'Purpose' }] },
  { id: 'mp1', kind: 'paragraph', content: [{ text: 'An old page, ' }, { text: 'bold', bold: true }] },
  {
    kind: 'bulletList',
    children: [
      { kind: 'listItem', children: [{ kind: 'paragraph', content: [{ text: 'first item' }] }] },
      {
        id: 'mli2',
        kind: 'listItem',
        children: [{ id: 'mlp2', kind: 'paragraph', content: [{ text: 'two' }] }],
      },
    ],
  },
  { id: 'mun1', kind: 'unsupported' },
];

export const duplicateBlocks = (): Obj[] => [
  { id: 'dp1', kind: 'paragraph', content: [{ text: 'one' }] },
  { id: 'dp1', kind: 'paragraph', content: [{ text: 'two' }] },
  { id: 'dun1', kind: 'unsupported' },
];

const legacy = (label: string): Obj[] => [
  { kind: 'paragraph', content: [{ text: `${label}: no id here` }] },
  { id: `${label}p2`, kind: 'paragraph', content: [{ text: 'this one has an id' }] },
];

export type AssignMode = 'normal' | 'changeText' | 'dropUnsupported';

export interface BlockIdsWorld extends SnapshotsWorld {
  /** The Main document of a page. */
  mainOf(pageId: string): string;
  /** What the mock holds for a page's Main document. */
  stored(pageId: string): { version: number; blocks: Obj[] };
  /** `assignBlockIds` calls the mock answered, by document id. */
  readonly assigns: Map<string, number>;
  /** The mock's `assignBlockIds` behaviour (normal by default). */
  mode: AssignMode;
  /** Runs `fn` right after the n-th (0-based) GET of a document's blocks, once. */
  afterRead(documentId: string, n: number, fn: () => void): void;
  /** An edit made in the app: the version moves. */
  outsideEdit(pageId: string, edit: (blocks: Obj[]) => void): void;
  /** A full snapshot (the real snapshot service against the mock), and the appraisal overlay brought up to date. */
  snapshot(): Promise<void>;
}

/** Gives ids as LegendKeeper's assignBlockIds is documented to (every block without one; a repeated id renewed). */
function assignIds(blocks: Obj[], next: () => string): number {
  const seen = new Set<string>();
  let n = 0;
  const walk = (list: Obj[]) => {
    for (const b of list) {
      if (typeof b.id !== 'string' || b.id === '' || seen.has(b.id)) {
        b.id = next();
        n++;
      }
      seen.add(b.id as string);
      if (Array.isArray(b.children)) walk(b.children as Obj[]);
    }
  };
  walk(blocks);
  return n;
}

export async function blockIdsWorld(o: Parameters<typeof snapshotsWorld>[0] = {}): Promise<BlockIdsWorld> {
  const assigns = new Map<string, number>();
  const hooks: { doc: string; n: number; fn: () => void; seen: number }[] = [];
  let counter = 0;
  const w = (await snapshotsWorld({
    ...o,
    seed: (world) => {
      const r = world.repo;
      r.seed({ id: B.shelf, name: '[INDEX] Archive Shelf', parentId: ROOT });
      for (const [id, name] of [
        [B.missing, '[BSRC] Old Missing'],
        [B.duplicate, '[BSRC] Old Duplicate'],
        [B.clean, '[BSRC] Clean Page'],
        [B.third, '[BSRC] Old Third'],
        [B.fourth, '[BSRC] Old Fourth'],
      ] as const)
        r.seed({ id, name, parentId: B.shelf, referenceType: 'General Source' });
      const main = (id: string) => r.liveDocs(r.live(id)!).find((d) => d.name === 'Main')!.id;
      r.blocks.set(main(B.missing), { version: 3, blocks: missingBlocks() });
      r.blocks.set(main(B.duplicate), { version: 1, blocks: duplicateBlocks() });
      r.blocks.set(main(B.clean), {
        version: 1,
        blocks: [{ id: 'cp1', kind: 'paragraph', content: [{ text: 'clean' }] }],
      });
      r.blocks.set(main(B.third), { version: 1, blocks: legacy('t') });
      r.blocks.set(main(B.fourth), { version: 1, blocks: legacy('f') });
      o.seed?.(world);
    },
  })) as BlockIdsWorld;
  w.sidebars.page(B.missing, [
    SidebarModel.kv('kvbidm01', 'PROPERTIES', [
      ['Reference Type', 'General Source'],
      ['Last Major Revision', '2026-01-01'],
    ]),
  ]);
  const mainOf = (id: string) => w.repo.liveDocs(w.repo.live(id)!).find((d) => d.name === 'Main')!.id;
  // The Authoritative page of the snapshots world (Status Authoritative, CANON) is a legacy page too: the canon guard's
  // exception lets the sweep through on it.
  w.repo.blocks.set(mainOf(S.harbour), { version: 2, blocks: legacy('h') });
  w.overrides.set(/\/resources\/[^/]+\/docs\/[^/]+\/(blocks|block-ids)$/, (req: MockRequest) => {
    const m = /\/resources\/([^/]+)\/docs\/([^/]+)\/(blocks|block-ids)$/.exec(req.path.replace(/\/$/, ''));
    if (!m) return undefined;
    const doc = m[2]!;
    if (m[3] === 'blocks') {
      if (req.method !== 'GET') return undefined;
      const answer = w.repo.respond(req);
      for (const h of hooks) if (h.doc === doc && h.seen++ === h.n) h.fn();
      return answer;
    }
    if (req.method !== 'POST') return undefined;
    const b = w.repo.blocks.get(doc);
    if (!b) return { status: 404, body: { message: 'no document', code: 'NOT_FOUND', requestId: 'bid-404' } };
    assigns.set(doc, (assigns.get(doc) ?? 0) + 1);
    const assigned = assignIds(b.blocks as Obj[], () => `nb${String(++counter).padStart(5, '0')}`);
    if (w.mode === 'changeText') {
      const first = (b.blocks as Obj[]).find((x) => Array.isArray(x.content));
      if (first) first.content = [{ text: 'changed by the mock' }];
    }
    if (w.mode === 'dropUnsupported') b.blocks = (b.blocks as Obj[]).filter((x) => x.kind !== 'unsupported');
    if (assigned > 0 || w.mode !== 'normal') b.version++;
    const res: MockResponse = { status: 200, body: { assigned, version: `v${b.version}` } };
    return res;
  });
  Object.assign(w, {
    mainOf,
    stored: (id: string) => w.repo.blocks.get(mainOf(id)) as { version: number; blocks: Obj[] },
    assigns,
    mode: 'normal',
    afterRead: (documentId: string, n: number, fn: () => void) =>
      hooks.push({ doc: documentId, n, fn, seen: 0 }),
    outsideEdit: (id: string, edit: (blocks: Obj[]) => void) => {
      const b = w.repo.blocks.get(mainOf(id))!;
      edit(b.blocks as Obj[]);
      b.version++;
    },
    snapshot: async () => {
      await w.stack.runtime.snapshots.full(PROJECT, 'manual');
      await w.stack.runtime.appraisal.ensureIndex(PROJECT);
    },
  });
  return w;
}
