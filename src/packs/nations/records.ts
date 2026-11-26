/**
 * v3 F6c (ADR 0080): the job record a role binding is written by, once the job that made its index succeeded (the
 * `territory_category_missing` fix, `create_index`'s role form): a `bridge.record` step in this store, handled by the
 * runtime (NationTaxonomyService.recordBinding).
 */
export const ROLE_RECORD_STORE = 'registry_roles';

/** The record step that binds `role` of the entry whose index is `ownerNodeId` to `nodeId`. */
export function roleBindingStep(r: { ownerNodeId: string; role: string; nodeId: string }) {
  return {
    op: 'bridge.record',
    params: {
      body: {
        action: 'complete',
        store: ROLE_RECORD_STORE,
        record: { kind: 'role_binding', ownerNodeId: r.ownerNodeId, role: r.role, nodeId: r.nodeId },
      },
    },
  } as const;
}
