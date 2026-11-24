/**
 * The page lifecycle (v2 C2c, ADR 0035): the per-project settings and their owner commands, the lifecycle record
 * (written by the lifecycle tools' own jobs through the `bridge.record` step), and the link index (kept up to date from
 * the bridge's own writes, refreshed by the paced `link-sweep`) behind the related-pages report.
 *
 * ```ts
 * const lifecycle = createLifecycle({ db, engine, tree, settings, setSetting, projectName, audit, now });
 * const detach = lifecycle.attach(); // the record handler and the link index's write observer
 * lifecycle.find(projectId);          // [INDEX] Working and [INDEX] Archived, found by name
 * lifecycle.update('owner', projectId, { workingIndexId, archiveIndexId }); // confirmed, audited
 * ```
 */
import { randomBytes } from 'node:crypto';
import type { Db } from '../db/open.js';
import {
  BudgetExhaustedError,
  LkOperationError,
  type JobEngine,
  type JobView,
  type OpParams,
  type StepView,
  type WriteObserver,
} from '../jobs/index.js';
import type { TreeNode, TreeService } from '../tree/index.js';
import { collectionLinks, mentionLinks, propertyLinks } from './links.js';
import {
  DEFAULT_LIFECYCLE,
  findIndexByName,
  lifecycleFrom,
  lifecycleIndexes,
  lifecycleSchema,
  storedLifecycle,
  type IndexLookup,
  type LifecycleConfig,
  type StoredLifecycle,
} from './settings.js';
import { LifecycleStore, type LifecycleRecordInput, type LifecycleSetInput, type LinkRow } from './store.js';

export * from './settings.js';
export * from './store.js';
export * from './tags.js';
export { collectionLinks, mentionLinks, propertyLinks } from './links.js';
export {
  LifecycleGuard,
  placeChange,
  prefixChange,
  statusChange,
  type LifecycleChange,
  type LifecycleGuardDeps,
} from './guard.js';

type Obj = Record<string, unknown>;

export class LifecycleError extends Error {
  override readonly name = 'LifecycleError';
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

export interface LifecycleDeps {
  readonly db: Db;
  readonly engine: JobEngine;
  readonly tree: Pick<TreeService, 'queries'>;
  /** A project's settings, read live. */
  readonly settings: (projectId: string) => Readonly<Record<string, unknown>> | undefined;
  /** Stores one setting of a project (`null` clears it). */
  readonly setSetting: (projectId: string, key: string, value: unknown) => void;
  readonly projectName: (projectId: string) => string;
  /** The audit log (actor, action, target, before, after). */
  readonly audit: (
    actor: string,
    action: string,
    target: string | null,
    before?: unknown,
    after?: unknown,
  ) => void;
  readonly now: () => number;
  /** Whether agents' work (P1 or P2) is queued for the project: the link sweep gives way. */
  readonly busy?: (projectId: string) => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: { warn(obj: Record<string, unknown>, msg: string): void };
}

/** One lifecycle index as a lookup found it, for the dashboard and the tools' refusals. */
export interface IndexLookupView {
  readonly status: IndexLookup['status'];
  readonly name: string;
  readonly node?: { readonly id: string; readonly name: string; readonly path: string };
  readonly candidates?: readonly { readonly id: string; readonly name: string; readonly path: string }[];
}

/** A page that links to another, as the related-pages report shows it. */
export interface RelatedPage {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly kind: string;
  /** How it links: `collection` with the collection's title, `mention` with the document's name. */
  readonly links: readonly {
    readonly kind: 'collection' | 'mention';
    readonly via: string;
    readonly seenAt: number;
  }[];
}

export interface Related {
  readonly pages: readonly RelatedPage[];
  /** "link index as of …": when the last complete sweep started, and whether writes since are indexed too. */
  readonly freshness: {
    readonly asOf: number | null;
    readonly sweepRunning: boolean;
    readonly text: string;
  };
}

export interface Lifecycle {
  readonly store: LifecycleStore;
  config(projectId: string): LifecycleConfig;
  /** `[INDEX] Working` and `[INDEX] Archived`, found by name in the tree now (never by id or position). */
  find(projectId: string): {
    readonly working: IndexLookupView;
    readonly archived: IndexLookupView;
    readonly config: LifecycleConfig;
    readonly confirmed: { readonly ok: boolean; readonly code?: string; readonly message?: string };
  };
  /** The owner's change of the settings (the two indexes confirmed, values edited; `null` restores the defaults). */
  update(actor: 'owner', projectId: string, patch: Partial<StoredLifecycle> | null): LifecycleConfig;
  /** Registers the `bridge.record` handler and the link index's write observer; returns a detach. */
  attach(): () => void;
  /** The pages that link to a page, from the link index (pages still in the tree only). */
  related(projectId: string, pageId: string): Related;
  /**
   * The link sweep of one project: paced (bulk P4 reads, v3 F9 / ADR 0074: it reads every page; they wait out an
   * exhausted budget, give way to routine P3 work and wait while agents' P1 or P2 work is queued), resumable (a pass
   * that stops is continued by the next run).
   */
  sweep(projectId: string): Promise<{
    readonly summary: string;
    readonly changed: boolean;
    readonly skipped?: boolean;
  }>;
  /** Stops a sweep in flight (shutdown): it stops after its current read, to be continued by the next run. */
  stop(): void;
}

/** v3 F9 (ADR 0074): the link sweep reads every page of the AI REPOSITORY: bulk. */
export const LINK_SWEEP_PRIORITY = 'P4' as const;

const nodeView = (n: TreeNode) => ({ id: n.id, name: n.rawName, path: n.path.names.join(' / ') });

function lookupView(l: IndexLookup): IndexLookupView {
  if (l.status === 'found') return { status: 'found', name: l.node.displayName, node: nodeView(l.node) };
  if (l.status === 'missing') return { status: 'missing', name: l.name };
  return { status: 'ambiguous', name: l.name, candidates: l.candidates.map(nodeView) };
}

const PARTIAL_BLOCK_WRITES: ReadonlySet<string> = new Set([
  'replaceBlock',
  'updateBlock',
  'deleteBlock',
  'moveBlock',
  'assignBlockIds',
]);

export function createLifecycle(d: LifecycleDeps): Lifecycle {
  const store = new LifecycleStore(d.db, d.now);
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const config = (projectId: string) => lifecycleFrom(d.settings(projectId));
  const node = (projectId: string, id: string): TreeNode | null => {
    try {
      return d.tree.queries.node(projectId, id).data ?? null;
    } catch {
      return null;
    }
  };

  // ------------------------------------------------------------------------------------------ settings

  const find: Lifecycle['find'] = (projectId) => {
    const c = config(projectId);
    let indexes: TreeNode[];
    try {
      indexes = d.tree.queries.byKind(projectId, 'index', { limit: 100_000 }).data;
    } catch {
      indexes = [];
    }
    const check = lifecycleIndexes(c, (id) => node(projectId, id));
    return {
      working: lookupView(findIndexByName(indexes, c.indexNames.working)),
      archived: lookupView(findIndexByName(indexes, c.indexNames.archived)),
      config: c,
      confirmed: check.ok ? { ok: true } : { ok: false, code: check.code, message: check.message },
    };
  };

  const update: Lifecycle['update'] = (actor, projectId, patch) => {
    if (actor !== 'owner')
      throw new LifecycleError('NOT_OWNER', 'Only the owner changes the lifecycle settings.');
    const before = config(projectId);
    const name = d.projectName(projectId);
    if (patch === null) {
      d.setSetting(projectId, 'lifecycle', null);
      d.audit('owner', 'project.set_lifecycle', name, storedLifecycle(before), null);
      return config(projectId);
    }
    const { problem: _p, ...base } = before;
    const merged = { ...storedLifecycle(base), ...patch };
    const parsed = lifecycleSchema.safeParse(merged);
    if (!parsed.success) {
      throw new LifecycleError(
        'INVALID_SETTING',
        parsed.error.issues.map((i) => `${i.path.join('.') || 'lifecycle'}: ${i.message}`).join('; '),
      );
    }
    const next = lifecycleFrom({ lifecycle: parsed.data });
    // The indexes the owner confirms must be what a lookup by name finds now: in the tree, an index, named as set.
    for (const [which, id, want] of [
      ['Working', next.workingIndexId, next.indexNames.working],
      ['Archive', next.archiveIndexId, next.indexNames.archived],
    ] as const) {
      if (!id) continue;
      const n = node(projectId, id);
      if (!n || n.kind !== 'index' || n.displayName.trim().toLowerCase() !== want.trim().toLowerCase()) {
        throw new LifecycleError(
          'INDEX_NOT_FOUND',
          `${id} is not “[INDEX] ${want}” in the repository tree, so it cannot be confirmed as the ${which} index.`,
        );
      }
    }
    // E5.3: an index whose pages are Authoritative without CANON must be an index in the tree, and not a lifecycle index.
    for (const id of patch.canonExemptIndexes ?? []) {
      const n = node(projectId, id);
      if (!n || n.kind !== 'index')
        throw new LifecycleError(
          'INDEX_NOT_FOUND',
          `${id} is not an [INDEX] in the repository tree, so its pages cannot be Authoritative without ${next.tags.canon}.`,
        );
      if (id === next.workingIndexId || id === next.archiveIndexId)
        throw new LifecycleError(
          'INVALID_SETTING',
          `${n.rawName} is a lifecycle index; the Working and Archived areas keep their own rules.`,
        );
    }
    if (next.workingIndexId && next.archiveIndexId) {
      const check = lifecycleIndexes(next, (id) => node(projectId, id));
      if (!check.ok) throw new LifecycleError(check.code, check.message);
    }
    d.setSetting(projectId, 'lifecycle', parsed.data);
    d.audit('owner', 'project.set_lifecycle', name, storedLifecycle(base), parsed.data);
    return config(projectId);
  };

  // ------------------------------------------------------------------------------------------ the record step

  const recordHandler = (job: JobView, _step: StepView, params: OpParams): unknown => {
    const body = (params.body ?? {}) as { action?: unknown; record?: unknown };
    if (body.action === 'begin') {
      const r = body.record as LifecycleRecordInput & { resumeOf?: number };
      if (!r || typeof r.pageId !== 'string' || typeof r.action !== 'string') {
        throw new LifecycleError(
          'INVALID_RECORD',
          'The lifecycle record of this job is not valid; nothing was written.',
        );
      }
      const origin = job.origin as { canonicalApprovedBy?: unknown; approval?: { proposalId?: unknown } };
      const approver =
        typeof origin.canonicalApprovedBy === 'string'
          ? origin.canonicalApprovedBy
          : (job.approvedBy ?? null);
      const proposalId = typeof origin.approval?.proposalId === 'string' ? origin.approval.proposalId : null;
      const rec = store.begin(job.projectId, {
        ...r,
        principalId: job.principalId,
        approver,
        jobId: job.id,
        proposalId,
        ...(typeof r.resumeOf === 'number' ? { resumeOf: r.resumeOf } : {}),
      });
      return { recordId: rec.id, state: rec.state };
    }
    if (body.action === 'complete') {
      const rec = store.byJob(job.projectId, job.id);
      if (!rec) throw new LifecycleError('NO_RECORD', 'This job wrote no lifecycle record to complete.');
      // The verify step's verdict, kept with the record.
      const steps = d.engine.stepResults(job.projectId, job.id) ?? [];
      const verification = steps
        .map((s) => (s.value as { verification?: { status?: unknown } } | null)?.verification)
        .find((v) => v !== undefined);
      const extra = (body.record ?? {}) as Obj;
      const done = store.complete(job.projectId, rec.id, {
        ...extra,
        ...(verification
          ? { verified: verification.status === 'verified', verification: verification.status }
          : {}),
      });
      return { recordId: rec.id, state: done?.state ?? 'complete' };
    }
    // C2d (ADR 0037): a whole set: the set record and every page's own record (linked to it), begun and completed
    // together; a resume adds this job to the set and to each page's record.
    if (body.action === 'begin_set') {
      const r = body.record as {
        set?: LifecycleSetInput;
        records?: LifecycleRecordInput[];
        resumeOf?: number;
      };
      if (!r?.set || typeof r.set.rootId !== 'string' || !Array.isArray(r.records)) {
        throw new LifecycleError(
          'INVALID_RECORD',
          'The lifecycle set record of this job is not valid; nothing was written.',
        );
      }
      const origin = job.origin as { canonicalApprovedBy?: unknown; approval?: { proposalId?: unknown } };
      const approver =
        typeof origin.canonicalApprovedBy === 'string'
          ? origin.canonicalApprovedBy
          : (job.approvedBy ?? null);
      const proposalId = typeof origin.approval?.proposalId === 'string' ? origin.approval.proposalId : null;
      const out = store.beginSet(job.projectId, {
        ...r.set,
        records: r.records,
        principalId: job.principalId,
        approver,
        jobId: job.id,
        proposalId,
        ...(typeof r.resumeOf === 'number' ? { resumeOf: r.resumeOf } : {}),
      });
      return { setId: out.set.id, state: out.set.state, recordIds: out.records.map((x) => x.id) };
    }
    if (body.action === 'complete_set') {
      const set = store.setByJob(job.projectId, job.id);
      if (!set) throw new LifecycleError('NO_RECORD', 'This job wrote no lifecycle set record to complete.');
      const steps = d.engine.stepResults(job.projectId, job.id) ?? [];
      const verification = steps
        .map((s) => (s.value as { verification?: { status?: unknown } } | null)?.verification)
        .find((v) => v !== undefined);
      const extra = (body.record ?? {}) as Obj;
      const done = store.completeSet(job.projectId, set.id, {
        ...extra,
        ...(verification
          ? { verified: verification.status === 'verified', verification: verification.status }
          : {}),
      });
      return { setId: set.id, state: done?.state ?? 'complete' };
    }
    throw new LifecycleError(
      'INVALID_RECORD',
      'A bridge.record step is begin, complete, begin_set or complete_set.',
    );
  };

  // ------------------------------------------------------------------------------------------ the link index

  /** Subtrees of pages being deleted, taken before the write (the tree drops them after it). */
  const deleting = new Map<string, string[]>();

  const observer: WriteObserver = {
    beforeWrite(info) {
      if (info.opId !== 'deleteResource') return;
      const rid = info.params.path?.resourceId;
      if (!rid) return;
      let ids = [rid];
      try {
        ids = d.tree.queries
          .subtree(info.projectId, rid, { limit: 100_000 })
          .data.entries.map((e) => e.node.id);
        if (ids.length === 0) ids = [rid];
      } catch {
        // not in the tree: the page alone
      }
      deleting.set(`${info.jobId}:${info.stepNo}`, ids);
    },
    async afterWrite(r) {
      const pid = r.projectId;
      const path = r.params.path ?? {};
      const rid = path.resourceId;
      const key = `${r.jobId}:${r.stepNo}`;
      const del = deleting.get(key);
      deleting.delete(key);
      if (r.outcome !== 'succeeded' || !rid) return;
      const value = r.value as Obj | undefined;
      const body = (r.params.body ?? {}) as Obj;
      try {
        switch (r.opId) {
          case 'replaceDocumentBlocks': {
            const blocks = Array.isArray(value?.blocks) ? value.blocks : body.blocks;
            const docName = node(pid, rid)?.documents.find((x) => x.id === path.documentId)?.name ?? null;
            store.replaceLinks(
              pid,
              rid,
              { kind: 'document', documentId: path.documentId! },
              mentionLinks(blocks, path.documentId!, docName),
              'write',
            );
            return;
          }
          case 'insertBlock': {
            const docName = node(pid, rid)?.documents.find((x) => x.id === path.documentId)?.name ?? null;
            store.addLinks(pid, rid, mentionLinks(body.block, path.documentId!, docName), 'write');
            return;
          }
          case 'updateProperty':
          case 'createProperty': {
            if (value && (value.kind === 'resourceCollection' || value.kind === 'resourceLink')) {
              store.replaceLinks(
                pid,
                rid,
                { kind: 'collection', title: typeof value.title === 'string' ? value.title : '' },
                propertyLinks(value),
                'write',
              );
            }
            return;
          }
          case 'deleteProperty': {
            const sb = await d.engine.internalRead(
              pid,
              'listProperties',
              { path: { resourceId: rid } },
              {
                priority: r.priority,
                jobId: r.jobId,
                signal: r.signal,
                notFoundIsAnswer: true,
              },
            );
            store.replaceLinks(pid, rid, { kind: 'sidebar' }, collectionLinks(sb), 'write');
            return;
          }
          case 'deleteResource':
            store.removeFrom(pid, del ?? [rid]);
            return;
          case 'deleteDocument':
            if (path.documentId) store.removeDocument(pid, rid, path.documentId);
            return;
          default:
            if (PARTIAL_BLOCK_WRITES.has(r.opId) && path.documentId) {
              // A partial block write: what it removed is not in the request, so the document is read again (one
              // read) when the index holds mentions from it; otherwise what it adds is taken from the request.
              if (store.hasMentionsVia(pid, rid, path.documentId)) {
                const got = (await d.engine.internalRead(
                  pid,
                  'getDocumentBlocks',
                  { path: { resourceId: rid, documentId: path.documentId } },
                  { priority: r.priority, jobId: r.jobId, signal: r.signal, notFoundIsAnswer: true },
                )) as { blocks?: unknown } | undefined;
                const docName = node(pid, rid)?.documents.find((x) => x.id === path.documentId)?.name ?? null;
                store.replaceLinks(
                  pid,
                  rid,
                  { kind: 'document', documentId: path.documentId },
                  mentionLinks(got?.blocks ?? [], path.documentId, docName),
                  'write',
                );
              } else if (r.opId !== 'deleteBlock') {
                const docName = node(pid, rid)?.documents.find((x) => x.id === path.documentId)?.name ?? null;
                store.addLinks(pid, rid, mentionLinks(body, path.documentId, docName), 'write');
              }
            }
        }
      } catch (e) {
        d.log?.warn({ err: e, jobId: r.jobId, stepNo: r.stepNo }, 'the link index could not follow a write');
      }
    },
  };

  // ------------------------------------------------------------------------------------------ related pages

  const related: Lifecycle['related'] = (projectId, pageId) => {
    const rows = store.linksTo(projectId, pageId);
    const byFrom = new Map<string, LinkRow[]>();
    for (const r of rows) {
      if (r.fromId === pageId) continue;
      const l = byFrom.get(r.fromId) ?? [];
      l.push(r);
      byFrom.set(r.fromId, l);
    }
    const pages: RelatedPage[] = [];
    for (const [from, links] of byFrom) {
      const n = node(projectId, from);
      if (!n) continue; // deleted, or outside the repository
      pages.push({
        id: n.id,
        name: n.rawName,
        path: n.path.names.join(' / '),
        kind: n.kind,
        links: links.map((l) => ({
          kind: l.kind,
          via:
            l.kind === 'mention'
              ? (l.viaName ?? n.documents.find((x) => x.id === l.via)?.name ?? l.via)
              : l.via,
          seenAt: l.seenAt,
        })),
      });
    }
    pages.sort((a, b) => a.path.localeCompare(b.path));
    const last = store.lastSweep(projectId);
    const running = store.runningSweep(projectId);
    const text = last
      ? `link index as of ${new Date(last.startedAt).toISOString()} (the last complete sweep), with the bridge’s own writes since`
      : 'link index from the bridge’s own writes only: no link sweep has completed yet, so links made outside the bridge are missing';
    return { pages, freshness: { asOf: last?.startedAt ?? null, sweepRunning: running !== null, text } };
  };

  // ------------------------------------------------------------------------------------------ the sweep

  const stopper = new AbortController();
  /**
   * One read of the sweep, at LINK_SWEEP_PRIORITY (bulk, P4) in its own fair-share lane: a gone page is undefined; an
   * exhausted budget is waited out on the clock.
   */
  const read = async (projectId: string, op: string, params: OpParams): Promise<unknown> => {
    for (;;) {
      if (stopper.signal.aborted) throw new Error('the bridge is stopping');
      try {
        return await d.engine.internalRead(projectId, op, params, {
          priority: LINK_SWEEP_PRIORITY,
          notFoundIsAnswer: true,
          signal: stopper.signal,
          lane: 'link-sweep',
        });
      } catch (e) {
        if (e instanceof LkOperationError && (e.lk.status === 404 || e.lkCode === 'NOT_FOUND'))
          return undefined;
        if (e instanceof BudgetExhaustedError) {
          await sleep(Math.max(1000, e.retryAtMs - d.now()));
          continue;
        }
        throw e;
      }
    }
  };

  const sweep: Lifecycle['sweep'] = async (projectId) => {
    let nodes: TreeNode[];
    try {
      const st = d.tree.queries.status(projectId).status;
      if (st !== 'ready' && st !== 'stale') {
        return {
          skipped: true,
          summary: `Skipped: the repository tree is ${st.replace('_', ' ')}.`,
          changed: false,
        };
      }
      const root = d.tree.queries.root(projectId).data ?? null;
      nodes = root
        ? d.tree.queries.subtree(projectId, root.id, { limit: 100_000 }).data.entries.map((e) => e.node)
        : [];
    } catch (e) {
      return {
        skipped: true,
        summary: `Skipped: ${e instanceof Error ? e.message : String(e)}`,
        changed: false,
      };
    }
    nodes = nodes.filter((n) => n.kind !== 'root').sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let pass = store.runningSweep(projectId);
    const resumed = pass !== null;
    if (!pass) pass = store.startSweep(`ls_${randomBytes(8).toString('hex')}`, projectId, nodes.length);
    const cursor = pass.cursor;
    const totals = { pages: 0, documents: 0, requests: 0, links: 0 };
    try {
      for (const n of nodes) {
        if (cursor !== null && n.id <= cursor) continue;
        // Agents' work first: wait while P1 or P2 work is queued for the project.
        for (let i = 0; i < 240 && d.busy?.(projectId); i++) await sleep(250);
        const one = { documents: 0, requests: 0, links: 0 };
        const res = (await read(projectId, 'getResource', { path: { resourceId: n.id } })) as Obj | undefined;
        one.requests++;
        if (!res || typeof res !== 'object') {
          store.removeFrom(projectId, [n.id]);
        } else {
          const coll = collectionLinks(res.properties);
          store.replaceLinks(projectId, n.id, { kind: 'sidebar' }, coll, 'sweep', d.now());
          one.links += coll.length;
          const docs = (Array.isArray(res.documents) ? (res.documents as Obj[]) : []).filter(
            (x) => typeof x.id === 'string' && x.deletedAt == null,
          );
          store.retainDocuments(
            projectId,
            n.id,
            docs.map((x) => x.id as string),
          );
          for (const doc of docs) {
            if (doc.type !== 'page') continue;
            const b = (await read(projectId, 'getDocumentBlocks', {
              path: { resourceId: n.id, documentId: doc.id as string },
            })) as { blocks?: unknown } | undefined;
            one.requests++;
            one.documents++;
            const blocks = b?.blocks ?? [];
            const m = mentionLinks(blocks, doc.id as string, typeof doc.name === 'string' ? doc.name : null);
            store.replaceLinks(
              projectId,
              n.id,
              { kind: 'document', documentId: doc.id as string },
              m,
              'sweep',
              d.now(),
            );
            one.links += m.length;
          }
        }
        // Progress after every page: a restart continues after the last page done.
        store.progressSweep(pass.id, { cursor: n.id, pages: 1, ...one });
        totals.pages++;
        totals.documents += one.documents;
        totals.requests += one.requests;
        totals.links += one.links;
      }
      // What the pass did not see again (pages deleted since, links removed outside the bridge) goes.
      const pruned = store.pruneBefore(projectId, pass.startedAt);
      store.finishSweep(pass.id, 'succeeded');
      const done = store.sweep(pass.id)!;
      return {
        summary: `${resumed ? 'Resumed and finished' : 'Swept'} the link index: ${done.pagesDone} pages, ${done.documentsRead} documents, ${done.requests} requests (${totals.requests} in this run); ${done.links} links seen, ${pruned} gone.`,
        changed: true,
      };
    } catch (e) {
      // The pass stays running: the next run continues after the last page done (it is never restarted).
      store.noteSweepError(pass.id, e instanceof Error ? e.message : String(e));
      throw e;
    }
  };

  return {
    store,
    config,
    find,
    update,
    attach() {
      const offRecord = d.engine.registerRecordHandler(recordHandler);
      const offObserver = d.engine.observeWrites(observer);
      return () => {
        offRecord();
        offObserver();
      };
    },
    related,
    sweep,
    stop: () => stopper.abort(),
  };
}

export { DEFAULT_LIFECYCLE };
