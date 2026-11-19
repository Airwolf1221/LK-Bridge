/**
 * R3-RETAG (pass 3): the pure retag engine (src/packs/retag/engine.ts) against the claims "status and lifecycle
 * tags are never added or removed by a retag, only moved first", "no unknown token is ever proposed" and "typed
 * race and culture are kept distinct". Each test asserts the SAFE behaviour: it passes when the attempt HELD, and
 * fails on a bypass.
 *
 * The yardstick for "a status tag added or removed" is the lifecycle guard's own (src/lifecycle/guard.ts
 * `statusTagChanges`): the C2d rule compares the status tags through the facts' fold (NFKC, default-ignorables,
 * case, Cyrillic/Greek/Cherokee/small-capital look-alikes) AND by exact spelling, so a correction whose proposed
 * array it would judge as adding or removing a status tag is a correction that changes a status tag.
 */
import { describe, expect, it } from 'vitest';
import { statusTagChanges } from '../../../src/lifecycle/guard.js';
import { lifecycleFrom } from '../../../src/lifecycle/settings.js';
import { retagPage, vocabularyOf, type RetagVerdict } from '../../../src/packs/retag/engine.js';
import { textKey } from '../../../src/packs/engine/text.js';
import { CTX, RULES, core, page, polity, rulesWith } from './helpers.js';

const LIFECYCLE = lifecycleFrom(undefined);

/** The status-tag changes the guard would see if this verdict were applied (only a correction is ever applied). */
const statusChanges = (v: RetagVerdict) =>
  v.disposition === 'correction' ? statusTagChanges(LIFECYCLE, v.current, v.proposed, 'AU') : [];

const shown = (v: RetagVerdict) => ({
  disposition: v.disposition,
  current: v.current,
  proposed: v.proposed,
  removals: v.removals,
  statusChanges: statusChanges(v),
});

describe('status and lifecycle tags: never added or removed, only moved first', () => {
  it('RT-01: a case-variant duplicate of CANON (CANON + canon / Canon) is never removed by a correction', () => {
    const out = [
      ['CANON', 'canon', 'Polity'],
      ['Polity', 'CANON', 'Canon'],
    ].map((tags) => shown(retagPage(polity(tags), CTX)));
    for (const o of out) expect(o.statusChanges, JSON.stringify(o)).toEqual([]);
  });

  it('RT-02: a fullwidth duplicate of CANON (CANON + ＣＡＮＯＮ) is never removed by a correction', () => {
    const o = shown(retagPage(polity(['CANON', 'ＣＡＮＯＮ', 'Polity']), CTX));
    expect(o.statusChanges, JSON.stringify(o)).toEqual([]);
  });

  it('RT-03: a space-padded duplicate of AU on an AU page (AU + " AU") is never removed', () => {
    const o = shown(
      retagPage(
        polity(['Polity', 'AU', ' AU'], {
          facts: { 'Continuity Type': 'AU', Continuity: 'Shattered Crown' },
        }),
        CTX,
      ),
    );
    expect(o.statusChanges, JSON.stringify(o)).toEqual([]);
  });

  it('RT-04: look-alikes beside CANON (Cyrillic, Greek, ZWSP, soft hyphen, Cherokee, small caps) are kept', () => {
    const lookalikes = [
      'СANON', // Cyrillic С
      'CΑNON', // Greek Α
      'CA​NON', // zero-width space
      'CA­NON', // soft hyphen
      'ᏟᎪNON', // Cherokee
      'ᴄᴀɴᴏɴ', // Latin small capitals
      'ＣＡＮＯＮ‍', // fullwidth with a zero-width joiner
    ];
    const bad: unknown[] = [];
    for (const l of lookalikes)
      for (const tags of [
        ['CANON', 'Polity', l],
        [l, 'Polity', 'CANON'],
      ]) {
        const v = retagPage(polity(tags), CTX);
        if (statusChanges(v).length > 0) bad.push(shown(v));
      }
    expect(bad).toEqual([]);
  });

  it('RT-05: a look-alike in place of the status tag is a hold; CANON is never added', () => {
    for (const l of ['СANON', 'ＣＡＮＯＮ', 'CA​NON', 'ᴄᴀɴᴏɴ']) {
      const v = retagPage(polity(['Polity', l]), CTX);
      expect(v.disposition, l).toBe('hold');
      expect(
        v.proposed.some((t) => t === 'CANON'),
        l,
      ).toBe(false);
    }
  });

  it('RT-06: a page that is AU and CANON (either Continuity Type, either order) is a hold', () => {
    const au = { 'Continuity Type': 'AU', Continuity: 'Shattered Crown' };
    for (const [tags, f] of [
      [['AU', 'CANON', 'Polity'], au],
      [['Polity', 'CANON', 'AU'], au],
      [['CANON', 'AU', 'Polity'], {}],
      [['Polity', 'au', 'CANON'], {}],
    ] as const) {
      const v = retagPage(polity([...tags], { facts: f }), CTX);
      expect(v.disposition, JSON.stringify(tags)).toBe('hold');
      expect(v.holds.some((h) => h.kind === 'status')).toBe(true);
    }
  });

  it('RT-07: a page carrying two lifecycle/status tags (CANON + Working, CANON + Archived) is a hold', () => {
    for (const tags of [
      ['Polity', 'Working', 'CANON'],
      ['CANON', 'Polity', 'archived'],
    ]) {
      const v = retagPage(polity(tags), CTX);
      expect(v.disposition, JSON.stringify(tags)).toBe('hold');
      expect(v.proposed.slice().sort()).toEqual(tags.slice().sort());
    }
  });

  it('RT-08: the status tag keeps its own spelling when moved first (au, Canon)', () => {
    const au = retagPage(
      polity(['Polity', 'au'], { facts: { 'Continuity Type': 'AU', Continuity: 'Shattered Crown' } }),
      CTX,
    );
    expect(au.proposed).toEqual(['au', 'Polity']);
    expect(statusChanges(au)).toEqual([]);
    const canon = retagPage(polity(['Polity', 'Canon']), CTX);
    expect(canon.proposed).toEqual(['Canon', 'Polity']);
    expect(statusChanges(canon)).toEqual([]);
  });

  it('RT-09: pack data naming a lifecycle tag as an Excluded Routine Tag never removes a look-alike of it', () => {
    // The owner's token-map editor takes any routine tag (src/packs/service.ts setTokens: no status-tag check).
    const ctx = { ...CTX, rules: rulesWith({ routine: ['Archived', 'Working'] }) };
    const out = [
      ['CANON', 'Polity', 'Ａｒｃｈｉｖｅｄ'], // fullwidth: NFKC folds it to "archived" (textKey), sameTag does not
      ['CANON', 'Polity', 'Ｗｏｒｋｉｎｇ'],
    ].map((tags) => shown(retagPage(polity(tags), ctx)));
    for (const o of out) expect(o.statusChanges, JSON.stringify(o)).toEqual([]);
  });

  it('RT-10: an Excluded Routine Tag naming CANON or Archived exactly never removes the genuine tag (a hold)', () => {
    const ctx = { ...CTX, rules: rulesWith({ routine: ['CANON', 'Archived'] }) };
    const reorder = retagPage(polity(['Polity', 'CANON']), ctx);
    expect(reorder.proposed).toEqual(['CANON', 'Polity']);
    expect(statusChanges(reorder)).toEqual([]);
    const archived = retagPage(polity(['CANON', 'Polity', 'Archived']), ctx);
    expect(archived.disposition).toBe('hold');
    expect(archived.proposed).toContain('Archived');
  });

  it('RT-11: a race token map naming a status-tag look-alike never adds it to a page', () => {
    // setTokens checks a token only against `never` (Unknown, Unestablished, None), not against the status tags.
    const bad: unknown[] = [];
    for (const token of ['Ｗｏｒｋｉｎｇ', 'СANON', 'ᴀᴜ', 'Arch­ived']) {
      const ctx = { ...CTX, rules: rulesWith({ race: { Ghostkin: token }, culture: { Hollow: 'Hollow' } }) };
      const v = retagPage(core(['CANON', 'Character', 'Hollow'], 'Ghostkin', 'Hollow'), ctx);
      if (statusChanges(v).length > 0) bad.push(shown(v));
    }
    expect(bad).toEqual([]);
  });

  it('RT-12: a race token map naming a status tag exactly: nothing added, and the rationale does not claim it', () => {
    const ctx = {
      ...CTX,
      rules: rulesWith({ race: { Ghostkin: 'Archived' }, culture: { Hollow: 'Hollow' } }),
    };
    const v = retagPage(core(['CANON', 'Character', 'Hollow'], 'Ghostkin', 'Hollow'), ctx);
    expect(v.proposed).not.toContain('Archived');
    expect(statusChanges(v)).toEqual([]);
    // Clarity: the race slot either shows a tag the array holds, or is held (never a phantom "Archived" race token).
    const race = v.slots.find((s) => s.slot === 'race');
    expect(
      race === undefined || race.held !== undefined || (race.tag !== null && v.proposed.includes(race.tag)),
      JSON.stringify({ race, proposed: v.proposed, disposition: v.disposition }),
    ).toBe(true);
  });

  it('RT-13: Working and Archived pages never get a correction (a stray CANON is never removed)', () => {
    for (const p of [
      page({ rawName: '[BWRK] Draft', kind: 'bwrk', tags: ['Polity', 'CANON', 'Working'] }),
      page({ rawName: '[BARC] Old', kind: 'barc', tags: ['Polity', 'Archived', 'CANON'] }),
      page({ rawName: 'Plain', kind: 'plain', lifecycle: 'Working', tags: ['Polity', 'Working'] }),
    ]) {
      const v = retagPage(p, CTX);
      expect(v.disposition, p.rawName).toBeNull();
      expect(v.proposed).toEqual(p.tags);
    }
  });
});

describe('no unknown token; typed race and culture', () => {
  it('RT-14: a value that is both a race and a culture with different tokens: both proposed, each typed', () => {
    const ctx = { ...CTX, rules: rulesWith({ race: { Velar: 'Velar' }, culture: { Velar: 'Velaran' } }) };
    const v = retagPage(core(['CANON', 'Character'], 'Velar', 'Velar'), ctx);
    expect(v.disposition).toBe('correction');
    expect(v.proposed).toEqual(['CANON', 'Character', 'Velar', 'Velaran']);
    expect(v.slots.find((s) => s.slot === 'race')!.tag).toBe('Velar');
    expect(v.slots.find((s) => s.slot === 'culture')!.tag).toBe('Velaran');
  });

  it('RT-15: a culture value given as the race (only in the culture map) is a hold: the race map never borrows', () => {
    const v = retagPage(core(['CANON', 'Character', 'Fujimatsuan'], 'Fujimatsuan', 'Fujimatsuan'), CTX);
    expect(v.disposition).toBe('hold');
    expect(v.holds.some((h) => h.kind === 'identity' && h.slot === 'race')).toBe(true);
    // And a race token is never proposed in the culture slot (a race value as the Naming Culture): a hold.
    const r = retagPage(core(['CANON', 'Character'], 'Human', 'Foxian'), CTX);
    expect(r.disposition).toBe('hold');
    expect(r.holds.some((h) => h.kind === 'identity' && h.slot === 'culture')).toBe(true);
    expect(r.proposed).not.toContain('Foxian');
  });

  it('RT-16: an identity value spelt with a Cyrillic look-alike gets no token (a hold), never a new one', () => {
    const v = retagPage(core(['CANON', 'Character'], 'Fоxian', 'Fujimatsuan'), CTX); // Cyrillic о
    expect(v.disposition).toBe('hold');
    expect(v.proposed).toEqual(['CANON', 'Character', 'Fujimatsuan']);
  });

  it('RT-17: an exceptional kind (race only) given as a Naming Culture is a hold', () => {
    const v = retagPage(core(['CANON', 'Character', 'Kami'], 'Kami', 'Kami'), CTX);
    expect(v.disposition).toBe('hold');
    expect(v.holds.some((h) => h.slot === 'culture')).toBe(true);
  });

  it('RT-18: a classification or a pack record naming an unknown specialist never puts it in the array', () => {
    const owner = retagPage(
      page({
        tags: ['CANON', 'Culture'],
        owner: { primary: 'Culture', specialist: 'Puppetry', detail: 'tampered row' },
      }),
      CTX,
    );
    expect(owner.proposed).not.toContain('Puppetry');
    const record = retagPage(
      page({
        tags: ['CANON', 'Culture'],
        packRecord: { primary: 'Culture', specialist: 'Puppetry', detail: 'tampered record' },
      }),
      CTX,
    );
    expect(record.proposed).not.toContain('Puppetry');
  });

  it('RT-24: an Excluded Routine Tag is never added, and one that is also a grammar token is never removed', () => {
    const ctx = { ...CTX, rules: rulesWith({ routine: ['Imported', 'Foxian', 'Polity'] }) };
    const plain = retagPage(polity(['Polity', 'CANON']), ctx);
    expect(plain.proposed).toEqual(['CANON', 'Polity']);
    const c = retagPage(core(['CANON', 'Character', 'Foxian', 'Imported'], 'Foxian', 'Fujimatsuan'), ctx);
    expect(c.proposed).toEqual(['CANON', 'Character', 'Foxian', 'Fujimatsuan']);
    expect(c.proposed).not.toContain('Imported');
  });

  it('RT-19: fuzz: every proposed tag is already on the page or an approved token of the closed grammar', () => {
    const v = vocabularyOf(RULES);
    const approved = new Set<string>([
      ...[...v.primaries.values()].map((p) => textKey(p.tag)),
      ...v.allSpecialists,
      ...v.identityTokens,
    ]);
    const pool = [
      'CANON',
      'canon',
      'AU',
      'Working',
      'Polity',
      'Character',
      'Culture',
      'Language',
      'Foxian',
      'Lore',
      'Imported',
      'Government',
      'Biography',
      'ＣＡＮＯＮ',
      'СANON',
      'Therian',
      'Human',
    ];
    const races = ['Foxian', 'Therian', 'Starborn', 'Unestablished', 'Kami', 'Fujimatsuan', ''];
    const cultures = ['Fujimatsuan', 'Therian', 'Foxian', 'None', 'Velaran', ''];
    const rts = [
      'Character Core',
      'Polity Reference',
      'General Source',
      'Character Biography',
      'Compact Character Reference',
    ];
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const unknown: unknown[] = [];
    for (let i = 0; i < 3000; i++) {
      const tags = Array.from({ length: 1 + rnd(5) }, () => pool[rnd(pool.length)]!);
      const p = page({
        tags,
        facts: {
          'Reference Type': rts[rnd(rts.length)]!,
          'Race / Species': races[rnd(races.length)]!,
          'Naming Culture': cultures[rnd(cultures.length)]!,
          ...(rnd(4) === 0 ? { 'Continuity Type': 'AU', Continuity: 'X' } : {}),
        },
      });
      const verdict = retagPage(p, CTX);
      for (const t of verdict.proposed)
        if (!tags.includes(t) && !approved.has(textKey(t)))
          unknown.push({ tags, proposed: verdict.proposed, t });
    }
    expect(unknown.slice(0, 5)).toEqual([]);
  });
});
