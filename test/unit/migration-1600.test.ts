import { describe, it, expect } from 'vitest';
import { openDatabase } from '../../src/db/open.js';
import { runMigrations, loadMigrations } from '../../src/db/migrate.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('migration 1600 (v2 C2c)', () => {
  it('rebuilds the tree tables with the new kinds, keeping names and cascades, and adds the two canon rules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'm'));
    const all = loadMigrations();
    const before = all.filter((m) => m.version < '1600');
    for (const m of before) writeFileSync(join(dir, m.file), m.sql);
    const db = openDatabase(':memory:');
    runMigrations(db, dir, { context: {} });
    db.prepare("INSERT INTO projects (id, name, created_at, updated_at, settings) VALUES ('p1','test',0,0,?)").run(JSON.stringify({ canonicalRules: [{ id: 'x', key: 'Status', kind: 'value', values: ['A'] }] }));
    db.prepare(`INSERT INTO tree_nodes (project_id,id,raw_name,display_name,kind,parent_id,rank,depth,path_ids,path_names,struct_observed_at,last_read_at,last_read_by,created_at,updated_at) VALUES ('p1','n1','[BWRK] X','[BWRK] X','unclassified',null,'a',0,'[]','[]',0,0,'build',0,0)`).run();
    db.prepare("INSERT INTO tree_names (project_id,node_id,field,name,name_key) VALUES ('p1','n1','raw','[BWRK] X','[bwrk] x')").run();
    runMigrations(db, undefined, { context: {} });
    expect(db.prepare('SELECT COUNT(*) n FROM tree_names').get()).toEqual({ n: 1 });
    db.prepare("UPDATE tree_nodes SET kind='bwrk' WHERE id='n1'").run();
    const rules = JSON.parse((db.prepare("SELECT settings FROM projects").get() as any).settings).canonicalRules;
    expect(rules.map((r: any) => r.id)).toEqual(['x', 'delete-archived', 'delete-document-authoritative']);
    db.prepare("DELETE FROM tree_nodes WHERE id='n1'").run();
    expect(db.prepare('SELECT COUNT(*) n FROM tree_names').get()).toEqual({ n: 0 });
  });
});
