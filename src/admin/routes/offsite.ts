/**
 * The Off-site copy page's API (v2 E1b, ADR 0043; docs/dashboard.md › Off-site copy), behind the owner session, Origin and
 * CSRF like every admin route. Saving the Google client, connecting, disconnecting, setting the encryption keys, deleting
 * an old Drive folder and adopting a folder all need a re-authentication within the last 5 minutes (`requireReauth`).
 *
 * - `GET /offsite`: everything the page shows (never a secret: the client ID, the secret's last four characters, the
 *   account, whether keys are set and when).
 * - `PUT /offsite/client`, `POST /offsite/connect`, `POST /offsite/disconnect`, `POST /offsite/check`.
 * - `POST /offsite/keys/generate` (shown once), `POST /offsite/keys/confirm`, `PUT /offsite/keys` (the owner's own).
 * - `PUT /offsite/settings`, `POST /offsite/copy`, `POST /offsite/verify`, `POST /offsite/folders/:generation/delete`,
 *   `POST /offsite/adopt`.
 *
 * Google's answer comes back to `GET /admin/drive/callback` (registered in plugin.ts, outside `/api/admin`: Google's
 * redirect is a cross-site navigation, which the admin API refuses by design).
 *
 * Every change is audited (`offsite.*`), never with a value.
 */
import * as z from 'zod';
import { OffsiteError, type OffsiteService } from '../../offsite/service.js';
import { requireReauth } from '../guard.js';
import { AdminHttpError } from '../http.js';
import { confirmBody, parseInput, type Register } from './util.js';

function refusal(e: unknown): never {
  if (e instanceof OffsiteError) throw new AdminHttpError(e.status, e.code, e.message);
  throw e;
}

export const registerOffsite: Register = (api, ctx) => {
  const rt = ctx.deps.runtime;
  const { sessionHash } = ctx.deps.services;
  const svc = (): OffsiteService => {
    if (!rt.offsite)
      throw new AdminHttpError(
        503,
        'OFFSITE_UNAVAILABLE',
        'The off-site copy is not running in this bridge.',
      );
    return rt.offsite;
  };
  const audit = (action: string, target: string | null, after?: unknown) =>
    rt.policy.store.audit('owner', action, target, undefined, after);
  const guarded = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      refusal(e);
    }
  };

  api.get('/offsite', async () => svc().status());

  api.put('/offsite/client', async (req) => {
    requireReauth(ctx.deps.services, req);
    const b = parseInput(
      z.object({ clientId: z.string().min(1).max(300), clientSecret: z.string().min(1).max(300) }),
      req.body,
    );
    const r = await guarded(() => svc().saveClient(b.clientId, b.clientSecret));
    audit('offsite.client_saved', 'google', {
      secretHint: b.clientSecret.trim().slice(-4),
      disconnected: r.disconnected,
    });
    return { ok: true, ...r };
  });

  api.post('/offsite/connect', (req) => {
    const token = requireReauth(ctx.deps.services, req);
    const r = guardedSync(() => svc().beginConnect(sessionHash(token)));
    audit('offsite.connect_started', 'google');
    return r;
  });

  api.post('/offsite/disconnect', async (req) => {
    requireReauth(ctx.deps.services, req);
    parseInput(confirmBody, req.body);
    const r = await guarded(() => svc().disconnect());
    audit('offsite.disconnected', 'google', { revokedAtGoogle: r.revoked });
    return r;
  });

  api.post('/offsite/check', async () => {
    const r = await guarded(() => svc().checkConnection());
    if (!r.ok) audit('offsite.connection_broken', 'google', { message: r.message });
    return r;
  });

  api.post('/offsite/keys/generate', (req) => {
    const token = requireReauth(ctx.deps.services, req);
    return guardedSync(() => svc().generateKeys(sessionHash(token)));
  });

  api.post('/offsite/keys/confirm', (req) => {
    const token = requireReauth(ctx.deps.services, req);
    const b = parseInput(
      z.object({
        confirmId: z.string().regex(/^[0-9a-f]{32}$/),
        passwordEnd: z.string().max(64),
        saltEnd: z.string().max(64),
        acknowledgeNewFolder: z.boolean().optional(),
      }),
      req.body,
    );
    const r = guardedSync(() => svc().confirmGeneratedKeys(sessionHash(token), b));
    audit('offsite.keys_set', 'keys', { source: 'generated', newFolder: r.newFolder?.path ?? null });
    return { ok: true, ...r };
  });

  api.put('/offsite/keys', (req) => {
    requireReauth(ctx.deps.services, req);
    const b = parseInput(
      z.object({
        password: z.string().min(1).max(1024),
        salt: z.string().min(1).max(1024),
        acknowledgeNewFolder: z.boolean().optional(),
      }),
      req.body,
    );
    const r = guardedSync(() => svc().setOwnKeys(b));
    audit('offsite.keys_set', 'keys', { source: 'entered', newFolder: r.newFolder?.path ?? null });
    return { ok: true, ...r };
  });

  api.put('/offsite/settings', (req) => {
    const b = parseInput(
      z.object({
        settings: z.record(z.string(), z.unknown()),
        acknowledgeNewFolder: z.boolean().optional(),
      }),
      req.body,
    );
    // v2 E4 (RV1-4; ADR 0046 decision 3): a change that weakens a protection of the copy needs the owner's
    // re-authentication, as the canon rules and lifecycle settings do (ADR 0036 decision 4): the monthly verify switched
    // off, fewer verified objects, the stale-copy warning later, removed pieces kept on Drive for fewer days, or another
    // folder (a new copy from nothing). Times, bandwidth and transfers stay one click.
    if (weakens(svc().settings().settings as unknown as Record<string, unknown>, b.settings))
      requireReauth(ctx.deps.services, req);
    const r = guardedSync(() => svc().updateSettings(b.settings, b.acknowledgeNewFolder === true));
    audit('offsite.settings', 'settings', { ...r.settings, newFolder: r.newFolder?.path ?? null });
    return r;
  });

  api.post('/offsite/copy', async (req) => {
    parseInput(confirmBody, req.body);
    const name = await guarded(() => svc().request('copy'));
    audit('offsite.copy_requested', name);
    return { ok: true, requested: name };
  });

  api.post('/offsite/verify', async (req) => {
    parseInput(confirmBody, req.body);
    const name = await guarded(() => svc().request('verify'));
    audit('offsite.verify_requested', name);
    return { ok: true, requested: name };
  });

  api.post('/offsite/folders/:generation/delete', async (req) => {
    requireReauth(ctx.deps.services, req);
    const { generation } = parseInput(z.object({ generation: z.coerce.number().int().min(1) }), req.params);
    parseInput(confirmBody, req.body);
    await guarded(() => svc().deleteFolder(generation));
    audit('offsite.folder_delete_requested', String(generation));
    return { ok: true };
  });

  api.post('/offsite/adopt', (req) => {
    requireReauth(ctx.deps.services, req);
    parseInput(confirmBody, req.body);
    const f = guardedSync(() => svc().adoptFolder());
    audit('offsite.folder_adopted', f.path);
    return { ok: true, folder: f };
  });
};

/** v2 E4 (RV1-4): whether a settings change weakens a protection of the off-site copy (see the route). */
export function weakens(
  now: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
): boolean {
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  const has = (k: string) => Object.prototype.hasOwnProperty.call(next, k);
  if (has('verifyEnabled') && next.verifyEnabled !== true && now.verifyEnabled !== false) return true;
  for (const k of ['verifySamplePercent', 'verifySampleMin', 'deletedRetentionDays'] as const)
    if (has(k) && (num(next[k]) === null || num(next[k])! < (num(now[k]) ?? 0))) return true;
  if (
    has('staleAfterDays') &&
    (num(next.staleAfterDays) === null || num(next.staleAfterDays)! > (num(now.staleAfterDays) ?? 0))
  )
    return true;
  if (has('folder') && next.folder !== now.folder) return true;
  return false;
}

function guardedSync<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    refusal(e);
  }
}
