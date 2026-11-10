/**
 * `src/facts` (v2 C2a, ADR 0032): sidebar facts and relationship links, and the protected canonical facts rule.
 *
 * - `assessFactChange(rules, before, after)`: the shared canonical check (pure). C2b's tools call it before they write.
 * - `CanonicalGuard`: the engine's write guard, on every write path (src/jobs/write-guard.ts).
 * - `canonConfigFrom(settings)`: a project's rules and the default status for pages agents create.
 * - the set_facts planner (plan.ts) and its expansion into one job (expand.ts).
 */
export {
  assessDelete,
  assessFactChange,
  CASCADE_READ_LIMIT,
  canonicalReason,
  CanonicalGuard,
  type CanonicalGuardDeps,
  type FactValue,
  type ProtectedChange,
} from './canonical.js';
export {
  canonConfigFrom,
  canonicalRuleSchema,
  canonicalRulesSchema,
  DEFAULT_AGENT_STATUS,
  DEFAULT_CANONICAL_RULES,
  DEFAULT_DELETE_RULE,
  factKey,
  type CanonConfig,
  type CanonicalRule,
} from './rules.js';
export {
  SIDEBAR_WRITE_OPS,
  applySidebarWrite,
  factRows,
  sidebarFrom,
  valueSignature,
  valueText,
  type Sidebar,
  type SidebarProperty,
  type SidebarRow,
} from './sidebar.js';
