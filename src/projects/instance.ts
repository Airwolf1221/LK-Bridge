/**
 * One bridge process per database (ADR 0023). The bridge's locks are in-process, and LegendKeeper's If-Match is not a
 * reliable compare-and-swap (PLAN-v2 10.6), so two processes serving the same project could overlap writes to the same
 * page. Each database therefore names the one process allowed to serve it, in `bridge_instance` (migration 0600), with
 * a heartbeat; a second process is refused at start-up with the holder's pid, host and start time.
 *
 * A holder is taken over only when it is provably gone: on the same host, its pid no longer exists (a crash, then
 * systemd's restart) or it has not written a heartbeat for `staleMs`; on another host, its heartbeat is older than
 * `staleMs`. The same process may take over its own row (a runtime rebuilt in tests).
 */
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { Db } from '../db/open.js';

export class InstanceLockError extends Error {
  readonly code = 'INSTANCE_LOCKED';
  constructor(message: string) {
    super(message);
    this.name = 'InstanceLockError';
  }
}

interface Row {
  instance_id: string;
  pid: number;
  hostname: string;
  started_at: number;
  heartbeat_at: number;
}

export interface InstanceGuardOptions {
  readonly db: Db;
  readonly now?: () => number;
  /** How often the heartbeat is written (default 15 s). */
  readonly heartbeatMs?: number;
  /** A heartbeat older than this means the holder is gone (default 60 s). */
  readonly staleMs?: number;
  /** Test seams. */
  readonly pid?: number;
  readonly hostname?: string;
  readonly isAlive?: (pid: number) => boolean;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class InstanceGuard {
  readonly instanceId = randomBytes(8).toString('hex');
  private timer: NodeJS.Timeout | undefined;
  private held = false;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly host: string;

  constructor(private readonly o: InstanceGuardOptions) {
    this.now = o.now ?? Date.now;
    this.pid = o.pid ?? process.pid;
    this.host = o.hostname ?? hostname();
  }

  /** Claims the database for this process, or throws `InstanceLockError` naming the process that holds it. */
  acquire(): { readonly tookOver: Row | null } {
    const staleMs = this.o.staleMs ?? 60_000;
    const alive = this.o.isAlive ?? pidAlive;
    const result = this.o.db
      .transaction(() => {
        const row = this.o.db.prepare('SELECT * FROM bridge_instance WHERE slot = 1').get() as
          Row | undefined;
        const at = this.now();
        if (row && row.instance_id !== this.instanceId) {
          const fresh = at - row.heartbeat_at < staleMs;
          const sameProcess = row.hostname === this.host && row.pid === this.pid;
          const running = row.hostname === this.host ? alive(row.pid) && fresh : fresh;
          if (!sameProcess && running) {
            throw new InstanceLockError(
              `Another LK-Bridge process (pid ${row.pid} on ${row.hostname}, started ${new Date(row.started_at).toISOString()}) ` +
                'is serving this database. Exactly one bridge process may serve a database and its projects (ADR 0023): ' +
                'stop the other one first.',
            );
          }
        }
        this.o.db
          .prepare(
            `INSERT INTO bridge_instance (slot, instance_id, pid, hostname, started_at, heartbeat_at)
           VALUES (1, ?, ?, ?, ?, ?)
           ON CONFLICT (slot) DO UPDATE SET instance_id = excluded.instance_id, pid = excluded.pid,
             hostname = excluded.hostname, started_at = excluded.started_at, heartbeat_at = excluded.heartbeat_at`,
          )
          .run(this.instanceId, this.pid, this.host, at, at);
        return { tookOver: row && row.instance_id !== this.instanceId ? row : null };
      })
      .immediate();
    this.held = true;
    this.timer = setInterval(() => this.beat(), this.o.heartbeatMs ?? 15_000);
    this.timer.unref();
    return result;
  }

  private beat(): void {
    if (!this.held) return;
    try {
      this.o.db
        .prepare('UPDATE bridge_instance SET heartbeat_at = ? WHERE slot = 1 AND instance_id = ?')
        .run(this.now(), this.instanceId);
    } catch {
      // The database may be closing; the next start judges the holder by its pid and heartbeat.
    }
  }

  /** Gives the database up (clean shutdown). Safe to call twice. */
  release(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!this.held) return;
    this.held = false;
    try {
      this.o.db
        .prepare('DELETE FROM bridge_instance WHERE slot = 1 AND instance_id = ?')
        .run(this.instanceId);
    } catch {
      // Already closed: the row is judged stale by the next start.
    }
  }
}
