/**
 * Public surface of `src/assets` (v2 A4, docs/assets.md, ADR 0027): the asset tree of each project's asset library.
 *
 * ```ts
 * const assets = createAssets({ db, engine, projects, clock, tree });
 * assets.attach();   // follows the engine's asset writes (a re-read after createAssetFolder, createImageAsset, …)
 * assets.start();    // resumes an interrupted build, catches up owed re-reads
 * assets.queries.findFoldersByName(projectId, 'Qishen') // { tree: { status, confirmedAt, … }, data: [...] }
 * assets.plan(projectId, { characterName: 'Mehrana al-Khalid' }) // placement, no writes
 * await assets.stop();
 * ```
 */
export {
  AssetService,
  AssetError,
  ASSET_FOLLOWED_OPS,
  createAssets,
  type AssetErrorCode,
  type AssetLogger,
  type AssetPassOutcome,
  type AssetServiceOptions,
} from './service.js';
export { AssetQueries, type SubtreeFolder } from './queries.js';
export { AssetStore } from './store.js';
export {
  FOLDER_TYPE,
  assetSettingsFrom,
  nameKey,
  observationFromAsset,
  type AssetSettings,
} from './classify.js';
export {
  DEFAULT_CHARACTER_ASSET_ROOT,
  UNKNOWN_RACE_FOLDER,
  planAssetDestination,
  type AssetPlan,
  type PlanDeps,
  type PlanError,
  type PlanErrorCode,
  type PlanRequest,
  type PlanResult,
  type PlanStep,
} from './plan.js';
export * from './types.js';
