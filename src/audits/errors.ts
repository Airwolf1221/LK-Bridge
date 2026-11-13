/** A refusal of the audits, with a code and details (the dashboard shows the message; the tool shows both). */
export class AuditError extends Error {
  override readonly name = 'AuditError';
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
