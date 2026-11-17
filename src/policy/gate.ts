/**
 * The real policy gate (replaces chunk 2's allow-all). Evaluated LIVE on every engine entry: the principal's profile
 * and scope are read from the database (cached for at most one second, and the cache is dropped on any change made
 * through the bridge), so a scope change applies to existing connections at once, with no reconnection.
 *
 * | scope     | reads | everything else                                                           |
 * | --------- | ----- | ------------------------------------------------------------------------- |
 * | `read`    | allow | deny: the connection is read-only; the owner can change this              |
 * | `propose` | allow | propose (the proposal service captures it; nothing is sent to LegendKeeper) |
 * | `write`   | allow | allow (the engine's guards still apply)                                    |
 *
 * Member and invite administration (registry `risk: admin`) stays refused for every agent unless
 * LK_ALLOW_MEMBER_ADMIN=true: by the engine's guard (`MEMBER_ADMIN_DISABLED`) and, for proposals, at capture.
 * The `system` principal (internal and dashboard work) is always allowed, except on an MCP origin, where it can only mean a tool forgot to pass the caller. Unknown, revoked or expired principals are denied.
 *
 * Approved proposals: see approval.ts. A valid token for the proposal containing the operation wins over the
 * proposer's (possibly since lowered) scope; `approvedBy` or a token that is not valid is refused outright.
 */
import type { JobKind, OpParams, Principal } from '../jobs/types.js';
import type {
  PolicyContext,
  PolicyDecision,
  PolicyGate,
  PolicyOpMeta,
  RailDecision,
  RailRequestItem,
} from '../jobs/policy.js';
import { isLiveApprovalToken } from './approval.js';
import { railsVerdict } from './rails.js';
import type { PolicyStore } from './store.js';
import type { ResolvedPrincipal, Scope } from './types.js';

export interface PolicyGateOptions {
  readonly store: PolicyStore;
  /** LK_ALLOW_MEMBER_ADMIN. */
  readonly allowMemberAdmin: boolean;
  /** At most 1000 ms (default 1000). */
  readonly cacheMs?: number;
  /** The current state of a proposal (the token is only honoured while it is `approved`). */
  readonly proposalState: (proposalId: string) => string | undefined;
  readonly now?: () => number;
}

export const SYSTEM_PRINCIPAL_ID = 'system';

/** v3 F3.4 (ADR 0055): what the rails need from the repository tree (set once the tree exists). */
export interface RailLookups {
  /** How many pages lie under a page (its descendants), or null when the tree does not know. */
  readonly descendants?: (projectId: string, resourceId: string) => number | null;
  readonly pageName?: (projectId: string, resourceId: string) => string | null;
  /**
   * CR-2026-11-R2 (B7): how many pages lie under a page as LegendKeeper holds them now (the tree may not have seen pages
   * added in the app since its last sweep), listed until more than `limit` are found; null when they cannot be listed.
   */
  readonly liveDescendants?: (projectId: string, resourceId: string, limit: number) => Promise<number | null>;
}

/** The pages whose descendants a request's rails count: a cascade delete's page, a copy's source (with its children). */
function countedRoots(items: readonly RailRequestItem[]): string[] {
  const roots = new Set<string>();
  for (const it of items) {
    if (it.kind === 'read') continue;
    const body = (it.params.body ?? {}) as { templateId?: unknown; includeChildren?: unknown };
    const rid = it.params.path?.resourceId;
    const cascade = it.params.query?.cascade === true || it.params.query?.cascade === 'true';
    if (it.opId === 'deleteResource' && cascade && rid) roots.add(rid);
    if (body.includeChildren !== true) continue;
    if (it.opId === 'saveResourceAsTemplate' && rid) roots.add(rid);
    if (it.opId === 'createResourceFromTemplate' && typeof body.templateId === 'string')
      roots.add(body.templateId);
  }
  return [...roots];
}

/** The message an agent sees when its connection is read-only. */
export function readOnlyReason(profile: string): string {
  return (
    `this connection is read-only (profile "${profile}" has scope "read"). ` +
    'The bridge owner can change the profile’s scope in the LK-Bridge dashboard.'
  );
}

/** v1: uploads are not proposable (a proposal cannot hold the image bytes and signed URL safely). */
export const UPLOAD_OPERATIONS: ReadonlySet<string> = new Set(['createImageUpload', 'createImageAsset']);

export const UPLOAD_PROPOSE_REASON =
  'image uploads cannot be proposed: they need a connection with scope "write". ' +
  'The bridge owner can raise this profile’s scope in the LK-Bridge dashboard.';

export const MEMBER_ADMIN_REASON =
  'member and invite administration is disabled on this bridge (LK_ALLOW_MEMBER_ADMIN=false)';

export class LivePolicyGate implements PolicyGate {
  private readonly cache = new Map<
    string,
    { at: number; version: number; value: ResolvedPrincipal | undefined }
  >();
  private readonly cacheMs: number;
  private readonly now: () => number;
  private railLookups: RailLookups = {};

  constructor(private readonly o: PolicyGateOptions) {
    this.cacheMs = Math.min(Math.max(o.cacheMs ?? 1000, 0), 1000);
    this.now = o.now ?? o.store.now;
  }

  /** The principal's live profile and scope (≤ 1 s cache, cleared by any change through the store). */
  resolve(principalId: string): ResolvedPrincipal | undefined {
    const now = this.now();
    const version = this.o.store.version;
    const hit = this.cache.get(principalId);
    if (hit && hit.version === version && now - hit.at < this.cacheMs) return hit.value;
    const value = this.o.store.lookupPrincipal(principalId);
    if (this.cache.size > 10_000) this.cache.clear();
    this.cache.set(principalId, { at: now, version, value });
    return value;
  }

  /** The live scope of a principal, or undefined when it is unknown or inactive. */
  scopeOf(principalId: string): Scope | undefined {
    const r = this.resolve(principalId);
    return r?.active ? r.scope : undefined;
  }

  authorize(principal: Principal, op: PolicyOpMeta, params: OpParams, ctx: PolicyContext): PolicyDecision {
    const deny = (reason: string): PolicyDecision => ({ decision: 'deny', reason });
    const origin = ctx.origin;
    const adminBlocked = op.risk === 'admin' && !this.o.allowMemberAdmin;

    // 1. The owner's approval of a proposal (only the proposal service can mint the token).
    if (origin.approval !== undefined) {
      const token = origin.approval;
      if (!isLiveApprovalToken(token)) return deny('the approval token is not valid');
      if (ctx.jobKind !== 'batch_ops' || ctx.stepIndex === undefined) {
        return deny('approved work must be submitted as the approved batch');
      }
      if (
        !token.covers(principal.principalId, ctx.project, ctx.stepIndex, op.operationId, params, this.now())
      ) {
        return deny('the approval does not cover this operation');
      }
      if (this.o.proposalState(token.proposalId) !== 'approved') {
        return deny(`proposal ${token.proposalId} is not awaiting execution`);
      }
      // v2 C2a: "accepted as canon" only with the token the owner's canonical approval minted.
      if (origin.canonicalApprovedBy !== undefined && !token.canonical) {
        return deny('canonicalApprovedBy can only be set by the owner accepting a proposal as canon');
      }
      if (adminBlocked) return deny(MEMBER_ADMIN_REASON);
      return { decision: 'allow' };
    }
    if (origin.approvedBy !== undefined) {
      return deny('approvedBy can only be set by the owner approving a proposal');
    }
    if (origin.canonicalApprovedBy !== undefined) {
      return deny('canonicalApprovedBy can only be set by the owner accepting a proposal as canon');
    }

    // 2. Internal and dashboard work.
    if (principal.principalId === SYSTEM_PRINCIPAL_ID) {
      if (origin.kind === 'mcp') return deny('an MCP request must act for the connection that made it');
      return { decision: 'allow' };
    }

    // 3. An agent: its profile's scope, read now.
    const resolved = this.resolve(principal.principalId);
    if (!resolved) return deny('the connection is not known to the bridge');
    if (!resolved.active) return deny('the connection has been revoked or has expired');
    if (op.kind === 'read') return { decision: 'allow' };
    // Member and invite administration is refused by the engine's own guard (MEMBER_ADMIN_DISABLED) at every scope,
    // after this gate, and by the dry-run of the guards at proposal capture; that typed refusal is clearer for agents.
    switch (resolved.scope) {
      case 'write':
        return { decision: 'allow' };
      case 'propose':
        // v2 D3 (ADR 0041): staging an image is allowed: it lands hidden in the project's staging folder, and placing it
        // is the proposal the owner approves (the proposal then holds no image bytes).
        if (ctx.jobKind === 'upload_image' && ctx.staging === true) return { decision: 'allow' };
        // v3 F2 (ADR 0049 decision 10): placing an image staged on the bridge's server uploads it: the proposal.
        if (ctx.jobKind === 'batch_ops' && ctx.stagedPlacement === true) return { decision: 'propose' };
        // Refused before anything is sent: lk_upload_image, and raw createImageUpload / createImageAsset calls.
        if (ctx.jobKind === 'upload_image' || UPLOAD_OPERATIONS.has(op.operationId)) {
          return deny(UPLOAD_PROPOSE_REASON);
        }
        return { decision: 'propose' };
      default:
        return deny(readOnlyReason(resolved.principal.profile));
    }
  }

  /** v3 F3.4: the tree's answers the rails use (a cascade's pages, page names for the reason). */
  setRailLookups(l: RailLookups): void {
    this.railLookups = l;
  }

  /**
   * v3 F3.4 (ADR 0055): the safety rails of the principal's profile, read live (the same cache as the scope), for a
   * request that would run directly. Only an agent at scope `write` has rails; anyone else gets null (the gate itself
   * decides for them).
   */
  async rails(
    principal: Principal,
    items: readonly RailRequestItem[],
    ctx: { readonly project: string; readonly jobKind: JobKind; readonly stagedPlacement?: boolean },
  ): Promise<RailDecision | null> {
    if (principal.principalId === SYSTEM_PRINCIPAL_ID) return null;
    const r = this.resolve(principal.principalId);
    if (!r?.active || r.scope !== 'write') return null;
    const l = this.railLookups;
    const base = {
      ...(l.pageName ? { pageName: (id: string) => l.pageName!(ctx.project, id) } : {}),
      ...(ctx.stagedPlacement === true ? { stagedPlacement: true } : {}),
    };
    const fromTree = (id: string) => l.descendants?.(ctx.project, id) ?? null;
    const verdict = railsVerdict(r.rails, items, { ...base, descendants: fromTree });
    // CR-2026-11-R2 (B7): a request the tree's counts would let run directly although it deletes a cascade or copies a
    // page with its children is counted again on the pages LegendKeeper holds now (the larger count wins; a listing
    // that cannot be made fails closed). Only then: a request already proposed costs no reads.
    if (verdict !== null || !r.rails.bulk || !l.liveDescendants) return verdict;
    const roots = countedRoots(items);
    if (roots.length === 0) return null;
    const live = new Map<string, number | null>();
    for (const id of roots) live.set(id, await l.liveDescendants(ctx.project, id, r.rails.bulkPages));
    return railsVerdict(r.rails, items, {
      ...base,
      descendants: (id: string) => {
        const now = live.get(id);
        if (now === undefined) return fromTree(id);
        return now === null ? null : Math.max(fromTree(id) ?? 0, now);
      },
    });
  }
}

export function createPolicyGate(o: PolicyGateOptions): LivePolicyGate {
  return new LivePolicyGate(o);
}
