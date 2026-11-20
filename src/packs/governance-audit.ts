/**
 * v3 F4a (ADR 0063): what the audits' governance check needs of the setting packs for one project.
 *
 * The drift rules (`governanceAudit`: the old bridge's call shapes, the equivalence map, the sections checked for
 * missing references) come from the version of the pack the owner APPROVED, as every report-only reading of a pack does
 * since CR-2026-11-R2 (R2-32); from the current version only while none is approved. The governance documents are the
 * tabs of the pages the pack's governance sources sit on in THIS project (Arkona's AI REPOSITORY root): the check reads
 * every one of them from the snapshots, the pinned sections included, not only the three sources the pack pins.
 */
import type { KnownNames } from '../audits/checks/governance.js';
import type { GovernanceAuditHook } from '../audits/service.js';
import type { Pack, PackRules } from './types.js';

/** The rules of the version the owner approved (null: none approved, or that version's rules cannot be read). */
export function approvedRulesOf(
  pack: Pack,
  rulesAt: (packId: string, version: number) => PackRules | null,
): PackRules | null {
  if (!pack.approved) return null;
  if (pack.approved.version === pack.version) return pack.rules;
  try {
    return rulesAt(pack.id, pack.approved.version);
  } catch {
    return null;
  }
}

/** The rules a report-only tool reads: the approved version's, else (none approved yet) the current version's. */
export function reportRulesOf(
  pack: Pack,
  rulesAt: (packId: string, version: number) => PackRules | null,
): PackRules {
  return approvedRulesOf(pack, rulesAt) ?? pack.rules;
}

/**
 * The governance check's hook for a project: the first attached pack (by id) whose rules have drift rules and whose
 * governance sources sit in this project. Null when there is none, or when the bridge's tool list is not ready (an empty
 * registry would make every name look unknown: the check is skipped rather than wrong).
 */
export function governanceAuditHook(o: {
  readonly packs: readonly Pack[];
  readonly rulesAt: (packId: string, version: number) => PackRules | null;
  /** The project's name (governance sources name their project by name). */
  readonly projectName: string | null;
  readonly known: () => KnownNames;
}): GovernanceAuditHook | null {
  if (!o.projectName) return null;
  const here = o.projectName.toLowerCase();
  for (const pack of [...o.packs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const rules = reportRulesOf(pack, o.rulesAt);
    if (!rules.governanceAudit) continue;
    const roots = [
      ...new Set(pack.governance.filter((g) => g.project.toLowerCase() === here).map((g) => g.resourceId)),
    ];
    if (roots.length === 0) continue;
    const known = o.known();
    if (known.tools.size === 0) return null;
    return { rules: rules.governanceAudit, packName: pack.name, roots, known };
  }
  return null;
}
