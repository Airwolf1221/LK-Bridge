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
import {
  distinctiveWords,
  factsCheck,
  GENERIC_REFERENCE_TYPE_WORDS,
  raceAnchors,
  resemblesRegistryValue,
  taxonomyCheck,
} from '../../src/audits/checks/taxonomy.js';
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
    // “Character Dossier” resembles no registry value ({character, dossier} is in neither), so only strict mode flags it.
    expect(factsCheck(ctxOf([p]))).toEqual([]);
    const out = factsCheck(ctxOf([p], { strictReferenceTypes: true }));
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

  // v3 F3d (ADR 0053): the AU ruling, and the lifecycle tag leading, on a project whose approved pack says so.
  const AU = { position: 'append' as const, au: { continuityType: 'AU', tag: 'AU' }, source: null };
  const LEAD = { ...AU, position: 'lead' as const };
  const auth = (id: string, ct: string, tags: string[]) =>
    page({
      id,
      name: `[BSRC] ${id}`,
      parent: 'chars',
      facts: { Status: 'Authoritative', 'Continuity Type': ct },
      tags,
    });

  it('the AU ruling: AU on an AU page and CANON on another are right; the swap either way is its own finding', () => {
    expect(
      run([auth('au1', 'AU', ['AU', 'Culture']), auth('ca1', 'CANON', ['CANON'])], { lifecycleTags: AU }),
    ).toEqual([]);
    const out = run([auth('au2', 'AU', ['CANON', 'Culture']), auth('ca2', 'CANON', ['AU'])], {
      lifecycleTags: AU,
    });
    expect(codes(out)).toEqual(['au_status_tag_mismatch', 'au_status_tag_mismatch']);
    expect(out.find((f) => f.pageId === 'au2')!.evidence).toMatchObject({
      continuityType: 'AU',
      expected: 'AU',
      unexpected: 'CANON',
    });
    expect(out.find((f) => f.pageId === 'ca2')!.message).toContain('so its status tag is CANON, not AU');
    // Missing altogether: the ordinary lifecycle finding, naming the tag it expects.
    const missing = run([auth('au3', 'AU', ['Culture'])], { lifecycleTags: AU });
    expect(codes(missing)).toEqual(['lifecycle_inconsistent']);
    expect(missing[0]!.evidence).toMatchObject({ problems: [{ signal: 'tag', expected: 'AU' }] });
    // AU on a Working page is a status tag where none belongs.
    const working = run(
      [
        page({
          id: 'wau',
          name: '[BWRK] Wau',
          parent: 'work',
          facts: { Status: 'Working' },
          tags: ['Working', 'AU'],
        }),
      ],
      { lifecycleTags: AU },
    );
    expect(working[0]!.evidence).toMatchObject({ problems: [{ signal: 'tag', expected: 'not AU' }] });
  });

  it('without the ruling an AU page carries CANON, as before (AU is just a tag)', () => {
    expect(run([auth('au4', 'AU', ['CANON', 'AU'])])).toEqual([]);
    expect(codes(run([auth('au5', 'AU', ['AU'])]))).toEqual(['lifecycle_inconsistent']);
  });

  it('lead: a [BWRK] or [BARC] page whose lifecycle tag is not first, or still has a status tag, with a reorder-only fix', () => {
    const late = page({
      id: 'r1',
      name: '[BARC] R1',
      parent: 'arch',
      facts: { Status: 'Archived' },
      tags: ['Culture', 'Language', 'Archived'],
    });
    const leading = page({
      id: 'r2',
      name: '[BARC] R2',
      parent: 'arch',
      facts: { Status: 'Archived' },
      tags: ['Archived', 'Magic'],
    });
    const stillCanon = page({
      id: 'w1',
      name: '[BWRK] W1',
      parent: 'work',
      facts: { Status: 'Working' },
      tags: ['Working', 'Character', 'CANON'],
    });
    const out = run([late, leading, stillCanon], { lifecycleTags: LEAD });
    const lead = out.filter((f) => f.code === 'lifecycle_tag_not_leading');
    expect(lead.map((f) => f.pageId).sort()).toEqual(['r1', 'w1']);
    const r1 = lead.find((f) => f.pageId === 'r1')!;
    expect(r1.message).toContain('Archived is not its first tag');
    expect(r1.fix).toMatchObject({
      kind: 'reorder_tags',
      args: {
        pageId: 'r1',
        tags: ['Culture', 'Language', 'Archived'],
        order: ['Archived', 'Culture', 'Language'],
      },
    });
    // The lifecycle tag already leads: the status tag is reported, and a reorder cannot remove it (no fix).
    const w1 = lead.find((f) => f.pageId === 'w1')!;
    expect(w1.message).toContain('it still carries CANON');
    expect(w1.fix).toBeUndefined();
    // Authoritative pages and set indexes are not this finding's; an append project has none.
    expect(
      run([late, stillCanon], { lifecycleTags: AU }).some((f) => f.code === 'lifecycle_tag_not_leading'),
    ).toBe(false);
    expect(run([late]).some((f) => f.code === 'lifecycle_tag_not_leading')).toBe(false);
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
    // v3 F10 (ADR 0078, C2): a wrong KCY now has its fix (the plan re-reads and refuses a date it cannot decide).
    expect(find(out, 'chronology_wrong_kcy').fix).toMatchObject({
      kind: 'chronology_kcy',
      args: { age: 'Third Age', rowId: 'row2' },
    });
    expect(find(out, 'chronology_wrong_kcy').source).toMatchObject({ kind: 'chronology-check', checkId: 9 });
  });

  it('v2 E6: an event without a row offers its deletion; a fix that changes an event’s shape asks to be confirmed', () => {
    const e6: CheckRun = {
      ...run,
      findings: [
        {
          kind: 'event_without_row',
          age: 'Fourth Age',
          message: 'Event “Orphan” has no table row.',
          detail: { eventId: 'evorph1', start: 1, name: 'Orphan', date: '4A 890', nearest: [] },
        },
        {
          kind: 'date_mismatch',
          age: 'Fourth Age',
          message: 'Row and event disagree.',
          detail: { rowId: 'row8', eventId: 'ev8', shapeChange: 'range → single day', pairedBy: 'start' },
        },
      ],
    };
    const out = chronologyCheck(context(model([ROOT]), { chronologyConfigured: true, chronology: e6 }));
    expect(find(out, 'chronology_event_without_row').fix).toMatchObject({
      kind: 'chronology_orphan',
      args: { age: 'Fourth Age', eventId: 'evorph1' },
    });
    expect(find(out, 'chronology_date_mismatch').fix).toMatchObject({
      kind: 'chronology_sync',
      args: { rowId: 'row8' },
      confirm: { shapeChange: 'range → single day' },
    });
    expect(find(out, 'chronology_date_mismatch').fix!.summary).toMatch(
      /range → single day: needs your confirmation/,
    );
  });

  it('offers the count fix for a count mismatch with a Main row, and none when the Main table has no row (v2 E5 hotfix)', () => {
    const counts: CheckRun = {
      ...run,
      findings: [
        {
          kind: 'count_mismatch',
          age: 'Fourth Age',
          message: 'The Main table says 337; the table has 336 rows (the timeline 335 events).',
          detail: { main: '337', rows: 336, events: 335 },
        },
        {
          kind: 'count_mismatch',
          age: 'Third Age',
          message: 'The Main table has no row m3 for Third Age.',
          detail: { main: null, rows: 12, events: 12 },
        },
      ],
    };
    const out = chronologyCheck(context(model([ROOT]), { chronologyConfigured: true, chronology: counts }));
    const fourth = out.find((f) => f.message.startsWith('Fourth Age'))!;
    const third = out.find((f) => f.message.startsWith('Third Age'))!;
    expect(fourth.fix).toMatchObject({ kind: 'chronology_count', args: { age: 'Fourth Age' } });
    expect(third.fix).toBeUndefined();
  });

  it('is silent when the chronology is not confirmed, and says so when it was never checked', () => {
    expect(chronologyCheck(context(model([ROOT])))).toEqual([]);
    expect(codes(chronologyCheck(context(model([ROOT]), { chronologyConfigured: true })))).toEqual([
      'chronology_not_checked',
    ]);
  });
});

// ============================================================================================ 15 Nov: Arkona's first audit

describe('“resembles” means what the setting says (Arkona, 15 Nov)', () => {
  const type = characterType();
  const ctxOf = (pages: ReturnType<typeof page>[], settings = {}) =>
    context(model([ROOT, page({ id: 'chars', name: '[INDEX] Characters', parent: 'root' }), ...pages]), {
      types: [type],
      settings,
    });
  const withRt = (id: string, name: string, rt: string) =>
    page({ id, name: `[BSRC] ${name}`, parent: 'chars', facts: { 'Reference Type': rt } });

  it('the generic words are a documented constant; distinctive words drop them', () => {
    expect(GENERIC_REFERENCE_TYPE_WORDS).toEqual(['reference', 'references', 'the', 'and', 'of', 'a', 'an']);
    expect([...distinctiveWords('The Annals of a Reference')]).toEqual(['annals']);
  });

  it('(a) the same words in other letters, (b) the page’s name pattern, (c) a subset of one value’s distinctive words', () => {
    const reg = ['Character Core', 'Compact Character Reference'];
    expect(resemblesRegistryValue('CharacterCore', reg, false)).toBe(true);
    expect(resemblesRegistryValue('Historical Character Reference', reg, true)).toBe(true);
    expect(resemblesRegistryValue('Historical Character Reference', reg, false)).toBe(false);
    expect(resemblesRegistryValue('Character Reference', reg, false)).toBe(true);
    expect(resemblesRegistryValue('Compact Reference', reg, false)).toBe(true);
    for (const v of [
      'Continent Reference',
      'Character Biography',
      'Relationship',
      'Reference',
      'The Reference',
    ])
      expect(resemblesRegistryValue(v, reg, false)).toBe(false);
  });

  it('“Character Reference” on a page with no name pattern is near, with no fix (it fits both registry values)', () => {
    const out = factsCheck(ctxOf([withRt('cr', 'Somebody', 'Character Reference')]));
    expect(codes(out)).toEqual(['unknown_reference_type']);
    expect(out[0]!.evidence).toMatchObject({ expected: null });
    expect(out[0]!.fix).toBeUndefined();
  });

  it('“Historical Character Reference” on “Mehrana I al-Khalid - Character Core”: near by its name, fixed to Character Core', () => {
    const p = page({
      id: 'mi',
      name: '[BSRC] Mehrana I al-Khalid - Character Core',
      parent: 'chars',
      facts: { 'Reference Type': 'Historical Character Reference', Subject: 'Mehrana I al-Khalid' },
    });
    const out = factsCheck(ctxOf([p]));
    expect(codes(out)).toEqual(['unknown_reference_type']);
    expect(out[0]!.evidence).toMatchObject({
      found: 'Historical Character Reference',
      expected: 'Character Core',
    });
    expect(out[0]!.fix).toMatchObject({
      kind: 'set_facts',
      args: {
        pageId: 'mi',
        facts: { 'Reference Type': 'Character Core' },
        expectedCurrent: { 'Reference Type': 'Historical Character Reference' },
      },
    });
  });

  it('the owner’s examples are not flagged with strict mode off; strict mode still flags every unknown value', () => {
    const pages = [
      withRt('c1', 'Velmar Expanse', 'Continent Reference'),
      withRt('c2', 'Saltmarsh Folk', 'Culture Reference'),
      withRt('c3', 'The Ninefold War', 'Historical Cross-National Conflict Reference'),
      withRt('c4', 'Wardstone Casting', 'Magical Applications Reference'),
      withRt('c5', 'Ash Strider', 'Creature Reference'),
      withRt('c6', 'Orrin Tale', 'Character Biography'),
      withRt('c7', 'Orrin and Pell', 'Relationship'),
    ];
    expect(factsCheck(ctxOf(pages))).toEqual([]);
    const strict = factsCheck(ctxOf(pages, { strictReferenceTypes: true }));
    expect(strict.map((d) => d.pageId)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
    expect(strict.every((d) => d.code === 'unknown_reference_type' && d.fix === undefined)).toBe(true);
    expect(find(strict, 'unknown_reference_type').evidence).toMatchObject({
      found: 'Continent Reference',
      expected: null,
    });
  });

  it('regression: an Arkona-like repository of free-form “… Reference” types gives no unknown_reference_type', () => {
    const kinds = [
      'Continent',
      'Culture',
      'Historical Cross-National Conflict',
      'Magical Applications',
      'Creature',
      'Nation',
      'City',
      'Religion',
      'Deity',
      'Language',
      'Artefact',
      'Organisation',
      'Dynasty',
      'Battle',
      'Treaty',
      'Calendar',
      'Plant',
      'Mineral',
      'Trade Route',
      'Mythic Event',
      'Ancient Lineage',
      'Regional Cuisine',
    ];
    const pages = kinds.flatMap((k, i) => [
      withRt(`p${i}a`, `Synthetic ${k} ${i}`, `${k} Reference`),
      withRt(`p${i}b`, `Another ${k} ${i}`, `${k} Reference`),
    ]);
    // Real character pages sit beside them and stay fine.
    pages.push(
      page({
        id: 'ok',
        name: '[BSRC] Ilsa Varn - Character Core',
        parent: 'chars',
        facts: { 'Reference Type': 'Character Core', Subject: 'Ilsa Varn' },
      }),
    );
    expect(new Set(kinds).size).toBeGreaterThanOrEqual(20);
    expect(factsCheck(ctxOf(pages)).filter((d) => d.code === 'unknown_reference_type')).toEqual([]);
  });
});

describe('race values read by their anchor (Arkona, 15 Nov)', () => {
  const type = characterType();
  const chars = page({ id: 'chars', name: '[INDEX] Characters', parent: 'root' });
  const idx = (id: string, name: string, parent = 'chars') => page({ id, name: `[INDEX] ${name}`, parent });
  const indexes = [
    idx('hum', 'Humans'),
    idx('high', 'High Humans', 'hum'),
    idx('ther', 'Therians'),
    idx('fae', 'Faeries'),
    idx('fox', 'Foxians'),
    idx('elf', 'Elves'),
    idx('sea', 'Sea Elves', 'elf'),
    idx('dw', 'Dwarves'),
    idx('half', 'Half-Elves'),
    idx('beasts', 'Heavenly Beasts'),
  ];
  const entries = [
    entry('e-hum', 'Humans', 'Human', 'hum'),
    entry('e-high', 'High Humans', 'High Human', 'high', { parentId: 'e-hum', sourceParentNodeId: 'hum' }),
    entry('e-ther', 'Therians', 'Therian', 'ther'),
    entry('e-fae', 'Faeries', 'Faerie', 'fae'),
    entry('e-fox', 'Foxians', 'Foxian', 'fox'),
    entry('e-elf', 'Elves', 'Elf', 'elf'),
    entry('e-sea', 'Sea Elves', 'Sea Elf', 'sea', { parentId: 'e-elf', sourceParentNodeId: 'elf' }),
    entry('e-dw', 'Dwarves', 'Dwarf', 'dw'),
    entry('e-half', 'Half-Elves', 'Half-Elf', 'half'),
    entry('e-beasts', 'Heavenly Beasts', 'Heavenly Beast', 'beasts'),
  ];
  let n = 0;
  const core = (race: string, parent: string) => {
    const id = `r${n++}`;
    return page({
      id,
      name: `[BSRC] Person ${id} - Character Core`,
      parent,
      facts: { 'Reference Type': 'Character Core', Subject: `Person ${id}`, 'Race / Species': race },
    });
  };
  const run = (pages: ReturnType<typeof page>[], es = entries) =>
    taxonomyCheck(context(model([ROOT, chars, ...indexes, ...pages]), { types: [type], entries: es })).filter(
      (d) => d.code === 'race_not_in_taxonomy' || d.code === 'race_index_mismatch',
    );

  it('the anchor: before the first “(”, “;” or “-”, trimmed; a hyphenated name is tried whole as well', () => {
    expect(raceAnchors('Therian (Aggeloi)')).toEqual(['Therian']);
    expect(raceAnchors('Fire Genie (Elemental Genie; Genie race)')).toEqual(['Fire Genie']);
    expect(raceAnchors('Sea Elf (contemporary classification; predates Sea Elves as a species)')).toEqual([
      'Sea Elf',
    ]);
    expect(raceAnchors('Half-Elf (Northern)')).toEqual(['Half', 'Half-Elf']);
    expect(raceAnchors('Human')).toEqual([]);
    expect(raceAnchors('(Unknown)')).toEqual([]);
  });

  it('qualified values match by their anchor; placement is still checked', () => {
    const ok = [
      core('High Human (Human subrace)', 'high'),
      core('Therian (Aggeloi)', 'ther'),
      core('Therian (Aggeloi)', 'ther'),
      core('Therian (Aggeloi)', 'ther'),
      core('Faerie (Fairy)', 'fae'),
      core('Foxian (nine-tailed Kitsune)', 'fox'),
      core('Sea Elf (contemporary classification; predates Sea Elves as a species)', 'sea'),
      core('Half-Elf (Northern)', 'half'),
      core('Therian; Aggeloi', 'ther'),
      core('Dwarf - hill clan', 'dw'),
    ];
    expect(run(ok)).toEqual([]);
    // A match by anchor under another race’s index is a placement finding, as a full match is.
    const misplaced = core('Therian (Aggeloi)', 'dw');
    const out = run([misplaced]);
    expect(codes(out)).toEqual(['race_index_mismatch']);
    expect(out[0]).toMatchObject({
      pageId: misplaced.id,
      evidence: { entry: 'Therians', sitsUnder: 'Dwarves' },
    });
  });

  it('no entry for the anchor: still a finding, naming the anchor tried; the last word is never guessed', () => {
    const genies = [idx('gen', 'Genies')];
    const withGenies = [...entries, entry('e-gen', 'Genies', 'Genie', 'gen')];
    const pages = [
      core('Fire Genie (Elemental Genie; Genie race)', 'chars'),
      core('Wishmaker Genie (Genie)', 'chars'),
      core(
        'Unique draconic Heavenly Beast (Celestial Jade Dragon); no ordinary roster race, not a True Dragon',
        'chars',
      ),
    ];
    const out = taxonomyCheck(
      context(model([ROOT, chars, ...indexes, ...genies, ...pages]), { types: [type], entries: withGenies }),
    ).filter((d) => d.code === 'race_not_in_taxonomy');
    expect(out.map((d) => (d.evidence as { anchor: string }).anchor)).toEqual([
      'Fire Genie',
      'Wishmaker Genie',
      'Unique draconic Heavenly Beast',
    ]);
    expect(out[0]!.message).toContain('“Fire Genie”');
    expect(out[0]!.message).toContain('Repository Mappings');
    // An unqualified value names no anchor.
    const plain = run([core('Foxan', 'fox')]);
    expect(plain[0]!.evidence).toMatchObject({ race: 'Foxan', anchor: null });
  });

  it('an alias the owner adds in Repository Mappings makes the anchor match', () => {
    const withAlias = [
      ...entries.filter((e) => e.id !== 'e-hum'),
      entry('e-hum', 'Humans', 'Human', 'hum', { aliases: ['Wishmaker Genie'] }),
    ];
    expect(run([core('Wishmaker Genie (Genie)', 'hum')], withAlias)).toEqual([]);
  });
});

describe('Authoritative without CANON beneath a listed index (Design References, 15 Nov)', () => {
  const lifecycle = {
    workingIndexId: 'work',
    archiveIndexId: 'arch',
    canonExemptIndexes: ['b034ef351290dfba28e292b0'],
  };
  const design = page({ id: 'b034ef351290dfba28e292b0', name: '[INDEX] Design References', parent: 'root' });
  const nested = page({ id: 'craft', name: '[INDEX] Craft', parent: design.id });
  const base = [
    ROOT,
    page({ id: 'work', name: '[INDEX] Working', parent: 'root' }),
    page({ id: 'arch', name: '[INDEX] Archived', parent: 'root' }),
    page({ id: 'chars', name: '[INDEX] Characters', parent: 'root' }),
    design,
    nested,
  ];
  const run = (pages: ReturnType<typeof page>[], o: Parameters<typeof context>[1] = {}) =>
    lifecycleCheck(context(model([...base, ...pages]), { lifecycle, ...o }));
  const bsrc = (id: string, name: string, parent: string, tags: string[]) =>
    page({ id, name: `[BSRC] ${name}`, parent, facts: { Status: 'Authoritative' }, tags });

  it('the two pages’ shape (Authoritative, no CANON) gives no finding, at any depth', () => {
    expect(
      run([
        bsrc('fic', 'Arkona – Fiction Writing Reference', design.id, ['reference']),
        bsrc('nar', 'Arkona – Narrative Story Planning & Drafting Workflow', nested.id, []),
      ]),
    ).toEqual([]);
  });

  it('CANON there is itself a lifecycle_inconsistent problem, naming the area', () => {
    const out = run([bsrc('fic', 'Arkona – Fiction Writing Reference', design.id, ['CANON'])]);
    expect(codes(out)).toEqual(['lifecycle_inconsistent']);
    expect(out[0]!.message).toContain('no CANON (Design References area)');
    expect(out[0]!.evidence).toMatchObject({
      canonExemptArea: { id: design.id, name: 'Design References' },
      problems: [{ signal: 'tag', expected: 'no CANON (Design References area)' }],
    });
  });

  it('a page outside the area still needs CANON; Status and the other status tags are still checked inside it', () => {
    const out = run([
      bsrc('taraji', 'Taraji al-Mizan', 'chars', []),
      page({
        id: 'st',
        name: '[BSRC] Wrong Status',
        parent: design.id,
        facts: { Status: 'Working' },
        tags: [],
      }),
      bsrc('wt', 'Working Tag', design.id, ['Working']),
    ]);
    expect(out.map((d) => d.pageId).sort()).toEqual(['st', 'taraji', 'wt']);
    expect(out.find((d) => d.pageId === 'taraji')!.evidence).toMatchObject({
      problems: [{ signal: 'tag', expected: 'CANON' }],
    });
    expect(out.find((d) => d.pageId === 'taraji')!.evidence).not.toHaveProperty('canonExemptArea');
  });

  it('with the list empty (the default) the pages need CANON as before', () => {
    const out = run([bsrc('fic', 'Fiction', design.id, [])], {
      lifecycle: { ...lifecycle, canonExemptIndexes: [] },
    });
    expect(codes(out)).toEqual(['lifecycle_inconsistent']);
  });
});
