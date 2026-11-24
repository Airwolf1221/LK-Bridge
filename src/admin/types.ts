import type { Packs } from '../packs/service.js';
import type { Appraisal } from '../appraisal/index.js';
import type { Consistency } from '../consistency/service.js';
import type { ImageService } from '../images/service.js';
import type { Lifecycle } from '../lifecycle/index.js';
import type { Audits } from '../audits/index.js';
import type { OutfitStore } from '../art/store.js';
import type { Chronology } from '../chronology/index.js';
import type { AuthServices } from '../auth/services.js';
import type { AdminSettings, Config } from '../config/index.js';
import type { JobEngine } from '../jobs/index.js';
import type { ProjectRegistry } from '../projects/index.js';
import type { Maintenance } from '../maintenance/index.js';
import type { Mappings } from '../mappings/index.js';
import type { Policy } from '../policy/index.js';
import type { AssetService } from '../assets/index.js';
import type { TreeService } from '../tree/index.js';
import type { SecretStore } from '../secrets/store.js';
import type { Registry } from '../registry/index.js';
import type { SnapshotService } from '../snapshots/service.js';
import type { Restores } from '../snapshots/restores.js';
import type { Rehearsals } from '../snapshots/rehearsal.js';
import type { OffsiteService } from '../offsite/service.js';
import type { ToolCallLog } from '../toolcalls/index.js';
import type { Evaluation } from '../evaluation/index.js';
import type { ReviewService } from '../review/service.js';
import type { RevertService } from '../review/revert.js';

/**
 * What the admin API needs from the running bridge. `Runtime` (src/runtime.ts) satisfies it; tests may build their own.
 */
import type { ResumeService } from '../resume/service.js';
import type { SplitService } from '../packs/split/service.js';
import type { ReferenceTypeService } from '../packs/reftypes/service.js';
import type { RetagService } from '../packs/retag/service.js';
import type { AutomationService } from '../automation/service.js';
import type { WorkstreamReports } from '../workstreams/report.js';
import type { OutcomeReconciler } from '../jobs/reconcile.js';
import type { ConfigSettingsRuntime } from './config-settings.js';

export interface AdminRuntime {
  readonly engine: JobEngine;
  /** The projects this bridge serves (v2 A1): each one's governor, flags and whether it is served now. */
  readonly projects: ProjectRegistry;
  /** OPS2: the encrypted secret store (its state is shown; values never leave it here). */
  readonly secrets: SecretStore;
  readonly policy: Policy;
  /** Maintenance registry, scheduler and owner commands (chunk 6). */
  readonly maintenance: Maintenance;
  /** Repository mappings store and owner commands (chunk 6). */
  readonly mappings: Mappings;
  /** v2 A2: the repository tree of each project. */
  readonly tree: TreeService;
  /** v2 A3: the type registry and taxonomy of each project. */
  readonly registry: Registry;
  /** v2 A4: the asset tree of each project. */
  readonly assets: AssetService;
  /** v3 F7 (ADR 0070, G3): each character's outfits (seeding, aliases); optional for tests' runtimes. */
  readonly outfits?: OutfitStore;
  /** v2 C2c: the page lifecycle (settings, the lifecycle record, the link index); optional for tests' runtimes. */
  readonly lifecycle?: Lifecycle;
  /** v2 D1: chronology sync (settings, records, the check); optional for tests' runtimes. */
  readonly chronology?: Chronology;
  /** v2 D3: the image pipeline (the Staging page); optional for tests' runtimes. */
  readonly images?: ImageService;
  /** v2 E1a: snapshots, restores and the rehearsal (the Snapshots page); optional for tests' runtimes. */
  readonly snapshots?: SnapshotService;
  readonly restores?: Restores;
  readonly rehearsals?: Rehearsals;
  /** v2 E2: the audits (the Audits page); optional for tests' runtimes. */
  readonly audits?: Audits;
  /** v2 E3: the tool-call log (the Tool calls page); optional for tests' runtimes. */
  readonly toolCalls?: ToolCallLog;
  /** v2 E3: the Evaluation helper (the Tool calls page's Evaluation panel); optional for tests' runtimes. */
  readonly evaluation?: Evaluation;
  /** v2 E1b: the off-site copy to Google Drive (the Off-site copy page, the Overview's warning); optional for tests. */
  readonly offsite?: OffsiteService;
  /** v3 F3a (ADR 0050): the setting packs (the Packs page); optional for tests' runtimes. */
  readonly packs?: Packs;
  /** v3 F3c (ADR 0054): the appraisal tools and the full-text index (the Appraisal page); optional for tests. */
  readonly appraisal?: Appraisal;
  /** v3 F4b (ADR 0064): the consistency check (the Audits page's "Pick the right value"); optional for tests. */
  readonly consistency?: Consistency;
  /** v3 F3.4 (ADR 0055): the review queue of direct writes (the Review page); optional for tests' runtimes. */
  readonly review?: ReviewService;
  /** v3 F3.4 (ADR 0055): Revert of a direct-write job (the Review and Jobs pages); optional for tests' runtimes. */
  readonly reverts?: RevertService;
  /** v3 F3d (ADR 0058): Resume of a package, a rename or a recreate that stopped part-way; optional for tests. */
  readonly resume?: ResumeService;
  /** v3 F3e (ADR 0059): the splits' records (a split's phase 1 can be reverted); optional for tests. */
  readonly splits?: Pick<SplitService, 'byJob'>;
  /** v3 F3f (ADR 0060): the retag audit, holds, batches and reconciliations (the Tagging page); optional for tests. */
  readonly retag?: RetagService;
  /** v3 F6a (ADR 0076): the Reference Types page (the report, decisions, publish); optional for tests. */
  readonly referenceTypes?: ReferenceTypeService;
  /** v3 F5b (ADR 0068): automatic actions for audits (the Automation page, the Overview's tile); optional for tests. */
  readonly automation?: AutomationService;
  /** v3 F5c (ADR 0069, H8): the workstreams and their reports (the Workstreams page); optional for tests. */
  readonly workstreamReports?: WorkstreamReports;
  /** v3 F5a (ADR 0067, H10): the reconciliation of writes whose outcome is unknown (absent in some tests). */
  readonly outcomes?: OutcomeReconciler;
  /** The configuration the running components were built from (environment plus the dashboard's stored values). */
  readonly config: Config;
  /** The environment's values alone: what clearing a stored setting falls back to. */
  readonly envConfig: Config;
  /** v3 F8 (ADR 0073): the Settings page's dashboard values and the restart control; optional for tests' runtimes. */
  readonly configSettings?: ConfigSettingsRuntime;
}

export interface AdminDeps {
  readonly runtime: AdminRuntime;
  readonly services: AuthServices;
  readonly settings: AdminSettings;
  readonly version: string;
  /** Directory of the built dashboard (`ui/dist`). When it does not exist `/ui` explains that it was not built. */
  readonly uiDir: string;
  readonly now?: () => number;
}
