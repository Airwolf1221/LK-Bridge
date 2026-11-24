/**
 * v3 F7d (ADR 0077; the owner-approved design `LK-Bridge-F7d-one-call-art-design.md`, A1 to A3, A5, A8, A9): a
 * character's WHOLE art set in one `arkona_add_character_art` call, `groups`, and one proposal.
 *
 * - **A1** each group is the design pieces (no `outfit`) or one outfit (`outfit`, `newOutfit`), with its images (each
 *   with its label, interpretation and source: `staged_id`, `upload_id` or `archive`). Limits: ART_CALL_MAX_IMAGES,
 *   ART_CALL_MAX_GROUPS.
 * - **A2** planned once, together: the character's folders read live once (F7's G9), its outfit record once; each
 *   group matched (exact or alias; a near match refused unless `newOutfit`); groups naming the same outfit merged (a
 *   note); placement by F7's G2 counting the outfit's recorded pieces plus this call's. ANY problem in any group refuses
 *   the whole call, every problem listed. A Compact Reference is upgraded in the same proposal when this call makes the
 *   Art page (F7.1's rule, in the package engine).
 * - **A8** the identity page (Core or Compact Reference) read live: Subject, Canonical Display Name, Family / Surname,
 *   Personal / Given Name, Naming Culture and Aliases copied where the Art page's template has the row, only into empty
 *   rows; a differing value is never overwritten (reported). The job checks the identity page's rows are still the ones
 *   copied, inside the job.
 * - **A9** `artPage`: Scope, Temporal Scope, Visual State / Period, Dependencies, Related Sources; Temporal Scope and
 *   Visual State are never copied: left out, they are listed under "still to fill". Dependencies always gain the
 *   identity page.
 *
 * The job (src/packs/engine/job.ts) and the items (src/packs/art-items.ts) follow from the plan built here.
 */
import type { McpToolContext, McpToolResult } from '../mcp/server.js';
import { errorResult, type ProjectDeps } from '../mcp/tools/shape.js';
import { liveRead } from '../mcp/tools/repo.js';
import type { FromMarkdownContext, LkBlock } from '../markdown/index.js';
import { pageConverterContext } from '../pages/index.js';
import { factKey, sidebarFrom, valueText, type SidebarProperty } from '../facts/index.js';
import type { LinkTarget } from '../facts/plan.js';
import { decidePlacement, type Placement } from '../art/placement.js';
import { outfitKey } from '../art/names.js';
import { DEFAULT_ART_CALL_MAX_GROUPS, DEFAULT_ART_CALL_MAX_IMAGES } from '../config/tools.js';
import type { LmrMode } from '../jobs/lmr-hook.js';
import { resolveArchiveImages, stageForPack } from './intake.js';
import {
  planExisting,
  planImages,
  planPackage,
  withImages,
  type ArtBlockGroup,
  type ArtGroupReport,
  type ArtImageGroup,
  type ArtLine,
  type ArtPlan,
  type CharacterHit,
  type ExistingChange,
  type ImagePlacement,
  type Issue,
  type PackPlan,
  type PackageImage,
  type PlanEnv,
  type PlannedImage,
} from './engine/plan.js';
import type { TypeRules } from './types.js';
import type { TreeNode } from '../tree/index.js';
import { characterEnv, finishPackage, packBasis } from './run.js';
import { liveArtFolder } from './art-place.js';
import { artPageOf, indexOf, nameOf, oneCharacter, piecesNamedOnPages } from './character-tools.js';
import type { ArtImageInput } from './character-tools.js';
import type { OutfitRecord } from '../art/store.js';

type Obj = Record<string, unknown>;

/** v3 F7d (A1): one group of a groups call. */
export interface ArtGroupInput {
  /** Absent or null: the design pieces. */
  readonly outfit?: string | null | undefined;
  readonly newOutfit?: boolean | undefined;
  readonly images: readonly ArtImageInput[];
}

/** v3 F7d (A9): the Art page's own fields: used when it is made, applied to its EMPTY rows when it exists. */
export interface ArtPageFields {
  readonly scope?: string | undefined;
  readonly temporalScope?: string | undefined;
  readonly visualState?: string | undefined;
  readonly dependencies?: readonly string[] | undefined;
  readonly related?: readonly string[] | undefined;
  /** A new Art page's text (drafted when left out) and status. */
  readonly markdown?: string | undefined;
  readonly status?: 'working' | 'authoritative' | undefined;
}

export interface ArtGroupsInput {
  readonly character: string;
  readonly groups: readonly ArtGroupInput[];
  readonly artPage?: ArtPageFields | undefined;
}

interface Run<I> {
  readonly packId: string;
  readonly tool: string;
  readonly input: I;
  readonly dryRun: boolean;
  readonly operationId?: string | undefined;
  readonly args: Obj;
  readonly lastMajorRevision?: LmrMode | undefined;
}

/** v3 F7d (A9): the Art page's rows that are never copies (left empty, and listed, when the agent gives none). */
export const TEMPORAL_SCOPE = 'Temporal Scope';
export const VISUAL_STATE = 'Visual State / Period';

/**
 * v3 F7d (A8, A10): the identity fields an Art page (and any other page of the character's set) carries as COPIES of
 * the identity page, as the pack names them: Subject, Canonical Display Name, Family / Surname, Personal / Given Name,
 * Naming Culture, Aliases. Never Temporal Scope, Race / Species or Life State (they are not copies).
 */
export function identityCopyKeys(type: TypeRules): string[] {
  const key = (field: string, fallback: string) =>
    type.identity.find((f) => f.field === field)?.key ?? fallback;
  return [
    'Subject',
    key('canonicalDisplayName', 'Canonical Display Name'),
    key('surname', 'Family / Surname'),
    key('givenName', 'Personal / Given Name'),
    key('namingCulture', 'Naming Culture'),
    key('aliases', 'Aliases'),
  ];
}

/** A page's key-value rows (the pack's facts property), or null. */
export function factsProperty(sidebar: readonly SidebarProperty[], title: string): SidebarProperty | null {
  return sidebar.find((p) => p.kind === 'keyValue' && factKey(p.title) === factKey(title)) ?? null;
}

/** A row's value as text, or null when the page has no such row ('' when it is empty). */
export function rowText(kv: SidebarProperty | null, key: string): string | null {
  const row = kv?.rows?.find((r) => factKey(r.key) === factKey(key));
  return row ? valueText(row.content) : null;
}

/** One group once matched and merged (A2). */
interface PlannedGroup {
  readonly key: string;
  readonly label: string;
  /** The groups of the call it holds (their positions, 0-based). */
  readonly from: number[];
  readonly images: PackageImage[];
  readonly placement: Extract<Placement, { ok: true }>;
}

const problem = (code: string, message: string, more: Obj = {}): Issue => ({ code, message, ...more });

export async function runArtGroups(
  pd: ProjectDeps,
  mctx: McpToolContext,
  o: Run<ArtGroupsInput>,
): Promise<McpToolResult> {
  const b = await packBasis(pd, mctx, o.packId, o.tool);
  if (!b.ok) return b.result;
  const e = characterEnv(pd, mctx, o.tool, b.value, 'Character', o.lastMajorRevision);
  if (!e.ok) return e.result;
  const env = e.env;
  const { type, ctx, pack } = env;
  const ch = oneCharacter(pd, env, o.input.character, 'character');
  if (!ch.ok) return ch.result;
  const groups = o.input.groups;
  const page = o.input.artPage ?? {};

  // A1: the limits (the call refused whole, before anything is read).
  const maxImages = pd.settings.artCallMaxImages ?? DEFAULT_ART_CALL_MAX_IMAGES;
  const maxGroups = pd.settings.artCallMaxGroups ?? DEFAULT_ART_CALL_MAX_GROUPS;
  const total = groups.reduce((n, g) => n + g.images.length, 0);
  if (groups.length === 0)
    return errorResult({ code: 'GROUPS_REQUIRED', message: 'Give at least one group.' }, pd);
  if (groups.length > maxGroups || total > maxImages)
    return errorResult(
      {
        code: 'ART_CALL_TOO_LARGE',
        message: `This call has ${groups.length} group${groups.length === 1 ? '' : 's'} and ${total} image${total === 1 ? '' : 's'}; one call takes at most ${maxGroups} groups (ART_CALL_MAX_GROUPS) and ${maxImages} images (ART_CALL_MAX_IMAGES). Split the set into calls of at most that size.`,
        groups: groups.length,
        images: total,
        maxGroups,
        maxImages,
      },
      pd,
    );

  const problems: Issue[] = [];
  const where = (gi: number, g: ArtGroupInput) =>
    `groups[${gi}] (${g.outfit ? `outfit “${g.outfit}”` : 'design pieces'})`;

  // 1. Each image's source (A1): a staged image, an archive entry (staged, or planned from its header), or an upload
  // staged now on the bridge's server.
  const stagedNow: { from: string; staged_id: string; deduplicated: boolean }[] = [];
  const fromArchives: Obj[] = [];
  const sourced: PackageImage[][] = [];
  for (const [gi, g] of groups.entries()) {
    const out: PackageImage[] = [];
    sourced.push(out);
    if (g.images.length === 0) {
      problems.push(problem('GROUP_EMPTY', `${where(gi, g)}: a group needs at least one image.`));
      continue;
    }
    const ok: ArtImageInput[] = [];
    for (const [ii, im] of g.images.entries()) {
      const n = [im.staged_id, im.upload_id, im.archive].filter((x) => x !== undefined).length;
      if (n !== 1)
        problems.push(
          problem(
            'IMAGE_SOURCE_INVALID',
            `${where(gi, g)}: images[${ii}] (${im.label}): give exactly one of staged_id, upload_id or archive.`,
          ),
        );
      else ok.push(im);
    }
    const arch = resolveArchiveImages(pd, ok);
    for (const n of arch.notUsed)
      problems.push(
        problem(
          'IMAGE_NOT_USABLE',
          `${where(gi, g)}: ${n.label}: the archive entry cannot be used (${n.code}: ${n.reason}). Leave it out of the call, or use another image.`,
          { archive: n.archive },
        ),
      );
    fromArchives.push(...arch.fromArchives);
    for (const im of arch.images) {
      let id = im.staged_id;
      if (id === undefined && im.upload_id !== undefined) {
        const r = await stageForPack(pd, mctx, o.tool, { upload_id: im.upload_id }, im.label);
        if (!r.ok) {
          problems.push(problem(r.code, `${where(gi, g)}: ${im.label}: ${r.message}`, r.details ?? {}));
          continue;
        }
        id = r.stagedId;
        stagedNow.push({ from: r.source, staged_id: id, deduplicated: r.deduplicated });
      }
      if (id === undefined) continue;
      out.push({
        staged_id: id,
        label: im.label,
        ...(im.interpretation !== undefined ? { interpretation: im.interpretation } : {}),
        ...(im.pending ? { pending: im.pending } : {}),
      });
    }
  }
  const seen = new Map<string, number>();
  for (const [gi, list] of sourced.entries())
    for (const im of list) {
      const at = seen.get(im.staged_id);
      if (at !== undefined)
        problems.push(
          problem(
            'STAGED_IMAGE_TWICE',
            `${where(gi, groups[gi]!)}: ${im.label}: ${im.staged_id} is also in groups[${at}]; an image belongs to one group.`,
          ),
        );
      else seen.set(im.staged_id, gi);
    }

  // 2. The character's folders, live, once (G9), and its outfit record, once.
  const subject = nameOf(env, ch.hit);
  const index = indexOf(env, ch.hit);
  const art = artPageOf(env, index, subject);
  const folder = await liveArtFolder(env, ch.hit, subject);
  if (!folder.ok) return folder.result;
  const { race, characterFolderId, layout } = folder.value;
  const records: OutfitRecord[] =
    characterFolderId && pd.services?.outfits
      ? pd.services.outfits.forCharacter(ctx.projectId, characterFolderId)
      : [];
  const decide = (outfit: string | null | undefined, newOutfit: boolean | undefined, arriving: number) =>
    decidePlacement({ character: subject, layout, records, outfit, newOutfit, arriving });

  // 3. Each group matched (A2); groups naming the same outfit merged, in the order first given.
  const notes: string[] = [];
  const merged = new Map<
    string,
    { label: string; from: number[]; images: PackageImage[]; given: string | null; newOutfit: boolean }
  >();
  for (const [gi, g] of groups.entries()) {
    const imgs = sourced[gi]!;
    if (g.outfit === undefined || g.outfit === null) {
      const d = merged.get('design') ?? {
        label: 'Design pieces',
        from: [],
        images: [],
        given: null,
        newOutfit: false,
      };
      d.from.push(gi);
      d.images.push(...imgs);
      merged.set('design', d);
      continue;
    }
    const p = decide(g.outfit, g.newOutfit, Math.max(1, g.images.length));
    if (!p.ok) {
      problems.push(
        problem(p.code, `${where(gi, g)}: ${p.message}`, p.candidates ? { candidates: p.candidates } : {}),
      );
      continue;
    }
    if (p.kind !== 'outfit') continue;
    const key = `outfit:${outfitKey(p.outfit.name)}`;
    const m = merged.get(key) ?? {
      label: `Outfit ${p.outfit.name}`,
      from: [],
      images: [],
      given: g.outfit,
      newOutfit: false,
    };
    m.from.push(gi);
    m.images.push(...imgs);
    m.newOutfit ||= g.newOutfit === true;
    merged.set(key, m);
  }
  for (const [key, m] of merged)
    if (m.from.length > 1)
      notes.push(
        `groups ${m.from.map((i) => `[${i}]`).join(', ')} all name ${key === 'design' ? 'the design pieces' : `“${m.label.replace(/^Outfit /, '')}”`}: merged into one group (${m.images.length} images).`,
      );
  // Placement per merged group, counting the outfit's recorded pieces plus everything this call brings (G2).
  const planned: PlannedGroup[] = [];
  const design = merged.get('design');
  if (design)
    planned.push({
      key: 'design',
      label: design.label,
      from: design.from,
      images: design.images,
      placement: { ok: true, kind: 'design', subfolders: [] },
    });
  for (const [key, m] of merged) {
    if (key === 'design') continue;
    const p = decide(m.given, m.newOutfit, Math.max(1, m.images.length));
    if (!p.ok) {
      problems.push(problem(p.code, `groups ${m.from.map((i) => `[${i}]`).join(', ')}: ${p.message}`));
      continue;
    }
    planned.push({ key, label: m.label, from: m.from, images: m.images, placement: p });
  }

  // 4. The identity page, live (A8): its values are what the Art page copies.
  const idRead = await liveRead(pd, mctx, o.tool, 'getResource', {
    path: { resourceId: ch.hit.identity.id },
  });
  if (!idRead.ok)
    problems.push(
      problem(
        'IDENTITY_UNREADABLE',
        `${ch.hit.identity.rawName} (the identity page) could not be read now, so its values cannot be copied to the Art page; nothing is decided from a cached copy. Try again shortly.`,
      ),
    );
  const props = pack.rules.sidebar.property;
  const idKv = idRead.ok ? factsProperty(sidebarFrom(idRead.value), props) : null;
  const copyKeys = identityCopyKeys(type);
  const copies = copyKeys
    .map((k) => ({ key: k, value: rowText(idKv, k) ?? '' }))
    .filter((c) => c.value !== '');

  // 5. Every problem of every group, at once (A2: the owner's ruling).
  if (problems.length > 0)
    return errorResult(
      {
        code: problems.length === 1 ? problems[0]!.code : 'ART_GROUPS_REFUSED',
        message:
          problems.length === 1
            ? `${problems[0]!.message} Nothing was planned or proposed.`
            : `${problems.length} problems in this call; nothing was planned or proposed. Fix them all and call again: ${problems.map((p, i) => `(${i + 1}) ${p.code}: ${p.message}`).join(' ')}`,
        problems,
        ...(stagedNow.length > 0
          ? {
              stagedNow,
              stagedNote:
                'These uploads were staged on the bridge’s server; calling again, give their staged_id.',
            }
          : {}),
      },
      pd,
    );

  // 6. The moves, and the lines on the character's pages naming a moved piece (for the owner, never edited).
  const allMoves = planned.flatMap((g) => (g.placement.kind === 'outfit' ? g.placement.moves : []));
  const named = await piecesNamedOnPages(env, index, allMoves);
  const linesFor = (g: PlannedGroup): ArtLine[] => {
    if (g.placement.kind !== 'outfit') return [];
    const ids = new Set(g.placement.moves.map((m) => m.id));
    const names = new Set(g.placement.moves.map((m) => m.name));
    return named.lines.filter(
      (l) => [...ids].some((id) => l.text.includes(id)) || [...names].some((n) => l.text.includes(n)),
    );
  };
  const imageGroups: ArtImageGroup[] = planned.map((g) => ({
    key: g.key,
    images: g.images,
    placement: placementOf(g),
  }));
  const groupOf: Record<string, string> = {};
  for (const g of planned) for (const im of g.images) groupOf[im.staged_id] = g.key;
  const base = (layout?.character.path ?? []).join(' / ');
  const wardrobe = layout?.wardrobe ?? null;
  const outfits: NonNullable<ArtPlan['outfits']> = planned
    .filter((g) => g.placement.kind === 'outfit')
    .map((g) => {
      const p = g.placement as Extract<Placement, { ok: true; kind: 'outfit' }>;
      const lines = linesFor(g);
      return {
        key: g.key,
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
      };
    });

  // 7. The plan: a new Art page (its sidebar planned with it), or the existing one extended (one write) with its sidebar
  // filled where empty, after the images.
  const sidebarView: Obj = {};
  let plan: PackPlan;
  if (!art) {
    const deps = [ch.hit.identity.id, ...(page.dependencies ?? [])];
    const extraFacts = [
      ...copies,
      ...(page.temporalScope ? [{ key: TEMPORAL_SCOPE, value: page.temporalScope }] : []),
      ...(page.visualState ? [{ key: VISUAL_STATE, value: page.visualState }] : []),
    ];
    plan = await planPackage(env, {
      name: subject,
      target: ch.hit.identity.id,
      ...(page.status !== undefined ? { status: page.status } : {}),
      identity: {},
      imageGroups,
      pages: [
        {
          role: type.assets.role,
          scope: page.scope ?? `${subject}'s approved visual references`,
          markdown:
            page.markdown ??
            `## Purpose\n\n${subject}'s approved visual references: each image below with what it establishes.\n`,
          extraFacts,
          dependencies: [...new Set(deps)],
          ...(page.related ? { related: page.related } : {}),
        },
      ],
    });
    if (page.markdown === undefined)
      plan.notes.push(
        'The Art page’s Purpose is drafted (shown in the preview); give artPage.markdown for your own.',
      );
    const made = plan.pages.find((p) => p.role === type.assets.role);
    const tkeys = made?.templateKeys ?? [];
    const has = (k: string) => tkeys.some((x) => factKey(x) === factKey(k));
    sidebarView.copied = copies.filter((c) => has(c.key));
    sidebarView.notOnTemplate = copyKeys.filter((k) => !has(k));
    sidebarView.stillToFill = [
      ...(has(TEMPORAL_SCOPE) && !page.temporalScope ? [TEMPORAL_SCOPE] : []),
      ...(has(VISUAL_STATE) && !page.visualState ? [VISUAL_STATE] : []),
    ];
    sidebarView.dependencies =
      made?.linkTargets
        .find((l) => factKey(l.title) === factKey(pack.rules.sidebar.dependencies))
        ?.targets.map((t) => t.name) ?? [];
    plan = {
      ...plan,
      art: {
        characterName: subject,
        characterFolderId,
        outfit: null,
        outfits,
        groupOf,
        report: reportOf(planned, plan.images),
        ...(idKv
          ? { identityCheck: { page: ch.hit.identity, propertyId: idKv.id, rows: idKv.rows ?? [] } }
          : {}),
      },
      extra: {
        ...(plan.extra ?? {}),
        artPage: { create: made?.rawName ?? null },
      },
    };
  } else {
    plan = await extendArtPage(env, {
      hit: ch.hit,
      subject,
      art,
      race,
      planned,
      imageGroups,
      copies,
      copyKeys,
      page,
      idKv,
      sidebarView,
    });
    plan = {
      ...plan,
      art: {
        characterName: subject,
        characterFolderId,
        outfit: null,
        outfits,
        groupOf,
        report: reportOf(planned, plan.images),
      },
    };
    if (ch.hit.role === 'compact' && index)
      plan.warnings.push({
        code: 'CORE_MISSING',
        message: `${ch.hit.identity.rawName} is still a Compact Character Reference at the head of ${index.rawName}, which has several owners: a character with an index and several owners has a Character Core. Upgrade it with arkona_create_character (target “${ch.hit.identity.rawName}”, upgradeToCore: true), or ask the owner to approve the audit's character_core_missing proposal.`,
      });
  }
  const stillToFill = (sidebarView.stillToFill as string[] | undefined) ?? [];
  if (stillToFill.length > 0)
    plan.notes.push(
      `Still to fill on the Art page: ${stillToFill.join(' and ')} (not copied from the identity page: they are this page's own; give artPage.temporalScope or artPage.visualState).`,
    );
  const pendingCount = plan.images.filter((i) => i.pending).length;
  return finishPackage(pd, mctx, o, env, {
    ...plan,
    notes: [
      ...plan.notes,
      `The character’s asset folders were read live once (${folder.value.live.requests} request${folder.value.live.requests === 1 ? '' : 's'}), and its identity page once.`,
      ...notes,
      ...planned.map((g) => groupNote(g)),
      ...(named.lines.length > 0
        ? [
            `${named.lines.length} line(s) on ${subject}'s pages name a piece this moves (they may state where it is): listed for you, never edited (linesForOwner).`,
          ]
        : []),
      ...(named.unread.length > 0
        ? [
            `Could not be read now, so not checked for lines naming a moved piece: ${named.unread.join(', ')}.`,
          ]
        : []),
      ...(pendingCount > 0
        ? [
            `${pendingCount} archive entr${pendingCount === 1 ? 'y is' : 'ies are'} not staged yet: planned from the header; the approved job waits for them (waiting_staging). Never upload them again; follow bridge_archive_status.`,
          ]
        : []),
      'Approve item by item: an outfit or the design pieces left out are not placed (their images stay staged for a later call); an item needs the Art page’s item when the page is new.',
    ],
    extra: {
      ...(plan.extra ?? {}),
      // A5: the reads made to plan (the folders, the identity page, the Art page's sidebar; the character's pages read
      // for lines naming a moved piece come on top when something moves).
      planReads: folder.value.live.requests + 1 + (art ? 1 : 0),
      groups: planned.map((g) => groupView(g, plan.images)),
      sidebar: sidebarView,
      ...(named.lines.length ? { linesForOwner: named.lines } : {}),
      ...(stagedNow.length > 0
        ? {
            stagedNow,
            stagedNote:
              'These images were staged on the bridge’s server for this package (nothing is in LegendKeeper until the owner approves it). Calling again, give their staged_id.',
          }
        : {}),
      ...(fromArchives.length > 0 ? { fromArchives } : {}),
    },
  });
}

/** A group's placement as planImages takes it. */
function placementOf(g: PlannedGroup): ImagePlacement {
  const p = g.placement;
  if (p.kind === 'design') return { subfolders: [], outfit: null };
  return {
    subfolders: p.subfolders,
    outfit: p.outfit.name,
    ...(p.moves.length > 0 ? { taken: new Set(p.moves.map((m) => m.name)) } : {}),
  };
}

/** The job's per-group report (A4): what each group brings, by staged id, and its moves. */
function reportOf(planned: readonly PlannedGroup[], images: readonly PlannedImage[]): ArtGroupReport[] {
  return planned.map((g) => ({
    key: g.key,
    label: g.label,
    images: g.images.map((im) => ({
      stagedId: im.staged_id,
      name: images.find((x) => x.stagedId === im.staged_id)?.name ?? im.label,
    })),
    moves:
      g.placement.kind === 'outfit' ? g.placement.moves.map((m) => ({ assetId: m.id, name: m.name })) : [],
  }));
}

/** The folder decision of a group, in words (A3's preview). */
function folderDecision(g: PlannedGroup): string {
  const p = g.placement;
  if (p.kind === 'design') return 'the character’s own folder';
  if (p.into === 'wardrobe') return `loose in ${p.subfolders.join(' / ')} (its only piece)`;
  return p.folderId ? `its folder ${p.subfolders.join(' / ')}` : `a new folder ${p.subfolders.join(' / ')}`;
}

function groupNote(g: PlannedGroup): string {
  const p = g.placement;
  if (p.kind === 'design')
    return `Design pieces: ${g.images.length} image(s), in the character’s own folder.`;
  return `Outfit “${p.outfit.name}”${p.outfit.source === 'new' ? ' (new)' : ''}: ${p.existing.length} piece(s) already, ${g.images.length} arriving: placed ${folderDecision(g)}${p.moves.length ? `; ${p.moves.map((m) => `“${m.name}”`).join(', ')} moved into it` : ''}.${p.notes.length ? ` ${p.notes.join(' ')}` : ''}`;
}

/** A group in the preview (A3): its folder decision, its asset names and the moves of its loose pieces. */
function groupView(g: PlannedGroup, images: readonly PlannedImage[]): Obj {
  const p = g.placement;
  const mine = images.filter((im) => g.images.some((x) => x.staged_id === im.stagedId));
  return {
    group: g.label,
    item: g.key,
    from: g.from.map((i) => `groups[${i}]`),
    folder: folderDecision(g),
    ...(p.kind === 'outfit'
      ? {
          outfit: p.outfit.name,
          known: p.outfit.source,
          ...(p.outfit.via && p.outfit.via !== p.outfit.name ? { matchedAlias: p.outfit.via } : {}),
          existingPieces: p.existing.length,
          total: p.total,
        }
      : {}),
    assets: mine.map((im) => ({ name: im.name, folder: im.path.join(' / ') })),
    moves: p.kind === 'outfit' ? p.moves.map((m) => m.name) : [],
  };
}

/**
 * An existing Art page extended by a groups call: every group's images planned with its own placement, their blocks
 * in ONE write (the `pack.art_groups` filler places each group inside the lock), and the sidebar filled where empty
 * (A8, A9), after the images.
 */
async function extendArtPage(
  env: PlanEnv,
  o: {
    readonly hit: CharacterHit;
    readonly subject: string;
    readonly art: TreeNode;
    readonly race: string | null;
    readonly planned: readonly PlannedGroup[];
    readonly imageGroups: readonly ArtImageGroup[];
    readonly copies: readonly { key: string; value: string }[];
    readonly copyKeys: readonly string[];
    readonly page: ArtPageFields;
    readonly idKv: SidebarProperty | null;
    readonly sidebarView: Obj;
  },
): Promise<PackPlan> {
  const { pd, ctx, type, pack } = env;
  const { art, subject } = o;
  const refusals: Issue[] = [];
  const warnings: Issue[] = [];
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
  const baseCtx = pd.services ? pageConverterContext(pd.services, ctx.projectId) : undefined;
  const converter: FromMarkdownContext | undefined = baseCtx ? { ...baseCtx } : undefined;
  if (!converter) refuse('TOOL_UNAVAILABLE', 'The repository tree cannot resolve names now.');
  const boundaries = [
    ...(type.roles.find((r) => r.role === type.assets.role)?.warnMissing ?? []),
    'Source Boundaries',
    'Unresolved Material',
  ];
  const all: PlannedImage[] = [];
  const blocks: LkBlock[] = [];
  const groups: ArtBlockGroup[] = [];
  for (const g of o.imageGroups) {
    const pg = o.planned.find((x) => x.key === g.key)!;
    const planned = planImages(env, {
      page: art.rawName,
      subject,
      race: o.race,
      images: g.images,
      refuse,
      warn,
      placement: g.placement,
      where: pg.label,
    });
    all.push(...planned);
    const outfit = pg.placement.kind === 'outfit' ? pg.placement.outfit : null;
    const section = outfit ? outfit.name : type.assets.section;
    const mine =
      converter && planned.length > 0 ? withImages([], planned, section, boundaries, converter) : [];
    blocks.push(...mine);
    groups.push({
      key: g.key,
      section,
      ...(outfit ? { outfit: { name: outfit.name, aliases: [...outfit.aliases] } } : {}),
      blockIds: mine.map((b) => (b as { id?: unknown }).id).filter((x): x is string => typeof x === 'string'),
    });
  }
  const existing: ExistingChange[] = [];
  const pageRef = ctx.types.resolveOne(art.id);
  if (doc && all.length > 0)
    existing.push({
      kind: 'images',
      page: pageRef,
      documentId: doc.id,
      blocks,
      section: type.assets.section,
      boundaries,
      images: all,
      groups,
    });

  // A8, A9: the Art page's sidebar, read live: only empty rows are filled; a differing value is reported, never
  // overwritten; Dependencies gain the identity page.
  const props = pack.rules.sidebar.property;
  const read = await liveRead(pd, env.mctx, env.tool, 'getResource', { path: { resourceId: art.id } });
  if (!read.ok) refuse('ART_PAGE_UNREADABLE', `${art.rawName}: its sidebar could not be read now.`);
  const sidebar = read.ok ? sidebarFrom(read.value) : [];
  const kv = factsProperty(sidebar, props);
  const facts: { key: string; value: string }[] = [];
  const copied: Obj[] = [];
  const differs: Obj[] = [];
  const leftAlone: Obj[] = [];
  const notOnTemplate: string[] = [];
  for (const k of o.copyKeys) {
    const mine = rowText(kv, k);
    const theirs = o.copies.find((c) => factKey(c.key) === factKey(k))?.value ?? '';
    if (mine === null) {
      notOnTemplate.push(k);
      continue;
    }
    if (theirs === '') continue;
    if (mine === '') {
      facts.push({ key: k, value: theirs });
      copied.push({ key: k, value: theirs });
    } else if (mine !== theirs) differs.push({ key: k, artPage: mine, identityPage: theirs });
  }
  const own: { key: string; value: string | undefined }[] = [
    { key: 'Scope', value: o.page.scope },
    { key: TEMPORAL_SCOPE, value: o.page.temporalScope },
    { key: VISUAL_STATE, value: o.page.visualState },
  ];
  const stillToFill: string[] = [];
  for (const f of own) {
    const mine = rowText(kv, f.key);
    if (mine === null) continue;
    if (f.value === undefined || f.value === '') {
      if (mine === '' && f.key !== 'Scope') stillToFill.push(f.key);
      continue;
    }
    if (mine === '') facts.push({ key: f.key, value: f.value });
    else if (mine !== f.value)
      leftAlone.push({ key: f.key, kept: mine, given: f.value, why: 'the row is not empty: left as it is' });
  }
  for (const d of differs)
    warnings.push({
      code: 'IDENTITY_COPY_DIFFERS',
      message: `${art.rawName}: ${String(d.key)} is “${String(d.artPage)}” but the identity page says “${String(d.identityPage)}”: left as it is (never overwritten); the audit's owner_identity_copy_drift proposes the fix.`,
    });
  const resolve = (ref: string): LinkTarget | null => {
    const r = ctx.types.resolve(ref, {});
    if (r.status !== 'resolved') {
      refuse(
        r.status === 'ambiguous' ? 'LINK_TARGET_AMBIGUOUS' : 'LINK_TARGET_NOT_FOUND',
        r.status === 'ambiguous'
          ? `${art.rawName}: the link “${ref}” names ${r.candidates.length} pages; give the id of the one meant.`
          : `${art.rawName}: the link “${ref}” names no page of the repository.`,
      );
      return null;
    }
    return { resourceId: r.node.id, name: r.node.rawName };
  };
  const depTargets = [
    { resourceId: o.hit.identity.id, name: o.hit.identity.rawName },
    ...(o.page.dependencies ?? []).map(resolve).filter((t): t is LinkTarget => t !== null),
  ].filter((t, i, a) => a.findIndex((x) => x.resourceId === t.resourceId) === i);
  const relTargets = (o.page.related ?? []).map(resolve).filter((t): t is LinkTarget => t !== null);
  const links = [
    { title: pack.rules.sidebar.dependencies, targets: depTargets },
    ...(relTargets.length ? [{ title: pack.rules.sidebar.related, targets: relTargets }] : []),
  ];
  if (read.ok) {
    const fp = planExisting(sidebar, art.id, props, facts, links, refuse, art.rawName);
    if (fp)
      existing.push({
        kind: 'facts',
        page: pageRef,
        sidebar,
        plan: fp,
        why: [
          ...(copied.length
            ? [`${copied.length} identity cop${copied.length === 1 ? 'y' : 'ies'} filled`]
            : []),
          ...facts.filter((f) => !copied.some((c) => c.key === f.key)).map((f) => `${f.key} filled`),
          ...(fp.links.some((l) => l.added.length > 0)
            ? fp.links.filter((l) => l.added.length > 0).map((l) => `${l.title}: +${l.added.length}`)
            : []),
        ],
        substantial: false,
        late: true,
        ...(o.idKv
          ? { identityCheck: { page: o.hit.identity, propertyId: o.idKv.id, rows: o.idKv.rows ?? [] } }
          : {}),
      });
  }
  Object.assign(o.sidebarView, {
    copied,
    ...(differs.length ? { differs } : {}),
    ...(leftAlone.length ? { leftAlone } : {}),
    notOnTemplate,
    stillToFill,
    dependencies: depTargets.map((t) => t.name),
    ...(relTargets.length ? { related: relTargets.map((t) => t.name) } : {}),
  });
  return {
    pack,
    type,
    mode: 'extend',
    subject,
    status,
    pages: [],
    existing,
    images: all,
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
    absent: { reservation: null, under: [], kind: 'art', images: all.map((i) => i.stagedId) },
    target: { identity: o.hit.identity, index: null, role: o.hit.role },
    notes: [
      `${art.rawName} exists: one write adds every group, in the order given: the design pieces at the end of its “${type.assets.section}” section, each outfit under its heading (found anywhere on the page when the job runs; else made under the page’s first heading holding “Wardrobe”; else under a new “Wardrobe” section). Nothing else on the page changes.`,
    ],
    extra: { artPage: { extend: art.rawName, id: art.id } },
    ...(all.some((i) => i.takeover)
      ? {
          takeovers: all
            .filter((i) => i.takeover)
            .map((i) => ({ stagedId: i.stagedId, proposalId: i.takeover! })),
        }
      : {}),
  };
}
