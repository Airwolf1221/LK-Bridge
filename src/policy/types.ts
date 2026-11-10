/** Shared types of the policy layer (docs/policy.md). */
import type { Principal } from '../jobs/types.js';
import type { ProjectScope } from '../projects/types.js';

export const SCOPES = ['read', 'propose', 'write'] as const;
/** `read`: reads only. `propose`: writes become proposals. `write`: writes execute (within every guard). */
export type Scope = (typeof SCOPES)[number];

export const PROFILE_KINDS = ['claude', 'chatgpt', 'claude-code', 'other'] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];

export function isScope(v: unknown): v is Scope {
  return typeof v === 'string' && (SCOPES as readonly string[]).includes(v);
}

export function isProfileKind(v: unknown): v is ProfileKind {
  return typeof v === 'string' && (PROFILE_KINDS as readonly string[]).includes(v);
}

export interface Profile {
  readonly id: string;
  readonly label: string;
  readonly kind: ProfileKind;
  readonly scope: Scope;
  /** v2 B2: whether the connections on this profile are shown the low-level tools in tools/list (default false). */
  readonly showLowLevelTools: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** The only actor allowed to run owner commands. Typed so that no agent-facing code can pass anything else. */
export type OwnerActor = 'owner';

/** Who an MCP request acts for, resolved from the server-issued token, with its live scope. */
export interface ResolvedPrincipal {
  readonly principal: Principal;
  readonly profileId: string;
  readonly scope: Scope;
  /** v2 B2: the profile's `showLowLevelTools`, read live. */
  readonly showLowLevelTools: boolean;
  /** False when the grant or PAT is revoked or expired. */
  readonly active: boolean;
}

export const PROPOSAL_STATES = [
  'pending',
  'approved',
  'rejected',
  'conflicted',
  'expired',
  'executing',
  'executed',
  'failed',
] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

/** States a proposal never leaves. */
export const FINAL_PROPOSAL_STATES: ReadonlySet<ProposalState> = new Set([
  'rejected',
  'conflicted',
  'expired',
  'executed',
  'failed',
]);

/** Where a proposal's target was read, and what it looked like. */
export interface CapturedTarget {
  readonly op: string;
  readonly path: Record<string, string>;
  /** For list reads: the entity the write targets (by id). */
  readonly selectId?: string;
}

export interface ProposalOpView {
  readonly index: number;
  readonly op: string;
  readonly opKind: string;
  readonly params: unknown;
  readonly options: Record<string, unknown>;
  readonly target: CapturedTarget | null;
  readonly targetExists: boolean | null;
  readonly version: string | null;
  readonly fingerprint: string | null;
}

export interface ProposalView {
  readonly id: string;
  /** v2 A1: the LegendKeeper id of the project the proposal is for; approval executes against it only. */
  readonly projectId: string;
  readonly principalId: string;
  readonly principalLabel: string;
  readonly profile: string;
  readonly jobKind: 'single_op' | 'batch_ops';
  readonly title: string;
  readonly priority: string;
  readonly summary: string;
  readonly state: ProposalState;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number;
  readonly decidedAt: number | null;
  readonly decidedBy: string | null;
  readonly rejectReason: string | null;
  readonly jobId: string | null;
  readonly conflict: ProposalConflict | null;
  readonly error: Record<string, unknown> | null;
  readonly finishedAt: number | null;
  readonly opCount: number;
  /**
   * v2 C1: the high-level operation, briefly (tool, page, document, mode, section, the version it was planned on, the
   * counts), or null for a v1 proposal. The whole operation is in the detail.
   */
  readonly operation: Readonly<Record<string, unknown>> | null;
  /**
   * v2 C2a (ADR 0032): the expansion makes a protected canonical change: only "Approve and accept as canon" can run it;
   * the ordinary approval is refused.
   */
  readonly requiresCanonicalApproval: boolean;
  /** v2 C2a: who accepted it as canon, and when (set by "Approve and accept as canon" only). */
  readonly canonicalApprovedBy: string | null;
  readonly canonicalApprovedAt: number | null;
  /** v2 C2a: the page-level summary, one plain line per page ("Asagiri Miyabi: sidebar, 2 facts changed"). */
  readonly pages: readonly string[];
}

export interface ProposalConflict {
  readonly index: number;
  readonly op: string;
  readonly reason: string;
  readonly capturedVersion: string | null;
  readonly currentVersion: string | null;
}

export interface ProposalFilter {
  /** v2 A1: one project's LegendKeeper id, or `ALL_PROJECTS`. Required: lists never span projects by accident. */
  readonly project: ProjectScope;
  readonly state?: ProposalState | readonly ProposalState[];
  readonly principalId?: string;
  readonly profile?: string;
  readonly before?: number;
  readonly limit?: number;
}
