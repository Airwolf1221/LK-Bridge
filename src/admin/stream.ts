/**
 * The dashboard's live stream (`GET /api/admin/stream`): one Server-Sent Events connection per open dashboard,
 * carrying the engine's events (jobs, steps, locks, writers, errors, controls), the policy layer's (`policy`,
 * `proposal`), the governor's (`throttled`, `budget-wait`) and a periodic `budget` snapshot.
 *
 * Reconnection. Every buffered event has an id `<boot>-<n>`. A browser that reconnects sends `Last-Event-ID`; if that
 * position is still in the replay buffer (same server run, nothing evicted) the missed events are replayed after a
 * `hello` with `resumed: true`. Otherwise (a restart, or too long away) it receives a `resync` event and refetches what
 * it shows. Budget snapshots and heartbeats carry no id and are never replayed.
 *
 * Heartbeats are real `heartbeat` events, so the page can tell a dead connection from a quiet one, and each tick also
 * re-checks the owner's session: a signed-out dashboard receives `unauthenticated` and the stream ends.
 */
import { randomBytes } from 'node:crypto';
import type { AdminSettings } from '../config/index.js';
import type { JobEngine } from '../jobs/index.js';
import type { LkClient } from '../lk/index.js';
import type { ProjectRegistry } from '../projects/index.js';
import { redactDeep } from './redact.js';

export interface StreamClient {
  /** Writes a frame; false when the connection is too far behind (it is then dropped). */
  write(frame: string): boolean;
  end(): void;
  /** Whether the owner's session is still valid. */
  alive(): boolean;
}

interface Buffered {
  readonly id: number;
  readonly frame: string;
}

export function budgetPayload(lk: LkClient) {
  const snapshot = lk.governor.snapshot();
  return { snapshot, writesPerMinute: snapshot.tiers['write-min'].used };
}

/** Every project's budget, by LegendKeeper id (each project has its own governor, v2 A1). */
export function allBudgets(projects: Pick<ProjectRegistry, 'clients'>) {
  const out: Record<string, ReturnType<typeof budgetPayload> & { name: string }> = {};
  for (const c of projects.clients()) out[c.id] = { name: c.name, ...budgetPayload(c.client) };
  return { projects: out };
}

export class StreamHub {
  readonly bootId = randomBytes(4).toString('hex');
  private nextId = 1;
  private buffer: Buffered[] = [];
  private readonly clients = new Set<StreamClient>();
  private readonly offs: (() => void)[] = [];
  private heartbeat: NodeJS.Timeout | undefined;
  private budgetTimer: NodeJS.Timeout | undefined;
  private closed = false;

  /** Governors whose events are relayed (a project's governor appears when its key is first verified). */
  private readonly governors = new Map<string, () => void>();

  constructor(
    private readonly engine: JobEngine,
    private readonly projects: ProjectRegistry,
    private readonly settings: AdminSettings,
    private readonly now: () => number = Date.now,
  ) {
    const e = engine.events;
    this.offs.push(
      e.on('job', (x) => this.publish('job', x)),
      e.on('step', (x) => this.publish('step', x)),
      e.on('lock', (x) => this.publish('lock', x)),
      e.on('writers', (x) => this.publish('writers', x)),
      e.on('error', (x) => this.publish('error', x)),
      e.on('controls', (x) => this.publish('controls', x)),
      e.on('policy', (x) => this.publish('policy', x)),
      e.on('proposal', (x) => this.publish('proposal', x)),
      // v2 A1: a project's status or flags changed (verified, stopped, read-only).
      projects.onChange((v) => {
        this.watchGovernors();
        this.publish('project', v);
      }),
    );
    this.watchGovernors();
  }

  /** Relays every project's governor events, each tagged with its project. */
  private watchGovernors(): void {
    for (const c of this.projects.clients()) {
      if (this.governors.has(c.id)) continue;
      const g = c.client.governor;
      const a = g.on('throttled', (x) => this.publish('throttled', { projectId: c.id, ...x }));
      const b = g.on('budget-wait', (x) => this.publish('budget-wait', { projectId: c.id, ...x }));
      this.governors.set(c.id, () => {
        a();
        b();
      });
    }
  }

  get lastId(): number {
    return this.nextId - 1;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private frame(event: string, data: unknown, id?: string): string {
    const body = JSON.stringify(redactDeep({ at: this.now(), data }, { maxString: 4000 }));
    return `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${body}\n\n`;
  }

  /** A buffered, replayable event. */
  publish(event: string, data: unknown): void {
    if (this.closed) return;
    const id = this.nextId++;
    const frame = this.frame(event, data, `${this.bootId}-${id}`);
    this.buffer.push({ id, frame });
    const max = this.settings.streamReplayEvents;
    if (this.buffer.length > max) this.buffer.splice(0, this.buffer.length - max);
    this.broadcast(frame);
  }

  /** A live-only event (no id, not replayed). */
  ephemeral(event: string, data: unknown): void {
    if (!this.closed) this.broadcast(this.frame(event, data));
  }

  private broadcast(frame: string): void {
    for (const c of this.clients) this.send(c, frame);
  }

  private send(c: StreamClient, frame: string): void {
    const ok = (() => {
      try {
        return c.write(frame);
      } catch {
        return false;
      }
    })();
    if (!ok) this.detach(c, true);
  }

  /** Adds a connection. `lastEventId` is the browser's `Last-Event-ID`, when it reconnects. */
  attach(c: StreamClient, lastEventId: string | undefined): void {
    if (this.closed) {
      c.end();
      return;
    }
    const resume = this.resumePoint(lastEventId);
    this.send(c, `retry: 3000\n\n`);
    if (resume === 'resync') {
      this.send(
        c,
        this.frame('resync', { reason: 'position_unavailable', bootId: this.bootId, lastId: this.lastId }),
      );
    } else {
      this.send(
        c,
        this.frame('hello', {
          bootId: this.bootId,
          lastId: this.lastId,
          resumed: resume !== null,
          heartbeatMs: this.settings.streamHeartbeatMs,
        }),
      );
      if (resume !== null) for (const b of this.buffer) if (b.id > resume) this.send(c, b.frame);
    }
    this.send(c, this.frame('budget', allBudgets(this.projects)));
    this.clients.add(c);
    this.startTimers();
  }

  /** `null`: a fresh connection. A number: replay events after it. `'resync'`: the position cannot be honoured. */
  private resumePoint(lastEventId: string | undefined): number | null | 'resync' {
    if (lastEventId === undefined || lastEventId === '') return null;
    const m = /^([0-9a-f]{8})-(\d{1,15})$/.exec(lastEventId);
    if (!m || m[1] !== this.bootId) return 'resync';
    const n = Number(m[2]);
    if (n > this.lastId) return 'resync';
    if (n === this.lastId) return n;
    const oldest = this.buffer[0]?.id;
    return oldest !== undefined && oldest <= n + 1 ? n : 'resync';
  }

  detach(c: StreamClient, end = false): void {
    this.clients.delete(c);
    if (end) {
      try {
        c.end();
      } catch {
        // already closed
      }
    }
    if (this.clients.size === 0) this.stopTimers();
  }

  private startTimers(): void {
    this.heartbeat ??= setInterval(() => this.tick(), this.settings.streamHeartbeatMs);
    this.budgetTimer ??= setInterval(
      () => this.ephemeral('budget', allBudgets(this.projects)),
      this.settings.budgetPushMs,
    );
    this.heartbeat.unref();
    this.budgetTimer.unref();
  }

  private stopTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.budgetTimer) clearInterval(this.budgetTimer);
    this.heartbeat = undefined;
    this.budgetTimer = undefined;
  }

  private tick(): void {
    for (const c of [...this.clients]) {
      const alive = (() => {
        try {
          return c.alive();
        } catch {
          return false;
        }
      })();
      if (!alive) {
        this.send(c, this.frame('unauthenticated', { reason: 'session_ended' }));
        this.detach(c, true);
      } else {
        this.send(c, this.frame('heartbeat', { lastId: this.lastId }));
      }
    }
  }

  /** Ends every connection and stops listening to the engine (server shutdown). */
  close(): void {
    this.closed = true;
    for (const off of this.offs) off();
    this.offs.length = 0;
    for (const off of this.governors.values()) off();
    this.governors.clear();
    for (const c of [...this.clients]) this.detach(c, true);
    this.stopTimers();
  }
}
