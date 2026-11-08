/**
 * Settings of the MCP tool layer (src/mcp/tools). Parsed from its own environment variables, like
 * `loadAuthConfig`, so the main config schema is untouched. `MCP_EXPOSE_PER_OP_TOOLS` stays in the main config
 * (`config.mcp.exposePerOpTools`).
 *
 * Values are only read inside functions, because `./index.ts` re-exports this module (import cycle, as in lk.ts).
 */
import * as z from 'zod';
import { ConfigError } from './index.js';
import { type OutboundPortAllowlist, parseOutboundPortAllowlist } from '../auth/ports.js';

const bool = (def: boolean) => z.stringbool().default(def);
const intFrom = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

const toolsEnvSchema = z.object({
  /** Largest image the bridge will upload (decoded bytes), from base64 or a URL. */
  UPLOAD_MAX_BYTES: intFrom(10 * 1024 * 1024, 1024, 100 * 1024 * 1024),
  /** `lk_upload_image` may fetch a public https URL. Set false to accept base64 only. */
  UPLOAD_ALLOW_URL_SOURCE: bool(true),
  /** Deadline for fetching an image from a URL (DNS, connect, TLS and body). */
  UPLOAD_FETCH_TIMEOUT_MS: intFrom(15_000, 1_000, 120_000),
  /**
   * Per-attempt deadline of the signed-URL PUT (the image upload itself). Its own setting: a large image on a slow
   * link needs longer than the governor's 30-second LegendKeeper request timeout. 5 s to 10 minutes.
   */
  UPLOAD_PUT_TIMEOUT_MS: intFrom(120_000, 5_000, 600_000),
  /** A tool result longer than this many characters is stored as a job artefact and returned as a handle. */
  MCP_RESULT_MAX_CHARS: intFrom(40_000, 4_000, 400_000),
  /** `host:port` pairs the image fetch and the upload PUT may use besides 443 (v1.0.1). Parsed below. */
  OUTBOUND_EXTRA_PORTS_ALLOWLIST: z.string().optional(),
});

export interface ToolsSettings {
  readonly upload: {
    readonly maxBytes: number;
    readonly allowUrlSource: boolean;
    readonly fetchTimeoutMs: number;
    /** UPLOAD_PUT_TIMEOUT_MS: per-attempt deadline of the signed-URL PUT. */
    readonly putTimeoutMs: number;
  };
  /**
   * OUTBOUND_EXTRA_PORTS_ALLOWLIST: `host:port` pairs the image source fetch and the signed-URL PUT may use besides
   * port 443 (src/auth/ports.ts). Empty by default: 443 only.
   */
  readonly outboundExtraPorts: OutboundPortAllowlist;
  /** Results above this many characters become artefact handles (PLAN §7: about 40,000). */
  readonly resultMaxChars: number;
}

export const DEFAULT_TOOLS_SETTINGS: ToolsSettings = {
  upload: { maxBytes: 10 * 1024 * 1024, allowUrlSource: true, fetchTimeoutMs: 15_000, putTimeoutMs: 120_000 },
  resultMaxChars: 40_000,
  outboundExtraPorts: new Set<string>(),
};

/** Parses and validates the tool-layer environment variables. Never echoes values, only names. */
export function loadToolsConfig(env: NodeJS.ProcessEnv = process.env): ToolsSettings {
  const parsed = toolsEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const e = parsed.data;
  let outboundExtraPorts: OutboundPortAllowlist;
  try {
    outboundExtraPorts = parseOutboundPortAllowlist(e.OUTBOUND_EXTRA_PORTS_ALLOWLIST);
  } catch (err) {
    throw new ConfigError([(err as Error).message]);
  }
  return {
    upload: {
      maxBytes: e.UPLOAD_MAX_BYTES,
      allowUrlSource: e.UPLOAD_ALLOW_URL_SOURCE,
      fetchTimeoutMs: e.UPLOAD_FETCH_TIMEOUT_MS,
      putTimeoutMs: e.UPLOAD_PUT_TIMEOUT_MS,
    },
    resultMaxChars: e.MCP_RESULT_MAX_CHARS,
    outboundExtraPorts,
  };
}
