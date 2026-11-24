/**
 * v3 F7d (ADR 0077, A10): `owner_identity_copy_drift` (category `taxonomy`), from the snapshots, free. A character's
 * identity page (its Character Core, or its Compact Character Reference) owns its identity; the other pages of its set
 * (every page under its index: the Art page, the specialists) carry COPIES of some of it in their sidebar. A finding is a
 * page whose copies are empty or differ from the identity page, field by field with both values.
 *
 * - The copyable fields: Subject, Canonical Display Name, Family / Surname, Personal / Given Name, Naming Culture,
 *   Aliases (F7d's A8 list), and only those the page's own sidebar has (its template's rows). Never Temporal Scope,
 *   Race / Species or Life State: they are not copies. A field the identity page leaves empty is not judged.
 * - A relationship page (two characters') is not a copy of one identity: left out.
 * - Fix (`identity_copy`): ONE governed set_facts per page, copying the identity page's values read live (FIX_STALE
 *   when either page changed since the audit). Automation: default Propose; Apply allowed when the owner switches it.
 *
 * This repairs pages made before F7d (Iuno - Character Art, whose copies the bridge left empty) and keeps copies in step
 * after a rename or an identity change.
 */
import { key as nkey, subjectOf } from '../../registry/names.js';
import { contentPages, fact, factAmbiguous, type AuditContext } from '../context.js';
import type { AuditPage } from '../model.js';
import type { FindingDraft } from '../types.js';

/** The copyable identity fields (A8's list), in sidebar order. */
export const IDENTITY_COPY_FIELDS: readonly string[] = [
  'Subject',
  'Canonical Display Name',
  'Family / Surname',
  'Personal / Given Name',
  'Naming Culture',
  'Aliases',
];

const isPage = (p: AuditPage) => p.kind === 'bsrc' || p.kind === 'bwrk';

export function identityCopyDrift(ctx: AuditContext): FindingDraft[] {
  const out: FindingDraft[] = [];
  const children = new Map<string, AuditPage[]>();
  for (const p of ctx.model.pages.values())
    if (p.parentId) children.set(p.parentId, [...(children.get(p.parentId) ?? []), p]);
  const rtRow = ctx.treeSettings.referenceTypeRow;
  const kinds = new Set<string>();
  const relationshipTypes = new Set<string>();
  for (const type of ctx.types) {
    if (!type.placement) continue;
    kinds.add(nkey(type.placement.referenceTypes.core));
    kinds.add(nkey(type.placement.referenceTypes.compact));
  }
  relationshipTypes.add(nkey('Joint Character Relationship Reference'));
  if (kinds.size === 0) return out;
  for (const id of contentPages(ctx)) {
    if (!isPage(id)) continue;
    const rt = fact(ctx, id, rtRow);
    if (rt === null || !kinds.has(nkey(rt))) continue;
    const index = id.parentId ? ctx.model.pages.get(id.parentId) : undefined;
    if (!index || index.kind !== 'index') continue;
    // The index's own identity page: named for it by its Subject, its Canonical Display Name or its page name (a
    // renamed identity, whose Canonical Display Name has moved on, is still the one its index holds).
    const names = [
      fact(ctx, id, 'Subject'),
      fact(ctx, id, 'Canonical Display Name'),
      subjectOf(id.displayName, null),
    ];
    if (!names.some((n) => n && nkey(n) === nkey(index.displayName))) continue;
    const subject = index.displayName;
    // The identity page's values (an ambiguous one is not judged).
    const theirs = new Map<string, string>();
    for (const k of IDENTITY_COPY_FIELDS) {
      if (factAmbiguous(id, k)) continue;
      const v = fact(ctx, id, k);
      if (v !== null) theirs.set(k, v);
    }
    if (theirs.size === 0) continue;
    // Every page of the set: under the index, nested indexes walked, relationship pages left out.
    const set: AuditPage[] = [];
    const queue = [...(children.get(index.id) ?? [])];
    while (queue.length > 0) {
      const c = queue.shift()!;
      if (c.kind === 'index') queue.push(...(children.get(c.id) ?? []));
      else if (isPage(c) && c.id !== id.id) set.push(c);
    }
    for (const p of set) {
      const prt = fact(ctx, p, rtRow);
      if (prt !== null && relationshipTypes.has(nkey(prt))) continue;
      if (/ & /.test(p.displayName)) continue;
      const fields: { key: string; page: string; identity: string }[] = [];
      const facts: Record<string, string> = {};
      const expectedCurrent: Record<string, string> = {};
      for (const [k, v] of theirs) {
        const f = p.facts.get(nkey(k));
        if (!f || f.count > 1) continue; // the template has no such row (or it is ambiguous): not judged
        const mine = f.text.trim();
        if (mine === v) continue;
        fields.push({ key: f.key, page: mine, identity: v });
        facts[f.key] = v;
        expectedCurrent[f.key] = mine;
      }
      if (fields.length === 0) continue;
      const empty = fields.filter((f) => f.page === '').length;
      out.push({
        code: 'owner_identity_copy_drift',
        key: `${id.id}:${p.id}`,
        pageId: p.id,
        message: `${p.rawName} copies ${subject}'s identity from ${id.rawName}, but ${fields.length} field${fields.length === 1 ? '' : 's'} ${fields.length === 1 ? 'is' : 'are'} ${empty === fields.length ? 'empty' : empty > 0 ? 'empty or different' : 'different'}: ${fields.map((f) => `${f.key} “${f.page}” (the identity page: “${f.identity}”)`).join('; ')}. The fix copies the identity page's values (one set_facts, both pages read live first).`,
        evidence: {
          identity: { id: id.id, name: id.rawName },
          fields,
        },
        fix: {
          kind: 'identity_copy',
          args: {
            pageId: p.id,
            identityId: id.id,
            facts,
            expectedCurrent,
            expectedIdentity: Object.fromEntries(fields.map((f) => [f.key, f.identity])),
          },
          summary: `Copy ${fields.map((f) => f.key).join(', ')} from ${id.rawName} to ${p.rawName}.`,
        },
      });
    }
  }
  return out;
}
