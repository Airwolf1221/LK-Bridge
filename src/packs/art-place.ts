/**
 * v3 F7 (ADR 0070; design G1, G2, G3, G9): the pack side of a guided art call. Before anything is decided, the
 * character's asset folders are read LIVE (G9: a cached tree once showed folders the owner had already changed): the
 * character's folder and three levels below it, or, when the tree does not hold that folder, its parent first (the
 * folder may have been made since). Then the outfit record and the layout decide where the call's images go
 * (src/art/placement.ts).
 */
import type { McpToolResult } from '../mcp/server.js';
import { errorResult } from '../mcp/tools/shape.js';
import { liveRead } from '../mcp/tools/repo.js';
import { readLayout, type ArtLayout } from '../art/layout.js';
import { queriesView } from '../art/seed.js';
import { decidePlacement, type Placement } from '../art/placement.js';
import type { OutfitStore } from '../art/store.js';
import type { CharacterHit, PlanEnv } from './engine/plan.js';
import { textKey } from './engine/text.js';

type Obj = Record<string, unknown>;

/** The character's race as the tree has it, else read once from its page (as the art step always did). */
export async function raceOf(
  env: Pick<PlanEnv, 'pd' | 'mctx' | 'tool'>,
  hit: CharacterHit,
): Promise<string | null> {
  if (hit.race !== null) return hit.race;
  const read = await liveRead(env.pd, env.mctx, env.tool, 'getResource', {
    path: { resourceId: hit.identity.id },
  });
  if (!read.ok) return null;
  const props = (read.value as { properties?: unknown }).properties;
  for (const p of Array.isArray(props) ? (props as Obj[]) : [])
    for (const r of Array.isArray(p.rows) ? (p.rows as Obj[]) : [])
      if (typeof r.key === 'string' && textKey(r.key) === textKey('Race / Species'))
        return (
          (Array.isArray(r.content) ? (r.content as Obj[]) : [])
            .map((x) => (typeof x.text === 'string' ? x.text : ''))
            .join('')
            .trim() || null
        );
  return null;
}

export interface ArtPlace {
  readonly placement: Extract<Placement, { ok: true }>;
  readonly race: string | null;
  /** The character's folder (null: the job makes it). */
  readonly characterFolderId: string | null;
  readonly layout: ArtLayout | null;
  /** The live reads made (G9). */
  readonly live: { readonly requests: number; readonly ok: boolean; readonly error?: string };
}

/** v3 F7b (ADR 0071): the character's asset folder read live (G9), and its layout; or why it could not be read. */
export interface LiveArtFolder {
  readonly race: string | null;
  /** The character's folder (null: it has none yet). */
  readonly characterFolderId: string | null;
  readonly layout: ArtLayout | null;
  /** The live reads made (G9). */
  readonly live: { readonly requests: number; readonly ok: boolean; readonly error?: string };
}

/**
 * v3 F7 (G9), shared by the art tool and v3 F7b's `arkona_get_art`: the character's folder found as the planner finds
 * it (its race's index), its parent read live first when the tree does not hold it, then the folder and three levels
 * below it read live. A failed read is `ART_FOLDERS_UNREADABLE`: nothing is decided from a cached tree.
 */
export async function liveArtFolder(
  env: Pick<PlanEnv, 'pd' | 'mctx' | 'tool' | 'ctx' | 'type'>,
  hit: CharacterHit,
  subject: string,
): Promise<{ ok: true; value: LiveArtFolder } | { ok: false; result: McpToolResult }> {
  const { pd, ctx, type } = env;
  const images = pd.services?.images;
  const assets = pd.services?.assets;
  if (!images || !assets)
    return {
      ok: false,
      result: errorResult(
        { code: 'TOOL_UNAVAILABLE', message: 'Images cannot be placed here (no image service).' },
        pd,
      ),
    };
  let race = await raceOf(env, hit);
  const registryType = type.placement.kind === 'taxonomy' ? type.placement.registryType : undefined;
  if (race !== null) {
    try {
      ctx.types.raceIndex(race, registryType);
    } catch {
      race = null;
    }
  }
  const plan = () =>
    images.plan(ctx.projectId, {
      for_character: { name: subject, race, ...(registryType ? { type: registryType } : {}) },
    });
  let requests = 0;
  let ok = true;
  let error: string | undefined;
  const refresh = async (folderId: string, depth: number) => {
    if (!assets.refreshFolder) return;
    const r = await assets.refreshFolder(ctx.projectId, folderId, { depth });
    requests += r.requests;
    if (!r.ok) {
      ok = false;
      error = r.error;
    }
  };
  let p = plan();
  if (!p.ok) return { ok: false, result: errorResult({ code: p.error.code, message: p.error.message }, pd) };
  if (!p.plan.destination.folderId) {
    const parent = p.plan.wouldCreate[0]?.parentFolderId ?? null;
    if (parent) {
      await refresh(parent, 1);
      p = plan();
      if (!p.ok)
        return { ok: false, result: errorResult({ code: p.error.code, message: p.error.message }, pd) };
    }
  }
  const characterFolderId = p.plan.destination.folderId;
  if (characterFolderId) await refresh(characterFolderId, 3);
  if (!ok)
    return {
      ok: false,
      result: errorResult(
        {
          code: 'ART_FOLDERS_UNREADABLE',
          message: `The character’s asset folders could not be read live now (${error ?? 'a read failed'}); nothing is decided from a cached tree. Try again shortly.`,
        },
        pd,
      ),
    };
  const layout = characterFolderId
    ? readLayout(queriesView(assets.queries, ctx.projectId), characterFolderId)
    : null;
  return {
    ok: true,
    value: { race, characterFolderId, layout, live: { requests, ok, ...(error ? { error } : {}) } },
  };
}

export async function placeArt(
  env: PlanEnv,
  hit: CharacterHit,
  subject: string,
  o: { outfit?: string | null | undefined; newOutfit?: boolean | undefined; arriving: number },
  outfits: OutfitStore | undefined,
): Promise<{ ok: true; value: ArtPlace } | { ok: false; result: McpToolResult }> {
  const { pd, ctx } = env;
  const folder = await liveArtFolder(env, hit, subject);
  if (!folder.ok) return folder;
  const { race, characterFolderId, layout, live } = folder.value;
  const records = characterFolderId && outfits ? outfits.forCharacter(ctx.projectId, characterFolderId) : [];
  const placement = decidePlacement({
    character: subject,
    layout,
    records,
    outfit: o.outfit,
    newOutfit: o.newOutfit,
    arriving: o.arriving,
  });
  if (!placement.ok)
    return {
      ok: false,
      result: errorResult(
        {
          code: placement.code,
          message: placement.message,
          ...(placement.candidates ? { candidates: placement.candidates } : {}),
        },
        pd,
      ),
    };
  return {
    ok: true,
    value: { placement, race, characterFolderId, layout, live },
  };
}
