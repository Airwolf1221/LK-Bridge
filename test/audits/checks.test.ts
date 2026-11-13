/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.* matchers are typed any */
/**
 * v2 E2 (ADR 0044): the other checks, each with a hand-made world (src/audits/checks/*): internal references (missing,
 * deleted and inaccessible kept distinct; Authoritative linking to Archived), unclassified pages, ordering, taxonomy
 * drift (with the two seeded examples), fact consistency, lifecycle consistency (sets and incomplete records included),
 * keep-region health and the chronology fold-in.
 */
import { describe, expect, it } from 'vitest';
import { chronologyCheck, keepRegionsCheck, lifecycleCheck } from '../../src/audits/checks/lifecycle.js';
import { orderingCheck, referencesCheck, unclassifiedCheck } from '../../src/audits/checks/references.js';
import { factsCheck, taxonomyCheck } from '../../src/audits/checks/taxonomy.js';
import type { CheckRun } from '../../src/chronology/store.js';
import { characterType, codes, context, entry, mention, model, page, ROOT, scan } from './helpers.js';

const find = <T extends { code: string }>(l: readonly T[], code: string) => l.find((d) => d.code === code)!;

// ============================================================================================ references

describe('internal references', () => {
  const doc = (id: string) => ({
    kind: 'mention' as const,
    where: 'document' as const,
    documentId: id,
    blockId: 'b1',
  });

  it('keeps missing, deleted and inaccessible distinct, from what the bridge knows (a 404 proves nothing)', () => {
    const from = page({
      id: 'a',
      name: '[BSRC] A',
      refs: [
        mention('nowhere', null, doc('d1')),
        mention('removed', null, doc('d1')),
        mention('treegone', null, doc('d1')),
        mention('tree404', null, doc('d1')),
        mention('tpl', null, doc('d1')),
        mention('moved', null, doc('d1')),
        mention('histdel', null, doc('d1')),
        mention('b', null, doc('d1')),
      ],
    });
    const b = page({ id: 'b', name: '[BSRC] B' });
    const m = model([ROOT, from, b], {
      deleted: { removed: { takenAt: 1, snapshotId: 'chg1', name: '[BSRC] Removed' } },
    });
    const out = referencesCheck(
      context(m, {
        tombstones: {
          treegone: { observedAt: 1, reason: 'deleted' },
          tree404: { observedAt: 1, reason: 'not found when re-read' },
        },
        knownTemplateIds: ['tpl'],
        everSeen: { moved: { name: 'Moved', deleted: false }, histdel: { name: 'Old', deleted: true } },
      }),
    );
    const by = (t: string) => out.find((d) => (d.evidence as { target: string }).target === t)!;
    expect(by('nowhere').code).toBe('missing_target');
    expect(by('removed').code).toBe('deleted_target');
    expect(by('treegone').code).toBe('deleted_target');
    expect(by('tree404').code).toBe('inaccessible_target');
    expect(by('tpl').code).toBe('inaccessible_target');
    expect(by('moved').code).toBe('inaccessible_target');
    expect(by('histdel').code).toBe('deleted_target');
    expect(out).toHaveLength(7); // b is fine
    expect(by('tree404').evidence).toMatchObject({ why: expect.stringContaining('does not prove') });
  });

  it('a document that is not on an existing target is missing; collection items count too; places are evidence', () => {
    const from = page({
      id: 'a',
      name: '[BSRC] A',
      refs: [
        mention('b', 'nodoc', doc('d1')),
        {
          resourceId: 'b',
          documentId: 'nodoc',
          via: { kind: 'collection', where: 'sidebar', property: 'Related Sources' },
        },
        {
          resourceId: 'ghost',
          documentId: null,
          via: { kind: 'collection', where: 'sidebar', property: 'Dependencies' },
        },
      ],
    });
    const out = referencesCheck(context(model([ROOT, from, page({ id: 'b', name: '[BSRC] B' })])));
    expect(codes(out)).toEqual(['missing_target', 'missing_target']);
    const withDoc = out.find((d) => (d.evidence as { document: string | null }).document === 'nodoc')!;
    expect((withDoc.evidence as { places: string[] }).places).toHaveLength(2);
    expect(out.find((d) => (d.evidence as { target: string }).target === 'ghost')!.evidence).toMatchObject({
      places: ['the “Dependencies” collection'],
    });
  });

  it('canon_refers_to_archived: an Authoritative page that links to a [BARC] page, once per target', () => {
    const canon = page({
      id: 'a',
      name: '[BSRC] A',
      facts: { Status: 'Authoritative' },
      refs: [
        mention('old', null, doc('d1')),
        mention('old', null, doc('d2')),
        mention('wip', null, doc('d1')),
      ],
    });
    const old = page({ id: 'old', name: '[BARC] Old', facts: { Status: 'Archived' } });
    const wip = page({ id: 'wip', name: '[BWRK] Wip', facts: { Status: 'Working' } });
    const out = referencesCheck(context(model([ROOT, canon, old, wip])));
    expect(codes(out)).toEqual(['canon_refers_to_archived']);
    expect(out[0]!.key).toBe('old');
    expect((out[0]!.evidence as { places: string[] }).places).toHaveLength(2);
    // A Working page linking to an Archived page is not canon.
    const working = page({
      id: 'w',
      name: '[BWRK] W',
      facts: { Status: 'Working' },
      refs: [mention('old', null, doc('d1'))],
    });
    expect(referencesCheck(context(model([ROOT, working, old])))).toEqual([]);
  });
});

// ============================================================================================ unclassified and ordering

describe('unclassified pages and ordering', () => {
  it('unclassified_page: no recognised prefix', () => {
    const m = model([ROOT, page({ id: 'x', name: 'Loose notes' }), page({ id: 'y', name: '[BSRC] Fine' })]);
    const out = unclassifiedCheck(context(m));
    expect(codes(out)).toEqual(['unclassified_page']);
    expect(out[0]!.pageId).toBe('x');
  });

  it('out_of_order: only the fewest pages that would have to move, with a move_resource fix under the same parent', () => {
    const idx = page({ id: 'idx', name: '[INDEX] Things', parent: 'root' });
    const kids = ['[BSRC] Apple', '[BSRC] Cherry', '[BSRC] Banana', '[BSRC] Damson'].map((name, i) =>
      page({ id: `k${i}`, name, parent: 'idx', rank: `r${i}` }),
    );
    const out = orderingCheck(context(model([ROOT, idx, ...kids])));
    expect(out).toHaveLength(1);
    // Cherry or Banana could move; either gives the fewest (one), and the choice is stable: Cherry, after Banana.
    expect(out[0]).toMatchObject({ code: 'out_of_order', pageId: 'k1' });
    expect(out[0]!.fix).toMatchObject({ kind: 'move_resource', args: { pageId: 'k1', parentId: 'idx' } });
    expect(out[0]!.evidence).toMatchObject({
      position: 2,
      siblings: 4,
      belongsAfter: { name: '[BSRC] Banana' },
    });
  });

  it('indexes come before pages, and a manual-order index is left alone', () => {
    const idx = page({ id: 'idx', name: '[INDEX] Things', parent: 'root' });
    const a = page({ id: 'a', name: '[BSRC] Aardvark', parent: 'idx', rank: '1' });
    const z = page({ id: 'z', name: '[INDEX] Zebras', parent: 'idx', rank: '2' });
    const m = model([ROOT, idx, a, z]);
    expect(orderingCheck(context(m)).map((d) => d.pageId)).toEqual(['a']);
    expect(orderingCheck(context(m, { settings: { manualOrderIndexes: ['idx'] } }))).toEqual([]);
    // Numbers by value, case ignored.
    const n = ['[BSRC] item 2', '[BSRC] Item 10'].map((name, i) =>
      page({ id: `n${i}`, name, parent: 'idx', rank: `${i}` }),
    );
    expect(orderingCheck(context(model([ROOT, idx, ...n])))).toEqual([]);
  });
});

// ============================================================================================ taxonomy

describe('taxonomy drift', () => {
  const chars = page({ id: 'chars', name: '[INDEX] Characters', parent: 'root' });
  const foxians = page({ id: 'fox', name: '[INDEX] Foxians', parent: 'chars' });
  const dwarves = page({ id: 'dw', name: '[INDEX] Dwarves', parent: 'chars' });
  const type = characterType();
  const entries = [entry('e-fox', 'Foxians', 'Foxian', 'fox'), entry('e-dw', 'Dwarves', 'Dwarf', 'dw')];
  const core = (id: string, name: string, race: string, parent: string) =>
    page({
      id,
      name,
      parent,
      facts: {
        'Reference Type': 'Character Core',
        Subject: name.replace(/^\[BSRC\] /, '').split(' - ')[0]!,
        'Race / Species': race,
      },
    });

  it('pages whose race is not in the taxonomy; unknown races are fine; a name an entry answers to is fine', () => {
    const m = model([
      ROOT,
      chars,
      foxians,
      dwarves,
      core('a', '[BSRC] Aki - Character Core', 'Foxian', 'fox'),
      core('b', '[BSRC] Bo - Character Core', 'Foxan', 'fox'), // the singular a wrong seed would have given
      core('c', '[BSRC] Cy - Character Core', 'Unestablished', 'chars'),
      core('d', '[BSRC] Di - Character Core', 'dwarves', 'dw'),
    ]);
    const out = taxonomyCheck(context(m, { types: [type], entries }));
    expect(codes(out)).toEqual(['race_not_in_taxonomy']);
    expect(out[0]).toMatchObject({ pageId: 'b', evidence: { race: 'Foxan', type: 'Character' } });
  });

  it('the two seeded examples: a wrong singular and a wrong parent are both found', () => {
    // "Foxan" is a guessed singular the owner never corrected; "Qishen" was seeded with the wrong parent.
    const beast = page({ id: 'beast', name: '[INDEX] Beastkin', parent: 'chars' });
    const qishen = page({ id: 'qis', name: '[INDEX] Qishen', parent: 'beast' });
    const fox = page({ id: 'fox', name: '[INDEX] Foxians', parent: 'beast' });
    const e = [
      entry('e-beast', 'Beastkin', 'Beastkin', 'beast'),
      entry('e-fox', 'Foxians', 'Foxan', 'fox', {
        parentId: 'e-beast',
        sourceParentNodeId: 'beast',
        status: 'needs_review',
        singularSource: 'rule',
        review: [{ code: 'singular_guess', message: 'The singular is a guess.' }],
      }),
      entry('e-qis', 'Qishen', 'Qishen', 'qis', { parentId: null, sourceParentNodeId: 'beast' }), // should be under Beastkin
    ];
    const m = model([
      ROOT,
      chars,
      beast,
      qishen,
      fox,
      core('a', '[BSRC] Aki - Character Core', 'Foxian', 'fox'),
      core('q', '[BSRC] Qi - Character Core', 'Qishen', 'qis'),
    ]);
    const out = taxonomyCheck(context(m, { types: [type], entries: e }));
    expect(codes(out)).toEqual([
      'race_not_in_taxonomy',
      'taxonomy_entry_unreviewed',
      'taxonomy_parent_mismatch',
    ]);
    expect(find(out, 'taxonomy_entry_unreviewed').evidence).toMatchObject({
      entry: 'Foxians',
      singular: 'Foxan',
      review: ['singular_guess'],
    });
    expect(find(out, 'taxonomy_parent_mismatch').evidence).toMatchObject({ entry: 'Qishen' });
  });

  it('index names that disagree, indexes with no entry, entries whose index is gone or moved, entries with no pages', () => {
    const renamed = page({ id: 'fox', name: '[INDEX] Foxfolk', parent: 'chars' });
    const stray = page({ id: 'new', name: '[INDEX] Newcomers', parent: 'chars' });
    const moved = page({ id: 'mv', name: '[INDEX] Dwarves', parent: 'root' });
    const e = [
      entry('e-fox', 'Foxians', 'Foxian', 'fox'),
      entry('e-gone', 'Ghosts', 'Ghost', 'gone'),
      entry('e-mv', 'Dwarves', 'Dwarf', 'mv'),
    ];
    const m = model([ROOT, chars, renamed, stray, moved]);
    const out = taxonomyCheck(context(m, { types: [type], entries: e }));
    expect(codes(out)).toEqual(
      [
        'taxonomy_index_renamed',
        'taxonomy_index_without_entry',
        'taxonomy_source_missing',
        'taxonomy_source_moved',
        'taxonomy_entry_without_pages',
        'taxonomy_entry_without_pages',
      ].sort(),
    );
    expect(find(out, 'taxonomy_index_renamed').message).toContain('Foxfolk');
  });

  it('a type root that left the repository', () => {
    const out = taxonomyCheck(context(model([ROOT]), { types: [type], entries: [] }));
    expect(codes(out)).toEqual(['taxonomy_type_root_missing']);
  });

  it('race_index_mismatch: the page sits under another race’s index than its race row names (a subrace is fine)', () => {
    const humans = page({ id: 'hum', name: '[INDEX] Humans', parent: 'chars' });
    const high = page({ id: 'high', name: '[INDEX] High Humans', parent: 'hum' });
    const e = [
      entry('e-hum', 'Humans', 'Human', 'hum'),
      entry('e-high', 'High Humans', 'High Human', 'high', { parentId: 'e-hum', sourceParentNodeId: 'hum' }),
      entry('e-dw', 'Dwarves', 'Dwarf', 'dw'),
    ];
    const m = model([
      ROOT,
      chars,
      humans,
      high,
      dwarves,
      core('ok', '[BSRC] Ann - Character Core', 'Human', 'high'),
      core('bad', '[BSRC] Bob - Character Core', 'Dwarf', 'high'),
    ]);
    const out = taxonomyCheck(context(m, { types: [type], entries: e }));
    expect(out.filter((d) => d.code === 'race_index_mismatch').map((d) => d.pageId)).toEqual(['bad']);
  });
});

// ============================================================================================ facts

describe('fact consistency', () => {
  const type = characterType();
  const ctxOf = (pages: ReturnType<typeof page>[], settings = {}) =>
    context(model([ROOT, page({ id: 'chars', name: '[INDEX] Characters', parent: 'root' }), ...pages]), {
      types: [type],
      settings,
    });

  it('Kamigawa Miyuki: Reference Type “Character Reference” is not a registry value; the page name gives the right one', () => {
    const p = page({
      id: 'kami',
      name: '[BSRC] Kamigawa Miyuki - Character Reference',
      parent: 'chars',
      facts: { 'Reference Type': 'Character Reference', Subject: 'Kamigawa Miyuki' },
    });
    const out = factsCheck(ctxOf([p]));
    expect(codes(out)).toEqual(['unknown_reference_type']);
    expect(out[0]!.evidence).toMatchObject({
      found: 'Character Reference',
      expected: 'Compact Character Reference',
    });
    expect(out[0]!.fix).toMatchObject({
      kind: 'set_facts',
      args: {
        pageId: 'kami',
        facts: { 'Reference Type': 'Compact Character Reference' },
        expectedCurrent: { 'Reference Type': 'Character Reference' },
      },
    });
  });

  it('Mehrana al-Khalid, Founder: an unknown Reference Type and a Subject that does not match: reported, no guess', () => {
    const p = page({
      id: 'mehrana',
      name: '[BSRC] Mehrana al-Khalid, Founder - Character Core',
      parent: 'chars',
      facts: { 'Reference Type': 'Historical Character Reference', Subject: 'Mehrana al-Khalid' },
    });
    const out = factsCheck(ctxOf([p]));
    // The name ends in the Core pattern, so the Reference Type's right value is clear; the Subject is not.
    expect(codes(out)).toEqual(['subject_mismatch', 'unknown_reference_type']);
    expect(find(out, 'subject_mismatch').fix).toBeUndefined();
    expect(find(out, 'subject_mismatch').evidence).toMatchObject({
      found: 'Mehrana al-Khalid',
      expected: 'Mehrana al-Khalid, Founder',
    });
    expect(find(out, 'unknown_reference_type').evidence).toMatchObject({ expected: 'Character Core' });
  });

  it('a fix only when the right value is unambiguous: an unmatched name pattern gives none', () => {
    const p = page({
      id: 'x',
      name: '[BSRC] Somebody',
      parent: 'chars',
      facts: { 'Reference Type': 'Character Dossier' },
    });
    const out = factsCheck(ctxOf([p]));
    expect(codes(out)).toEqual(['unknown_reference_type']);
    expect(out[0]!.fix).toBeUndefined();
    expect(out[0]!.evidence).toMatchObject({ expected: null });
  });

  it('a Reference Type another template stands for is known: Character Art is no mistake, Character Reference is', () => {
    const art = page({
      id: 'art',
      name: '[BSRC] Mira - Character Art',
      parent: 'chars',
      facts: { 'Reference Type': 'Character Art' },
    });
    const wrong = page({
      id: 'wr',
      name: '[BSRC] Zed - Character Reference',
      parent: 'chars',
      facts: { 'Reference Type': 'Character Reference' },
    });
    const ctx = context(
      model([ROOT, page({ id: 'chars', name: '[INDEX] Characters', parent: 'root' }), art, wrong]),
      {
        types: [type],
        templateNames: ['[BSRC] AI Character Art Template', '[BSRC] AI Character Core', '[INDEX] AI Index'],
      },
    );
    expect(factsCheck(ctx).map((d) => d.pageId)).toEqual(['wr']);
  });

  it('a Reference Type that only differs in letters has the registry value as its fix; other types are left alone unless strict', () => {
    const lower = page({
      id: 'l',
      name: '[BSRC] Lo - Character Core',
      parent: 'chars',
      facts: { 'Reference Type': 'character core', Subject: 'Lo' },
    });
    expect(factsCheck(ctxOf([lower]))).toEqual([]); // the registry compares without case: it is known
    const general = page({
      id: 'g',
      name: '[BSRC] Atlas',
      parent: 'chars',
      facts: { 'Reference Type': 'General Source' },
    });
    expect(factsCheck(ctxOf([general]))).toEqual([]);
    expect(codes(factsCheck(ctxOf([general], { strictReferenceTypes: true })))).toEqual([
      'unknown_reference_type',
    ]);
    expect(
      factsCheck(ctxOf([general], { strictReferenceTypes: true, knownReferenceTypes: ['General Source'] })),
    ).toEqual([]);
  });

  it('Subject and Canonical Display Name against the name: tidy differences get a fix, others only a report', () => {
    const tidy = page({
      id: 't',
      name: '[BSRC] Mira Vale - Character Core',
      parent: 'chars',
      facts: { 'Reference Type': 'Character Core', Subject: 'Mira-Vale' },
    });
    const cdn = page({
      id: 'c',
      name: '[BSRC] Zed - Character Core',
      parent: 'chars',
      facts: { 'Reference Type': 'Character Core', Subject: 'Zed', 'Canonical Display Name': 'Zedekiah' },
    });
    const out = factsCheck(ctxOf([tidy, cdn]));
    expect(out.find((d) => d.pageId === 't')!.fix).toMatchObject({
      kind: 'set_facts',
      args: { facts: { Subject: 'Mira Vale' } },
    });
    const c = out.find((d) => d.code === 'canonical_name_mismatch')!;
    expect(c.pageId).toBe('c');
    expect(c.fix).toBeUndefined();
  });
});

// ============================================================================================ lifecycle

describe('lifecycle consistency', () => {
  const ids = { workingIndexId: 'work', archiveIndexId: 'arch' };
  const base = [
    ROOT,
    page({ id: 'work', name: '[INDEX] Working', parent: 'root' }),
    page({ id: 'arch', name: '[INDEX] Archived', parent: 'root' }),
    page({ id: 'chars', name: '[INDEX] Characters', parent: 'root' }),
  ];
  const run = (pages: ReturnType<typeof page>[], o: Parameters<typeof context>[1] = {}) =>
    lifecycleCheck(context(model([...base, ...pages]), { lifecycle: ids, ...o }));
  const good = {
    bsrc: page({
      id: 'a',
      name: '[BSRC] A',
      parent: 'chars',
      facts: { Status: 'Authoritative' },
      tags: ['CANON'],
    }),
    bwrk: page({
      id: 'w',
      name: '[BWRK] W',
      parent: 'work',
      facts: { Status: 'Working' },
      tags: ['Working'],
    }),
    barc: page({
      id: 'r',
      name: '[BARC] R',
      parent: 'arch',
      facts: { Status: 'Archived' },
      tags: ['Archived'],
    }),
  };

  it('agreeing pages have no findings', () => {
    expect(run([good.bsrc, good.bwrk, good.barc])).toEqual([]);
  });

  it('prefix, Status, status tag and place disagreeing: one error naming each signal', () => {
    const bad = page({
      id: 'a',
      name: '[BSRC] A',
      parent: 'chars',
      facts: { Status: 'Working' },
      tags: ['Working'],
    });
    const out = run([bad]);
    expect(codes(out)).toEqual(['lifecycle_inconsistent']);
    expect((out[0]!.evidence as { problems: { signal: string }[] }).problems.map((p) => p.signal)).toEqual([
      'status',
      'tag',
      'tag',
    ]);
    const wrongPlace = page({
      id: 'w',
      name: '[BWRK] W',
      parent: 'chars',
      facts: { Status: 'Working' },
      tags: ['Working'],
    });
    const place = run([wrongPlace]);
    expect(place[0]!.evidence).toMatchObject({
      problems: [{ signal: 'location', expected: 'under the working index' }],
    });
    const authInArchive = page({
      id: 'a2',
      name: '[BSRC] A2',
      parent: 'arch',
      facts: { Status: 'Authoritative' },
      tags: ['CANON'],
    });
    expect(run([authInArchive])[0]!.evidence).toMatchObject({ problems: [{ signal: 'location' }] });
  });

  it('a [BWRK] page under a page, not an index, is refused as a place', () => {
    const under = page({
      id: 'w2',
      name: '[BWRK] W2',
      parent: 'w',
      facts: { Status: 'Working' },
      tags: ['Working'],
    });
    const out = run([good.bwrk, under]);
    expect(out).toHaveLength(1);
    expect(out[0]!.pageId).toBe('w2');
  });

  it('a set kept together: pages under a set index are the area’s state; its indexes carry its tag and no Status', () => {
    const setIdx = page({ id: 'set', name: '[INDEX] Mira', parent: 'arch', tags: ['Archived'] });
    const inSet = page({
      id: 'sp',
      name: '[BARC] Mira - Character Core',
      parent: 'set',
      facts: { Status: 'Archived' },
      tags: ['Archived'],
    });
    expect(run([setIdx, inSet])).toEqual([]);
    // A [BSRC] page under an archived set's index, an index with a Status and without the tag.
    const wrongPage = page({
      id: 'sp2',
      name: '[BSRC] Mira - Other',
      parent: 'set',
      facts: { Status: 'Authoritative' },
      tags: ['CANON'],
    });
    const badIdx = page({
      id: 'set2',
      name: '[INDEX] Zed',
      parent: 'arch',
      facts: { Status: 'Archived' },
      tags: [],
    });
    const out = run([setIdx, wrongPage, badIdx]);
    expect(codes(out)).toEqual(['lifecycle_set_inconsistent', 'lifecycle_set_inconsistent']);
    expect(out.find((d) => d.pageId === 'sp2')!.message).toContain('[BARC]');
    expect(out.find((d) => d.pageId === 'set2')!.evidence).toMatchObject({
      problems: [{ signal: 'tag' }, { signal: 'status' }],
    });
    // Working sets likewise.
    const wset = page({ id: 'ws', name: '[INDEX] Kei', parent: 'work', tags: ['Working'] });
    const wpage = page({
      id: 'wp',
      name: '[BWRK] Kei - Character Core',
      parent: 'ws',
      facts: { Status: 'Working' },
      tags: ['Working'],
    });
    expect(run([wset, wpage])).toEqual([]);
  });

  it('with the indexes unconfirmed, Status and tag are still compared and the missing places are said once', () => {
    const out = lifecycleCheck(
      context(
        model([
          ...base,
          good.bsrc,
          page({
            id: 'x',
            name: '[BARC] X',
            parent: 'arch',
            facts: { Status: 'Working' },
            tags: ['Archived'],
          }),
        ]),
      ),
    );
    expect(codes(out)).toEqual(['lifecycle_inconsistent', 'lifecycle_not_configured']);
  });

  it('incomplete lifecycle and set records are reported with their pages, never fixed', () => {
    const out = run([good.bsrc], {
      incompleteRecords: [
        {
          id: 7,
          pageId: 'a',
          pageName: '[BSRC] A',
          action: 'archive',
          createdAt: 1_700_000_000_000,
          jobId: 'job1',
        },
      ],
      incompleteSets: [
        {
          id: 3,
          pageId: 'set',
          pageName: '[INDEX] Mira',
          action: 'move_to_working',
          createdAt: 1_700_000_000_000,
          jobId: 'job2',
          set: {
            rootId: 'set',
            pages: [
              { id: 'set', name: '[INDEX] Mira' },
              { id: 'sp', name: '[BSRC] Mira - Core' },
            ],
          },
        },
      ],
    });
    expect(codes(out)).toEqual(['lifecycle_record_incomplete', 'lifecycle_set_incomplete']);
    expect(find(out, 'lifecycle_set_incomplete').evidence).toMatchObject({
      pages: [{ id: 'set' }, { id: 'sp' }],
    });
    expect(out.every((d) => d.fix === undefined)).toBe(true);
  });
});

// ============================================================================================ keep regions

describe('keep-region health', () => {
  it('line_break_paragraph, with a split fix only when the breaks are all there is; icons; unsupported; collections', () => {
    const lb = (blockId: string, characters: string[], splittable: boolean) => ({
      blockId,
      characters,
      splittable,
      parts: splittable ? 3 : 0,
      preview: 'text',
      runsHash: `h-${blockId}`,
    });
    const p = page({
      id: 'p',
      name: '[BSRC] P',
      scans: [
        scan('d1', {
          lineBreaks: [lb('b1', ['\\n'], true), lb('b2', ['\\n', '\\u0007'], false)],
          iconBlocks: ['b3'],
          unsupported: { count: 2, blockIds: ['u1', 'u2'] },
          collectionBlocks: 1,
        }),
        scan('d2', { unsupported: { count: 1, blockIds: ['u3'] } }),
      ],
    });
    const out = keepRegionsCheck(context(model([ROOT, p])));
    expect(codes(out)).toEqual([
      'collection_blocks',
      'inline_icon_page',
      'line_break_paragraph',
      'line_break_paragraph',
      'unsupported_blocks',
    ]);
    const fixes = out.filter((d) => d.code === 'line_break_paragraph');
    expect(fixes.find((d) => d.blockId === 'b1')!.fix).toMatchObject({
      kind: 'split_paragraph',
      args: { pageId: 'p', documentId: 'd1', blockId: 'b1', runsHash: 'h-b1' },
    });
    expect(fixes.find((d) => d.blockId === 'b2')!.fix).toBeUndefined();
    expect(find(out, 'unsupported_blocks').evidence).toMatchObject({ total: 3 });
    expect(find(out, 'inline_icon_page').evidence).toMatchObject({
      documents: [{ id: 'd1', blocks: ['b3'] }],
    });
  });
});

// ============================================================================================ chronology

describe('the chronology fold-in', () => {
  const run: CheckRun = {
    id: 9,
    projectId: 'prj',
    trigger: 'schedule',
    state: 'succeeded',
    requests: 20,
    summary: '3 findings',
    findings: [
      {
        kind: 'row_without_event',
        age: 'Fourth Age',
        message: 'Row 41 has no event.',
        detail: { rowId: 'row41', date: '4A 41' },
      },
      {
        kind: 'date_mismatch',
        age: 'Fourth Age',
        message: 'Row and event disagree.',
        detail: { rowId: 'row7', eventId: 'ev7' },
      },
      { kind: 'wrong_kcy', age: 'Third Age', message: 'KCY wrong.', detail: { rowId: 'row2', cell: '1' } },
    ],
    ages: [],
    error: null,
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_100_000,
  };

  it('folds D1’s findings in as their own category, keeps its Propose a fix, and records the check as the source', () => {
    const out = chronologyCheck(context(model([ROOT]), { chronologyConfigured: true, chronology: run }));
    expect(codes(out)).toEqual([
      'chronology_date_mismatch',
      'chronology_row_without_event',
      'chronology_wrong_kcy',
    ]);
    expect(find(out, 'chronology_row_without_event').fix).toMatchObject({
      kind: 'chronology_sync',
      args: { age: 'Fourth Age', rowId: 'row41' },
    });
    expect(find(out, 'chronology_date_mismatch').fix).toMatchObject({
      kind: 'chronology_sync',
      args: { rowId: 'row7' },
    });
    expect(find(out, 'chronology_wrong_kcy').fix).toBeUndefined();
    expect(find(out, 'chronology_wrong_kcy').source).toMatchObject({ kind: 'chronology-check', checkId: 9 });
  });

  it('is silent when the chronology is not confirmed, and says so when it was never checked', () => {
    expect(chronologyCheck(context(model([ROOT])))).toEqual([]);
    expect(codes(chronologyCheck(context(model([ROOT]), { chronologyConfigured: true })))).toEqual([
      'chronology_not_checked',
    ]);
  });
});
