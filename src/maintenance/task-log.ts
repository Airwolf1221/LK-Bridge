/**
 * CR-2026-11-R3 (R3-65, the owner's follow-up): every scheduled or background task logs its start and its finish at info,
 * with the process's memory (the V8 heap used and the resident set, in MB, and how far each moved during the task), so a
 * step in the bridge's memory can be matched to the task that made it. The live report that asked for it: +74 MB between
 * 17:15 and 17:20, and not one request logged then.
 *
 *   {"task":"maintenance:tree-sweep","project":"…","memory":{"heapUsedMb":412,"rssMb":690},"msg":"task started"}
 *   {"task":"maintenance:tree-sweep","project":"…","outcome":"succeeded","ms":8123,
 *    "memory":{"heapUsedMb":420,"rssMb":702},"delta":{"heapUsedMb":8,"rssMb":12},"msg":"task finished"}
 *
 * A task that runs more often than once a minute (the budget sampler every 10 seconds, the instance heartbeat, a
 * dashboard stream's timers) is `quiet`: it logs its finish, with its start's figures, only when memory moved by 1 MB or
 * more during it, or when it failed; two lines every few seconds would bury everything else.
 *
 * v3 F6a.1 (ADR 0061 amendment 1): every task also registers with the process's activities for as long as it runs, so the
 * watchdog's slow-request, event-loop and memory warnings can name it (src/observability/watchdog.ts).
 */
import { processActivities } from '../observability/watchdog.js';

export interface TaskLogger {
  info(obj: Record<string, unknown>, msg: string): void;
}

/** The process's memory now, in MB: the V8 heap used and the resident set. */
export function memoryNow(): { heapUsedMb: number; rssMb: number } {
  const m = process.memoryUsage();
  return { heapUsedMb: Math.round(m.heapUsed / 1048576), rssMb: Math.round(m.rss / 1048576) };
}

export interface TaskLogOptions {
  /** A task that runs more often than once a minute: its finish only, and only when memory moved or it failed. */
  readonly quiet?: boolean;
}

/** Runs `fn` as the background task `task`, logging its start and finish (see the module comment). */
export async function loggedTask<T>(
  log: TaskLogger | undefined,
  task: string,
  fields: Record<string, unknown>,
  fn: () => Promise<T> | T,
  o: TaskLogOptions = {},
): Promise<T> {
  const done = processActivities.begin('task', task, taskFields(fields));
  try {
    if (!log) return await fn();
    return await logged(log, task, fields, fn, o);
  } finally {
    done();
  }
}

/** The fields an activity keeps: short plain values only (a project id, a trigger), never a payload. */
function taskFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields))
    if ((typeof v === 'string' && v.length <= 100) || typeof v === 'number' || typeof v === 'boolean')
      out[k] = v;
  return out;
}

async function logged<T>(
  log: TaskLogger,
  task: string,
  fields: Record<string, unknown>,
  fn: () => Promise<T> | T,
  o: TaskLogOptions,
): Promise<T> {
  const t0 = Date.now();
  const before = memoryNow();
  if (o.quiet !== true) log.info({ task, ...fields, memory: before }, 'task started');
  let outcome: 'succeeded' | 'failed' = 'succeeded';
  try {
    return await fn();
  } catch (e) {
    outcome = 'failed';
    throw e;
  } finally {
    const after = memoryNow();
    const delta = { heapUsedMb: after.heapUsedMb - before.heapUsedMb, rssMb: after.rssMb - before.rssMb };
    const moved = Math.abs(delta.heapUsedMb) >= 1 || Math.abs(delta.rssMb) >= 1;
    if (o.quiet !== true || moved || outcome === 'failed')
      log.info(
        {
          task,
          ...fields,
          outcome,
          ms: Date.now() - t0,
          memory: after,
          delta,
          ...(o.quiet === true ? { before } : {}),
        },
        'task finished',
      );
  }
}
