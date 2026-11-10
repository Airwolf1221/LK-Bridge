/**
 * The protected canonical facts guard (v2 C2a, ADR 0032; PLAN-v2 10.3 as refined by the owner). Canon never changes
 * without the owner's explicit canonical approval, by any route.
 *
 * `assessFactChange(rules, before, after)` is THE shared function (pure, no reads): given a page's facts before and
 * after a change, it lists every protected change the rules forbid without canonical approval. set_facts uses it for
 * its dry run; C2b's creation tools call it for a new page (`before` empty) before they write; and the engine's write
 * guard below uses it on EVERY write path.
 *
 * `CanonicalGuard` is the engine's write guard (src/jobs/write-guard.ts):
 * - at entry (every `run` / `submit`: set_facts, `lk_api_write`, `lk_api_batch`, every `lk_op_*`, an approved
 *   proposal's batch, and C2b's tools, whatever they submit), it simulates the request's sidebar writes in order on the
 *   page's sidebar as it is now and compares the facts after each write with those before it. A protected change
 *   becomes a proposal flagged `requiresCanonicalApproval`, whatever the caller's scope; an approved batch that carries
 *   one without the owner's canonical approval is refused, so nothing is written; the system principal is refused.
 * - inside the lock, before each sidebar write is sent, it checks again on what is there now. A versioned row write
 *   sent with an `If-Match` the bridge did not read in the lock is left to LegendKeeper's version check, which refuses
 *   it if the row changed since the entry check read it.
 */
import { isCanonicalApproval } from '../policy/approval.js';
import { CanonicalApprovalRequiredError, LkOperationError, type JobEngine } from '../jobs/index.js';
import type {
  WriteGuard,
  WriteGuardEntry,
  WriteGuardInLock,
  WriteGuardVerdict,
} from '../jobs/write-guard.js';
import { SYSTEM_PRINCIPAL } from '../jobs/types.js';
import { canonConfigFrom, factKey, factValueKey, type CanonicalRule } from './rules.js';
import {
  SIDEBAR_WRITE_OPS,
  applySidebarWrite,
  factRows,
  rowsFrom,
  sidebarFrom,
  valueSignature,
  valueText,
  type Sidebar,
  type SidebarProperty,
  type SidebarRow,
} from './sidebar.js';

/** One protected change: which rule, which fact, and its values before and after. */
export interface ProtectedChange {
  readonly ruleId: string;
  readonly key: string;
  /**
   * `to`: set TO a protected value; `from`: changed FROM one; `change`: an existing non-empty value changed; `delete`
   * (v2 C2b): a page holding a protected value is deleted.
   */
  readonly direction: 'to' | 'from' | 'change' | 'delete';
  /** The protected value (`to` / `from`). */
  readonly value?: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
  /** The page, when known. */
  readonly resourceId?: string;
  readonly page?: string;
  /** The operation of the request that makes it (0-based), when known. */
  readonly stepIndex?: number;
  /** One plain sentence. */
  readonly text: string;
}

/** A fact as the rules see it: its key and value. */
export interface FactValue {
  readonly key: string;
  readonly content: readonly Record<string, unknown>[];
}

const shown = (l: readonly string[]) => (l.length === 0 ? '(nothing)' : l.map((v) => `“${v}”`).join(', '));

/**
 * The protected changes between a page's facts `before` and `after` (pure; the shared function with a clear contract).
 * Facts are every key-value row of the sidebar; a key may occur more than once and every occurrence counts.
 * - `value` rule: protected if the number of rows holding one of its values (without case) changes.
 * - `change` rule: protected if the fact had a non-empty value before and its non-empty values after differ (as a
 *   multiset of value signatures: text and mentioned pages; marks do not count). Setting a fact that was empty or
 *   absent is allowed.
 */
export function assessFactChange(
  rules: readonly CanonicalRule[],
  before: readonly FactValue[],
  after: readonly FactValue[],
): ProtectedChange[] {
  const out: ProtectedChange[] = [];
  for (const rule of rules) {
    if (rule.kind === 'delete') continue; // judged when a page is deleted (assessDelete), not on a fact change
    const k = factKey(rule.key);
    const b = before.filter((f) => factKey(f.key) === k);
    const a = after.filter((f) => factKey(f.key) === k);
    const bt = b.map((f) => valueText(f.content)).filter((t) => t !== '');
    const at = a.map((f) => valueText(f.content)).filter((t) => t !== '');
    if (rule.kind === 'value') {
      for (const v of rule.values) {
        const vk = factValueKey(v);
        const nb = bt.filter((t) => factValueKey(t) === vk).length;
        const na = at.filter((t) => factValueKey(t) === vk).length;
        if (na > nb) {
          out.push({
            ruleId: rule.id,
            key: rule.key,
            direction: 'to',
            value: v,
            before: bt,
            after: at,
            text: `${rule.key} would be set to ${v} (it is ${shown(bt)})`,
          });
        } else if (na < nb) {
          out.push({
            ruleId: rule.id,
            key: rule.key,
            direction: 'from',
            value: v,
            before: bt,
            after: at,
            text: `${rule.key} would change from ${v} to ${shown(at)}`,
          });
        }
      }
      continue;
    }
    const sb = b.filter((f) => valueText(f.content) !== '').map((f) => valueSignature(f.content));
    if (sb.length === 0) continue; // empty or absent before: setting it is allowed
    const sa = a.filter((f) => valueText(f.content) !== '').map((f) => valueSignature(f.content));
    if ([...sb].sort().join('\u0000') !== [...sa].sort().join('\u0000')) {
      out.push({
        ruleId: rule.id,
        key: rule.key,
        direction: 'change',
        before: bt,
        after: at,
        text: `${rule.key} would change from ${shown(bt)} to ${shown(at)}`,
      });
    }
  }
  return out;
}

/**
 * v2 C2b: what deleting a page holding these facts would remove that the `delete` rules protect (pure). `page` names
 * it in the sentence.
 */
export function assessDelete(
  rules: readonly CanonicalRule[],
  facts: readonly FactValue[],
  page: string,
): ProtectedChange[] {
  const out: ProtectedChange[] = [];
  for (const rule of rules) {
    if (rule.kind !== 'delete') continue;
    const k = factKey(rule.key);
    const held = facts
      .filter((f) => factKey(f.key) === k)
      .map((f) => valueText(f.content))
      .filter((t) => t !== '');
    for (const v of rule.values) {
      if (!held.some((t) => factValueKey(t) === factValueKey(v))) continue;
      out.push({
        ruleId: rule.id,
        key: rule.key,
        direction: 'delete',
        value: v,
        before: held,
        after: [],
        page,
        text: `deleting “${page}”, whose ${rule.key} is ${v}`,
      });
    }
  }
  return out;
}

/** The reason line for a list of protected changes. */
export function canonicalReason(changes: readonly ProtectedChange[]): string {
  const parts = changes.slice(0, 5).map((c) => `${c.page ? `${c.page}: ` : ''}${c.text}`);
  return (
    `this makes a protected canonical change (${parts.join('; ')}${changes.length > 5 ? `; and ${changes.length - 5} more` : ''}), ` +
    'which needs the owner’s canonical approval'
  );
}

const rowsOf = (sidebar: Sidebar): FactValue[] =>
  factRows(sidebar).map((r) => ({ key: r.key, content: r.content }));

export interface CanonicalGuardDeps {
  /** A project's settings (its `canonicalRules`). */
  readonly settings: (projectId: string) => Readonly<Record<string, unknown>> | undefined;
  /** Governed reads for the guard's own checks (the engine's `internalRead`). */
  readonly engine: Pick<JobEngine, 'internalRead'>;
  /** A page's name (for the reasons), from the repository tree. */
  readonly pageName?: (projectId: string, resourceId: string) => string | null;
  /**
   * v2 C2b: the pages under a page, from the repository tree (not the page itself), for a cascade delete. Undefined or
   * null: they cannot be listed, and a cascade counts as unchecked (so it needs canonical approval).
   */
  readonly descendants?: (projectId: string, resourceId: string) => readonly string[] | null;
}

/** v2 C2b: at most this many pages of a cascade are read at entry; any beyond count as unchecked (protected). */
export const CASCADE_READ_LIMIT = 100;

/** Keys the rules protect, for the in-lock shortcut ("can this write touch a protected fact at all?"). */
function protectsAny(rules: readonly CanonicalRule[], rows: readonly SidebarRow[]): boolean {
  const keys = new Set(rules.map((r) => factKey(r.key)));
  return rows.some((r) => keys.has(factKey(r.key)));
}

/** The engine's write guard for the protected canonical facts. */
export class CanonicalGuard implements WriteGuard {
  constructor(private readonly d: CanonicalGuardDeps) {}

  private rules(projectId: string): readonly CanonicalRule[] {
    return canonConfigFrom(this.d.settings(projectId)).rules;
  }

  async entry(input: WriteGuardEntry): Promise<WriteGuardVerdict> {
    const rules = this.rules(input.project);
    if (rules.length === 0) return { decision: 'allow' };
    const guarded = input.items
      .map((it, i) => ({ ...it, i }))
      .filter(
        (it) =>
          SIDEBAR_WRITE_OPS.has(it.op) ||
          it.op === 'createResourceFromTemplate' ||
          (it.op === 'deleteResource' && rules.some((r) => r.kind === 'delete')),
      );
    if (guarded.length === 0) return { decision: 'allow' };
    const priority = input.origin.approval !== undefined ? 'P0' : 'P1';
    const changes: ProtectedChange[] = [];
    const unchecked: { i: number; why: string }[] = [];
    const sidebars = new Map<string, SidebarProperty[] | null>();
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
              { priority, notFoundIsAnswer: true },
            ),
          );
        } catch (e) {
          // Not there: LegendKeeper refuses the write itself (404), so there is nothing to protect.
          if (e instanceof LkOperationError && e.lk.status === 404) {
            sidebars.set(resourceId, []);
            return [];
          }
          sb = null;
          unchecked.push({
            i: -1,
            why: `the sidebar of ${resourceId} could not be read (${e instanceof Error ? e.message : String(e)})`,
          });
        }
      }
      sidebars.set(resourceId, sb);
      return sb;
    };
    for (const it of guarded) {
      if (it.op === 'createResourceFromTemplate') {
        const body = (it.params.body ?? {}) as { templateId?: unknown; id?: unknown; name?: unknown };
        const templateId = typeof body.templateId === 'string' ? body.templateId : null;
        if (!templateId) continue;
        const template = await read(templateId);
        if (!template) {
          unchecked.push({ i: it.i, why: `the template ${templateId} could not be read` });
          continue;
        }
        for (const c of assessFactChange(rules, [], rowsOf(template))) {
          changes.push({
            ...c,
            stepIndex: it.i,
            ...(typeof body.id === 'string' ? { resourceId: body.id } : {}),
            page:
              typeof body.name === 'string'
                ? `${body.name} (new, from a template)`
                : 'a new page from a template',
          });
        }
        // v2 C2b: the new page starts as a copy of its template, so the facts the same request writes to it (with the
        // template's ids, bound to the copy's in the job) are judged on that copy.
        if (typeof body.id === 'string') sidebars.set(body.id, template);
        continue;
      }
      if (it.op === 'deleteResource') {
        const rid = it.params.path?.resourceId;
        if (!rid) continue;
        const cascade = it.params.query?.cascade === true || it.params.query?.cascade === 'true';
        const pages = [rid];
        if (cascade) {
          // The tree's list of the subtree, else (no tree, or a page outside it) a live listing of it.
          const below =
            this.d.descendants?.(input.project, rid) ??
            (await this.listDescendants(input.project, rid, priority));
          if (below === null) {
            unchecked.push({ i: it.i, why: `the pages under ${rid} could not be listed` });
          } else {
            pages.push(...below.slice(0, CASCADE_READ_LIMIT));
            if (below.length > CASCADE_READ_LIMIT) {
              unchecked.push({
                i: it.i,
                why: `the cascade holds ${below.length + 1} pages, more than the ${CASCADE_READ_LIMIT + 1} the guard reads`,
              });
            }
          }
        }
        for (const id of pages) {
          const sb = await read(id);
          if (!sb) {
            unchecked.push({ i: it.i, why: `the sidebar of ${id} could not be read` });
            continue;
          }
          const name = this.d.pageName?.(input.project, id) ?? id;
          for (const c of assessDelete(rules, rowsOf(sb), name))
            changes.push({ ...c, stepIndex: it.i, resourceId: id });
        }
        continue;
      }
      const rid = it.params.path?.resourceId;
      if (!rid) continue;
      const before = await read(rid);
      if (!before) {
        unchecked.push({ i: it.i, why: `the sidebar of ${rid} could not be read` });
        continue;
      }
      const after = applySidebarWrite(before, it.op, it.params);
      if (!after) continue; // its target is not there: LegendKeeper refuses it, nothing changes
      sidebars.set(rid, after);
      const name = this.d.pageName?.(input.project, rid) ?? rid;
      for (const c of assessFactChange(rules, rowsOf(before), rowsOf(after)))
        changes.push({ ...c, stepIndex: it.i, resourceId: rid, page: name });
    }
    if (changes.length === 0 && unchecked.length === 0) return { decision: 'allow' };
    const reason =
      changes.length > 0
        ? canonicalReason(changes)
        : `the protected canonical facts could not be checked (${unchecked[0]!.why}), so this needs the owner’s canonical approval`;
    // The owner's canonical approval of this very proposal: the protected changes are what was accepted as canon.
    if (isCanonicalApproval(input.origin.approval)) return { decision: 'allow' };
    const first = changes[0]?.stepIndex ?? unchecked[0]?.i ?? 0;
    const opId = input.items[Math.max(0, first)]?.op ?? 'operation';
    if (input.origin.approval !== undefined) {
      return {
        decision: 'deny',
        opId,
        ...(input.jobKind === 'batch_ops' ? { stepIndex: Math.max(0, first) } : {}),
        reason: `refused at execution: ${reason}, and this proposal was not approved as canon; nothing was written`,
      };
    }
    if (input.principal.principalId === SYSTEM_PRINCIPAL.principalId) {
      return { decision: 'deny', opId, reason: `${reason}; the bridge never makes it on its own` };
    }
    const all: unknown[] = [...changes, ...unchecked.map((u) => ({ unchecked: u.why, stepIndex: u.i }))];
    return { decision: 'propose_canonical', reason, changes: all };
  }

  /**
   * v2 C2b: the pages under `resourceId`, listed live level by level (`listResources` by parent, 100 a page), up to one
   * more than the guard reads; null when a listing fails (the cascade then counts as unchecked).
   */
  private async listDescendants(
    project: string,
    resourceId: string,
    priority: 'P0' | 'P1',
  ): Promise<string[] | null> {
    const out: string[] = [];
    let level = [resourceId];
    try {
      while (level.length > 0 && out.length <= CASCADE_READ_LIMIT) {
        const next: string[] = [];
        for (const parentId of level) {
          let cursor: string | undefined;
          for (let page = 0; page < 50; page++) {
            const body = (await this.d.engine.internalRead(
              project,
              'listResources',
              { query: { parentId, limit: 100, ...(cursor ? { cursor } : {}) } },
              { priority },
            )) as { data?: unknown; hasMore?: unknown; nextCursor?: unknown };
            for (const r of Array.isArray(body?.data) ? (body.data as { id?: unknown }[]) : []) {
              if (typeof r.id === 'string' && r.id !== resourceId) {
                out.push(r.id);
                next.push(r.id);
              }
            }
            if (body?.hasMore !== true || typeof body.nextCursor !== 'string') break;
            cursor = body.nextCursor;
          }
          if (out.length > CASCADE_READ_LIMIT) break;
        }
        level = next;
      }
      return out;
    } catch {
      return null;
    }
  }

  async inLock(input: WriteGuardInLock): Promise<void> {
    if (input.opId === 'deleteResource') return this.deleteInLock(input);
    if (!SIDEBAR_WRITE_OPS.has(input.opId)) return; // a template copy is checked at entry (the template is not locked)
    if (input.job.origin.canonicalApprovedBy !== undefined) return; // approved as canon (checked at entry)
    const rules = this.rules(input.job.projectId);
    if (rules.length === 0) return;
    const rid = input.params.path?.resourceId;
    const pid = input.params.path?.propertyId;
    if (!rid) return;
    const ref = { jobId: input.job.id, stepNo: input.step.stepNo };
    // The one property the write touches, as it is now: the read made in the lock, or one more read.
    let prop: SidebarProperty | undefined;
    if (input.opId === 'createProperty') {
      prop = undefined;
    } else if (input.current) {
      const c = input.current;
      const body = c.body as { data?: unknown } | undefined;
      if (Array.isArray(body?.data)) {
        prop = { id: pid ?? '', kind: 'keyValue', title: '', rows: rowsFrom(body.data), raw: {} };
      } else if (c.entity && typeof c.entity === 'object') {
        prop = sidebarFrom([c.entity])[0];
      }
    } else if (input.params.ifMatch !== undefined && input.opId.endsWith('PropertyRow')) {
      // A versioned row write with a version the bridge did not read here: LegendKeeper's If-Match refuses it if the
      // rows changed since the version the entry check (or the job's own bridge.expect step) confirmed.
      return;
    } else if (pid) {
      const got = await input.read('getProperty', { path: { resourceId: rid, propertyId: pid } });
      prop = got ? sidebarFrom([got])[0] : undefined;
    }
    const one: Sidebar = prop ? [prop] : [];
    const afterOne = applySidebarWrite(one, input.opId, input.params);
    if (!afterOne) return;
    if (!protectsAny(rules, [...factRows(one), ...factRows(afterOne)])) return;
    // The write touches a protected fact: judge it on the whole sidebar as it is now.
    const whole = sidebarFrom(await input.read('listProperties', { path: { resourceId: rid } }));
    const after = applySidebarWrite(whole, input.opId, input.params);
    if (!after) return;
    const changes = assessFactChange(rules, rowsOf(whole), rowsOf(after));
    if (changes.length > 0) {
      throw new CanonicalApprovalRequiredError(input.opId, canonicalReason(changes), changes, ref);
    }
  }

  /**
   * v2 C2b: the page a delete removes, read again inside its lock (one read): a page that became protected since the
   * entry check (an edit in the app) is not deleted without canonical approval. The pages under it were judged at entry.
   */
  private async deleteInLock(input: WriteGuardInLock): Promise<void> {
    if (input.job.origin.canonicalApprovedBy !== undefined) return;
    const rules = this.rules(input.job.projectId).filter((r) => r.kind === 'delete');
    const rid = input.params.path?.resourceId;
    if (rules.length === 0 || !rid) return;
    const got = await input.read('listProperties', { path: { resourceId: rid } });
    if (got === undefined) return; // already gone: LegendKeeper answers the delete itself
    const name = this.d.pageName?.(input.job.projectId, rid) ?? rid;
    const changes = assessDelete(rules, rowsOf(sidebarFrom(got)), name).map((c) => ({
      ...c,
      resourceId: rid,
    }));
    if (changes.length > 0) {
      throw new CanonicalApprovalRequiredError(input.opId, canonicalReason(changes), changes, {
        jobId: input.job.id,
        stepNo: input.step.stepNo,
      });
    }
  }
}
