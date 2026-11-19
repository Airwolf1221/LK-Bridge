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
import { factKey, sidebarFrom, type SidebarProperty } from '../../facts/index.js';
import { FactsPlanError, planFacts, type FactsPlan, type LinkTarget } from '../../facts/plan.js';
import { rowTextRuns } from '../../facts/values.js';
import { mintClientId } from '../../jobs/ids.js';
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
import { pageConverterContext } from '../../pages/index.js';
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
  readonly subfolder?: string | null | undefined;
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
    }
  | {
      readonly kind: 'facts';
      readonly page: NodeRef;
      readonly sidebar: readonly SidebarProperty[];
      readonly plan: FactsPlan;
      readonly why: readonly string[];
      /** A substantial change (its Last Major Revision is set): not for a link alone. */
      readonly substantial: boolean;
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
    };

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
  const base = pd.services ? pageConverterContext(pd.services, ctx.projectId) : undefined;
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
          ? new Set(type.generalKeys.map(factKey))
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
    // Images (the Art page): staged uploads, each with its label and interpretation.
    if (rule.role === type.assets.role && p.images && p.images.length > 0 && blocks) {
      const planned = planImages(env, {
        page: d.displayName,
        subject,
        race: mode === 'extend' ? targetRace : raceFallback ? null : raceValue,
        images: p.images,
        refuse,
        warn,
      });
      pageImages.push(...planned);
      images.push(...planned);
      blocks = withImages(
        blocks,
        planned,
        type.assets.section,
        rule.warnMissing.concat(['Source Boundaries', 'Unresolved Material']),
        converter!,
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
    if (input.upgradeToCore === true && hook.upgrade && target.role === hook.upgrade.from) {
      const coreRule = roleRule(hook.upgrade.to)!;
      const compactRule = roleRule(hook.upgrade.from)!;
      const coreTid = templateId(coreRule);
      const compactTid = templateId(compactRule);
      if (coreTid && compactTid) {
        const a = await readSidebar(pd, env.mctx, env.tool, coreTid, env.cc.sidebars, env.cc.templateTags);
        const b = await readSidebar(pd, env.mctx, env.tool, compactTid, env.cc.sidebars, env.cc.templateTags);
        const ka = a.ok ? keysOf(a.value, props) : null;
        const kb = b.ok ? keysOf(b.value, props) : null;
        if (!ka || !kb || ka.map(factKey).join('|') !== kb.map(factKey).join('|')) {
          refuse(
            'TEMPLATES_DIFFER',
            `The Core and Compact templates' sidebar rows differ (${ka?.join(', ') ?? '?'} / ${kb?.join(', ') ?? '?'}), so a Compact Reference cannot become a Core in place. Ask the owner.`,
          );
        } else {
          const kindPrefix = targetIdentityNode!.kind === 'bwrk' ? '[BWRK] ' : '[BSRC] ';
          const to = `${kindPrefix}${fill(coreRule.name, { Name: subject })}`;
          const np = nameProblem(to, rules);
          if (np) refuse(np.code, np.message);
          renamed = to;
          existing.push({
            kind: 'rename',
            page: target.identity,
            from: target.identity.rawName,
            to,
            coreTemplateId: coreTid,
          });
          facts.push({ key: 'Reference Type', value: coreRule.referenceType ?? 'Character Core' });
          why.push(`Reference Type: ${compactRule.referenceType} → ${coreRule.referenceType}`);
          // The Reference's body is kept; sections the new pages now own are warned about.
          const overlap = await overlapWarnings(env, target.identity, pages);
          warnings.push(...overlap);
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
function planExisting(
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
  const lines = children.map((c) => {
    const label = c.name.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
    return `- [${label}](lk://resources/${c.id})${c.scope ? `: ${c.scope}` : ''}`;
  });
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
): LkBlock[] {
  if (images.length === 0) return [...blocks];
  const add: LkBlock[] = [];
  for (const im of images) {
    const parts = fromMarkdown(
      `### ${im.label.replace(/^#+\s*/, '')}\n\n${im.interpretation}\n`,
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
  const subfolders = type.assets.subfolders;
  for (const [i, im] of o.images.entries()) {
    const where = `${o.page}: images[${i}]`;
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
    const row = images.staged(ctx.projectId, im.staged_id);
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
    let sub: string[] = [];
    if (im.subfolder) {
      const m = /^\s*([^/]+?)\s*(?:\/\s*(.+?)\s*)?$/.exec(im.subfolder);
      const head = m?.[1] ?? '';
      const kind = Object.entries<string>(subfolders).find(([, v]) => textKey(v) === textKey(head));
      if (!kind || (kind[0] !== 'details' && !m?.[2]) || (kind[0] === 'details' && m?.[2])) {
        o.refuse(
          'SUBFOLDER_INVALID',
          `${where}: subfolder is “${subfolders.form} / <named form>”, “${subfolders.outfit} / <named outfit>” or “${subfolders.details}”.`,
        );
        continue;
      }
      sub = kind[0] === 'details' ? [kind[1]] : [kind[1], m![2]!];
    }
    const name = type.assets.displayName.replace(/\{Subject\}/g, o.subject).replace(/\{Label\}/g, im.label);
    if (out.some((x) => x.name === name && x.subfolder === (sub.join(' / ') || null))) {
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
    const free =
      p.destination.folderId && p.wouldCreate.length === 0
        ? images.freeName(ctx.projectId, p.destination.folderId, name)
        : name;
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
    });
  }
  return out;
}

/** What a routing change needs of the plan's environment (F3a's character tool and F3b's owner tool alike). */
export type RoutingEnv = Pick<PlanEnv, 'pd' | 'mctx' | 'tool' | 'ctx'> & {
  readonly type: Pick<TypeRules, 'index'>;
};

/**
 * One routing line, F3a's pattern: `- [<page name>](lk://resources/<id>): <Scope>`. CR-2026-11-R2 (R2-37): ONE line:
 * any line break in the name or Scope is collapsed to a space, so a Scope can never add a heading or a paragraph.
 */
export const routingLine = (c: {
  readonly rawName: string;
  readonly id: string;
  readonly scope: string | null;
}) => {
  const scope = c.scope ? oneLine(c.scope) : '';
  return `- [${oneLine(c.rawName).replace(/\[/g, '\\[').replace(/\]/g, '\\]')}](lk://resources/${c.id})${scope ? `: ${scope}` : ''}`;
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
  const label = to.rawName.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
  const before = lines[hits[0]!]!;
  const after = before.replace(link, `[${label}](lk://resources/${to.id})`);
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
async function overlapWarnings(env: PlanEnv, page: NodeRef, pages: readonly PlannedPage[]): Promise<Issue[]> {
  const node = env.ctx.tree.node(env.ctx.projectId, page.id).data;
  const doc =
    node?.documents.find((d) => d.name === 'Main') ?? node?.documents.find((d) => d.type === 'page');
  if (!node || !doc) return [];
  const read = await liveRead(env.pd, env.mctx, env.tool, 'getDocumentBlocks', {
    path: { resourceId: page.id, documentId: doc.id },
  });
  if (!read.ok) return [];
  const blocks = (read.value as { blocks?: LkBlock[] }).blocks ?? [];
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
