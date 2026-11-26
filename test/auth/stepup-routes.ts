/**
 * ADR 0081 (the owner, 26 November 2026: "A code at sign-in is enough"): the explicit list of every route that asks for a
 * fresh authenticator code (`requireReauth`, `403 REAUTH_REQUIRED`), each by method and path. Nothing else asks.
 * test/auth/stepup-inventory.test.ts fails when the routes that ask differ from this list, either way; change it only
 * with the owner's decision.
 *
 * The consent page's own step-up (`src/policy/consent.ts` `consentStepUp`, on `/oauth/authorize`) is not a
 * `REAUTH_REQUIRED` answer and is tested on its own (test/auth/consent-stepup.test.ts).
 */
export const STEP_UP_ROUTES: readonly string[] = [
  // ---- the owner's password, authenticator and recovery codes (the Account page)
  'POST /api/admin/security/password',
  'POST /api/admin/security/totp/enrol',
  'POST /api/admin/security/totp/confirm',
  'POST /api/admin/security/totp/remove',
  'POST /api/admin/security/recovery-codes',
  // ---- connections: made, revoked, moved or their scope changed (a profile's scope and the default scope are its
  // connections' scope), and personal access tokens
  'POST /api/admin/clients/profiles',
  'PUT /api/admin/clients/profiles/:id/scope',
  'PUT /api/admin/clients/default-scope',
  'PUT /api/admin/clients/connections/:id/profile',
  'POST /api/admin/clients/connections/:id/revoke',
  'POST /api/admin/clients/connections/remove-inactive',
  'POST /api/admin/clients/connections/:id/remove',
  'POST /api/admin/clients/connections/revoke-stale',
  'POST /api/admin/clients/pats',
  // ---- a project's LegendKeeper API key: added, replaced or removed (with its project)
  'POST /api/admin/projects/check',
  'POST /api/admin/projects/:name/key/check',
  'POST /api/admin/projects/confirm',
  'POST /api/admin/projects/:name/remove',
  // ---- the off-site copy's credentials: the Google client, the Drive sign-in, the encryption keys
  'PUT /api/admin/offsite/client',
  'POST /api/admin/offsite/connect',
  'POST /api/admin/offsite/disconnect',
  'POST /api/admin/offsite/keys/generate',
  'POST /api/admin/offsite/keys/confirm',
  'PUT /api/admin/offsite/keys',
];

/** A cheap route that asks (a no-op when nothing is inactive), for tests of the step-up itself. */
export const STEP_UP_PROBE = '/api/admin/clients/connections/remove-inactive';
