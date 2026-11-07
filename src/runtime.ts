import { pino } from 'pino';
import { jobsSettingsFrom, lkSettingsFrom, type Config, type ToolsSettings } from './config/index.js';
import type { Db } from './db/open.js';
import { createJobEngine, UPLOAD_PUT_STEP, type JobEngine } from './jobs/index.js';
import { createLkClient, defaultTransport, type Clock, type LkClient, type Transport } from './lk/index.js';
import type { McpToolProvider } from './mcp/server.js';
import {
  BRIDGE_INSTRUCTIONS,
  createBridgeTools,
  createUploadPutHandler,
  createUploadTransport,
} from './mcp/tools/index.js';
import type { GuardOptions } from './mcp/tools/upload-http.js';

/**
 * The bridge's working parts, in the order they depend on each other: governor-backed LK client, then the job
 * engine on the migrated database (its restart-resume runs inside `createRuntime`, before the caller opens the
 * MCP endpoint), then the MCP tools. `src/server.ts` builds the HTTP side around it.
 */
export interface Runtime {
  readonly lk: LkClient;
  readonly engine: JobEngine;
  readonly tools: readonly McpToolProvider[];
  readonly instructions: string;
  /** Drain (bounded), stop the engine, close the governor. Does not close the database. */
  shutdown(drainTimeoutMs?: number): Promise<void>;
}

export interface RuntimeOptions {
  readonly config: Config;
  readonly toolsSettings: ToolsSettings;
  /** Already opened and migrated. */
  readonly db: Db;
  readonly version: string;
  /** Test seams. */
  readonly clock?: Clock;
  readonly lkTransport?: Transport;
  readonly uploadGuard?: GuardOptions;
}

export function createRuntime(o: RuntimeOptions): Runtime {
  const { config } = o;
  const log = pino({ level: config.logLevel, base: { component: 'engine' } });
  // Signed upload URLs are on another host: the transport sends LegendKeeper's host through the platform fetch
  // and every other host through the SSRF guard. Both stay under the governor.
  const transport = createUploadTransport({
    lkOrigin: new URL(config.lk.baseUrl).origin,
    lk: o.lkTransport ?? defaultTransport,
    ...(o.uploadGuard ?? {}),
  });
  const lk = createLkClient({
    ...lkSettingsFrom(config),
    transport,
    ...(o.clock ? { clock: o.clock } : {}),
  });
  const engine = createJobEngine({
    db: o.db,
    lk,
    settings: jobsSettingsFrom(config),
    log,
    ...(o.clock ? { clock: o.clock } : {}),
    customSteps: { [UPLOAD_PUT_STEP]: createUploadPutHandler(o.uploadGuard ? { guard: o.uploadGuard } : {}) },
    autoStart: false,
  });
  engine.start(); // restart-resume: jobs left running by a crash are verified and continued

  const tools = createBridgeTools(
    {
      engine,
      lk,
      settings: o.toolsSettings,
      version: o.version,
      projectId: config.lk.projectId,
      configuredReadOnly: config.lk.readOnly,
      uploadGuard: o.uploadGuard,
    },
    { exposePerOpTools: config.mcp.exposePerOpTools },
  );

  return {
    lk,
    engine,
    tools,
    instructions: BRIDGE_INSTRUCTIONS,
    async shutdown(drainTimeoutMs = 20_000) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        engine.controls.drain(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, drainTimeoutMs);
        }),
      ]);
      clearTimeout(timer);
      await engine.stop();
      lk.governor.close();
    },
  };
}
