/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- parsed JSON tool results */
/**
 * Amendment 1 to ADR 0072 (v3 F7.1a): the owner's bug of 24 November 2026, end to end against the mock LegendKeeper.
 *
 * - `core_compact_wording` on Mehrana al-Khalid's Core replaces only the phrase that means the page itself (its Purpose
 *   opener); the sentence about Taraji's own page is listed, never edited, before and after the owner approves.
 * - Akari's "This compact character reference owns Akari's …" is replaced.
 * - Every `core_text` proposal shows exactly what changes: its summary, its page summary and its operations hold the
 *   sentence before and after (the replaced words marked), and so does the Review card of a direct upgrade.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture } from '../images/world.js';
import { approve, C, IDENTITY_KEYS } from '../packs/world.js';
import { PROJECT, type OwnersWorld } from '../packs/owners-world.js';
import { automationWorld } from '../automation/world.js';
import { SidebarModel } from '../resources/world.js';
import { coreWorld, F } from './world.js';

const M = {
  mehrIndex: 'mehrindx',
  mehr: 'mehrcore',
  taraji: 'tarajicr',
  akariIndex: 'akariidx',
  akari: 'akaricor',
} as const;

const MEHRANA_TARAJI =
  "Taraji resumed lifelong personal service and is still Mehrana's tailor in 5A 931; her identity is owned by the separate compact character reference.";
const AKARI = "This compact character reference owns Akari's individual identity, voice and history.";
const TOMO = "This compact reference owns Tomo's identity.";

const heading = (id: string, level: number, text: string) => ({
  id,
  kind: 'heading',
  level,
  content: [{ text }],
});
const para = (id: string, text: string) => ({ id, kind: 'paragraph', content: [{ text }] });
const textOf = (b: any): string =>
  Array.isArray(b.content) ? b.content.map((r: any) => r.text ?? '').join('') : '';
const mainOfIn = (x: OwnersWorld, id: string) => {
  const main = x.repo.liveDocs(x.repo.res.get(id)!).find((d) => d.name === 'Main')!;
  return x.repo.blocks.get(main.id)!.blocks as any[];
};

/** The F7.1 world with Mehrana al-Khalid's Core (and Taraji's own Compact Reference) and Shibukawa Akari's Core. */
async function wordingWorld(base?: Parameters<typeof coreWorld>[1], portraits = true): Promise<OwnersWorld> {
  const w = await coreWorld(
    {
      seed: (world) => {
        const r = world.repo;
        const body = (id: string, blocks: unknown[]) => {
          const main = r.liveDocs(r.live(id)!).find((d) => d.name === 'Main')!;
          r.blocks.set(main.id, { version: 2, blocks });
        };
        r.seed({ id: M.mehrIndex, name: '[INDEX] Mehrana al-Khalid', parentId: C.humans });
        r.seed({
          id: M.mehr,
          name: '[BSRC] Mehrana al-Khalid - Character Core',
          parentId: M.mehrIndex,
          referenceType: 'Character Core',
          canonical: 'Mehrana al-Khalid',
          scope: 'A sultana',
          tags: ['CANON', 'Character', 'Human'],
        });
        r.seed({
          id: M.taraji,
          name: '[BSRC] Taraji - Character Reference',
          parentId: C.humans,
          referenceType: 'Compact Character Reference',
          canonical: 'Taraji',
          scope: 'A tailor',
          tags: ['CANON', 'Character', 'Human'],
        });
        r.seed({ id: M.akariIndex, name: '[INDEX] Shibukawa Akari', parentId: C.humans });
        r.seed({
          id: M.akari,
          name: '[BSRC] Shibukawa Akari - Character Core',
          parentId: M.akariIndex,
          referenceType: 'Character Core',
          canonical: 'Shibukawa Akari',
          scope: 'A courier',
          tags: ['CANON', 'Character', 'Human'],
        });
        for (const id of [M.mehr, M.taraji, M.akari]) r.outside.setRow(id, 'Race / Species', 'Human');
        body(M.mehr, [
          heading('mh1', 2, 'Purpose'),
          para('mh2', 'Compact Main CANON reference for Mehrana al-Khalid, sultana of Menkhet.'),
          heading('mh3', 2, 'Household'),
          para('mh4', MEHRANA_TARAJI),
          heading('mh5', 2, 'Source Boundaries'),
          para('mh6', 'Identity only.'),
        ]);
        body(M.taraji, [heading('tj1', 2, 'Purpose'), para('tj2', 'The reference for Taraji, a tailor.')]);
        body(M.akari, [
          heading('ak1', 2, 'Purpose'),
          para('ak2', 'The Character Core for Shibukawa Akari.'),
          heading('ak3', 2, 'Source Boundaries'),
          para('ak4', AKARI),
        ]);
        // Tomo Reed (Working, flat under [INDEX] Working): a sentence that means his own page.
        body(F.tomo, [
          heading('tm1', 2, 'Purpose'),
          para('tm2', TOMO),
          heading('tm3', 2, 'Source Boundaries'),
          para('tm4', 'Identity only.'),
        ]);
      },
    },
    base,
    portraits,
  );
  const sidebar = (id: string, v: Record<string, string>) =>
    w.sidebars.page(id, [
      SidebarModel.kv(
        `kv${id}`.slice(0, 8),
        'PROPERTIES',
        IDENTITY_KEYS.map((k) => [k, v[k] ?? '']),
      ),
      SidebarModel.links(`dp${id}`.slice(0, 8), 'Dependencies', []),
      SidebarModel.links(`rl${id}`.slice(0, 8), 'Related Sources', []),
      { id: `tg${id}`.slice(0, 8), kind: 'unsupported' as const, title: 'TAGS' },
    ]);
  const person = (subject: string, given: string, surname: string, rt: string) => ({
    Status: 'Authoritative',
    'Continuity Type': 'CANON',
    Continuity: 'Main',
    Inheritance: 'None',
    Subject: subject,
    'Canonical Display Name': subject,
    'Personal / Given Name': given,
    'Family / Surname': surname,
    'Naming Culture': 'Menkheti',
    'Reference Type': rt,
    Scope: 'A person',
    'Race / Species': 'Human',
    'Life State': 'Alive at 5A 931',
    'Temporal Scope': '5A 900 - 5A 931',
    'Last Major Revision': '2026-11-01',
    Supersedes: 'None',
  });
  sidebar(M.mehr, person('Mehrana al-Khalid', 'Mehrana', 'al-Khalid', 'Character Core'));
  sidebar(M.taraji, person('Taraji', 'Taraji', '', 'Compact Character Reference'));
  sidebar(M.akari, person('Shibukawa Akari', 'Akari', 'Shibukawa', 'Character Core'));
  return w;
}

async function fullSnapshot(x: OwnersWorld): Promise<void> {
  const r = await x.stack.runtime.snapshots.full(PROJECT, 'manual');
  expect(r.summary ?? '', r.summary).not.toMatch(/MISSING/);
  await x.stack.runtime.audits.settled();
}

describe('core_compact_wording: only self-references, and the proposal shows the words', () => {
  let x: OwnersWorld;
  beforeAll(async () => {
    x = await wordingWorld(
      (o) => automationWorld({ ...(o?.seed ? { seed: o.seed } : {}), artCodes: true }),
      false,
    );
    await fullSnapshot(x);
    const run = await x.stack.runtime.audits.run(PROJECT, 'manual');
    expect(run.state, run.summary).toBe('succeeded');
  });
  afterAll(async () => x?.close());
  const open = () =>
    x.stack.runtime.audits.store.list(PROJECT, { code: ['core_compact_wording'], state: 'open', limit: 100 })
      .findings;

  it('Mehrana: only her Purpose opener is the fix’s; the sentence about Taraji’s page is listed', () => {
    const f = open().find((y) => y.pageId === M.mehr)!;
    expect(f, JSON.stringify(open().map((y) => y.pageId))).toBeTruthy();
    const ev = f.evidence as any;
    expect(ev.core.replacements).toEqual([
      {
        blockId: 'mh2',
        before: 'Compact Main CANON reference for Mehrana al-Khalid, sultana of Menkhet.',
        after: 'Main CANON Character Core for Mehrana al-Khalid, sultana of Menkhet.',
      },
    ]);
    expect(ev.left).toContainEqual(expect.objectContaining({ blockId: 'mh4', sentence: MEHRANA_TARAJI }));
    // Taraji is a character the audit knows: the fix carries her name for the same test inside the lock.
    expect((f.fix?.args as any).others).toContain('Taraji');
  });

  it('Akari: “This compact character reference owns Akari’s …” is found and replaced by the fix', () => {
    const f = open().find((y) => y.pageId === M.akari)!;
    expect((f.evidence as any).core.replacements.map((r: any) => r.after)).toEqual([
      "This Character Core owns Akari's individual identity, voice and history.",
    ]);
  });

  it('the fix’s proposal shows the sentence before and after, in its summary, page summary and operations; Taraji’s sentence is never edited', async () => {
    const f = open().find((y) => y.pageId === M.mehr)!;
    const before = mainOfIn(x, M.mehr);
    const r = await x.stack.runtime.audits.proposeFix('owner', PROJECT, f.id);
    expect(r.status).toBe('proposal_captured');
    if (r.status !== 'proposal_captured') return;
    const prop = x.stack.runtime.policy.proposals.get(r.proposalId)!;
    // The summary: the words that change, before and after.
    expect(prop.summary).toContain(
      '“Compact Main CANON reference for Mehrana al-Khalid, sultana of Menkhet.”',
    );
    expect(prop.summary).toContain('“Main CANON Character Core for Mehrana al-Khalid, sultana of Menkhet.”');
    expect(prop.summary).not.toContain('Taraji');
    // The item view's data: the page summary and the operation's text changes (the replaced words marked).
    const detail = x.stack.runtime.policy.proposals.detail(r.proposalId)!;
    expect(JSON.stringify(detail.pageSummary)).toContain(
      '“Compact Main CANON reference” → “Main CANON Character Core”',
    );
    const changes = (detail.operations as any[]).flatMap((o) => o.textChanges ?? []);
    expect(changes).toHaveLength(1);
    const c = changes[0];
    expect(c.before).toBe('Compact Main CANON reference for Mehrana al-Khalid, sultana of Menkhet.');
    expect(c.after).toBe('Main CANON Character Core for Mehrana al-Khalid, sultana of Menkhet.');
    expect(c.before.slice(c.removed.start, c.removed.end)).toBe('Compact Main CANON reference');
    expect(c.after.slice(c.added.start, c.added.end)).toBe('Main CANON Character Core');
    // Nothing written before the owner approves; then only the opener.
    expect(mainOfIn(x, M.mehr)).toEqual(before);
    const d = await approve(x, r.proposalId);
    expect(d.job?.status, JSON.stringify(d.job?.lastError)).toBe('succeeded');
    expect(mainOfIn(x, M.mehr).map(textOf)).toEqual([
      'Purpose',
      'Main CANON Character Core for Mehrana al-Khalid, sultana of Menkhet.',
      'Household',
      MEHRANA_TARAJI,
      'Source Boundaries',
      'Identity only.',
    ]);
  });
});

describe('the upgrade (core_text): the proposal and the Review card show the words', () => {
  let w: OwnersWorld;
  beforeAll(async () => {
    w = await wordingWorld();
  });
  afterAll(async () => w?.close());
  const stage = async (file: string) => {
    const r = await w.call('upload_image', {
      data_base64: fixture(file).toString('base64'),
      name: `stage ${file}`,
      stage: true,
      project: 'test',
    });
    expect(r.isError, r.text).toBe(false);
    return String(r.body.staged_id);
  };
  const portrait = (staged_id: string) => ({
    staged_id,
    label: 'Expression Reference - Smile',
    interpretation: 'His smile.',
  });

  it('an upgrade’s proposal (a propose-scope connection): the summary and the item hold the sentence before and after', async () => {
    const id = await stage('alpha.png');
    // v3 F12 (ADR 0081): at scope write the upgrade is direct; a propose-scope connection's is the proposal.
    const proposer = w.stack.newToken('upgrade-proposer', 'propose');
    const pc = await w.stack.connect(proposer.token);
    const p = await w.stack.call(pc, 'arkona_add_character_art', {
      character: 'Emine al-Noor',
      images: [portrait(id)],
      project: 'test',
    });
    expect(p.body.status, p.text).toBe('proposal_captured');
    const prop = w.stack.runtime.policy.proposals.get(String(p.body.proposalId))!;
    expect(prop.requiresCanonicalApproval).toBe(true);
    expect(prop.summary).toContain('Text: “');
    expect(prop.summary).toContain('Compact Main CANON reference');
    const detail = w.stack.runtime.policy.proposals.detail(prop.id)!;
    const item = detail.itemPlan!.items.find((i) => i.id === `existing:${F.emine}`)!;
    const wording = (item.diff?.changes ?? []).filter((c) => c.what === 'wording');
    expect(wording.map((c) => [c.before, c.after])).toContainEqual([
      'Compact Main CANON reference for Emine al-Noor, a courier of the Noor house.',
      'Main CANON Character Core for Emine al-Noor, a courier of the Noor house.',
    ]);
    // A sentence of a longer run: only that sentence is shown, its phrase marked.
    const owns = wording.find((c) => /owns her identity/.test(c.before ?? ''))!;
    expect(owns.before).toBe('This compact reference owns her identity.');
    expect(owns.before!.slice(owns.removed!.start, owns.removed!.end)).toBe('compact reference');
    expect(owns.after!.slice(owns.added!.start, owns.added!.end)).toBe('Character Core');
    expect((detail.operations as any[]).some((o) => (o.textChanges ?? []).length > 0)).toBe(true);
    w.stack.runtime.policy.commands.reject('owner', prop.id, 'not now');
  });

  it('a direct upgrade (a Working character at scope write): its Review card lists the words it changed', async () => {
    const id = await stage('png-named.jpg');
    const r = await w.call('arkona_add_character_art', {
      character: 'Tomo Reed',
      images: [portrait(id)],
      project: 'test',
    });
    expect(r.body.status, r.text).not.toBe('proposal_captured');
    const jobId = String(r.body.jobId ?? r.body.job?.id);
    for (let i = 0; i < 500; i++) {
      const job = w.stack.runtime.engine.queries.getJob(PROJECT, jobId);
      if (job && ['succeeded', 'failed', 'cancelled'].includes(job.status)) break;
      await new Promise((y) => setTimeout(y, 20));
    }
    expect(w.stack.runtime.engine.queries.getJob(PROJECT, jobId)?.status).toBe('succeeded');
    expect(textOf(mainOfIn(w, F.tomo)[1])).toBe("This Character Core owns Tomo's identity.");
    const item = w.stack.runtime.review.list(PROJECT).find((i) => i.jobId === jobId)!;
    expect(item, 'the job is on the Review page').toBeTruthy();
    expect(item.textChanges?.map((c) => [c.before, c.after])).toEqual([
      [TOMO, "This Character Core owns Tomo's identity."],
    ]);
  });
});
