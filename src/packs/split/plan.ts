/**
 * `arkona_split_owner`'s plan (v3 F3e, ADR 0059; the owner-approved design docs/design/F3e-splits.md, section 2, "C2").
 *
 * The bridge never decides what to split: the agent brings a DESTINATION MAP the owner asked for, and the plan proves,
 * before anything is proposed, that nothing is lost or duplicated (Character Architecture's Monolith Migration
 * Procedure, steps 1 to 9; Lifecycle & Repository Maintenance's Splits and Replacement):
 *
 * - **D1, the map**: every section of the source's main document (and, where a section must be divided, each block in
 *   it) goes to exactly one destination: a NEW owner (through F3a's rules for a character's pages, F3b's for any other
 *   owner: names, templates, tags, AU and lifecycle, placement in the character's index), an EXISTING owner (appended
 *   under a heading the agent gives), a RELATIONSHIP owner (existing, or new by F3b's relationship rules), `stays`, or
 *   UNIVERSAL (D3: not migrated; the agent's subject-specific application text replaces it and the universal owner
 *   becomes a Dependency).
 * - **The checks before anything is proposed**: coverage (every block exactly once: `SPLIT_COVERAGE` with the list), no
 *   duplicated authority, the visual audit (step 5), the relationship audit (step 3, a warning), the universal audit
 *   (step 4), an interface summary for every moved section when the source survives, and the incoming Dependencies from
 *   F3c's change impact (D5: every one mapped when the source is to be retired).
 * - **Phase 1, one job** (always a canonical proposal, D7): the new owners made and the moved blocks written verbatim
 *   (ids kept where LegendKeeper allows), the existing owners extended, then a check that every destination holds what
 *   it receives BEFORE anything leaves the source, then the source's own edits (each item's blocks out, its interface
 *   summary in), the index lines, the remapped Dependencies, Last Major Revision by ADR 0051's rule per page, and the
 *   verification (a direct re-read of the affected graph). Phase 2 (D2, the source archived) is a SEPARATE proposal the
 *   bridge makes once phase 1 has verified (src/packs/split/service.ts).
 * - **Items (F3d)**: each destination is an item; its steps include its own source edit, so a destination left out
 *   leaves its sections in the source (D6) and coverage always holds. A universal assignment whose application text
 *   stays in the source is an item of its own; index lines and remapped Dependencies hang off their destinations.
 */
import { randomBytes } from 'node:crypto';
import { impactOf } from '../../appraisal/impact.js';
import { expandFacts } from '../../facts/expand.js';
import { FactsPlanError, planFacts } from '../../facts/plan.js';
import { sidebarFrom, type SidebarProperty } from '../../facts/sidebar.js';
import { mintClientId } from '../../jobs/ids.js';
import {
  EXPECT_STEP,
  LMR_STEP,
  VERIFY_STEP,
  type ExpectCheck,
  type VerifyTarget,
} from '../../jobs/internal-steps.js';
import { textChangeEntry, validateItems, withStepDependencies, type PlanItem } from '../../jobs/items.js';
import type { LmrMode } from '../../jobs/lmr-hook.js';
import type { ItemPartShape, LifecycleMarker, StepSpec } from '../../jobs/types.js';
import { fromMarkdown, MarkdownError, toMarkdown, type LkBlock } from '../../markdown/index.js';
import type { McpToolContext, McpToolResult } from '../../mcp/server.js';
import { liveRead } from '../../mcp/tools/repo.js';
import type { ProjectDeps } from '../../mcp/tools/shape.js';
import { pageConverterContext } from '../../pages/index.js';
import { cleanPrefixes } from '../../registry/names.js';
import { blockIds, unwritableBlocks } from '../../snapshots/canonical.js';
import type { TreeNode } from '../../tree/index.js';
import { buildPackJob, coreTextStep, PACK_CHECKS, shiftStep, type PackJob } from '../engine/job.js';
import { coreNeed, coreTextChanges, coreTextWords, ownersInIndex } from '../engine/core.js';
import { itemizePackage } from '../engine/items.js';
import { planOwner } from '../engine/owner.js';
import {
  planPackage,
  routingLine,
  type ExistingChange,
  type PackagePage,
  type PackPlan,
  type PlanEnv,
} from '../engine/plan.js';
import { textKey } from '../engine/text.js';
import { GENERIC_HOOK } from '../hooks.js';
import { characterEnv, envOf, type PackBasis } from '../run.js';
import type { SplitsRules } from '../types.js';
import {
  blockText,
  findHeading,
  fingerprint,
  holdsImage,
  holdsUnsupported,
  mentionedIn,
  outlineOf,
  PREAMBLE,
  textPrint,
  contentPrint,
  type AppendInput,
  type OutlineHeading,
  type RouteInput,
  type SourceEditInput,
} from './blocks.js';
import {
  mainDocumentOf,
  SPLIT_CHECKS,
  SPLIT_REBASERS,
  type DestRef,
  type DestinationsCheckInput,
  type SourceCheckInput,
  type VerifyCheckInput,
} from './checks.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export const SPLIT_TOOL = 'arkona_split_owner';
export const STAYS = 'stays';

/** The item groups, in the order the plan lists them. */
export const SPLIT_GROUPS = {
  destinations: 'Destinations',
  universal: 'Universal material',
  index: 'Character index',
  existing: 'Changes to existing pages',
  routing: 'Index lines',
  dependencies: 'Dependencies',
} as const;

// ============================================================================================ input

export interface SplitDestinationInput {
  /** The key the map names it by (`biography`, `powers`…). */
  readonly key: string;
  readonly kind: 'new' | 'existing' | 'relationship' | 'universal';
  // A new owner of a character's set (F3a): its role (`specialist`, `art`), title, Reference Type, specialist tag.
  readonly role?: string | undefined;
  readonly title?: string | undefined;
  readonly referenceType?: string | undefined;
  readonly specialistTag?: string | undefined;
  // A new owner of any other source (F3b): its type, name (Subject), descriptor, home and Temporal Scope.
  readonly type?: string | undefined;
  readonly name?: string | undefined;
  readonly descriptor?: string | undefined;
  readonly home?: string | undefined;
  readonly homeOverride?: { readonly reason: string } | undefined;
  readonly nation?: string | undefined;
  readonly temporalScope?: string | undefined;
  /** A new owner's Scope (required: it is set, and verified, and its index line says it). */
  readonly scope?: string | undefined;
  /** A new owner's Purpose (Markdown; `## Purpose` is added when it has no heading). */
  readonly purpose?: string | undefined;
  /**
   * A new owner's Dependencies. ADR 0059 amendment 1: the source's own Dependencies are its starting list (the plan
   * suggests them; the agent keeps those it relies on); an empty list needs `noDependencies` with a reason.
   */
  readonly dependencies?: readonly string[] | undefined;
  /** ADR 0059 amendment 1: a new owner with no Dependencies says so, with a reason the proposal shows the owner. */
  readonly noDependencies?: { readonly reason: string } | undefined;
  /**
   * ADR 0059 amendment 1: a new owner's Source Boundaries and Unresolved Material, supplied by the agent (Markdown; the
   * section's heading is added when the text has none). With items moved to it from the source's own section, the text
   * follows them. The bridge never writes these sections' content itself.
   */
  readonly sourceBoundaries?: string | undefined;
  readonly unresolvedMaterial?: string | undefined;
  /** ADR 0059 amendment 1: the section does not apply to this new owner, with a reason the proposal shows the owner. */
  readonly notApplicable?:
    | { readonly sourceBoundaries?: string | undefined; readonly unresolvedMaterial?: string | undefined }
    | undefined;
  readonly related?: readonly string[] | undefined;
  // An existing owner, or an existing relationship owner: the page; the heading the material goes under.
  readonly page?: string | undefined;
  readonly under?: string | undefined;
  // A new relationship owner (F3b's relationship rules): the other character and the label.
  readonly with?: string | undefined;
  readonly label?: string | undefined;
  // Universal (D3): the universal owner, the subject-specific application text, and where it goes.
  readonly owner?: string | undefined;
  readonly text?: string | undefined;
  /** `source` (the default when the rest of its section stays) or a destination's key. */
  readonly in?: string | undefined;
}

export interface SplitMapEntry {
  /** A heading's text or its block id (`(preamble)` for the blocks before the first heading). */
  readonly section: string;
  /** A destination's key, or `stays`; leave it out when the section is divided block by block. */
  readonly to?: string | undefined;
  /** D1: the section divided, block by block (every block of the section in exactly one group). */
  readonly blocks?:
    | readonly {
        readonly ids: readonly string[];
        readonly to: string;
        readonly summary?: string | undefined;
        readonly under?: string | undefined;
      }[]
    | undefined;
  /** The interface summary the source keeps where the section was (Markdown; required when the source survives). */
  readonly summary?: string | undefined;
  /** The heading the material goes under in its destination (an existing owner's default is its destination's). */
  readonly under?: string | undefined;
}

export interface SplitInput {
  readonly source: string;
  /** D2: archive the source once phase 1 has verified (a separate proposal). Default false: the source survives. */
  readonly retire?: boolean | undefined;
  readonly destinations: readonly SplitDestinationInput[];
  readonly map: readonly SplitMapEntry[];
  /** D5: incoming Dependencies remapped to the destination each page actually needs. */
  readonly dependencies?:
    | readonly { readonly page: string; readonly to: string; readonly keepSource?: boolean | undefined }[]
    | undefined;
  readonly lastMajorRevision?: LmrMode | undefined;
}

export interface Issue {
  readonly code: string;
  readonly message: string;
  readonly [k: string]: unknown;
}

// ============================================================================================ the plan

export interface PlannedDestination {
  readonly key: string;
  readonly kind: SplitDestinationInput['kind'];
  readonly item: string;
  /** Its page (a new page's id is minted by the plan). */
  readonly page: { readonly id: string; readonly name: string } | null;
  readonly isNew: boolean;
  /** Its main document, when known now (an existing owner's). */
  readonly documentId: string | null;
  /** Its sections (or `section › n blocks`), in source order. */
  readonly sections: string[];
  readonly blocks: string[];
  readonly words: number;
  readonly images: number;
  readonly visual: boolean;
  readonly relationship: boolean;
  /** Universal: the owner and where its application text goes. */
  readonly universal?: { readonly owner: { id: string; name: string }; readonly in: string };
}

export interface SplitPlan {
  readonly splitId: string;
  readonly source: {
    readonly id: string;
    readonly name: string;
    readonly kind: 'character' | 'owner';
    readonly lifecycle: 'authoritative' | 'working';
    readonly subject: string;
    readonly documentId: string;
    readonly identity: boolean;
  };
  readonly retire: boolean;
  readonly destinations: readonly PlannedDestination[];
  /** Each section and where it goes. */
  readonly sections: readonly { readonly section: string; readonly to: string; readonly blocks: number }[];
  readonly items: PlanItem[];
  readonly steps: StepSpec[];
  readonly labels: string[];
  readonly marker: LifecycleMarker;
  readonly refusals: Issue[];
  readonly warnings: Issue[];
  readonly notes: string[];
  readonly dependencies: {
    readonly mapped: readonly { page: { id: string; name: string }; to: string; keepSource: boolean }[];
    readonly unmapped: readonly { id: string; name: string }[];
    readonly chronology: readonly { page: { id: string; name: string }; snippet: string | null }[];
  };
  readonly summaries: readonly { readonly section: string; readonly to: string; readonly text: string }[];
  /**
   * ADR 0059 amendment 1: how each new owner addresses the source's Source Boundaries and Unresolved Material, and its
   * Dependencies; the source's own Dependencies, each new owner's starting list.
   */
  readonly completeness: SplitCompleteness;
  /** ADR 0059 amendment 1: what is still owed once the split has run (sections, Dependencies), each with its tool. */
  readonly nextSteps: readonly SplitNextStep[];
  readonly indexEntries: readonly { readonly index: string; readonly line: string }[];
  /** Block ids: how many moved blocks keep theirs, and those that cannot move (LegendKeeper cannot create them). */
  readonly ids: { readonly kept: number; readonly note: string };
  /**
   * CR-2026-11-R3 (R3-66): the source, a Compact Character Reference left at the head of several owners, upgraded to its
   * Character Core in this proposal (null: no upgrade). Revert puts it back with the deletion of the pages the split made.
   */
  readonly upgrade: SplitUpgrade | null;
  readonly lmr: {
    readonly mode: LmrMode;
    readonly newPages: readonly string[];
    readonly measured: readonly string[];
    readonly switchedOff: boolean;
  };
  readonly cost: { readonly planReads: number; readonly jobReads: number; readonly jobWrites: number };
  readonly summary: string;
  readonly prefetched: { op: string; path: Record<string, string>; body: unknown }[];
  readonly operations: Obj[];
}

/** ADR 0059 amendment 1: the frame sections a new owner addresses (the input field, and the section's heading). */
export type FrameField = 'sourceBoundaries' | 'unresolvedMaterial';

export interface SplitCompleteness {
  /** The source's own Dependencies: each new owner's starting list (the agent keeps those it relies on). */
  readonly suggestedDependencies: readonly { readonly id: string; readonly name: string }[];
  readonly owners: readonly {
    readonly key: string;
    readonly page: { readonly id: string; readonly name: string } | null;
    readonly sections: readonly {
      readonly section: string;
      /**
       * `moved` (items from the source's own section), `supplied` (the agent's text), both, not applicable (the agent's
       * answer, with its reason), or (CR-2026-11-R4) not expected: the pack does not expect this kind of page to carry it.
       */
      readonly by: 'moved' | 'supplied' | 'moved and supplied' | 'not applicable' | 'not expected';
      readonly reason?: string;
    }[];
    readonly dependencies: { readonly count: number } | { readonly none: string };
  }[];
}

export interface SplitNextStep {
  readonly page: { readonly id: string; readonly name: string } | null;
  readonly what: string;
  /** The tool that does it. */
  readonly tool: string;
}

/** CR-2026-11-R3 (R3-66): a split's in-place upgrade of its Compact source to the Character Core (what Revert undoes). */
export interface SplitUpgrade {
  readonly resourceId: string;
  /** Its name before (the Compact Character Reference's) and after (the Character Core's). */
  readonly from: string;
  readonly to: string;
  /** The key-value property and its Reference Type before and after. */
  readonly property: string;
  readonly referenceType: { readonly before: string | null; readonly after: string };
  readonly templates: { readonly compact: string | null; readonly core: string };
}

export interface SplitEnv {
  readonly pd: ProjectDeps;
  readonly mctx: McpToolContext;
  readonly basis: PackBasis;
  readonly appraisal: NonNullable<NonNullable<ProjectDeps['services']>['appraisal']>;
}

export class PlanReadError extends Error {
  constructor(readonly result: McpToolResult) {
    super('a read of the plan failed');
  }
}

const issue = (code: string, message: string, more: Obj = {}): Issue => ({ code, message, ...more });

const words = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** Every block in a tree, with a minted id where it has none. */
function withIds(blocks: readonly unknown[]): Obj[] {
  return blocks.filter(isObj).map((b) => ({
    ...b,
    id: typeof b.id === 'string' && b.id !== '' ? b.id : mintClientId(),
    ...(Array.isArray(b.children) ? { children: withIds(b.children as unknown[]) } : {}),
  }));
}

/**
 * The exact link a summary or an application text ends with: a plain mention (no custom label, which Arkona's repository
 * does not use; LegendKeeper shows the page's current name), in a sentence of its own.
 */
const seeLink = (resourceId: string, tail = '.'): Obj => ({
  id: mintClientId(),
  kind: 'paragraph',
  content: [{ text: 'See ' }, { mention: { resourceId } }, { text: tail }],
});

/** A deep copy of a block (moved verbatim: its ids and every attribute kept). */
const copy = (b: Obj): Obj => JSON.parse(JSON.stringify(b)) as Obj;

type Destination = SplitDestinationInput & { readonly item: string };

interface Resolved {
  readonly d: Destination;
  page: { id: string; name: string } | null;
  node: TreeNode | null;
  documentId: string | null;
  isNew: boolean;
  visual: boolean;
  relationship: boolean;
  universalOwner?: { id: string; name: string };
  universalIn?: string;
}

/** A moved run: consecutive blocks of one map entry (or block group) going to one destination. */
interface Assignment {
  readonly to: string;
  readonly entry: number;
  readonly group: number | null;
  readonly summary: string | null;
  readonly under: string | null;
  /** The top-level section it belongs to (for the interface summaries and the relationship audit). */
  readonly top: string;
}

// ============================================================================================ planning

export async function planSplit(
  env: SplitEnv,
  input: SplitInput,
): Promise<
  { ok: true; plan: SplitPlan } | { ok: false; result?: McpToolResult; refusals?: Issue[]; partial?: Obj }
> {
  const { mctx, basis } = env;
  // Every read the plan makes (its own, and the pack engine's for the new pages) is counted: the preview states it.
  let reads = 0;
  const pd: ProjectDeps = {
    ...env.pd,
    engine: new Proxy(env.pd.engine, {
      get(t, k) {
        const v = Reflect.get(t, k) as unknown;
        if (k === 'run')
          return (...a: Parameters<typeof t.run>) => {
            reads++;
            return t.run(...a);
          };
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    }),
  };
  const ctx = basis.ctx;
  const projectId = ctx.projectId;
  const rules = basis.pack.rules;
  const s: SplitsRules | undefined = rules.splits;
  if (!s)
    return {
      ok: false,
      refusals: [
        issue(
          'SPLIT_RULES_MISSING',
          'The Arkona pack version the owner approved has no split rules yet (they came with v3 F3e): approve the new pack version on the Packs page first.',
        ),
      ],
    };
  const refusals: Issue[] = [];
  const warnings: Issue[] = [];
  const notes: string[] = [];
  const prefetched: SplitPlan['prefetched'] = [];
  const read = async (op: string, params: Record<string, unknown>): Promise<unknown> => {
    const r = await liveRead(pd, mctx, SPLIT_TOOL, op, params);
    if (!r.ok) throw new PlanReadError(r.result);
    return r.value;
  };
  const retire = input.retire === true;
  const splitId = `sp_${randomBytes(8).toString('hex')}`;
  const deps = rules.sidebar.dependencies;
  const prop = rules.sidebar.property;
  const ctype = rules.types.find((t) => t.hook === 'character') ?? rules.types[0]!;
  const unresolvedHeading = ctype.text.unresolved;

  // ---------------------------------------------------------------------------------------------- the source
  const resolveNode = (ref: string): { node: TreeNode } | { issue: Issue } => {
    const direct = ctx.tree.node(projectId, ref.trim()).data;
    if (direct) return { node: direct };
    const q = cleanPrefixes(ref).name.trim() || ref.trim();
    const r = ctx.types.resolve(q, {});
    if (r.status === 'ambiguous')
      return {
        issue: issue(
          'PAGE_AMBIGUOUS',
          `“${ref}” names ${r.candidates.length} pages; pass the id of the one meant.`,
          {
            candidates: r.candidates.map((c) => ({ id: c.id, name: c.rawName })),
          },
        ),
      };
    if (r.status !== 'resolved')
      return { issue: issue('PAGE_NOT_FOUND', `No page is named “${ref}” (by id, name, alias or path).`) };
    const n = ctx.tree.node(projectId, r.node.id).data;
    return n ? { node: n } : { issue: issue('PAGE_NOT_FOUND', `No page ${ref}.`) };
  };
  const src = resolveNode(input.source);
  if ('issue' in src) return { ok: false, refusals: [{ ...src.issue, code: `SOURCE_${src.issue.code}` }] };
  const node = src.node;
  const lifecycleIds = new Set(
    [basis.lifecycle.workingIndexId, basis.lifecycle.archiveIndexId].filter(Boolean),
  );
  if (node.kind === 'index' || node.kind === 'root' || lifecycleIds.has(node.id))
    return {
      ok: false,
      refusals: [
        issue(
          'SPLIT_SOURCE_INDEX',
          `${node.rawName} is an index: a split takes an owner page (an index only routes; its pages are owners of their own).`,
        ),
      ],
    };
  if (node.kind === 'barc')
    return {
      ok: false,
      refusals: [
        issue(
          'SPLIT_SOURCE_ARCHIVED',
          `${node.rawName} is Archived: its record is kept as it is. Unarchive it first if it is to be split.`,
        ),
      ],
    };
  if (node.kind !== 'bsrc' && node.kind !== 'bwrk')
    return {
      ok: false,
      refusals: [
        issue(
          'SPLIT_SOURCE_UNCLASSIFIED',
          `${node.rawName} is neither an Authoritative [BSRC] nor a Working [BWRK] page: its lifecycle is the owner's to sort out first.`,
        ),
      ],
    };
  const lifecycle: 'authoritative' | 'working' = node.kind === 'bsrc' ? 'authoritative' : 'working';
  const ch = ctx.types.characterOfPage(node.id);
  const parentNode = node.parentId ? ctx.tree.node(projectId, node.parentId).data : null;
  const character =
    ch.ok &&
    (ch.value.core.id === node.id ||
      (parentNode?.kind === 'index' && textKey(parentNode.displayName) === textKey(ch.value.subject)))
      ? ch.value
      : null;
  const subject = character
    ? character.subject || cleanPrefixes(node.displayName).name.split(' - ')[0]!.trim()
    : node.displayName.split(' - ')[0]!.trim();
  const identity = character !== null && character.core.id === node.id;

  let resource: Obj;
  let blocks: Obj[];
  let documentId: string;
  let sidebar: SidebarProperty[];
  try {
    resource = (await read('getResource', { path: { resourceId: node.id } })) as Obj;
    prefetched.push({ op: 'getResource', path: { resourceId: node.id }, body: resource });
    sidebar = sidebarFrom({ data: Array.isArray(resource.properties) ? resource.properties : [] });
    const doc = mainDocumentOf(resource);
    if (!doc)
      return {
        ok: false,
        refusals: [issue('SPLIT_NO_PAGE_DOCUMENT', `${node.rawName} has no main page document to split.`)],
      };
    documentId = doc;
    const body = (await read('getDocumentBlocks', { path: { resourceId: node.id, documentId } })) as Obj;
    prefetched.push({ op: 'getDocumentBlocks', path: { resourceId: node.id, documentId }, body });
    blocks = Array.isArray(body.blocks) ? (body.blocks as unknown[]).filter(isObj) : [];
  } catch (e) {
    if (e instanceof PlanReadError) return { ok: false, result: e.result };
    throw e;
  }
  // A legacy page (a block without an id, an id used twice) waits for the block-id sweep (ADR 0056).
  const ids = blocks.map((b) => str(b.id));
  const dup = ids.filter((x, i) => x !== null && ids.indexOf(x) !== i);
  if (ids.some((x) => x === null || x === '') || dup.length > 0)
    return {
      ok: false,
      refusals: [
        issue(
          'SPLIT_BLOCK_IDS_PENDING',
          `${node.rawName} is a legacy page (blocks without ids, or an id used twice): its blocks cannot be assigned one by one until the block-id sweep has given them ids.`,
        ),
      ],
    };
  const o = outlineOf(blocks);
  const excerpt = (id: string) => blockText(o.byId.get(id) ?? {}).slice(0, 120);
  const titleOfTop = (id: string) => o.headings.find((h) => h.id === id)?.title ?? PREAMBLE;

  // ---------------------------------------------------------------------------------------------- the destinations
  const dests = new Map<string, Resolved>();
  for (const [i, d0] of input.destinations.entries()) {
    const key = (d0.key ?? '').trim();
    if (key === '' || textKey(key) === STAYS) {
      refusals.push(
        issue('SPLIT_DESTINATION_KEY', `destinations[${i}]: a key is required (and “stays” is reserved).`),
      );
      continue;
    }
    if (dests.has(key)) {
      refusals.push(issue('SPLIT_DESTINATION_KEY', `Two destinations are both “${key}”.`));
      continue;
    }
    const d: Destination = {
      ...d0,
      key,
      item: d0.kind === 'universal' ? `universal:${key}` : `dest:${key}`,
    };
    const r: Resolved = {
      d,
      page: null,
      node: null,
      documentId: null,
      isNew: d.kind === 'new' || (d.kind === 'relationship' && !d.page),
      visual: false,
      relationship: d.kind === 'relationship',
    };
    dests.set(key, r);
    if (d.kind === 'existing' || (d.kind === 'relationship' && d.page)) {
      if (!d.page) {
        refusals.push(issue('SPLIT_DESTINATION_PAGE', `${key}: an existing owner needs its page.`));
        continue;
      }
      const hit = resolveNode(d.page);
      if ('issue' in hit) {
        refusals.push({ ...hit.issue, destination: key });
        continue;
      }
      const n = hit.node;
      if (n.id === node.id) {
        refusals.push(
          issue(
            'SPLIT_DESTINATION_SOURCE',
            `${key}: the source cannot be its own destination (use “stays”).`,
          ),
        );
        continue;
      }
      if (n.kind !== 'bsrc' && n.kind !== 'bwrk') {
        refusals.push(
          issue(
            'SPLIT_DESTINATION_NOT_OWNER',
            `${key}: ${n.rawName} is ${n.kind === 'index' ? 'an index' : n.kind === 'barc' ? 'Archived' : 'not an owner page'}: material goes to a current owner page.`,
          ),
        );
        continue;
      }
      if ((n.kind === 'bsrc') !== (lifecycle === 'authoritative')) {
        refusals.push(
          issue(
            'SPLIT_LIFECYCLE_MISMATCH',
            `${key}: ${n.rawName} is ${n.kind === 'bsrc' ? 'Authoritative' : 'Working'} but ${node.rawName} is ${lifecycle === 'authoritative' ? 'Authoritative' : 'Working'}: moving material between canon and Working is promote_page's or move_to_working's, not a split's.`,
          ),
        );
        continue;
      }
      const doc =
        n.documents.find((x) => x.name === 'Main' && (x.type === 'page' || x.type === 'blank')) ??
        (n.documents.filter((x) => x.type === 'page').length === 1
          ? n.documents.find((x) => x.type === 'page')
          : undefined);
      if (!doc) {
        refusals.push(
          issue('SPLIT_NO_PAGE_DOCUMENT', `${key}: ${n.rawName} has no main page document to append to.`),
        );
        continue;
      }
      if (!(d.under ?? '').trim() && !input.map.some((e) => e.to === key && (e.under ?? '').trim()))
        refusals.push(
          issue(
            'SPLIT_UNDER_REQUIRED',
            `${key}: material appended to ${n.rawName} goes under a heading the agent gives (under).`,
          ),
        );
      r.page = { id: n.id, name: n.rawName };
      r.node = n;
      r.documentId = doc.id;
      r.visual =
        s.visual.referenceTypes.some((v) => textKey(v) === textKey(n.referenceType ?? '')) ||
        n.tags.some((t) => s.visual.tags.some((v) => textKey(v) === textKey(t)));
      r.relationship =
        / & .+ - /.test(n.displayName) ||
        textKey(n.referenceType ?? '') === textKey('Joint Character Relationship Reference');
      if (d.kind === 'relationship' && !r.relationship)
        refusals.push(
          issue(
            'SPLIT_NOT_A_RELATIONSHIP',
            `${key}: ${n.rawName} is not a relationship owner (a “<A> & <B> - …” page).`,
          ),
        );
    } else if (d.kind === 'new' || d.kind === 'relationship') {
      if (!(d.purpose ?? '').trim())
        refusals.push(
          issue('SPLIT_PURPOSE_REQUIRED', `${key}: a new owner needs its Purpose (purpose, Markdown).`),
        );
      if (!(d.scope ?? '').trim())
        refusals.push(
          issue(
            'SPLIT_SCOPE_REQUIRED',
            `${key}: a new owner needs its Scope (it is set, verified and routed).`,
          ),
        );
      if (d.kind === 'relationship' && !character)
        refusals.push(
          issue(
            'SPLIT_RELATIONSHIP_NOT_CHARACTER',
            `${key}: a new relationship owner is a joint page of two characters; ${node.rawName} is not a character's page.`,
          ),
        );
      if (d.kind === 'relationship' && !(d.with ?? '').trim())
        refusals.push(
          issue(
            'SPLIT_RELATIONSHIP_WITH',
            `${key}: a new relationship owner names the other character (with).`,
          ),
        );
      const role = d.kind === 'relationship' ? 'relationship' : (d.role ?? (character ? 'specialist' : null));
      r.visual =
        (role !== null && s.visual.roles.includes(role)) ||
        s.visual.referenceTypes.some((v) => textKey(v) === textKey(d.referenceType ?? ''));
      if (!character && d.kind === 'new' && !(d.type ?? '').trim())
        refusals.push(
          issue('SPLIT_OWNER_TYPE', `${key}: a new owner of ${node.rawName} needs its owner type (type).`),
        );
    } else if (d.kind === 'universal') {
      if (!(d.text ?? '').trim())
        refusals.push(
          issue(
            'SPLIT_UNIVERSAL_TEXT_REQUIRED',
            `${key}: universal material is not migrated; give the subject-specific application text that replaces it (text).`,
          ),
        );
      if (!(d.owner ?? '').trim()) {
        refusals.push(
          issue('SPLIT_UNIVERSAL_OWNER_REQUIRED', `${key}: name the universal owner it belongs to (owner).`),
        );
        continue;
      }
      const hit = resolveNode(d.owner!);
      if ('issue' in hit) {
        refusals.push({ ...hit.issue, code: 'SPLIT_UNIVERSAL_OWNER_NOT_FOUND', destination: key });
        continue;
      }
      const n = hit.node;
      const primaries = (rules.owners?.types ?? [])
        .filter((t) => s.universalTypes.some((u) => textKey(u) === textKey(t.name)))
        .map((t) => textKey(t.primary));
      const inSet = ctx.types.characterOfPage(n.id);
      if (
        n.kind !== 'bsrc' ||
        n.id === node.id ||
        !n.tags.some((t) => primaries.includes(textKey(t))) ||
        (inSet.ok && (inSet.value.core.id === n.id || inSet.value.via !== 'subject'))
      )
        refusals.push(
          issue(
            'SPLIT_UNIVERSAL_OWNER_NOT_UNIVERSAL',
            `${key}: ${n.rawName} is not a current universal owner (an Authoritative page of a universal type: ${s.universalTypes.join(', ')}). A Dependency names a current Authoritative owner only.`,
          ),
        );
      r.universalOwner = { id: n.id, name: n.rawName };
    } else {
      refusals.push(
        issue('SPLIT_DESTINATION_KIND', `${key}: kind is new, existing, relationship or universal.`),
      );
    }
  }

  // ---------------------------------------------------------------------------------------------- the map (D1)
  const assigned = new Map<string, Assignment[]>();
  const headingUse = new Map<string, { entry: number; to: string }[]>();
  const assign = (id: string, a: Assignment) => assigned.set(id, [...(assigned.get(id) ?? []), a]);
  const topOf = (id: string): string => {
    const h = o.headings.filter((x) => x.blockIds.includes(id) && x.top === x.id);
    return h[0]?.id ?? PREAMBLE;
  };
  const notFound: string[] = [];
  const ambiguous: { section: string; headings: { id: string; title: string }[] }[] = [];
  const outside: { section: string; blocks: string[] }[] = [];
  for (const [i, e] of input.map.entries()) {
    let sectionBlocks: readonly string[];
    let heading: OutlineHeading | null = null;
    if (e.section === PREAMBLE) sectionBlocks = o.preamble;
    else {
      const f = findHeading(o, e.section);
      if (!f) {
        notFound.push(e.section);
        continue;
      }
      if ('ambiguous' in f) {
        ambiguous.push({
          section: e.section,
          headings: f.ambiguous.map((h) => ({ id: h.id, title: h.title })),
        });
        continue;
      }
      heading = f.heading;
      sectionBlocks = heading.blockIds;
    }
    if (sectionBlocks.length === 0) {
      notFound.push(e.section);
      continue;
    }
    const key = heading?.id ?? PREAMBLE;
    if (e.blocks && e.blocks.length > 0) {
      const set = new Set(sectionBlocks);
      const out: string[] = [];
      e.blocks.forEach((g, gi) => {
        for (const id of g.ids) {
          if (!set.has(id)) {
            out.push(id);
            continue;
          }
          assign(id, {
            to: g.to,
            entry: i,
            group: gi,
            summary: g.summary ?? null,
            under: g.under ?? e.under ?? null,
            top: topOf(id),
          });
        }
      });
      headingUse.set(key, [
        ...(headingUse.get(key) ?? []),
        { entry: i, to: `divided (${[...new Set(e.blocks.map((g) => g.to))].join(', ')})` },
      ]);
      if (out.length > 0) outside.push({ section: e.section, blocks: out });
    } else {
      const to = (e.to ?? '').trim();
      if (to === '') {
        refusals.push(
          issue(
            'SPLIT_MAP_ENTRY',
            `map[${i}] (“${e.section}”): give to (a destination's key or “stays”), or blocks.`,
          ),
        );
        continue;
      }
      for (const id of sectionBlocks)
        assign(id, {
          to,
          entry: i,
          group: null,
          summary: e.summary ?? null,
          under: e.under ?? null,
          top: topOf(id),
        });
      headingUse.set(key, [...(headingUse.get(key) ?? []), { entry: i, to }]);
    }
  }
  if (notFound.length > 0)
    refusals.push(
      issue(
        'SPLIT_SECTION_NOT_FOUND',
        `The source has no section ${notFound.map((x) => `“${x}”`).join(', ')}. Its headings: ${o.headings.map((h) => `“${h.title}”`).join(', ') || 'none'}.`,
        {
          sections: notFound,
          headings: o.headings.map((h) => ({ id: h.id, title: h.title, level: h.level })),
        },
      ),
    );
  if (ambiguous.length > 0)
    refusals.push(
      issue(
        'SPLIT_SECTION_AMBIGUOUS',
        `${ambiguous.map((a) => `“${a.section}”`).join(', ')} names several headings: give the heading's block id instead.`,
        { ambiguous },
      ),
    );
  if (outside.length > 0)
    refusals.push(
      issue(
        'SPLIT_BLOCK_NOT_IN_SECTION',
        `Blocks assigned under a section they are not in: ${outside.map((x) => `${x.section}: ${x.blocks.join(', ')}`).join('; ')}.`,
        { outside },
      ),
    );
  // No duplicated authority: one section, one destination (block by block, each block once).
  const duplicated = [...headingUse.entries()]
    .filter(([, uses]) => uses.length > 1)
    .map(([h, uses]) => ({
      section:
        titleOfTop(h) === PREAMBLE && h !== PREAMBLE
          ? h
          : (o.headings.find((x) => x.id === h)?.title ?? PREAMBLE),
      destinations: uses.map((u) => u.to),
    }));
  if (duplicated.length > 0)
    refusals.push(
      issue(
        'SPLIT_DUPLICATED_AUTHORITY',
        `A section is listed more than once (${duplicated.map((d) => `“${d.section}” → ${d.destinations.join(' and ')}`).join('; ')}): one section, one destination (divide it block by block in ONE entry when it must be divided).`,
        { duplicated },
      ),
    );
  // Coverage: every block of the source exactly once.
  const unassigned = o.order.filter((id) => !assigned.has(id));
  const twice = o.order.filter((id) => (assigned.get(id)?.length ?? 0) > 1);
  if (unassigned.length > 0 || twice.length > 0)
    refusals.push(
      issue(
        'SPLIT_COVERAGE',
        `Every block of the source goes to exactly one destination: ${[
          unassigned.length > 0
            ? `${unassigned.length} block${unassigned.length === 1 ? ' is' : 's are'} not assigned`
            : null,
          twice.length > 0
            ? `${twice.length} block${twice.length === 1 ? ' is' : 's are'} assigned more than once`
            : null,
        ]
          .filter(Boolean)
          .join(' and ')}. Nothing is lost by omission: assign each (“stays” keeps it).`,
        {
          unassigned: unassigned.map((id) => ({
            block: id,
            section: titleOfTop(topOf(id)),
            text: excerpt(id),
          })),
          twice: twice.map((id) => ({
            block: id,
            section: titleOfTop(topOf(id)),
            text: excerpt(id),
            destinations: (assigned.get(id) ?? []).map((a) => a.to),
          })),
        },
      ),
    );
  const unknownDest = [...new Set([...assigned.values()].flat().map((a) => a.to))].filter(
    (to) => textKey(to) !== STAYS && !dests.has(to),
  );
  if (unknownDest.length > 0)
    refusals.push(
      issue(
        'SPLIT_DESTINATION_UNKNOWN',
        `The map names destinations that are not given: ${unknownDest.join(', ')} (or use “stays”).`,
        { unknown: unknownDest },
      ),
    );

  const toOf = (id: string): string => {
    const a = assigned.get(id)?.[0];
    return !a || textKey(a.to) === STAYS ? STAYS : a.to;
  };
  // Each destination's blocks, in source order.
  const blocksTo = new Map<string, string[]>();
  for (const id of o.order) {
    const to = toOf(id);
    if (to === STAYS) continue;
    blocksTo.set(to, [...(blocksTo.get(to) ?? []), id]);
  }
  for (const key of dests.keys())
    if ((blocksTo.get(key) ?? []).length === 0)
      refusals.push(
        issue('SPLIT_DESTINATION_EMPTY', `${key}: no section or block of the source is assigned to it.`, {
          destination: key,
        }),
      );

  // ---------------------------------------------------------------------------------------------- the audits
  // LegendKeeper cannot create an `unsupported` block: such content can only stay where it is.
  const cannot = o.order.filter((id) => toOf(id) !== STAYS && holdsUnsupported(o.byId.get(id)!));
  if (cannot.length > 0)
    refusals.push(
      issue(
        'SPLIT_UNSUPPORTED_BLOCK',
        `${cannot.length} block${cannot.length === 1 ? ' holds' : 's hold'} content LegendKeeper's API cannot create (unsupported): it can only stay in the source (${cannot.map((id) => `${titleOfTop(topOf(id))}: “${excerpt(id) || id}”`).join('; ')}).`,
        { blocks: cannot },
      ),
    );
  // CR-2026-11-R3 (R3-51): a block holding an inline icon (a run LegendKeeper's write format has no form for) cannot be
  // written back, and the split writes the source back whole (each source edit) and the moved blocks to their
  // destinations: refused before any page is made or anything copied, wherever the block goes.
  const iconBlocks = unwritableBlocks(o.order.map((id) => o.byId.get(id)!)).filter(
    (f) => f.what === 'inline-icon',
  );
  if (iconBlocks.length > 0) {
    const tops = [
      ...new Set(
        o.order.filter((id) => {
          const ids = blockIds([o.byId.get(id)!]);
          return iconBlocks.some((f) => f.blockId !== null && ids.has(f.blockId));
        }),
      ),
    ];
    refusals.push(
      issue(
        'SPLIT_NOT_WRITABLE',
        `${iconBlocks.length} block${iconBlocks.length === 1 ? ' holds' : 's hold'} an inline icon, which LegendKeeper's write format cannot write back; a split writes ${node.rawName} back whole, so it cannot be split while ${iconBlocks.length === 1 ? 'it is' : 'they are'} there (${tops.map((id) => `${titleOfTop(topOf(id))}: “${excerpt(id) || id}”`).join('; ')}). Remove the icon in LegendKeeper (or write that text without it), then plan the split again.`,
        { blocks: iconBlocks.map((f) => f.blockId).filter((x): x is string => x !== null) },
      ),
    );
  }
  // Step 5, the visual audit: what interprets images goes to an Art or visual owner, or stays. CR-2026-11-R3 (R3-11): an
  // image assigned as universal material is refused too: universal material is removed from the source (its application
  // text takes its place), never moved, so the image would be on no page.
  const notVisual = o.order.filter((id) => {
    const to = toOf(id);
    if (to === STAYS || !holdsImage(o.byId.get(id)!)) return false;
    const r = dests.get(to);
    return r !== undefined && (r.d.kind === 'universal' || !r.visual);
  });
  const universalOf = (id: string) => dests.get(toOf(id))?.d.kind === 'universal';
  if (notVisual.length > 0)
    refusals.push(
      issue(
        'SPLIT_VISUAL',
        `Images go to an Art or visual owner (Character Architecture's visual audit), or stay: ${notVisual.map((id) => `${titleOfTop(topOf(id))} → ${toOf(id)}${universalOf(id) ? ' (universal material is removed, not moved: the image would be on no page)' : ''}`).join('; ')}. Divide the section block by block: the images and their interpretation to the Art page, the rest where it belongs.`,
        { blocks: notVisual.map((id) => ({ block: id, section: titleOfTop(topOf(id)), to: toOf(id) })) },
      ),
    );
  // Universal material (step 4): where its application text goes.
  for (const r of dests.values()) {
    if (r.d.kind !== 'universal') continue;
    const mine = blocksTo.get(r.d.key) ?? [];
    let into = (r.d.in ?? '').trim();
    if (into === '') {
      const around = new Set<string>();
      for (const id of mine) {
        const top = topOf(id);
        for (const other of o.order)
          if (topOf(other) === top && !mine.includes(other) && toOf(other) !== STAYS) around.add(toOf(other));
      }
      into = around.size === 1 ? [...around][0]! : 'source';
    }
    if (into !== 'source') {
      const t = dests.get(into);
      if (!t || t.d.kind === 'universal')
        refusals.push(
          issue('SPLIT_UNIVERSAL_IN', `${r.d.key}: in names no destination that takes text (${into}).`),
        );
    }
    r.universalIn = into;
  }
  // Step 3, the relationship audit (a character's page): a section about one other character goes to a relationship
  // owner. A warning: the owner judges.
  const known = knownCharacters(ctx, projectId);
  if (character) {
    for (const h of o.headings.filter((x) => x.top === x.id)) {
      const others = new Map<string, string>();
      for (const c of known) {
        if (textKey(c.subject) === textKey(subject)) continue;
        if (phrase(h.title, c.subject)) others.set(c.id, c.subject);
      }
      if (others.size === 0) {
        const ments = new Set<string>();
        for (const id of h.blockIds) mentionedIn(o.byId.get(id)!, ments);
        for (const m of ments) {
          const c = known.find((k) => k.id === m || k.pages.includes(m));
          if (c && textKey(c.subject) !== textKey(subject)) others.set(c.id, c.subject);
        }
        if (others.size === 0 || !isRelationshipHeading(h.title, s)) continue;
      }
      if (others.size !== 1) continue;
      const to = new Set(h.blockIds.map(toOf));
      const wrong = [...to].filter((t) => t !== STAYS && !dests.get(t)?.relationship);
      if (wrong.length > 0)
        warnings.push(
          issue(
            'SPLIT_RELATIONSHIP_SECTION',
            `“${h.title}” is about ${subject} and ${[...others.values()][0]} as joint subjects, but goes to ${wrong.join(', ')}, not a relationship owner (Character Architecture's relationship audit). The owner judges.`,
            { section: h.title, with: [...others.values()][0], to: wrong },
          ),
        );
    }
  }
  // Step 4: a block citing a universal owner the source depends on, migrated into a character-specific owner.
  const depRaw = sidebar.find((p) => textKey(p.title) === textKey(deps))?.raw;
  const depIds = new Set(
    (Array.isArray(depRaw?.items) ? (depRaw.items as unknown[]) : [])
      .filter(isObj)
      .map((x) => str(x.resourceId))
      .filter((x): x is string => x !== null),
  );
  const universalTypes = (rules.owners?.types ?? [])
    .filter((t) => s.universalTypes.some((u) => textKey(u) === textKey(t.name)))
    .map((t) => textKey(t.primary));
  for (const id of o.order) {
    const to = toOf(id);
    const r = dests.get(to);
    if (!r || r.d.kind === 'universal') continue;
    for (const m of mentionedIn(o.byId.get(id)!)) {
      if (!depIds.has(m)) continue;
      const n = ctx.tree.node(projectId, m).data;
      if (!n || !n.tags.some((t) => universalTypes.includes(textKey(t)))) continue;
      warnings.push(
        issue(
          'SPLIT_UNIVERSAL_CANDIDATE',
          `“${excerpt(id)}” (${titleOfTop(topOf(id))}) cites ${n.rawName}, a universal owner this page depends on, and moves to ${to}. If it restates ${n.rawName}'s rule, assign it as universal (not migrated; application text instead): “do not migrate universal rules into character-specific owners”.`,
          { block: id, owner: { id: n.id, name: n.rawName }, to },
        ),
      );
    }
  }
  // Interface summaries: one for every moved section when the source survives.
  const pairs = new Map<string, { to: string; top: string; first: string; summary: string | null }>();
  for (const id of o.order) {
    const to = toOf(id);
    const r = dests.get(to);
    if (!r || r.d.kind === 'universal') continue;
    const a = assigned.get(id)![0]!;
    const k = `${to}\u0000${a.top}`;
    const p = pairs.get(k);
    if (!p) pairs.set(k, { to, top: a.top, first: id, summary: a.summary });
    else if (!p.summary && a.summary) pairs.set(k, { ...p, summary: a.summary });
  }
  if (!retire) {
    const missing = [...pairs.values()].filter((p) => !(p.summary ?? '').trim());
    if (missing.length > 0)
      refusals.push(
        issue(
          'SPLIT_SUMMARY_REQUIRED',
          `The source survives, so each section that leaves it keeps a compact interface summary with an exact link (“replace duplicated sections in a surviving broad owner with compact interface summaries and exact links”): give summary for ${missing.map((p) => `“${titleOfTop(p.top)}” → ${p.to}`).join(', ')}.`,
          { missing: missing.map((p) => ({ section: titleOfTop(p.top), to: p.to })) },
        ),
      );
  }
  if (retire && identity)
    refusals.push(
      issue(
        'SPLIT_RETIRE_IDENTITY',
        `${node.rawName} is ${subject}'s identity page: retiring it would leave the character with none. Keep it as the surviving owner (its identity stays; retire: false), or make it a Core first (arkona_create_character upgradeToCore).`,
      ),
    );
  // A character with an index and several owners has a Character Core (Character Architecture). The split that leaves a
  // Compact Character Reference at the head of several owners upgrades it in place, in this same proposal, when it is the
  // surviving source (F3a's upgradeToCore: "<Name> - Character Core", Reference Type "Character Core", the Core
  // template recorded; its id, documents, identity facts, links and text kept). Any other map that would leave such a
  // character without a Core is refused.
  const core = (() => {
    if (!character || character.role !== 'compact') return null;
    const head = ctx.tree.node(projectId, character.core.id).data;
    const up = head?.parentId ? ctx.tree.node(projectId, head.parentId).data : null;
    const set = up?.kind === 'index' ? ctx.types.characterOfPage(up.id) : null;
    const index =
      up && set?.ok && set.value.core.id === character.core.id && set.value.via === 'index' ? up : null;
    // The owners the character keeps (a source to be retired leaves the set), and the new ones the split makes for it.
    // v3 F7.1 (ADR 0072): counted by the rule the package planner uses (src/packs/engine/core.ts).
    const others = index
      ? ownersInIndex(
          ctx.tree.children(projectId, index.id).data,
          character.core.id,
          retire ? new Set([node.id]) : undefined,
        )
      : 0;
    const made = [...dests.values()].filter((r) => r.isNew).length;
    const n = coreNeed({
      role: character.role,
      from: 'compact',
      hasIndex: index !== null,
      existing: others,
      added: made,
    });
    return { needed: n.needed, owners: n.owners, index };
  })();
  const upgradeToCore = core?.needed === true && identity && !retire;
  if (core?.needed === true && !identity && character)
    refusals.push(
      issue(
        'SPLIT_CORE_REQUIRED',
        `${subject} would have ${core.owners} owner pages in ${core.index?.rawName ?? 'an index'} and no Character Core: ${character.core.rawName} is a Compact Character Reference. A character with an index and several owners has a Character Core: upgrade it first (arkona_create_character with target “${character.core.rawName}” and upgradeToCore), then split.`,
        { identity: { id: character.core.id, name: character.core.rawName }, owners: core.owners },
      ),
    );
  if (retire) {
    const staying = o.headings
      .filter((h) => h.top === h.id && h.blockIds.every((id) => toOf(id) === STAYS))
      .map((h) => h.title);
    // CR-2026-11-R3 (R3-41): and what stays of a divided section, and the blocks before the first heading.
    const divided = o.headings
      .filter((h) => h.top === h.id && !h.blockIds.every((id) => toOf(id) === STAYS))
      .map((h) => ({ title: h.title, ids: h.blockIds.filter((id) => toOf(id) === STAYS) }))
      .filter((h) => h.ids.length > 0);
    const before = o.preamble.filter((id) => toOf(id) === STAYS);
    const parts = [
      ...(before.length > 0
        ? [`${PREAMBLE}: ${before.length} block${before.length === 1 ? '' : 's'} (“${excerpt(before[0]!)}”)`]
        : []),
      ...staying.map((x) => `“${x}”`),
      ...divided.map(
        (h) =>
          `part of “${h.title}”: ${h.ids.length} block${h.ids.length === 1 ? '' : 's'} (“${excerpt(h.ids[0]!)}”)`,
      ),
    ];
    if (parts.length > 0)
      warnings.push(
        issue(
          'SPLIT_RETIRED_CONTENT',
          `With retire, what stays is archived with the source (kept for provenance, no longer current): ${parts.join(', ')}.`,
          {
            sections: staying,
            ...(before.length > 0 ? { preamble: before } : {}),
            ...(divided.length > 0
              ? { divided: divided.map((h) => ({ section: h.title, blocks: h.ids })) }
              : {}),
          },
        ),
      );
  }

  // ---------------------------------------------------------------------------------------------- incoming Dependencies
  let incoming: { id: string; name: string }[] = [];
  let chronology: SplitPlan['dependencies']['chronology'] = [];
  try {
    const { reader } = await env.appraisal.reader(projectId);
    const drafts = await impactOf(
      {
        db: env.appraisal.d.db,
        projectId,
        reader,
        fullText: env.appraisal.fullText,
        dependenciesTitle: deps,
        relatedTitle: rules.sidebar.related,
        chronologyDocuments: new Set(env.appraisal.d.chronologyDocuments(projectId)),
        maxRestatements: 0,
      },
      { pageId: node.id, ...(retire ? { becomes: 'Archived' as const } : {}) },
    );
    const seen = new Set<string>();
    for (const d of drafts) {
      if (d.check !== 'incoming_link' && d.check !== 'link_to_noncurrent') continue;
      if (textKey(str((d.details as Obj).property) ?? '') !== textKey(deps) || !d.pageId) continue;
      if (seen.has(d.pageId)) continue;
      seen.add(d.pageId);
      incoming.push({
        id: d.pageId,
        name: ctx.tree.node(projectId, d.pageId).data?.rawName ?? reader.page(d.pageId)?.rawName ?? d.pageId,
      });
    }
    chronology = drafts
      .filter((d) => d.check === 'chronology_row' && d.pageId)
      .map((d) => ({
        page: { id: d.pageId!, name: reader.page(d.pageId!)?.rawName ?? d.pageId! },
        snippet: str((d.details as Obj).snippet),
      }));
  } catch (e) {
    warnings.push(
      issue(
        'SPLIT_IMPACT_UNAVAILABLE',
        `The incoming Dependencies could not be read from the snapshots (${e instanceof Error ? e.message : String(e)}).${retire ? ' A source to be retired needs them: nothing can be proposed until the snapshots are readable.' : ''}`,
      ),
    );
    if (retire)
      refusals.push(
        issue(
          'SPLIT_IMPACT_UNAVAILABLE',
          'The incoming Dependencies are not known: a source to be retired needs every one of them mapped.',
        ),
      );
    incoming = [];
  }
  const mapped: { page: { id: string; name: string }; to: string; keepSource: boolean }[] = [];
  for (const m of input.dependencies ?? []) {
    const hit = resolveNode(m.page);
    if ('issue' in hit) {
      refusals.push({ ...hit.issue, code: 'SPLIT_DEPENDENCY_NOT_FOUND' });
      continue;
    }
    if (!incoming.some((x) => x.id === hit.node.id)) {
      refusals.push(
        issue(
          'SPLIT_DEPENDENCY_NOT_INCOMING',
          `${hit.node.rawName} does not list ${node.rawName} in its ${deps} (as of the snapshots): nothing to remap.`,
        ),
      );
      continue;
    }
    const t = dests.get(m.to);
    if (!t || t.d.kind === 'universal') {
      refusals.push(
        issue(
          'SPLIT_DEPENDENCY_TO',
          `${hit.node.rawName}: map it to a destination that receives material (${m.to}).`,
        ),
      );
      continue;
    }
    if (m.keepSource && retire)
      refusals.push(
        issue(
          'SPLIT_DEPENDENCY_KEEPS_RETIRED',
          `${hit.node.rawName}: a source to be retired cannot be kept as a Dependency.`,
        ),
      );
    mapped.push({
      page: { id: hit.node.id, name: hit.node.rawName },
      to: m.to,
      keepSource: m.keepSource === true,
    });
  }
  const unmapped = incoming.filter((x) => !mapped.some((m) => m.page.id === x.id));
  if (retire && unmapped.length > 0)
    refusals.push(
      issue(
        'SPLIT_DEPENDENCIES_UNMAPPED',
        `The source is to be retired, so every page that depends on it must be remapped to the new owner it actually needs (D5): ${unmapped.map((x) => x.name).join(', ')}.`,
        { unmapped },
      ),
    );

  // ---------------------------------------------------------------------------------------------- completeness
  // ADR 0059 amendment 1 (the owner's tests, 19 November 2026). Source Boundaries and Unresolved Material: when the source
  // has either section, each new owner addresses it, by items moved to it from that section (they go under the section's
  // own heading), by text the agent supplies, or as not applicable with a reason the proposal shows the owner. The bridge
  // never writes these sections' content itself. Dependencies: the source's own are each new owner's starting list; an
  // empty list is an explicit "none" with a reason.
  const warnAll = [
    ...(rules.owners?.text.warnMissing ?? []),
    ...rules.types.flatMap((t) => t.roles.flatMap((r) => r.warnMissing)),
  ];
  const frame: { field: FrameField; title: string }[] = [
    {
      field: 'sourceBoundaries',
      title: warnAll.find((h) => textKey(h) !== textKey(unresolvedHeading)) ?? 'Source Boundaries',
    },
    { field: 'unresolvedMaterial', title: unresolvedHeading },
  ];
  const frameHeadings = (title: string) => o.headings.filter((h) => textKey(h.title) === textKey(title));
  const frameBlocks = (title: string) => new Set(frameHeadings(title).flatMap((h) => h.blockIds));
  const newOwners = [...dests.values()].filter((r) => r.isNew && r.d.kind !== 'universal');
  // A frame section's blocks moved to a new owner without their heading (and without an `under`) go under the section's
  // own heading there, so the new owner has the section.
  for (const f of frame) {
    const heads = frameHeadings(f.title).map((h) => h.id);
    for (const id of frameBlocks(f.title)) {
      const list = assigned.get(id);
      const a = list?.[0];
      if (!a || (a.under ?? '').trim() !== '') continue;
      const r = dests.get(a.to);
      if (!r || !newOwners.includes(r) || heads.some((h) => toOf(h) === a.to)) continue;
      assigned.set(id, [{ ...a, under: f.title }, ...list.slice(1)]);
    }
  }
  /** Whether the source's section `f` reaches the new owner `key` as a section (its heading, or blocks under it). */
  const movedFrame = (key: string, f: { title: string }): boolean => {
    const heads = new Set(frameHeadings(f.title).map((h) => h.id));
    return [...frameBlocks(f.title)].some(
      (id) =>
        toOf(id) === key &&
        ([...heads].some((h) => toOf(h) === key) ||
          textKey(assigned.get(id)?.[0]?.under ?? '') === textKey(f.title)),
    );
  };
  /**
   * CR-2026-11-R4 (the owner's request; ADR 0066 A): the frame sections a new owner is expected to address, by the pack's
   * `splits.sections`: its Reference Type (ignoring case), else its role in a character's set, else its owner type, else
   * `otherwise`. A version without the data: both, as ADR 0059 amendment 1 built.
   */
  const expectedFrame = (r: {
    d: SplitDestinationInput;
  }): { fields: ReadonlySet<FrameField>; as: string } => {
    const spec = s?.sections;
    if (!spec) return { fields: new Set(frame.map((f) => f.field)), as: 'every new owner' };
    const role = character
      ? r.d.kind === 'relationship'
        ? 'relationship'
        : (r.d.role ?? 'specialist')
      : null;
    const referenceType =
      (r.d.referenceType ?? '').trim() ||
      (role ? (ctype.roles.find((x) => x.role === role)?.referenceType ?? '') : '');
    const byKey = (m: Readonly<Record<string, readonly FrameField[]>>, k: string) =>
      k === '' ? undefined : Object.entries(m).find(([x]) => textKey(x) === textKey(k))?.[1];
    const byType = byKey(spec.referenceTypes, referenceType);
    if (byType) return { fields: new Set(byType), as: `a ${referenceType} page` };
    if (role !== null) {
      const byRole = spec.roles[role];
      if (byRole) return { fields: new Set(byRole), as: `a ${role} page of a character’s set` };
    } else {
      const type = (r.d.type ?? '').trim();
      const byOwner = byKey(spec.ownerTypes, type);
      if (byOwner) return { fields: new Set(byOwner), as: `a ${type} owner` };
    }
    return { fields: new Set(spec.otherwise), as: 'a new owner of this kind' };
  };
  const nodeName = (id: string) => ctx.tree.node(projectId, id).data?.rawName ?? id;
  const suggestedDependencies = [...depIds].map((id) => ({ id, name: nodeName(id) }));
  const completenessOwners: SplitCompleteness['owners'][number][] = [];
  const unaddressed: { destination: string; section: string }[] = [];
  const noDeps: string[] = [];
  const conflicts: string[] = [];
  for (const r of newOwners) {
    const key = r.d.key;
    const sections: SplitCompleteness['owners'][number]['sections'][number][] = [];
    const expected = expectedFrame(r);
    for (const f of frame) {
      const moved = movedFrame(key, f);
      const supplied = (r.d[f.field] ?? '').trim() !== '';
      const na = (r.d.notApplicable?.[f.field] ?? '').trim();
      if (na !== '' && (moved || supplied)) {
        conflicts.push(
          `${key}: “${f.title}” is marked not applicable but ${moved ? 'items of it move there' : 'its text is given'}`,
        );
        continue;
      }
      if (na !== '') sections.push({ section: f.title, by: 'not applicable', reason: na });
      else if (moved || supplied)
        sections.push({
          section: f.title,
          by: moved && supplied ? 'moved and supplied' : moved ? 'moved' : 'supplied',
        });
      else if (frameBlocks(f.title).size > 0) {
        if (expected.fields.has(f.field)) unaddressed.push({ destination: key, section: f.title });
        // CR-2026-11-R4: a kind of page the pack does not expect to carry the section is not asked for it.
        else
          sections.push({
            section: f.title,
            by: 'not expected',
            reason: `the pack does not expect ${expected.as} to carry it (splits.sections)`,
          });
      }
    }
    const listed =
      (r.d.dependencies ?? []).length +
      [...dests.values()].filter((u) => u.d.kind === 'universal' && u.universalIn === key && u.universalOwner)
        .length;
    const none = (r.d.noDependencies?.reason ?? '').trim();
    if (listed > 0 && none !== '')
      conflicts.push(`${key}: Dependencies are listed and also said to be none (noDependencies)`);
    else if (listed === 0 && none === '') noDeps.push(key);
    completenessOwners.push({
      key,
      page: null,
      sections,
      dependencies: none !== '' && listed === 0 ? { none } : { count: listed },
    });
  }
  if (unaddressed.length > 0) {
    const titles = [...new Set(unaddressed.map((u) => u.section))];
    refusals.push(
      issue(
        'SPLIT_SECTIONS_UNADDRESSED',
        `${node.rawName} has ${titles.map((t) => `“${t}”`).join(' and ')}, and each new owner addresses ${titles.length === 1 ? 'it' : 'each'}: ${unaddressed.map((u) => `${u.destination} (${u.section})`).join(', ')} ${unaddressed.length === 1 ? 'does' : 'do'} not. For each: move its items from the source to the new owner (map; they go under that heading), give its text (${frame.map((f) => f.field).join(' / ')}, Markdown), or mark it not applicable with a reason the owner reads in the proposal (notApplicable: { ${frame[0]!.field}: "…" }). The bridge never writes these sections itself.`,
        { unaddressed, fields: Object.fromEntries(frame.map((f) => [f.title, f.field])) },
      ),
    );
  }
  if (noDeps.length > 0)
    refusals.push(
      issue(
        'SPLIT_DEPENDENCIES_UNADDRESSED',
        `${noDeps.join(', ')} would have no Dependencies. Start from ${node.rawName}'s own (${suggestedDependencies.map((d) => d.name).join(', ') || 'none listed'}) and keep those the new owner relies on (dependencies), or say there are none, with a reason the owner reads in the proposal (noDependencies: { reason }).`,
        { destinations: noDeps, suggested: suggestedDependencies },
      ),
    );
  if (conflicts.length > 0)
    refusals.push(
      issue(
        'SPLIT_COMPLETENESS_CONFLICT',
        `${conflicts.join('; ')}. Give one answer for each: the material, or the reason it does not apply.`,
        { conflicts },
      ),
    );

  const partial = (): Obj => ({
    source: { id: node.id, name: node.rawName, kind: character ? 'character' : 'owner' },
    suggestedDependencies,
    retire,
    sections: o.headings
      .filter((h) => h.top === h.id)
      .map((h) => ({
        section: h.title,
        id: h.id,
        blocks: h.blockIds.length,
        to: [...new Set(h.blockIds.map(toOf))],
      })),
    incomingDependencies: { incoming, unmapped },
  });
  if (refusals.length > 0) return { ok: false, refusals, partial: { ...partial(), warnings } };

  // ---------------------------------------------------------------------------------------------- the new pages (F3a, F3b)
  const converter = pd.services ? pageConverterContext(pd.services, projectId) : undefined;
  const md = (text: string, what: string): Obj[] => {
    try {
      return withIds(fromMarkdown(text, { blocks: [] }, converter ?? {}).blocks);
    } catch (e) {
      if (e instanceof MarkdownError) {
        refusals.push(issue(e.code, `${what}: ${e.message}`));
        return [];
      }
      throw e;
    }
  };
  const purposeOf = (d: SplitDestinationInput) => {
    const t = (d.purpose ?? '').trim();
    return /^#{1,6}\s/.test(t) ? t : `## ${ctype.text.firstHeading}\n\n${t}`;
  };
  const universalHere = (key: string) =>
    [...dests.values()].filter((r) => r.d.kind === 'universal' && r.universalIn === key && r.universalOwner);
  const packPlans: { plan: PackPlan; env: PlanEnv; keys: Map<string, string> }[] = [];
  let upgrade: SplitUpgrade | null = null;
  const lmrMode: LmrMode = input.lastMajorRevision ?? 'auto';
  const newDests = [...dests.values()].filter((r) => r.isNew);
  try {
    if ((newDests.length > 0 || upgradeToCore) && character) {
      const e = characterEnv(pd, mctx, SPLIT_TOOL, basis, ctype.name, lmrMode);
      if (!e.ok) return { ok: false, result: e.result };
      const pages: PackagePage[] = newDests.map((r) => ({
        role: r.d.kind === 'relationship' ? 'relationship' : (r.d.role ?? 'specialist'),
        ...(r.d.title ? { title: r.d.title } : {}),
        ...(r.d.referenceType ? { referenceType: r.d.referenceType } : {}),
        ...(r.d.specialistTag ? { specialistTag: r.d.specialistTag } : {}),
        scope: (r.d.scope ?? '').trim(),
        markdown: purposeOf(r.d),
        dependencies: [
          ...(r.d.dependencies ?? []),
          ...universalHere(r.d.key).map((u) => u.universalOwner!.id),
        ],
        ...(r.d.related ? { related: r.d.related } : {}),
        ...(r.d.kind === 'relationship'
          ? { with: r.d.with, ...(r.d.label ? { label: r.d.label } : {}) }
          : {}),
      }));
      const plan = await planPackage(e.env, {
        name: subject,
        identity: {},
        target: character.core.id,
        pages,
        // The split moves the sections itself (each leaves an interface summary): no overlap to warn about.
        ...(upgradeToCore
          ? {
              upgradeToCore: true,
              upgradeOverlap: false,
              // v3 F7.1: the source as this plan read it (no second read for the upgrade's text change).
              upgradeText: { documentId, blocks: blocks as unknown as LkBlock[] },
            }
          : {}),
      });
      const keys = new Map<string, string>();
      newDests.forEach((r, i) => keys.set(`p${i}`, r.d.key));
      packPlans.push({ plan, env: e.env, keys });
      const rn = plan.existing.find((c) => c.kind === 'rename' && c.page.id === node.id);
      if (upgradeToCore && rn?.kind === 'rename') {
        const compactRole = ctype.roles.find((x) => x.role === 'compact');
        const coreRole = ctype.roles.find((x) => x.role === 'core');
        upgrade = {
          resourceId: node.id,
          from: rn.from,
          to: rn.to,
          property: prop,
          referenceType: {
            before: sidebarValue(sidebar, prop, 'Reference Type'),
            after: coreRole?.referenceType ?? 'Character Core',
          },
          templates: {
            compact: compactRole ? (e.env.templates[compactRole.template] ?? null) : null,
            core: rn.coreTemplateId,
          },
        };
      }
    } else if (newDests.length > 0) {
      const base = envOf(pd, mctx, SPLIT_TOOL, basis, lmrMode);
      for (const r of newDests) {
        const continuity = sidebarValue(sidebar, prop, 'Continuity');
        const plan = await planOwner(base, {
          type: r.d.type ?? '',
          name: (r.d.name ?? '').trim(),
          ...(r.d.descriptor ? { descriptor: r.d.descriptor } : {}),
          status: lifecycle,
          ...(continuity && textKey(continuity) !== 'main' ? { continuity } : {}),
          home: r.d.home ?? '',
          ...(r.d.homeOverride ? { homeOverride: r.d.homeOverride } : {}),
          ...(r.d.nation ? { nation: r.d.nation } : {}),
          ...(r.d.referenceType ? { referenceType: r.d.referenceType } : {}),
          scope: (r.d.scope ?? '').trim(),
          ...(r.d.temporalScope
            ? { temporalScope: r.d.temporalScope }
            : sidebarValue(sidebar, prop, 'Temporal Scope')
              ? { temporalScope: sidebarValue(sidebar, prop, 'Temporal Scope')! }
              : {}),
          markdown: purposeOf(r.d),
          dependencies: [
            ...(r.d.dependencies ?? []),
            ...universalHere(r.d.key).map((u) => u.universalOwner!.id),
          ],
          ...(r.d.related ? { related: r.d.related } : {}),
        });
        const keys = new Map<string, string>();
        const owner = plan.pages.findIndex((p) => p.kind !== 'index');
        if (owner >= 0) keys.set(plan.pages[owner]!.key, r.d.key);
        packPlans.push({ plan, env: { ...base, type: plan.type, hook: GENERIC_HOOK }, keys });
      }
    }
  } catch (e) {
    if (e instanceof PlanReadError) return { ok: false, result: e.result };
    throw e;
  }
  for (const pp of packPlans) {
    for (const x of pp.plan.refusals) refusals.push({ ...x, code: x.code, message: x.message });
    for (const x of pp.plan.warnings) warnings.push({ ...x });
    notes.push(...pp.plan.notes);
  }
  if (refusals.length > 0) return { ok: false, refusals, partial: { ...partial(), warnings } };

  // Each new destination's page, and its content: Purpose, then the moved blocks verbatim (under the agent's headings),
  // with universal material whose application text goes here replaced by that text.
  const pageOfKey = new Map<string, { id: string; name: string; scope: string | null }>();
  for (const pp of packPlans)
    for (const p of pp.plan.pages) {
      const key = pp.keys.get(p.key);
      if (key) pageOfKey.set(key, { id: p.id, name: p.rawName, scope: p.scope });
    }
  for (const r of newDests) {
    const pg = pageOfKey.get(r.d.key);
    if (pg) r.page = { id: pg.id, name: pg.name };
  }
  const appText = new Map<string, Obj[]>();
  for (const r of dests.values()) {
    if (r.d.kind !== 'universal' || !r.universalOwner) continue;
    const b = md(r.d.text ?? '', `${r.d.key}: the application text`);
    if (!b.some((x) => mentionedIn(x).has(r.universalOwner!.id)))
      b.push(seeLink(r.universalOwner.id, ' for the rule itself.'));
    appText.set(r.d.key, b);
  }
  /** A destination's content: its blocks in source order, the agent's headings, application texts in place. */
  const contentOf = (key: string): { blocks: Obj[]; moved: string[]; universal: string[] } => {
    const out: Obj[] = [];
    const moved: string[] = [];
    const universal: string[] = [];
    const heads = new Set<string>();
    const doneUniversal = new Set<string>();
    /** Where the last block moved from each frame section ends in `out`. */
    const lastFrame = new Map<FrameField, number>();
    for (const id of o.order) {
      const to = toOf(id);
      const u = dests.get(to);
      if (u?.d.kind === 'universal' && u.universalIn === key) {
        universal.push(id);
        if (!doneUniversal.has(to)) {
          doneUniversal.add(to);
          out.push(...(appText.get(to) ?? []).map(copy));
        }
        continue;
      }
      if (to !== key) continue;
      const a = assigned.get(id)![0]!;
      const under = (a.under ?? '').trim();
      const r = dests.get(key)!;
      if (under !== '' && r.isNew && !heads.has(textKey(under))) {
        heads.add(textKey(under));
        const b = o.byId.get(id)!;
        if (!(b.kind === 'heading' && textKey(blockText(b)) === textKey(under)))
          out.push({ id: mintClientId(), kind: 'heading', level: 2, content: [{ text: under }] });
      }
      out.push(copy(o.byId.get(id)!));
      moved.push(id);
      for (const f of frame) if (frameBlocks(f.title).has(id)) lastFrame.set(f.field, out.length);
    }
    // ADR 0059 amendment 1: the agent's text for a frame section, after the items moved under it, else at the end under
    // the section's heading (added when the text has none). Later positions first, so the earlier ones still hold.
    const dest = dests.get(key);
    if (dest && newOwners.includes(dest)) {
      const given = frame
        .map((f) => ({ f, text: (dest.d[f.field] ?? '').trim(), at: lastFrame.get(f.field) ?? -1 }))
        .filter((x) => x.text !== '');
      for (const x of given.filter((g) => g.at >= 0).sort((a, b) => b.at - a.at))
        out.splice(x.at, 0, ...md(x.text, `${key}: ${x.f.field}`));
      for (const x of given.filter((g) => g.at < 0))
        out.push(
          ...md(/^#{1,6}\s/.test(x.text) ? x.text : `## ${x.f.title}\n\n${x.text}`, `${key}: ${x.f.field}`),
        );
    }
    return { blocks: out, moved, universal };
  };
  const contents = new Map<string, ReturnType<typeof contentOf>>();
  for (const r of dests.values()) if (r.d.kind !== 'universal') contents.set(r.d.key, contentOf(r.d.key));
  // The routing lines a pack plan would append are written one per page instead (each its own item), and the planned
  // text of each new page is its Purpose and its moved blocks.
  const routes: { index: TreeNode; section: string; pageKey: string }[] = [];
  const coreText: Extract<ExistingChange, { kind: 'core_text' }>[] = [];
  for (const pp of packPlans) {
    const routing = pp.plan.existing.filter((c) => c.kind === 'routing');
    for (const c of routing) {
      const index = ctx.tree.node(projectId, c.page.id).data;
      if (!index) continue;
      for (const p of pp.plan.pages) {
        const key = pp.keys.get(p.key);
        if (key) routes.push({ index, section: c.section, pageKey: key });
      }
    }
    // v3 F7.1 (ADR 0072): the upgrade's text change runs after phase 1's verification (the split's checks compare the
    // source's blocks with what it planned), on the blocks that stay in the source.
    for (const c of pp.plan.existing)
      if (c.kind === 'core_text') {
        if (c.role === 'core' && c.page.id === node.id) {
          const stays = (id: string) => o.byId.has(id) && toOf(id) === STAYS;
          const r = {
            ...c,
            replacements: c.replacements.filter((x) => stays(x.blockId)),
            remove: c.remove.filter((x) => stays(x.blockId)),
          };
          if (r.replacements.length > 0 || r.remove.length > 0) coreText.push(r);
        } else coreText.push(c);
      }
    const kept = pp.plan.existing.filter((c) => c.kind !== 'routing' && c.kind !== 'core_text');
    pp.plan.existing.splice(0, pp.plan.existing.length, ...kept);
    for (let i = 0; i < pp.plan.pages.length; i++) {
      const p = pp.plan.pages[i]!;
      const key = pp.keys.get(p.key);
      if (!key) continue;
      const c = contents.get(key)!;
      const purpose = (p.blocks ?? []) as unknown as Obj[];
      const all = [...withIds(purpose), ...c.blocks] as unknown as LkBlock[];
      let markdown = p.markdown;
      try {
        markdown = toMarkdown({ blocks: all }).markdown;
      } catch {
        // the preview keeps the Purpose's Markdown
      }
      pp.plan.pages[i] = {
        ...p,
        blocks: all,
        markdown,
        headings: all
          .filter((b) => (b as unknown as Obj).kind === 'heading')
          .map((b) => blockText(b as unknown as Obj)),
      };
    }
  }
  const jobs: {
    job: PackJob;
    plan: PackPlan;
    keys: Map<string, string>;
    items: PlanItem[] | null;
    steps: StepSpec[];
  }[] = [];
  for (const pp of packPlans) {
    const built = buildPackJob(pp.env, pp.plan);
    if (!built.ok) return { ok: false, result: built.result };
    const it = itemizePackage(pp.plan, built.value);
    jobs.push({ job: built.value, plan: pp.plan, keys: pp.keys, items: it.items, steps: it.steps });
  }

  // ---------------------------------------------------------------------------------------------- the job
  const body: StepSpec[] = [];
  const labels: string[] = [];
  const stepNo = () => body.length + 2; // the first check is step 1
  const journal = (page: { id: string; name: string } | null, write: string): Obj => ({
    tool: SPLIT_TOOL,
    pack: basis.pack.id,
    split: splitId,
    ...(page ? { page } : {}),
    write,
  });
  const itemIds = new Map<string, string>(); // pack item id → split item id
  const packItems: PlanItem[] = [];
  const checks: ExpectCheck[] = [
    {
      label: 'governance',
      kind: 'registered',
      checker: PACK_CHECKS.governance,
      input: {
        packId: basis.pack.id,
        version: basis.pack.version,
        sources: basis.pack.approved?.sources ?? [],
        tool: SPLIT_TOOL,
      },
    },
  ];
  const verifyTargets: VerifyTarget[] = [];
  const verifyTargetItems: string[][] = [];
  const markerPages: LifecycleMarker['pages'][number][] = [];
  const pageItem = new Map<string, string>(); // a new page's id → its split item
  for (const [ji, j] of jobs.entries()) {
    const keyOf = (packItem: string): string | null => {
      if (!packItem.startsWith('page:')) return packItem; // existing:<id>
      const pid = packItem.slice('page:'.length);
      const p = j.plan.pages.find((x) => x.id === pid);
      if (!p) return null;
      const key = j.keys.get(p.key);
      if (key) return dests.get(key)!.d.item;
      return `index:${pid}`;
    };
    for (const it of j.items ?? []) {
      const id = keyOf(it.id);
      if (id) itemIds.set(it.id, id);
    }
    for (const p of j.plan.pages) {
      const id = itemIds.get(`page:${p.id}`);
      if (id) pageItem.set(p.id, id);
    }
    for (const it of j.items ?? [])
      if (!it.id.startsWith('page:') || itemIds.get(it.id)?.startsWith('index:'))
        packItems.push({
          ...it,
          id: itemIds.get(it.id) ?? it.id,
          group: it.id.startsWith('page:') ? SPLIT_GROUPS.index : SPLIT_GROUPS.existing,
          dependsOn: it.dependsOn
            .map((x) => itemIds.get(x) ?? x)
            // The source upgraded to its Core: every new owner needs it, so it needs none of them. Its move's place
            // beside a new page is re-anchored, and a link to one is dropped with it, when that page is left out.
            .filter((x) => !(upgradeToCore && it.id === `existing:${node.id}` && x.startsWith('dest:'))),
        });
    const mapItems = (its: readonly string[] | undefined) =>
      its ? [...new Set(its.map((x) => itemIds.get(x) ?? x))] : undefined;
    const steps = j.steps;
    // Its own first check: merged into the split's (governance once; each package's absent check kept).
    const first = (steps[0]?.params?.body as { checks?: ExpectCheck[] } | undefined)?.checks ?? [];
    for (const c of first) if (c.label !== 'governance') checks.push({ ...c, label: `${c.label}:${ji}` });
    const base = stepNo() - 2; // step 2 of the package (its first after the check) becomes stepNo()
    for (let i = 1; i < steps.length; i++) {
      const s0 = steps[i]!;
      if (s0.op === VERIFY_STEP && i === steps.length - 1) {
        const ts = (s0.params?.body as { targets?: VerifyTarget[] } | undefined)?.targets ?? [];
        const parts = s0.itemParts?.find((x) => x.path === 'body.targets')?.items ?? [];
        ts.forEach((t, k) => {
          verifyTargets.push(shiftTarget(t, base));
          verifyTargetItems.push((parts[k] ?? []).map((x) => itemIds.get(x) ?? x));
        });
        continue;
      }
      const s = shiftStep(s0, base);
      const its = mapItems(s.items);
      body.push({
        ...s,
        ...(its ? { items: its } : {}),
        ...(s.itemParts
          ? {
              itemParts: s.itemParts.map((pt) => ({
                ...pt,
                items: pt.items.map((x) => [...new Set(x.map((y) => itemIds.get(y) ?? y))]),
              })),
            }
          : {}),
        ...(s.journalOperation
          ? { journalOperation: { ...s.journalOperation, tool: SPLIT_TOOL, split: splitId } }
          : {}),
      });
      labels.push(j.job.labels[i] ?? s.op);
    }
    for (const p of j.job.marker?.pages ?? []) markerPages.push(p);
  }

  // The existing owners: the moved blocks appended under the agent's heading (rebased on a conflict, F3d.1).
  const boundaries = [ctype.index.boundaries, 'Source Boundaries', unresolvedHeading];
  const writes = new Map<string, number[]>(); // page → its write steps (for Last Major Revision)
  const wrote = (pageId: string, n: number) => writes.set(pageId, [...(writes.get(pageId) ?? []), n]);
  const writeItems = new Map<string, Set<string>>();
  const touch = (pageId: string, item: string) =>
    writeItems.set(pageId, new Set([...(writeItems.get(pageId) ?? []), item]));
  let keptIds = 0;
  for (const r of dests.values()) {
    if (r.isNew || r.d.kind === 'universal' || !r.page || !r.documentId) continue;
    const c = contents.get(r.d.key)!;
    // One append per heading the material goes under.
    const groups = new Map<string, Obj[]>();
    for (const id of c.moved) {
      const a = assigned.get(id)![0]!;
      const under = (a.under ?? r.d.under ?? '').trim();
      groups.set(under, [...(groups.get(under) ?? []), copy(o.byId.get(id)!)]);
    }
    // Universal application text placed here goes with the first group.
    if (c.universal.length > 0) {
      const first = [...groups.keys()][0] ?? (r.d.under ?? '').trim();
      const extra = c.blocks.filter((b) => !c.moved.includes(str(b.id) ?? '') && b.kind !== 'heading');
      groups.set(first, [...(groups.get(first) ?? []), ...extra]);
    }
    let nth = 0;
    for (const [under, moved] of groups) {
      keptIds += moved.length;
      // CR-2026-11-R3 (R3-23): an item is never skipped part-way. Its first append may be skipped (after three conflicts
      // nothing of the item is written yet, so its material stays in the source); a later one is core: once an earlier
      // append has landed, the job stops there (resumable) instead of leaving that material in two places.
      const later = nth++ > 0;
      const a: AppendInput = {
        item: r.d.item,
        under,
        level: 2,
        headingId: mintClientId(),
        blocks: moved,
        boundaries,
        where: `${r.page.name} › ${under}`,
      };
      const at = stepNo();
      body.push({
        op: 'replaceDocumentBlocks',
        params: { path: { resourceId: r.page.id, documentId: r.documentId }, body: { blocks: [] } },
        judgedInLock: true,
        verifyAfterWrite: true,
        items: [r.d.item],
        rebase: { rebaser: SPLIT_REBASERS.append, input: a, always: true, ...(later ? { core: true } : {}) },
        journalOperation: journal(
          r.page,
          `${moved.length} block(s) of ${node.rawName} appended under “${under}”`,
        ),
      });
      labels.push(`${r.page.name}: ${moved.length} block(s) under “${under}”`);
      wrote(r.page.id, at);
      touch(r.page.id, r.d.item);
    }
  }

  // Before anything leaves the source: every destination holds what it receives, and every new page its Scope.
  const keysOf = ['Scope', 'Reference Type'];
  const destRef = (r: Resolved): DestRef => ({
    resourceId: r.page!.id,
    documentId: r.isNew ? null : r.documentId,
    name: r.page!.name,
    isNew: r.isNew,
  });
  const receivers = [...dests.values()].filter((r) => r.d.kind !== 'universal' && r.page);
  const moveEntries = receivers.map((r) => ({
    item: r.d.item,
    dest: destRef(r),
    blocks: contents.get(r.d.key)!.moved.map((id) => ({
      id,
      text: textPrint(o.byId.get(id)!),
      excerpt: excerpt(id),
      content: contentPrint(o.byId.get(id)!),
    })),
  }));
  const newPages = receivers
    .filter((r) => r.isNew)
    .map((r) => ({
      item: r.d.item,
      resourceId: r.page!.id,
      name: r.page!.name,
      property: prop,
      keys: keysOf,
    }));
  const midInput: DestinationsCheckInput = { moves: moveEntries, newPages };
  body.push({
    op: EXPECT_STEP,
    params: {
      body: {
        checks: [
          { label: 'destinations', kind: 'registered', checker: SPLIT_CHECKS.destinations, input: midInput },
        ],
      },
    },
    itemParts: [
      { path: 'body.checks.0.input.moves', items: moveEntries.map((m) => [m.item]) },
      { path: 'body.checks.0.input.newPages', items: newPages.map((p) => [p.item]) },
    ],
  });
  labels.push('check the destinations before anything leaves the source');

  // The source's edits: each item's blocks out, its interface summaries (or application text) in their places.
  const summaries: { section: string; to: string; text: string; at: number }[] = [];
  const sourceEdits: SourceEditInput[] = [];
  const editItems: string[] = [];
  const editOf = (item: string, remove: string[], inserts: SourceEditInput['inserts'], where: string) => {
    if (remove.length === 0) return;
    const e: SourceEditInput = {
      item,
      remove: remove.map((id) => ({ id, fp: fingerprint(o.byId.get(id)!) })),
      inserts,
      where,
    };
    sourceEdits.push(e);
    editItems.push(item);
  };
  for (const r of receivers) {
    const c = contents.get(r.d.key)!;
    const inserts: { before: string; blocks: Obj[] }[] = [];
    for (const p of pairs.values()) {
      if (p.to !== r.d.key || !(p.summary ?? '').trim()) continue;
      const b = md(p.summary!, `${r.d.key}: the interface summary of “${titleOfTop(p.top)}”`);
      if (!b.some((x) => mentionedIn(x).has(r.page!.id))) b.push(seeLink(r.page!.id));
      // A section that leaves whole takes its heading with it: its summary keeps the section's heading in the source,
      // so the page's outline still reads the same (unless the summary brings a heading of its own).
      const top = o.headings.find((h) => h.id === p.top);
      if (top && c.moved.includes(top.id) && b[0]?.kind !== 'heading')
        b.unshift({ id: mintClientId(), kind: 'heading', level: top.level, content: [{ text: top.title }] });
      inserts.push({ before: p.first, blocks: b });
      summaries.push({
        section: titleOfTop(p.top),
        to: r.page!.name,
        text: p.summary!,
        at: o.order.indexOf(p.first),
      });
    }
    editOf(
      r.d.item,
      o.order.filter((id) => c.moved.includes(id) || c.universal.includes(id)),
      inserts,
      `${node.rawName}: what moves to ${r.page!.name}`,
    );
  }
  for (const r of dests.values()) {
    if (r.d.kind !== 'universal' || r.universalIn !== 'source') continue;
    const mine = blocksTo.get(r.d.key) ?? [];
    editOf(
      r.d.item,
      mine,
      [{ before: mine[0]!, blocks: appText.get(r.d.key) ?? [] }],
      `${node.rawName}: universal material (${r.universalOwner?.name ?? r.d.key})`,
    );
  }
  if (refusals.length > 0) return { ok: false, refusals, partial: { ...partial(), warnings } };
  for (const e of sourceEdits) {
    const at = stepNo();
    body.push({
      op: 'replaceDocumentBlocks',
      params: { path: { resourceId: node.id, documentId }, body: { blocks: [] } },
      judgedInLock: true,
      verifyAfterWrite: true,
      items: [e.item],
      // Core: what leaves the source must be exactly what was copied; changed meanwhile stops the job (resumable).
      rebase: { rebaser: SPLIT_REBASERS.source, input: e, always: true, core: true },
      journalOperation: journal(
        { id: node.id, name: node.rawName },
        `${e.remove.length} block(s) out (${e.item})`,
      ),
    });
    labels.push(
      `${node.rawName}: ${e.remove.length} block(s) out, ${e.inserts.reduce((n, g) => n + g.blocks.length, 0)} in (${e.item})`,
    );
    wrote(node.id, at);
    touch(node.id, e.item);
  }

  // Universal material that stays (its application text in the source): the universal owner becomes a Dependency.
  const factsWrite = (
    page: { id: string; name: string },
    pageSidebar: readonly SidebarProperty[],
    add: { resourceId: string; name: string }[],
    remove: { resourceId: string; name: string }[],
    item: string,
    what: string,
  ): boolean => {
    let fp;
    try {
      fp = planFacts({
        resourceId: page.id,
        sidebar: pageSidebar,
        propertyTitle: prop,
        facts: [],
        links: [{ title: deps, add, remove }],
        templateKeys: null,
      });
    } catch (e) {
      if (e instanceof FactsPlanError) {
        refusals.push(issue(e.code, `${page.name}: ${e.message}`));
        return false;
      }
      throw e;
    }
    if (fp.empty) return false;
    const fx = expandFacts(fp, { id: page.id, name: page.name }, pageSidebar, { facts: null, links: [what] });
    const base = stepNo() - 1;
    for (const s0 of fx.steps) {
      if (s0.op === VERIFY_STEP) {
        // Its read-back joins the job's verify step (Revert reads the sidebar it left from there).
        for (const t of (s0.params?.body as { targets?: VerifyTarget[] } | undefined)?.targets ?? []) {
          verifyTargets.push(t);
          verifyTargetItems.push([item]);
        }
        continue;
      }
      const at = stepNo();
      body.push({
        ...shiftStep(s0, base),
        items: [item],
        ...(s0.op !== EXPECT_STEP ? { judgedInLock: true } : {}),
        ...(s0.journalOperation
          ? { journalOperation: { ...s0.journalOperation, tool: SPLIT_TOOL, split: splitId } }
          : {}),
      });
      labels.push(s0.op === EXPECT_STEP ? 'check' : `${page.name}: ${what}`);
      if (s0.op !== EXPECT_STEP) {
        wrote(page.id, at);
        touch(page.id, item);
      }
    }
    return true;
  };
  const lmrKnown = new Map<string, Obj[]>();
  for (const r of dests.values()) {
    if (r.d.kind !== 'universal' || r.universalIn !== 'source' || !r.universalOwner) continue;
    if (depIds.has(r.universalOwner.id)) continue;
    if (
      factsWrite(
        { id: node.id, name: node.rawName },
        sidebar,
        [{ resourceId: r.universalOwner.id, name: r.universalOwner.name }],
        [],
        r.d.item,
        `${deps}: + ${r.universalOwner.name}`,
      )
    )
      lmrKnown.set(node.id, [
        ...(lmrKnown.get(node.id) ?? []),
        { kind: 'links', title: deps, added: 1, removed: 0, item: r.d.item },
      ]);
  }

  // Index lines (step 6): each new page's line in its index, an item of its own.
  const routeItems: PlanItem[] = [];
  const indexEntries: { index: string; line: string }[] = [];
  for (const rt of routes) {
    const r = dests.get(rt.pageKey)!;
    const pg = pageOfKey.get(rt.pageKey);
    if (!pg) continue;
    const doc =
      rt.index.documents.find((x) => x.name === 'Main' && (x.type === 'page' || x.type === 'blank')) ??
      rt.index.documents.find((x) => x.type === 'page');
    if (!doc) continue;
    const text = routingLine({ rawName: pg.name, id: pg.id, scope: pg.scope });
    const list = md(text, `the index line of ${pg.name}`);
    const line =
      isObj(list[0]) && Array.isArray(list[0].children) ? (list[0].children as Obj[])[0] : undefined;
    if (!line) continue;
    const item = `route:${pg.id}`;
    const ri: RouteInput = {
      item,
      section: rt.section,
      line,
      listId: str(list[0]!.id) ?? mintClientId(),
      pageId: pg.id,
      where: `${rt.index.rawName} › ${rt.section}`,
    };
    const at = stepNo();
    body.push({
      op: 'replaceDocumentBlocks',
      params: { path: { resourceId: rt.index.id, documentId: doc.id }, body: { blocks: [] } },
      judgedInLock: true,
      verifyAfterWrite: true,
      items: [item],
      rebase: { rebaser: SPLIT_REBASERS.route, input: ri, always: true },
      journalOperation: journal({ id: rt.index.id, name: rt.index.rawName }, `${rt.section}: + ${pg.name}`),
    });
    labels.push(`${rt.index.rawName}: line for ${pg.name}`);
    wrote(rt.index.id, at);
    touch(rt.index.id, item);
    indexEntries.push({ index: rt.index.rawName, line: text });
    routeItems.push({
      id: item,
      kind: 'index_line',
      group: SPLIT_GROUPS.routing,
      label: `${rt.index.rawName} › ${rt.section}: ${text}`,
      page: { id: rt.index.id, name: rt.index.rawName },
      diff: { before: null, after: text },
      dependsOn: [r.d.item],
      selected: true,
    });
  }

  // D5: the incoming Dependencies remapped to the new owner each page actually needs.
  const depItems: PlanItem[] = [];
  const remaps: { item: string; pageId: string; name: string; dest: string; keepSource: boolean }[] = [];
  try {
    for (const m of mapped) {
      const r = dests.get(m.to)!;
      if (!r.page) continue;
      const res = (await read('getResource', { path: { resourceId: m.page.id } })) as Obj;
      prefetched.push({ op: 'getResource', path: { resourceId: m.page.id }, body: res });
      const sb = sidebarFrom({ data: Array.isArray(res.properties) ? res.properties : [] });
      const item = `dep:${m.page.id}`;
      const ok = factsWrite(
        m.page,
        sb,
        [{ resourceId: r.page.id, name: r.page.name }],
        m.keepSource ? [] : [{ resourceId: node.id, name: node.rawName }],
        item,
        `${deps}: ${m.keepSource ? '' : `${node.rawName} → `}${r.page.name}`,
      );
      if (!ok) continue;
      lmrKnown.set(m.page.id, [
        ...(lmrKnown.get(m.page.id) ?? []),
        { kind: 'links', title: deps, added: 1, removed: m.keepSource ? 0 : 1, item },
      ]);
      remaps.push({ item, pageId: m.page.id, name: m.page.name, dest: r.page.id, keepSource: m.keepSource });
      depItems.push({
        id: item,
        kind: 'dependency_remap',
        group: SPLIT_GROUPS.dependencies,
        label: `${m.page.name}: ${deps} ${m.keepSource ? `+ ${r.page.name}` : `${node.rawName} → ${r.page.name}`}`,
        page: m.page,
        diff: { before: node.rawName, after: m.keepSource ? `${node.rawName}, ${r.page.name}` : r.page.name },
        dependsOn: [r.d.item],
        selected: true,
      });
    }
  } catch (e) {
    if (e instanceof PlanReadError) return { ok: false, result: e.result };
    throw e;
  }
  if (refusals.length > 0) return { ok: false, refusals, partial: { ...partial(), warnings } };

  // Last Major Revision (ADR 0051, per page): measured when the job runs, from what was approved. Moved content counts
  // on both sides: what leaves the source and what an existing owner receives (new pages are always dated).
  const lmrKey = basis.lifecycle.fields.lastMajorRevision;
  const measured: string[] = [];
  const dated = new Set<string>(); // the pages this job may date (their Last Major Revision step)
  const sidebars = new Map<string, readonly SidebarProperty[]>([[node.id, sidebar]]);
  if (lmrMode !== 'skip' && basis.lmrOnChanges) {
    for (const [pageId, after] of writes) {
      const its = [...(writeItems.get(pageId) ?? [])];
      if (its.length === 0) continue;
      const sb = sidebars.get(pageId) ?? ctx.tree.sidebars(projectId, [pageId]).data.get(pageId) ?? null;
      const hasRow =
        sb === null
          ? null
          : (sb as readonly { kind?: string; rows?: readonly { key: string }[] }[]).some(
              (p) => p.kind === 'keyValue' && (p.rows ?? []).some((x) => textKey(x.key) === textKey(lmrKey)),
            );
      if (hasRow === false) continue;
      const name = ctx.tree.node(projectId, pageId).data?.rawName ?? pageId;
      const lmrStep = stepNo();
      body.push({
        op: LMR_STEP,
        params: {
          body: {
            resourceId: pageId,
            key: lmrKey,
            after,
            page: name.slice(0, 500),
            why: lmrMode === 'set' ? 'lastMajorRevision "set" was asked' : 'a split (measured when it runs)',
            ...(lmrMode === 'set' ? {} : { measure: { known: lmrKnown.get(pageId) ?? [] } }),
          },
        },
        followUp: 'lmr_failed',
        items: its,
      });
      labels.push(`${lmrKey} of ${name}`);
      body.push({
        op: 'updatePropertyRow',
        params: {
          path: { resourceId: pageId, propertyId: pageId, rowId: pageId },
          body: { content: [{ text: 'date of approval' }] },
        },
        decisionFrom: { step: lmrStep },
        ifMatchFrom: { step: lmrStep, key: 'lmr' },
        followUp: 'lmr_failed',
        judgedInLock: true,
        deferTreeReread: true,
        items: its,
        journalOperation: journal({ id: pageId, name }, `${lmrKey}: today`),
      });
      labels.push(`${lmrKey} of ${name}: today`);
      measured.push(name);
      dated.add(pageId);
    }
  }
  // CR-2026-11-R3 (R3-67): a page this job may date whose read-back expects its rows exactly (the pack's facts write on
  // a source the split upgrades to its Core, R3-66) leaves its Last Major Revision row to the job's own step: compared
  // exactly, the date the split set read back as a difference, and the job was "not verified". Every other row is
  // compared as before, and Revert still reads the rows the job left from this target.
  for (const [i, t] of verifyTargets.entries()) {
    if (t.kind !== 'sidebar' || !dated.has(t.resourceId)) continue;
    verifyTargets[i] = {
      ...t,
      properties: t.properties.map((x) => {
        const row = x.rows?.find((r) => r.id !== null && textKey(r.key) === textKey(lmrKey));
        return row?.id ? { ...x, datedRowId: row.id } : x;
      }),
    };
  }

  // The new pages' own read-back (the pack's: place, rows, tags, links), then phase 1's verification.
  if (verifyTargets.length > 0) {
    body.push({
      op: VERIFY_STEP,
      params: { body: { targets: verifyTargets } },
      itemParts: [{ path: 'body.targets', items: verifyTargetItems }],
    });
    labels.push('verify the new pages and the remapped Dependencies');
  }
  const original = o.order.map((id) => ({
    id,
    text: textPrint(o.byId.get(id)!),
    excerpt: excerpt(id),
    content: contentPrint(o.byId.get(id)!),
  }));
  const contentMoves: {
    item: string;
    kind: 'move' | 'universal';
    blocks: string[];
    dest: { resourceId: string; documentId: string | null; name: string } | null;
  }[] = [];
  const contentMoveItems: string[][] = [];
  for (const r of receivers) {
    const c = contents.get(r.d.key)!;
    contentMoves.push({
      item: r.d.item,
      kind: 'move',
      blocks: c.moved,
      dest: { resourceId: r.page!.id, documentId: r.isNew ? null : r.documentId, name: r.page!.name },
    });
    contentMoveItems.push([r.d.item]);
    if (c.universal.length > 0) {
      contentMoves.push({ item: r.d.item, kind: 'universal', blocks: c.universal, dest: null });
      contentMoveItems.push([r.d.item]);
    }
  }
  for (const r of dests.values()) {
    if (r.d.kind !== 'universal' || r.universalIn !== 'source') continue;
    contentMoves.push({ item: r.d.item, kind: 'universal', blocks: blocksTo.get(r.d.key) ?? [], dest: null });
    contentMoveItems.push([r.d.item]);
  }
  const verifyInput: VerifyCheckInput = {
    source: { resourceId: node.id, documentId, name: node.rawName },
    original,
    moves: contentMoves,
    dests: receivers.map((r) => ({ ...destRef(r), item: r.d.item })),
    newPages,
    remaps,
    dependencies: deps,
    retire,
  };
  body.push({
    op: EXPECT_STEP,
    params: {
      body: {
        checks: [{ label: 'verify', kind: 'registered', checker: SPLIT_CHECKS.verify, input: verifyInput }],
      },
    },
    itemParts: [
      { path: 'body.checks.0.input.moves', items: contentMoveItems },
      { path: 'body.checks.0.input.dests', items: receivers.map((r) => [r.d.item]) },
      { path: 'body.checks.0.input.newPages', items: newPages.map((p) => [p.item]) },
      { path: 'body.checks.0.input.remaps', items: remaps.map((m) => [m.item]) },
    ],
  });
  labels.push('verify phase 1 (a direct re-read of the affected graph)');
  // v3 F7.1 (ADR 0072): the upgraded source's text change (the Art page's first), after the verification; with the
  // upgrade's item.
  if (upgradeToCore)
    for (const c of [
      ...coreText.filter((x) => x.role === 'art'),
      ...coreText.filter((x) => x.role === 'core'),
    ]) {
      const item = itemIds.get(`existing:${node.id}`) ?? `existing:${node.id}`;
      const at = stepNo();
      body.push({
        ...coreTextStep(c, journal({ id: c.page.id, name: c.page.rawName }, coreTextWords(c))),
        items: [item],
      });
      labels.push(`${c.page.rawName}: ${coreTextWords(c)}`);
      wrote(c.page.id, at);
      touch(c.page.id, item);
    }

  // The first check: governance, nothing of the new pages' names appeared, and the source as planned.
  const srcInput: SourceCheckInput = {
    resourceId: node.id,
    documentId,
    name: node.rawName,
    known: o.order,
    moves: sourceEdits,
  };
  checks.push({ label: 'source', kind: 'registered', checker: SPLIT_CHECKS.source, input: srcInput });
  const firstParts: ItemPartShape[] = [
    { path: `body.checks.${checks.length - 1}.input.moves`, items: editItems.map((i) => [i]) },
  ];
  const steps: StepSpec[] = [
    { op: EXPECT_STEP, params: { body: { checks } }, itemParts: firstParts },
    ...body,
  ];
  const allLabels = ['check', ...labels];

  // ---------------------------------------------------------------------------------------------- the items
  /** ADR 0059 amendment 1: a new owner's "not applicable" and "no Dependencies" answers, with their reasons (shown). */
  const choicesOf = (key: string): string => {
    const c = completenessOwners.find((x) => x.key === key);
    if (!c) return '';
    const parts = [
      ...c.sections
        .filter((x) => x.by === 'not applicable')
        .map((x) => `“${x.section}” not applicable: “${(x.reason ?? '').slice(0, 300)}”`),
      ...('none' in c.dependencies ? [`no Dependencies: “${c.dependencies.none.slice(0, 300)}”`] : []),
    ];
    return parts.join('; ');
  };
  /**
   * ADR 0059 amendment 1: what is still owed once the split has run, each with the tool that does it: a frame section
   * the surviving source gave away whole, pages that depend on the surviving source and may need a new owner instead, and
   * each new owner's "not applicable" and "no Dependencies" answers (to revisit if they change).
   */
  const nextStepsOf = (): SplitNextStep[] => {
    const out: SplitNextStep[] = [];
    const src = { id: node.id, name: node.rawName };
    if (!retire)
      for (const f of frame) {
        const b = [...frameBlocks(f.title)];
        if (b.length > 0 && b.every((id) => toOf(id) !== STAYS))
          out.push({
            page: src,
            what: `${node.rawName} keeps no “${f.title}” (all of it moved): write its own for what stays, or leave it out where it no longer applies.`,
            tool: 'write_page',
          });
      }
    if (!retire)
      for (const x of unmapped.slice(0, 20))
        out.push({
          page: x,
          what: `${x.name} depends on ${node.rawName}: if it relies on material that moved, add the new owner to its Dependencies (and remove ${node.rawName} if nothing it relies on stayed).`,
          tool: 'set_facts',
        });
    for (const c of completenessOwners) {
      const page = dests.get(c.key)?.page ?? null;
      const name = page?.name ?? c.key;
      for (const x of c.sections.filter((y) => y.by === 'not applicable'))
        out.push({
          page,
          what: `${name} has no “${x.section}” (not applicable: “${(x.reason ?? '').slice(0, 300)}”): add it if that changes.`,
          tool: 'write_page',
        });
      if ('none' in c.dependencies)
        out.push({
          page,
          what: `${name} has no Dependencies (“${c.dependencies.none.slice(0, 300)}”): add them when it comes to rely on another owner.`,
          tool: 'set_facts',
        });
    }
    return out;
  };
  const destItems: PlanItem[] = [];
  for (const r of dests.values()) {
    const sections = [...new Set((blocksTo.get(r.d.key) ?? []).map((id) => titleOfTop(topOf(id))))];
    const n = (blocksTo.get(r.d.key) ?? []).length;
    const w = (blocksTo.get(r.d.key) ?? []).reduce((k, id) => k + words(blockText(o.byId.get(id)!)), 0);
    const leftOut = `If left out, ${sections.map((x) => `“${x}”`).join(', ')} ${sections.length === 1 ? 'stays' : 'stay'} in ${node.rawName} (nothing is lost).`;
    if (r.d.kind === 'universal') {
      if (r.universalIn !== 'source') continue; // part of the destination its application text goes to
      destItems.push({
        id: r.d.item,
        kind: 'universal',
        group: SPLIT_GROUPS.universal,
        label: `Universal: ${n} block(s) of ${sections.join(', ')} → ${r.universalOwner?.name ?? r.d.owner} (not migrated; application text in ${node.rawName}; ${r.universalOwner?.name ?? ''} becomes a Dependency)`,
        page: { id: node.id, name: node.rawName },
        diff: {
          before: (blocksTo.get(r.d.key) ?? [])
            .map((id) => excerpt(id))
            .join(' · ')
            .slice(0, 2000),
          after: (r.d.text ?? '').slice(0, 2000),
          context: leftOut,
        },
        dependsOn: [],
        selected: true,
      });
      continue;
    }
    const kindWord = r.isNew ? 'New' : r.relationship ? 'Existing relationship owner' : 'Existing owner';
    // CR-2026-11-R3 (R3-50): universal material whose application text comes here is removed from the source with this
    // item (not migrated): the owner is shown its text, as for universal material whose text stays in the source.
    const removedHere = [...dests.values()]
      .filter((u) => u.d.kind === 'universal' && u.universalIn === r.d.key)
      .map((u) => ({
        owner: u.universalOwner?.name ?? u.d.owner ?? u.d.key,
        text: (blocksTo.get(u.d.key) ?? []).map((id) => blockText(o.byId.get(id) ?? {})).join(' · '),
      }))
      .filter((u) => u.text !== '');
    destItems.push({
      id: r.d.item,
      kind: r.isNew ? 'split_new_owner' : 'split_existing_owner',
      group: SPLIT_GROUPS.destinations,
      label: `${kindWord} ${r.page?.name ?? r.d.key}: ${sections.map((x) => `“${x}”`).join(', ')} (${n} block${n === 1 ? '' : 's'}, ${w} words)${choicesOf(r.d.key) ? `; ${choicesOf(r.d.key)}` : ''}`,
      page: r.page,
      diff: {
        before: null,
        after: (contents.get(r.d.key)?.blocks ?? [])
          .map((b) => blockText(b))
          .join('\n')
          .slice(0, 8000),
        context:
          leftOut +
          (choicesOf(r.d.key) ? ` The agent's answers, for the owner to judge: ${choicesOf(r.d.key)}.` : '') +
          removedHere
            .map(
              (u) =>
                ` With it, universal material is removed from ${node.rawName} (not migrated: ${u.owner}'s rule, its application text here instead): “${u.text.slice(0, 1500)}”.`,
            )
            .join(''),
      },
      dependsOn: [],
      selected: true,
    });
  }
  // Each destination item takes over its pack item's dependencies (a page under a new index needs the index).
  for (const j of jobs)
    for (const it of j.items ?? []) {
      const id = itemIds.get(it.id);
      if (!id || !id.startsWith('dest:')) continue;
      const k = destItems.findIndex((x) => x.id === id);
      if (k < 0) continue;
      const extra = it.dependsOn.map((x) => itemIds.get(x) ?? x).filter((x) => x !== id);
      destItems[k] = { ...destItems[k]!, dependsOn: [...new Set([...destItems[k]!.dependsOn, ...extra])] };
    }
  // The source upgraded to its Character Core by this split: each new owner needs the upgrade, so a partial approval never
  // leaves the character with several owners and no Core (unticking the upgrade drops the new owners with it).
  if (upgradeToCore) {
    const head = itemIds.get(`existing:${node.id}`) ?? `existing:${node.id}`;
    if (packItems.some((p) => p.id === head))
      for (const [k, d] of destItems.entries())
        if ([...dests.values()].some((r) => r.isNew && r.d.item === d.id))
          destItems[k] = { ...d, dependsOn: [...new Set([...d.dependsOn, head])] };
  }
  // Amendment 1 to ADR 0072: the upgrade's wording change is shown on the upgrade's item, sentence by sentence.
  const wording = upgradeToCore ? coreText.flatMap((c) => coreTextChanges(c)) : [];
  if (wording.length > 0) {
    const head = itemIds.get(`existing:${node.id}`) ?? `existing:${node.id}`;
    const k = packItems.findIndex((p) => p.id === head);
    if (k >= 0)
      packItems[k] = {
        ...packItems[k]!,
        label: `${packItems[k]!.label}; ${coreText.map((c) => `${c.page.rawName}: ${coreTextWords(c)}`).join('; ')}`,
        diff: {
          ...packItems[k]!.diff,
          changes: [...(packItems[k]!.diff?.changes ?? []), ...wording.map(textChangeEntry)],
        },
      };
  }
  let items: PlanItem[] = [
    ...destItems,
    ...packItems.filter((p) => !destItems.some((d) => d.id === p.id)),
    ...routeItems,
    ...depItems,
  ];
  items = withStepDependencies(items, steps);
  try {
    validateItems(items);
  } catch (e) {
    refusals.push(issue('ITEM_FILTER', e instanceof Error ? e.message : String(e)));
    return { ok: false, refusals, partial: { ...partial(), warnings } };
  }

  // ---------------------------------------------------------------------------------------------- the rest of the plan
  const marker: LifecycleMarker = {
    tool: SPLIT_TOOL,
    canonical: true,
    reason: `a split moves established material between owners (${node.rawName} → ${receivers.map((r) => r.page?.name).join(', ')}): always a canonical proposal, at every scope (D7)`,
    pages: markerPages,
  };
  const cost = splitCost(steps);
  const newNames = receivers.filter((r) => r.isNew).map((r) => r.page!.name);
  const summary = `${SPLIT_TOOL}: ${node.rawName} → ${receivers.length} owner${receivers.length === 1 ? '' : 's'} (${newNames.length} new)${[...dests.values()].some((r) => r.d.kind === 'universal') ? ', universal material replaced by its application' : ''}; ${retire ? 'the source is to be retired (phase 2: a separate archive proposal once phase 1 verifies)' : 'the source survives with interface summaries'}`;
  notes.push(
    'Each destination is its own item: leave one out and its sections stay in the source (D6). Index lines and remapped Dependencies hang off their destinations.',
    `The moved blocks are written verbatim with their ids (LegendKeeper keeps a requested id; one a destination already uses is replaced by a derived id, said in the job). Content LegendKeeper cannot create (unsupported blocks) can only stay.`,
    retire
      ? 'Phase 2: once phase 1 verifies, the bridge proposes archiving the source (archive_page): a separate canonical proposal for the owner. The split never deletes the source.'
      : 'The source survives: no phase 2.',
  );
  if (unmapped.length > 0)
    notes.push(
      `${unmapped.length} page(s) depend on ${node.rawName} and are not remapped: they keep pointing at it (it survives): ${unmapped.map((x) => x.name).join(', ')}.`,
    );
  const operations: Obj[] = [
    {
      tool: SPLIT_TOOL,
      split: splitId,
      page: { id: node.id, name: node.rawName },
      pageParts: [
        ...sourceEdits.map((e) => `${e.where}: ${e.remove.length} block(s) out`),
        ...summaries.map((x) => `summary of “${x.section}” → ${x.to}`),
      ].slice(0, 40),
      summaryLabel: `${node.rawName}: ${sourceEdits.reduce((n, e) => n + e.remove.length, 0)} block(s) leave it${summaries.length ? `, ${summaries.length} interface summar${summaries.length === 1 ? 'y' : 'ies'}` : ''}`,
    },
    ...receivers.map((r) => ({
      tool: SPLIT_TOOL,
      split: splitId,
      page: r.page,
      ...(r.isNew ? { isNew: true } : {}),
      pageParts: (blocksTo.get(r.d.key) ?? [])
        .map((id) => `${titleOfTop(topOf(id))}: “${excerpt(id).slice(0, 60)}”`)
        .slice(0, 40),
      summaryLabel: `${r.isNew ? 'New page' : 'Existing owner'} ${r.page?.name}: ${[...new Set((blocksTo.get(r.d.key) ?? []).map((id) => titleOfTop(topOf(id))))].join(', ')}`,
    })),
    // Amendment 1 to ADR 0072: the upgrade's wording change, with its sentences (the summary and the Review card).
    ...(upgradeToCore
      ? coreText
          .filter((c) => c.replacements.length > 0)
          .map((c) => ({
            tool: SPLIT_TOOL,
            split: splitId,
            page: { id: c.page.id, name: c.page.rawName },
            pageParts: [coreTextWords(c)],
            textChanges: coreTextChanges(c),
          }))
      : []),
  ];
  return {
    ok: true,
    plan: {
      splitId,
      source: {
        id: node.id,
        name: node.rawName,
        kind: character ? 'character' : 'owner',
        lifecycle,
        subject,
        documentId,
        identity,
      },
      retire,
      destinations: [...dests.values()].map((r) => ({
        key: r.d.key,
        kind: r.d.kind,
        item: r.d.item,
        page: r.page,
        isNew: r.isNew,
        documentId: r.documentId,
        sections: [...new Set((blocksTo.get(r.d.key) ?? []).map((id) => titleOfTop(topOf(id))))],
        blocks: blocksTo.get(r.d.key) ?? [],
        words: (blocksTo.get(r.d.key) ?? []).reduce((k, id) => k + words(blockText(o.byId.get(id)!)), 0),
        images: (blocksTo.get(r.d.key) ?? []).filter((id) => holdsImage(o.byId.get(id)!)).length,
        visual: r.visual,
        relationship: r.relationship,
        ...(r.universalOwner
          ? { universal: { owner: r.universalOwner, in: r.universalIn ?? 'source' } }
          : {}),
      })),
      sections: o.headings
        .filter((h) => h.top === h.id)
        .map((h) => ({
          section: h.title,
          to: [
            ...new Set(
              h.blockIds.map((id) => {
                const t = toOf(id);
                return t === STAYS ? STAYS : (dests.get(t)?.page?.name ?? t);
              }),
            ),
          ].join(' + '),
          blocks: h.blockIds.length,
        })),
      items,
      steps,
      labels: allLabels,
      marker,
      refusals,
      warnings,
      notes,
      dependencies: { mapped, unmapped, chronology },
      summaries: [...summaries]
        .sort((a, b) => a.at - b.at)
        .map(({ section, to, text }) => ({ section, to, text })),
      completeness: {
        suggestedDependencies,
        owners: completenessOwners.map((c) => ({ ...c, page: dests.get(c.key)?.page ?? null })),
      },
      nextSteps: nextStepsOf(),
      indexEntries,
      ids: {
        kept:
          keptIds +
          receivers
            .filter((r) => r.isNew)
            .reduce((n, r) => n + (contents.get(r.d.key)?.moved.length ?? 0), 0),
        note: 'Every moved block keeps its id (and its children theirs) where LegendKeeper allows: always on a new page; on an existing owner unless that page already uses the id, when a derived id is used and the job says so.',
      },
      upgrade,
      lmr: {
        mode: lmrMode,
        newPages: receivers.filter((r) => r.isNew).map((r) => r.page!.name),
        measured,
        switchedOff: !basis.lmrOnChanges,
      },
      cost: { planReads: reads, jobReads: cost.reads, jobWrites: cost.writes },
      summary,
      prefetched,
      operations,
    },
  };
}

// ============================================================================================ helpers

/** A verify target with every step number it names moved by `base` (the pack's targets in the merged job). */
function shiftTarget(t: VerifyTarget, base: number): VerifyTarget {
  const shifted = shiftStep({ op: VERIFY_STEP, params: { body: { targets: [t] } } }, base);
  return (shifted.params?.body as { targets: VerifyTarget[] }).targets[0] ?? t;
}

/** A sidebar row's plain value (null when the page has no such row). */
function sidebarValue(sidebar: readonly SidebarProperty[], title: string, key: string): string | null {
  const kv = sidebar.find((p) => p.kind === 'keyValue' && textKey(p.title) === textKey(title));
  const row = kv?.rows?.find((r) => textKey(r.key) === textKey(key));
  if (!row) return null;
  const v = row.content
    .map((r) => (typeof r.text === 'string' ? r.text : ''))
    .join('')
    .trim();
  return v === '' ? null : v;
}

/** Whether `phrase` appears in `text` as whole words. */
function phrase(text: string, p: string): boolean {
  const t = ` ${textKey(text).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  const q = ` ${textKey(p)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;
  return q.trim() !== '' && t.includes(q);
}

function isRelationshipHeading(title: string, s: SplitsRules): boolean {
  return Object.entries(s.domains).some(
    ([d, ws]) => (s.destinations[d]?.role ?? '') === 'relationship' && ws.some((w) => phrase(title, w)),
  );
}

/** Every character the repository tree knows (its identity page, subject, and its set's pages). */
function knownCharacters(
  ctx: SplitEnv['basis']['ctx'],
  projectId: string,
): { id: string; subject: string; pages: string[] }[] {
  const out: { id: string; subject: string; pages: string[] }[] = [];
  const t = ctx.tree as unknown as {
    byKind?: (p: string, k: 'bsrc' | 'bwrk') => { data: readonly TreeNode[] };
  };
  if (!t.byKind) return out;
  for (const n of [...t.byKind(projectId, 'bsrc').data, ...t.byKind(projectId, 'bwrk').data]) {
    const rt = textKey(n.referenceType ?? '');
    if (rt !== 'character core' && rt !== 'compact character reference') continue;
    const subject = (n.canonicalDisplayName ?? '').trim() || n.displayName.split(' - ')[0]!.trim();
    const parent = n.parentId ? ctx.tree.node(projectId, n.parentId).data : null;
    const index =
      parent && parent.kind === 'index' && textKey(parent.displayName) === textKey(subject) ? parent : null;
    out.push({
      id: n.id,
      subject,
      pages: index ? [index.id, ...ctx.tree.children(projectId, index.id).data.map((c) => c.id)] : [n.id],
    });
  }
  return out;
}

/**
 * What the job costs with every item approved, from the engine's own rules (src/jobs/op-meta.ts) and what each of the
 * split's checks reads: the first check 2 (the source and its document) plus the pack's governance reads; the
 * destinations check and the verification 2 per destination document and 1 per new page or remapped page; one read
 * before each write the engine reads for (a guarded or versioned write without If-Match), at most two for each Last
 * Major Revision that is set. The tests pin the measured figures.
 */
export function splitCost(steps: readonly StepSpec[]): { writes: number; reads: number } {
  let writes = 0;
  let reads = 0;
  for (const s of steps) {
    const b = (s.params?.body ?? {}) as Obj;
    if (s.op === EXPECT_STEP) {
      for (const c of (b.checks as Obj[] | undefined) ?? []) {
        const input = (c.input ?? {}) as Obj;
        if (c.checker === SPLIT_CHECKS.source) reads += 2;
        else if (c.checker === SPLIT_CHECKS.destinations)
          reads +=
            ((input.moves as Obj[] | undefined) ?? []).reduce(
              (n, m) => n + ((m.dest as Obj | undefined)?.isNew ? 2 : 2),
              0,
            ) + ((input.newPages as unknown[] | undefined) ?? []).length;
        else if (c.checker === SPLIT_CHECKS.verify)
          reads +=
            1 +
            ((input.dests as unknown[] | undefined) ?? []).length * 2 +
            ((input.newPages as unknown[] | undefined) ?? []).length +
            ((input.remaps as unknown[] | undefined) ?? []).length;
        else if (c.checker === PACK_CHECKS.governance) reads += 3;
        else reads += 1;
      }
      continue;
    }
    if (s.op === VERIFY_STEP) {
      reads += ((b.targets as unknown[] | undefined) ?? []).length;
      continue;
    }
    if (s.op === LMR_STEP) {
      reads += 2;
      continue;
    }
    if (s.op.startsWith('bridge.')) continue;
    writes++;
    if (s.op === 'replaceDocumentBlocks' || s.op === 'updateProperty' || s.op === 'updatePropertyRow')
      reads++;
    else if (s.op === 'createPropertyRow' || s.op === 'updateResource') reads++;
  }
  return { writes, reads };
}
