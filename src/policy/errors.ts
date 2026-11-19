/** Errors of the owner command layer and the proposal workflow. `code` is stable; `message` is for people. */
export type PolicyErrorCode =
  | 'NOT_OWNER'
  | 'INVALID_INPUT'
  | 'PROFILE_EXISTS'
  | 'PROFILE_NOT_FOUND'
  | 'CONNECTION_NOT_FOUND'
  | 'CONNECTION_ACTIVE'
  | 'PROPOSAL_NOT_FOUND'
  | 'INVALID_TRANSITION'
  | 'PROPOSAL_EXPIRED'
  | 'BRIDGE_READ_ONLY'
  | 'WRITES_PAUSED'
  | 'DRAINING'
  | 'NO_ENGINE'
  | 'CAPTURE_FAILED'
  | 'REREAD_FAILED'
  | 'PROJECT_UNAVAILABLE'
  | 'CANONICAL_APPROVAL_REQUIRED'
  | 'NOT_CANONICAL'
  // v3 F3d (ADR 0058): selective approval and "propose these again".
  | 'NOT_ITEMIZED'
  | 'UNKNOWN_ITEMS'
  | 'SELECTION_NOT_CLOSED'
  | 'NOTHING_SELECTED'
  | 'NOTHING_LEFT_OUT'
  | 'ALREADY_REPROPOSED'
  /** CR-2026-11-R3 (R3-15, R3-16). */
  | 'REPROPOSE_REFUSED'
  | 'REPROPOSE_RUNNING'
  | 'REPROPOSE_FAILED'
  | 'APPROVAL_HOOK_REFUSED';

export class PolicyError extends Error {
  override readonly name = 'PolicyError';
  constructor(
    readonly code: PolicyErrorCode,
    message: string,
    /** v3 F3d: more for the dashboard (the items a selection would also drop). */
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, ...this.details };
  }
}
