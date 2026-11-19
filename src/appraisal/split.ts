/**
 * `arkona_split_appraisal` (v3 F3e, ADR 0059; the owner-approved design docs/design/F3e-splits.md, section 1, "A6"): the
 * measurable Split Triggers of Character Architecture, applied to one page, with Anti-Fragmentation as the counterweight.
 * Pure: it works on a page as the appraisal's reader holds it (the snapshots' overlay, or a live read) and on the pack's
 * data (`rules.splits`, decision D4), and never acts. Every result is an ARCHITECTURAL CANDIDATE, only ever a suggestion:
 *
 * | Trigger                      | What it measures                                                                   |
 * | ---------------------------- | ---------------------------------------------------------------------------------- |
 * | Scope Overload               | the Scope (or the top-level sections) name `scopeOverload.minDomains`+ domains      |
 * | Retrieval Cost               | `retrievalCost.minWords`+ words AND `retrievalCost.minDomains`+ section domains     |
 * | Asset Ownership              | a non-Art page with `minImages`+ images, or a wardrobe, form or outfit section with one |
 * | Shared Ownership             | a section about one named character, long enough, with no relationship owner yet    |
 * | Distinct Unresolved Material | `unresolved.minItems`+ Unresolved Material items under one domain                  |
 * | Distinct Dependencies        | a Dependency only one section relies on                                            |
 *
 * Length alone never counts ("Source length alone is not an automatic trigger"). Each result names its trigger, its
 * evidence (section names, counts, sizes), a DRAFT destination map (which sections might go where) and the
 * Anti-Fragmentation note (sections that look closely related and should probably stay together, by the rule's own
 * examples). The triggers the bridge cannot measure (Independent Retrieval, Independent Maintenance, Downstream
 * Dependency) are the owner's questions.
 */
import type { PackRules, SplitsRules } from '../packs/types.js';
import { textKey } from '../packs/engine/text.js';
import { cleanPrefixes } from '../registry/names.js';
import { deepText, ownText } from './extract.js';
import type { LoadedPage } from './reader.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The six measurable triggers, by their check id in the appraisal's catalogue (src/appraisal/rules.ts). */
export const SPLIT_TRIGGERS = {
  scope_overload: 'Scope Overload',
  retrieval_cost: 'Retrieval Cost',
  asset_ownership: 'Asset Ownership',
  shared_ownership: 'Shared Ownership',
  distinct_unresolved: 'Distinct Unresolved Material',
  distinct_dependencies: 'Distinct Dependencies',
} as const;
export type SplitCheck = keyof typeof SPLIT_TRIGGERS;

// ============================================================================================ the outline

/** A top-level section of a body: its heading and everything to the next heading of its level or higher. */
export interface OutlineSection {
  /** Its heading block's id (null for the blocks before the first heading). */
  readonly headingId: string | null;
  /** The heading's text ('' for the preamble). */
  readonly title: string;
  readonly level: number;
  /** Its top-level blocks, the heading first. */
  readonly blocks: readonly Obj[];
  readonly blockIds: readonly string[];
  /** Words of text under it (the heading's own included). */
  readonly words: number;
  /** Image blocks under it, at any depth. */
  readonly images: number;
  /** Its domain (from its heading), or null; `frame` when it is the page's own frame (Purpose, Source Boundaries…). */
  readonly domain: string | null;
  readonly frame: boolean;
  /** Pages its blocks mention (resource ids, at any depth). */
  readonly mentions: readonly string[];
}

export const wordCount = (s: string): number => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** Every block under one (itself included), depth first. */
export function* walkBlocks(b: Obj): Generator<Obj> {
  yield b;
  if (Array.isArray(b.children)) for (const c of b.children) if (isObj(c)) yield* walkBlocks(c);
}

/** The pages a block mentions, at any depth (runs' mentions, resource links and collection items). */
export function mentionsIn(b: Obj): string[] {
  const out = new Set<string>();
  for (const x of walkBlocks(b)) {
    if (Array.isArray(x.content))
      for (const r of x.content as unknown[])
        if (isObj(r) && isObj(r.mention) && typeof r.mention.resourceId === 'string')
          out.add(r.mention.resourceId);
    if (typeof x.resourceId === 'string') out.add(x.resourceId);
    if (Array.isArray(x.items))
      for (const it of x.items as unknown[])
        if (isObj(it) && typeof it.resourceId === 'string') out.add(it.resourceId);
  }
  return [...out];
}

const imagesIn = (b: Obj): number => {
  let n = 0;
  for (const x of walkBlocks(b)) if (x.kind === 'image') n++;
  return n;
};

/** Whether `phrase` (one or more words) appears in `text` as whole words; its position, else -1. */
export function phraseAt(text: string, phrase: string): number {
  const t = ` ${textKey(text).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  const p = ` ${textKey(phrase)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;
  if (p.trim() === '') return -1;
  return t.indexOf(p);
}

/** The domain a heading (or an item's text) names: the domain whose word comes first in it, else null. */
export function domainOf(text: string, vocab: Readonly<Record<string, readonly string[]>>): string | null {
  let best: { domain: string; at: number } | null = null;
  for (const [domain, words] of Object.entries(vocab))
    for (const w of words) {
      const at = phraseAt(text, w);
      if (at >= 0 && (best === null || at < best.at)) best = { domain, at };
    }
  return best?.domain ?? null;
}

/** Every domain a text names (a Scope: "identity, biography, appearance and powers"). */
export function domainsIn(text: string, vocab: Readonly<Record<string, readonly string[]>>): string[] {
  return Object.entries(vocab)
    .filter(([, words]) => words.some((w) => phraseAt(text, w) >= 0))
    .map(([d]) => d);
}

/**
 * The body's top-level sections: at the shallowest heading level the body uses (Arkona's pages use level 2), each with
 * its nested sub-sections. Blocks before the first heading are a preamble.
 */
export function outline(
  blocks: readonly Obj[],
  o: { readonly vocab: Readonly<Record<string, readonly string[]>>; readonly frame: readonly string[] },
): OutlineSection[] {
  const levels = blocks
    .filter((b) => b.kind === 'heading')
    .map((b) => (typeof b.level === 'number' ? b.level : 1));
  const top = levels.length ? Math.min(...levels) : 1;
  const raw: { heading: Obj | null; blocks: Obj[] }[] = [];
  let cur: { heading: Obj | null; blocks: Obj[] } = { heading: null, blocks: [] };
  for (const b of blocks) {
    const isTop = b.kind === 'heading' && (typeof b.level === 'number' ? b.level : 1) <= top;
    if (isTop) {
      if (cur.heading !== null || cur.blocks.length > 0) raw.push(cur);
      cur = { heading: b, blocks: [b] };
    } else cur.blocks.push(b);
  }
  if (cur.heading !== null || cur.blocks.length > 0) raw.push(cur);
  const frameKeys = new Set(o.frame.map(textKey));
  return raw.map((s) => {
    const title = s.heading ? ownText(s.heading).trim() : '';
    const frame = s.heading === null || frameKeys.has(textKey(title));
    const text = s.blocks.map((b) => deepText(b)).join(' ');
    return {
      headingId: s.heading ? (str(s.heading.id) ?? null) : null,
      title,
      level: s.heading ? (typeof s.heading.level === 'number' ? s.heading.level : 1) : 0,
      blocks: s.blocks,
      blockIds: s.blocks.map((b) => str(b.id)).filter((x): x is string => x !== null),
      words: wordCount(text),
      images: s.blocks.reduce((n, b) => n + imagesIn(b), 0),
      domain: frame ? null : domainOf(title, o.vocab),
      frame,
      mentions: [...new Set(s.blocks.flatMap((b) => mentionsIn(b)))],
    };
  });
}

// ============================================================================================ the appraisal

/** A character the overlay knows (its identity page and the subject it is named by). */
export interface KnownCharacter {
  readonly id: string;
  readonly subject: string;
  /** Every page of its set (its index's pages), for a mention of any of them. */
  readonly pages: readonly string[];
}

export interface SplitContext {
  readonly rules: PackRules;
  /** The page's pack role (`core`, `compact`, `specialist`, `art`, `relationship`) or `owner`. */
  readonly role: string;
  /** The character a page belongs to (its subject), when it is a character page. */
  readonly subject: string | null;
  /** Every character the overlay knows, by subject (for Shared Ownership). */
  readonly characters: readonly KnownCharacter[];
  /** A relationship owner for two subjects, by name in either order (`A & B - …`), when one exists. */
  readonly relationshipOf: (a: string, b: string) => { readonly id: string; readonly name: string } | null;
  /** A page's display name. */
  readonly nameOf: (id: string) => string | null;
  /** A page's tags as the overlay holds them (for the visual owner). */
  readonly tagsOf?: (id: string) => readonly string[];
}

export interface SplitEvidence {
  readonly [k: string]: unknown;
}

/** One section's place in a draft destination map. */
export interface DraftEntry {
  readonly section: string;
  readonly words: number;
  readonly images: number;
  /** `stays`, `new` (a new owner), `relationship`, `divide` (block by block), `universal`, or `review` (no domain). */
  readonly to: 'stays' | 'new' | 'relationship' | 'divide' | 'review';
  /** What the new owner might be (an F3a role, its name and Reference Type; or an owner type). */
  readonly suggestion?: Readonly<Record<string, unknown>>;
  readonly note?: string;
}

export interface SplitCandidate {
  readonly check: SplitCheck;
  readonly trigger: (typeof SPLIT_TRIGGERS)[SplitCheck];
  /** Tells several results of one trigger apart (a section, a Dependency). */
  readonly key?: string;
  readonly message: string;
  readonly evidence: SplitEvidence;
}

export interface PageSplitAppraisal {
  readonly candidates: readonly SplitCandidate[];
  /** The draft destination map: every top-level section, where it might go. Only ever a suggestion. */
  readonly draftMap: readonly DraftEntry[];
  /** The Anti-Fragmentation note: sections that should probably stay together, and why. */
  readonly antiFragmentation: readonly string[];
  /** The triggers the bridge cannot measure, as questions for the owner. */
  readonly questions: readonly { readonly trigger: string; readonly question: string }[];
  readonly words: number;
  readonly sections: number;
}

const short = (s: string, n = 140) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const CHARACTER_ROLES = new Set(['core', 'compact', 'specialist', 'art', 'relationship']);

/** The pack's split rules, or null (a pack without them has no split tools). */
export function splitsOf(rules: PackRules): SplitsRules | null {
  return rules.splits ?? null;
}

/** Applies the measurable Split Triggers to one page (see the module comment). Null when the pack has no split rules. */
export function appraiseSplit(p: LoadedPage, ctx: SplitContext): PageSplitAppraisal | null {
  const s = splitsOf(ctx.rules);
  if (!s || !p.body) return null;
  const character = CHARACTER_ROLES.has(ctx.role);
  const vocab = character ? s.domains : s.ownerDomains;
  const frame = [
    ...s.stays,
    ...(ctx.rules.types[0]?.text.unresolved ? [ctx.rules.types[0].text.unresolved] : []),
  ];
  const sections = outline(p.body.blocks, { vocab, frame });
  const words = sections.reduce((n, x) => n + x.words, 0);
  const out: SplitCandidate[] = [];
  const byDomain = new Map<string, string[]>();
  for (const x of sections)
    if (x.domain) byDomain.set(x.domain, [...(byDomain.get(x.domain) ?? []), x.title]);
  const sectionDomains = [...byDomain.keys()];
  const scope = p.sidebar?.facts.get('scope')?.text ?? '';
  const scopeDomains = scope.trim() === '' ? [] : domainsIn(scope, vocab);
  const subject = ctx.subject ?? cleanPrefixes(p.page.rawName).name.split(' - ')[0]!.trim();

  // Scope Overload (D4: scopeOverload.minDomains).
  if (
    scopeDomains.length >= s.scopeOverload.minDomains ||
    sectionDomains.length >= s.scopeOverload.minDomains
  ) {
    const by = scopeDomains.length >= s.scopeOverload.minDomains ? 'its Scope' : 'its sections';
    const n = Math.max(scopeDomains.length, sectionDomains.length);
    out.push({
      check: 'scope_overload',
      trigger: SPLIT_TRIGGERS.scope_overload,
      message: `Scope Overload: ${by} name${by === 'its Scope' ? 's' : ''} ${n} separate domains (${(by === 'its Scope' ? scopeDomains : sectionDomains).join(', ')}), at or above the pack's threshold of ${s.scopeOverload.minDomains}. A candidate for splitting, never a decision: the split appraisal (A6) gives the draft destination map and the Anti-Fragmentation note.`,
      evidence: {
        threshold: s.scopeOverload.minDomains,
        scope: scope === '' ? null : short(scope, 300),
        scopeDomains,
        sectionDomains: Object.fromEntries(byDomain),
      },
    });
  }

  // Retrieval Cost (D4: length AND domains; length alone never counts).
  if (words >= s.retrievalCost.minWords && sectionDomains.length >= s.retrievalCost.minDomains)
    out.push({
      check: 'retrieval_cost',
      trigger: SPLIT_TRIGGERS.retrieval_cost,
      message: `Retrieval Cost: ${words} words (the threshold is ${s.retrievalCost.minWords}) across ${sectionDomains.length} domains (${sectionDomains.join(', ')}): a reader after one domain opens all of it. Length alone never counts; here the domains do too.`,
      evidence: {
        words,
        threshold: { words: s.retrievalCost.minWords, domains: s.retrievalCost.minDomains },
        domains: Object.fromEntries(
          sections.filter((x) => x.domain).map((x) => [x.title, { domain: x.domain, words: x.words }]),
        ),
      },
    });

  // Asset Ownership (a non-Art page that interprets several images, or a wardrobe, form or outfit section with images).
  const rt = p.sidebar?.facts.get('reference type')?.text ?? '';
  const tags = ctx.tagsOf?.(p.page.id) ?? [];
  const visual =
    s.visual.roles.includes(ctx.role) ||
    s.visual.referenceTypes.some((v) => textKey(v) === textKey(rt)) ||
    tags.some((t) => s.visual.tags.some((v) => textKey(v) === textKey(t)));
  const images = sections.reduce((n, x) => n + x.images, 0);
  const assetSections = sections.filter(
    (x) => x.images > 0 && s.assetOwnership.sectionWords.some((w) => phraseAt(x.title, w) >= 0),
  );
  if (!visual && (images >= s.assetOwnership.minImages || assetSections.length > 0))
    out.push({
      check: 'asset_ownership',
      trigger: SPLIT_TRIGGERS.asset_ownership,
      message: `Asset Ownership: a page that is not an Art or visual owner interprets ${images} image${images === 1 ? '' : 's'}${assetSections.length ? ` (with images under ${assetSections.map((x) => `“${x.title}”`).join(', ')})` : ''}. Visual material belongs to an Art or visual owner (Character Architecture's visual audit).`,
      evidence: {
        images,
        threshold: s.assetOwnership.minImages,
        sections: sections.filter((x) => x.images > 0).map((x) => ({ section: x.title, images: x.images })),
      },
    });

  // Shared Ownership (a character page only): a section about one named character, long enough to stand alone, with no
  // relationship owner for the pair.
  const shared: { section: OutlineSection; with: KnownCharacter }[] = [];
  if (character && ctx.role !== 'relationship') {
    const me = textKey(subject);
    for (const x of sections) {
      if (x.frame) continue;
      const named = new Map<string, KnownCharacter>();
      for (const c of ctx.characters) {
        if (textKey(c.subject) === me) continue;
        if (phraseAt(x.title, c.subject) >= 0) named.set(c.id, c);
      }
      if (named.size === 0 && x.domain && vocabIsRelationship(x.domain, s)) {
        for (const m of x.mentions) {
          const c = ctx.characters.find((k) => k.id === m || k.pages.includes(m));
          if (c && textKey(c.subject) !== me) named.set(c.id, c);
        }
      }
      if (named.size !== 1 || x.words < s.sharedOwnership.minWords) continue;
      const other = [...named.values()][0]!;
      if (ctx.relationshipOf(subject, other.subject)) continue;
      shared.push({ section: x, with: other });
      out.push({
        check: 'shared_ownership',
        trigger: SPLIT_TRIGGERS.shared_ownership,
        key: textKey(x.title),
        message: `Shared Ownership: “${x.title}” is about ${subject} and ${other.subject} (${x.words} words, long enough to stand alone), and no relationship owner exists for the pair: a candidate for “${subject} & ${other.subject} - Relationship”.`,
        evidence: {
          section: x.title,
          words: x.words,
          threshold: s.sharedOwnership.minWords,
          with: { id: other.id, name: other.subject },
        },
      });
    }
  }

  // Distinct Unresolved Material: its items cluster under one domain.
  const unresolvedHeading = ctx.rules.types[0]?.text.unresolved ?? 'Unresolved Material';
  const um = sections.find((x) => textKey(x.title) === textKey(unresolvedHeading));
  const clusters = new Map<string, string[]>();
  if (um) {
    for (const item of itemsOf(um)) {
      const d = domainOf(item, vocab);
      if (d) clusters.set(d, [...(clusters.get(d) ?? []), short(item, 160)]);
    }
    const big = [...clusters.entries()].filter(([, v]) => v.length >= s.unresolved.minItems);
    if (big.length > 0)
      out.push({
        check: 'distinct_unresolved',
        trigger: SPLIT_TRIGGERS.distinct_unresolved,
        message: `Distinct Unresolved Material: ${big.map(([d, v]) => `${v.length} items about ${d}`).join('; ')}. Unresolved matters that cluster under one domain belong with that domain's owner if it is split out (“preserve qualifications and unresolved matters”).`,
        evidence: {
          threshold: s.unresolved.minItems,
          clusters: Object.fromEntries(big),
          items: itemsOf(um).length,
        },
      });
  }

  // Distinct Dependencies: a Dependency that only one section relies on (it mentions the page, or names it in full), when
  // that section has a domain of its own among the page's other sections (one section alone is nothing to split off).
  const deps = p.collections.find((c) => textKey(c.title) === textKey(ctx.rules.sidebar.dependencies));
  const depOnly: { dep: string; section: OutlineSection }[] = [];
  const contentSections = sections.filter((x) => !x.frame);
  for (const it of contentSections.length >= 2 ? (deps?.items ?? []) : []) {
    const name = ctx.nameOf(it.resourceId);
    const display = name ? cleanPrefixes(name).name.trim() : null;
    const users = sections.filter(
      (x) =>
        x.mentions.includes(it.resourceId) ||
        (display !== null &&
          display.includes(' ') &&
          x.blocks.some((b) => phraseAt(deepText(b), display) >= 0)),
    );
    if (users.length !== 1 || users[0]!.frame || users[0]!.domain === null) continue;
    depOnly.push({ dep: it.resourceId, section: users[0]! });
    out.push({
      check: 'distinct_dependencies',
      trigger: SPLIT_TRIGGERS.distinct_dependencies,
      key: it.resourceId,
      message: `Distinct Dependencies: only “${users[0]!.title}” relies on ${name ?? it.resourceId} (a Dependency of this page). If that section becomes its own owner, the Dependency goes with it; if it restates that owner's rule, the rule stays there and the section keeps only its application (“do not migrate universal rules into character-specific owners”).`,
      evidence: {
        dependency: { id: it.resourceId, name: name ?? it.resourceId },
        section: users[0]!.title,
      },
    });
  }

  if (out.length === 0)
    return {
      candidates: [],
      draftMap: [],
      antiFragmentation: [],
      questions: s.questions,
      words,
      sections: sections.length,
    };

  return {
    candidates: out,
    draftMap: draftMapOf(sections, {
      s,
      character,
      subject,
      shared,
      depOnly,
      clusters,
      unresolvedHeading,
      nameOf: ctx.nameOf,
    }),
    antiFragmentation: antiFragmentationOf(sections, s, shared.length),
    questions: s.questions,
    words,
    sections: sections.length,
  };
}

const vocabIsRelationship = (domain: string, s: SplitsRules): boolean =>
  (s.destinations[domain]?.role ?? '') === 'relationship';

/** The items of a section (each list item, else each paragraph), as text. */
function itemsOf(x: OutlineSection): string[] {
  const out: string[] = [];
  for (const b of x.blocks.slice(x.headingId ? 1 : 0)) {
    if (b.kind === 'bulletList' || b.kind === 'orderedList' || b.kind === 'taskList') {
      for (const li of (Array.isArray(b.children) ? b.children : []) as unknown[])
        if (isObj(li)) {
          const t = deepText(li).trim();
          if (t) out.push(t);
        }
    } else {
      const t = deepText(b).trim();
      if (t) out.push(t);
    }
  }
  return out;
}

function draftMapOf(
  sections: readonly OutlineSection[],
  o: {
    readonly s: SplitsRules;
    readonly character: boolean;
    readonly subject: string;
    readonly shared: readonly { section: OutlineSection; with: KnownCharacter }[];
    readonly depOnly: readonly { dep: string; section: OutlineSection }[];
    readonly clusters: ReadonlyMap<string, readonly string[]>;
    readonly unresolvedHeading: string;
    readonly nameOf: (id: string) => string | null;
  },
): DraftEntry[] {
  const { s } = o;
  const visualTitle = (x: OutlineSection) =>
    x.images > 0
      ? ' Its images go to an Art or visual owner (the visual audit): divide it block by block.'
      : '';
  return sections.map((x): DraftEntry => {
    const base = { section: x.title || '(before the first heading)', words: x.words, images: x.images };
    if (textKey(x.title) === textKey(o.unresolvedHeading) && o.clusters.size > 0)
      return {
        ...base,
        to: 'divide',
        note: `Divide it block by block: each item goes with its domain's owner (${[...o.clusters.keys()].join(', ')}); the rest stays.`,
      };
    if (x.frame) return { ...base, to: 'stays' };
    const sh = o.shared.find((z) => z.section === x);
    if (sh)
      return {
        ...base,
        to: 'relationship',
        suggestion: {
          role: 'relationship',
          with: sh.with.subject,
          name: `${o.subject} & ${sh.with.subject} - Relationship`,
        },
      };
    if (!x.domain)
      return {
        ...base,
        to: 'review',
        note: 'No domain recognised from its heading: where it belongs is the owner’s call.',
      };
    const dep = o.depOnly.find((z) => z.section === x);
    const universal = dep
      ? ` It alone relies on ${o.nameOf(dep.dep) ?? dep.dep}: blocks that restate that owner's rule are “universal” (not migrated; application text instead).`
      : '';
    if (o.character) {
      const d = s.destinations[x.domain];
      if (d?.role === 'relationship')
        return {
          ...base,
          to: 'relationship',
          suggestion: {
            role: 'relationship',
            note: 'name the other character (with), or an existing relationship page',
          },
          note: `A relationship section: its owner is a relationship page for the pair.${universal}`,
        };
      if (d)
        return {
          ...base,
          to: x.images > 0 ? 'divide' : 'new',
          suggestion: {
            role: d.role,
            ...(d.title ? { title: d.title, name: `${o.subject} - ${d.title}` } : {}),
            ...(d.referenceType ? { referenceType: d.referenceType } : {}),
          },
          ...(visualTitle(x) || universal ? { note: `${visualTitle(x)}${universal}`.trim() } : {}),
        };
      return {
        ...base,
        to: 'review',
        note: `The ${x.domain} domain has no suggested owner in the pack.${universal}`,
      };
    }
    return {
      ...base,
      to: x.images > 0 ? 'divide' : 'new',
      suggestion: { tool: 'arkona_create_owner', type: x.domain, note: 'its home is the owner’s call' },
      ...(visualTitle(x) || universal ? { note: `${visualTitle(x)}${universal}`.trim() } : {}),
    };
  });
}

function antiFragmentationOf(sections: readonly OutlineSection[], s: SplitsRules, shared: number): string[] {
  const out: string[] = [
    '“Do not split merely because a character has many facts. The unit of ownership is a coherent subject… Do not create four small files where one clear owner is better.”',
  ];
  for (const g of s.together) {
    const hit = sections.filter((x) => !x.frame && g.words.some((w) => phraseAt(x.title, w) >= 0));
    if (hit.length >= 2)
      out.push(
        `Keep together: ${hit.map((x) => `“${x.title}”`).join(', ')} (${g.example}): closely related, probably one owner.`,
      );
  }
  const small = sections.filter((x) => !x.frame && x.domain && x.words < s.sharedOwnership.minWords);
  if (small.length > 0)
    out.push(
      `Small sections: ${small.map((x) => `“${x.title}” (${x.words} words)`).join(', ')}: probably not worth an owner of their own; they can stay or go with a neighbour.`,
    );
  if (shared >= 2)
    out.push(
      'Several relationship sections: if they form one shared hierarchy (a romantic hierarchy, a household), keep them in one relationship owner rather than one per pair.',
    );
  return out;
}
