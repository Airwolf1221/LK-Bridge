import { createMappings, type Mappings, type ProjectMappings } from '../../src/mappings/index.js';
import { PROJECT } from '../jobs/helpers.js';
import { policyRig, type PolicyRig } from '../policy/helpers.js';

export interface MappingRig {
  readonly rig: PolicyRig;
  /** The mock project's mappings (v2 A1: mappings belong to a project). */
  readonly mappings: ProjectMappings;
  /** Every project's, by id. */
  readonly all: Mappings;
  close(): Promise<void>;
}

export async function mappingRig(): Promise<MappingRig> {
  const rig = await policyRig();
  const all = createMappings({
    db: rig.db,
    engine: rig.e.engine,
    policyStore: rig.policy.store,
    now: () => rig.h.clock.now(),
  });
  return { rig, mappings: all.forProject(PROJECT), all, close: () => rig.close() };
}

export const SET = { name: 'Baisheng taxonomy', description: 'The main repository', notes: 'First draft' };

export const SUBTREE_RULE = {
  selector: { kind: 'subtree', resourceId: 'rcharact', descendants: true },
  semanticType: 'Character',
  priority: 10,
  notes: 'Everything under Characters',
};

export const TAG_RULE = {
  selector: { kind: 'tag', tag: 'nation' },
  semanticType: 'Nation',
  priority: 20,
};

export const FIELD_SIDEBAR = {
  semanticType: 'Character',
  fieldName: 'Species',
  location: { kind: 'sidebar_property', title: 'Species' },
  expectedKind: 'resource_link',
};

export const FIELD_INFOBOX = {
  semanticType: 'Character',
  fieldName: 'Born',
  location: { kind: 'infobox_row', infoboxTitle: 'Vitals', rowKey: 'Born' },
  expectedKind: 'date',
};

export const FIELD_HEADING = {
  semanticType: 'Character',
  fieldName: 'Biography',
  location: { kind: 'block', heading: 'Biography' },
  expectedKind: 'text',
};

export const FIELD_BLOCK_ID = {
  semanticType: 'Nation',
  fieldName: 'Motto',
  location: { kind: 'block', blockId: 'blk_motto' },
  expectedKind: 'text',
};
