/**
 * v3 F4b (ADR 0064, design D5): the "consistency" line of `arkona_brief` (and of the character brief it delegates to): the
 * open Contradictory findings of the nightly audit's `consistency` category that involve the subject's pages (the identity
 * page's value or a restatement on one of them). Free: the audits' store. It never decides which side is right.
 */
import type { Audits } from '../audits/index.js';

type Obj = Record<string, unknown>;

export function consistencyLine(
  audits: Pick<Audits, 'store'> | undefined,
  projectId: string,
  pageIds: ReadonlySet<string>,
): Obj {
  if (!audits) return { open: 0, note: 'The audits are not available here.' };
  const all = audits.store.list(projectId, { category: ['consistency'], state: 'open', limit: 500 }).findings;
  const mine = all.filter((f) => {
    const pages = Array.isArray(f.evidence.pages) ? (f.evidence.pages as unknown[]) : [];
    return (
      (f.pageId !== null && pageIds.has(f.pageId)) ||
      pages.some((p) => typeof p === 'string' && pageIds.has(p))
    );
  });
  const value = (v: unknown) => {
    const o = (v ?? {}) as Obj;
    const page = (o.page ?? {}) as Obj;
    return { value: o.value ?? null, page: page.name ?? null, lifecycle: o.lifecycle ?? null };
  };
  return {
    open: mine.length,
    contradictions: mine.slice(0, 20).map((f) => ({
      auditFinding: f.id,
      consistencyId: f.evidence.consistencyId ?? null,
      code: f.code,
      subject: f.evidence.subject ?? null,
      what: f.evidence.what ?? null,
      values: [f.evidence.reference, ...((f.evidence.restatements as unknown[] | undefined) ?? [])].map(
        value,
      ),
    })),
    ...(mine.length > 20 ? { more: mine.length - 20 } : {}),
    note:
      mine.length > 0
        ? 'Authoritative pages disagree here: do not write on these values until the owner picks the right one (the dashboard’s “Pick the right value”). arkona_consistency shows the details.'
        : 'No open contradiction involves these pages (as of the last audit).',
  };
}
