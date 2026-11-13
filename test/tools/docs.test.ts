import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOLS_SETTINGS } from '../../src/config/index.js';
import { createBridgeTools } from '../../src/mcp/tools/index.js';
import type { ToolDeps } from '../../src/mcp/tools/index.js';

const docs = readFileSync(new URL('../../docs/tools.md', import.meta.url), 'utf8');
const deps = { settings: DEFAULT_TOOLS_SETTINGS } as unknown as ToolDeps;

describe('docs/tools.md', () => {
  it('documents every tool', () => {
    for (const t of createBridgeTools(deps, { exposePerOpTools: false })) {
      expect(docs, t.name).toContain(`\`${t.name}\``);
    }
    expect(docs).toContain('lk_op_<operationId>');
  });
  it('states the tool counts', () => {
    // Chunk 3's 16, v2 A1's list_projects, v2 B2's twelve, v2 C1's write_page, v2 C2a's set_facts, v2 C2b's twelve and
    // v2 C2c's four lifecycle tools, v2 D1's calendar_date and four timeline tools, D1.1's sync_timeline_event, v2 D2's three
    // map-feature tools, v2 D3's upload_image and prepare_image_upload, and v2 E1a's three snapshot tools and v2 E2's audit_findings
    // (the policy layer adds its two proposal tools on the server).
    expect(createBridgeTools(deps, { exposePerOpTools: false })).toHaveLength(62);
    expect(createBridgeTools(deps, { exposePerOpTools: true })).toHaveLength(62 + 89);
    expect(docs).toContain('151 tools');
  });
});
