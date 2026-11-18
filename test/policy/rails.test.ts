/**
 * v3 F3.4 (ADR 0055 decision C): the safety rails' classification, pure. Which operations each rail catches, the
 * defaults, the bulk threshold's boundary (10 pages direct, 11 proposed), what is never caught (edits of blocks and
 * fact rows, pages a request creates and then places), and the stored form.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WRITE_RAILS,
  mergeRails,
  pagesTouched,
  railsFrom,
  railsVerdict,
  type WriteRails,
} from '../../src/policy/index.js';
import type { RailItem } from '../../src/policy/rails.js';

const w = (opId: string, params: RailItem['params'] = {}, options: RailItem['options'] = {}): RailItem => ({
  opId,
  kind: 'write',
  params,
  options,
});
const page = (id: string) => ({ path: { resourceId: id } });
const updates = (n: number) =>
  Array.from({ length: n }, (_, i) => w('updateResource', { ...page(`pg${i}`), body: { tags: ['x'] } }));
const ALL_OFF: WriteRails = {
  deletes: false,
  bulk: false,
  bulkPages: 10,
  renamesMoves: false,
  assets: false,
};

describe('defaults', () => {
  it('deletes, bulk over 10 pages, and asset deletes and moves are on; renames and moves are off', () => {
    expect(DEFAULT_WRITE_RAILS).toEqual({
      deletes: true,
      bulk: true,
      bulkPages: 10,
      renamesMoves: false,
      assets: true,
    });
  });

  it('a profile with nothing stored has the defaults; a stored change keeps the rest', () => {
    expect(railsFrom(null)).toEqual(DEFAULT_WRITE_RAILS);
    expect(railsFrom('not json')).toEqual(DEFAULT_WRITE_RAILS);
    expect(railsFrom(JSON.stringify({ renamesMoves: true, bulkPages: 3 }))).toEqual({
      ...DEFAULT_WRITE_RAILS,
      renamesMoves: true,
      bulkPages: 3,
    });
    // A threshold out of range falls back to the default rather than switching the rail off.
    expect(railsFrom(JSON.stringify({ bulkPages: 0 })).bulkPages).toBe(10);
  });

  it('a change is checked: unknown rails and bad thresholds are refused', () => {
    expect(mergeRails(DEFAULT_WRITE_RAILS, { deletes: false })).toEqual({
      ...DEFAULT_WRITE_RAILS,
      deletes: false,
    });
    expect(() => mergeRails(DEFAULT_WRITE_RAILS, { canon: false })).toThrow(/Unknown rail/);
    expect(() => mergeRails(DEFAULT_WRITE_RAILS, { bulkPages: 0 })).toThrow(/1 to 1000/);
    expect(() => mergeRails(DEFAULT_WRITE_RAILS, { bulkPages: 2.5 })).toThrow(/whole number/);
    expect(() => mergeRails(DEFAULT_WRITE_RAILS, { deletes: 'yes' })).toThrow(/on \(true\) or off/);
  });
});

describe('deletes', () => {
  it.each([
    ['deleteResource', page('pg1'), 'page'],
    ['deleteDocument', { path: { resourceId: 'pg1', documentId: 'd1' } }, 'document'],
    ['deleteEvent', { path: { resourceId: 'pg1', documentId: 'd1', eventId: 'e1' } }, 'timeline event'],
    ['deleteLane', { path: { resourceId: 'pg1', documentId: 'd1', laneId: 'l1' } }, 'timeline lane'],
    ['deleteFeature', { path: { resourceId: 'pg1', documentId: 'd1', featureId: 'f1' } }, 'map feature'],
    ['deleteAsset', { path: { assetId: 'a1' } }, 'asset'],
    ['deleteCalendar', { path: { calendarId: 'c1' } }, 'calendar'],
    // CR-2026-11-R2 (R2-02): an infobox property with its rows; the whole replaces delete what they do not send.
    [
      'deleteBlockProperty',
      { path: { resourceId: 'pg1', documentId: 'd1', blockId: 'b1', propertyId: 'p1' } },
      'infobox property',
    ],
    ['replaceBoardContent', { path: { resourceId: 'pg1', documentId: 'd1' } }, 'board content replaced'],
    ['updateCalendar', { path: { calendarId: 'c1' } }, 'calendar replaced'],
  ])('%s is a delete', (op, params, what) => {
    const v = railsVerdict({ ...ALL_OFF, deletes: true }, [w(op, params)]);
    expect(v?.reason).toBe(`proposed because: delete (1 ${what})`);
    expect(v?.hits.map((h) => h.rail)).toEqual(['deletes']);
  });

  it('names a deleted page when the tree knows it, and counts several deletes by kind', () => {
    const v = railsVerdict({ ...ALL_OFF, deletes: true }, [w('deleteResource', page('pg1'))], {
      pageName: () => 'Inae Mikumo',
    });
    expect(v?.reason).toBe('proposed because: delete (1 page “Inae Mikumo”)');
    const many = railsVerdict({ ...ALL_OFF, deletes: true }, [
      w('deleteResource', page('a')),
      w('deleteResource', page('b')),
      w('deleteEvent', { path: { resourceId: 'c', documentId: 'd', eventId: 'e' } }),
    ]);
    expect(many?.reason).toBe('proposed because: deletes (2 pages, 1 timeline event)');
  });

  it('through the high-level tools, removing blocks, fact rows and rows of a block is an edit (planned and revertible)', () => {
    // CR-2026-11-R2 (R2-02): deleteBlockProperty (an infobox property and its rows) left this list: it is a delete now.
    const edits = ['deleteBlock', 'deletePropertyRow', 'deleteBlockRow', 'deleteBlockPropertyRow'].map((op) =>
      w(op, { path: { resourceId: 'pg1', documentId: 'd1', blockId: 'b1' } }),
    );
    expect(railsVerdict(DEFAULT_WRITE_RAILS, edits)).toBeNull();
  });

  // ADR 0057 decision 4 (R2-52): through lk_api_write, lk_api_batch or lk_op_*, every removal is a delete for the rail.
  it.each([
    ['deleteBlock', 'block'],
    ['deleteBlockRow', 'row of a block'],
    ['deletePropertyRow', 'sidebar row'],
    ['deleteBlockPropertyRow', 'infobox row'],
  ])('through a low-level tool, %s is a delete (%s)', (op, what) => {
    const v = railsVerdict(
      DEFAULT_WRITE_RAILS,
      [w(op, { path: { resourceId: 'pg1', documentId: 'd1', blockId: 'b1', rowId: 'r1' } })],
      { lowLevel: true },
    );
    expect(v?.reason).toBe(`proposed because: delete (1 ${what})`);
  });

  it('through a low-level tool, a whole-list write is a delete only when it drops an entry held now', () => {
    const write = w('updateProperty', { path: { resourceId: 'pg1', propertyId: 'p1' }, body: { items: [] } });
    expect(railsVerdict(DEFAULT_WRITE_RAILS, [write], { lowLevel: true, drops: () => true })?.reason).toBe(
      'proposed because: delete (1 sidebar property write that drops entries)',
    );
    expect(railsVerdict(DEFAULT_WRITE_RAILS, [write], { lowLevel: true, drops: () => false })).toBeNull();
    // Not known: fails closed.
    expect(
      railsVerdict(DEFAULT_WRITE_RAILS, [write], { lowLevel: true, drops: () => null })?.hits[0]?.rail,
    ).toBe('deletes');
    expect(railsVerdict(DEFAULT_WRITE_RAILS, [write], { lowLevel: true })?.hits[0]?.rail).toBe('deletes');
    // A write that sends no list (a title) drops nothing; the deletes rail switched off lets it through.
    const title = w('updateProperty', {
      path: { resourceId: 'pg1', propertyId: 'p1' },
      body: { title: 'X' },
    });
    expect(railsVerdict(DEFAULT_WRITE_RAILS, [title], { lowLevel: true })).toBeNull();
    expect(railsVerdict({ ...DEFAULT_WRITE_RAILS, deletes: false }, [write], { lowLevel: true })).toBeNull();
  });

  it('switched off, a delete runs directly', () => {
    expect(
      railsVerdict({ ...DEFAULT_WRITE_RAILS, deletes: false }, [w('deleteResource', page('x'))]),
    ).toBeNull();
  });
});

describe('bulk changes: a restore (ADR 0057 decision 9)', () => {
  const restore = w('restoreResource', page('box'));
  it('counts every page its restore set says may come back with it', () => {
    expect(railsVerdict(DEFAULT_WRITE_RAILS, [restore], { restored: () => 9 })).toBeNull();
    expect(railsVerdict(DEFAULT_WRITE_RAILS, [restore], { restored: () => 15 })?.reason).toBe(
      'proposed because: bulk change (16 pages > 10)',
    );
  });
  it('an unknown restore set counts as over the limit (fails closed)', () => {
    const v = railsVerdict(DEFAULT_WRITE_RAILS, [restore], { restored: () => null });
    expect(v?.reason).toBe(
      'proposed because: bulk change (a restore whose pages are not known, so more than 10 pages are assumed)',
    );
    expect(railsVerdict(DEFAULT_WRITE_RAILS, [restore])?.hits[0]?.rail).toBe('bulk');
    expect(railsVerdict({ ...DEFAULT_WRITE_RAILS, bulk: false }, [restore])).toBeNull();
  });
});

describe('bulk changes: the N boundary', () => {
  it('10 pages run directly; 11 become a proposal saying how many', () => {
    expect(railsVerdict(DEFAULT_WRITE_RAILS, updates(10))).toBeNull();
    const v = railsVerdict(DEFAULT_WRITE_RAILS, updates(11));
    expect(v?.reason).toBe('proposed because: bulk change (11 pages > 10)');
  });

  it('pages are counted once however many writes touch them, and the threshold is the profile’s', () => {
    const twice = [...updates(11), ...updates(11)];
    expect(pagesTouched(twice).pages.size).toBe(11);
    expect(railsVerdict({ ...DEFAULT_WRITE_RAILS, bulkPages: 3 }, updates(4))?.reason).toBe(
      'proposed because: bulk change (4 pages > 3)',
    );
    expect(railsVerdict({ ...DEFAULT_WRITE_RAILS, bulkPages: 3 }, updates(3))).toBeNull();
  });

  it('pages a request creates count (createManyResources counts every item)', () => {
    const many = w('createManyResources', {
      body: { resources: Array.from({ length: 14 }, (_, i) => ({ name: `New ${i}` })) },
    });
    expect(railsVerdict(DEFAULT_WRITE_RAILS, [many])?.reason).toBe(
      'proposed because: bulk change (14 pages > 10)',
    );
  });

  it('a cascade delete counts the pages under it; one the tree cannot count fails closed', () => {
    const cascade = w('deleteResource', { path: { resourceId: 'root' }, query: { cascade: true } });
    const rails = { ...ALL_OFF, bulk: true, bulkPages: 10 };
    expect(railsVerdict(rails, [cascade], { descendants: () => 9 })).toBeNull();
    expect(railsVerdict(rails, [cascade], { descendants: () => 10 })?.reason).toBe(
      'proposed because: bulk change (11 pages > 10)',
    );
    expect(railsVerdict(rails, [cascade], { descendants: () => null })?.reason).toMatch(
      /cascade delete whose pages are not known/,
    );
  });

  it('a copy with its children counts every page copied; one whose source cannot be counted fails closed (CR-2026-11-R2)', () => {
    const rails = { ...ALL_OFF, bulk: true, bulkPages: 10 };
    const fromTemplate = (includeChildren: boolean) =>
      w('createResourceFromTemplate', { body: { templateId: 'tpl1', includeChildren, name: 'Copy' } });
    const saved = w('saveResourceAsTemplate', {
      path: { resourceId: 'pg1' },
      body: { includeChildren: true },
    });
    // Without its children a copy is one page, whatever is under the template.
    expect(railsVerdict(rails, [fromTemplate(false)], { descendants: () => null })).toBeNull();
    expect(railsVerdict(rails, [fromTemplate(true)], { descendants: () => 9 })).toBeNull();
    expect(railsVerdict(rails, [fromTemplate(true)], { descendants: () => 15 })?.reason).toBe(
      'proposed because: bulk change (16 pages > 10)',
    );
    expect(railsVerdict(rails, [saved], { descendants: (id) => (id === 'pg1' ? 15 : 0) })?.reason).toBe(
      'proposed because: bulk change (16 pages > 10)',
    );
    // A template is not in the repository tree: its pages are not known, so the rail fails closed.
    expect(railsVerdict(rails, [fromTemplate(true)], { descendants: () => null })?.reason).toMatch(
      /a copy with its children whose pages are not known/,
    );
  });

  it("the bridge's own steps and reads are never pages", () => {
    const items: RailItem[] = [
      ...updates(10),
      { opId: 'bridge.expect', kind: 'read', params: { body: {} }, options: {} },
      { opId: 'bridge.lmr', kind: 'read', params: { body: { resourceId: 'other' } }, options: {} },
      { opId: 'getResource', kind: 'read', params: page('elsewhere'), options: {} },
    ];
    expect(railsVerdict(DEFAULT_WRITE_RAILS, items)).toBeNull();
  });
});

describe('renames and moves of pages (off by default)', () => {
  const rename = w('updateResource', { ...page('pg1'), body: { name: 'New name' } });
  const move = w('moveResource', { ...page('pg1'), body: { parentId: 'other' } });

  it('off by default: a rename and a move run directly', () => {
    expect(railsVerdict(DEFAULT_WRITE_RAILS, [rename, move])).toBeNull();
  });

  it('on: each becomes a proposal, named', () => {
    const on = { ...ALL_OFF, renamesMoves: true };
    expect(railsVerdict(on, [rename], { pageName: () => 'Old name' })?.reason).toBe(
      'proposed because: rename of a page (“Old name” → “New name”)',
    );
    expect(railsVerdict(on, [move], { pageName: () => 'Old name' })?.reason).toBe(
      'proposed because: move of a page (“Old name”)',
    );
  });

  it('tags or aliases alone are not a rename; placing a page the request creates is not a move', () => {
    const on = { ...ALL_OFF, renamesMoves: true };
    expect(railsVerdict(on, [w('updateResource', { ...page('pg1'), body: { tags: ['a'] } })])).toBeNull();
    const create = w('createResource', { body: { id: 'newpage1', name: 'New' } });
    const place = w('moveResource', { ...page('newpage1'), body: { parentId: 'idx', after: 'sib' } });
    const retag = w('updateResource', { ...page('newpage1'), body: { name: 'Placed' } });
    expect(railsVerdict(on, [create, place, retag])).toBeNull();
  });
});

describe('asset deletes and moves (on by default)', () => {
  it('an asset delete and an asset move to another folder are proposals', () => {
    expect(railsVerdict(ALL_OFF, [w('deleteAsset', { path: { assetId: 'a' } })])).toBeNull();
    const on = { ...ALL_OFF, assets: true };
    expect(railsVerdict(on, [w('deleteAsset', { path: { assetId: 'a' } })])?.reason).toBe(
      'proposed because: asset delete',
    );
    expect(
      railsVerdict(on, [w('updateAsset', { path: { assetId: 'a' }, body: { folderId: 'f2' } })])?.reason,
    ).toBe('proposed because: asset move (to another folder)');
    // A folder bound from a step that creates it is a move too.
    expect(
      railsVerdict(on, [
        w(
          'updateAsset',
          { path: { assetId: 'a' }, body: { isHidden: false } },
          { bindFrom: { step: 1, to: 'body.folderId' } },
        ),
      ])?.reason,
    ).toBe('proposed because: asset move (to another folder)');
  });

  it('renaming or unhiding an asset in place, and uploading a new one, are not moves', () => {
    const on = { ...ALL_OFF, assets: true };
    expect(
      railsVerdict(on, [
        w('updateAsset', { path: { assetId: 'a' }, body: { name: 'x', isHidden: false } }),
        w('createAssetFolder', { body: { name: 'f' } }),
        { opId: 'createImageAsset', kind: 'upload', params: { body: { folderId: 'f' } }, options: {} },
      ]),
    ).toBeNull();
  });

  it('placing a staged image (bridge code marks the request) is not an asset move; a delete in it still counts', () => {
    const on = { ...ALL_OFF, assets: true };
    const place = w(
      'updateAsset',
      { path: { assetId: 'a' }, body: { isHidden: false } },
      { bindFrom: { step: 1, to: 'body.folderId' } },
    );
    expect(railsVerdict(on, [place], { stagedPlacement: true })).toBeNull();
    expect(railsVerdict(on, [place])?.reason).toBe('proposed because: asset move (to another folder)');
    expect(
      railsVerdict(on, [place, w('deleteAsset', { path: { assetId: 'b' } })], { stagedPlacement: true })
        ?.reason,
    ).toBe('proposed because: asset delete');
  });

  it('several rails at once are all named', () => {
    const v = railsVerdict(DEFAULT_WRITE_RAILS, [w('deleteAsset', { path: { assetId: 'a' } })]);
    expect(v?.reason).toBe('proposed because: delete (1 asset); asset delete');
    expect(v?.hits.map((h) => h.rail)).toEqual(['deletes', 'assets']);
  });
});
