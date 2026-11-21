/**
 * v3 F4b (ADR 0064; design D3, D4, D9): the comparison. Pure functions: one character's facts in (its identity page's,
 * then every restatement elsewhere, already narrowed to its continuity and the pages in scope), the disagreements out,
 * each labelled by the owner's evidence classes. It never decides which side is right.
 *
 * - **Dates conflict only when their spans cannot both be true** (D3): `4A 100` and `Camue 1st, 4A 100` agree; a "c."
 *   date is widened by the pack's margin.
 * - **Identity facts** are compared normalised (case, diacritics, punctuation, and the order of a name's words, so an
 *   East Asian name in either order agrees). `Unestablished` never conflicts: it is a gap.
 * - **Labels** (D4): Authoritative against Authoritative is **Contradictory** (`warning`); Working against canon is
 *   **Proposal differs from canon** (`info`); a gap is **Gap** (`info`); Archived or historical material, only when
 *   asked for, is **Historical material differs** (`info`); a date the calendar cannot read is **Unreadable** (`info`).
 * - **Attested bounds are never compared** (chosen): a page's Temporal Scope may be the time its source covers, which
 *   Character Architecture forbids treating as a lifespan; they are read for "as of a date" and the coverage report.
 */
import type { Calendar } from '../calendar/index.js';
import { cleanPrefixes } from '../registry/names.js';
import { nameKeyOf } from '../packs/naming/namesakes.js';
import { overlaps, spanOf, type Span } from './dates.js';
import { principalValue } from './extract.js';
import type { StoredFact } from './facts-index.js';

export type Lifecycle = 'Authoritative' | 'Working' | 'Archived';
export type Label = 'contradictory' | 'differs' | 'gap' | 'historical' | 'unreadable' | 'spelling';

export const LABEL_TEXT: Readonly<Record<Label, string>> = {
  contradictory: 'Contradictory',
  differs: 'Proposal differs from canon',
  gap: 'Gap',
  historical: 'Historical material differs',
  unreadable: 'Unreadable date',
  spelling: 'Spelling differs',
};

export const LABEL_SEVERITY: Readonly<Record<Label, 'warning' | 'info'>> = {
  contradictory: 'warning',
  differs: 'info',
  gap: 'info',
  historical: 'info',
  unreadable: 'info',
  spelling: 'info',
};

/** What a page is, for labelling. */
export interface PageInfo {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly lifecycle: Lifecycle | null;
  /** A non-current area (the Legacy Canon Archive, the Design References), or null. */
  readonly area: string | null;
}

/** The kinds of comparison, each with its stable finding code (D5). */
export type CompareKind = 'birth' | 'death' | 'identity' | 'chronology';
export const FINDING_CODE: Readonly<Record<CompareKind, string>> = {
  birth: 'consistency_birth',
  death: 'consistency_death',
  identity: 'consistency_identity',
  chronology: 'consistency_chronology',
};

/** One side of a disagreement as every answer shows it. */
export interface ValueView {
  /** Stable within the finding (`page:doc:block:seq`). */
  readonly key: string;
  readonly page: { readonly id: string; readonly name: string; readonly path: string };
  readonly lifecycle: Lifecycle | null;
  readonly area?: string;
  readonly section: string | null;
  readonly excerpt: string;
  readonly value: string;
  readonly precision: string | null;
  readonly approximate?: boolean;
  readonly source: StoredFact['source'];
  readonly pattern: string;
  readonly documentId: string | null;
  readonly blockId: string | null;
  readonly field: string | null;
  readonly gap?: boolean;
  readonly unreadable?: string;
  /** A Main CANON value shown in an AU's place (D9). */
  readonly inherited?: string;
}

export interface Disagreement {
  readonly kind: CompareKind;
  /** The fact compared: `birth`, `death`, or an identity field. */
  readonly what: string;
  readonly field: string | null;
  readonly label: Label;
  /** The identity page's value first (or, when it records none, the first Authoritative restatement). */
  readonly reference: ValueView;
  /** True when the identity page records no value and `reference` is a restatement. */
  readonly referenceFromRestatement: boolean;
  readonly restatements: readonly ValueView[];
  /** For a chronology finding: the row (`documentId:rowId`). */
  readonly row?: string;
}

const lifecycleRank = (l: Lifecycle | null) => (l === 'Authoritative' ? 0 : l === 'Working' ? 1 : 2);

/** A value's key within its finding (`ValueView.key`), from its fact. */
export const valueKey = (f: StoredFact): string =>
  `${f.pageId}:${f.documentId ?? ''}:${f.blockId ?? ''}:${f.pattern}:${f.seq}`;

export function viewOf(f: StoredFact, page: PageInfo, inherited?: string): ValueView {
  return {
    key: valueKey(f),
    page: { id: page.id, name: page.name, path: page.path },
    lifecycle: page.lifecycle,
    ...(page.area ? { area: page.area } : {}),
    section: f.section,
    excerpt: f.excerpt,
    value: f.valueText,
    precision: f.date?.precision ?? null,
    ...(f.date?.approximate ? { approximate: true } : {}),
    source: f.source,
    pattern: f.pattern,
    documentId: f.documentId,
    blockId: f.blockId,
    field: f.field,
    ...(f.gap ? { gap: true } : {}),
    ...(f.unreadable ? { unreadable: f.unreadable } : {}),
    ...(inherited ? { inherited } : {}),
  };
}

/** The label of a disagreement between two pages (D4), by their lifecycles. */
export function labelOf(a: PageInfo, b: PageInfo): Label {
  const historical = (p: PageInfo) => p.lifecycle === 'Archived' || p.area !== null;
  if (historical(a) || historical(b)) return 'historical';
  if (a.lifecycle === 'Working' || b.lifecycle === 'Working') return 'differs';
  return 'contradictory';
}

/**
 * An identity value's principal part, normalised (ADR 0064 amendment 1, rule E): what comes before its first qualifier
 * (`;`, `(`, a spaced dash). Differing qualifiers or wording after it are no conflict. CR-2026-11-R4 (RC-18): its words
 * in their order (a reordered surname, "von Woerfels-Hohenfalk" against "von Hohenfalk-Woerfels", is a difference), and
 * the whole value when the principal part's key is empty ("— (Human)").
 */
export const principalKey = (v: string): string => {
  const k = nameKeyOf(principalValue(v));
  return k !== '' ? k : nameKeyOf(v);
};

/** A value's key with its accents and marks KEPT (CR-2026-11-R4, RC-18: "Ōno" and "Ono" are spelt differently). */
const markedKey = (v: string): string => {
  const p = principalValue(v);
  const key = (x: string) =>
    cleanPrefixes(x)
      .name.normalize('NFC')
      .replace(/['’ʻ`]/g, '')
      .toLocaleLowerCase('en-GB')
      .replace(/[\p{P}\p{S}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  return nameKeyOf(p) !== '' ? key(p) : key(v);
};

/**
 * CR-2026-11-R4 (RC-18): how two identity values compare: `same`; `spelling` when a name (`name`: a given name or a
 * surname) differs only in accents or marks ("Ōno", "Ono": D3 normalises them, so never a conflict, but reported as
 * information); `differs`. Word order is ignored only for a two-part personal name: the character's given name and
 * surname in either order (East Asian order, D3); with the character's names unknown (`person` absent), any two words
 * in either order, as before.
 */
export function identityCompare(
  a: string,
  b: string,
  person?: { readonly given: string | null; readonly surname: string | null },
  name = false,
): 'same' | 'spelling' | 'differs' {
  const ka = principalKey(a);
  const kb = principalKey(b);
  const swapped = (): boolean => {
    const wa = ka.split(' ');
    const wb = kb.split(' ');
    // The character's names unknown: any two words in either order (D3's East Asian order), as before.
    if (!person) return wa.length === 2 && wb.length === 2 && wa[0] === wb[1] && wa[1] === wb[0];
    if (!person.given || !person.surname) return false;
    const g = nameKeyOf(person.given);
    const s = nameKeyOf(person.surname);
    if (g === '' || s === '') return false;
    const forms = new Set([`${g} ${s}`, `${s} ${g}`]);
    return forms.has(ka) && forms.has(kb);
  };
  if (ka !== kb && !swapped()) return 'differs';
  return name && ka === kb && markedKey(a) !== markedKey(b) ? 'spelling' : 'same';
}

/** An identity value, normalised: case, diacritics and punctuation ignored, its words in any order. */
export const identityKey = (v: string): string =>
  nameKeyOf(v)
    .split(' ')
    .filter((w) => w !== '')
    .sort()
    .join(' ');

export interface CompareInput {
  readonly cal: Calendar | null;
  readonly margin: number;
  readonly page: (id: string) => PageInfo;
  readonly identityPageId: string;
  /** The facts about the character, in its continuity and scope, with the identity page's own among them. */
  readonly facts: readonly StoredFact[];
  /** Identity values shown for an AU from Main CANON (D9), by kind or field. */
  readonly inherited?: ReadonlyMap<string, StoredFact>;
  readonly inheritedLabel?: string;
  /** Whether a chronology row relates to a page (the row mentions it, or the page links to the row's table). */
  readonly rowRelates: (row: StoredFact, pageId: string) => boolean;
  /**
   * ADR 0064 amendment 1 (F): a fact from a section or row marked non-current, brought in with `include`, is historical
   * material: never the reference, and labelled "Historical material differs". False: such facts count as current.
   */
  readonly nonCurrentHistorical?: boolean;
  /**
   * CR-2026-11-R4 (the owner's request L): a character with more than one life. The identity page's own birth and death
   * statements by the life they belong to (`page:seq` → life), and whether a span agrees with ANY life's start (a birth,
   * a return, a restoration) or death: a restatement that does is no disagreement, and one life's own value is never
   * compared with another life's.
   */
  readonly lives?: {
    readonly lifeOf: ReadonlyMap<string, number>;
    readonly agrees: (kind: 'birth' | 'death', s: Span) => boolean;
  };
  /** CR-2026-11-R4 (RC-18): the character's given name and surname (a two-part personal name in either order agrees). */
  readonly person?: { readonly given: string | null; readonly surname: string | null };
  /** CR-2026-11-R4 (RC-18): the identity fields that hold a name (the given name, the surname): accents reported. */
  readonly nameFields?: readonly string[];
}

const SOURCE_ORDER: Readonly<Record<StoredFact['source'], number>> = {
  temporalScope: 0,
  lifeState: 1,
  sidebar: 2,
  prose: 3,
  chronology: 4,
};

/** Every disagreement of one character (D3, D4). */
export function compareCharacter(o: CompareInput): Disagreement[] {
  const out: Disagreement[] = [];
  const span = (f: StoredFact): Span | null => (o.cal && f.date ? spanOf(o.cal, f.date, o.margin) : null);
  const conflict = (a: StoredFact, b: StoredFact): boolean | null => {
    if (a.kind === 'identity') return identityCompare(a.valueText, b.valueText, o.person) === 'differs';
    const sa = span(a);
    const sb = span(b);
    return sa && sb ? !overlaps(sa, sb) : null;
  };
  const factKey = (f: StoredFact) => `${f.pageId}:${f.seq}`;
  /** CR-2026-11-R4 (request L): a value that is another life's own, or that agrees with any life's: never a conflict. */
  const otherLife = (kind: CompareKind, ref: StoredFact, f: StoredFact): boolean => {
    if (!o.lives || (kind !== 'birth' && kind !== 'death')) return false;
    const fl = o.lives.lifeOf.get(factKey(f));
    if (fl !== undefined) return fl !== o.lives.lifeOf.get(factKey(ref));
    const s = span(f);
    return s !== null && o.lives.agrees(kind, s);
  };
  const hist = (f: StoredFact): boolean => o.nonCurrentHistorical === true && f.nonCurrent === true;
  const sorted = (list: readonly StoredFact[]) =>
    [...list].sort(
      (a, b) =>
        Number(hist(a)) - Number(hist(b)) ||
        SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] ||
        lifecycleRank(o.page(a.pageId).lifecycle) - lifecycleRank(o.page(b.pageId).lifecycle) ||
        a.pageId.localeCompare(b.pageId) ||
        a.seq - b.seq,
    );

  /** One fact compared across pages: the identity page's value first, then every restatement. */
  const compareGroup = (
    kind: CompareKind,
    what: string,
    field: string | null,
    group: readonly StoredFact[],
    inheritedRef?: StoredFact,
  ) => {
    const own = sorted(group.filter((f) => f.pageId === o.identityPageId && f.source !== 'chronology'));
    const others = sorted(group.filter((f) => !own.includes(f)));
    const ownValue = own.find((f) => !hist(f) && (f.gap || f.date !== null || f.kind === 'identity'));
    let reference: StoredFact | null = ownValue ?? null;
    let fromRestatement = false;
    if (!reference) {
      reference =
        others.find(
          (f) =>
            o.page(f.pageId).lifecycle === 'Authoritative' &&
            !hist(f) &&
            !f.gap &&
            (f.date !== null || f.kind === 'identity'),
        ) ?? null;
      fromRestatement = reference !== null;
    }
    // CR-2026-11-R4 (RC-8, D9): an AU's own restatements come first; Main CANON's value stands in only when the AU
    // states none (then nothing of the AU's Authoritative pages is compared against it).
    if (!reference) reference = inheritedRef ?? null;
    if (!reference) return;
    const refPage = o.page(reference.pageId);
    const buckets = new Map<Label, ValueView[]>();
    const add = (l: Label, f: StoredFact) => {
      const list = buckets.get(l) ?? [];
      list.push(viewOf(f, o.page(f.pageId)));
      buckets.set(l, list);
    };
    for (const f of [...own, ...others]) {
      if (f === reference) continue;
      if (f.unreadable) {
        add('unreadable', f);
        continue;
      }
      if (hist(f)) {
        // Non-current material brought in: historical whenever it differs (a value against a gap included).
        if (f.gap !== reference.gap || (!f.gap && conflict(reference, f) === true)) add('historical', f);
        continue;
      }
      if (f.gap !== reference.gap) {
        add('gap', f);
        continue;
      }
      if (f.gap) continue; // both deliberately unestablished: they agree
      if (otherLife(kind, reference, f)) continue;
      if (
        kind === 'identity' &&
        identityCompare(
          reference.valueText,
          f.valueText,
          o.person,
          (o.nameFields ?? []).some((n) => identityKey(n) === identityKey(f.field ?? '')),
        ) === 'spelling'
      ) {
        add('spelling', f);
        continue;
      }
      const c = conflict(reference, f);
      if (c !== true) continue;
      add(labelOf(refPage, o.page(f.pageId)), f);
    }
    for (const [label, restatements] of buckets)
      out.push({
        kind,
        what,
        field,
        label,
        reference: viewOf(reference, refPage, reference === inheritedRef ? o.inheritedLabel : undefined),
        referenceFromRestatement: fromRestatement,
        restatements,
      });
  };

  const pageFacts = o.facts.filter((f) => f.source !== 'chronology');
  for (const kind of ['birth', 'death'] as const)
    compareGroup(
      kind,
      kind,
      null,
      pageFacts.filter((f) => f.kind === kind),
      o.inherited?.get(kind),
    );
  const fields = new Map<string, StoredFact[]>();
  for (const f of pageFacts.filter((x) => x.kind === 'identity' && x.field)) {
    const k = identityKey(f.field!);
    fields.set(k, [...(fields.get(k) ?? []), f]);
  }
  for (const [k, list] of fields)
    compareGroup('identity', list[0]!.field!, list[0]!.field, list, o.inherited?.get(`identity:${k}`));

  // Chronology (D1): a row's date against the same event restated on a page it relates to (the row mentions the page,
  // or the page links to the row's table) that names the same subject and the same kind of event.
  for (const row of o.facts.filter(
    (f) => f.source === 'chronology' && (f.kind === 'birth' || f.kind === 'death'),
  )) {
    const rowPage = o.page(row.pageId);
    const buckets = new Map<Label, ValueView[]>();
    for (const f of sorted(pageFacts.filter((x) => x.kind === row.kind && o.rowRelates(row, x.pageId)))) {
      if (row.unreadable || f.unreadable) {
        if (f.unreadable)
          buckets.set('unreadable', [...(buckets.get('unreadable') ?? []), viewOf(f, o.page(f.pageId))]);
        continue;
      }
      if (f.gap) {
        const l = hist(row) || hist(f) ? 'historical' : 'gap';
        buckets.set(l, [...(buckets.get(l) ?? []), viewOf(f, o.page(f.pageId))]);
        continue;
      }
      if (conflict(row, f) !== true) continue;
      // CR-2026-11-R4 (request L): a row and a page that each agree with one of the character's lives agree.
      const sr = span(row);
      const sf = span(f);
      if (
        o.lives &&
        sr &&
        sf &&
        o.lives.agrees(row.kind as 'birth' | 'death', sr) &&
        o.lives.agrees(row.kind as 'birth' | 'death', sf)
      )
        continue;
      const l = hist(row) || hist(f) ? 'historical' : labelOf(rowPage, o.page(f.pageId));
      buckets.set(l, [...(buckets.get(l) ?? []), viewOf(f, o.page(f.pageId))]);
    }
    for (const [label, restatements] of buckets)
      out.push({
        kind: 'chronology',
        what: row.kind,
        field: null,
        label,
        reference: viewOf(row, rowPage),
        referenceFromRestatement: false,
        restatements,
        row: `${row.documentId ?? ''}:${row.blockId ?? ''}`,
      });
  }
  return out;
}
