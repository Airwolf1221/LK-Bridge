/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- LK results are untyped JSON */
/**
 * After the owner's run of the third review's checks (assumptions-r3), opt-in, WRITES then cleans up: what the fixes of
 * that run assume and no sandbox check confirms yet. Written for the owner; never run by an agent or in CI. On the
 * server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- assumptions-r4
 *
 * Each check reports PASS, FAIL or NOTED (a fact recorded, never a failure):
 *
 * - **Y1** X6's follow-up: do a BOARD's, a MAP's and a TIMELINE's own timestamps move on a content edit? For each, its
 *   `updatedAt` in getResource's document list and in getDocument, before and after an edit (a shape, a feature, an
 *   event), NOTED; PASS when the content read (getBoardContent, listFeatures, listEvents) shows the edit. The retag
 *   read-back now compares their content (a hash of what the snapshots take), so it is right either way; if the
 *   timestamps do move, a cheaper comparison is possible later.
 * - **Y2** X2's follow-up: the generic verify compares a label the bridge wrote: a mention with a custom label (in a
 *   paragraph and in a table cell) reads back with that label, and `compareStoredBlocks` finds the document as sent; a
 *   mention sent without a label reads back with one LegendKeeper filled in, which the verify ignores.
 * - **Y3** X5's follow-up: with one block id in two documents of one page, `getBlock` answers each document's own block
 *   (the bridge looks blocks up by document and id), and `updateBlock` on one leaves the other as it was.
 *
 * Everything runs in the sandbox runtime's own temporary database, through the job engine and the governor (never a raw
 * request; each document write carries If-Match from the engine's read). The same guard as the other sandbox tests: a
 * registered sandbox project with its own key, refused otherwise before any request. What it makes: one throwaway page
 * `lk-bridge r4 check <time>` with a page document, a second page document, a board, a map and a timeline; plain name,
 * no prefix, no status tag. Deleted at the end, even after a failure; the report names it if it must be deleted by hand.
 * Cost: about 25 writes and 30 reads.
 *
 * The thin wrapper for the real run is `assumptions-r4.test.ts`; the ordinary suite runs these steps against the mock in
 * `test/sandbox-mock/assumptions-r4.test.ts`.
 */
import { sandboxRun, type SandboxRun } from './steps.js';
import { mintClientId, type OpParams, type StepOptions } from '../../src/jobs/index.js';
import { stableJson } from '../../src/jobs/sidebar-state.js';
import { compareStoredBlocks } from '../../src/jobs/verify-blocks.js';
import type { SoakRuntime } from './soak.js';
import { y2Blocks } from './r4-blocks.js';
import { notSucceeded, wholeError } from './whole.js';

type Obj = Record<string, any>;

export interface AssumptionsR4Item {
  readonly id: string;
  readonly title: string;
  readonly verdict: 'pass' | 'fail' | 'noted';
  readonly detail: string;
}
type Item = AssumptionsR4Item;

const para = (text: string, id = mintClientId()): Obj => ({ id, kind: 'paragraph', content: [{ text }] });

/**
 * The checks (Y1 to Y3), for the real run (`assumptions-r4.test.ts`) and, CR-2026-11-R4 (the owner's request S), the
 * ordinary suite's run against the mock (`test/sandbox-mock/assumptions-r4.test.ts`), through the same runtime and harness.
 */
export async function runAssumptionsR4(
  sb: SoakRuntime,
  /** R4.1: the run that prints each step and holds the clean-up (the test file's, for its `afterAll`). */
  steps: SandboxRun = sandboxRun({ name: 'assumptions-r4', out: () => undefined }),
): Promise<AssumptionsR4Item[]> {
  const items: Item[] = [];
  const record = (id: string, title: string, verdict: Item['verdict'], detail: string) =>
    items.push({ id, title, verdict, detail });
  const run = async (op: string, params: OpParams, options: StepOptions = {}) => {
    const r = await sb.runtime.engine.run(op, params, {
      project: sb.projectId,
      origin: { kind: 'test', client: 'sandbox', tool: 'assumptions-r4' },
      priority: 'P2',
      ...options,
    });
    if (r.status !== 'succeeded') throw notSucceeded(op, r);
    return r.result as Obj;
  };
  const check = async (id: string, title: string, fn: () => Promise<void>) => {
    try {
      await steps.step(id, title, fn);
    } catch (e) {
      record(id, title, 'fail', `the check could not complete: ${wholeError(e)}`);
    }
  };
  const stamp = new Date().toISOString();
  let pageId: string | null = null;
  steps.defer('the throwaway page deleted', async () => {
    if (pageId)
      try {
        await run(
          'deleteResource',
          { path: { resourceId: pageId }, query: { cascade: true } },
          { confirm: 'cascade' },
        );
      } catch (e) {
        record(
          'cleanup',
          'the throwaway page deleted',
          'fail',
          `${pageId}: ${wholeError(e)}. Delete it by hand.`,
        );
      }
  });
  try {
    const id = mintClientId(8);
    const made = await steps.step('setup', 'a throwaway page with two documents', () =>
      run('createResource', {
        body: {
          id,
          name: `lk-bridge r4 check ${stamp}`,
          documents: [
            { name: 'Main', type: 'page' },
            { name: 'Second', type: 'page' },
          ],
        },
      }),
    );
    pageId = String(made.id ?? id);
    const docs = (made.documents ?? []) as Obj[];
    const main = { resourceId: pageId, documentId: String(docs.find((d) => d.name === 'Main')?.id ?? '') };
    const second = {
      resourceId: pageId,
      documentId: String(docs.find((d) => d.name === 'Second')?.id ?? ''),
    };
    const stamps = async (documentId: string) => {
      const res = await run('getResource', { path: { resourceId: pageId! } });
      const listed = ((res.documents ?? []) as Obj[]).find((d) => d.id === documentId)?.updatedAt;
      const got = await run('getDocument', { path: { resourceId: pageId!, documentId } });
      return { listed: listed ?? null, own: got.updatedAt ?? null };
    };
    const moved = (a: Obj, b: Obj) =>
      `getResource's updatedAt ${a.listed === null ? 'ABSENT' : a.listed === b.listed ? `did not move (${String(a.listed)})` : `moved (${String(a.listed)} → ${String(b.listed)})`}; getDocument's ${a.own === null ? 'ABSENT' : a.own === b.own ? `did not move (${String(a.own)})` : `moved (${String(a.own)} → ${String(b.own)})`}`;

    await check(
      'Y1',
      'a board’s, a map’s and a timeline’s own timestamps on a content edit (NOTED)',
      async () => {
        const lines: string[] = [];
        let ok = true;
        // A board: a shape added.
        const board = await run('createDocument', {
          path: { resourceId: pageId! },
          body: { name: 'Board', type: 'board' },
        });
        const bp = { resourceId: pageId!, documentId: String(board.id) };
        const b0 = await stamps(bp.documentId);
        const c0 = stableJson(await run('getBoardContent', { path: bp }));
        await new Promise((r) => setTimeout(r, 1500));
        await run('createBoardShapes', {
          path: bp,
          body: { shapes: [{ type: 'geo', x: 0, y: 0, props: { geo: 'rectangle', w: 120, h: 80 } }] },
        });
        const b1 = await stamps(bp.documentId);
        const c1 = stableJson(await run('getBoardContent', { path: bp }));
        ok &&= c0 !== c1;
        lines.push(`board: ${moved(b0, b1)}; content ${c0 !== c1 ? 'changed' : 'NOT changed'}`);
        // A map: a feature renamed.
        const map = await run('createDocument', {
          path: { resourceId: pageId! },
          body: { name: 'Map', type: 'map' },
        });
        const mp = { resourceId: pageId!, documentId: String(map.id) };
        const f = await run('createFeature', {
          path: mp,
          body: { type: 'pin', name: 'Pin', pos: [0, 0], rank: 'a0' },
        });
        const m0 = await stamps(mp.documentId);
        await new Promise((r) => setTimeout(r, 1500));
        await run('updateFeature', { path: { ...mp, featureId: String(f.id) }, body: { name: 'Pin moved' } });
        const m1 = await stamps(mp.documentId);
        const feats = ((await run('listFeatures', { path: mp })).data ?? []) as Obj[];
        const mapEdited = feats.some((x) => x.name === 'Pin moved');
        ok &&= mapEdited;
        lines.push(`map: ${moved(m0, m1)}; content ${mapEdited ? 'changed' : 'NOT changed'}`);
        // A timeline: an event renamed.
        const tl = await run('createDocument', {
          path: { resourceId: pageId! },
          body: { name: 'Timeline', type: 'time' },
        });
        const tp = { resourceId: pageId!, documentId: String(tl.id) };
        const lane = await run('createLane', { path: tp, body: { name: 'Lane', rank: 'a0', size: 'sm' } });
        const ev = await run('createEvent', {
          path: tp,
          body: { laneId: lane.id, type: 'event', name: 'Event', start: 0 },
        });
        const t0 = await stamps(tp.documentId);
        await new Promise((r) => setTimeout(r, 1500));
        await run('updateEvent', {
          path: { ...tp, eventId: String(ev.id) },
          body: { name: 'Event renamed' },
        });
        const t1 = await stamps(tp.documentId);
        const evs = ((await run('listEvents', { path: tp })).data ?? []) as Obj[];
        const tlEdited = evs.some((x) => x.name === 'Event renamed');
        ok &&= tlEdited;
        lines.push(`timeline: ${moved(t0, t1)}; content ${tlEdited ? 'changed' : 'NOT changed'}`);
        record(
          'Y1',
          'a board’s, a map’s and a timeline’s own timestamps on a content edit (NOTED)',
          ok ? 'pass' : 'fail',
          lines.join(' | '),
        );
      },
    );

    await check('Y2', 'the verify compares a label the bridge wrote (paragraph and table cell)', async () => {
      // The table as LegendKeeper takes it (X2's shape): rows and cells are `children` of kind `tableRow` and `tableCell`.
      const blocks = y2Blocks(pageId!, () => mintClientId());
      await run('replaceDocumentBlocks', { path: main, body: { blocks } });
      const stored = ((await run('getDocumentBlocks', { path: main })).blocks ?? []) as Obj[];
      const cmp = compareStoredBlocks(blocks, stored);
      const text = stableJson(stored);
      const kept = text.includes('a custom label') && text.includes('in a cell');
      record(
        'Y2',
        'the verify compares a label the bridge wrote (paragraph and table cell)',
        cmp.ok && kept ? 'pass' : 'fail',
        `labels ${kept ? 'kept as sent' : 'NOT kept'}; the verify ${cmp.ok ? 'finds the document as sent' : `finds ${cmp.count} difference(s): ${stableJson(cmp.differences)}; stored: ${stableJson(stored)}`}`,
      );
    });

    await check(
      'Y3',
      'one block id in two documents: getBlock and updateBlock are each document’s own',
      async () => {
        const shared = mintClientId();
        await run('replaceDocumentBlocks', { path: main, body: { blocks: [para('In Main', shared)] } });
        await run('replaceDocumentBlocks', { path: second, body: { blocks: [para('In Second', shared)] } });
        // getBlock answers the block, or `{ block }` in some versions of the API.
        const textOf = (got: Obj) => {
          const b = (got.block ?? got) as Obj;
          return ((b.content ?? []) as Obj[]).map((r) => String(r.text ?? '')).join('');
        };
        const a = await run('getBlock', { path: { ...main, blockId: shared } });
        const b = await run('getBlock', { path: { ...second, blockId: shared } });
        await run('updateBlock', {
          path: { ...second, blockId: shared },
          body: { content: [{ text: 'Second, edited' }] },
        });
        const a2 = await run('getBlock', { path: { ...main, blockId: shared } });
        const ok = textOf(a) === 'In Main' && textOf(b) === 'In Second' && textOf(a2) === 'In Main';
        record(
          'Y3',
          'one block id in two documents: getBlock and updateBlock are each document’s own',
          ok ? 'pass' : 'fail',
          `Main “${textOf(a)}”, Second “${textOf(b)}”; after editing Second, Main “${textOf(a2)}”`,
        );
      },
    );
  } finally {
    await steps.cleanup();
  }
  return items;
}

/** The report as the real run prints it: every item whole (CR-2026-11-R4: never a slice of what LegendKeeper answered). */
export function formatAssumptionsR4Report(items: readonly AssumptionsR4Item[]): string {
  const mark = { pass: 'PASS', fail: 'FAIL', noted: 'NOTED' } as const;
  return [
    '',
    'LK-Bridge sandbox: what the fixes after the third review assume of LegendKeeper (Y1–Y3)',
    '=========================================================================================',
    ...items.map((i) => `[${mark[i.verdict]}] (${i.id}) ${i.title}\n        ${i.detail}`),
    '',
  ].join('\n');
}
