/**
 * v3 F5a (ADR 0067; the owner-approved design, H10): the audits' `writes` category. A write whose outcome stayed
 * unknown after the reconciler (src/jobs/reconcile.ts) read its target back for about five minutes is shown to the owner
 * here, with the pre-image and the intended change, so it never sits unreconciled. Report only, from the bridge's own
 * journal: no LegendKeeper read, no fix (the owner compares the page with what was there and what was sent, and
 * restores from the pre-image by hand if needed).
 */
import type { Check } from '../context.js';
import type { FindingDraft } from '../types.js';

/** Caps what a finding carries of a pre-image or a body (the journal keeps the whole). */
const cap = (v: unknown, max = 4000): unknown => {
  if (v === null || v === undefined) return null;
  const text = JSON.stringify(v);
  return text.length <= max ? v : { truncated: true, preview: text.slice(0, max) };
};

export const writesCheck: Check = (ctx) => {
  const out: FindingDraft[] = [];
  for (const w of ctx.unknownWrites ?? []) {
    out.push({
      code: 'write_outcome_unknown',
      key: `journal:${w.journalId}`,
      pageId: w.resourceId,
      documentId: w.documentId,
      message:
        `${w.opId} (journal entry ${w.journalId}, ${new Date(w.at).toISOString()}, by ${w.profile}) may or may not have ` +
        `applied: after ${w.attempts} read-back${w.attempts === 1 ? '' : 's'} the bridge could not tell` +
        `${w.reason ? ` (${w.reason})` : ''}. Compare the page with the pre-image and the intended change below; ` +
        'bridge_journal_lookup gives the whole entry.',
      evidence: {
        journalId: w.journalId,
        at: new Date(w.at).toISOString(),
        operation: w.opId,
        jobId: w.jobId,
        stepNo: w.stepNo,
        principalId: w.principalId,
        profile: w.profile,
        target: w.targetId,
        basedOnVersion: w.version,
        highLevel: cap(w.operation, 2000),
        intendedChange: cap(w.intended),
        preImage: cap(w.preImage),
      },
      sourceKind: 'bridge',
    });
  }
  return out;
};
