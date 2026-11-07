import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { registerFormParser } from './form.js';
import { registerAuthorizeRoutes } from './routes/authorize.js';
import { registerLoginRoutes } from './routes/login.js';
import { registerMetadataRoutes } from './routes/metadata.js';
import { registerOAuthRoutes } from './routes/oauth.js';
import type { AuthServices } from './services.js';

export interface AuthPluginOptions {
  readonly services: AuthServices;
  /** How often to delete expired auth rows. 0 disables (tests). Default 10 minutes. */
  readonly pruneIntervalMs?: number;
}

/**
 * Fastify plugin for the authorization server: discovery metadata, registration, authorize and
 * consent, token, revocation, and owner login. Register it encapsulated (plain `app.register`):
 * its body parsers apply only to these routes.
 */
export async function authPlugin(app: FastifyInstance, opts: AuthPluginOptions): Promise<void> {
  const s = opts.services;
  if (!app.hasDecorator('parseCookie')) await app.register(fastifyCookie);
  registerFormParser(app);
  // Any other media type reaches the route with no body, so it can answer with a proper OAuth
  // error (for example invalid_request on the token endpoint) instead of a bare 415.
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 16 * 1024 }, (_req, _body, done) => {
    done(null, undefined);
  });

  registerMetadataRoutes(app, s.config);
  registerOAuthRoutes(app, s);
  registerAuthorizeRoutes(app, s);
  registerLoginRoutes(app, s);

  const interval = opts.pruneIntervalMs ?? 10 * 60_000;
  if (interval > 0) {
    const timer = setInterval(() => {
      try {
        s.prune();
      } catch (err) {
        app.log.error({ err }, 'auth prune failed');
      }
    }, interval);
    timer.unref();
    app.addHook('onClose', () => clearInterval(timer));
  }
}
