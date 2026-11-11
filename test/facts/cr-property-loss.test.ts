/**
 * CR-2026-11, findings CR-01 and CR-02 (data loss on the sidebar):
 *
 * - CR-02: a sidebar property can be `unsupported` itself (TAGS) or hold `unsupported` blocks (a text field's
 *   children). LegendKeeper cannot recreate either, and has no restore for a property. `deleteProperty` and an
 *   `updateProperty` that replaces a text field's children were not guarded: the unsupported-block guard (PLAN §4 rule
 *   2, CLAUDE.md "never drop unsupported blocks") now refuses them unless the caller passes `allowUnsupportedLoss`.
 * - CR-01: a deleted property kept only its id in the journal, though LegendKeeper cannot restore it: the journal now
 *   keeps the property as it was (rows, items, children), so the owner can rebuild it by hand.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT } from '../tools/helpers.js';
import { factsWorld, P, type FactsWorld } from './world.js';

let w: FactsWorld;
beforeAll(async () => {
  w = await factsWorld({
    seed: () => undefined,
  });
  // A text field on Mehrana's sidebar holding an `unsupported` block between two paragraphs.
  w.sidebars.pages.get(P.mehrana)!.props.push({
    id: 'txtmehr1',
    kind: 'textField',
    title: 'Notes',
    rank: 'r0000zzzz',
    children: [
      { id: 'tp000001', kind: 'paragraph', content: [{ text: 'before' }] },
      { id: 'tu000001', kind: 'unsupported' },
      { id: 'tp000002', kind: 'paragraph', content: [{ text: 'after' }] },
    ],
  });
});
afterAll(async () => w.close());

const origin = { kind: 'system' as const, tool: 'test_cr02' };
const run = (op: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  w.stack.runtime.engine.run(op, params, { project: PROJECT, origin, ...extra });
const has = (page: string, id: string) => w.sidebars.pages.get(page)!.props.some((p) => p.id === id);
const writes = () => w.sidebars.requests.filter((r) => r.method !== 'GET').length;

describe('CR-02: unsupported sidebar content is never dropped unguarded', () => {
  it('refuses to delete an unsupported property (TAGS); nothing is sent', async () => {
    const before = writes();
    await expect(
      run('deleteProperty', { path: { resourceId: P.miyabi, propertyId: 'tagsmiya' } }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_BLOCK_LOSS' });
    expect(has(P.miyabi, 'tagsmiya')).toBe(true);
    expect(writes()).toBe(before);
  });

  it('refuses to delete a text field that holds an unsupported block', async () => {
    await expect(
      run('deleteProperty', { path: { resourceId: P.mehrana, propertyId: 'txtmehr1' } }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_BLOCK_LOSS' });
    expect(has(P.mehrana, 'txtmehr1')).toBe(true);
  });

  it('refuses an updateProperty whose new children leave the unsupported block out', async () => {
    await expect(
      run('updateProperty', {
        path: { resourceId: P.mehrana, propertyId: 'txtmehr1' },
        body: { children: [{ kind: 'paragraph', content: [{ text: 'all new' }] }] },
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_BLOCK_LOSS' });
    const prop = w.sidebars.pages.get(P.mehrana)!.props.find((p) => p.id === 'txtmehr1')!;
    expect(prop.children?.map((b) => b.id)).toEqual(['tp000001', 'tu000001', 'tp000002']);
  });

  it('allows an updateProperty that echoes the unsupported block, and one that sends no children', async () => {
    const r = await run('updateProperty', {
      path: { resourceId: P.mehrana, propertyId: 'txtmehr1' },
      body: {
        children: [
          { id: 'tp000001', kind: 'paragraph', content: [{ text: 'changed' }] },
          { id: 'tu000001', kind: 'unsupported' },
        ],
      },
    });
    expect(r.status).toBe('succeeded');
    const t = await run('updateProperty', {
      path: { resourceId: P.mehrana, propertyId: 'txtmehr1' },
      body: { title: 'Notes (kept)' },
    });
    expect(t.status).toBe('succeeded');
  });

  it('deletes it with allowUnsupportedLoss, keeping the property in the journal', async () => {
    const r = await run(
      'deleteProperty',
      { path: { resourceId: P.miyabi, propertyId: 'tagsmiya' } },
      { allowUnsupportedLoss: true },
    );
    expect(r.status).toBe('succeeded');
    expect(has(P.miyabi, 'tagsmiya')).toBe(false);
    const [entry] = w.stack.runtime.engine.queries.journalLookup(PROJECT, {
      jobId: (r as { jobId: string }).jobId,
    });
    expect(entry?.preImage).toMatchObject({ id: 'tagsmiya', kind: 'unsupported', title: 'TAGS' });
  });
});

describe('CR-01: a property delete keeps a pre-image the owner can restore from', () => {
  it('keeps a link collection’s items and filter', async () => {
    const r = await run('deleteProperty', { path: { resourceId: P.miyabi, propertyId: 'depmiya1' } });
    expect(r.status).toBe('succeeded');
    const [entry] = w.stack.runtime.engine.queries.journalLookup(PROJECT, {
      jobId: (r as { jobId: string }).jobId,
    });
    const pre = entry?.preImage as { title?: string; items?: { resourceId: string }[]; filter?: unknown };
    expect(pre.title).toBe('Dependencies');
    expect(pre.items?.map((i) => i.resourceId)).toEqual(['age40001', 'kaede001']);
    expect(pre.filter).toEqual({ kind: 'tag', tag: 'canon' });
  });
});
