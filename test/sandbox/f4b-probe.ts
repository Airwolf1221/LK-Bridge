/* eslint-disable @typescript-eslint/no-explicit-any -- LK results are untyped JSON */
/**
 * v3 F4b (ADR 0064), the owner's sandbox run of consistency-f4b: its F2 failed because the probe's Authoritative
 * `[BSRC] … - Character Core` was created through the bridge's governed `createResource` as the system principal, and
 * the canon guard (rightly) refused it: an Authoritative page is canon, made only by the owner's canonical approval.
 *
 * So the two probe pages (the throwaway Core and the page restating its birth) and the throwaway index holding them are
 * made, and deleted again, with the sandbox's RAW LegendKeeper client, exactly as the assumptions checks make their
 * throwaway pages through the raw route (assumptions-r2's `raw`): `LkClient.call` with the governor's own `fetch`, so the
 * rate governor still paces and counts every request, but no job, no proposal and no guard of the bridge is involved.
 * The canon guard is not touched (it still refuses a governed `[BSRC]` create). Everything after the set-up (the
 * consistency check, the owner's pick, the approval, the read-back) goes through the bridge as before.
 */
import { DEFAULT_LK_BASE_URL } from '../../src/lk/constants.js';
import type { LkClient } from '../../src/lk/index.js';

type Obj = Record<string, any>;

/** One raw request: LegendKeeper's status and body (a non-2xx answer throws, with what LegendKeeper said). */
export interface RawLk {
  request(
    operationId: string,
    method: string,
    suffix: string,
    body?: unknown,
    o?: { readonly ifMatch?: string },
  ): Promise<Obj>;
}

/** The sandbox runtime's raw client for its project: the governor's pacing and counting, nothing of the bridge's. */
export function rawLk(o: {
  readonly lk: Pick<LkClient, 'call' | 'fetch'>;
  readonly projectId: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
}): RawLk {
  const base = (o.baseUrl ?? DEFAULT_LK_BASE_URL).replace(/\/+$/, '');
  return {
    async request(operationId, method, suffix, body, x = {}) {
      const res = await o.lk.call<Response>({
        operationId,
        priority: 'P1',
        ...(body !== undefined ? { input: { body } } : {}),
        run: () =>
          o.lk.fetch(`${base}/api/v3/projects/${o.projectId}${suffix}`, {
            method,
            headers: {
              authorization: `Bearer ${o.apiKey}`,
              ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
              // A versioned write sends the version it read (the governor refuses one without, on this route too).
              ...(x.ifMatch ? { 'if-match': x.ifMatch } : {}),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          }),
      });
      const text = await res.text();
      const parsed = text ? (JSON.parse(text) as Obj) : {};
      if (res.status < 200 || res.status > 299)
        throw new Error(
          `${operationId}: ${res.status} ${String(parsed.code ?? '')} ${String(parsed.message ?? '')}`,
        );
      return parsed;
    },
  };
}

export interface ProbePages {
  readonly index: string;
  readonly core: string;
  readonly page: string;
  readonly pageDoc: string;
}

/**
 * The probe (F2): a plain throwaway index `lk-bridge f4b check <stamp>` (under the AI REPOSITORY root when given), the
 * Character Core `[BSRC] <subject> - Character Core` (Temporal Scope "Born Camue 1st, 4A 100") and a plain page saying
 * "<subject> was born on Camue 1st, 4A 103.", all made with the raw client. `made` is told the index as soon as it
 * exists, so the clean-up finds it after any failure.
 */
export async function createProbePages(
  raw: RawLk,
  o: {
    readonly rootId?: string | undefined;
    readonly stamp: string;
    readonly subject: string;
    readonly made: (indexId: string) => void;
  },
): Promise<ProbePages> {
  const index = await raw.request('createResource', 'POST', '/resources', {
    name: `lk-bridge f4b check ${o.stamp}`,
    ...(o.rootId ? { parentId: o.rootId } : {}),
  });
  const indexId = String(index.id);
  o.made(indexId);
  const core = await raw.request('createResource', 'POST', '/resources', {
    name: `[BSRC] ${o.subject} - Character Core`,
    parentId: indexId,
  });
  const coreId = String(core.id);
  await raw.request('createProperty', 'POST', `/resources/${coreId}/properties`, {
    kind: 'keyValue',
    title: 'PROPERTIES',
    rows: [
      { key: 'Subject', text: o.subject },
      { key: 'Reference Type', text: 'Character Core' },
      { key: 'Temporal Scope', text: 'Born Camue 1st, 4A 100' },
    ],
  });
  const page = await raw.request('createResource', 'POST', '/resources', {
    name: `lk-bridge f4b restatement ${o.stamp}`,
    parentId: indexId,
    documents: [{ name: 'Main', type: 'page' }],
  });
  const pageId = String(page.id);
  const docs = (page.documents ?? []) as Obj[];
  const pageDoc = String((docs.find((d) => d.name === 'Main') ?? docs[0])?.id ?? '');
  if (pageDoc === '') throw new Error(`the restating page ${pageId} came back with no document`);
  const doc = await raw.request('getDocumentBlocks', 'GET', `/resources/${pageId}/docs/${pageDoc}/blocks`);
  if (typeof doc.version !== 'string')
    throw new Error(`the restating page's document ${pageDoc} has no version`);
  await raw.request(
    'replaceDocumentBlocks',
    'PUT',
    `/resources/${pageId}/docs/${pageDoc}/blocks`,
    {
      blocks: [
        {
          kind: 'paragraph',
          content: [{ text: `${o.subject} was born on Camue 1st, 4A 103, in the harbour quarter.` }],
        },
        { kind: 'paragraph', content: [{ text: 'This line stays as it is.' }] },
      ],
    },
    { ifMatch: doc.version },
  );
  return { index: indexId, core: coreId, page: pageId, pageDoc };
}

/** The clean-up: the throwaway index deleted with everything under it, with the raw client. */
export async function deleteProbe(raw: RawLk, indexId: string): Promise<void> {
  await raw.request('deleteResource', 'DELETE', `/resources/${indexId}?cascade=true`);
}
