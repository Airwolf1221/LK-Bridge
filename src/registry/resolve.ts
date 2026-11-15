/**
 * Name resolution (v2 A3, PLAN-v2 4.4): one shared resolver for every tool that accepts "name or id", built on the
 * tree's exact-name lookups. Exactly one match is used; several are refused with every candidate and its path; none is
 * `not_found`, with near names as a hint only. No fuzzy matching ever decides anything.
 */
import type { ResolveMention } from '../markdown/index.js';
import { KIND_PREFIX, isPageKind, type PageKind, type TreeNode } from '../tree/index.js';
import { cleanPrefixes, key, subjectOf } from './names.js';
import type { RegistryStore } from './store.js';
import type { ProjectTree } from './tree-view.js';
import {
  RegistryError,
  type CharacterPlacementConfig,
  type MatchField,
  type NodeRef,
  type ResolveKind,
  type ResolveOptions,
  type ResolveResult,
} from './types.js';

/** v2 C2b: a character page's role, and the order a mention prefers them in. */
export type CharacterRole = 'core' | 'compact' | 'index';
const ROLE_ORDER: readonly CharacterRole[] = ['core', 'compact', 'index'];
/** v2 C2c: why a mention chose its page: the character role (C2b), or the page's lifecycle state. */
export type MentionRole = CharacterRole | PageKind;
export const ROLE_LABEL: Readonly<Record<MentionRole, string>> = {
  core: 'Character Core',
  compact: 'Character Reference',
  index: 'character index',
  bsrc: 'current [BSRC] page',
  bwrk: 'Working [BWRK] page',
  barc: 'Archived [BARC] page',
};

/** v2 C2c (ADR 0035): the order a mention prefers the lifecycle states of one subject in: current first. */
const STATE_RANK: Readonly<Record<PageKind, number>> = { bsrc: 0, bwrk: 1, barc: 2 };

/**
 * v2 E3b (ADR 0045): the character a page belongs to, for the places that need the character's own page: a Core or
 * Reference itself, a character's index (Working or Archived ones too), or a specialist page (`{name} - Art`, any page
 * whose subject is the character).
 */
export interface CharacterOfPage {
  readonly subject: string;
  /** The character's Character Core, else its Compact Character Reference. */
  readonly core: NodeRef;
  readonly role: 'core' | 'compact';
  /** How the page led to the character: it is the Core or Reference, it is the character's index, or its subject names the character. */
  readonly via: 'page' | 'index' | 'subject';
  /** The Race / Species fact as the repository tree holds it; null when the tree has none for that page. */
  readonly race: string | null;
}

export type CharacterOfPageResult =
  | { readonly ok: true; readonly value: CharacterOfPage }
  | { readonly ok: false; readonly reason: 'not_found'; readonly subject: string | null }
  | {
      readonly ok: false;
      readonly reason: 'several';
      readonly subject: string;
      readonly candidates: readonly NodeRef[];
    };

/** v2 C2b: the page a mention of one character's pages went to, and why. */
export interface MentionChoice {
  readonly chosen: NodeRef;
  readonly role: MentionRole;
  readonly subject: string;
  readonly candidates: readonly (NodeRef & { readonly role: string })[];
  readonly why: string;
}

const FIELD_RANK: Readonly<Record<MatchField, number>> = {
  id: 0,
  raw: 1,
  display: 2,
  alias: 3,
  canonical: 4,
};
const KINDS: readonly ResolveKind[] = ['index', 'bsrc', 'bwrk', 'barc', 'unclassified'];
const LK_URI = /^lk:\/\/resources\/([a-z][0-9a-z]{1,63})\/?$/;
const MAX_QUERY = 500;

export class NameResolver {
  constructor(
    private readonly tree: ProjectTree,
    private readonly store: RegistryStore,
  ) {}

  /** The scope's top node id (searched below it, not itself), or null for the whole tree. */
  private scopeTop(o: ResolveOptions): string | null {
    const s = o.scope;
    if (!s) return null;
    if ('under' in s) {
      if (!this.tree.node(s.under)) {
        throw new RegistryError('SCOPE_NOT_FOUND', `The scope ${s.under} is not in the repository tree.`, {
          scope: s.under,
        });
      }
      return s.under;
    }
    const t = this.store.typeByName(s.type);
    if (!t) {
      const known = this.store.listTypes().map((x) => x.singular);
      throw new RegistryError(
        'UNKNOWN_TYPE',
        `No type named “${s.type}”. Types: ${known.length ? known.join(', ') : 'none yet'}.`,
        { types: known },
      );
    }
    if (!t.rootIndexId || !this.tree.node(t.rootIndexId)) {
      throw new RegistryError(
        'TYPE_ROOT_MISSING',
        `The type ${t.singular} has no root index in the repository tree, so it cannot scope a search.`,
        { typeId: t.id },
      );
    }
    return t.rootIndexId;
  }

  private accepts(n: TreeNode, top: string | null, kinds: ReadonlySet<string> | null): boolean {
    if (kinds && !kinds.has(n.kind)) return false;
    if (top !== null && (n.id === top || !n.path.ids.includes(top))) return false;
    return true;
  }

  resolve(query: string, o: ResolveOptions = {}): ResolveResult {
    const meta = this.tree.requireUsable();
    if (typeof query !== 'string' || query.trim() === '') {
      throw new RegistryError('INVALID_INPUT', 'A name or id is required.');
    }
    if (query.length > MAX_QUERY) throw new RegistryError('INVALID_INPUT', 'That name is too long.');
    const top = this.scopeTop(o);
    const kinds = o.kinds && o.kinds.length > 0 ? new Set<string>(o.kinds) : null;
    if (o.kinds?.some((k) => !KINDS.includes(k))) {
      throw new RegistryError('INVALID_INPUT', `Kinds are ${KINDS.join(', ')}.`);
    }
    const trimmed = query.trim();
    const { name: cleaned, prefix } = cleanPrefixes(trimmed);

    // An id (or an lk://resources/<id> link) is always accepted, within the scope and kinds asked for.
    const idCandidate = LK_URI.exec(trimmed)?.[1] ?? trimmed;
    const byId = this.tree.node(idCandidate);
    if (byId && byId.id === idCandidate) {
      if (!this.accepts(byId, top, kinds)) {
        throw new RegistryError(
          'OUT_OF_SCOPE',
          `${byId.id} (“${byId.path.names.join(' / ')}”) is outside the scope or kinds asked for.`,
          { node: this.tree.ref(byId) },
        );
      }
      return {
        status: 'resolved',
        node: this.tree.ref(byId),
        matchedBy: 'id',
        query,
        cleaned: idCandidate,
        tree: meta,
      };
    }
    if (cleaned === '') throw new RegistryError('INVALID_INPUT', 'Only a prefix was given, with no name.');

    const found = new Map<string, { node: TreeNode; field: MatchField }>();
    const take = (node: TreeNode, field: MatchField) => {
      if (!this.accepts(node, top, kinds)) return;
      const had = found.get(node.id);
      if (!had || FIELD_RANK[field] < FIELD_RANK[had.field]) found.set(node.id, { node, field });
    };
    // The cleaned name against display names, aliases and Canonical Display Names; and raw names as typed (collapsed
    // to one prefix), so "[INDEX] Humans" matches the index's raw name exactly.
    for (const m of this.tree.findByName(cleaned)) take(m.node, m.field);
    if (prefix) {
      const raw = `${KIND_PREFIX[prefix]}${cleaned}`;
      for (const m of this.tree.findByRawName(raw)) take(m.node, 'raw');
    }
    let matches = [...found.values()];
    // A stray prefix is a hint the agent gave: when it tells the matches apart, it is used.
    if (prefix && matches.length > 1) {
      const same = matches.filter((m) => m.node.kind === prefix);
      if (same.length > 0) matches = same;
    }
    if (matches.length === 1) {
      return {
        status: 'resolved',
        node: this.tree.ref(matches[0]!.node),
        matchedBy: matches[0]!.field,
        query,
        cleaned,
        tree: meta,
      };
    }
    if (matches.length > 1) {
      return {
        status: 'ambiguous',
        candidates: matches
          .map((m) => ({ ...this.tree.ref(m.node), matchedBy: m.field }))
          .sort((a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id)),
        query,
        cleaned,
        tree: meta,
      };
    }
    return { status: 'not_found', near: this.near(cleaned, top, kinds), query, cleaned, tree: meta };
  }

  /** Exactly one node, or a typed error: `AMBIGUOUS` with every candidate, `NOT_FOUND` with near names (a hint). */
  resolveOne(query: string, o: ResolveOptions = {}): NodeRef {
    const r = this.resolve(query, o);
    if (r.status === 'resolved') return r.node;
    if (r.status === 'ambiguous') {
      throw new RegistryError(
        'AMBIGUOUS',
        `“${query}” matches ${r.candidates.length} pages; name one by id: ${r.candidates.map((c) => `${c.path} (${c.id})`).join('; ')}.`,
        { candidates: r.candidates },
      );
    }
    throw new RegistryError(
      'NOT_FOUND',
      `No page is named “${r.cleaned}”${r.near.length ? `. Near names (not used): ${r.near.map((n) => n.displayName).join(', ')}` : ''}.`,
      { near: r.near },
    );
  }

  /**
   * Up to 10 names close to the query, for the error message only: names containing it (or contained in it), then
   * those within a small edit distance. Never used to resolve anything.
   */
  private near(cleaned: string, top: string | null, kinds: ReadonlySet<string> | null): NodeRef[] {
    const root = top ?? this.tree.root()?.id;
    if (!root) return [];
    const q = key(cleaned);
    const limit = Math.max(2, Math.floor(q.length / 3));
    const scored: { node: TreeNode; score: number }[] = [];
    for (const { node } of this.tree.subtree(root)) {
      if (!this.accepts(node, top, kinds)) continue;
      let best = Number.POSITIVE_INFINITY;
      for (const n of [
        node.displayName,
        ...node.aliases,
        ...(node.canonicalDisplayName ? [node.canonicalDisplayName] : []),
      ]) {
        const k = key(n);
        if (k.length === 0) continue;
        const s = k.includes(q) || q.includes(k) ? 0.5 : levenshtein(q, k, limit);
        best = Math.min(best, s);
      }
      if (best <= limit) scored.push({ node, score: best });
    }
    return scored
      .sort((a, b) => a.score - b.score || a.node.displayName.localeCompare(b.node.displayName))
      .slice(0, 10)
      .map((s) => this.tree.ref(s.node));
  }

  /**
   * v2 C2b: a page's character role, from the registry: a Character Core or Compact Character Reference by its Reference
   * Type (a character type's), or a character index (an index under a character type's root whose name is the subject:
   * not the root, not a taxonomy category, not the unknown-race index). Null for any other page. With its subject.
   */
  characterRole(id: string): { readonly role: CharacterRole; readonly subject: string } | null {
    const n = this.tree.node(id);
    if (!n) return null;
    for (const t of this.store.listTypes()) {
      const p = t.placement;
      if (t.placementKind !== 'character' || !p) continue;
      // v2 C2c: a Working or Archived Core or Reference is one too (name handling treats [BWRK] and [BARC] like [BSRC]).
      if (isPageKind(n.kind) && n.referenceType) {
        const ref = key(n.referenceType);
        const role: CharacterRole | null =
          ref === key(p.referenceTypes.core)
            ? 'core'
            : ref === key(p.referenceTypes.compact)
              ? 'compact'
              : null;
        if (role) return { role, subject: subjectOf(n.displayName, this.tree.rowValue(n.id, p.subjectRow)) };
        continue;
      }
      if (
        n.kind !== 'index' ||
        !t.rootIndexId ||
        n.id === t.rootIndexId ||
        !n.path.ids.includes(t.rootIndexId)
      )
        continue;
      if (key(n.displayName) === key(p.unknownIndexName)) continue;
      if (this.store.entries(t.id).some((e) => e.sourceNodeId === n.id)) continue;
      return { role: 'index', subject: n.displayName };
    }
    return null;
  }

  /**
   * v2 E3b (ADR 0045): the character a page belongs to, and the page that holds the character's facts (its Core, else its
   * Reference), from the tree alone. Null `reason: not_found` when the page leads to no character: the subject (a Subject
   * row, else the name before " - ") has no Core or Reference. Several Cores of one subject in one lifecycle state are
   * `several` (they are never chosen between).
   */
  characterOfPage(id: string): CharacterOfPageResult {
    const n = this.tree.node(id);
    if (!n) return { ok: false, reason: 'not_found', subject: null };
    const placementOf = (core: TreeNode): CharacterPlacementConfig | null => {
      for (const t of this.store.listTypes()) {
        const p = t.placement;
        if (t.placementKind === 'character' && p && core.referenceType) {
          const ref = key(core.referenceType);
          if (ref === key(p.referenceTypes.core) || ref === key(p.referenceTypes.compact)) return p;
        }
      }
      return null;
    };
    const coreRole = (node: TreeNode): 'core' | 'compact' | null => {
      const r = this.characterRole(node.id)?.role;
      return r === 'core' || r === 'compact' ? r : null;
    };
    const found = (
      core: TreeNode,
      role: 'core' | 'compact',
      via: CharacterOfPage['via'],
      subject: string,
    ): CharacterOfPageResult => {
      const p = placementOf(core);
      return {
        ok: true,
        value: {
          subject,
          core: this.tree.ref(core),
          role,
          via,
          race: p ? this.tree.rowValue(core.id, p.speciesRow) : null,
        },
      };
    };
    const self = coreRole(n);
    if (self) return found(n, self, 'page', this.characterRole(n.id)!.subject);

    // A character's index (under Working or Archived too): the Core, else the Reference, directly under it.
    if (n.kind === 'index') {
      const kids = this.tree.children(n.id);
      const core = kids.find((k) => coreRole(k) === 'core');
      const ref = kids.find((k) => coreRole(k) === 'compact');
      if (core) return found(core, 'core', 'index', n.displayName);
      if (ref) return found(ref, 'compact', 'index', n.displayName);
      return { ok: false, reason: 'not_found', subject: null };
    }
    if (!isPageKind(n.kind)) return { ok: false, reason: 'not_found', subject: null };

    // A specialist page: its subject names the character. Look beside it first, then by name.
    const subject = subjectOf(n.displayName, this.tree.rowValue(n.id, 'Subject'));
    const sk = key(subject);
    const pool = new Map<string, TreeNode>();
    const consider = (c: TreeNode | null | undefined) => {
      if (!c || pool.has(c.id)) return;
      const role = coreRole(c);
      if (role && key(this.characterRole(c.id)!.subject) === sk) pool.set(c.id, c);
    };
    const parent = n.path.ids.length >= 2 ? this.tree.node(n.path.ids[n.path.ids.length - 2]!) : null;
    if (parent) for (const k of this.tree.children(parent.id)) consider(k);
    for (const m of this.tree.findByName(subject)) {
      consider(m.node);
      if (m.node.kind === 'index') for (const k of this.tree.children(m.node.id)) consider(k);
    }
    const cores = [...pool.values()];
    if (cores.length === 0) return { ok: false, reason: 'not_found', subject };
    // The current page first ([BSRC], then [BWRK], then [BARC]), a Core before a Reference; one best page is the answer.
    const rank = (c: TreeNode): number =>
      (isPageKind(c.kind) ? STATE_RANK[c.kind] : 3) * 2 + (coreRole(c) === 'core' ? 0 : 1);
    const best = Math.min(...cores.map(rank));
    const top = cores.filter((c) => rank(c) === best);
    if (top.length > 1) {
      return { ok: false, reason: 'several', subject, candidates: top.map((c) => this.tree.ref(c)) };
    }
    return found(top[0]!, coreRole(top[0]!)!, 'subject', subject);
  }

  /**
   * v2 C2b (decided by the owner on 10 November 2026): among several pages a MENTION matches, the one to link when they
   * all belong to the same character (the same subject, each with a character role): its Core, else its Reference, else
   * its index. Null when they do not (different subjects, a page with no character role, or two of the best role).
   */
  preferredMention(candidates: readonly NodeRef[]): MentionChoice | null {
    if (candidates.length < 2) return null;
    // v2 C2c (ADR 0035): the same subject in several lifecycle states goes to the current page first ([BSRC], then
    // [BWRK], then [BARC]); the character rule below then decides among the pages left, if there are several.
    const states = this.byLifecycle(candidates);
    if (states && states.pool.length < candidates.length) {
      if (states.pool.length === 1) {
        const chosen = states.pool[0]!;
        const kind = this.tree.node(chosen.id)!.kind as PageKind;
        return {
          chosen,
          role: kind,
          subject: states.subject,
          candidates: candidates.map((c) => ({
            ...c,
            role: ROLE_LABEL[this.tree.node(c.id)!.kind as PageKind],
          })),
          why: `the names match pages of one subject (${states.subject}) in several lifecycle states; a mention goes to the current page first ([BSRC], then [BWRK], then [BARC])`,
        };
      }
      const pick = this.byCharacterRole(states.pool);
      return pick
        ? {
            ...pick,
            why: `${pick.why}; ${candidates.length - states.pool.length} page(s) in a later lifecycle state were set aside`,
          }
        : null;
    }
    return this.byCharacterRole(candidates);
  }

  /**
   * v2 C2c: when every candidate is a page or an index of ONE subject, the candidates in the best lifecycle state (an
   * index counts as current). Null when they are not one subject, or one is unclassified.
   */
  private byLifecycle(
    candidates: readonly NodeRef[],
  ): { readonly pool: readonly NodeRef[]; readonly subject: string } | null {
    const rows: { c: NodeRef; rank: number; subject: string }[] = [];
    for (const c of candidates) {
      const n = this.tree.node(c.id);
      if (!n || (n.kind !== 'index' && !isPageKind(n.kind))) return null;
      const subject =
        this.characterRole(n.id)?.subject ?? subjectOf(n.displayName, this.tree.rowValue(n.id, 'Subject'));
      rows.push({ c, rank: isPageKind(n.kind) ? STATE_RANK[n.kind] : 0, subject });
    }
    const k = key(rows[0]!.subject);
    if (rows.some((r) => key(r.subject) !== k)) return null;
    const best = Math.min(...rows.map((r) => r.rank));
    return { pool: rows.filter((r) => r.rank === best).map((r) => r.c), subject: rows[0]!.subject };
  }

  /** v2 C2b: the Core, else the Reference, else the index of ONE character, among `candidates`; null otherwise. */
  private byCharacterRole(candidates: readonly NodeRef[]): MentionChoice | null {
    if (candidates.length < 2) return null;
    const roles = candidates.map((c) => ({ c, r: this.characterRole(c.id) }));
    if (roles.some((x) => x.r === null)) return null;
    const subject = key(roles[0]!.r!.subject);
    if (roles.some((x) => key(x.r!.subject) !== subject)) return null;
    for (const role of ROLE_ORDER) {
      const hits = roles.filter((x) => x.r!.role === role);
      if (hits.length > 1) return null;
      if (hits.length === 1) {
        return {
          chosen: hits[0]!.c,
          role,
          subject: roles[0]!.r!.subject,
          candidates: roles.map((x) => ({ ...x.c, role: ROLE_LABEL[x.r!.role] })),
          why: `the names match pages of one character (${roles[0]!.r!.subject}); a mention goes to its ${ROLE_LABEL[role]} (Core, then Reference, then index)`,
        };
      }
    }
    return null;
  }

  /**
   * The mention resolver the Markdown converter takes (`ctx.resolveMention`, B1): `[[Name]]` resolves to exactly one
   * page. A tree that cannot answer, or a bad scope, throws its typed `RegistryError` rather than claiming "not found".
   * v2 C2b: several pages of ONE character resolve to its Core, else its Reference, else its index (`preferredMention`);
   * `onChoice` is told which page was chosen and why.
   */
  mentionResolver(
    o: ResolveOptions & { readonly onChoice?: (c: MentionChoice & { name: string }) => void } = {},
  ): ResolveMention {
    return (name) => {
      const r = this.resolve(name, o);
      if (r.status === 'resolved') return { status: 'resolved', resourceId: r.node.id };
      if (r.status === 'ambiguous') {
        const pick = this.preferredMention(r.candidates);
        if (pick) {
          o.onChoice?.({ ...pick, name });
          return { status: 'resolved', resourceId: pick.chosen.id };
        }
        return {
          status: 'ambiguous',
          candidates: r.candidates.map((c) => ({ resourceId: c.id, name: c.rawName, path: c.path })),
        };
      }
      return { status: 'not_found' };
    };
  }
}

/** Edit distance, giving up (returning limit + 1) once every path is past `limit`. */
function levenshtein(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > limit) return limit + 1;
    prev = cur;
  }
  return prev[b.length]!;
}
