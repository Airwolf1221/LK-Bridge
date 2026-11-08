/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- parsed JSON replies and loosely typed test data */
/**
 * The Repository Mappings admin routes: chunk 5's owner-session, Origin and CSRF rules, audited and evented CRUD,
 * import and export over HTTP, and the read-only preview against the mock LegendKeeper.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fullFlow } from '../auth/helpers.js';
import { startAdminStack, type AdminStack } from '../admin/helpers.js';
import { FIELD_INFOBOX, FIELD_SIDEBAR, SET, SUBTREE_RULE, TAG_RULE } from './helpers.js';

let stack: AdminStack;
let oauthAccess: string;
const parents = new Map<string, { name: string; parentId?: string; tags: string[] }>([
  ['rcharact', { name: 'Characters', tags: [] }],
  ['rduke', { name: 'The Duke', parentId: 'rcharact', tags: ['nation'] }],
]);

beforeAll(async () => {
  stack = await startAdminStack({
    respond: (req) => {
      const m = /\/resources\/([a-z0-9]+)\/?$/.exec(req.path);
      if (req.method === 'GET' && m && parents.has(m[1]!))
        return { status: 200, body: { id: m[1], ...parents.get(m[1]!) } };
      if (req.method === 'GET' && m)
        return { status: 404, body: { code: 'NOT_FOUND', message: 'No such resource' } };
      return undefined;
    },
  });
  oauthAccess = (await fullFlow(stack.bridge)).access;
});
afterAll(() => stack.close());

const mine = () => stack.routes.filter((r) => r.url.startsWith('/api/admin/mappings'));
const concrete = (url: string) => url.replace(/:id/g, 'x');
const A = '/api/admin/mappings';

describe('routes and auth', () => {
  it('registers the documented routes', () => {
    expect(mine().length).toBeGreaterThanOrEqual(16);
  });

  it('are closed to no credentials and to OAuth access tokens', async () => {
    for (const r of mine()) {
      for (const o of [
        { cookie: null, csrf: null, origin: null },
        { cookie: null, authorization: `Bearer ${oauthAccess}` },
      ]) {
        const reply = await stack.call(r.method, concrete(r.url), o);
        expect(reply.status, `${r.method} ${r.url}`).toBe(401);
      }
    }
  });

  it('refuse a bad CSRF token or Origin on every change, and write nothing', async () => {
    const before = stack.audit().length;
    for (const r of mine().filter((r) => r.method !== 'GET')) {
      for (const o of [
        { csrf: null },
        { csrf: 'wrong' },
        { origin: null },
        { origin: 'https://evil.example' },
      ]) {
        const reply = await stack.call(r.method, concrete(r.url), { body: SET, ...o });
        expect(reply.status, `${r.method} ${r.url}`).toBe(403);
      }
    }
    expect(stack.audit().length).toBe(before);
    expect((await stack.get(A)).json.sets).toEqual([]);
  });
});

describe('CRUD over HTTP', () => {
  let setId: string;
  let ruleId: string;
  let fieldId: string;

  it('creates, reads, updates and lists a set; every change is audited and evented', async () => {
    const created = await stack.post(`${A}/sets`, SET);
    expect(created.status).toBe(201);
    setId = created.json.set.id;
    expect((await stack.put(`${A}/sets/${setId}`, { ...SET, notes: 'Edited' })).json.set.notes).toBe(
      'Edited',
    );
    const list = (await stack.get(A)).json;
    expect(list.sets).toMatchObject([{ id: setId, name: 'Baisheng taxonomy', ruleCount: 0, active: false }]);
    expect(list.expectedKinds).toContain('resource_link');
    expect(list.suggestedTypes).toEqual(['Character', 'Nation', 'Species', 'Institution', 'Place', 'Class']);
    expect(stack.audit('mapping.set_create')).toHaveLength(1);
    expect(stack.events.map((e) => e.action)).toContain('mapping.set_update');
  });

  it('refuses duplicate names (409) and invalid input (400, naming the field)', async () => {
    const dup = await stack.post(`${A}/sets`, { ...SET, name: 'baisheng taxonomy' });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe('NAME_TAKEN');
    const bad = await stack.post(`${A}/sets`, { name: '' });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toMatch(/name/);
  });

  it('creates rules and field maps and shows the readable summary', async () => {
    ruleId = (await stack.post(`${A}/sets/${setId}/rules`, SUBTREE_RULE)).json.rule.id;
    await stack.post(`${A}/sets/${setId}/rules`, TAG_RULE);
    fieldId = (await stack.post(`${A}/sets/${setId}/fields`, FIELD_SIDEBAR)).json.field.id;
    await stack.post(`${A}/sets/${setId}/fields`, FIELD_INFOBOX);
    const detail = (await stack.get(`${A}/sets/${setId}`)).json;
    expect(detail.rules).toHaveLength(2);
    expect(detail.fields).toHaveLength(2);
    expect(detail.summary.headline).toBe(
      'Inactive set “Baisheng taxonomy”: 2 type rules, 2 field maps, 2 semantic types.',
    );
    expect(
      (await stack.put(`${A}/rules/${ruleId}`, { ...SUBTREE_RULE, priority: 50 })).json.rule.priority,
    ).toBe(50);
    expect(
      (await stack.put(`${A}/fields/${fieldId}`, { ...FIELD_SIDEBAR, expectedKind: 'text' })).json.field
        .expectedKind,
    ).toBe('text');
    const dupField = await stack.post(`${A}/sets/${setId}/fields`, FIELD_SIDEBAR);
    expect(dupField.status).toBe(409);
    expect(dupField.json.error.code).toBe('DUPLICATE_FIELD');
    expect(
      (await stack.post(`${A}/sets/${setId}/rules`, { ...SUBTREE_RULE, selector: { kind: 'tag' } })).status,
    ).toBe(400);
  });

  it('activates one set at a time', async () => {
    const other = (await stack.post(`${A}/sets`, { ...SET, name: 'Second' })).json.set.id;
    await stack.post(`${A}/sets/${setId}/activate`);
    await stack.post(`${A}/sets/${other}/activate`);
    const sets = (await stack.get(A)).json.sets;
    expect(sets.filter((s: any) => s.active).map((s: any) => s.name)).toEqual(['Second']);
    await stack.post(`${A}/sets/${other}/deactivate`);
    expect((await stack.get(A)).json.sets.filter((s: any) => s.active)).toEqual([]);
    expect((await stack.post(`${A}/sets/${other}/delete`, { confirm: true })).json).toEqual({ ok: true });
  });

  it('exports the versioned document and imports it as a new inactive set; refuses a bad file', async () => {
    const exported = (await stack.get(`${A}/sets/${setId}/export`)).json.document;
    expect(exported).toMatchObject({
      schema: 'lk-bridge.mapping-set',
      version: 1,
      set: { name: 'Baisheng taxonomy' },
    });
    const dup = await stack.post(`${A}/import`, { document: JSON.stringify(exported) });
    expect(dup.status).toBe(409);
    const ok = await stack.post(`${A}/import`, { document: JSON.stringify(exported), name: 'Imported' });
    expect(ok.status).toBe(201);
    expect(ok.json.set).toMatchObject({ name: 'Imported', active: false });
    expect(ok.json.rules).toHaveLength(2);
    expect(ok.json.fields).toHaveLength(2);
    const bad = await stack.post(`${A}/import`, {
      document: '{"schema":"lk-bridge.mapping-set","version":9}',
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('INVALID_IMPORT');
    expect((await stack.post(`${A}/import`, { document: 'not json' })).status).toBe(400);
    expect((await stack.get(A)).json.sets).toHaveLength(2); // unchanged by the refused imports
  });

  it('deleting needs confirmation; deleting rules and fields works', async () => {
    expect((await stack.post(`${A}/rules/${ruleId}/delete`)).json).toEqual({ ok: true });
    expect((await stack.post(`${A}/fields/${fieldId}/delete`)).json).toEqual({ ok: true });
    expect((await stack.post(`${A}/sets/${setId}/delete`, {})).status).toBe(400); // no confirm
    expect((await stack.get(`${A}/sets/${setId}`)).status).toBe(200);
    expect((await stack.post(`${A}/rules/${ruleId}/delete`)).status).toBe(404);
  });
});

describe('preview over HTTP', () => {
  it('is a GET that reads through the governor and writes nothing', async () => {
    const set = (await stack.post(`${A}/sets`, { ...SET, name: 'Preview set' })).json.set.id;
    await stack.post(`${A}/sets/${set}/rules`, SUBTREE_RULE);
    await stack.post(`${A}/sets/${set}/rules`, { ...TAG_RULE, priority: 5 });
    const auditBefore = stack.audit().length;
    const writesBefore = stack.mock.calls.filter((c) => c.method !== 'GET').length;
    const r = await stack.get(`${A}/sets/${set}/preview?resourceId=rduke`);
    expect(r.status).toBe(200);
    expect(r.json.preview).toMatchObject({
      semanticType: 'Character',
      resource: { id: 'rduke', name: 'The Duke' },
    });
    expect(r.json.preview.matches.map((m: any) => m.semanticType)).toEqual(['Character', 'Nation']);
    expect(stack.mock.calls.filter((c) => c.method !== 'GET').length).toBe(writesBefore);
    expect(stack.mock.calls.length).toBeGreaterThan(0);
    expect(stack.audit().length).toBe(auditBefore);
    // Needs a resource id, and an existing resource and set.
    expect((await stack.get(`${A}/sets/${set}/preview`)).status).toBe(400);
    expect((await stack.get(`${A}/sets/nope/preview?resourceId=rduke`)).status).toBe(404);
    expect((await stack.get(`${A}/sets/${set}/preview?resourceId=rmissing`)).status).toBeGreaterThanOrEqual(
      400,
    );
  });
});
