/**
 * v3 F7 (ADR 0070, G3): the outfit record on the dashboard (the Asset Tree page's "Outfits" panel).
 *
 * - `GET /art/outfits`: the characters with outfits, one character's outfits (`folderId`), the recent seedings;
 * - `POST /art/outfits/seed` (audited `art.seed`): reads one character's folders LIVE and lists what G3's rules found,
 *   ambiguous names included, for the owner's review; nothing is recorded yet;
 * - `POST /art/outfits/seed/:id/save` (audited `art.seed_save`) and `…/discard`;
 * - `POST /art/outfits/:id/aliases` and `POST /art/outfits/:id/aliases/remove` (audited `art.alias_add`,
 *   `art.alias_remove`): the owner's aliases.
 *
 * Nothing here writes to LegendKeeper: the seeding only reads (P0, the owner's), and the record is the bridge's own.
 */
import * as z from 'zod';
import { seedOutfits } from '../../art/seed.js';
import { OutfitError } from '../../art/store.js';
import { AdminHttpError } from '../http.js';
import { parseInput, projectFor, projectParam, type Register } from './util.js';

const STATUS: Readonly<Record<string, number>> = {
  OUTFIT_NOT_FOUND: 404,
  SEED_NOT_FOUND: 404,
  FOLDER_NOT_FOUND: 404,
  FOLDER_AMBIGUOUS: 409,
  SEED_DECIDED: 409,
  ALIAS_TAKEN: 409,
  ALIAS_IS_NAME: 409,
  INVALID_ALIAS: 400,
  INVALID_INPUT: 400,
  LIVE_READ_FAILED: 502,
};

export const registerArt: Register = (api, ctx) => {
  const rt = ctx.deps.runtime;
  const store = () => {
    if (!rt.outfits)
      throw new AdminHttpError(503, 'OUTFITS_UNAVAILABLE', 'The outfit record is not running.');
    return rt.outfits;
  };
  const wrap = async <T>(f: () => T | Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      if (e instanceof OutfitError) throw new AdminHttpError(STATUS[e.code] ?? 400, e.code, e.message);
      throw e;
    }
  };
  const audit = (action: string, target: string, after: unknown) =>
    rt.policy.store.audit('owner', action, target, undefined, after);

  api.get('/art/outfits', (req) => {
    const q = parseInput(
      z.object({ project: projectParam, folderId: z.string().min(1).max(200).optional() }),
      req.query,
    );
    const p = ctx.project(q.project);
    const s = store();
    return {
      project: p,
      characters: s.characters(p.id),
      ...(q.folderId ? { folderId: q.folderId, outfits: s.forCharacter(p.id, q.folderId) } : {}),
      seeds: s.recentSeeds(p.id, 20),
      now: ctx.now(),
    };
  });

  api.post('/art/outfits/seed', async (req) => {
    const b = parseInput(
      z
        .object({
          project: projectParam,
          folderId: z.string().min(1).max(200).optional(),
          character: z.string().min(1).max(300).optional(),
        })
        .strict(),
      req.body,
    );
    const p = projectFor(ctx, req, b.project);
    return wrap(async () => {
      const seed = await seedOutfits(
        {
          store: store(),
          queries: rt.assets.queries,
          refreshFolder: (projectId, folderId, o) =>
            rt.assets.refreshFolder(projectId, folderId, { ...o, priority: 'P0' }),
          now: ctx.now,
        },
        p.id,
        { folderId: b.folderId, character: b.character },
        'owner',
      );
      audit('art.seed', `${p.id}:${seed.characterFolderId}`, {
        seed: seed.id,
        outfits: seed.result.outfits.length,
        ambiguous: seed.result.ambiguous.length,
      });
      return { seed };
    });
  });

  api.post('/art/outfits/seed/:id/save', async (req) => {
    const { id } = parseInput(z.object({ id: z.string().min(1).max(64) }), req.params);
    const b = parseInput(z.object({ project: projectParam }).loose(), req.body);
    const p = projectFor(ctx, req, b.project);
    return wrap(() => {
      const r = store().saveSeed(p.id, id, 'owner');
      audit('art.seed_save', `${p.id}:${r.seed.characterFolderId}`, { seed: id, outfits: r.outfits.length });
      return r;
    });
  });

  api.post('/art/outfits/seed/:id/discard', async (req) => {
    const { id } = parseInput(z.object({ id: z.string().min(1).max(64) }), req.params);
    const b = parseInput(z.object({ project: projectParam }).loose(), req.body);
    const p = projectFor(ctx, req, b.project);
    return wrap(() => {
      const seed = store().discardSeed(p.id, id, 'owner');
      audit('art.seed_discard', `${p.id}:${seed.characterFolderId}`, { seed: id });
      return { seed };
    });
  });

  const aliasBody = z.object({ project: projectParam, alias: z.string().min(1).max(100) }).strict();
  api.post('/art/outfits/:id/aliases', async (req) => {
    const { id } = parseInput(z.object({ id: z.string().min(1).max(64) }), req.params);
    const b = parseInput(aliasBody, req.body);
    const p = projectFor(ctx, req, b.project);
    return wrap(() => {
      const outfit = store().addAlias(p.id, id, b.alias, 'owner');
      audit('art.alias_add', `${p.id}:${id}`, { alias: b.alias });
      return { outfit };
    });
  });

  api.post('/art/outfits/:id/aliases/remove', async (req) => {
    const { id } = parseInput(z.object({ id: z.string().min(1).max(64) }), req.params);
    const b = parseInput(aliasBody, req.body);
    const p = projectFor(ctx, req, b.project);
    return wrap(() => {
      const outfit = store().removeAlias(p.id, id, b.alias);
      audit('art.alias_remove', `${p.id}:${id}`, { alias: b.alias });
      return { outfit };
    });
  });
};
