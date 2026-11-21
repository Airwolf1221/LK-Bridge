/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- parsed JSON */
/**
 * CR-2026-11-R4 pass 2: selective approval of a pick and Revert of its job (ADR 0064 D6.3: "Approval and selective
 * approval work as usual … Revert applies to an approved pick's job"; ADR 0058 decision 2; ADR 0055 decision B). The
 * attempts: some items approved, then Revert; Revert after the owner edited a page again (a sentence, a field); Revert of
 * a wrong-occurrence edit. Each test asserts the safe behaviour: an item left out is never written, Revert puts back only
 * what the job wrote and never what the owner changed since.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  approveAndWait,
  coreOf,
  findingOf,
  heading,
  outsideBlock,
  outsideRow,
  ownerClient,
  para,
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
const TOBI: Person = {
  key: 'tobi',
  name: 'Tobi Rand',
  given: 'Tobi',
  family: 'Rand',
  core: { 'Temporal Scope': 'Born 4A 100' },
  pages: [
    reg('tobia001', '[BSRC] Rand Register A', 'Tobi Rand was born in 4A 103.'),
    reg('tobib001', '[BSRC] Rand Register B', 'Tobi Rand was born in 4A 103.'),
  ],
};
const UGOR: Person = {
  key: 'ugor',
  name: 'Ugo Rask',
  given: 'Ugo',
  family: 'Rask',
  core: { 'Temporal Scope': 'Born 4A 100' },
  pages: [
    reg('ugora001', '[BSRC] Rask Ledger A', 'Ugo Rask was born in 4A 103.'),
    reg('ugorb001', '[BSRC] Rask Ledger B', 'Ugo Rask was born in 4A 103.'),
  ],
};

let w: F4bWorld;
beforeAll(async () => {
  w = await r4World([QUIL, ROSA, SAUL, YURI, TOBI, UGOR]);
});

/** "Propose these again" on the dashboard: the left-out items as a new proposal. */
async function repropose(id: string) {
  const r = await ownerClient(w).post(`/proposals/${id}/repropose?project=test`, { confirm: true });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return String(r.json.repropose.proposalId);
}
afterAll(async () => {
  await w?.close();
});

describe('selective approval and Revert of a pick', () => {
  it('PK-58 two of three pages approved: the third is never written; Revert puts back only the two', async () => {
    const f = findingOf(w, QUIL.name, 'consistency_birth');
    const { r } = await pickPage(w, f, coreOf(QUIL));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((r.json.items as any[]).map((i) => i.id).sort()).toEqual([
      'page:quila001',
      'page:quilb001',
      'page:quilc001',
    ]);
    const done = await approveAndWait(w, String(r.json.proposalId), ['page:quila001', 'page:quilb001']);
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    expect(textOf(w, 'quila001', 'quila001p')).toBe('Quill Arden was born in 4A 100.');
    expect(textOf(w, 'quilb001', 'quilb001p')).toBe('Quill Arden was born in 4A 100.');
    expect(textOf(w, 'quilc001', 'quilc001p')).toBe('Quill Arden was born in 4A 103.');
    const writesToC = w.stack.mock.calls.filter(
      (c) => c.method !== 'GET' && c.path.includes('quilc001'),
    ).length;
    expect(writesToC).toBe(0);
    const rv = await revert(w, done.job!.id);
    expect(rv.r.status, JSON.stringify(rv.r)).toBe('submitted');
    expect(rv.job?.status, JSON.stringify(rv.job?.lastError ?? null)).toBe('succeeded');
    expect(textOf(w, 'quila001', 'quila001p')).toBe('Quill Arden was born in 4A 103.');
    expect(textOf(w, 'quilb001', 'quilb001p')).toBe('Quill Arden was born in 4A 103.');
    expect(w.stack.mock.calls.filter((c) => c.method !== 'GET' && c.path.includes('quilc001')).length).toBe(
      0,
    );
  });

  it('PK-59 Revert after the owner edited one of the pick’s pages again: refused whole; confirmed partly, the owner’s edit is kept', async () => {
    const f = findingOf(w, ROSA.name, 'consistency_birth');
    const { r } = await pickPage(w, f, 'rosaa001');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const done = await approveAndWait(w, String(r.json.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    expect(rowText(w, coreOf(ROSA), 'Temporal Scope')).toBe('Born 4A 100');
    expect(textOf(w, 'rosab001', 'rosab001p')).toBe('Rosa Venn was born in 4A 100.');
    // The owner edits Register B again in the app.
    outsideBlock(w, 'rosab001', 'rosab001p', [t('Rosa Venn was born in 4A 100, at dawn.')]);
    const whole = await revert(w, done.job!.id);
    expect(whole.r.status).not.toBe('submitted');
    expect(textOf(w, 'rosab001', 'rosab001p')).toBe('Rosa Venn was born in 4A 100, at dawn.');
    expect(rowText(w, coreOf(ROSA), 'Temporal Scope')).toBe('Born 4A 100');
    const part = await revert(w, done.job!.id, { confirmPartial: true });
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
    const done = await approveAndWait(w, String(r.json.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    expect(rowText(w, coreOf(YURI), 'Temporal Scope')).toBe('Born 4A 100');
    outsideRow(w, coreOf(YURI), 'Temporal Scope', 'Born 4A 100 (confirmed by the owner)');
    const rv = await revert(w, done.job!.id, { confirmPartial: true });
    if (rv.job) expect(rv.job.status).toBe('succeeded');
    expect(rowText(w, coreOf(YURI), 'Temporal Scope')).toBe('Born 4A 100 (confirmed by the owner)');
  });

  it('PK-61 Revert of a pick that edited the wrong sentence (as PK-02) puts the paragraph back exactly', async () => {
    const f = findingOf(w, SAUL.name, 'consistency_birth');
    const before = textOf(w, 'saulr001', 'saulr001p');
    const { r } = await pickPage(w, f, coreOf(SAUL));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const done = await approveAndWait(w, String(r.json.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    const rv = await revert(w, done.job!.id);
    expect(rv.r.status, JSON.stringify(rv.r)).toBe('submitted');
    expect(rv.job?.status, JSON.stringify(rv.job?.lastError ?? null)).toBe('succeeded');
    expect(textOf(w, 'saulr001', 'saulr001p')).toBe(before);
  });

  it('PK-67 “Propose these again” of a page left out: the new proposal edits that page at its date only', async () => {
    const f = findingOf(w, TOBI.name, 'consistency_birth');
    const { r } = await pickPage(w, f, coreOf(TOBI));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const done = await approveAndWait(w, String(r.json.proposalId), ['page:tobia001']);
    expect(done.job?.status).toBe('succeeded');
    expect(textOf(w, 'tobib001', 'tobib001p')).toBe('Tobi Rand was born in 4A 103.');
    const again = await repropose(String(r.json.proposalId));
    expect(w.stack.runtime.policy.proposals.itemsOf(again)!.items.map((i) => i.id)).toEqual([
      'page:tobib001',
    ]);
    const second = await approveAndWait(w, again);
    expect(second.job?.status, JSON.stringify(second.job?.lastError ?? null)).toBe('succeeded');
    expect(textOf(w, 'tobib001', 'tobib001p')).toBe('Tobi Rand was born in 4A 100.');
    expect(textOf(w, 'tobia001', 'tobia001p')).toBe('Tobi Rand was born in 4A 100.');
  });

  it('PK-68 “Propose these again” after the left-out page changed (its old date now in another sentence): nothing widened', async () => {
    const f = findingOf(w, UGOR.name, 'consistency_birth');
    const { r } = await pickPage(w, f, coreOf(UGOR));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const done = await approveAndWait(w, String(r.json.proposalId), ['page:ugora001']);
    expect(done.job?.status).toBe('succeeded');
    outsideBlock(w, 'ugorb001', 'ugorb001p', [
      t('The Rask mill was built in 4A 103. Ugo Rask was born in 4A 105.'),
    ]);
    const again = await repropose(String(r.json.proposalId));
    await approveAndWait(w, again);
    expect(textOf(w, 'ugorb001', 'ugorb001p')).toBe(
      'The Rask mill was built in 4A 103. Ugo Rask was born in 4A 105.',
    );
  });
});
