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

export type { ToolDeps, DiscoverServices } from './shape.js';
export { guideResources } from './guides.js';
export { createUploadPutHandler, createUploadVerifyHandler } from './upload-step.js';
export { createUploadTransport } from './upload-http.js';

/**
 * The MCP server `instructions`: short, and pointing to the bridge guide (v2 B2; the full text is docs/bridge-guide.md,
 * served by `get_bridge_guide` and as the resource lk-bridge://guides/bridge).
 */
export const BRIDGE_INSTRUCTIONS =
  'LK-Bridge gives governed access to LegendKeeper projects (list_projects); every tool takes an optional project, and a write must name its project when the bridge serves several. Call get_bridge_guide first: it explains projects, the repository tree, finding and reading pages, writing, budgets and proposals. ' +
  'Find pages with search and browse_repository_tree, read them with get_resource and read_document (Markdown; see get_markdown_guide). ' +
  "Every result names its project and ends with that project's budget line; budgets are finite, so never loop on budget errors, and check bridge_estimate before hundreds of calls. " +
  'Never retry a write that returned waiting_budget, queued or proposal_captured: follow a job with bridge_job_status and a proposal with bridge_proposal_status. ' +
  'Results are summaries (detail "full" opts in); oversized results come as handles for bridge_result_page. The lk_api_* tools are the low-level fallback.';

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
    ...guideTools(deps),
    ...lkApiTools(deps),
    ...uploadTools(deps),
    // v2 D3 (ADR 0041): the image pipeline.
    ...imageTools(deps),
    ...(opts.exposePerOpTools ? perOpTools(deps) : []),
  ];
}
