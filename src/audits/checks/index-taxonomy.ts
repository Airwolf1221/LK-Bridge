/**
 * v3 F6b (ADR 0079; design T12 step 2): the index classification carried out, category `taxonomy`, from the snapshots,
 * free. Only rows the owner APPROVED on the Index Classification page are checked (a proposal alone is never acted on).
 *
 * - `index_prefix` (warning): the page's prefix disagrees with its approved role (`[INDEX] Humans` approved as nav). The
 *   fix renames the prefix only: the display name, the id and every link stay (links are by id).
 * - `index_tags` (warning): the page's tags differ from T11's rule for its approved role: a `[NAV]` carries exactly the
 *   navigation tag; an `[INDEX]` exactly its subject's primary category; neither carries CANON. Reported only once the
 *   rule is in force: the approved version's tag section is the Tagging Standard's published one (a draft keeps the old
 *   rules in force). A subject index whose subject the owner did not give has no expected tags: no finding. Under
 *   Narratives the narrative tag grammar governs (the owner's ruling at the F6b review), so only the prefix is checked
 *   there.
 *
 * T11's ordering is the ordering check's (`out_of_order`), under the same approved version.
 */
import { indexRoleOfName, ROLE_PREFIX } from '../../tree/classify.js';
import { expectedIndexTags } from '../../packs/indextax/rules.js';
import { guardedIndexReason, type AuditContext } from '../context.js';
import type { FindingDraft } from '../types.js';

/** The Index Classification page's row for a page (the dashboard route). */
export const classificationRowLink = (pageId: string): string =>
  `/ui/index-classification?page=${encodeURIComponent(pageId)}`;

const sameTags = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((t, i) => t === b[i]);

export function indexTaxonomyCheck(ctx: AuditContext): FindingDraft[] {
  const it = ctx.indexTaxonomy;
  if (!it || it.approved.size === 0) return [];
  const out: FindingDraft[] = [];
  for (const [pageId, want] of it.approved) {
    const page = ctx.model.pages.get(pageId);
    if (!page || page.kind !== 'index') continue;
    const now = indexRoleOfName(page.rawName) ?? 'subject';
    const guarded = guardedIndexReason(ctx, page);
    if (now !== want.role) {
      const to = `${ROLE_PREFIX[want.role]}${page.displayName}`;
      // v3 F5b.2: a page the lifecycle guard always refuses is a finding with no fix (nothing to plan, nothing to skip).
      if (guarded || guardedIndexReason(ctx, page, to))
        out.push({
          code: 'index_prefix',
          pageId,
          message: `“${page.rawName}” is approved as a ${want.role === 'nav' ? 'navigation index ([NAV])' : 'subject index ([INDEX])'}, so its prefix should become ${ROLE_PREFIX[want.role].trim()}, but it is ${guarded ?? guardedIndexReason(ctx, page, to)}.`,
          evidence: {
            role: want.role,
            subject: want.subject,
            from: page.rawName,
            to,
            row: classificationRowLink(pageId),
          },
          fix: null,
        });
      else
        out.push({
          code: 'index_prefix',
          pageId,
          message: `“${page.rawName}” is approved as a ${want.role === 'nav' ? 'navigation index ([NAV])' : 'subject index ([INDEX])'}: its prefix becomes ${ROLE_PREFIX[want.role].trim()}, so the page reads “${to}” (its display name, id and links stay).`,
          evidence: {
            role: want.role,
            subject: want.subject,
            from: page.rawName,
            to,
            row: classificationRowLink(pageId),
          },
          fix: {
            kind: 'index_prefix',
            args: { pageId, name: page.rawName, to, role: want.role },
            summary: `Rename the prefix of ${page.displayName}: ${page.rawName} → ${to}.`,
          },
        });
    }
    if (!it.tagsInForce) continue;
    // The owner's ruling (F6b review): under Narratives the narrative tag grammar (Narrative + kind, + AU; ADR 0065)
    // governs story, continuity and act indexes, so T11's tags are never applied there (the prefix still is). The
    // Tagging Standard's section says so; without that line Narratives are excluded all the same.
    if (ctx.narrativeIds?.has(pageId)) continue;
    const expected = expectedIndexTags(it.rules, want.role, want.subject);
    if (!expected || sameTags(page.tags, expected)) continue;
    if (guarded) {
      out.push({
        code: 'index_tags',
        pageId,
        message: `“${page.rawName}” carries ${page.tags.length > 0 ? page.tags.join(', ') : 'no tags'}; as a ${want.role === 'nav' ? 'navigation index' : 'subject index'} it should carry exactly ${expected.join(', ')}, but it is ${guarded}.`,
        evidence: {
          role: want.role,
          subject: want.subject,
          current: [...page.tags],
          expected,
          row: classificationRowLink(pageId),
        },
        fix: null,
      });
      continue;
    }
    out.push({
      code: 'index_tags',
      pageId,
      message: `“${page.rawName}” carries ${page.tags.length > 0 ? page.tags.join(', ') : 'no tags'}; as a ${want.role === 'nav' ? 'navigation index it carries exactly' : 'subject index it carries exactly its subject’s primary category,'} ${expected.join(', ')} (and never CANON).`,
      evidence: {
        role: want.role,
        subject: want.subject,
        current: [...page.tags],
        expected,
        row: classificationRowLink(pageId),
      },
      fix: {
        kind: 'index_tags',
        args: {
          pageId,
          name: page.rawName,
          current: [...page.tags],
          proposed: expected,
          parentId: page.parentId,
        },
        summary: `Set the tags of ${page.displayName}: ${page.tags.join(', ') || '(none)'} → ${expected.join(', ')}.`,
      },
    });
  }
  return out;
}
