import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOLS_SETTINGS } from '../../src/config/index.js';
import { operations } from '../../src/lk/index.js';
import { createBridgeTools } from '../../src/mcp/tools/index.js';
import { GUIDES, readGuide } from '../../src/mcp/tools/guides.js';
import type { ToolDeps } from '../../src/mcp/tools/index.js';
import { getSection, outline } from '../../src/markdown/index.js';

const tools = createBridgeTools({ settings: DEFAULT_TOOLS_SETTINGS } as unknown as ToolDeps, {
  exposePerOpTools: false,
});
const guide = readFileSync(new URL('../../docs/bridge-guide.md', import.meta.url), 'utf8');

describe('docs/bridge-guide.md', () => {
  it('is what get_bridge_guide serves, and the Markdown guide is what get_markdown_guide serves', () => {
    expect(readGuide(GUIDES.find((g) => g.id === 'bridge')!)).toBe(guide);
    expect(readGuide(GUIDES.find((g) => g.id === 'markdown')!)).toBe(
      readFileSync(new URL('../../docs/markdown.md', import.meta.url), 'utf8'),
    );
  });
  it('covers what an agent needs: projects, the tree, finding, reading, writing, budget rules and proposals', () => {
    const headings = outline(guide).map((h) => h.text);
    for (const h of [
      'What the bridge is',
      'Projects',
      'The repository tree',
      'Finding things',
      'Reading',
      'Writing, and what is coming',
      'Budget rules',
      'Proposals and the owner',
    ]) {
      expect(headings, h).toContain(h);
      expect(getSection(guide, h).body.length, h).toBeGreaterThan(100);
    }
  });
  it('names only tools that exist (or the write tools it says are coming)', () => {
    const names = new Set(tools.map((t) => t.name));
    for (const op of operations) names.add(`lk_op_${op.operationId}`);
    for (const n of ['bridge_proposal_status', 'bridge_proposals_mine']) names.add(n);
    // The write tool the guide says is coming.
    const coming = new Set(['write_page']);
    const mentioned = [...guide.matchAll(/`((?:lk|bridge|list|get|browse|write)(?:_[a-zA-Z]+)+)`/g)].map(
      (m) => m[1]!,
    );
    expect(mentioned.length).toBeGreaterThan(10);
    for (const n of mentioned) {
      expect(names.has(n) || coming.has(n), n).toBe(true);
    }
  });
  it('states that content search is incomplete and that a write must name its project', () => {
    expect(guide).toMatch(/incomplete by nature/i);
    expect(guide).toMatch(/A write must name its project/);
  });
});
