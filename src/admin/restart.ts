/**
 * v3 F8 (ADR 0073 decision 7, owner-approved): "Restart the bridge" on the Settings page.
 *
 * The unit has `Restart=on-failure` (deploy/lk-bridge.service), so a clean exit would not come back. The restart is the
 * SIGTERM stop the bridge already has (no new requests or tool calls, every job parked at its next step boundary as the
 * engine's normal shutdown does, waits ended, HTTP and the database closed: `stopBridgeForRestart`), then an exit with
 * the dedicated code {@link RESTART_EXIT_CODE}, which systemd restarts. With `RestartForceExitStatus=75` in the unit it
 * is restarted whatever `Restart=` says; without it, `on-failure` restarts it anyway (75 is not a clean exit).
 *
 * It is the owner's request, not a failure: the log line before the exit says so, and the next start records
 * `bridge.restarted` ("restarted at the owner's request") from a marker written before the exit, which the Settings
 * page shows. Outside systemd (no `INVOCATION_ID` in the environment) nothing would start the bridge again, so the
 * button is disabled and says why.
 */
import type { Db } from '../db/open.js';

/** EX_TEMPFAIL: "try again". Not 0, so `Restart=on-failure` brings the bridge back. */
export const RESTART_EXIT_CODE = 75;

const REQUESTED = 'dash.restart_requested';
const LAST = 'dash.last_restart';

export interface LastRestart {
  readonly requestedAt: number;
  readonly by: string;
  /** When the bridge was back (this start), or null while it is still going down. */
  readonly backAt: number | null;
}

export interface RestartStatus {
  /** The button works: the bridge runs under systemd and the process can be stopped from here. */
  readonly available: boolean;
  /** Why it is not available (shown under the disabled button). */
  readonly reason: string | null;
  /** The last restart the owner asked for, if any. */
  readonly last: LastRestart | null;
  /** A restart is under way. */
  readonly inProgress: boolean;
}

export class RestartUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestartUnavailableError';
  }
}

export interface RestartControl {
  status(): RestartStatus;
  /**
   * Records the request, logs it, and starts the stop (after the current request has been answered). Throws
   * {@link RestartUnavailableError} when the bridge is not under systemd or nothing can stop it.
   */
  request(by: string): void;
  /** The stop-and-exit, attached by `createBridge` (which owns HTTP and the database). */
  attach(stop: () => Promise<void>): void;
}

export const NOT_UNDER_SYSTEMD =
  'The bridge is not running under systemd (its environment has no INVOCATION_ID), so nothing would start it again after it stopped. Restart it the way it was started.';

export function createRestartControl(o: {
  readonly db: Pick<Db, 'prepare'>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => number;
  readonly audit: (
    actor: string,
    action: string,
    target: string | null,
    before?: unknown,
    after?: unknown,
  ) => void;
  readonly log: { info(obj: object, msg: string): void };
  /** Defers the stop until the current request's reply is out (default: setTimeout 100 ms). */
  readonly defer?: (fn: () => void) => void;
}): RestartControl {
  const read = (key: string): unknown => {
    try {
      const r = o.db.prepare('SELECT value FROM runtime_settings WHERE key = ?').get(key) as
        { value: string } | undefined;
      return r ? (JSON.parse(r.value) as unknown) : undefined;
    } catch {
      return undefined;
    }
  };
  const write = (key: string, value: unknown) => {
    if (value === null) {
      o.db.prepare('DELETE FROM runtime_settings WHERE key = ?').run(key);
      return;
    }
    o.db
      .prepare(
        `INSERT INTO runtime_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'owner')
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), o.now());
  };

  // This start: a restart the owner asked for before the last exit is recorded as such, never as a failure.
  const pending = read(REQUESTED) as { at?: unknown; by?: unknown } | undefined;
  if (pending && typeof pending.at === 'number') {
    const last: LastRestart = {
      requestedAt: pending.at,
      by: typeof pending.by === 'string' ? pending.by : 'owner',
      backAt: o.now(),
    };
    write(LAST, last);
    write(REQUESTED, null);
    o.audit('system', 'bridge.restarted', null, undefined, {
      reason: 'restart requested by the owner',
      requestedAt: last.requestedAt,
      backAt: last.backAt,
    });
    o.log.info({ requestedAt: last.requestedAt }, 'restarted at the owner’s request');
  }

  let stop: (() => Promise<void>) | null = null;
  let inProgress = false;
  const underSystemd = (o.env.INVOCATION_ID ?? '').trim() !== '';

  const status = (): RestartStatus => {
    const last = read(LAST) as LastRestart | undefined;
    const reason = !underSystemd
      ? NOT_UNDER_SYSTEMD
      : stop === null
        ? 'This bridge process cannot stop itself from the dashboard (no restart handler).'
        : null;
    return {
      available: reason === null && !inProgress,
      reason: inProgress ? 'A restart is under way.' : reason,
      last: last && typeof last.requestedAt === 'number' ? last : null,
      inProgress,
    };
  };

  return {
    status,
    attach(fn) {
      stop = fn;
    },
    request(by) {
      const s = status();
      if (!s.available || stop === null) throw new RestartUnavailableError(s.reason ?? 'Not available.');
      inProgress = true;
      const at = o.now();
      write(REQUESTED, { at, by });
      o.audit(by, 'bridge.restart_requested', null, undefined, { exitCode: RESTART_EXIT_CODE });
      o.log.info({ by, exitCode: RESTART_EXIT_CODE }, 'restart requested by the owner');
      const run = stop;
      (o.defer ?? ((fn) => setTimeout(fn, 100).unref()))(() => {
        void run();
      });
    },
  };
}
