/**
 * ADR 0057 decision 4 (R2-52): whether a whole-list write through a low-level tool drops an entry LegendKeeper holds now
 * (src/policy/list-drops.ts), pure.
 */
import { describe, expect, it } from 'vitest';
import { currentRead, dropsEntries, listDropsReader } from '../../src/policy/list-drops.js';

const items = [
  { id: 'i1', rank: 'a', resourceId: 'pg1' },
  { id: 'i2', rank: 'b', resourceId: 'pg2', documentId: 'd2' },
];

describe('dropsEntries', () => {
  it('a link collection: emptied, or an item left out, drops; reordered or added does not', () => {
    expect(dropsEntries({ items }, { items: [] }, ['items'])).toBe(true);
    expect(dropsEntries({ items }, { items: [items[0]] }, ['items'])).toBe(true);
    expect(dropsEntries({ items }, { items: [items[1], items[0]] }, ['items'])).toBe(false);
    expect(dropsEntries({ items }, { items: [...items, { resourceId: 'pg3' }] }, ['items'])).toBe(false);
    // An item sent without its id, naming the same page and document, is kept.
    expect(
      dropsEntries({ items }, { items: [{ resourceId: 'pg1' }, { resourceId: 'pg2', documentId: 'd2' }] }, [
        'items',
      ]),
    ).toBe(false);
  });

  it("a document's blocks: one left out drops, wherever the rest are sent (a block moved inside another is kept)", () => {
    const current = {
      blocks: [
        { id: 'b1', type: 'paragraph' },
        { id: 'b2', type: 'table', rows: [{ id: 'r1' }, { id: 'r2' }] },
      ],
    };
    expect(dropsEntries(current, { blocks: [{ id: 'b1' }] }, ['blocks'])).toBe(true);
    expect(
      dropsEntries(current, { blocks: [{ id: 'b2', rows: [{ id: 'r1' }, { id: 'r2' }] }, { id: 'b1' }] }, [
        'blocks',
      ]),
    ).toBe(false);
    // A table kept with one of its rows left out drops that row.
    expect(
      dropsEntries(current, { blocks: [{ id: 'b1' }, { id: 'b2', rows: [{ id: 'r1' }] }] }, ['blocks']),
    ).toBe(true);
    expect(
      dropsEntries(
        current,
        {
          blocks: [
            {
              id: 'q',
              type: 'quote',
              children: [{ id: 'b1' }, { id: 'b2', rows: [{ id: 'r1' }, { id: 'r2' }] }],
            },
          ],
        },
        ['blocks'],
      ),
    ).toBe(false);
  });

  it('entries without ids: fewer sent than held drops', () => {
    expect(dropsEntries({ rows: [{ key: 'a' }, { key: 'b' }] }, { rows: [{ key: 'a' }] }, ['rows'])).toBe(
      true,
    );
    expect(dropsEntries({ rows: [{ key: 'a' }] }, { rows: [{ key: 'z' }] }, ['rows'])).toBe(false);
  });
});

describe('the live reader', () => {
  it('reads what the write replaces; a failed read is null (fails closed)', async () => {
    const write = {
      opId: 'updateProperty',
      kind: 'write',
      params: { path: { resourceId: 'pg1', propertyId: 'p1' }, body: { items: [] } },
      options: {},
    };
    expect(currentRead(write)).toEqual({
      opId: 'getProperty',
      params: { path: { resourceId: 'pg1', propertyId: 'p1' } },
    });
    expect(await listDropsReader(() => Promise.resolve({ items }))('test', write)).toBe(true);
    expect(await listDropsReader(() => Promise.resolve({ items: [] }))('test', write)).toBe(false);
    expect(await listDropsReader(() => Promise.reject(new Error('down')))('test', write)).toBeNull();
  });
});
