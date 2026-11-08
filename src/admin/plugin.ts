/**
 * The dashboard's HTTP side (chunk 5): the admin JSON API at `/api/admin`, the live stream, and the static app at `/ui`.
 * Register it with a plain `app.register` after the auth plugin (it needs the same services). See docs/dashboard.md.
 */
import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { createAdminActions } from './actions.js';
import { adminGuard, sessionTokenOf } from './guard.js';
import { createHealthCheck } from './health.js';
import { describeError } from './http.js';
import { registerBudgets } from './routes/budgets.js';
import { registerJobs } from './routes/jobs.js';
import { registerMaintenance } from './routes/maintenance.js';
import { registerMappings } from './routes/mappings.js';
import { registerOverview } from './routes/overview.js';
import { registerPolicy } from './routes/policy.js';
import { registerSettings } from './routes/settings.js';
import type { RouteContext } from './routes/util.js';
import { StreamHub } from './stream.js';
import { registerUi } from './ui.js';
import type { AdminDeps } from './types.js';

export async function adminPlugin(app: FastifyInstance, deps: AdminDeps): Promise<void> {
  const { engine, lk } = deps.runtime;
  const now = deps.now ?? Date.now;
  if (!app.hasDecorator('parseCookie')) await app.register(fastifyCookie);

  const hub = new StreamHub(engine, lk, deps.settings, now);
  const actions = createAdminActions(deps);
  const ctx: RouteContext = {
    deps,
    actions,
    hub,
    now,
    health: createHealthCheck(engine, now),
  };
  // Open streams would keep `app.close()` waiting: end them first.
  app.addHook('preClose', () => {
    hub.close();
  });

  await app.register(
    (api, _opts, done) => {
      api.addHook('onRequest', adminGuard(deps.services));
      api.setErrorHandler((err, _req, reply) => {
        const { status, body } = describeError(err);
        if (status >= 500) api.log.error({ err }, 'admin request failed');
        return reply.code(status).type('application/json; charset=utf-8').send(body);
      });
      api.setNotFoundHandler((_req, reply) =>
        reply
          .code(404)
          .type('application/json; charset=utf-8')
          .send({ error: { code: 'NOT_FOUND', message: 'No such admin endpoint.' } }),
      );

      registerOverview(api, ctx);
      registerJobs(api, ctx);
      registerBudgets(api, ctx);
      registerPolicy(api, ctx);
      registerSettings(api, ctx);
      registerMaintenance(api, ctx); // chunk 6
      registerMappings(api, ctx); // chunk 6

      /** The one live stream (docs/dashboard.md › Stream). */
      api.get('/stream', (req, reply) => {
        const token = sessionTokenOf(req);
        const raw = reply.raw;
        reply.hijack();
        raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no', // tell Caddy/nginx not to buffer
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        });
        req.raw.socket.setNoDelay(true);
        req.raw.socket.setKeepAlive(true);
        const header = req.headers['last-event-id'];
        const client = {
          write: (frame: string) => {
            if (raw.destroyed || raw.writableEnded) return false;
            raw.write(frame);
            return raw.writableLength < 2 * 1024 * 1024; // a client this far behind is dropped
          },
          end: () => {
            if (!raw.writableEnded) raw.end();
          },
          alive: () => deps.services.owner.getSession(token) !== undefined,
        };
        req.raw.on('close', () => hub.detach(client));
        hub.attach(client, Array.isArray(header) ? header[0] : header);
      });
      done();
    },
    { prefix: '/api/admin' },
  );

  // Browsers ask for /favicon.ico on the sign-in page too (which has no icon). Answer quietly instead of a 404.
  app.get('/favicon.ico', (_req, reply) =>
    reply.code(204).header('cache-control', 'public, max-age=86400').send(),
  );

  registerUi(app, deps.services, deps.uiDir);
}
