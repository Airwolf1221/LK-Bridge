/**
 * Name resolution (v2 A3, PLAN-v2 4.4): one shared resolver for every tool that accepts "name or id", built on the
 * tree's exact-name lookups. Exactly one match is used; several are refused with every candidate and its path; none is
 * `not_found`, with near names as a hint only. No fuzzy matching ever decides anything.
 */
import type { ResolveMention } from '../markdown/index.js';
import type { TreeNode } from '../tree/index.js';
import { cleanPrefixes, key } from './names.js';
import type { RegistryStore } from './store.js';
import type { ProjectTree } from './tree-view.js';
import {
  RegistryError,
  type MatchField,
  type NodeRef,
  type ResolveKind,
  type ResolveOptions,
  type ResolveResult,
} from './types.js';

const FIELD_RANK: Readonly<Record<MatchField, number>> = {
  id: 0,
  raw: 1,
  display: 2,
  alias: 3,
  canonical: 4,
};
const KINDS: readonly ResolveKind[] = ['index', 'bsrc', 'unclassified'];
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
      const raw = `${prefix === 'index' ? '[INDEX]' : '[BSRC]'} ${cleaned}`;
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
   * The mention resolver the Markdown converter takes (`ctx.resolveMention`, B1): `[[Name]]` resolves to exactly one
   * page. A tree that cannot answer, or a bad scope, throws its typed `RegistryError` rather than claiming "not found".
   */
  mentionResolver(o: ResolveOptions = {}): ResolveMention {
    return (name) => {
      const r = this.resolve(name, o);
      if (r.status === 'resolved') return { status: 'resolved', resourceId: r.node.id };
      if (r.status === 'ambiguous') {
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
