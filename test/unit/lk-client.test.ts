import { describe, expect, it } from 'vitest';
import { defaultGovernorSettings } from '../../src/config/lk.js';
import { createLkClient } from '../../src/lk/client.js';
import { costSpecFor } from '../../src/lk/costs.js';
import { FakeClock } from '../../src/lk/governor/clock.js';
import { idempotencyKeyFor, isValidIdempotencyKey } from '../../src/lk/idempotency.js';
import { requireOperation } from '../../src/lk/registry.js';
import { json, rate } from './governor-helpers.js';

function client() {
  const clock = new FakeClock();
  const seen: { url: string; method: string; headers: Headers; body: unknown }[] = [];
  let reply = (): Response => json(200, { id: 'res1', name: 'A' }, rate(300, 299, clock.now() + 60_000));
  const c = createLkClient({
    apiKey: 'test-key-not-real',
    projectId: 'proj_test',
    baseUrl: 'http://mock-lk.test',
    governor: defaultGovernorSettings(),
    clock,
    transport: (input, init) => {
      seen.push({
        url: input instanceof Request ? input.url : input.toString(),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return Promise.resolve(reply());
    },
  });
  return { c, clock, seen, setReply: (r: () => Response) => (reply = r) };
}

describe('createLkClient', () => {
  it('routes SDK calls through the governor and captures rate headers', async () => {
    const { c, seen } = client();
    const res = await c.call({
      operationId: 'getResource',
      priority: 'P1',
      run: (sdk, signal) => sdk.resources.get({ projectId: c.projectId, resourceId: 'res1' }, { signal }),
    });
    expect(res).toMatchObject({ id: 'res1' });
    expect(seen[0]!.url).toBe('http://mock-lk.test/api/v3/projects/proj_test/resources/res1/');
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer test-key-not-real');
    expect(c.governor.snapshot().tiers['key-min'].used).toBe(1);
    expect(c.governor.snapshot().tiers['key-min'].drift).toMatchObject({ observedUsed: 1, delta: 0 });
  });

  it('sends the governor-owned Idempotency-Key on POST and never an SDK-generated one', async () => {
    const { c, seen, clock } = client();
    const create = (key?: string) =>
      c.call({
        operationId: 'createResource',
        priority: 'P2',
        jobId: 'job1',
        ...(key ? { idempotencyKey: key } : {}),
        run: (sdk, signal) => sdk.resources.create({ projectId: c.projectId }, { name: 'A', signal }),
      });
    await create(idempotencyKeyFor('job1', 4));
    const second = create();
    await clock.advance(1000);
    await second;
    expect(seen[0]!.headers.get('idempotency-key')).toBe('lkb.job1.4.0');
    expect(seen[1]!.headers.get('idempotency-key')).toBeNull();
  });

  it('refuses SDK use outside execute (GOVERNOR_BYPASS)', async () => {
    const { c, seen } = client();
    await expect(c.sdk.resources.get({ projectId: 'proj_test', resourceId: 'r' })).rejects.toMatchObject({
      cause: { code: 'GOVERNOR_BYPASS' },
    });
    expect(seen).toHaveLength(0);
  });

  it('allows exactly one LK request per call (no hidden pagination or composite helpers)', async () => {
    const { c } = client();
    await expect(
      c.call({
        operationId: 'getResource',
        priority: 'P1',
        run: async (sdk, signal) => {
          await sdk.resources.get({ projectId: c.projectId, resourceId: 'a' }, { signal });
          return sdk.resources.get({ projectId: c.projectId, resourceId: 'b' }, { signal });
        },
      }),
    ).rejects.toMatchObject({ code: 'ONE_REQUEST_PER_CALL', classification: 'bridge' });
  });

  it('refuses a versioned write without If-Match before sending anything', async () => {
    const { c, seen } = client();
    await expect(
      c.call({
        operationId: 'replaceDocumentBlocks',
        priority: 'P1',
        run: (sdk, signal) =>
          sdk.documents.replaceBlocks(
            { projectId: c.projectId, resourceId: 'r', documentId: 'd' },
            {
              blocks: [],
              signal,
            },
          ),
      }),
    ).rejects.toMatchObject({ code: 'IF_MATCH_REQUIRED' });
    expect(seen).toHaveLength(0);
    expect(c.governor.snapshot().tiers['write-min'].used).toBe(0); // refunded: nothing went out
  });

  it('maps SDK errors to BridgeLkError with the LK code and requestId', async () => {
    const { c, setReply } = client();
    setReply(() =>
      json(404, { code: 'NOT_FOUND', message: 'nope', requestId: 'body-id' }, { 'x-request-id': 'hdr-id' }),
    );
    await expect(
      c.call({
        operationId: 'getResource',
        priority: 'P1',
        run: (sdk, signal) => sdk.resources.get({ projectId: c.projectId, resourceId: 'x' }, { signal }),
      }),
    ).rejects.toMatchObject({
      name: 'BridgeLkError',
      code: 'NOT_FOUND',
      requestId: 'hdr-id',
      opId: 'getResource',
    });
  });

  it('costs createManyResources by item count', () => {
    const op = requireOperation('createManyResources');
    expect(costSpecFor(op, { body: { resources: [{}, {}, {}] } })).toEqual({ tiers: op.costs, items: 3 });
    expect(() => costSpecFor(op, { body: {} })).toThrow(/body.resources/);
    expect(costSpecFor(requireOperation('listResources')).tiers).not.toContain('write-min');
  });

  it('formats a budget footer', () => {
    const { c } = client();
    expect(c.budgetFooter()).toMatch(/^budget: writes 0\/120·min/);
  });
});

describe('idempotency keys', () => {
  it('derives lkb.{jobId}.{stepNo}.{attempt0} and validates it', () => {
    expect(idempotencyKeyFor('j_1', 0)).toBe('lkb.j_1.0.0');
    expect(idempotencyKeyFor('j_1', 7, 2)).toBe('lkb.j_1.7.2');
    expect(() => idempotencyKeyFor('bad id', 1)).toThrow();
    expect(() => idempotencyKeyFor('j', -1)).toThrow();
    expect(isValidIdempotencyKey('a'.repeat(255))).toBe(true);
    expect(isValidIdempotencyKey('a'.repeat(256))).toBe(false);
  });
});
