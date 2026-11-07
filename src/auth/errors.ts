/** An OAuth 2.x error answered as JSON (RFC 6749 §5.2, RFC 7591 §3.2.2, RFC 8707 §2). */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status: number = 400,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(`${error}: ${description}`);
    this.name = 'OAuthError';
  }

  toJSON(): { error: string; error_description: string } {
    return { error: this.error, error_description: this.description };
  }
}

export const invalidRequest = (d: string) => new OAuthError('invalid_request', d);
export const invalidGrant = (d: string) => new OAuthError('invalid_grant', d);
export const invalidScope = (d: string) => new OAuthError('invalid_scope', d);
export const invalidTarget = (d: string) => new OAuthError('invalid_target', d);
export const unsupportedGrantType = (d: string) => new OAuthError('unsupported_grant_type', d);
export const unauthorizedClient = (d: string) => new OAuthError('unauthorized_client', d);
/** RFC 6749 §5.2: 401, with a Basic challenge when the client tried HTTP Basic. */
export const invalidClient = (d: string, usedBasic = false) =>
  new OAuthError(
    'invalid_client',
    d,
    401,
    usedBasic ? { 'www-authenticate': 'Basic realm="lk-bridge"' } : {},
  );
