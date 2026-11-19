/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * v3 F3f (ADR 0060, part D): routing lines are plain mentions. The bridge's own writers (F3a's drafted index text and
 * appended lines, F3b's repointed line, F3e's index lines, which use F3a's) emit a mention with no custom label, so it
 * always shows the page's current name. The appraisal reports a labelled mention in a routing section as optional
 * polish whose follow-up is `none` ("change it in the app"): LegendKeeper's API cannot change a mention's custom label.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fromMarkdown } from '../../src/markdown/index.js';
import { draftIndexText, routingLine } from '../../src/packs/engine/plan.js';
import { R, retagWorld, type RetagWorld } from './retag-world.js';

vi.setConfig({ testTimeout: 180_000 });

const mentionsOf = (blocks: unknown[]): Record<string, unknown>[] => {
  const out: Record<string, unknown>[] = [];
  const walk = (b: any) => {
    for (const r of b?.content ?? []) if (r?.mention) out.push(r.mention);
    for (const c of b?.children ?? []) walk(c);
  };
  for (const b of blocks) walk(b);
  return out;
};

describe('the routing-line writers', () => {
  it('emit plain mentions (no custom label), keeping the rest of the line', () => {
    const line = routingLine({
      rawName: '[BSRC] Ilsa Varn - Character Core',
      id: 'abcd1234',
      scope: 'Her identity',
    });
    expect(line).toBe('- [](lk://resources/abcd1234): Her identity');
    const drafted = draftIndexText(
      {
        purpose: 'Routes to {Name}.',
        routing: 'How to Use This Index',
        collection: 'Subpages',
        boundaries: 'Index Boundaries',
        boundariesText: 'Only routes.',
      },
      'Ilsa Varn',
      [{ id: 'efgh5678', name: '[BSRC] Ilsa Varn - Character Core', scope: 'Her identity' }],
    );
    expect(drafted).toContain('- [](lk://resources/efgh5678): Her identity');
    const blocks = fromMarkdown(drafted, { blocks: [] }).blocks as unknown[];
    expect(mentionsOf(blocks)).toEqual([{ resourceId: 'efgh5678' }]);
  });
});

describe('the appraisal finding', () => {
  let w: RetagWorld;
  beforeAll(async () => {
    w = await retagWorld();
    w.repo.blocks.set(w.mainOf(R.routing), {
      version: 1,
      blocks: [
        { id: 'rth1', kind: 'heading', level: 2, content: [{ text: 'Purpose' }] },
        { id: 'rtp1', kind: 'paragraph', content: [{ text: 'Routes to the desk’s pages.' }] },
        { id: 'rth2', kind: 'heading', level: 2, content: [{ text: 'How to Use This Index' }] },
        {
          id: 'rtl1',
          kind: 'bulletList',
          children: [
            {
              id: 'rtli1',
              kind: 'listItem',
              children: [
                {
                  id: 'rtlp1',
                  kind: 'paragraph',
                  content: [
                    { mention: { resourceId: R.ok, text: 'Corlath (old name)' } },
                    { text: ': A march' },
                  ],
                },
              ],
            },
            {
              id: 'rtli2',
              kind: 'listItem',
              children: [
                {
                  id: 'rtlp2',
                  kind: 'paragraph',
                  content: [{ mention: { resourceId: R.order } }, { text: ': A shore' }],
                },
              ],
            },
          ],
        },
      ],
    });
    await w.snapshot();
  });
  afterAll(async () => w?.close());

  it('reports a labelled mention in a routing section as polish, with follow-up none (change it in the app)', async () => {
    const r = await w.call('arkona_appraise_owner', {
      page: R.routing,
      limit: 200,
      detail: 'full',
      project: 'test',
    });
    expect(r.isError, r.text).toBe(false);
    const found = (r.body.findings as any[]).filter((f) => f.check === 'routing_labelled_mention');
    expect(found).toHaveLength(1); // the plain mention is not reported
    expect(found[0]).toMatchObject({
      group: 'polish',
      followUp: { kind: 'none' },
      details: { label: 'Corlath (old name)', target: { id: R.ok } },
    });
    expect(JSON.stringify(found[0].followUp)).toMatch(/change it in the app/);
    const fix = await w.call('arkona_appraisal_fix', { findingId: found[0].id, project: 'test' });
    expect(fix.isError).toBe(true);
  });
});
