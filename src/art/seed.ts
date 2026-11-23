/**
 * v3 F7 (ADR 0070, G3): seeding a character's outfit record, an owner action on the dashboard. The character's folder
 * is read LIVE (G9), then G3's rules read its Wardrobe (src/art/layout.ts `seedFromLayout`): a `Wardrobe/<X>` folder is
 * outfit X with its pieces; a loose piece named `<Character> - <Outfit> - <Descriptor>` is that outfit; anything else is
 * listed for the owner, never guessed. The result waits for the owner's review (`pending`); only "Save" records it.
 */
import type { AssetQueries } from '../assets/queries.js';
import { readLayout, seedFromLayout, type LibraryView } from './layout.js';
import { OutfitError, type OutfitStore, type SeedView } from './store.js';

export interface SeedDeps {
  readonly store: OutfitStore;
  readonly queries: AssetQueries;
  readonly refreshFolder: (
    projectId: string,
    folderId: string,
    o?: { depth?: number },
  ) => Promise<{ ok: boolean; requests: number; error?: string }>;
  readonly now: () => number;
}

export function queriesView(queries: AssetQueries, projectId: string): LibraryView {
  return {
    folder: (id) => {
      const f = queries.folder(projectId, id).data;
      return f ? { id: f.id, name: f.name, path: f.path.names } : null;
    },
    folders: (parentId) =>
      queries.children(projectId, parentId).data.map((f) => ({ id: f.id, name: f.name })),
    items: (folderId) =>
      queries
        .assetsIn(projectId, folderId, { limit: 5000 })
        .data.assets.map((a) => ({ id: a.id, name: a.name, url: a.url })),
  };
}

/** The character folder a seeding is for: by id, or by its exact name (one folder of that name). */
export function characterFolder(
  queries: AssetQueries,
  projectId: string,
  ref: { readonly folderId?: string | undefined; readonly character?: string | undefined },
): { id: string; name: string; path: string } {
  if (ref.folderId) {
    const f = queries.folder(projectId, ref.folderId).data;
    if (!f) throw new OutfitError('FOLDER_NOT_FOUND', `No asset folder ${ref.folderId} in the asset tree.`);
    return { id: f.id, name: f.name, path: f.path.names.join(' / ') };
  }
  const name = (ref.character ?? '').trim();
  if (!name) throw new OutfitError('INVALID_INPUT', 'Give the character’s folder (its id) or its name.');
  const hits = queries.findFoldersByName(projectId, name).data;
  if (hits.length === 0) throw new OutfitError('FOLDER_NOT_FOUND', `No asset folder is named “${name}”.`);
  if (hits.length > 1)
    throw new OutfitError(
      'FOLDER_AMBIGUOUS',
      `${hits.length} asset folders are named “${name}” (${hits.map((h) => h.path.names.join(' / ')).join('; ')}): give the folder’s id.`,
    );
  const f = hits[0]!;
  return { id: f.id, name: f.name, path: f.path.names.join(' / ') };
}

/** Reads one character's folders live and stores what G3's rules found, for the owner's review. */
export async function seedOutfits(
  d: SeedDeps,
  projectId: string,
  ref: { readonly folderId?: string | undefined; readonly character?: string | undefined },
  by: string,
): Promise<SeedView> {
  const f = characterFolder(d.queries, projectId, ref);
  const live = await d.refreshFolder(projectId, f.id, { depth: 3 });
  if (!live.ok)
    throw new OutfitError(
      'LIVE_READ_FAILED',
      `The folder could not be read live (${live.error ?? 'a read failed'}); nothing is seeded from a cached tree.`,
    );
  const layout = readLayout(queriesView(d.queries, projectId), f.id);
  if (!layout)
    throw new OutfitError('FOLDER_NOT_FOUND', `The folder ${f.path} is gone (read live just now).`);
  const s = seedFromLayout(layout);
  return d.store.createSeed({
    projectId,
    characterFolderId: f.id,
    characterName: layout.character.name,
    result: { ...s, read: { requests: live.requests, at: d.now(), ok: true } },
    by,
  });
}
