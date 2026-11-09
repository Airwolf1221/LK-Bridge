/**
 * Property-based tests of the converter's central promise (docs/PLAN-v2.md 4.7 rules 1 and 2):
 *
 * 1. For a page Markdown can express, the parser reads the Markdown back as exactly the blocks' projection, and the
 *    renderer never had to fall back to a keep region.
 * 2. For any page (keep regions included), blocks → Markdown → blocks is the identity, ids and attributes included,
 *    and the write plan is empty.
 * 3. The Markdown is stable: converting it without the page and rendering again gives byte-identical Markdown.
 * 4. Editing one paragraph changes that block only; everything else keeps its id and object.
 *
 * Runs per property: FC_RUNS (default 300). FC_SEED replays a failure.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fromMarkdown, projectDocument, toMarkdown } from '../../src/markdown/index.js';
import { CODE_PIPE_REASON } from '../../src/markdown/model.js';
import type { LkBlock } from '../../src/markdown/types.js';
import { pageArb } from './arbitraries.js';
import { allBlocks, parsedProjection } from './helpers.js';

const RUNS = Number(process.env.FC_RUNS ?? 300);
const SEED = process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined;
const params = { numRuns: RUNS, ...(SEED !== undefined ? { seed: SEED } : {}) };
/** The property test count, reported by the summary test below. */
export const PROPERTY_RUNS = RUNS;

describe('Markdown converter properties', { timeout: 600_000 }, () => {
  it('reads an expressible page back as exactly its projection, with no keep regions', () => {
    fc.assert(
      fc.property(pageArb({ keep: false, depth: 3 }), (blocks) => {
        const r = toMarkdown(blocks);
        expect(r.warnings).toEqual([]);
        // The one thing the generator can make that GFM cannot write: see CODE_PIPE_REASON.
        expect(r.regions.filter((x) => x.reason !== CODE_PIPE_REASON)).toEqual([]);
        expect(parsedProjection(r.markdown)).toEqual(projectDocument(blocks));
      }),
      params,
    );
  });

  it('blocks → Markdown → blocks is the identity (ids and attributes), with an empty plan', () => {
    fc.assert(
      fc.property(pageArb({ keep: true, depth: 2 }), (blocks) => {
        const before = structuredClone(blocks);
        const md = toMarkdown(blocks).markdown;
        const back = fromMarkdown(md, blocks);
        expect(back.blocks).toEqual(blocks);
        expect(back.plan.empty).toBe(true);
        expect(back.plan.kept).toBe(allBlocks(blocks).length);
        expect(back.warnings).toEqual([]);
        expect(blocks).toEqual(before); // the input is never mutated
        expect(toMarkdown(back.blocks).markdown).toBe(md);
      }),
      params,
    );
  });

  it('Markdown converted without the page and rendered again is byte-identical', () => {
    fc.assert(
      fc.property(pageArb({ keep: false, depth: 2 }), (blocks) => {
        const r = toMarkdown(blocks);
        if (r.regions.length > 0) return; // a keep region needs its page
        const md = r.markdown;
        const fresh = fromMarkdown(md, []).blocks;
        expect(toMarkdown(fresh).markdown).toBe(md);
        expect(fromMarkdown(md, fresh).plan.empty).toBe(true);
      }),
      params,
    );
  });

  it('editing one paragraph changes that block only', () => {
    const page = pageArb({ keep: true, depth: 1, max: 8 }).filter((b) =>
      b.some((x) => x.kind === 'paragraph'),
    );
    fc.assert(
      fc.property(page, fc.nat(), (blocks, pick) => {
        const regions = new Set(toMarkdown(blocks).regions.map((r) => r.id));
        const paras = blocks.filter((b) => b.kind === 'paragraph' && !regions.has(b.id!));
        if (paras.length === 0) return;
        const target = paras[pick % paras.length]!;
        const edited = blocks.map((b) =>
          b === target ? { ...b, content: [{ text: 'Rewritten by an agent' }] } : b,
        );
        // The agent edits the Markdown of the page: render the edited tree, convert against the original.
        const md = toMarkdown(edited).markdown;
        const res = fromMarkdown(md, blocks);
        const changedIds = res.plan.changed.map((c) => c.id);
        if (JSON.stringify(target.content) === JSON.stringify([{ text: 'Rewritten by an agent' }])) {
          expect(res.plan.empty).toBe(true);
          return;
        }
        // Identical neighbouring paragraphs may be matched either way round: the edit lands on one paragraph.
        expect(res.plan.added).toEqual([]);
        expect(res.plan.removed).toEqual([]);
        expect(changedIds).toHaveLength(1);
        const changed = res.blocks.find((b) => b.id === changedIds[0]) as LkBlock;
        expect(changed.content).toEqual([{ text: 'Rewritten by an agent' }]);
        for (const b of res.blocks) if (b.id !== changedIds[0]) expect(blocks).toContainEqual(b);
      }),
      { ...params, numRuns: Math.max(50, Math.floor(RUNS / 3)) },
    );
  });
});
