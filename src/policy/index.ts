/**
 * Public surface of `src/policy` (docs/policy.md): profiles and scopes, the live policy gate, proposals and the owner
 * command layer.
 *
 * Wiring (the composition root):
 *
 * ```ts
 * const policy = createPolicy({ db, settings: loadPolicyConfig(), allowMemberAdmin: config.lk.allowMemberAdmin });
 * const engine = createJobEngine({ db, lk, settings, policyGate: policy.gate, proposalSink: policy.proposals });
 * policy.attach(engine);      // job outcomes, restart reconciliation, expiry sweep, events
 * buildServer({ ..., policy }) // consent profiles, per-principal tool lists, the proposal tools
 * policy.commands             // owner commands for chunk 5's admin routes (never for MCP)
 * ```
 *
 * `issueApprovalToken` is intentionally not exported.
 */
import { AuthStore } from '../auth/store.js';
import type { ConsentProfiles } from '../auth/services.js';
import { defaultPolicySettings, type PolicySettings } from '../config/policy.js';
import type { Db } from '../db/open.js';
import type { JobEngine } from '../jobs/engine.js';
import type { Clock } from '../lk/governor/clock.js';
import type { McpAccessControl, McpToolProvider } from '../mcp/server.js';
import { createOwnerCommands, type OwnerCommands } from './commands.js';
import { createConsentProfiles } from './consent.js';
import { createPolicyGate, type LivePolicyGate } from './gate.js';
import { createMcpAccessControl, proposalTools } from './mcp.js';
import { ProposalService } from './proposals.js';
import { PolicyStore } from './store.js';

export interface CreatePolicyOptions {
  readonly db: Db;
  readonly settings?: PolicySettings;
  /** LK_ALLOW_MEMBER_ADMIN. */
  readonly allowMemberAdmin: boolean;
  /** Milliseconds since the epoch (tests pass the FakeClock's `now`). */
  readonly now?: () => number;
  /** Timers for the expiry sweep. */
  readonly clock?: Clock;
  readonly log?: { warn(o: Record<string, unknown>, m: string): void };
  /** Chunk 6: the maintenance scheduler runs the expiry sweep, so the service starts no timer (see ProposalService). */
  readonly externalExpirySweep?: boolean;
}

export interface Policy {
  readonly store: PolicyStore;
  readonly gate: LivePolicyGate;
  readonly proposals: ProposalService;
  readonly consent: ConsentProfiles;
  readonly access: McpAccessControl;
  /** `bridge_proposal_status` and `bridge_proposals_mine`. */
  readonly tools: readonly McpToolProvider[];
  readonly commands: OwnerCommands;
  attach(engine: JobEngine): () => void;
}

export function createPolicy(o: CreatePolicyOptions): Policy {
  const settings = o.settings ?? defaultPolicySettings();
  const store = new PolicyStore(o.db, o.now ?? o.clock?.now.bind(o.clock) ?? (() => Date.now()));
  const proposals = new ProposalService({
    store,
    settings,
    allowMemberAdmin: o.allowMemberAdmin,
    ...(o.clock ? { clock: o.clock } : {}),
    ...(o.log ? { log: o.log } : {}),
    ...(o.externalExpirySweep ? { externalExpirySweep: true } : {}),
  });
  const gate = createPolicyGate({
    store,
    allowMemberAdmin: o.allowMemberAdmin,
    cacheMs: settings.cacheMs,
    proposalState: (id) => proposals.state(id),
  });
  return {
    store,
    gate,
    proposals,
    consent: createConsentProfiles(store),
    access: createMcpAccessControl(gate),
    tools: proposalTools(proposals),
    commands: createOwnerCommands({ store, proposals, authStore: new AuthStore(o.db) }),
    attach: (engine) => proposals.attach(engine),
  };
}

export { PolicyStore, validateLabel, type AuditRow, type ConnectionView } from './store.js';
export {
  LivePolicyGate,
  createPolicyGate,
  readOnlyReason,
  MEMBER_ADMIN_REASON,
  UPLOAD_OPERATIONS,
  UPLOAD_PROPOSE_REASON,
} from './gate.js';
export { ProposalService, readerTarget, proposalSummary } from './proposals.js';
export type { ProposalDetail, ProposalOpDetail, AgentProposalView } from './proposals.js';
export { createOwnerCommands, type OwnerCommands, type BulkResult, type ProfileSummary } from './commands.js';
export { createConsentProfiles, ensureProfile, suggestKind, DEFAULT_PAT_PROFILE } from './consent.js';
export { createMcpAccessControl, mcpOrigin, proposalTools } from './mcp.js';
export { PolicyError, type PolicyErrorCode } from './errors.js';
export { canonicalJson, hashJson, isLiveApprovalToken } from './approval.js';
export * from './types.js';
