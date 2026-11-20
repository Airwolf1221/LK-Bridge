/**
 * The audits' tag findings from the retag engine (v3 F3f, ADR 0060). On a project whose approved pack has retag rules,
 * the tags audit asks the SAME engine as `arkona_retag_audit` (src/packs/retag/engine.ts), so the two cannot disagree;
 * the tag-definition document is not consulted there. The finding codes are the old ones, plus two:
 *
 * - `missing_required_tags`: a tag the proposed array holds that the page lacks (a culture token, a specialist backed by
 *   the pack record or the owner's classification). No fix here: the guarded apply is `arkona_retag_apply`.
 * - `tags_outside_definition`: a tag the page holds outside the grammar (an Excluded Routine Tag to remove, or an owner
 *   exception kept).
 * - `duplicate_tags`: the same tag twice.
 * - `tags_out_of_order` (new): the same tags in another order than the grammar's (the status tag first).
 * - `tags_held` (new): the engine holds the page (an uncertain category, a specialist, an identity or a status slot).
 *
 * Working and Archived pages are the lifecycle check's (`lifecycle_tag_not_leading`); excluded pages get nothing.
 */
import { canonExemptionOfPage, areaOf } from '../../lifecycle/settings.js';
import { retagPage, type RetagVerdict } from '../../packs/retag/engine.js';
import { sameTag } from '../../lifecycle/tags.js';
import { ownedPages, type AuditContext } from '../context.js';
import type { FindingDraft } from '../types.js';

/** The engine's verdict for every content page of the audit's model (free: the snapshots). */
export function retagVerdicts(ctx: AuditContext): RetagVerdict[] {
  const hook = ctx.retag;
  if (!hook) return [];
  const lc = ctx.lifecycle;
  const ids = { workingIndexId: lc.workingIndexId, archiveIndexId: lc.archiveIndexId };
  const out: RetagVerdict[] = [];
  // v3 F4c: the tagging grammar leaves Narratives alone (E2: the tools set narrative tags).
  for (const p of ownedPages(ctx)) {
    const node = ctx.snapshotTree.node(p.id);
    if (!node) continue;
    const area = areaOf(node, ids);
    out.push(
      retagPage(
        {
          id: p.id,
          rawName: p.rawName,
          kind: p.kind,
          tags: p.tags,
          facts: p.facts,
          lifecycle: area === 'working' ? 'Working' : area === 'archived' ? 'Archived' : null,
          ancestors: node.path.names.slice(0, -1),
          area: canonExemptionOfPage(lc, node) ? 'design' : null,
          templateId: hook.templateOf(p.id),
          packRecord: hook.packRecord(p.id),
          owner: hook.owner(p.id),
        },
        hook.context,
      ),
    );
  }
  return out;
}

export function retagTagFindings(ctx: AuditContext): FindingDraft[] {
  const out: FindingDraft[] = [];
  const policy = ctx.retag?.policy;
  for (const v of retagVerdicts(ctx)) {
    if (v.scope !== 'grammar') continue;
    const evidence = {
      engine: 'retag',
      disposition: v.disposition,
      current: v.current,
      proposed: v.proposed,
      ...(policy ? { policy: { version: policy.version, digest: policy.digest } } : {}),
    };
    if (v.disposition === 'hold') {
      out.push({
        code: 'tags_held',
        pageId: v.pageId,
        message: `Held for the owner: ${v.holds.map((h) => h.reason).join('; ')}.`,
        evidence: { ...evidence, holds: v.holds },
      });
      continue;
    }
    const dupes = v.removals.filter((r) => r.why.startsWith('a duplicate')).map((r) => r.tag);
    if (dupes.length > 0)
      out.push({
        code: 'duplicate_tags',
        pageId: v.pageId,
        message: `The page carries ${dupes.map((d) => `“${d}”`).join(', ')} more than once.`,
        evidence: { ...evidence, duplicates: dupes, tags: v.current },
      });
    const missing = v.proposed.filter((t) => !v.current.some((c) => sameTag(c, t)));
    if (missing.length > 0)
      out.push({
        code: 'missing_required_tags',
        key: 'retag',
        pageId: v.pageId,
        message: `The closed grammar requires the tag${missing.length > 1 ? 's' : ''} ${missing.map((t) => `“${t}”`).join(', ')} (${v.slots
          .filter((s) => s.tag !== null && missing.some((m) => sameTag(m, s.tag)))
          .map((s) => s.source)
          .join('; ')}). The guarded apply is arkona_retag_apply.`,
        evidence: { ...evidence, missing, tags: v.current },
      });
    const removed = v.removals.filter((r) => !r.why.startsWith('a duplicate'));
    const outside = [
      ...removed.map((r) => ({ tag: r.tag, why: r.why })),
      ...v.exceptions.map((e) => ({ tag: e.tag, why: e.reason })),
    ];
    if (outside.length > 0)
      out.push({
        code: 'tags_outside_definition',
        key: 'retag',
        pageId: v.pageId,
        message: `Outside the closed grammar: ${outside.map((o) => `“${o.tag}” (${o.why})`).join('; ')}.`,
        evidence: { ...evidence, outside: outside.map((o) => o.tag), reasons: outside },
      });
    const sameSet =
      missing.length === 0 &&
      outside.length === 0 &&
      dupes.length === 0 &&
      v.current.join('\u0000') !== v.proposed.join('\u0000');
    if (sameSet)
      out.push({
        code: 'tags_out_of_order',
        pageId: v.pageId,
        message: `The tags are in another order than the grammar’s: ${v.current.join(', ')} → ${v.proposed.join(', ')} (the status tag first). The guarded apply is arkona_retag_apply.`,
        evidence,
      });
  }
  return out;
}
