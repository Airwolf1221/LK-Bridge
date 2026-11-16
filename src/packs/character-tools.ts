/**
 * The Arkona pack's character tools beside `arkona_create_character` (v3 F3b, ADR 0052; the owner-approved design
 * docs/design/F3b-owner-tools.md, sections 2 and 3), each one proposal through the same engine:
 *
 * - `arkona_create_relationship`: a joint relationship of two EXISTING characters, by F3a's relationship builder (the
 *   AI Relationship template, `<A> & <B> - <Label>` with both names exactly as their indexes give them, hosted by F3a's
 *   rule, tags `CANON, Character, Relationship`, both participants' Related Sources updated in the same proposal; a
 *   Working page with a canon partner leaves that link until promotion, with a warning). Refused when a character does
 *   not exist (CHARACTER_NOT_FOUND) or the pair already has a relationship owner (RELATIONSHIP_EXISTS, naming it).
 * - `arkona_add_character_art`: F3a's art step on its own: images from staged uploads, a ChatGPT `file` or an
 *   `upload_id` (staged on the bridge's server first), placed in the character's asset folder (found or created when
 *   the job runs), with semantic, extension-free, collision-checked names; the Art page created when missing, or
 *   extended under its "Reference Images" section. Each image needs its interpretation text.
 */
import type { McpToolContext, McpToolResult } from '../mcp/server.js';
import { errorResult, type ProjectDeps } from '../mcp/tools/shape.js';
import { liveRead } from '../mcp/tools/repo.js';
import type { FromMarkdownContext, LkBlock } from '../markdown/index.js';
import { pageConverterContext } from '../pages/index.js';
import { cleanPrefixes, key as nameKey, subjectOf } from '../registry/names.js';
import type { TreeNode } from '../tree/index.js';
import { stageForPack, type ChatGptFile } from './intake.js';
import {
  findCharacters,
  planImages,
  planPackage,
  withImages,
  type CharacterHit,
  type PackPlan,
  type PackageImage,
  type PlanEnv,
} from './engine/plan.js';
import { textKey } from './engine/text.js';
import { characterEnv, finishPackage, packBasis } from './run.js';

type Obj = Record<string, unknown>;

interface Run<I> {
  readonly packId: string;
  readonly tool: string;
  readonly input: I;
  readonly dryRun: boolean;
  readonly operationId?: string | undefined;
  readonly args: Obj;
}

/** One character by name, alias or id, or the refusal (none: CHARACTER_NOT_FOUND; several: CHARACTER_AMBIGUOUS). */
function oneCharacter(
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
function indexOf(env: PlanEnv, hit: CharacterHit): TreeNode | null {
  const node = env.ctx.tree.node(env.ctx.projectId, hit.identity.id).data;
  const parent = node?.parentId ? env.ctx.tree.node(env.ctx.projectId, node.parentId).data : null;
  const subject = hit.subject || subjectOf(hit.identity.displayName, null);
  return parent && parent.kind === 'index' && nameKey(parent.displayName) === nameKey(subject)
    ? parent
    : null;
}

/** "Both names exactly as their indexes give them" (design section 2): the index's name, else the subject. */
function nameOf(env: PlanEnv, hit: CharacterHit): string {
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
  const e = characterEnv(pd, mctx, o.tool, b.value, 'Character');
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
  readonly label: string;
  readonly interpretation?: string | undefined;
  readonly subfolder?: string | null | undefined;
}

export interface ArtInput {
  readonly character: string;
  readonly images: readonly ArtImageInput[];
  /** A ChatGPT conversation attachment: the source of the one image that names neither staged_id nor upload_id. */
  readonly file?: ChatGptFile | undefined;
  /** A new Art page's Scope and text (drafted when the text is left out). */
  readonly scope?: string | undefined;
  readonly markdown?: string | undefined;
  readonly status?: 'working' | 'authoritative' | undefined;
}

export async function runArt(
  pd: ProjectDeps,
  mctx: McpToolContext,
  o: Run<ArtInput>,
): Promise<McpToolResult> {
  const b = await packBasis(pd, mctx, o.packId, o.tool);
  if (!b.ok) return b.result;
  const e = characterEnv(pd, mctx, o.tool, b.value, 'Character');
  if (!e.ok) return e.result;
  const env = e.env;
  const type = env.type;
  const ch = oneCharacter(pd, env, o.input.character, 'character');
  if (!ch.ok) return ch.result;
  if (o.input.images.length === 0)
    return errorResult({ code: 'IMAGES_REQUIRED', message: 'Give at least one image.' }, pd);
  // 1. Each image's source: a staged image, or an upload or ChatGPT file staged now on the bridge's server.
  const unsourced = o.input.images.filter((im) => im.staged_id === undefined && im.upload_id === undefined);
  if (
    unsourced.length > 1 ||
    (unsourced.length === 1 && !o.input.file) ||
    (unsourced.length === 0 && o.input.file)
  )
    return errorResult(
      {
        code: 'IMAGE_SOURCE_INVALID',
        message:
          'Each image has exactly one source: staged_id, upload_id, or (for ONE image with neither) the attached file given as `file`.',
      },
      pd,
    );
  const staged: { from: string; staged_id: string; deduplicated: boolean }[] = [];
  const images: PackageImage[] = [];
  for (const im of o.input.images) {
    if (im.staged_id !== undefined && im.upload_id !== undefined)
      return errorResult(
        { code: 'IMAGE_SOURCE_INVALID', message: `${im.label}: give staged_id or upload_id, not both.` },
        pd,
      );
    let id = im.staged_id;
    if (id === undefined) {
      const r = await stageForPack(
        pd,
        mctx,
        o.tool,
        im.upload_id !== undefined ? { upload_id: im.upload_id } : { file: o.input.file! },
        im.label,
      );
      if (!r.ok)
        return errorResult({ code: r.code, message: `${im.label}: ${r.message}`, ...(r.details ?? {}) }, pd);
      id = r.stagedId;
      staged.push({ from: r.source, staged_id: id, deduplicated: r.deduplicated });
    }
    images.push({
      staged_id: id,
      label: im.label,
      ...(im.interpretation !== undefined ? { interpretation: im.interpretation } : {}),
      ...(im.subfolder !== undefined ? { subfolder: im.subfolder } : {}),
    });
  }
  const stagedNote =
    staged.length > 0
      ? {
          stagedNow: staged,
          stagedNote:
            'These images were staged on the bridge’s server for this package (nothing is in LegendKeeper until the owner approves it). Calling again, give their staged_id.',
        }
      : {};
  // 2. The character's Art page: extended when it has one, else made.
  const subject = nameOf(env, ch.hit);
  const index = indexOf(env, ch.hit);
  const artName =
    type.roles.find((r) => r.role === type.assets.role)?.name.replace('{Name}', subject) ?? null;
  const artRef = type.roles.find((r) => r.role === type.assets.role)?.referenceType ?? null;
  const art = index
    ? (env.ctx.tree
        .children(env.ctx.projectId, index.id)
        .data.find(
          (n) =>
            n.kind !== 'index' &&
            ((artName !== null && nameKey(n.displayName) === nameKey(artName)) ||
              (artRef !== null && n.referenceType !== null && textKey(n.referenceType) === textKey(artRef))),
        ) ?? null)
    : null;
  if (!art) {
    const plan = await planPackage(env, {
      name: subject,
      target: ch.hit.identity.id,
      ...(o.input.status !== undefined ? { status: o.input.status } : {}),
      identity: {},
      pages: [
        {
          role: type.assets.role,
          scope: o.input.scope ?? `${subject}'s approved visual references`,
          markdown:
            o.input.markdown ??
            `## Purpose\n\n${subject}'s approved visual references: each image below with what it establishes.\n`,
          images,
        },
      ],
    });
    if (o.input.markdown === undefined)
      plan.notes.push(
        'The Art page’s Purpose is drafted (shown in the preview); give markdown for your own.',
      );
    return finishPackage(pd, mctx, o, env, {
      ...plan,
      extra: {
        ...(plan.extra ?? {}),
        artPage: { create: plan.pages.find((p) => p.role === type.assets.role)?.rawName ?? null },
        ...stagedNote,
      },
    });
  }
  const plan = await planArtExtension(env, ch.hit, subject, art, images);
  return finishPackage(pd, mctx, o, env, { ...plan, extra: { ...(plan.extra ?? {}), ...stagedNote } });
}

/** New images on an existing Art page (design section 3): appended under its images section, in one proposal. */
async function planArtExtension(
  env: PlanEnv,
  hit: CharacterHit,
  subject: string,
  art: TreeNode,
  pkgImages: readonly PackageImage[],
): Promise<PackPlan> {
  const { pd, ctx, type, pack } = env;
  const refusals: PackPlan['refusals'] = [];
  const warnings: PackPlan['warnings'] = [];
  const refuse = (code: string, message: string, more: Obj = {}) => refusals.push({ code, message, ...more });
  const warn = (code: string, message: string, more: Obj = {}) => warnings.push({ code, message, ...more });
  if (art.kind === 'barc')
    refuse(
      'TARGET_ARCHIVED',
      `${art.rawName} is Archived: unarchive it first (unarchive_page, the owner's approval).`,
    );
  const status: 'working' | 'authoritative' = art.kind === 'bwrk' ? 'working' : 'authoritative';
  const doc =
    art.documents.find((d) => d.name === 'Main' && (d.type === 'page' || d.type === 'blank')) ??
    (art.documents.filter((d) => d.type === 'page').length === 1
      ? art.documents.find((d) => d.type === 'page')
      : undefined);
  if (!doc) refuse('ART_PAGE_UNREADABLE', `${art.rawName} has no main page document to add the images to.`);
  // The race for the asset folder: as the repository tree has it (a fact read at the last pass).
  let race = hit.race;
  if (race === null) {
    const read = await liveRead(pd, env.mctx, env.tool, 'getResource', {
      path: { resourceId: hit.identity.id },
    });
    if (read.ok) {
      const props = (read.value as { properties?: unknown }).properties;
      for (const p of Array.isArray(props) ? (props as Obj[]) : [])
        for (const r of Array.isArray(p.rows) ? (p.rows as Obj[]) : [])
          if (typeof r.key === 'string' && textKey(r.key) === textKey('Race / Species'))
            race =
              (Array.isArray(r.content) ? (r.content as Obj[]) : [])
                .map((x) => (typeof x.text === 'string' ? x.text : ''))
                .join('')
                .trim() || null;
    }
  }
  const planned = planImages(env, { page: art.rawName, subject, race, images: pkgImages, refuse, warn });
  const base = pd.services ? pageConverterContext(pd.services, ctx.projectId) : undefined;
  const converter: FromMarkdownContext | undefined = base ? { ...base } : undefined;
  if (!converter) refuse('TOOL_UNAVAILABLE', 'The repository tree cannot resolve names now.');
  const section = type.assets.section;
  const boundaries = [
    ...(type.roles.find((r) => r.role === type.assets.role)?.warnMissing ?? []),
    'Source Boundaries',
    'Unresolved Material',
  ];
  const blocks: LkBlock[] =
    converter && planned.length > 0 ? withImages([], planned, section, boundaries, converter) : [];
  return {
    pack,
    type,
    mode: 'extend',
    subject,
    status,
    pages: [],
    existing:
      doc && planned.length > 0
        ? [
            {
              kind: 'images',
              page: ctx.types.resolveOne(art.id),
              documentId: doc.id,
              blocks,
              section,
              boundaries,
              images: planned,
            },
          ]
        : [],
    images: planned,
    refusals: [
      ...refusals,
      ...(env.governance.state === 'current'
        ? []
        : [
            {
              code: 'PACK_NOT_CURRENT',
              message: `${env.governance.message} Nothing can be proposed now (fail closed).`,
              governance: { state: env.governance.state, sources: env.governance.sources },
            },
          ]),
    ],
    warnings,
    replacements: [],
    held: [],
    governance: env.governance,
    absent: { reservation: null, under: [], kind: 'art', images: planned.map((i) => i.stagedId) },
    target: { identity: hit.identity, index: null, role: hit.role },
    notes: [
      `${art.rawName} exists: the images are added at the end of its “${section}” section (made before its boundary sections if it has none) when the job runs; nothing else on the page changes.`,
    ],
    extra: { artPage: { extend: art.rawName, id: art.id } },
    ...(planned.some((i) => i.takeover)
      ? {
          takeovers: planned
            .filter((i) => i.takeover)
            .map((i) => ({ stagedId: i.stagedId, proposalId: i.takeover! })),
        }
      : {}),
  };
}
