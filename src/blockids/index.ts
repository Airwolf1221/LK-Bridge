/**
 * Public surface of `src/blockids` (v3 F3.5, ADR 0056): the block-id sweep, an approved narrow automation that gives
 * legacy page documents block ids (`assign-block-ids-sweep`), its rules, its statement and the canon guard's exception.
 */
export {
  BlockIdSweep,
  BlockIdSweepError,
  EXPECT_CHECK,
  VERIFY_CHECK,
  READS_PER_DOCUMENT,
  type BlockIdSweepDeps,
  type DryRun,
  type Prerequisite,
  type PlannedDocument,
  type ProjectCard,
  type SweepCard,
  type SweepRunResult,
} from './service.js';
export {
  isLegacy,
  legacyProblems,
  unsupportedCount,
  verifyAssigned,
  withoutBlockIds,
  type BlockIdDifference,
  type BlockIdVerification,
  type LegacyProblems,
} from './detect.js';
export { scanCandidates, type Candidate, type CandidateScan, type SnapshotOverlay } from './candidates.js';
export { AUTOMATION_STATEMENT, SWEEP_JOB_ID, type StatementPoint } from './statement.js';
export { isBlockIdSweepRequest } from './guard.js';
export {
  BlockIdStore,
  type DocRecord,
  type DocStatus,
  type SandboxVerdict,
  type StopRecord,
} from './store.js';
