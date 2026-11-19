/**
 * v3 F3f (ADR 0060): the retag's test world. The appraisal world (the REAL server, runtime, MCP transport, policy and
 * engine against the mock LegendKeeper, the Arkona pack attached and approved), plus a "Retag Desk" of fixture pages
 * built from the Tagging Standard's shapes, never fetched:
 *
 * - correct tags; a missing identity token; a wrong order; an incidental extra tag (an owner exception) and an Excluded
 *   Routine Tag; an uncertain category (no pack record, two primary categories); an AU owner; the race/culture shared
 *   token (the Standard's Otheiralth example); an "Unestablished" Naming Culture; a Working page and a page in a Legacy
 *   Canon Archive (both outside the grammar); an index whose routing lines are labelled mentions (part D).
 *
 * The approved pack version lists `Imported` as an Excluded Routine Tag and makes the lifecycle tag lead on this project.
 */
import { ROOT } from '../discover/world.js';
import { appraisalWorld, type AppraisalWorld } from '../appraisal/world.js';
import { PROJECT } from '../tools/helpers.js';
import { ARKONA_PACK } from '../../src/packs/arkona.js';

export { PROJECT };

export const R = {
  desk: 'rtdesk01',
  ok: 'rtok0001',
  order: 'rtorder1',
  extra: 'rtextra1',
  routine: 'rtroutn1',
  missing: 'rtmiss01',
  twoPrimaries: 'rttwo001',
  au: 'rtau0001',
  otheiralth: 'rtother1',
  unestablished: 'rtunest1',
  working: 'rtwork01',
  legacyIndex: 'rtlegix1',
  legacy: 'rtlegcy1',
  routing: 'rtroute1',
  held: 'rtheld01',
  gone: 'rtgone01',
  resumeA: 'rtres001',
  resumeB: 'rtres002',
} as const;

/** What each fixture page should be, by the engine. */
export const EXPECTED: Readonly<Record<string, string>> = {
  [R.ok]: 'compliant',
  [R.order]: 'correction',
  [R.extra]: 'exception',
  [R.routine]: 'correction',
  [R.missing]: 'correction',
  [R.twoPrimaries]: 'hold',
  [R.au]: 'correction',
  [R.otheiralth]: 'compliant',
  [R.unestablished]: 'hold',
  [R.held]: 'correction',
  [R.gone]: 'correction',
  [R.resumeA]: 'correction',
  [R.resumeB]: 'correction',
};

const CANON_ROWS: [string, string][] = [
  ['Status', 'Authoritative'],
  ['Continuity Type', 'CANON'],
  ['Continuity', 'Main'],
  ['Inheritance', 'None'],
];

export interface RetagWorld extends AppraisalWorld {
  /** The n-th (0-based) next request matching method and path fails once with a 400 (as the rename world's). */
  failNext(method: string, path: RegExp, n?: number): void;
  /** The approved pack version with these retag rules (a new version, approved as the owner would). */
  approveRetag(o?: { readonly routine?: readonly string[]; readonly batchSize?: number }): void;
}

export async function retagWorld(): Promise<RetagWorld> {
  const w = await appraisalWorld({
    retag: true,
    seed: (world) => {
      const r = world.repo;
      const page = (
        id: string,
        name: string,
        parentId: string,
        tags: string[],
        referenceType: string,
        rows: [string, string][] = CANON_ROWS,
      ) => {
        r.seed({ id, name, parentId, tags, referenceType });
        for (const [k, v] of rows) r.outside.setRow(id, k, v);
      };
      r.seed({ id: R.desk, name: '[INDEX] Retag Desk', parentId: ROOT });
      page(R.ok, '[BSRC] Corlath March - Polity Reference', R.desk, ['CANON', 'Polity'], 'Polity Reference');
      page(
        R.order,
        '[BSRC] Drevin Shore - Polity Reference',
        R.desk,
        ['Polity', 'CANON'],
        'Polity Reference',
      );
      page(
        R.extra,
        '[BSRC] Esk Reach - Polity Reference',
        R.desk,
        ['CANON', 'Polity', 'Lore'],
        'Polity Reference',
      );
      page(
        R.routine,
        '[BSRC] Fallow Isles - Polity Reference',
        R.desk,
        ['CANON', 'Polity', 'Imported'],
        'Polity Reference',
      );
      page(
        R.missing,
        '[BSRC] Ilsa Varn - Character Core',
        R.desk,
        ['CANON', 'Character', 'Foxian'],
        'Character Core',
        [...CANON_ROWS, ['Race / Species', 'Foxian'], ['Naming Culture', 'Fujimatsuan']],
      );
      page(R.held, '[BSRC] Kessen Ford - Polity Reference', R.desk, ['Polity', 'CANON'], 'Polity Reference');
      page(R.gone, '[BSRC] Lorn Weir - Polity Reference', R.desk, ['Polity', 'CANON'], 'Polity Reference');
      page(
        R.resumeA,
        '[BSRC] Mavren Hold - Polity Reference',
        R.desk,
        ['Polity', 'CANON'],
        'Polity Reference',
      );
      page(R.resumeB, '[BSRC] Nesk Vale - Polity Reference', R.desk, ['Polity', 'CANON'], 'Polity Reference');
      page(
        R.twoPrimaries,
        '[BSRC] Harrow Pact - Reference',
        R.desk,
        ['CANON', 'Culture', 'Polity'],
        'General Source',
      );
      page(R.au, '[BSRC] Shattered Crown - Polity Reference', R.desk, ['Polity', 'AU'], 'Polity Reference', [
        ['Status', 'Authoritative'],
        ['Continuity Type', 'AU'],
        ['Continuity', 'Shattered Crown'],
        ['Inheritance', 'None'],
      ]);
      page(
        R.otheiralth,
        '[BSRC] Otheiralth - Character Core',
        R.desk,
        ['CANON', 'Character', 'Therian'],
        'Character Core',
        [...CANON_ROWS, ['Race / Species', 'Therian'], ['Naming Culture', 'Therian']],
      );
      page(
        R.unestablished,
        '[BSRC] Mirel Dask - Character Core',
        R.desk,
        ['CANON', 'Character', 'Human'],
        'Character Core',
        [...CANON_ROWS, ['Race / Species', 'Human'], ['Naming Culture', 'Unestablished']],
      );
      page(R.working, '[BWRK] Salt Toll Draft', R.desk, ['Polity', 'Working'], 'Polity Reference', [
        ['Status', 'Working'],
      ]);
      r.seed({ id: R.legacyIndex, name: '[INDEX] Legacy Canon Archive', parentId: R.desk });
      page(R.legacy, '[BSRC] Old Dominion - Polity Reference', R.legacyIndex, ['Polity'], 'Polity Reference');
      // Part D: an index whose routing lines are mentions with a custom label (and one plain mention).
      r.seed({ id: R.routing, name: '[INDEX] Routing Desk', parentId: R.desk });
    },
  });
  const approveRetag = (o: { readonly routine?: readonly string[]; readonly batchSize?: number } = {}) => {
    const packs = w.stack.runtime.packs;
    const pack = packs.get('arkona')!;
    const next = packs.store.newVersion(
      'arkona',
      {
        ...pack.rules,
        lifecycleTagPosition: { arkona: 'lead', test: 'lead' },
        retag: {
          ...(pack.rules.retag ?? ARKONA_PACK.rules.retag!),
          excludedRoutineTags: [...(o.routine ?? ['Imported'])],
          ...(o.batchSize !== undefined ? { batchSize: o.batchSize } : {}),
        },
      },
      'test: retag rules',
    );
    packs.store.approve('arkona', {
      version: next.version,
      at: Date.now(),
      by: 'owner',
      sources: pack.approved?.sources ?? [],
    });
  };
  approveRetag();
  const failNext = (method: string, path: RegExp, n = 0) => {
    let seen = 0;
    let fired = false;
    const fn = (req: { method: string; path: string }) => {
      if (fired || req.method !== method || !path.test(req.path.replace(/\/$/, ''))) return undefined;
      if (seen++ !== n) return undefined;
      fired = true;
      return {
        status: 400,
        body: {
          message: 'model VALIDATION_ERROR (injected)',
          code: 'VALIDATION_ERROR',
          requestId: 'model-injected',
        },
      };
    };
    const rest = [...w.overrides.entries()];
    w.overrides.clear();
    w.overrides.set(/./, fn);
    for (const [re, f] of rest) w.overrides.set(re, f);
  };
  return Object.assign(w, { approveRetag, failNext });
}
