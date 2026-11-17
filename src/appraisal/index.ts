/**
 * The Arkona pack's appraisal tools and the full-text search (v3 F3c, ADR 0054; docs/design/F3c-appraisal.md):
 * read-only; a fix is always one ordinary proposal for the owner.
 */
export { Appraisal, PACK_ID, findingId, type AppraisalDeps, type ScopeInput } from './service.js';
export { AppraisalIndex, type IndexState, type OverlayPage } from './overlay.js';
export { FullText, ftsQueryOf, type Term, type TextHit } from './fts.js';
export { AppraisalStore, type RunView } from './store.js';
export { CHECKS, FIX_CHANGE, isCheckId, type CheckId } from './rules.js';
export {
  AREA_KEYS,
  NON_CURRENT_AREAS,
  labelContext,
  labelsOf,
  inScope,
  type AreaKey,
  type Labels,
} from './scope.js';
export type { FixResult } from './fixes.js';
export type { LiveRead } from './reader.js';
export {
  AppraisalError,
  APPRAISAL_TOOLS,
  GROUP_LABEL,
  TOOL_GROUPS,
  type AppraisalFinding,
  type AppraisalReport,
  type AppraisalTool,
  type FollowUp,
  type Group,
} from './types.js';
