/**
 * Owner commands for maintenance jobs, on the owner command layer pattern of `src/policy/commands.ts`: every function
 * takes `actor: 'owner'` first, every change writes an `audit_log` row and emits a `policy` event, and nothing here is
 * reachable from MCP (test/policy/no-agent-escalation.test.ts enumerates the registered tools).
 */
import type { PolicyStore } from '../policy/store.js';
import { MaintenanceError, type MaintenanceScheduler } from './scheduler.js';
import type { MaintenanceJobView, RunView } from './types.js';

export interface MaintenanceCommands {
  list(actor: 'owner'): MaintenanceJobView[];
  get(
    actor: 'owner',
    id: string,
  ): MaintenanceJobView & { history: ReturnType<MaintenanceScheduler['history']> };
  enable(actor: 'owner', id: string): MaintenanceJobView;
  disable(actor: 'owner', id: string): MaintenanceJobView;
  /** `null` restores the job's default schedule. */
  setSchedule(actor: 'owner', id: string, schedule: unknown): MaintenanceJobView;
  /** Starts a run and returns at once (the job is `running`); `done` settles when it has finished. */
  runNow(actor: 'owner', id: string): { job: MaintenanceJobView; done: Promise<RunView | null> };
}

function assertOwner(actor: unknown): asserts actor is 'owner' {
  if (actor !== 'owner') throw new MaintenanceError('NOT_OWNER', 'Only the owner can do this');
}

const brief = (j: MaintenanceJobView) => ({
  enabled: j.enabled,
  schedule: j.scheduleText,
  nextRunAt: j.nextRunAt,
});

export function createMaintenanceCommands(d: {
  scheduler: MaintenanceScheduler;
  store: PolicyStore;
}): MaintenanceCommands {
  const { scheduler, store } = d;
  const audit = (action: string, id: string, before?: unknown, after?: unknown) =>
    store.audit('owner', action, id, before, after);
  const commands: MaintenanceCommands = {
    list(actor) {
      assertOwner(actor);
      return scheduler.list();
    },
    get(actor, id) {
      assertOwner(actor);
      return { ...scheduler.get(id), history: scheduler.history(id) };
    },
    enable(actor, id) {
      assertOwner(actor);
      const before = scheduler.get(id);
      const after = scheduler.setEnabled(id, true);
      audit('maintenance.enable', id, brief(before), brief(after));
      return after;
    },
    disable(actor, id) {
      assertOwner(actor);
      const before = scheduler.get(id);
      const after = scheduler.setEnabled(id, false);
      audit('maintenance.disable', id, brief(before), brief(after));
      return after;
    },
    setSchedule(actor, id, schedule) {
      assertOwner(actor);
      const before = scheduler.get(id);
      const after = scheduler.setSchedule(id, schedule);
      audit('maintenance.set_schedule', id, { schedule: before.schedule }, { schedule: after.schedule });
      return after;
    },
    runNow(actor, id) {
      assertOwner(actor);
      const { done } = scheduler.runNow(id);
      audit('maintenance.run_now', id);
      return { job: scheduler.get(id), done };
    },
  };
  return Object.freeze(commands);
}
