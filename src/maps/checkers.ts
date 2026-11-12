/**
 * The map-feature checks inside the lock (v2 D2, ADR 0040): the `bridge.expect` and `bridge.verify` map checkers the
 * map-feature tools' jobs use. LegendKeeper does not version features (no `version`, no `If-Match`), so the bridge's
 * own compare-and-swap is these checks: inside the document's lock, just before the write, the map is read again (its
 * settings and every feature) and the plan's RESOLVED request is judged against it. The write's body is worked out
 * from the map as it is then (pixels converted with the live image, the rank between the real neighbours), never from
 * the plan. A difference is a conflict and nothing is sent.
 */
import type { MapChecker, MapCheckContext } from '../jobs/internal-steps.js';
import type { StateDifference } from '../jobs/sidebar-state.js';
import {
  buildCreate,
  buildUpdate,
  checkDelete,
  mapState,
  verifyFeatures,
  type CreateRequest,
  type DeleteRequest,
  type Fail,
  type UpdateRequest,
  type VerifyInput,
} from './plan.js';

const conflict = (ctx: MapCheckContext, f: Fail): { differences: StateDifference[] } => ({
  differences: [
    { path: `${ctx.label} [${f.code}]`, expected: 'the state the plan was made on', actual: f.message },
  ],
});

const requestOf = <T>(ctx: MapCheckContext): T => (ctx.input as { request: T }).request;

/** The checkers, by name. */
export function mapCheckers(): Readonly<Record<string, MapChecker>> {
  return {
    /** A new feature: the body to send (coordinates and rank decided now) and what to see back. */
    'maps.create': (ctx) => {
      const state = mapState(ctx.document, ctx.features);
      const r = buildCreate(state, requestOf<CreateRequest>(ctx));
      if (!r.ok) return conflict(ctx, r);
      return { differences: [], bodies: { feature: r.body, verify: r.verify } };
    },
    /** A changed feature: still as planned; the changed fields (rank and converted coordinates decided now). */
    'maps.update': (ctx) => {
      const state = mapState(ctx.document, ctx.features);
      const r = buildUpdate(state, requestOf<UpdateRequest>(ctx));
      if (!r.ok) return conflict(ctx, r);
      if (r.noChange === true) {
        return {
          differences: [
            {
              path: `${ctx.label} [NOTHING_TO_CHANGE]`,
              expected: 'a change to make',
              actual: 'the feature already holds what was asked',
            },
          ],
        };
      }
      return { differences: [], bodies: { feature: r.body, verify: r.verify } };
    },
    /** Features to delete: each still as planned, and nothing new under a folder being deleted. */
    'maps.delete': (ctx) => {
      const state = mapState(ctx.document, ctx.features);
      const r = checkDelete(state, requestOf<DeleteRequest>(ctx));
      if (!r.ok) return conflict(ctx, r);
      return { differences: [] };
    },
    /**
     * After update_document gave a map its image: the document is a map and its image is the asset asked for (its id or,
     * where LegendKeeper reports no asset id, its url).
     */
    'maps.image': (ctx) => {
      const want = ctx.input as { assetId: string; url?: string | null } | null;
      const d = ctx.document;
      if (!want || !d) return { differences: [{ path: ctx.label, expected: 'a map', actual: '(not read)' }] };
      const diffs: StateDifference[] = [];
      if (d.type !== 'map')
        diffs.push({ path: `${ctx.label} type`, expected: 'map', actual: d.type ?? null });
      const img =
        d.mapImage !== null && typeof d.mapImage === 'object'
          ? (d.mapImage as Record<string, unknown>)
          : null;
      const sameAsset =
        img !== null && (img.assetId === want.assetId || (!!want.url && img.url === want.url));
      if (!sameAsset) {
        diffs.push({
          path: `${ctx.label} mapImage`,
          expected: want.assetId,
          actual: img === null ? null : (img.assetId ?? img.url ?? null),
        });
      }
      return { differences: diffs };
    },
    /** After the writes: each feature present as written (and between its neighbours), each deleted one gone. */
    'maps.verify': (ctx) => {
      const input = ctx.input as VerifyInput | null;
      if (!input)
        return {
          differences: [{ path: ctx.label, expected: 'a plan', actual: '(none: the check did not run)' }],
        };
      return { differences: verifyFeatures(ctx.features, input) };
    },
  };
}
