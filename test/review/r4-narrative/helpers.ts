/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- the runtime and the tool results are JSON-shaped, typed loosely here */
/**
 * CR-2026-11-R4 (pass 1, the narrative property): shared helpers for the adversarial tests of
 * `test/review/r4-narrative/`. Nothing here talks to a live system: every world is the REAL stack on the mock
 * LegendKeeper (`test/narrative/world.ts`, `test/packs/f4a-world.ts`).
 *
 * - `agentOf(w)`: an agent connection at scope `write` (a profile made with `newToken`, as a new profile is on the
 *   bridge), which is what an attacking agent at scope `write` has (v3 F12: its writes are direct, each on the owner's
 *   Review page with Revert: `onReview`, `revertJob`);
 * - `approveOrdinary(w, id)`: the owner's ordinary "Approve" (never "Approve and accept as canon"), waited for;
 * - `moveWorld()`: F4a's world (the Arkona pack approved with its narrative rules) with the per-operation tools on
 *   (`MCP_EXPOSE_PER_OP_TOOLS`), a Narratives layout, and canon pages to move.
 */
import { f4aWorld, O, PROJECT, type F4aWorld } from '../../packs/f4a-world.js';
import { SidebarModel } from '../../resources/world.js';
import { ROOT } from '../../discover/world.js';

export { PROJECT };

type Obj = Record<string, any>;

interface StackLike {
  readonly stack: {
    newToken(label: string, scope: 'read' | 'propose' | 'write'): { token: string };
    connect(token?: string): Promise<unknown>;
    call(client: any, name: string, args?: Record<string, unknown>): Promise<{ body: Obj }>;
    readonly runtime: any;
  };
}

/** An agent at scope `write`. */
export async function agentOf(
  w: StackLike,
  label = 'r4-narrative-agent',
): Promise<(name: string, args: Record<string, unknown>) => Promise<Obj>> {
  const { token } = w.stack.newToken(label, 'write');
  const client = await w.stack.connect(token);
  return async (name, args) => (await w.stack.call(client, name, args)).body;
}

/** Waits for a job to end (direct jobs answer `written` at once; batches answer a job id). */
export async function settle(w: StackLike, b: Obj): Promise<void> {
  if (typeof b.jobId === 'string' && b.status !== 'written')
    await w.stack.runtime.engine.wait(PROJECT, b.jobId, 30_000).catch(() => undefined);
}

/** v3 F12 (ADR 0081): whether a direct job is on the owner's Review page, with Revert offered. */
export function onReview(w: StackLike, jobId: string): boolean {
  const items = w.stack.runtime.review.list(PROJECT, { state: 'all', limit: 1000 }) as Obj[];
  const item = items.find((i) => i.jobId === jobId);
  return item !== undefined && item.revertible !== false;
}

/** v3 F12: the owner's Revert of a job from the Review page, waited for; answers the revert job's status. */
export async function revertJob(w: StackLike, jobId: string): Promise<string> {
  const r = await w.stack.runtime.reverts.revert('owner', PROJECT, jobId);
  if (r.status !== 'submitted') return `not submitted: ${JSON.stringify(r).slice(0, 400)}`;
  let j = await w.stack.runtime.engine.wait(PROJECT, r.revertJobId, 30_000);
  for (let i = 0; i < 10 && !['succeeded', 'failed', 'cancelled'].includes(j.status); i++)
    j = await w.stack.runtime.engine.wait(PROJECT, r.revertJobId, 30_000);
  return String(j.status);
}

/** The owner's ORDINARY approval (never as canon), waited for until the proposal and its job end. */
export async function approveOrdinary(
  w: StackLike,
  proposalId: string,
): Promise<{ state: string; error?: string }> {
  const policy = w.stack.runtime.policy;
  try {
    await policy.commands.approve('owner', proposalId);
  } catch (e) {
    return { state: 'refused', error: e instanceof Error ? e.message : String(e) };
  }
  for (let i = 0; i < 500; i++) {
    const p = policy.proposals.get(proposalId)!;
    if (['executed', 'failed', 'conflicted'].includes(p.state)) {
      const job = p.jobId ? w.stack.runtime.engine.queries.getJob(PROJECT, p.jobId) : undefined;
      if (job && !['succeeded', 'failed', 'cancelled'].includes(job.status)) {
        await new Promise((r) => setTimeout(r, 20));
        continue;
      }
      return { state: p.state };
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return { state: 'timeout' };
}

/** The ids of the move world's fixtures. */
export const M = {
  narratives: 'narrati1',
  continuities: 'contnts1',
  moonfall: 'moondef1',
  main: 'maincan1',
  story: 'nastory1',
  storyMap: 'nasmap01',
  chapter: 'nachap01',
  chapter2: 'nachap02',
  chapter3: 'nachap03',
  /** A story whose pages are canon pages (a chronicle kept in Narratives): the whole-set route. */
  chronicle: 'nachron1',
  chronicleAct: 'nachron2',
  chroniclePage: 'nachron3',
  /** Canon pages, one per attempt. */
  canon: ['nacan001', 'nacan002', 'nacan003', 'nacan004', 'nacan005', 'nacan006', 'nacan007', 'nacan008'],
  /** A canon index (CANON-tagged) holding a canon page named like a chapter. */
  annals: 'naannal1',
  annalsPage: 'naannal2',
  /** A canon index whose name is swapped for "Narratives" (NA-11), and its page. */
  institutions: 'nainsti1',
  institutionsPage: 'nainsti2',
} as const;

export interface MoveWorld extends F4aWorld {
  /** An agent at scope `write`. */
  agent(name: string, args: Record<string, unknown>): Promise<Obj>;
}

/** The sidebar of an Authoritative page as Arkona writes it (Status, Continuity Type, Scope, Last Major Revision). */
export function canonSidebar(id: string, subject: string, referenceType = 'Polity Reference') {
  return [
    SidebarModel.kv(`kv${id}`.slice(0, 8), 'PROPERTIES', [
      ['Status', 'Authoritative'],
      ['Continuity Type', 'CANON'],
      ['Continuity', 'Main'],
      ['Inheritance', 'None'],
      ['Subject', subject],
      ['Reference Type', referenceType],
      ['Scope', `${subject}, canon of Salahad`],
      ['Last Major Revision', '2026-11-01'],
      ['Supersedes', 'None'],
    ]),
    SidebarModel.links(`dp${id}`.slice(0, 8), 'Dependencies', []),
    SidebarModel.links(`rl${id}`.slice(0, 8), 'Related Sources', []),
    { id: `tg${id}`.slice(0, 8), kind: 'unsupported' as const, title: 'TAGS' },
  ];
}

export async function moveWorld(): Promise<MoveWorld> {
  const w = await f4aWorld({
    env: { MCP_EXPOSE_PER_OP_TOOLS: 'true' },
    seed: (world) => {
      const r = world.repo;
      r.seed({ id: M.narratives, name: '[INDEX] Narratives', parentId: ROOT });
      r.seed({ id: M.continuities, name: '[INDEX] Continuities', parentId: ROOT });
      r.seed({ id: M.moonfall, name: '[BSRC] Moonfall', parentId: M.continuities, tags: ['AU'] });
      r.seed({ id: M.main, name: '[INDEX] Main CANON', parentId: M.narratives, tags: ['Narrative'] });
      r.seed({ id: M.story, name: '[INDEX] Ash Tales', parentId: M.main, tags: ['Narrative', 'Story'] });
      r.seed({ id: M.storyMap, name: 'Story Map', parentId: M.story, tags: ['Narrative', 'Story Map'] });
      for (const [id, n] of [
        [M.chapter, 1],
        [M.chapter2, 2],
        [M.chapter3, 3],
      ] as const)
        r.seed({
          id,
          name: `Chapter ${n} - Embers ${n}`,
          parentId: M.story,
          tags: ['Narrative', 'Chapter'],
          props: false,
        });
      // A chronicle kept in Narratives: an index of canon pages (the whole-set route, NA-13).
      r.seed({
        id: M.chronicle,
        name: '[INDEX] The Ash Chronicle',
        parentId: M.main,
        tags: ['Narrative', 'Story'],
      });
      r.seed({
        id: M.chronicleAct,
        name: '[INDEX] Act 1 - The Kings',
        parentId: M.chronicle,
        tags: ['Narrative', 'Act'],
      });
      r.seed({
        id: M.chroniclePage,
        name: '[BSRC] Ash Kings - Polity Reference',
        parentId: M.chronicleAct,
        tags: ['CANON', 'Polity'],
        referenceType: 'Polity Reference',
      });
      M.canon.forEach((id, i) =>
        r.seed({
          id,
          name: `[BSRC] Accord of Ash ${i + 1} - Polity Reference`,
          parentId: O.salahadPolities,
          tags: ['CANON', 'Polity'],
          referenceType: 'Polity Reference',
        }),
      );
      r.seed({
        id: M.annals,
        name: '[INDEX] Annals of Ash',
        parentId: O.salahadPolities,
        tags: ['CANON', 'Polity'],
      });
      r.seed({
        id: M.annalsPage,
        name: '[BSRC] Chapter 1 - The Founding',
        parentId: M.annals,
        tags: ['CANON', 'Polity'],
        referenceType: 'Polity Reference',
      });
      r.seed({ id: M.institutions, name: '[INDEX] Ash Institutions', parentId: O.salahad });
      r.seed({
        id: M.institutionsPage,
        name: '[BSRC] Ash Guild - Institution Reference',
        parentId: M.institutions,
        tags: ['CANON', 'Institution'],
        referenceType: 'Institution Reference',
      });
    },
  });
  for (const [i, id] of M.canon.entries()) w.sidebars.page(id, canonSidebar(id, `Accord of Ash ${i + 1}`));
  w.sidebars.page(M.annalsPage, canonSidebar(M.annalsPage, 'The Founding'));
  w.sidebars.page(M.chroniclePage, canonSidebar(M.chroniclePage, 'Ash Kings'));
  w.sidebars.page(M.institutionsPage, canonSidebar(M.institutionsPage, 'Ash Guild', 'Institution Reference'));
  for (const id of [M.chapter, M.chapter2, M.chapter3])
    w.sidebars.page(id, [
      SidebarModel.kv(`kv${id}`.slice(0, 8), 'PROPERTIES', [
        ['Chapter Number', id.slice(-1)],
        ['In-world Date', 'Camue 3rd, 4A 400'],
        ['Continuity', 'Main CANON'],
      ]),
    ]);
  w.sidebars.adoptNewPages = (id) => w.repo.live(id) !== undefined;
  await w.snapshot();
  const agent = await agentOf(w);
  return Object.assign(w, { agent });
}
