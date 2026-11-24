/**
 * v3 F6a (ADR 0076; design T3, first half): the Reference Type checks (category `taxonomy`), from the snapshots, free.
 *
 * - `reference_type_noncanonical` (info): a page's Reference Type is not in the vocabulary in force (the approved pack
 *   version's, plus the owner's decisions not published yet).
 *   - An approved mapping (the owner's decision): the finding carries the fix, which sets ONE sidebar field (Reference
 *     Type) to the mapped value through the governed facts path (src/audits/fixes.ts `reference_type`).
 *   - No decision (`open`): a judgement for the owner, linked to the value's row on the Reference Types page; no fix.
 *   - Rejected, or a specialist type covering the page: no finding.
 *   - A decision the published section contradicts: reported with the conflict, no fix (the section wins).
 * - `reference_type_category_mismatch` (info, judgement): the Reference Type is canonical in another primary
 *   category's list than the page's primary category tag. Both are shown; no fix (T7: the owner rules).
 *
 * Out of scope: the Legacy Canon Archive, the Design References, Working, Archived and Narratives pages (a Working page
 * is checked at promotion, by promote_page's preview).
 */
import { labelContext, labelsOf } from '../../appraisal/scope.js';
import { categoryFromTags, vocabularyOf } from '../../packs/retag/engine.js';
import { canonicalIndex, isSpecialist, type ReferenceTypeAuditInput } from '../../packs/reftypes/service.js';
import { suggest } from '../../packs/reftypes/suggest.js';
import { typeKey } from '../../packs/reftypes/vocabulary.js';
import { contentPages, fact, factAmbiguous, isNarrativePage, type AuditContext } from '../context.js';
import { nameKey, type AuditPage } from '../model.js';
import type { FindingDraft } from '../types.js';

/** The Reference Types page's row for a value (the dashboard route). */
export const mappingRowLink = (value: string, category: string): string =>
  `/ui/reference-types?value=${encodeURIComponent(value)}&category=${encodeURIComponent(category)}`;

/** Whether a page is in the checks' scope (and the report's): not in a non-current area, not Working, Archived, narrative. */
export function inReferenceTypeScope(ctx: AuditContext, p: AuditPage): boolean {
  if (p.kind !== 'bsrc' && p.kind !== 'bwrk' && p.kind !== 'barc') return false;
  if (isNarrativePage(ctx, p.id)) return false;
  const n = ctx.snapshotTree.node(p.id);
  if (!n) return false;
  const kinds = n.path.ids.map((id) => ctx.model.pages.get(id)?.kind ?? '');
  const l = labelsOf(
    { ids: n.path.ids, names: n.path.names, kinds },
    labelContext(ctx.model.rootId, ctx.lifecycle),
  );
  return l.area === null && l.lifecycle !== 'Working' && l.lifecycle !== 'Archived';
}

export function referenceTypesCheck(ctx: AuditContext): FindingDraft[] {
  const input = ctx.referenceTypes;
  if (!input) return [];
  return checkWith(ctx, input);
}

function checkWith(ctx: AuditContext, input: ReferenceTypeAuditInput): FindingDraft[] {
  const out: FindingDraft[] = [];
  const rt = input.rules.referenceTypes!;
  const lists = input.effective.lists;
  const canon = canonicalIndex(lists);
  const vocab = vocabularyOf(input.rules);
  const decisions = new Map(input.decisions.map((d) => [`${d.value}\u0000${typeKey(d.category)}`, d]));
  const row = ctx.treeSettings.referenceTypeRow;
  for (const p of contentPages(ctx)) {
    if (!inReferenceTypeScope(ctx, p)) continue;
    if (factAmbiguous(p, row)) continue;
    const value = fact(ctx, p, row);
    if (value === null) continue;
    const c = categoryFromTags(p.tags, vocab);
    const category = 'primary' in c ? c.primary : '';
    const rowKey = p.facts.get(nameKey(row))?.key ?? row;
    const there = canon.get(value);
    if (there) {
      if (category !== '' && typeKey(there.category) !== typeKey(category))
        out.push({
          code: 'reference_type_category_mismatch',
          key: value,
          pageId: p.id,
          message: `The Reference Type “${value}” is a ${there.category} type, but the page’s primary category tag is ${category}. Which one is right is the owner’s to rule: the page’s tag, or its Reference Type.`,
          evidence: {
            referenceType: value,
            typeCategory: there.category,
            pageCategory: category,
            role: there.role,
          },
        });
      continue;
    }
    const d = decisions.get(`${value}\u0000${typeKey(category)}`) ?? null;
    if (d?.action === 'reject') continue;
    if (d?.action === 'specialist' && (d.pages === null || d.pages.some((x) => x.id === p.id))) continue;
    if (category !== '' && isSpecialist(lists, value, category, p.id)) continue;
    const conflict = d ? (input.effective.conflicts.get(d.id) ?? null) : null;
    const link = mappingRowLink(value, category);
    if (d?.action === 'map' && d.target !== null && conflict === null) {
      out.push({
        code: 'reference_type_noncanonical',
        key: value,
        pageId: p.id,
        message: `The Reference Type “${value}” is not in the vocabulary; the owner mapped it to “${d.target}”. The fix sets Reference Type to “${d.target}” (one field, through set_facts).`,
        evidence: {
          referenceType: value,
          category: category || null,
          status: 'mapped',
          mappedTo: d.target,
          decision: d.id,
          link,
        },
        fix: {
          kind: 'reference_type',
          args: {
            pageId: p.id,
            facts: { [rowKey]: d.target },
            expectedCurrent: { [rowKey]: value },
            decisionId: d.id,
            value,
            category,
          },
          summary: `Set ${rowKey} to “${d.target}” on ${p.displayName} (the owner’s mapping).`,
        },
      });
      continue;
    }
    const s = suggest(value, category || null, lists, rt.normalise);
    out.push({
      code: 'reference_type_noncanonical',
      key: value,
      pageId: p.id,
      message: conflict
        ? `The Reference Type “${value}” is not in the vocabulary, and the owner’s mapping conflicts with the published section (${conflict}). Decide it again on the Reference Types page.`
        : `The Reference Type “${value}” is not in the vocabulary${s.value ? ` (suggested: “${s.value}”)` : ''}. Decide it on the Reference Types page: accept, choose another value, reject, or keep it as specialist.`,
      evidence: {
        referenceType: value,
        category: category || null,
        status: conflict ? 'conflict' : 'open',
        ...(conflict ? { conflict, decision: d!.id } : {}),
        suggestion: s.value,
        reason: s.reason,
        candidates: s.candidates.map((x) => x.name),
        link,
      },
    });
  }
  return out;
}
