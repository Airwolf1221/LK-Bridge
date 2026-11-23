/**
 * `arkona_identity_reconcile` (v3 F5c, ADR 0069, H6): bulk identity facts with their tags, as ONE job with one item per
 * character, so a maintenance objective (a culture split's 27 Naming Culture changes) is one coherent, verified job
 * instead of a character at a time by hand. The approval boundaries are unchanged: at scope `propose` it is a proposal;
 * at `write` it runs directly for 10 pages or fewer, and the bulk rail makes more a proposal whose items the owner
 * approves in part or whole; the canon guard, the lifecycle guard and the rails judge it as any write.
 *
 * Per item: the identity page is resolved (the Character Core, else the Compact Character Reference, else the
 * identity-owning Character Reference; an [INDEX] to its Core; a name naming several is refused with the candidates),
 * read fresh (`getResource`: its facts, tags and `factsVersion`), and validated: only the identity facts (Race /
 * Species, Naming Culture, Life State, Personal / Given Name, Family / Surname, Temporal Scope); a Canonical Display
 * Name is a rename (`USE_ARKONA_RENAME`); protected and lifecycle facts are refused with their tool; Race and Naming
 * Culture values must map through the pack's token maps. A Naming Culture gets `arkona_name_check`'s culture report.
 * Then set_facts' own plan for the facts, and the retag engine's array for the tags from the NEW facts under the
 * approved policy (grammar order, supplementary tags kept): a hold or an exception writes no tags, and says why.
 *
 * The job (src/packs/identity/checks.ts): per item a fresh in-job read (a changed sidebar skips only that character),
 * the fact writes (If-Match chained), their read-back, the tag write (judged inside its lock), its read-back. Failures
 * are isolated per item (`isolateItems`); the job can be resumed. Last Major Revision follows the owner's rule. When it
 * ends, each character is checked for consistency (free) and the result is itemised.
 */
import * as z from 'zod';
import { extractSidebar } from '../../audits/model.js';
import { expandFacts } from '../../facts/expand.js';
import { FactsPlanError, planFacts, type FactsPlan } from '../../facts/plan.js';
import { sidebarFrom } from '../../facts/sidebar.js';
import { FactValueError, factValueRuns } from '../../facts/values.js';
import { factsVersionFrom } from '../../facts/version.js';
import { EXPECT_STEP, VERIFY_STEP } from '../../jobs/internal-steps.js';
import { mapStepRefs, type PlanItem } from '../../jobs/items.js';
import { stateHash } from '../../jobs/sidebar-state.js';
import type { StepSpec } from '../../jobs/types.js';
import { lifecycleFrom } from '../../lifecycle/settings.js';
import { textKey } from '../../packs/engine/text.js';
import { tokenFor } from '../../packs/engine/tags.js';
import { IDENTITY_CHECKS, IDENTITY_REBASERS } from '../../packs/identity/checks.js';
import { IDENTITY_TOOL, summaryOf } from '../../packs/identity/service.js';
import type { IdentityRecord, PlannedItem } from '../../packs/identity/store.js';
import { nameCheck, NEVER_INFER } from '../../packs/naming/check.js';
import {
  characterTypeOf,
  currentCharacters,
  nameKeyOf,
  treeLabeller,
} from '../../packs/naming/namesakes.js';
import { RETAG_CHECKS } from '../../packs/retag/checks.js';
import { RetagError } from '../../packs/retag/service.js';
import type { PackRules, TypeRules } from '../../packs/types.js';
import { pageConverterContext } from '../../pages/index.js';
import { cleanPrefixes } from '../../registry/names.js';
import { sidebarPiece } from '../../snapshots/canonical.js';
import type { TreeNode } from '../../tree/index.js';
import { currentWorkstream } from '../../workstreams/context.js';
import type { McpToolContext, McpToolProvider, McpToolResult } from '../server.js';
import { defineTool } from './define.js';
import { identityReferenceTypes } from './query-facts.js';
import { finish, repoContext, type RepoCtx } from './repo.js';
import { lastMajorRevisionArg } from './schemas.js';
import { templateKeysFor } from './set-facts.js';
import {
  errorFromThrown,
  errorResult,
  mcpOrigin,
  projectArg,
  railBody,
  render,
  withProject,
  type ProjectDeps,
  type ToolDeps,
} from './shape.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

const PACK = 'arkona';
export const MAX_ITEMS = 100;
const WAIT_MS = 25_000;
const norm = (s: string) => s.normalize('NFC').trim().toLowerCase();

/** The identity fields this tool sets (the pack's gated identity fields), by field. */
const SETTABLE = ['race', 'namingCulture', 'lifeState', 'givenName', 'surname', 'temporalScope'] as const;
/** Keys that name the character: changing them is a rename. */
const RENAME_KEYS = ['Canonical Display Name', 'Subject', 'Name', 'Page Name', 'Display Name'];
/** Protected and lifecycle facts, with the tool that changes each. */
const PROTECTED: Readonly<Record<string, string>> = {
  status: 'promote_page, archive_page or move_to_working (the lifecycle tools; always the owner’s canonical approval)',
  'continuity type': 'set_facts (always a proposal the owner accepts as canon)',
  continuity: 'set_facts (always a proposal the owner accepts as canon)',
  'last major revision': 'the bridge’s rule (pass lastMajorRevision: "set" or "skip" to override it)',
  inheritance: 'set_facts',
  supersedes: 'set_facts',
  'reference type': 'set_facts',
  aliases: 'set_facts (aliases), or arkona_rename for a new name',
};

const itemSchema = z
  .object({
    character: z.string().min(1).max(500).describe('The character: a name, alias, path or id (its index resolves to its Core).'),
    facts: z
      .record(z.string().min(1).max(256), z.string().min(1).max(2000))
      .describe('Identity fact → value: Race / Species, Naming Culture, Life State, Personal / Given Name, Family / Surname, Temporal Scope.'),
  })
  .strict();

interface Resolved {
  readonly node: TreeNode;
  readonly subject: string;
  readonly role: string;
}

/** The identity page of a character the caller named, or why not. */
function resolveCharacter(
  ctx: RepoCtx,
  type: TypeRules,
  idTypes: ReadonlySet<string>,
  scan: ReturnType<typeof currentCharacters>,
  labels: ReturnType<typeof treeLabeller>,
  q: string,
): { ok: true; r: Resolved } | { ok: false; code: string; message: string; extra?: Obj } {
  const roleOf = (n: TreeNode) =>
    type.roles.find((r) => r.referenceType && n.referenceType && textKey(r.referenceType) === textKey(n.referenceType))
      ?.referenceType ?? n.referenceType ?? 'identity page';
  const isIdentity = (n: TreeNode) =>
    n.kind !== 'index' && n.referenceType !== null && idTypes.has(textKey(n.referenceType));
  const identityOf = (n: TreeNode): TreeNode | null => {
    if (isIdentity(n)) return n;
    const c = ctx.types.characterOfPage(n.id);
    if (c.ok) {
      const core = ctx.tree.node(ctx.projectId, c.value.core.id).data;
      if (core) return core;
    }
    if (n.kind === 'index') {
      const kids = ctx.tree.children(ctx.projectId, n.id).data.filter(isIdentity);
      const order = [...idTypes];
      kids.sort((a, b) => order.indexOf(textKey(a.referenceType!)) - order.indexOf(textKey(b.referenceType!)));
      return kids[0] ?? null;
    }
    return null;
  };
  const raw = q.trim().replace(/^lk:\/\/resources\//, '');
  const found = new Map<string, TreeNode>();
  const direct = ctx.tree.node(ctx.projectId, raw).data;
  const starts: TreeNode[] = direct
    ? [direct]
    : [
        ...ctx.tree.findByName(ctx.projectId, raw).data.map((m) => m.node),
        ...ctx.tree.findByName(ctx.projectId, cleanPrefixes(raw).name || raw).data.map((m) => m.node),
      ];
  for (const n of starts) {
    const id = identityOf(n);
    if (id) found.set(id.id, id);
  }
  if (found.size === 0) {
    const k = nameKeyOf(cleanPrefixes(raw).name || raw);
    for (const c of scan.characters)
      if ([...c.names.full, ...c.names.aliases].some((x) => nameKeyOf(x) === k)) {
        const n = ctx.tree.node(ctx.projectId, c.identity.id).data;
        if (n) found.set(n.id, n);
      }
  }
  const all = [...found.values()];
  if (all.length === 0)
    return {
      ok: false,
      code: 'CHARACTER_NOT_FOUND',
      message: `“${q}” names no character’s identity page (a Character Core, a Compact Character Reference or an identity-owning Character Reference) the bridge knows.`,
    };
  if (all.length > 1)
    return {
      ok: false,
      code: 'CHARACTER_AMBIGUOUS',
      message: `“${q}” names ${all.length} characters: pass the identity page’s id.`,
      extra: {
        candidates: all.map((n) => ({
          id: n.id,
          name: n.rawName,
          referenceType: n.referenceType,
          lifecycle: labels(n).lifecycle,
          path: n.path.names.join(' / '),
        })),
      },
    };
  const node = all[0]!;
  const l = labels(node);
  if (node.kind === 'barc' || l.lifecycle === 'Archived' || l.area !== null)
    return {
      ok: false,
      code: 'NOT_CURRENT',
      message: `“${node.rawName}” is ${l.area ? `in a non-current area (${l.area})` : 'Archived'}: history is never changed by this tool.`,
    };
  const subject =
    ctx.types.characterRole(node.id)?.subject ?? cleanPrefixes(node.displayName).name.split(' - ')[0]!.trim();
  return { ok: true, r: { node, subject, role: roleOf(node) } };
}

/** The first JSON line of a tool result. */
function bodyOf(r: McpToolResult): Obj | null {
  const t = r.content[0];
  if (!t || !('text' in t)) return null;
  try {
    const v = JSON.parse(t.text.split('\n')[0]!) as unknown;
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** The name check's culture report, trimmed for an item (owners, members, namesakes). */
async function cultureCheck(
  pd: ProjectDeps,
  mctx: McpToolContext,
  value: string,
  subject: string,
  pageId: string,
): Promise<Obj> {
  const r = await nameCheck(pd, mctx, {
    packId: PACK,
    tool: IDENTITY_TOOL,
    input: { namingCulture: value, name: subject, exclude: [pageId] },
    full: false,
  });
  const b = bodyOf(r);
  if (!b || r.isError) return { value, error: b?.error ?? 'the name check could not run' };
  const nc = isObj(b.namingCulture) ? b.namingCulture : {};
  const members = isObj(nc.members) ? nc.members : {};
  return {
    value,
    mapped: nc.mapped ?? null,
    ...(nc.token !== undefined ? { token: nc.token } : {}),
    owners: Array.isArray(nc.owners) ? (nc.owners as Obj[]).map((o) => ({ id: o.id, name: o.name })) : [],
    members: {
      count: members.count ?? 0,
      characters: Array.isArray(members.characters)
        ? (members.characters as Obj[]).slice(0, 10).map((c) => c.character)
        : [],
    },
    namesakes: Array.isArray(b.namesakes)
      ? (b.namesakes as Obj[]).slice(0, 5).map((n) => ({ character: n.character, severity: n.severity }))
      : [],
    ...(typeof nc.note === 'string' ? { note: nc.note } : {}),
  };
}

/** One item's view in an answer. */
function itemView(p: PlannedItem): Obj {
  return {
    character: p.character,
    ...(p.asked !== p.character ? { asked: p.asked } : {}),
    page: p.page,
    status: p.status,
    ...(p.refusal ? { refusal: p.refusal } : {}),
    ...(p.facts ? { facts: p.facts.filter((f) => f.change !== 'unchanged') } : {}),
    ...(p.facts?.some((f) => f.change === 'unchanged')
      ? { unchanged: p.facts.filter((f) => f.change === 'unchanged').map((f) => f.key) }
      : {}),
    ...(p.tags ? { tags: p.tags } : {}),
    ...(p.nameCheck ? { nameCheck: p.nameCheck } : {}),
  };
}

function recordBody(rec: IdentityRecord): Obj {
  const plan = new Map(rec.plan.items.map((p) => [p.item, p]));
  const items = rec.outcome
    ? rec.outcome.items.map((o) => {
        const p = plan.get(o.item);
        return {
          ...o,
          ...(p?.facts ? { planned: p.facts.filter((f) => f.change !== 'unchanged') } : {}),
          ...(p?.tags ? { plannedTags: p.tags } : {}),
        };
      })
    : rec.plan.items.map(itemView);
  const followUps = rec.outcome
    ? rec.outcome.items.flatMap((o) =>
        (o.followUps ?? []).map((f) => ({ character: o.character, ...f })),
      )
    : [];
  return {
    reconcileId: rec.id,
    state: rec.state,
    ...(rec.jobId ? { jobId: rec.jobId } : {}),
    ...(rec.proposalId ? { proposalId: rec.proposalId } : {}),
    ...(rec.workstream ? { workstream: rec.workstream } : {}),
    summary: rec.outcome?.summary ?? `${rec.plan.items.length} character(s) planned; the job has not ended`,
    items,
    ...(followUps.length > 0 ? { followUps } : {}),
  };
}

export function identityReconcileTool(deps: ToolDeps): McpToolProvider {
  const packs = () => deps.services?.packs;
  const listed = () =>
    (packs()?.toolListed(PACK) ?? false) &&
    (packs()?.peek(PACK)?.rules.types.some((t) => t.hook === 'character') ?? false);
  return defineTool({
    name: IDENTITY_TOOL,
    title: 'Set many characters’ identity facts and their tags (Arkona pack)',
    access: 'write',
    listed,
    description:
      'The Arkona pack: ONE bounded job for many characters’ identity facts (a culture split, a race correction): for each item { character, facts } it resolves the identity page (Character Core, else Compact Character Reference, else the identity-owning Character Reference; an [INDEX] goes to its Core), reads it fresh, sets ONLY the facts given, recomputes the page’s tags from the new facts under the approved tagging policy (grammar order, supplementary tags kept), and reads both back. Allowed facts: Race / Species, Naming Culture, Life State, Personal / Given Name, Family / Surname, Temporal Scope. Race and Naming Culture values must be in the pack’s token maps (an unmapped one refuses that item only: ask the owner). A Canonical Display Name or name change is a rename (arkona_rename); Status, Continuity Type, Continuity and other protected facts are refused with their tool. Each Naming Culture gets arkona_name_check’s culture report. A tag result that would be a hold or an exception writes no tags and says why (the facts are still written). ' +
      'Failures are isolated: a character that changed since it was read, or whose write fails, is reported and the others carry on; the job can be resumed. Result: each item done and verified, partly done (facts written, tags held, and why), skipped or failed (and why), with consistency follow-ups. ALWAYS run dryRun first (the full itemised preview: planned facts and tag arrays; nothing written). ' +
      'At scope write it runs directly for 10 pages or fewer; more becomes ONE proposal with one item per character (the owner approves some or all); at scope propose it is a proposal. Never retry a proposal or a queued job: follow it with { report: reconcileId }. It never infers a culture, race or nationality, and never renames or moves anything. Example: { "items": [{ "character": "Al-Mansur XII", "facts": { "Naming Culture": "Ancient Menkheti" } }], "workstream": "Menkheti culture split", "dryRun": true, "project": "arkona" }. Cost: 1 read per character to plan; then per character about 3 reads, 1 write per fact changed, 1 tag write and 2 read-backs.',
    inputSchema: z.object({
      items: z.array(itemSchema).min(1).max(MAX_ITEMS).optional(),
      reconcileTags: z.boolean().optional().describe('Recompute and write the tags from the new facts (default true).'),
      dryRun: z.boolean().optional().describe('The full itemised preview; nothing written.'),
      lastMajorRevision: lastMajorRevisionArg,
      report: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe('A reconcileId (or its jobId): the itemised result as it stands (free).'),
      project: projectArg,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: (args, mctx) =>
      withProject(deps, args.project, 'write', async (pd) => {
        const service = pd.services?.identity;
        if (!service)
          return errorResult({ code: 'TOOL_UNAVAILABLE', message: 'This tool is not available on this bridge.' }, pd);
        if (args.report !== undefined) {
          let rec =
            service.records.get(args.report) ?? service.records.byJob(pd.project.id, args.report) ?? null;
          if (!rec || rec.projectId !== pd.project.id)
            return errorResult({ code: 'NOT_FOUND', message: `No reconcile ${args.report} in this project.` }, pd);
          rec = await service.current(rec);
          return finish(pd, mctx, IDENTITY_TOOL, { ...recordBody(rec), cost: 'none' }, () => ({
            reconcileId: rec.id,
            summary: rec.outcome?.summary ?? null,
          }));
        }
        if (!args.items || args.items.length === 0)
          return errorResult({ code: 'INVALID_PARAMS', message: 'Give items (or report).' }, pd);
        try {
          return await plan(pd, mctx, { ...args, items: args.items });
        } catch (e) {
          if (e instanceof RetagError)
            return errorResult({ code: e.code, message: e.message, ...e.details }, pd);
          return errorFromThrown(e, pd);
        }
      }),
  });
}

async function plan(
  pd: ProjectDeps,
  mctx: McpToolContext,
  args: {
    readonly items: readonly { character: string; facts: Record<string, string> }[];
    readonly reconcileTags?: boolean | undefined;
    readonly dryRun?: boolean | undefined;
    readonly lastMajorRevision?: 'auto' | 'set' | 'skip' | undefined;
  },
): Promise<McpToolResult> {
  const services = pd.services!;
  const packs = services.packs;
  const retag = services.retag;
  const service = services.identity!;
  if (!packs || !retag)
    return errorResult({ code: 'TOOL_UNAVAILABLE', message: 'Setting packs are not available here.' }, pd);
  const pack = packs.get(PACK);
  if (!pack || !packs.attachment(PACK, pd.project.id))
    return errorResult(
      { code: 'PACK_NOT_ATTACHED', message: `The Arkona pack is not attached to the project ${pd.project.name}.` },
      pd,
    );
  const rules: PackRules | null = packs.approvedRules(PACK);
  if (!pack.approved || !rules)
    return errorResult(
      { code: 'PACK_NOT_CURRENT', message: 'No version of the Arkona pack is approved yet: the owner approves it on the Packs page.' },
      pd,
    );
  const reconcileTags = args.reconcileTags !== false;
  // Fails closed (PACK_NOT_CURRENT, RETAG_UNAVAILABLE) before anything is read, when the tags are to be reconciled.
  const policy = reconcileTags ? retag.policyFor(pd.project.id).policy : null;
  const type = characterTypeOf(rules);
  if (!type)
    return errorResult({ code: 'NO_CHARACTER_TYPE', message: 'The approved Arkona pack version has no character type.' }, pd);
  const rc = repoContext(pd);
  if (!rc.ok) return rc.result;
  const ctx = rc.ctx;
  const settings = services.projectSettings?.(ctx.projectId) ?? {};
  const lifecycle = lifecycleFrom(settings);
  const labels = treeLabeller(ctx, lifecycle);
  const scan = currentCharacters({ ctx, rules, lifecycle });
  const idTypes = new Set(identityReferenceTypes(rules).map(textKey));
  const propertyTitle =
    typeof settings.factsPropertyName === 'string' ? settings.factsPropertyName : rules.sidebar.property;
  const keyOf = (field: string) => type.identity.find((f) => f.field === field)?.key;
  const settable = new Map<string, { field: string; key: string }>();
  for (const f of SETTABLE) {
    const k = keyOf(f);
    if (k) settable.set(textKey(k), { field: f, key: k });
  }
  const raceKey = keyOf('race');
  const cultureKey = keyOf('namingCulture');
  const never = new Set([...rules.tags.never, type.unestablished].map(textKey));
  const placeholders = new Set(type.placeholders.map((p) => p.trim().toLowerCase()));

  // 1. Each item: its keys and values, then its identity page (nothing read yet).
  interface Draft {
    readonly item: string;
    readonly asked: string;
    readonly facts: { key: string; value: string }[];
    character: string;
    page: Resolved | null;
    refusal: ({ code: string; message: string } & Obj) | null;
  }
  const drafts: Draft[] = args.items.map((it, i) => ({
    item: `char:${i + 1}`,
    asked: it.character,
    facts: [],
    character: it.character,
    page: null,
    refusal: null,
  }));
  const seen = new Map<string, string>();
  args.items.forEach((it, i) => {
    const d = drafts[i]!;
    const refuse = (code: string, message: string, extra: Obj = {}) => {
      if (!d.refusal) d.refusal = { code, message, ...extra };
    };
    const entries = Object.entries(it.facts);
    if (entries.length === 0) refuse('INVALID_PARAMS', 'Give at least one identity fact.');
    for (const [rawKey, rawValue] of entries) {
      const k = textKey(rawKey);
      const value = rawValue.trim();
      if (RENAME_KEYS.some((r) => textKey(r) === k)) {
        refuse(
          'USE_ARKONA_RENAME',
          `${rawKey} names the character: changing it is a rename. Use arkona_rename (it renames every page of the set, the identity facts, routing lines and restatements, as one proposal).`,
          { key: rawKey, hint: 'arkona_rename { subject, newName }' },
        );
        continue;
      }
      const prot = PROTECTED[norm(rawKey)];
      if (prot) {
        refuse('PROTECTED_FACT', `${rawKey} is not an identity fact this tool sets: use ${prot}.`, { key: rawKey });
        continue;
      }
      const s = settable.get(k);
      if (!s) {
        refuse(
          'NOT_AN_IDENTITY_FACT',
          `${rawKey} is not one of the identity facts (${[...settable.values()].map((x) => x.key).join(', ')}); use set_facts for other facts.`,
          { key: rawKey },
        );
        continue;
      }
      if (value === '' || placeholders.has(value.toLowerCase())) {
        refuse('PLACEHOLDER_VALUE', `${s.key}: “${rawValue}” is a placeholder, not a value. Ask the owner (“${type.unestablished}” only with their reason).`, { key: s.key });
        continue;
      }
      if (s.key === raceKey && !never.has(textKey(value))) {
        const token = tokenFor(rules.tags.race, value) ?? rules.tags.exceptional.find((x) => textKey(x) === textKey(value)) ?? null;
        if (token === null) {
          refuse(
            'UNMAPPED_VALUE',
            `${s.key}: “${value}” has no approved race token in the pack’s race map. Ask the owner; they add it on the Packs page. Never choose one from the name.`,
            { key: s.key, value },
          );
          continue;
        }
      }
      if (s.key === cultureKey && !never.has(textKey(value)) && tokenFor(rules.tags.culture, value) === null) {
        refuse(
          'UNMAPPED_VALUE',
          `${s.key}: “${value}” has no approved culture token in the pack’s culture map. Ask the owner; they add it on the Packs page. Never choose one from the name.`,
          { key: s.key, value },
        );
        continue;
      }
      d.facts.push({ key: s.key, value });
    }
    const r = resolveCharacter(ctx, type, idTypes, scan, labels, it.character);
    if (!r.ok) {
      refuse(r.code, r.message, r.extra ?? {});
      return;
    }
    d.page = r.r;
    d.character = r.r.subject;
    const dup = seen.get(r.r.node.id);
    if (dup) refuse('DUPLICATE_CHARACTER', `The same character as ${dup}: give each character once.`);
    else seen.set(r.r.node.id, d.item);
  });

  // 2. One fresh read of each identity page (one job, as get_resource reads several).
  const toRead = drafts.filter((d) => !d.refusal && d.page).map((d) => d.page!.node);
  const reads = new Map<string, Obj>();
  if (toRead.length > 0) {
    const { workstream: _ws, ...readOrigin } = mcpOrigin(mctx, IDENTITY_TOOL);
    void _ws;
    const sub = await pd.engine.submit({
      kind: 'batch_ops',
      project: pd.project.id,
      steps: toRead.map((n) => ({ op: 'getResource', params: { path: { resourceId: n.id } } })),
      onError: 'continue',
      origin: readOrigin,
      priority: 'P1',
      title: `${IDENTITY_TOOL}: read ${toRead.length} identity page${toRead.length === 1 ? '' : 's'}`,
    });
    if (!('jobId' in sub)) return errorResult({ code: 'BRIDGE_ERROR', message: 'The reads were not accepted.' }, pd);
    const job = await pd.engine.wait(pd.project.id, sub.jobId, WAIT_MS);
    const results =
      job.status === 'succeeded' || job.status === 'failed' ? pd.engine.stepResults(pd.project.id, sub.jobId) : undefined;
    if (!results)
      return render(
        {
          status: 'reading',
          jobId: sub.jobId,
          hint: 'The fresh reads are waiting for LegendKeeper’s rate budget; nothing was planned or written. Call again once bridge_job_status shows this job finished.',
        },
        pd,
      );
    results.forEach((st, i) => {
      if (st.status === 'succeeded' && isObj(st.value)) reads.set(toRead[i]!.id, st.value);
    });
  }

  // 3. Each item's plan: the facts (set_facts' planner), the tags (the retag engine on the new facts), the name check.
  const converter = pageConverterContext(services, ctx.projectId, {});
  const planned: PlannedItem[] = [];
  const factsPlans = new Map<string, { plan: FactsPlan; sidebar: ReturnType<typeof sidebarFrom>; res: Obj }>();
  for (const d of drafts) {
    const base = { item: d.item, asked: d.asked, character: d.character };
    const pageView = d.page ? { id: d.page.node.id, name: d.page.node.rawName, role: d.page.role } : null;
    if (d.refusal) {
      planned.push({ ...base, page: pageView, status: 'refused', refusal: d.refusal });
      continue;
    }
    const node = d.page!.node;
    const res = reads.get(node.id);
    if (!res) {
      planned.push({
        ...base,
        page: pageView,
        status: 'refused',
        refusal: { code: 'PAGE_UNREADABLE', message: 'Its identity page could not be read now; nothing was planned for it.' },
      });
      continue;
    }
    const sidebar = sidebarFrom(res);
    const fv = factsVersionFrom(node.id, res);
    services.factsVersions?.store(ctx.projectId, node.id, fv.version, fv.state);
    let facts: { key: string; value: Obj[] }[];
    try {
      facts = d.facts.map((f) => ({ key: f.key, value: factValueRuns(f.value, converter!) }));
    } catch (e) {
      const code = e instanceof FactValueError ? e.code : 'INVALID_VALUE';
      planned.push({
        ...base,
        page: pageView,
        status: 'refused',
        refusal: { code, message: e instanceof Error ? e.message : String(e) },
      });
      continue;
    }
    const kv = sidebar.filter((p) => p.kind === 'keyValue' && textKey(p.title) === textKey(propertyTitle));
    const have = new Set((kv[0]?.rows ?? []).map((r) => textKey(r.key)));
    let templateKeys: readonly string[] | null = null;
    if (facts.some((f) => !have.has(textKey(f.key)))) {
      const t = await templateKeysFor(pd, mctx, ctx, node, facts, kv[0]?.rows ?? [], propertyTitle);
      if (t.ok) templateKeys = t.keys;
    }
    let fplan: FactsPlan;
    try {
      fplan = planFacts({ resourceId: node.id, sidebar, propertyTitle, facts, links: [], templateKeys });
    } catch (e) {
      planned.push({
        ...base,
        page: pageView,
        status: 'refused',
        refusal:
          e instanceof FactsPlanError
            ? { code: e.code, message: e.message }
            : { code: 'PLAN_FAILED', message: e instanceof Error ? e.message : String(e) },
      });
      continue;
    }
    const factRows = fplan.facts.map((f) => ({
      key: f.key,
      before: f.before ?? null,
      after: f.after ?? '',
      change: f.change,
    }));
    // The tags from the new facts.
    const current = list(res.tags);
    let tags: NonNullable<PlannedItem['tags']> = { status: 'off', current, proposed: current };
    if (reconcileTags) {
      const extracted = extractSidebar(sidebarPiece(res.properties ?? []), propertyTitle).facts;
      const cells = new Map<string, { text: string; count: number }>();
      for (const [k, v] of extracted) cells.set(k, { text: v.text, count: v.count });
      // The token each identity value maps to (race: its map or the exceptional kinds; culture: its map).
      const tokenOf = (key: string | undefined, value: string | undefined): string | null => {
        if (!key || value === undefined || never.has(textKey(value))) return null;
        if (key === raceKey)
          return (
            tokenFor(rules.tags.race, value) ??
            rules.tags.exceptional.find((x) => textKey(x) === textKey(value)) ??
            null
          );
        if (key === cultureKey) return tokenFor(rules.tags.culture, value);
        return null;
      };
      const before = (key: string | undefined) => (key ? extracted.get(norm(key))?.text : undefined);
      for (const f of d.facts) cells.set(norm(f.key), { text: f.value, count: 1 });
      const after = (key: string | undefined) => (key ? cells.get(norm(key))?.text : undefined);
      // The old value's own token, which this change replaces with the new value's: only that exact tag, only when the
      // new value maps to another token, and never one the page's other identity slot still gives (the Standard's
      // shared race and culture token). Never inferred: the tag the old fact made, for the tag the new fact makes.
      const stillGiven = new Set(
        [tokenOf(raceKey, after(raceKey)), tokenOf(cultureKey, after(cultureKey))]
          .filter((x): x is string => x !== null)
          .map(textKey),
      );
      const replaced: { tag: string; why: string }[] = [];
      for (const f of d.facts) {
        if (f.key !== raceKey && f.key !== cultureKey) continue;
        const oldTok = tokenOf(f.key, before(f.key));
        const newTok = tokenOf(f.key, f.value);
        if (oldTok === null || newTok === null || textKey(oldTok) === textKey(newTok)) continue;
        if (stillGiven.has(textKey(oldTok))) continue;
        const t = current.find((x) => textKey(x) === textKey(oldTok));
        if (t)
          replaced.push({
            tag: t,
            why: `the token of the old ${f.key} (“${before(f.key)}”), replaced by “${newTok}”, the token of “${f.value}”`,
          });
      }
      const engineTags = current.filter((t) => !replaced.some((x) => x.tag === t));
      const l = labels(node);
      const { verdict } = retag.verdictFor(ctx.projectId, {
        id: node.id,
        rawName: typeof res.name === 'string' ? res.name : node.rawName,
        kind: node.kind,
        tags: engineTags,
        facts: cells,
        lifecycle: l.lifecycle,
        ancestors: node.path.names.slice(0, -1),
        area: l.area,
        parentId: typeof res.parentId === 'string' ? res.parentId : null,
      });
      if (verdict.scope !== 'grammar')
        tags = {
          status: 'not_applicable',
          current,
          proposed: current,
          reason:
            verdict.scope === 'lifecycle'
              ? 'a Working page: only the lifecycle grammar applies until it is promoted; its tags are left as they are'
              : `outside the automatic grammar (${verdict.excluded?.reason ?? 'excluded'}); its tags are left as they are`,
          disposition: verdict.disposition,
        };
      else if (verdict.disposition === 'correction' || verdict.disposition === 'compliant') {
        const proposed = [...verdict.proposed];
        tags =
          proposed.length === current.length && proposed.every((t, i) => t === current[i])
            ? { status: 'already_correct', current, proposed: current, disposition: 'compliant' }
            : {
                status: 'write',
                current,
                proposed,
                disposition: 'correction',
                ...(replaced.length > 0 ? { replaced } : {}),
              };
      } else
        tags = {
          status: 'held',
          current,
          proposed: [...verdict.proposed],
          disposition: verdict.disposition,
          reason:
            verdict.disposition === 'hold'
              ? `a hold: ${verdict.holds.map((h) => h.reason).join('; ')}`
              : `an exception for the owner: ${verdict.exceptions.map((x) => `${x.tag} (${x.reason})`).join('; ')}`,
        };
    }
    const culture = d.facts.find((f) => f.key === cultureKey);
    const nameCheckReport = culture
      ? await cultureCheck(pd, mctx, culture.value, d.character, node.id)
      : undefined;
    const nothing = fplan.empty && tags.status !== 'write';
    planned.push({
      ...base,
      page: pageView,
      status: nothing ? 'no_change' : 'planned',
      facts: factRows,
      factsVersion: fv.version,
      tags,
      ...(nameCheckReport ? { nameCheck: nameCheckReport } : {}),
    });
    if (!nothing) factsPlans.set(d.item, { plan: fplan, sidebar, res });
  }

  const refused = planned.filter((p) => p.status === 'refused').length;
  const toRun = planned.filter((p) => p.status === 'planned');
  const head = {
    reconcileTags,
    ...(policy ? { policy: { version: policy.version, digest: policy.digest.slice(0, 16), label: policy.label } } : {}),
    counts: {
      items: planned.length,
      planned: toRun.length,
      noChange: planned.filter((p) => p.status === 'no_change').length,
      refused,
      tagsWritten: toRun.filter((p) => p.tags?.status === 'write').length,
      tagsHeld: toRun.filter((p) => p.tags?.status === 'held').length,
    },
    rule: NEVER_INFER,
  };
  if (args.dryRun === true || toRun.length === 0) {
    return finish(
      pd,
      mctx,
      IDENTITY_TOOL,
      {
        status: args.dryRun === true ? 'dry_run' : 'nothing_to_do',
        ...head,
        items: planned.map(itemView),
        message:
          args.dryRun === true
            ? `Dry run: nothing was written. Run it again without dryRun to apply these ${toRun.length} character(s)${refused > 0 ? `; the ${refused} refused item(s) are left out` : ''}.`
            : 'Nothing to write: every item was refused or already holds these facts and tags.',
        cost: `${reads.size} read(s)`,
      },
      () => ({ counts: head.counts }),
    );
  }

  // 4. The job: one item per character.
  const steps: StepSpec[] = [];
  const items: PlanItem[] = [];
  const operations: Obj[] = [];
  const prefetched: { op: string; path: Record<string, string>; body: unknown }[] = [];
  const tagsAnywhere = toRun.some((p) => p.tags?.status === 'write');
  if (tagsAnywhere && policy)
    steps.push({
      op: EXPECT_STEP,
      params: {
        body: {
          checks: [
            {
              label: 'tagging policy',
              kind: 'registered',
              checker: RETAG_CHECKS.policy,
              input: { packId: PACK, runId: IDENTITY_TOOL, version: policy.version, digest: policy.digest },
            },
          ],
        },
      },
    });
  for (const p of toRun) {
    const fp = factsPlans.get(p.item)!;
    const node = p.page!;
    const item = p.item;
    const page = { id: node.id, name: node.name };
    const checkAt = steps.length + 1;
    const checkLabel = `identity page ${node.id}`;
    steps.push({
      op: EXPECT_STEP,
      params: {
        body: {
          checks: [
            {
              label: checkLabel,
              kind: 'registered',
              checker: IDENTITY_CHECKS.page,
              resourceId: node.id,
              input: { pageId: node.id, name: node.name, item, factsVersion: p.factsVersion! },
            },
          ],
        },
      },
      items: [item],
    });
    if (!fp.plan.empty) {
      const job = expandFacts(fp.plan, page, fp.sidebar, { facts: Object.fromEntries((p.facts ?? []).map((f) => [f.key, f.after])), links: {} });
      const base = steps.length;
      for (const s of job.steps) {
        const m = mapStepRefs(s, (n) => n + base);
        const write = m.op !== EXPECT_STEP && m.op !== VERIFY_STEP;
        steps.push({
          ...m,
          items: [item],
          ...(m.journalOperation
            ? { journalOperation: { ...m.journalOperation, tool: IDENTITY_TOOL, via: 'set_facts', character: p.character } }
            : {}),
          // Judged by the item's own checks inside the job (its fresh read, the rows check, the in-lock state), so a
          // proposal captures no version of it: one character changed before approval skips that character alone.
          ...(write
            ? {
                judgedInLock: true,
                rebase: { rebaser: IDENTITY_REBASERS.facts, input: { item, name: node.name } },
              }
            : {}),
        });
      }
    }
    if (p.tags?.status === 'write') {
      steps.push({
        op: 'updateResource',
        params: { path: { resourceId: node.id }, body: { tags: [...p.tags.proposed] } },
        expectCurrent: { state: 'resource', hash: stateHash({ name: node.name, tags: p.tags.current }), label: node.name },
        judgedInLock: true,
        deferTreeReread: true,
        items: [item],
        rebase: {
          rebaser: IDENTITY_REBASERS.tags,
          input: {
            item,
            pageId: node.id,
            name: node.name,
            current: p.tags.current,
            proposed: p.tags.proposed,
            packId: PACK,
            digest: policy!.digest,
          },
          always: true,
        },
        journalOperation: {
          tool: IDENTITY_TOOL,
          page,
          character: p.character,
          write: 'tags',
          from: p.tags.current,
          to: p.tags.proposed,
        },
      });
      steps.push({
        op: VERIFY_STEP,
        params: {
          body: {
            targets: [
              {
                kind: 'registered',
                label: `${node.name}: tags read back`,
                checker: IDENTITY_CHECKS.tagsVerify,
                resourceId: node.id,
                input: { pageId: node.id, name: node.name, proposed: p.tags.proposed, beforeLabel: checkLabel },
                inputFrom: [{ step: checkAt, as: 'before' }],
              },
            ],
          },
        },
        items: [item],
      });
    }
    const changed = (p.facts ?? []).filter((f) => f.change !== 'unchanged');
    const factText = changed.map((f) => `${f.key}: ${f.before ?? '(none)'} → ${f.after}`).join('; ');
    const tagText =
      p.tags?.status === 'write'
        ? `tags ${p.tags.current.join(', ') || '(none)'} → ${p.tags.proposed.join(', ')}`
        : p.tags?.status === 'held'
          ? `tags held (${p.tags.reason ?? 'the owner decides'})`
          : '';
    items.push({
      id: item,
      kind: 'identity_facts',
      group: 'Identity facts and tags',
      label: `${p.character}: ${[factText, tagText].filter(Boolean).join('; ')}`.slice(0, 300),
      page,
      diff: {
        before: changed.map((f) => `${f.key}: ${f.before ?? '(none)'}`).join('\n'),
        after: changed.map((f) => `${f.key}: ${f.after}`).join('\n'),
        changes: [
          ...changed.map((f) => ({ what: f.key, before: f.before, after: f.after })),
          ...(p.tags?.status === 'write'
            ? [{ what: 'tags', before: p.tags.current.join(', '), after: p.tags.proposed.join(', ') }]
            : []),
        ],
      },
      dependsOn: [],
      selected: true,
    });
    operations.push({
      tool: IDENTITY_TOOL,
      page,
      pageParts: [factText, tagText].filter(Boolean),
      summaryLabel: `${p.character}: ${[factText, tagText].filter(Boolean).join('; ')}`.slice(0, 300),
    });
    prefetched.push({ op: 'getResource', path: { resourceId: node.id }, body: fp.res });
  }
  const title = `${IDENTITY_TOOL}: ${toRun.length} character${toRun.length === 1 ? '' : 's'}${toRun.length <= 3 ? ` (${toRun.map((p) => p.character).join(', ')})` : ''}`;
  const mode = packs.strictToolMode(PACK, IDENTITY_TOOL);
  let r;
  try {
    r = await pd.engine.submit({
      kind: 'batch_ops',
      project: pd.project.id,
      steps,
      onError: 'stop',
      priority: 'P1',
      origin: mcpOrigin(mctx, IDENTITY_TOOL),
      title: title.slice(0, 300),
      internal: true,
      ...(mode === 'propose' ? { forceProposal: true } : {}),
      ...(args.lastMajorRevision ? { lastMajorRevision: args.lastMajorRevision } : {}),
      resumable: { kind: 'identity', ...(tagsAnywhere && policy ? { recheck: [1] } : {}), isolateItems: true },
      proposal: {
        summary: title,
        items,
        operation: {
          tool: IDENTITY_TOOL,
          reconcileTags,
          characters: toRun.map((p) => ({ item: p.item, character: p.character, page: p.page })),
        },
        operations,
        prefetched,
      },
    });
  } catch (e) {
    return errorFromThrown(e, pd);
  }
  const principalId = mctx.principal?.principalId ?? 'unknown';
  const workstream = currentWorkstream();
  const recordPlan = { items: planned, reconcileTags, ...(policy ? { policy: { version: policy.version, digest: policy.digest } } : {}) };
  if ('proposalId' in r) {
    const rec = service.records.save({
      projectId: pd.project.id,
      principalId,
      workstream,
      jobId: null,
      proposalId: r.proposalId,
      plan: recordPlan,
    });
    return finish(
      pd,
      mctx,
      IDENTITY_TOOL,
      {
        status: 'proposal_captured',
        reconcileId: rec.id,
        proposalId: r.proposalId,
        ...head,
        ...(r.canonical
          ? {
              requiresCanonicalApproval: true,
              reason: r.canonical.reason,
              hint: 'Part of this touches protected canon, so it was NOT made: only the owner can accept it. Never retry it or work around it.',
            }
          : r.proposedBecause
            ? railBody(r)
            : {
                hint: 'Nothing was written: the owner approves the characters (some or all) on the Proposals page. Never resubmit it; follow it with bridge_proposal_status, then { report: reconcileId }.',
              }),
        items: planned.map(itemView),
      },
      () => ({ proposalId: r.proposalId, counts: head.counts }),
    );
  }
  const rec = service.records.save({
    projectId: pd.project.id,
    principalId,
    workstream,
    jobId: r.jobId,
    proposalId: null,
    plan: recordPlan,
  });
  const view =
    r.eta === null
      ? (pd.engine.queries.getJob(pd.project.id, r.jobId) ?? (await pd.engine.wait(pd.project.id, r.jobId, 0)))
      : await pd.engine.wait(pd.project.id, r.jobId, WAIT_MS);
  if (view.status === 'succeeded' || view.status === 'failed' || view.status === 'cancelled') {
    const done = (await service.conclude(pd.project.id, r.jobId)) ?? rec;
    return finish(
      pd,
      mctx,
      IDENTITY_TOOL,
      {
        status: 'finished',
        ...head,
        ...recordBody(done),
        jobStatus: view.status,
        ...(view.status !== 'succeeded'
          ? {
              hint: `Not every character finished: each item says why. Do not repeat the call: the job can be resumed (bridge_job_resume { jobId: "${r.jobId}" }) once the cause is fixed, or redo the skipped characters after reading them again.`,
            }
          : {}),
      },
      () => ({ reconcileId: done.id, summary: done.outcome?.summary ?? null }),
    );
  }
  return render(
    {
      status: view.status === 'waiting_budget' ? 'waiting_budget' : 'queued',
      reconcileId: rec.id,
      jobId: r.jobId,
      ...head,
      summary: `${toRun.length} character(s) queued; nothing is reported until the job has run`,
      hint: 'The job is accepted and has NOT failed: it runs by itself. Never submit it again: follow it with { report: reconcileId } (or bridge_job_status).',
    },
    pd,
  );
}
