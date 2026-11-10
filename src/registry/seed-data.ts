/**
 * Seed data (v2 A3): the conventions the old bridge used, offered as DEFAULTS for seeding. Nothing here is applied by
 * itself, and each value can be overridden in the seed request or edited on the dashboard afterwards.
 */
import { DEFAULT_CHARACTER_PLACEMENT, type CharacterPlacementConfig } from './types.js';

/**
 * Singular → plural, from the old bridge's `race-mappings.json`. Seeding looks a plural up here first; a match gives
 * a singular the owner does not need to review.
 */
export const SINGULAR_PLURALS: readonly (readonly [singular: string, plural: string])[] = [
  ['Human', 'Humans'],
  ['High Human', 'High Humans'],
  ['Elf', 'Elves'],
  ['Dark Elf', 'Dark Elves'],
  ['High Elf', 'High Elves'],
  ['Moon Elf', 'Moon Elves'],
  ['Sea Elf', 'Sea Elves'],
  ['Sky Elf', 'Sky Elves'],
  ['Sun Elf', 'Sun Elves'],
  ['Wood Elf', 'Wood Elves'],
  ['Dwarf', 'Dwarves'],
  ['Greenskin', 'Greenskins'],
  ['Goblin', 'Goblins'],
  ['Orc', 'Orcs'],
  ['Outsider', 'Outsiders'],
  ['Daemon', 'Daemons'],
  ['Devil', 'Devils'],
  ['Faerie', 'Faeries'],
  ['Genie', 'Genies'],
  ['Therian', 'Therians'],
  ['True Dragon', 'True Dragons'],
];

/** The Character type's seed: how the old bridge named its root, templates and asset folder. */
export interface CharacterSeedDefaults {
  readonly singular: string;
  readonly plural: string;
  /** The display name of the root index, looked for directly under the AI REPOSITORY root. */
  readonly rootIndexName: string;
  readonly indexTemplateName: string;
  readonly pageTemplates: readonly { readonly role: string; readonly templateName: string }[];
  readonly assetRootFolder: string;
  readonly placement: CharacterPlacementConfig;
}

export const CHARACTER_SEED: CharacterSeedDefaults = Object.freeze({
  singular: 'Character',
  plural: 'Characters',
  rootIndexName: 'Characters',
  indexTemplateName: '[INDEX] AI Index',
  pageTemplates: [
    { role: 'core', templateName: '[BSRC] AI Character Core' },
    { role: 'compact', templateName: '[BSRC] AI Compact Character Reference' },
  ],
  assetRootFolder: 'Characters',
  placement: DEFAULT_CHARACTER_PLACEMENT,
});
