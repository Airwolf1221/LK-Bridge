/**
 * The dashboard's HTTP side (chunk 5): the admin JSON API at `/api/admin`, the live stream, and the static app at `/ui`.
 * Register it with a plain `app.register` after the auth plugin (it needs the same services). See docs/dashboard.md.
 */
import { registerPacks } from './routes/packs.js';
import { registerReview } from './routes/review.js';
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
import { registerAudits } from './routes/audits.js';
import { registerToolCalls } from './routes/toolcalls.js';
import { registerEvaluation } from './routes/evaluation.js';
import { registerChronology } from './routes/chronology.js';
import { registerSnapshots } from './routes/snapshots.js';
import { registerOffsite } from './routes/offsite.js';
import { CALLBACK_PATH, OffsiteError } from '../offsite/service.js';
import type { RouteContext } from './routes/util.js';
import { StreamHub } from './stream.js';
import { registerPublicPages } from '../public/pages.js';
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
      registerOffsite(api, ctx); // v2 E1b
      registerAudits(api, ctx); // v2 E2
      registerToolCalls(api, ctx); // v2 E3
      registerEvaluation(api, ctx); // v2 E3: the Evaluation helper
      registerPacks(api, ctx);
      registerReview(api, ctx); // v3 F3a: setting packs

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

  /**
   * v2 E1b (ADR 0043): Google's answer to "Connect Google Drive". A top-level navigation from Google, so it carries the
   * session cookie (SameSite=Lax) but is cross-site: it lives outside /api/admin. The service refuses an answer without
   * an owner session, or whose `state` is not a pending sign-in of this session (or has expired). Nothing here echoes the
   * code; the browser is sent straight on to the Off-site copy page, with no referrer.
   */
  app.get(CALLBACK_PATH, async (req, reply) => {
    reply
      .header('cache-control', 'no-store')
      .header('pragma', 'no-cache')
      .header('referrer-policy', 'no-referrer')
      .header('x-content-type-options', 'nosniff');
    const q = (req.query ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' && v.length <= 2048 ? v : undefined);
    const token = req.cookies[deps.services.owner.sessionCookie];
    const session = token ? deps.services.owner.getSession(token) : undefined;
    const offsite = deps.runtime.offsite;
    let target = '/ui/offsite?drive=connected';
    if (!offsite) target = '/ui/offsite?drive_error=OFFSITE_UNAVAILABLE';
    else {
      try {
        const account = await offsite.completeConnect({
          sessionHash: session && token ? deps.services.sessionHash(token) : null,
          state: str(q.state),
          code: str(q.code),
          error: str(q.error),
        });
        deps.runtime.policy.store.audit('owner', 'offsite.connected', 'google', undefined, {
          account: account.email,
        });
      } catch (e) {
        const code = e instanceof OffsiteError ? e.code : 'OFFSITE_GOOGLE_REFUSED';
        if (!(e instanceof OffsiteError)) app.log.error({ err: e }, 'the Google Drive callback failed');
        deps.runtime.policy.store.audit('owner', 'offsite.connect_refused', 'google', undefined, { code });
        target = `/ui/offsite?drive_error=${encodeURIComponent(code)}`;
      }
    }
    return reply.code(303).header('location', target).send();
  });

  registerUi(app, deps.services, deps.uiDir);
  registerPublicPages(app, deps.runtime.policy.store.db);
}
