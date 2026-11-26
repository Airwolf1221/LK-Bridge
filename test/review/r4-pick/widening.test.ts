/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- parsed JSON */
/**
 * CR-2026-11-R4 pass 2: "Pick the right value" (ADR 0064 D6.2) must edit only the restated value: "a sentence's date
 * replaced in its one text run". These attempts give the pick a sentence whose block holds the same date (or a longer
 * date containing it) elsewhere, a sentence holding the date twice, a date split by formatting, a date in a link or after
 * a mention, a quotation and a non-current section. Each test asserts the safe behaviour: only the found sentence's date
 * changes (or nothing is planned), every other run, sentence, date and mark is as it was, and the side picked is never
 * touched. Against F4b's world on the mock LegendKeeper (test/review/r4-pick/helpers.ts).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  pickDone,
  coreOf,
  findingOf,
  heading,
  para,
  pick,
  pickPage,
  proposalCount,
  r4World,
  rowText,
  runsOf,
  t,
  textOf,
  valuesOf,
  type F4bWorld,
  type Person,
} from './helpers.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

const person = (
  key: string,
  name: string,
  scope: string,
  blocks: any[],
  more: Partial<Person> = {},
): Person => ({
  key,
  name,
  given: name.split(' ')[0]!,
  family: name.split(' ').slice(1).join(' '),
  core: { 'Temporal Scope': scope },
  pages: [{ id: `${key}reg1`, name: `[BSRC] ${name.split(' ')[1]} Register`, blocks }],
  ...more,
});

const ARIN = person('arin', 'Arin Volkova', 'Born 4A 100', [
  heading('arinh1', 'Purpose'),
  para('arinp1', t('Arin Volkova was born in 4A 103 in the harbour quarter.')),
  para('arinp2', t('The harbour quarter burned in 4A 103.')),
]);
const BELA = person('bela', 'Bela Moravec', 'Born 4A 100', [
  heading('belah1', 'Purpose'),
  para(
    'belap1',
    t('The Accord of Moravia was signed in 4A 103. Bela Moravec was born in 4A 103, the spring after.'),
  ),
]);
const CYRA = person('cyra', 'Cyra Halden', 'Born 4A 12', [
  heading('cyrah1', 'Purpose'),
  para('cyrap1', t('The Halden archive was founded in 4A 100. Cyra Halden was born in 4A 10.')),
]);
const DARA = person('dara', 'Dara Kessin', 'Born 4A 100', [
  heading('darah1', 'Purpose'),
  para('darap1', t('In 4A 103, the year of the great flood, Dara Kessin was born in 4A 103.')),
]);
const ELIO = person('elio', 'Elio Brask', 'Born 4A 100', [
  heading('elioh1', 'Purpose'),
  para('eliop1', t('Elio Brask was born in 4A 103, ten years before the Treaty of 4A 113.')),
]);
const FENN = person('fenn', 'Fenna Draskovic', 'Born Camue 1st, 4A 100', [
  heading('fennh1', 'Purpose'),
  para(
    'fennp1',
    t('Fenna Draskovic was born on '),
    t('Camue 2nd', { bold: true }),
    t(', 4A 100 in the hill country.'),
  ),
]);
const GITA = person('gita', 'Gita Lorne', 'Born Camue 1st, 4A 100', [
  heading('gitah1', 'Purpose'),
  para(
    'gitap1',
    t('The Lorne charter is dated Camue 2nd, 4A 100. Gita Lorne was born on '),
    t('Camue 2nd', { bold: true }),
    t(', 4A 100.'),
  ),
]);
const HALE = person('hale', 'Hale Sorrin', 'Born 4A 100', [
  heading('haleh1', 'Purpose'),
  para(
    'halep1',
    t('Hale Sorrin was born in '),
    t('4A 103', { bold: true, link: 'https://example.test/years/4a-103' }),
    t(', the register says.'),
  ),
]);
const ILSA: Person = {
  ...person('ilsa', 'Ilsa Moravek', 'Born 4A 100', []),
  pages: [
    {
      id: 'ilsareg1',
      name: '[BSRC] Moravek Register',
      blocks: [
        heading('ilsah1', 'Purpose'),
        para(
          'ilsap1',
          { mention: { resourceId: 'ilsacor1', text: 'Ilsa Moravek' } },
          t(' was born in 4A 103.'),
        ),
      ],
    },
  ],
};
const JORY = person('jory', 'Jory Tallis', 'Born 4A 100', [
  heading('joryh1', 'Purpose'),
  para('joryp1', t('The Tallis bridge was finished in 4A 103.')),
  para('joryp2', t('Jory Tallis was born in 4A 103.')),
]);
const KAEL = person('kael', 'Kael Oduya', 'Born 4A 100', [
  heading('kaelh1', 'Purpose'),
  para('kaelp1', t('The plaque in the hall reads “Kael Oduya was born in 4A 103.”')),
  para('kaelp2', t('Kael Oduya was born in 4A 103, by the town’s own count.')),
]);
const LENA = person('lena', 'Lena Varga', 'Born 4A 100', [
  heading('lenah1', 'Early Life - Pre-Rewrite'),
  para('lenap1', t('Lena Varga was born in 4A 105.')),
  heading('lenah2', 'Early Life'),
  para('lenap2', t('Lena Varga was born in 4A 105.')),
]);
const MIRA = person('mira', 'Mira Castell', 'Born 4A 100', [
  heading('mirah1', 'Purpose'),
  para(
    'mirap1',
    t('Mira Castell was born in 4A 100. Later chroniclers wrote that Mira Castell was born in 4A 10.'),
  ),
]);
const NORA = person('nora', 'Nora Ashby', 'Born 4A 105', [
  heading('norah1', 'Purpose'),
  para('norap1', t('Nora Ashby was born in 4A 100. Others say Nora Ashby was born in 4A 10.')),
]);
// Two characters, twins by the register: Zeke's birth agrees with his Core, Zara's does not.
const ZEKE: Person = { ...person('zeke', 'Zeke Quell', 'Born 4A 103', []), pages: [] };
const ZARA = person('zara', 'Zara Quell', 'Born 4A 100', [
  heading('zarah1', 'Purpose'),
  para('zarap1', t('Zeke Quell was born in 4A 103. Zara Quell was born in 4A 103.')),
]);
const IVOT = person('ivot', 'Ivo Tamm', 'Born 4A 100', [
  heading('ivoth1', 'Purpose'),
  para('ivotp1', t('Ivo Tamm was born in 4A 103 under the '), { icon: { glyph: 'star' } }, t(' sign.')),
]);
const UNSU = person('unsu', 'Una Sirr', 'Born 4A 100', [
  heading('unsuh1', 'Purpose'),
  para('unsup1', t('Una Sirr was born in 4A 103.')),
  { id: 'unsux1', kind: 'unsupported' },
]);
const LIST = person('list', 'Lise Toft', 'Born 4A 100', [
  heading('listh1', 'Purpose'),
  {
    id: 'listb1',
    kind: 'bulletList',
    children: [
      {
        id: 'listi1',
        kind: 'listItem',
        children: [para('listp1', t('The Toft farm was founded in 4A 103.'))],
      },
      { id: 'listi2', kind: 'listItem', children: [para('listp2', t('Lise Toft was born in 4A 103.'))] },
    ],
  },
]);

const MENA = person('mena', 'Mena Rook', 'Born Camue 1st, 4A 100', [
  heading('menah1', 'Purpose'),
  para(
    'menap1',
    t('Mena Rook was born on '),
    { mention: { resourceId: 'menacor1', text: 'Camue 2nd' } },
    t(', 4A 100.'),
  ),
]);
const NEVA = person('neva', 'Neva Stroud', 'Born 4A 100', [
  heading('nevah1', 'Purpose'),
  para('nevap1', t('Neva Stroud was born in 4A 103.')),
]);
const OTIS = person('otis', 'Otis Marr', 'Born 4A 100', [
  heading('otish1', 'Purpose'),
  para('otisp1', t('The Marr charter was sealed in 4A 103. Otis Marr was born in 4A 103.')),
]);

let w: F4bWorld;
beforeAll(async () => {
  w = await r4World([
    ARIN,
    BELA,
    CYRA,
    DARA,
    ELIO,
    FENN,
    GITA,
    HALE,
    ILSA,
    JORY,
    KAEL,
    LENA,
    MIRA,
    NORA,
    ZEKE,
    ZARA,
    IVOT,
    UNSU,
    LIST,
    MENA,
    NEVA,
    OTIS,
  ]);
});
afterAll(async () => {
  await w?.close();
});

/** Picks the identity page's (the Core's) value of a person's birth finding (v3 F12: it runs at once), and returns its job. */
async function pickCore(p: Person) {
  const f = findingOf(w, p.name, 'consistency_birth');
  const { r } = await pickPage(w, f, coreOf(p));
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const done = await pickDone(w, r.json);
  return { f, r, done };
}

describe('the sentence’s date, and nothing else (ADR 0064 D6.2)', () => {
  it('PK-01 control: a plain sentence; only its date changes, the next paragraph (same date) is as it was', async () => {
    const { done } = await pickCore(ARIN);
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    expect(textOf(w, 'arinreg1', 'arinp1')).toBe('Arin Volkova was born in 4A 100 in the harbour quarter.');
    expect(textOf(w, 'arinreg1', 'arinp2')).toBe('The harbour quarter burned in 4A 103.');
    expect(rowText(w, coreOf(ARIN), 'Temporal Scope')).toBe('Born 4A 100');
  });

  it('PK-02 the same date earlier in the same paragraph (another sentence): only the birth sentence is edited', async () => {
    const { done } = await pickCore(BELA);
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    // SAFE: the Accord's date is not the restated value; the birth sentence is.
    expect(textOf(w, 'belareg1', 'belap1')).toBe(
      'The Accord of Moravia was signed in 4A 103. Bela Moravec was born in 4A 100, the spring after.',
    );
  });

  it('PK-03 the restated date is the start of a longer date earlier in the paragraph ("4A 10" in "4A 100")', async () => {
    const { done } = await pickCore(CYRA);
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    // SAFE: the archive's founding year is untouched; the birth reads the picked year.
    expect(textOf(w, 'cyrareg1', 'cyrap1')).toBe(
      'The Halden archive was founded in 4A 100. Cyra Halden was born in 4A 12.',
    );
  });

  it('PK-04 the same date twice in the one sentence: only the date after “born in” changes', async () => {
    const { done } = await pickCore(DARA);
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    expect(textOf(w, 'darareg1', 'darap1')).toBe(
      'In 4A 103, the year of the great flood, Dara Kessin was born in 4A 100.',
    );
  });

  it('PK-05 a sentence holding two different dates: only the birth date changes', async () => {
    const { done } = await pickCore(ELIO);
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    expect(textOf(w, 'elioreg1', 'eliop1')).toBe(
      'Elio Brask was born in 4A 100, ten years before the Treaty of 4A 113.',
    );
  });

  it('PK-06 a date split by a bold run: not planned, nothing proposed, the paragraph as it was', async () => {
    const f = findingOf(w, FENN.name, 'consistency_birth');
    const before = proposalCount(w);
    const runs = runsOf(w, 'fennreg1', 'fennp1');
    const { r } = await pickPage(w, f, coreOf(FENN));
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(r.json.error.code).toBe('NOTHING_TO_PROPOSE');
    expect(JSON.stringify(r.json.error.details)).toMatch(/one piece of text/);
    expect(proposalCount(w)).toBe(before);
    expect(runsOf(w, 'fennreg1', 'fennp1')).toEqual(runs);
  });

  it('PK-07 the found sentence’s date is split by bold, and the same date sits whole in an earlier sentence', async () => {
    const f = findingOf(w, GITA.name, 'consistency_birth');
    const values = await valuesOf(w, f);
    // Set-up: the restatement found is the birth sentence (the charter sentence is no fact).
    expect(values.map((v) => v.excerpt)).toContain('Gita Lorne was born on Camue 2nd, 4A 100.');
    const runs = runsOf(w, 'gitareg1', 'gitap1');
    const r = await pick(w, f, { side: values[0]!.key });
    // SAFE: the found date is not in one run, so nothing is planned (409) or, if the pick runs, the
    // charter's date is not the one edited.
    if (r.status === 200) {
      const done = await pickDone(w, r.json);
      expect(done.job?.status).toBe('succeeded');
    } else expect(r.json.error?.code).toBe('NOTHING_TO_PROPOSE');
    expect(runsOf(w, 'gitareg1', 'gitap1')[0]).toEqual(runs[0]);
  });

  it('PK-08 the date inside a bold link: its text changes, its marks and the other runs are kept', async () => {
    const before = runsOf(w, 'halereg1', 'halep1');
    const { done } = await pickCore(HALE);
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    expect(runsOf(w, 'halereg1', 'halep1')).toEqual([
      before[0],
      { text: '4A 100', bold: true, link: 'https://example.test/years/4a-103' },
      before[2],
    ]);
  });

  it('PK-09 the subject is a mention: the mention is kept as it was, only the date changes', async () => {
    const { done } = await pickCore(ILSA);
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    expect(runsOf(w, 'ilsareg1', 'ilsap1')).toEqual([
      { mention: { resourceId: 'ilsacor1', text: 'Ilsa Moravek' } },
      { text: ' was born in 4A 100.' },
    ]);
  });

  it('PK-10 the same date in another paragraph of the page: only the found paragraph is edited', async () => {
    const { done } = await pickCore(JORY);
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    expect(textOf(w, 'joryreg1', 'joryp1')).toBe('The Tallis bridge was finished in 4A 103.');
    expect(textOf(w, 'joryreg1', 'joryp2')).toBe('Jory Tallis was born in 4A 100.');
  });

  it('PK-11 a quotation restating the birth on a page that also restates it plainly: the quotation can be left out', async () => {
    const f = findingOf(w, KAEL.name, 'consistency_birth');
    const { r } = await pickPage(w, f, coreOf(KAEL));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // SAFE (the bridge's own rule for quotations, ADR 0058 D1 (a)): the quotation is either not ticked by default, or an
    // item of its own that the owner can leave out while the plain restatement is fixed.
    const items = r.json.items as any[];
    const quoteSeparable = items.length > 1 || items.some((i) => i.selected === false);
    const done = await pickDone(w, r.json);
    expect(done.job?.status).toBe('succeeded');
    expect(textOf(w, 'kaelreg1', 'kaelp2')).toBe('Kael Oduya was born in 4A 100, by the town’s own count.');
    expect(
      quoteSeparable ||
        textOf(w, 'kaelreg1', 'kaelp1') === 'The plaque in the hall reads “Kael Oduya was born in 4A 103.”',
      `the quotation was edited with no way to leave it out: ${textOf(w, 'kaelreg1', 'kaelp1')}`,
    ).toBe(true);
  });

  it('PK-12 a “Pre-Rewrite” section restating the birth: left out of the finding and never edited', async () => {
    const f = findingOf(w, LENA.name, 'consistency_birth');
    const values = await valuesOf(w, f);
    expect(values.map((v) => v.blockId)).not.toContain('lenap1');
    const { done } = await pickCore(LENA);
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    expect(textOf(w, 'lenareg1', 'lenap1')).toBe('Lena Varga was born in 4A 105.');
    expect(textOf(w, 'lenareg1', 'lenap2')).toBe('Lena Varga was born in 4A 100.');
  });

  it('PK-13 a sentence that agrees with the pick, before the disagreeing one in the same paragraph, is never touched', async () => {
    const { done } = await pickCore(MIRA);
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    // SAFE: "a value that agrees with the pick is untouched"; only the chroniclers' "4A 10" becomes 4A 100.
    expect(textOf(w, 'mirareg1', 'mirap1')).toBe(
      'Mira Castell was born in 4A 100. Later chroniclers wrote that Mira Castell was born in 4A 100.',
    );
  });

  it('PK-14 the side picked is a sentence in the same paragraph as another restatement: the picked side is never edited', async () => {
    const f = findingOf(w, NORA.name, 'consistency_birth');
    const values = await valuesOf(w, f);
    const picked = values.find((v) => v.value === '4A 100');
    expect(picked, JSON.stringify(values)).toBeDefined();
    expect(values.map((v) => v.value)).toContain('4A 10');
    const r = await pick(w, f, { side: picked!.key });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.untouched).toEqual([expect.objectContaining({ value: '4A 100', why: 'the side picked' })]);
    const done = await pickDone(w, r.json);
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    // SAFE: the picked sentence is as it was; the other sentence reads the picked value.
    expect(textOf(w, 'norareg1', 'norap1')).toBe(
      'Nora Ashby was born in 4A 100. Others say Nora Ashby was born in 4A 100.',
    );
    expect(rowText(w, coreOf(NORA), 'Temporal Scope')).toBe('Born 4A 100');
  });
});

describe('depth: what else the first occurrence reaches, and the block guards', () => {
  it('PK-62 another character’s birth earlier in the paragraph (same date): never edited by this character’s pick', async () => {
    const f = findingOf(w, ZARA.name, 'consistency_birth');
    const values = await valuesOf(w, f);
    // Set-up: only Zara's sentence is a restatement of Zara; Zeke's agrees with Zeke's own Core.
    expect(values.map((v) => v.excerpt)).toEqual([
      'Temporal Scope: Born 4A 100',
      'Zara Quell was born in 4A 103.',
    ]);
    const { done } = await pickCore(ZARA);
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    expect(textOf(w, 'zarareg1', 'zarap1')).toBe(
      'Zeke Quell was born in 4A 103. Zara Quell was born in 4A 100.',
    );
  });

  it('PK-63 the sentence’s paragraph holds an inline icon (not writable block by block): not planned, nothing written', async () => {
    const f = findingOf(w, IVOT.name, 'consistency_birth');
    const runs = runsOf(w, 'ivotreg1', 'ivotp1');
    const before = proposalCount(w);
    const { r } = await pickPage(w, f, coreOf(IVOT));
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(r.json.error.code).toBe('NOTHING_TO_PROPOSE');
    expect(proposalCount(w)).toBe(before);
    expect(runsOf(w, 'ivotreg1', 'ivotp1')).toEqual(runs);
  });

  it('PK-64 the page holds an `unsupported` block: the pick replaces the sentence’s block only, the block is kept', async () => {
    const { done } = await pickCore(UNSU);
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    expect(textOf(w, 'unsureg1', 'unsup1')).toBe('Una Sirr was born in 4A 100.');
    expect((w.repo.blocks.get(w.mainOf('unsureg1'))!.blocks as any[]).map((b) => b.id)).toContain('unsux1');
  });

  it('PK-65 the sentence in a nested list item, the same date in the item above: only the found item changes', async () => {
    const { done } = await pickCore(LIST);
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    expect(textOf(w, 'listreg1', 'listp1')).toBe('The Toft farm was founded in 4A 103.');
    expect(textOf(w, 'listreg1', 'listp2')).toBe('Lise Toft was born in 4A 100.');
  });

  it('PK-71 a date split by a mention (its day and month are the mention’s label): not planned, nothing written', async () => {
    const f = findingOf(w, MENA.name, 'consistency_birth');
    const values = await valuesOf(w, f);
    expect(values.map((v) => v.value)).toContain('Camue 2nd, 4A 100');
    const runs = runsOf(w, 'menareg1', 'menap1');
    const before = proposalCount(w);
    const { r } = await pickPage(w, f, coreOf(MENA));
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(r.json.error.code).toBe('NOTHING_TO_PROPOSE');
    expect(proposalCount(w)).toBe(before);
    expect(runsOf(w, 'menareg1', 'menap1')).toEqual(runs);
  });

  it('PK-72 the confirmed pick runs at once as one job (v3 F12, no proposal): it writes the found sentence only', async () => {
    const f = findingOf(w, NEVA.name, 'consistency_birth');
    const writes = () =>
      w.stack.mock.calls.filter((c) => c.method !== 'GET' && c.path.includes('nevareg1')).length;
    const before = proposalCount(w);
    const { r } = await pickPage(w, f, coreOf(NEVA));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const done = await pickDone(w, r.json);
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    // The owner's confirmed pick is the decision: nothing waits for an approval.
    expect(proposalCount(w)).toBe(before);
    expect(done.job.origin).toMatchObject({ kind: 'ui', ownerConfirmed: true });
    expect(writes()).toBe(1);
    expect(textOf(w, 'nevareg1', 'nevap1')).toBe('Neva Stroud was born in 4A 100.');
  });

  it('PK-73 after a pick’s job reports success, the next audit and the owner’s second pick leave every other date as it was', async () => {
    const first = await pickCore(OTIS);
    expect(first.done.job?.status, JSON.stringify(first.done.job?.lastError ?? null)).toBe('succeeded');
    const afterFirst = textOf(w, 'otisreg1', 'otisp1');
    await w.stack.runtime.snapshots.settled();
    await w.stack.runtime.audits.run('proj_mock', 'manual');
    const stillOpen = w.stack.runtime.audits.store.get('proj_mock', first.f.id)!.state;
    if (stillOpen === 'open') {
      // The owner sees the same finding again and picks the same value again.
      const second = await pickCore(OTIS);
      expect(second.done.job?.status).toBe('succeeded');
    }
    // SAFE: the charter's date was never the restated value, whatever happened in between.
    expect(
      textOf(w, 'otisreg1', 'otisp1'),
      `after the first job (reported succeeded): “${afterFirst}”; finding then ${stillOpen}`,
    ).toBe('The Marr charter was sealed in 4A 103. Otis Marr was born in 4A 100.');
  });
});
