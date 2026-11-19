/**
 * CR-2026-11-R3 (R3-37): "Propose these again" puts back the routing line a partial approval left out of an index
 * (src/jobs/route-back.ts). Pure: the line goes back where it stood, inside the page's lock, on the document as it is.
 */
import { describe, expect, it } from 'vitest';
import { applyRouteBack, type RouteBackInput } from '../../../src/jobs/route-back.js';

type Obj = Record<string, unknown>;
const heading = (id: string, text: string): Obj => ({ id, kind: 'heading', level: 2, content: [{ text }] });
const line = (id: string, page: string, text: string): Obj => ({
  id,
  kind: 'listItem',
  children: [{ id: `${id}p`, kind: 'paragraph', content: [{ mention: { resourceId: page } }, { text }] }],
});
const route: RouteBackInput = {
  item: 'page:personality',
  section: 'How to Use This Index',
  line: line('lp', 'pers', ': the temperament'),
  listId: 'list1',
  after: 'lc',
  pageId: 'pers',
  where: '[INDEX] Kaede › How to Use This Index',
};
const doc = (): Obj[] => [
  heading('h1', 'How to Use This Index'),
  {
    id: 'list1',
    kind: 'bulletList',
    children: [line('lc', 'core', ': the core'), line('lb', 'bio', ': the life')],
  },
  heading('h2', 'Pages'),
];

describe('R3-37: the routing line put back', () => {
  it('goes back into its list, after the line it followed', () => {
    const o = applyRouteBack(doc(), route);
    expect(o.state).toBe('apply');
    const list = (o as { blocks: Obj[] }).blocks[1]!;
    expect((list.children as Obj[]).map((c) => c.id)).toEqual(['lc', 'lp', 'lb']);
  });

  it('a section that already routes to the page sends nothing', () => {
    const d = doc();
    (d[1]!.children as Obj[]).push(line('other', 'pers', ': added by hand'));
    expect(applyRouteBack(d, route)).toEqual({ state: 'done' });
  });

  it('a section that is gone is said, and nothing is written', () => {
    expect(applyRouteBack([heading('h2', 'Pages')], route)).toMatchObject({ state: 'missing' });
  });

  it('its list gone: a new list at the end of the section (the heading after it untouched)', () => {
    const o = applyRouteBack([heading('h1', 'How to Use This Index'), heading('h2', 'Pages')], route);
    expect((o as { blocks: Obj[] }).blocks.map((b) => b.id)).toEqual(['h1', 'list1', 'h2']);
  });
});
