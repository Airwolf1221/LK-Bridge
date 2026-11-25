/**
 * The Arkona pack's character tools beside `arkona_create_character` (v3 F3b, ADR 0052; the owner-approved design
 * docs/design/F3b-owner-tools.md, sections 2 and 3), each one proposal through the same engine:
 *
 * - `arkona_create_relationship`: a joint relationship of two EXISTING characters, by F3a's relationship builder (the
 *   AI Relationship template, `<A> & <B> - <Label>` with both names exactly as their indexes give them, hosted by F3a's
 *   rule, tags `CANON, Character, Relationship`, both participants' Related Sources updated in the same proposal; a
 *   Working page with a canon partner leaves that link until promotion, with a warning). Refused when a character does
 *   not exist (CHARACTER_NOT_FOUND) or the pair already has a relationship owner (RELATIONSHIP_EXISTS, naming it).
 * - `arkona_add_character_art`: planned by src/packs/art-groups.ts since v3 F7d (ADR 0077), its single-target form as
 *   one group; the helpers here (the Art page, the lines naming a moved piece, the single form's placement words) are
 *   shared with it.
 */
import type { McpToolContext, McpToolResult } from '../mcp/server.js';
import { errorResult, type ProjectDeps } from '../mcp/tools/shape.js';
import { cleanPrefixes, key as nameKey, subjectOf } from '../registry/names.js';
import type { TreeNode } from '../tree/index.js';
import type { ArchiveImageRef, ChatGptFile } from './intake.js';
import {
  findCharacters,
  planPackage,
  type CharacterHit,
  type PackPlan,
  type PlanEnv,
} from './engine/plan.js';
import { textKey } from './engine/text.js';
import type { LmrMode } from '../jobs/lmr-hook.js';
import { characterEnv, finishPackage, packBasis } from './run.js';
import { liveArtFolder, type ArtPlace } from './art-place.js';
import { knownOutfits } from '../art/placement.js';
import { matchOutfit } from '../art/names.js';
import type { ArtLine, ArtPlan } from './engine/plan.js';
import { linesNaming } from '../art/lines.js';
import { liveRead } from '../mcp/tools/repo.js';

type Obj = Record<string, unknown>;

interface Run<I> {
  readonly packId: string;
  readonly tool: string;
  readonly input: I;
  readonly dryRun: boolean;
  readonly operationId?: string | undefined;
  readonly args: Obj;
  /** v3 F3b with ADR 0051: the caller's override for the existing pages the package changes (default `auto`). */
  readonly lastMajorRevision?: LmrMode | undefined;
}

/** One character by name, alias or id, or the refusal (none: CHARACTER_NOT_FOUND; several: CHARACTER_AMBIGUOUS). */
export function oneCharacter(
  pd: ProjectDeps,
  env: PlanEnv,
  q: string,
  what: string,
): { ok: true; hit: CharacterHit } | { ok: false; result: McpToolResult } {
  const found = findCharacters(env.ctx, cleanPrefixes(q).name.trim() || q);
  if (found.subjects.length === 1) return { ok: true, hit: found.subjects[0]! };
  if (found.subjects.length === 0)
    return {
      ok: false,
      result: errorResult(
        {
          code: 'CHARACTER_NOT_FOUND',
          message: `${what}: no character matches “${q}” (by id, name, alias or Canonical Display Name). Check the name with search; a new character is made with arkona_create_character first.`,
          hint: 'Make the character with arkona_create_character, then call again.',
        },
        pd,
      ),
    };
  return {
    ok: false,
    result: errorResult(
      {
        code: 'CHARACTER_AMBIGUOUS',
        message: `${what}: “${q}” names ${found.subjects.length} characters; pass the id (or exact name) of the one meant.`,
        candidates: found.subjects.map((s) => ({
          id: s.identity.id,
          name: s.identity.rawName,
          path: s.identity.path,
        })),
      },
      pd,
    ),
  };
}

/** A character's index (its own `[INDEX] <name>` holding its identity page), or null. */
export function indexOf(env: PlanEnv, hit: CharacterHit): TreeNode | null {
  const node = env.ctx.tree.node(env.ctx.projectId, hit.identity.id).data;
  const parent = node?.parentId ? env.ctx.tree.node(env.ctx.projectId, node.parentId).data : null;
  const subject = hit.subject || subjectOf(hit.identity.displayName, null);
  return parent && parent.kind === 'index' && nameKey(parent.displayName) === nameKey(subject)
    ? parent
    : null;
}

/** "Both names exactly as their indexes give them" (design section 2): the index's name, else the subject. */
export function nameOf(env: PlanEnv, hit: CharacterHit): string {
  return indexOf(env, hit)?.displayName ?? (hit.subject || subjectOf(hit.identity.displayName, null));
}

// ============================================================================================ relationships

export interface RelationshipInput {
  readonly a: string;
  readonly b: string;
  readonly label?: string | undefined;
  /** Which participant's index hosts it (default `a`). */
  readonly host?: 'a' | 'b' | undefined;
  readonly status?: 'working' | 'authoritative' | undefined;
  readonly scope?: string | undefined;
  readonly markdown?: string | undefined;
  readonly dependencies?: readonly string[] | undefined;
  readonly related?: readonly string[] | undefined;
}

/** The relationship pages of a pair anywhere in the tree (any label, either order; current or Working). */
function relationshipOf(env: PlanEnv, a: string, b: string): TreeNode[] {
  const pre = [`${a} & ${b} - `, `${b} & ${a} - `].map((x) => nameKey(x));
  const out: TreeNode[] = [];
  for (const kind of ['bsrc', 'bwrk'] as const)
    for (const n of env.ctx.tree.byKind(env.ctx.projectId, kind).data)
      if (pre.some((p) => nameKey(n.displayName).startsWith(p))) out.push(n);
  return out;
}

export async function runRelationship(
  pd: ProjectDeps,
  mctx: McpToolContext,
  o: Run<RelationshipInput>,
): Promise<McpToolResult> {
  const b = await packBasis(pd, mctx, o.packId, o.tool);
  if (!b.ok) return b.result;
  const e = characterEnv(pd, mctx, o.tool, b.value, 'Character', o.lastMajorRevision);
  if (!e.ok) return e.result;
  const env = e.env;
  const a = oneCharacter(pd, env, o.input.a, 'a');
  if (!a.ok) return a.result;
  const bb = oneCharacter(pd, env, o.input.b, 'b');
  if (!bb.ok) return bb.result;
  if (a.hit.identity.id === bb.hit.identity.id)
    return errorResult(
      { code: 'RELATIONSHIP_WITH_SELF', message: 'A relationship needs two different characters.' },
      pd,
    );
  const nameA = nameOf(env, a.hit);
  const nameB = nameOf(env, bb.hit);
  const there = relationshipOf(env, nameA, nameB);
  if (there.length > 0)
    return errorResult(
      {
        code: 'RELATIONSHIP_EXISTS',
        message: `${nameA} and ${nameB} already have a relationship owner: ${there.map((n) => `${n.rawName} (${n.path.names.join(' / ')})`).join('; ')}. Edit it with write_page; never a second one for the pair.`,
        existing: there.map((n) => ({ id: n.id, name: n.rawName, path: n.path.names.join(' / ') })),
      },
      pd,
    );
  // F3a's hosting rule: the page is named “<a> & <b>” and hosted under a's index (host "a") or b's ("b": F3a's
  // `host: "other"`, which needs b to have an index and refuses a Working relationship there).
  const host = o.input.host ?? 'a';
  const plan = await planPackage(env, {
    name: nameA,
    target: a.hit.identity.id,
    ...(o.input.status !== undefined ? { status: o.input.status } : {}),
    identity: {},
    pages: [
      {
        role: 'relationship',
        with: bb.hit.identity.id,
        ...(o.input.label !== undefined ? { label: o.input.label } : {}),
        host: host === 'b' ? 'other' : 'self',
        ...(o.input.scope !== undefined ? { scope: o.input.scope } : {}),
        ...(o.input.markdown !== undefined ? { markdown: o.input.markdown } : {}),
        ...(o.input.dependencies !== undefined ? { dependencies: o.input.dependencies } : {}),
        ...(o.input.related !== undefined ? { related: o.input.related } : {}),
      },
    ],
    names: { subject: nameA, partner: nameB },
  });
  // The job's re-check (design section 5): no relationship of the pair appeared since the plan, under either
  // participant's index or in the Working area, and the pair is reserved while the job runs.
  const prefixes = [`${nameA} & ${nameB} - `, `${nameB} & ${nameA} - `];
  const where = [indexOf(env, a.hit)?.id, indexOf(env, bb.hit)?.id, env.lifecycle.workingIndexId].filter(
    (x): x is string => typeof x === 'string',
  );
  const pair = [a.hit.identity.id, bb.hit.identity.id].sort().join('|');
  const out: PackPlan = {
    ...plan,
    absent: {
      ...plan.absent,
      under: [
        ...plan.absent.under,
        ...[...new Set(where)].map((parentId) => ({
          parentId,
          names: [],
          prefixes,
          code: 'RELATIONSHIP_EXISTS',
        })),
      ],
      reservations: [...(plan.absent.reservations ?? []), `relationship:${pair}`],
      kind: 'relationship',
    },
    extra: {
      ...(plan.extra ?? {}),
      relationship: {
        a: { id: a.hit.identity.id, name: nameA },
        b: { id: bb.hit.identity.id, name: nameB },
        hostedUnder: host === 'b' ? nameB : nameA,
      },
    },
  };
  return finishPackage(pd, mctx, o, env, out);
}

// ============================================================================================ art

export interface ArtImageInput {
  readonly staged_id?: string | undefined;
  readonly upload_id?: string | undefined;
  /** v3 F7c (ADR 0075, Z4): an entry of an image archive (upload_image_archive). */
  readonly archive?: ArchiveImageRef | undefined;
  readonly label: string;
  readonly interpretation?: string | undefined;
}

/** The single-target form's input (v3 F7: one call, one target; since v3 F7d planned as a one-group groups call). */
export interface ArtInput {
  readonly character: string;
  /**
   * v3 F7 (ADR 0070, G1): the outfit every image of the call belongs to; absent or null: design pieces (the character's
   * own folder). The bridge decides the folder (G2).
   */
  readonly outfit?: string | null | undefined;
  /** v3 F7 (G3): the outfit is a new one although its name is close to an existing one's. */
  readonly newOutfit?: boolean | undefined;
  readonly images: readonly ArtImageInput[];
  /** A ChatGPT conversation attachment: the source of the one image that names neither staged_id nor upload_id. */
  readonly file?: ChatGptFile | undefined;
  /** A new Art page's Scope and text (drafted when the text is left out). */
  readonly scope?: string | undefined;
  readonly markdown?: string | undefined;
  readonly status?: 'working' | 'authoritative' | undefined;
}

/**
 * v3 F7 (ADR 0070, G5): when the job moves loose pieces, every page under the character's index (the index too) is read
 * live, and each line naming a moved piece by asset id or name is listed for the owner (it may state where the piece is):
 * never edited. One read per page document; none when nothing moves.
 */
export async function piecesNamedOnPages(
  env: PlanEnv,
  index: TreeNode | null,
  pieces: readonly { readonly id: string; readonly name: string }[],
): Promise<{ lines: ArtLine[]; unread: string[] }> {
  const lines: ArtLine[] = [];
  const unread: string[] = [];
  if (!index || pieces.length === 0) return { lines, unread };
  const nodes = [index, ...env.ctx.tree.subtree(env.ctx.projectId, index.id).data.entries.map((e) => e.node)];
  const seen = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    // A page document, or one the tree last saw blank (it may hold text written since).
    for (const d of n.documents.filter((x) => x.type === 'page' || x.type === 'blank')) {
      const read = await liveRead(env.pd, env.mctx, env.tool, 'getDocumentBlocks', {
        path: { resourceId: n.id, documentId: d.id },
      });
      if (!read.ok) {
        unread.push(n.rawName);
        continue;
      }
      const blocks = ((read.value ?? {}) as { blocks?: unknown[] }).blocks ?? [];
      for (const l of linesNaming(blocks, pieces))
        lines.push({ pageId: n.id, page: n.rawName, documentId: d.id, blockId: l.blockId, text: l.text });
    }
  }
  return { lines, unread };
}

/** The character's Art page under its index (by name or Reference Type), or null. */
export function artPageOf(env: PlanEnv, index: TreeNode | null, subject: string): TreeNode | null {
  const { type } = env;
  const artName =
    type.roles.find((r) => r.role === type.assets.role)?.name.replace('{Name}', subject) ?? null;
  const artRef = type.roles.find((r) => r.role === type.assets.role)?.referenceType ?? null;
  return index
    ? (env.ctx.tree
        .children(env.ctx.projectId, index.id)
        .data.find(
          (n) =>
            n.kind !== 'index' &&
            ((artName !== null && nameKey(n.displayName) === nameKey(artName)) ||
              (artRef !== null && n.referenceType !== null && textKey(n.referenceType) === textKey(artRef))),
        ) ?? null)
    : null;
}

/** v3 F7: what the job needs besides the images (the moves, the outfit record, the Art page's place for them). */
export function artPlanOf(place: ArtPlace, subject: string, lines: readonly ArtLine[]): ArtPlan {
  const p = place.placement;
  const base = (place.layout?.character.path ?? []).join(' / ');
  const wardrobe = place.layout?.wardrobe ?? null;
  return {
    characterName: subject,
    characterFolderId: place.characterFolderId,
    outfit:
      p.kind === 'outfit'
        ? {
            name: p.outfit.name,
            aliases: [...p.outfit.aliases],
            into: p.into,
            folderId: p.folderId,
            moves: p.moves.map((m) => ({
              assetId: m.id,
              name: m.name,
              fromFolderId: wardrobe?.id ?? null,
              fromPath: wardrobe ? `${base} / ${wardrobe.name}` : null,
              ...(m.url ? { url: m.url } : {}),
            })),
            toPath: [base, ...p.subfolders].filter(Boolean).join(' / '),
            ...(lines.length ? { linesForOwner: lines } : {}),
          }
        : null,
  };
}

export function artNotes(place: ArtPlace): string[] {
  const p = place.placement;
  const read = `The character’s asset folders were read live first (${place.live.requests} request${place.live.requests === 1 ? '' : 's'}).`;
  if (p.kind === 'design') return [read, 'Design pieces: placed in the character’s own folder.'];
  const where =
    p.into === 'wardrobe'
      ? `loose in ${p.subfolders.join(' / ')} (its only piece)`
      : p.folderId
        ? `in its folder ${p.subfolders.join(' / ')}`
        : `in a new folder ${p.subfolders.join(' / ')}`;
  return [
    read,
    `Outfit “${p.outfit.name}”${p.outfit.source === 'new' ? ' (new)' : ''}: ${p.existing.length} piece(s) already, ${p.total - p.existing.length} arriving: placed ${where}.`,
    ...(p.moves.length > 0
      ? [
          `Its loose piece${p.moves.length === 1 ? '' : 's'} ${p.moves.map((m) => `“${m.name}”`).join(', ')} ${p.moves.length === 1 ? 'is' : 'are'} moved into the new folder in the same job.`,
        ]
      : []),
    ...p.notes,
  ];
}

export function placementSummary(place: ArtPlace): Record<string, unknown> {
  const p = place.placement;
  if (p.kind === 'design') return { kind: 'design', folder: 'the character’s own folder' };
  return {
    kind: 'outfit',
    outfit: p.outfit.name,
    known: p.outfit.source,
    ...(p.outfit.via && p.outfit.via !== p.outfit.name ? { matchedAlias: p.outfit.via } : {}),
    into: p.subfolders.join(' / '),
    existingPieces: p.existing.length,
    total: p.total,
    moves: p.moves.map((m) => m.name),
  };
}

// ============================================================================================ archive hints (v3 F7c)

/** v3 F7c (ADR 0075, Z10): what one folder of an archive is to a character's outfits (F7's matcher). */
export type FolderOutfitMatch =
  | { readonly outfitMatch: 'exact'; readonly outfit: string; readonly via: string }
  | {
      readonly outfitMatch: 'near';
      readonly candidates: readonly { readonly name: string; readonly via: string; readonly why: string }[];
    }
  | { readonly outfitMatch: 'new' };

/**
 * v3 F7c (ADR 0075, Z10): each distinct folder of an archive checked against a character's outfits (its outfit record
 * and the outfits its folders show, read live as an art call reads them), by the folder's raw name and its display
 * form. A suggestion only: the bridge never places by folder. A character that does not resolve is reported, not an
 * error.
 */
export async function archiveOutfitHints(
  pd: ProjectDeps,
  mctx: McpToolContext,
  tool: string,
  character: string,
  folders: readonly { readonly raw: string; readonly display: string | null }[],
): Promise<
  | {
      readonly resolved: true;
      readonly character: { readonly id: string; readonly name: string };
      readonly folders: ReadonlyMap<string, FolderOutfitMatch>;
      readonly liveReads: number;
    }
  | { readonly resolved: false; readonly reason: string }
> {
  const b = await packBasis(pd, mctx, 'arkona', tool);
  if (!b.ok) return { resolved: false, reason: 'the Arkona pack is not attached to this project' };
  const e = characterEnv(pd, mctx, tool, b.value, 'Character');
  if (!e.ok) return { resolved: false, reason: 'the Arkona pack has no Character type here' };
  const env = e.env;
  const ch = oneCharacter(pd, env, character, 'character');
  if (!ch.ok) {
    const body = JSON.parse((ch.result.content[0] as { text: string }).text.split('\n')[0]!) as {
      error?: { code?: string; message?: string };
    };
    return {
      resolved: false,
      reason: `${body.error?.code ?? 'CHARACTER_NOT_FOUND'}: ${body.error?.message ?? ''}`,
    };
  }
  const subject = nameOf(env, ch.hit);
  const folder = await liveArtFolder(env, ch.hit, subject);
  if (!folder.ok)
    return {
      resolved: false,
      reason: 'the character’s asset folders could not be read live now; try again shortly',
    };
  const { characterFolderId, layout } = folder.value;
  const records =
    characterFolderId && pd.services?.outfits
      ? pd.services.outfits.forCharacter(pd.project.id, characterFolderId)
      : [];
  const known = knownOutfits(layout, records, subject);
  const out = new Map<string, FolderOutfitMatch>();
  for (const f of folders) {
    const tries = [f.raw.split('/').filter(Boolean).pop() ?? f.raw, ...(f.display ? [f.display] : [])];
    let best: FolderOutfitMatch = { outfitMatch: 'new' };
    for (const t of tries) {
      const m = matchOutfit(t, known);
      if (m.kind === 'same') {
        best = { outfitMatch: 'exact', outfit: m.outfit.name, via: m.via };
        break;
      }
      if (m.kind === 'near' && best.outfitMatch === 'new')
        best = {
          outfitMatch: 'near',
          candidates: m.candidates.map((c) => ({ name: c.outfit.name, via: c.via, why: c.why })),
        };
    }
    out.set(f.raw, best);
  }
  return {
    resolved: true,
    character: { id: ch.hit.identity.id, name: subject },
    folders: out,
    liveReads: folder.value.live.requests,
  };
}
