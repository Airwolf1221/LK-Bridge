/** Public surface of `src/admin` (docs/dashboard.md). */
export { adminPlugin } from './plugin.js';
export { applyStoredSettings, readStoredSettings, SETTING_KEYS } from './runtime-settings.js';
export { UI_CSP } from './ui.js';
export { ADMIN_CSRF_PURPOSE } from './guard.js';
export type { AdminDeps, AdminRuntime } from './types.js';
