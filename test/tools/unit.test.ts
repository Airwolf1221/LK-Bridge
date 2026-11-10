/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- parsed JSON */
import { describe, expect, it } from 'vitest';
import { ConfigError, loadToolsConfig } from '../../src/config/index.js';
import { mcpOrigin, project, summarise } from '../../src/mcp/tools/shape.js';
import type { McpToolContext } from '../../src/mcp/server.js';
import { sniffImageType, checkTargetUrl, UploadHttpError } from '../../src/mcp/tools/upload-http.js';
import { suggestOperations } from '../../src/mcp/tools/schemas.js';
import { operations } from '../../src/lk/registry.js';
import { BRIDGE_INSTRUCTIONS } from '../../src/mcp/tools/index.js';

describe('tools configuration', () => {
  it('has the documented defaults', () => {
    expect(loadToolsConfig({})).toEqual({
      upload: {
        maxBytes: 10 * 1024 * 1024,
        allowUrlSource: true,
        fetchTimeoutMs: 15_000,
        putTimeoutMs: 120_000,
      },
      resultMaxChars: 40_000,
      outboundExtraPorts: new Set(),
    });
  });
  it('parses OUTBOUND_EXTRA_PORTS_ALLOWLIST and refuses a malformed entry (v1.0.1)', () => {
    expect([
      ...loadToolsConfig({ OUTBOUND_EXTRA_PORTS_ALLOWLIST: 'images.example.org:8443' }).outboundExtraPorts,
    ]).toEqual(['images.example.org:8443']);
    expect(() => loadToolsConfig({ OUTBOUND_EXTRA_PORTS_ALLOWLIST: '*.example.org:8443' })).toThrow(
      /OUTBOUND_EXTRA_PORTS_ALLOWLIST/,
    );
  });
  it('reads overrides and rejects bad values by name only', () => {
    expect(
      loadToolsConfig({ UPLOAD_ALLOW_URL_SOURCE: 'false', UPLOAD_MAX_BYTES: '5000' }).upload,
    ).toMatchObject({
      allowUrlSource: false,
      maxBytes: 5000,
    });
    expect(() => loadToolsConfig({ UPLOAD_MAX_BYTES: 'lots' })).toThrow(ConfigError);
  });
});

describe('result shaping', () => {
  it('summarises block trees to an outline and counts, with unsupported ids', () => {
    const s = summarise('getDocumentBlocks', {
      id: 'd1',
      version: 'v9',
      schema: 1,
      text: 'x',
      blocks: [
        { id: 'b1', kind: 'heading', level: 2, content: [{ text: 'Title' }] },
        { id: 'b2', kind: 'bulletList', children: [{ id: 'b3', kind: 'unsupported' }] },
      ],
    }) as any;
    expect(s).toMatchObject({ version: 'v9', blockCount: 3, topLevelBlocks: 2, unsupportedBlockIds: ['b3'] });
    expect(s.outline[0]).toMatchObject({ id: 'b1', level: 2, text: 'Title' });
    expect(s).not.toHaveProperty('blocks');
  });
  it('summarises lists to scalar fields and counts', () => {
    const s = summarise('listResources', {
      data: [{ id: 'r1', name: 'N', tags: ['a', 'b'], documents: [{ id: 'd' }], banner: { url: 'x' } }],
      hasMore: true,
      nextCursor: 'c',
    }) as any;
    expect(s).toMatchObject({ count: 1, hasMore: true, nextCursor: 'c' });
    expect(s.items[0]).toEqual({
      id: 'r1',
      name: 'N',
      tags: ['a', 'b'],
      documents: '[1 items]',
      banner: '{…}',
    });
  });
  it('clips long strings', () => {
    expect((project({ text: 'x'.repeat(500) }) as { text: string }).text.length).toBeLessThan(130);
  });
  it('builds the engine origin from the request principal, and refuses without one', () => {
    const principal = { principalId: 'pat_abc', profile: 'claude-code', label: 'laptop (PAT)' };
    const caller = { kind: 'pat' as const, clientId: 'pat:pat_abc', scopes: [], tokenId: 'pat_abc' };
    expect(mcpOrigin({ caller, principal } as unknown as McpToolContext, 'lk_api_write')).toEqual({
      kind: 'mcp',
      client: 'pat:pat_abc',
      tool: 'lk_api_write',
      principal,
    });
    expect(() => mcpOrigin({ caller } as unknown as McpToolContext, 'lk_api_write')).toThrow(/not known/);
  });
  it('suggests close operation names', () => {
    expect(
      suggestOperations(
        'getDocumnt',
        operations.map((o) => o.operationId),
      )[0],
    ).toBe('getDocument');
  });
  it('tells agents what the plan requires', () => {
    for (const phrase of [
      'bridge_estimate',
      'get_bridge_guide',
      'get_markdown_guide',
      'loop',
      'waiting_budget',
      'proposal_captured',
      // v2 A1
      'list_projects',
      'a write must name its project',
    ]) {
      expect(BRIDGE_INSTRUCTIONS).toContain(phrase);
    }
  });
});

describe('image helpers', () => {
  it('recognises the four image formats by their first bytes', () => {
    expect(sniffImageType(Buffer.from('89504e470d0a1a0a00', 'hex'))).toBe('image/png');
    expect(sniffImageType(Buffer.from('ffd8ffe000', 'hex'))).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from('GIF89a....'))).toBe('image/gif');
    expect(sniffImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).toBe(
      'image/webp',
    );
    expect(sniffImageType(Buffer.from('<svg></svg>'))).toBeNull();
  });
  it('checks the shape of a target URL', () => {
    expect(() => checkTargetUrl('https://example.com/a')).not.toThrow();
    for (const bad of [
      'http://example.com/',
      'https://u:p@example.com/',
      'https://[::1]/',
      'https://127.0.0.1/',
      'https://169.254.169.254/',
      'ftp://x',
      'nonsense',
    ]) {
      expect(() => checkTargetUrl(bad), bad).toThrow(UploadHttpError);
    }
  });
});
