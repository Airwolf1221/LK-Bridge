/**
 * The real policy gate (replaces chunk 2's allow-all). Evaluated LIVE on every engine entry: the principal's profile
 * and scope are read from the database (cached for at most one second, and the cache is dropped on any change made
 * through the bridge), so a scope change applies to existing connections at once, with no reconnection.
 *
 * | scope     | reads | everything else                                                           |
 * | --------- | ----- | ------------------------------------------------------------------------- |
 * | `read`    | allow | deny: the connection is read-only; the owner can change this              |
 * | `propose` | allow | propose (the proposal service captures it; nothing is sent to LegendKeeper) |
 * | `write`   | allow | allow: direct, canon and lifecycle changes included (v3 F12, ADR 0081; the guards' refusals still apply) |
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
import { AGENT_REFUSED } from '../review/write-kinds.js';
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
/** v3 F5b (ADR 0068): the automation engine's principal (`AUTOMATION_PRINCIPAL` in src/jobs/types.ts). */
export const AUTOMATION_PRINCIPAL_ID = 'automation';

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

    // 2a. v3 F5b (ADR 0068): the automation engine's own principal, for the codes the owner switched on. Only the
    // engine acts as it (origin `maintenance`, tool `automation.*`); the canon and lifecycle guards still judge every
    // request (v3 F12, ADR 0081: the safety rails are gone).
    if (principal.principalId === AUTOMATION_PRINCIPAL_ID) {
      // Its reads carry the origin's kind through the bridge's own machinery (a proposal's capture reads as
      // `proposal_capture`); its writes name the engine's tool.
      if (origin.kind !== 'maintenance')
        return deny('only the bridge’s automation engine acts as the Automation principal');
      if (op.kind !== 'read' && (typeof origin.tool !== 'string' || !origin.tool.startsWith('automation.')))
        return deny('only the bridge’s automation engine acts as the Automation principal');
      if (adminBlocked) return deny(MEMBER_ADMIN_REASON);
      return { decision: 'allow' };
    }

    // 3. An agent: its profile's scope, read now.
    const resolved = this.resolve(principal.principalId);
    if (!resolved) return deny('the connection is not known to the bridge');
    if (!resolved.active) return deny('the connection has been revoked or has expired');
    if (op.kind === 'read') return { decision: 'allow' };
    // v3 F12 (ADR 0081, D2): a write no Revert can undo is never an agent's, whatever the scope or LK_ALLOW_MEMBER_ADMIN.
    const refused = AGENT_REFUSED[op.operationId];
    if (refused) return deny(`${op.operationId}: ${refused}. The owner does it in the LegendKeeper app.`);
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

}

export function createPolicyGate(o: PolicyGateOptions): LivePolicyGate {
  return new LivePolicyGate(o);
}
