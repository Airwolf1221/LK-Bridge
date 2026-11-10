/**
 * Property-based tests of the converter's central promise (docs/PLAN-v2.md 4.7 rules 1 and 2):
 *
 * 1. For a page Markdown can express, the parser reads the Markdown back as exactly the blocks' projection, and the
 *    renderer never had to fall back to a keep region.
 * 2. For any page (keep regions included), blocks → Markdown → blocks is the identity, ids and attributes included,
 *    and the write plan is empty.
 * 3. The Markdown is stable: converting it without the page and rendering again gives byte-identical Markdown.
 * 4. Editing one paragraph changes that block only, exactly the one edited (also among identical twins); everything
 *    else keeps its id and attributes in its own place.
 *
 * Runs per property: FC_RUNS (default 300; run 10,000 locally after touching the converter). A failure logs its seed,
 * path and counterexample; FC_SEED and FC_PATH replay it (helpers.ts, assertProperty). Counterexamples found are kept
 * as fixed `examples`.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fromMarkdown, projectDocument, toMarkdown } from '../../src/markdown/index.js';
import { CODE_PIPE_REASON } from '../../src/markdown/model.js';
import type { LkBlock } from '../../src/markdown/types.js';
import { pageArb } from './arbitraries.js';
import { allBlocks, assertProperty, fcParams, parsedProjection } from './helpers.js';

const params = fcParams(300);
/** The property test count. */
export const PROPERTY_RUNS = params.numRuns;
const REWRITTEN = 'Rewritten by an agent';

/**
 * Counterexamples found by the edit property, kept as fixed cases (run before the random ones on every run).
 * 1. Found once in CI: an `unsupported` block followed by two empty paragraphs, the second one edited (and, for
 *    symmetry, the first). The exact LCS broke ties towards the last twin, so the first twin lost its id and the edit
 *    became a new block (test/markdown/twins.test.ts has the close variants).
 */
const EDIT_EXAMPLES: [LkBlock[], number][] = [
  [
    [
      { id: 'b0000000', kind: 'unsupported' },
      { id: 'b0000001', kind: 'paragraph', content: [] },
      { id: 'b0000002', kind: 'paragraph', content: [] },
    ],
    1,
  ],
  [
    [
      { id: 'b0000000', kind: 'unsupported' },
      { id: 'b0000001', kind: 'paragraph', content: [] },
      { id: 'b0000002', kind: 'paragraph', content: [] },
    ],
    0,
  ],
];

/** One property as one test: `assertProperty` logs the seed, path and counterexample of a failure. */
function property<Ts>(name: string, build: () => fc.IProperty<Ts>, opts: fc.Parameters<Ts> = params): void {
  it(name, () => assertProperty(name, build(), opts));
}

describe('Markdown converter properties', { timeout: 600_000 }, () => {
  property('reads an expressible page back as exactly its projection, with no keep regions', () =>
    fc.property(pageArb({ keep: false, depth: 3 }), (blocks) => {
      const r = toMarkdown(blocks);
      expect(r.warnings).toEqual([]);
      // The one thing the generator can make that GFM cannot write: see CODE_PIPE_REASON.
      expect(r.regions.filter((x) => x.reason !== CODE_PIPE_REASON)).toEqual([]);
      expect(parsedProjection(r.markdown)).toEqual(projectDocument(blocks));
    }),
  );

  property('blocks → Markdown → blocks is the identity (ids and attributes), with an empty plan', () =>
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
  );

  property('Markdown converted without the page and rendered again is byte-identical', () =>
    fc.property(pageArb({ keep: false, depth: 2 }), (blocks) => {
      const r = toMarkdown(blocks);
      if (r.regions.length > 0) return; // a keep region needs its page
      const md = r.markdown;
      const fresh = fromMarkdown(md, []).blocks;
      expect(toMarkdown(fresh).markdown).toBe(md);
      expect(fromMarkdown(md, fresh).plan.empty).toBe(true);
    }),
  );

  property(
    'editing one paragraph changes that block only',
    () => {
      const page = pageArb({ keep: true, depth: 1, max: 8 }).filter((b) =>
        b.some((x) => x.kind === 'paragraph'),
      );
      return fc.property(page, fc.nat(), (blocks, pick) => {
        const regions = new Set(toMarkdown(blocks).regions.map((r) => r.id));
        const paras = blocks.filter((b) => b.kind === 'paragraph' && !regions.has(b.id!));
        if (paras.length === 0) return;
        const target = paras[pick % paras.length]!;
        const edited = blocks.map((b) => (b === target ? { ...b, content: [{ text: REWRITTEN }] } : b));
        // The agent edits the Markdown of the page: render the edited tree, convert against the original.
        const md = toMarkdown(edited).markdown;
        const res = fromMarkdown(md, blocks);
        if (JSON.stringify(target.content) === JSON.stringify([{ text: REWRITTEN }])) {
          expect(res.plan.empty).toBe(true);
          return;
        }
        // Exactly the edited block changes, also when it has identical twins; nothing is added, removed or moved,
        // and every other block keeps its id and attributes in its own place.
        expect(res.plan.added).toEqual([]);
        expect(res.plan.removed).toEqual([]);
        expect(res.plan.moved).toEqual([]);
        expect(res.plan.changed.map((c) => c.id)).toEqual([target.id]);
        expect(res.blocks).toEqual(edited);
      });
    },
    { ...params, examples: EDIT_EXAMPLES },
  );
});
