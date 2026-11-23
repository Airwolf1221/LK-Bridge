/**
 * v3 F7 (ADR 0070, G10): a titled block's default `title` and `isTitleHidden`, and the warning's wording.
 *
 * Evidence: jobs jkrmpgt21y38x5dp and j5udx2rpurxqcj9k, reproduced by j3u162l831nskgsl (a write_page adding one image
 * block) on 23 November 2026: `[41].isTitleHidden expected (absent) actual true`, `[41].title expected (absent) actual
 * "Image"`.
 */
import { describe, expect, it } from 'vitest';
import {
  compareStoredBlocks,
  mismatchCause,
  mismatchWarning,
  TITLED_BLOCK_DEFAULTS,
  TITLED_BLOCK_KINDS,
  VERIFY_IGNORED_FIELDS,
} from '../../src/jobs/verify-blocks.js';
import { jobMismatchWarning } from '../../src/mcp/tools/write-job.js';

const para = (id: string, text: string) => ({ id, kind: 'paragraph', content: [{ text }] });
const image = (over: Record<string, unknown> = {}) => ({
  id: 'img00001',
  kind: 'image',
  url: 'https://assets.legendkeeper.com/p_1.webp',
  alt: 'Portrait',
  ...over,
});

describe('G10: titled block defaults', () => {
  it('an image block sent without either field and stored with LegendKeeper’s default is verified', () => {
    const r = compareStoredBlocks(
      [para('a', 'Hello'), image()],
      [para('a', 'Hello'), image({ title: 'Image', isTitleHidden: true })],
    );
    expect(r).toMatchObject({ ok: true, count: 0 });
  });

  it('with title "Caption" sent and stored: verified (the unsent isTitleHidden at its default is LegendKeeper’s)', () => {
    const sent = image({ title: 'Caption' });
    expect(compareStoredBlocks([sent], [image({ title: 'Caption', isTitleHidden: true })]).ok).toBe(true);
    expect(compareStoredBlocks([sent], [image({ title: 'Caption' })]).ok).toBe(true);
    const both = image({ title: 'Caption', isTitleHidden: false });
    expect(compareStoredBlocks([both], [image({ title: 'Caption', isTitleHidden: false })]).ok).toBe(true);
    // A value the plan sent is always compared.
    expect(compareStoredBlocks([both], [image({ title: 'Caption', isTitleHidden: true })]).ok).toBe(false);
  });

  it('sent "Caption", stored "Image": a difference', () => {
    const r = compareStoredBlocks([image({ title: 'Caption' })], [image({ title: 'Image' })]);
    expect(r.ok).toBe(false);
    expect(r.differences[0]).toMatchObject({ path: '[0].title', expected: 'Caption', actual: 'Image' });
  });

  it('not sent, stored "Something": a difference (only the recorded default is LegendKeeper’s)', () => {
    const r = compareStoredBlocks([image()], [image({ title: 'Something', isTitleHidden: true })]);
    expect(r.ok).toBe(false);
    expect(r.differences.map((d) => d.path)).toEqual(['[0].title']);
    const shown = compareStoredBlocks([image()], [image({ title: 'Image', isTitleHidden: false })]);
    expect(shown.ok).toBe(false);
  });

  it('a kind not yet confirmed (embed) still reports the difference', () => {
    expect(TITLED_BLOCK_DEFAULTS.embed).toBeUndefined();
    const embed = { id: 'e1', kind: 'embed', url: 'https://example.org/x' };
    const r = compareStoredBlocks([embed], [{ ...embed, title: 'Embed', isTitleHidden: true }]);
    expect(r.ok).toBe(false);
    expect(r.count).toBe(2);
  });

  it('the defaults table holds only titled kinds, and the rule is listed among the ignored fields', () => {
    for (const k of Object.keys(TITLED_BLOCK_DEFAULTS)) expect(TITLED_BLOCK_KINDS).toContain(k);
    expect(TITLED_BLOCK_KINDS).toHaveLength(8);
    expect(VERIFY_IGNORED_FIELDS.some((f) => /isTitleHidden/.test(f))).toBe(true);
  });

  it('nested: an image inside a layout column is relieved the same way', () => {
    const col = (children: unknown[]) => ({ id: 'c1', kind: 'callout', children });
    expect(
      compareStoredBlocks([col([image()])], [col([image({ title: 'Image', isTitleHidden: true })])]).ok,
    ).toBe(true);
  });
});

describe('G10: the warning’s wording', () => {
  const planned = [para('a', 'Kept'), para('b', 'Written')];
  const before = [para('a', 'Kept')];

  it('a difference in a block the plan wrote, same version: LegendKeeper may have changed it on save', () => {
    const stored = [para('a', 'Kept'), para('b', 'Changed')];
    const cmp = compareStoredBlocks(planned, stored);
    const cause = mismatchCause(cmp.differences, planned, before, { written: 'v2', stored: 'v2' });
    expect(cause).toBe('stored_differently');
    const w = mismatchWarning({ cause, count: cmp.count, first: cmp.differences[0], tail: 'Read the page.' });
    expect(w).toMatch(/LegendKeeper may have changed it on save/);
    expect(w).toMatch(/"Written"/);
    expect(w).not.toMatch(/something else/);
  });

  it('a difference in a block the plan did not write: something else may have edited the page', () => {
    const stored = [para('a', 'Edited in the app'), para('b', 'Written')];
    const cmp = compareStoredBlocks(planned, stored);
    const cause = mismatchCause(cmp.differences, planned, before, { written: 'v2', stored: 'v2' });
    expect(cause).toBe('concurrent_edit');
    expect(mismatchWarning({ cause, count: cmp.count, first: cmp.differences[0], tail: '' })).toMatch(
      /something else may have edited the page at the same moment/,
    );
  });

  it('a version other than the one the write returned: something else may have edited the page', () => {
    const stored = [para('a', 'Kept'), para('b', 'Changed')];
    const cmp = compareStoredBlocks(planned, stored);
    expect(mismatchCause(cmp.differences, planned, before, { written: 'v2', stored: 'v3' })).toBe(
      'concurrent_edit',
    );
  });

  it('a block the plan never sent: something else', () => {
    const stored = [para('a', 'Kept'), para('b', 'Written'), para('c', 'Added elsewhere')];
    const cmp = compareStoredBlocks(planned, stored);
    expect(mismatchCause(cmp.differences, planned, before, {})).toBe('concurrent_edit');
  });

  it('a job’s warning follows its verifications’ causes', () => {
    expect(jobMismatchWarning({ status: 'mismatch', cause: 'concurrent_edit' }, 'j1')).toMatch(
      /something else may have edited/,
    );
    const quiet = jobMismatchWarning(
      [
        { status: 'verified' },
        {
          status: 'mismatch',
          cause: 'stored_differently',
          differences: [{ path: '[3].title', expected: '(absent)', actual: 'Image' }],
        },
      ],
      'j1',
    );
    expect(quiet).toMatch(/LegendKeeper may have changed it on save/);
    expect(quiet).toMatch(/\[3\]\.title/);
    expect(quiet).not.toMatch(/something else/);
  });
});
