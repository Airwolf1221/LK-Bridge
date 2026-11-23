/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON replies in tests */
/**
 * v3 F5a (ADR 0067, H10 and H11) on the Overview: a call the caller cancelled (`client`) is left out of "errors in the
 * last hour"; a write whose outcome is unknown is counted, and one left for the owner says so.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemClock } from '../../src/lk/index.js';
import { LkModel } from '../jobs/lk-model.js';
import { PROJECT, startAdminStack, type AdminStack } from './helpers.js';

const model = new LkModel(() => systemClock.now());
let stack: AdminStack;
beforeAll(async () => {
  stack = await startAdminStack({ respond: model.respond });
});
afterAll(() => stack.close());

describe('the Overview', () => {
  it('leaves a caller’s cancellation out of the error totals', async () => {
    const db = stack.runtime.engine.database;
    const add = db.prepare(
      `INSERT INTO errors (project_id, at, op_id, message, retryable, classification, fingerprint, code)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
    );
    const now = Date.now();
    add.run(PROJECT, now, 'listEvents', 'Cancelled by the caller', 'client', 'listEvents|ABORTED|', 'ABORTED');
    add.run(PROJECT, now, 'getResource', 'boom', 'upstream', 'getResource|CONNECTION_ERROR|', 'CONNECTION_ERROR');
    const r = await stack.get('/api/admin/overview?refresh=true');
    expect(r.json.errorsLastHour).toEqual({ count: 1, capped: false });
  });

  it('counts the writes whose outcome is unknown', async () => {
    const db = stack.runtime.engine.database;
    const id = Number(
      db
        .prepare(
          `INSERT INTO write_journal (project_id, at, op_id, risk, target_kind, bytes, outcome)
           VALUES (?, ?, 'replaceDocumentBlocks', 'destructive', 'document', 0, 'unknown')`,
        )
        .run(PROJECT, Date.now()).lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO write_reconciliations (journal_id, project_id, state, outcome, attempts, first_at)
       VALUES (?, ?, 'unresolved', 'unknown', 5, ?)`,
    ).run(id, PROJECT, Date.now());
    const r = await stack.get('/api/admin/overview?refresh=true');
    expect(r.json.unknownWrites).toEqual({ pending: 0, unresolved: 1 });
    const j = await stack.get(`/api/admin/journal/${id}`);
    expect(j.json.reconciliation).toMatchObject({ state: 'unresolved', outcome: 'unknown' });
  });
});
