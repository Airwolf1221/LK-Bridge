/**
 * The Packs page (v3 F3a, ADR 0050; docs/dashboard.md › Packs): each setting pack's rules (read-only in F3a), its
 * governance sources with the versions the owner approved, its attachments (projects, served, template ids) and its
 * versions. Two changes, each with a fresh re-authentication and audited by the pack service: **approve this pack version**
 * (the current rules, with each governance source's document version read now and recorded), and the **token maps**
 * (race and culture → tag token), which make a new version that waits for approval.
 *
 * - `GET /packs`: every pack, as stored (no LegendKeeper request).
 * - `GET /packs/:id/governance`: the governance sources read now (one read each), with drift recorded.
 * - `POST /packs/:id/approve` `{ confirm: true }` (re-authenticated).
 * - `PUT /packs/:id/tokens` `{ race?, culture?, confirm: true }` (re-authenticated).
 */
import * as z from 'zod';
import { PackError } from '../../packs/types.js';
import type { Packs } from '../../packs/service.js';
import { requireReauth } from '../guard.js';
import { AdminHttpError } from '../http.js';
import { parseInput, type Register } from './util.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const tokenMap = z.record(z.string().max(200), z.string().max(100));
const tokensBody = z
  .object({ race: tokenMap.optional(), culture: tokenMap.optional(), confirm: z.literal(true) })
  .strict();

const STATUS: Readonly<Record<string, number>> = {
  PACK_NOT_FOUND: 404,
  NOT_OWNER: 403,
  INVALID_TOKEN: 400,
  GOVERNANCE_UNREADABLE: 409,
};

function packs(ctx: Parameters<Register>[1]): Packs {
  const p = ctx.deps.runtime.packs;
  if (!p) throw new AdminHttpError(503, 'PACKS_UNAVAILABLE', 'Setting packs are not available in this bridge.');
  return p;
}

async function guarded<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PackError) throw new AdminHttpError(STATUS[e.code] ?? 400, e.code, e.message, { ...e.details });
    throw e;
  }
}

export const registerPacks: Register = (api, ctx) => {
  api.get('/packs', () => {
    const p = packs(ctx);
    return {
      packs: p.list().map((v) => ({ ...v, versions: p.store.versions(v.id).slice(0, 20) })),
    };
  });

  api.get('/packs/:id/governance', async (req) => {
    const { id } = parseInput(idParam, req.params);
    return guarded(async () => ({ governance: await packs(ctx).governance(id) }));
  });

  api.post('/packs/:id/approve', async (req) => {
    requireReauth(ctx.deps.services, req);
    const { id } = parseInput(idParam, req.params);
    parseInput(z.object({ confirm: z.literal(true) }).strict(), req.body);
    return guarded(async () => {
      const r = await packs(ctx).commands.approve('owner', id);
      return { pack: packs(ctx).view(id), governance: r.governance };
    });
  });

  api.put('/packs/:id/tokens', async (req) => {
    requireReauth(ctx.deps.services, req);
    const { id } = parseInput(idParam, req.params);
    const b = parseInput(tokensBody, req.body);
    return guarded(() => {
      packs(ctx).commands.setTokens('owner', id, {
        ...(b.race !== undefined ? { race: b.race } : {}),
        ...(b.culture !== undefined ? { culture: b.culture } : {}),
      });
      return { pack: packs(ctx).view(id) };
    });
  });
};
