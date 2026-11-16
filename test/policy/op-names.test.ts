/**
 * Readable low-level proposals (v2 E6, ADR 0048): a proposal made by `lk_api_write` names the page, the document and
 * the entity it touches, from the pre-image captured anyway, the tree and (for a sidebar row) one cheap read; a name
 * that cannot be found falls back to the ids and never blocks the proposal.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeNamed, nameOperation, type NameLookups } from '../../src/policy/op-names.js';
import { C, chronologyWorld, type ChronologyWorld } from '../chronology/world.js';

const lookups: NameLookups = {
  page: (rid) => (rid === 'chrono01' ? '[BSRC] Universal Chronology' : null),
  document: (_rid, did) => (did === 'doctl01' ? 'Fourth Arkonan Age - Timeline' : null),
  propertyTitle: () => Promise.resolve('PROPERTIES'),
};

describe('naming an operation from its pre-image', () => {
  it('deleteEvent: the event’s name and its date, in its document, on its page', async () => {
    const params = { path: { resourceId: 'chrono01', documentId: 'doctl01', eventId: 'vuxddr01' } };
    const names = await nameOperation(
      'deleteEvent',
      params,
      {
        id: 'vuxddr01',
        name: 'Mehrana completes the Divan Heirage',
        formattedStart: 'Isar 3rd, 4A 619',
        formattedEnd: 'Camue 5th, 4A 624',
      },
      lookups,
    );
    expect(describeNamed('deleteEvent', params, names)).toBe(
      'deleteEvent: event “Mehrana completes the Divan Heirage” (Isar 3rd, 4A 619 - Camue 5th, 4A 624) in “Fourth Arkonan Age - Timeline” on “[BSRC] Universal Chronology” (chrono01 › vuxddr01)',
    );
  });

  it('deleteFeature: the feature’s type and name', async () => {
    const params = { path: { resourceId: 'map00001', documentId: 'docmap01', featureId: 'feat0001' } };
    const names = await nameOperation(
      'deleteFeature',
      params,
      { id: 'feat0001', type: 'pin', name: 'Sarayi Halid' },
      { ...lookups, page: () => 'Arkona', document: () => 'Arkona Map' },
    );
    expect(describeNamed('deleteFeature', params, names)).toBe(
      'deleteFeature: pin “Sarayi Halid” in “Arkona Map” on “Arkona” (map00001 › feat0001)',
    );
  });

  it('updateBlock: the block’s first words', async () => {
    const params = {
      path: { resourceId: 'chrono01', documentId: 'doctab01', blockId: 'para0001' },
      body: { content: [{ text: 'x' }] },
    };
    const names = await nameOperation(
      'updateBlock',
      params,
      {
        id: 'para0001',
        kind: 'paragraph',
        content: [{ text: 'Every dated event of the age of Arkona, in calendar order, with its KCY' }],
      },
      { ...lookups, document: () => 'Fourth Arkonan Age - Table' },
    );
    expect(names.entity).toBe('paragraph “Every dated event of the age of Arkona,…”');
  });

  it('a property row (updatePropertyRow): its key and value, and the property’s title by one read', async () => {
    const params = {
      path: { resourceId: 'chrono01', propertyId: 'kvchron1', rowId: 'kvchron1r1' },
      body: { content: [{ text: 'General Source' }] },
    };
    let reads = 0;
    const names = await nameOperation(
      'updatePropertyRow',
      params,
      { id: 'kvchron1r1', key: 'Reference Type', text: 'General Source' },
      {
        ...lookups,
        propertyTitle: () => {
          reads++;
          return Promise.resolve('PROPERTIES');
        },
      },
    );
    expect(reads).toBe(1);
    expect(describeNamed('updatePropertyRow', params, names)).toBe(
      'updatePropertyRow: row “Reference Type” (“General Source”) of “PROPERTIES” on “[BSRC] Universal Chronology” (chrono01 › kvchron1r1)',
    );
  });

  it('a failed lookup falls back to the ids; it never throws', async () => {
    const params = { path: { resourceId: 'chrono01', documentId: 'doctl01', eventId: 'vuxddr01' } };
    const broken: NameLookups = {
      page: () => {
        throw new Error('tree down');
      },
      document: () => {
        throw new Error('tree down');
      },
      propertyTitle: () => Promise.reject(new Error('no read')),
    };
    const names = await nameOperation('deleteEvent', params, null, broken);
    expect(names).toEqual({ page: null, document: null, entity: null });
    expect(describeNamed('deleteEvent', params, names)).toBe('deleteEvent on chrono01 › vuxddr01');
    const row = await nameOperation(
      'deletePropertyRow',
      { path: { resourceId: 'chrono01', propertyId: 'kvchron1', rowId: 'r1' } },
      { key: 'Status' },
      broken,
    );
    expect(row.entity).toBe('row “Status”');
  });
});

describe('a proposal made by lk_api_write names what it touches (the real capture)', () => {
  let w: ChronologyWorld;
  let proposer: Client;
  const FOURTH = 'Fourth Arkonan Age';
  beforeAll(async () => {
    w = await chronologyWorld();
    proposer = await w.stack.connect(w.stack.newToken('low-level-proposer', 'propose').token);
  });
  afterAll(() => w?.close());
  const propose = async (operationId: string, params: Record<string, unknown>) => {
    const r = await w.stack.call(proposer, 'lk_api_write', { project: 'test', operationId, params });
    expect(r.body.status, r.text).toBe('proposal_captured');
    return w.stack.runtime.policy.proposals.detail(String(r.body.proposalId))!;
  };

  it('deleteEvent: the summary, the page summary and the operation’s label name the event, its date, the timeline and the page', async () => {
    const tl = w.ages[FOURTH]!.timeline;
    const p = await propose('deleteEvent', {
      path: { resourceId: C.resource, documentId: tl, eventId: 'efour001' },
    });
    expect(p.summary).toBe(
      `Proposed deleteEvent: event “The Long Winter” (Kumikas 19th, 4A 100 - Meshaph 10th, 4A 102) in “${FOURTH} - Timeline” on “Universal Chronology” (${C.resource} › efour001)`,
    );
    expect(p.pageSummary.map((e) => e.label)).toEqual([
      `Universal Chronology: event “The Long Winter” (Kumikas 19th, 4A 100 - Meshaph 10th, 4A 102) deleted in “${FOURTH} - Timeline”`,
    ]);
    expect(p.ops[0]!.label).toBe(p.summary.replace(/^Proposed /, ''));
    // Nothing was written.
    expect(w.events(tl).some((e) => e.id === 'efour001')).toBe(true);
  });

  it('updateBlock: the block’s first words in the table document', async () => {
    const p = await propose('updateBlock', {
      path: { resourceId: C.resource, documentId: w.ages[FOURTH]!.table, blockId: 'ifour' },
      body: { content: [{ text: 'Every event of the age.' }] },
    });
    expect(p.summary).toMatch(/^Proposed updateBlock: paragraph “Every dated event of the age/);
    expect(p.summary).toContain(`in “${FOURTH} - Table” on “Universal Chronology”`);
  });

  it('updatePropertyRow: the row’s key and the property’s title (one more read)', async () => {
    const done = w.mark();
    const p = await propose('updatePropertyRow', {
      path: { resourceId: C.resource, propertyId: 'kvchron1', rowId: 'kvchron1r1' },
      body: { content: [{ text: 'General Source' }] },
    });
    expect(p.summary).toBe(
      `Proposed updatePropertyRow: row “Reference Type” (“General Source”) of “PROPERTIES” on “Universal Chronology” (${C.resource} › kvchron1r1)`,
    );
    expect(done().lines.filter((l) => /\/properties\/kvchron1$/.test(l.split('?')[0]!))).toHaveLength(1);
  });
});
