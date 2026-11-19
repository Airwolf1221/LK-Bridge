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
 */
import { describe, expect, it } from 'vitest';
import { mintClientId, type OpParams, type StepOptions } from '../../src/jobs/index.js';
import { stableJson } from '../../src/jobs/sidebar-state.js';
import { withoutVersions } from '../../src/pages/blockwise.js';
import { createSoakRuntime, type SoakRuntime } from './soak.js';
import { resolveSandboxTarget } from './target.js';

const projectName = process.env.LKB_SANDBOX_PROJECT;

type Obj = Record<string, any>;

interface Item {
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

async function runCheck(sb: SoakRuntime): Promise<Item[]> {
  const items: Item[] = [];
  const record = (id: string, title: string, verdict: Item['verdict'], detail: string) =>
    items.push({ id, title, verdict, detail });
  const run = async (op: string, params: OpParams, options: StepOptions = {}) => {
    const r = await sb.runtime.engine.run(op, params, {
      project: sb.projectId,
      origin: { kind: 'test', client: 'sandbox', tool: 'split-ids' },
      priority: 'P2',
      ...options,
    });
    if (r.status !== 'succeeded') throw new Error(`${op}: ${r.status}`);
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
  try {
    const A = await page('A');
    made.push(A.resourceId);
    const B = await page('B');
    made.push(B.resourceId);
    const { paragraph, list } = movedBlocks();
    const heading = { id: mintClientId(), kind: 'heading', level: 2, content: [{ text: 'Purpose' }] };
    await write(A, [heading, paragraph, list]);
    const inA = await read(A);

    // (1) and (2): written to B with A's ids.
    const bHeading = { id: mintClientId(), kind: 'heading', level: 2, content: [{ text: 'Purpose' }] };
    await write(B, [bHeading, ...inA.filter((b) => b.id !== heading.id).map((b) => structuredClone(b))]);
    const inB = await read(B);
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
    await write(A, [
      heading,
      {
        id: mintClientId(),
        kind: 'paragraph',
        content: [{ text: 'Summarised; see ' }, { mention: { resourceId: B.resourceId } }],
      },
    ]);
    const after = await read(B);
    record(
      '3',
      'the source’s own edit leaves the destination’s copy as it is',
      stableJson(withoutVersions(after)) === stableJson(withoutVersions(inB)) ? 'pass' : 'fail',
      `B holds ${after.length} blocks after A's edit`,
    );

    // (4) An id B already uses: what LegendKeeper does is recorded.
    try {
      await write(B, [
        ...after,
        { id: paragraph.id, kind: 'paragraph', content: [{ text: 'a second block, same id' }] },
      ]);
      const twice = await read(B);
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
      record(
        '4',
        'a requested id the destination already uses',
        'noted',
        `LegendKeeper refused it (${(e as Error).message}): the split never sends this (it derives another id)`,
      );
    }
  } finally {
    for (const id of made.reverse()) {
      try {
        await run(
          'deleteResource',
          { path: { resourceId: id }, query: { cascade: true } },
          { confirm: 'cascade' },
        );
      } catch (e) {
        record(
          'cleanup',
          'a throwaway page deleted',
          'fail',
          `${id}: ${(e as Error).message}. Delete it by hand.`,
        );
      }
    }
  }
  return items;
}

describe.skipIf(!projectName)(
  'LegendKeeper sandbox: block ids across documents, for arkona_split_owner (writes, then cleans up)',
  () => {
    it('a moved block keeps its id and arrives verbatim; the source’s edit leaves it as it is', async () => {
      const target = resolveSandboxTarget(projectName);
      const sandbox = await createSoakRuntime({
        apiKey: target.apiKey,
        project: target.name,
        ...(process.env.LK_BASE_URL ? { baseUrl: process.env.LK_BASE_URL } : {}),
      });
      try {
        const items = await runCheck(sandbox);
        process.stdout.write(
          `\nsplit block-id sandbox check:\n${items
            .map((i) => `${i.id} ${i.verdict.toUpperCase()}: ${i.title} (${i.detail})`)
            .join('\n')}\n` +
            `requests: ${sandbox.counters.reads} reads, ${sandbox.counters.writes} writes (counted at the transport)\n`,
        );
        expect(items.filter((i) => i.verdict === 'fail').map((i) => `${i.id}: ${i.detail}`)).toEqual([]);
      } finally {
        await sandbox.close();
      }
    }, 900_000);
  },
);
