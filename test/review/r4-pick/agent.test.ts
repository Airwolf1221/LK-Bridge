/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- parsed JSON */
/**
 * CR-2026-11-R4 pass 2: an agent at scope `write` steering the owner's pick with an ordinary direct edit (the class of
 * R3-12 and R3-25: an ordinary edit, an agent's included, made an owner-approved change apply where the owner had not
 * approved it). After the audit an agent edits a page the finding names (write_page, set_facts: direct writes at scope
 * write, each followed by its change snapshot); the owner then picks on the dashboard (v3 F12: it runs at once). Each test asserts the
 * safe behaviour: the owner's approved edit lands on the restated value only, never on text the agent chose.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  pickDone,
  coreOf,
  findingOf,
  heading,
  para,
  pickPage,
  r4World,
  rowText,
  t,
  textOf,
  valuesOf,
  type F4bWorld,
  type Person,
} from './helpers.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

const WYNN: Person = {
  key: 'wynn',
  name: 'Wynn Ostra',
  given: 'Wynn',
  family: 'Ostra',
  core: { 'Temporal Scope': 'Born 4A 100' },
  pages: [
    {
      id: 'wynnreg1',
      name: '[BSRC] Ostra Register',
      blocks: [heading('wynnh1', 'Purpose'), para('wynnp1', t('Wynn Ostra was born in 4A 103.'))],
    },
  ],
};
const YARA: Person = {
  key: 'yara',
  name: 'Yara Pell',
  given: 'Yara',
  family: 'Pell',
  core: { 'Temporal Scope': 'Born 4A 103' },
  pages: [
    {
      id: 'yarareg1',
      name: '[BSRC] Pell Register',
      blocks: [heading('yarah1', 'Purpose'), para('yarap1', t('Yara Pell was born in 4A 100.'))],
    },
  ],
};

let w: F4bWorld;
beforeAll(async () => {
  w = await r4World([WYNN, YARA]);
});
afterAll(async () => {
  await w?.close();
});

async function agent(name: string, args: Record<string, unknown>) {
  // v3 F12: the world's own agent is at scope propose; this one is at scope write, where its edit is direct.
  const c = await w.stack.connect(w.stack.newToken('r4-pick-writer', 'write').token);
  const r = await w.stack.call(c, name, { project: 'test', ...args });
  expect(r.isError, r.text).toBe(false);
  await w.stack.runtime.snapshots.settled();
  await w.stack.runtime.appraisal.index.settled();
  return r;
}

describe('an agent’s direct edit after the audit, then the owner’s pick', () => {
  it('PK-69 the agent writes a sentence holding the same date before the restated one: the owner’s pick never edits it', async () => {
    const f = findingOf(w, WYNN.name, 'consistency_birth');
    await agent('write_page', {
      page: 'wynnreg1',
      mode: 'replace_section',
      section: 'Purpose',
      markdown: 'The Ostra charter is dated 4A 103. Wynn Ostra was born in 4A 103.',
    });
    // The dashboard (the audit's evidence) still shows the restatement the owner reads.
    expect((await valuesOf(w, f)).map((v) => v.excerpt)).toContain('Wynn Ostra was born in 4A 103.');
    const { r } = await pickPage(w, f, coreOf(WYNN));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const done = await pickDone(w, r.json);
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    const body = (w.repo.blocks.get(w.mainOf('wynnreg1'))!.blocks as any[]).filter(
      (b) => b.kind === 'paragraph',
    );
    const text = body.map((b) => textOf(w, 'wynnreg1', b.id)).join(' ');
    // SAFE: the charter's date (the agent's text) is as the agent wrote it; the birth reads the owner's value.
    expect(text).toBe('The Ostra charter is dated 4A 103. Wynn Ostra was born in 4A 100.');
  });

  it('PK-70 the agent adds a clause holding the same date before the birth clause of the Core: the owner’s pick never edits it', async () => {
    const f = findingOf(w, YARA.name, 'consistency_birth');
    await agent('set_facts', {
      page: coreOf(YARA),
      facts: { 'Temporal Scope': 'Married 4A 103; Born 4A 103' },
    });
    const { r } = await pickPage(w, f, 'yarareg1');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const done = await pickDone(w, r.json);
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    expect(rowText(w, coreOf(YARA), 'Temporal Scope')).toBe('Married 4A 103; Born 4A 100');
  });
});
