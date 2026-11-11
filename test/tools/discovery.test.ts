/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
/**
 * Operation discovery when the low-level tools are hidden (ADR 0033): close suggestions for an unknown operation id
 * (edit distance and a small synonym map), a hint that names the low-level tools only when the caller can see them, the
 * bridge guide's generated Operations section (every registry operation), and the same suggestions from lk_api_batch.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { operations } from '../../src/lk/index.js';
import { guideResources, GUIDES, readGuide } from '../../src/mcp/tools/guides.js';
import { operationsGuideSection } from '../../src/mcp/tools/discovery.js';
import { suggestOperations } from '../../src/mcp/tools/schemas.js';
import { ALL_PROJECTS } from '../../src/projects/index.js';
import { getSection, outline } from '../../src/markdown/index.js';
import { discoverWorld, type DiscoverWorld } from '../discover/world.js';

const ids = operations.map((o) => o.operationId);

describe('suggestions', () => {
  it('appendDocumentBlocks → insertBlock first, with replaceDocumentBlocks and getDocumentBlocks among at most 5', () => {
    const s = suggestOperations('appendDocumentBlocks', ids);
    expect(s).toHaveLength(5);
    expect(s[0]).toBe('insertBlock');
    expect(s).toEqual(expect.arrayContaining(['replaceDocumentBlocks', 'getDocumentBlocks']));
  });

  it('listBlocks → the list and get operations on blocks', () => {
    const s = suggestOperations('listBlocks', ids);
    expect(s).toHaveLength(5);
    expect(s).toEqual(expect.arrayContaining(['listBlockRows', 'listBlockProperties', 'getBlock']));
    expect(s).toContain('getDocumentBlocks'); // fetch/list ~ get
  });

  it('deleteDocument: case-insensitive, and the synonym remove → delete', () => {
    expect(suggestOperations('deletedocument', ids)[0]).toBe('deleteDocument');
    expect(suggestOperations('DELETEDOCUMENT', ids)[0]).toBe('deleteDocument');
    expect(suggestOperations('removeDocument', ids)[0]).toBe('deleteDocument');
    expect(suggestOperations('deleteDocuments', ids)[0]).toBe('deleteDocument');
  });

  it('the other synonyms: add/create → insert, edit/set → update, fetch → get or list; typos by edit distance', () => {
    expect(suggestOperations('addBlock', ids)[0]).toBe('insertBlock');
    expect(suggestOperations('editResource', ids)[0]).toBe('updateResource');
    expect(suggestOperations('setBlock', ids)).toContain('updateBlock');
    expect(suggestOperations('fetchDocument', ids).slice(0, 2)).toEqual(
      expect.arrayContaining(['getDocument', 'listDocuments']),
    );
    expect(suggestOperations('getDocumnt', ids)[0]).toBe('getDocument');
    expect(suggestOperations('GETDOCUMENTBLOCK', ids)).toContain('getDocumentBlocks');
  });
});

describe('the bridge guide’s Operations section', () => {
  it('lists every registry operation, grouped by tag, one line each with kind and risk, no schemas', () => {
    const section = operationsGuideSection();
    expect(operations).toHaveLength(89);
    for (const op of operations) {
      const line = section.split('\n').find((l) => l.startsWith(`- \`${op.operationId}\`:`));
      expect(line, op.operationId).toBeTruthy();
      expect(line).toContain(`${op.kind}, ${op.risk}`);
    }
    expect(section.split('\n').filter((l) => l.startsWith('- `'))).toHaveLength(89);
    for (const tag of new Set(operations.map((o) => o.tag))) expect(section).toContain(`### ${tag}`);
    expect(section).not.toContain('inputSchema');
    expect(section).toContain('`lk_api_describe_operation`');
    expect(section).toContain('`getBlock` and `getDocumentBlocks`');
  });

  it('is appended to the guide at serve time (the tool, the section lookup and the MCP resource), so it cannot go stale', () => {
    const guide = GUIDES.find((g) => g.id === 'bridge')!;
    const text = readGuide(guide);
    expect(outline(text).map((h) => h.text)).toContain('Operations');
    // The section is parsed once (parsing the whole guide per operation came close to the 5 s timeout under CI load).
    const section = getSection(text, 'Operations').markdown;
    for (const op of operations) expect(section, op.operationId).toContain(`\`${op.operationId}\``);
    const resource = guideResources().find((r) => r.uri === guide.uri)!;
    expect(resource.read()).toBe(text);
    // The markdown guide is untouched.
    expect(readGuide(GUIDES.find((g) => g.id === 'markdown')!)).not.toContain('## Operations\n\nAll 89');
  });
});

describe('UNKNOWN_OPERATION through the tools', () => {
  let w: DiscoverWorld;
  beforeAll(async () => {
    w = await discoverWorld({ bulk: 5 });
  });
  afterAll(() => w.close());

  const HIDDEN_HINT =
    'The full list is in get_bridge_guide (Operations), or the owner can show the low-level tools for this profile on Clients & Access.';

  it('a profile that cannot see the low-level tools is pointed at the guide, never at a tool it cannot see', async () => {
    const t = w.stack.newToken('hidden-discovery', 'write');
    const c = await w.stack.connect(t.token);
    for (const tool of ['lk_api_read', 'lk_api_write']) {
      const r = await w.stack.call(c, tool, { operationId: 'appendDocumentBlocks' });
      expect(r.isError).toBe(true);
      expect(r.body.error.code).toBe('UNKNOWN_OPERATION');
      expect(r.body.error.didYouMean[0]).toBe('insertBlock');
      expect(r.body.error.didYouMean).toEqual(
        expect.arrayContaining(['replaceDocumentBlocks', 'getDocumentBlocks']),
      );
      expect(r.body.error.hint).toBe(HIDDEN_HINT);
      expect(JSON.stringify(r.body.error)).not.toMatch(/lk_api_list_operations|lk_api_describe_operation/);
    }
  });

  it('a profile that sees them is told about them, and the hint follows the setting live', async () => {
    const t = w.stack.newToken('visible-discovery', 'write');
    w.stack.policy.commands.setShowLowLevelTools('owner', t.profileId, true);
    const c = await w.stack.connect(t.token);
    const r = await w.stack.call(c, 'lk_api_read', { operationId: 'listBlocks' });
    expect(r.body.error.hint).toContain('lk_api_list_operations');
    expect(r.body.error.hint).toContain('lk_api_describe_operation');
    expect(r.body.error.didYouMean).toHaveLength(5);
    const d = await w.stack.call(c, 'lk_api_describe_operation', { operationId: 'removeDocument' });
    expect(d.body.error.didYouMean[0]).toBe('deleteDocument');
    expect(d.body.error.hint).toContain('lk_api_list_operations');
    // Hidden again: the very next call says the other thing.
    w.stack.policy.commands.setShowLowLevelTools('owner', t.profileId, false);
    const again = await w.stack.call(c, 'lk_api_read', { operationId: 'listBlocks' });
    expect(again.body.error.hint).toBe(HIDDEN_HINT);
  });

  it('lk_api_batch gives the same suggestions, refuses the whole batch and queues nothing', async () => {
    const t = w.stack.newToken('batch-discovery', 'write');
    const c = await w.stack.connect(t.token);
    const jobs = () => w.stack.runtime.engine.queries.listJobs(ALL_PROJECTS, {}).length;
    const before = jobs();
    const single = await w.stack.call(c, 'lk_api_read', { operationId: 'appendDocumentBlocks' });
    const r = await w.stack.call(c, 'lk_api_batch', {
      calls: [
        { operationId: 'getResource', params: { path: { resourceId: 'kaede001' } } },
        { operationId: 'appendDocumentBlocks', params: {} },
      ],
    });
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('UNKNOWN_OPERATION');
    expect(r.body.error.didYouMean).toEqual(single.body.error.didYouMean);
    expect(r.body.error.hint).toBe(HIDDEN_HINT);
    expect(r.body.error.callIndex).toBe(1);
    expect(r.body.error.message).toContain('call 2 of 2');
    expect(jobs()).toBe(before);
  });

  it('lk_api_paginate_all (visible only with the low-level tools) suggests too', async () => {
    const t = w.stack.newToken('paginate-discovery', 'read');
    const c = await w.stack.connect(t.token);
    const r = await w.stack.call(c, 'lk_api_paginate_all', { operationId: 'listResource' });
    expect(r.body.error.code).toBe('UNKNOWN_OPERATION');
    expect(r.body.error.didYouMean[0]).toBe('listResources');
  });
});
