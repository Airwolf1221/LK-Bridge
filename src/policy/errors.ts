/** Errors of the owner command layer and the proposal workflow. `code` is stable; `message` is for people. */
export type PolicyErrorCode =
  | 'NOT_OWNER'
  | 'INVALID_INPUT'
  | 'PROFILE_EXISTS'
  | 'PROFILE_NOT_FOUND'
  | 'CONNECTION_NOT_FOUND'
  | 'PROPOSAL_NOT_FOUND'
  | 'INVALID_TRANSITION'
  | 'PROPOSAL_EXPIRED'
  | 'BRIDGE_READ_ONLY'
  | 'WRITES_PAUSED'
  | 'DRAINING'
  | 'NO_ENGINE'
  | 'CAPTURE_FAILED'
  | 'REREAD_FAILED'
  | 'PROJECT_UNAVAILABLE';

export class PolicyError extends Error {
  override readonly name = 'PolicyError';
  constructor(
    readonly code: PolicyErrorCode,
    message: string,
  ) {
    super(message);
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message };
  }
}
