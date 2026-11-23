/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- tool JSON */
/**
 * v3 F5c (ADR 0069, H7): `query_facts` against the Menkheti world's tree (the real tree store, filled from the mock's
 * pages as a build leaves it): each selector; the characters shortcut in Main CANON and in an AU; columns and rows
 * (never one object per row), CSV, paging by row and by cursor, and the data's age; stale and missing coverage flagged
 * per row; `live` with its estimate then confirm; and zero LegendKeeper reads without `live`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BULK, M, PROJECT, identityWorld, type IdentityWorld } from '../packs/identity-world.js';
import { toCsv } from '../../src/mcp/tools/query-facts.js';

vi.setConfig({ testTimeout: 120_000 });

let w: IdentityWorld;
beforeAll(async () => {
  w = await identityWorld();
});
afterAll(async () => w?.close());

const q = async (args: Record<string, unknown>) => {
  const r = await w.callRead('query_facts', { project: 'test', ...args });
  expect(r.isError, r.text).toBe(false);
  return r.body;
};
const col = (body: any, name: string) => (body.rows as any[]).map((r) => r[body.columns.indexOf(name)]);

describe('selection', () => {
  it('by Reference Type, as a table: columns once, then rows as arrays; zero LegendKeeper reads', async () => {
    const before = w.requests().all;
    const b = await q({ type: 'Compact Character Reference', fields: ['id', 'name', 'Naming Culture', 'tags'] });
    expect(w.requests().all).toBe(before);
    expect(b.columns).toEqual(['id', 'name', 'Naming Culture', 'tags', 'coverage', 'readAt']);
    expect(Array.isArray(b.rows[0])).toBe(true);
    expect(col(b, 'id')).toContain(M.khepri);
    const k = b.rows.find((r: any[]) => r[0] === M.khepri);
    expect(k.slice(1, 5)).toEqual(['Khepri Nadu - Character Reference', 'Menkheti', ['CANON', 'Character', 'Human', 'Menkheti'], 'ok']);
    expect(b.cost).toBe('none');
    expect(b.age.tree.status).toBeDefined();
  });

  it('by tag (any, all), branch, kind, lifecycle and name', async () => {
    const genie = await q({ tag: 'Genie', fields: ['id'] });
    expect(col(genie, 'id')).toEqual([M.azar]);
    const both = await q({ tag: ['Cosmology', 'Genie'], tagMode: 'all', fields: ['id'] });
    expect(col(both, 'id')).toEqual([M.azar]);
    const either = await q({ tag: ['Cosmology', 'Genie', 'Shadeless'], fields: ['id'] });
    expect(col(either, 'id')).toContain(M.azar);
    const under = await q({ under: '[INDEX] Al-Mansur XII', fields: ['id'] });
    expect(col(under, 'id').sort()).toEqual([M.mansurIndex, M.mansurBio, M.mansur].sort());
    const indexes = await q({ under: M.desk, kind: 'index', fields: ['id'] });
    expect(col(indexes, 'id').sort()).toEqual([M.desk, M.mansurIndex, M.daryanIndex].sort());
    const auth = await q({ under: M.desk, lifecycle: 'Authoritative', fields: ['id'] });
    expect(col(auth, 'id')).toContain(M.mansur);
    expect(col(auth, 'id')).not.toContain(M.desk);
    const named = await q({ name: 'al-nafir', fields: ['id', 'name'] });
    expect(col(named, 'id')).toEqual([M.azar]);
  });

  it('characters: every current identity page of Main CANON, or of an AU through continuity', async () => {
    const main = await q({
      characters: true,
      type: 'Character Core',
      fields: ['canonicalDisplayName', 'Race / Species', 'Naming Culture', 'Life State', 'Temporal Scope', 'tags', 'parent', 'id'],
    });
    expect(main.continuity).toBe('Main CANON');
    const ids = col(main, 'id');
    expect(ids).toContain(M.mansur);
    expect(ids).toContain(M.daryan);
    expect(ids).not.toContain(M.khepri); // a Compact Reference (type narrows)
    expect(ids).not.toContain(M.auChar);
    expect(ids).not.toContain(M.mansurBio); // not an identity page
    const mansur = main.rows.find((r: any[]) => r[7] === M.mansur);
    expect(mansur.slice(0, 7)).toEqual([null, 'Human', 'Menkheti', 'Alive', null, ['CANON', 'Character', 'Human', 'Menkheti'], 'Al-Mansur XII']);
    const au = await q({ characters: true, continuity: 'Shattered Crown', fields: ['id', 'Naming Culture'] });
    expect(au.rows).toEqual([[M.auChar, 'Menkheti', 'ok', expect.any(String)]]);
    const all = await q({ characters: true, fields: ['id'] });
    expect(col(all, 'id')).toContain(M.khepri);
  });
});

describe('shape and paging', () => {
  it('CSV, paging by offset and by cursor, the same rows either way', async () => {
    const page1 = await q({ characters: true, fields: ['id', 'name'], limit: 5 });
    expect(page1.returned).toBe(5);
    expect(page1.totalRows).toBeGreaterThan(5 + BULK.length - 1);
    expect(page1.nextCursor).toEqual(expect.any(String));
    const page2 = await q({ characters: true, fields: ['id', 'name'], limit: 5, cursor: page1.nextCursor });
    const byOffset = await q({ characters: true, fields: ['id', 'name'], limit: 5, offset: 5 });
    expect(page2.rows).toEqual(byOffset.rows);
    expect(page2.offset).toBe(5);
    const bad = await w.callRead('query_facts', {
      project: 'test',
      characters: true,
      fields: ['id'],
      cursor: page1.nextCursor,
    });
    expect(bad.body.error.code).toBe('CURSOR_INVALID');
    const csv = await q({ characters: true, fields: ['id', 'tags'], limit: 2, format: 'csv' });
    expect(csv.rows).toBeUndefined();
    const lines = (csv.csv as string).split('\r\n');
    expect(lines[0]).toBe('id,tags,coverage,readAt');
    expect(lines).toHaveLength(3);
    expect(toCsv(['a'], [[['x, y', 'z']]])).toBe('a\r\n"x, y; z"');
  });
});

describe('coverage and live', () => {
  it('stale and missing sidebars are flagged per row, never silently', async () => {
    w.stack.runtime.tree.store.markStale(PROJECT, [M.arin], 'test: a re-read failed');
    w.stack.db
      .prepare('UPDATE tree_nodes SET sidebar = NULL, props_observed_at = NULL WHERE project_id = ? AND id = ?')
      .run(PROJECT, M.zahira);
    const b = await q({ under: M.desk, type: 'Character Core', fields: ['id', 'Naming Culture'] });
    const row = (id: string) => b.rows.find((r: any[]) => r[0] === id);
    expect(row(M.arin)[2]).toBe('stale');
    expect(row(M.zahira)).toEqual([M.zahira, null, 'missing', null]);
    expect(row(M.mansur)[2]).toBe('ok');
    expect(b.coverage).toMatchObject({ stale: 1, missing: 1 });
    expect(b.notes.join(' ')).toMatch(/1 row\(s\) missing/);
  });

  it('live: an estimate above 10 rows, then confirm reads each row once and fills factsVersion', async () => {
    const before = w.requests().all;
    const est = await q({ characters: true, type: 'Character Core', fields: ['id', 'factsVersion'], live: true, limit: 12 });
    expect(est).toMatchObject({ status: 'estimate', reads: 12 });
    expect(w.requests().all).toBe(before);
    const b = await q({
      characters: true,
      type: 'Character Core',
      fields: ['id', 'Naming Culture', 'factsVersion'],
      live: true,
      limit: 12,
      confirm: true,
    });
    expect(w.requests().all - before).toBe(12);
    expect(col(b, 'factsVersion').every((v: unknown) => typeof v === 'string' && /^fv2_/.test(v))).toBe(true);
    expect(col(b, 'coverage').every((v: unknown) => v === 'live')).toBe(true);
    expect(b.cost).toBe('12 read(s)');
    const small = await q({ ids: undefined, under: M.mansurIndex, fields: ['id'], live: true });
    expect(small.status).toBeUndefined();
  });
});
