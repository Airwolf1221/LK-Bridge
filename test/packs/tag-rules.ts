/**
 * v3 F3d (ADR 0053): a test world's project gets lifecycle tag rules from the Arkona pack, as the owner would by approving
 * a new pack version: where the lifecycle tag goes on this project (`lifecycleTagPosition`, by its name, "test") and the
 * AU ruling (the seed's, unless `au: false`). Written through the pack store (the governance check is the pack tests').
 */
import type { Runtime } from '../../src/runtime.js';
import { PROJECT } from '../tools/helpers.js';

export function approveTagRules(
  runtime: Pick<Runtime, 'packs'>,
  o: { readonly lead: boolean; readonly au?: boolean },
): void {
  const packs = runtime.packs;
  packs.ensureSeeded();
  if (!packs.attachment('arkona', PROJECT)) packs.commands.attach('owner', 'arkona', PROJECT, {});
  const pack = packs.get('arkona')!;
  const next = packs.store.newVersion(
    'arkona',
    {
      ...pack.rules,
      // Per project, by name: this world's project is "test"; Arkona's own entry is kept and does not apply here.
      lifecycleTagPosition: { arkona: 'lead', ...(o.lead ? { test: 'lead' } : {}) },
      tags: { ...pack.rules.tags, au: o.au === false ? undefined : { continuityType: 'AU', tag: 'AU' } },
    },
    'test: lifecycle tag rules',
  );
  packs.store.approve('arkona', { version: next.version, at: Date.now(), by: 'owner', sources: [] });
}
