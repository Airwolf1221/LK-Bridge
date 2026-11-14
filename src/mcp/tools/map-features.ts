/**
 * The map-feature tools (v2 D2, ADR 0040; PLAN-v2 section 5, Maps): `create_map_feature`, `update_map_feature` and
 * `delete_map_feature` for the pins, labels, regions, paths and folders of a map document of a page inside the AI
 * REPOSITORY.
 *
 * Each is ONE job (or one proposal under `propose`), journalled, verified and never replayed, with the bridge's own
 * compare-and-swap inside the document's lock (LegendKeeper does not version features): the job's first step reads the
 * map again and judges the plan's resolved request against it, and works out what to send from the map as it is THEN
 * (pixels converted with the live image, the rank between the real neighbours). `dryRun` writes nothing.
 *
 * Canon (ADR 0036 decision 6, option (a)): feature edits are ordinary edits, on an Authoritative page too. Only deleting
 * a whole map document of an Authoritative page is canonical (delete_document's rule); nothing here is gated.
 */
import * as z from 'zod';
import { mintClientId } from '../../jobs/ids.js';
import {
  FEATURE_TYPES,
  buildCreate,
  buildUpdate,
  createJob,
  deleteJob,
  updateJob,
  featureHash,
  featureView,
  findFeature,
  frameOfState,
  idOf,
  nameOf,
  parentOf,
  planDelete,
  styleFields,
  styleSchema,
  typeOf,
  type CreateRequest,
  type DeleteRequest,
  type MapState,
  type Obj,
  type Placement,
  type UpdateRequest,
  type VerifyInput,
} from '../../maps/index.js';
import type { McpToolProvider } from '../server.js';
import { withRequest, type CreateOutcome } from './create-support.js';
import { defineTool } from './define.js';
import { repoContext } from './repo.js';
import { CHANGE_ANNOTATIONS, CREATE_ANNOTATIONS, operationIdArg } from './resources.js';
import { pageRef } from './set-facts.js';
import { projectArg, render, withProject, type ProjectDeps, type ToolDeps } from './shape.js';
import {
  coordinateArgs,
  failResult,
  folderIdOf,
  linkArg,
  loadMap,
  parseGeometry,
  refArg,
  refuse,
  resolveLink,
  siblingIdOf,
} from './map-support.js';
import { runWriteJob } from './write-job.js';

/** Answers list at most this many removed features by name; the count is always exact. */
const LIST_MAX = 200;

const answer = (result: ReturnType<typeof render>): CreateOutcome => ({ kind: 'answer', result });

/** A body for a dry run, with long point lists replaced by their counts. */
function brief(body: Obj): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(body)) {
    const long = Array.isArray(v) && JSON.stringify(v).length > 600;
    out[k] = long ? { points: JSON.stringify(v).match(/\],\[|\]\]/g)?.length ?? 0, omitted: 'long list' } : v;
  }
  return out;
}

const nameOfId = (state: MapState, id: string | null): string | null => {
  if (id === null) return null;
  const f = state.features.find((x) => idOf(x) === id);
  return f ? nameOf(f) || id : id;
};

function placementInfo(state: MapState, verify: VerifyInput) {
  const p = verify.present[0]?.place;
  return p
    ? {
        after: nameOfId(state, p.after),
        before: nameOfId(state, p.before),
        folder: nameOfId(state, p.parentId),
      }
    : undefined;
}

// ============================================================================================ create

function createMapFeatureTool(deps: ToolDeps): McpToolProvider {
  const tool = 'create_map_feature';
  return defineTool({
    name: tool,
    title: 'Add a pin, label, region, path or folder to a map',
    access: 'write',
    description:
      'Adds one feature to a MAP document: a pin, label, region, path or folder. Give coordinates in ONE system per request: `pixel` { x, y }, counted from the image’s TOP-LEFT corner (use these when working from the image: read_document shows each position and the map’s size), or `latlng` [lat, lng]. A pin or label takes one position; a region `points` (3 or more) or `polygons`; a path `points` (2 or more); a folder none. Pixels need a map with an image (not a legacy tiled map); anything outside the image is refused unless allowOutside. `link` is a page by name or id (an ambiguous name is refused with the candidates), `folder` the parent folder, `style` LegendKeeper’s style fields. A feature goes at the END of its parent unless `after` or `before` names a sibling: maps are never sorted. `page` plus `document` identify the map (document is optional when the page has one). A blank document is not a map yet: give it an image with update_document. An ordinary edit, not canon-gated. At scope propose it becomes a proposal: nothing is written, never resubmit it, follow it with bridge_proposal_status. Cost: about 7 reads and 1 write.',
    inputSchema: z.object({
      page: pageRef.describe('The page (name or id).'),
      document: refArg
        .optional()
        .describe('The map document (name or id); optional when the page has one map.'),
      type: z.enum(FEATURE_TYPES),
      name: z.string().min(1).max(500),
      ...coordinateArgs,
      link: linkArg.optional(),
      folder: refArg.optional().describe('The parent folder (name or id). Default: the top level.'),
      after: refArg.optional().describe('Place it after this sibling (name or id) under the same parent.'),
      before: refArg.optional().describe('Place it before this sibling (name or id) under the same parent.'),
      hidden: z.boolean().optional(),
      style: styleSchema.optional(),
      dryRun: z.boolean().optional().describe('Show the plan (what would be sent); write nothing.'),
      operation_id: operationIdArg,
      project: projectArg,
    }),
    annotations: CREATE_ANNOTATIONS,
    handler: (args, mctx) =>
      withProject(deps, args.project, 'write', (pd) => {
        const rc = repoContext(pd);
        if (!rc.ok) return rc.result;
        const ctx = rc.ctx;
        return withRequest(pd, mctx, tool, args, null, async (): Promise<CreateOutcome> => {
          const gp = parseGeometry(pd, args);
          if (!gp.ok) return answer(gp.result);
          if (args.after !== undefined && args.before !== undefined) {
            return answer(refuse(pd, 'INVALID_PARAMS', 'Give `after` or `before`, not both.').result);
          }
          const m = await loadMap(pd, mctx, ctx, tool, args.page, args.document);
          if (!m.ok) return answer(m.result);
          const state = m.state;
          let parentId: string | null = null;
          if (args.folder !== undefined) {
            const f = folderIdOf(pd, state, args.folder);
            if (!f.ok) return answer(f.result);
            parentId = f.id;
          }
          let placement: Placement = { at: 'end' };
          const sib = args.after ?? args.before;
          if (sib !== undefined) {
            const s = siblingIdOf(pd, state, parentId, sib);
            if (!s.ok) return answer(s.result);
            placement = { at: args.after !== undefined ? 'after' : 'before', siblingId: s.id };
          }
          let uri: string | undefined;
          let linkView: Obj | undefined;
          if (args.link !== undefined) {
            const l = await resolveLink(pd, mctx, ctx, tool, args.link);
            if (!l.ok) return answer(l.result);
            uri = l.uri;
            linkView = l.view;
          }
          const id = mintClientId(24);
          const request: CreateRequest = {
            id,
            type: args.type,
            name: args.name.trim(),
            geometry: gp.geometry,
            allowOutside: args.allowOutside === true,
            frame: gp.geometry?.system === 'pixel' ? frameOfState(state.frame) : null,
            parentId,
            placement,
            ...(uri !== undefined ? { uri } : {}),
            ...(args.hidden !== undefined ? { hidden: args.hidden } : {}),
            style: styleFields(args.style),
          };
          const built = buildCreate(state, request);
          if (!built.ok) return answer(failResult(pd, built));
          const page = m.page;
          const document = m.document;
          const head = {
            page,
            document,
            feature: featureView(state, { ...built.body, id }),
            ...(linkView ? { link: linkView } : {}),
            placement: placementInfo(state, built.verify),
          };
          if (args.dryRun === true) {
            return answer(
              render(
                {
                  ...head,
                  status: 'dry_run',
                  wouldSend: brief(built.body),
                  message:
                    'Dry run: nothing was written. The rank and any converted coordinates are worked out again inside the lock.',
                },
                pd,
              ),
            );
          }
          const job = createJob(
            { tool, resourceId: m.node.id, documentId: m.doc.id, page, document },
            request,
            built,
          );
          const { steps, labels } = job;
          const summary = `${tool}: ${args.type} “${request.name}” on ${page.name} / ${document.name ?? document.id}`;
          const out = await runWriteJob(pd, mctx, tool, {
            steps,
            labels,
            title: summary,
            holdDocuments: job.holdDocuments,
            proposal: {
              operations: [
                {
                  tool,
                  page,
                  pageParts: [`${args.type} “${request.name}” added to ${document.name ?? 'the map'}`],
                  summaryLabel: summary,
                  map: head,
                },
              ],
              summary,
            },
            head,
            preview: () => head,
          });
          return { kind: 'job', head, labels, ...out };
        });
      }),
  });
}

// ============================================================================================ update

function updateMapFeatureTool(deps: ToolDeps): McpToolProvider {
  const tool = 'update_map_feature';
  return defineTool({
    name: tool,
    title: 'Change a map feature',
    access: 'write',
    description:
      'Changes one feature of a MAP document: its name, coordinates, link, folder, place, style or hidden flag; only what you give changes. Name it with `feature` (its id, or its name; add `featureFolder` when a name occurs more than once, or null for the top level). Coordinates, link and folder work as in create_map_feature (`pixel` or `latlng`, never both); `link: null` clears the link and `folder: null` moves it to the top level. A feature’s type cannot change (delete and add instead). An ordinary edit, not canon-gated. At scope propose it becomes a proposal: nothing is written, never resubmit it, follow it with bridge_proposal_status. Cost: about 7 reads and 1 write.',
    inputSchema: z.object({
      page: pageRef.describe('The page (name or id).'),
      document: refArg
        .optional()
        .describe('The map document (name or id); optional when the page has one map.'),
      feature: refArg.describe('The feature: its id, or its name.'),
      featureFolder: refArg
        .nullable()
        .optional()
        .describe('Where to look for it by name: a folder (name or id), or null for the top level only.'),
      name: z.string().min(1).max(500).optional(),
      ...coordinateArgs,
      link: linkArg.nullable().optional().describe('A page to link to, or null to clear the link.'),
      folder: refArg
        .nullable()
        .optional()
        .describe('Move it into this folder (name or id), or to the top level (null).'),
      after: refArg.optional().describe('Place it after this sibling (name or id) under its (new) parent.'),
      before: refArg.optional().describe('Place it before this sibling (name or id) under its (new) parent.'),
      hidden: z.boolean().optional(),
      style: styleSchema.optional(),
      dryRun: z.boolean().optional().describe('Show the plan (what would change); write nothing.'),
      operation_id: operationIdArg,
      project: projectArg,
    }),
    annotations: CHANGE_ANNOTATIONS,
    handler: (args, mctx) =>
      withProject(deps, args.project, 'write', (pd) => {
        const rc = repoContext(pd);
        if (!rc.ok) return rc.result;
        const ctx = rc.ctx;
        return withRequest(pd, mctx, tool, args, null, async (): Promise<CreateOutcome> => {
          const gp = parseGeometry(pd, args);
          if (!gp.ok) return answer(gp.result);
          if (args.after !== undefined && args.before !== undefined) {
            return answer(refuse(pd, 'INVALID_PARAMS', 'Give `after` or `before`, not both.').result);
          }
          const style = styleFields(args.style);
          const asked =
            args.name !== undefined ||
            gp.geometry !== null ||
            args.link !== undefined ||
            args.folder !== undefined ||
            args.after !== undefined ||
            args.before !== undefined ||
            args.hidden !== undefined ||
            Object.keys(style).length > 0;
          if (!asked) {
            return answer(
              refuse(
                pd,
                'INVALID_PARAMS',
                'Nothing to change: give a name, coordinates, link, folder, place, style or hidden.',
              ).result,
            );
          }
          const m = await loadMap(pd, mctx, ctx, tool, args.page, args.document);
          if (!m.ok) return answer(m.result);
          const state = m.state;
          const found = findFeature(state.features, args.feature, args.featureFolder);
          if (!found.ok) return answer(failResult(pd, found));
          const cur = found.feature;
          let parentId: string | null | undefined;
          if (args.folder === null) parentId = null;
          else if (args.folder !== undefined) {
            const f = folderIdOf(pd, state, args.folder);
            if (!f.ok) return answer(f.result);
            parentId = f.id;
          }
          let placement: Placement | undefined;
          const sib = args.after ?? args.before;
          if (sib !== undefined) {
            const target = parentId !== undefined ? parentId : parentOf(cur);
            const s = siblingIdOf(pd, state, target, sib, idOf(cur));
            if (!s.ok) return answer(s.result);
            placement = { at: args.after !== undefined ? 'after' : 'before', siblingId: s.id };
          }
          let uri: string | undefined;
          let linkView: Obj | undefined;
          if (args.link === null) uri = '';
          else if (args.link !== undefined) {
            const l = await resolveLink(pd, mctx, ctx, tool, args.link);
            if (!l.ok) return answer(l.result);
            uri = l.uri;
            linkView = l.view;
          }
          const request: UpdateRequest = {
            featureId: idOf(cur),
            expectedHash: featureHash(cur),
            ...(args.name !== undefined ? { name: args.name.trim() } : {}),
            ...(gp.geometry ? { geometry: gp.geometry } : {}),
            allowOutside: args.allowOutside === true,
            frame: gp.geometry?.system === 'pixel' ? frameOfState(state.frame) : null,
            ...(parentId !== undefined ? { parentId } : {}),
            ...(placement ? { placement } : {}),
            ...(uri !== undefined ? { uri } : {}),
            ...(args.hidden !== undefined ? { hidden: args.hidden } : {}),
            style,
          };
          const built = buildUpdate(state, request);
          if (!built.ok) return answer(failResult(pd, built));
          const page = m.page;
          const document = m.document;
          const before = featureView(state, cur);
          if (built.noChange === true) {
            return answer(
              render(
                {
                  page,
                  document,
                  feature: before,
                  status: 'no_change',
                  message: 'Nothing to change: the feature already holds this. Nothing was sent.',
                },
                pd,
              ),
            );
          }
          const head = {
            page,
            document,
            feature: before,
            changes: built.changes,
            after: featureView(state, { ...cur, ...built.body }),
            ...(linkView ? { link: linkView } : {}),
            ...(placementInfo(state, built.verify) ? { placement: placementInfo(state, built.verify) } : {}),
          };
          if (args.dryRun === true) {
            return answer(
              render(
                {
                  ...head,
                  status: 'dry_run',
                  wouldSend: brief(built.body),
                  message:
                    'Dry run: nothing was written. The rank and any converted coordinates are worked out again inside the lock.',
                },
                pd,
              ),
            );
          }
          const fid = idOf(cur);
          const nm = nameOf(cur) || fid;
          const job = updateJob(
            { tool, resourceId: m.node.id, documentId: m.doc.id, page, document },
            cur,
            request,
            built,
          );
          const { steps, labels } = job;
          const summary = `${tool}: ${typeOf(cur)} “${nm}” on ${page.name} / ${document.name ?? document.id} (${built.changes!.join(', ')})`;
          const out = await runWriteJob(pd, mctx, tool, {
            steps,
            labels,
            title: summary,
            holdDocuments: job.holdDocuments,
            proposal: {
              operations: [
                {
                  tool,
                  page,
                  pageParts: [`${typeOf(cur)} “${nm}” changed (${built.changes!.join(', ')})`],
                  summaryLabel: summary,
                  map: head,
                },
              ],
              summary,
            },
            head,
            preview: () => head,
          });
          return { kind: 'job', head, labels, ...out };
        });
      }),
  });
}

// ============================================================================================ delete

function deleteMapFeatureTool(deps: ToolDeps): McpToolProvider {
  const tool = 'delete_map_feature';
  return defineTool({
    name: tool,
    title: 'Delete a map feature',
    access: 'write',
    description:
      'Deletes one feature of a MAP document; `confirm: true` is required. Name it as update_map_feature does. A folder that holds features is refused unless `cascade: true`, which deletes them deepest first as one job; the answer lists everything removed and the journal keeps each feature in full. A stopped cascade resumes when you ask again. Deleting the whole map document is delete_document. At scope propose it becomes a proposal: nothing is written, never resubmit it, follow it with bridge_proposal_status. Cost: about 8 reads and 1 write per feature.',
    inputSchema: z.object({
      page: pageRef.describe('The page (name or id).'),
      document: refArg
        .optional()
        .describe('The map document (name or id); optional when the page has one map.'),
      feature: refArg.describe('The feature: its id, or its name.'),
      featureFolder: refArg
        .nullable()
        .optional()
        .describe('Where to look for it by name: a folder (name or id), or null for the top level only.'),
      confirm: z.literal(true).describe('Required: true.'),
      cascade: z.boolean().optional().describe('Also delete every feature under a folder.'),
      dryRun: z.boolean().optional().describe('Show what would be deleted; delete nothing.'),
      operation_id: operationIdArg,
      project: projectArg,
    }),
    annotations: { ...CHANGE_ANNOTATIONS, destructiveHint: true },
    handler: (args, mctx) =>
      withProject(deps, args.project, 'write', (pd) => {
        const rc = repoContext(pd);
        if (!rc.ok) return rc.result;
        const ctx = rc.ctx;
        return withRequest(pd, mctx, tool, args, null, async (): Promise<CreateOutcome> => {
          const m = await loadMap(pd, mctx, ctx, tool, args.page, args.document);
          if (!m.ok) return answer(m.result);
          const state = m.state;
          const found = findFeature(state.features, args.feature, args.featureFolder);
          if (!found.ok) return answer(failResult(pd, found));
          const target = found.feature;
          const plan = planDelete(state, idOf(target), args.cascade === true);
          if (!plan.ok) return answer(failResult(pd, plan));
          const order = plan.order;
          const page = m.page;
          const document = m.document;
          const views = order.map((f) => featureView(state, f));
          const head = {
            page,
            document,
            feature: featureView(state, target),
            removed: views.slice(0, LIST_MAX),
            removedCount: order.length,
            ...(order.length > LIST_MAX
              ? { note: `Only the first ${LIST_MAX} of ${order.length} are listed.` }
              : {}),
          };
          if (args.dryRun === true) {
            return answer(
              render(
                {
                  ...head,
                  status: 'dry_run',
                  message: `Dry run: nothing was deleted. ${order.length} feature(s) would be.`,
                },
                pd,
              ),
            );
          }
          const request: DeleteRequest = {
            ids: order.map(idOf),
            hashes: Object.fromEntries(order.map((f) => [idOf(f), featureHash(f)])),
            cascade: args.cascade === true,
          };
          const job = deleteJob(
            { tool, resourceId: m.node.id, documentId: m.doc.id, page, document },
            target,
            order,
            request,
          );
          const { steps, labels } = job;
          const summary = `${tool}: ${order.length > 1 ? `${typeOf(target)} “${nameOf(target)}” and ${order.length - 1} under it` : `${typeOf(target)} “${nameOf(target) || idOf(target)}”`} on ${page.name} / ${document.name ?? document.id}`;
          const out = await runWriteJob(pd, mctx, tool, {
            steps,
            labels,
            title: summary,
            holdDocuments: job.holdDocuments,
            proposal: {
              operations: [
                {
                  tool,
                  page,
                  pageParts: [`${order.length} map feature(s) deleted`],
                  summaryLabel: summary,
                  map: head,
                },
              ],
              summary,
            },
            head,
            preview: () => head,
          });
          return { kind: 'job', head, labels, ...out };
        });
      }),
  });
}

export function mapFeatureTools(deps: ToolDeps): McpToolProvider[] {
  return [createMapFeatureTool(deps), updateMapFeatureTool(deps), deleteMapFeatureTool(deps)];
}

export type { ProjectDeps };
