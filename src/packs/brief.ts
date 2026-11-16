/**
 * `arkona_character_brief` (v3 F3b, ADR 0052; the owner-approved design docs/design/F3b-owner-tools.md, section 4):
 * Character Architecture's "remind the user who is under discussion" step, read-only and free. From the bridge's own
 * repository tree, snapshots and audit findings, with NO LegendKeeper read (the pack's governance is not read either):
 *
 * - the six gated identity fields (from the tree's last read of the identity page's sidebar);
 * - every owner page of the character's set, with its Reference Type and Scope;
 * - its relationships, its Art pages and how many images each holds (from the newest snapshot of the page);
 * - the open audit findings on those pages, and each page's Unresolved Material headings (from the snapshots);
 * - how fresh each source is. `live: true` re-reads the identity page's sidebar (one read) for the six fields.
 */
import { sidebarFrom } from '../facts/index.js';
import type { McpToolContext, McpToolResult } from '../mcp/server.js';
import { ago, finish, liveRead, repoContext, treeInfo } from '../mcp/tools/repo.js';
import { errorResult, type ProjectDeps } from '../mcp/tools/shape.js';
import { cleanPrefixes, key as nameKey, subjectOf } from '../registry/names.js';
import type { TreeNode } from '../tree/index.js';
import { findCharacters } from './engine/plan.js';
import { sectionsOf, textKey } from './engine/text.js';
import { hookFor } from './hooks.js';

type Obj = Record<string, unknown>;

/** The most pages of a set the brief looks at in the snapshots (the rest are listed without their text). */
const SNAPSHOT_PAGES = 40;

export async function characterBrief(
  pd: ProjectDeps,
  mctx: McpToolContext,
  o: { readonly packId: string; readonly tool: string; readonly character: string; readonly live: boolean },
): Promise<McpToolResult> {
  const packs = pd.services?.packs;
  if (!packs)
    return errorResult({ code: 'TOOL_UNAVAILABLE', message: 'Setting packs are not available here.' }, pd);
  const pack = packs.get(o.packId);
  if (!pack) return errorResult({ code: 'PACK_NOT_FOUND', message: `No pack ${o.packId}.` }, pd);
  if (!packs.attachment(pack.id, pd.project.id)) {
    const attached = packs.view(pack.id)?.attachments.map((a) => a.projectName) ?? [];
    return errorResult(
      {
        code: 'PACK_NOT_ATTACHED',
        message: `The ${pack.name} pack is not attached to the project ${pd.project.name}; its tools work only on ${attached.join(', ') || 'no project yet'}.`,
        attachedTo: attached,
      },
      pd,
    );
  }
  const type = pack.rules.types.find((t) => hookFor(t)?.name === 'character');
  if (!type)
    return errorResult(
      { code: 'PACK_TYPE_NOT_FOUND', message: `The ${pack.name} pack has no character type.` },
      pd,
    );
  const rc = repoContext(pd);
  if (!rc.ok) return rc.result;
  const ctx = rc.ctx;
  const found = findCharacters(ctx, cleanPrefixes(o.character).name.trim() || o.character);
  if (found.subjects.length !== 1)
    return errorResult(
      found.subjects.length === 0
        ? {
            code: 'CHARACTER_NOT_FOUND',
            message: `No character matches “${o.character}” (by id, name, alias or Canonical Display Name).`,
          }
        : {
            code: 'CHARACTER_AMBIGUOUS',
            message: `“${o.character}” names ${found.subjects.length} characters; pass the id of the one meant.`,
            candidates: found.subjects.map((s) => ({
              id: s.identity.id,
              name: s.identity.rawName,
              path: s.identity.path,
            })),
          },
      pd,
    );
  const hit = found.subjects[0]!;
  const node = (id: string) => ctx.tree.node(ctx.projectId, id).data;
  const identity = node(hit.identity.id);
  const subject = hit.subject || subjectOf(hit.identity.displayName, null);
  const parent = identity?.parentId ? node(identity.parentId) : null;
  const index =
    parent && parent.kind === 'index' && nameKey(parent.displayName) === nameKey(subject) ? parent : null;

  // ---------------------------------------------------------------------------------- the six gated fields
  const gated = type.identity.filter((f) => f.gated).map((f) => f.key);
  const property = pack.rules.sidebar.property;
  let fieldsFrom: Obj;
  let rows: { key: string; text: string }[];
  if (o.live) {
    const read = await liveRead(pd, mctx, o.tool, 'getResource', { path: { resourceId: hit.identity.id } });
    if (!read.ok) return read.result;
    const kv = sidebarFrom(read.value).find(
      (p) => p.kind === 'keyValue' && textKey(p.title) === textKey(property),
    );
    rows = (kv?.rows ?? []).map((r) => ({
      key: r.key,
      text: r.content.map((x) => (typeof x.text === 'string' ? x.text : '')).join(''),
    }));
    fieldsFrom = { source: 'live', readAt: new Date(ctx.now).toISOString(), reads: 1 };
  } else {
    const sb = ctx.tree.sidebars(ctx.projectId, [hit.identity.id]).data.get(hit.identity.id) ?? null;
    const kv = (sb ?? []).find((p) => p.kind === 'keyValue' && textKey(p.title ?? '') === textKey(property));
    rows = [...(kv?.rows ?? [])].map((r) => ({ key: r.key, text: r.text }));
    const readAt = identity ? Math.min(identity.lastReadAt, ctx.now) : null;
    fieldsFrom = {
      source: 'tree',
      readAt: readAt !== null ? new Date(readAt).toISOString() : null,
      age: readAt !== null ? ago(ctx.now - readAt) : null,
      ...(sb === null
        ? { note: 'The tree has not read this page’s sidebar yet: call again with live: true.' }
        : {}),
    };
  }
  const fields: Record<string, string | null> = {};
  for (const k of gated) {
    const r = rows.find((x) => textKey(x.key) === textKey(k));
    fields[k] = r ? r.text.trim() || null : null;
  }
  const blank = gated.filter((k) => !fields[k]);

  // ---------------------------------------------------------------------------------- the set's pages
  const set: TreeNode[] = index
    ? ctx.tree
        .subtree(ctx.projectId, index.id, { limit: 500 })
        .data.entries.map((e) => e.node)
        .filter((n) => n.id !== index.id)
    : identity
      ? [identity]
      : [];
  const pages = set.filter((n) => n.kind !== 'index');
  const relRole = type.relationship?.role;
  const relRef = type.roles.find((r) => r.role === relRole)?.referenceType ?? null;
  const artRole = type.roles.find((r) => r.role === type.assets.role);
  const artName = artRole ? artRole.name.replace('{Name}', subject) : null;
  const isArt = (n: TreeNode) =>
    (artName !== null && nameKey(n.displayName) === nameKey(artName)) ||
    (artRole?.referenceType != null &&
      n.referenceType !== null &&
      textKey(n.referenceType) === textKey(artRole.referenceType));
  // Relationships: in the set by Reference Type, and anywhere by name (`<A> & <B> - …`).
  const relationships = new Map<string, TreeNode>();
  for (const n of pages)
    if (relRef && n.referenceType && textKey(n.referenceType) === textKey(relRef)) relationships.set(n.id, n);
  const a = nameKey(`${subject} & `);
  const b = nameKey(` & ${subject} - `);
  for (const kind of ['bsrc', 'bwrk'] as const)
    for (const n of ctx.tree.byKind(ctx.projectId, kind).data) {
      const d = nameKey(n.displayName);
      if (d.startsWith(a) || d.includes(b)) relationships.set(n.id, n);
    }

  // ---------------------------------------------------------------------------------- snapshots (free)
  const snaps = pd.services?.snapshots;
  const unresolvedHeading = type.text.unresolved;
  const newestDocument = async (n: TreeNode): Promise<{ blocks: unknown[]; takenAt: number } | null> => {
    if (!snaps) return null;
    const doc =
      n.documents.find((d) => d.name === 'Main' && (d.type === 'page' || d.type === 'blank')) ??
      n.documents.find((d) => d.type === 'page');
    if (!doc) return null;
    const row = snaps.index
      .pageHistory(ctx.projectId, n.id, { piece: 'document', ref: doc.id, limit: 5 })
      .find((r) => r.piece === 'document' && r.sha256);
    if (!row?.sha256) return null;
    const piece = await snaps.store.getJson<{ blocks?: unknown[] }>(row.sha256);
    return piece ? { blocks: piece.blocks ?? [], takenAt: row.takenAt } : null;
  };
  const countImages = (blocks: readonly unknown[]): number => {
    let n = 0;
    for (const b0 of blocks) {
      if (!b0 || typeof b0 !== 'object') continue;
      const b1 = b0 as Obj;
      if (b1.kind === 'image') n++;
      if (Array.isArray(b1.children)) n += countImages(b1.children as unknown[]);
    }
    return n;
  };
  const snapshotTimes: number[] = [];
  const art: Obj[] = [];
  const unresolved: Obj[] = [];
  for (const n of pages.slice(0, SNAPSHOT_PAGES)) {
    const doc = await newestDocument(n);
    if (doc) snapshotTimes.push(doc.takenAt);
    if (isArt(n))
      art.push({
        id: n.id,
        name: n.rawName,
        images: doc ? countImages(doc.blocks) : null,
        ...(doc
          ? { from: `snapshot of ${new Date(doc.takenAt).toISOString()}` }
          : { from: 'not in a snapshot yet' }),
      });
    if (!doc) continue;
    const secs = sectionsOf(doc.blocks as never[]);
    const at = secs.findIndex((s) => s.heading && textKey(s.title) === textKey(unresolvedHeading));
    if (at < 0) continue;
    const level = secs[at]!.level;
    const items: string[] = [];
    for (let i = at; i < secs.length && items.length < 12; i++) {
      const s = secs[i]!;
      if (i > at && (!s.heading || s.level <= level)) break;
      if (i > at) items.push(s.title);
      for (const b0 of s.blocks) {
        const first = firstText(b0);
        if (first && items.length < 12) items.push(first.slice(0, 200));
      }
    }
    unresolved.push({ page: n.rawName, items });
  }
  for (const n of pages.slice(SNAPSHOT_PAGES))
    if (isArt(n))
      art.push({ id: n.id, name: n.rawName, images: null, from: 'not looked at (a very large set)' });

  // ---------------------------------------------------------------------------------- open audit findings
  const findings: Obj[] = [];
  const audits = pd.services?.audits;
  if (audits)
    for (const n of [...(index ? [index] : []), ...pages]) {
      for (const f of audits.store.list(ctx.projectId, { pageId: n.id, state: 'open', limit: 20 }).findings)
        findings.push({ page: n.rawName, code: f.code, severity: f.severity, message: f.message });
    }

  const body = {
    character: {
      subject,
      identityPage: { id: hit.identity.id, name: hit.identity.rawName, role: hit.role },
      index: index ? { id: index.id, name: index.rawName } : null,
      path: hit.identity.path,
      lifecycle:
        identity?.kind === 'bwrk' ? 'Working' : identity?.kind === 'barc' ? 'Archived' : 'Authoritative',
    },
    identity: fields,
    ...(blank.length ? { blankGatedFields: blank } : {}),
    identityFrom: fieldsFrom,
    pages: pages.map((n) => ({
      id: n.id,
      name: n.rawName,
      referenceType: n.referenceType,
      scope: n.scope,
    })),
    relationships: [...relationships.values()].map((n) => ({
      id: n.id,
      name: n.rawName,
      under: n.path.names.slice(-2, -1)[0] ?? null,
    })),
    art,
    findings,
    unresolved,
    freshness: {
      tree: treeInfo(ctx.meta, ctx.now),
      snapshots:
        snapshotTimes.length > 0
          ? {
              newest: new Date(Math.max(...snapshotTimes)).toISOString(),
              oldest: new Date(Math.min(...snapshotTimes)).toISOString(),
            }
          : null,
      ...(o.live ? { live: 'the identity fields were read now (one read)' } : {}),
    },
    cost: o.live
      ? 'one read (the identity page’s sidebar)'
      : 'free: the bridge’s own tree, snapshots and audits',
  };
  return finish(pd, mctx, o.tool, body, () => ({ pages: pages.length }));
}

/** The first text of a block (a paragraph, or a list's first item), for the Unresolved Material lines. */
function firstText(b: unknown): string | null {
  if (!b || typeof b !== 'object') return null;
  const o = b as Obj;
  if (Array.isArray(o.content)) {
    const t = (o.content as Obj[])
      .map((r) => (typeof r.text === 'string' ? r.text : ''))
      .join('')
      .trim();
    if (t) return t;
  }
  if (Array.isArray(o.children))
    for (const c of o.children as unknown[]) {
      const t = firstText(c);
      if (t) return t;
    }
  return null;
}
