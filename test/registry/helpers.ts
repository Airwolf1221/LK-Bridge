/**
 * Harness for the registry tests (v2 A3): a migrated SQLite database in a temp directory, projects registered, and
 * each project's repository tree filled directly through A2's store (as a build would leave it), so the registry is
 * tested against the real tree, query layer and status logic without a mock LegendKeeper.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../src/db/migrate.js';
import { openDatabase, type Db } from '../../src/db/open.js';
import type { JobEngine } from '../../src/jobs/index.js';
import { FakeClock } from '../../src/lk/governor/clock.js';
import type { ProjectsRuntime } from '../../src/projects/registry.js';
import { ProjectStore } from '../../src/projects/index.js';
import { createRegistry, type Registry, type TemplateInfo } from '../../src/registry/index.js';
import { createTree, type TreeService } from '../../src/tree/index.js';

export interface NodeSpec {
  id: string;
  name: string;
  parent: string | null;
  /** LegendKeeper's sibling rank (default: none, so siblings sort by id). */
  rank?: string;
  referenceType?: string | null;
  subject?: string;
  aliases?: string[];
  canonical?: string;
  /** false: only the structure is known (properties not read yet). */
  props?: boolean;
}

export interface World {
  readonly db: Db;
  readonly clock: FakeClock;
  readonly tree: TreeService;
  readonly registry: Registry;
  readonly audits: { action: string; target: string | null; after?: unknown }[];
  templates: Record<string, TemplateInfo[]>;
  /** Adds (or replaces) nodes of a project's tree, as an observation stamped now. */
  add(project: string, nodes: readonly NodeSpec[]): void;
  /** Removes a node (and what is under it) from the tree, as a deletion seen by a pass. */
  remove(project: string, id: string): void;
  close(): void;
}

export const ROOT = 'root0001';

let stamp = 1_000_000;

export function world(projects: readonly string[] = ['alpha']): World {
  const dir = mkdtempSync(join(tmpdir(), 'lkb-registry-'));
  const db = openDatabase(join(dir, 'bridge.db'));
  runMigrations(db);
  const clock = new FakeClock();
  const ps = new ProjectStore(db, () => clock.now());
  for (const p of projects) {
    ps.insert({ id: p, name: p, displayName: null, verifiedAt: null });
    ps.setSetting(p, 'aiRepositoryRootId', ROOT);
  }
  const stubProjects = {
    client: () => undefined,
    activeIds: () => [],
    onChange: () => () => undefined,
  } as unknown as ProjectsRuntime;
  const tree = createTree({
    db,
    engine: {} as JobEngine,
    projects: stubProjects,
    clock,
    autoSuggestRoot: false,
  });
  const audits: World['audits'] = [];
  const w: World = {
    db,
    clock,
    tree,
    audits,
    templates: {},
    registry: undefined as unknown as Registry,
    add(project, nodes) {
      const settings = tree.settings(project);
      tree.store.ensureRoot(project, ROOT);
      const ctx = { projectId: project, rootId: ROOT, settings, by: 'build' as const };
      for (const n of nodes) {
        const rows = [
          ...(n.referenceType ? [{ key: 'Reference Type', text: n.referenceType }] : []),
          ...(n.subject ? [{ key: 'Subject', text: n.subject }] : []),
          ...(n.canonical ? [{ key: 'Canonical Display Name', text: n.canonical }] : []),
        ];
        tree.store.applyObservation(
          ctx,
          {
            id: n.id,
            name: n.name,
            parentId: n.parent,
            rank: n.rank ?? null,
            tags: [],
            aliases: n.aliases ?? [],
            documents: [],
            isHidden: false,
            ...(n.props === false
              ? {}
              : {
                  props: {
                    isLocked: false,
                    sidebar: [{ id: 'p1', kind: 'keyValue', title: 'PROPERTIES', rows }],
                  },
                }),
          },
          ++stamp,
        );
      }
      tree.store.recomputePaths(project, ROOT);
      tree.store.setConfirmed(project, clock.now(), 'build');
    },
    remove(project, id) {
      tree.store.applyGone(
        { projectId: project, rootId: ROOT, settings: tree.settings(project), by: 'check' },
        id,
        ++stamp,
        'deleted',
      );
      tree.store.recomputePaths(project, ROOT);
    },
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  (w as { registry: Registry }).registry = createRegistry({
    db,
    tree,
    audit: { audit: (_actor, action, target, _before, after) => audits.push({ action, target, after }) },
    now: () => clock.now(),
    readTemplates: (p) => Promise.resolve(w.templates[p] ?? []),
  });
  return w;
}

/**
 * The test world's shape (PLAN-v2 section 2): nine groups under `[INDEX] Characters`, both layouts (Beastkin / Foxians,
 * a group then a race; Dwarves, a race directly under Characters with characters beneath it), Humans mixing character
 * indexes, a subrace and compact references, and exactly one `[INDEX] Undetermined / Unknown`.
 */
export function testWorld(): NodeSpec[] {
  const nodes: NodeSpec[] = [
    { id: ROOT, name: 'AI REPOSITORY', parent: null },
    { id: 'chars001', name: '[INDEX] Characters', parent: ROOT, referenceType: 'Index' },
    { id: 'equip001', name: '[INDEX] Equipment', parent: ROOT, referenceType: 'Index' },
    // Beastkin / Foxians / Asagiri Miyabi (character index with its core)
    { id: 'beast001', name: '[INDEX] Beastkin', parent: 'chars001', referenceType: 'Index' },
    { id: 'fox00001', name: '[INDEX] Foxians', parent: 'beast001', referenceType: 'Index' },
    { id: 'asagi001', name: '[INDEX] Asagiri Miyabi', parent: 'fox00001', referenceType: 'Index' },
    { id: 'asagi002', name: '[BSRC] Asagiri Miyabi', parent: 'asagi001', referenceType: 'Character Core' },
    {
      id: 'asagi003',
      name: '[BSRC] Asagiri Miyabi - Art',
      parent: 'asagi001',
      referenceType: 'Character Art',
    },
    { id: 'qish0001', name: '[INDEX] Qishen', parent: 'beast001', referenceType: 'Index' },
    { id: 'mehr0001', name: '[INDEX] Mehrana al-Khalid', parent: 'qish0001', referenceType: 'Index' },
    {
      id: 'mehr0002',
      name: '[BSRC] Mehrana al-Khalid - Character Core',
      parent: 'mehr0001',
      referenceType: 'Character Core',
    },
    { id: 'saru0001', name: '[INDEX] Saru', parent: 'beast001', referenceType: 'Index' },
    // Dwarves directly under Characters, with characters beneath it
    { id: 'dwarf001', name: '[INDEX] Dwarves', parent: 'chars001', referenceType: 'Index' },
    { id: 'thor0001', name: '[INDEX] Thorin Ironhand', parent: 'dwarf001', referenceType: 'Index' },
    {
      id: 'thor0002',
      name: '[BSRC] Core sheet',
      parent: 'thor0001',
      referenceType: 'Character Core',
      subject: 'Thorin Ironhand',
    },
    {
      id: 'gimb0001',
      name: '[BSRC] Gimble Stonefoot',
      parent: 'dwarf001',
      referenceType: 'Compact Character Reference',
    },
    // Humans: character indexes, a subrace and compact references side by side
    { id: 'human001', name: '[INDEX] Humans', parent: 'chars001', referenceType: 'Index' },
    { id: 'aldr0001', name: '[INDEX] Aldric Vane', parent: 'human001', referenceType: 'Index' },
    { id: 'aldr0002', name: '[BSRC] Aldric Vane', parent: 'aldr0001', referenceType: 'Character Core' },
    { id: 'hhum0001', name: '[INDEX] High Humans', parent: 'human001', referenceType: 'Index' },
    { id: 'lys00001', name: '[INDEX] Lyssa Dawn', parent: 'hhum0001', referenceType: 'Index' },
    { id: 'lys00002', name: '[BSRC] Lyssa Dawn', parent: 'lys00001', referenceType: 'Character Core' },
    {
      id: 'bram0001',
      name: '[BSRC] Bram Cooper - Compact Character Reference',
      parent: 'human001',
      referenceType: 'Compact Character Reference',
    },
    {
      id: 'cora0001',
      name: '[BSRC] Cora Fenn',
      parent: 'human001',
      referenceType: 'Compact Character Reference',
    },
    // A compact reference that is the only page of its index: a character index too.
    { id: 'pell0001', name: '[INDEX] Pell', parent: 'human001', referenceType: 'Index' },
    { id: 'pell0002', name: '[BSRC] Pell', parent: 'pell0001', referenceType: 'Compact Character Reference' },
    // Elves (group) / Wood Elves (race) / Moon Elves (deeper than the race search)
    { id: 'elves001', name: '[INDEX] Elves', parent: 'chars001', referenceType: 'Index' },
    { id: 'wood0001', name: '[INDEX] Wood Elves', parent: 'elves001', referenceType: 'Index' },
    { id: 'moon0001', name: '[INDEX] Moon Elves', parent: 'wood0001', referenceType: 'Index' },
    { id: 'moon0002', name: '[BSRC] Moon Elf customs', parent: 'moon0001' },
    // More groups (nine in all), one empty
    { id: 'green001', name: '[INDEX] Greenskins', parent: 'chars001', referenceType: 'Index' },
    { id: 'gobl0001', name: '[INDEX] Goblins', parent: 'green001', referenceType: 'Index' },
    { id: 'gobl0002', name: '[BSRC] Goblin notes', parent: 'gobl0001' },
    { id: 'outs0001', name: '[INDEX] Outsiders', parent: 'chars001', referenceType: 'Index' },
    { id: 'daem0001', name: '[INDEX] Daemons', parent: 'outs0001', referenceType: 'Index' },
    { id: 'daem0002', name: '[BSRC] Daemon notes', parent: 'daem0001' },
    { id: 'faer0001', name: '[INDEX] Faeries', parent: 'chars001', referenceType: 'Index' },
    { id: 'faer0002', name: '[BSRC] Faerie courts', parent: 'faer0001' },
    { id: 'drag0001', name: '[INDEX] True Dragons', parent: 'chars001', referenceType: 'Index' },
    { id: 'tide0001', name: '[INDEX] Tidekin', parent: 'chars001', referenceType: 'Index' },
    // Exactly one unknown-race index, with a character in it
    { id: 'undet001', name: '[INDEX] Undetermined / Unknown', parent: 'chars001', referenceType: 'Index' },
    { id: 'nobo0001', name: '[INDEX] Nobody Known', parent: 'undet001', referenceType: 'Index' },
    { id: 'nobo0002', name: '[BSRC] Nobody Known', parent: 'nobo0001', referenceType: 'Character Core' },
    // A loose page with no prefix
    { id: 'notes001', name: 'Working notes', parent: ROOT },
  ];
  return nodes;
}

export const TEMPLATES: TemplateInfo[] = [
  { id: 'tplindex', name: '[INDEX] AI Index Template', parentId: 'templates' },
  { id: 'tplcore1', name: '[BSRC] AI Character Core', parentId: 'templates' },
  { id: 'tplcomp1', name: '[BSRC] AI Compact Character Reference', parentId: 'templates' },
  { id: 'tplart01', name: '[BSRC] AI Character Art', parentId: 'templates' },
];
