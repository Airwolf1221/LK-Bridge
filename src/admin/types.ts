import type { AuthServices } from '../auth/services.js';
import type { AdminSettings, Config } from '../config/index.js';
import type { JobEngine } from '../jobs/index.js';
import type { ProjectRegistry } from '../projects/index.js';
import type { Maintenance } from '../maintenance/index.js';
import type { Mappings } from '../mappings/index.js';
import type { Policy } from '../policy/index.js';
import type { AssetService } from '../assets/index.js';
import type { TreeService } from '../tree/index.js';

/**
 * What the admin API needs from the running bridge. `Runtime` (src/runtime.ts) satisfies it; tests may build their own.
 */
export interface AdminRuntime {
  readonly engine: JobEngine;
  /** The projects this bridge serves (v2 A1): each one's governor, flags and whether it is served now. */
  readonly projects: ProjectRegistry;
  readonly policy: Policy;
  /** Maintenance registry, scheduler and owner commands (chunk 6). */
  readonly maintenance: Maintenance;
  /** Repository mappings store and owner commands (chunk 6). */
  readonly mappings: Mappings;
  /** v2 A2: the repository tree of each project. */
  readonly tree: TreeService;
  /** v2 A4: the asset tree of each project. */
  readonly assets: AssetService;
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
