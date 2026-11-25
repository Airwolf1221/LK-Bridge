/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- parsed JSON */
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_IMAGE_SETTINGS,
  DEFAULT_SNAPSHOT_SETTINGS,
  loadToolsConfig,
} from '../../src/config/index.js';
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
      images: DEFAULT_IMAGE_SETTINGS,
      snapshots: DEFAULT_SNAPSHOT_SETTINGS,
      // v3 F7b (ADR 0071, D6): the art cache, beside the database, 500 MB.
      artCache: { dir: null, maxBytes: 500 * 1024 * 1024 },
      // v3 F6a.1 (ADR 0076 amendment 1, ADR 0061 amendment 1): the bulk accept's bound and the hang warnings.
      reftypeBulkMax: 500,
      indexClassifyBulkMax: 500,
      slowRequestWarnMs: 30_000,
      slowRequestRepeatMs: 60_000,
      eventLoopLagWarnMs: 2_000,
      memoryWarnFraction: 0.7,
      // v3 F7d (ADR 0077, A1): one groups call's limits.
      artCallMaxImages: 120,
      // v3 F10 (ADR 0078): CHRONOLOGY_CHECK_DELAY_MS.
      chronologyCheckDelayMs: 600000,
      artCallMaxGroups: 40,
    });
    expect(loadToolsConfig({ ART_CACHE_DIR: '/srv/art', ART_CACHE_MAX_MB: '20' }).artCache).toEqual({
      dir: '/srv/art',
      maxBytes: 20 * 1024 * 1024,
    });
    // v2 E1a (ADR 0042): the snapshot store's defaults (10 GiB minimum free space; every full snapshot for 30 days, then 8 weekly; 30 days of change snapshots), spelled out.
    expect(DEFAULT_SNAPSHOT_SETTINGS).toEqual({
      dataDir: null,
      minFreeBytes: 10 * 1024 ** 3,
      keepFullDays: 30,
      keepWeekly: 8,
      keepDays: 30,
      softDeleteDays: 30,
    });
    expect(
      loadToolsConfig({ SNAPSHOT_KEEP_FULL_DAYS: '14', SNAPSHOT_KEEP_WEEKLY: '4', SNAPSHOT_KEEP_DAYS: '7' })
        .snapshots,
    ).toMatchObject({ keepFullDays: 14, keepWeekly: 4, keepDays: 7 });
    expect(
      loadToolsConfig({ SNAPSHOT_MIN_FREE_GB: '2.5', SNAPSHOT_DIR: '/srv/snap' }).snapshots,
    ).toMatchObject({
      dataDir: '/srv/snap',
      minFreeBytes: Math.round(2.5 * 1024 ** 3),
    });
    // v2 D3 (ADR 0041): the image settings' defaults, spelled out.
    expect(DEFAULT_IMAGE_SETTINGS).toEqual({
      maxPixels: 100_000_000,
      maxFrames: 300,
      convertTimeoutMs: 60_000,
      convertConcurrency: 1,
      dataDir: null,
      ratePerPrincipalPerHour: 1000,
      ratePerIpPerHour: 60,
      bodyTimeoutMs: 120_000,
      idleTimeoutMs: 15_000,
      stagingReportDays: 30,
      // v3 F2 (ADR 0049 decision 10): unplaced staged images on the server, and the disk the image store keeps.
      stagingMaxDays: 90,
      stagingMinFreeBytes: 5 * 1024 ** 3,
      keptBytesRetentionDays: 90,
      archiveMaxEntries: 300,
      archiveMaxUncompressedBytes: 2 * 1024 ** 3,
      stagedMaxBytes: 5 * 1024 ** 3,
      assetHosts: ['assets.legendkeeper.com', 'assets2.legendkeeper.com'],
    });
    // v2 E5.2: the defaults apply only where LK_ASSET_HOSTS is unset; a set list is kept as it is.
    expect(loadToolsConfig({}).images.assetHosts).toEqual([
      'assets.legendkeeper.com',
      'assets2.legendkeeper.com',
    ]);
    expect(loadToolsConfig({ LK_ASSET_HOSTS: 'assets.legendkeeper.com' }).images.assetHosts).toEqual([
      'assets.legendkeeper.com',
    ]);
    expect(() => loadToolsConfig({ LK_ASSET_HOSTS: 'https://evil.example/x' })).toThrow(/LK_ASSET_HOSTS/);
    expect(
      loadToolsConfig({ LK_ASSET_HOSTS: 'Assets.LegendKeeper.com, cdn.example.org' }).images.assetHosts,
    ).toEqual(['assets.legendkeeper.com', 'cdn.example.org']);
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
