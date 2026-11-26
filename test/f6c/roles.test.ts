/**
 * v3 F6c (ADR 0080, C2): the nation roles and the unified names, the pure rules: matching in the three live forms,
 * the variants, the owner's mappings, unmatched children, the short name and its fallback, the derived word list F6b's
 * classifier reads, and the roles a two-part name names.
 */
import { describe, expect, it } from 'vitest';
import { ARKONA_PACK } from '../../src/packs/arkona.js';
import {
  canonicalRole,
  categoryParentOf,
  matchNationChild,
  nationSubindexWords,
  roleForCategory,
  rolesNamedBy,
  unifiedName,
} from '../../src/packs/nations/roles.js';

const tax = ARKONA_PACK.rules.indexTaxonomy!;

describe('the pack data', () => {
  it('carries the ten roles in the owner’s order and the seven variants', () => {
    expect(tax.nationRoles).toEqual([
      'Government & Administration',
      'Institutions',
      'Historical Events',
      'Military & Technology',
      'Unique Magic & Technologies',
      'Cultures',
      'Settlements & Locations',
      'Religion & Religious Administration',
      'Household & Court',
      'Historical Polities',
    ]);
    expect(tax.nationRoleVariants).toHaveLength(7);
    expect(categoryParentOf(tax, 'Conflicts')).toBe('Historical Events');
    expect(categoryParentOf(tax, 'Polities')).toBeNull();
  });

  it('F6b’s nation subindex list is derived from the roles and the variants', () => {
    const words = nationSubindexWords(tax);
    expect(words).toEqual(tax.structural.nationSubindexes);
    expect(words).toContain('Military & Technology');
    expect(words).toContain('Government & Institutions');
    expect(words).not.toContain('Laws');
  });
});

describe('matching a nation’s child', () => {
  it('bare, <Nation> <word> and <Nation or short name> - <word>', () => {
    expect(matchNationChild(tax, 'Military & Technology', ['Jabal al-Noor'])).toMatchObject({
      role: 'Military & Technology',
      via: 'role',
      form: 'bare',
    });
    expect(matchNationChild(tax, 'Al-Muqaddas Government & Administration', ['Al-Muqaddas'])).toMatchObject({
      role: 'Government & Administration',
      form: 'nation',
    });
    expect(
      matchNationChild(tax, 'Cantha - Government & Administration', ['Kingdom of Cantha', 'Cantha']),
    ).toMatchObject({ role: 'Government & Administration', form: 'dash' });
  });

  it('ignores case and accents', () => {
    expect(
      matchNationChild(tax, 'devlet-i aliyye-i mehrânîye institutions', ['Devlet-i Aliyye-i Mehraniye'])
        ?.role,
    ).toBe('Institutions');
    expect(matchNationChild(tax, 'SETTLEMENTS & LOCATIONS', [])?.role).toBe('Settlements & Locations');
  });

  it('the approved variants map to their roles', () => {
    expect(matchNationChild(tax, 'Government & Institutions', ['X'])).toMatchObject({
      role: 'Government & Administration',
      via: 'variant',
      word: 'Government & Institutions',
    });
    expect(matchNationChild(tax, 'Settlements & Historic City-States', [])?.role).toBe(
      'Settlements & Locations',
    );
    expect(matchNationChild(tax, 'Founding Polities & Regions', [])?.role).toBe('Historical Polities');
  });

  it('the owner’s mapping of an exact name is read first', () => {
    expect(
      matchNationChild(
        tax,
        'Military & Naval Affairs',
        ['Al-Muqaddas'],
        [{ name: 'Military & Naval Affairs', role: 'military & technology' }],
      ),
    ).toMatchObject({ role: 'Military & Technology', via: 'mapping', form: 'exact' });
  });

  it('the live unmatched names stay unmatched: never guessed', () => {
    for (const [name, nation] of [
      ['Military & Naval Affairs', 'Al-Muqaddas'],
      ['Military & Logistics', 'Devlet-i Aliyye-i Mehraniye'],
      ['Khorshahri Military and Sacred Arsenal', 'Khorshahr'],
      ['Khorshahr-Arshama History', 'Khorshahr-Arshama'],
      ['Palace Education', 'X'],
    ] as const)
      expect(matchNationChild(tax, name, [nation]), name).toBeNull();
  });

  it('another nation’s name does not count as this one’s', () => {
    expect(matchNationChild(tax, 'Cantha Institutions', ['Al-Muqaddas'])).toBeNull();
  });
});

describe('the unified name', () => {
  it('<Nation> <Role>, the short name first, else the display name', () => {
    expect(
      unifiedName({ displayName: 'Kingdom of Cantha', shortName: 'Cantha' }, 'Settlements & Locations'),
    ).toBe('Cantha Settlements & Locations');
    expect(unifiedName({ displayName: 'Jabal al-Noor', shortName: null }, 'Military & Technology')).toBe(
      'Jabal al-Noor Military & Technology',
    );
    expect(unifiedName({ displayName: 'Devlet-i Aliyye-i Mehraniye', shortName: '  ' }, 'Institutions')).toBe(
      'Devlet-i Aliyye-i Mehraniye Institutions',
    );
  });

  it('a two-part name names two roles; a one-role variant does not', () => {
    expect(rolesNamedBy(tax, 'Government & Institutions')).toEqual([
      'Government & Administration',
      'Institutions',
    ]);
    expect(rolesNamedBy(tax, 'Settlements & Infrastructure')).toEqual(['Settlements & Locations']);
  });

  it('a home rule’s nation-level category to its role (or none)', () => {
    expect(roleForCategory(tax, 'Institutions')).toBe('Institutions');
    expect(roleForCategory(tax, 'Government & Administration')).toBe('Government & Administration');
    expect(roleForCategory(tax, 'Laws')).toBeNull();
    expect(canonicalRole(tax, 'household & court')).toBe('Household & Court');
    expect(canonicalRole(tax, 'Navy')).toBeNull();
  });
});
