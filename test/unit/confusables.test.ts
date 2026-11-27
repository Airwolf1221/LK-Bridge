/**
 * v3 F12 follow-up (ADR 0081 amendment 1, decision 2): look-alikes by Unicode's confusables data (UTS #39), not a hand
 * list. The generated table matches the vendored source exactly; the skeleton folds the letters Unicode lists as
 * confusable; an allowed value itself (any case) is never a look-alike of itself.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONFUSABLES_OUT, CONFUSABLES_SOURCE, generateConfusables } from '../../scripts/gen-confusables.js';
import { CONFUSABLES_VERSION } from '../../src/text/confusables.generated.js';
import { lookalikeOf, skeleton } from '../../src/text/confusables.js';

const STATUS = ['Authoritative', 'Working', 'Archived'];

describe('the confusables table', () => {
  it('is generated from the vendored Unicode file, unchanged', () => {
    expect(readFileSync(CONFUSABLES_OUT, 'utf8')).toBe(
      generateConfusables(readFileSync(CONFUSABLES_SOURCE, 'utf8')),
    );
    expect(CONFUSABLES_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('folds what Unicode lists: Cyrillic, Greek, Cherokee', () => {
    expect(skeleton('а')).toBe(skeleton('a')); // Cyrillic а
    expect(skeleton('Α')).toBe(skeleton('A')); // Greek Α
    expect(skeleton('Ꭺ')).toBe(skeleton('A')); // Cherokee Ꭺ
    expect(skeleton('rn')).toBe(skeleton('m')); // UTS #39: "rn" and "m"
  });
});

describe('lookalikeOf', () => {
  it('names the allowed value a disguised spelling looks like', () => {
    expect(lookalikeOf('Authoritаtive', STATUS)).toBe('Authoritative'); // Cyrillic а
    expect(lookalikeOf('Αuthoritative', STATUS)).toBe('Authoritative'); // Greek Α
    expect(lookalikeOf('Wоrking', STATUS)).toBe('Working'); // Cyrillic о
    expect(lookalikeOf('Arch​ived', STATUS)).toBe('Archived'); // a zero-width space
    expect(lookalikeOf('Ꭺrchived', STATUS)).toBe('Archived'); // Cherokee Ꭺ
  });

  it('never calls the value itself a look-alike, in any case; an unrelated value is no look-alike', () => {
    for (const v of STATUS) {
      expect(lookalikeOf(v, STATUS)).toBeNull();
      expect(lookalikeOf(v.toUpperCase(), STATUS)).toBeNull();
      expect(lookalikeOf(` ${v.toLowerCase()} `, STATUS)).toBeNull();
    }
    expect(lookalikeOf('Draft', STATUS)).toBeNull();
    expect(lookalikeOf('Authority', STATUS)).toBeNull();
  });
});
