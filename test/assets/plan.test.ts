/**
 * v2 A4: placement planning, the old bridge's folder rules as a pure function (PLAN-v2 section 9). Every case runs
 * against a real repository tree (A2) and a real asset tree built from the mock LegendKeeper, and the plan never writes:
 * no request leaves the bridge and no row changes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  UNKNOWN_RACE_FOLDER,
  planAssetDestination,
  type AssetPlan,
  type PlanDeps,
  type PlanRequest,
  type PlanResult,
} from '../../src/assets/index.js';
import { assetRig, buildAssets, buildRepository, type AssetRig } from './helpers.js';
import type { World } from './model.js';

let rig: AssetRig;
let w: World;
type PageKey =
  | 'root'
  | 'chars'
  | 'mehrana'
  | 'mehranaIndex'
  | 'inae'
  | 'brenna'
  | 'brennaIndex'
  | 'kitsu'
  | 'wanderer'
  | 'aurelian'
  | 'tom'
  | 'voss'
  | 'orphan'
  | 'twinA'
  | 'twinB'
  | 'outside';
let page: Record<PageKey, string>;
afterEach(async () => rig?.close());

const P = () => rig.p.alpha!;
const plan = (r: PlanRequest) => rig.i.assets.plan(P().id, r);
const refresh = () => rig.settle(rig.i.assets.refresh(P().id, 'manual'));

function ok(r: PlanResult): AssetPlan {
  if (!r.ok) throw new Error(`expected a plan, got ${r.error.code}: ${r.error.message}`);
  return r.plan;
}
function bad(r: PlanResult) {
  if (r.ok) throw new Error(`expected a refusal, got a plan to ${r.plan.destination.path.join(' / ')}`);
  return r.error;
}
/** The plan as `action name` lines, root first: easy to read in an assertion. */
const lines = (p: AssetPlan) => p.steps.map((s) => `${s.action} ${s.name}`);

/** The repository of the test world: the pages the race labels come from. */
function seedRepository(): void {
  const m = P().repo;
  const root = m.seed({ name: 'AI REPOSITORY', parentId: null });
  const chars = m.seed({ name: '[INDEX] Characters', parentId: root.id });
  const group = (name: string, parent = chars.id) => m.seed({ name: `[INDEX] ${name}`, parentId: parent }).id;
  const core = (name: string, parent: string) => {
    const index = group(name, parent);
    return {
      index,
      core: m.seed({ name: `[BSRC] ${name}`, parentId: index, referenceType: 'Character Core' }).id,
    };
  };
  const compact = (name: string, parent: string) =>
    m.seed({ name: `[BSRC] ${name}`, parentId: parent, referenceType: 'Compact Character Reference' }).id;

  const beastkin = group('Beastkin');
  const qishen = group('Qishen', beastkin);
  const foxians = group('Foxians', beastkin);
  const elves = group('Elves');
  const moon = group('Moon Elves', elves);
  const dwarves = group('Dwarves');
  const unknown = group('Undetermined / Unknown');
  const humans = group('Humans');
  const high = group('High Humans', humans);
  const outsiders = group('Outsiders');
  const therians = group('Therians', outsiders);
  const archtherians = group('Archtherians', therians);
  page = {
    root: root.id,
    chars: chars.id,
    mehrana: core('Mehrana al-Khalid', qishen).core,
    mehranaIndex: [...m.res.values()].find((r) => r.name === '[INDEX] Mehrana al-Khalid')!.id,
    inae: core('Inae Mikumo', moon).core,
    brenna: core('Brenna Stonehand', dwarves).core,
    brennaIndex: [...m.res.values()].find((r) => r.name === '[INDEX] Brenna Stonehand')!.id,
    kitsu: compact('Kitsu', foxians),
    wanderer: compact('Wanderer', unknown),
    aurelian: compact('Aurelian', high),
    tom: compact('Commoner Tom', humans),
    voss: compact('Voss', archtherians),
    orphan: m.seed({
      name: '[BSRC] Orphan Page',
      parentId: chars.id,
      referenceType: 'Compact Character Reference',
    }).id,
    // The same name in two races, and outside the Characters index.
    twinA: compact('Twin', qishen),
    twinB: compact('Twin', moon),
    outside: m.seed({ name: '[INDEX] Locations', parentId: root.id }).id,
  };
  rig.setSetting('alpha', 'aiRepositoryRootId', root.id);
}

beforeEach(async () => {
  rig = await assetRig();
  w = P().model.testWorld();
  seedRepository();
  await buildAssets(rig, 'alpha');
  await buildRepository(rig, 'alpha');
});

describe('rule 1: a folder named after the character is reused wherever it is', () => {
  it('by name', () => {
    const p = ok(plan({ characterName: 'Inae Mikumo' }));
    expect(p.mode).toBe('existing_character_folder');
    expect(lines(p)).toEqual(['reuse Characters', 'reuse Elves', 'reuse Moon Elves', 'reuse Inae Mikumo']);
    expect(p.wouldCreate).toEqual([]);
    expect(p.destination).toEqual({
      path: ['Characters', 'Elves', 'Moon Elves', 'Inae Mikumo'],
      folderId: w.inae,
      exists: true,
    });
    expect(p.steps.map((s) => s.folderId)).toEqual([w.characters, w.elves, w.moonElves, w.inae]);
    expect(p.steps[3]).toMatchObject({ parentFolderId: w.moonElves });
    expect(p.character).toMatchObject({ name: 'Inae Mikumo', raceSource: 'not_needed' });
  });

  it('by the character’s page (the Core page, whose own [INDEX] gives the name)', () => {
    const p = ok(plan({ characterResourceId: page.inae }));
    expect(p.mode).toBe('existing_character_folder');
    expect(p.destination.folderId).toBe(w.inae);
    expect(p.character).toMatchObject({ name: 'Inae Mikumo', resourceId: page.inae });
  });

  it('even when the folder is nowhere near Characters, as long as there is exactly one', async () => {
    P().model.outsideMove(w.inae, w.recoveryCharacters);
    await refresh();
    const p = ok(plan({ characterName: 'Inae Mikumo' }));
    expect(lines(p)).toEqual(['reuse Recovery originals 2026-11', 'reuse Characters', 'reuse Inae Mikumo']);
    expect(p.destination.path).toEqual(['Recovery originals 2026-11', 'Characters', 'Inae Mikumo']);
    // The folder was NOT moved: the plan only reports where it is.
    expect(P().model.assets.get(w.inae)!.folderId).toBe(w.recoveryCharacters);
  });

  it('ignores case, and says so', () => {
    const p = ok(plan({ characterName: 'inae mikumo' }));
    expect(p.destination.folderId).toBe(w.inae);
    expect(p.notes.join(' ')).toMatch(/ignoring case/);
  });

  it('takes the literal subfolders after the reused folder', () => {
    const p = ok(plan({ characterName: 'Mehrana al-Khalid', subfolders: ['Portraits', 'Casual'] }));
    expect(lines(p)).toEqual([
      'reuse Characters',
      'reuse Beastkin',
      'reuse Qishen',
      'reuse Mehrana al-Khalid',
      'create Portraits',
      'create Casual',
    ]);
    expect(p.destination).toMatchObject({
      path: [...p.reused.map((s) => s.name), 'Portraits', 'Casual']
        .slice(0, 4)
        .concat(['Portraits', 'Casual']),
      folderId: null,
      exists: false,
    });
    expect(p.wouldCreate.map((s) => s.parentFolderId)).toEqual([w.mehrana, null]);
  });

  it('works without the repository tree (the name alone is enough when the folder exists)', () => {
    rig.setSetting('alpha', 'aiRepositoryRootId', null);
    expect(ok(plan({ characterName: 'Inae Mikumo' })).destination.folderId).toBe(w.inae);
  });
});

describe('rule 2: Characters / Group / Race / Character, from the character page’s ancestry', () => {
  it('group and race, with the folders that exist reused and the rest created, in order', () => {
    const p = ok(plan({ characterName: 'Kitsu' }));
    expect(p.mode).toBe('character_path');
    expect(lines(p)).toEqual(['reuse Characters', 'reuse Beastkin', 'reuse Foxians', 'create Kitsu']);
    expect(p.reused.map((s) => s.name)).toEqual(['Characters', 'Beastkin', 'Foxians']);
    expect(p.wouldCreate).toEqual([
      {
        name: 'Kitsu',
        action: 'create',
        folderId: null,
        parentFolderId: w.foxians,
        path: ['Characters', 'Beastkin', 'Foxians', 'Kitsu'],
      },
    ]);
    expect(p.destination).toEqual({
      path: ['Characters', 'Beastkin', 'Foxians', 'Kitsu'],
      folderId: null,
      exists: false,
    });
    expect(p.character).toMatchObject({
      name: 'Kitsu',
      group: 'Beastkin',
      race: 'Foxians',
      raceSource: 'page_ancestry',
      resourceId: page.kitsu,
    });
  });

  it('by resource id gives the same plan; the [INDEX] / [BSRC] prefixes are never in a folder name', () => {
    const a = ok(plan({ characterResourceId: page.kitsu }));
    expect(a.destination.path).toEqual(['Characters', 'Beastkin', 'Foxians', 'Kitsu']);
    for (const s of a.steps) expect(s.name).not.toMatch(/^\[/);
  });

  it('a race directly under Characters has no group: Characters / Race / Character', () => {
    const p = ok(plan({ characterName: 'Brenna Stonehand' }));
    expect(lines(p)).toEqual(['reuse Characters', 'reuse Dwarves', 'create Brenna Stonehand']);
    expect(p.character).toMatchObject({ group: null, race: 'Dwarves', raceSource: 'page_ancestry' });
    // The Core page and its own [INDEX] page give the same answer.
    expect(ok(plan({ characterResourceId: page.brenna })).destination.path).toEqual(p.destination.path);
    expect(ok(plan({ characterResourceId: page.brennaIndex })).destination.path).toEqual(p.destination.path);
  });

  it('a compact reference directly under a race index, next to subraces', () => {
    expect(ok(plan({ characterName: 'Commoner Tom' })).destination.path).toEqual([
      'Characters',
      'Humans',
      'Commoner Tom',
    ]);
    expect(ok(plan({ characterName: 'Aurelian' })).destination.path).toEqual([
      'Characters',
      'Humans',
      'High Humans',
      'Aurelian',
    ]);
  });

  it('an existing partial path: what is there is reused, the rest is created, in order', () => {
    const p = ok(plan({ characterName: 'Aurelian' }));
    expect(lines(p)).toEqual(['reuse Characters', 'reuse Humans', 'create High Humans', 'create Aurelian']);
    expect(p.wouldCreate.map((s) => s.parentFolderId)).toEqual([w.humans, null]);
  });

  it('nothing exists at all: every folder would be created, starting with the asset root', async () => {
    P().model.outsideDelete(w.characters);
    await refresh();
    const p = ok(plan({ characterName: 'Kitsu' }));
    expect(lines(p)).toEqual(['create Characters', 'create Beastkin', 'create Foxians', 'create Kitsu']);
    expect(p.reused).toEqual([]);
    expect(p.wouldCreate[0]).toMatchObject({ parentFolderId: null });
  });

  it('subfolders follow the character folder', () => {
    const p = ok(plan({ characterName: 'Kitsu', subfolders: ['Portraits', 'Casual'] }));
    expect(lines(p)).toEqual([
      'reuse Characters',
      'reuse Beastkin',
      'reuse Foxians',
      'create Kitsu',
      'create Portraits',
      'create Casual',
    ]);
    expect(p.destination.path).toEqual(['Characters', 'Beastkin', 'Foxians', 'Kitsu', 'Portraits', 'Casual']);
  });

  it('the asset root folder name comes from the type registry when A3’s data exists', () => {
    const deps: PlanDeps = {
      assets: rig.i.assets.queries,
      tree: rig.i.tree.queries,
      charactersRootId: () => page.chars,
      assetRootFolderName: () => 'Dramatis Personae',
    };
    const p = ok(planAssetDestination(P().id, { characterName: 'Kitsu' }, deps));
    expect(lines(p)).toEqual([
      'create Dramatis Personae',
      'create Beastkin',
      'create Foxians',
      'create Kitsu',
    ]);
    // Without it: the literal "Characters".
    expect(ok(plan({ characterName: 'Kitsu' })).steps[0]!.name).toBe('Characters');
  });

  it('the Characters root can be named by the project’s charactersRootId', () => {
    rig.setSetting('alpha', 'charactersRootId', page.chars);
    expect(ok(plan({ characterName: 'Kitsu' })).destination.path).toEqual([
      'Characters',
      'Beastkin',
      'Foxians',
      'Kitsu',
    ]);
  });
});

describe('rule 3: an unknown race uses the literal folder “Undetermined / Unknown”', () => {
  it('a character under the Undetermined / Unknown index', () => {
    const p = ok(plan({ characterName: 'Wanderer' }));
    expect(lines(p)).toEqual(['reuse Characters', 'reuse Undetermined / Unknown', 'create Wanderer']);
    expect(p.steps[1]!.name).toBe(UNKNOWN_RACE_FOLDER);
  });

  it('a name with no page under Characters: unknown, and the plan says why', () => {
    const p = ok(plan({ characterName: 'Nobody Known' }));
    expect(lines(p)).toEqual(['reuse Characters', 'reuse Undetermined / Unknown', 'create Nobody Known']);
    expect(p.character).toMatchObject({
      raceSource: 'unknown_race',
      resourceId: null,
      race: UNKNOWN_RACE_FOLDER,
    });
    expect(p.notes.join(' ')).toMatch(/race is unknown/);
  });

  it('a page directly under Characters has no race either', () => {
    const p = ok(plan({ characterResourceId: page.orphan }));
    expect(p.destination.path).toEqual(['Characters', UNKNOWN_RACE_FOLDER, 'Orphan Page']);
    expect(p.character!.raceSource).toBe('unknown_race');
  });

  it('the literal folder is created when it does not exist yet', async () => {
    P().model.outsideDelete(w.unknown);
    await refresh();
    const p = ok(plan({ characterName: 'Wanderer', subfolders: ['Art'] }));
    expect(lines(p)).toEqual([
      'reuse Characters',
      'create Undetermined / Unknown',
      'create Wanderer',
      'create Art',
    ]);
  });
});

describe('rule 4: subfolders are literal plain names', () => {
  it('reuses an existing subfolder, then creates what is missing', () => {
    P().model.folder('Reference', w.mehrana);
    return refresh().then(() => {
      const p = ok(plan({ characterName: 'Mehrana al-Khalid', subfolders: ['Reference', 'Sketches'] }));
      expect(lines(p).slice(4)).toEqual(['reuse Reference', 'create Sketches']);
    });
  });

  it('a slash path is refused, never split', () => {
    const e = bad(plan({ characterName: 'Kitsu', subfolders: ['Portraits/Casual'] }));
    expect(e.code).toBe('INVALID_NAME');
    expect(e.message).toMatch(/never a slash path/);
    expect(bad(plan({ characterName: 'Kitsu', subfolders: ['a\\b/c'] })).code).toBe('INVALID_NAME');
  });

  it('empty, over-long and control-character names are refused; surrounding spaces are removed', () => {
    expect(bad(plan({ characterName: 'Kitsu', subfolders: ['  '] })).code).toBe('INVALID_NAME');
    expect(bad(plan({ characterName: 'Kitsu', subfolders: ['x'.repeat(201)] })).code).toBe('INVALID_NAME');
    expect(bad(plan({ characterName: 'Kitsu', subfolders: ['bad\u0007name'] })).code).toBe('INVALID_NAME');
    expect(bad(plan({ characterName: '' })).code).toBe('INVALID_NAME');
    const p = ok(plan({ characterName: '  Kitsu  ', subfolders: [' Art '] }));
    expect(p.destination.path.slice(-2)).toEqual(['Kitsu', 'Art']);
  });

  it('the one name with a slash that is allowed is the literal unknown-race folder', () => {
    expect(ok(plan({ folderPath: ['Characters', UNKNOWN_RACE_FOLDER] })).destination.folderId).toBe(
      w.unknown,
    );
  });
});

describe('a literal folder path', () => {
  it('reuses what exists and creates the rest', () => {
    const p = ok(plan({ folderPath: ['Maps to get started', 'Dungeons', 'Level 1'] }));
    expect(p.mode).toBe('folder_path');
    expect(lines(p)).toEqual(['reuse Maps to get started', 'create Dungeons', 'create Level 1']);
    expect(p.character).toBeNull();
    expect(ok(plan({ folderPath: ['Characters', 'Beastkin'] })).destination).toMatchObject({
      folderId: w.beastkin,
      exists: true,
    });
  });

  it('is refused when empty or mixed with a character', () => {
    expect(bad(plan({ folderPath: [] })).code).toBe('INVALID_REQUEST');
    expect(bad(plan({ folderPath: ['a'], characterName: 'x' } as unknown as PlanRequest)).code).toBe(
      'INVALID_REQUEST',
    );
    expect(bad(plan({ folderPath: ['a'], subfolders: ['x'] } as unknown as PlanRequest)).code).toBe(
      'INVALID_REQUEST',
    );
  });
});

describe('rule 5: a conflict and an ambiguity are typed, never guessed', () => {
  it('an asset (not a folder) with the character’s name where the folder is needed is a conflict', async () => {
    const image = P().model.image('Kitsu', w.foxians);
    await refresh();
    const e = bad(plan({ characterName: 'Kitsu' }));
    expect(e.code).toBe('ASSET_NAME_CONFLICT');
    expect(e.details).toMatchObject({
      name: 'Kitsu',
      in: ['Characters', 'Beastkin', 'Foxians'],
      assets: [{ id: image, type: 'IMAGE' }],
    });
    expect(e.message).toMatch(/Nothing was moved or renamed/);
  });

  it('a conflict in the middle of the path stops the plan there', async () => {
    P().model.image('High Humans', w.humans);
    await refresh();
    expect(bad(plan({ characterName: 'Aurelian' })).code).toBe('ASSET_NAME_CONFLICT');
  });

  it('a conflict in a subfolder, and in a literal path', async () => {
    P().model.image('Portraits', w.mehrana);
    await refresh();
    expect(bad(plan({ characterName: 'Mehrana al-Khalid', subfolders: ['Portraits'] })).code).toBe(
      'ASSET_NAME_CONFLICT',
    );
    P().model.image('Level 1', w.maps);
    await refresh();
    expect(bad(plan({ folderPath: ['Maps to get started', 'Level 1'] })).code).toBe('ASSET_NAME_CONFLICT');
  });

  it('a folder of the right name wins over an asset of the same name', async () => {
    P().model.image('Qishen', w.beastkin); // an image called Qishen next to the folder Qishen
    await refresh();
    expect(ok(plan({ folderPath: ['Characters', 'Beastkin', 'Qishen'] })).destination.folderId).toBe(
      w.qishen,
    );
  });

  it('more than one folder with the character’s name is an ambiguity, listing every candidate', async () => {
    const twin = P().model.folder('Mehrana al-Khalid', w.recoveryCharacters);
    await refresh();
    const e = bad(plan({ characterName: 'Mehrana al-Khalid' }));
    expect(e.code).toBe('AMBIGUOUS_FOLDER');
    // Ordered by path.
    expect(e.details!.candidates).toEqual([
      { id: w.mehrana, path: ['Characters', 'Beastkin', 'Qishen', 'Mehrana al-Khalid'] },
      { id: twin, path: ['Recovery originals 2026-11', 'Characters', 'Mehrana al-Khalid'] },
    ]);
    expect(e.message).toMatch(/Nothing was guessed/);
    // Naming the folder by its path settles it.
    expect(
      ok(plan({ folderPath: ['Characters', 'Beastkin', 'Qishen', 'Mehrana al-Khalid'] })).destination
        .folderId,
    ).toBe(w.mehrana);
  });

  it('two folders of one name in one place on the way down is an ambiguity too', async () => {
    P().model.folder('Foxians', w.beastkin);
    await refresh();
    const e = bad(plan({ characterName: 'Kitsu' }));
    expect(e.code).toBe('AMBIGUOUS_FOLDER');
    expect(e.details).toMatchObject({ name: 'Foxians', in: ['Characters', 'Beastkin'] });
  });

  it('folders are never moved: a plan only reads', () => {
    const mutations = P().model.mutations.length;
    const sent = rig.i.sent.length;
    const counts = JSON.stringify(rig.i.assets.store.counts(P().id));
    const rows = rig.i.db.prepare('SELECT COUNT(*) AS n FROM asset_log').get();
    for (const r of [
      { characterName: 'Kitsu' },
      { characterName: 'Inae Mikumo', subfolders: ['x'] },
      { folderPath: ['nope'] },
      { characterResourceId: page.aurelian },
    ] as PlanRequest[])
      plan(r);
    expect(P().model.mutations.length).toBe(mutations);
    expect(rig.i.sent.length).toBe(sent);
    expect(JSON.stringify(rig.i.assets.store.counts(P().id))).toBe(counts);
    expect(rig.i.db.prepare('SELECT COUNT(*) AS n FROM asset_log').get()).toEqual(rows);
  });
});

describe('the request and the trees must be usable', () => {
  it('needs exactly one of characterResourceId and characterName', () => {
    expect(bad(plan({})).code).toBe('INVALID_REQUEST');
    expect(bad(plan({ characterName: 'a', characterResourceId: 'b' })).code).toBe('INVALID_REQUEST');
  });

  it('an unknown page, a page outside Characters, and a page too deep are refused', () => {
    expect(bad(plan({ characterResourceId: 'zzzzzzzz' })).code).toBe('CHARACTER_NOT_FOUND');
    expect(bad(plan({ characterResourceId: page.outside })).code).toBe('NOT_A_CHARACTER');
    const deep = bad(plan({ characterResourceId: page.voss }));
    expect(deep.code).toBe('ANCESTRY_TOO_DEEP');
    expect(deep.details).toEqual({ chain: ['Outsiders', 'Therians', 'Archtherians'] });
    // A literal path still works for it.
    expect(
      ok(plan({ folderPath: ['Characters', 'Outsiders', 'Therians', 'Archtherians', 'Voss'] })).wouldCreate,
    ).toHaveLength(1);
  });

  it('a name whose pages sit in different places is ambiguous: say which', () => {
    const e = bad(plan({ characterName: 'Twin' }));
    expect(e.code).toBe('CHARACTER_PAGE_AMBIGUOUS');
    expect(e.details!.places).toHaveLength(2);
    expect(ok(plan({ characterResourceId: page.twinA })).destination.path).toEqual([
      'Characters',
      'Beastkin',
      'Qishen',
      'Twin',
    ]);
    expect(ok(plan({ characterResourceId: page.twinB })).destination.path).toEqual([
      'Characters',
      'Elves',
      'Moon Elves',
      'Twin',
    ]);
  });

  it('no plan while the asset tree is not built', async () => {
    const other = await assetRig({ projects: ['beta'] });
    try {
      const e = bad(other.i.assets.plan(other.p.beta!.id, { characterName: 'Kitsu' }));
      expect(e.code).toBe('ASSET_TREE_NOT_READY');
      expect(bad(other.i.assets.plan(other.p.beta!.id, { folderPath: ['a'] })).code).toBe(
        'ASSET_TREE_NOT_READY',
      );
    } finally {
      await other.close();
    }
  });

  it('no race can be read while the repository tree is not built (but a folder that exists needs none)', () => {
    rig.setSetting('alpha', 'aiRepositoryRootId', null);
    expect(bad(plan({ characterName: 'Kitsu' })).code).toBe('REPOSITORY_TREE_NOT_READY');
    expect(bad(plan({ characterResourceId: page.kitsu })).code).toBe('REPOSITORY_TREE_NOT_READY');
    expect(ok(plan({ characterName: 'Inae Mikumo' })).mode).toBe('existing_character_folder');
    expect(ok(plan({ folderPath: ['Characters'] })).destination.exists).toBe(true);
  });

  it('a stale asset tree still plans, and says it is stale', () => {
    rig.i.assets.store.markStale(P().id, [w.dwarves], 'test');
    const p = ok(plan({ characterName: 'Kitsu' }));
    expect(p.assetTree.status).toBe('stale');
    expect(p.notes.join(' ')).toMatch(/asset tree is stale/);
  });

  it('the Characters root must be findable', () => {
    P().repo.seed({ name: '[INDEX] Characters', parentId: page.root });
    return rig.settle(rig.i.tree.sweep(P().id, 'manual')).then(() => {
      const e = bad(plan({ characterName: 'Kitsu' }));
      expect(e.code).toBe('CHARACTERS_ROOT_UNKNOWN');
      rig.setSetting('alpha', 'charactersRootId', page.chars);
      expect(ok(plan({ characterName: 'Kitsu' })).mode).toBe('character_path');
    });
  });
});
