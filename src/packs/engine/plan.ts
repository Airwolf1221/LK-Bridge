/**
 * The setting-pack planner (v3 F3a, ADR 0050): ONE package to a plan of linked pages, from the pack's rules (data) and its
 * type's hook, with no write. It refuses rather than guesses, and says everything it decided:
 *
 * - the text rules first (dashes replaced and listed; forbidden words and dates in page names refused);
 * - the subject: a new one (refused with CHARACTER_EXISTS when one of that name exists: pass `target`), or an existing
 *   one named by `target` (an index, a Core or a Compact Reference; ambiguous names refused with each candidate);
 * - the gate (each gated identity field given, never blank or a placeholder; `Unestablished` only with a reason, which is
 *   written into Unresolved Material); an existing subject's blank gated fields are warned about and fixed when given;
 * - the pages: only the roles the package brings, the index when the hook wants one, each from its template, named by
 *   its rule, placed by the type's placement rule, with its sidebar facts in template order (never a row added or
 *   dropped), its computed tags (held slots reported), its links resolved to exact ids, and its body converted and
 *   checked (Purpose first, no title or metadata header, no empty section, missing sections warned about);
 * - images from staged uploads into the subject's asset folder (mirroring the race path) with Visual References names;
 * - for an existing subject: an index made in the Reference's place (the Reference moved under it, id kept), an upgrade
 *   of a Compact Reference to a Core, the gate's fixes, the relationship's automatic links, the index's routing lines.
 */
import { createHash } from 'node:crypto';
import { factKey, sidebarFrom, type SidebarProperty, type SidebarRow } from '../../facts/index.js';
import { FactsPlanError, planFacts, type FactsPlan, type LinkTarget } from '../../facts/plan.js';
import { rowTextRuns } from '../../facts/values.js';
import { mintClientId } from '../../jobs/ids.js';
import { textChange, textChangeWords } from '../../jobs/text-change.js';
import type { LmrMode } from '../../jobs/lmr-hook.js';
import type { LifecycleConfig } from '../../lifecycle/settings.js';
import type { LmrConfig } from '../../lmr/index.js';
import {
  applyEdit,
  fromMarkdown,
  getSection,
  MarkdownError,
  toMarkdown,
  type FromMarkdownContext,
  type LkBlock,
} from '../../markdown/index.js';
import { pageConverterContext, withImageCheck } from '../../pages/index.js';
import { cleanPrefixes, key as nameKey, subjectOf } from '../../registry/names.js';
import { slotAmong } from '../../registry/ordering.js';
import type { NodeRef } from '../../registry/index.js';
import { RegistryError } from '../../registry/index.js';
import { classifyName } from '../../tree/classify.js';
import type { TreeNode } from '../../tree/index.js';
import type { McpToolContext } from '../../mcp/server.js';
import { liveRead, type RepoCtx } from '../../mcp/tools/repo.js';
import type { ProjectDeps } from '../../mcp/tools/shape.js';
import type { CreateCtx, NewPage, NewPageFactsPlan } from '../../mcp/tools/create-support.js';
import { readSidebar, statusValue } from '../../mcp/tools/create-support.js';
import type { ImageUploadRow } from '../../images/store.js';
import type { GovernanceStatus } from '../service.js';
import type { TypeHook } from '../hooks.js';
import type { Pack, RoleRule, TypeRules } from '../types.js';
import { computeTags, type HeldSlot } from './tags.js';
import {
  coreNeed,
  imageKeys,
  isOwnerRole,
  ownersInIndex,
  planCoreImages,
  reword,
  nameWord,
  visualTextWarning,
  wordingLeft,
  type CompactLeft,
  type Replacement as CoreReplacement,
  type WordingNames,
} from './core.js';
import {
  currentCharacters,
  namesakeLine,
  namesakesOf,
  namesakeView,
  splitAliases,
  usableName,
} from '../naming/namesakes.js';
import {
  blockText,
  checkBody,
  isPlaceholder,
  nameProblem,
  oneLine,
  replaceDashes,
  replaceDashesInMarkdown,
  sectionsOf,
  textKey,
  type Replacement,
} from './text.js';

type Obj = Record<string, unknown>;

// ============================================================================================ the package

export type IdentityValue = string | { readonly value: string; readonly reason?: string | undefined };

export interface PackageImage {
  readonly staged_id: string;
  readonly label: string;
  readonly interpretation?: string | undefined;
  /**
   * v3 F7c (ADR 0075, Z4): an archive entry not staged yet: `staged_id` is the id reserved for it, and the plan is made
   * from its header (its proposal and job name that id; the job waits until it is staged). Bridge code only.
   */
  readonly pending?: PendingArchiveImage;
}

/** v3 F7c: what an archive entry's header says, for planning before it is staged. */
export interface PendingArchiveImage {
  readonly archiveId: string;
  readonly path: string;
  readonly format: string;
  readonly width: number;
  readonly height: number;
  readonly frames: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly principalId: string;
}

/** v3 F7c: the placeholder SHA-256 a not-yet-staged entry's upload steps carry until the job binds the real one. */
export const PENDING_SHA256 = '0'.repeat(64);

/** v3 F7c: an image record for planning, from a not-yet-staged archive entry's header (never stored). */
function pendingRow(projectId: string, stagedId: string, p: PendingArchiveImage): ImageUploadRow {
  return {
    projectId,
    id: stagedId,
    state: 'uploaded',
    jobId: null,
    assetId: null,
    name: p.path.slice(p.path.lastIndexOf('/') + 1),
    description: null,
    folderId: null,
    folderPath: null,
    staged: true,
    intended: { archive: { id: p.archiveId, entry: p.path } },
    source: 'archive',
    principalId: p.principalId,
    original: { format: p.format, sha256: p.sha256, bytes: p.bytes, orientation: null },
    webp: { sha256: PENDING_SHA256, bytes: Math.max(1, p.bytes) },
    width: p.width,
    height: p.height,
    frames: p.frames,
    hasAlpha: false,
    conversionMode: 'converted',
    quality: null,
    convertMs: null,
    storedVerified: null,
    storedSha256: null,
    verifyReason: null,
    error: null,
    placedAt: null,
    placedBy: null,
    placementJobId: null,
    placementProposalId: null,
    discardJobId: null,
    discardedAt: null,
    discardedBy: null,
    createdAt: 0,
    updatedAt: 0,
    serverSha256: PENDING_SHA256,
    expiryWarnedAt: null,
    legacyAssetId: null,
  };
}

/**
 * v3 F7 (ADR 0070, G2): where a call's images go, as the bridge decided (src/art/placement.ts): the folder chain under
 * the character's folder (none: a design piece), the outfit (G4's name part) and the names already in the target
 * folder that the job does not see in the tree yet (the loose pieces it moves into a new folder).
 */
export interface ImagePlacement {
  readonly subfolders: readonly string[];
  readonly outfit: string | null;
  readonly taken?: ReadonlySet<string>;
}

/** v3 F7d (ADR 0077): one group of a groups call, as the engine takes it. */
export interface ArtImageGroup {
  /** The group's item key (`design`, or `outfit:<key>`). */
  readonly key: string;
  readonly placement: ImagePlacement;
  readonly images: readonly PackageImage[];
}

export interface PackagePage {
  readonly role: string;
  readonly title?: string | undefined;
  readonly referenceType?: string | undefined;
  readonly specialistTag?: string | undefined;
  readonly scope?: string | undefined;
  readonly markdown?: string | undefined;
  readonly dependencies?: readonly string[] | undefined;
  readonly related?: readonly string[] | undefined;
  readonly images?: readonly PackageImage[] | undefined;
  /**
   * v3 F7d (ADR 0077, A8, A9): more sidebar rows for the Art page (the identity copies, Temporal Scope, Visual State /
   * Period), written only where its template has the row.
   */
  readonly extraFacts?: readonly { readonly key: string; readonly value: string }[] | undefined;
  readonly with?: string | undefined;
  readonly label?: string | undefined;
  readonly host?: 'self' | 'other' | undefined;
}

/** A package, as the tools hand it to the engine (each tool's schema maps its input onto this). */
export interface PackageInput {
  readonly name: string;
  readonly depth?: string | undefined;
  readonly status?: 'working' | 'authoritative' | undefined;
  readonly identity: Readonly<Record<string, IdentityValue | undefined>>;
  readonly pages: readonly PackagePage[];
  readonly index?: { readonly markdown: string } | undefined;
  readonly target?: string | undefined;
  readonly upgradeToCore?: boolean | undefined;
  /** v3 F7 (ADR 0070, G2): where the Art page's images go, as the bridge decided (none: design pieces). */
  readonly imagePlacement?: ImagePlacement | undefined;
  /**
   * v3 F7d (ADR 0077, A1 to A3): the Art page's images in groups, each with its own placement (the design pieces, then
   * each outfit in the order given); instead of the art page's `images` and `imagePlacement`.
   */
  readonly imageGroups?: readonly ArtImageGroup[] | undefined;
  /**
   * With upgradeToCore: warn about the Reference's sections a new page now owns (default true). A split (F3e) moves those
   * sections itself, each leaving an interface summary, so it passes false (and the Reference is not read for it).
   */
  readonly upgradeOverlap?: boolean | undefined;
  /** v3 F7.1 (ADR 0072): the upgraded page's main document as the caller already read it (the split); else read live. */
  readonly upgradeText?: { readonly documentId: string; readonly blocks: readonly LkBlock[] } | undefined;
  readonly split?: unknown;
  /**
   * v3 F3b (ADR 0052): the names a relationship's page takes for its two participants, exactly as their indexes give
   * them (arkona_create_relationship); by default the target's Canonical Display Name and the partner's subject.
   */
  readonly names?:
    { readonly subject?: string | undefined; readonly partner?: string | undefined } | undefined;
}

/** A character found by name, alias, Canonical Display Name or id (an index, a Core or a Compact Reference). */
export interface CharacterHit {
  readonly identity: NodeRef;
  readonly role: string;
  readonly via: string;
  readonly node: TreeNode;
  readonly subject: string;
  readonly race: string | null;
}

/** v3 F3b: the characters a query names (each once, by its identity page), as the character tool finds them. */
export function findCharacters(ctx: RepoCtx, q: string): { subjects: CharacterHit[] } {
  const r = ctx.types.resolve(q, {});
  const nodes: TreeNode[] =
    r.status === 'resolved'
      ? [ctx.tree.node(ctx.projectId, r.node.id).data!].filter(Boolean)
      : r.status === 'ambiguous'
        ? r.candidates.map((c) => ctx.tree.node(ctx.projectId, c.id).data!).filter(Boolean)
        : [];
  const subjects = new Map<string, CharacterHit>();
  for (const n of nodes) {
    const c = ctx.types.characterOfPage(n.id);
    if (c.ok) {
      const id = c.value.core.id;
      if (!subjects.has(id))
        subjects.set(id, {
          identity: c.value.core,
          role: c.value.role,
          via: c.value.via,
          node: n,
          subject: c.value.subject,
          race: c.value.race,
        });
    }
  }
  return { subjects: [...subjects.values()] };
}

export interface Issue {
  readonly code: string;
  readonly message: string;
  readonly page?: string;
  readonly [k: string]: unknown;
}

// ============================================================================================ the plan

export interface PlannedImage {
  readonly stagedId: string;
  readonly row: ImageUploadRow;
  readonly label: string;
  readonly interpretation: string;
  /** The asset's display name (`{Subject} - {Label}`). */
  readonly name: string;
  /** The folder path in the asset library, and what must be created. */
  readonly path: readonly string[];
  readonly folderId: string | null;
  readonly creates: readonly { readonly name: string; readonly parentFolderId: string | null }[];
  /** The string the Art page's image block carries until the job binds the asset's address. */
  readonly placeholder: string;
  readonly subfolder: string | null;
  /**
   * v3 F3b (ADR 0052; design section 6): the image's own pending placement proposal (upload_image's at scope
   * `propose`), which the package takes over: withdrawn, "superseded by package prop_…", when the package is proposed.
   */
  readonly takeover?: string | null;
  /** v3 F7c (ADR 0075): an archive entry not staged yet (planned from its header; the job binds and waits). */
  readonly pending?: PendingArchiveImage;
}

export interface PlannedPage extends NewPage {
  readonly role: string;
  readonly rule: RoleRule;
  readonly templateRole: string;
  readonly subject: string;
  readonly referenceType: string | null;
  readonly scope: string | null;
  readonly factValues: readonly { readonly key: string; readonly value: string }[];
  readonly gatedKeys: readonly string[];
  readonly templateKeys: readonly string[] | null;
  readonly linkTargets: readonly { readonly title: string; readonly targets: readonly LinkTarget[] }[];
  readonly markdown: string | null;
  readonly blocks: LkBlock[] | null;
  /** The body is written with the filler (a template copy), keeping what Markdown cannot express there. */
  readonly drafted: boolean;
  readonly images: readonly PlannedImage[];
  /** For the preview: where its body's headings are. */
  readonly headings: readonly string[];
  /**
   * v3 F7d (ADR 0077, A3, A4): the headings a groups call made on a new Art page (Wardrobe, each outfit's, Reference
   * Images), each with the image blocks it was made for: the filler leaves one out when none of them is left.
   */
  readonly prune?: readonly { readonly id: string; readonly needs: readonly string[] }[];
  /** v3 F3b (ADR 0052): what the proposal says of this page besides its facts (a named step, a home override). */
  readonly notes?: readonly string[];
}

/**
 * v3 F3b (ADR 0052): one of the job's run-time re-checks under an existing parent: none of `names` (exact display
 * names) and no name starting with one of `prefixes` may have appeared there since the plan; `code` is the refusal.
 */
export interface AbsentUnder {
  readonly parentId: string;
  readonly names: readonly string[];
  readonly prefixes?: readonly string[];
  readonly code?: string;
}

/** v3 F3b: an existing page the job moves or relies on, still where the plan saw it when the job runs. */
export interface PresentCheck {
  readonly resourceId: string;
  readonly parentId: string;
  readonly name: string;
  readonly code: string;
}

/** A change to a page that exists (an extension). */
export type ExistingChange =
  | {
      readonly kind: 'move';
      readonly page: NodeRef;
      readonly to: { readonly item: string };
      readonly toName: string;
      readonly name: string;
    }
  | {
      readonly kind: 'rename';
      readonly page: NodeRef;
      readonly from: string;
      readonly to: string;
      readonly coreTemplateId: string;
      /** v3 F7.1 (ADR 0072): the Compact template it had (recorded, so a revert puts it back). */
      readonly compactTemplateId?: string | null;
      /** v3 F7.1: why, when the planner upgraded it on its own (the character now has an index and several owners). */
      readonly automatic?: boolean;
    }
  | {
      /**
       * v3 F7.1 (ADR 0072): the upgrade's text change on the upgraded page (`role` core) or on the character's Art page
       * (`role` art), applied by the `pack.core_text` filler inside the job's lock on the page as it is then: the wording
       * rules on the named blocks, the named image blocks removed while they still show the planned file, and (on the
       * Art page) the Core's images it lacked appended under its images section. The Art page's change runs first.
       */
      readonly kind: 'core_text';
      readonly page: NodeRef;
      readonly documentId: string;
      readonly role: 'core' | 'art';
      readonly subject: string;
      /** Amendment 1 to ADR 0072: the names the self-reference test used (the filler applies the same ones). */
      readonly names?: readonly string[];
      readonly others?: readonly string[];
      readonly replacements: readonly CoreReplacement[];
      readonly remove: readonly { readonly blockId: string; readonly url: string }[];
      /** Art page: the moved images (label, image, interpretation), appended under `section`. */
      readonly append: readonly LkBlock[];
      readonly section: string;
      readonly boundaries: readonly string[];
      /** Core: the Art page (an existing page's id, or the new one's) its moved images go to first. */
      readonly needs?: string;
    }
  | {
      readonly kind: 'facts';
      readonly page: NodeRef;
      readonly sidebar: readonly SidebarProperty[];
      readonly plan: FactsPlan;
      readonly why: readonly string[];
      /** A substantial change (its Last Major Revision is set): not for a link alone. */
      readonly substantial: boolean;
      /**
       * v3 F7d (ADR 0077, A4, A8): the Art page's sidebar in a groups call: run after the images, the page's text and the
       * outfit records, and withdrawn (with why) rather than failing the job when it cannot be written.
       */
      readonly late?: boolean;
      /** v3 F7d (A8): the identity page whose values it copies: its rows must still be as planned inside the job. */
      readonly identityCheck?: {
        readonly page: NodeRef;
        readonly propertyId: string;
        readonly rows: readonly SidebarRow[];
      };
    }
  | {
      readonly kind: 'routing';
      readonly page: NodeRef;
      readonly documentId: string;
      readonly version: string;
      readonly blocks: readonly LkBlock[];
      /** The document's blocks with the lines appended (what is sent, with the version read as If-Match). */
      readonly planned: readonly LkBlock[];
      readonly lines: readonly string[];
      readonly markdown: string;
      readonly sectionHash: string;
      readonly section: string;
      /**
       * v3 F3d (ADR 0053): `replace_section` when an existing line is rewritten (the Polities index's line for a nation
       * `promoteNation` indexes now points to the new index); absent, the lines are appended (F3a).
       */
      readonly mode?: 'append_to_section' | 'replace_section';
      /** v3 F3d: what the change does, in words, for the preview, the step's label and the proposal. */
      readonly what?: string;
    }
  | {
      /**
       * v3 F3b (ADR 0052; design section 3): new images on an EXISTING Art page, appended under its images section
       * (made before the boundary sections when it has none) by the `pack.art_append` filler inside the job's lock, on
       * the document as it is then (nothing else on the page is touched; `unsupported` blocks are kept).
       */
      readonly kind: 'images';
      readonly page: NodeRef;
      readonly documentId: string;
      /** Per image: its label (level 3), the image block (its address bound in the job), its interpretation. */
      readonly blocks: readonly LkBlock[];
      readonly section: string;
      readonly boundaries: readonly string[];
      readonly images: readonly PlannedImage[];
      /**
       * v3 F7 (ADR 0070, G5): outfit pieces: placed under a heading naming the outfit (or an alias) anywhere on the page,
       * else a new one under the page's first heading holding "Wardrobe", else in a new "Wardrobe" section.
       */
      readonly outfit?: { readonly name: string; readonly aliases: readonly string[] };
      /**
       * v3 F7d (ADR 0077, A4): a groups call's ONE write: each group's blocks (by id) under its own place, in the order
       * the groups were given (the `pack.art_groups` filler); `blocks` is every group's blocks together.
       */
      readonly groups?: readonly ArtBlockGroup[];
    };

/** v3 F7d (ADR 0077, A4): one group's blocks on the Art page (design pieces: `section`; an outfit: `outfit`). */
export interface ArtBlockGroup {
  readonly key: string;
  readonly section: string;
  readonly outfit?: { readonly name: string; readonly aliases: readonly string[] };
  readonly blockIds: readonly string[];
}

/** v3 F7 (ADR 0070, G5): the section an Art page's outfits go under when it has no heading holding "Wardrobe". */
export const WARDROBE_SECTION = 'Wardrobe';

/** v3 F7 (ADR 0070, G2, G3): what an art job does besides the images: the moves and the outfit record. */
export interface ArtPlan {
  readonly characterName: string;
  /** The character's folder (null: the job makes it, with the first image's folders). */
  readonly characterFolderId: string | null;
  readonly outfit: {
    readonly name: string;
    readonly aliases: readonly string[];
    readonly into: 'wardrobe' | 'folder';
    /** The outfit's folder when it exists now (null: loose, or made by the job). */
    readonly folderId: string | null;
    readonly moves: readonly {
      readonly assetId: string;
      readonly name: string;
      readonly fromFolderId: string | null;
      readonly fromPath: string | null;
      readonly url?: string;
    }[];
    readonly toPath: string;
    /**
     * v3 F7 (G5): the lines on the character's pages (every page under its index, read live when planned) naming a
     * moved piece by id or name: they may state its location, so they are listed for the owner, never edited.
     */
    readonly linesForOwner?: readonly ArtLine[];
  } | null;
  /**
   * v3 F7d (ADR 0077): a groups call: every outfit of the call (its moves and record, as `outfit` for one), each with its
   * group's key; and each image's group (by staged id). `outfit` is then null.
   */
  readonly outfits?: readonly (NonNullable<ArtPlan['outfit']> & { readonly key: string })[];
  readonly groupOf?: Readonly<Record<string, string>>;
  /**
   * v3 F7d (ADR 0077, A8): the identity page whose values a NEW Art page copies, its key-value rows as read when planned:
   * checked inside the job before anything is written.
   */
  readonly identityCheck?: {
    readonly page: NodeRef;
    readonly propertyId: string;
    readonly rows: readonly SidebarRow[];
  };
  /** v3 F7d (A4): the groups, for the job's per-group report (what was placed and what was not). */
  readonly report?: readonly ArtGroupReport[];
}

/** v3 F7d (ADR 0077, A4): one group, as the job's report names it. */
export interface ArtGroupReport {
  readonly key: string;
  readonly label: string;
  readonly images: readonly { readonly stagedId: string; readonly name: string }[];
  readonly moves: readonly { readonly assetId: string; readonly name: string }[];
}

/** v3 F7 (G5): a line on one of a character's pages, for the owner. */
export interface ArtLine {
  readonly pageId: string;
  readonly page: string;
  readonly documentId: string;
  readonly blockId: string;
  readonly text: string;
}

export interface PackPlan {
  readonly pack: Pack;
  readonly type: TypeRules;
  readonly mode: 'new' | 'extend';
  readonly subject: string;
  readonly status: 'working' | 'authoritative';
  readonly pages: PlannedPage[];
  readonly existing: ExistingChange[];
  readonly images: PlannedImage[];
  readonly refusals: Issue[];
  readonly warnings: Issue[];
  readonly replacements: Replacement[];
  readonly held: HeldSlot[];
  readonly governance: GovernanceStatus;
  /** A new subject: the name its job reserves, and where it checks again (live) that nothing appeared meanwhile. */
  readonly absent: {
    readonly reservation: string | null;
    readonly under: readonly AbsentUnder[];
    /** v3 F3b: more names the job reserves (a nation index, a relationship's pair). */
    readonly reservations?: readonly string[];
    /** v3 F3b: existing pages that must still be where the plan saw them (a Reference promoteNation moves). */
    readonly present?: readonly PresentCheck[];
    /** v3 F3b: what kind of package it is (`owner`, `relationship`): the character-only checks are skipped. */
    readonly kind?: 'character' | 'owner' | 'relationship' | 'art';
    /** v3 F3b: staged images whose placement the job takes on (still staged and placed by nothing else). */
    readonly images?: readonly string[];
  };
  readonly target: {
    readonly identity: NodeRef;
    readonly index: NodeRef | null;
    readonly role: string;
  } | null;
  readonly notes: string[];
  /** v3 F3b (ADR 0052): more of the preview (an owner's home and nation, a relationship's pair, an art page). */
  readonly extra?: Readonly<Record<string, unknown>>;
  /** v3 F3b: why the package needs the owner's canonical approval besides an Authoritative page (a move of one). */
  readonly canonical?: { readonly reason: string };
  /** v3 F3b: added to the proposal's one-line summary (a home override's reason). */
  readonly summaryNote?: string;
  /** v3 F3b: staged images whose own pending placement proposal the package takes over (design section 6). */
  readonly takeovers?: readonly { readonly stagedId: string; readonly proposalId: string }[];
  /** v3 F7 (ADR 0070): a guided art call's moves and outfit record (arkona_add_character_art). */
  readonly art?: ArtPlan;
  /**
   * v3 F3b (design 1.1a): a character navigation index the package makes, recorded in the Character taxonomy when the
   * job runs, so the character tool can place a character of that race.
   */
  readonly taxonomy?: readonly {
    readonly resourceId: string;
    readonly plural: string;
    readonly parentNodeId: string;
  }[];
}

export interface PlanEnv {
  readonly pd: ProjectDeps;
  readonly mctx: McpToolContext;
  readonly ctx: RepoCtx;
  readonly cc: CreateCtx;
  readonly tool: string;
  readonly pack: Pack;
  readonly type: TypeRules;
  readonly hook: TypeHook;
  readonly templates: Readonly<Record<string, string | null>>;
  readonly lifecycle: LifecycleConfig;
  readonly governance: GovernanceStatus;
  /** Today (Europe/London) for the preview; the job dates Last Major Revision when it runs. */
  readonly today: string;
  /**
   * Whether the project's switch for setting-pack tools (`lmrPackTools`, v3 F2; on by default) lets the Last Major
   * Revision rule date the EXISTING pages a package changes. Pages the package creates always get it.
   */
  readonly lmrOnChanges: boolean;
  /**
   * v3 F3b with ADR 0051 (ADR 0052 decision 14): the project's Last Major Revision configuration (the row's key, the
   * switches, the housekeeping keys) and the caller's `lastMajorRevision` (`auto` when absent), which decide for the
   * EXISTING pages a package changes (src/packs/engine/lmr.ts). Absent: the project's defaults, `auto`.
   */
  readonly lmr?: { readonly config: LmrConfig; readonly mode: LmrMode };
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The value of an identity field, and its reason when it is the deliberate gap. */
export function identityOf(v: IdentityValue | undefined): { value: string | null; reason: string | null } {
  if (v === undefined) return { value: null, reason: null };
  if (typeof v === 'string') return { value: v.trim() === '' ? '' : v.trim(), reason: null };
  return { value: v.value.trim(), reason: v.reason?.trim() || null };
}

const fill = (pattern: string, vars: Readonly<Record<string, string>>) =>
  pattern.replace(/\{(Name|Title|A|B|Label|Subject)\}/g, (_m, k: string) => vars[k] ?? '');

/** The template's PROPERTIES keys in order (null when it has no such property, or several). */
export function keysOf(sidebar: readonly SidebarProperty[], title: string): string[] | null {
  const kv = sidebar.filter((p) => p.kind === 'keyValue' && factKey(p.title) === factKey(title));
  return kv.length === 1 ? (kv[0]!.rows ?? []).map((r) => r.key) : null;
}

/** The value of a row of a live sidebar, as plain text (null when the page has no such row). */
export function rowValue(sidebar: readonly SidebarProperty[], title: string, key: string): string | null {
  const kv = sidebar.find((p) => p.kind === 'keyValue' && factKey(p.title) === factKey(title));
  const row = kv?.rows?.find((r) => factKey(r.key) === factKey(key));
  if (!row) return null;
  return row.content
    .map((r) => (typeof r.text === 'string' ? r.text : ''))
    .join('')
    .trim();
}

// ============================================================================================ planning

export async function planPackage(env: PlanEnv, input: PackageInput): Promise<PackPlan> {
  const { pd, ctx, type, pack, hook } = env;
  const rules = pack.rules;
  const refusals: Issue[] = [];
  const warnings: Issue[] = [];
  const replacements: Replacement[] = [];
  const held: HeldSlot[] = [];
  const notes: string[] = [];
  const pages: PlannedPage[] = [];
  const existing: ExistingChange[] = [];
  const images: PlannedImage[] = [];
  const refuse = (code: string, message: string, more: Obj = {}) => refusals.push({ code, message, ...more });
  const warn = (code: string, message: string, more: Obj = {}) => warnings.push({ code, message, ...more });
  const roleRule = (role: string) => type.roles.find((r) => r.role === role);
  const tagsCurrent = env.governance.state === 'current';

  // ---------------------------------------------------------------------------------- the text rules, on every input
  const name = replaceDashes(
    cleanPrefixes(input.name).name.replace(/\s+/g, ' ').trim(),
    input.name,
    'name',
    replacements,
  );
  if (name === '' || name.length > 200) refuse('INVALID_NAME', 'The name (1 to 200 characters) is required.');
  const pkgPages = input.pages.map((p, i) => {
    const where = `${p.role}${p.title ? ` “${p.title}”` : ''} (pages[${i}])`;
    return {
      ...p,
      where,
      title: p.title !== undefined ? replaceDashes(p.title.trim(), where, 'title', replacements) : undefined,
      label: p.label !== undefined ? replaceDashes(p.label.trim(), where, 'label', replacements) : undefined,
      // CR-2026-11-R2 (R2-37): the Scope is one line (line breaks collapsed), in its row and in a routing line.
      scope:
        p.scope !== undefined ? replaceDashes(oneLine(p.scope), where, 'Scope', replacements) : undefined,
      referenceType:
        p.referenceType !== undefined
          ? replaceDashes(p.referenceType.trim(), where, 'Reference Type', replacements)
          : undefined,
      markdown:
        p.markdown !== undefined ? replaceDashesInMarkdown(p.markdown, where, replacements) : undefined,
      images: p.images?.map((im, j) => ({
        ...im,
        label: replaceDashes(im.label.trim(), `${where} images[${j}]`, 'label', replacements),
        interpretation: replaceDashesInMarkdown(
          (im.interpretation ?? '').trim(),
          `${where} images[${j}]`,
          replacements,
        ),
      })),
    };
  });
  const indexMarkdown =
    input.index?.markdown !== undefined
      ? replaceDashesInMarkdown(input.index.markdown, 'index', replacements)
      : undefined;
  const identity: Record<string, { value: string | null; reason: string | null }> = {};
  for (const f of type.identity) {
    const v = identityOf(input.identity[f.field]);
    identity[f.field] = {
      value: v.value === null ? null : replaceDashes(v.value, 'identity', f.key, replacements),
      reason: v.reason,
    };
  }
  for (const k of Object.keys(input.identity)) {
    if (!type.identity.some((f) => f.field === k))
      refuse(
        'UNKNOWN_IDENTITY_FIELD',
        `identity.${k} is not a ${type.name} identity field (${type.identity.map((f) => f.field).join(', ')}).`,
      );
  }
  if (input.split !== undefined) {
    // v3 F3e (ADR 0059): steered to the split tools, as F3d.1 steers renames.
    refuse(
      'USE_ARKONA_SPLIT',
      'Splitting an existing page into owners moves established material: it is arkona_split_owner’s (appraise first with arkona_split_appraisal, bring it to the owner, then split with a destination map). This tool only adds new pages.',
      { useTool: 'arkona_split_owner' },
    );
  }

  // ---------------------------------------------------------------------------------- the roles
  for (const p of pkgPages) {
    const r = roleRule(p.role);
    if (!r || r.role === type.index.role) {
      refuse(
        'UNKNOWN_ROLE',
        `${p.where}: “${p.role}” is not a page role of ${type.name} (${type.roles
          .filter((x) => x.role !== type.index.role)
          .map((x) => x.role)
          .join(', ')}); the index's text goes in \`index\`.`,
      );
    }
  }
  for (const r of type.roles) {
    const n = pkgPages.filter((p) => p.role === r.role).length;
    if (n > r.max)
      refuse(
        'TOO_MANY_PAGES',
        `At most ${r.max} ${r.role} page${r.max === 1 ? '' : 's'} in one package (${n} given).`,
      );
  }

  // ---------------------------------------------------------------------------------- the subject
  const statusOverride = input.status;
  let mode: 'new' | 'extend' = 'new';
  let subject = name;
  let status: 'working' | 'authoritative' = statusOverride ?? 'working';
  let target: PackPlan['target'] = null;
  let targetSidebar: SidebarProperty[] | null = null;
  let targetIndexNode: TreeNode | null = null;
  let targetIdentityNode: TreeNode | null = null;
  let targetRace: string | null = null;
  let standing: {
    status: string | null;
    continuityType: string | null;
    continuity: string | null;
    inheritance: string | null;
  } = {
    status: null,
    continuityType: null,
    continuity: null,
    inheritance: null,
  };
  const props = rules.sidebar.property;
  /** v3 F4a: the characters CHARACTER_EXISTS names (its refusal says so; they are not repeated as namesakes). */
  const existingIds = new Set<string>();

  const characterCandidates = (q: string) => findCharacters(ctx, q);

  if (input.target !== undefined) {
    mode = 'extend';
    const q = cleanPrefixes(input.target).name.trim();
    const found = characterCandidates(q);
    if (found.subjects.length === 0) {
      refuse(
        'TARGET_NOT_FOUND',
        `No ${type.name.toLowerCase()} matches target “${input.target}” (by id, name, alias or Canonical Display Name; an index, Core or Compact Reference). Check the name with search, or leave target out to create a new ${type.name.toLowerCase()}.`,
      );
    } else if (found.subjects.length > 1) {
      refuse(
        'TARGET_AMBIGUOUS',
        `target “${input.target}” names ${found.subjects.length} ${type.name.toLowerCase()}s; pass the id (or exact name) of the one you mean.`,
        {
          candidates: found.subjects.map((s) => ({
            id: s.identity.id,
            name: s.identity.rawName,
            role: s.role === 'core' ? 'Character Core' : 'Character Reference',
            path: s.identity.path,
          })),
        },
      );
    } else {
      const s = found.subjects[0]!;
      targetIdentityNode = ctx.tree.node(ctx.projectId, s.identity.id).data;
      const parent = targetIdentityNode?.parentId
        ? ctx.tree.node(ctx.projectId, targetIdentityNode.parentId).data
        : null;
      const subjectName = s.subject || subjectOf(s.identity.displayName, null);
      targetRace = s.race;
      targetIndexNode =
        parent && parent.kind === 'index' && nameKey(parent.displayName) === nameKey(subjectName)
          ? parent
          : null;
      target = {
        identity: s.identity,
        index: targetIndexNode ? ctx.types.resolveOne(targetIndexNode.id) : null,
        role: s.role,
      };
      const read = await liveRead(pd, env.mctx, env.tool, 'getResource', {
        path: { resourceId: s.identity.id },
      });
      if (!read.ok) refuse('TARGET_UNREADABLE', `The target ${s.identity.rawName} could not be read now.`);
      else targetSidebar = sidebarFrom(read.value);
      if (targetSidebar) {
        const f = env.lifecycle.fields;
        standing = {
          status: rowValue(targetSidebar, props, f.status),
          continuityType: rowValue(targetSidebar, props, f.continuityType),
          continuity: rowValue(targetSidebar, props, 'Continuity'),
          inheritance: rowValue(targetSidebar, props, 'Inheritance'),
        };
        subject =
          input.names?.subject || rowValue(targetSidebar, props, 'Canonical Display Name') || subjectName;
        targetRace = rowValue(targetSidebar, props, 'Race / Species') ?? targetRace;
      } else subject = input.names?.subject || subjectName;
      const kind = targetIdentityNode?.kind;
      if (kind === 'barc' || standing.status === env.lifecycle.status.archived) {
        refuse(
          'TARGET_ARCHIVED',
          `${s.identity.rawName} is Archived. New pages are never added to an archived ${type.name.toLowerCase()}: unarchive it first (unarchive_page, the owner's approval), then try again.`,
        );
      }
      if (statusOverride === undefined) status = kind === 'bwrk' ? 'working' : 'authoritative';
    }
  } else if (name !== '') {
    const found = characterCandidates(name);
    for (const s of found.subjects) existingIds.add(s.identity.id);
    if (found.subjects.length > 0) {
      refuse(
        'CHARACTER_EXISTS',
        `A ${type.name.toLowerCase()} named “${name}” exists (${found.subjects
          .map((s) => `${s.identity.rawName}: ${s.identity.path}`)
          .join(
            '; ',
          )}). To add pages to it, call again with target set to its name or id (never a second set of pages for one ${type.name.toLowerCase()}).`,
        {
          candidates: found.subjects.map((s) => ({
            id: s.identity.id,
            name: s.identity.rawName,
            role: s.role === 'core' ? 'Character Core' : 'Character Reference',
          })),
          hint: 'Pass target with the existing character’s name or id.',
        },
      );
    }
  }

  // ---------------------------------------------------------------------------------- the gate
  const gated = type.identity.filter((f) => f.gated);
  const unestablishedKey = textKey(type.unestablished);
  const unestablished: { key: string; reason: string }[] = [];
  if (mode === 'new') {
    const missing: string[] = [];
    for (const f of gated) {
      const v = identity[f.field]!;
      if (v.value === null || v.value === '' || isPlaceholder(v.value, type.placeholders)) {
        missing.push(f.key);
        continue;
      }
      if (textKey(v.value) === unestablishedKey) {
        if (!v.reason)
          refuse(
            'UNESTABLISHED_NEEDS_REASON',
            `identity.${f.field} is “${type.unestablished}” with no reason. ${type.unestablished} is a deliberate, stated outcome: give { "value": "${type.unestablished}", "reason": "…" } (the reason goes into ${type.text.unresolved}), or ask the owner for the value.`,
            { field: f.field, key: f.key },
          );
        else unestablished.push({ key: f.key, reason: v.reason });
      }
    }
    if (missing.length > 0) {
      refuse(
        'IDENTITY_INCOMPLETE',
        `Missing or blank: ${missing.join(', ')}. Arkona's completion gate requires every one on the ${type.name}'s identity page. Do not guess them: ask the owner, then call again with their values (or "${type.unestablished}" with a reason, when the owner says it is deliberately left open).`,
        { fields: missing, hint: 'Ask the owner for these values; never invent them.' },
      );
    }
  } else if (targetSidebar) {
    const debt: string[] = [];
    for (const f of gated) {
      const now = rowValue(targetSidebar, props, f.key);
      if (now === null || now === '' || isPlaceholder(now, type.placeholders)) {
        const given = identity[f.field]!;
        if (given.value && !isPlaceholder(given.value, type.placeholders)) continue; // fixed in this proposal
        debt.push(f.key);
      }
    }
    if (debt.length > 0) {
      warn(
        'IDENTITY_DEBT',
        `${target!.identity.rawName} has blank gated fields: ${debt.join(', ')} (existing debt; not refused). Ask the owner for the values and fix them with set_facts, or give them in this package's identity to fix them in the same proposal.`,
        {
          fields: debt,
          suggestedSetFacts: {
            page: target!.identity.id,
            facts: Object.fromEntries(debt.map((k) => [k, '…'])),
          },
        },
      );
    }
  }

  // ---------------------------------------------------------------------------------- identity role and index
  const roles = pkgPages.map((p) => p.role);
  let identityRole: string | null = null;
  if (mode === 'new') {
    const r = hook.identityRole({ depth: input.depth, roles }, type);
    if ('refusal' in r) refuse(r.refusal.code, r.refusal.message);
    else identityRole = r.role;
    if (identityRole && !pkgPages.some((p) => p.role === identityRole)) {
      refuse(
        'IDENTITY_PAGE_REQUIRED',
        `A new ${type.name.toLowerCase()} needs its ${roleRule(identityRole)?.referenceType ?? identityRole} page (role "${identityRole}") with its text.`,
      );
    }
  } else {
    identityRole = target?.role ?? null;
    for (const p of pkgPages) {
      const r = roleRule(p.role);
      if (r && r.facts === 'identity') {
        refuse(
          'DOMAIN_EXISTS',
          `${p.where}: ${target?.identity.rawName ?? 'the target'} already has its identity page; edit it with write_page and set_facts (or upgradeToCore to make a Compact Reference a Core).`,
          { existing: target?.identity.id },
        );
      }
    }
    if (input.depth !== undefined)
      warn('DEPTH_IGNORED', '`depth` is for a new character; it is ignored with target.');
  }
  if (input.upgradeToCore === true) {
    if (mode !== 'extend' || !hook.upgrade)
      refuse(
        'UPGRADE_NEEDS_TARGET',
        'upgradeToCore works on an existing Compact Character Reference named by target.',
      );
    else if (target && target.role !== hook.upgrade.from)
      refuse(
        'UPGRADE_NOT_COMPACT',
        `${target.identity.rawName} is already a ${target.role === 'core' ? 'Character Core' : target.role}; upgradeToCore is only for a Compact Character Reference.`,
      );
  }

  // Relationship pages hosted elsewhere do not count as siblings for the index rule.
  const siblingRoles = pkgPages
    .filter(
      (p) =>
        roleRule(p.role)?.facts !== 'identity' && !(p.role === type.relationship?.role && p.host === 'other'),
    )
    .map((p) => p.role);

  // ---------------------------------------------------------------------------------- templates
  const templateId = (role: RoleRule): string | null => {
    const id = env.templates[role.template] ?? null;
    if (!id) {
      refuse(
        'PACK_TEMPLATE_UNSET',
        `The ${pack.name} pack has no ${role.template} template for this project. The owner refreshes the project's templates (Repository Mappings) and approves the pack again on the Packs page.`,
        { role: role.role, template: role.template },
      );
      return null;
    }
    const snap = ctx.types.store.templates();
    if (snap.readAt === null) {
      refuse(
        'TEMPLATES_NOT_READ',
        'The bridge has not read this project’s templates, so the pack’s template ids cannot be checked. The owner refreshes them on the Repository Mappings page.',
      );
      return null;
    }
    if (!snap.templates.some((t) => t.id === id)) {
      refuse(
        'PACK_TEMPLATE_UNKNOWN',
        `The ${pack.name} pack's ${role.template} template (${id}) is not one of this project's templates as last read. The owner checks the pack on the Packs page.`,
        { role: role.role, templateId: id },
      );
      return null;
    }
    return id;
  };
  const templateName = (id: string) =>
    ctx.types.store.templates().templates.find((t) => t.id === id)?.name ?? id;

  // ---------------------------------------------------------------------------------- placement
  let home: TreeNode | null = null;
  let raceIndex: TreeNode | null = null;
  let raceFallback = false;
  const raceValue = identity['race']?.value ?? null;
  const working = status === 'working';
  const wi = env.lifecycle.workingIndexId
    ? ctx.tree.node(ctx.projectId, env.lifecycle.workingIndexId).data
    : null;
  if (working && (!wi || wi.kind !== 'index')) {
    refuse(
      'LIFECYCLE_NOT_CONFIGURED',
      'Working pages go under [INDEX] Working, which the owner has not confirmed (Projects page, Lifecycle). Ask the owner, or use status "authoritative".',
    );
  }
  const placement = type.placement;
  if (mode === 'new') {
    if (placement.kind === 'taxonomy') {
      try {
        const r = ctx.types.raceIndex(
          raceValue && textKey(raceValue) !== unestablishedKey ? raceValue : null,
          placement.registryType,
        );
        raceIndex = ctx.tree.node(ctx.projectId, r.node.id).data;
        if (r.unknown && raceValue && textKey(raceValue) !== unestablishedKey) raceFallback = true;
      } catch (e) {
        if (e instanceof RegistryError && e.code === 'RACE_NOT_FOUND') {
          raceFallback = true;
          try {
            const r = ctx.types.raceIndex(null, placement.registryType);
            raceIndex = ctx.tree.node(ctx.projectId, r.node.id).data;
          } catch (e2) {
            if (e2 instanceof RegistryError) refuse(e2.code, e2.message, e2.details);
            else throw e2;
          }
        } else if (e instanceof RegistryError) refuse(e.code, e.message, e.details);
        else throw e;
      }
      if (raceFallback) {
        warn(
          'RACE_FALLBACK',
          `The race “${raceValue}” matches no race index of ${placement.registryType}, so the ${type.name.toLowerCase()} goes under [INDEX] ${placement.fallbackIndex}. Race / Species is written as given; the owner moves it when its race index exists.`,
        );
      }
    } else {
      const r = ctx.types.resolve(placement.index, { kinds: ['index'] });
      if (r.status === 'resolved') raceIndex = ctx.tree.node(ctx.projectId, r.node.id).data;
      else
        refuse(
          'PLACEMENT_INDEX_NOT_FOUND',
          `The ${type.name} index “${placement.index}” is not one index in the repository.`,
        );
    }
    home = working ? wi : raceIndex;
  }

  // ---------------------------------------------------------------------------------- pages
  const statusFacts = (s: 'working' | 'authoritative') => statusValue(env.lifecycle, s);
  const linkTitle = { dependencies: rules.sidebar.dependencies, related: rules.sidebar.related };
  // A new set's index (or an existing one); a new index for an extension of a Compact Reference with no index.
  let indexPage: PlannedPage | null = null;
  let indexParent: { existing: string } | { item: string } | null = null;
  let movedReference: NodeRef | null = null;
  const wantIndexNew =
    mode === 'new' && identityRole !== null && hook.wantsIndex(identityRole, siblingRoles, type);
  const prefix = working ? '[BWRK] ' : '[BSRC] ';
  const pageKind = working ? 'bwrk' : 'bsrc';

  // Where an extension's new pages go.
  let extensionParent: { existing: string } | { item: string } | null = null;
  if (mode === 'extend' && target) {
    if (statusOverride === 'working' && targetIdentityNode?.kind !== 'bwrk') {
      // Drafts for a canon character: [BWRK] pages flat under [INDEX] Working, promoted later with destination.
      if (wi) extensionParent = { existing: wi.id };
      notes.push(
        `New pages are drafted as [BWRK] directly under [INDEX] Working; promote each with promote_page (destination: ${target.index?.rawName ?? target.identity.rawName}'s place) when ready.`,
      );
    } else if (targetIndexNode) {
      extensionParent = { existing: targetIndexNode.id };
    } else if (siblingRoles.length > 0 && targetIdentityNode) {
      // The Kamigawa Miyuki pattern: an [INDEX] made in the Reference's place, the Reference moved under it.
      const parentId = targetIdentityNode.parentId;
      if (!parentId) refuse('TARGET_HAS_NO_PARENT', `${target.identity.rawName} has no parent.`);
      else indexParent = { existing: parentId };
      movedReference = target.identity;
      extensionParent = { item: 'index' };
    }
  }

  const indexRule = roleRule(type.index.role)!;
  if ((wantIndexNew || (mode === 'extend' && movedReference !== null)) && (home || indexParent)) {
    const tid = templateId(indexRule);
    const indexName = fill(indexRule.name, { Name: subject });
    const raw = `[INDEX] ${indexName}`;
    const parent = indexParent ?? { existing: home!.id };
    const parentNode = 'existing' in parent ? ctx.tree.node(ctx.projectId, parent.existing).data : null;
    if (
      parentNode &&
      ctx.tree
        .children(ctx.projectId, parentNode.id)
        .data.some((c) => c.kind === 'index' && nameKey(c.displayName) === nameKey(indexName))
    ) {
      refuse(
        'CHARACTER_INDEX_EXISTS',
        `An index named “${indexName}” already exists under ${parentNode.displayName}.`,
      );
    }
    if (tid) {
      indexPage = {
        key: 'index',
        id: mintClientId(),
        rawName: raw,
        displayName: indexName,
        kind: 'index',
        parent,
        templateId: tid,
        facts: null,
        parentName: parentNode?.rawName ?? '?',
        templateName: templateName(tid),
        status: null,
        role: indexRule.role,
        rule: indexRule,
        templateRole: indexRule.template,
        subject,
        referenceType: null,
        scope: null,
        factValues: [],
        gatedKeys: [],
        templateKeys: null,
        linkTargets: [],
        markdown: null,
        blocks: null,
        drafted: true,
        images: [],
        headings: [],
      };
    }
  }

  const parentFor = (
    p: (typeof pkgPages)[number],
  ): { parent: { existing: string } | { item: string }; parentName: string } | null => {
    if (mode === 'extend') {
      if (!extensionParent) return null;
      return {
        parent: extensionParent,
        parentName:
          'item' in extensionParent
            ? (indexPage?.rawName ?? '?')
            : (ctx.tree.node(ctx.projectId, extensionParent.existing).data?.rawName ?? '?'),
      };
    }
    const r = roleRule(p.role)!;
    if (r.facts === 'identity' && !indexPage)
      return home ? { parent: { existing: home.id }, parentName: home.rawName } : null;
    if (indexPage) return { parent: { item: 'index' }, parentName: indexPage.rawName };
    return home ? { parent: { existing: home.id }, parentName: home.rawName } : null;
  };

  // The planned names first (so pages can mention and link each other).
  interface Draft {
    readonly p: (typeof pkgPages)[number];
    readonly rule: RoleRule;
    readonly id: string;
    readonly displayName: string;
    readonly rawName: string;
    partner?: { node: NodeRef; subject: string; indexId: string | null };
  }
  const drafts: Draft[] = [];
  for (const p of pkgPages) {
    const rule = roleRule(p.role);
    if (!rule || rule.role === type.index.role) continue;
    let display = '';
    let partner: Draft['partner'];
    if (type.relationship && rule.role === type.relationship.role) {
      if (!hook.relationships) refuse('RELATIONSHIPS_UNSUPPORTED', `${type.name} has no relationship pages.`);
      if (!p.with) {
        refuse(
          'RELATIONSHIP_PARTNER_REQUIRED',
          `${p.where}: a relationship needs \`with\`, the other participant.`,
        );
        continue;
      }
      const found = characterCandidates(cleanPrefixes(p.with).name.trim());
      if (found.subjects.length !== 1) {
        refuse(
          found.subjects.length === 0 ? 'RELATIONSHIP_PARTNER_NOT_FOUND' : 'RELATIONSHIP_PARTNER_AMBIGUOUS',
          found.subjects.length === 0
            ? `${p.where}: no ${type.name.toLowerCase()} matches “${p.with}”. Both participants must exist (create the other first).`
            : `${p.where}: “${p.with}” names ${found.subjects.length} ${type.name.toLowerCase()}s; pass the id of the one you mean.`,
          found.subjects.length > 1
            ? {
                candidates: found.subjects.map((s) => ({
                  id: s.identity.id,
                  name: s.identity.rawName,
                  path: s.identity.path,
                })),
              }
            : {},
        );
        continue;
      }
      const s = found.subjects[0]!;
      const pnode = ctx.tree.node(ctx.projectId, s.identity.id).data;
      const pparent = pnode?.parentId ? ctx.tree.node(ctx.projectId, pnode.parentId).data : null;
      const psubject = input.names?.partner || s.subject || subjectOf(s.identity.displayName, null);
      partner = {
        node: s.identity,
        subject: psubject,
        indexId:
          pparent && pparent.kind === 'index' && nameKey(pparent.displayName) === nameKey(psubject)
            ? pparent.id
            : null,
      };
      if (target && s.identity.id === target.identity.id) {
        refuse('RELATIONSHIP_WITH_SELF', `${p.where}: a relationship needs two different participants.`);
        continue;
      }
      display = fill(rule.name, {
        A: subject,
        B: psubject,
        Label: p.label || type.relationship.defaultLabel,
      });
    } else if (rule.role === 'specialist' || rule.name.includes('{Title}')) {
      if (!p.title) {
        refuse(
          'TITLE_REQUIRED',
          `${p.where}: a ${rule.role} page needs a title (its name is “${fill(rule.name, { Name: subject, Title: '<title>' })}”).`,
        );
        continue;
      }
      display = fill(rule.name, { Name: subject, Title: p.title });
    } else display = fill(rule.name, { Name: subject });
    const np = nameProblem(display, rules);
    if (np) refuse(np.code, np.message, { page: display });
    if (drafts.some((d) => nameKey(d.displayName) === nameKey(display)))
      refuse('DUPLICATE_PAGE', `Two pages of the package would both be named “${display}”.`);
    drafts.push({
      p,
      rule,
      id: mintClientId(),
      displayName: display,
      rawName: `${prefix}${display}`,
      ...(partner ? { partner } : {}),
    });
  }
  if (indexPage) {
    const np = nameProblem(indexPage.displayName, rules);
    if (np) refuse(np.code, np.message, { page: indexPage.rawName });
  }

  // Mentions and links can name the package's own pages, before they exist.
  const ownByName = new Map<string, { id: string; name: string }>();
  for (const d of drafts) {
    ownByName.set(nameKey(d.displayName), { id: d.id, name: d.rawName });
    ownByName.set(nameKey(d.rawName), { id: d.id, name: d.rawName });
  }
  if (indexPage) ownByName.set(nameKey(indexPage.rawName), { id: indexPage.id, name: indexPage.rawName });
  const plain = pd.services ? pageConverterContext(pd.services, ctx.projectId) : undefined;
  // v3 F7 (ADR 0070, G11): an image in a page's text must be one of the project's assets (live once for a miss).
  const base = plain
    ? await withImageCheck(
        pd.services?.assets,
        ctx.projectId,
        plain,
        input.pages.map((p) => p.markdown ?? ''),
      )
    : undefined;
  const converter: FromMarkdownContext | undefined = base
    ? {
        ...base,
        resolveMention: (n: string) => {
          const own = ownByName.get(nameKey(cleanPrefixes(n).name)) ?? ownByName.get(nameKey(n));
          if (own) return { status: 'resolved', resourceId: own.id };
          return base.resolveMention ? base.resolveMention(n) : { status: 'not_found' };
        },
      }
    : undefined;
  if (!converter) refuse('TOOL_UNAVAILABLE', 'The repository tree cannot resolve names now.');

  // Existing pages under the target's index: a page of the same name or Reference Type there is the same domain.
  if (mode === 'extend' && target) {
    const siblings = targetIndexNode ? ctx.tree.children(ctx.projectId, targetIndexNode.id).data : [];
    for (const d of drafts) {
      const same = siblings.find(
        (s) =>
          nameKey(s.displayName) === nameKey(d.displayName) ||
          (d.rule.referenceType !== null &&
            s.referenceType !== null &&
            d.rule.facts !== 'general' &&
            nameKey(s.referenceType) === nameKey(d.rule.referenceType)),
      );
      const sameRef =
        d.p.referenceType &&
        siblings.find((s) => s.referenceType && nameKey(s.referenceType) === nameKey(d.p.referenceType!));
      const hit = same ?? sameRef ?? null;
      if (hit) {
        refuse(
          'DOMAIN_EXISTS',
          `${d.displayName}: ${target.identity.rawName} already has ${hit.rawName} for that domain. This tool only adds new owners; edit the existing page with write_page.`,
          { existing: { id: hit.id, name: hit.rawName } },
        );
      }
      const flatParent = extensionParent && 'existing' in extensionParent ? extensionParent.existing : null;
      if (wi && flatParent === wi.id) {
        const flat = ctx.tree
          .children(ctx.projectId, wi.id)
          .data.find((s) => nameKey(s.displayName) === nameKey(d.displayName));
        if (flat)
          refuse('DOMAIN_EXISTS', `${d.displayName}: a Working page of that name exists (${flat.rawName}).`, {
            existing: { id: flat.id, name: flat.rawName },
          });
      }
    }
  }

  // Link targets: the package's own pages, else exactly one page of the repository.
  const resolveTarget = (
    ref: string,
    pageName: string,
    pageStatus: 'working' | 'authoritative',
  ): LinkTarget | null => {
    const own = ownByName.get(nameKey(cleanPrefixes(ref).name)) ?? ownByName.get(nameKey(ref));
    if (own) return { resourceId: own.id, name: own.name };
    const r = ctx.types.resolve(ref, {});
    if (r.status !== 'resolved') {
      refuse(
        r.status === 'ambiguous' ? 'LINK_TARGET_AMBIGUOUS' : 'LINK_TARGET_NOT_FOUND',
        r.status === 'ambiguous'
          ? `${pageName}: the link “${ref}” names ${r.candidates.length} pages; give the id of the one meant.`
          : `${pageName}: the link “${ref}” names no page of the repository.`,
        r.status === 'ambiguous'
          ? { candidates: r.candidates.map((c) => ({ id: c.id, name: c.rawName, path: c.path })) }
          : {},
      );
      return null;
    }
    const k = r.node.kind;
    const ok = pageStatus === 'authoritative' ? k === 'bsrc' : k === 'bsrc' || k === 'bwrk';
    if (!ok) {
      refuse(
        'LINK_TARGET_NOT_CURRENT',
        pageStatus === 'authoritative'
          ? `${pageName}: “${r.node.rawName}” is ${k === 'bwrk' ? 'a Working' : k === 'barc' ? 'an Archived' : 'not a [BSRC]'} page; a CANON page links only current [BSRC] pages.`
          : `${pageName}: “${r.node.rawName}” is ${k === 'barc' ? 'an Archived page' : 'not a page'}; links go to current pages.`,
        { target: { id: r.node.id, name: r.node.rawName, kind: k } },
      );
      return null;
    }
    return { resourceId: r.node.id, name: r.node.rawName };
  };

  // The identity values every identity page gets, in the sidebar's words.
  const identityFacts = (): { key: string; value: string }[] => {
    const out: { key: string; value: string }[] = [];
    for (const f of type.identity) {
      const v = identity[f.field]!.value;
      if (f.field === 'subject') out.push({ key: f.key, value: v || subject });
      else if (f.field === 'canonicalDisplayName') out.push({ key: f.key, value: v || subject });
      else if (f.field === 'supersedes') out.push({ key: f.key, value: v || 'None' });
      else if (v) out.push({ key: f.key, value: v });
    }
    return out;
  };

  const pageStatus: 'working' | 'authoritative' = status;
  const continuityType =
    mode === 'extend' && standing.continuityType
      ? standing.continuityType
      : (type.fixedFacts['Continuity Type'] ?? null);
  const continuity =
    mode === 'extend' && standing.continuity ? standing.continuity : (type.fixedFacts['Continuity'] ?? null);
  const inheritance =
    mode === 'extend' && standing.inheritance
      ? standing.inheritance
      : (type.fixedFacts['Inheritance'] ?? null);

  for (const d of drafts) {
    const { p, rule } = d;
    const tid = templateId(rule);
    const placed = parentFor(p);
    if (!placed) {
      if (mode === 'extend' && target && !extensionParent) {
        refuse(
          'NO_PLACE_FOR_PAGES',
          `${d.displayName}: ${target.identity.rawName} has no index and this package brings nothing that needs one.`,
        );
      }
      continue;
    }
    // A relationship hosted under the other participant.
    let parent = placed.parent;
    let parentName = placed.parentName;
    if (d.partner && p.host === 'other') {
      if (working) {
        refuse(
          'HOST_NOT_WORKING',
          `${d.displayName}: a Working relationship is hosted under its own character's Working index (host "self"); the other participant is not in the Working area.`,
        );
      } else if (!d.partner.indexId) {
        refuse(
          'HOST_HAS_NO_INDEX',
          `${d.displayName}: ${d.partner.node.rawName} has no index to host the relationship; host it under this character (host "self").`,
        );
      } else {
        parent = { existing: d.partner.indexId };
        parentName = ctx.tree.node(ctx.projectId, d.partner.indexId).data?.rawName ?? '?';
      }
    }
    // Reference Type: the role's, or the package's (suggested from the title for a specialist page).
    let referenceType: string | null = rule.referenceType;
    if (referenceType === null) {
      const words = textKey(p.title ?? '');
      const suggestions = [
        ...new Set(
          Object.entries(type.suggestedReferenceTypes)
            .filter(([w]) => words.includes(textKey(w)))
            .map(([, v]) => v),
        ),
      ];
      if (p.referenceType) {
        referenceType = p.referenceType;
        if (suggestions.length > 0 && !suggestions.some((s) => textKey(s) === textKey(p.referenceType!)))
          warn(
            'REFERENCE_TYPE_SUGGESTION',
            `${d.displayName}: suggested Reference Type ${suggestions.map((s) => `“${s}”`).join(' or ')} (the package's “${p.referenceType}” is used).`,
            { page: d.displayName, suggestions },
          );
      } else if (suggestions.length === 1) {
        referenceType = suggestions[0]!;
        warn(
          'REFERENCE_TYPE_SUGGESTED',
          `${d.displayName}: Reference Type “${referenceType}” (suggested from the title).`,
          { page: d.displayName },
        );
      } else {
        refuse(
          'REFERENCE_TYPE_REQUIRED',
          `${d.displayName}: give referenceType${suggestions.length ? ` (suggested: ${suggestions.join(', ')})` : ` (for example ${[...new Set(Object.values(type.suggestedReferenceTypes))].join(', ')})`}.`,
          {
            suggestions: suggestions.length
              ? suggestions
              : [...new Set(Object.values(type.suggestedReferenceTypes))],
          },
        );
      }
    }
    // The specialist tag: one of the closed list, never inferred.
    let specialist: string | null = null;
    if (rule.tags.includes('$specialist') && p.specialistTag) {
      const hit = type.specialistTags.find((t) => textKey(t) === textKey(p.specialistTag!));
      if (!hit)
        refuse(
          'TAG_NOT_ALLOWED',
          `${d.displayName}: “${p.specialistTag}” is not one of the specialist tags (${type.specialistTags.join(', ')}); tags are never typed freely.`,
        );
      else specialist = hit;
    } else if (p.specialistTag && !rule.tags.includes('$specialist')) {
      refuse(
        'TAG_NOT_ALLOWED',
        `${d.displayName}: a ${rule.role} page takes no specialist tag; its tags are computed.`,
      );
    }
    // Facts, in template order, only rows the template has.
    const sidebarRead = tid
      ? await readSidebar(pd, env.mctx, env.tool, tid, env.cc.sidebars, env.cc.templateTags)
      : null;
    if (sidebarRead && !sidebarRead.ok)
      refuse('TEMPLATE_UNREADABLE', `${d.displayName}: its template could not be read now.`);
    const tSidebar = sidebarRead?.ok ? sidebarRead.value : [];
    const tKeys = keysOf(tSidebar, props);
    const want: { key: string; value: string }[] = [];
    const put = (k: string, v: string | null) => {
      if (v === null || v === '') return;
      if (!want.some((x) => factKey(x.key) === factKey(k))) want.push({ key: k, value: v });
    };
    put(env.lifecycle.fields.status, statusFacts(pageStatus));
    put(env.lifecycle.fields.continuityType, continuityType);
    put('Continuity', continuity);
    put('Inheritance', inheritance);
    if (rule.facts === 'identity') for (const f of identityFacts()) put(f.key, f.value);
    // v3 F7d (ADR 0077, A8, A9): the Art page's identity copies (its Subject included) and its own fields, where its
    // template has the row.
    for (const f of p.extraFacts ?? []) put(f.key, f.value);
    put(
      'Subject',
      d.partner && type.relationship
        ? fill(type.relationship.subject, { A: subject, B: d.partner.subject })
        : subject,
    );
    put('Reference Type', referenceType);
    put('Scope', p.scope ?? null);
    put('Supersedes', identity['supersedes']?.value || 'None');
    const allowed =
      rule.facts === 'identity'
        ? null
        : rule.facts === 'general'
          ? new Set([...type.generalKeys, ...(p.extraFacts ?? []).map((f) => f.key)].map(factKey))
          : new Set<string>();
    // Only rows the template has (never one added or dropped), in the template's order.
    const order = (k: string) => tKeys?.findIndex((x) => factKey(x) === factKey(k)) ?? -1;
    const factValues = want
      .filter((f) => (allowed === null || allowed.has(factKey(f.key))) && order(f.key) >= 0)
      .sort((a, b) => order(a.key) - order(b.key));
    if (rule.facts === 'identity' && tKeys) {
      for (const f of gated) {
        if (!tKeys.some((k) => factKey(k) === factKey(f.key)))
          warn(
            'TEMPLATE_ROW_MISSING',
            `${d.displayName}: the template has no “${f.key}” row, so that gated field cannot be written there.`,
            { page: d.displayName },
          );
      }
    }
    if (!p.scope)
      warn('SCOPE_MISSING', `${d.displayName}: no scope given (the Scope row stays empty).`, {
        page: d.displayName,
      });
    // Links: the package's, then (later) the automatic relationship links.
    const linkTargets: { title: string; targets: LinkTarget[] }[] = [];
    const deps = (p.dependencies ?? [])
      .map((r) => resolveTarget(r, d.displayName, pageStatus))
      .filter((t): t is LinkTarget => t !== null);
    const rel = (p.related ?? [])
      .map((r) => resolveTarget(r, d.displayName, pageStatus))
      .filter((t): t is LinkTarget => t !== null);
    if (deps.length) linkTargets.push({ title: linkTitle.dependencies, targets: deps });
    if (rel.length) linkTargets.push({ title: linkTitle.related, targets: rel });
    // Tags.
    const tagResult = tagsCurrent
      ? computeTags({
          rules,
          role: rule,
          page: d.rawName,
          status: pageStatus,
          race: rule.tags.includes('$race') ? (identity['race']?.value ?? null) : null,
          culture: rule.tags.includes('$culture') ? (identity['namingCulture']?.value ?? null) : null,
          specialist,
          unestablished: type.unestablished,
          // v3 F3b (ADR 0052; the owner's AU ruling): an Authoritative page of an AU character carries AU, not CANON.
          continuityType,
        })
      : { tags: [], held: [] };
    held.push(...tagResult.held);
    // Body.
    let md = p.markdown ?? '';
    if (rule.facts === 'identity' && unestablished.length > 0)
      md = withUnresolved(md, type.text.unresolved, unestablished);
    let blocks: LkBlock[] | null = null;
    const headings: string[] = [];
    const pageImages: PlannedImage[] = [];
    const prune: { id: string; needs: string[] }[] = [];
    if (rule.body === 'required' && md.trim() === '') {
      refuse(
        'BODY_REQUIRED',
        `${d.displayName}: the page needs its text (markdown); no empty or token pages.`,
        { page: d.displayName },
      );
    } else if (md.trim() !== '' && converter) {
      try {
        blocks = fromMarkdown(md, { blocks: [] }, converter).blocks;
        const check = checkBody({
          page: d.displayName,
          role: rule.role,
          blocks,
          titles: [d.displayName, d.rawName, subject, name],
          type,
          warnMissing: rule.warnMissing,
        });
        refusals.push(...check.refusals.map((x) => ({ ...x })));
        warnings.push(...check.warnings.map((x) => ({ ...x })));
        for (const s of sectionsOf(blocks)) if (s.heading) headings.push(s.title);
      } catch (e) {
        if (e instanceof MarkdownError)
          refuse(e.code, `${d.displayName}: ${e.message}`, { page: d.displayName });
        else throw e;
      }
    }
    // v3 F7d (ADR 0077, A2): a groups call: each group planned with its own placement, the design pieces under the
    // images section and each outfit under its heading in a "Wardrobe" section, in the order the groups were given.
    if (rule.role === type.assets.role && input.imageGroups && input.imageGroups.length > 0 && blocks) {
      const outfitImages: string[] = [];
      let wardrobeHead: string | null = null;
      for (const g of input.imageGroups) {
        const before = new Set(blocks.map((x) => (x as Obj).id as string));
        const planned = planImages(env, {
          page: d.displayName,
          subject,
          race: mode === 'extend' ? targetRace : raceFallback ? null : raceValue,
          images: g.images,
          refuse,
          warn,
          placement: g.placement,
          where: g.placement.outfit ? `outfit “${g.placement.outfit}”` : 'design pieces',
        });
        pageImages.push(...planned);
        images.push(...planned);
        const bounds = rule.warnMissing.concat(['Source Boundaries', 'Unresolved Material']);
        blocks = g.placement.outfit
          ? withOutfitSection(
              blocks,
              withImages([], planned, type.assets.section, bounds, converter!, g.placement.outfit),
              bounds,
            )
          : withImages(blocks, planned, type.assets.section, bounds, converter!);
        // The headings this group made besides its images' labels, and the image blocks each was made for.
        const added = blocks.filter((x) => !before.has((x as Obj).id as string));
        const imageIds = added.filter((x) => (x as Obj).kind === 'image').map((x) => (x as Obj).id as string);
        const labels = new Set<string>();
        added.forEach((x, i) => {
          if ((x as Obj).kind === 'image' && (added[i - 1] as Obj | undefined)?.kind === 'heading')
            labels.add((added[i - 1] as Obj).id as string);
        });
        for (const x of added) {
          if ((x as Obj).kind !== 'heading' || labels.has((x as Obj).id as string)) continue;
          const id = (x as Obj).id as string;
          if (g.placement.outfit && textKey(blockText(x)) === textKey(WARDROBE_SECTION)) wardrobeHead = id;
          else prune.push({ id, needs: imageIds });
        }
        if (g.placement.outfit) outfitImages.push(...imageIds);
      }
      if (wardrobeHead) prune.push({ id: wardrobeHead, needs: outfitImages });
      headings.splice(
        0,
        headings.length,
        ...sectionsOf(blocks)
          .filter((s) => s.heading)
          .map((s) => s.title),
      );
    } else if (rule.role === type.assets.role && p.images && p.images.length > 0 && blocks) {
      const planned = planImages(env, {
        page: d.displayName,
        subject,
        race: mode === 'extend' ? targetRace : raceFallback ? null : raceValue,
        images: p.images,
        refuse,
        warn,
        placement: input.imagePlacement,
      });
      pageImages.push(...planned);
      images.push(...planned);
      blocks = withImages(
        blocks,
        planned,
        type.assets.section,
        rule.warnMissing.concat(['Source Boundaries', 'Unresolved Material']),
        converter!,
        input.imagePlacement?.outfit ?? null,
      );
      headings.splice(
        0,
        headings.length,
        ...sectionsOf(blocks)
          .filter((s) => s.heading)
          .map((s) => s.title),
      );
    } else if (p.images && p.images.length > 0 && rule.role !== type.assets.role) {
      refuse('IMAGES_NOT_HERE', `${d.displayName}: images go on the ${type.assets.role} page.`);
    }
    const page: PlannedPage = {
      key: `p${drafts.indexOf(d)}`,
      id: d.id,
      rawName: d.rawName,
      displayName: d.displayName,
      kind: pageKind,
      parent,
      templateId: tid ?? 'missing',
      facts: null,
      parentName,
      templateName: tid ? templateName(tid) : '?',
      status: pageStatus,
      tags: tagResult.tags,
      role: rule.role,
      rule,
      templateRole: rule.template,
      subject,
      referenceType,
      scope: p.scope ?? null,
      factValues,
      gatedKeys: rule.facts === 'identity' ? gated.map((f) => f.key) : [],
      templateKeys: tKeys,
      linkTargets,
      markdown: md || null,
      blocks,
      drafted: false,
      images: pageImages,
      headings,
      ...(prune.length ? { prune } : {}),
    };
    pages.push(page);
  }

  // ---------------------------------------------------------------------------------- automatic relationship links
  const partnerLinks = new Map<string, { node: NodeRef; links: LinkTarget[] }>();
  const identityPage = pages.find((p) => p.rule.facts === 'identity') ?? null;
  for (const rel of pages.filter((p) => type.relationship && p.role === type.relationship.role)) {
    const d = drafts.find((x) => x.id === rel.id);
    const link: LinkTarget = { resourceId: rel.id, name: rel.rawName };
    // This character's identity page: new (in its facts) or existing (a facts change below).
    if (identityPage) {
      const l = identityPage.linkTargets as { title: string; targets: LinkTarget[] }[];
      const at = l.find((x) => x.title === linkTitle.related);
      if (at) at.targets.push(link);
      else l.push({ title: linkTitle.related, targets: [link] });
    }
    if (d?.partner) {
      const partnerNode = ctx.tree.node(ctx.projectId, d.partner.node.id).data;
      if (pageStatus === 'working' && partnerNode && partnerNode.kind !== 'bwrk') {
        warn(
          'PARTNER_LINK_DEFERRED',
          `${rel.rawName} is Working, so it is not linked from ${d.partner.node.rawName} yet (a canon page links only current pages). Add it to that page's ${linkTitle.related} with set_facts once the set is promoted.`,
        );
      } else queuePartnerLink(d.partner.node, link);
    }
  }
  function queuePartnerLink(node: NodeRef, link: LinkTarget) {
    const had = partnerLinks.get(node.id);
    if (had) had.links.push(link);
    else partnerLinks.set(node.id, { node, links: [link] });
  }
  if (mode === 'extend' && target && !identityPage) {
    for (const rel of pages.filter((p) => type.relationship && p.role === type.relationship.role)) {
      if (pageStatus === 'working' && targetIdentityNode?.kind !== 'bwrk') continue;
      queuePartnerLink(target.identity, { resourceId: rel.id, name: rel.rawName });
    }
  }

  // ---------------------------------------------------------------------------------- facts of each new page
  for (const p of pages) {
    const tSidebar = p.templateId ? env.cc.sidebars.get(p.templateId) : undefined;
    if (!tSidebar) continue;
    const plan = planOnTemplate(p, tSidebar, props, refuse);
    if (plan)
      (p as { facts: NewPageFactsPlan | null }).facts = {
        plan,
        templateSidebar: tSidebar,
        status: statusFacts(pageStatus),
      };
  }

  // ---------------------------------------------------------------------------------- the index's body
  if (indexPage) {
    const children = [
      ...pages.filter((p) => 'item' in p.parent && p.parent.item === 'index'),
      ...(movedReference
        ? [
            {
              id: movedReference.id,
              rawName: movedReference.rawName,
              displayName: movedReference.displayName,
              scope: ctx.tree.node(ctx.projectId, movedReference.id).data?.scope ?? null,
            },
          ]
        : []),
    ].sort((a, b) => (a.displayName < b.displayName ? -1 : 1));
    const md =
      indexMarkdown ??
      draftIndex(
        type,
        subject,
        children.map((c) => ({ id: c.id, name: c.rawName, scope: c.scope ?? null })),
      );
    if (converter) {
      try {
        const blocks = fromMarkdown(md, { blocks: [] }, converter).blocks;
        const check = checkBody({
          page: indexPage.rawName,
          role: indexRule.role,
          blocks,
          titles: [indexPage.displayName, indexPage.rawName, subject],
          type,
          warnMissing: [type.index.routing, type.index.boundaries],
          allowEmpty: [type.index.collection],
        });
        refusals.push(...check.refusals.map((x) => ({ ...x })));
        warnings.push(...check.warnings.map((x) => ({ ...x })));
        indexPage = {
          ...indexPage,
          markdown: md,
          blocks,
          headings: sectionsOf(blocks)
            .filter((s) => s.heading)
            .map((s) => s.title),
        };
      } catch (e) {
        if (e instanceof MarkdownError) refuse(e.code, `${indexPage.rawName}: ${e.message}`);
        else throw e;
      }
    }
    if (!indexMarkdown)
      notes.push(
        `The index's text is drafted (Purpose, ${type.index.routing}, ${type.index.collection}, ${type.index.boundaries}); it is in the preview to edit, or give your own as index.markdown.`,
      );
  } else if (indexMarkdown !== undefined) {
    warn('INDEX_TEXT_UNUSED', 'index.markdown was given but this package makes no index; it is not used.');
  }

  // ---------------------------------------------------------------------------------- v3 F7.1: is a Core needed?
  // Character Architecture: a character with an index and several owners has a Character Core. When this package would
  // leave the character so under a Compact Character Reference, the upgrade is part of the same proposal (exactly as
  // upgradeToCore: true), whichever tool asked; an explicit upgradeToCore: false is refused, never silently honoured.
  // The counting is shared with the split planner (src/packs/engine/core.ts).
  let need: { needed: boolean; owners: number } = { needed: false, owners: 0 };
  if (mode === 'extend' && target && hook.upgrade && targetIdentityNode) {
    const idxId = targetIndexNode?.id ?? null;
    const inIndex = (p: PlannedPage) =>
      'item' in p.parent ? p.parent.item === 'index' : idxId !== null && p.parent.existing === idxId;
    need = coreNeed({
      role: target.role,
      from: hook.upgrade.from,
      hasIndex: targetIndexNode !== null || indexPage !== null,
      existing: targetIndexNode
        ? ownersInIndex(ctx.tree.children(ctx.projectId, targetIndexNode.id).data, target.identity.id)
        : 0,
      added: pages.filter((p) => isOwnerRole(p.rule) && inIndex(p)).length,
    });
    if (need.needed && input.upgradeToCore === false)
      refuse(
        'CORE_REQUIRED',
        `${subject} would have ${need.owners} owner pages in ${target.index?.rawName ?? `[INDEX] ${subject}`} and no Character Core: ${target.identity.rawName} is a Compact Character Reference, and a character with an index and several owners has a Character Core. Leave upgradeToCore out (or true): the package then upgrades it in the same proposal.`,
        { identity: { id: target.identity.id, name: target.identity.rawName }, owners: need.owners },
      );
  }
  // A relationship hosted under the other participant's index counts there: a Compact Reference heading it is refused
  // (one package upgrades only its own character).
  for (const p of pages) {
    const hosted = drafts.find((d) => d.id === p.id);
    if (!hosted?.partner || hosted.p.host !== 'other' || !('existing' in p.parent)) continue;
    if (p.parent.existing === targetIndexNode?.id || !isOwnerRole(p.rule)) continue;
    const host = ctx.tree.node(ctx.projectId, p.parent.existing).data;
    if (!host || host.kind !== 'index' || (wi && host.id === wi.id)) continue;
    const ch = ctx.types.characterOfPage(host.id);
    if (!ch.ok || ch.value.via !== 'index' || ch.value.core.id === target?.identity.id) continue;
    const n = coreNeed({
      role: ch.value.role,
      from: hook.upgrade?.from ?? null,
      hasIndex: true,
      existing: ownersInIndex(ctx.tree.children(ctx.projectId, host.id).data, ch.value.core.id),
      added: pages.filter((x) => 'existing' in x.parent && x.parent.existing === host.id).length,
    });
    if (n.needed)
      refuse(
        'CORE_REQUIRED',
        `${p.displayName}: hosted under ${host.rawName}, ${ch.value.subject} would have ${n.owners} owner pages and no Character Core (${ch.value.core.rawName} is a Compact Character Reference). Upgrade it first (arkona_create_character with target “${ch.value.core.rawName}” and upgradeToCore), or host the relationship here (host "self").`,
        { identity: { id: ch.value.core.id, name: ch.value.core.rawName }, owners: n.owners },
      );
  }
  const upgrading =
    input.upgradeToCore === true ||
    (need.needed && input.upgradeToCore === undefined && refusals.length === 0);
  /** The upgrade could not be made although the character needs its Core: the whole package is refused. */
  const upgradeRefused = (cause: string, message: string) => {
    if (!need.needed) refuse(cause, message);
    else
      refuse(
        'CORE_REQUIRED',
        `${subject} would have ${need.owners} owner pages in ${target?.index?.rawName ?? `[INDEX] ${subject}`} and no Character Core, and ${target?.identity.rawName ?? 'its Compact Character Reference'} cannot become its Core now (${cause}: ${message}). Nothing is made. Ask the owner to fix that first; then add the pages again.`,
        { cause, identity: target ? { id: target.identity.id, name: target.identity.rawName } : null },
      );
  };

  // ---------------------------------------------------------------------------------- an extension's changes to existing pages
  if (mode === 'extend' && target && targetSidebar && refusals.length === 0) {
    const why: string[] = [];
    const facts: { key: string; value: string }[] = [];
    for (const f of gated) {
      const now = rowValue(targetSidebar, props, f.key);
      const given = identity[f.field]!;
      if (
        (now === null || now === '' || isPlaceholder(now, type.placeholders)) &&
        given.value &&
        !isPlaceholder(given.value, type.placeholders) &&
        now !== null
      ) {
        facts.push({ key: f.key, value: given.value });
        why.push(`${f.key}: was blank, now “${given.value}”`);
      }
    }
    let renamed: string | null = null;
    if (upgrading && hook.upgrade && target.role === hook.upgrade.from) {
      const coreRule = roleRule(hook.upgrade.to)!;
      const compactRule = roleRule(hook.upgrade.from)!;
      const before = refusals.length;
      const coreTid = templateId(coreRule);
      const compactTid = templateId(compactRule);
      // A template refusal is the upgrade's: refused as CORE_REQUIRED when the character needs its Core.
      if (need.needed && refusals.length > before) {
        const got = refusals.splice(before);
        for (const g of got) upgradeRefused(g.code, g.message);
      }
      if (coreTid && compactTid) {
        const a = await readSidebar(pd, env.mctx, env.tool, coreTid, env.cc.sidebars, env.cc.templateTags);
        const b = await readSidebar(pd, env.mctx, env.tool, compactTid, env.cc.sidebars, env.cc.templateTags);
        const ka = a.ok ? keysOf(a.value, props) : null;
        const kb = b.ok ? keysOf(b.value, props) : null;
        const kindPrefix = targetIdentityNode!.kind === 'bwrk' ? '[BWRK] ' : '[BSRC] ';
        const to = `${kindPrefix}${fill(coreRule.name, { Name: subject })}`;
        const np = nameProblem(to, rules);
        if (!ka || !kb || ka.map(factKey).join('|') !== kb.map(factKey).join('|')) {
          upgradeRefused(
            'TEMPLATES_DIFFER',
            `The Core and Compact templates' sidebar rows differ (${ka?.join(', ') ?? '?'} / ${kb?.join(', ') ?? '?'}), so a Compact Reference cannot become a Core in place. Ask the owner.`,
          );
        } else if (np) {
          upgradeRefused(np.code, np.message);
        } else {
          const automatic = input.upgradeToCore !== true;
          renamed = to;
          existing.push({
            kind: 'rename',
            page: target.identity,
            from: target.identity.rawName,
            to,
            coreTemplateId: coreTid,
            compactTemplateId: compactTid,
            ...(automatic ? { automatic: true } : {}),
          });
          facts.push({ key: 'Reference Type', value: coreRule.referenceType ?? 'Character Core' });
          why.push(`Reference Type: ${compactRule.referenceType} → ${coreRule.referenceType}`);
          if (need.needed)
            notes.push(
              `${target.identity.displayName} becomes ${fill(coreRule.name, { Name: subject })} (the character now has an index and several owners: ${need.owners}). Its id, documents, identity facts, links and text are kept; its Reference Type becomes ${coreRule.referenceType ?? 'Character Core'} and the Core template is recorded.`,
            );
          // v3 F7.1 (ADR 0072): its text stops calling it compact, and its images are left to the Art page.
          const ct = await coreTextChanges(env, {
            identity: target.identity,
            subject,
            pages,
            indexNode: targetIndexNode,
            split: input.upgradeOverlap === false,
            ...(input.upgradeText ? { core: input.upgradeText } : {}),
          });
          for (const c of ct.changes) existing.push(c);
          warnings.push(...ct.warnings);
          notes.push(...ct.notes);
          // The Reference's body is kept; sections the new pages now own are warned about.
          if (input.upgradeOverlap !== false)
            warnings.push(...(await overlapWarnings(env, target.identity, pages, ct.coreBlocks)));
        }
      }
    }
    const links = partnerLinks.get(target.identity.id)?.links ?? [];
    partnerLinks.delete(target.identity.id);
    if (facts.length > 0 || links.length > 0) {
      const plan = planExisting(
        targetSidebar,
        target.identity.id,
        props,
        facts,
        links.length ? [{ title: linkTitle.related, targets: links }] : [],
        refuse,
        target.identity.rawName,
      );
      if (plan)
        existing.push({
          kind: 'facts',
          page: target.identity,
          sidebar: targetSidebar,
          plan,
          why: [...why, ...(links.length ? [`${linkTitle.related}: +${links.length}`] : [])],
          substantial: facts.length > 0,
        });
    }
    if (movedReference && indexPage) {
      existing.push({
        kind: 'move',
        page: movedReference,
        to: { item: 'index' },
        toName: indexPage.rawName,
        name: renamed ?? movedReference.rawName,
      });
    }
    // Routing lines in the existing index.
    if (
      hook.routing &&
      targetIndexNode &&
      pages.some((p) => 'existing' in p.parent && p.parent.existing === targetIndexNode.id)
    ) {
      const r = await routingChange(
        env,
        targetIndexNode,
        pages.filter((p) => 'existing' in p.parent && p.parent.existing === targetIndexNode.id),
        refuse,
        warn,
      );
      if (r) existing.push(r);
    }
  }
  // Partners' identity pages (other characters): a links change each.
  for (const { node, links } of partnerLinks.values()) {
    const read = await liveRead(pd, env.mctx, env.tool, 'getResource', { path: { resourceId: node.id } });
    if (!read.ok) {
      refuse('PARTNER_UNREADABLE', `${node.rawName} could not be read now.`);
      continue;
    }
    const sb = sidebarFrom(read.value);
    const plan = planExisting(
      sb,
      node.id,
      props,
      [],
      [{ title: linkTitle.related, targets: links }],
      refuse,
      node.rawName,
    );
    if (plan && !plan.empty)
      existing.push({
        kind: 'facts',
        page: node,
        sidebar: sb,
        plan,
        why: [`${linkTitle.related}: +${links.length}`],
        substantial: false,
      });
  }

  if (!tagsCurrent) {
    refuse(
      'PACK_NOT_CURRENT',
      `${env.governance.message} No tags were computed (fail closed), so nothing can be proposed now.`,
      {
        governance: { state: env.governance.state, sources: env.governance.sources },
      },
    );
  }
  if (status === 'authoritative' && mode === 'new') {
    notes.push(
      'status "authoritative": the set is built in place as canon, so this is a canonical proposal ("Approve and accept as canon").',
    );
  }

  // v3 F4a (ADR 0063): a new character's namesakes (Character Architecture's naming-culture review), free from the tree.
  // An exact full-name match is a warning, in the preview and in the proposal's summary the owner reads; a partial one
  // (given name, surname, alias) a note. Never a refusal: names may be shared.
  let namesakeExtra: Obj | null = null;
  let namesakeSummary: string | undefined;
  if (mode === 'new' && hook.name === 'character' && name !== '') {
    const scan = currentCharacters({ ctx, rules, lifecycle: env.lifecycle });
    const found = namesakesOf(
      scan,
      {
        name: subject,
        givenName: identity.givenName?.value ?? null,
        surname: identity.surname?.value ?? null,
        aliases: splitAliases(identity.aliases?.value),
      },
      usableName(rules),
      existingIds,
    );
    const exact = found.filter((n) => n.severity === 'warning');
    const partial = found.filter((n) => n.severity === 'info');
    if (exact.length > 0) {
      warn(
        'NAMESAKE',
        `A current character already goes by this name: ${exact
          .slice(0, 5)
          .map(namesakeLine)
          .join(
            '; ',
          )}. Names may be shared, so nothing is refused: tell the owner, and ask whether this is a different person (Character Architecture's naming-culture review). arkona_name_check lists every namesake.`,
        { namesakes: exact.slice(0, 10).map(namesakeView) },
      );
      namesakeSummary = `namesake: ${exact
        .slice(0, 3)
        .map(
          (n) =>
            `${n.character.subject} (${[n.character.lifecycle, ...(n.character.au ? ['AU'] : [])].join(', ')})`,
        )
        .join(
          ', ',
        )}${exact.length > 3 ? ` and ${exact.length - 3} more` : ''} already ${exact.length === 1 ? 'goes' : 'go'} by this name`;
    }
    if (partial.length > 0)
      notes.push(
        `Namesakes (info: a given name, surname or alias in common): ${partial
          .slice(0, 5)
          .map(namesakeLine)
          .join('; ')}${partial.length > 5 ? `; and ${partial.length - 5} more (arkona_name_check)` : ''}.`,
      );
    if (found.length > 0)
      namesakeExtra = {
        namesakes: {
          warning: exact.length,
          info: partial.length,
          list: found.slice(0, 10).map(namesakeView),
          rule: 'Names may be shared: never refused. The bridge never suggests a naming culture, race or nationality from a name.',
        },
      };
  }

  const allPages = indexPage ? [indexPage, ...pages] : pages;
  const absentUnder: { parentId: string; names: string[] }[] = [];
  if (mode === 'new') {
    const names = [
      ...new Set([
        subject,
        ...allPages
          .filter((p) => p.rule.facts === 'identity' || p.kind === 'index')
          .map((p) => p.displayName),
      ]),
    ];
    for (const id of [home?.id, raceIndex?.id, wi?.id].filter((x): x is string => typeof x === 'string'))
      if (!absentUnder.some((a) => a.parentId === id)) absentUnder.push({ parentId: id, names });
  } else {
    for (const p of pages) {
      if (!('existing' in p.parent)) continue;
      const parentId = p.parent.existing;
      const a = absentUnder.find((x) => x.parentId === parentId);
      if (a) a.names.push(p.displayName);
      else absentUnder.push({ parentId, names: [p.displayName] });
    }
  }

  return {
    pack,
    type,
    mode,
    subject,
    status,
    pages: allPages,
    existing,
    images,
    refusals,
    warnings,
    replacements,
    held,
    governance: env.governance,
    absent: {
      reservation: mode === 'new' ? `${type.name.toLowerCase()}:${nameKey(subject)}` : null,
      under: absentUnder,
      ...(images.length ? { images: images.map((i) => i.stagedId) } : {}),
    },
    target,
    notes,
    ...(namesakeExtra ? { extra: namesakeExtra } : {}),
    ...(namesakeSummary ? { summaryNote: namesakeSummary } : {}),
    ...(images.some((i) => i.takeover)
      ? {
          takeovers: images
            .filter((i) => i.takeover)
            .map((i) => ({ stagedId: i.stagedId, proposalId: i.takeover! })),
        }
      : {}),
  };
}

// ============================================================================================ helpers

/** The facts plan of a new page on its template's sidebar (ids are the template's; the job binds the copy's). */
export function planOnTemplate(
  p: PlannedPage,
  sidebar: readonly SidebarProperty[],
  property: string,
  refuse: (code: string, message: string, more?: Obj) => void,
): FactsPlan | null {
  if (p.factValues.length === 0 && p.linkTargets.every((l) => l.targets.length === 0)) return null;
  try {
    const plan = planFacts({
      resourceId: p.id,
      sidebar,
      propertyTitle: property,
      facts: p.factValues.map((f) => ({ key: f.key, value: rowTextRuns(f.value) })),
      links: p.linkTargets.map((l) => ({ title: l.title, add: l.targets, remove: [] })),
      templateKeys: p.templateKeys,
    });
    return plan.empty ? null : plan;
  } catch (e) {
    if (e instanceof FactsPlanError) {
      refuse(e.code, `${p.rawName}: ${e.message}`, { page: p.rawName });
      return null;
    }
    throw e;
  }
}

/** A facts and links change to an existing page, planned on its live sidebar. */
export function planExisting(
  sidebar: readonly SidebarProperty[],
  resourceId: string,
  property: string,
  facts: readonly { key: string; value: string }[],
  links: readonly { title: string; targets: readonly LinkTarget[] }[],
  refuse: (code: string, message: string, more?: Obj) => void,
  name: string,
): FactsPlan | null {
  try {
    const keys = keysOf(sidebar, property);
    const plan = planFacts({
      resourceId,
      sidebar,
      propertyTitle: property,
      facts: facts.map((f) => ({ key: f.key, value: rowTextRuns(f.value) })),
      links: links.map((l) => ({ title: l.title, add: l.targets, remove: [] })),
      templateKeys: keys,
    });
    return plan.empty ? null : plan;
  } catch (e) {
    if (e instanceof FactsPlanError) {
      refuse(e.code, `${name}: ${e.message}`, { page: name });
      return null;
    }
    throw e;
  }
}

/** Appends `Unestablished` reasons to the body's Unresolved Material section (made when absent). */
export function withUnresolved(
  md: string,
  heading: string,
  items: readonly { key: string; reason: string }[],
): string {
  const lines = items.map((i) => `- ${i.key}: Unestablished. ${i.reason}`);
  const src = md.replace(/\s+$/, '');
  const re = new RegExp(`^(#{1,6})\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'im');
  const m = re.exec(src);
  if (!m) return `${src}\n\n## ${heading}\n\n${lines.join('\n')}\n`;
  const level = m[1]!.length;
  const after = src.slice(m.index + m[0].length);
  const next = new RegExp(`^#{1,${level}}\\s`, 'm').exec(after);
  const end = next ? m.index + m[0].length + next.index : src.length;
  const before = src.slice(0, end).replace(/\s+$/, '');
  return `${before}\n\n${lines.join('\n')}\n\n${src.slice(end)}`.replace(/\s+$/, '') + '\n';
}

/** The drafted index (decision 8): Purpose, routing lines from each child's name and Scope, the collection, boundaries. */
export function draftIndex(
  type: TypeRules,
  subject: string,
  children: readonly { id: string; name: string; scope: string | null }[],
): string {
  return draftIndexText(type.index, subject, children);
}

/**
 * v3 F3b (ADR 0052): the drafted index text from explicit wording (an owner package's nation index, national subindex
 * or character navigation): Purpose, one routing line per child, the collection, the boundaries. An index with no
 * child yet says how its routing section fills, never a placeholder line.
 */
export function draftIndexText(
  index: {
    readonly purpose: string;
    readonly routing: string;
    readonly collection: string;
    readonly boundaries: string;
    readonly boundariesText: string;
  },
  subject: string,
  children: readonly { id: string; name: string; scope: string | null }[],
  emptyRouting = '- (no pages yet)',
): string {
  // v3 F3f (ADR 0060, part D): a plain mention (no custom label), which always shows the page's current name.
  const lines = children.map((c) => `- [](lk://resources/${c.id})${c.scope ? `: ${c.scope}` : ''}`);
  return [
    `## Purpose`,
    '',
    index.purpose.replace(/\{Name\}/g, subject),
    '',
    `## ${index.routing}`,
    '',
    ...(lines.length ? lines : [emptyRouting]),
    '',
    `## ${index.collection}`,
    '',
    `## ${index.boundaries}`,
    '',
    index.boundariesText.replace(/\{Name\}/g, subject),
    '',
  ].join('\n');
}

/**
 * The images' section of the Art page: a level-2 heading (made before the first boundary section when the text has none),
 * then for each image its label as a level-3 heading, the image block (its address bound when the job runs) and its
 * interpretation.
 */
export function withImages(
  blocks: readonly LkBlock[],
  images: readonly PlannedImage[],
  section: string,
  boundaries: readonly string[],
  ctx: FromMarkdownContext,
  /** v3 F7 (G5): outfit pieces on a new page: a "Wardrobe" section, the outfit's heading (level 3), labels at level 4. */
  outfit: string | null = null,
): LkBlock[] {
  if (images.length === 0) return [...blocks];
  const add: LkBlock[] = [];
  if (outfit) {
    add.push(...fromMarkdown(`### ${outfit}\n`, { blocks: [] }, ctx).blocks);
    section = WARDROBE_SECTION;
  }
  const label = outfit ? '####' : '###';
  for (const im of images) {
    const parts = fromMarkdown(
      `${label} ${im.label.replace(/^#+\s*/, '')}\n\n${im.interpretation}\n`,
      { blocks: [] },
      ctx,
    ).blocks;
    add.push(parts[0]!);
    add.push({
      id: ctx.mintBlockId ? ctx.mintBlockId() : mintClientId(),
      kind: 'image',
      url: im.placeholder,
      alt: im.label,
    });
    add.push(...parts.slice(1));
  }
  const secs = sectionsOf(blocks);
  const has = secs.findIndex((s) => s.heading && textKey(s.title) === textKey(section));
  const out = [...blocks];
  if (has >= 0) {
    // At the end of the existing section.
    let at = 0;
    for (let i = 0; i <= has; i++) at += (secs[i]!.heading ? 1 : 0) + secs[i]!.blocks.length;
    out.splice(at, 0, ...add);
    return out;
  }
  const heading = fromMarkdown(`## ${section}\n`, { blocks: [] }, ctx).blocks;
  const b = secs.findIndex((s) => s.heading && boundaries.some((x) => textKey(x) === textKey(s.title)));
  if (b < 0) return [...out, ...heading, ...add];
  let at = 0;
  for (let i = 0; i < b; i++) at += (secs[i]!.heading ? 1 : 0) + secs[i]!.blocks.length;
  out.splice(at, 0, ...heading, ...add);
  return out;
}

/**
 * v3 F7d (ADR 0077, A4): one outfit's blocks (`## Wardrobe`, `### <Outfit>`, its pieces, as `withImages` lays them out on
 * an empty page) on a new Art page: at the END of its Wardrobe section, after the outfits already there (its deeper
 * headings included), so the outfits stand in the order the groups were given; the section is made before the boundary
 * sections (else at the end) when the page has none.
 */
export function withOutfitSection(
  blocks: readonly LkBlock[],
  chunk: readonly LkBlock[],
  boundaries: readonly string[],
): LkBlock[] {
  const isHead = (b: LkBlock | undefined) => (b as Obj | undefined)?.kind === 'heading';
  const level = (b: LkBlock) => (typeof (b as Obj).level === 'number' ? ((b as Obj).level as number) : 1);
  const out = [...blocks];
  const w = out.findIndex((b) => isHead(b) && textKey(blockText(b)) === textKey(WARDROBE_SECTION));
  if (w >= 0) {
    const body =
      isHead(chunk[0]) && textKey(blockText(chunk[0]!)) === textKey(WARDROBE_SECTION)
        ? chunk.slice(1)
        : chunk;
    let end = w + 1;
    while (end < out.length && !(isHead(out[end]) && level(out[end]!) <= level(out[w]!))) end++;
    out.splice(end, 0, ...body);
    return out;
  }
  const keys = boundaries.map(textKey);
  const b = out.findIndex((x) => isHead(x) && keys.includes(textKey(blockText(x))));
  if (b >= 0) out.splice(b, 0, ...chunk);
  else out.push(...chunk);
  return out;
}

/** The staged images of an Art page, with their folder and display names (refused rather than guessed). */
export function planImages(
  env: PlanEnv,
  o: {
    page: string;
    subject: string;
    race: string | null;
    images: readonly PackageImage[];
    refuse: (code: string, message: string, more?: Obj) => void;
    warn: (code: string, message: string, more?: Obj) => void;
    /** v3 F7 (G2): the bridge's placement; none: design pieces in the character's own folder. */
    placement?: ImagePlacement | undefined;
    /** v3 F7d (ADR 0077): the group, in each refusal's place (`Art page: outfit “X”: images[2]`). */
    where?: string | undefined;
  },
): PlannedImage[] {
  const { pd, ctx, type } = env;
  const images = pd.services?.images;
  if (!images) {
    o.refuse('TOOL_UNAVAILABLE', 'Images cannot be placed here (no image service).');
    return [];
  }
  const out: PlannedImage[] = [];
  const seen = new Set<string>();
  const sub = [...(o.placement?.subfolders ?? [])];
  const outfit = o.placement?.outfit ?? null;
  for (const [i, im] of o.images.entries()) {
    const where = `${o.page}: ${o.where ? `${o.where}: ` : ''}images[${i}]`;
    if (!im.interpretation || im.interpretation.trim() === '') {
      o.refuse(
        'BARE_IMAGE',
        `${where}: an image needs its interpretation text (what the reference establishes); a bare image is refused.`,
      );
      continue;
    }
    const parts = im.label
      .split(' - ')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length < 2 || /\.(png|jpe?g|gif|webp|avif|bmp|tiff?)$/i.test(im.label)) {
      o.refuse(
        'IMAGE_LABEL_INVALID',
        `${where}: the label is “{Visual Role} - {Descriptor}” (for example “Primary Reference - Character Portrait”), with no file extension.`,
      );
      continue;
    }
    const stagedNow = images.staged(ctx.projectId, im.staged_id);
    // v3 F7c (ADR 0075, Z4): an archive entry not staged yet is planned from its header (staged meanwhile: as it is).
    const pending = !stagedNow && im.pending ? im.pending : undefined;
    const row = pending ? pendingRow(ctx.projectId, im.staged_id, pending) : stagedNow;
    if (!row || !row.staged) {
      o.refuse(
        'STAGED_IMAGE_NOT_FOUND',
        `${where}: no staged image ${im.staged_id} in this project (stage it with upload_image first).`,
      );
      continue;
    }
    if (!row.serverSha256) {
      o.refuse(
        'STAGED_IMAGE_LEGACY',
        `${where}: ${im.staged_id} was staged in LegendKeeper before staging moved to the bridge; the owner migrates it first (images migrate-staging).`,
      );
      continue;
    }
    // v3 F3b (design section 6): the image's own pending placement is taken over; any other activity still refuses.
    // CR-2026-11-R2 (R2-40): only the caller's own: another agent's pending placement is "busy", never planned over.
    const takeover = row.placementProposalId
      ? images.ownPendingPlacement(row, env.mctx.principal?.principalId)
      : null;
    if (row.placementJobId || row.discardJobId || (row.placementProposalId && !takeover)) {
      o.refuse(
        'STAGED_IMAGE_BUSY',
        `${where}: ${im.staged_id} is already being placed or discarded${row.placementProposalId ? ` (proposal ${row.placementProposalId}, not its own placement alone)` : row.placementJobId ? ` (job ${row.placementJobId})` : ''}.`,
        {
          hint: 'Stage art for a pack with upload_image { stage: true } and no destination: that proposes nothing.',
        },
      );
      continue;
    }
    if (seen.has(im.staged_id)) {
      o.refuse('STAGED_IMAGE_TWICE', `${where}: ${im.staged_id} is listed twice.`);
      continue;
    }
    seen.add(im.staged_id);
    // G4: `<Character> - <Label>` for a design piece; `<Character> - <Outfit> - <Label>` for an outfit piece.
    const name = type.assets.displayName
      .replace(/\{Subject\}/g, o.subject)
      .replace(/\{Label\}/g, outfit ? `${outfit} - ${im.label}` : im.label);
    if (out.some((x) => x.name === name || x.label === im.label)) {
      o.refuse('IMAGE_NAME_TWICE', `${where}: two images would both be named “${name}” in one folder.`);
      continue;
    }
    const registryType = type.placement.kind === 'taxonomy' ? type.placement.registryType : undefined;
    // A race that names no race index places the folder under the unknown race, as the pages are (with a warning).
    let race = o.race;
    if (race !== null) {
      try {
        ctx.types.raceIndex(race, registryType);
      } catch {
        race = null;
      }
    }
    const planned = images.plan(ctx.projectId, {
      for_character: { name: o.subject, race, ...(registryType ? { type: registryType } : {}) },
      ...(sub.length ? { subfolders: sub } : {}),
    });
    if (!planned.ok) {
      o.refuse(planned.error.code, `${where}: ${planned.error.message}`);
      continue;
    }
    const p = planned.plan;
    let free =
      p.destination.folderId && p.wouldCreate.length === 0
        ? images.freeName(ctx.projectId, p.destination.folderId, name)
        : name;
    // v3 F7 (G4): numbered past the names the job moves into a new folder too (` (2)`, ` (3)`, …).
    const taken = o.placement?.taken;
    if (taken?.has(free)) {
      let n = 2;
      while (taken.has(`${name} (${n})`)) n++;
      free = `${name} (${n})`;
    }
    if (free !== name)
      o.warn(
        'IMAGE_NAME_NUMBERED',
        `${where}: “${name}” is taken in that folder; it is placed as “${free}”.`,
      );
    out.push({
      stagedId: im.staged_id,
      row,
      label: im.label,
      interpretation: im.interpretation,
      name: free,
      path: [...p.destination.path],
      folderId: p.destination.folderId,
      creates: p.wouldCreate.map((c) => ({ name: c.name, parentFolderId: c.parentFolderId })),
      placeholder: `https://lk-bridge.invalid/staged/${im.staged_id}`,
      subfolder: sub.join(' / ') || null,
      takeover,
      ...(pending ? { pending } : {}),
    });
  }
  return out;
}

/** What a routing change needs of the plan's environment (F3a's character tool and F3b's owner tool alike). */
export type RoutingEnv = Pick<PlanEnv, 'pd' | 'mctx' | 'tool' | 'ctx'> & {
  readonly type: Pick<TypeRules, 'index'>;
};

/**
 * One routing line, F3a's pattern with a PLAIN mention: `- [](lk://resources/<id>): <Scope>`. v3 F3f (ADR 0060, part D):
 * the mention carries no custom label, so it always shows the page's current name (LegendKeeper's API cannot change a
 * custom label, so a rename would leave a labelled one behind). CR-2026-11-R2 (R2-37): ONE line: any line break in the
 * Scope is collapsed to a space, so a Scope can never add a heading or a paragraph. `rawName` is kept for callers'
 * summaries; the line itself no longer holds it.
 */
export const routingLine = (c: {
  readonly rawName: string;
  readonly id: string;
  readonly scope: string | null;
}) => {
  const scope = c.scope ? oneLine(c.scope) : '';
  return `- [](lk://resources/${c.id})${scope ? `: ${scope}` : ''}`;
};

/** An index's routing section as read now: its document, version, blocks and the section, or why not (said). */
async function routingSection(
  env: RoutingEnv,
  index: TreeNode,
  refuse: (code: string, message: string, more?: Obj) => void,
  warn: (code: string, message: string, more?: Obj) => void,
  /** What is left undone, in words: after "no main page document; " and "section, so ". */
  undone: { readonly noDocument: string; readonly noSection: string },
): Promise<{
  doc: { id: string };
  version: string;
  blocks: LkBlock[];
  md: string;
  title: string;
} | null> {
  const doc =
    index.documents.find((d) => d.name === 'Main' && (d.type === 'page' || d.type === 'blank')) ??
    (index.documents.filter((d) => d.type === 'page').length === 1
      ? index.documents.find((d) => d.type === 'page')
      : undefined);
  if (!doc) {
    warn('ROUTING_SKIPPED', `${index.rawName} has no main page document; ${undone.noDocument}.`);
    return null;
  }
  const read = await liveRead(env.pd, env.mctx, env.tool, 'getDocumentBlocks', {
    path: { resourceId: index.id, documentId: doc.id },
  });
  if (!read.ok) {
    refuse('INDEX_UNREADABLE', `${index.rawName} could not be read now.`);
    return null;
  }
  const body = read.value as { version?: string; blocks?: LkBlock[] };
  const blocks = body.blocks ?? [];
  const want = textKey(env.type.index.routing);
  const found = sectionsOf(blocks).find((s) => s.heading && textKey(s.title) === want);
  if (!found) {
    warn(
      'ROUTING_SECTION_MISSING',
      `${index.rawName} has no “${env.type.index.routing}” section, so ${undone.noSection}.`,
    );
    return null;
  }
  return {
    doc,
    version: body.version ?? '',
    blocks,
    md: toMarkdown({ blocks }).markdown,
    title: found.title,
  };
}

/**
 * v3 F3d (ADR 0053): the Polities index's line for a nation that `promoteNation` gives its own index now points to that
 * index: the one routing line that links the nation's Reference has its link replaced by one to the new index (the rest
 * of the line, its Scope, kept), as one section rewrite with the in-lock re-plan. No such line, or several: nothing is
 * changed and the preview says so.
 */
export async function repointRoutingLine(
  env: RoutingEnv,
  index: TreeNode,
  from: { readonly id: string; readonly rawName: string },
  to: { readonly id: string; readonly rawName: string },
  refuse: (code: string, message: string, more?: Obj) => void,
  say: (code: string, message: string, more?: Obj) => void,
): Promise<ExistingChange | null> {
  const r = await routingSection(env, index, refuse, say, {
    noDocument: `its line for ${from.rawName} was not changed`,
    noSection: `no line for ${from.rawName} was changed (edit it with write_page if it lists the nation)`,
  });
  if (!r) return null;
  let section: string;
  try {
    section = getSection(r.md, r.title).markdown;
  } catch {
    say(
      'ROUTING_SECTION_AMBIGUOUS',
      `${index.rawName}: “${r.title}” could not be read as one section; its line for ${from.rawName} was not changed.`,
    );
    return null;
  }
  const link = new RegExp(`\\[((?:[^\\]\\\\]|\\\\.)*)\\]\\(lk://resources/${from.id}\\)`, 'g');
  const lines = section.split('\n');
  const hits = lines.map((l, i) => (/^\s*[-*+]\s/.test(l) && l.match(link) ? i : -1)).filter((i) => i >= 0);
  if (hits.length !== 1) {
    say(
      hits.length === 0 ? 'ROUTING_LINE_MISSING' : 'ROUTING_LINE_AMBIGUOUS',
      `${index.rawName}: ${hits.length === 0 ? `no routing line links ${from.rawName}` : `${hits.length} routing lines link ${from.rawName}`}, so none was pointed to ${to.rawName} (edit it with write_page if needed).`,
    );
    return null;
  }
  // v3 F3f (ADR 0060, part D): the repointed link is a plain mention (the new index's current name, always).
  const before = lines[hits[0]!]!;
  const after = before.replace(link, `[](lk://resources/${to.id})`);
  lines[hits[0]!] = after;
  const markdown = lines.join('\n');
  let planned: LkBlock[];
  try {
    const ctx = env.pd.services ? pageConverterContext(env.pd.services, env.ctx.projectId) : undefined;
    planned = applyEdit(
      { blocks: r.blocks },
      { mode: 'replace_section', section: r.title, markdown },
      ctx ?? {},
    ).blocks;
  } catch (e) {
    say(
      'ROUTING_SECTION_AMBIGUOUS',
      `${index.rawName}: its line for ${from.rawName} could not be changed (${e instanceof Error ? e.message : String(e)}); edit it with write_page.`,
    );
    return null;
  }
  return {
    planned,
    kind: 'routing',
    mode: 'replace_section',
    page: env.ctx.types.resolveOne(index.id),
    documentId: r.doc.id,
    version: r.version,
    blocks: r.blocks,
    lines: [after.trim()],
    markdown,
    sectionHash: createHash('sha256').update(section).digest('hex'),
    section: r.title,
    what: `its line for ${from.rawName} now points to ${to.rawName}`,
  };
}

/** The existing index's routing section gains a line per new page (append, never a rewrite); missing: warned. */
export async function routingChange(
  env: RoutingEnv,
  index: TreeNode,
  children: readonly Pick<PlannedPage, 'rawName' | 'id' | 'scope'>[],
  refuse: (code: string, message: string, more?: Obj) => void,
  warn: (code: string, message: string, more?: Obj) => void,
): Promise<ExistingChange | null> {
  const r = await routingSection(env, index, refuse, warn, {
    noDocument: 'its routing lines were not added',
    noSection: 'no routing lines were added (add them with write_page)',
  });
  if (!r) return null;
  const { blocks, md } = r;
  const doc = r.doc;
  const body = { version: r.version };
  const found = { title: r.title };
  const lines = children.map(routingLine);
  let sectionMd: string;
  let planned: LkBlock[];
  try {
    sectionMd = getSection(md, found.title).markdown;
    const ctx = env.pd.services ? pageConverterContext(env.pd.services, env.ctx.projectId) : undefined;
    planned = applyEdit(
      { blocks },
      { mode: 'append_to_section', section: found.title, markdown: lines.join('\n') },
      ctx ?? {},
    ).blocks;
  } catch (e) {
    warn(
      'ROUTING_SECTION_AMBIGUOUS',
      `${index.rawName}: the lines could not be added to “${found.title}” (${e instanceof Error ? e.message : String(e)}); add them with write_page.`,
    );
    return null;
  }
  return {
    planned,
    kind: 'routing',
    page: env.ctx.types.resolveOne(index.id),
    documentId: doc.id,
    version: body.version ?? '',
    blocks,
    lines,
    markdown: lines.join('\n'),
    sectionHash: createHash('sha256').update(sectionMd).digest('hex'),
    section: found.title,
  };
}

/** Sections of the Reference's body that the new pages' domains now own (by heading words): a follow-up trim is due. */
/** A page's main document, read live (null: none, or unreadable now). */
async function readMain(
  env: PlanEnv,
  pageId: string,
): Promise<{ documentId: string; blocks: LkBlock[] } | null> {
  const node = env.ctx.tree.node(env.ctx.projectId, pageId).data;
  const doc =
    node?.documents.find((d) => d.name === 'Main') ?? node?.documents.find((d) => d.type === 'page');
  if (!node || !doc) return null;
  const read = await liveRead(env.pd, env.mctx, env.tool, 'getDocumentBlocks', {
    path: { resourceId: pageId, documentId: doc.id },
  });
  if (!read.ok) return null;
  return { documentId: doc.id, blocks: (read.value as { blocks?: LkBlock[] }).blocks ?? [] };
}

/** Inserts `add` at the end of the `section` heading's section, else before the first boundary section, else at the end. */
function insertUnder(
  blocks: readonly LkBlock[],
  section: string,
  boundaries: readonly string[],
  add: readonly LkBlock[],
): LkBlock[] {
  const out = [...blocks];
  const isHead = (b: LkBlock) => (b as unknown as Obj).kind === 'heading';
  const level = (b: LkBlock) => Number((b as unknown as Obj).level ?? 1);
  const at = out.findIndex((b) => isHead(b) && textKey(blockText(b)) === textKey(section));
  if (at >= 0) {
    let end = at + 1;
    while (end < out.length && !(isHead(out[end]!) && level(out[end]!) <= level(out[at]!))) end++;
    out.splice(end, 0, ...add);
    return out;
  }
  const head = {
    id: mintClientId(),
    kind: 'heading',
    level: 2,
    content: [{ text: section }],
  } as unknown as LkBlock;
  const b = out.findIndex((x) => isHead(x) && boundaries.some((t) => textKey(t) === textKey(blockText(x))));
  if (b >= 0) out.splice(b, 0, head, ...add);
  else out.push(head, ...add);
  return out;
}

/**
 * Amendment 1 to ADR 0072: who the Core is about, for the self-reference test: its Subject and Canonical Display Name;
 * and the other characters (every Character Core and Compact Character Reference the tree knows, by their names) whose
 * names appear in the pages' text, so a sentence naming one of them is never edited. Kept with the plan, so the filler
 * applies exactly the same test inside the lock.
 */
function wordingNames(
  env: PlanEnv,
  identityId: string,
  subject: string,
  texts: readonly (readonly LkBlock[])[],
): { names?: string[]; others?: string[] } {
  const { ctx } = env;
  const me = ctx.tree.node(ctx.projectId, identityId).data;
  const names = [...new Set([me?.canonicalDisplayName ?? '', subjectOf(me?.displayName ?? '', null)])]
    .map((n) => n.trim())
    .filter((n) => n !== '' && nameKey(n) !== nameKey(subject));
  const text = texts.flatMap((bs) => bs.map((b) => JSON.stringify(b))).join(' ');
  const others = new Set<string>();
  for (const kind of ['bsrc', 'bwrk'] as const)
    for (const n of ctx.tree.byKind(ctx.projectId, kind).data) {
      if (n.id === identityId) continue;
      const rt = textKey(n.referenceType ?? '');
      if (rt !== textKey('Character Core') && rt !== textKey('Compact Character Reference')) continue;
      const who = (n.canonicalDisplayName ?? subjectOf(n.displayName, null)).trim();
      if (who === '') continue;
      const words = [who, ...who.split(/\s+/).filter(nameWord)];
      if (words.some((w) => text.includes(w))) others.add(who);
    }
  const out: WordingNames = {
    ...(names.length > 0 ? { names } : {}),
    ...(others.size > 0 ? { others: [...others].sort() } : {}),
  };
  return out as { names?: string[]; others?: string[] };
}

/**
 * v3 F7.1 (ADR 0072): the upgrade's text change, planned on the pages read live (the Core, and the character's Art
 * page when it exists; a new Art page of the same package is changed in its plan):
 *
 * - the wording rules (src/packs/engine/core.ts) on the Core and on the Art page, every replacement shown;
 * - each image of the Core that the Art page also holds removed from the Core; each it lacks copied to the Art page
 *   under its images section (its following paragraphs as its interpretation) and then removed from the Core: never
 *   dropped (no Art page, or a split's new Art page whose text the split writes: the image stays, and the owner is told);
 * - any other sentence still saying "compact" listed for the owner, never edited; the visual text left in a section
 *   whose images left the Core goes into the overlap warnings.
 */
async function coreTextChanges(
  env: PlanEnv,
  a: {
    readonly identity: NodeRef;
    readonly subject: string;
    readonly pages: PlannedPage[];
    readonly indexNode: TreeNode | null;
    readonly split: boolean;
    readonly core?: { readonly documentId: string; readonly blocks: readonly LkBlock[] };
  },
): Promise<{
  changes: ExistingChange[];
  warnings: Issue[];
  notes: string[];
  coreBlocks: LkBlock[] | null;
}> {
  const { ctx, type } = env;
  const changes: ExistingChange[] = [];
  const warnings: Issue[] = [];
  const notes: string[] = [];
  const core = a.core
    ? { documentId: a.core.documentId, blocks: [...a.core.blocks] }
    : await readMain(env, a.identity.id);
  if (!core) {
    warnings.push({
      code: 'CORE_TEXT_UNREAD',
      message: `${a.identity.rawName}: its text could not be read now, so its wording and images are not changed by the upgrade. Check it afterwards: it may still call itself compact.`,
    });
    return { changes, warnings, notes, coreBlocks: null };
  }
  const artRule = type.roles.find((r) => r.role === type.assets.role) ?? null;
  const artName = artRule ? fill(artRule.name, { Name: a.subject }) : null;
  const newArtAt = a.pages.findIndex((p) => p.role === type.assets.role);
  const artNode =
    newArtAt < 0 && a.indexNode
      ? (ctx.tree
          .children(ctx.projectId, a.indexNode.id)
          .data.find(
            (n) =>
              n.kind !== 'index' &&
              n.kind !== 'barc' &&
              ((artName !== null && nameKey(n.displayName) === nameKey(artName)) ||
                (artRule?.referenceType != null &&
                  n.referenceType !== null &&
                  textKey(n.referenceType) === textKey(artRule.referenceType))),
          ) ?? null)
      : null;
  const art = artNode ? await readMain(env, artNode.id) : null;
  if (artNode && !art)
    warnings.push({
      code: 'CORE_TEXT_UNREAD',
      message: `${artNode.rawName}: it could not be read now, so the Core's images stay on the Core and the Art page's wording is not changed.`,
    });
  const newArt = newArtAt >= 0 ? a.pages[newArtAt]! : null;
  const boundaries = ['Source Boundaries', 'Unresolved Material'];
  const section = type.assets.section;

  // The wording, on the Core: only phrases that mean the page itself (amendment 1 to ADR 0072).
  const wn = wordingNames(env, a.identity.id, a.subject, [
    core.blocks,
    art?.blocks ?? [],
    newArt?.blocks ?? [],
  ]);
  const cw = reword(core.blocks, 'core', a.subject, undefined, wn);
  // The images.
  const artBlocks = art?.blocks ?? newArt?.blocks ?? null;
  let imgs = artBlocks
    ? planCoreImages(core.blocks, imageKeys(artBlocks), a.subject, mintClientId)
    : { remove: [], append: [], sections: [] };
  const coreImages = core.blocks.filter((b) => (b as unknown as Obj).kind === 'image').length;
  if (!artBlocks && coreImages > 0 && !artNode)
    notes.push(
      `${a.identity.rawName} holds ${coreImages} image${coreImages === 1 ? '' : 's'} and ${a.subject} has no Art page yet, so ${coreImages === 1 ? 'it stays' : 'they stay'} on the Core (arkona_add_character_art makes the Art page).`,
    );
  if (newArt && a.split && imgs.append.length > 0) {
    // The split writes its new pages' text itself: an image the new Art page lacks stays on the Core.
    const kept = imgs.remove.filter((r) => !r.onArt).length;
    imgs = { ...imgs, remove: imgs.remove.filter((r) => r.onArt), append: [] };
    warnings.push({
      code: 'CORE_IMAGE_KEPT',
      message: `${a.identity.rawName}: ${kept} image${kept === 1 ? '' : 's'} not on the new Art page stay${kept === 1 ? 's' : ''} on the Core (the split writes the new page's text). Move ${kept === 1 ? 'it' : 'them'} with arkona_add_character_art afterwards.`,
      page: a.identity.rawName,
    });
  }
  const after = cw.blocks.filter((b) => !imgs.remove.some((r) => r.blockId === (b as unknown as Obj).id));
  const left: CompactLeft[] = wordingLeft(
    after,
    cw.skipped.filter((x) => !imgs.remove.some((r) => r.blockId === x.blockId)),
    a.identity.rawName,
  );

  // The Art page: its wording, and the moved images.
  let artReplacements: CoreReplacement[] = [];
  if (art && artNode) {
    const aw = reword(art.blocks, 'art', a.subject, undefined, wn);
    artReplacements = aw.replacements;
    left.push(...wordingLeft(aw.blocks, aw.skipped, artNode.rawName));
    if (aw.replacements.length > 0 || imgs.append.length > 0)
      changes.push({
        kind: 'core_text',
        page: {
          id: artNode.id,
          rawName: artNode.rawName,
          displayName: artNode.displayName,
          kind: artNode.kind,
          path: artNode.path.names.join(' / '),
        },
        documentId: art.documentId,
        role: 'art',
        subject: a.subject,
        ...wn,
        replacements: aw.replacements,
        remove: [],
        append: imgs.append,
        section,
        boundaries,
      });
  } else if (newArt && newArt.blocks) {
    const aw = reword(newArt.blocks, 'art', a.subject, undefined, wn);
    artReplacements = aw.replacements;
    const blocks =
      imgs.append.length > 0 ? insertUnder(aw.blocks, section, boundaries, imgs.append) : aw.blocks;
    if (aw.replacements.length > 0 || imgs.append.length > 0) {
      let markdown = newArt.markdown;
      try {
        markdown = toMarkdown({ blocks }).markdown;
      } catch {
        // the preview keeps the planned Markdown
      }
      a.pages[newArtAt] = {
        ...newArt,
        blocks,
        markdown,
        headings: sectionsOf(blocks)
          .filter((s) => s.heading)
          .map((s) => s.title),
        notes: [
          ...(newArt.notes ?? []),
          ...(imgs.append.length > 0
            ? [`${imgs.remove.filter((r) => !r.onArt).length} image(s) moved here from the Character Core`]
            : []),
        ],
      };
    }
    left.push(...wordingLeft(blocks, aw.skipped, newArt.rawName));
  }

  // The Core: its wording, and its images removed (after the Art page has them).
  if (cw.replacements.length > 0 || imgs.remove.length > 0)
    changes.push({
      kind: 'core_text',
      page: a.identity,
      documentId: core.documentId,
      role: 'core',
      subject: a.subject,
      ...wn,
      replacements: cw.replacements,
      remove: imgs.remove.map((r) => ({ blockId: r.blockId, url: r.url })),
      append: [],
      section,
      boundaries,
      ...(imgs.remove.some((r) => !r.onArt) ? { needs: artNode?.id ?? newArt?.id ?? '' } : {}),
    });
  const all = [...cw.replacements, ...artReplacements];
  if (all.length > 0)
    notes.push(
      `Wording: ${all.length} phrase${all.length === 1 ? '' : 's'} where the page calls itself compact now say Character Core (${all
        .slice(0, 6)
        .map((r) => {
          const c = textChange({ page: '', before: r.before, after: r.after });
          return c ? textChangeWords(c) : `“${r.before.slice(0, 120)}” → “${r.after.slice(0, 120)}”`;
        })
        .join('; ')}${all.length > 6 ? `; and ${all.length - 6} more` : ''}).`,
    );
  const onArt = imgs.remove.filter((r) => r.onArt).length;
  const moved = imgs.remove.length - onArt;
  if (imgs.remove.length > 0)
    notes.push(
      `Images: ${onArt > 0 ? `${onArt} the Art page already holds removed from the Core` : ''}${onArt > 0 && moved > 0 ? '; ' : ''}${moved > 0 ? `${moved} the Art page lacked moved to its ${section} (with ${moved === 1 ? 'its' : 'their'} interpretation) and then removed from the Core` : ''}. No prose is removed.`,
    );
  warnings.push(...visualTextWarning(a.identity.rawName, imgs.sections));
  if (left.length > 0) {
    warnings.push({
      code: 'COMPACT_WORDING_LEFT',
      message: `${left.length} sentence${left.length === 1 ? '' : 's'} still say${left.length === 1 ? 's' : ''} “compact” after the upgrade's replacements; listed for the owner, never edited.`,
      sentences: left.slice(0, 20),
    });
    notes.push(
      `For the owner (not edited): ${left
        .slice(0, 5)
        .map((l) => `${l.page}: “${l.sentence.slice(0, 160)}”`)
        .join('; ')}${left.length > 5 ? `; and ${left.length - 5} more` : ''}.`,
    );
  }
  return { changes, warnings, notes, coreBlocks: core.blocks };
}

async function overlapWarnings(
  env: PlanEnv,
  page: NodeRef,
  pages: readonly PlannedPage[],
  read?: LkBlock[] | null,
): Promise<Issue[]> {
  const blocks = read ?? (await readMain(env, page.id))?.blocks;
  if (!blocks) return [];
  const domains = env.type.text.overload.domains;
  const owned = new Set<string>();
  for (const p of pages) {
    const t = textKey(`${p.displayName} ${p.referenceType ?? ''}`);
    for (const [d, words] of Object.entries(domains))
      if (words.some((w) => t.includes(textKey(w))) || t.includes(textKey(d))) owned.add(d);
  }
  const out: Issue[] = [];
  for (const s of sectionsOf(blocks)) {
    if (!s.heading) continue;
    const t = textKey(s.title);
    for (const d of owned) {
      if ((domains[d] ?? []).some((w) => t.includes(textKey(w))) || t.includes(textKey(d))) {
        out.push({
          code: 'UPGRADE_OVERLAP',
          message: `${page.rawName}: its section “${s.title}” is ${d.toLowerCase()} material that a new page now owns; trim it from the Core afterwards (write_page), as a follow-up.`,
          page: page.rawName,
          section: s.title,
        });
        break;
      }
    }
  }
  return out;
}

/** For the routing line and preview: a page's parent as text. */
export function blockSummary(blocks: readonly LkBlock[] | null): { blocks: number; headings: string[] } {
  if (!blocks) return { blocks: 0, headings: [] };
  return {
    blocks: blocks.length,
    headings: sectionsOf(blocks)
      .filter((s) => s.heading)
      .map((s) => s.title),
  };
}

export { blockText, isObj, slotAmong, classifyName };
