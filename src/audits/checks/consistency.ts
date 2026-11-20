/**
 * v3 F4b (ADR 0064, design D5): the audits' `consistency` category. Only **Contradictory** pairs (Authoritative against
 * Authoritative) become findings; Working proposals, gaps and historical material stay in `arkona_consistency`. A pure
 * function of its context: the consistency service compares the facts read from the same snapshots and hands the
 * Contradictory ones in. Stable codes (`consistency_birth`, `consistency_death`, `consistency_identity`,
 * `consistency_chronology`), each finding keyed by its consistency id, so it clears when the pages agree.
 */
import type { AuditContext } from '../context.js';
import type { FindingDraft } from '../types.js';

export function consistencyCheck(ctx: AuditContext): FindingDraft[] {
  return (ctx.consistency ?? []).map((c) => ({
    code: c.code,
    key: c.id,
    pageId: c.pageId,
    message: c.message,
    evidence: { consistencyId: c.id, ...c.evidence },
  }));
}
