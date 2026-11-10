// Loaded with `node --import` (through NODE_OPTIONS; Node strips the types itself) by the sandbox wrapper tests (test/unit/sandbox-wrappers.test.ts),
// in every Node process the wrapper starts. It answers every request to LegendKeeper's host itself, so nothing ever
// leaves the machine, and logs each one as `<method> <path> <sha256 of the bearer token>`: never the token, so the test
// can prove WHICH key was sent without any key reaching a file or an output.
//
// LKB_TEST_FETCH_MODE: `refuse` answers 401 to everything (the key check fails: the script stops after the first call);
// `world` answers as a small read-only test world (listProjects, listResources, getDocumentBlocks), for the round trip.
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const LOG = process.env.LKB_TEST_FETCH_LOG;
const MODE = process.env.LKB_TEST_FETCH_MODE ?? 'refuse';
const PROJECT = process.env.LKB_TEST_FETCH_PROJECT ?? 'lkp_test';
const realFetch = globalThis.fetch;

const para = (id: string, text: string) => ({ id, kind: 'paragraph', content: [{ text }] });
const WORLD = [
  { id: 'rootres1', name: 'AI REPOSITORY', parentId: null, doc: 'd0000001', blocks: [] },
  {
    id: 'page0001',
    name: 'A page',
    parentId: 'rootres1',
    doc: 'd0000002',
    blocks: [para('p0000001', 'Hello from the test world.')],
  },
];

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-request-id': `fake-${Math.random().toString(36).slice(2)}`,
    },
  });

function answer(method: string, path: string): Response {
  if (MODE !== 'world')
    return json(401, { code: 'UNAUTHORIZED', message: 'fake: refused', requestId: 'fake' });
  if (method !== 'GET') return json(500, { code: 'INTERNAL', message: 'fake: read-only', requestId: 'fake' });
  const p = path.replace(/\/$/, '');
  if (p === '/api/v3/projects')
    return json(200, { data: [{ id: PROJECT, name: 'Test world' }], hasMore: false, nextCursor: null });
  if (/^\/api\/v3\/projects\/[^/]+\/resources$/.test(p)) {
    const data = WORLD.map((r) => ({
      id: r.id,
      name: r.name,
      parentId: r.parentId,
      rank: 'a0',
      tags: [],
      aliases: [],
      documents: [{ id: r.doc, name: 'Main', type: 'page' }],
    }));
    return json(200, { data, hasMore: false, nextCursor: null });
  }
  const m = /^\/api\/v3\/projects\/[^/]+\/resources\/([^/]+)\/docs\/([^/]+)\/blocks$/.exec(p);
  const r = m && WORLD.find((x) => x.id === m[1] && x.doc === m[2]);
  if (r) return json(200, { id: r.doc, version: 'v1', schema: 1, text: '', blocks: r.blocks });
  return json(404, { code: 'NOT_FOUND', message: 'fake: not found', requestId: 'fake' });
}

globalThis.fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== 'www.legendkeeper.com') return realFetch(input, init);
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  const token = (headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (LOG)
    appendFileSync(LOG, `${method} ${url.pathname} ${createHash('sha256').update(token).digest('hex')}\n`);
  return answer(method, url.pathname);
};
