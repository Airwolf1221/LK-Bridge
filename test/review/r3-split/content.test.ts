/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * CR-2026-11-R3 (splits, pass 1): what a split does to content that is not a plain paragraph, and what its checks
 * compare. Each test asserts the SAFE behaviour: a pass means the attempt HELD, a failure is a bypass (a finding).
 *
 * - SP-06: lists with nested items, a table with marked cells, an expand, a quote, a callout, a key-value block and a
 *   code block, moved whole to a new page: verbatim (deep-equal, ids and attributes), and gone from the source.
 * - SP-07: `unsupported` blocks that stay (top level, nested in a list) and one on the existing owner: all echoed.
 * - SP-08..SP-12: the plan's refusals: an `unsupported` block nested in a moving list; a nested id assigned on its own;
 *   an id used twice at the top level; a sub-section mapped apart from its section; blocks before the first heading.
 * - SP-13 (modelled): LegendKeeper stores a moved block not as sent (marks, a link, key-value rows, an expand title,
 *   a heading level, a table cell's header flag, a code block's language, letter case, a nested item moved): does
 *   either check notice before the originals leave the source?
 * - SP-14: an existing owner that already uses the id of one moved block (different text): ADR 0059 departure 2 says
 *   the moved block takes a derived id and the split goes on.
 * - SP-15: an existing owner that already uses the id of a moved block with no text (a key-value block appended under
 *   a heading of its own).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { splitWorld, statutesBody, type SplitWorld } from '../../packs/split-world.js';
import { statutesSplit } from '../../packs/split-inputs.js';
import {
  approveSplit,
  bodyOf,
  intercept,
  recordOf,
  refusal,
  split,
  type Obj,
} from '../../packs/split-helpers.js';
import { heading, holders, noVersions, para, propose, S, setBody } from './helpers.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

/** Blocks that are not plain paragraphs, for the Law and Courts section (moved whole to the new Law owner). */
function lawExtras(): Obj[] {
  return [
    {
      id: 'slList',
      kind: 'bulletList',
      children: [
        {
          id: 'slLi1',
          kind: 'listItem',
          children: [
            para('slLi1p', 'The first statute of the charter.'),
            {
              id: 'slLi1n',
              kind: 'bulletList',
              children: [
                { id: 'slLi1a', kind: 'listItem', children: [para('slLi1ap', 'Its first clause.')] },
              ],
            },
          ],
        },
        { id: 'slLi2', kind: 'listItem', children: [para('slLi2p', 'The second statute of the charter.')] },
      ],
    },
    {
      id: 'slTab',
      kind: 'table',
      children: [
        {
          id: 'slTr1',
          kind: 'tableRow',
          children: [
            {
              id: 'slTc1',
              kind: 'tableCell',
              header: true,
              children: [{ id: 'slTc1p', kind: 'paragraph', content: [{ text: 'Court', bold: true }] }],
            },
            {
              id: 'slTc2',
              kind: 'tableCell',
              header: true,
              children: [{ id: 'slTc2p', kind: 'paragraph', content: [{ text: 'Seat', bold: true }] }],
            },
          ],
        },
        {
          id: 'slTr2',
          kind: 'tableRow',
          children: [
            { id: 'slTc3', kind: 'tableCell', children: [para('slTc3p', 'High Assize')] },
            {
              id: 'slTc4',
              kind: 'tableCell',
              children: [
                {
                  id: 'slTc4p',
                  kind: 'paragraph',
                  content: [
                    { text: 'Ostrand ' },
                    { text: 'Square', italic: true, link: 'https://example.test/sq' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    { id: 'slExp', kind: 'expand', title: 'How a verdict is sealed', children: [para('slExpP', 'In wax.')] },
    { id: 'slQuote', kind: 'quote', children: [para('slQuoteP', 'No verdict binds until it is sealed.')] },
    {
      id: 'slCall',
      kind: 'callout',
      tone: 'note',
      children: [para('slCallP', 'Assizes sit in the square.')],
    },
    {
      id: 'slKv',
      kind: 'keyValue',
      display: 'list',
      title: 'Courts',
      rows: [
        { id: 'slKvR1', rank: 'a0', key: 'Sessions', content: [{ text: 'Quarterly' }], text: 'Quarterly' },
        { id: 'slKvR2', rank: 'a1', key: 'Appeal', content: [{ text: 'To the Duke' }], text: 'To the Duke' },
      ],
    },
    { id: 'slCode', kind: 'code', language: 'text', text: 'ARTICLE 1. The assize sits quarterly.' },
  ];
}

/** The statutes body with the extras at the end of Law and Courts (before Faith and Worship). */
function bodyWith(extras: Obj[], more: { overview?: Obj[]; faith?: Obj[]; before?: Obj[] } = {}): Obj[] {
  const b = statutesBody() as Obj[];
  const faith = b.findIndex((x) => x.id === 'sh4');
  const out = [...b.slice(0, faith), ...extras, ...b.slice(faith)];
  if (more.overview) out.splice(out.findIndex((x) => x.id === 'so1') + 1, 0, ...more.overview);
  if (more.faith) out.splice(out.findIndex((x) => x.id === 'sf6') + 1, 0, ...more.faith);
  if (more.before) out.unshift(...more.before);
  return out;
}

const UNSUPPORTED_STAYING: Obj[] = [
  { id: 'soUns', kind: 'unsupported' },
  {
    id: 'soList',
    kind: 'bulletList',
    children: [
      {
        id: 'soLi',
        kind: 'listItem',
        children: [para('soLip', 'An item of the overview.'), { id: 'soUns2', kind: 'unsupported' }],
      },
    ],
  },
];

describe('SP-06..SP-12: nested content, unsupported blocks and the plan’s refusals', () => {
  let w: SplitWorld;
  let lawId: string;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  const dry = (args: Obj) => split(w, { ...args, dryRun: true });

  it('SP-08 an unsupported block nested in a list that would move is refused (it can only stay)', async () => {
    const extras = lawExtras();
    const li2 = (extras[0]!.children as Obj[])[1]!.children as Obj[];
    li2.push({ id: 'slUns', kind: 'unsupported' });
    setBody(w, S.statutes, bodyWith(extras));
    const r = await dry(statutesSplit());
    const c = refusal(r, 'SPLIT_UNSUPPORTED_BLOCK');
    expect(c.blocks).toEqual(['slList']);
  });

  it('SP-09 a nested block assigned on its own (not a top-level block of the section) is refused', async () => {
    setBody(w, S.statutes, bodyWith(lawExtras()));
    const law = [
      'sh3',
      'sl1',
      'sl2',
      'sl3',
      'sl4',
      'sl5',
      'sl6',
      'slList',
      'slTab',
      'slExp',
      'slQuote',
      'slCall',
      'slKv',
      'slCode',
    ];
    const r = await dry(
      statutesSplit({
        map: [
          { section: 'Purpose', to: 'stays' },
          { section: 'Overview', to: 'stays' },
          {
            section: 'Law and Courts',
            blocks: [
              { ids: law.filter((x) => x !== 'slList'), to: 'law' },
              { ids: ['slList'], to: 'stays' },
              { ids: ['slLi1'], to: 'law' },
            ],
          },
          { section: 'Faith and Worship', to: 'rite' },
          { section: 'Source Boundaries', to: 'stays' },
          { section: 'Unresolved Material', to: 'stays' },
        ],
      }),
    );
    expect(r.isError, r.text).toBe(true);
    const codes = ((r.body as any).error.refusals as any[]).map((x) => x.code);
    expect(codes).toContain('SPLIT_BLOCK_NOT_IN_SECTION');
  });

  it('SP-10 an id used twice at the top level of the source is refused before anything is planned', async () => {
    const b = bodyWith([]);
    b.splice(b.findIndex((x) => x.id === 'sh4') + 1, 0, para('sl2', 'A second block that holds the id sl2.'));
    setBody(w, S.statutes, b);
    refusal(await dry(statutesSplit()), 'SPLIT_BLOCK_IDS_PENDING');
  });

  it('SP-11 a sub-section mapped apart from the section that holds it is refused (each block once)', async () => {
    const b = bodyWith([]);
    b.splice(
      b.findIndex((x) => x.id === 'sl4'),
      0,
      heading('sh3a', 3, 'Assize Procedure'),
    );
    setBody(w, S.statutes, b);
    const r = await dry(
      statutesSplit({
        map: [...(statutesSplit().map as Obj[]), { section: 'Assize Procedure', to: 'rite' }],
      }),
    );
    const c = refusal(r, 'SPLIT_COVERAGE');
    expect(c.twice.map((x: any) => x.block)).toEqual(['sh3a', 'sl4', 'sl5', 'sl6']);
  });

  it('SP-12 blocks before the first heading must be assigned too ((preamble))', async () => {
    setBody(w, S.statutes, bodyWith([], { before: [para('pre1', 'A line before any heading.')] }));
    const c = refusal(await dry(statutesSplit()), 'SPLIT_COVERAGE');
    expect(c.unassigned.map((x: any) => x.block)).toEqual(['pre1']);
    const ok = await dry(
      statutesSplit({ map: [{ section: '(preamble)', to: 'stays' }, ...(statutesSplit().map as Obj[])] }),
    );
    expect(ok.isError, ok.text).toBe(false);
  });

  it('SP-06/SP-07 (run) nested blocks move verbatim; unsupported blocks that stay are kept, here and on the owner', async () => {
    setBody(w, S.statutes, bodyWith(lawExtras(), { overview: UNSUPPORTED_STAYING }));
    const rite = bodyOf(w, S.sunRite);
    setBody(w, S.sunRite, [...rite.slice(0, 2), { id: 'rtUns', kind: 'unsupported' }, ...rite.slice(2)]);
    const p = await propose(w, statutesSplit());
    lawId = p.pages.get('law')!.id;
    const done = await approveSplit(w, p.proposalId);
    expect(done.job.status, JSON.stringify(done.job.lastError)).toBe('succeeded');
    await recordOf(w, done.jobId, (x) => x.state === 'retiring');
  });

  it('SP-06 every nested and non-paragraph block is on the Law page exactly as it was, and nowhere else', () => {
    const law = bodyOf(w, lawId);
    for (const x of lawExtras()) {
      const at = holders(w, x.id as string);
      expect(
        at.map((h) => h.pageId),
        x.id as string,
      ).toEqual([lawId]);
      expect(noVersions(law.find((b) => b.id === x.id)), x.id as string).toEqual(x);
    }
  });

  it('SP-07 the unsupported blocks that stay are still in the source, and the owner’s own is still on its page', () => {
    const src = bodyOf(w, S.statutes);
    expect(src.find((b) => b.id === 'soUns')).toMatchObject({ kind: 'unsupported' });
    expect(holders(w, 'soUns2').map((h) => h.pageId)).toEqual([S.statutes]);
    expect(bodyOf(w, S.sunRite).find((b) => b.id === 'rtUns')).toMatchObject({ kind: 'unsupported' });
  });
});

describe('SP-13 (modelled): LegendKeeper stores a moved block not as sent', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('SP-13 a moved block that lands changed (formatting, rows, titles, levels, structure) stops the split before the source loses it', async () => {
    setBody(w, S.statutes, bodyWith(lawExtras()));
    const p = await propose(w, statutesSplit());
    const lawId = p.pages.get('law')!.id;
    const changes: string[] = [];
    // Modelled from ADR 0059 departure 10 ("LegendKeeper not storing a block as sent"): the first write of the Law page's
    // text is stored with these differences, none of which changes a word.
    const lk = intercept(w, 'PUT', new RegExp(`/resources/${lawId}/docs/[^/]+/blocks$`), (n, req) => {
      const body = req.body as { blocks?: Obj[] };
      if (n !== 0 || !Array.isArray(body.blocks)) return undefined;
      const by = (id: string) => body.blocks!.find((b) => b.id === id)!;
      const sh3 = by('sh3');
      sh3.level = 4;
      changes.push('heading level 2 → 4');
      const sl2 = by('sl2');
      sl2.content = (sl2.content as Obj[]).map((r) => ({ ...r, text: String(r.text).toLowerCase() }));
      changes.push('letter case of a statute');
      const tab = by('slTab');
      const cell = ((tab.children as Obj[])[1]!.children as Obj[])[1]!;
      (cell.children as Obj[])[0]!.content = [{ text: 'Ostrand ' }, { text: 'Square' }];
      changes.push('italic and link of a table cell');
      ((tab.children as Obj[])[0]!.children as Obj[]).forEach((c) => delete c.header);
      changes.push('header flags of the table');
      by('slExp').title = 'Untitled';
      changes.push('the expand’s title');
      by('slKv').rows = [];
      changes.push('the key-value rows');
      by('slCode').language = 'js';
      changes.push('the code block’s language');
      // The nested clause moves from the first item to the head of the second: the list's text reads the same.
      const list = by('slList');
      const [li1, li2] = list.children as Obj[];
      const nested = (li1!.children as Obj[]).pop()!;
      (li2!.children as Obj[]).unshift(nested);
      changes.push('a nested list moved to another item');
      return undefined;
    });
    const done = await approveSplit(w, p.proposalId);
    lk.off();
    const src = bodyOf(w, S.statutes).map((b) => b.id);
    // SAFE: the destinations check (or the verification) notices, and nothing has left the source.
    expect(
      { status: done.job.status, code: done.job.lastError?.code ?? null, sl2InSource: src.includes('sl2') },
      `LegendKeeper changed: ${changes.join('; ')}`,
    ).toEqual({ status: 'failed', code: 'SPLIT_DESTINATIONS_UNVERIFIED', sl2InSource: true });
  });
});

describe('SP-14: an existing owner already uses the id of a moved block (different text)', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('SP-14 the moved block takes a derived id and the split completes (ADR 0059 departure 2)', async () => {
    // The Sun Rite holds a block whose id is sf3 (an id a page copy or a restore left behind), with its own text.
    const rite = bodyOf(w, S.sunRite);
    setBody(w, S.sunRite, [
      ...rite.slice(0, 4),
      para('sf3', 'The Sun Rite’s own note on the dawn bell.'),
      ...rite.slice(4),
    ]);
    const p = await propose(w, statutesSplit());
    const done = await approveSplit(w, p.proposalId);
    const sf3 = holders(w, 'sf3').map((h) => h.pageId);
    expect(
      { status: done.job.status, error: done.job.lastError?.message?.slice(0, 200) ?? null },
      'the split should complete, the moved sf3 under a derived id',
    ).toEqual({ status: 'succeeded', error: null });
    expect(sf3).toEqual([S.sunRite]);
  });
});

describe('SP-15: an existing owner already uses the id of a moved block that has no text', () => {
  let w: SplitWorld;
  beforeAll(async () => {
    w = await splitWorld();
    await w.snapshot();
  });
  afterAll(() => w?.close());

  it('SP-15 a moved key-value block whose id the owner already uses still arrives with its rows', async () => {
    const feast: Obj = {
      id: 'sfkv',
      kind: 'keyValue',
      display: 'list',
      title: 'Feast days',
      rows: [
        {
          id: 'sfkvr1',
          rank: 'a0',
          key: 'Midsummer',
          content: [{ text: 'The long vigil' }],
          text: 'The long vigil',
        },
        {
          id: 'sfkvr2',
          rank: 'a1',
          key: 'First frost',
          content: [{ text: 'The grain tithe' }],
          text: 'The grain tithe',
        },
      ],
    };
    setBody(w, S.statutes, bodyWith([], { faith: [feast] }));
    // The Sun Rite already holds a divider whose id is sfkv (left by a copy or a restore of another page).
    const rite = bodyOf(w, S.sunRite);
    setBody(w, S.sunRite, [...rite.slice(0, 4), { id: 'sfkv', kind: 'rule' }, ...rite.slice(4)]);
    const p = await propose(
      w,
      statutesSplit({
        map: (statutesSplit().map as Obj[]).map((e) =>
          e.section === 'Faith and Worship'
            ? {
                section: 'Faith and Worship',
                blocks: [
                  { ids: ['sh4', 'sf1', 'sf2', 'sf3', 'sf4', 'sf5', 'sf6'], to: 'rite' },
                  { ids: ['sfkv'], to: 'rite', under: 'Feast Days' },
                ],
              }
            : e,
        ),
      }),
    );
    const done = await approveSplit(w, p.proposalId);
    const withRows = holders(w, 'sfkv').filter(
      (h) => Array.isArray(h.block.rows) && (h.block.rows as unknown[]).length === 2,
    );
    const derived = [...w.repo.docs.values()].some((d) =>
      JSON.stringify(w.repo.blocks.get(d.id)?.blocks ?? []).includes('The long vigil'),
    );
    const rec =
      done.job.status === 'succeeded' ? await recordOf(w, done.jobId, (x) => x.state !== 'running') : null;
    // SAFE: the feast days (the rows) are still held by a live page, or the split did not go through.
    expect(
      { status: done.job.status, rowsHeldSomewhere: withRows.length > 0 || derived },
      `job ${done.job.status}${done.job.lastError ? ` (${done.job.lastError.code})` : ''}; split ${rec?.state ?? '-'}` +
        `${rec?.phase2?.proposalId ? ` (phase 2 proposed: ${String(rec.phase2.proposalId)})` : ''}`,
    ).toEqual({ status: done.job.status, rowsHeldSomewhere: true });
  });
});
