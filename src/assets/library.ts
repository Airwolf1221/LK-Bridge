/**
 * v3 F2 (ADR 0049 decision 9): the asset library as the bridge's asset tree holds it (folders with their paths, and
 * the items in them), for the audit's duplicate-folder check. Null while the tree has never been built.
 */
import type { AssetLibrary } from '../audits/checks/assets.js';
import type { AssetService } from './service.js';

export function assetLibraryOf(assets: Pick<AssetService, 'store'>, projectId: string): AssetLibrary | null {
  const db = assets.store.db;
  const folders = db
    .prepare('SELECT id, name, parent_id, path_names, created_at FROM asset_folders WHERE project_id = ?')
    .all(projectId) as {
    id: string;
    name: string;
    parent_id: string | null;
    path_names: string;
    created_at: number;
  }[];
  if (folders.length === 0) return null;
  const items = db
    .prepare('SELECT id, name, folder_id FROM asset_items WHERE project_id = ?')
    .all(projectId) as {
    id: string;
    name: string;
    folder_id: string | null;
  }[];
  const pathOf = (t: string): string[] => {
    try {
      const v = JSON.parse(t) as unknown;
      return Array.isArray(v) ? v.map(String) : [];
    } catch {
      return [];
    }
  };
  return {
    folders: folders.map((f) => ({
      id: f.id,
      name: f.name,
      parentId: f.parent_id,
      path: pathOf(f.path_names),
      createdAt: f.created_at,
    })),
    items: items.map((i) => ({ id: i.id, name: i.name, folderId: i.folder_id })),
  };
}
