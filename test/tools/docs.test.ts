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
    expect(createBridgeTools(deps, { exposePerOpTools: false })).toHaveLength(16);
    expect(createBridgeTools(deps, { exposePerOpTools: true })).toHaveLength(16 + 89);
    expect(docs).toContain('105 tools');
  });
});
