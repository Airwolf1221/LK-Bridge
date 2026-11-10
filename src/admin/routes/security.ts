/**
 * The owner's account (OPS2, docs/auth.md › Managing the owner account from the dashboard): the password, the
 * authenticator app and its recovery codes, the encrypted store's state, and re-authentication.
 *
 * Every change here needs a re-authentication within the last 5 minutes (`requireReauth`), on top of the session,
 * Origin and CSRF checks every admin request passes. Only two responses ever carry a secret, each once and marked
 * `shownOnce`: the authenticator secret when an enrolment starts, and recovery codes when they are made.
 */
import * as z from 'zod';
import { clientIp } from '../../auth/http.js';
import { otpauthUri } from '../../auth/totp.js';
import { requireReauth, sessionTokenOf } from '../guard.js';
import { parseInput, type Register } from './util.js';

const confirm = z.object({ confirm: z.literal(true) });

export const registerSecurity: Register = (api, ctx) => {
  const { deps, actions } = ctx;
  const { owner, credentials, config, sessionHash } = deps.services;
  const { projects, secrets } = deps.runtime;

  api.get('/security', (req) => {
    const token = sessionTokenOf(req);
    const session = owner.getSession(token);
    const until = session ? owner.reauthUntil(session) : null;
    const pw = credentials.password();
    const totp = credentials.totp();
    const store = secrets.state();
    const keyConflicts = projects
      .list()
      .filter((p) => p.keyConflict !== null)
      .map((p) => ({ project: p.name, message: p.keyConflict }));
    return {
      username: config.owner.username,
      password: { source: pw.ok ? pw.source : null, problem: pw.ok ? null : pw.reason },
      totp: {
        enabled: totp.state !== 'off',
        source: totp.state === 'on' ? totp.source : null,
        problem: totp.state === 'unreadable' ? totp.reason : null,
        recoveryCodesLeft: totp.state === 'off' ? 0 : credentials.recoveryCodesLeft(),
        enrolmentPending: credentials.pendingTotp(sessionHash(token)) !== undefined,
      },
      reauth: { until: until === null ? null : until * 1000, windowSeconds: 300 },
      store: {
        available: store.available,
        problem: store.problem,
        keyId: store.keyId,
        stored: store.stored,
        unreadable: store.unreadable.length,
        underPrevious: store.underPrevious,
      },
      canManageKeys: projects.canManageKeys,
      warnings: [...credentials.warnings(), ...projects.notes],
      keyConflicts,
    };
  });

  api.post('/security/reauth', async (req) => {
    const b = parseInput(
      z.object({ password: z.string().min(1).max(1024), totp: z.string().max(64).optional() }),
      req.body,
    );
    return actions.reauthenticate(
      sessionTokenOf(req),
      { password: b.password, ...(b.totp !== undefined ? { totp: b.totp } : {}) },
      clientIp(req),
    );
  });

  api.post('/security/password', async (req) => {
    const token = requireReauth(deps.services, req);
    const b = parseInput(
      z.object({
        currentPassword: z.string().min(1).max(1024),
        newPassword: z.string().min(1).max(4096),
      }),
      req.body,
    );
    return actions.changePassword(token, b, clientIp(req));
  });

  api.post('/security/totp/enrol', (req) => {
    const token = requireReauth(deps.services, req);
    const r = actions.beginTotp(sessionHash(token));
    return {
      secret: r.secret,
      otpauthUri: otpauthUri(r.secret, r.account, r.issuer),
      shownOnce: true,
    };
  });

  api.post('/security/totp/confirm', (req) => {
    const token = requireReauth(deps.services, req);
    const b = parseInput(z.object({ code: z.string().min(6).max(12) }), req.body);
    return { ...actions.confirmTotp(sessionHash(token), b.code), shownOnce: true };
  });

  api.post('/security/totp/remove', (req) => {
    requireReauth(deps.services, req);
    parseInput(confirm, req.body);
    actions.removeTotp();
    return { ok: true };
  });

  api.post('/security/recovery-codes', (req) => {
    requireReauth(deps.services, req);
    parseInput(confirm, req.body);
    return { ...actions.regenerateRecoveryCodes(), shownOnce: true };
  });
};
