/**
 * The MCP tool surface (PLAN §7): low-level `lk_api_*` tools, the composite `lk_upload_image`, the `bridge_*`
 * awareness tools and, only when MCP_EXPOSE_PER_OP_TOOLS=true, `lk_op_<operationId>` for all 89 operations.
 * Every tool carries an `access` tag (`read` | `write`) and honest annotations.
 */
import type { McpToolProvider } from '../server.js';
import { bridgeTools } from './bridge.js';
import { lkApiTools } from './lk-api.js';
import { perOpTools } from './per-op.js';
import type { ToolDeps } from './shape.js';
import { uploadTools } from './upload.js';

export type { ToolDeps } from './shape.js';
export { createUploadPutHandler } from './upload-step.js';
export { createUploadTransport } from './upload-http.js';

/** The MCP server `instructions`: short guidance every connected agent sees (also in docs/tools.md). */
export const BRIDGE_INSTRUCTIONS =
  'LK-Bridge gives governed access to one LegendKeeper project. Rate budget is shared and finite: every result ends with a budget line. ' +
  'Before a large workload (hundreds of calls) check bridge_estimate, and run multi-step work as one lk_api_batch job rather than a loop of single calls. ' +
  'Read before you write, and pass the version you read as params.ifMatch. ' +
  'Never loop on budget errors: wait until the stated retry time. ' +
  'Never retry a write that returned waiting_budget, queued or proposal_captured; it is not lost: follow a job with bridge_job_status and a proposal with bridge_proposal_status. ' +
  'Results are summaries; ask for detail "full" only when you need the whole payload, and page oversized results with bridge_result_page.';

export function createBridgeTools(deps: ToolDeps, opts: { exposePerOpTools: boolean }): McpToolProvider[] {
  return [
    ...bridgeTools(deps),
    ...lkApiTools(deps),
    ...uploadTools(deps),
    ...(opts.exposePerOpTools ? perOpTools(deps) : []),
  ];
}
