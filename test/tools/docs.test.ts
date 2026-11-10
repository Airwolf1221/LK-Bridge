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
    // Chunk 3's 16, v2 A1's list_projects, v2 B2's twelve and v2 C1's write_page (the policy layer adds its two proposal
    // tools on the server).
    expect(createBridgeTools(deps, { exposePerOpTools: false })).toHaveLength(30);
    expect(createBridgeTools(deps, { exposePerOpTools: true })).toHaveLength(30 + 89);
    expect(docs).toContain('119 tools');
  });
});
