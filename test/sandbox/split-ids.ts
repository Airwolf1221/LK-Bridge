/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- LK results are untyped JSON */
/**
 * v3 F3e (ADR 0059), opt-in, WRITES then cleans up: what `arkona_split_owner` assumes of LegendKeeper when it moves blocks
 * verbatim from one page to another (the design's "keeping block IDs where LegendKeeper allows"). Written for the owner;
 * never run by an agent. On the server:
 *
 *   sudo -u lkbridge /opt/lk-bridge/app/deploy/sandbox-test.sh --project test -- split-ids
 *
 * Two throwaway pages, A and B, each with its Main document. It confirms:
 *
 * - (1) a block written to B with the id it has in A is kept with that id (block ids are per document, so a moved block
 *   keeps its id), its children's ids too;
 * - (2) the moved block arrives verbatim: its runs, marks, mention and nested list exactly as in A (versions aside);
 * - (3) A's own edit (the block taken out, an interface summary in its place) leaves B's copy as it is;
 * - (4) a requested id B already uses: what LegendKeeper does (a refusal, or another id) is recorded as NOTED; the split
 *   never sends one (it derives another id and says so in the job).
 *
 * Everything runs in the sandbox runtime's own temporary database, through the job engine and the governor (never a raw
 * request; each document write carries If-Match from the engine's read). The same guard as the other sandbox tests: a
 * registered sandbox project, with its own key. Both pages are deleted at the end; the report says which to delete by
 * hand if that fails.
 *
 * CR-2026-11-R4 (the owner's request S): the check's steps, for the real run (`split-ids.test.ts`) and the ordinary
 * suite's run against the mock (`test/sandbox-mock/split-ids.test.ts`), through the same runtime and harness.
 */
import { sandboxRun, StepTimeoutError, type SandboxRun } from './steps.js';
import { mintClientId, type OpParams, type StepOptions } from '../../src/jobs/index.js';
import { stableJson } from '../../src/jobs/sidebar-state.js';
import { withoutVersions } from '../../src/pages/blockwise.js';
import type { HttpCounters, SoakRuntime } from './soak.js';
import { notSucceeded, wholeError } from './whole.js';

type Obj = Record<string, any>;

export interface SplitIdsItem {
  readonly id: string;
  readonly title: string;
  readonly verdict: 'pass' | 'fail' | 'noted';
  readonly detail: string;
}

/** The blocks the check moves (ids minted as LegendKeeper's own are): runs with marks, and a nested list. */
function movedBlocks() {
  const id = () => mintClientId();
  return {
    paragraph: {
      id: id(),
      kind: 'paragraph',
      content: [{ text: 'Moved verbatim, ' }, { text: 'with marks', bold: true }, { text: '.' }],
    },
    list: {
      id: id(),
      kind: 'bulletList',
      children: [
        {
          id: id(),
          kind: 'listItem',
          children: [{ id: id(), kind: 'paragraph', content: [{ text: 'a nested item' }] }],
        },
      ],
    },
  };
}

export async function runSplitIdsCheck(
  sb: SoakRuntime,
  /** R4.1: the run that prints each step and holds the clean-up (the test file's, for its `afterAll`). */
  steps: SandboxRun = sandboxRun({ name: 'split-ids', out: () => undefined }),
): Promise<SplitIdsItem[]> {
  const items: SplitIdsItem[] = [];
  const record = (id: string, title: string, verdict: SplitIdsItem['verdict'], detail: string) =>
    items.push({ id, title, verdict, detail });
  const run = async (op: string, params: OpParams, options: StepOptions = {}) => {
    const r = await sb.runtime.engine.run(op, params, {
      project: sb.projectId,
      origin: { kind: 'test', client: 'sandbox', tool: 'split-ids' },
      priority: 'P2',
      ...options,
    });
    if (r.status !== 'succeeded') throw notSucceeded(op, r);
    return r.result as Obj;
  };
  const page = async (label: string) => {
    const id = mintClientId(8);
    const made = await run('createResource', {
      body: {
        id,
        name: `lk-bridge split check ${label} ${new Date().toISOString()}`,
        documents: [{ name: 'Main', type: 'page' }],
      },
    });
    const doc = (made.documents as Obj[] | undefined)?.find((d) => d.name === 'Main') ?? made.documents?.[0];
    return { resourceId: String(made.id ?? id), documentId: String(doc?.id ?? '') };
  };
  const read = async (p: { resourceId: string; documentId: string }) =>
    ((await run('getDocumentBlocks', { path: p })) as { blocks: Obj[] }).blocks;
  const write = (p: { resourceId: string; documentId: string }, blocks: Obj[]) =>
    run('replaceDocumentBlocks', { path: p, body: { blocks } });
  const same = (x: unknown, y: unknown) =>
    stableJson(withoutVersions([x])) === stableJson(withoutVersions([y]));

  const made: string[] = [];
  steps.defer('the throwaway pages deleted', async () => {
    for (const id of made.reverse()) {
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
  });
  try {
    const { paragraph, list } = movedBlocks();
    const heading = { id: mintClientId(), kind: 'heading', level: 2, content: [{ text: 'Purpose' }] };
    const { A, B, inA } = await steps.step(
      'setup',
      'two throwaway pages, the blocks written to A',
      async () => {
        const A = await page('A');
        made.push(A.resourceId);
        const B = await page('B');
        made.push(B.resourceId);
        await write(A, [heading, paragraph, list]);
        return { A, B, inA: await read(A) };
      },
    );

    // (1) and (2): written to B with A's ids.
    const inB = await steps.step('1-2', 'the blocks written to B with A’s ids, read back', async () => {
      const bHeading = { id: mintClientId(), kind: 'heading', level: 2, content: [{ text: 'Purpose' }] };
      await write(B, [bHeading, ...inA.filter((b) => b.id !== heading.id).map((b) => structuredClone(b))]);
      return read(B);
    });
    const ids = (bs: Obj[]): string[] =>
      bs.flatMap((b) => [String(b.id), ...(Array.isArray(b.children) ? ids(b.children as Obj[]) : [])]);
    const want = ids([paragraph, list]);
    const kept = want.filter((x) => ids(inB).includes(x));
    record(
      '1',
      'a block written to another document keeps its id (and its children theirs)',
      kept.length === want.length ? 'pass' : 'fail',
      `${kept.length} of ${want.length} ids kept (${want.filter((x) => !kept.includes(x)).join(', ') || 'none lost'})`,
    );
    const moved = inB.filter((b) => b.id === paragraph.id || b.id === list.id);
    const verbatim =
      moved.length === 2 &&
      moved.every((b) =>
        same(
          b,
          inA.find((x) => x.id === b.id),
        ),
      );
    record(
      '2',
      'the moved blocks arrive verbatim (runs, marks, nested list)',
      verbatim ? 'pass' : 'fail',
      verbatim ? 'identical but for versions' : `in A: ${stableJson(inA)}; in B: ${stableJson(inB)}`,
    );

    // (3) A's own edit: the blocks out, an interface summary in their place.
    const after = await steps.step('3', 'the source’s own edit, then the destination read', async () => {
      await write(A, [
        heading,
        {
          id: mintClientId(),
          kind: 'paragraph',
          content: [{ text: 'Summarised; see ' }, { mention: { resourceId: B.resourceId } }],
        },
      ]);
      return read(B);
    });
    record(
      '3',
      'the source’s own edit leaves the destination’s copy as it is',
      stableJson(withoutVersions(after)) === stableJson(withoutVersions(inB)) ? 'pass' : 'fail',
      `B holds ${after.length} blocks after A's edit`,
    );

    // (4) An id B already uses: what LegendKeeper does is recorded.
    try {
      const twice = await steps.step('4', 'a second block with an id B already uses', async () => {
        await write(B, [
          ...after,
          { id: paragraph.id, kind: 'paragraph', content: [{ text: 'a second block, same id' }] },
        ]);
        return read(B);
      });
      const n = twice.filter((b) => b.id === paragraph.id).length;
      record(
        '4',
        'a requested id the destination already uses',
        'noted',
        n > 1
          ? 'LegendKeeper KEPT the id twice in one document: the split never sends this (it derives another id)'
          : `LegendKeeper accepted the write and gave the second block another id (${twice.length} blocks)`,
      );
    } catch (e) {
      if (e instanceof StepTimeoutError) throw e; // a hang is no refusal
      record(
        '4',
        'a requested id the destination already uses',
        'noted',
        `LegendKeeper refused it (${wholeError(e)}): the split never sends this (it derives another id)`,
      );
    }
  } finally {
    await steps.cleanup();
  }
  return items;
}

/** The report as the real run prints it, every item whole, and the requests counted at the transport. */
export function formatSplitIdsReport(
  items: readonly SplitIdsItem[],
  counters: Pick<HttpCounters, 'reads' | 'writes'>,
): string {
  return (
    `\nsplit block-id sandbox check:\n${items
      .map((i) => `${i.id} ${i.verdict.toUpperCase()}: ${i.title} (${i.detail})`)
      .join('\n')}\n` +
    `requests: ${counters.reads} reads, ${counters.writes} writes (counted at the transport)\n`
  );
}
