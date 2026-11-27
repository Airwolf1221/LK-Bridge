/**
 * The Packs page (v3 F3a, ADR 0050; docs/dashboard.md › Packs): each setting pack's rules (read-only in F3a), its
 * governance sources with the versions the owner approved, its attachments (projects, served, template ids) and its
 * versions. Two changes, each audited by the pack service (ADR 0081: no fresh code): **approve this pack version**
 * (the current rules, with each governance source's document version read now and recorded), and the **token maps**
 * (race and culture → tag token), which make a new version that waits for approval.
 *
 * - `GET /packs`: every pack, as stored (no LegendKeeper request).
 * - `GET /packs/:id/governance`: the governance sources read now (one read each), with drift recorded.
 * - `POST /packs/:id/approve` `{ confirm: true }`.
 * - `PUT /packs/:id/tokens` `{ race?, culture?, excludedRoutineTags?, confirm: true }` (v3 F3f adds
 *   the Tagging Standard's Excluded Routine Tags).
 * - `POST /packs/:id/sections` `{ source, from, to, confirm: true }` (ADR 0052 amendment): re-maps a
 *   pinned heading of a governance source to one of the document's actual headings. A new version, waiting for approval.
 */
import * as z from 'zod';
import { PackError } from '../../packs/types.js';
import type { Packs } from '../../packs/service.js';
import { AdminHttpError } from '../http.js';
import { parseInput, type Register } from './util.js';

const idParam = z.object({ id: z.string().min(1).max(64) });
const tokenMap = z.record(z.string().max(200), z.string().max(100));
const tokensBody = z
  .object({
    race: tokenMap.optional(),
    culture: tokenMap.optional(),
    // v3 F3f (ADR 0060): the Tagging Standard's Excluded Routine Tags.
    excludedRoutineTags: z.array(z.string().max(100)).max(100).optional(),
    confirm: z.literal(true),
  })
  .strict();

const remapBody = z
  .object({
    source: z.string().min(1).max(40),
    from: z.string().min(1).max(200),
    to: z.string().trim().min(1).max(200),
    confirm: z.literal(true),
  })
  .strict();

const STATUS: Readonly<Record<string, number>> = {
  UNKNOWN_TOOL: 400,
  PACK_NOT_FOUND: 404,
  NOT_OWNER: 403,
  INVALID_TOKEN: 400,
  GOVERNANCE_UNREADABLE: 409,
  GOVERNANCE_SECTION_MISSING: 409,
  // CR-2026-11-R2 (R2-33): a pinned heading the page has more than once.
  GOVERNANCE_SECTION_AMBIGUOUS: 409,
  SOURCE_NOT_FOUND: 404,
  SECTION_NOT_PINNED: 409,
  SECTION_ALREADY_PINNED: 409,
  HEADING_NOT_FOUND: 409,
  HEADING_AMBIGUOUS: 409,
};

function packs(ctx: Parameters<Register>[1]): Packs {
  const p = ctx.deps.runtime.packs;
  if (!p)
    throw new AdminHttpError(503, 'PACKS_UNAVAILABLE', 'Setting packs are not available in this bridge.');
  return p;
}

async function guarded<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PackError)
      throw new AdminHttpError(STATUS[e.code] ?? 400, e.code, e.message, { ...e.details });
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
    const { id } = parseInput(idParam, req.params);
    parseInput(z.object({ confirm: z.literal(true) }).strict(), req.body);
    return guarded(async () => {
      const r = await packs(ctx).commands.approve('owner', id);
      return { pack: packs(ctx).view(id), governance: r.governance };
    });
  });

  api.post('/packs/:id/sections', async (req) => {
    const { id } = parseInput(idParam, req.params);
    const b = parseInput(remapBody, req.body);
    return guarded(async () => {
      const r = await packs(ctx).commands.remapSection('owner', id, {
        source: b.source,
        from: b.from,
        to: b.to,
      });
      return { pack: packs(ctx).view(id), governance: r.governance };
    });
  });

  api.put('/packs/:id/tokens', async (req) => {
    const { id } = parseInput(idParam, req.params);
    const b = parseInput(tokensBody, req.body);
    return guarded(() => {
      packs(ctx).commands.setTokens('owner', id, {
        ...(b.race !== undefined ? { race: b.race } : {}),
        ...(b.culture !== undefined ? { culture: b.culture } : {}),
        ...(b.excludedRoutineTags !== undefined ? { excludedRoutineTags: b.excludedRoutineTags } : {}),
      });
      return { pack: packs(ctx).view(id) };
    });
  });
};
