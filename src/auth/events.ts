import type { FastifyBaseLogger } from 'fastify';

/**
 * Structured auth audit events (requirement 16). Callers pass identifiers only (client ids,
 * grant ids, token ids, IP addresses): never tokens, codes, secrets, passwords or TOTP codes.
 */
export type AuthEventName =
  | 'client.registered'
  | 'client.registration_rejected'
  | 'client.metadata_fetched'
  | 'client.metadata_rejected'
  | 'client.grant_types_ignored'
  | 'client.jwks_fetched'
  | 'client.assertion_accepted'
  | 'client.assertion_rejected'
  | 'authorize.rejected'
  | 'consent.shown'
  | 'consent.granted'
  | 'consent.scope_change_confirm'
  | 'consent.denied'
  | 'token.issued'
  | 'token.refreshed'
  | 'token.refresh_replayed'
  | 'token.revoked'
  | 'token.rejected'
  | 'token.reuse_detected'
  | 'login.succeeded'
  | 'login.failed'
  | 'login.rate_limited'
  | 'login.unavailable'
  | 'logout'
  | 'logout.everywhere'
  | 'reauth.succeeded'
  | 'reauth.failed'
  | 'reauth.rate_limited'
  | 'recovery_code.used'
  | 'password.changed'
  | 'totp.enabled'
  | 'totp.removed'
  | 'recovery_codes.regenerated'
  | 'secrets.imported'
  | 'pat.created'
  | 'pat.revoked'
  | 'mcp.rejected';

export type AuthEventFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

export type AuthEventLogger = (
  event: AuthEventName,
  fields?: AuthEventFields,
  level?: 'info' | 'warn',
) => void;

export function createAuthEventLogger(log: FastifyBaseLogger): AuthEventLogger {
  const child = log.child({ component: 'auth' });
  return (event, fields = {}, level = 'info') => {
    child[level]({ event, ...fields }, `auth ${event}`);
  };
}
