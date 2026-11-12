/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- LK results are untyped JSON */
/**
 * The sandbox smoke script (opt-in; see test/sandbox/README.md). It checks the open assumptions of chunk 2 against a
 * REAL LegendKeeper sandbox project and walks every entity family through create / read / update / delete.
 *
 * Safety: it refuses to run unless the API key's own project (from `listProjects`) is exactly the sandbox project id
 * the caller gave. Everything it creates lives under one throwaway root resource that is deleted at the end.
 * The same code runs, as a dry run, against the spec-driven mock in test/tools/sandbox-dryrun.test.ts.
 */
import type { JobEngine } from '../../src/jobs/index.js';
import type { LkClient } from '../../src/lk/index.js';
import { runSettled, waitForJob, type WaitOptions } from './wait.js';

export type Verdict = 'pass' | 'fail' | 'inconclusive' | 'skipped';
export interface Finding {
  readonly id: string;
  readonly title: string;
  readonly verdict: Verdict;
  readonly detail: string;
}

export interface SmokeTarget {
  readonly engine: JobEngine;
  readonly lk: LkClient;
  readonly projectId: string;
  readonly baseUrl: string;
  readonly apiKey: string;
}

export class SandboxGuardError extends Error {}

type Obj = Record<string, any>;

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export async function runSmoke(
  t: SmokeTarget,
  expectedProjectId: string,
  wait: WaitOptions = {},
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const origin = { kind: 'test' as const, client: 'sandbox-smoke', tool: 'sandbox-smoke' };
  const record = (id: string, title: string, verdict: Verdict, detail: string) =>
    findings.push({ id, title, verdict, detail });

  // The owner's run of 12 November 2026: a write parked for budget (`waiting_budget`) or queued behind the pacing has
  // not failed. Wait for it (never send it again), as assumptions.ts does, here and in the clean-up.
  const run = async (op: string, params: Obj = {}, extra: Obj = {}): Promise<any> =>
    runSettled(t, op, params, { origin, priority: 'P1', project: t.projectId, ...extra }, wait);
  const p = (path: Obj, rest: Obj = {}) => ({ path, ...rest });

  // ---- guard: the key must belong to exactly the sandbox project --------------------------------------------------
  const projects = (await run('listProjects')) as { data?: { id: string }[] };
  const ids = (projects.data ?? []).map((x) => x.id);
  if (ids.length !== 1 || ids[0] !== expectedProjectId || t.projectId !== expectedProjectId) {
    throw new SandboxGuardError(
      `Refusing to run: the key's project is [${ids.join(', ')}], not the sandbox project ${expectedProjectId}.`,
    );
  }

  // ---- (a) LK echoes a client-supplied x-request-id ---------------------------------------------------------------
  try {
    const rid = `lkb.smoke.${Date.now().toString(36)}`;
    const res = await t.lk.call<Response>({
      operationId: 'getProject',
      priority: 'P0',
      run: () =>
        t.lk.fetch(`${t.baseUrl}/api/v3/projects/${t.projectId}`, {
          headers: { authorization: `Bearer ${t.apiKey}`, 'x-request-id': rid },
        }),
    });
    const echoed = res.headers.get('x-request-id');
    record(
      'a',
      'LK echoes a client-supplied x-request-id',
      echoed === rid ? 'pass' : 'fail',
      `sent ${rid}, received ${echoed ?? '(none)'}`,
    );
  } catch (e) {
    record('a', 'LK echoes a client-supplied x-request-id', 'inconclusive', (e as Error).message);
  }

  // ---- the throwaway root -----------------------------------------------------------------------------------------
  const root = (await run('createResource', {
    body: { name: `lk-bridge smoke ${new Date().toISOString()}` },
  })) as Obj;
  const rootId = root.id as string;
  const mainDoc = (root.documents?.[0]?.id ?? '') as string;
  const family = async (id: string, title: string, fn: () => Promise<string>) => {
    try {
      record(id, title, 'pass', await fn());
    } catch (e) {
      record(id, title, 'fail', (e as Error).message);
    }
  };

  try {
    // ---- (b) block / row / infobox-property reads carry the document version, and it works as If-Match ------------
    await family(
      'b',
      'version on block, row and infobox-property reads equals the document version and works as If-Match',
      async () => {
        await run(
          'replaceDocumentBlocks',
          p(
            { resourceId: rootId, documentId: mainDoc },
            {
              body: {
                blocks: [
                  { kind: 'paragraph', content: [{ text: 'smoke' }] },
                  { kind: 'keyValue', rows: [{ key: 'Age', text: '30' }] },
                  { kind: 'infobox', rows: [{ kind: 'keyValue', rows: [{ key: 'Race', text: 'Elf' }] }] },
                ],
              },
            },
          ),
          { allowUnsupportedLoss: true },
        );
        const doc = await run('getDocumentBlocks', p({ resourceId: rootId, documentId: mainDoc }));
        const blocks = doc.blocks as Obj[];
        const para = blocks.find((b) => b.kind === 'paragraph')!;
        const kv = blocks.find((b) => b.kind === 'keyValue')!;
        const box = blocks.find((b) => b.kind === 'infobox')!;
        const path = { resourceId: rootId, documentId: mainDoc };
        const got = await run('getBlock', p({ ...path, blockId: para.id }));
        const rows = await run('listBlockRows', p({ ...path, blockId: kv.id }));
        const props = await run('listBlockProperties', p({ ...path, blockId: box.id }));
        const same = [got.version, rows.version, props.version].every((v) => v === doc.version);
        if (!same)
          throw new Error(
            `document ${doc.version}; getBlock ${got.version}; listBlockRows ${rows.version}; listBlockProperties ${props.version}`,
          );
        // As If-Match: write a row with the version a row read returned.
        await run(
          'createBlockRow',
          p({ ...path, blockId: kv.id }, { ifMatch: rows.version, body: { key: 'Height', text: '180' } }),
        );
        return `all four versions equal (${doc.version}); the row version was accepted as If-Match`;
      },
    );

    // ---- (d) create / read / update / delete round trips per family -----------------------------------------------
    await family('d.resources', 'resources: create, read, update, move, delete, restore', async () => {
      const c = (await run('createResource', { body: { name: 'child', parentId: rootId } })) as Obj;
      await run('getResource', p({ resourceId: c.id }));
      await run('updateResource', p({ resourceId: c.id }, { body: { name: 'child renamed' } }));
      await run('moveResource', p({ resourceId: c.id }, { body: { parentId: rootId } }));
      await run('deleteResource', p({ resourceId: c.id }));
      await run('restoreResource', p({ resourceId: c.id }));
      await run('deleteResource', p({ resourceId: c.id }));
      const many = (await run('createManyResources', {
        body: {
          resources: [
            { name: 'm1', parentId: rootId },
            { name: 'm2', parentId: rootId },
          ],
        },
      })) as Obj;
      return `created ${c.id}; batch of ${many.resources?.length ?? '?'}`;
    });

    await family(
      'd.documents',
      'documents: create, read, update, delete, restore, assign block ids',
      async () => {
        const d = (await run(
          'createDocument',
          p({ resourceId: rootId }, { body: { name: 'extra', type: 'page' } }),
        )) as Obj;
        const path = { resourceId: rootId, documentId: d.id };
        await run('getDocument', p(path));
        await run('updateDocument', p(path, { body: { name: 'extra renamed' } }));
        await run('listDocuments', p({ resourceId: rootId }));
        await run('deleteDocument', p(path));
        await run('restoreDocument', p(path));
        await run('assignBlockIds', p({ resourceId: rootId, documentId: mainDoc }));
        return `document ${d.id}`;
      },
    );

    await family('d.blocks', 'blocks and rows: insert, read, update, replace, move, delete', async () => {
      const path = { resourceId: rootId, documentId: mainDoc };
      const ins = (await run(
        'insertBlock',
        p(path, { body: { block: { kind: 'paragraph', content: [{ text: 'one' }] } } }),
      )) as Obj;
      const ins2 = (await run(
        'insertBlock',
        p(path, { body: { block: { kind: 'paragraph', content: [{ text: 'two' }] } } }),
      )) as Obj;
      await run('getBlock', p({ ...path, blockId: ins.id }));
      await run('updateBlock', p({ ...path, blockId: ins.id }, { body: { content: [{ text: 'one!' }] } }));
      await run(
        'replaceBlock',
        p({ ...path, blockId: ins.id }, { body: { kind: 'paragraph', content: [{ text: 'one?' }] } }),
      );
      await run('moveBlock', p({ ...path, blockId: ins2.id }, { body: { before: ins.id } }));
      await run('deleteBlock', p({ ...path, blockId: ins.id }));
      await run('deleteBlock', p({ ...path, blockId: ins2.id }));
      const doc = await run('getDocumentBlocks', p(path));
      const kv = (doc.blocks as Obj[]).find((b) => b.kind === 'keyValue')!;
      const rows = await run('listBlockRows', p({ ...path, blockId: kv.id }));
      const row = (rows.data as Obj[])[0]!;
      await run('updateBlockRow', p({ ...path, blockId: kv.id, rowId: row.id }, { body: { text: '31' } }));
      await run('deleteBlockRow', p({ ...path, blockId: kv.id, rowId: row.id }));
      return 'insert, get, update, replace, move, delete; rows list, update, delete';
    });

    await family('d.infobox', 'infobox properties and their rows', async () => {
      const path = { resourceId: rootId, documentId: mainDoc };
      const doc = await run('getDocumentBlocks', p(path));
      const box = (doc.blocks as Obj[]).find((b) => b.kind === 'infobox')!;
      const props = await run('listBlockProperties', p({ ...path, blockId: box.id }));
      const prop = (props.data as Obj[])[0]!;
      await run('getBlockProperty', p({ ...path, blockId: box.id, propertyId: prop.id }));
      const created = (await run(
        'createBlockProperty',
        p({ ...path, blockId: box.id }, { body: { kind: 'textField', children: [] } }),
      )) as Obj;
      await run(
        'updateBlockProperty',
        p({ ...path, blockId: box.id, propertyId: created.id }, { body: { title: 'Notes' } }),
      );
      await run('deleteBlockProperty', p({ ...path, blockId: box.id, propertyId: created.id }));
      const pr = await run('listBlockPropertyRows', p({ ...path, blockId: box.id, propertyId: prop.id }));
      const newRow = (await run(
        'createBlockPropertyRow',
        p({ ...path, blockId: box.id, propertyId: prop.id }, { body: { key: 'Eyes', text: 'green' } }),
      )) as Obj;
      await run(
        'updateBlockPropertyRow',
        p({ ...path, blockId: box.id, propertyId: prop.id, rowId: newRow.id }, { body: { text: 'blue' } }),
      );
      await run(
        'deleteBlockPropertyRow',
        p({ ...path, blockId: box.id, propertyId: prop.id, rowId: newRow.id }),
      );
      return `property ${prop.id}; ${(pr.data as unknown[]).length} row(s) before`;
    });

    await family('d.properties', 'sidebar properties and their rows', async () => {
      const prop = (await run(
        'createProperty',
        p({ resourceId: rootId }, { body: { kind: 'keyValue', rows: [] } }),
      )) as Obj;
      const path = { resourceId: rootId, propertyId: prop.id };
      await run('listProperties', p({ resourceId: rootId }));
      await run('getProperty', p(path));
      await run('updateProperty', p(path, { body: { title: 'Facts' } }));
      const row = (await run('createPropertyRow', p(path, { body: { key: 'k', text: 'v' } }))) as Obj;
      await run('listPropertyRows', p(path));
      await run('updatePropertyRow', p({ ...path, rowId: row.id }, { body: { text: 'v2' } }));
      await run('deletePropertyRow', p({ ...path, rowId: row.id }));
      await run('deleteProperty', p(path));
      return `property ${prop.id}`;
    });

    await family('d.timeline', 'timeline lanes and events', async () => {
      const d = (await run(
        'createDocument',
        p({ resourceId: rootId }, { body: { name: 'timeline', type: 'time' } }),
      )) as Obj;
      const path = { resourceId: rootId, documentId: d.id };
      const lane = (await run(
        'createLane',
        p(path, { body: { name: 'Lane', rank: 'a0', size: 'sm' } }),
      )) as Obj;
      const ev = (await run(
        'createEvent',
        p(path, { body: { laneId: lane.id, type: 'event', name: 'Event', start: 0 } }),
      )) as Obj;
      await run('listLanes', p(path));
      await run('listEvents', p(path));
      await run('getLane', p({ ...path, laneId: lane.id }));
      await run('getEvent', p({ ...path, eventId: ev.id }));
      await run('updateEvent', p({ ...path, eventId: ev.id }, { body: { name: 'Event 2' } }));
      await run('updateLane', p({ ...path, laneId: lane.id }, { body: { name: 'Lane 2' } }));
      await run('deleteEvent', p({ ...path, eventId: ev.id }));
      await run('deleteLane', p({ ...path, laneId: lane.id }));
      return `document ${d.id}`;
    });

    await family('d.map', 'map features', async () => {
      const d = (await run(
        'createDocument',
        p({ resourceId: rootId }, { body: { name: 'map', type: 'map' } }),
      )) as Obj;
      const path = { resourceId: rootId, documentId: d.id };
      const f = (await run(
        'createFeature',
        p(path, { body: { type: 'pin', name: 'Pin', pos: [0, 0] } }),
      )) as Obj;
      await run('listFeatures', p(path));
      await run('getFeature', p({ ...path, featureId: f.id }));
      await run('updateFeature', p({ ...path, featureId: f.id }, { body: { name: 'Pin 2' } }));
      await run('deleteFeature', p({ ...path, featureId: f.id }));
      return `document ${d.id}`;
    });

    await family('d.board', 'board content and shapes', async () => {
      const d = (await run(
        'createDocument',
        p({ resourceId: rootId }, { body: { name: 'board', type: 'board' } }),
      )) as Obj;
      const path = { resourceId: rootId, documentId: d.id };
      await run('getBoardContent', p(path));
      const made = (await run(
        'createBoardShapes',
        p(path, { body: { shapes: [{ type: 'geo', x: 0, y: 0 }] } }),
      )) as Obj;
      const shapes = await run('listBoardShapes', p(path));
      const shapeId = (made.shapes?.[0]?.id ?? (shapes.data as Obj[])[0]?.id) as string;
      await run('updateBoardShapes', p(path, { body: { shapes: [{ id: shapeId, x: 10 }] } }));
      await run('deleteBoardShapes', p(path, { body: { ids: [shapeId] } }));
      const now = await run('getBoardContent', p(path));
      await run(
        'replaceBoardContent',
        p(path, {
          ifMatch: now.version,
          body: { shapes: [], bindings: [], assets: [] },
        }),
      );
      return `document ${d.id}`;
    });

    await family('d.assets', 'asset folders', async () => {
      const f = (await run('createAssetFolder', { body: { name: 'smoke folder' } })) as Obj;
      await run('listAssets');
      await run('getAsset', p({ assetId: f.id }));
      await run('updateAsset', p({ assetId: f.id }, { body: { name: 'smoke folder 2' } }));
      await run('deleteAsset', p({ assetId: f.id }));
      return `folder ${f.id}`;
    });

    await family('d.calendars', 'calendars (a copy of a built-in one)', async () => {
      const list = await run('listCalendars');
      const base = ((list.data ?? list.calendars ?? list) as Obj[])[0]!;
      const spec: Obj = { ...base };
      for (const k of ['id', 'builtIn', 'isBuiltIn', 'version', 'readOnly']) delete spec[k];
      spec.name = 'smoke calendar';
      const c = (await run('createCalendar', { body: spec })) as Obj;
      await run(
        'updateCalendar',
        p({ calendarId: c.id }, { ifMatch: c.version, body: { ...spec, name: 'smoke calendar 2' } }),
      );
      await run('deleteCalendar', p({ calendarId: c.id }));
      return `calendar ${c.id}`;
    });

    await family('d.reads', 'projects, members, tags and search (reads)', async () => {
      await run('getProject');
      await run('listMembers');
      await run('listTags');
      await run('search', { query: { q: 'smoke' } });
      return 'ok';
    });

    // ---- (e) image upload end to end -------------------------------------------------------------------------------
    await family('e', 'image upload end to end (createImageUpload, PUT, createImageAsset)', async () => {
      const bytes = Buffer.from(PNG_1PX, 'base64');
      const r = await t.engine.submit({
        project: t.projectId,
        kind: 'upload_image',
        contentType: 'image/png',
        contentLength: bytes.length,
        dataBase64: PNG_1PX,
        name: 'smoke image',
        origin,
        priority: 'P1',
      });
      if (!('jobId' in r)) throw new Error(`not queued: ${r.status}`);
      const job = await waitForJob(t.engine, t.projectId, r.jobId, 'the upload job', wait);
      const asset = (job.result as Obj).asset as Obj;
      await run('getAsset', p({ assetId: asset.id }));
      await run('deleteAsset', p({ assetId: asset.id }));
      return `asset ${asset.id} (${asset.width}x${asset.height})`;
    });

    // ---- (f) template round trip ------------------------------------------------------------------------------------
    await family('f', 'template round trip (save as template, list, create from template)', async () => {
      const src = (await run('createResource', {
        body: { name: 'template source', parentId: rootId },
      })) as Obj;
      const tpl = (await run(
        'saveResourceAsTemplate',
        p({ resourceId: src.id }, { body: { name: 'smoke template' } }),
      )) as Obj;
      const list = (await run('listTemplates')) as Obj;
      const found = (list.data as Obj[]).some((x) => x.id === tpl.id);
      const made = (await run('createResourceFromTemplate', {
        body: { templateId: tpl.id, name: 'from template', parentId: rootId },
      })) as Obj;
      await run('deleteResource', p({ resourceId: made.id }));
      await run('deleteResource', p({ resourceId: tpl.id }));
      if (!found) throw new Error('the saved template is not in listTemplates');
      return `template ${tpl.id}; new resource ${made.id}`;
    });
  } finally {
    // Clean up: the whole throwaway tree goes (cascade, confirmed).
    try {
      await run('deleteResource', p({ resourceId: rootId }, { query: { cascade: true } }), {
        confirm: 'cascade',
      });
      record('cleanup', 'throwaway root deleted', 'pass', rootId);
    } catch (e) {
      record(
        'cleanup',
        'throwaway root deleted',
        'fail',
        `${rootId}: ${(e as Error).message}. Delete it by hand.`,
      );
    }
  }

  record(
    'c',
    'createManyResources failing part-way',
    'skipped',
    'Not safely testable against a real project. The engine verifies every minted id after an ambiguous outcome and re-sends only the missing items (ADR 0010; test/jobs/batch-recovery.test.ts). LK’s own guide says the call is not atomic.',
  );
  return findings;
}

export function formatReport(findings: readonly Finding[]): string {
  const mark = { pass: 'PASS', fail: 'FAIL', inconclusive: 'INCONCLUSIVE', skipped: 'SKIPPED' } as const;
  return [
    '',
    'LK-Bridge sandbox smoke report',
    '==============================',
    ...findings.map((f) => `[${mark[f.verdict]}] (${f.id}) ${f.title}\n        ${f.detail}`),
    '',
  ].join('\n');
}
