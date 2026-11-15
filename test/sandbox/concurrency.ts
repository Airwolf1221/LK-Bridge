/**
 * v2 E4, PLAN-v2 10.6 test 2 (opt-in, WRITES; docs/reviews/E4-2026-11.md section 4): what LegendKeeper itself does
 * with simultaneous writes that carry the SAME expected version. The bridge never sends such writes (its per-document
 * locks serialise them and it checks versions itself inside the lock); this script sends them on purpose, straight
 * through the governor's raw client (`lk.call`, bypassing the engine and its locks; never a raw fetch around the
 * governor), on a throwaway page, to RECORD LegendKeeper's real behaviour. It reports; it fixes nothing.
 *
 * - C1: two `replaceDocumentBlocks` with one If-Match, sent together. Does LegendKeeper accept both (not an atomic
 *   compare-and-swap, as reported on 9 November 2026), or one and refuse the other with 412?
 * - C2: five `insertBlock` with one If-Match, sent together (several block writes racing).
 * - C3: the same two whole-document writes, one after the other (the control: the second must be refused with 412).
 *
 * Verdicts: PASS when LegendKeeper behaved as an atomic compare-and-swap; NOTED when it accepted more than one (that is
 * the behaviour 10.6 designs around, not a failure of the bridge); FAIL only when the control (C3) did not refuse a
 * stale version, which the bridge's whole design assumes it does. Everything lives under ONE throwaway root resource
 * (`lk-bridge concurrency <time>`), deleted at the end even after a failure; a delete answering 404 or ALREADY_DELETED
 * counts as cleaned. Every write of the set-up and the clean-up goes through test/sandbox/wait.ts.
 *
 * Cost: about 14 writes (1 create, 1 first block, 2 + 5 + 2 racing or control writes, 1 delete, a few retries at most)
 * and about 12 reads. Run with the write spacing at 0 for this runtime only (the wrapper does), so the racing writes
 * really leave together; the governor's tier counters still apply.
 */
import { mintClientId } from '../../src/jobs/ids.js';
import { BridgeLkError, BudgetWaitError } from '../../src/lk/errors.js';
import { SandboxGuardError, type Finding, type SmokeTarget, type Verdict } from './smoke.js';
import { runSettled, type WaitOptions } from './wait.js';

type Obj = Record<string, unknown>;

export interface ConcurrencyOptions {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly wait?: WaitOptions;
}

interface RawAnswer {
  readonly status: number;
  readonly code?: string;
  readonly version?: string;
}

const para = (id: string, text: string) => ({ id, kind: 'paragraph', content: [{ text }] });

export async function runConcurrencySandbox(
  t: SmokeTarget,
  expectedProjectId: string,
  o: ConcurrencyOptions = {},
): Promise<{ findings: Finding[] }> {
  const findings: Finding[] = [];
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const origin = { kind: 'test' as const, client: 'sandbox-concurrency', tool: 'sandbox-concurrency' };
  const record = (id: string, title: string, verdict: Verdict, detail: string) =>
    findings.push({ id, title, verdict, detail });
  const wait: WaitOptions = { ...(o.sleep ? { sleep: o.sleep } : {}), ...o.wait };
  const run = async (op: string, params: Obj = {}, extra: Obj = {}): Promise<unknown> =>
    runSettled(t, op, params, { origin, priority: 'P1', project: t.projectId, ...extra }, wait);

  // The same guard as every sandbox script: the key's own project must be the sandbox project.
  const projects = (await run('listProjects')) as { data?: { id: string }[] };
  const seen = (projects.data ?? []).map((p) => p.id);
  if (seen.length !== 1 || seen[0] !== expectedProjectId)
    throw new SandboxGuardError(
      `refusing to run: the key's project is ${seen.join(', ') || 'none'}, not the sandbox project ${expectedProjectId}`,
    );

  /** One RAW write through the governor (no engine, no lock): LegendKeeper's own answer. Parked for budget: again. */
  const raw = async (operationId: string, method: string, suffix: string, ifMatch: string, body: unknown) => {
    for (let tries = 0; ; tries++) {
      try {
        const res = await t.lk.call<Response>({
          operationId,
          priority: 'P1',
          input: { ifMatch, body },
          run: () =>
            t.lk.fetch(`${t.baseUrl}/api/v3/projects/${t.projectId}${suffix}`, {
              method,
              headers: {
                authorization: `Bearer ${t.apiKey}`,
                'content-type': 'application/json',
                'if-match': ifMatch,
              },
              body: JSON.stringify(body),
            }),
        });
        const json = (await res.json().catch(() => ({}))) as Obj;
        const etag = res.headers.get('etag')?.replace(/^W\//, '').replace(/"/g, '');
        return {
          status: res.status,
          ...(typeof json.version === 'string' ? { version: json.version } : etag ? { version: etag } : {}),
        } as RawAnswer;
      } catch (e) {
        if (e instanceof BudgetWaitError && tries < 5) {
          await sleep(Math.max(1000, e.retryAtMs - Date.now()));
          continue;
        }
        if (e instanceof BridgeLkError)
          return { status: e.status ?? 0, ...(e.code ? { code: e.code } : {}) } as RawAnswer;
        throw e;
      }
    }
  };
  const describe = (a: readonly RawAnswer[]) =>
    a.map((x) => `${x.status}${x.code ? ` ${x.code}` : ''}${x.version ? ` → ${x.version}` : ''}`).join('; ');

  let rootId: string | null = null;
  try {
    // ---- the throwaway page, with one block (its Main becomes a page)
    rootId = mintClientId(24);
    await run('createResource', {
      body: { id: rootId, name: `lk-bridge concurrency ${new Date().toISOString()}` },
    });
    const page = (await run('getResource', { path: { resourceId: rootId } })) as {
      documents?: { id: string; name?: string }[];
    };
    const docId = (page.documents ?? []).find((d) => d.name === 'Main')?.id ?? page.documents?.[0]?.id;
    if (!docId) throw new Error('the throwaway page has no document');
    await run('insertBlock', {
      path: { resourceId: rootId, documentId: docId },
      body: { block: para(mintClientId(8), 'start') },
    });
    const blocksPath = `/resources/${rootId}/docs/${docId}/blocks`;
    const versionNow = async () =>
      String(
        ((await run('getDocumentBlocks', { path: { resourceId: rootId, documentId: docId } })) as Obj)
          .version,
      );
    record('setup', 'a throwaway page with one block', 'pass', `root ${rootId}, document ${docId}`);

    // ---- C1: two whole-document writes with one version, together
    {
      const v = await versionNow();
      const a = para(mintClientId(8), 'written by A');
      const b = para(mintClientId(8), 'written by B');
      const answers = await Promise.all([
        raw('replaceDocumentBlocks', 'PUT', blocksPath, v, { blocks: [a] }),
        raw('replaceDocumentBlocks', 'PUT', blocksPath, v, { blocks: [b] }),
      ]);
      const after = (await run('getDocumentBlocks', {
        path: { resourceId: rootId, documentId: docId },
      })) as Obj;
      const ok = answers.filter((x) => x.status >= 200 && x.status < 300).length;
      const held = ((after.blocks as Obj[] | undefined) ?? [])
        .map((x) => (x.content as { text?: string }[] | undefined)?.[0]?.text ?? '?')
        .join(' | ');
      const verdict: Verdict =
        ok === 1 && answers.some((x) => x.status === 412) ? 'pass' : ok >= 2 ? 'noted' : 'inconclusive';
      record(
        'C1',
        'two replaceDocumentBlocks with one If-Match, sent together',
        verdict,
        `answers: ${describe(answers)}; the page now holds: ${held}${ok >= 2 ? ' — LegendKeeper accepted both: its If-Match is not an atomic compare-and-swap (PLAN-v2 10.6: the bridge locks and checks itself)' : ''}`,
      );
    }

    // ---- C2: five block inserts with one version, together
    {
      const v = await versionNow();
      const answers = await Promise.all(
        [0, 1, 2, 3, 4].map((i) =>
          raw('insertBlock', 'POST', blocksPath, v, { block: para(mintClientId(8), `racer ${i}`) }),
        ),
      );
      const ok = answers.filter((x) => x.status >= 200 && x.status < 300).length;
      record(
        'C2',
        'five insertBlock with one If-Match, sent together',
        ok === 1 ? 'pass' : ok > 1 ? 'noted' : 'inconclusive',
        `${ok} of 5 accepted; answers: ${describe(answers)}`,
      );
    }

    // ---- C3: the control, one after the other: the second (stale) must be refused
    {
      const v = await versionNow();
      const first = await raw('replaceDocumentBlocks', 'PUT', blocksPath, v, {
        blocks: [para(mintClientId(8), 'first')],
      });
      const second = await raw('replaceDocumentBlocks', 'PUT', blocksPath, v, {
        blocks: [para(mintClientId(8), 'second')],
      });
      const okFirst = first.status >= 200 && first.status < 300;
      record(
        'C3',
        'the control: a stale If-Match one after the other is refused with 412',
        okFirst && second.status === 412 ? 'pass' : okFirst ? 'fail' : 'inconclusive',
        `first: ${describe([first])}; second: ${describe([second])}`,
      );
    }
  } catch (e) {
    record('run', 'the checks ran to the end', 'fail', e instanceof Error ? e.message : String(e));
  } finally {
    if (rootId) {
      try {
        await run('deleteResource', { path: { resourceId: rootId } });
        record('cleanup', 'the throwaway page is deleted', 'pass', `root ${rootId}`);
      } catch (e) {
        const gone =
          e instanceof BridgeLkError &&
          (e.status === 404 || e.code === 'ALREADY_DELETED' || e.code === 'NOT_FOUND');
        record(
          'cleanup',
          'the throwaway page is deleted',
          gone ? 'pass' : 'fail',
          gone
            ? `root ${rootId} (already gone)`
            : `could not delete ${rootId}: delete it by hand (${(e as Error).message})`,
        );
      }
    }
  }
  return { findings };
}

export function formatConcurrencyReport(findings: readonly Finding[]): string {
  const lines = findings.map((f) => `[${f.verdict.toUpperCase()}] (${f.id}) ${f.title}\n        ${f.detail}`);
  const n = (v: Verdict) => findings.filter((f) => f.verdict === v).length;
  return `${lines.join('\n')}\n\n${n('pass')} PASS, ${n('fail')} FAIL, ${n('inconclusive')} INCONCLUSIVE, ${n('noted')} NOTED\n`;
}
