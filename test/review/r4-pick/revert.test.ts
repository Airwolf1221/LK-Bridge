/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- parsed JSON */
/**
 * CR-2026-11-R4 pass 2: Revert of a pick's job (ADR 0064 D6.3: "Revert applies to an approved pick's job"; ADR 0058
 * decision 2; ADR 0055 decision B). v3 F12 (ADR 0081): the owner's confirmed pick runs at once as one job editing every
 * page planned, so selective approval of a pick (and "Propose these again" of a page left out, PK-67, PK-68) is gone.
 * The attempts: Revert of a pick of three pages; Revert after the owner edited a page again (a sentence, a field);
 * Revert of a wrong-occurrence edit. Each test asserts the safe behaviour: Revert puts back only what the job wrote and
 * never what the owner changed since.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  coreOf,
  findingOf,
  heading,
  outsideBlock,
  outsideRow,
  para,
  pickDone,
  pickPage,
  r4World,
  revert,
  rowText,
  t,
  textOf,
  type F4bWorld,
  type Person,
} from './helpers.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

const reg = (id: string, name: string, sentence: string) => ({
  id,
  name,
  blocks: [heading(`${id}h`, 'Purpose'), para(`${id}p`, t(sentence))],
});

const QUIL: Person = {
  key: 'quil',
  name: 'Quill Arden',
  given: 'Quill',
  family: 'Arden',
  core: { 'Temporal Scope': 'Born 4A 100' },
  pages: [
    reg('quila001', '[BSRC] Arden Register A', 'Quill Arden was born in 4A 103.'),
    reg('quilb001', '[BSRC] Arden Register B', 'Quill Arden was born in 4A 103.'),
    reg('quilc001', '[BSRC] Arden Register C', 'Quill Arden was born in 4A 103.'),
  ],
};
const ROSA: Person = {
  key: 'rosa',
  name: 'Rosa Venn',
  given: 'Rosa',
  family: 'Venn',
  core: { 'Temporal Scope': 'Born 4A 103' },
  pages: [
    reg('rosaa001', '[BSRC] Venn Register A', 'Rosa Venn was born in 4A 100.'),
    reg('rosab001', '[BSRC] Venn Register B', 'Rosa Venn was born in 4A 105.'),
  ],
};
const SAUL: Person = {
  key: 'saul',
  name: 'Saul Brine',
  given: 'Saul',
  family: 'Brine',
  core: { 'Temporal Scope': 'Born 4A 100' },
  pages: [
    reg(
      'saulr001',
      '[BSRC] Brine Register',
      'The Brine accord was signed in 4A 103. Saul Brine was born in 4A 103.',
    ),
  ],
};
const YURI: Person = {
  key: 'yuri',
  name: 'Yuri Sand',
  given: 'Yuri',
  family: 'Sand',
  core: { 'Temporal Scope': 'Born 4A 103' },
  pages: [reg('yurir001', '[BSRC] Sand Register', 'Yuri Sand was born in 4A 100.')],
};
let w: F4bWorld;
beforeAll(async () => {
  w = await r4World([QUIL, ROSA, SAUL, YURI]);
});
afterAll(async () => {
  await w?.close();
});

describe('Revert of a pick', () => {
  it('PK-58 a pick of three pages (v3 F12: run at once, every page): Revert puts back exactly the three', async () => {
    const f = findingOf(w, QUIL.name, 'consistency_birth');
    const { r } = await pickPage(w, f, coreOf(QUIL));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((r.json.items as any[]).map((i) => i.id).sort()).toEqual([
      'page:quila001',
      'page:quilb001',
      'page:quilc001',
    ]);
    const done = await pickDone(w, r.json);
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    for (const id of ['quila001', 'quilb001', 'quilc001'])
      expect(textOf(w, id, `${id}p`)).toBe('Quill Arden was born in 4A 100.');
    const rv = await revert(w, done.job.id);
    expect(rv.r.status, JSON.stringify(rv.r)).toBe('submitted');
    expect(rv.job?.status, JSON.stringify(rv.job?.lastError ?? null)).toBe('succeeded');
    for (const id of ['quila001', 'quilb001', 'quilc001'])
      expect(textOf(w, id, `${id}p`)).toBe('Quill Arden was born in 4A 103.');
    expect(rowText(w, coreOf(QUIL), 'Temporal Scope')).toBe('Born 4A 100');
  });

  it('PK-59 Revert after the owner edited one of the pick’s pages again: refused whole; confirmed partly, the owner’s edit is kept', async () => {
    const f = findingOf(w, ROSA.name, 'consistency_birth');
    const { r } = await pickPage(w, f, 'rosaa001');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const done = await pickDone(w, r.json);
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    expect(rowText(w, coreOf(ROSA), 'Temporal Scope')).toBe('Born 4A 100');
    expect(textOf(w, 'rosab001', 'rosab001p')).toBe('Rosa Venn was born in 4A 100.');
    // The owner edits Register B again in the app.
    outsideBlock(w, 'rosab001', 'rosab001p', [t('Rosa Venn was born in 4A 100, at dawn.')]);
    const whole = await revert(w, done.job.id);
    expect(whole.r.status).not.toBe('submitted');
    expect(textOf(w, 'rosab001', 'rosab001p')).toBe('Rosa Venn was born in 4A 100, at dawn.');
    expect(rowText(w, coreOf(ROSA), 'Temporal Scope')).toBe('Born 4A 100');
    const part = await revert(w, done.job.id, { confirmPartial: true });
    expect(part.r.status, JSON.stringify(part.r)).toBe('submitted');
    expect(part.job?.status, JSON.stringify(part.job?.lastError ?? null)).toBe('succeeded');
    expect(rowText(w, coreOf(ROSA), 'Temporal Scope')).toBe('Born 4A 103');
    expect(textOf(w, 'rosab001', 'rosab001p')).toBe('Rosa Venn was born in 4A 100, at dawn.');
    expect(textOf(w, 'rosaa001', 'rosaa001p')).toBe('Rosa Venn was born in 4A 100.');
  });

  it('PK-60 Revert after the owner re-edited the field the pick wrote: the owner’s value is kept', async () => {
    const f = findingOf(w, YURI.name, 'consistency_birth');
    const { r } = await pickPage(w, f, 'yurir001');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const done = await pickDone(w, r.json);
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    expect(rowText(w, coreOf(YURI), 'Temporal Scope')).toBe('Born 4A 100');
    outsideRow(w, coreOf(YURI), 'Temporal Scope', 'Born 4A 100 (confirmed by the owner)');
    const rv = await revert(w, done.job.id, { confirmPartial: true });
    if (rv.job) expect(rv.job.status).toBe('succeeded');
    expect(rowText(w, coreOf(YURI), 'Temporal Scope')).toBe('Born 4A 100 (confirmed by the owner)');
  });

  it('PK-61 Revert of a pick that edited the wrong sentence (as PK-02) puts the paragraph back exactly', async () => {
    const f = findingOf(w, SAUL.name, 'consistency_birth');
    const before = textOf(w, 'saulr001', 'saulr001p');
    const { r } = await pickPage(w, f, coreOf(SAUL));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const done = await pickDone(w, r.json);
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    const rv = await revert(w, done.job.id);
    expect(rv.r.status, JSON.stringify(rv.r)).toBe('submitted');
    expect(rv.job?.status, JSON.stringify(rv.job?.lastError ?? null)).toBe('succeeded');
    expect(textOf(w, 'saulr001', 'saulr001p')).toBe(before);
  });
});
