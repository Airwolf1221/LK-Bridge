/**
 * Result shaping shared by every tool (PLAN §7):
 *
 * - every result ends with the one-line budget footer (PLAN §5.4);
 * - default results are summaries (ids, names, counts, versions); `detail: "full"` opts in to whole payloads;
 * - anything over `MCP_RESULT_MAX_CHARS` (about 40,000 characters) is stored as a job artefact and returned as a
 *   handle that `bridge_result_page` pages. Claude Code truncates MCP output at 25,000 tokens, so defaults stay far
 *   below that;
 * - failures become typed `{ error: { code, message, … } }` results, never thrown exceptions.
 */
import type { AutomationService } from '../../automation/service.js';
import type { Packs } from '../../packs/service.js';
import type { Consistency } from '../../consistency/service.js';
import type { Appraisal } from '../../appraisal/service.js';
import type { BlockwiseUndo } from '../../pages/undo.js';
import * as z from 'zod';
import type { ImageService } from '../../images/service.js';
import type { Audits } from '../../audits/service.js';
import type { SnapshotService } from '../../snapshots/service.js';
import type { Restores } from '../../snapshots/restores.js';
import type { AssetQueries } from '../../assets/index.js';
import type { UrlCheck } from '../../assets/service.js';
import type { OutfitStore } from '../../art/store.js';
import type { DocumentVersions } from '../../pages/versions.js';
import type { TemplateKeys } from '../../facts/templates.js';
import type { FactsVersions } from '../../facts/version.js';
import type { RequestRegistry } from '../../resources/requests.js';
import type { ToolsSettings } from '../../config/tools.js';
import type { Registry } from '../../registry/index.js';
import type { TreeQueries } from '../../tree/index.js';
import {
  BudgetExhaustedError,
  JobsError,
  UnknownOperationError,
  LkOperationError,
  PolicyDeniedError,
  UnsupportedBlockLossError,
  VersionConflictError,
  type JobEngine,
  type JobOrigin,
  type OpParams,
  type RunResult,
} from '../../jobs/index.js';
import type { ProjectsRuntime } from '../../projects/registry.js';
import type { Lifecycle } from '../../lifecycle/index.js';
import type { Chronology } from '../../chronology/index.js';
import type {
  ProjectSelector,
  ProjectSelectionError,
  SelectableProjects,
  SelectedProject,
} from '../../projects/selection.js';
import type { ProjectView } from '../../projects/types.js';
import type { McpToolResult } from '../server.js';
import { unknownOperationBody } from './discovery.js';
import type { RenameService } from '../../packs/rename/service.js';
import type { RetagService } from '../../packs/retag/service.js';
import type { SplitService } from '../../packs/split/service.js';
import type { ResumeService } from '../../resume/service.js';
import type { GuardOptions } from './upload-http.js';
import type { WorkstreamDefaults } from '../../workstreams/defaults.js';
import type { WorkstreamReports } from '../../workstreams/report.js';
import type { IdentityService } from '../../packs/identity/service.js';
import type { ArtCache } from '../../art/view/cache.js';

/** The projects as the tools see them (v2 A1): `ProjectRegistry` and `StaticProjects` both provide this. */
export type ToolProjects = ProjectsRuntime & SelectableProjects & { list(): ProjectView[] };

/**
 * The bridge's models the Discover and Read tools answer from (v2 B2): the repository tree, the type registry and the
 * asset tree. Optional so the tool list can be built without them (tests); a tool that needs one says so when called.
 */
export interface DiscoverServices {
  readonly tree: { readonly queries: TreeQueries };
  readonly registry: Pick<Registry, 'forProject'>;
  readonly assets: {
    readonly queries: AssetQueries;
    /** v3 F7 (ADR 0070, G11): image URLs checked against the model, with one live refresh for those it lacks. */
    readonly checkUrls?: (projectId: string, urls: readonly string[]) => Promise<UrlCheck>;
    /** v3 F7 (ADR 0070, G9): a folder and its subfolders read live (the model updated) before anything is decided. */
    readonly refreshFolder?: (
      projectId: string,
      folderId: string | null,
      o?: { depth?: number },
    ) => Promise<{ ok: boolean; requests: number; error?: string }>;
  };
  /**
   * v2 C1: the bridge's memory of recent page versions (src/pages/versions.ts). read_document and write_page record
   * what they read; write_page checks a section edit made from an older version against it.
   */
  readonly versions?: DocumentVersions;
  /** v2 C2a: each project's settings (set_facts' default property, the canonical rules), read live. */
  readonly projectSettings?: (projectId: string) => Readonly<Record<string, unknown>>;
  /** v2 C2a: the templates' fact keys, cached (set_facts puts new template facts in template order). */
  readonly templateKeys?: TemplateKeys;
  /** v2 C2b: the sidebar state at each `factsVersion` handed out (a stale `baseFactsVersion` says what changed). */
  readonly factsVersions?: FactsVersions;
  /** v2 C2b: the create tools' `operation_id` store and duplicate-request claims (src/resources/requests.ts). */
  readonly requests?: RequestRegistry;
  /** v2 C2c: the page lifecycle (settings, records, the link index; src/lifecycle). */
  readonly lifecycle?: Lifecycle;
  /** v2 D1: chronology sync (settings, the calendar cache, records, links; src/chronology). */
  readonly chronology?: Chronology;
  /** v2 D3 (ADR 0041): the image pipeline (upload_image, prepare_image_upload, staging). */
  readonly images?: ImageService;
  /** v2 E1a (ADR 0042): snapshots (list_snapshots, snapshot_diff) and restore proposals (restore_snapshot). */
  readonly snapshots?: SnapshotService;
  readonly restores?: Restores;
  /** v2 E2 (ADR 0044): the audits (audit_findings). */
  readonly audits?: Audits;
  /** v2 E4 (ADR 0046): the undo of a block-by-block page write that stopped part-way. */
  readonly blockwiseUndo?: BlockwiseUndo;
  /** v3 F3a (ADR 0050): the setting packs (their rules, attachments, governance and approval). */
  readonly packs?: Packs;
  /** v3 F3c (ADR 0054): the appraisal tools and the full-text index (read-only; fixes are proposals). */
  readonly appraisal?: Appraisal;
  /** v3 F4b (ADR 0064): the consistency check and "as of a date" (read-only; the owner's pick is a proposal). */
  readonly consistency?: Consistency;
  /** v3 F4c (ADR 0065): a note on a pending proposal (where promoted lore came from). */
  readonly proposals?: { annotate(id: string, note: string): boolean };
  /** v3 F3d (ADR 0058): resuming a package or a rename that stopped part-way (bridge_job_resume). */
  readonly resume?: ResumeService;
  /** v3 F3d (ADR 0058): `arkona_rename`'s records, token versions and leftover reports. */
  readonly renames?: RenameService;
  /** v3 F3e (ADR 0059): `arkona_split_owner`'s records, phase 2 (the source's archive proposal) and reverts. */
  readonly splits?: SplitService;
  /** v3 F3f (ADR 0060): the retag audit, apply batches, the owner's classifications and reconciliations. */
  readonly retag?: RetagService;
  /** v3 F7 (ADR 0070, G3): each character's outfits (placement of outfit art, the art layout audit). */
  readonly outfits?: OutfitStore;
  /** v3 F5b (ADR 0068): which finding codes the automation runs (bridge_info only; agents cannot change a setting). */
  readonly automation?: Pick<AutomationService, 'automated'> & { store: { global(): { paused: boolean } } };
  /** v3 F5c (ADR 0069, H8): each connection's default workstream label (`bridge_workstream`). */
  readonly workstreams?: WorkstreamDefaults;
  /** v3 F5c (ADR 0069, H8): the workstream report (`bridge_workstream_report`, read-only and free). */
  readonly workstreamReports?: WorkstreamReports;
  /** v3 F5c (ADR 0069, H6): `arkona_identity_reconcile`'s records. */
  readonly identity?: IdentityService;
  /** v3 F7b (ADR 0071, D6): the derivatives `arkona_get_art` delivers inline, on the bridge's disk. */
  readonly artCache?: ArtCache;
}

/** What every tool handler needs. */
export interface ToolDeps {
  readonly engine: JobEngine;
  /** Every project's client (for its budget footer) and the `project` argument's choices (v2 A1). */
  readonly projects: ToolProjects;
  /** Resolves the `project` argument (REQUIRE_PROJECT_FOR_WRITES applies to write tools). */
  readonly selector: ProjectSelector;
  readonly settings: ToolsSettings;
  /** v2 B2: the tree, registry and asset tree (the Discover and Read tools). */
  readonly services?: DiscoverServices | undefined;
  readonly version: string;
  /**
   * Hotfix (ADR 0033): names principal ids (a live connection's label, or a removed connection's tombstone with the
   * day it was removed). Without it (tests of the tool layer alone) tools fall back to the profile.
   */
  readonly principalNames?: ((ids: Iterable<string>) => Map<string, { readonly name: string }>) | undefined;
  /** LK_READ_ONLY as configured (the effective flag, which can be overridden at runtime, comes from the engine). */
  readonly configuredReadOnly: boolean;
  /** BRIDGE_PUBLIC_URL: where agents reach the bridge (the binary upload endpoint's address). */
  readonly publicUrl?: string | undefined;
  /** Test seam for the upload guard (resolver, CA, allowed addresses). Never set in production. */
  readonly uploadGuard?: GuardOptions | undefined;
  readonly now?: () => number;
}

/** A tool call's deps, bound to the project the call resolved to (every result names it). */
export interface ProjectDeps extends ToolDeps {
  readonly project: SelectedProject;
}

/** The optional `project` argument every tool takes (v2 A1). */
export const projectArg = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe('Project name or id (list_projects). Required for a write when several projects are served.');

/**
 * Resolves the call's `project` and runs `fn` with deps bound to it. An unknown project, a write with no project while
 * several are served (REQUIRE_PROJECT_FOR_WRITES), or a project not available now is refused here, before anything is
 * sent or recorded.
 */
export function withProject(
  deps: ToolDeps,
  project: string | undefined,
  access: 'read' | 'write',
  fn: (pd: ProjectDeps) => McpToolResult | Promise<McpToolResult>,
): McpToolResult | Promise<McpToolResult> {
  const sel = deps.selector.select(project, access);
  if (!sel.ok) return selectionError(deps, sel.error);
  return fn({ ...deps, project: sel.project });
}

/** The refusal of a `project` argument, with the default project's budget line (it is where a read would go). */
export function selectionError(deps: ToolDeps, error: ProjectSelectionError): McpToolResult {
  const hint =
    error.code === 'PROJECT_REQUIRED'
      ? 'Pass project with one of the names in registered (list_projects shows them all).'
      : 'Call list_projects to see the projects this bridge serves.';
  const text = `${JSON.stringify({ error: { ...error, hint } })}\n${defaultFooter(deps)}`;
  return { content: [{ type: 'text', text }], isError: true };
}

function defaultFooter(deps: Pick<ToolDeps, 'projects'>): string {
  const d = deps.projects.defaultProject();
  return footerFor(deps, d.id, d.name);
}

/** The budget line of one project (each has its own governor), naming it. */
export function footerFor(deps: Pick<ToolDeps, 'projects'>, projectId: string | null, name: string): string {
  const lk = projectId !== null ? deps.projects.anyClient(projectId) : undefined;
  return lk ? lk.budgetFooter(name) : `budget (${name}): not available (the project is not served now)`;
}

// ------------------------------------------------------------------------------------------------ principal

/**
 * Every engine call from a tool uses `mcpOrigin(ctx, tool)` (src/policy): the principal resolved from the
 * server-issued token, the tool's name, and never `approvedBy`. It refuses when the request has no principal, so a
 * tool can never fall back to the `system` principal.
 */
export { mcpOrigin } from '../../policy/mcp.js';

// ------------------------------------------------------------------------------------------------ rendering

/**
 * Compact JSON, then the budget footer on its own last line. Every result names the project it used (v2 A1): an
 * object body gets `project` (the name) unless it already says, and the footer is that project's, naming it.
 */
export function render(
  body: unknown,
  deps: Pick<ProjectDeps, 'projects' | 'project'>,
  isError = false,
): McpToolResult {
  const named =
    body !== null && typeof body === 'object' && !Array.isArray(body) && !('project' in body)
      ? { project: deps.project.name, ...(body as Record<string, unknown>) }
      : body;
  const text = `${JSON.stringify(named)}\n${footerFor(deps, deps.project.id, deps.project.name)}`;
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

export interface ToolErrorBody {
  readonly code: string;
  readonly message: string;
  readonly [key: string]: unknown;
}

export function errorResult(
  error: ToolErrorBody,
  deps: Pick<ProjectDeps, 'projects' | 'project'>,
): McpToolResult {
  return render({ error }, deps, true);
}

const BUDGET_HINT =
  'Nothing was lost and nothing is repeated for you. Do not retry in a loop: wait until retryAt (bridge_budget shows every tier), tell the person if the wait is long, and check bridge_estimate before any bulk work.';

/**
 * What an agent should do next, for the typed errors that carry no hint of their own (E3, ADR 0045). A refusal always
 * names a next step, and never invites a retry of the same call.
 */
const NEXT_STEP: Readonly<Record<string, string>> = {
  READ_ONLY:
    'Nothing was written. This project (or the whole bridge) is read-only; only the owner lifts that, on the dashboard. Tell the person; do not retry or look for another route.',
  DRAINING:
    'The bridge is about to restart and takes no new work. Nothing was written. Wait a few minutes, then send the call once more; do not loop.',
  MEMBER_ADMIN_DISABLED:
    'Changing members or invites is switched off by the owner. Nothing was done. Tell the person; do not look for another route.',
  CASCADE_CONFIRM_REQUIRED:
    'Nothing was deleted. Deleting a page with everything under it needs the person’s say-so: ask them, and only then pass confirm: "cascade". For a high-level delete use delete_resource with confirm: true and cascade: true.',
  TEMPLATES_DESTINATION:
    'Nothing was moved. A page never moves under "templates" (it would leave the repository). Move it under a page of the repository instead; templates are the owner’s.',
  CANONICAL_APPROVAL_REQUIRED:
    'Nothing was written. This change is protected canon: only the owner can accept it, with “Approve and accept as canon”. Tell the person it is waiting for them; never retry it or look for another route.',
  JOB_NOT_FOUND:
    'Only your own jobs in this project are visible. Call bridge_job_status without a jobId to list them, and pass the project the work ran in.',
  UNKNOWN_PROJECT: 'Pass one of the registered project names (list_projects).',
};

function jsonOf(e: JobsError): ToolErrorBody {
  return e.toJSON() as unknown as ToolErrorBody;
}

/** Maps anything an engine call can throw to a typed tool error. */
export function errorFromThrown(e: unknown, deps: Pick<ProjectDeps, 'projects' | 'project'>): McpToolResult {
  if (e instanceof BudgetExhaustedError) {
    return errorResult(
      {
        code: 'BUDGET_EXHAUSTED',
        message: e.message,
        tier: e.tier,
        retryAt: new Date(e.retryAtMs).toISOString(),
        retryAfterSeconds: Math.max(0, Math.ceil((e.retryAtMs - Date.now()) / 1000)),
        hint: BUDGET_HINT,
      },
      deps,
    );
  }
  if (e instanceof LkOperationError) {
    const lk = e.lk;
    return errorResult(
      {
        code: 'LK_ERROR',
        lkCode: lk.code,
        status: lk.status,
        message: lk.message,
        requestId: lk.requestId,
        classification: lk.classification,
        retryable: lk.retryable,
        ...(lk.errors.length > 0 ? { issues: lk.errors } : {}),
        ...(e.jobId ? { jobId: e.jobId, stepNo: e.stepNo } : {}),
        ...(lk.classification === 'budget' ? { hint: BUDGET_HINT } : {}),
      },
      deps,
    );
  }
  if (e instanceof VersionConflictError) {
    return errorResult(
      {
        ...jsonOf(e),
        hint: 'Nothing was written: the entity changed since you read it. Never send the same call again. Read it again, redo your change on what it holds now, and pass the new version.',
      },
      deps,
    );
  }
  if (e instanceof UnsupportedBlockLossError) {
    return errorResult(
      {
        ...jsonOf(e),
        hint: 'Nothing was written. Keep these unsupported blocks in the new content (by id). Pass allowUnsupportedLoss: true only if the person has asked for them to be deleted: ask first. write_page never deletes them.',
      },
      deps,
    );
  }
  if (e instanceof PolicyDeniedError) {
    return errorResult(
      {
        ...jsonOf(e),
        hint: 'This route is closed to this connection. If the message names a tool to use instead, use that one, once. If it names none, tell the person: only the owner can change what a connection may do. Do not try other routes to the same change.',
      },
      deps,
    );
  }
  if (e instanceof UnknownOperationError) {
    // Raised deeper than a tool (a proposal's capture, a batch step): same suggestions, and the hint that never names a
    // tool the caller might not see.
    return errorResult(unknownOperationBody(e.opId, false), deps);
  }
  if (e instanceof JobsError) {
    const next = NEXT_STEP[e.code];
    return errorResult(next ? { ...jsonOf(e), hint: next } : jsonOf(e), deps);
  }
  if (e instanceof z.ZodError) {
    return errorResult({ code: 'INVALID_PARAMS', message: e.message }, deps);
  }
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && e instanceof Error) return errorResult({ code, message: e.message }, deps);
  return errorResult({ code: 'BRIDGE_ERROR', message: e instanceof Error ? e.message : String(e) }, deps);
}

// ------------------------------------------------------------------------------------------------ run results

const WAIT_HINT = 'Do not submit it again. Follow it with bridge_job_status (wait_seconds waits for it).';

/** Shapes an engine `RunResult` for a single-operation tool. Writes that waited or were captured are not errors. */
export function runResultBody(
  opId: string,
  r: RunResult,
  detail: 'summary' | 'full',
): Record<string, unknown> {
  switch (r.status) {
    case 'succeeded':
      return {
        status: 'succeeded',
        operationId: opId,
        ...(r.jobId ? { jobId: r.jobId } : {}),
        result: detail === 'full' ? r.result : summarise(opId, r.result),
        requestIds: r.requestIds,
      };
    case 'queued':
      return {
        status: 'queued',
        operationId: opId,
        jobId: r.jobId,
        reason: r.reason,
        eta: r.eta === null ? null : new Date(r.eta).toISOString(),
        hint:
          r.reason === 'read_only' || r.reason === 'writes_paused'
            ? `Writes are held (${r.reason}); it runs when they resume. ${WAIT_HINT}`
            : `Queued because it is large. ${WAIT_HINT}`,
      };
    case 'waiting_budget':
      return {
        status: 'waiting_budget',
        operationId: opId,
        jobId: r.jobId,
        resumeAt: r.eta === null ? null : new Date(r.eta).toISOString(),
        hint: `The rate budget is exhausted; the write resumes by itself and has NOT failed. Tell the person it is waiting for budget. Never retry it. ${WAIT_HINT}`,
      };
    case 'proposal_captured':
      return {
        status: 'proposal_captured',
        operationId: opId,
        proposalId: r.proposalId,
        ...(r.summary !== undefined ? { summary: r.summary } : {}),
        ...canonicalBody(r),
      };
  }
}

/**
 * v2 C2a: the agent-facing part of a captured proposal: when the write touches protected canon, that it needs the
 * owner's canonical approval (whatever the scope), and why.
 */
export function canonicalBody(
  r: { readonly canonical?: { readonly reason: string }; readonly proposedBecause?: string },
  lead = 'The change needs the owner’s approval and was not made.',
): Record<string, unknown> {
  if (!r.canonical && r.proposedBecause) return railBody(r);
  if (r.canonical) {
    return {
      requiresCanonicalApproval: true,
      reason: r.canonical.reason,
      hint:
        'This touches protected canon, so it was NOT made and waits for the owner, who alone can accept it as canon (whatever your scope). ' +
        'Never retry it or work around it; tell the user, and follow it with bridge_proposal_status.',
    };
  }
  return {
    hint: `${lead} Never retry it; tell the user it is waiting for approval, and follow it with bridge_proposal_status.`,
  };
}

/**
 * v3 F3.4 (ADR 0055): what an agent at scope `write` is told when its profile's safety rail (deletes, bulk changes,
 * renames and moves, asset deletes and moves) made a write a proposal.
 */
export const RAIL_HINT =
  'Your scope is "write", but the owner keeps this kind of change for approval (a safety rail on your profile), so it was NOT made: ' +
  'it waits for the owner. Never retry it, and never split it up or take another route to get round the rail; tell the user, ' +
  'and follow it with bridge_proposal_status.';

/** v3 F3.4: the rail's reason and the hint, when a safety rail made the write a proposal; else nothing. */
export function railBody(r: { readonly proposedBecause?: string }): Record<string, unknown> {
  return r.proposedBecause ? { proposedBecause: r.proposedBecause, hint: RAIL_HINT } : {};
}

// ------------------------------------------------------------------------------------------------ summaries

const SNIPPET = 120;

function clip(s: string, n = SNIPPET): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Scalar fields of an object (long strings clipped); arrays and objects become counts. */
export function project(item: unknown, depth = 0): unknown {
  if (item === null || typeof item !== 'object') return typeof item === 'string' ? clip(item) : item;
  if (Array.isArray(item))
    return depth > 0 ? `[${item.length} items]` : item.map((x) => project(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
    if (v === null || ['number', 'boolean'].includes(typeof v)) out[k] = v;
    else if (typeof v === 'string') out[k] = clip(v);
    else if (Array.isArray(v)) {
      out[k] =
        v.length <= 5 && v.every((x) => typeof x === 'string' || typeof x === 'number')
          ? v
          : `[${v.length} items]`;
    } else out[k] = '{…}';
  }
  return out;
}

function runsText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((r) => {
      const run = r as { text?: unknown; mention?: { text?: unknown } };
      if (typeof run.text === 'string') return run.text;
      if (typeof run.mention?.text === 'string') return run.mention.text;
      return '';
    })
    .join('');
}

interface BlockLike {
  id?: unknown;
  kind?: unknown;
  level?: unknown;
  content?: unknown;
  children?: unknown;
  [key: string]: unknown;
}

function countBlocks(blocks: unknown, acc = { total: 0, unsupported: [] as string[] }) {
  if (!Array.isArray(blocks)) return acc;
  for (const b of blocks as BlockLike[]) {
    acc.total++;
    if (b.kind === 'unsupported' && typeof b.id === 'string') acc.unsupported.push(b.id);
    countBlocks(b.children, acc);
  }
  return acc;
}

const OUTLINE_MAX = 60;

function summariseBlocks(v: Record<string, unknown>): Record<string, unknown> {
  const blocks = Array.isArray(v.blocks) ? (v.blocks as BlockLike[]) : [];
  const counts = countBlocks(blocks);
  return {
    id: v.id,
    version: v.version,
    ...(v.schema !== undefined ? { schema: v.schema } : {}),
    blockCount: counts.total,
    topLevelBlocks: blocks.length,
    ...(counts.unsupported.length > 0 ? { unsupportedBlockIds: counts.unsupported } : {}),
    outline: blocks.slice(0, OUTLINE_MAX).map((b) => {
      const text = clip(runsText(b.content), 80);
      return {
        id: b.id,
        kind: b.kind,
        ...(b.level !== undefined ? { level: b.level } : {}),
        ...(text ? { text } : {}),
        ...(Array.isArray(b.children) && b.children.length > 0 ? { children: b.children.length } : {}),
      };
    }),
    ...(blocks.length > OUTLINE_MAX
      ? { outlineTruncated: `${blocks.length - OUTLINE_MAX} more blocks` }
      : {}),
    note: 'Summary. Pass detail: "full" for the whole block tree.',
  };
}

function summariseBoard(v: Record<string, unknown>): Record<string, unknown> {
  const n = (k: string) => (Array.isArray(v[k]) ? (v[k] as unknown[]).length : 0);
  return {
    version: v.version,
    pages: n('pages'),
    shapes: n('shapes'),
    bindings: n('bindings'),
    assets: n('assets'),
    note: 'Summary. Pass detail: "full" for the whole board; listBoardShapes pages the shapes.',
  };
}

/**
 * A list page's summary stays inline (under about 7,000 tokens) even at 100 rich items: items are projected as
 * usual, and when that would exceed `LIST_SUMMARY_MAX_CHARS` they are reduced to the fields that identify them.
 */
export const LIST_SUMMARY_MAX_CHARS = 24_000;
const ESSENTIAL_KEYS = [
  'id',
  'name',
  'title',
  'type',
  'kind',
  'parentId',
  'resourceId',
  'documentId',
  'version',
];

function essentials(item: unknown): unknown {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return project(item, 1);
  const o = item as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ESSENTIAL_KEYS) {
    const v = o[k];
    if (typeof v === 'string') out[k] = clip(v, 80);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      // Search hits nest the entity ({ resource, document }): keep their identity too.
      out[k] = essentials(v);
    }
  }
  for (const k of ['resource', 'document']) {
    const v = o[k];
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) out[k] = essentials(v);
  }
  return out;
}

function listItems(data: readonly unknown[]): { items: unknown[]; note?: string } {
  const items = data.map((x) => project(x));
  if ((JSON.stringify(items) ?? '').length <= LIST_SUMMARY_MAX_CHARS) return { items };
  return {
    items: data.map((x) => essentials(x)),
    note: 'Items reduced to id, name, type and parent to stay small. Pass detail: "full" (or a smaller limit) for every field.',
  };
}

/** Per-operation shaping of a successful result. Falls back to a generic digest. */
export function summarise(opId: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value ?? null;
  const v = value as Record<string, unknown>;
  if ((opId === 'getDocumentBlocks' || opId === 'replaceDocumentBlocks') && Array.isArray(v.blocks)) {
    return summariseBlocks(v);
  }
  if ((opId === 'getBoardContent' || opId === 'replaceBoardContent') && Array.isArray(v.shapes)) {
    return summariseBoard(v);
  }
  if (Array.isArray(v.data) && ('hasMore' in v || 'nextCursor' in v)) {
    return {
      count: v.data.length,
      hasMore: v.hasMore === true,
      nextCursor: typeof v.nextCursor === 'string' ? v.nextCursor : null,
      ...listItems(v.data),
    };
  }
  if (Array.isArray(v.data)) return { count: v.data.length, ...listItems(v.data) };
  const text = JSON.stringify(v);
  if (text.length <= 6_000) return v;
  return { ...(project(v) as object), note: 'Large result shortened. Pass detail: "full" for everything.' };
}

/** A short, depth-limited look at a value, for the preview that accompanies an artefact handle. */
export function preview(value: unknown, maxChars = 1_500): unknown {
  const text = JSON.stringify(summarise('', value));
  return text.length <= maxChars ? JSON.parse(text) : `${text.slice(0, maxChars)}…`;
}

// ------------------------------------------------------------------------------------------------ oversize

export interface StoredHandle {
  readonly status: 'stored';
  readonly handle: string;
  readonly jobId: string;
  readonly chars: number;
  readonly preview: unknown;
  readonly hint: string;
}

/**
 * Applies the size rule to a read's result: summary (or full) inline when it fits; otherwise the whole value is
 * stored as a `result` artefact (a succeeded one-step job) and a handle comes back.
 */
export function shapeRead(
  deps: ProjectDeps,
  args: {
    readonly opId: string;
    readonly params: OpParams;
    readonly value: unknown;
    readonly detail: 'summary' | 'full';
    readonly origin: JobOrigin;
  },
): { readonly inline: unknown } | StoredHandle {
  const shaped = args.detail === 'full' ? args.value : summarise(args.opId, args.value);
  const text = JSON.stringify(shaped) ?? 'null';
  if (text.length <= deps.settings.resultMaxChars) return { inline: shaped };
  const stored = deps.engine.recordResult({
    project: deps.project.id,
    opId: args.opId,
    params: args.params,
    value: args.value,
    origin: args.origin,
  });
  return {
    status: 'stored',
    handle: stored.artifactId,
    jobId: stored.jobId,
    chars: text.length,
    preview: preview(args.value),
    hint: 'Too large to return in one piece. Read it with bridge_result_page({ handle, offset }), a page at a time.',
  };
}
