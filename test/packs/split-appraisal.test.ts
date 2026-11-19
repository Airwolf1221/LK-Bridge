/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- parsed JSON tool results */
/**
 * v3 F3e (ADR 0059): `arkona_split_appraisal` (A6), read-only and free, against the splits' test world (fixtures built from
 * the design's shapes, never fetched): every measurable trigger on its own evidence, the thin character silent (the
 * Anti-Fragmentation control), length alone never a trigger, the thresholds from the pack's data (D4), and the
 * candidates gathered into `arkona_appraise_owner`'s architectural group, so the Appraisal page shows them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_CSRF_PURPOSE } from '../../src/admin/guard.js';
import { packRulesSchema } from '../../src/packs/types.js';
import { PUBLIC_URL } from '../tools/helpers.js';
import { C, P, S, splitWorld, type SplitWorld } from './split-world.js';

let w: SplitWorld;
let zahra: any;

beforeAll(async () => {
  w = await splitWorld();
  await w.snapshot();
  const r = await w.call('arkona_split_appraisal', { page: S.zahra, project: 'test' });
  expect(r.isError, r.text).toBe(false);
  zahra = r.body;
}, 120_000);
afterAll(async () => w?.close());

const checks = (body: any) => (body.findings as any[]).map((f) => f.check as string).sort();

describe('the measurable Split Triggers, each on its evidence', () => {
  it('a monolith: every trigger fires, each with its trigger, evidence, draft map and Anti-Fragmentation note', () => {
    expect(checks(zahra)).toEqual([
      'asset_ownership',
      'distinct_dependencies',
      'distinct_unresolved',
      'retrieval_cost',
      'scope_overload',
      'shared_ownership',
    ]);
    for (const f of zahra.findings) {
      expect(f.group).toBe('architectural');
      expect(f.evidence).toBe('Potential Maintenance Issue');
      expect(f.rule).toMatch(/^Character Architecture › Split Triggers › /);
      expect(f.followUp).toMatchObject({ kind: 'judgement', tool: 'arkona_split_owner' });
      expect(f.details.trigger).toBeTypeOf('string');
      expect(Array.isArray(f.details.draftMap)).toBe(true);
      expect(f.details.antiFragmentation[0]).toMatch(
        /Do not split merely because a character has many facts/,
      );
    }
  });

  it('Scope Overload: the Scope names six domains (threshold 3)', () => {
    const f = zahra.findings.find((x: any) => x.check === 'scope_overload');
    expect(f.details.evidence.threshold).toBe(3);
    expect(f.details.evidence.scopeDomains).toEqual(
      expect.arrayContaining(['Biography', 'Appearance', 'Personality', 'Powers', 'Wardrobe']),
    );
  });

  it('Retrieval Cost: long AND several domains', () => {
    const f = zahra.findings.find((x: any) => x.check === 'retrieval_cost');
    expect(f.details.evidence.words).toBeGreaterThanOrEqual(2000);
    expect(f.details.evidence.threshold).toEqual({ words: 2000, domains: 2 });
  });

  it('Asset Ownership: a page that is not an Art owner interprets five images, two under Wardrobe', () => {
    const f = zahra.findings.find((x: any) => x.check === 'asset_ownership');
    expect(f.details.evidence.images).toBe(5);
    expect(f.details.evidence.sections).toEqual([
      { section: 'Appearance', images: 3 },
      { section: 'Wardrobe', images: 2 },
    ]);
  });

  it('Shared Ownership: the long section about Nadira al-Khalid, with no relationship owner for the pair', () => {
    const f = zahra.findings.find((x: any) => x.check === 'shared_ownership');
    expect(f.details.evidence).toMatchObject({
      section: 'Zahra and Nadira al-Khalid',
      with: { id: C.nadira, name: 'Nadira al-Khalid' },
    });
    expect(f.details.evidence.words).toBeGreaterThanOrEqual(120);
  });

  it('Distinct Unresolved Material: its items cluster under Powers and Wardrobe', () => {
    const f = zahra.findings.find((x: any) => x.check === 'distinct_unresolved');
    expect(Object.keys(f.details.evidence.clusters).sort()).toEqual(['Powers', 'Wardrobe']);
    expect(f.details.evidence.clusters.Powers).toHaveLength(2);
  });

  it('Distinct Dependencies: only Powers relies on Salahad Sorcery', () => {
    const f = zahra.findings.find((x: any) => x.check === 'distinct_dependencies');
    expect(f.details.evidence).toMatchObject({ dependency: { id: S.sorcery }, section: 'Powers' });
  });

  it('the draft destination map: frame sections stay, domains go to new owners, images divide, the pair to a relationship', () => {
    const map = zahra.findings[0].details.draftMap as any[];
    const to = Object.fromEntries(map.map((e) => [e.section, e.to]));
    expect(to).toMatchObject({
      Purpose: 'stays',
      Identity: 'stays',
      Biography: 'new',
      Appearance: 'divide',
      Personality: 'new',
      Wardrobe: 'divide',
      'Zahra and Nadira al-Khalid': 'relationship',
      Powers: 'new',
      'Source Boundaries': 'stays',
      'Unresolved Material': 'divide',
    });
    expect(map.find((e) => e.section === 'Biography').suggestion).toMatchObject({
      role: 'specialist',
      name: 'Zahra al-Rashid - Biography',
      referenceType: 'Character Biography',
    });
    expect(map.find((e) => e.section === 'Powers').note).toMatch(/universal/);
  });

  it('the Anti-Fragmentation note uses the rule’s own examples', () => {
    const notes = zahra.findings[0].details.antiFragmentation as string[];
    expect(notes.join(' ')).toMatch(/Keep together: “Personality”, “Habits” \(personality and habits\)/);
    expect(notes.join(' ')).toMatch(/Small sections/);
  });

  it('the unmeasurable triggers come back as the owner’s questions; nothing was written', () => {
    expect(zahra.questions.map((q: any) => q.trigger)).toEqual([
      'Independent Retrieval',
      'Independent Maintenance',
      'Downstream Dependency',
    ]);
    expect(zahra.readOnly).toMatch(/Nothing was written/);
    expect(zahra.cost).toBe('none');
  });
});

describe('Anti-Fragmentation: what must not trigger', () => {
  it('the thin character triggers nothing', async () => {
    const r = await w.call('arkona_split_appraisal', { page: S.thin, project: 'test' });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.findings).toEqual([]);
  });

  it('length alone never triggers: a long page in one domain', async () => {
    const r = await w.call('arkona_split_appraisal', { page: S.chronicle, project: 'test' });
    expect(r.isError, r.text).toBe(false);
    expect(r.body.inspected.measured).toBe(1);
    expect(checks(r.body)).toEqual([]);
  });

  it('a non-character owner with two separable domains: Retrieval Cost, by the owner domains', async () => {
    const r = await w.call('arkona_split_appraisal', { page: S.statutes, project: 'test' });
    expect(r.isError, r.text).toBe(false);
    expect(checks(r.body)).toEqual(['retrieval_cost']);
    const f = r.body.findings[0];
    expect(Object.values(f.details.evidence.domains).map((d: any) => d.domain)).toEqual(['Law', 'Religion']);
    expect(f.details.draftMap.find((e: any) => e.section === 'Law and Courts').suggestion).toMatchObject({
      tool: 'arkona_create_owner',
      type: 'Law',
    });
  });
});

describe('the thresholds are the pack’s data (D4)', () => {
  it('raising Scope Overload’s threshold in a new, approved pack version silences it', async () => {
    const packs = w.stack.runtime.packs;
    const before = packs.get('arkona')!;
    const rules = packRulesSchema.parse({
      ...before.rules,
      splits: {
        ...before.rules.splits!,
        scopeOverload: { minDomains: 7 },
        retrievalCost: { minWords: 50_000, minDomains: 2 },
      },
    });
    packs.commands.replaceRules('owner', 'arkona', rules, 'test: D4 thresholds tuned');
    await packs.commands.approve('owner', 'arkona');
    try {
      const r = await w.call('arkona_split_appraisal', { page: S.zahra, project: 'test' });
      expect(r.isError, r.text).toBe(false);
      expect(checks(r.body)).not.toContain('scope_overload');
      expect(checks(r.body)).not.toContain('retrieval_cost');
      expect(r.body.inspected.thresholds.scopeOverload).toEqual({ minDomains: 7 });
    } finally {
      packs.commands.replaceRules('owner', 'arkona', before.rules, 'test: back');
      await packs.commands.approve('owner', 'arkona');
    }
  });
});

describe('the Appraisal page shows them: A2’s architectural group', () => {
  it('arkona_appraise_owner gathers the split candidates, each with its trigger and evidence', async () => {
    const r = await w.call('arkona_appraise_owner', { page: S.zahra, detail: 'full', project: 'test' });
    expect(r.isError, r.text).toBe(false);
    const arch = (r.body.findings as any[]).filter((f) => f.group === 'architectural');
    expect(arch.map((f) => f.check).sort()).toEqual(checks(zahra));
    expect(arch[0].details.trigger).toBeTypeOf('string');
    expect(arch[0].details.splitAppraisal).toMatch(/arkona_split_appraisal/);
  });

  it('the dashboard runs the split appraisal on a page', async () => {
    const s = w.stack.services;
    const session = s.owner.createSession('127.0.0.1', 'vitest');
    const res = await fetch(`${w.stack.base}/api/admin/appraisal/run?project=test`, {
      method: 'POST',
      headers: {
        cookie: `${s.owner.sessionCookie}=${session}`,
        origin: PUBLIC_URL,
        'x-csrf-token': s.owner.csrfToken(session, ADMIN_CSRF_PURPOSE),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ confirm: true, project: 'test', tool: 'split', page: S.zahra }),
    });
    const json = (await res.json()) as any;
    expect(res.status, JSON.stringify(json)).toBe(200);
    const report = json.report;
    expect(report.tool).toBe('arkona_split_appraisal');
    expect(report.questions).toHaveLength(3);
    expect(report.findings.length).toBe(6);
  });

  it('a branch: Qishen’s pages, each measured; the monolith’s candidates among them', async () => {
    const r = await w.call('arkona_split_appraisal', { under: C.qishen, limit: 200, project: 'test' });
    expect(r.isError, r.text).toBe(false);
    const pages = new Set((r.body.findings as any[]).map((f) => f.page.id));
    expect(pages.has(S.zahra)).toBe(true);
    expect(pages.has(S.thin)).toBe(false);
    void P;
  });
});
