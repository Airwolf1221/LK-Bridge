/**
 * v3 F4a (ADR 0063): namesakes. Characters share names, and Character Architecture makes a naming-culture review
 * mandatory at every intake; this finds the current characters that share a name, free, from the bridge's repository
 * tree and its stored sidebars (no LegendKeeper read).
 *
 * - **Current characters**: every Character Core and Compact Character Reference (the pack's identity roles) that is
 *   Authoritative or Working, AU included and labelled; never an Archived one, nor one in the Legacy Canon Archive or
 *   the Design References (ADR 0054's non-current areas).
 * - **What is matched**: the full name (the page's subject, its Canonical Display Name, and its given and family names
 *   in either order), the given name, the surname and every alias (the page's aliases and its Aliases fact). Names are
 *   compared without case, accents, punctuation or a lifecycle prefix (`[BSRC]`).
 * - **Name order**: a full name is matched in both orders, so "Asagiri Miyabi" finds "Miyabi Asagiri" and the reverse,
 *   whichever order the East Asian Personal Name Presentation Standard presents it in. The bridge never decides a
 *   culture's order itself.
 * - **Severity**: `warning` when the full name is exactly a name another current character goes by (its full name in
 *   either order, its Canonical Display Name or one of its aliases); `info` for every partial match (a given name, a
 *   surname, an alias of the new name). Never a refusal: names may be shared.
 *
 * It never suggests or infers a naming culture, race or nationality from a name, and never proposes a rename: it
 * reports what the bridge's records say, and the agent asks the owner.
 */
import { labelContext, labelsOf, type AreaKey, type LabelPath } from '../../appraisal/scope.js';
import type { LifecycleConfig } from '../../lifecycle/settings.js';
import type { RepoCtx } from '../../mcp/tools/repo.js';
import { cleanPrefixes } from '../../registry/names.js';
import type { SidebarBlock, TreeNode } from '../../tree/index.js';
import { isPlaceholder, textKey } from '../engine/text.js';
import type { PackRules, TypeRules } from '../types.js';

// ============================================================================================ names

/** A name's comparable form: case, accents, apostrophes and punctuation ignored, a lifecycle prefix removed. */
export function nameKeyOf(s: string): string {
  return cleanPrefixes(s)
    .name.normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/['’ʻ`]/g, '')
    .toLocaleLowerCase('en-GB')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The subject of a page name: the part before " - " (a character's page is "<Name> - <descriptor>"). */
export function subjectPart(name: string): string {
  return cleanPrefixes(name).name.split(' - ')[0]!.trim();
}

/**
 * What opens a bracketed NOTE on an alias rather than a part of its name (ADR 0064 amendment 2): a time ("from 4A 192",
 * "until …", "c. …"), or what kind of name it is ("birth", "birth name", "earlier birth/family name", "maiden name",
 * "regnal name", "childhood name", "nickname").
 */
const NOTE_START =
  /^(?:from|until|till|to|since|after|before|during|c\.|ca\.|circa|approx\.?|approximately|born|birth|earlier|later|former|formerly|original|originally|maiden|childhood|regnal|nickname|informal|formal|family|given|personal|courtesy|used|as|in|by|nee|née)\b/iu;

/** Whether a bracket's inside is a note: it holds a digit (a date or range), opens as a note does, or ends "name(s)". */
function isAliasNote(inner: string): boolean {
  const t = inner.trim();
  return t === '' || /\d/u.test(t) || NOTE_START.test(t) || /\bnames?$/iu.test(t);
}

/**
 * One alias as a bare name (ADR 0064 amendment 2): every trailing bracketed note dropped ("Rita von Katzen (4A 99-192)"
 * → "Rita von Katzen"; "Mizuno Rei (birth name)" → "Mizuno Rei"). A bracket that is not a note ("Leopold (the Elder)")
 * stays part of the name.
 */
export function aliasName(s: string): string {
  let t = s.replace(/\s+/g, ' ').trim();
  for (;;) {
    const m = /\s*[([]([^()[\]]*)[)\]]\s*$/u.exec(t);
    if (!m || !isAliasNote(m[1]!) || m.index === 0) return t;
    t = t.slice(0, m.index).trim();
  }
}

/**
 * An Aliases fact as bare names: THE alias parser (ADR 0064 amendment 2), used by the facts index, `arkona_as_of`,
 * `arkona_consistency`, `arkona_brief`, `arkona_name_check`, the character tools and the rename review. Aliases are
 * separated by semicolons or line breaks (a comma may sit inside a note's date: "(from Zahras 1st, 4A 192)"); each loses
 * its trailing bracketed notes (`aliasName`).
 */
export function splitAliases(v: string | null | undefined): string[] {
  return [
    ...new Set(
      (v ?? '')
        .split(/[;\n]/)
        .map(aliasName)
        .filter((s) => s !== '' && s !== '…' && s !== '...'),
    ),
  ];
}

/** The names a character goes by, as matching reads them. */
export interface NameSet {
  /** Its full names: the subject, the Canonical Display Name (as written). */
  readonly full: readonly string[];
  readonly given: string | null;
  readonly surname: string | null;
  readonly aliases: readonly string[];
}

/** What is asked: a name, its parts, its aliases (each optional). */
export interface NameQuery {
  readonly name?: string | null | undefined;
  readonly givenName?: string | null | undefined;
  readonly surname?: string | null | undefined;
  readonly aliases?: readonly string[] | undefined;
}

export type MatchPart = 'full name' | 'given name' | 'surname' | 'alias';

export interface NameMatch {
  readonly part: MatchPart;
  /** The name asked about, and theirs, as written. */
  readonly yours: string;
  readonly theirs: string;
  /** How it matched, when not word for word: the other order, a word of the name. */
  readonly how?: string;
  readonly severity: 'warning' | 'info';
}

const words = (k: string) => (k === '' ? [] : k.split(' '));
/** `part` (words) appears as whole words inside `whole`. */
const holds = (whole: string, part: string): boolean => part !== '' && ` ${whole} `.includes(` ${part} `);

/**
 * How one character's names match a query (empty: no match). `usable` says whether a value counts as a name (not blank,
 * a placeholder, or a deliberate gap such as `Unestablished`).
 */
export function matchNames(q: NameQuery, c: NameSet, usable: (v: string) => boolean): NameMatch[] {
  const out: NameMatch[] = [];
  const ok = (v: string | null | undefined): v is string => typeof v === 'string' && usable(v);
  const qName = ok(q.name) ? q.name.trim() : null;
  const qGiven = ok(q.givenName) ? q.givenName.trim() : null;
  const qSurname = ok(q.surname) ? q.surname.trim() : null;
  const qAliases = (q.aliases ?? []).filter(ok).map((a) => a.trim());
  const cGiven = ok(c.given) ? c.given.trim() : null;
  const cSurname = ok(c.surname) ? c.surname.trim() : null;
  const cFull = c.full.filter(ok);
  const cAliases = c.aliases.filter(ok);

  // The full names asked about: the name, and the parts in either order.
  const asked: { text: string; composed: boolean }[] = [];
  if (qName) asked.push({ text: qName, composed: false });
  if (qGiven && qSurname)
    asked.push(
      { text: `${qGiven} ${qSurname}`, composed: true },
      { text: `${qSurname} ${qGiven}`, composed: true },
    );
  // The full name: as written (their subject or Canonical Display Name), else one of their aliases, else their given
  // name and surname together, else (no parts recorded) the same two words in the other order. One match is reported,
  // the most exact.
  let full: NameMatch | null = null;
  for (const a of asked) {
    const hit = cFull.find((x) => nameKeyOf(x) === nameKeyOf(a.text));
    if (hit) {
      full = { part: 'full name', yours: a.text, theirs: hit, severity: 'warning' };
      break;
    }
  }
  if (!full)
    for (const a of asked) {
      const hit = cAliases.find((x) => nameKeyOf(x) === nameKeyOf(a.text));
      if (hit) {
        full = {
          part: 'alias',
          yours: a.text,
          theirs: hit,
          how: 'your full name is their alias',
          severity: 'warning',
        };
        break;
      }
    }
  if (!full && cGiven && cSurname) {
    // The order their name is written in, read from their own records (never from their culture).
    const written = nameKeyOf(cFull[0] ?? '');
    const presented = written.startsWith(`${nameKeyOf(cGiven)} `)
      ? 'given'
      : written.startsWith(`${nameKeyOf(cSurname)} `)
        ? 'family'
        : null;
    for (const a of asked) {
      for (const [text, first] of [
        [`${cGiven} ${cSurname}`, 'given'],
        [`${cSurname} ${cGiven}`, 'family'],
      ] as const) {
        if (nameKeyOf(text) !== nameKeyOf(a.text)) continue;
        full = {
          part: 'full name',
          yours: a.text,
          theirs: cFull[0] ?? text,
          how:
            presented === null
              ? 'their given name and surname'
              : presented === first
                ? 'their given name and surname, in the order their name is written'
                : 'the same names in the other order',
          severity: 'warning',
        };
        break;
      }
      if (full) break;
    }
  }
  if (!full)
    for (const a of asked) {
      const aw = words(nameKeyOf(a.text));
      const hit = cFull.find((t) => {
        const w = words(nameKeyOf(t));
        return w.length === 2 && aw.length === 2 && w[0] === aw[1] && w[1] === aw[0];
      });
      if (hit) {
        full = {
          part: 'full name',
          yours: a.text,
          theirs: hit,
          how: 'the same two names in the other order',
          severity: 'warning',
        };
        break;
      }
    }
  if (full) out.push(full);

  // Partial matches (info): the given name, the surname, an alias of the new name.
  if (qGiven && cGiven && nameKeyOf(qGiven) === nameKeyOf(cGiven))
    out.push({ part: 'given name', yours: qGiven, theirs: cGiven, severity: 'info' });
  if (qSurname && cSurname && nameKeyOf(qSurname) === nameKeyOf(cSurname))
    out.push({ part: 'surname', yours: qSurname, theirs: cSurname, severity: 'info' });
  for (const a of qAliases) {
    const ak = nameKeyOf(a);
    const hit = [...cFull, ...cAliases].find((x) => nameKeyOf(x) === ak);
    if (hit)
      out.push({ part: 'alias', yours: a, theirs: hit, how: 'your alias is their name', severity: 'info' });
  }
  // Only a name was given (no parts): their given name or surname as whole words of it (literal, never a guess).
  if (qName && !qGiven && !qSurname && !full) {
    const nk = nameKeyOf(qName);
    if (cGiven && holds(nk, nameKeyOf(cGiven)))
      out.push({
        part: 'given name',
        yours: qName,
        theirs: cGiven,
        how: 'their given name is a word of the name',
        severity: 'info',
      });
    if (cSurname && holds(nk, nameKeyOf(cSurname)))
      out.push({
        part: 'surname',
        yours: qName,
        theirs: cSurname,
        how: 'their surname is a word of the name',
        severity: 'info',
      });
  }
  return out;
}

// ============================================================================================ current characters

export type Lifecycle = 'Authoritative' | 'Working';

/** A current character as the bridge's records hold it (its identity page and its identity facts). */
export interface CharacterRecord {
  readonly identity: { readonly id: string; readonly name: string; readonly role: string };
  readonly subject: string;
  readonly index: { readonly id: string; readonly name: string } | null;
  readonly path: string;
  readonly lifecycle: Lifecycle;
  readonly au: boolean;
  readonly names: NameSet;
  readonly namingCulture: string | null;
  readonly lifeState: string | null;
  /** Where its facts came from: the tree's last read of its sidebar (and when), or none yet. */
  readonly factsReadAt: number | null;
}

export interface CharacterScan {
  readonly characters: readonly CharacterRecord[];
  /** Identity pages left out as not current: Archived ones and those in a non-current area. */
  readonly leftOut: { readonly archived: number; readonly areas: Partial<Record<AreaKey, number>> };
  /** Current identity pages whose sidebar the tree has not read yet (matched by their names and aliases only). */
  readonly unread: number;
}

/** The pack's character type (its identity roles and fields). */
export function characterTypeOf(rules: PackRules): TypeRules | null {
  return rules.types.find((t) => t.hook === 'character') ?? null;
}

/** A sidebar row of the tree's summary (the key-value property named `property`). */
function rowOf(sidebar: readonly SidebarBlock[] | null, property: string, key: string): string | null {
  if (!sidebar) return null;
  const kv = sidebar.find((p) => p.kind === 'keyValue' && textKey(p.title ?? '') === textKey(property));
  const r = kv?.rows?.find((x) => textKey(x.key) === textKey(key));
  if (!r) return null;
  const t = r.text.trim();
  return t === '' ? null : t;
}

/** The labels of a tree node: its lifecycle and non-current area, as the appraisal labels pages (ADR 0054). */
export function treeLabeller(ctx: RepoCtx, lifecycle: LifecycleConfig) {
  const kinds = new Map<string, string>();
  const kindOf = (id: string) => {
    let k = kinds.get(id);
    if (k === undefined) {
      k = ctx.tree.node(ctx.projectId, id).data?.kind ?? '';
      kinds.set(id, k);
    }
    return k;
  };
  const lc = labelContext(ctx.meta.rootId, lifecycle);
  return (n: TreeNode) => {
    const path: LabelPath = { ids: n.path.ids, names: n.path.names, kinds: n.path.ids.map(kindOf) };
    return labelsOf(path, lc);
  };
}

/** Every current character (free: the tree and its stored sidebars). */
export function currentCharacters(o: {
  readonly ctx: RepoCtx;
  readonly rules: PackRules;
  readonly lifecycle: LifecycleConfig;
  /** Areas brought in (`legacy`, `design`); default none. */
  readonly include?: ReadonlySet<string>;
}): CharacterScan {
  const { ctx, rules } = o;
  const type = characterTypeOf(rules);
  if (!type) return { characters: [], leftOut: { archived: 0, areas: {} }, unread: 0 };
  const identityRoles = type.roles.filter((r) => r.facts === 'identity' && r.referenceType);
  const roleOf = new Map(identityRoles.map((r) => [textKey(r.referenceType!), r]));
  const keyOf = (field: string, fallback: string) =>
    type.identity.find((f) => f.field === field)?.key ?? fallback;
  const keys = {
    given: keyOf('givenName', 'Personal / Given Name'),
    surname: keyOf('surname', 'Family / Surname'),
    culture: keyOf('namingCulture', 'Naming Culture'),
    lifeState: keyOf('lifeState', 'Life State'),
    cdn: keyOf('canonicalDisplayName', 'Canonical Display Name'),
    aliases: keyOf('aliases', 'Aliases'),
    subject: keyOf('subject', 'Subject'),
    continuityType: o.lifecycle.fields.continuityType,
  };
  const property = rules.sidebar.property;
  const auType = rules.tags.au?.continuityType ?? null;
  const labels = treeLabeller(ctx, o.lifecycle);
  const include = o.include ?? new Set<string>();
  const nodes: TreeNode[] = [];
  let archived = 0;
  const areas: Partial<Record<AreaKey, number>> = {};
  for (const kind of ['bsrc', 'bwrk', 'barc'] as const)
    for (const n of ctx.tree.byKind(ctx.projectId, kind).data) {
      if (!n.referenceType || !roleOf.has(textKey(n.referenceType))) continue;
      if (kind === 'barc') {
        archived++;
        continue;
      }
      const l = labels(n);
      if (l.area && !include.has(l.area)) {
        areas[l.area] = (areas[l.area] ?? 0) + 1;
        continue;
      }
      if (l.lifecycle === 'Archived') {
        archived++;
        continue;
      }
      nodes.push(n);
    }
  const sidebars = ctx.tree.sidebars(
    ctx.projectId,
    nodes.map((n) => n.id),
  ).data;
  let unread = 0;
  const characters: CharacterRecord[] = [];
  for (const n of nodes) {
    const sb = sidebars.get(n.id) ?? null;
    if (!sb) unread++;
    const row = (k: string) => rowOf(sb, property, k);
    const subject = row(keys.subject) ?? subjectPart(n.displayName);
    const cdn = row(keys.cdn) ?? n.canonicalDisplayName;
    const parent = n.parentId ? ctx.tree.node(ctx.projectId, n.parentId).data : null;
    const index =
      parent && parent.kind === 'index' && nameKeyOf(parent.displayName) === nameKeyOf(subject)
        ? parent
        : null;
    const role = roleOf.get(textKey(n.referenceType!))!;
    const continuity = row(keys.continuityType);
    characters.push({
      identity: { id: n.id, name: n.rawName, role: role.referenceType ?? role.role },
      subject,
      index: index ? { id: index.id, name: index.rawName } : null,
      path: n.path.names.join(' / '),
      lifecycle: labels(n).lifecycle === 'Working' || n.kind === 'bwrk' ? 'Working' : 'Authoritative',
      au: auType !== null && continuity !== null && textKey(continuity) === textKey(auType),
      names: {
        full: [...new Set([subject, ...(cdn ? [cdn] : [])])],
        given: row(keys.given),
        surname: row(keys.surname),
        aliases: [
          ...new Set([
            ...n.aliases.map(aliasName).filter((a) => a !== ''),
            ...splitAliases(row(keys.aliases)),
          ]),
        ],
      },
      namingCulture: row(keys.culture),
      lifeState: row(keys.lifeState),
      factsReadAt: sb ? n.lastReadAt : null,
    });
  }
  return { characters, leftOut: { archived, areas }, unread };
}

/** Whether a value counts as a name: not blank, not a placeholder, not a deliberate gap (`Unestablished`, `None`). */
export function usableName(rules: PackRules): (v: string) => boolean {
  const type = characterTypeOf(rules);
  const never = new Set([...rules.tags.never, ...(type ? [type.unestablished] : [])].map((v) => textKey(v)));
  const placeholders = type?.placeholders ?? [];
  return (v: string) => {
    const t = v.trim();
    return t !== '' && !never.has(textKey(t)) && !isPlaceholder(t, placeholders);
  };
}

/** One namesake, as every answer shows it. */
export interface Namesake {
  readonly character: CharacterRecord;
  readonly matched: readonly NameMatch[];
  readonly severity: 'warning' | 'info';
}

/** The namesakes of a query among the current characters (`exclude`: identity page ids left out). */
export function namesakesOf(
  scan: CharacterScan,
  q: NameQuery,
  usable: (v: string) => boolean,
  exclude: ReadonlySet<string> = new Set(),
): Namesake[] {
  const out: Namesake[] = [];
  for (const c of scan.characters) {
    if (exclude.has(c.identity.id)) continue;
    const matched = matchNames(q, c.names, usable);
    if (matched.length === 0) continue;
    out.push({
      character: c,
      matched,
      severity: matched.some((m) => m.severity === 'warning') ? 'warning' : 'info',
    });
  }
  return out.sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === 'warning' ? -1 : 1) ||
      a.character.subject.localeCompare(b.character.subject, 'en', { sensitivity: 'base' }),
  );
}

/** A namesake as the answers list it (its identity page, Naming Culture and Life State, what matched). */
export function namesakeView(n: Namesake): Record<string, unknown> {
  const c = n.character;
  return {
    character: c.subject,
    identityPage: c.identity,
    ...(c.index ? { index: c.index } : {}),
    path: c.path,
    lifecycle: c.lifecycle,
    labels: [c.lifecycle, ...(c.au ? ['AU'] : [])],
    namingCulture: c.namingCulture,
    lifeState: c.lifeState,
    givenName: c.names.given,
    surname: c.names.surname,
    ...(c.names.aliases.length > 0 ? { aliases: c.names.aliases } : {}),
    matched: n.matched,
    severity: n.severity,
    ...(c.factsReadAt === null
      ? { note: 'its facts are not read yet: matched by its names and aliases only' }
      : {}),
  };
}

/** One line for a warning or a proposal's summary: who has the name, and how. */
export function namesakeLine(n: Namesake): string {
  const c = n.character;
  const m = n.matched.find((x) => x.severity === 'warning') ?? n.matched[0]!;
  const labels = [c.lifecycle, ...(c.au ? ['AU'] : [])].join(', ');
  return `${c.subject} (${labels}; Naming Culture ${c.namingCulture ?? 'not recorded'}; Life State ${c.lifeState ?? 'not recorded'}): ${m.part} “${m.theirs}”${m.how ? `, ${m.how}` : ''}`;
}
