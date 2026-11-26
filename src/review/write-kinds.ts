/**
 * v3 F12 (ADR 0081, D2): the inventory of write kinds. Every write operation an agent can cause (through the high-level
 * tools, `lk_api_write`, `lk_api_batch` or the `lk_op_*` tools: they all come down to these operations) has a Revert
 * path on the owner's Review page, or is refused for agents with why. The coverage test fails when an operation of the
 * registry that writes is in neither table. A leaf module (no imports): the policy gate reads `AGENT_REFUSED`.
 */

/**
 * v3 F12 (ADR 0081, D2): every write operation an agent can cause, with its Revert path. The coverage test fails if a
 * write operation of the registry is in neither this table nor `AGENT_REFUSED`.
 */
export const REVERT_PATHS: Readonly<Record<string, string>> = {
  // Page text and blocks (targets.ts: `text`, `block`)
  replaceDocumentBlocks: 'text: block by block back to the page before',
  insertBlock: 'text or block: removed again',
  replaceBlock: 'text or block: its old content back',
  updateBlock: 'text or block: its old content back',
  deleteBlock: 'text: put back block by block',
  moveBlock: 'text: back in its old place (the page written back whole)',
  assignBlockIds: 'nothing to revert: ids only, the content unchanged',
  // Facts and links (`facts`, `lmr`), and the generic undo of single rows and properties
  createPropertyRow: 'facts (set_facts), or entity: the row deleted again',
  updatePropertyRow: 'facts, or entity: the row back to its pre-image',
  deletePropertyRow: 'facts, or entity: the row made again from its pre-image',
  createProperty: 'entity: the property deleted again',
  updateProperty: 'facts (link collections), or entity: back to its pre-image',
  deleteProperty: 'entity: made again from its pre-image',
  createBlockRow: 'entity: the row deleted again',
  updateBlockRow: 'entity: the row back to its pre-image',
  deleteBlockRow: 'entity: the row made again from its pre-image',
  createBlockProperty: 'entity: the infobox property deleted again',
  updateBlockProperty: 'entity: back to its pre-image',
  deleteBlockProperty: 'entity: made again from its pre-image',
  createBlockPropertyRow: 'entity: the infobox row deleted again',
  updateBlockPropertyRow: 'entity: back to its pre-image',
  deleteBlockPropertyRow: 'entity: made again from its pre-image',
  // Pages (`resource`, `move`, entity)
  createResource: 'entity: the page deleted again while untouched (its copy kept first)',
  createManyResources: 'entity: each page deleted again while untouched (children first; copies kept)',
  createResourceFromTemplate: 'entity: the page deleted again while untouched (its copy kept first)',
  saveResourceAsTemplate: 'entity: the template deleted again while untouched (its copy kept first)',
  updateResource: 'resource: name, tags, aliases, icon, lock and width back; entity: any other field back',
  moveResource: 'move: back under its old parent, in its old place',
  deleteResource: 'entity (D3): restoreResource, else made again from the copy kept before the delete',
  restoreResource: 'entity: deleted again (its copy kept first)',
  // Documents
  createDocument: 'entity: the document deleted again while untouched',
  updateDocument: 'entity: its fields back to the pre-image',
  deleteDocument: 'entity (D3): restoreDocument (its copy kept before the delete)',
  restoreDocument: 'entity: deleted again',
  // Timelines (`chronology` for the chronology tools; entity otherwise)
  createLane: 'entity: the lane deleted again',
  updateLane: 'entity: back to its pre-image',
  deleteLane: 'entity: made again with its events, from its pre-image',
  createEvent: 'chronology (with its row), or entity: the event deleted again',
  updateEvent: 'chronology, or entity: back to its pre-image',
  deleteEvent: 'chronology (a re-made event), or entity: made again from its pre-image',
  // Maps
  createFeature: 'entity: the feature deleted again',
  updateFeature: 'entity: back to its pre-image',
  deleteFeature: 'entity: made again from its pre-image',
  // Boards
  replaceBoardContent: 'entity: the board’s content back to its pre-image',
  createBoardShapes: 'entity: the shapes deleted again',
  updateBoardShapes: 'entity: the shapes back to their pre-image',
  deleteBoardShapes: 'entity: the shapes made again from the board’s pre-image',
  // Assets (`image`, entity)
  createAssetFolder: 'image (a placement’s folder stays), or entity: an empty folder deleted again',
  createImageUpload: 'nothing to revert: no change in LegendKeeper (a signed upload address)',
  createImageAsset:
    'image: a placement back on the Staging page; or entity: an upload deleted again (its bytes kept)',
  updateAsset: 'image: back to its old folder, name and hidden flag',
  deleteAsset: 'entity (D3): uploaded again from the bytes kept before the delete, pages relinked',
  // Calendars
  createCalendar: 'entity: the calendar deleted again',
  updateCalendar: 'entity: the whole calendar back to its pre-image',
  deleteCalendar: 'entity: made again from its pre-image',
};

/**
 * v3 F12 (ADR 0081, D2): write operations that genuinely cannot be reverted, refused for agents with why (the policy gate
 * refuses them, whatever the scope or LK_ALLOW_MEMBER_ADMIN). The owner does them in the LegendKeeper app.
 */
export const AGENT_REFUSED: Readonly<Record<string, string>> = {
  inviteMember:
    'member administration is never done by agents: an invitation sends an email no revert can take back',
  removeMember:
    'member administration is never done by agents: a member taken off the project cannot be put back as they were (their role, their own edits)',
  revokeInvite:
    'member administration is never done by agents: a revoked invitation cannot be sent back as it was',
};
