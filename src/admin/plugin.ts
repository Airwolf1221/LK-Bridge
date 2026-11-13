/**
 * The dashboard's HTTP side (chunk 5): the admin JSON API at `/api/admin`, the live stream, and the static app at `/ui`.
 * Register it with a plain `app.register` after the auth plugin (it needs the same services). See docs/dashboard.md.
 */
import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { createAdminActions } from './actions.js';
import { adminGuard, sessionTokenOf } from './guard.js';
import { createHealthCheck } from './health.js';
import { AdminHttpError, describeError } from './http.js';
import { registerBudgets } from './routes/budgets.js';
import { registerJobs } from './routes/jobs.js';
import { registerMaintenance } from './routes/maintenance.js';
import { registerMappings } from './routes/mappings.js';
import { registerOverview } from './routes/overview.js';
import { registerPolicy } from './routes/policy.js';
import { registerProjects } from './routes/projects.js';
import { registerSecurity } from './routes/security.js';
import { registerSettings } from './routes/settings.js';
import { registerStaging } from './routes/staging.js';
import { registerAssets } from './routes/assets.js';
import { registerTree } from './routes/tree.js';
import { registerRegistry } from './routes/registry.js';
import { registerLifecycle } from './routes/lifecycle.js';
import { registerChronology } from './routes/chronology.js';
import { registerSnapshots } from './routes/snapshots.js';
import type { RouteContext } from './routes/util.js';
import { StreamHub } from './stream.js';
import { registerUi } from './ui.js';
import type { AdminDeps } from './types.js';

export async function adminPlugin(app: FastifyInstance, deps: AdminDeps): Promise<void> {
  const { engine, projects } = deps.runtime;
  const now = deps.now ?? Date.now;
  if (!app.hasDecorator('parseCookie')) await app.register(fastifyCookie);

  const hub = new StreamHub(engine, projects, deps.settings, now);
  const actions = createAdminActions(deps);
  const health = createHealthCheck(engine, now);
  const ctx: RouteContext = {
    deps,
    actions,
    hub,
    now,
    principals: (ids) => Object.fromEntries(deps.runtime.policy.store.describePrincipals(ids)),
    health: (project, refresh) => health(project.id, refresh),
    // v2 A1: the `project` query parameter of every project-scoped route; default: the default project.
    project: (ref) => {
      const p = ref ? projects.find(ref) : projects.defaultProject();
      if (!p) {
        throw new AdminHttpError(
          400,
          'UNKNOWN_PROJECT',
          `No project "${String(ref).slice(0, 64)}". Known: ${projects
            .list()
            .map((x) => x.name)
            .join(', ')}`,
        );
      }
      if (!p.id) {
        throw new AdminHttpError(
          409,
          'PROJECT_UNAVAILABLE',
          `Project "${p.name}" has no data yet: its key has not been verified (${p.reason ?? 'not checked'}).`,
        );
      }
      return { id: p.id, name: p.name };
    },
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
      registerProjects(api, ctx); // v2 A1
      registerTree(api, ctx); // v2 A2
      registerSecurity(api, ctx); // OPS2
      registerRegistry(api, ctx); // v2 A3
      registerLifecycle(api, ctx); // v2 C2c
      registerChronology(api, ctx); // v2 D1
      registerAssets(api, ctx); // v2 A4
      registerStaging(api, ctx); // v2 D3
      registerSnapshots(api, ctx); // v2 E1a

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
