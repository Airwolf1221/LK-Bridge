// @vitest-environment jsdom
/**
 * CR-2026-11-R4 (ADR 0062 decision 1; the review's SE-42 and SE-43): which requests the dashboard sends as its own
 * (`X-LKB-Background: 1`: the bridge checks the session but does not count them as a use, so an idle open tab does not
 * keep it alive) and which are the owner's. The page's first load and the owner's own Refresh are the owner's; the
 * reload for the stream starting afresh, for a live event and for the page's own timer, and the session check after the
 * stream drops, are the dashboard's own; so is anything sent more than a minute after the owner's last input. The
 * bridge's side is test/auth/background-requests.test.ts.
 */
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_HEADER, OWNER_INPUT_MS, api, apiConfig, noteOwnerInput } from '../../ui/src/api';
import { defaultCheckSession } from '../../ui/src/stream';
import { baseRoutes, installApi, openStream, renderApp, useDom, type Api } from './helpers';

useDom();
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const NOW = Date.now();
const maintenance = {
  jobs: [
    {
      id: 'budget-sampler',
      name: 'Budget sampler',
      description: 'Stores one snapshot of the request budgets every 10 seconds.',
      implemented: true,
      writes: false,
      enabled: true,
      schedule: { kind: 'interval', everySeconds: 10 },
      scheduleText: 'Every 10 seconds',
      defaultSchedule: { kind: 'interval', everySeconds: 10 },
      scheduleOverridden: false,
      priority: 'P3',
      running: false,
      lastRun: null,
      nextRunAt: NOW + 6000,
      note: null,
    },
  ],
  schedulerEnabled: true,
  now: NOW,
};

/** Whether each `GET /maintenance` so far was sent as the dashboard's own. */
const marks = (a: Api) => a.find('GET', '/maintenance').map((c) => c.headers[BACKGROUND_HEADER] === '1');

describe("the dashboard's own requests are marked; the owner's are not", () => {
  it('the first load and Refresh are the owner’s; the reloads for the stream starting afresh and a live event are its own', async () => {
    noteOwnerInput(); // the page has just been opened
    const user = userEvent.setup();
    const a = installApi({ ...baseRoutes(), 'GET /maintenance': maintenance });
    renderApp('/ui/maintenance');
    expect(await screen.findByRole('heading', { level: 1, name: 'Maintenance Jobs' })).toBeInTheDocument();
    await waitFor(() => expect(marks(a)).toEqual([false]));
    // The stream says hello (it starts afresh): every page reloads, as the dashboard's own.
    const stream = await openStream();
    await waitFor(() => expect(marks(a)).toEqual([false, true]));
    expect(a.find('GET', '/projects').at(-1)!.headers[BACKGROUND_HEADER]).toBe('1');
    // An event on the stream (an agent's job, the owner's change elsewhere): its own.
    act(() => stream.emit('job', { id: 'job_agent', status: 'running', projectId: 'lkp_baisheng' }));
    await waitFor(() => expect(marks(a)).toEqual([false, true, true]));
    // The owner's Refresh: the owner's.
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(marks(a)).toEqual([false, true, true, false]));
  });

  it("the page's own timer is its own", async () => {
    noteOwnerInput();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const a = installApi({ ...baseRoutes(), 'GET /maintenance': maintenance });
    renderApp('/ui/maintenance');
    expect(await screen.findByRole('heading', { level: 1, name: 'Maintenance Jobs' })).toBeInTheDocument();
    await waitFor(() => expect(marks(a)).toEqual([false]));
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    await waitFor(() => expect(marks(a)).toEqual([false, true]));
  });

  it('the session check after the stream drops is its own', async () => {
    const seen: Record<string, string>[] = [];
    vi.stubGlobal('fetch', (_url: string, init: RequestInit = {}) => {
      seen.push(init.headers as Record<string, string>);
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    apiConfig.base = '';
    expect(await defaultCheckSession()).toBe(true);
    expect(seen[0]?.[BACKGROUND_HEADER]).toBe('1');
  });

  it("a minute after the owner's last input, whatever it sends is its own; a key or a click makes it the owner's again", async () => {
    const a = installApi({ 'GET /session': { authenticated: true } });
    const at = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
    noteOwnerInput();
    await api.get('/session');
    clock.mockReturnValue(at + OWNER_INPUT_MS + 1000);
    await api.get('/session');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    await api.get('/session');
    clock.mockReturnValue(at + 3 * OWNER_INPUT_MS);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await api.get('/session');
    expect(a.find('GET', '/session').map((c) => c.headers[BACKGROUND_HEADER] ?? null)).toEqual([
      null,
      '1',
      null,
      null,
    ]);
  });
});
