/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect matchers */
/**
 * v3 F3f (ADR 0060): the retag engine, pure, on the Arkona seed's rules (never fetched): each disposition, each rationale
 * slot, typed race and culture (the Standard's Otheiralth example), the uncertain category as a hold, the exclusions,
 * and that no unknown token is ever generated.
 */
import { describe, expect, it } from 'vitest';
import { ARKONA_PACK } from '../../src/packs/arkona.js';
import {
  policyOf,
  retagPage,
  vocabularyOf,
  type RetagContext,
  type RetagPageInput,
} from '../../src/packs/retag/engine.js';
import type { PackRules } from '../../src/packs/types.js';

const RULES: PackRules = ARKONA_PACK.rules;

export const CTX: RetagContext = {
  rules: RULES,
  lifecycle: {
    status: { authoritative: 'Authoritative', working: 'Working', archived: 'Archived' },
    tags: { canon: 'CANON', working: 'Working', archived: 'Archived' },
    fields: { status: 'Status', continuityType: 'Continuity Type' },
  },
  tagRules: { position: 'lead', au: { continuityType: 'AU', tag: 'AU' }, source: null },
  referenceTypeRow: 'Reference Type',
  governanceIds: new Set(['govpage1']),
};

const facts = (f: Record<string, string | string[]>) =>
  new Map(
    Object.entries(f).map(([k, v]) => [
      k.toLowerCase(),
      { text: Array.isArray(v) ? v[0]! : v, count: Array.isArray(v) ? v.length : 1 },
    ]),
  );

const CANON_FACTS = {
  Status: 'Authoritative',
  'Continuity Type': 'CANON',
  Continuity: 'Main',
  Inheritance: 'None',
};

type PageSpec = Partial<Omit<RetagPageInput, 'facts'>> & { facts?: Record<string, string | string[]> };

export function page(o: PageSpec): RetagPageInput {
  return {
    id: o.id ?? 'page0001',
    rawName: o.rawName ?? '[BSRC] Test - Polity Reference',
    kind: o.kind ?? 'bsrc',
    tags: o.tags ?? [],
    facts: facts({ ...CANON_FACTS, ...(o.facts ?? {}) }),
    lifecycle: o.lifecycle ?? null,
    ancestors: o.ancestors ?? ['AI REPOSITORY'],
    area: o.area ?? null,
    templateId: o.templateId ?? null,
    packRecord: o.packRecord ?? null,
    owner: o.owner ?? null,
  };
}

const polity = (tags: string[], more: PageSpec = {}) =>
  page({ tags, facts: { 'Reference Type': 'Polity Reference', ...(more.facts ?? {}) }, ...more });
const core = (tags: string[], race: string | string[], culture: string | string[]) =>
  page({
    rawName: '[BSRC] Otheiralth - Character Core',
    tags,
    facts: { 'Reference Type': 'Character Core', 'Race / Species': race, 'Naming Culture': culture },
  });

describe('dispositions', () => {
  it('correct tags: compliant, each slot with its rationale', () => {
    const v = retagPage(polity(['CANON', 'Polity']), CTX);
    expect(v.disposition).toBe('compliant');
    expect(v.proposed).toEqual(['CANON', 'Polity']);
    expect(v.slots.map((s) => [s.slot, s.tag])).toEqual([
      ['status', 'CANON'],
      ['primary', 'Polity'],
      ['specialist', null],
    ]);
    expect(v.slots[0]!.source).toMatch(/Status Authoritative, Continuity Type CANON, Continuity Main/);
    expect(v.slots[1]!.source).toMatch(/its current tags \(exactly one primary category; Polity Reference/);
  });

  it('a wrong order: a deterministic correction (the status tag moved first, nothing added or removed)', () => {
    const v = retagPage(polity(['Polity', 'CANON']), CTX);
    expect(v.disposition).toBe('correction');
    expect(v.proposed).toEqual(['CANON', 'Polity']);
    expect(v.removals).toEqual([]);
  });

  it('a missing identity token: a correction that adds the culture token from Naming Culture', () => {
    const v = retagPage(core(['CANON', 'Character', 'Foxian'], 'Foxian', 'Fujimatsuan'), CTX);
    expect(v.disposition).toBe('correction');
    expect(v.proposed).toEqual(['CANON', 'Character', 'Foxian', 'Fujimatsuan']);
    expect(v.slots.find((s) => s.slot === 'race')!.source).toMatch(
      /Race \/ Species “Foxian” through the race token map/,
    );
    expect(v.slots.find((s) => s.slot === 'culture')!.source).toMatch(
      /Naming Culture “Fujimatsuan” through the culture/,
    );
  });

  it('an incidental extra tag is an owner exception, kept; an Excluded Routine Tag is removed deterministically', () => {
    const ex = retagPage(polity(['CANON', 'Polity', 'Lore']), CTX);
    expect(ex.disposition).toBe('exception');
    expect(ex.proposed).toEqual(['CANON', 'Polity', 'Lore']);
    expect(ex.exceptions).toEqual([expect.objectContaining({ tag: 'Lore' })]);
    const rules = { ...RULES, retag: { ...RULES.retag!, excludedRoutineTags: ['Imported'] } };
    const rt = retagPage(polity(['CANON', 'Polity', 'Imported']), { ...CTX, rules });
    expect(rt.disposition).toBe('correction');
    expect(rt.proposed).toEqual(['CANON', 'Polity']);
    expect(rt.removals).toEqual([{ tag: 'Imported', why: expect.stringMatching(/Excluded Routine Tags/) }]);
  });

  it('an uncertain category (no pack record, two primary categories) is a hold, the array unchanged', () => {
    const v = retagPage(page({ tags: ['CANON', 'Culture', 'Polity'] }), CTX);
    expect(v.disposition).toBe('hold');
    expect(v.holds[0]).toMatchObject({ kind: 'uncertain_category' });
    expect(v.holds[0]!.reason).toMatch(/^uncertain category; owner classification needed/);
    expect(v.proposed).toEqual(['CANON', 'Culture', 'Polity']);
    // No primary tag at all: the same hold. A name is never evidence.
    const none = retagPage(page({ rawName: '[BSRC] Salt Polity - Polity Reference', tags: ['CANON'] }), CTX);
    expect(none.disposition).toBe('hold');
    expect(none.holds[0]!.kind).toBe('uncertain_category');
  });

  it('a Reference Type that contradicts the tags’ category is a hold', () => {
    const v = retagPage(
      page({ tags: ['CANON', 'Polity'], facts: { 'Reference Type': 'Character Core' } }),
      CTX,
    );
    expect(v.disposition).toBe('hold');
    expect(v.holds[0]!.reason).toMatch(/Character Core.*belongs to Character/);
  });

  it('the owner’s classification resolves the hold and is used by the next verdict', () => {
    const v = retagPage(
      page({
        tags: ['CANON', 'Culture', 'Polity'],
        owner: { primary: 'Culture', specialist: 'Language', detail: 'owner, 19 November 2026' },
      }),
      CTX,
    );
    expect(v.disposition).toBe('correction');
    expect(v.proposed).toEqual(['CANON', 'Culture', 'Language']);
    expect(v.slots.find((s) => s.slot === 'primary')!.source).toMatch(/the owner’s classification/);
  });

  it('the pack record backs the category and the specialist', () => {
    const v = retagPage(
      page({
        tags: ['CANON', 'Character'],
        facts: { 'Reference Type': 'Character Biography' },
        packRecord: {
          primary: 'Character',
          specialist: 'Biography',
          detail: 'arkona_create_character, role specialist',
        },
      }),
      CTX,
    );
    expect(v.disposition).toBe('correction');
    expect(v.proposed).toEqual(['CANON', 'Character', 'Biography']);
    // Without the record the specialist cannot be inferred from the Reference Type: a hold.
    const bare = retagPage(
      page({ tags: ['CANON', 'Character'], facts: { 'Reference Type': 'Character Biography' } }),
      CTX,
    );
    expect(bare.disposition).toBe('hold');
    expect(bare.holds[0]!.kind).toBe('specialist');
  });
});

describe('status and AU', () => {
  it('an AU owner carries AU in place of CANON, moved first', () => {
    const v = retagPage(
      polity(['Polity', 'AU'], { facts: { 'Continuity Type': 'AU', Continuity: 'Shattered Crown' } }),
      CTX,
    );
    expect(v.disposition).toBe('correction');
    expect(v.proposed).toEqual(['AU', 'Polity']);
    expect(v.slots[0]!.source).toMatch(/AU ruling/);
  });

  it('a missing or wrong status tag is never added or removed: a hold', () => {
    const missing = retagPage(polity(['Polity']), CTX);
    expect(missing.disposition).toBe('hold');
    expect(missing.proposed).toEqual(['Polity']);
    const wrong = retagPage(
      polity(['CANON', 'Polity'], { facts: { 'Continuity Type': 'AU', Continuity: 'X' } }),
      CTX,
    );
    expect(wrong.disposition).toBe('hold');
    expect(wrong.proposed).toEqual(['CANON', 'Polity']);
  });
});

describe('identity tokens', () => {
  it('typed race and culture are distinct and de-duplicated (the Otheiralth case)', () => {
    const v = retagPage(core(['CANON', 'Character', 'Therian'], 'Therian', 'Therian'), CTX);
    expect(v.disposition).toBe('compliant');
    expect(v.proposed).toEqual(['CANON', 'Character', 'Therian']);
    const race = v.slots.find((s) => s.slot === 'race')!;
    const culture = v.slots.find((s) => s.slot === 'culture')!;
    expect(race).toMatchObject({ tag: 'Therian' });
    expect(culture).toMatchObject({ tag: 'Therian' });
    expect(culture.source).toMatch(/the same token as the race, kept once/);
  });

  it('a culture never borrows the race map: a race token as a Naming Culture with no culture entry is a hold', () => {
    const v = retagPage(core(['CANON', 'Character', 'Foxian'], 'Foxian', 'Foxian'), CTX);
    expect(v.disposition).toBe('hold');
    expect(v.holds).toEqual([expect.objectContaining({ kind: 'identity', slot: 'culture' })]);
    expect(v.proposed).toEqual(['CANON', 'Character', 'Foxian']);
  });

  it('an “Unestablished” Naming Culture: the slot omitted, with a hold', () => {
    const v = retagPage(core(['CANON', 'Character', 'Human'], 'Human', 'Unestablished'), CTX);
    expect(v.disposition).toBe('hold');
    expect(v.holds[0]!.reason).toMatch(/Naming Culture “Unestablished”.*never a tag/);
    expect(v.slots.find((s) => s.slot === 'culture')).toMatchObject({ tag: null });
  });

  it('missing, unmapped and contradictory values are holds; no unknown token is ever generated', () => {
    const vocab = vocabularyOf(RULES);
    const known = new Set([...vocab.identityTokens, 'canon', 'character', 'au']);
    for (const [race, culture] of [
      ['Starborn', 'Velaran'],
      ['Human', ''],
      [['Human', 'High Human'], 'Velaran'],
      ['Unknown', 'None'],
    ] as const) {
      const v = retagPage(core(['CANON', 'Character'], race as string | string[], culture), CTX);
      expect(v.disposition).toBe('hold');
      for (const t of v.proposed) expect(known.has(t.toLowerCase()), t).toBe(true);
    }
  });
});

describe('scope', () => {
  it('Working and Archived pages: the lifecycle grammar only (lifecycle tag not leading)', () => {
    const w = retagPage(page({ rawName: '[BWRK] Draft', kind: 'bwrk', tags: ['Polity', 'Working'] }), CTX);
    expect(w.scope).toBe('lifecycle');
    expect(w.disposition).toBeNull();
    expect(w.lifecycleCheck).toMatchObject({
      ok: false,
      notFirst: true,
      finding: 'lifecycle_tag_not_leading',
    });
    const a = retagPage(page({ rawName: '[BARC] Old', kind: 'barc', tags: ['Archived', 'Magic'] }), CTX);
    expect(a.lifecycleCheck).toMatchObject({ ok: true, finding: null });
  });

  it('Legacy, Design References, indexes, governance and other continuities are excluded', () => {
    expect(
      retagPage(polity(['Polity'], { ancestors: ['AI REPOSITORY', 'Legacy Canon Archive'] }), CTX).excluded,
    ).toMatchObject({
      code: 'area',
    });
    expect(retagPage(polity(['Polity'], { area: 'design' }), CTX).excluded).toMatchObject({ code: 'area' });
    expect(retagPage(page({ kind: 'index', rawName: '[INDEX] Salahad' }), CTX).excluded).toMatchObject({
      code: 'index',
    });
    expect(retagPage(polity(['Polity'], { id: 'govpage1' }), CTX).excluded).toMatchObject({
      code: 'governance',
    });
    expect(
      retagPage(polity(['Polity'], { facts: { Continuity: 'Second Dawn' } }), CTX).excluded,
    ).toMatchObject({
      code: 'continuity',
    });
  });
});

describe('the policy', () => {
  it('the digest changes with the rules or a governance version', () => {
    const pack = { id: 'arkona', governance: ARKONA_PACK.governance };
    const a = policyOf(pack, RULES, { version: 3, sources: [{ key: 'tagging-standard', version: 'v1' }] });
    const b = policyOf(pack, RULES, { version: 3, sources: [{ key: 'tagging-standard', version: 'v2' }] });
    const c = policyOf(
      pack,
      { ...RULES, tags: { ...RULES.tags, race: {} } },
      {
        version: 3,
        sources: [{ key: 'tagging-standard', version: 'v1' }],
      },
    );
    expect(a.label).toBe('v1.8');
    expect(new Set([a.digest, b.digest, c.digest]).size).toBe(3);
  });
});
