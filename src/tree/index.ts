/**
 * Public surface of `src/tree` (v2 A2, docs/tree.md, ADR 0025): the repository tree of each project's AI REPOSITORY.
 *
 * ```ts
 * const tree = createTree({ db, engine, projects, clock });
 * tree.attach();   // follows the engine's writes (re-reads after each write that can change the tree)
 * tree.start();    // resumes an interrupted build, catches up owed re-reads
 * tree.queries.children(projectId, nodeId) // { tree: { status, confirmedAt, … }, data: [...] }
 * await tree.stop();
 * ```
 */
export {
  TreeService,
  TreeError,
  createTree,
  TREE_FOLLOWED_OPS,
  type TreeErrorCode,
  type TreeLogger,
  type TreeServiceOptions,
  type PassOutcome,
} from './service.js';
export { TreeQueries, type SubtreeEntry, type TreeCounts } from './queries.js';
export { TreeStore } from './store.js';
export {
  BARC_PREFIX,
  BSRC_PREFIX,
  BWRK_PREFIX,
  INDEX_PREFIX,
  KIND_PREFIX,
  PAGE_KINDS,
  catalogueFrom,
  classifyName,
  isPageKind,
  nameKey,
  observationFromListItem,
  observationFromResource,
  summariseSidebar,
  treeSettingsFrom,
  type TreeSettings,
} from './classify.js';
export * from './types.js';
