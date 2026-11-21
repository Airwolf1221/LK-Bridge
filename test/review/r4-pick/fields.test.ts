/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- parsed JSON */
/**
 * CR-2026-11-R4 pass 2: "Pick the right value" on a sidebar field (ADR 0064 D6.2: "a sidebar field's date replaced inside
 * the field, the rest of the field kept"; "an identity field's whole value"). The attempts: a Temporal Scope with several
 * `;` clauses holding the same date, a date that is the start of a longer one in an earlier clause, a field written with
 * a line break, a bold date, a link, a mention, an identity value with a qualifier, a Life State. Each test asserts the
 * safe behaviour: only the restated date changes, the field's other clauses, marks, links and breaks are as they were.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  approveAndWait,
  coreOf,
  findingOf,
  heading,
  indexOf,
  para,
  pickPage,
  proposalCount,
  r4World,
  revert,
  rowRuns,
  rowText,
  t,
  valuesOf,
  type F4bWorld,
  type Person,
  type Value,
} from './helpers.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

/** A person whose Core holds `core`, and a register page restating it in one sentence. */
const person = (key: string, name: string, core: Record<string, Value>, sentence: string): Person => ({
  key,
  name,
  given: name.split(' ')[0]!,
  family: name.split(' ').slice(1).join(' '),
  core,
  pages: [
    {
      id: `${key}reg1`,
      name: `[BSRC] ${name.split(' ')[1]} Register`,
      blocks: [heading(`${key}h1`, 'Purpose'), para(`${key}p1`, t(sentence))],
    },
  ],
});

const OLAF = person(
  'olaf',
  'Olaf Brenn',
  { 'Temporal Scope': 'Born 4A 160; died 4A 160', 'Life State': 'Deceased' },
  'Olaf Brenn died in 4A 161.',
);
const PELL = person(
  'pell',
  'Pell Arvane',
  { 'Temporal Scope': 'Attested 4A 1600–5A 931; Born 4A 160' },
  'Pell Arvane was born in 4A 163.',
);
const QUIN = person(
  'quin',
  'Quinn Ravel',
  { 'Temporal Scope': [t('Born 4A 160'), { break: true }, t('Attested through 5A 931')] },
  'Quinn Ravel was born in 4A 163.',
);
const RHEA = person(
  'rhea',
  'Rhea Solano',
  { 'Temporal Scope': [t('Born '), t('4A 160', { bold: true }), t('; attested through 5A 931')] },
  'Rhea Solano was born in 4A 163.',
);
const SVEN = person(
  'sven',
  'Sven Halloran',
  {
    'Temporal Scope': [
      t('Born 4A 160; '),
      t('attested through 5A 931', { link: 'https://example.test/attest/sven' }),
    ],
  },
  'Sven Halloran was born in 4A 163.',
);
const TOVA = person(
  'tova',
  'Tova Ilic',
  {
    'Temporal Scope': [t('Born 4A 160; see '), { mention: { resourceId: 'tovareg1', text: 'the register' } }],
  },
  'Tova Ilic was born in 4A 163.',
);
const URSA: Person = {
  key: 'ursa',
  name: 'Ursa Kell',
  given: 'Ursa',
  family: 'Kell',
  core: { 'Temporal Scope': 'Born 4A 200' },
  pages: [
    {
      id: 'ursabio1',
      name: '[BSRC] Ursa Kell - Biography',
      parent: indexOf({ key: 'ursa' } as Person),
      referenceType: 'General Source',
      tags: ['CANON', 'Character'],
      blocks: [heading('ursah1', 'Purpose'), para('ursap1', t('The life of Ursa Kell.'))],
      sidebar: { Subject: 'Ursa Kell', 'Race / Species': 'Elf; raised among Humans (see Upbringing)' },
    },
  ],
};
const VIDA = person(
  'vida',
  'Vida Morrow',
  { 'Temporal Scope': 'Born 4A 300', 'Life State': 'Deceased Camue 3rd, 4A 400; buried at Ashgate' },
  'Vida Morrow died on Camue 5th, 4A 400.',
);

let w: F4bWorld;
beforeAll(async () => {
  w = await r4World([OLAF, PELL, QUIN, RHEA, SVEN, TOVA, URSA, VIDA]);
});
afterAll(async () => {
  await w?.close();
});

/** The owner picks the register's value (so the Core's field is the one edited), and approves. */
async function pickRegister(p: Person, code = 'consistency_birth') {
  const f = findingOf(w, p.name, code);
  const { r } = await pickPage(w, f, `${p.key}reg1`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const done = await approveAndWait(w, String(r.json.proposalId));
  expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
  return { f, r, done };
}

describe('a sidebar field: its date replaced inside the field, the rest kept (ADR 0064 D6.2)', () => {
  it('PK-15 a Temporal Scope whose birth and death clauses hold the same date: the death pick edits the death clause', async () => {
    await pickRegister(OLAF, 'consistency_death');
    // SAFE: "died 4A 160" is the restated value; "Born 4A 160" is another clause.
    expect(rowText(w, coreOf(OLAF), 'Temporal Scope')).toBe('Born 4A 160; died 4A 161');
  });

  it('PK-16 the birth date is the start of a longer date in an earlier clause ("4A 160" in "4A 1600")', async () => {
    await pickRegister(PELL);
    expect(rowText(w, coreOf(PELL), 'Temporal Scope')).toBe('Attested 4A 1600–5A 931; Born 4A 163');
  });

  it('PK-17 a field written on two lines (a line break run): the break and the second line are kept', async () => {
    await pickRegister(QUIN);
    expect(rowRuns(w, coreOf(QUIN), 'Temporal Scope')).toEqual([
      { text: 'Born 4A 163' },
      { break: true },
      { text: 'Attested through 5A 931' },
    ]);
  });

  let rheaJob: string;
  it('PK-18 a bold date in the field: the new date is bold, the rest of the field as it was', async () => {
    const { done } = await pickRegister(RHEA);
    rheaJob = done.jobId!;
    expect(rowRuns(w, coreOf(RHEA), 'Temporal Scope')).toEqual([
      { text: 'Born ' },
      { text: '4A 163', bold: true },
      { text: '; attested through 5A 931' },
    ]);
  });

  it('PK-19 a link in another clause of the field: the link is kept', async () => {
    await pickRegister(SVEN);
    expect(rowRuns(w, coreOf(SVEN), 'Temporal Scope')).toEqual([
      { text: 'Born 4A 163; ' },
      { text: 'attested through 5A 931', link: 'https://example.test/attest/sven' },
    ]);
  });

  it('PK-20 a field holding a mention: not planned (change it by hand), nothing proposed or written', async () => {
    const f = findingOf(w, TOVA.name, 'consistency_birth');
    const before = proposalCount(w);
    const runs = rowRuns(w, coreOf(TOVA), 'Temporal Scope');
    const { r } = await pickPage(w, f, 'tovareg1');
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(r.json.error.code).toBe('NOTHING_TO_PROPOSE');
    expect(JSON.stringify(r.json.error.details)).toMatch(/holds a mention/);
    expect(proposalCount(w)).toBe(before);
    expect(rowRuns(w, coreOf(TOVA), 'Temporal Scope')).toEqual(runs);
  });

  it('PK-21 an identity value with a qualifier ("Elf; raised among Humans …"): only the principal value is replaced', async () => {
    const f = findingOf(w, URSA.name, 'consistency_identity');
    const values = await valuesOf(w, f);
    expect(values.map((v) => v.value)).toEqual(['Human', 'Elf; raised among Humans (see Upbringing)']);
    const { r } = await pickPage(w, f, coreOf(URSA));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const done = await approveAndWait(w, String(r.json.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    // SAFE (ADR 0064 amendment 1 E: the qualifier after the principal value is no part of the conflict): kept.
    expect(rowText(w, 'ursabio1', 'Race / Species')).toBe('Human; raised among Humans (see Upbringing)');
  });

  it('PK-22 control: a dated Life State with a second clause; only the date changes', async () => {
    await pickRegister(VIDA, 'consistency_death');
    expect(rowText(w, coreOf(VIDA), 'Life State')).toBe('Deceased Camue 5th, 4A 400; buried at Ashgate');
    expect(rowText(w, coreOf(VIDA), 'Temporal Scope')).toBe('Born 4A 300');
  });

  it('PK-66 the picks above changed no other field of the pages they edited (Last Major Revision by its rule only)', () => {
    const today = new Date().toISOString().slice(0, 10);
    for (const p of [OLAF, PELL, QUIN, RHEA, SVEN, VIDA]) {
      // ADR 0051 rule 3 (a changed fact other than the housekeeping keys is a major revision; a changed date is never a
      // typo), which ADR 0064 D6.3 keeps: the row reads today, or as it was.
      expect(['2026-11-01', today], p.name).toContain(rowText(w, coreOf(p), 'Last Major Revision'));
      expect(rowText(w, coreOf(p), 'Scope'), p.name).toBe(`${p.name}, a person of Arkona`);
      expect(rowText(w, coreOf(p), 'Race / Species'), p.name).toBe('Human');
      expect(rowText(w, coreOf(p), 'Subject'), p.name).toBe(p.name);
    }
    expect(rowText(w, coreOf(OLAF), 'Life State')).toBe('Deceased');
    expect(rowText(w, coreOf(VIDA), 'Temporal Scope')).toBe('Born 4A 300');
  });

  it('PK-23 Revert of a pick on a formatted field puts the field back exactly, marks included', async () => {
    expect(rheaJob).toBeDefined();
    const { r, job } = await revert(w, rheaJob);
    expect(r.status, JSON.stringify(r)).toBe('submitted');
    expect(job?.status, JSON.stringify(job?.lastError ?? null)).toBe('succeeded');
    expect(rowRuns(w, coreOf(RHEA), 'Temporal Scope')).toEqual([
      { text: 'Born ' },
      { text: '4A 160', bold: true },
      { text: '; attested through 5A 931' },
    ]);
  });
});
