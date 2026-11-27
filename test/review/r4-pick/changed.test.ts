/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- parsed JSON */
/**
 * CR-2026-11-R4 pass 2: "Pick the right value" when the page changed after the run that found the disagreement (the
 * pick plans from the snapshot's facts and reads each page live, ADR 0064 D6.2: "a value changed since the snapshot is
 * not planned and is listed") and after the pick, before or during its job (another writer's edit, a 412, as
 * R3's rebase-widening attempts provoke one). Each test asserts the safe behaviour: what changed since is never edited
 * in the found value's place, another writer's edit is kept, and the job never writes wider than the found value.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LIFECYCLE } from '../../packs/world.js';
import {
  pickDone,
  coreOf,
  findingOf,
  heading,
  holdWrites,
  intercept,
  outsideBlock,
  outsideInsert,
  outsideRow,
  para,
  pickPage,
  PROJECT,
  proposalCount,
  r4World,
  rowText,
  t,
  textOf,
  type F4bWorld,
  type Person,
} from './helpers.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

const person = (key: string, name: string, scope: string, sentence: string, more: any[] = []): Person => ({
  key,
  name,
  given: name.split(' ')[0]!,
  family: name.split(' ').slice(1).join(' '),
  core: { 'Temporal Scope': scope },
  pages: [
    {
      id: `${key}reg1`,
      name: `[BSRC] ${name.split(' ')[1]} Register`,
      blocks: [heading(`${key}h1`, 'Purpose'), para(`${key}p1`, t(sentence)), ...more],
    },
  ],
});

const ABEL = person('abel', 'Abel Norcross', 'Born 4A 100', 'Abel Norcross was born in 4A 103.');
const BRYN = person('bryn', 'Bryn Ostler', 'Born 4A 100', 'Bryn Ostler was born in 4A 103.');
const CATO = person('cato', 'Cato Mbeki', 'Born 4A 100', 'Cato Mbeki was born in 4A 103.');
const DINA = person('dina', 'Dina Farrow', 'Born 4A 100', 'Dina Farrow was born in 4A 103.');
const EDDA = person('edda', 'Edda Lund', 'Born 4A 100', 'Edda Lund was born in 4A 103.');
const FAYE = person('faye', 'Faye Corran', 'Born 4A 103', 'Faye Corran was born in 4A 100.');
const GWEN = person('gwen', 'Gwen Tarrow', 'Born 4A 103', 'Gwen Tarrow was born in 4A 100.');
const HUGO = person('hugo', 'Hugo Brandt', 'Born 4A 100', 'Hugo Brandt was born in 4A 103.');
const IRIS = person('iris', 'Iris Kade', 'Born 4A 100', 'Iris Kade was born in 4A 103.', [
  para('irisp2', t('The Kade mill stands by the river.')),
]);
const JUDE = person('jude', 'Jude Varn', 'Born 4A 100', 'Jude Varn was born in 4A 103.', [
  para('judep2', t('The Varn orchard was planted later.')),
]);
const KIRA = person('kira', 'Kira Solt', 'Born 4A 103', 'Kira Solt was born in 4A 100.');
const LIAM = person('liam', 'Liam Ord', 'Born 4A 103', 'Liam Ord was born in 4A 100.');
const MONA = person('mona', 'Mona Rask', 'Born 4A 100', 'Mona Rask was born in 4A 103.');

let w: F4bWorld;
beforeAll(async () => {
  w = await r4World([ABEL, BRYN, CATO, DINA, EDDA, FAYE, GWEN, HUGO, IRIS, JUDE, KIRA, LIAM, MONA]);
});
afterAll(async () => {
  await w?.close();
});

/** The owner's pick of one side of a person's birth finding (v3 F12: it runs at once as a job). */
async function pickOf(p: Person, pageId: string) {
  const f = findingOf(w, p.name, 'consistency_birth');
  return (await pickPage(w, f, pageId)).r;
}

describe('the page changed between the run and the pick', () => {
  it('PK-24 the sentence reworded, its old date now in another sentence of the paragraph: that sentence is not edited', async () => {
    outsideBlock(w, 'abelreg1', 'abelp1', [
      t('The Norcross toll was set in 4A 103. Abel Norcross was born in 4A 105.'),
    ]);
    const r = await pickOf(ABEL, coreOf(ABEL));
    if (r.status === 200) {
      const done = await pickDone(w, r.json);
      expect(['succeeded', 'failed']).toContain(done.job?.status);
    } else expect(r.json.error.code).toBe('NOTHING_TO_PROPOSE');
    // SAFE: the sentence the run found is gone; the toll's date is not the restated value.
    expect(textOf(w, 'abelreg1', 'abelp1')).toBe(
      'The Norcross toll was set in 4A 103. Abel Norcross was born in 4A 105.',
    );
  });

  it('PK-25 the value edited (the sentence now gives another date): not planned, nothing proposed', async () => {
    outsideBlock(w, 'brynreg1', 'brynp1', [t('Bryn Ostler was born in 4A 105.')]);
    const before = proposalCount(w);
    const r = await pickOf(BRYN, coreOf(BRYN));
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(r.json.error.code).toBe('NOTHING_TO_PROPOSE');
    expect(proposalCount(w)).toBe(before);
    expect(textOf(w, 'brynreg1', 'brynp1')).toBe('Bryn Ostler was born in 4A 105.');
  });

  it('PK-26 a block holding the same date inserted above: the pick edits the found block only', async () => {
    outsideInsert(w, 'catoreg1', para('catop0', t('Cato Mbeki was born in 4A 103, say the elders.')));
    const r = await pickOf(CATO, coreOf(CATO));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const done = await pickDone(w, r.json);
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    expect(textOf(w, 'catoreg1', 'catop0')).toBe('Cato Mbeki was born in 4A 103, say the elders.');
    expect(textOf(w, 'catoreg1', 'catop1')).toBe('Cato Mbeki was born in 4A 100.');
  });

  it('PK-27 the page renamed: edited by its id, only the date; its new name is kept', async () => {
    w.repo.outside.rename('dinareg1', '[BSRC] Farrow Parish Book');
    const r = await pickOf(DINA, coreOf(DINA));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const done = await pickDone(w, r.json);
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    expect(textOf(w, 'dinareg1', 'dinap1')).toBe('Dina Farrow was born in 4A 100.');
    expect(w.repo.live('dinareg1')!.name).toBe('[BSRC] Farrow Parish Book');
  });

  it('PK-28 the page moved into the Archived area: an Archived page is never edited by the pick', async () => {
    w.repo.outside.move('eddareg1', LIFECYCLE.archived);
    w.repo.outside.rename('eddareg1', '[BARC] Lund Register');
    w.repo.outside.setTags('eddareg1', ['Archived']);
    const r = await pickOf(EDDA, coreOf(EDDA));
    if (r.status === 200) {
      const done = await pickDone(w, r.json);
      expect(['succeeded', 'failed']).toContain(done.job?.status);
    }
    // SAFE (ADR 0064 D3/D4 decision 7; history is left as it is): the Archived page keeps its text.
    expect(textOf(w, 'eddareg1', 'eddap1')).toBe('Edda Lund was born in 4A 103.');
  });

  it('PK-29 the field renamed: not planned, nothing proposed', async () => {
    outsideRow(w, coreOf(FAYE), 'Temporal Scope', 'Born 4A 103', 'Lifespan');
    const before = proposalCount(w);
    const r = await pickOf(FAYE, 'fayereg1');
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(r.json.error.code).toBe('NOTHING_TO_PROPOSE');
    expect(JSON.stringify(r.json.error.details)).toMatch(/no longer on the page/);
    expect(proposalCount(w)).toBe(before);
  });

  it('PK-30 the field reworded, its old date now in another clause: that clause is not edited', async () => {
    outsideRow(w, coreOf(GWEN), 'Temporal Scope', 'Baptised 4A 103; Born 4A 105');
    const r = await pickOf(GWEN, 'gwenreg1');
    if (r.status === 200) {
      const done = await pickDone(w, r.json);
      expect(['succeeded', 'failed']).toContain(done.job?.status);
    } else expect(r.json.error.code).toBe('NOTHING_TO_PROPOSE');
    // SAFE: the clause the run found ("Born 4A 103") is gone; the baptism is not the restated value.
    expect(rowText(w, coreOf(GWEN), 'Temporal Scope')).toBe('Baptised 4A 103; Born 4A 105');
  });
});

// v3 F12 (ADR 0081): the confirmed pick runs at once as a job; the engine's write hold stands in for the time between
// the pick and its job's run (it was the time before approval).
describe('the page changed between the pick and its job’s run, or while the job ran', () => {
  it('PK-31 the sentence edited before the job runs: the job’s check stops it, nothing is written', async () => {
    const release = holdWrites(w);
    const r = await pickOf(HUGO, coreOf(HUGO));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    outsideBlock(w, 'hugoreg1', 'hugop1', [t('Hugo Brandt was born in 4A 103, in the rain.')]);
    release();
    const done = await pickDone(w, r.json);
    expect(done.job?.status).not.toBe('succeeded');
    expect(textOf(w, 'hugoreg1', 'hugop1')).toBe('Hugo Brandt was born in 4A 103, in the rain.');
  });

  it('PK-32 another paragraph of the same page edited before the job runs: nothing is written over it', async () => {
    const release = holdWrites(w);
    const r = await pickOf(IRIS, coreOf(IRIS));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    outsideBlock(w, 'irisreg1', 'irisp2', [t('The Kade mill burned down.')]);
    release();
    const done = await pickDone(w, r.json);
    expect(textOf(w, 'irisreg1', 'irisp2')).toBe('The Kade mill burned down.');
    // Either stopped (the page is not as planned) or written only at the date.
    expect(['Iris Kade was born in 4A 103.', 'Iris Kade was born in 4A 100.']).toContain(
      textOf(w, 'irisreg1', 'irisp1'),
    );
    void done;
  });

  it('PK-33 another writer edits another paragraph as the write is sent (412): no rebase widens it, the edit is kept', async () => {
    const release = holdWrites(w);
    const r = await pickOf(JUDE, coreOf(JUDE));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const hook = intercept(w, 'PUT', /\/blocks\/judep1$/, (n) => {
      if (n === 0) outsideBlock(w, 'judereg1', 'judep2', [t('The Varn orchard was felled.')]);
    });
    release();
    const done = await pickDone(w, r.json);
    hook.off();
    expect(hook.count()).toBeGreaterThanOrEqual(1);
    // Set-up: LegendKeeper refused the write (412), so the engine met the conflict this attempt is about.
    expect(done.job?.status).toBe('failed');
    expect(JSON.stringify(done.job?.lastError)).toMatch(/VERSION_CONFLICT|VERSION_MISMATCH|412/);
    expect(textOf(w, 'judereg1', 'judep2')).toBe('The Varn orchard was felled.');
    expect(['Jude Varn was born in 4A 103.', 'Jude Varn was born in 4A 100.']).toContain(
      textOf(w, 'judereg1', 'judep1'),
    );
    // A step retried by the owner after the conflict re-sends nothing wider either.
    if (done.job?.status === 'failed') {
      const failed = done.job.steps.find((s) => s.status === 'failed')!;
      w.stack.runtime.engine.controls.retryStep(PROJECT, done.job.id, failed.stepNo);
      for (let i = 0; i < 300; i++) {
        const j = w.stack.runtime.engine.queries.getJob(PROJECT, done.job.id)!;
        if (['succeeded', 'failed', 'cancelled'].includes(j.status)) break;
        await new Promise((res) => setTimeout(res, 20));
      }
      expect(textOf(w, 'judereg1', 'judep2')).toBe('The Varn orchard was felled.');
      expect(['Jude Varn was born in 4A 103.', 'Jude Varn was born in 4A 100.']).toContain(
        textOf(w, 'judereg1', 'judep1'),
      );
    }
  });

  it('PK-34 another row of the sidebar edited before the job runs: nothing is written over it', async () => {
    const release = holdWrites(w);
    const r = await pickOf(KIRA, 'kirareg1');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    outsideRow(w, coreOf(KIRA), 'Scope', 'Kira Solt, a person of Arkona (revised)');
    release();
    await pickDone(w, r.json);
    expect(rowText(w, coreOf(KIRA), 'Scope')).toBe('Kira Solt, a person of Arkona (revised)');
    expect(['Born 4A 103', 'Born 4A 100']).toContain(rowText(w, coreOf(KIRA), 'Temporal Scope'));
  });

  it('PK-35 another writer edits another row as the row write is sent (412): the edit is kept, nothing widened', async () => {
    const release = holdWrites(w);
    const r = await pickOf(LIAM, 'liamreg1');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const hook = intercept(w, 'PATCH', /\/resources\/liamcor1\/properties\/[^/]+\/rows\/[^/]+$/, (n) => {
      if (n === 0) outsideRow(w, coreOf(LIAM), 'Scope', 'Liam Ord, revised by another writer');
    });
    release();
    const done = await pickDone(w, r.json);
    hook.off();
    expect(hook.count()).toBeGreaterThanOrEqual(1);
    // Set-up: LegendKeeper refused the row write (412).
    expect(done.job?.status).toBe('failed');
    expect(JSON.stringify(done.job?.lastError)).toMatch(/VERSION_CONFLICT|VERSION_MISMATCH|412/);
    expect(rowText(w, coreOf(LIAM), 'Scope')).toBe('Liam Ord, revised by another writer');
    expect(['Born 4A 103', 'Born 4A 100']).toContain(rowText(w, coreOf(LIAM), 'Temporal Scope'));
  });
});

describe('controls', () => {
  it('PK-28c control for PK-28: the same move, seen by a full snapshot, takes the page out of the comparison', async () => {
    const f = findingOf(w, MONA.name, 'consistency_birth');
    w.repo.outside.move('monareg1', LIFECYCLE.archived);
    w.repo.outside.rename('monareg1', '[BARC] Rask Register');
    w.repo.outside.setTags('monareg1', ['Archived']);
    await w.snapshot();
    // The bridge reads the moved page as Archived: the only restatement is gone, so the finding clears.
    expect(w.stack.runtime.audits.store.get(PROJECT, f.id)!.state).toBe('gone');
  });
});
