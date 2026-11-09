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
import type { OpParams, Principal } from '../jobs/types.js';
import type { PolicyContext, PolicyDecision, PolicyGate, PolicyOpMeta } from '../jobs/policy.js';
import { isLiveApprovalToken } from './approval.js';
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
      if (adminBlocked) return deny(MEMBER_ADMIN_REASON);
      return { decision: 'allow' };
    }
    if (origin.approvedBy !== undefined) {
      return deny('approvedBy can only be set by the owner approving a proposal');
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
        // Refused before anything is sent: lk_upload_image, and raw createImageUpload / createImageAsset calls.
        if (ctx.jobKind === 'upload_image' || UPLOAD_OPERATIONS.has(op.operationId)) {
          return deny(UPLOAD_PROPOSE_REASON);
        }
        return { decision: 'propose' };
      default:
        return deny(readOnlyReason(resolved.principal.profile));
    }
  }
}

export function createPolicyGate(o: PolicyGateOptions): LivePolicyGate {
  return new LivePolicyGate(o);
}
