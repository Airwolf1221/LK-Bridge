/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * v3 F3e (ADR 0059): manual splitting steered away, as F3d.1 steers renames. On a project whose approved pack has split
 * rules, `write_page` refuses an edit that takes a section's worth of text (the pack's `guardWords`) off a pack page with
 * `USE_ARKONA_SPLIT` and a hint naming the two split tools; `plainEdit: { reason }` lets a page's own revision through,
 * with its reason kept for the owner; a small edit is never refused.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROJECT, S, splitWorld, type SplitWorld } from './split-world.js';
import { bodyOf, settle, textOf } from './split-helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

describe('write_page on a pack page: a split is never made by hand', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    // v3 F12 (ADR 0081): at scope write (the refusals refuse there; a plain edit runs directly).
    w = await splitWorld({ toolModes: 'seed' });
  });
  afterAll(() => w?.close());

  const read = async () => {
    const r = await w.call('read_document', { resource: S.zahra, project: 'test' });
    return String((r.body as any).version);
  };

  it('taking a section’s worth of text off a pack page is refused with USE_ARKONA_SPLIT and the way to split', async () => {
    const before = w.requests().writes;
    const r = await w.call('write_page', {
      page: S.zahra,
      mode: 'replace_section',
      section: 'Biography',
      markdown: '## Biography\n\nHer life is told elsewhere.\n',
      baseVersion: await read(),
      project: 'test',
    });
    expect(r.isError, r.text).toBe(true);
    const e = (r.body as any).error;
    expect(e.code).toBe('USE_ARKONA_SPLIT');
    expect(e.useTool).toBe('arkona_split_owner');
    expect(e.hint).toContain('arkona_split_appraisal');
    expect(e.message).toContain('a page of a character’s set');
    expect(e.removedWords).toBeGreaterThanOrEqual(120);
    expect(w.requests().writes).toBe(before);
  });

  it('a small edit is never refused', async () => {
    const r = await w.call('write_page', {
      page: S.zahra,
      mode: 'replace_section',
      section: 'Habits',
      markdown: '## Habits\n\nShe counts her coins twice.\n',
      baseVersion: await read(),
      project: 'test',
    });
    expect(r.isError, r.text).toBe(false);
  });

  it('plainEdit: a page’s own revision passes, its reason kept for the owner', async () => {
    const r = await w.call('write_page', {
      page: S.zahra,
      mode: 'replace_section',
      section: 'Biography',
      markdown: '## Biography\n\nHer life, retold briefly by the owner’s request.\n',
      baseVersion: await read(),
      plainEdit: { reason: 'the owner cut the biography to a line' },
      project: 'test',
    });
    expect(r.isError, r.text).toBe(false);
    expect((r.body as any).status).toBe('written');
    const job = await settle(w, String((r.body as any).jobId));
    expect(job.title).toContain('the owner cut the biography to a line');
    expect(bodyOf(w, S.zahra).map(textOf)).toContain('Her life, retold briefly by the owner’s request.');
    void PROJECT;
  });
});
