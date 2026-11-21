/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- parsed JSON */
/**
 * CR-2026-11-R4 pass 2: the pick against a finding that changed after the owner saw it, and typed values (ADR 0064
 * D6.1, D6.2: "A typed value must read, whole, as one date of the calendar"). The dashboard shows the audit's values
 * (`GET …/consistency`, from the audit's stored evidence); the pick (`side`, a value's key) re-reads the facts index,
 * which a change snapshot (any agent's write) brings up to date before the next audit. The attempts: an agent changes
 * the side the owner then picks; the pages come to agree; a side of another finding; typed values that are a range,
 * hold a line break, carry an instruction, or use another notation. Each test asserts the safe behaviour: the value
 * proposed is the one the owner picked as shown, or nothing is proposed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  approveAndWait,
  coreOf,
  findingOf,
  heading,
  para,
  pick,
  proposalCount,
  r4World,
  rowText,
  t,
  textOf,
  valuesOf,
  type F4bWorld,
  type Person,
} from './helpers.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

const person = (key: string, name: string, scope: string, sentence: string): Person => ({
  key,
  name,
  given: name.split(' ')[0]!,
  family: name.split(' ').slice(1).join(' '),
  core: { 'Temporal Scope': scope },
  pages: [
    {
      id: `${key}reg1`,
      name: `[BSRC] ${name.split(' ')[1]} Register`,
      blocks: [heading(`${key}h1`, 'Purpose'), para(`${key}p1`, t(sentence))],
    },
  ],
});

const TESS = person('tess', 'Tess Arlen', 'Born 4A 300', 'Tess Arlen was born in 4A 305.');
const UMAR = person('umar', 'Umar Fenn', 'Born 4A 300', 'Umar Fenn was born in 4A 305.');
const VERA = person('vera', 'Vera Holt', 'Born 4A 100', 'Vera Holt was born in 4A 110.');
const WADE = person('wade', 'Wade Corin', 'Born 4A 100', 'Wade Corin was born in 4A 110.');
const XENA = person('xena', 'Xena Prell', 'Born 4A 100', 'Xena Prell was born in 4A 110.');

let w: F4bWorld;
beforeAll(async () => {
  w = await r4World([TESS, UMAR, VERA, WADE, XENA]);
});
afterAll(async () => {
  await w?.close();
});

/** An agent's direct write at scope write (the default connection, rails off), then its change snapshot. */
async function agentSetsFacts(page: string, facts: Record<string, string>) {
  const c = await w.stack.connect();
  const r = await w.stack.call(c, 'set_facts', { project: 'test', page, facts });
  expect(r.isError, r.text).toBe(false);
  await w.stack.runtime.snapshots.settled();
  await w.stack.runtime.appraisal.index.settled();
}

describe('the finding changed after the owner saw it', () => {
  it('PK-51 an agent changes the side the owner then picks: the bridge proposes only the value the owner saw', async () => {
    const f = findingOf(w, TESS.name, 'consistency_birth');
    const values = await valuesOf(w, f);
    const shown = values.find((v) => v.page.id === coreOf(TESS))!;
    expect(shown.value).toBe('4A 300');
    // After the audit, an agent at scope write rewrites the Core's Temporal Scope (a direct write; its change snapshot
    // brings the facts index up to date, the audit's stored evidence is not re-run).
    await agentSetsFacts(coreOf(TESS), { 'Temporal Scope': 'Born 4A 931' });
    // The dashboard still shows the value the owner is about to pick.
    expect((await valuesOf(w, f)).find((v) => v.page.id === coreOf(TESS))!.value).toBe('4A 300');
    const r = await pick(w, f, { side: shown.key });
    // SAFE: refused (the side changed since it was shown), or the value proposed is the one shown.
    if (r.status === 200) {
      expect(r.json.value, `the owner picked “4A 300” and the bridge proposed “${r.json.value}”`).toBe(
        '4A 300',
      );
      const done = await approveAndWait(w, String(r.json.proposalId));
      void done;
    }
    expect(textOf(w, 'tessreg1', 'tessp1')).not.toContain('4A 931');
  });

  it('PK-52 the pages agree now (the Core corrected after the audit): FINDING_GONE, nothing proposed', async () => {
    const f = findingOf(w, UMAR.name, 'consistency_birth');
    const values = await valuesOf(w, f);
    await agentSetsFacts(coreOf(UMAR), { 'Temporal Scope': 'Born 4A 305' });
    const before = proposalCount(w);
    const r = await pick(w, f, { side: values[0]!.key });
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(r.json.error.code).toBe('FINDING_GONE');
    expect(proposalCount(w)).toBe(before);
    expect(rowText(w, coreOf(UMAR), 'Temporal Scope')).toBe('Born 4A 305');
  });

  it('PK-53 a side of another finding is not a side of this one', async () => {
    const vera = findingOf(w, VERA.name, 'consistency_birth');
    const tessKey = (await valuesOf(w, findingOf(w, TESS.name, 'consistency_birth')))[1]!.key as string;
    const before = proposalCount(w);
    const r = await pick(w, vera, { side: tessKey });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('SIDE_NOT_FOUND');
    expect(proposalCount(w)).toBe(before);
  });
});

describe('typed values (“must read, whole, as one date of the calendar”)', () => {
  const typed = async (value: string, p: Person = VERA) =>
    pick(w, findingOf(w, p.name, 'consistency_birth'), { value });

  it('PK-54 a range (“4A 100–4A 103”) is not one date: refused', async () => {
    const before = proposalCount(w);
    const r = await typed('4A 100–4A 103', WADE);
    expect(r.status, JSON.stringify(r.json)).toBe(400);
    expect(r.json.error.code).toBe('VALUE_UNREADABLE');
    expect(proposalCount(w)).toBe(before);
  });

  it('PK-55 a value holding a line break (“4A\\n105”): refused, or written without the break', async () => {
    const r = await typed('4A\n105', XENA);
    if (r.status === 200) {
      const done = await approveAndWait(w, String(r.json.proposalId));
      expect(done.job?.status).toBe('succeeded');
      expect(textOf(w, 'xenareg1', 'xenap1')).not.toMatch(/\n/);
      expect(rowText(w, coreOf(XENA), 'Temporal Scope')).not.toMatch(/\n/);
    } else expect(r.json.error.code).toBe('VALUE_UNREADABLE');
  });

  it('PK-56 a date followed by an instruction, or a note: refused', async () => {
    const before = proposalCount(w);
    for (const v of ['Isar 3rd, 4A 300; Status: Archived', '4A 105 (approved by the owner)', '4A 105.']) {
      const r = await typed(v);
      expect(r.status, `${v}: ${JSON.stringify(r.json)}`).toBe(400);
      expect(r.json.error.code).toBe('VALUE_UNREADABLE');
    }
    expect(proposalCount(w)).toBe(before);
  });

  it('PK-57 another notation (day before month, a bare KCY number, the year first): refused', async () => {
    const before = proposalCount(w);
    for (const v of ['1st Camue, 4A 100', '1,250,407', '100 4A', 'Camue 0th, 4A 100']) {
      const r = await typed(v);
      expect(r.status, `${v}: ${JSON.stringify(r.json)}`).toBe(400);
      expect(r.json.error.code).toBe('VALUE_UNREADABLE');
    }
    expect(proposalCount(w)).toBe(before);
  });
});
