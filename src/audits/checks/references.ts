/**
 * Internal references, unclassified pages and ordering (v2 E2, ADR 0044; PLAN-v2 4.5 and 4.12).
 *
 * **References.** Every mention and collection item (in the sidebar and in page documents) that points at a page or a
 * document that is missing, deleted or inaccessible. The three stay distinct, and a page's absence from the snapshot
 * does not prove it was deleted (a 404 does not either); the bridge's own knowledge decides:
 *
 * - `deleted_target`: proven gone: a change snapshot recorded its deletion, or the tree's own pass found it deleted;
 * - `inaccessible_target`: it may exist but the audits cannot see it: a template (outside the AI REPOSITORY), a page the
 *   snapshots once held that is no longer in the repository with no deletion on record (deleted in the app, or moved
 *   out), or a page the tree found gone without proof (a 404 on a re-read);
 * - `missing_target`: nothing the bridge has ever seen has that id, or the page exists but not the document named.
 *
 * New: an Authoritative page that links to an Archived (`[BARC]`) page is a warning, `canon_refers_to_archived`: the
 * archive tool flags related pages at the time, and this catches them later.
 *
 * **Unclassified pages** have no recognised prefix. **Ordering**: children of an index that are not in the registry's
 * alphabetical order (`[INDEX]` first, then pages, then unclassified; a case-insensitive, numeric-aware compare),
 * reported and never moved; the fix is `move_resource` under the same parent.
 */
import { outOfOrderAmong } from '../../registry/ordering.js';
import { contentPages, fact, pathOf, type AuditContext } from '../context.js';
import type { AuditPage, Ref } from '../model.js';
import { childrenByRank } from '../snapshot-tree.js';
import type { FindingDraft } from '../types.js';

type TargetState =
  { readonly state: 'ok' } | { readonly state: 'missing' | 'deleted' | 'inaccessible'; readonly why: string };

export function targetState(ctx: AuditContext, id: string, documentId: string | null): TargetState {
  const page = ctx.model.pages.get(id);
  if (page) {
    if (documentId !== null && !page.documents.some((d) => d.id === documentId))
      return {
        state: 'missing',
        why: `“${page.displayName}” exists but has no document ${documentId} in the snapshot.`,
      };
    return { state: 'ok' };
  }
  const gone = ctx.model.deleted.get(id);
  if (gone)
    return {
      state: 'deleted',
      why: `A change snapshot (${gone.snapshotId}) recorded “${gone.name}” as deleted.`,
    };
  const t = ctx.tombstone(id);
  if (t) {
    if (t.reason === 'deleted' || t.reason.startsWith('its ancestor was deleted'))
      return { state: 'deleted', why: `The repository tree found it deleted (${t.reason}).` };
    return {
      state: 'inaccessible',
      why: `The repository tree could not find it (${t.reason}); a 404 does not prove it was deleted.`,
    };
  }
  if (ctx.model.templates?.has(id) || ctx.knownTemplateIds.has(id))
    return {
      state: 'inaccessible',
      why: 'It is a template: outside the AI REPOSITORY, so outside the audits.',
    };
  const seen = ctx.everSeen(id);
  if (seen?.deleted)
    return { state: 'deleted', why: `The snapshots recorded “${seen.name ?? id}” as deleted.` };
  if (seen)
    return {
      state: 'inaccessible',
      why: `The snapshots once held “${seen.name ?? id}”, which is no longer in the repository, with no deletion on record (deleted in the LegendKeeper app, or moved out).`,
    };
  return { state: 'missing', why: 'No snapshot, tree pass or template list knows a page with this id.' };
}

const place = (r: Ref): string =>
  r.via.where === 'sidebar'
    ? r.via.kind === 'collection'
      ? `the “${r.via.property}” collection`
      : `the “${r.via.property}” row “${r.via.row}”`
    : `${r.via.kind === 'collection' ? 'a collection' : 'a mention'} in document ${r.via.documentId}${r.via.blockId ? ` (block ${r.via.blockId})` : ''}`;

export function referencesCheck(ctx: AuditContext): FindingDraft[] {
  const out: FindingDraft[] = [];
  const authoritative = ctx.lifecycle.status.authoritative.trim().toLowerCase();
  for (const p of contentPages(ctx)) {
    // One finding per (page, target, document): the places are evidence.
    const byTarget = new Map<string, { ref: Ref; where: string[] }>();
    for (const r of p.refs) {
      if (r.resourceId === p.id && r.documentId === null) continue; // a page pointing at itself
      const k = `${r.resourceId}|${r.documentId ?? ''}`;
      const got = byTarget.get(k) ?? { ref: r, where: [] };
      got.where.push(place(r));
      byTarget.set(k, got);
    }
    const isCanon =
      p.kind === 'bsrc' && (fact(ctx, p, ctx.lifecycle.fields.status) ?? '').toLowerCase() === authoritative;
    for (const { ref, where } of byTarget.values()) {
      const t = targetState(ctx, ref.resourceId, ref.documentId);
      if (t.state !== 'ok') {
        out.push({
          code:
            t.state === 'missing'
              ? 'missing_target'
              : t.state === 'deleted'
                ? 'deleted_target'
                : 'inaccessible_target',
          key: `${ref.resourceId}|${ref.documentId ?? ''}`,
          pageId: p.id,
          message: `${p.displayName} links to ${ref.resourceId}${ref.documentId ? ` / ${ref.documentId}` : ''} (${[...new Set(where)].slice(0, 3).join('; ')}): ${t.why}`,
          evidence: {
            target: ref.resourceId,
            document: ref.documentId,
            state: t.state,
            why: t.why,
            places: [...new Set(where)].slice(0, 20),
          },
        });
        continue;
      }
      const target = ctx.model.pages.get(ref.resourceId);
      if (isCanon && target && target.kind === 'barc' && target.id !== p.id) {
        out.push({
          code: 'canon_refers_to_archived',
          key: target.id,
          pageId: p.id,
          message: `${p.displayName} (Authoritative) links to ${target.displayName}, which is Archived (${[...new Set(where)].slice(0, 3).join('; ')}).`,
          evidence: {
            target: { id: target.id, name: target.rawName, path: pathOf(ctx, target) },
            places: [...new Set(where)].slice(0, 20),
          },
        });
      }
    }
  }
  return out;
}

// ============================================================================================ unclassified

export function unclassifiedCheck(ctx: AuditContext): FindingDraft[] {
  return contentPages(ctx)
    .filter((p) => p.kind === 'unclassified')
    .map((p) => ({
      code: 'unclassified_page' as const,
      pageId: p.id,
      message: `“${p.rawName}” has no [INDEX], [BSRC], [BWRK] or [BARC] prefix.`,
      evidence: { rawName: p.rawName, parent: p.parentId },
    }));
}

// ============================================================================================ ordering

export function orderingCheck(ctx: AuditContext): FindingDraft[] {
  const out: FindingDraft[] = [];
  const manual = new Set(ctx.settings.manualOrderIndexes);
  const kids = childrenByRank(ctx.model);
  for (const parent of ctx.model.pages.values()) {
    if (parent.kind !== 'index' || manual.has(parent.id)) continue;
    const siblings = kids.get(parent.id) ?? [];
    if (siblings.length < 2) continue;
    const orderable = siblings.map((s) => ({
      id: s.id,
      displayName: s.displayName,
      kind: s.kind as 'index',
    }));
    const bad = outOfOrderAmong(orderable);
    const byId = new Map(siblings.map((s) => [s.id, s]));
    for (const b of bad) {
      const page = byId.get(b.node.id) as AuditPage;
      const now = siblings.findIndex((s) => s.id === page.id);
      out.push({
        code: 'out_of_order',
        pageId: page.id,
        message: `“${page.rawName}” is out of alphabetical order under “${parent.displayName}”: it belongs ${b.belongsAfter ? `after “${b.belongsAfter.displayName}”` : 'first'}.`,
        evidence: {
          parent: { id: parent.id, name: parent.rawName },
          position: now + 1,
          siblings: siblings.length,
          belongsAfter: b.belongsAfter
            ? { id: b.belongsAfter.id, name: byId.get(b.belongsAfter.id)?.rawName }
            : null,
        },
        fix: {
          kind: 'move_resource',
          args: { pageId: page.id, parentId: parent.id },
          summary: `Re-place ${page.displayName} alphabetically under ${parent.displayName}.`,
        },
      });
    }
  }
  return out;
}
