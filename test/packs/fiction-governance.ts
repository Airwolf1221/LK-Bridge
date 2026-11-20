/**
 * v3 F4c (ADR 0065): the two fiction Design References the pack pins by their page names (any dash), for worlds that
 * take the seed's governance as it is upgraded: "Arkona – Narrative Story Planning & Drafting Workflow" (its
 * "LegendKeeper Planning and Manuscript Structure") and "Arkona - Fiction Writing Reference" (its "32B. Durable
 * Chapter Persistence in LegendKeeper"), one with an en dash and one with a hyphen, as the live pages may be written.
 */
import { buildModels, ROOT } from '../discover/world.js';
import type { PackWorld } from './world.js';

export const FICTION_PAGES = { workflow: 'fgwkflw1', fiction: 'fgfictn1' } as const;

export function seedFictionGovernance(w: Pick<PackWorld, 'repo' | 'stack' | 'assets'>): void {
  const r = w.repo;
  const page = (id: string, name: string, headings: string[]) => {
    r.seed({ id, name, parentId: ROOT, tags: ['CANON'] });
    const doc = r.liveDocs(r.live(id)!).find((d) => d.name === 'Main')!;
    r.blocks.set(doc.id, {
      version: 1,
      blocks: headings.flatMap((h, i) => [
        { id: `${id}h${i}`, kind: 'heading', level: 2, content: [{ text: h }] },
        { id: `${id}p${i}`, kind: 'paragraph', content: [{ text: `${h}: the rule.` }] },
      ]),
    });
  };
  page(FICTION_PAGES.workflow, '[BSRC] Arkona – Narrative Story Planning & Drafting Workflow', [
    'LegendKeeper Planning and Manuscript Structure',
    'Standard Chapter Planning Format',
  ]);
  page(FICTION_PAGES.fiction, '[BSRC] Arkona - Fiction Writing Reference', [
    '32B. Durable Chapter Persistence in LegendKeeper',
    '35. Canon and Invention in Fiction',
  ]);
  buildModels(w.stack, w.repo, w.assets);
}
