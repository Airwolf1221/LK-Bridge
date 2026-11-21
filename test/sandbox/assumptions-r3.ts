/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- LK results are untyped JSON */
/**
 * CR-2026-11-R3, opt-in, WRITES then cleans up: what the code reviewed in the third review (renames, splits, retagging,
 * the block-id sweep, and this review's own fixes) assumes of LegendKeeper and no sandbox check confirms yet. Written
 * for the owner; never run by an agent or in CI. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- assumptions-r3
 *
 * Each check reports PASS, FAIL or NOTED (a fact recorded, never a failure) with what LegendKeeper answered:
 *
 * - **X1** `updateAsset` renames an asset FOLDER (a rename renames a character's art folder: src/packs/rename/plan.ts),
 *   and `getAsset` and the folder listing answer the new name.
 * - **X2** a mention run inside a TABLE CELL reads back with its page (a rename reports table cells rather than editing
 *   them, ADR 0058 departures; the split moves tables verbatim): its `resourceId` kept, its custom label NOTED (kept, or
 *   dropped: LegendKeeper shows the page's current name).
 * - **X3** `assignBlockIds` on a document holding the SAME id twice (the block-id sweep, ADR 0056, and the split's
 *   refusal of such a page until the sweep has run): first whether LegendKeeper lets such a document be written at all
 *   (NOTED), then, if it does, whether `assignBlockIds` leaves every id unique and the content unchanged.
 * - **X4** a page's tags come back in the order written, and two spellings of one tag (`lkb-r3-a`, `LKB-R3-A`) are kept
 *   as written or folded (NOTED): the retag moves a status tag first by writing the array in order, and treats a second
 *   spelling of a status tag as a hold (CR-2026-11-R3, R3-06).
 * - **X5** block ids beyond split-ids: (a) the same id in two page documents of ONE page; (b) an id taken out of a
 *   document and written back later keeps that id (Revert of a split puts the source's blocks back with their ids).
 * - **X6** a document's `version` (getDocumentBlocks) moves on a content edit, and getResource's per-document
 *   `updatedAt`: present or not, and whether it moves (NOTED). The retag read-back (CR-2026-11-R3, fix C) compares the
 *   versions and says "documents' metadata … unchanged" of `updatedAt`.
 * - **X7** a NESTED block with an id a top-level block of the same document already has: refused, or kept twice
 *   (NOTED; the split assumes a refusal, its report's "suspected, not reproduced" 1).
 * - **X8** a plain mention (no label) reads back with its page, and the generic verify finds the document as written:
 *   LegendKeeper fills in display fields on read-back (the owner saw `name` and `text`, NOTED), which the verify ignores,
 *   comparing a mention by its target (CR-2026-11-R3, R3-67: a split's job read its own mentions back as differences).
 *
 * Everything runs in the sandbox runtime's own temporary database, through the job engine and the governor (never a raw
 * request; each document write carries If-Match from the engine's read). The same guard as the other sandbox tests: a
 * registered sandbox project with its own key, refused otherwise before any request. What it makes: two throwaway pages
 * `lk-bridge r3 check A|B <time>` (B with a second page document) and one asset folder `lk-bridge r3 X1 <time>`; plain
 * names, no prefix, no status tag. All are deleted at the end, even after a failure; the report names any to delete by
 * hand. Cost: about 26 writes and 26 reads.
 *
 * The thin wrapper for the real run is `assumptions-r3.test.ts`; the ordinary suite runs these steps against the mock in
 * `test/sandbox-mock/assumptions-r3.test.ts`.
 */
import { mintClientId, type OpParams, type StepOptions } from '../../src/jobs/index.js';
import { stableJson } from '../../src/jobs/sidebar-state.js';
import { compareStoredBlocks } from '../../src/jobs/verify-blocks.js';
import type { SoakRuntime } from './soak.js';
import { notSucceeded, wholeError } from './whole.js';

type Obj = Record<string, any>;

export interface AssumptionsR3Item {
  readonly id: string;
  readonly title: string;
  readonly verdict: 'pass' | 'fail' | 'noted';
  readonly detail: string;
}
type Item = AssumptionsR3Item;

const para = (text: string): Obj => ({ id: mintClientId(), kind: 'paragraph', content: [{ text }] });

/**
 * The checks (X1 to X8), for the real run (`assumptions-r3.test.ts`) and, CR-2026-11-R4 (the owner's request S), the
 * ordinary suite's run against the mock (`test/sandbox-mock/assumptions-r3.test.ts`), through the same runtime and harness.
 */
export async function runAssumptionsR3(sb: SoakRuntime): Promise<AssumptionsR3Item[]> {
  const items: Item[] = [];
  const record = (id: string, title: string, verdict: Item['verdict'], detail: string) =>
    items.push({ id, title, verdict, detail });
  const run = async (op: string, params: OpParams, options: StepOptions = {}) => {
    const r = await sb.runtime.engine.run(op, params, {
      project: sb.projectId,
      origin: { kind: 'test', client: 'sandbox', tool: 'assumptions-r3' },
      priority: 'P2',
      ...options,
    });
    if (r.status !== 'succeeded') throw notSucceeded(op, r);
    return r.result as Obj;
  };
  /** Runs a check; an unexpected error is a FAIL with what was answered. */
  const check = async (id: string, title: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      record(id, title, 'fail', `the check could not complete: ${wholeError(e)}`);
    }
  };
  const stamp = new Date().toISOString();
  const pages: string[] = [];
  const folders: string[] = [];
  const page = async (label: string) => {
    const id = mintClientId(8);
    const made = await run('createResource', {
      body: { id, name: `lk-bridge r3 check ${label} ${stamp}`, documents: [{ name: 'Main', type: 'page' }] },
    });
    pages.push(String(made.id ?? id));
    const doc = (made.documents as Obj[] | undefined)?.find((d) => d.name === 'Main') ?? made.documents?.[0];
    return { resourceId: String(made.id ?? id), documentId: String(doc?.id ?? '') };
  };
  type Doc = { resourceId: string; documentId: string };
  const read = async (p: Doc) =>
    (await run('getDocumentBlocks', { path: p })) as { version?: unknown; blocks: Obj[] };
  const write = (p: Doc, blocks: Obj[]) => run('replaceDocumentBlocks', { path: p, body: { blocks } });
  const idsIn = (bs: readonly Obj[]): string[] =>
    bs.flatMap((b) => [String(b.id), ...(Array.isArray(b.children) ? idsIn(b.children as Obj[]) : [])]);

  try {
    const A = await page('A');
    const B = await page('B');

    await check(
      'X1',
      'updateAsset renames an asset folder; getAsset and the listing answer the new name',
      async () => {
        const f = await run('createAssetFolder', { body: { name: `lk-bridge r3 X1 ${stamp}` } });
        const id = String(f.id);
        folders.push(id);
        const renamed = `lk-bridge r3 X1 renamed ${stamp}`;
        await run('updateAsset', { path: { assetId: id }, body: { name: renamed } });
        const got = await run('getAsset', { path: { assetId: id } });
        const listed = await run('listAssets', { query: { limit: 100 } });
        const inList = ((listed.data ?? []) as Obj[]).find((x) => x.id === id);
        const ok = got.name === renamed && (inList === undefined || inList.name === renamed);
        record(
          'X1',
          'updateAsset renames an asset folder; getAsset and the listing answer the new name',
          ok ? 'pass' : 'fail',
          `getAsset: “${String(got.name)}”; listing: ${inList ? `“${String(inList.name)}”` : 'not on the first page of the root (NOTED)'}`,
        );
      },
    );

    await check(
      'X2',
      'a mention inside a table cell reads back with its page (its label noted)',
      async () => {
        const cellPara = {
          id: mintClientId(),
          kind: 'paragraph',
          content: [
            { text: 'Kept by ' },
            { mention: { resourceId: B.resourceId, text: 'An Old Name' } },
            { text: '.' },
          ],
        };
        const table = {
          id: mintClientId(),
          kind: 'table',
          children: [
            {
              id: mintClientId(),
              kind: 'tableRow',
              children: [
                { id: mintClientId(), kind: 'tableCell', children: [para('Holder')] },
                { id: mintClientId(), kind: 'tableCell', children: [cellPara] },
              ],
            },
          ],
        };
        await write(A, [para('X2'), table]);
        const back = await read(A);
        const find = (bs: readonly Obj[]): Obj | undefined => {
          for (const b of bs) {
            if (b.id === cellPara.id) return b;
            const inner = Array.isArray(b.children) ? find(b.children as Obj[]) : undefined;
            if (inner) return inner;
          }
          return undefined;
        };
        const got = find(back.blocks);
        const m = ((got?.content ?? []) as Obj[]).find((r) => r.mention)?.mention as Obj | undefined;
        record(
          'X2',
          'a mention inside a table cell reads back with its page (its label noted)',
          m?.resourceId === B.resourceId ? 'pass' : 'fail',
          m
            ? `resourceId ${m.resourceId === B.resourceId ? 'kept' : `changed to ${String(m.resourceId)}`}; custom label ${m.text === 'An Old Name' ? 'KEPT as sent (NOTED)' : `not kept (NOTED: ${JSON.stringify(m.text ?? null)})`}`
            : `no mention in the cell's paragraph: ${stableJson(got ?? null)}`,
        );
      },
    );

    await check('X3', 'assignBlockIds on a document holding one id twice', async () => {
      const dup = mintClientId();
      let accepted = true;
      try {
        await write(A, [
          { id: dup, kind: 'paragraph', content: [{ text: 'first' }] },
          { id: dup, kind: 'paragraph', content: [{ text: 'second' }] },
        ]);
      } catch (e) {
        accepted = false;
        record(
          'X3',
          'assignBlockIds on a document holding one id twice',
          'noted',
          `LegendKeeper refused a document with one id twice (${wholeError(e)}): such a document cannot be made through the API, only found (a legacy page)`,
        );
      }
      if (!accepted) return;
      const before = await read(A);
      const twice = idsIn(before.blocks).filter((x) => x === dup).length;
      await run('assignBlockIds', { path: A });
      const after = await read(A);
      const ids = idsIn(after.blocks);
      const unique = new Set(ids).size === ids.length;
      const text = (bs: readonly Obj[]) => bs.map((b) => stableJson(b.content ?? null)).join('|');
      record(
        'X3',
        'assignBlockIds on a document holding one id twice',
        unique && text(after.blocks) === text(before.blocks) ? 'pass' : 'fail',
        `written with the id ${twice === 2 ? 'twice (kept twice)' : `once in the read-back (${twice})`}; after assignBlockIds: ${unique ? 'every id unique' : `ids ${ids.join(', ')}`}, content ${text(after.blocks) === text(before.blocks) ? 'unchanged' : 'CHANGED'}`,
      );
    });

    await check('X4', 'tags come back in the order written (two spellings of one tag noted)', async () => {
      const tags = ['lkb-r3-b', 'lkb-r3-a', 'lkb-r3-c', 'LKB-R3-A'];
      await run('updateResource', { path: { resourceId: A.resourceId }, body: { tags } });
      const got = ((await run('getResource', { path: { resourceId: A.resourceId } })).tags ?? []) as string[];
      const order = got.filter((t) => tags.includes(t));
      const folded = !got.includes('LKB-R3-A') || !got.includes('lkb-r3-a');
      record(
        'X4',
        'tags come back in the order written (two spellings of one tag noted)',
        stableJson(order) === stableJson(tags.filter((t) => got.includes(t))) && order[0] === 'lkb-r3-b'
          ? 'pass'
          : 'fail',
        `written ${JSON.stringify(tags)}, read ${JSON.stringify(got)}; two spellings ${folded ? 'FOLDED into one (NOTED)' : 'both kept (NOTED)'}`,
      );
    });

    await check(
      'X5',
      'block ids: one id in two documents of one page; an id taken out and written back',
      async () => {
        const second = await run('createDocument', {
          path: { resourceId: B.resourceId },
          body: { name: 'Second', type: 'page' },
        });
        const B2 = { resourceId: B.resourceId, documentId: String(second.id) };
        const shared = para('the same id in two documents of one page');
        await write(B, [shared]);
        let twoDocs: string;
        try {
          await write(B2, [{ ...shared, content: [{ text: 'its twin in the second document' }] }]);
          twoDocs = (await read(B2)).blocks.some((b) => b.id === shared.id)
            ? 'kept in both'
            : 'given another id';
        } catch (e) {
          twoDocs = `refused (${wholeError(e)})`;
        }
        const back = para('taken out, then written back');
        await write(A, [para('X5'), back]);
        await write(A, [para('X5 without it')]);
        await write(A, [para('X5 again'), back]);
        const kept = (await read(A)).blocks.some((b) => b.id === back.id);
        record(
          'X5',
          'block ids: one id in two documents of one page; an id taken out and written back',
          kept ? 'pass' : 'fail',
          `(a) two documents of one page: ${twoDocs} (NOTED); (b) an id written back after it was taken out: ${kept ? 'kept' : 'NOT kept (Revert of a split relies on it)'}`,
        );
      },
    );

    await check(
      'X6',
      'a document’s version moves on a content edit; getResource’s updatedAt noted',
      async () => {
        await write(A, [para('X6 one')]);
        const v1 = (await read(A)).version;
        const r1 = await run('getResource', { path: { resourceId: A.resourceId } });
        await write(A, [para('X6 two')]);
        const v2 = (await read(A)).version;
        const r2 = await run('getResource', { path: { resourceId: A.resourceId } });
        const stamp1 = ((r1.documents ?? []) as Obj[]).find((d) => d.id === A.documentId)?.updatedAt;
        const stamp2 = ((r2.documents ?? []) as Obj[]).find((d) => d.id === A.documentId)?.updatedAt;
        record(
          'X6',
          'a document’s version moves on a content edit; getResource’s updatedAt noted',
          v1 !== undefined && v1 !== v2 ? 'pass' : 'fail',
          `version ${String(v1)} → ${String(v2)}; getResource's updatedAt ${stamp1 === undefined ? 'ABSENT (NOTED: the read-back compares the versions)' : stamp1 === stamp2 ? `present but did not move (${String(stamp1)}) (NOTED)` : `moved (${String(stamp1)} → ${String(stamp2)}) (NOTED)`}`,
        );
      },
    );

    await check('X7', 'a nested block with an id a top-level block already has', async () => {
      const top = para('top-level');
      try {
        await write(A, [
          top,
          {
            id: mintClientId(),
            kind: 'bulletList',
            children: [
              {
                id: mintClientId(),
                kind: 'listItem',
                children: [{ ...top, content: [{ text: 'nested twin' }] }],
              },
            ],
          },
        ]);
        const n = idsIn((await read(A)).blocks).filter((x) => x === top.id).length;
        record(
          'X7',
          'a nested block with an id a top-level block already has',
          'noted',
          n > 1
            ? 'LegendKeeper KEPT the id twice (the split checks nested ids against the destination: it never sends this)'
            : 'LegendKeeper accepted it and gave the nested block another id',
        );
      } catch (e) {
        record(
          'X7',
          'a nested block with an id a top-level block already has',
          'noted',
          `LegendKeeper refused it (${wholeError(e)}), as the split assumes`,
        );
      }
    });

    await check(
      'X8',
      'a plain mention reads back with its page, and the generic verify finds it as written',
      async () => {
        const sent = [
          {
            id: mintClientId(),
            kind: 'paragraph',
            content: [{ text: 'See ' }, { mention: { resourceId: B.resourceId } }, { text: '.' }],
          },
        ];
        await write(A, sent);
        const back = await read(A);
        const m = ((back.blocks[0]?.content ?? []) as Obj[]).find((r) => r.mention)?.mention as
          Obj | undefined;
        const cmp = compareStoredBlocks(sent, back.blocks);
        const filled = m
          ? Object.keys(m)
              .filter((k) => k !== 'resourceId')
              .map((k) => `${k} ${JSON.stringify(m[k])}`)
              .join(', ') || 'nothing'
          : 'no mention';
        record(
          'X8',
          'a plain mention reads back with its page, and the generic verify finds it as written',
          m?.resourceId === B.resourceId && cmp.ok ? 'pass' : 'fail',
          `resourceId ${m?.resourceId === B.resourceId ? 'kept' : `changed (${String(m?.resourceId)})`}; filled in on read-back (NOTED): ${filled}; the verify: ${cmp.ok ? 'the document as written' : `${cmp.count} difference(s): ${stableJson(cmp.differences)}`}`,
        );
      },
    );
  } finally {
    for (const id of folders.reverse()) {
      try {
        await run('deleteAsset', { path: { assetId: id } });
      } catch (e) {
        record(
          'cleanup',
          'the throwaway asset folder deleted',
          'fail',
          `${id}: ${wholeError(e)}. Delete it by hand.`,
        );
      }
    }
    for (const id of pages.reverse()) {
      try {
        await run(
          'deleteResource',
          { path: { resourceId: id }, query: { cascade: true } },
          { confirm: 'cascade' },
        );
      } catch (e) {
        record('cleanup', 'a throwaway page deleted', 'fail', `${id}: ${wholeError(e)}. Delete it by hand.`);
      }
    }
  }
  return items;
}

/** The report as the real run prints it: every item whole (CR-2026-11-R4: never a slice of what LegendKeeper answered). */
export function formatAssumptionsR3Report(items: readonly AssumptionsR3Item[]): string {
  const mark = { pass: 'PASS', fail: 'FAIL', noted: 'NOTED' } as const;
  return [
    '',
    'LK-Bridge sandbox: what the third review (CR-2026-11-R3) assumes of LegendKeeper (X1–X8)',
    '==========================================================================================',
    ...items.map((i) => `[${mark[i.verdict]}] (${i.id}) ${i.title}\n        ${i.detail}`),
    '',
  ].join('\n');
}
