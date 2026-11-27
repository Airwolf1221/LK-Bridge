/**
 * v3 F6a.1 (ADR 0061 amendment 1): the next hang names itself (src/observability/watchdog.ts).
 *
 * - a request still running after 30 s is a warning (method, URL, tool name; never the body), again every 60 s while
 *   it runs (a fake clock);
 * - event-loop lag above the threshold is a warning naming what ran, with heap and RSS (an artificial block);
 * - RSS above 70% of MemoryHigh is a warning naming the running tasks (an injected cgroup value), read from the
 *   bridge's own cgroup;
 * - the watchdog thread speaks WHILE the event loop is blocked (the 24 November hang logged nothing for 20 minutes);
 * - the HTTP server and the MCP layer register each request and tool call; background tasks register through
 *   loggedTask.
 */
import { mkdtempSync, openSync, readFileSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Activities,
  Watchdog,
  processActivities,
  readMemoryHigh,
  type WatchdogSettings,
} from '../../src/observability/watchdog.js';
import { loggedTask } from '../../src/maintenance/task-log.js';
import { activityObserver } from '../../src/server.js';

const SETTINGS: WatchdogSettings = {
  slowRequestWarnMs: 30_000,
  slowRequestRepeatMs: 60_000,
  eventLoopLagWarnMs: 2_000,
  memoryWarnFraction: 0.7,
};
const MB = 1048576;

function capture() {
  const lines: { obj: Record<string, unknown>; msg: string; level: string }[] = [];
  return {
    lines,
    log: {
      warn: (obj: Record<string, unknown>, msg: string) => lines.push({ obj, msg, level: 'warn' }),
      info: (obj: Record<string, unknown>, msg: string) => lines.push({ obj, msg, level: 'info' }),
    },
  };
}

const stopped: Watchdog[] = [];
afterEach(async () => {
  for (const w of stopped.splice(0)) await w.stop();
});

describe('slow requests', () => {
  it('a request still running after 30 s is a warning, again every 60 s while it runs (fake clock)', () => {
    let now = 1_000_000;
    const activities = new Activities(() => now);
    const c = capture();
    const w = new Watchdog({
      log: c.log,
      settings: () => SETTINGS,
      activities,
      now: () => now,
      memoryHigh: () => null,
      lag: { max: () => 0, reset: () => undefined, stop: () => undefined },
    });
    const end = activities.begin('request', 'POST /api/admin/reference-types/bulk-accept', {
      method: 'POST',
      url: '/api/admin/reference-types/bulk-accept',
    });
    const tool = activities.begin('tool', 'tool arkona_reference_types', {
      method: 'POST',
      url: '/mcp',
      tool: 'arkona_reference_types',
    });
    now += 29_999;
    w.tick();
    expect(c.lines).toEqual([]);
    now += 1;
    w.tick();
    expect(c.lines.map((l) => [l.level, l.msg, l.obj])).toEqual([
      [
        'warn',
        'request still running',
        { kind: 'request', method: 'POST', url: '/api/admin/reference-types/bulk-accept', runningMs: 30_000 },
      ],
      [
        'warn',
        'request still running',
        { kind: 'tool', method: 'POST', url: '/mcp', tool: 'arkona_reference_types', runningMs: 30_000 },
      ],
    ]);
    now += 30_000;
    w.tick();
    expect(c.lines).toHaveLength(2); // not again before 60 s
    tool();
    now += 30_000;
    w.tick();
    expect(c.lines).toHaveLength(3);
    expect(c.lines[2]!.obj).toEqual({
      kind: 'request',
      method: 'POST',
      url: '/api/admin/reference-types/bulk-accept',
      runningMs: 90_000,
      repeat: true,
    });
    end();
    now += 120_000;
    w.tick();
    expect(c.lines).toHaveLength(3);
  });

  it('the threshold and the repeat are read on each check (registry settings, applies now)', () => {
    let now = 0;
    const activities = new Activities(() => now);
    const c = capture();
    let s = { ...SETTINGS };
    const w = new Watchdog({
      log: c.log,
      settings: () => s,
      activities,
      now: () => now,
      memoryHigh: () => null,
      lag: { max: () => 0, reset: () => undefined, stop: () => undefined },
    });
    activities.begin('request', 'GET /x', { method: 'GET', url: '/x' });
    now = 5_000;
    w.tick();
    expect(c.lines).toHaveLength(0);
    s = { ...s, slowRequestWarnMs: 5_000 };
    w.tick();
    expect(c.lines).toHaveLength(1);
  });
});

describe('event-loop lag', () => {
  it('a block the histogram lost (its sample discarded by the tick’s reset) is still warned of: the tick’s own lateness', async () => {
    // PR 106's CI run: when the first tick after a block ran before the histogram's overdue sample, its reset discarded
    // the block (about once in 15 blocks). A histogram that reports nothing is that case, every time.
    const c = capture();
    const w = new Watchdog({
      log: c.log,
      settings: () => ({ ...SETTINGS, eventLoopLagWarnMs: 150 }),
      activities: new Activities(),
      memoryHigh: () => null,
      lag: { max: () => 0, reset: () => undefined, stop: () => undefined },
      tickMs: 50,
    });
    stopped.push(w);
    w.start();
    await new Promise((r) => setTimeout(r, 120));
    const t0 = Date.now();
    while (Date.now() - t0 < 400) {
      // the block
    }
    await new Promise((r) => setTimeout(r, 150));
    const lag = c.lines.filter((l) => l.msg === 'event loop blocked');
    expect(lag).toHaveLength(1);
    expect((lag[0]!.obj as { lagMs: number }).lagMs).toBeGreaterThanOrEqual(300);
  });

  it('an artificial block above the threshold is a warning naming what ran, with heap and RSS', async () => {
    const activities = new Activities();
    const c = capture();
    const w = new Watchdog({
      log: c.log,
      settings: () => ({ ...SETTINGS, eventLoopLagWarnMs: 150 }),
      activities,
      memoryHigh: () => null,
      tickMs: 50,
    });
    stopped.push(w);
    w.start();
    await new Promise((r) => setTimeout(r, 120));
    const end = activities.begin('request', 'POST /api/admin/reference-types/decide', {
      method: 'POST',
      url: '/api/admin/reference-types/decide',
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 400) {
      // the block
    }
    end();
    await new Promise((r) => setTimeout(r, 150));
    const lag = c.lines.filter((l) => l.msg === 'event loop blocked');
    expect(lag.length).toBeGreaterThanOrEqual(1);
    const o = lag[0]!.obj as {
      lagMs: number;
      finished: { name: string }[];
      running: unknown[];
      memory: { heapUsedMb: number; rssMb: number };
    };
    expect(o.lagMs).toBeGreaterThanOrEqual(300);
    // The block ended with its request: the warning names it among what finished since the last sample.
    expect(o.finished.map((x) => x.name)).toContain('POST /api/admin/reference-types/decide');
    expect(o.memory.rssMb).toBeGreaterThan(0);
    expect(o.memory.heapUsedMb).toBeGreaterThan(0);
    // Below the threshold: nothing.
    const before = c.lines.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(c.lines.length).toBe(before);
  });

  it('the watchdog thread speaks while the event loop is still blocked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lkb-watchdog-'));
    const file = join(dir, 'out.log');
    const fd = openSync(file, 'w');
    try {
      const activities = new Activities();
      const c = capture();
      const w = new Watchdog({
        log: c.log,
        settings: () => ({ ...SETTINGS, eventLoopLagWarnMs: 200, slowRequestRepeatMs: 60_000 }),
        activities,
        memoryHigh: () => 1400 * MB,
        tickMs: 50,
        thread: true,
        threadFd: fd,
      });
      stopped.push(w);
      w.start();
      await new Promise((r) => setTimeout(r, 300)); // the thread is up and has the first heartbeat
      activities.begin('request', 'POST /api/admin/reference-types/bulk-accept', {
        method: 'POST',
        url: '/api/admin/reference-types/bulk-accept',
      });
      await new Promise((r) => setTimeout(r, 100)); // the begin reached the thread
      const t0 = Date.now();
      let seenDuringBlock = false;
      while (Date.now() - t0 < 1500) {
        if (!seenDuringBlock && Date.now() - t0 > 700)
          seenDuringBlock = readFileSync(file, 'utf8').includes('event loop blocked');
      }
      expect(seenDuringBlock).toBe(true);
      const line = JSON.parse(readFileSync(file, 'utf8').trim().split('\n')[0]!) as Record<string, unknown>;
      expect(line).toMatchObject({
        level: 40,
        source: 'watchdog-thread',
        msg: 'event loop blocked: the main thread has not answered',
        memoryHighMb: 1400,
      });
      expect(line.blockedMs).toBeGreaterThan(200);
      expect((line.running as { name: string }[]).map((x) => x.name)).toEqual([
        'POST /api/admin/reference-types/bulk-accept',
      ]);
      // Once only per block (the repeat is 60 s).
      expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('memory pressure', () => {
  it('RSS above 70% of MemoryHigh is a warning naming the running tasks (an injected cgroup value)', () => {
    let now = 0;
    let rss = 900 * MB;
    const activities = new Activities(() => now);
    const c = capture();
    const w = new Watchdog({
      log: c.log,
      settings: () => SETTINGS,
      activities,
      now: () => now,
      memory: () => ({ rss, heapUsed: 210 * MB }),
      memoryHigh: () => 1468006400, // the unit's MemoryHigh on 24 November (1,400 MiB)
      lag: { max: () => 0, reset: () => undefined, stop: () => undefined },
    });
    activities.begin('task', 'maintenance:tree-sweep', { project: 'proj_arkona' });
    w.tick();
    expect(c.lines).toEqual([]); // 900 MB < 980 MB
    rss = 1000 * MB;
    now += 1000;
    w.tick();
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0]).toEqual({
      level: 'warn',
      msg: 'memory pressure: RSS above 70% of MemoryHigh',
      obj: {
        rssMb: 1000,
        heapUsedMb: 210,
        memoryHighMb: 1400,
        fraction: 0.7,
        running: [{ kind: 'task', name: 'maintenance:tree-sweep', ms: 1000, project: 'proj_arkona' }],
      },
    });
    now += 60_000;
    w.tick();
    expect(c.lines).toHaveLength(1); // again only after five minutes
    now += 5 * 60_000;
    w.tick();
    expect(c.lines).toHaveLength(2);
    rss = 500 * MB;
    w.tick();
    expect(c.lines.at(-1)!.msg).toBe('memory pressure eased');
  });

  it('reads MemoryHigh from the bridge’s own cgroup, then the namespace root; `max` is none', () => {
    const files: Record<string, string> = {
      '/proc/self/cgroup': '0::/system.slice/lk-bridge.service\n',
      '/sys/fs/cgroup/system.slice/lk-bridge.service/memory.high': '1468006400\n',
    };
    const read = (p: string) => {
      const v = files[p];
      if (v === undefined) throw new Error('ENOENT');
      return v;
    };
    expect(readMemoryHigh(read)).toBe(1468006400);
    files['/sys/fs/cgroup/system.slice/lk-bridge.service/memory.high'] = 'max\n';
    expect(readMemoryHigh(read)).toBeNull();
    delete files['/sys/fs/cgroup/system.slice/lk-bridge.service/memory.high'];
    files['/proc/self/cgroup'] = '0::/\n';
    files['/sys/fs/cgroup/memory.high'] = '2000000000';
    expect(readMemoryHigh(read)).toBe(2000000000);
    expect(
      readMemoryHigh(() => {
        throw new Error('ENOENT');
      }),
    ).toBeNull();
  });
});

describe('what registers', () => {
  it('a background task registers through loggedTask while it runs', async () => {
    let seen: string[] = [];
    await loggedTask(undefined, 'maintenance:proposal-expiry', { project: 'p1' }, () => {
      seen = processActivities.running().map((a) => a.name);
    });
    expect(seen).toContain('maintenance:proposal-expiry');
    expect(processActivities.running().map((a) => a.name)).not.toContain('maintenance:proposal-expiry');
  });

  it('a tool call registers with its name (never its arguments) and is logged at debug when it starts', () => {
    const debug: [Record<string, unknown>, string][] = [];
    const ended: unknown[] = [];
    const o = activityObserver(
      { begin: () => (end) => ended.push(end) },
      { debug: (obj, msg) => debug.push([obj, msg]) },
    );
    const done = o.begin(
      'arkona_reference_types',
      { secret: 'never logged' },
      { principalId: null, profile: null, scope: null },
    );
    const a = processActivities.running().find((x) => x.name === 'tool arkona_reference_types')!;
    expect(a.fields).toEqual({ method: 'POST', url: '/mcp', tool: 'arkona_reference_types' });
    expect(debug).toEqual([[{ tool: 'arkona_reference_types' }, 'tool call started']]);
    done({});
    expect(ended).toHaveLength(1);
    expect(processActivities.running().some((x) => x.id === a.id)).toBe(false);
  });
});
