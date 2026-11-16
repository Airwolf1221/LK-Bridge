/**
 * v3 F3c (ADR 0051 decision 1): the owner's rule of what counts as a major revision, as pure functions, and the planner
 * that applies it with the caller's override (`lastMajorRevision: auto | set | skip`). Each boundary of the rule is
 * here: 7 and 8 words, a typo and a real word change, a punctuation-only fact, a trimmed value, a KCY-only chronology
 * change, a heading, Dependencies against Related Sources.
 */
import { describe, expect, it } from 'vitest';
import {
  createLmrPlanner,
  measureChronologyRow,
  measureFact,
  measureText,
  textUnits,
  valueChange,
  verdictFor,
  wordsChanged,
  wordsOf,
  type LmrPlannerDeps,
} from '../../src/lmr/index.js';
import type { LmrPlanInput } from '../../src/jobs/lmr-hook.js';

const p = (text: string) => ({ kind: 'paragraph', content: [{ text }] });
const h = (text: string) => ({ kind: 'heading', level: 2, content: [{ text }] });
const units = (...blocks: unknown[]) => textUnits(blocks);

describe('words', () => {
  it('counts words without punctuation, dashes, whitespace or capitalisation', () => {
    expect(wordsOf('Moon-elf envoy — to the  Hollow Court.')).toEqual([
      'moon',
      'elf',
      'envoy',
      'to',
      'the',
      'hollow',
      'court',
    ]);
    expect(wordsOf('the envoy’s return')).toEqual(['the', 'envoys', 'return']);
    expect(wordsChanged('a b c d', 'a x c d')).toBe(1);
    expect(wordsChanged('a b', 'a b c d e')).toBe(3);
  });
});

describe('page text', () => {
  const base = [h('Biography'), p('Born in the shrine at dawn.')];
  it('7 words added is not a major revision; 8 words is', () => {
    const seven = measureText(units(...base), units(...base, p('One two three four five six seven.')));
    expect(seven).toMatchObject({ major: false, words: 7 });
    expect(seven.reason).toBe('7 words of page text changed (fewer than 8)');
    const eight = measureText(units(...base), units(...base, p('One two three four five six seven eight.')));
    expect(eight).toMatchObject({ major: true, words: 8, reason: '8 words of page text changed' });
  });

  it('the changed text is counted over the whole edit (two small changes add up)', () => {
    const before = units(p('Alpha beta gamma delta.'), p('Epsilon zeta eta theta.'));
    const after = units(p('Alpha one two three.'), p('Epsilon four five six seven eight.'));
    // 3 replaced in the first, 5 (3 replaced and 2 added) in the second.
    expect(measureText(before, after)).toMatchObject({ major: true, words: 8 });
  });

  it('a typo fix and punctuation count nothing; a real word change counts', () => {
    const before = units(p('The envoy returned to the Hollow Court in spring.'));
    expect(measureText(before, units(p('The envoy returned to the Holow Court in spring.')))).toMatchObject({
      major: false,
      reason: 'a typo fix',
    });
    expect(measureText(before, units(p('The envoy returned to the Hollow Court, in spring!')))).toMatchObject(
      {
        major: false,
        reason: 'only punctuation, dashes, whitespace or capitalisation changed',
      },
    );
    expect(measureText(before, units(p('The envoy returned to the Silver Court in spring.')))).toMatchObject({
      major: false,
      words: 1,
    });
  });

  it('a heading’s wording changing always counts; its capitalisation does not', () => {
    expect(measureText(units(h('Early Life')), units(h('Childhood')))).toMatchObject({
      major: true,
      reason: 'a heading changed (“Early Life” → “Childhood”)',
    });
    expect(measureText(units(h('Early Life')), units(h('Early life')))).toMatchObject({ major: false });
    expect(measureText(units(p('x')), units(p('x'), h('Notes')))).toMatchObject({
      major: true,
      reason: 'a heading added (“Notes”)',
    });
  });

  it('reads list items and table rows as units', () => {
    const list = {
      kind: 'bulletList',
      children: [{ kind: 'listItem', children: [p('First point')] }],
    };
    const row = (cells: string[]) => ({
      kind: 'tableRow',
      children: cells.map((t) => ({ kind: 'tableCell', children: [p(t)] })),
    });
    expect(textUnits([list, { kind: 'table', children: [row(['a', 'b'])] }])).toEqual([
      { kind: 'listItem', text: 'First point' },
      { kind: 'tableRow', text: 'a | b' },
    ]);
  });

  it('Arkona (16 November 2026): one KCY cell fixed in a table row is not a major revision', () => {
    const row = (kcy: string) => ({
      kind: 'table',
      children: [
        {
          kind: 'tableRow',
          children: ['The Menkhet charter is sealed', 'c. 4A 563; exact date unresolved', kcy].map((t) => ({
            kind: 'tableCell',
            children: [p(t)],
          })),
        },
      ],
    });
    expect(measureText(textUnits([row('1,250,870')]), textUnits([row('1,250,872')]))).toMatchObject({
      major: false,
      words: 1,
    });
  });
});

describe('facts', () => {
  it('Arkona (16 November 2026): a Subject trimmed to a prefix of itself is not a major revision', () => {
    expect(
      measureFact(
        'Subject',
        'Mehrana al-Khalid — one character across two successive incarnations',
        'Mehrana al-Khalid',
      ),
    ).toEqual({ major: false, reason: 'Subject: a trimmed value' });
  });

  it('the minor cases: a tail or a parenthetical removed, punctuation, a typo', () => {
    expect(valueChange('Kaede (elder sister)', 'Kaede')).toBe('trim');
    expect(valueChange('Kaede (elder) of Asagiri', 'Kaede of Asagiri')).toBe('trim');
    expect(valueChange('Shrine maiden: keeper of the bells', 'Shrine maiden')).toBe('trim');
    expect(valueChange('Moon elf envoy to the Hollow Court', 'Moon-elf envoy to the Hollow Court.')).toBe(
      'punctuation',
    );
    expect(valueChange('Moon elf envoy to the Hollow Court', 'moon elf envoy to the hollow court')).toBe(
      'punctuation',
    );
    expect(valueChange('Moon elf envoy to the Hollow Court', 'Moon elf envoy to the Holow Court')).toBe(
      'typo',
    );
    expect(valueChange('Moon elf envoy', 'Mon elff envoi')).toBe('typo'); // 3 words, each by at most 2
  });

  it('real changes: a new word, a tail added, a changed number, four typos, a word changed by 3 characters', () => {
    expect(valueChange('Moon elf envoy to the Hollow Court', 'Moon elf envoy to the Silver Court')).toBe(
      'real',
    );
    expect(valueChange('Mehrana al-Khalid', 'Mehrana al-Khalid — one character, two incarnations')).toBe(
      'real',
    );
    expect(valueChange('Born 4A 563', 'Born 4A 565')).toBe('real'); // a digit is never a typo
    expect(valueChange('Moon elf envoy here', 'Mon elff envoi hare')).toBe('real'); // 4 words
    expect(valueChange('Hollow', 'Hallaw')).toBe('typo');
    expect(valueChange('Hollow', 'Hxxxow')).toBe('real'); // 3 characters
  });

  it('an added or removed fact counts; an empty one added does not', () => {
    expect(measureFact('Epithet', null, 'the Quiet')).toMatchObject({ major: true });
    expect(measureFact('Epithet', 'the Quiet', null)).toMatchObject({ major: true });
    expect(measureFact('Epithet', null, '')).toMatchObject({ major: false });
  });

  it('Dependencies count; Related Sources alone does not', () => {
    expect(verdictFor([{ kind: 'links', title: 'Dependencies', added: 1, removed: 0 }])).toEqual({
      major: true,
      reason: 'Dependencies: 1 added',
    });
    expect(verdictFor([{ kind: 'links', title: 'Related Sources', added: 2, removed: 1 }])).toMatchObject({
      major: false,
    });
  });
});

describe('chronology rows', () => {
  const row = { description: 'The Menkhet charter is sealed', date: 'c. 4A 563', kcy: '1,250,870' };
  it('a KCY-only change does not count; the date or the description does', () => {
    expect(measureChronologyRow(row, { ...row, kcy: '1,250,872' })).toEqual({
      major: false,
      reason: 'a KCY-only change in a chronology row',
    });
    expect(measureChronologyRow(row, { ...row, date: 'c. 4A 565' })).toMatchObject({ major: true });
    expect(measureChronologyRow(row, { ...row, description: 'The Menkhet charter is burned' })).toMatchObject(
      {
        major: true,
      },
    );
    expect(
      measureChronologyRow(row, { ...row, description: 'The Menkhet charter is sealed.' }),
    ).toMatchObject({ major: false });
    expect(measureChronologyRow(null, row)).toMatchObject({ major: true, reason: 'a chronology row added' });
    expect(verdictFor([{ kind: 'chronologyCount' }])).toMatchObject({ major: false });
  });
});

describe('the planner and the override', () => {
  const PAGE = 'page0001';
  const PROP = 'prop0001';
  const deps: LmrPlannerDeps = {
    settings: () => ({}),
    sidebar: () => [
      {
        id: PROP,
        kind: 'keyValue',
        title: 'PROPERTIES',
        rows: [
          { key: 'Subject', text: '' },
          { key: 'Last Major Revision', text: '2026-11-01' },
        ],
      },
    ],
    pageName: () => 'Mehrana al-Khalid',
  };
  const sidebarRead = {
    op: 'listProperties',
    path: { resourceId: PAGE },
    body: {
      data: [
        {
          id: PROP,
          kind: 'keyValue',
          title: 'PROPERTIES',
          rows: [
            {
              id: 'row00001',
              key: 'Subject',
              content: [{ text: 'Mehrana al-Khalid — one character across two successive incarnations' }],
            },
            { id: 'row00002', key: 'Last Major Revision', content: [{ text: '2026-11-01' }] },
          ],
        },
      ],
    },
  };
  const trim = (mode?: 'auto' | 'set' | 'skip'): LmrPlanInput => ({
    project: 'proj',
    origin: { kind: 'mcp', tool: 'set_facts' },
    jobKind: 'batch_ops',
    steps: [
      {
        op: 'updatePropertyRow',
        params: {
          path: { resourceId: PAGE, propertyId: PROP, rowId: 'row00001' },
          body: { content: [{ text: 'Mehrana al-Khalid' }] },
        },
        options: { journalOperation: { tool: 'set_facts', factKey: 'Subject' } },
      },
    ],
    prefetched: [sidebarRead],
    ...(mode ? { mode } : {}),
  });
  const plan = createLmrPlanner(deps);

  it('auto: a trimmed value plans nothing, and says why', () => {
    expect(plan(trim())).toEqual({
      steps: [],
      pages: [],
      note: 'Last Major Revision skipped: Subject: a trimmed value, not a major revision',
    });
  });

  it('set: the row is set although the rule would not, and the note says so', () => {
    const r = plan(trim('set'))!;
    expect(r.steps.map((s) => s.op)).toEqual(['bridge.lmr', 'updatePropertyRow']);
    expect(r.note).toBe('+ Last Major Revision → date of approval (set: lastMajorRevision "set" was asked)');
  });

  it('skip: a major revision is left alone, and the note says so', () => {
    const major = trim('skip');
    const steps = [
      {
        ...major.steps[0]!,
        params: { ...major.steps[0]!.params, body: { content: [{ text: 'Nezrin Aydın' }] } },
      },
    ];
    expect(plan({ ...major, steps, mode: 'auto' })!.steps).toHaveLength(2);
    expect(plan({ ...major, steps })).toEqual({
      steps: [],
      pages: [],
      note: 'Last Major Revision skipped: lastMajorRevision "skip" was asked',
    });
  });

  it('a chronology row’s KCY alone plans nothing (the evidence its plan attaches)', () => {
    const r = plan({
      project: 'proj',
      origin: { kind: 'mcp', tool: 'update_timeline_event' },
      jobKind: 'batch_ops',
      steps: [
        {
          op: 'replaceBlock',
          params: { path: { resourceId: PAGE, documentId: 'doc00001', blockId: 'row00009' }, body: {} },
          options: {
            journalOperation: {
              tool: 'update_timeline_event',
              lmr: {
                kind: 'chronologyRow',
                before: { description: 'A', date: '4A 563', kcy: '1,250,870' },
                after: { description: 'A', date: '4A 563', kcy: '1,250,872' },
              },
            },
          },
        },
      ],
    });
    expect(r).toMatchObject({
      steps: [],
      note: 'Last Major Revision skipped: a KCY-only change in a chronology row, not a major revision',
    });
  });

  it('Dependencies count (under set_facts); Related Sources only when the project switches link collections on', () => {
    const sidebar = {
      op: 'listProperties',
      path: { resourceId: PAGE },
      body: {
        data: [
          ...sidebarRead.body.data,
          { id: 'deps0001', kind: 'resourceCollection', title: 'Dependencies', items: [] },
          { id: 'srcs0001', kind: 'resourceCollection', title: 'Related Sources', items: [] },
        ],
      },
    };
    const link = (propertyId: string): LmrPlanInput => ({
      project: 'proj',
      origin: { kind: 'mcp', tool: 'set_facts' },
      jobKind: 'batch_ops',
      steps: [
        {
          op: 'updateProperty',
          params: { path: { resourceId: PAGE, propertyId }, body: { items: [{ resourceId: 'other001' }] } },
          options: { journalOperation: { tool: 'set_facts' } },
        },
      ],
      prefetched: [sidebar],
    });
    expect(plan(link('deps0001'))!.note).toBe(
      '+ Last Major Revision → date of approval (auto: Dependencies: 1 added)',
    );
    expect(plan(link('srcs0001'))).toBeNull();
    const switched = createLmrPlanner({ ...deps, settings: () => ({ lmrLinkCollections: true }) });
    expect(switched(link('srcs0001'))!.note).toBe(
      '+ Last Major Revision → date of approval (auto: link collections other than Dependencies, switched on for this project)',
    );
  });

  it('a block edit whose old text the request does not hold is measured when it runs', () => {
    const r = plan({
      project: 'proj',
      origin: { kind: 'mcp', tool: 'lk_api_write' },
      jobKind: 'single_op',
      steps: [
        {
          op: 'replaceBlock',
          params: { path: { resourceId: PAGE, documentId: 'doc00001', blockId: 'blk00001' }, body: p('x') },
          options: {},
        },
      ],
    })!;
    expect(r.steps[0]!.params?.body).toMatchObject({ measure: { known: [] } });
    expect(r.note).toBe(
      '+ Last Major Revision → date of approval (auto: if the edit is a major revision, measured when it runs)',
    );
  });
});
