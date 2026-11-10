/**
 * Pure helpers of the asset tree: what a listAssets item or a getAsset response says about an asset or a folder (an
 * `AssetObservation`), the case-folded key exact-name lookups use, and the per-project settings the asset tree reads.
 */
import type { ProjectSettings } from '../projects/settings.js';
import { nameKey } from '../tree/classify.js';
import type { AssetObservation } from './types.js';

export { nameKey };

/** LegendKeeper's type of a folder. */
export const FOLDER_TYPE = 'FOLDER';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const whole = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;

/**
 * One asset as listAssets or getAsset shows it. Null when it has no usable id, name or type (such an item is left out
 * rather than guessed at).
 */
export function observationFromAsset(raw: unknown): AssetObservation | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id === '') return null;
  if (typeof o.name !== 'string' || typeof o.type !== 'string') return null;
  return {
    id: o.id,
    name: o.name,
    type: o.type,
    folderId: typeof o.folderId === 'string' && o.folderId !== '' ? o.folderId : null,
    url: str(o.url),
    width: whole(o.width),
    height: whole(o.height),
    // LegendKeeper's Asset has no size today; read it if it ever appears, under the names it might use.
    size: whole(o.size ?? o.fileSize ?? o.bytes ?? o.contentLength),
    isHidden: o.isHidden === true,
    createdAt: str(o.createdAt),
  };
}

/** The settings the asset tree reads, with their defaults. */
export interface AssetSettings {
  /** Whether the regular refresh (default every 6 hours) runs for this project. The nightly check always runs. */
  readonly refreshEnabled: boolean;
  /** The Characters root page of the repository tree (a project setting), or null. */
  readonly charactersRootId: string | null;
}

export function assetSettingsFrom(s: ProjectSettings): AssetSettings {
  return {
    refreshEnabled: s.assetRefreshEnabled ?? true,
    charactersRootId: s.charactersRootId ?? null,
  };
}
