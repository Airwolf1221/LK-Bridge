/**
 * The lifecycle guard (v2 C2c, ADR 0035; Part 3, decided by the owner): lifecycle changes happen ONLY through the four
 * lifecycle tools (and the creation tools' `status`). It sits in the engine beside the protected canonical facts guard
 * (src/facts/canonical.ts), so every write path is judged: set_facts, `lk_api_write`, `lk_api_batch`, every `lk_op_*`,
 * the resource tools and an approved proposal. It refuses, naming the right tool:
 *
 * - a Status change to or from Working or Archived (and so from Working to Authoritative), by any sidebar write or a
 *   page created from a template that carries one;
 * - a rename that adds, removes or changes a `[BWRK]` or `[BARC]` prefix (turning either into `[BSRC]` included), and a
 *   page created with one;
 * - a move of a page into or out of `[INDEX] Working` or `[INDEX] Archived` (or between them), and a page created under
 *   either.
 *
 * The tools' own steps are allowed only through the job's lifecycle marker (`BatchSubmit.lifecycle`), which bridge code
 * alone sets and which names exactly the pages the job changes: an agent's body can never carry one. A marker of the four
 * lifecycle tools (`canonical`) also makes the request a proposal that only the owner's "Approve and accept as canon"
 * can run, at every scope; at execution the token is checked again, and every change is judged again inside the lock.
 */
import { isCanonicalApproval } from '../policy/approval.js';
import { PolicyDeniedError, type JobEngine, LkOperationError } from '../jobs/index.js';
import { SYSTEM_PRINCIPAL, type LifecycleMarker } from '../jobs/types.js';
import type {
  WriteGuard,
  WriteGuardEntry,
  WriteGuardInLock,
  WriteGuardVerdict,
} from '../jobs/write-guard.js';
import { factKey, factValueKey } from '../facts/rules.js';
import {
  SIDEBAR_WRITE_OPS,
  applySidebarWrite,
  factRows,
  sidebarFrom,
  valueText,
  type SidebarProperty,
} from '../facts/sidebar.js';
import { classifyName, type TreeNode } from '../tree/index.js';
import { areaOf, lifecycleFrom, type LifecycleConfig } from './settings.js';

type Obj = Record<string, unknown>;
type Area = 'working' | 'archived' | null;
type State = 'authoritative' | 'working' | 'archived';

/** One lifecycle change a request would make. */
export interface LifecycleChange {
  readonly resourceId: string;
  readonly page: string;
  /** What changes: the Status, the prefix, or the place. */
  readonly what: 'status' | 'prefix' | 'place' | 'create';
  /** The state it moves to, as far as the change tells. */
  readonly to: State | null;
  readonly text: string;
  /** The tool to use instead. */
  readonly tool: string;
  readonly stepIndex?: number;
}

const TOOL_TO: Readonly<Record<State, string>> = {
  archived: 'archive_page',
  working: 'move_to_working',
  authoritative: 'promote_page',
};
const TOOL_FROM: Readonly<Record<'working' | 'archived', string>> = {
  archived: 'unarchive_page',
  working: 'promote_page (to make it Authoritative) or archive_page (to retire it)',
};

/** The lifecycle states the Status values name (`other` for anything else). */
function statusClass(c: LifecycleConfig, value: string): State | 'other' {
  const v = factValueKey(value);
  if (v === factValueKey(c.status.working)) return 'working';
  if (v === factValueKey(c.status.archived)) return 'archived';
  if (v === factValueKey(c.status.authoritative)) return 'authoritative';
  return 'other';
}

/**
 * The lifecycle change between a page's Status values before and after a write (pure): the number of Working or
 * Archived values changes. Null when there is none. `isNew`: the page is being created (the tool is then a create's).
 */
export function statusChange(
  c: LifecycleConfig,
  before: readonly string[],
  after: readonly string[],
  isNew = false,
): {
  readonly to: State | null;
  readonly from: 'working' | 'archived' | null;
  readonly tool: string;
  readonly text: string;
} | null {
  const count = (l: readonly string[], s: State) => l.filter((v) => statusClass(c, v) === s).length;
  for (const s of ['archived', 'working'] as const) {
    const b = count(before, s);
    const a = count(after, s);
    if (a === b) continue;
    const shown = (l: readonly string[]) =>
      l.length === 0 ? '(nothing)' : l.map((v) => `“${v}”`).join(', ');
    if (a > b) {
      return {
        to: s,
        from: null,
        tool: isNew
          ? s === 'working'
            ? 'create_resource with status "working"'
            : 'archive_page'
          : TOOL_TO[s],
        text: `Status would be set to ${c.status[s]} (it is ${shown(before)})`,
      };
    }
    const to = after.some((v) => statusClass(c, v) === 'authoritative') ? 'authoritative' : null;
    return {
      to,
      from: s,
      tool: s === 'working' && to === 'authoritative' ? 'promote_page' : TOOL_FROM[s],
      text: `Status would change from ${c.status[s]} to ${shown(after)}`,
    };
  }
  return null;
}

/** The lifecycle change of a prefix change (pure), or null: a `[BWRK]` or `[BARC]` prefix added, removed or changed. */
export function prefixChange(
  fromKind: string | null,
  toKind: string,
): { readonly to: State | null; readonly tool: string } | null {
  if (fromKind === toKind) return null;
  const lc = (k: string | null) => k === 'bwrk' || k === 'barc';
  if (!lc(fromKind) && !lc(toKind)) return null;
  if (toKind === 'barc') return { to: 'archived', tool: 'archive_page' };
  if (fromKind === 'barc') return { to: toKind === 'bsrc' ? 'authoritative' : null, tool: 'unarchive_page' };
  if (toKind === 'bwrk') return { to: 'working', tool: 'move_to_working' };
  return {
    to: toKind === 'bsrc' ? 'authoritative' : null,
    tool: toKind === 'bsrc' ? 'promote_page' : TOOL_FROM.working,
  };
}

/** The lifecycle change of a move (pure), or null: into or out of the Working or Archive area, or between them. */
export function placeChange(
  from: Area,
  to: Area,
): { readonly to: State | null; readonly tool: string } | null {
  if (from === to) return null;
  if (to === 'archived') return { to: 'archived', tool: 'archive_page' };
  if (from === 'archived') return { to: null, tool: 'unarchive_page' };
  if (to === 'working') return { to: 'working', tool: 'move_to_working' };
  return { to: null, tool: TOOL_FROM.working };
}

export interface LifecycleGuardDeps {
  /** A project's settings (its `lifecycle`). */
  readonly settings: (projectId: string) => Readonly<Record<string, unknown>> | undefined;
  /** Governed reads for the guard's own checks (the engine's `internalRead`). */
  readonly engine: Pick<JobEngine, 'internalRead'>;
  /** A node of the repository tree, or null. */
  readonly node: (projectId: string, id: string) => TreeNode | null;
}

const statusValues = (c: LifecycleConfig, sb: readonly SidebarProperty[]) =>
  factRows(sb)
    .filter((r) => factKey(r.key) === factKey(c.fields.status))
    .map((r) => valueText(r.content))
    .filter((t) => t !== '');

/** The lifecycle guard (see the module comment). */
export class LifecycleGuard implements WriteGuard {
  constructor(private readonly d: LifecycleGuardDeps) {}

  private config(projectId: string): LifecycleConfig {
    return lifecycleFrom(this.d.settings(projectId));
  }

  /** Where a page (or the parent a page goes under) is, in lifecycle terms; the index itself counts as inside. */
  private areaOfParent(c: LifecycleConfig, project: string, parentId: string | null): Area {
    if (parentId === null) return null;
    if (parentId === c.workingIndexId) return 'working';
    if (parentId === c.archiveIndexId) return 'archived';
    const n = this.d.node(project, parentId);
    if (!n) return null;
    return areaOf({ id: '', path: n.path }, c);
  }

  private areaOfPage(c: LifecycleConfig, project: string, id: string): Area {
    const n = this.d.node(project, id);
    return n ? areaOf(n, c) : null;
  }

  async entry(input: WriteGuardEntry): Promise<WriteGuardVerdict> {
    const marker = input.lifecycle;
    const c = this.config(input.project);
    const changes = await this.changes(input, c);
    // Changes the job does not declare: refused, naming the right tool. A marker is bridge code's, so an undeclared
    // change in a marked job is a bridge fault: refused too.
    const undeclared = changes.filter((ch) => !declares(marker, ch));
    if (undeclared.length > 0) {
      const first = undeclared[0]!;
      return {
        decision: 'deny',
        opId: input.items[first.stepIndex ?? 0]?.op ?? 'operation',
        ...(input.jobKind === 'batch_ops' && first.stepIndex !== undefined
          ? { stepIndex: first.stepIndex }
          : {}),
        reason: refusal(undeclared),
      };
    }
    if (!marker?.canonical) return { decision: 'allow' };
    // The four lifecycle tools: always the owner's canonical approval, at every scope (owner, 10 November 2026).
    if (isCanonicalApproval(input.origin.approval)) return { decision: 'allow' };
    const reason = `${marker.tool} ${marker.reason ?? 'changes a page’s lifecycle state'}, which always needs the owner’s canonical approval (“Approve and accept as canon”), whatever the scope`;
    if (input.origin.approval !== undefined) {
      return {
        decision: 'deny',
        opId: input.items[0]?.op ?? 'operation',
        reason: `refused at execution: ${reason}, and this proposal was not approved as canon; nothing was written`,
      };
    }
    if (input.principal.principalId === SYSTEM_PRINCIPAL.principalId) {
      return {
        decision: 'deny',
        opId: input.items[0]?.op ?? 'operation',
        reason: `${reason}; the bridge never makes it on its own`,
      };
    }
    return {
      decision: 'propose_canonical',
      reason,
      changes: [
        { lifecycle: marker.tool, pages: marker.pages },
        ...changes.map((ch) => ({
          lifecycle: ch.what,
          page: ch.page,
          resourceId: ch.resourceId,
          text: ch.text,
        })),
      ],
    };
  }

  /** Every lifecycle change the request makes, judged in order (sidebar writes simulated on the sidebars as they are). */
  private async changes(input: WriteGuardEntry, c: LifecycleConfig): Promise<LifecycleChange[]> {
    const out: LifecycleChange[] = [];
    const sidebars = new Map<string, SidebarProperty[] | null>();
    const created = new Set<string>();
    // The area of a page created earlier in the same request (for a batch whose items nest).
    const createdArea = new Map<string, Area>();
    const read = async (resourceId: string): Promise<SidebarProperty[] | null> => {
      if (sidebars.has(resourceId)) return sidebars.get(resourceId)!;
      const pre = input.prefetched?.find(
        (p) => (p.op === 'listProperties' || p.op === 'getResource') && p.path.resourceId === resourceId,
      );
      let sb: SidebarProperty[] | null;
      if (pre) sb = sidebarFrom(pre.body);
      else {
        try {
          sb = sidebarFrom(
            await this.d.engine.internalRead(
              input.project,
              'listProperties',
              { path: { resourceId } },
              { priority: input.origin.approval !== undefined ? 'P0' : 'P1', notFoundIsAnswer: true },
            ),
          );
        } catch (e) {
          sb = e instanceof LkOperationError && e.lk.status === 404 ? [] : null;
        }
      }
      sidebars.set(resourceId, sb);
      return sb;
    };
    const name = (id: string) => this.d.node(input.project, id)?.rawName ?? id;
    for (const [i, it] of input.items.entries()) {
      const body = (it.params.body ?? {}) as Obj;
      if (
        it.op === 'createResource' ||
        it.op === 'createManyResources' ||
        it.op === 'createResourceFromTemplate'
      ) {
        const items =
          it.op === 'createManyResources'
            ? ((Array.isArray(body.resources) ? body.resources : []) as Obj[])
            : [body];
        for (const x of items) {
          const id = typeof x.id === 'string' ? x.id : '(new)';
          const raw = typeof x.name === 'string' ? x.name : '';
          const kind = classifyName(raw).kind;
          const pid = typeof x.parentId === 'string' ? x.parentId : null;
          // A parent created earlier in the same request has the area it was created in.
          const area: Area =
            pid !== null && createdArea.has(pid)
              ? (createdArea.get(pid) ?? null)
              : this.areaOfParent(c, input.project, pid);
          if (typeof x.id === 'string') {
            created.add(x.id);
            createdArea.set(x.id, area);
          }
          if (kind === 'bwrk' || kind === 'barc') {
            out.push({
              resourceId: id,
              page: raw,
              what: 'create',
              to: kind === 'bwrk' ? 'working' : 'archived',
              text: `a page would be created named ${raw}`,
              tool: kind === 'bwrk' ? 'create_resource with status "working"' : 'archive_page',
              stepIndex: i,
            });
          } else if (area !== null) {
            out.push({
              resourceId: id,
              page: raw || id,
              what: 'create',
              to: area,
              text: `a page would be created under [INDEX] ${area === 'working' ? c.indexNames.working : c.indexNames.archived}`,
              tool: area === 'working' ? 'create_resource with status "working"' : 'archive_page',
              stepIndex: i,
            });
          }
        }
        if (it.op === 'createResourceFromTemplate') {
          const templateId = typeof body.templateId === 'string' ? body.templateId : null;
          const id = typeof body.id === 'string' ? body.id : null;
          if (templateId) {
            const t = await read(templateId);
            const ch = t ? statusChange(c, [], statusValues(c, t), true) : null;
            if (ch && id)
              out.push({
                resourceId: id,
                page: `${typeof body.name === 'string' ? body.name : id} (new)`,
                what: 'status',
                to: ch.to,
                text: ch.text,
                tool: ch.tool,
                stepIndex: i,
              });
            // The new page starts as a copy of its template: later writes to it are judged on that copy.
            if (id && t) sidebars.set(id, t);
          }
        }
        continue;
      }
      if (SIDEBAR_WRITE_OPS.has(it.op)) {
        const rid = it.params.path?.resourceId;
        if (!rid) continue;
        const before = await read(rid);
        if (!before) {
          // Unreadable: judged inside the lock, where a read is made again before the write is sent.
          continue;
        }
        const after = applySidebarWrite(before, it.op, it.params);
        if (!after) continue;
        sidebars.set(rid, after);
        const ch = statusChange(c, statusValues(c, before), statusValues(c, after), created.has(rid));
        if (ch)
          out.push({
            resourceId: rid,
            page: name(rid),
            what: 'status',
            to: ch.to,
            text: ch.text,
            tool: ch.tool,
            stepIndex: i,
          });
        continue;
      }
      if (it.op === 'updateResource' && typeof body.name === 'string') {
        const rid = it.params.path?.resourceId;
        if (!rid) continue;
        const fromKind = await this.kindNow(input.project, rid);
        const toKind = classifyName(body.name).kind;
        const ch = prefixChange(fromKind, toKind);
        if (ch)
          out.push({
            resourceId: rid,
            page: name(rid),
            what: 'prefix',
            to: ch.to,
            text: `the page would be renamed to ${body.name}`,
            tool: ch.tool,
            stepIndex: i,
          });
        continue;
      }
      if (it.op === 'moveResource') {
        const rid = it.params.path?.resourceId;
        if (!rid || body.parentId === undefined) continue;
        const from = this.areaOfPage(c, input.project, rid);
        const to = this.areaOfParent(
          c,
          input.project,
          typeof body.parentId === 'string' ? body.parentId : null,
        );
        const ch = placeChange(from, to);
        if (ch)
          out.push({
            resourceId: rid,
            page: name(rid),
            what: 'place',
            to: ch.to,
            text:
              to !== null
                ? `the page would be moved into [INDEX] ${to === 'working' ? c.indexNames.working : c.indexNames.archived}`
                : `the page would be moved out of [INDEX] ${from === 'working' ? c.indexNames.working : c.indexNames.archived}`,
            tool: ch.tool,
            stepIndex: i,
          });
      }
    }
    return out;
  }

  /** A page's kind now: the tree's, else its name read live (null when it cannot be told). */
  private async kindNow(project: string, id: string): Promise<string | null> {
    const n = this.d.node(project, id);
    if (n) return n.kind;
    try {
      const r = (await this.d.engine.internalRead(
        project,
        'getResource',
        { path: { resourceId: id } },
        { priority: 'P1', notFoundIsAnswer: true },
      )) as { name?: unknown } | undefined;
      return typeof r?.name === 'string' ? classifyName(r.name).kind : null;
    } catch {
      return null;
    }
  }

  /**
   * Inside the lock: a Status write, rename or move judged again on what is there now (the engine's own read of the
   * target, else one read), against the job's marker.
   */
  async inLock(input: WriteGuardInLock): Promise<void> {
    const marker = (input.jobOptions?.lifecycle as LifecycleMarker | undefined) ?? undefined;
    const c = this.config(input.job.projectId);
    const rid = input.params.path?.resourceId;
    if (!rid) return;
    const project = input.job.projectId;
    const body = (input.params.body ?? {}) as Obj;
    const refuse = (ch: LifecycleChange) => {
      if (declares(marker, ch)) return;
      throw new PolicyDeniedError(
        input.opId,
        `${refusal([ch])} (checked again inside the lock; nothing was sent)`,
        input.job.principalId,
      );
    };
    const current = (input.current?.entity ?? input.current?.body) as Obj | undefined;
    if (input.opId === 'updateResource' && typeof body.name === 'string') {
      const fromName = typeof current?.name === 'string' ? current.name : null;
      const fromKind = fromName !== null ? classifyName(fromName).kind : await this.kindNow(project, rid);
      const ch = prefixChange(fromKind, classifyName(body.name).kind);
      if (ch)
        refuse({
          resourceId: rid,
          page: fromName ?? rid,
          what: 'prefix',
          to: ch.to,
          text: `the page would be renamed to ${body.name}`,
          tool: ch.tool,
        });
      return;
    }
    if (input.opId === 'moveResource' && body.parentId !== undefined) {
      const from = this.areaOfPage(c, project, rid);
      const to = this.areaOfParent(c, project, typeof body.parentId === 'string' ? body.parentId : null);
      const ch = placeChange(from, to);
      if (ch)
        refuse({
          resourceId: rid,
          page: rid,
          what: 'place',
          to: ch.to,
          text: 'the page would be moved across a lifecycle index',
          tool: ch.tool,
        });
      return;
    }
    if (!SIDEBAR_WRITE_OPS.has(input.opId)) return;
    // A versioned row write sent with an If-Match the bridge did not read here: LegendKeeper's If-Match refuses it if
    // the rows changed since the version the entry check (or the job's own check step) confirmed (as the canon guard).
    if (!input.current && input.params.ifMatch !== undefined && input.opId.endsWith('PropertyRow')) return;
    // Only a write that can touch the Status row needs the whole sidebar (one more read).
    if (!touchesKey(input, factKey(c.fields.status))) return;
    const whole = sidebarFrom(await input.read('listProperties', { path: { resourceId: rid } }));
    const after = applySidebarWrite(whole, input.opId, input.params);
    if (!after) return;
    const ch = statusChange(c, statusValues(c, whole), statusValues(c, after));
    if (ch) refuse({ resourceId: rid, page: rid, what: 'status', to: ch.to, text: ch.text, tool: ch.tool });
  }
}

/**
 * Whether a sidebar write can touch a row keyed `k`, from its body and the engine's own read in the lock (no read
 * here). When it cannot be told, true (the whole sidebar is then read and judged).
 */
function touchesKey(input: WriteGuardInLock, k: string): boolean {
  const body = (input.params.body ?? {}) as { key?: unknown; rows?: unknown };
  const keyed = (rows: unknown) =>
    Array.isArray(rows) &&
    (rows as { key?: unknown }[]).some((r) => typeof r?.key === 'string' && factKey(r.key) === k);
  if (typeof body.key === 'string' && factKey(body.key) === k) return true;
  if (keyed(body.rows)) return true;
  const current = input.current;
  const rowsNow = Array.isArray((current?.body as { data?: unknown } | undefined)?.data)
    ? ((current!.body as { data: unknown[] }).data as { id?: unknown; key?: unknown }[])
    : Array.isArray((current?.entity as { rows?: unknown } | undefined)?.rows)
      ? ((current!.entity as { rows: unknown[] }).rows as { id?: unknown; key?: unknown }[])
      : null;
  switch (input.opId) {
    case 'createPropertyRow':
    case 'createProperty':
      return false; // judged from the body above
    case 'updatePropertyRow':
    case 'deletePropertyRow': {
      if (!rowsNow) return true;
      const row = rowsNow.find((r) => r.id === input.params.path?.rowId);
      return !row || (typeof row.key === 'string' && factKey(row.key) === k);
    }
    case 'updateProperty':
      // A link collection's items, or a key-value property's rows (judged from the body above and the rows now).
      return body.rows !== undefined && (rowsNow === null || keyed(rowsNow));
    case 'deleteProperty':
      return rowsNow === null || keyed(rowsNow);
    default:
      return true;
  }
}

/** Whether the job's marker declares this change (the page, and the state it moves to when the change tells one). */
function declares(marker: LifecycleMarker | undefined, ch: LifecycleChange): boolean {
  if (!marker) return false;
  const p = marker.pages.find((x) => x.id === ch.resourceId);
  if (!p) return false;
  if (ch.to === null || p.to === null) return true;
  return p.to === ch.to;
}

function refusal(changes: readonly LifecycleChange[]): string {
  const parts = changes.slice(0, 3).map((ch) => `${ch.page}: ${ch.text} — use ${ch.tool}`);
  return (
    `refused: this changes a page’s lifecycle state (${parts.join('; ')}${changes.length > 3 ? `; and ${changes.length - 3} more` : ''}). ` +
    'Lifecycle changes (Working, Archived, and Working to Authoritative) happen only through the lifecycle tools ' +
    '(archive_page, unarchive_page, move_to_working, promote_page) and the creation tools’ status; nothing was written'
  );
}
