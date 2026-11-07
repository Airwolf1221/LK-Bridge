/**
 * Result size (item 8 of the chunk 2b integration pass): the DEFAULT (summary) results of the biggest everyday
 * reads stay comfortably under 20,000 tokens, estimated at 3.5 characters a token, measured on the whole text the
 * client receives (JSON plus the budget footer). Payloads are deliberately heavy: long names, tags, aliases,
 * properties and highlights on every item, and a page of 3,000 blocks.
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON tool results */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from './helpers.js';
import { specRespond } from './spec-mock.js';

const LIMIT_TOKENS = 20_000;
const tokens = (text: string) => Math.ceil(text.length / 3.5);
const words = (n: number, seed: number) =>
  Array.from({ length: n }, (_, i) => `word${(seed * 31 + i) % 997}`).join(' ');

const resource = (i: number) => ({
  id: `r${String(i).padStart(7, '0')}`,
  name: `Character ${i}: ${words(30, i)}`,
  tags: Array.from({ length: 20 }, (_, t) => `tag-${t}-${words(3, t)}`),
  aliases: Array.from({ length: 10 }, (_, a) => `Alias ${a} ${words(8, a)}`),
  iconGlyph: 'user',
  iconColor: '#aa3344',
  parentId: 'rparent0',
  rank: `a${i}`,
  isHidden: false,
  isLocked: false,
  isFullWidth: false,
  showPropertyBar: true,
  imageUrl: `https://assets.example/${'x'.repeat(200)}.png`,
  banner: { url: `https://assets.example/${'b'.repeat(200)}.png`, offset: 0.5 },
  permissions: { read: ['all'], write: ['owner', 'editors'] },
  documents: Array.from({ length: 5 }, (_, d) => ({ id: `d${i}_${d}`, name: `Doc ${d} ${words(10, d)}` })),
  properties: Array.from({ length: 15 }, (_, p) => ({ id: `p${p}`, name: `Prop ${p}`, value: words(40, p) })),
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
});

const blocks = Array.from({ length: 3_000 }, (_, i) =>
  i % 50 === 0
    ? { id: `u${i}`, kind: 'unsupported' }
    : {
        id: `b${i}`,
        kind: i % 7 === 0 ? 'heading' : 'paragraph',
        content: [{ text: words(60, i) }],
        children: i % 10 === 0 ? [{ id: `c${i}`, kind: 'paragraph', content: [{ text: words(30, i) }] }] : [],
      },
);

let stack: Stack;
let client: Client;
beforeAll(async () => {
  stack = await startStack({
    respond: specRespond({
      listResources: () => ({
        status: 200,
        body: {
          data: Array.from({ length: 100 }, (_, i) => resource(i)),
          hasMore: true,
          nextCursor: 'c'.repeat(200),
        },
      }),
      search: () => ({
        status: 200,
        body: {
          data: Array.from({ length: 100 }, (_, i) => ({
            resource: {
              ...resource(i),
              highlights: Array.from({ length: 5 }, (_, h) => ({ text: words(40, h) })),
            },
            document: { id: `d${i}`, name: `Doc ${words(10, i)}`, highlights: [{ text: words(80, i) }] },
          })),
        },
      }),
      getDocumentBlocks: () => ({
        status: 200,
        body: { id: 'dbig', version: 'v9', schema: 1, text: words(5_000, 1), blocks },
      }),
    }),
  });
  client = await stack.connect();
});
afterAll(() => stack.close());

const sizes: Record<string, number> = {};

describe('default results stay well under 20,000 tokens', () => {
  const cases = [
    [
      'getDocumentBlocks on a 3,000-block page',
      'getDocumentBlocks',
      { path: { resourceId: 'rbig', documentId: 'dbig' } },
    ],
    ['listResources at limit 100', 'listResources', { query: { limit: 100 } }],
    ['search at limit 100', 'search', { query: { q: 'dragon', limit: 100 } }],
  ] as const;
  for (const [label, operationId, params] of cases) {
    it(label, async () => {
      const r = await stack.call(client, 'lk_api_read', { operationId, params });
      expect(r.isError, r.text.slice(0, 500)).toBe(false);
      // Inline, not an artefact handle: the agent gets the summary itself.
      expect(r.body.status, label).toBe('succeeded');
      expect(r.body.result.count ?? r.body.result.blockCount).toBeGreaterThanOrEqual(100);
      const t = tokens(r.text);
      sizes[label] = t;
      // "Comfortably": at most half the limit.
      expect(t, `${label}: ${t} tokens`).toBeLessThan(LIMIT_TOKENS / 2);
      // And the full payload really was large (so the summary did the work).
      const full = await stack.call(client, 'lk_api_read', { operationId, params, detail: 'full' });
      expect(full.body.status === 'stored' || tokens(full.text) > t).toBe(true);
    });
  }

  it('reports the measured sizes', () => {
    expect(Object.keys(sizes)).toHaveLength(3);
    console.info('default result sizes (estimated tokens):', sizes);
  });
});
