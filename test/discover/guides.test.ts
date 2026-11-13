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
    // The bridge guide is the file, with the Operations section generated from the registry appended (ADR 0033).
    const served = readGuide(GUIDES.find((g) => g.id === 'bridge')!);
    expect(served.startsWith(guide.trimEnd())).toBe(true);
    expect(served.slice(guide.trimEnd().length)).toMatch(/^\n\n## Operations\n/);
    expect(readGuide(GUIDES.find((g) => g.id === 'markdown')!)).toBe(
      readFileSync(new URL('../../docs/markdown.md', import.meta.url), 'utf8'),
    );
  });
  it('is organised around tasks, with “How to decide” first and the reference after (E3, ADR 0045)', () => {
    const headings = outline(guide);
    const top = headings.filter((h) => h.level === 2).map((h) => h.text);
    expect(top[0]).toBe('How to decide');
    for (const h of [
      'Find and read a page',
      "Edit a page's text",
      'Change facts and links',
      'Create a page or a character (Working first)',
      'Rename, move, delete and restore',
      'The page lifecycle',
      'Dates and the chronology',
      'Maps',
      'Images',
      'Snapshots and restores',
      'Audit findings',
      'Budgets, jobs and proposals',
      'Canon and approval',
      'When the low-level tools are right',
      'Reference',
    ]) {
      expect(top, h).toContain(h);
      expect(getSection(guide, h).body.length, h).toBeGreaterThan(100);
    }
    expect(top.indexOf('How to decide')).toBeLessThan(top.indexOf('Reference'));
    // The reference keeps what an agent looks up: the project and tree rules, and the refusal codes.
    const all = headings.map((h) => h.text);
    for (const h of ['What the bridge is', 'Projects', 'The repository tree', 'When something goes wrong'])
      expect(all, h).toContain(h);
  });
  it('“How to decide” holds the five rules and the which-tool table, and stays short enough to read every time', () => {
    const decide = getSection(guide, 'How to decide');
    for (const phrase of ['Five rules', 'Which tool?', 'baseFactsVersion', 'proposal_captured', 'lk_api_']) {
      expect(decide.markdown, phrase).toContain(phrase);
    }
    expect(decide.markdown.length).toBeLessThan(9000);
  });
  it('names only tools that exist', () => {
    const names = new Set(tools.map((t) => t.name));
    for (const op of operations) names.add(`lk_op_${op.operationId}`);
    for (const n of ['bridge_proposal_status', 'bridge_proposals_mine']) names.add(n);
    const mentioned = [...guide.matchAll(/`((?:lk|bridge|list|get|browse|write)(?:_[a-zA-Z]+)+)`/g)].map(
      (m) => m[1]!,
    );
    expect(mentioned.length).toBeGreaterThan(10);
    for (const n of mentioned) {
      expect(names.has(n), n).toBe(true);
    }
  });
  it('states that content search is incomplete and that a write must name its project', () => {
    expect(guide).toMatch(/incomplete by nature/i);
    expect(guide).toMatch(/A write must name its project/);
  });
});
