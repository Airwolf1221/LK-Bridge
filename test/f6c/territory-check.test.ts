/**
 * v3 F6c follow-up (ADR 0080): `territory_category_missing` reads ONLY the governance's REQUIRED categories (the pack's
 * `requiredTerritoryCategories`: Cultures; Historical Events with Conflicts inside; Institutions; Polities; Regions;
 * Settlements & Locations; Unique Magic & Technologies). Religions is recognised (seeding binds it where it exists) but
 * never required. A hand-made snapshot model and the check alone.
 */
import { describe, expect, it } from 'vitest';
import { ARKONA_PACK } from '../../src/packs/arkona.js';
import { nationTaxonomyCheck } from '../../src/audits/checks/nation-taxonomy.js';
import type { NationAuditInput } from '../../src/packs/nations/service.js';
import { requiredTerritoryCategoriesOf, territoryCategoriesOf } from '../../src/packs/nations/roles.js';
import { context, model, page, ROOT } from '../audits/helpers.js';

const rules = ARKONA_PACK.rules;
const tax = rules.indexTaxonomy!;
const REQUIRED_TOP = [
  'Cultures',
  'Historical Events',
  'Institutions',
  'Polities',
  'Regions',
  'Settlements & Locations',
  'Unique Magic & Technologies',
];

/** A territory `Zarvia` with these top-level categories (Conflicts inside Historical Events when `conflicts`). */
function world(o: { categories: readonly string[]; conflicts: boolean; bind: boolean }) {
  const pages = [ROOT, page({ id: 'zar', name: '[INDEX] Zarvia', parent: 'root', tags: ['Place'] })];
  const bindings = new Map<string, string>();
  for (const c of o.categories) {
    const id = `cat-${c}`;
    pages.push(page({ id, name: `[NAV] Zarvia ${c}`, parent: 'zar', tags: ['Navigation'] }));
    if (o.bind) bindings.set(c, id);
  }
  // The container of Conflicts is the bound Historical Events (bound by the seed, as it is by exact name).
  if (o.categories.includes('Historical Events')) bindings.set('Historical Events', 'cat-Historical Events');
  if (o.conflicts) {
    pages.push(
      page({
        id: 'cat-Conflicts',
        name: '[NAV] Zarvia Conflicts',
        parent: 'cat-Historical Events',
        tags: ['Navigation'],
      }),
    );
    if (o.bind) bindings.set('Conflicts', 'cat-Conflicts');
  }
  const input: NationAuditInput = {
    rules,
    tax,
    decisions: [],
    shortNames: new Map(),
    roles: null,
    territories: [{ entryId: 'e-zar', nodeId: 'zar', name: 'Zarvia', bindings }],
    homeRulings: new Map(),
    checks: { nonstandard: false, categoryMissing: true, categoryHome: false },
  };
  return { ...context(model(pages)), nationTaxonomy: input };
}

const missing = (ctx: ReturnType<typeof world>) =>
  nationTaxonomyCheck(ctx)
    .filter((f) => f.code === 'territory_category_missing')
    .map((f) => String(f.evidence?.category));

describe('the required territory categories', () => {
  it('are the governance’s seven plus Conflicts, in its order; Religions is recognised, not required', () => {
    expect(requiredTerritoryCategoriesOf(tax)).toEqual([
      'Cultures',
      'Historical Events',
      'Conflicts',
      'Institutions',
      'Polities',
      'Regions',
      'Settlements & Locations',
      'Unique Magic & Technologies',
    ]);
    expect(territoryCategoriesOf(tax)).toContain('Religions');
    expect(requiredTerritoryCategoriesOf(tax)).not.toContain('Religions');
  });

  it('a territory with all seven and Conflicts, and no Religions, has no finding (bound or found by name)', () => {
    expect(missing(world({ categories: REQUIRED_TOP, conflicts: true, bind: true }))).toEqual([]);
    expect(missing(world({ categories: REQUIRED_TOP, conflicts: true, bind: false }))).toEqual([]);
  });

  it('a missing required category, and a missing Conflicts inside Historical Events, are each one finding', () => {
    const r = missing(
      world({ categories: REQUIRED_TOP.filter((c) => c !== 'Regions'), conflicts: false, bind: true }),
    );
    expect(r).toEqual(['Conflicts', 'Regions']);
  });

  it('a version without the list requires every recognised category (Religions included)', () => {
    const ctx = world({ categories: REQUIRED_TOP, conflicts: true, bind: true });
    const old = { ...tax };
    delete (old as { requiredTerritoryCategories?: unknown }).requiredTerritoryCategories;
    expect(missing({ ...ctx, nationTaxonomy: { ...ctx.nationTaxonomy, tax: old } })).toEqual(['Religions']);
  });
});
