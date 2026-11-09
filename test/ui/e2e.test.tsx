/**
 * End to end, without a browser: the REAL bridge (auth, runtime, admin API, SSE stream) on a local port with a mock
 * LegendKeeper, and the REAL dashboard code in jsdom talking to it over HTTP, with a real EventSource-style stream.
 * A mock job runs while the Jobs, Budgets and Writers pages update live, and WRITERS_MAX changes without a restart.
 * (test/e2e/ repeats the key flows in a real browser; this one runs in `npm run ci`.)
 */
import { request } from 'node:http';
import type * as RTL from '@testing-library/react';
import type UserEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { apiConfig } from '../../ui/src/api';
import { App } from '../../ui/src/app';
import type { SourceFactory, SourceLike } from '../../ui/src/stream';
import type { SessionInfo } from '../../ui/src/types';
import { systemClock } from '../../src/lk/index.js';
import { LkModel } from '../jobs/lk-model.js';
import { PROJECT, PUBLIC_URL, startAdminStack, type AdminStack } from '../admin/helpers.js';

// Node environment on purpose: the bridge's own start-up code resolves file URLs with Node's `URL`, which a jsdom
// environment replaces. The bridge starts first; a jsdom window is installed afterwards for React and Testing Library.
let R: typeof RTL;
let userEvent: typeof UserEvent;
let screen: typeof RTL.screen;
let waitFor: typeof RTL.waitFor;
let within: typeof RTL.within;

const realFetch = globalThis.fetch;
let stack: AdminStack;
const model = new LkModel(() => systemClock.now());
model.seedResource('res1', {
  name: 'Kingdom',
  blocks: [{ kind: 'paragraph', content: [{ text: 'Hello' }] }],
});

/** An EventSource over node:http, sending the owner's cookie: what the browser does for the real dashboard. */
class NodeSource implements SourceLike {
  onerror: ((e: Event) => void) | null = null;
  onopen: ((e: Event) => void) | null = null;
  readyState = 0;
  private readonly handlers = new Map<string, ((e: MessageEvent<string>) => void)[]>();
  private req: ReturnType<typeof request>;
  constructor(path: string) {
    const u = new URL(stack.base);
    this.req = request(
      {
        host: u.hostname,
        port: u.port,
        path,
        headers: { cookie: stack.cookie, accept: 'text/event-stream' },
      },
      (res) => {
        this.readyState = 1;
        this.onopen?.(new Event('open'));
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buf += chunk;
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let event = 'message';
            let data = '';
            for (const line of raw.split('\n')) {
              if (line.startsWith('event: ')) event = line.slice(7);
              else if (line.startsWith('data: ')) data += line.slice(6);
            }
            if (data) for (const h of this.handlers.get(event) ?? []) h({ data } as MessageEvent<string>);
          }
        });
      },
    );
    this.req.on('error', () => undefined);
    this.req.end();
  }
  addEventListener(type: string, l: (e: MessageEvent<string>) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), l]);
  }
  close(): void {
    this.readyState = 2;
    this.req.destroy();
  }
}
const createSource: SourceFactory = (url) => new NodeSource(url);

beforeAll(async () => {
  stack = await startAdminStack({
    respond: model.respond,
    admin: { budgetPushMs: 100, streamHeartbeatMs: 500 },
  });
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: `${PUBLIC_URL}/ui/`,
    pretendToBeVisual: true,
  });
  const g = globalThis as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  // Everything else a component or Testing Library reaches for, except what Node already has (URL, fetch, …).
  for (const key of Object.getOwnPropertyNames(dom.window)) {
    if (key in g || key.startsWith('_')) continue;
    try {
      g[key] = (dom.window as unknown as Record<string, unknown>)[key];
    } catch {
      // read-only on this platform: skip
    }
  }
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  g.IS_REACT_ACT_ENVIRONMENT = true;
  R = await import('@testing-library/react');
  userEvent = (await import('@testing-library/user-event')).default;
  await import('@testing-library/jest-dom/vitest');
  ({ screen, waitFor, within } = R);
});
afterEach(() => R?.cleanup());
afterAll(async () => {
  vi.unstubAllGlobals();
  R?.cleanup();
  await stack?.close();
});

async function mount(path: string) {
  // The page's fetch() reaches the real bridge with the owner's cookie and the Origin a browser would send.
  // Only the page's own (relative) requests are redirected: the bridge's calls to the mock LegendKeeper share this global.
  vi.stubGlobal('fetch', (input: string | URL | Request, init: RequestInit = {}) =>
    typeof input === 'string' && input.startsWith('/')
      ? realFetch(`${stack.base}${input}`, {
          ...init,
          headers: { ...(init.headers as Record<string, string>), cookie: stack.cookie, origin: PUBLIC_URL },
        })
      : realFetch(input, init),
  );
  apiConfig.base = '';
  const sessionRes = await realFetch(`${stack.base}/api/admin/session`, {
    headers: { cookie: stack.cookie },
  });
  const session = (await sessionRes.json()) as SessionInfo;
  apiConfig.csrfToken = session.csrfToken;
  window.history.replaceState({}, '', path);
  return R.render(<App session={session} createSource={createSource} />);
}

const nav = (name: RegExp) =>
  within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name });

describe('a mock job runs while the pages update live', { timeout: 40_000 }, () => {
  it('Jobs, Budgets and Writers follow the job, and WRITERS_MAX changes without a restart', async () => {
    const user = userEvent.setup();
    // Hold LegendKeeper's block writes so the job stays visibly in flight.
    const release = stack.hold((m, u) => m === 'PUT' && /\/blocks/.test(u));
    await mount('/ui/jobs');
    await screen.findByText('Nothing is running or waiting.');
    await waitFor(
      () => expect(screen.getByRole('status', { name: 'Live updates: Live' })).toBeInTheDocument(),
      { timeout: 5000 },
    );

    const { jobId } = (await stack.runtime.engine.submit({
      project: PROJECT,
      kind: 'batch_ops',
      title: 'Live end-to-end job',
      origin: { kind: 'ui', tool: 'e2e' },
      steps: [1, 2, 3].map((i) => ({
        op: 'replaceDocumentBlocks',
        params: {
          path: { resourceId: 'res1', documentId: 'd_res1' },
          body: { blocks: [{ kind: 'paragraph', content: [{ text: `Step ${i}` }] }] },
        },
      })),
    })) as { jobId: string };

    // Jobs: the row appears by itself, running, with no progress yet.
    const row = await screen.findByRole('row', { name: /Live end-to-end job/ }, { timeout: 5000 });
    expect(within(row).getByText('0 / 3 steps')).toBeInTheDocument();

    // Writers: a slot is busy with it, and holds the document lock.
    await user.click(nav(/^Concurrent Writers/));
    await waitFor(() => expect(document.querySelector('[data-slot][data-state="busy"]')).not.toBeNull(), {
      timeout: 5000,
    });
    const busy = document.querySelector('[data-slot][data-state="busy"]') as HTMLElement;
    expect(busy).toHaveTextContent('replaceDocumentBlocks');
    expect(busy).toHaveTextContent('d_res1');
    expect(within(busy).getByRole('link', { name: 'Live end-to-end job' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Held locks/ })).toHaveTextContent(`${PROJECT}:doc:d_res1`); // v2 A1: locks are per project

    // WRITERS_MAX changes with no restart: the real pool and the page both follow.
    expect(stack.runtime.engine.writers.max).toBe(2);
    await user.selectOptions(screen.getByLabelText('Writer slots'), '3');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(stack.runtime.engine.writers.max).toBe(3), { timeout: 5000 });
    await waitFor(() => expect(document.querySelectorAll('[data-slot]')).toHaveLength(3), { timeout: 5000 });
    expect(stack.audit('writers.set_max').length).toBeGreaterThan(0);

    // The job moves while we look: release LegendKeeper and watch the rate and the gauges.
    release();
    await waitFor(
      () =>
        expect(
          stack.runtime.engine.queries.getJob(PROJECT, jobId)?.status,
          JSON.stringify(stack.runtime.engine.queries.getJob(PROJECT, jobId)?.lastError),
        ).toBe('succeeded'),
      { timeout: 10_000 },
    );
    await waitFor(
      () => expect(Number(screen.getByTestId('writes-per-minute').textContent)).toBeGreaterThanOrEqual(3),
      { timeout: 5000 },
    );

    // Budgets: the writes gauge shows what was used.
    await user.click(nav(/^Request Budgets/));
    const gauge = await screen.findByRole('region', { name: 'Writes per minute' });
    await waitFor(
      () => expect(gauge.querySelector('.gauge-figure')?.textContent).toMatch(/^[3-9]\d* \/ 120$/),
      { timeout: 5000 },
    );
    expect(screen.getByRole('region', { name: 'Image uploads' })).toHaveTextContent('reactive only');

    // Jobs again: the finished job is in History, succeeded, with all three steps done.
    await user.click(nav(/^Jobs/));
    await user.click(await screen.findByRole('button', { name: 'History' }));
    const done = await screen.findByRole('row', { name: /Live end-to-end job/ });
    expect(within(done).getByText('Succeeded')).toBeInTheDocument();
    expect(within(done).getByText('3 / 3 steps')).toBeInTheDocument();
    await stack.put('/api/admin/writers/max', { value: 2 });
  });

  it('shows a job’s progress moving step by step while it runs', async () => {
    const gate = stack.gate((m, u) => m === 'PUT' && /\/blocks/.test(u));
    await mount('/ui/jobs');
    await screen.findByText('Nothing is running or waiting.');
    await waitFor(
      () => expect(screen.getByRole('status', { name: 'Live updates: Live' })).toBeInTheDocument(),
      { timeout: 5000 },
    );
    const { jobId } = (await stack.runtime.engine.submit({
      project: PROJECT,
      kind: 'batch_ops',
      title: 'Step by step',
      origin: { kind: 'ui', tool: 'e2e' },
      steps: [1, 2, 3].map((i) => ({
        op: 'replaceDocumentBlocks',
        params: {
          path: { resourceId: 'res1', documentId: 'd_res1' },
          body: { blocks: [{ kind: 'paragraph', content: [{ text: `Gated ${i}` }] }] },
        },
      })),
    })) as { jobId: string };
    const row = () => screen.getByRole('row', { name: /Step by step/ });
    await screen.findByRole('row', { name: /Step by step/ }, { timeout: 5000 });
    for (const done of [0, 1, 2]) {
      await waitFor(() => expect(gate.waiting()).toBe(1), { timeout: 5000 }); // the next write is at LegendKeeper's door
      await waitFor(() => expect(within(row()).getByText(`${done} / 3 steps`)).toBeInTheDocument(), {
        timeout: 5000,
      });
      expect(within(row()).getByText('Running')).toBeInTheDocument();
      gate.releaseOne();
    }
    await waitFor(
      () => expect(stack.runtime.engine.queries.getJob(PROJECT, jobId)?.status).toBe('succeeded'),
      {
        timeout: 10_000,
      },
    );
    // It leaves the active list on its own.
    await waitFor(() => expect(screen.queryByRole('row', { name: /Step by step/ })).toBeNull(), {
      timeout: 5000,
    });
    gate.releaseAll();
  });
});
