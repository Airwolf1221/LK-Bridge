/**
 * Harness for the maintenance tests: the policy rig (FakeClock, mock LK with a stateful model, SQLite in a temp file,
 * the real policy layer) with a maintenance scheduler mounted on top. `mount` is called again after `rig.restart()`
 * to simulate a restart: the new scheduler reads the state the old one left in SQLite.
 */
import { defaultMaintenanceSettings, type MaintenanceSettings } from '../../src/config/index.js';
import { createMaintenance, type Maintenance, type MaintenanceJobDef } from '../../src/maintenance/index.js';
import { policyRig, type PolicyRig } from '../policy/helpers.js';

export interface MaintenanceRig {
  readonly rig: PolicyRig;
  maintenance: Maintenance;
  /** Mounts (and starts) a scheduler on the rig's current engine and policy; call after `rig.restart()`. */
  mount(o?: {
    extraJobs?: MaintenanceJobDef[];
    settings?: Partial<MaintenanceSettings>;
    start?: boolean;
  }): Maintenance;
  close(): Promise<void>;
}

export async function maintenanceRig(
  o: {
    extraJobs?: MaintenanceJobDef[];
    settings?: Partial<MaintenanceSettings>;
    start?: boolean;
    rig?: Parameters<typeof policyRig>[0];
  } = {},
): Promise<MaintenanceRig> {
  const rig = await policyRig({ externalExpirySweep: true, ...o.rig });
  const m: MaintenanceRig = {
    rig,
    maintenance: undefined as unknown as Maintenance,
    mount(mo = {}) {
      m.maintenance = createMaintenance({
        db: rig.db,
        engine: rig.e.engine,
        lk: rig.e.lk,
        policy: rig.policy,
        clock: rig.h.clock,
        settings: defaultMaintenanceSettings({ ...o.settings, ...mo.settings }),
        expirySweepMs: 300_000,
        extraJobs: mo.extraJobs ?? o.extraJobs ?? [],
      });
      if (mo.start ?? o.start ?? true) m.maintenance.start();
      return m.maintenance;
    },
    async close() {
      await m.maintenance?.stop();
      await rig.close();
    },
  };
  m.mount();
  return m;
}

/** Budget samples stored so far. */
export const sampleCount = (r: PolicyRig) => r.e.engine.queries.listBudgetSamples({}).length;
