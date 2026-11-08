import type { AuthServices } from '../auth/services.js';
import type { AdminSettings, Config } from '../config/index.js';
import type { JobEngine } from '../jobs/index.js';
import type { LkClient } from '../lk/index.js';
import type { Policy } from '../policy/index.js';

/**
 * What the admin API needs from the running bridge. `Runtime` (src/runtime.ts) satisfies it; tests may build their own.
 */
export interface AdminRuntime {
  readonly engine: JobEngine;
  readonly lk: LkClient;
  readonly policy: Policy;
  /** The configuration the running components were built from (environment plus the dashboard's stored values). */
  readonly config: Config;
  /** The environment's values alone: what clearing a stored setting falls back to. */
  readonly envConfig: Config;
}

export interface AdminDeps {
  readonly runtime: AdminRuntime;
  readonly services: AuthServices;
  readonly settings: AdminSettings;
  readonly version: string;
  /** Directory of the built dashboard (`ui/dist`). When it does not exist `/ui` explains that it was not built. */
  readonly uiDir: string;
  readonly now?: () => number;
}
