/** v2 E2 (ADR 0044): the audits. Findings only, read from the snapshots. */
export * from './types.js';
export * from './config.js';
export { AuditStore, fingerprintOf, evidenceHashOf, type FindingFilter, type StoredDraft } from './store.js';
export { AuditError } from './errors.js';
export { Audits, CHECKS, type AuditDeps, type AuditOutcome } from './service.js';
export { buildModel, sourceOf, type AuditModel, type SnapshotSource } from './reader.js';
export {
  SPLIT_CHECK,
  SPLIT_VERIFY,
  splitChecker,
  splitVerifier,
  paragraphParts,
  proposeFix,
  type FixResult,
} from './fixes.js';
