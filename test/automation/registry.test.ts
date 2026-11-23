/**
 * v3 F5b (ADR 0068, H5): which finding codes can be automated. Only codes whose fix the bridge fully determines carry
 * `automatable: 'mechanical'`; the flag cannot be set on any code the design rules out (canon and lifecycle changes,
 * holds, exceptions, judgements, "Pick the right value", deletions, splits, renames, moves into or out of Narratives,
 * images, unsupported blocks), nor on a code that makes a page.
 */
import { describe, expect, it } from 'vitest';
import {
  AutomationFlagError,
  CATALOGUE,
  defineCode,
  ELIGIBLE,
  NEVER_TRAITS,
  scopeOf,
  type CodeEntry,
} from '../../src/automation/registry.js';
import { CODES } from '../../src/audits/types.js';
import { CHECKS } from '../../src/appraisal/rules.js';

describe('the eligible codes (ADR 0068, for the owner to confirm)', () => {
  it('are exactly the design’s candidates, in the engine’s fixed order', () => {
    expect(ELIGIBLE.map((e) => e.code)).toEqual([
      'out_of_order',
      'lifecycle_tag_not_leading',
      'retag_correction',
      'em_dash_name',
      'em_dash_text',
      'blank_paragraphs',
      'heading_links',
      'asset_extension',
      'related_noncurrent',
      'narrative_number_mismatch',
      'narrative_link_broken',
      'narrative_dateline_mismatch',
      'narrative_tags',
    ]);
  });

  it('each names its plain name, an example, the one transformation and what its read-back compares', () => {
    for (const e of ELIGIBLE) {
      expect(e.name.length, e.code).toBeGreaterThan(3);
      expect(e.example.length, e.code).toBeGreaterThan(10);
      expect(e.transformation.length, e.code).toBeGreaterThan(20);
      expect(e.target, e.code).toBeDefined();
      expect(e.changes, e.code).toBeDefined();
      expect(
        e.traits.some((t) => NEVER_TRAITS.includes(t)),
        e.code,
      ).toBe(false);
      // The scope: the AI REPOSITORY without the Legacy Canon Archive and the Design References (none is about them).
      if (e.target !== 'asset')
        expect(scopeOf(e)).toMatch(/excluding the Legacy Canon Archive and the Design References/);
    }
  });

  it('each is a real finding code whose fix the bridge already makes', () => {
    for (const e of ELIGIBLE) {
      if (e.source === 'audit') {
        const info = (CODES as Record<string, { fix?: string }>)[e.code];
        expect(info, e.code).toBeDefined();
        expect(info!.fix, e.code).toBeDefined();
      } else if (e.source === 'appraisal') {
        const c = (CHECKS as Record<string, { followUp?: string }>)[e.code];
        expect(c, e.code).toBeDefined();
      } else expect(e.code).toBe('retag_correction');
    }
  });
});

describe('the never-eligible codes (the design’s "Never automatic")', () => {
  const never = CATALOGUE.filter((e) => e.automatable !== 'mechanical');

  it('cover every category the design rules out', () => {
    const traits = new Set(never.flatMap((e) => e.traits));
    for (const t of [
      'canon',
      'lifecycle',
      'hold',
      'exception',
      'judgement',
      'pick',
      'delete',
      'split',
      'rename',
      'narrative_move',
      'image',
      'unsupported',
    ] as const)
      expect(traits.has(t), t).toBe(true);
  });

  it('cannot be flagged: defineCode refuses the flag on each of them', () => {
    expect(never.length).toBeGreaterThanOrEqual(12);
    for (const e of never) {
      expect(
        () => defineCode({ ...e, target: 'resource', changes: [], automatable: 'mechanical' }),
        e.code,
      ).toThrow(AutomationFlagError);
    }
  });

  it('nor can any code that carries a never-eligible trait beside a mechanical one', () => {
    const base: CodeEntry = ELIGIBLE[0]!;
    for (const t of NEVER_TRAITS)
      expect(() => defineCode({ ...base, traits: [...base.traits, t] }), t).toThrow(/cannot be flagged/);
  });

  it('a code with no transformation or no read-back cannot be flagged either', () => {
    const base: CodeEntry = ELIGIBLE[0]!;
    expect(() => defineCode({ ...base, traits: [] })).toThrow(/names no transformation/);
    const { target: _t, ...noTarget } = base;
    void _t;
    expect(() => defineCode({ ...noTarget })).toThrow(/no read-back target/);
  });
});
