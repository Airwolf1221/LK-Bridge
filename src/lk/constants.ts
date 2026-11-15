/** LegendKeeper endpoints. Only src/lk may mention the upstream host (enforced by ESLint). */
export const DEFAULT_LK_BASE_URL = 'https://www.legendkeeper.com';
export const LK_API_PREFIX = '/api/v3';
/**
 * v2 D3 (ADR 0041): the hosts LegendKeeper serves asset files from (the default of LK_ASSET_HOSTS). v2 E5.2: some files
 * are served from `assets2` (a GET on `assets` answers 302 to the same path there), so both are known.
 */
export const DEFAULT_LK_ASSET_HOSTS: readonly string[] = [
  'assets.legendkeeper.com',
  'assets2.legendkeeper.com',
];
