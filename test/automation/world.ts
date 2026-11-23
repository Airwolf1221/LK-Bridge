/**
 * v3 F5b (ADR 0068): the automation framework's test world. The retag world (the REAL server, runtime, MCP transport,
 * policy and engine against the mock LegendKeeper; the appraisal's fixture pages, one per defect, and the Retag Desk),
 * plus a Repository Automation document on the AI REPOSITORY page built from the shapes the governance quotes, never
 * fetched: its "Default Boundary", "Approved Narrow Automations" (holding the block-id sweep's paragraph) and "Source
 * Boundaries". The pack's governance sources take it as `repository-automation`, and the pack is approved with it.
 */
import { ROOT } from '../discover/world.js';
import { LIFECYCLE } from '../resources/world.js';
import { retagWorld, type RetagWorld } from '../packs/retag-world.js';
import { ARKONA_PACK } from '../../src/packs/arkona.js';
import { PROJECT } from '../tools/helpers.js';

export { PROJECT };

/** The sweep's paragraph as the governance has it (the fragments the owner's brief quotes). */
export const SWEEP_PARAGRAPH =
  'Assign Block IDs Sweep (owner approval, 17 November 2026): one assignBlockIds call per legacy page document inside AI REPOSITORY, verified against its journalled pre-image; enabling it is the activation, and this approval establishes no wider repair whitelist.';

export const AUTOMATION_SECTIONS = ['Default Boundary', 'Approved Narrow Automations', 'Source Boundaries'];

export interface AutomationWorld extends RetagWorld {
  /** The Repository Automation document's id (on the AI REPOSITORY page). */
  readonly governanceDoc: string;
  /** Its blocks as the mock holds them now. */
  governanceBlocks(): Record<string, unknown>[];
  /** An edit made in the LegendKeeper app (outside the bridge): the document's version moves on. */
  editAutomationPage(edit: (blocks: Record<string, unknown>[]) => void): void;
}

const heading = (id: string, level: number, text: string) => ({
  id,
  kind: 'heading',
  level,
  content: [{ text }],
});
const para = (id: string, text: string) => ({ id, kind: 'paragraph', content: [{ text }] });

/** What `withAutomationGovernance` needs of a test world (every world built on the discover world has it). */
interface GovernableWorld {
  readonly repo: RetagWorld['repo'];
  readonly stack: RetagWorld['stack'];
}

/**
 * Adds the Repository Automation document to a world, points the pack's `repository-automation` source at it and
 * approves the pack again (with the automation rules, if its version lacks them).
 */
export async function withAutomationGovernance<W extends GovernableWorld>(
  w: W,
): Promise<W & Pick<AutomationWorld, 'governanceDoc' | 'governanceBlocks' | 'editAutomationPage'>> {
  const doc = w.repo.outside.addDocument(ROOT, 'Repository Automation');
  w.repo.blocks.set(doc.id, {
    version: 1,
    blocks: [
      heading('raH1', 1, 'Repository Automation'),
      heading('raH2', 2, 'Default Boundary'),
      para(
        'raP1',
        'Automations are diagnostic and read-only by default. A separately approved narrow automation action must identify exact scope, prerequisites, transformations, verification, concurrency rules and stop conditions.',
      ),
      heading('raH3', 2, 'Approved Narrow Automations'),
      para('raSweep', SWEEP_PARAGRAPH),
      heading('raH4', 2, 'Source Boundaries'),
      para(
        'raP2',
        'No unattended consequential source-repair whitelist is established here; a future one needs explicit scoped approval.',
      ),
    ],
  });
  const packs = w.stack.runtime.packs;
  const pack = packs.get('arkona')!;
  packs.store.setGovernance('arkona', [
    ...pack.governance.filter((g) => g.key !== 'repository-automation'),
    {
      key: 'repository-automation',
      project: 'test',
      resourceId: ROOT,
      documentId: doc.id,
      name: 'Repository Automation',
      sections: [...AUTOMATION_SECTIONS],
    },
  ]);
  if (!packs.get('arkona')!.rules.automation)
    packs.store.newVersion(
      'arkona',
      { ...packs.get('arkona')!.rules, automation: ARKONA_PACK.rules.automation! },
      'test: the automation rules',
    );
  await packs.commands.approve('owner', 'arkona');
  return Object.assign(w, {
    governanceDoc: doc.id,
    governanceBlocks: () => w.repo.blocks.get(doc.id)!.blocks as Record<string, unknown>[],
    editAutomationPage(edit: (blocks: Record<string, unknown>[]) => void) {
      const b = w.repo.blocks.get(doc.id)!;
      b.version++;
      edit(b.blocks as Record<string, unknown>[]);
    },
  });
}

/**
 * Pages whose name holds a dash outside its subject (a plain dash fix, not a rename): an Authoritative one (renaming it
 * is a canonical change: the canon guard catches it) and a Working one (the fix runs).
 */
export const DASH_ROLE = 'autdash1';
export const DASH_WORKING = 'autdash2';
/** A Working page outside the Working index: re-placing it after its rename is refused by the lifecycle guard. */
export const DASH_STRAY = 'autdash3';

export async function automationWorld(o: Parameters<typeof retagWorld>[0] = {}): Promise<AutomationWorld> {
  const w = await retagWorld({
    ...o,
    seed: (world) => {
      world.repo.seed({
        id: DASH_ROLE,
        name: '[BSRC] Varn Harbour - Toll Ledger\u2014Annex',
        parentId: ROOT,
        tags: [],
      });
      world.repo.seed({
        id: DASH_WORKING,
        name: '[BWRK] Varn Harbour - Toll Ledger\u2014Draft',
        parentId: LIFECYCLE.working,
        tags: ['Working'],
      });
      world.repo.seed({
        id: DASH_STRAY,
        name: '[BWRK] Varn Harbour - Toll Ledger\u2014Stray',
        parentId: ROOT,
        tags: ['Working'],
      });
      o.seed?.(world);
    },
  });
  return withAutomationGovernance(w);
}
