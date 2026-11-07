/** Shared types of the policy layer (docs/policy.md). */
import type { Principal } from '../jobs/types.js';

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
}

export interface ProposalConflict {
  readonly index: number;
  readonly op: string;
  readonly reason: string;
  readonly capturedVersion: string | null;
  readonly currentVersion: string | null;
}

export interface ProposalFilter {
  readonly state?: ProposalState | readonly ProposalState[];
  readonly principalId?: string;
  readonly profile?: string;
  readonly before?: number;
  readonly limit?: number;
}
