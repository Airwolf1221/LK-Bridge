/**
 * Public surface of `src/mappings` (docs/mappings.md): the Repository Mappings data model, owner commands, import and
 * export, and the read-only preview. Data and CRUD only: no inference engine, and no MCP tool.
 */
import type { Db } from '../db/open.js';
import type { JobEngine } from '../jobs/index.js';
import type { PolicyStore } from '../policy/store.js';
import { createMappingCommands, type MappingCommands } from './commands.js';
import { MappingStore } from './store.js';

/** One project's mappings (v2 A1): mapping sets, rules and field maps belong to a project. */
export interface ProjectMappings {
  readonly store: MappingStore;
  readonly commands: MappingCommands;
}

export interface Mappings {
  /** The store and owner commands of ONE project (its LegendKeeper id); nothing of another project is reachable. */
  forProject(projectId: string): ProjectMappings;
}

export function createMappings(o: {
  db: Db;
  engine: JobEngine;
  policyStore: PolicyStore;
  now?: () => number;
}): Mappings {
  const now = o.now ?? (() => Date.now());
  const cache = new Map<string, ProjectMappings>();
  return {
    forProject(projectId) {
      let m = cache.get(projectId);
      if (!m) {
        const store = new MappingStore(o.db, now, projectId);
        m = {
          store,
          commands: createMappingCommands({ store, audit: o.policyStore, engine: o.engine, now }),
        };
        cache.set(projectId, m);
      }
      return m;
    },
  };
}

export { MappingStore } from './store.js';
export { createMappingCommands, type MappingCommands } from './commands.js';
export { exportSet, parseImport, EXPORT_SCHEMA, EXPORT_VERSION, type MappingDocument } from './exchange.js';
export { previewResource, type PreviewResult, type PreviewMatch } from './preview.js';
export { summarise, describeSelector, describeLocation } from './summary.js';
export * from './types.js';
