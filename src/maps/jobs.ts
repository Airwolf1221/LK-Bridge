/**
 * The steps of a map-feature job (v2 D2, ADR 0040): shared by the three tools and by the opt-in sandbox test, so the test
 * runs EXACTLY the job a tool submits against the real API (the sandbox runtime has no repository tree, so it cannot call
 * the tools themselves). Each job is: `bridge.expect` (the compare-and-swap inside the lock: the map read again and the
 * plan's resolved request judged against it, the body to send worked out from it), the write(s) with that body bound
 * (`bindBody`), and `bridge.verify` (the features read back). Nothing is decided here; the planning is plan.ts.
 */
import { EXPECT_STEP, VERIFY_STEP } from '../jobs/internal-steps.js';
import type { StepSpec } from '../jobs/types.js';
import { idOf, nameOf, typeOf, type Obj } from './features.js';
import type { Built, CreateRequest, DeleteRequest, UpdateRequest, VerifyInput } from './plan.js';

export const CHECK_LABEL = 'check';
export const VERIFY_LABEL = 'verify';

export interface MapJob {
  readonly steps: StepSpec[];
  readonly labels: string[];
  /** The documents the job holds the lock of from its first step to its last. */
  readonly holdDocuments: string[];
}

interface Where {
  readonly tool: string;
  readonly resourceId: string;
  readonly documentId: string;
  readonly page: { readonly id: string; readonly name: string };
  readonly document: { readonly id: string; readonly name: string | null };
}

const expectStep = (w: Where, checker: string, input: unknown): StepSpec => ({
  op: EXPECT_STEP,
  params: {
    body: {
      checks: [
        { label: 'map', kind: 'map', resourceId: w.resourceId, documentId: w.documentId, checker, input },
      ],
    },
  },
});

const verifyStep = (w: Where, label: string, input: VerifyInput, fromCheck: boolean): StepSpec => ({
  op: VERIFY_STEP,
  params: {
    body: {
      targets: [
        {
          kind: 'mapChecked',
          label,
          resourceId: w.resourceId,
          documentId: w.documentId,
          checker: 'maps.verify',
          input,
          ...(fromCheck ? { inputFrom: { step: 1, key: 'verify' } } : {}),
        },
      ],
    },
  },
});

/** A new feature: check, createFeature (body bound from the check), verify. */
export function createJob(w: Where, request: CreateRequest, built: Built): MapJob {
  const label = `${request.type} “${request.name}”`;
  return {
    steps: [
      expectStep(w, 'maps.create', { request }),
      {
        op: 'createFeature',
        params: { path: { resourceId: w.resourceId, documentId: w.documentId }, body: built.body },
        bindBody: { step: 1, key: 'feature' },
        journalOperation: {
          tool: w.tool,
          page: w.page,
          document: w.document,
          feature: { id: request.id, type: request.type, name: request.name },
        },
      },
      verifyStep(w, label, built.verify, true),
    ],
    labels: [CHECK_LABEL, `add the ${request.type} “${request.name}”`, VERIFY_LABEL],
    holdDocuments: [w.documentId],
  };
}

/** A changed feature: check, updateFeature (changed fields bound from the check), verify. */
export function updateJob(w: Where, feature: Obj, request: UpdateRequest, built: Built): MapJob {
  const fid = idOf(feature);
  const nm = nameOf(feature) || fid;
  const changes = built.changes ?? [];
  return {
    steps: [
      expectStep(w, 'maps.update', { request }),
      {
        op: 'updateFeature',
        params: {
          path: { resourceId: w.resourceId, documentId: w.documentId, featureId: fid },
          body: built.body,
        },
        bindBody: { step: 1, key: 'feature' },
        // The feature as the plan read it, which the check inside the lock confirmed is exactly what is there.
        journalPreImage: feature,
        journalOperation: {
          tool: w.tool,
          page: w.page,
          document: w.document,
          feature: { id: fid, type: typeOf(feature), name: nm },
          changes,
        },
      },
      verifyStep(w, `${typeOf(feature)} “${nm}”`, built.verify, true),
    ],
    labels: [CHECK_LABEL, `change the ${typeOf(feature)} “${nm}” (${changes.join(', ')})`, VERIFY_LABEL],
    holdDocuments: [w.documentId],
  };
}

/**
 * Features deleted deepest first (`order`: children before the folder that holds them; LegendKeeper leaves a folder's
 * features in place, so a stop part-way never leaves one pointing at a deleted folder), the folder's own journal entry
 * keeping every feature that went with it.
 */
export function deleteJob(w: Where, target: Obj, order: readonly Obj[], request: DeleteRequest): MapJob {
  const steps: StepSpec[] = [expectStep(w, 'maps.delete', { request })];
  const labels: string[] = [CHECK_LABEL];
  const last = order.length - 1;
  order.forEach((f, i) => {
    const fid = idOf(f);
    const nm = nameOf(f) || fid;
    steps.push({
      op: 'deleteFeature',
      params: { path: { resourceId: w.resourceId, documentId: w.documentId, featureId: fid } },
      journalOperation: {
        tool: w.tool,
        page: w.page,
        document: w.document,
        feature: { id: fid, type: typeOf(f), name: nm },
        ...(order.length > 1 ? { cascade: { root: idOf(target), position: i + 1, of: order.length } } : {}),
      },
      // The folder's own entry keeps every feature the cascade removed, in full (as a lane's delete keeps its events):
      // the engine's read gives the folder, this gives what went with it.
      ...(i === last && order.length > 1
        ? { journalPreImageWith: { removedWithIt: order.slice(0, last) } }
        : {}),
    });
    labels.push(`delete the ${typeOf(f)} “${nm}”`);
  });
  steps.push(
    verifyStep(
      w,
      order.length > 1 ? `${order.length} features deleted` : `${typeOf(target)} deleted`,
      {
        present: [],
        gone: order.map((f) => ({ id: idOf(f), label: `${typeOf(f)} “${nameOf(f) || idOf(f)}”` })),
      },
      false,
    ),
  );
  labels.push(VERIFY_LABEL);
  return { steps, labels, holdDocuments: [w.documentId] };
}
