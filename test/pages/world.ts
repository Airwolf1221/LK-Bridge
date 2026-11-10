/**
 * The test world for write_page (v2 C1): B2's discover world (the REAL server, runtime, MCP transport and policy, with
 * chunk 1's mock LegendKeeper behind it), with B1's real-page fixtures on some of its pages and hooks that let a test
 * play "someone else" editing a page at an exact moment: right after the bridge's plan read, or right after its write.
 */
import type { MockRequest, MockResponse } from '../contract/mock-lk.js';
import { discoverWorld, type DiscoverWorld } from '../discover/world.js';
import { bsrcPage, fourthAgeTablePage, richPage } from '../markdown/fixtures.js';
import type { LkBlock } from '../../src/markdown/index.js';

export interface PagesWorld extends DiscoverWorld {
  /** The Main document id of a page of the world, by its key in `ids` (or the page id). */
  doc(page: string): string;
  /** Sets a page's blocks and version (the mock answers `v<version>`). */
  setPage(page: string, blocks: readonly LkBlock[], version?: number): string;
  /** What LegendKeeper (the mock) holds now. */
  stored(page: string): { version: string; blocks: LkBlock[] };
  /** An edit made outside the bridge (the version goes up, as LegendKeeper's does). */
  outsideEdit(page: string, edit: (blocks: LkBlock[]) => void): void;
  /** Requests to a document's blocks, in order: `GET plan`, `GET lock`, `PUT`, `GET verify`… with the request id. */
  blockRequests(page: string): { method: string; requestId: string; ifMatch?: string; body?: unknown }[];
  /**
   * Runs `fn` right after the n-th answered request (0-based) to a page's blocks that matches `method`, once. The
   * answer was computed before `fn` runs, so `fn` changes what LATER requests see.
   */
  after(page: string, method: 'GET' | 'PUT', n: number, fn: () => void): void;
  /** Answers every PUT to a page's blocks with this status and body instead (for failures), until cleared. */
  failPuts(page: string, response: MockResponse | null): void;
}

export const FIXTURE_PAGES = {
  /** [BSRC] Asagiri Kaede: B1's [BSRC] article. */
  article: 'kaede001',
  /** [INDEX] Qishen: B1's page with an infobox, a collection, an inline icon and an unsupported block. */
  rich: 'qishen01',
  /** The Fourth Age table page: B1's 335-row table page. */
  fourthAge: 'age40001',
} as const;

export async function pagesWorld(o: Parameters<typeof discoverWorld>[0] = {}): Promise<PagesWorld> {
  const hooks: { page: string; method: string; n: number; fn: () => void; seen: number }[] = [];
  const log = new Map<string, { method: string; requestId: string; ifMatch?: string; body?: unknown }[]>();
  const fails = new Map<string, MockResponse>();
  const world: DiscoverWorld = await discoverWorld({ bulk: 60, ageRows: 30, ...o });
  const docOf = (page: string): string => {
    const id = world.ids[page] ?? page;
    const r = world.repo.live(id);
    if (!r) throw new Error(`no page ${page}`);
    const main = world.repo.liveDocs(r).find((d) => d.name === 'Main');
    if (!main) throw new Error(`${page} has no Main`);
    return main.id;
  };
  // Consulted before the world's own answers (DiscoverWorld.overrides): every request to a page's blocks.
  world.overrides.set(/\/resources\/[^/]+\/docs\/[^/]+\/blocks$/, (req: MockRequest) => {
    const m = /\/resources\/([^/]+)\/docs\/([^/]+)\/blocks\/?$/.exec(req.path);
    if (!m) return undefined;
    const page = m[1]!;
    const list = log.get(page) ?? [];
    list.push({
      method: req.method,
      requestId: String(req.headers['x-request-id'] ?? ''),
      ...(req.headers['if-match'] ? { ifMatch: req.headers['if-match'] } : {}),
      ...(req.method === 'PUT' ? { body: structuredClone(req.body) } : {}),
    });
    log.set(page, list);
    const fail = fails.get(page);
    if (req.method === 'PUT' && fail) return fail;
    // Answer now, then run the hooks that wait for this request.
    const answer = world.repo.respond(req);
    for (const h of hooks) {
      if (h.page !== page || h.method !== req.method) continue;
      if (h.seen++ === h.n) h.fn();
    }
    return answer;
  });
  // The fixtures, on pages of the world.
  const w = world as PagesWorld;
  w.doc = docOf;
  w.setPage = (page, blocks, version = 1) => {
    const d = docOf(page);
    world.repo.blocks.set(d, { version, blocks: structuredClone(blocks) as unknown[] });
    return d;
  };
  w.stored = (page) => {
    const b = world.repo.blocks.get(docOf(page))!;
    return { version: `v${b.version}`, blocks: structuredClone(b.blocks) as LkBlock[] };
  };
  w.outsideEdit = (page, edit) => {
    const b = world.repo.blocks.get(docOf(page))!;
    edit(b.blocks as LkBlock[]);
    b.version++;
  };
  w.blockRequests = (page) => [...(log.get(world.ids[page] ?? page) ?? [])];
  w.after = (page, method, n, fn) => {
    hooks.push({ page: world.ids[page] ?? page, method, n, fn, seen: 0 });
  };
  w.failPuts = (page, response) => {
    const id = world.ids[page] ?? page;
    if (response) fails.set(id, response);
    else fails.delete(id);
  };
  w.setPage(FIXTURE_PAGES.article, bsrcPage());
  w.setPage(FIXTURE_PAGES.rich, richPage());
  w.setPage(FIXTURE_PAGES.fourthAge, fourthAgeTablePage(335));
  return w;
}

/** The plain text of a block's runs. */
export const textOf = (b: unknown): string =>
  (((b as { content?: { text?: string }[] } | undefined)?.content ?? []) as { text?: string }[])
    .map((r) => r.text ?? '')
    .join('');
