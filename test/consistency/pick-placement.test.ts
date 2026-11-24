/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- parsed JSON and mock documents */
/**
 * CR-2026-11-R4 ("Pick the right value", ADR 0064 D6): every edit is PLACED where the check read the value, never
 * searched for. Regression tests beside the reviewer's attempts (test/review/r4-pick), for what they leave unpinned:
 *
 * - the facts index records where each value was read (its sentence or clause, by its SHA-1, and the date's offset);
 * - a page Archived between the pick and its approval: the job checks the page's name, parent and tags inside its locks
 *   and stops before writing it;
 * - a restatement inside a quotation is listed (never edited) while the page's plain restatement is planned, and the
 *   item shows the whole sentence before and after;
 * - a sentence written twice in its paragraph is not planned (which one is meant cannot be told);
 * - the side's value as the dashboard showed it must still be the stored one (`SIDE_CHANGED`);
 * - an identity value: only the principal part is written (the picked side's qualifier is not copied);
 * - a typed value holding a line break is refused (`VALUE_UNREADABLE`).
 *
 * Against F4b's world on the mock LegendKeeper (test/consistency/world.ts). Nothing here touches a live system.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Finding } from '../../src/audits/types.js';
import { placeSha } from '../../src/consistency/extract.js';
import { SidebarModel } from '../resources/world.js';
import { approve, IDENTITY_KEYS, LIFECYCLE } from '../packs/world.js';
import { C, f4bWorld, ownerClient, PROJECT, type F4bWorld } from './world.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

type Obj = Record<string, any>;
const t = (text: string, marks: Obj = {}): Obj => ({ text, ...marks });
const para = (id: string, ...runs: Obj[]): Obj => ({ id, kind: 'paragraph', content: runs });

interface Person {
  readonly key: string;
  readonly name: string;
  readonly core: Readonly<Record<string, string>>;
  readonly blocks: readonly Obj[];
  /** A sidebar for the register page (its Subject the person's: a restatement of the identity facts). */
  readonly sidebar?: Readonly<Record<string, string>>;
}

const AMOS: Person = {
  key: 'amos',
  name: 'Amos Hale',
  core: { 'Temporal Scope': 'Born 4A 100' },
  blocks: [para('amosp1', t('Amos Hale was born in 4A 103.'))],
};
const BETH: Person = {
  key: 'beth',
  name: 'Beth Ivers',
  core: { 'Temporal Scope': 'Born 4A 100' },
  blocks: [
    para('bethp1', t('The stone by the well reads “Beth Ivers was born in 4A 103.”')),
    para('bethp2', t('Beth Ivers was born in 4A 103, the parish says.')),
  ],
};
const CORA: Person = {
  key: 'cora',
  name: 'Cora Jensen',
  core: { 'Temporal Scope': 'Born 4A 100' },
  blocks: [
    para('corap1', t('Cora Jensen was born in 4A 103. Cora Jensen was born in 4A 103. She lived long.')),
  ],
};
const DEAN: Person = {
  key: 'dean',
  name: 'Dean Kerr',
  core: { 'Temporal Scope': 'Born 4A 100' },
  blocks: [para('deanp1', t('Dean Kerr was born in 4A 103.'))],
};
const ELLA: Person = {
  key: 'ella',
  name: 'Ella Lark',
  core: {},
  blocks: [para('ellap1', t('The life of Ella Lark.'))],
  sidebar: { Subject: 'Ella Lark', 'Race / Species': 'Elf (by adoption)' },
};
const FINN: Person = {
  key: 'finn',
  name: 'Finn Moss',
  core: { 'Temporal Scope': 'Born 4A 100' },
  blocks: [para('finnp1', t('Finn Moss was born in 4A 103.'))],
};
const GWYN: Person = {
  key: 'gwyn',
  name: 'Gwyn Nash',
  core: { 'Temporal Scope': 'Born 4A 100' },
  blocks: [para('gwynp1', t('Gwyn Nash was born in 4A 103.'))],
  sidebar: { Subject: 'Gwyn Nash', 'Temporal Scope': 'Born 4A 103' },
};
const PEOPLE = [AMOS, BETH, CORA, DEAN, ELLA, FINN, GWYN];

const canon = {
  Status: 'Authoritative',
  'Continuity Type': 'CANON',
  Continuity: 'Main',
  Inheritance: 'None',
};
const core = (p: Person) => `${p.key}cor1`;
const reg = (p: Person) => `${p.key}reg1`;

let w: F4bWorld;
beforeAll(async () => {
  w = await f4bWorld({
    seed: (world) => {
      for (const p of PEOPLE) {
        world.repo.seed({ id: `${p.key}idx1`, name: `[INDEX] ${p.name}`, parentId: C.humans });
        world.repo.seed({
          id: core(p),
          name: `[BSRC] ${p.name} - Character Core`,
          parentId: `${p.key}idx1`,
          referenceType: 'Character Core',
          canonical: p.name,
          tags: ['CANON', 'Character', 'Human'],
        });
        world.repo.seed({
          id: reg(p),
          name: `[BSRC] ${p.name.split(' ')[1]} Register`,
          parentId: p.sidebar ? `${p.key}idx1` : C.humans,
          ...(p.sidebar ? { referenceType: 'General Source' } : {}),
          tags: ['CANON'],
        });
      }
    },
  });
  const kv = (id: string, v: Readonly<Record<string, string>>) =>
    w.sidebars.page(id, [
      SidebarModel.kv(
        `kv${id}`.slice(0, 8),
        'PROPERTIES',
        IDENTITY_KEYS.map((k) => [k, v[k] ?? ''] as [string, string]),
      ),
      SidebarModel.links(`dp${id}`.slice(0, 8), 'Dependencies', []),
      SidebarModel.links(`rl${id}`.slice(0, 8), 'Related Sources', []),
      { id: `tg${id}`.slice(0, 8), kind: 'unsupported' as const, title: 'TAGS' },
    ]);
  for (const p of PEOPLE) {
    const [given, ...family] = p.name.split(' ');
    kv(core(p), {
      ...canon,
      Subject: p.name,
      'Canonical Display Name': p.name,
      'Personal / Given Name': given!,
      'Family / Surname': family.join(' '),
      'Naming Culture': 'Velaran',
      'Reference Type': 'Character Core',
      Scope: `${p.name}, a person of Arkona`,
      'Race / Species': 'Human',
      'Life State': 'Alive',
      'Last Major Revision': '2026-11-01',
      Supersedes: 'None',
      ...p.core,
    });
    w.setBody(core(p), [para(`${p.key}c1`, t(`The identity of ${p.name}.`))]);
    if (p.sidebar) kv(reg(p), { ...canon, 'Reference Type': 'General Source', ...p.sidebar });
    w.setBody(reg(p), [...p.blocks]);
  }
  w.rebuildTree();
  await w.snapshot();
});
afterAll(async () => {
  await w?.close();
});

const findingOf = (subject: string, code: string): Finding => {
  const all = w.stack.runtime.audits.list(PROJECT, {
    category: ['consistency'],
    acknowledged: 'include',
    limit: 500,
  }).findings;
  const f = all.find((x) => x.code === code && x.evidence.subject === subject && x.state === 'open');
  expect(f, `no open ${code} finding for ${subject}`).toBeDefined();
  return f!;
};
const valuesOf = async (f: Finding): Promise<Obj[]> =>
  (await ownerClient(w).get(`/audits/findings/${f.id}/consistency?project=test`)).json.values as Obj[];
const pick = (f: Finding, body: Obj) => {
  const o = ownerClient(w);
  o.reauth();
  return o.post(`/audits/findings/${f.id}/consistency-pick?project=test`, { confirm: true, ...body });
};
const textOf = (pageId: string, blockId: string): string =>
  ((w.repo.blocks.get(w.mainOf(pageId))!.blocks as Obj[]).find((b) => b.id === blockId)!.content as Obj[])
    .map((r) => r.text ?? r.mention?.text ?? '')
    .join('');
const rowText = (pageId: string, key: string): string =>
  (w.sidebars.pages.get(pageId)!.props.find((x) => x.title === 'PROPERTIES')!.rows ?? [])
    .find((r) => r.key === key)!
    .content.map((c: Obj) => c.text ?? '')
    .join('');
const proposals = () => w.stack.runtime.policy.proposals.list({ project: PROJECT, limit: 1000 }).length;

describe('the pick places each edit where the check read the value (CR-2026-11-R4)', () => {
  it('the facts index records the sentence and the date’s offset in it, and a clause’s', () => {
    const facts = w.stack.runtime.consistency.facts;
    const prose = facts.factsOn(PROJECT, [reg(AMOS)]).find((f) => f.pattern === 'birth.prose')!;
    expect(prose.place).toEqual({ sha: placeSha('Amos Hale was born in 4A 103.'), at: 22 });
    const scope = facts.factsOn(PROJECT, [core(AMOS)]).find((f) => f.pattern === 'birth.scope')!;
    expect(scope.place).toEqual({ sha: placeSha('Born 4A 100'), at: 5 });
  });

  it('a page Archived between the pick and its approval: the job checks it inside its locks and writes nothing', async () => {
    const f = findingOf(AMOS.name, 'consistency_birth');
    const side = (await valuesOf(f)).find((v) => v.page.id === core(AMOS))!;
    const r = await pick(f, { side: side.key });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // The owner archives the register in the app while the pick waits for approval.
    w.repo.outside.move(reg(AMOS), LIFECYCLE.archived);
    w.repo.outside.rename(reg(AMOS), '[BARC] Hale Register');
    w.repo.outside.setTags(reg(AMOS), ['Archived']);
    const done = await approve(w, String(r.json.proposalId));
    expect(done.job?.status).not.toBe('succeeded');
    expect(JSON.stringify(done.job?.lastError ?? null)).toMatch(/name|parent|tags/);
    expect(textOf(reg(AMOS), 'amosp1')).toBe('Amos Hale was born in 4A 103.');
  });

  it('a quotation is listed and never edited; the plain restatement is, and its item shows the whole sentence', async () => {
    const f = findingOf(BETH.name, 'consistency_birth');
    const side = (await valuesOf(f)).find((v) => v.page.id === core(BETH))!;
    const r = await pick(f, { side: side.key });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.notPlanned).toEqual([
      expect.objectContaining({ from: '4A 103', why: expect.stringMatching(/quotation is never edited/) }),
    ]);
    expect(r.json.items).toHaveLength(1);
    expect(r.json.items[0].diff.changes).toEqual([
      {
        what: 'the sentence',
        before: 'Beth Ivers was born in 4A 103, the parish says.',
        after: 'Beth Ivers was born in 4A 100, the parish says.',
        // Amendment 1 to ADR 0072: the replaced words, marked for the Proposals page.
        removed: { start: 26, end: 29 },
        added: { start: 26, end: 29 },
      },
    ]);
    // …and the proposal's summary and operations show the sentence before and after.
    const detail = w.stack.runtime.policy.proposals.detail(String(r.json.proposalId))!;
    expect((detail.operations as Obj[]).flatMap((o) => (o.textChanges as Obj[] | undefined) ?? [])).toEqual([
      expect.objectContaining({
        before: 'Beth Ivers was born in 4A 103, the parish says.',
        after: 'Beth Ivers was born in 4A 100, the parish says.',
      }),
    ]);
    expect(detail.summary).toContain('“Beth Ivers was born in 4A 103, the parish says.”');
    const done = await approve(w, String(r.json.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    expect(textOf(reg(BETH), 'bethp1')).toBe('The stone by the well reads “Beth Ivers was born in 4A 103.”');
    expect(textOf(reg(BETH), 'bethp2')).toBe('Beth Ivers was born in 4A 100, the parish says.');
  });

  it('a sentence written twice in its paragraph is not planned: which one is meant cannot be told', async () => {
    const f = findingOf(CORA.name, 'consistency_birth');
    const side = (await valuesOf(f)).find((v) => v.page.id === core(CORA))!;
    const before = proposals();
    const r = await pick(f, { side: side.key });
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(r.json.error.code).toBe('NOTHING_TO_PROPOSE');
    expect(JSON.stringify(r.json.error.details)).toMatch(/more than once/);
    expect(proposals()).toBe(before);
    expect(textOf(reg(CORA), 'corap1')).toBe(
      'Cora Jensen was born in 4A 103. Cora Jensen was born in 4A 103. She lived long.',
    );
  });

  it('a side sent with a value other than the one stored (the page showed an older finding): SIDE_CHANGED', async () => {
    const f = findingOf(DEAN.name, 'consistency_birth');
    const side = (await valuesOf(f)).find((v) => v.page.id === core(DEAN))!;
    const before = proposals();
    const r = await pick(f, { side: side.key, shown: '4A 99' });
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(r.json.error.code).toBe('SIDE_CHANGED');
    expect(proposals()).toBe(before);
    // The value shown, sent with the side: proposed.
    const ok = await pick(f, { side: side.key, shown: side.value });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.value).toBe('4A 100');
  });

  it('an identity value: only the principal part is written; the picked side’s qualifier is not copied', async () => {
    const f = findingOf(ELLA.name, 'consistency_identity');
    const side = (await valuesOf(f)).find((v) => v.page.id === reg(ELLA))!;
    expect(side.value).toBe('Elf (by adoption)');
    const r = await pick(f, { side: side.key });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const done = await approve(w, String(r.json.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    expect(rowText(core(ELLA), 'Race / Species')).toBe('Elf');
    expect(rowText(reg(ELLA), 'Race / Species')).toBe('Elf (by adoption)');
  });

  it('one page restating it in its sidebar and in a sentence: one item, both edited, each part chained to its own check', async () => {
    const f = findingOf(GWYN.name, 'consistency_birth');
    const side = (await valuesOf(f)).find((v) => v.page.id === core(GWYN))!;
    const r = await pick(f, { side: side.key });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.items).toHaveLength(1);
    const changes = r.json.items[0].diff.changes as Obj[];
    expect(changes.map((c) => c.what)).toEqual(['Temporal Scope', 'the sentence']);
    const done = await approve(w, String(r.json.proposalId));
    expect(done.job?.status, JSON.stringify(done.job?.lastError ?? null)).toBe('succeeded');
    expect(rowText(reg(GWYN), 'Temporal Scope')).toBe('Born 4A 100');
    expect(textOf(reg(GWYN), 'gwynp1')).toBe('Gwyn Nash was born in 4A 100.');
  });

  it('a typed value holding a line break is refused, nothing proposed', async () => {
    const f = findingOf(FINN.name, 'consistency_birth');
    const before = proposals();
    const r = await pick(f, { value: '4A\n100' });
    expect(r.status, JSON.stringify(r.json)).toBe(400);
    expect(r.json.error.code).toBe('VALUE_UNREADABLE');
    expect(proposals()).toBe(before);
  });
});
