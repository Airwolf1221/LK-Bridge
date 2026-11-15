/**
 * Taxonomy drift and fact consistency (v2 E2, ADR 0044; PLAN-v2 4.3 and 4.12).
 *
 * **Taxonomy drift** (reported, never fixed): the registry's own drift walk (`computeDrift`, `classifyType`) runs over the
 * snapshot's pages, so it agrees with the dashboard's drift report in what it counts; on top of it:
 * pages whose race is not in the taxonomy, taxonomy entries whose index holds no pages, entries whose singular is still
 * a guess waiting for the owner's review, and an index whose name disagrees with its entry.
 *
 * **Fact consistency**: a character page's Subject or Canonical Display Name disagreeing with its name, and Reference
 * Type values the registry does not know (with strict mode off, only those that resemble a registry value:
 * `resemblesRegistryValue`, with the generic words of `GENERIC_REFERENCE_TYPE_WORDS` ignored). A qualified race value
 * ("Therian (Aggeloi)") is read by its anchor (`raceAnchors`) when the whole value matches no entry. "Propose a fix" uses `set_facts` only when the right value is unambiguous
 * (a Reference Type that is a registry value in other letters, or whose page name carries the registry's own page-name
 * pattern; a Subject that differs from the name only in case or spacing); otherwise the finding only reports.
 */
import { computeDrift, type DriftCode } from '../../registry/drift.js';
import { key as nkey, subjectOf } from '../../registry/names.js';
import type { RegistryStore } from '../../registry/store.js';
import type { RegistryType, TaxonomyEntry } from '../../registry/index.js';
import { contentPages, fact, factAmbiguous, type AuditContext } from '../context.js';
import type { AuditPage } from '../model.js';
import type { FindingCode, FindingDraft } from '../types.js';

const DRIFT_CODE: Record<DriftCode, FindingCode> = {
  type_root_missing: 'taxonomy_type_root_missing',
  unmapped_index: 'taxonomy_index_without_entry',
  source_deleted: 'taxonomy_source_missing',
  source_renamed: 'taxonomy_index_renamed',
  source_moved: 'taxonomy_source_moved',
  parent_mismatch: 'taxonomy_parent_mismatch',
};

/** The Reference Type a template's name stands for: its prefix, a leading "AI" and a trailing "Template" removed. */
export const referenceTypeOfTemplate = (name: string): string =>
  name
    .replace(/^\s*\[(INDEX|BSRC|BWRK|BARC)\]\s*/i, '')
    .replace(/^AI\s+/i, '')
    .replace(/\s+Template\s*$/i, '')
    .trim();

/**
 * The anchors of a qualified race value, in the order they are tried: the text before the first `(`, `;` or `-`,
 * trimmed ("Therian (Aggeloi)" → "Therian"); and, when that cut a hyphenated name ("Half-Elf (Northern)"), the text
 * before the first `(` or `;`. Empty, or the whole value, gives none.
 */
export function raceAnchors(value: string): string[] {
  const whole = value.trim();
  const out: string[] = [];
  for (const re of [/[(;-]/, /[(;]/]) {
    const i = whole.search(re);
    if (i <= 0) continue;
    const a = whole.slice(0, i).trim();
    if (a && a !== whole && !out.includes(a)) out.push(a);
  }
  return out;
}

const isPageKind = (k: string) => k === 'bsrc' || k === 'bwrk' || k === 'barc';

/** A character page's role by its Reference Type, in the type's own words. */
function characterRole(ctx: AuditContext, type: RegistryType, p: AuditPage): 'core' | 'compact' | null {
  if (!type.placement || !isPageKind(p.kind)) return null;
  const rt = fact(ctx, p, ctx.treeSettings.referenceTypeRow);
  if (rt === null) return null;
  if (nkey(rt) === nkey(type.placement.referenceTypes.core)) return 'core';
  if (nkey(rt) === nkey(type.placement.referenceTypes.compact)) return 'compact';
  return null;
}

export function taxonomyCheck(ctx: AuditContext): FindingDraft[] {
  const out: FindingDraft[] = [];
  // The registry's own drift walk, on the snapshot's tree.
  const store = {
    listTypes: () => [...ctx.types],
    entries: (typeId: string) => [...ctx.entries(typeId)],
  } as unknown as RegistryStore;
  for (const f of computeDrift(ctx.tree, store)) {
    const inModel = ctx.model.pages.has(f.nodeId);
    out.push({
      code: DRIFT_CODE[f.code],
      key: `${f.typeId}:${f.entryId ?? ''}:${f.nodeId}`,
      pageId: inModel ? f.nodeId : null,
      message: f.message,
      evidence: {
        type: f.typeName,
        entry: f.entryName,
        entryId: f.entryId,
        node: f.nodeId,
        path: f.nodePath,
        drift: f.code,
      },
    });
  }

  for (const type of ctx.types) {
    if (type.taxonomySeededAt === null) continue;
    const entries = ctx.entries(type.id);
    const bySource = new Map<string, TaxonomyEntry>(entries.map((e) => [e.sourceNodeId, e]));
    const byId = new Map(entries.map((e) => [e.id, e]));
    const root = type.rootIndexId ? ctx.snapshotTree.node(type.rootIndexId) : null;

    // Entries waiting for the owner's review (a singular still a guess, a deep or empty index).
    for (const e of entries) {
      if (e.status === 'needs_review')
        out.push({
          code: 'taxonomy_entry_unreviewed',
          key: e.id,
          pageId: ctx.model.pages.has(e.sourceNodeId) ? e.sourceNodeId : null,
          message: `The taxonomy entry “${e.plural}” (singular “${e.singular}”) still waits for the owner’s review: ${e.review.map((r) => r.message).join(' ') || 'no reason recorded'}`,
          evidence: {
            type: type.singular,
            entry: e.plural,
            singular: e.singular,
            singularSource: e.singularSource,
            review: e.review.map((r) => r.code),
          },
        });
    }

    // Entries whose index holds no pages.
    const kids = new Map<string, number>();
    for (const p of ctx.model.pages.values()) {
      if (!isPageKind(p.kind)) continue;
      const n = ctx.snapshotTree.node(p.id);
      for (const id of n?.path.ids ?? []) kids.set(id, (kids.get(id) ?? 0) + 1);
    }
    for (const e of entries) {
      const src = ctx.model.pages.get(e.sourceNodeId);
      if (!src) continue; // reported by the drift walk
      if ((kids.get(e.sourceNodeId) ?? 0) === 0)
        out.push({
          code: 'taxonomy_entry_without_pages',
          key: e.id,
          pageId: src.id,
          message: `The taxonomy entry “${e.plural}” has an index with no pages under it.`,
          evidence: { type: type.singular, entry: e.plural, index: src.rawName },
        });
    }

    // A character page's race against the taxonomy.
    if (!type.placement || !root) continue;
    const unknown = new Set(
      [...type.placement.unknownRaceValues, type.placement.unknownSpeciesValue].map((v) => nkey(v)),
    );
    const names = new Map<string, TaxonomyEntry[]>();
    for (const e of entries)
      for (const n of [e.plural, e.singular, ...e.aliases]) {
        const k = nkey(n);
        names.set(k, [...(names.get(k) ?? []), e]);
      }
    for (const p of contentPages(ctx)) {
      const role = characterRole(ctx, type, p);
      if (role === null) continue;
      const n = ctx.snapshotTree.node(p.id);
      if (!n || !n.path.ids.includes(root.id)) continue;
      const race = fact(ctx, p, type.placement.speciesRow);
      if (race === null || unknown.has(nkey(race))) continue;
      // The whole value first; then, for a qualified value ("Therian (Aggeloi)"), its anchor. The page is never
      // rewritten, and a last word is never guessed ("Fire Genie" is not "Genies").
      let hit = [...new Set(names.get(nkey(race)) ?? [])];
      const anchors = hit.length === 0 ? raceAnchors(race) : [];
      for (const a of anchors) {
        hit = [...new Set(names.get(nkey(a)) ?? [])];
        if (hit.length > 0) break;
      }
      if (hit.length === 0) {
        const anchor = anchors[0] ?? null;
        out.push({
          code: 'race_not_in_taxonomy',
          key: nkey(race),
          pageId: p.id,
          message: `The ${type.placement.speciesRow} “${race}” is not in the ${type.singular} taxonomy (no entry has it${anchor ? `, or its anchor “${anchor}”,` : ''} as its plural, singular or alias)${anchor ? `; to accept it, add “${anchor}” as an alias in Repository Mappings` : ''}.`,
          evidence: {
            type: type.singular,
            race,
            anchor,
            row: type.placement.speciesRow,
            entries: entries.slice(0, 200).map((e) => e.plural),
          },
        });
        continue;
      }
      if (hit.length > 1) continue; // ambiguous names are the registry's own error (RACE_AMBIGUOUS); not repeated here
      // The race index the page actually sits under: the nearest ancestor that is an entry's index.
      let under: TaxonomyEntry | null = null;
      for (let i = n.path.ids.length - 2; i >= 0; i--) {
        const e = bySource.get(n.path.ids[i]!);
        if (e) {
          under = e;
          break;
        }
      }
      if (!under || under.id === hit[0]!.id) continue;
      // A race named by an ancestor entry of the index it sits under (Human under High Humans) is consistent.
      let ok = false;
      for (
        let cur: TaxonomyEntry | undefined = under;
        cur;
        cur = cur.parentId ? byId.get(cur.parentId) : undefined
      )
        if (cur.id === hit[0]!.id) ok = true;
      if (!ok)
        out.push({
          code: 'race_index_mismatch',
          key: nkey(race),
          pageId: p.id,
          message: `The ${type.placement.speciesRow} “${race}” belongs to the index “${hit[0]!.plural}”, but the page sits under “${under.plural}”.`,
          evidence: { race, entry: hit[0]!.plural, sitsUnder: under.plural },
        });
    }
  }
  return out;
}

// ============================================================================================ facts

/** The suffix a page-name pattern adds to `{name}` ("{name} - Character Core" → " - Character Core"). */
const suffixOf = (pattern: string): string => pattern.slice(pattern.indexOf('{name}') + '{name}'.length);

/**
 * The generic words a Reference Type's resemblance ignores: "Continent Reference" shares only "reference" with
 * "Compact Character Reference", which says nothing. Documented in docs/audits.md.
 */
export const GENERIC_REFERENCE_TYPE_WORDS: readonly string[] = [
  'reference',
  'references',
  'the',
  'and',
  'of',
  'a',
  'an',
];

/** A value's distinctive words: its words, case ignored, without the generic ones. */
export const distinctiveWords = (s: string): Set<string> =>
  new Set(
    nkey(s)
      .split(/[^a-z0-9]+/)
      .filter((w) => w !== '' && !GENERIC_REFERENCE_TYPE_WORDS.includes(w)),
  );

/**
 * Whether an unknown Reference Type **resembles** a registry value (strict mode off flags only these). One of:
 * (a) it is a registry value in other letters or spacing ("CharacterCore"); (b) the page's name carries a registry
 * page-name pattern (`namePatternMatches`: "{name} - Character Core"); (c) its distinctive words are a non-empty subset
 * of one registry value's ("Character Reference" → {character} ⊆ {compact, character}). "Continent Reference",
 * "Character Biography" and "Relationship" resemble nothing.
 */
export function resemblesRegistryValue(
  value: string,
  registryValues: readonly string[],
  namePatternMatches: boolean,
): boolean {
  if (namePatternMatches) return true;
  const fold = (s: string) => nkey(s).replace(/[^a-z0-9]+/g, '');
  if (registryValues.some((v) => fold(v) === fold(value))) return true;
  const mine = distinctiveWords(value);
  if (mine.size === 0) return false;
  return registryValues.some((v) => {
    const theirs = distinctiveWords(v);
    return [...mine].every((w) => theirs.has(w));
  });
}

export function factsCheck(ctx: AuditContext): FindingDraft[] {
  const out: FindingDraft[] = [];
  const known = new Set<string>(ctx.settings.knownReferenceTypes.map((v) => nkey(v)));
  const registryValues: string[] = [];
  for (const t of ctx.types)
    if (t.placement) registryValues.push(t.placement.referenceTypes.core, t.placement.referenceTypes.compact);
  for (const v of registryValues) known.add(nkey(v));
  // Every template stands for a Reference Type: "[BSRC] AI Character Art Template" is "Character Art".
  for (const n of ctx.templateNames) known.add(nkey(referenceTypeOfTemplate(n)));
  for (const r of ctx.rules) if (r.selectors.referenceType) known.add(nkey(r.selectors.referenceType));
  const fold = (s: string) => nkey(s).replace(/[^a-z0-9]+/g, '');
  // The registry's page-name patterns the page's name ends in ("{name} - Character Core"), by type.
  const nameRoles = (p: AuditPage) =>
    ctx.types.flatMap((t) =>
      t.placement
        ? (['core', 'compact'] as const)
            .filter((r) => p.displayName.endsWith(suffixOf(t.placement!.pageNames[r])))
            .map((r) => ({ type: t, role: r }))
        : [],
    );

  for (const p of contentPages(ctx)) {
    if (!isPageKind(p.kind)) continue;
    const rt = fact(ctx, p, ctx.treeSettings.referenceTypeRow);
    if (factAmbiguous(p, ctx.treeSettings.referenceTypeRow)) continue;
    const rtRow = p.facts.get(nkey(ctx.treeSettings.referenceTypeRow));

    // Reference Type values the registry does not know.
    if (rt !== null && !known.has(nkey(rt))) {
      const roles = nameRoles(p);
      if (ctx.settings.strictReferenceTypes || resemblesRegistryValue(rt, registryValues, roles.length > 0)) {
        // The right value, only when unambiguous: the same words in other letters, or the page's own name pattern.
        let right: string | null = null;
        let why = '';
        const exact = registryValues.filter((v) => fold(v) === fold(rt));
        if (exact.length === 1) {
          right = exact[0]!;
          why = `the same words as the registry’s “${right}”`;
        } else {
          for (const t of ctx.types) {
            const mine = roles.filter((r) => r.type === t);
            if (!t.placement || mine.length !== 1) continue;
            const role = mine[0]!.role;
            const want = t.placement.referenceTypes[role];
            if (right !== null && right !== want) {
              right = null;
              why = '';
              break;
            }
            right = want;
            why = `the page’s name ends “${suffixOf(t.placement.pageNames[role])}”, the registry’s name pattern for “${want}”`;
          }
        }
        out.push({
          code: 'unknown_reference_type',
          pageId: p.id,
          message: `The Reference Type “${rt}” is not a value the registry knows${right ? `; the right value is “${right}” (${why})` : ''}.`,
          evidence: {
            found: rt,
            registryValues: [...new Set(registryValues)],
            expected: right,
            ...(right ? { because: why } : { because: 'no single right value can be told from the page' }),
          },
          ...(right && rtRow
            ? {
                fix: {
                  kind: 'set_facts' as const,
                  args: { pageId: p.id, facts: { [rtRow.key]: right }, expectedCurrent: { [rtRow.key]: rt } },
                  summary: `Set ${rtRow.key} to “${right}” on ${p.displayName}.`,
                },
              }
            : {}),
        });
      }
    }

    // A character page's Subject and Canonical Display Name against its name. The page is a character page by its
    // Reference Type, or (when that is not a registry value) by its name's own pattern ("{name} - Character Core").
    const type =
      ctx.types.find(
        (t) =>
          t.placement &&
          rt !== null &&
          [t.placement.referenceTypes.core, t.placement.referenceTypes.compact].some(
            (v) => nkey(v) === nkey(rt),
          ),
      ) ?? nameRoles(p)[0]?.type;
    if (!type?.placement) continue;
    const fromName = subjectOf(p.displayName, null);
    const subject = fact(ctx, p, type.placement.subjectRow);
    const subjectRow = p.facts.get(nkey(type.placement.subjectRow));
    if (subject !== null && nkey(subject) !== nkey(fromName)) {
      const tidy = fold(subject) === fold(fromName);
      out.push({
        code: 'subject_mismatch',
        pageId: p.id,
        message: `The ${type.placement.subjectRow} “${subject}” does not match the page’s name (“${fromName}”).`,
        evidence: {
          found: subject,
          expected: fromName,
          row: type.placement.subjectRow,
          because: tidy
            ? 'they differ only in case, spacing or punctuation'
            : 'the name or the Subject may be the wrong one; the audit does not choose',
        },
        ...(tidy && subjectRow
          ? {
              fix: {
                kind: 'set_facts' as const,
                args: {
                  pageId: p.id,
                  facts: { [subjectRow.key]: fromName },
                  expectedCurrent: { [subjectRow.key]: subject },
                },
                summary: `Set ${subjectRow.key} to “${fromName}” on ${p.displayName}.`,
              },
            }
          : {}),
      });
    }
    const cdn = fact(ctx, p, ctx.treeSettings.canonicalNameRow);
    if (cdn !== null && nkey(cdn) !== nkey(fromName) && nkey(cdn) !== nkey(p.displayName)) {
      out.push({
        code: 'canonical_name_mismatch',
        pageId: p.id,
        message: `The ${ctx.treeSettings.canonicalNameRow} “${cdn}” does not match the page’s name (“${fromName}”).`,
        evidence: {
          found: cdn,
          expected: fromName,
          row: ctx.treeSettings.canonicalNameRow,
          because: 'the name or the Canonical Display Name may be the wrong one; the audit does not choose',
        },
      });
    }
  }
  return out;
}
