/**
 * The MCP tool surface (PLAN §7): low-level `lk_api_*` tools, the composite `lk_upload_image`, the `bridge_*`
 * awareness tools and, only when MCP_EXPOSE_PER_OP_TOOLS=true, `lk_op_<operationId>` for all 89 operations.
 * Every tool carries an `access` tag (`read` | `write`) and honest annotations.
 */
import type { McpToolProvider } from '../server.js';
import { bridgeTools } from './bridge.js';
import { discoverTools } from './discover.js';
import { guideTools } from './guides.js';
import { readDocumentTool } from './read-document.js';
import { lkApiTools } from './lk-api.js';
import { perOpTools } from './per-op.js';
import type { ToolDeps } from './shape.js';
import { uploadTools } from './upload.js';
import { imageTools } from './images.js';
import { writePageTool } from './write-page.js';
import { setFactsTool } from './set-facts.js';
import { resourceTools } from './resources.js';
import { createCharacterTool } from './create-character.js';
import { lifecycleTools } from './lifecycle.js';
import { documentTools } from './documents.js';
import { timelineTools } from './timelines.js';
import { mapFeatureTools } from './map-features.js';
import { snapshotTools } from './snapshots.js';
import { auditTools } from './audits.js';

export type { ToolDeps, DiscoverServices } from './shape.js';
export { guideResources } from './guides.js';
export { createUploadPutHandler, createUploadVerifyHandler } from './upload-step.js';
export { createUploadTransport } from './upload-http.js';

/**
 * The MCP server `instructions`: short, and pointing to the bridge guide (v2 B2; the full text is docs/bridge-guide.md,
 * served by `get_bridge_guide` and as the resource lk-bridge://guides/bridge).
 */
export const BRIDGE_INSTRUCTIONS =
  'LK-Bridge gives governed access to LegendKeeper projects (list_projects). Every tool takes an optional project; a write must name its project when the bridge serves several.\n' +
  'FIRST call get_bridge_guide with section "How to decide", then read its section for your task before you do it; read get_markdown_guide before writing Markdown. Every result names its project and ends with that project’s budget line.\n' +
  'The four rules that matter most:\n' +
  '1. Use the high-level tools (search, get_resource, read_document, write_page, set_facts, create_*); the lk_api_* tools are only the fallback for a job none of them does.\n' +
  '2. Read before you write, and pass the version you read (baseVersion, baseFactsVersion). Never retry a write that returned proposal_captured, queued or waiting_budget: follow it with bridge_proposal_status or bridge_job_status.\n' +
  '3. New pages are Working. Canon and lifecycle changes (promote_page, archive_page, deleting Authoritative pages) are always proposals only the owner can accept: tell the person, never route around it.\n' +
  '4. Budgets are finite: never loop on an error, and check bridge_estimate before bulk work.\n' +
  'Results are summaries (detail "full" opts in); oversized results come as handles for bridge_result_page.';

export function createBridgeTools(deps: ToolDeps, opts: { exposePerOpTools: boolean }): McpToolProvider[] {
  return [
    ...bridgeTools(deps),
    ...discoverTools(deps),
    readDocumentTool(deps),
    writePageTool(deps),
    setFactsTool(deps),
    ...resourceTools(deps),
    createCharacterTool(deps),
    // v2 C2c (ADR 0035): the page lifecycle.
    ...lifecycleTools(deps),
    ...documentTools(deps),
    // v2 D1 (ADR 0038): the calendar engine and the timeline tools.
    ...timelineTools(deps),
    // v2 D2 (ADR 0040): the map-feature tools.
    ...mapFeatureTools(deps),
    // v2 E1a (ADR 0042): snapshots and restores (always proposals).
    ...snapshotTools(deps),
    // v2 E2 (ADR 0044): the audits' findings (read-only).
    ...auditTools(deps),
    ...guideTools(deps),
    ...lkApiTools(deps),
    ...uploadTools(deps),
    // v2 D3 (ADR 0041): the image pipeline.
    ...imageTools(deps),
    ...(opts.exposePerOpTools ? perOpTools(deps) : []),
  ];
}
