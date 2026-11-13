/**
 * A mock of Google's OAuth 2.0 and the one Drive call the bridge makes (v2 E1b tests). Nothing reaches Google.
 *
 * - `/authorize` is never fetched by the bridge (the browser goes there); `approve(url)` plays the owner allowing access
 *   and returns the code Google would put in the callback, bound to that URL's client, redirect URI, PKCE challenge and
 *   scope.
 * - `/token`: `authorization_code` (checks the client, the code, the redirect URI and the PKCE verifier; a code works
 *   once) and `refresh_token` (refuses a revoked or `expire()`d token with `invalid_grant`, as Google does for an app in
 *   Testing after 7 days).
 * - `/revoke`: revokes a refresh token (and its access tokens) or an access token.
 * - `/drive/v3/about?fields=user`: answers only a live access token whose grant includes `drive.file`.
 */
import { createHash, randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { GoogleEndpoints } from '../../src/offsite/google.js';

export const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
export const CLIENT_ID = 'test-client-1234567890.apps.googleusercontent.com';
export const CLIENT_SECRET = 'GOCSPX-TESTSECRETabcdef0123456789';

interface Code {
  clientId: string;
  redirectUri: string;
  challenge: string;
  scope: string;
  used: boolean;
}

export class MockGoogle {
  private app: FastifyInstance | null = null;
  base = '';
  readonly clients = new Map<string, string>([[CLIENT_ID, CLIENT_SECRET]]);
  readonly codes = new Map<string, Code>();
  /** refresh token → its grant. */
  readonly grants = new Map<string, { clientId: string; scope: string; revoked: boolean }>();
  /** access token → refresh token it came from (or null) and scope. */
  readonly access = new Map<string, { refresh: string | null; scope: string; revoked: boolean }>();
  readonly requests: { path: string; grantType?: string }[] = [];
  readonly revoked: string[] = [];
  account = { emailAddress: 'owner@example.test', displayName: 'Test Owner' };
  /** Issue a new refresh token on each refresh (Google rarely does). */
  rotateOnRefresh = false;
  /** Make the revoke endpoint fail (the network, say). */
  revokeFails = false;

  get endpoints(): GoogleEndpoints {
    return {
      authorize: `${this.base}/authorize`,
      token: `${this.base}/token`,
      revoke: `${this.base}/revoke`,
      drive: `${this.base}/drive/v3`,
    };
  }

  async start(): Promise<string> {
    const app = Fastify({ logger: false });
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_r, body, done) =>
      done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );
    app.post('/token', async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, string>;
      this.requests.push({ path: '/token', grantType: b.grant_type ?? '' });
      if (this.clients.get(b.client_id ?? '') !== b.client_secret) {
        return reply
          .code(401)
          .send({ error: 'invalid_client', error_description: 'The OAuth client was not found.' });
      }
      if (b.grant_type === 'authorization_code') {
        const c = this.codes.get(b.code ?? '');
        if (!c || c.used || c.clientId !== b.client_id || c.redirectUri !== b.redirect_uri) {
          return reply.code(400).send({ error: 'invalid_grant', error_description: 'Bad Request' });
        }
        const challenge = createHash('sha256')
          .update(b.code_verifier ?? '')
          .digest('base64url');
        if (challenge !== c.challenge) {
          return reply
            .code(400)
            .send({ error: 'invalid_grant', error_description: 'Invalid code verifier.' });
        }
        c.used = true;
        const refresh = `1//mock-refresh-${randomBytes(12).toString('hex')}`;
        this.grants.set(refresh, { clientId: c.clientId, scope: c.scope, revoked: false });
        const access = this.issue(refresh, c.scope);
        return {
          access_token: access,
          expires_in: 3599,
          refresh_token: refresh,
          scope: c.scope,
          token_type: 'Bearer',
        };
      }
      if (b.grant_type === 'refresh_token') {
        const g = this.grants.get(b.refresh_token ?? '');
        if (!g || g.revoked || g.clientId !== b.client_id) {
          return reply
            .code(400)
            .send({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        }
        let refresh = b.refresh_token!;
        if (this.rotateOnRefresh) {
          g.revoked = true;
          refresh = `1//mock-refresh-${randomBytes(12).toString('hex')}`;
          this.grants.set(refresh, { clientId: g.clientId, scope: g.scope, revoked: false });
        }
        const access = this.issue(refresh, g.scope);
        return {
          access_token: access,
          expires_in: 3599,
          scope: g.scope,
          token_type: 'Bearer',
          ...(this.rotateOnRefresh ? { refresh_token: refresh } : {}),
        };
      }
      return reply.code(400).send({ error: 'unsupported_grant_type' });
    });
    app.post('/revoke', async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, string>;
      this.requests.push({ path: '/revoke' });
      if (this.revokeFails) return reply.code(503).send('unavailable');
      const t = b.token ?? '';
      const g = this.grants.get(t);
      if (g) {
        g.revoked = true;
        for (const a of this.access.values()) if (a.refresh === t) a.revoked = true;
      } else if (this.access.has(t)) this.access.get(t)!.revoked = true;
      else return reply.code(400).send({ error: 'invalid_token' });
      this.revoked.push(t);
      return {};
    });
    app.get('/drive/v3/about', async (req, reply) => {
      this.requests.push({ path: '/drive/v3/about' });
      const q = req.query as Record<string, string>;
      if (q.fields !== 'user') return reply.code(400).send({ error: { message: 'fields required' } });
      const auth = req.headers.authorization ?? '';
      const a = this.access.get(auth.replace(/^Bearer /, ''));
      if (!a || a.revoked) return reply.code(401).send({ error: { message: 'Invalid Credentials' } });
      // about.get is allowed with drive.file alone (as with any Drive scope).
      if (!a.scope.split(' ').includes(DRIVE_FILE))
        return reply.code(403).send({ error: { message: 'Insufficient Permission' } });
      return {
        user: {
          kind: 'drive#user',
          displayName: this.account.displayName,
          emailAddress: this.account.emailAddress,
        },
      };
    });
    this.base = await app.listen({ host: '127.0.0.1', port: 0 });
    this.app = app;
    return this.base;
  }

  private issue(refresh: string | null, scope: string): string {
    const t = `ya29.mock-access-${randomBytes(12).toString('hex')}`;
    this.access.set(t, { refresh, scope, revoked: false });
    return t;
  }

  /** The owner allows access at Google: the code the callback receives. */
  approve(
    authorizeUrl: string,
    o: { scope?: string } = {},
  ): { code: string; state: string; redirectUri: string } {
    const u = new URL(authorizeUrl);
    const p = u.searchParams;
    const code = `4/mock-code-${randomBytes(12).toString('hex')}`;
    this.codes.set(code, {
      clientId: p.get('client_id') ?? '',
      redirectUri: p.get('redirect_uri') ?? '',
      challenge: p.get('code_challenge') ?? '',
      scope: o.scope ?? p.get('scope') ?? '',
      used: false,
    });
    return { code, state: p.get('state') ?? '', redirectUri: p.get('redirect_uri') ?? '' };
  }

  /** Every refresh token stops working (an app in Testing after 7 days, or access removed in the Google account). */
  expireAll(): void {
    for (const g of this.grants.values()) g.revoked = true;
  }

  /** A refresh token Google would accept, made directly (for the runner's tests). */
  grant(scope = DRIVE_FILE): string {
    const refresh = `1//mock-refresh-${randomBytes(12).toString('hex')}`;
    this.grants.set(refresh, { clientId: CLIENT_ID, scope, revoked: false });
    return refresh;
  }

  async stop(): Promise<void> {
    await this.app?.close();
  }
}
