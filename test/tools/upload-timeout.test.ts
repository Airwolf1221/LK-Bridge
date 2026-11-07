/**
 * UPLOAD_PUT_TIMEOUT_MS: the signed-URL PUT has its own per-attempt deadline (default 120 s), validated at start-up,
 * instead of the governor's 30-second LegendKeeper request timeout.
 */
import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_TOOLS_SETTINGS, loadToolsConfig } from '../../src/config/index.js';
import type { CustomStepHandler } from '../../src/jobs/index.js';
import type { ExecuteRequest } from '../../src/lk/governor/types.js';
import { createUploadPutHandler, DEFAULT_UPLOAD_PUT_TIMEOUT_MS } from '../../src/mcp/tools/upload-step.js';
import { setup, track } from '../unit/governor-helpers.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('UPLOAD_PUT_TIMEOUT_MS', () => {
  it('defaults to 120 s and is validated at start-up', () => {
    expect(loadToolsConfig({}).upload.putTimeoutMs).toBe(120_000);
    expect(DEFAULT_TOOLS_SETTINGS.upload.putTimeoutMs).toBe(120_000);
    expect(DEFAULT_UPLOAD_PUT_TIMEOUT_MS).toBe(120_000);
    expect(loadToolsConfig({ UPLOAD_PUT_TIMEOUT_MS: '300000' }).upload.putTimeoutMs).toBe(300_000);
    for (const bad of ['1000', '600001', 'soon', '1.5']) {
      expect(() => loadToolsConfig({ UPLOAD_PUT_TIMEOUT_MS: bad }), bad).toThrow(ConfigError);
    }
    try {
      loadToolsConfig({ UPLOAD_PUT_TIMEOUT_MS: 'soon' });
    } catch (e) {
      expect((e as Error).message).toContain('UPLOAD_PUT_TIMEOUT_MS');
      expect((e as Error).message).not.toContain('soon');
    }
  });

  async function putRequest(opts: Parameters<typeof createUploadPutHandler>[0]) {
    const seen: ExecuteRequest<Response>[] = [];
    const handler: CustomStepHandler = createUploadPutHandler({
      ...opts,
      guard: { resolve: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]) },
    });
    await handler({
      params: {
        body: { contentType: 'image/png', contentLength: PNG.length, dataBase64: PNG.toString('base64') },
      },
      resultOf: () => ({ uploadUrl: 'https://storage.example/put?sig=x', method: 'PUT', headers: {} }),
      replaceParams: () => undefined,
      priority: 'P1',
      jobId: 'job_1',
      lk: {
        governor: {
          execute: (req: ExecuteRequest<Response>) => {
            seen.push(req);
            return Promise.resolve(new Response(null, { status: 200 }));
          },
        },
        fetch: () => Promise.resolve(new Response(null, { status: 200 })),
      },
    } as unknown as Parameters<CustomStepHandler>[0]);
    return seen[0]!;
  }

  it('the PUT step asks the governor for its own deadline', async () => {
    expect((await putRequest({})).timeoutMs).toBe(120_000);
    expect((await putRequest({ putTimeoutMs: 300_000 })).timeoutMs).toBe(300_000);
    expect((await putRequest({ putTimeoutMs: 300_000 })).kind).toBe('upload');
  });

  it('the governor honours a per-call deadline instead of requestTimeoutMs', async () => {
    const hang = (env: ReturnType<typeof setup>) =>
      env.setResponder((req, i) =>
        i === 0
          ? new Promise<Response>((_, reject) =>
              req.signal?.addEventListener('abort', () => reject(req.signal?.reason as Error)),
            )
          : new Response('{}', { status: 200 }),
      );
    // Longer than the 30 s default: not aborted at 30 s, aborted at 120 s.
    const env = setup({ requestTimeoutMs: 30_000 });
    hang(env);
    const p = track(env.call({ timeoutMs: 120_000 }));
    await env.clock.advance(30_001);
    expect(env.seen[0]!.signal?.aborted).toBe(false);
    await env.clock.advance(90_000);
    expect(env.seen[0]!.signal?.aborted).toBe(true);
    await env.clock.advance(2_000);
    expect(p.done && !p.error).toBe(true);
    // Without one, the governor's own timeout still applies.
    const env2 = setup({ requestTimeoutMs: 30_000 });
    hang(env2);
    track(env2.call());
    await env2.clock.advance(30_000);
    expect(env2.seen[0]!.signal?.aborted).toBe(true);
  });
});
