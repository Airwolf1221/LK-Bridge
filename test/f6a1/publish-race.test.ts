/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- parsed JSON replies and log lines */
/**
 * v3 F6a.1 (ADR 0076 amendment 1): the publish race the sandbox saw on 24 November 2026. After "Publish vocabulary"'s job
 * succeeded, its governance check ran after the bridge had stopped and closed the database (`TypeError: The database
 * connection is not open` from `packs/service.ts` `governance` → `PackStore.newVersion`): it was started with
 * `void …catch()`, so no stop could wait for it.
 *
 * Here the check's read of Source Formatting is held, the bridge is stopped while the check waits on it, and the read is
 * let go only once the database has closed (what the sandbox's timing did). The runtime now owns the check: the stop
 * aborts it and waits for it, so it ends before the database closes, writes nothing, and logs no error.
 */
import { Writable } from 'node:stream';
import { afterAll, expect, it } from 'vitest';
import { PROJECT } from '../packs/retag-world.js';
import { scaleWorld, type ScaleWorld } from './world.js';

let s: ScaleWorld | null = null;
afterAll(() => {
  // The test closes its world itself (that is what it tests).
  s = null;
});

it('a stop during the post-publish governance check logs no error and writes nothing after the database closes', async () => {
  const lines: Record<string, any>[] = [];
  let wrote = false;
  let readsAfterWrite = 0;
  let held = 0;
  let release: (() => void) | null = null;
  const released = new Promise<void>((r) => (release = r));
  let sourceDoc = '';
  s = await scaleWorld({
    pages: 40,
    snapshot: false,
    logStream: new Writable({
      write(chunk: Buffer, _e, cb) {
        for (const l of chunk.toString('utf8').split('\n')) if (l !== '') lines.push(JSON.parse(l));
        cb();
      },
    }),
    lkTransport: async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = init?.method ?? 'GET';
      const onSource = sourceDoc !== '' && url.includes(`/docs/${sourceDoc}/blocks`);
      // The publication's requests on Source Formatting: its read, the job's check read, the write, the read-back;
      // then the governance check's read: the second read after the write is the one held.
      if (onSource && method === 'PUT') wrote = true;
      else if (onSource && method === 'GET' && wrote && ++readsAfterWrite === 2) {
        held++;
        await Promise.race([
          released,
          new Promise((_, reject) =>
            init?.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error), {
              once: true,
            }),
          ),
        ]);
      }
      return fetch(input, init);
    },
  });
  const w = s.w;
  const rt = w.stack.runtime;
  const pack = rt.packs.get('arkona')!;
  sourceDoc = pack.governance.find((g) => g.key === 'source-formatting')!.documentId;

  const from = lines.length; // the start-up's own warnings (this world's environment) are not this test's
  const pub = await rt.referenceTypes.publish('owner', PROJECT);
  expect(pub.jobId).not.toBeNull();
  for (let i = 0; i < 200; i++) {
    const j = rt.engine.queries.getJob(PROJECT, pub.jobId!);
    if (j?.status === 'succeeded') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(rt.engine.queries.getJob(PROJECT, pub.jobId!)?.status).toBe('succeeded');
  // The check (after its debounce, since F6a.1) reads Source Formatting: that read is held.
  for (let i = 0; i < 400 && held === 0; i++) await new Promise((r) => setTimeout(r, 10));
  expect(held).toBe(1);

  // Stop while the check waits on its read; the read is let go only once the database has closed.
  const db = w.stack.db;
  const close = db.close.bind(db);
  (db as { close: () => typeof db }).close = () => {
    const r = close();
    release!();
    return r;
  };
  const t0 = Date.now();
  await w.close();
  s = null;
  // What a late check would do after the database closed has had its chance to happen.
  await new Promise((r) => setTimeout(r, 300));

  const bad = lines.slice(from).filter((l) => l.level >= 40);
  expect(bad.map((l) => `${l.msg} ${l.err?.message ?? ''}`)).toEqual([]);
  expect(JSON.stringify(lines)).not.toContain('The database connection is not open');
  // It was stopped, quietly: the abort is a debug line, not an error.
  expect(lines.some((l) => l.level === 20 && l.msg === 'background work stopped with the bridge')).toBe(true);
  // And the stop did not have to wait out its bound (the abort reached the held read).
  expect(Date.now() - t0).toBeLessThan(8_000);
});
