/**
 * Several mock LegendKeeper projects behind one base URL (v2 A1 tests). LegendKeeper answers every project at the same
 * address and tells them apart by the API key, so this front routes each request by its bearer key to that project's
 * own `MockLk`: each keeps its own rate windows (per-key tiers and its project tier), its own state model and its own
 * record of calls, exactly as two real projects with two keys would.
 */
import Fastify from 'fastify';
import type { MockLk } from './mock-lk.js';

const FORWARDED_REQUEST = ['authorization', 'idempotency-key', 'if-match', 'x-request-id', 'content-type'];

export class MultiMockLk {
  readonly app = Fastify({ logger: false });
  url = '';

  constructor(private readonly byKey: ReadonlyMap<string, MockLk>) {
    this.app.removeAllContentTypeParsers();
    this.app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    this.app.all('/api/v3/*', async (req, reply) => {
      const auth = req.headers.authorization ?? '';
      const key = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
      const target = this.byKey.get(key);
      if (!target) {
        return reply
          .code(401)
          .type('application/json')
          .send(JSON.stringify({ message: 'mock UNAUTHENTICATED', code: 'UNAUTHENTICATED' }));
      }
      const headers: Record<string, string> = {};
      for (const h of FORWARDED_REQUEST) {
        const v = req.headers[h];
        if (typeof v === 'string') headers[h] = v;
      }
      const res = await fetch(`${target.url}${req.url}`, {
        method: req.method,
        headers,
        ...(req.body instanceof Buffer && req.body.length > 0 ? { body: req.body } : {}),
      });
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        if (/^(x-ratelimit-|retry-after|x-request-id|idempotent-replay|content-type)/.test(k)) out[k] = v;
      });
      const text = await res.text();
      return reply
        .code(res.status)
        .headers(out)
        .send(text === '' ? undefined : text);
    });
  }

  async start(): Promise<string> {
    this.url = await this.app.listen({ port: 0, host: '127.0.0.1' });
    return this.url;
  }

  async stop(): Promise<void> {
    await this.app.close();
  }
}
