/**
 * v3 F3d (renames), ADR 0058: the checks a rename's job makes inside its locks (the design's section 1, "one job, then
 * verification"), registered with the job engine:
 *
 * - `rename.subject` (expect): the subject still has its old name (or, for a job resumed after it renamed the subject,
 *   or a follow-up of the left-out items, the new one). Anything else ("someone renamed it meanwhile"): nothing runs.
 * - `rename.resource` (expect): each page the rename writes is as planned: its name (old, or new once renamed), its
 *   aliases and its tags (before, or after this rename's own change).
 * - `rename.document` (expect, a document check): each block the rename edits is as planned apart from this rename's
 *   own edits (its fingerprint), and its new body is worked out from the block as it is now (`bindBody`).
 * - `rename.document.verify` (read-back): each approved occurrence now shows the new name, nothing else changed.
 * - `rename.asset` (expect) and `rename.asset.verify` (read-back): an asset's (or folder's) name before and after.
 * - `rename.pack` (expect): the pack version the owner APPROVED maps the new culture or race value to its new token.
 */
import type { JobEngine } from '../../jobs/engine.js';
import type {
  DocumentCheckContext,
  DocumentCheckResult,
  RegisteredCheckContext,
  RegisteredCheckResult,
} from '../../jobs/internal-steps.js';
import type { StateDifference } from '../../jobs/sidebar-state.js';
import type { Packs } from '../service.js';
import { applyEdits, blockOccurrences, findBlock, fingerprint, writable, type BlockEdit } from './text.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export const RENAME_CHECKS = {
  subject: 'rename.subject',
  resource: 'rename.resource',
  document: 'rename.document',
  documentVerify: 'rename.document.verify',
  asset: 'rename.asset',
  assetVerify: 'rename.asset.verify',
  pack: 'rename.pack',
} as const;

/** The input of a document check: the blocks it edits, each with its fingerprint and its edits. */
export interface DocumentEditsInput {
  readonly documentId: string;
  readonly oldName: string;
  readonly newName: string;
  readonly blocks: readonly {
    readonly blockId: string;
    readonly fingerprint: string;
    readonly edits: readonly BlockEdit[];
    /** Where it is, for the owner. */
    readonly where?: string;
  }[];
}

/** The key a block's new body is kept under in the check's result. */
export const blockKey = (documentId: string, blockId: string) => `block:${documentId}:${blockId}`;

function documentCheck(ctx: DocumentCheckContext): DocumentCheckResult {
  const input = ctx.input as DocumentEditsInput;
  const differences: StateDifference[] = [];
  const bodies: Record<string, unknown> = {};
  for (const b of input.blocks) {
    const block = findBlock(ctx.document.blocks, b.blockId);
    if (!block) {
      differences.push({ path: `${ctx.label} ${b.blockId}`, expected: 'the block', actual: '(gone)' });
      continue;
    }
    if (fingerprint(block, input.oldName, input.newName) !== b.fingerprint) {
      differences.push({
        path: `${ctx.label} ${b.where ?? b.blockId}`,
        expected: 'the block as the rename was planned on it',
        actual: 'changed since (an outside edit is never overwritten)',
      });
      continue;
    }
    const next = applyEdits(block, b.edits, input.oldName, input.newName);
    if (!next) {
      differences.push({
        path: `${ctx.label} ${b.where ?? b.blockId}`,
        expected: 'the occurrences the rename was planned on',
        actual: 'not found',
      });
      continue;
    }
    bodies[blockKey(input.documentId, b.blockId)] = writable(next);
  }
  return { differences, bodies, observed: { blocks: input.blocks.length } };
}

function documentVerify(ctx: DocumentCheckContext): DocumentCheckResult {
  const input = ctx.input as DocumentEditsInput;
  const differences: StateDifference[] = [];
  for (const b of input.blocks) {
    const block = findBlock(ctx.document.blocks, b.blockId);
    if (!block) {
      differences.push({ path: `${ctx.label} ${b.blockId}`, expected: 'the block', actual: '(gone)' });
      continue;
    }
    if (fingerprint(block, input.oldName, input.newName) !== b.fingerprint) {
      differences.push({
        path: `${ctx.label} ${b.where ?? b.blockId}`,
        expected: 'the block with only the rename’s edits',
        actual: 'other changes',
      });
      continue;
    }
    const found = blockOccurrences(block, input.oldName, input.newName);
    for (const e of b.edits) {
      const o = e.kind === 'text' ? found.text[e.ordinal] : found.mentions[e.ordinal];
      if (!o || o.isOld)
        differences.push({
          path: `${ctx.label} ${b.where ?? b.blockId}`,
          expected: input.newName,
          actual: o ? input.oldName : '(not found)',
        });
    }
  }
  return { differences };
}

async function subjectCheck(ctx: RegisteredCheckContext): Promise<RegisteredCheckResult> {
  const input = ctx.input as { resourceId: string; oldName: string; newName: string };
  const r = await ctx.read('getResource', { path: { resourceId: input.resourceId } });
  const name = str((r.body as Obj | null)?.name);
  if (!r.exists || name === null)
    return {
      differences: [],
      refusal: {
        code: 'SUBJECT_GONE',
        message: `The page this rename is about (${input.oldName}) is gone. Nothing was written.`,
      },
    };
  if (name !== input.oldName && name !== input.newName)
    return {
      differences: [],
      refusal: {
        code: 'SUBJECT_RENAMED',
        message: `${input.oldName} is called “${name}” now: someone renamed it after this rename was planned. Nothing was written. Plan the rename again from its name now.`,
        details: { expected: input.oldName, actual: name },
      },
    };
  return { differences: [], observed: { name } };
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join('\u0001') === [...b].sort().join('\u0001');
const sameList = (a: readonly string[], b: readonly string[]) => a.join('\u0001') === b.join('\u0001');

async function resourceCheck(ctx: RegisteredCheckContext): Promise<RegisteredCheckResult> {
  const input = ctx.input as {
    resourceId: string;
    names: string[];
    aliases?: string[][];
    tags?: string[][];
  };
  const r = await ctx.read('getResource', { path: { resourceId: input.resourceId } });
  const body = (r.body ?? {}) as Obj;
  if (!r.exists || typeof body.deletedAt === 'string')
    return { differences: [{ path: ctx.label, expected: 'the page', actual: '(gone)' }] };
  const differences: StateDifference[] = [];
  const name = str(body.name) ?? '';
  if (!input.names.includes(name))
    differences.push({ path: `${ctx.label} name`, expected: input.names[0] ?? '', actual: name });
  const aliases = Array.isArray(body.aliases)
    ? (body.aliases as unknown[]).filter((x) => typeof x === 'string')
    : [];
  if (input.aliases && !input.aliases.some((a) => sameSet(a, aliases)))
    differences.push({ path: `${ctx.label} aliases`, expected: input.aliases[0] ?? [], actual: aliases });
  const tags = Array.isArray(body.tags) ? (body.tags as unknown[]).filter((x) => typeof x === 'string') : [];
  if (input.tags && !input.tags.some((t) => sameList(t, tags)))
    differences.push({ path: `${ctx.label} tags`, expected: input.tags[0] ?? [], actual: tags });
  return { differences };
}

async function assetCheck(ctx: RegisteredCheckContext): Promise<RegisteredCheckResult> {
  const input = ctx.input as { assetId: string; names: string[]; folderId: string | null };
  const r = await ctx.read('getAsset', { path: { assetId: input.assetId } });
  const body = (r.body ?? {}) as Obj;
  if (!r.exists) return { differences: [{ path: ctx.label, expected: 'the asset', actual: '(gone)' }] };
  const differences: StateDifference[] = [];
  const name = str(body.name) ?? '';
  const want = ctx.phase === 'verify' ? input.names.slice(-1) : input.names;
  if (!want.includes(name))
    differences.push({ path: `${ctx.label} name`, expected: want[0] ?? '', actual: name });
  const folder = str(body.folderId) ?? str(body.parentId);
  if (input.folderId !== undefined && folder !== input.folderId)
    differences.push({ path: `${ctx.label} folder`, expected: input.folderId, actual: folder });
  return { differences };
}

function packCheck(packs: Pick<Packs, 'get' | 'store'>) {
  return (ctx: RegisteredCheckContext): Promise<RegisteredCheckResult> => {
    const input = ctx.input as { packId: string; map: 'culture' | 'race'; value: string; token: string };
    const pack = packs.get(input.packId);
    const rules =
      pack?.approved && pack.approved.version === pack.version
        ? pack.rules
        : pack?.approved
          ? packs.store.rulesAt(pack.id, pack.approved.version)
          : null;
    const have = rules?.tags[input.map]?.[input.value];
    if (have !== input.token)
      return Promise.resolve({
        differences: [],
        refusal: {
          code: 'PACK_TOKEN_NOT_APPROVED',
          message: `The pack version the owner approved does not map the ${input.map} “${input.value}” to the tag “${input.token}” (it maps it to ${have ? `“${have}”` : 'nothing'}). The new identity tags are not written until the owner approves the pack version holding the new token map on the Packs page; then Resume the job.`,
          details: {
            pack: input.packId,
            map: input.map,
            value: input.value,
            token: input.token,
            approved: have ?? null,
          },
        },
      });
    return Promise.resolve({ differences: [], observed: { version: pack?.approved?.version ?? null } });
  };
}

/** Registers the rename's checks with the engine. Returns an unregister. */
export function registerRenameChecks(
  engine: Pick<JobEngine, 'registerAsyncChecker' | 'registerChecker'>,
  packs: Pick<Packs, 'get' | 'store'>,
): () => void {
  const off = [
    engine.registerAsyncChecker(RENAME_CHECKS.subject, subjectCheck),
    engine.registerAsyncChecker(RENAME_CHECKS.resource, resourceCheck),
    engine.registerChecker(RENAME_CHECKS.document, documentCheck),
    engine.registerChecker(RENAME_CHECKS.documentVerify, documentVerify),
    engine.registerAsyncChecker(RENAME_CHECKS.asset, assetCheck),
    engine.registerAsyncChecker(RENAME_CHECKS.assetVerify, assetCheck),
    engine.registerAsyncChecker(RENAME_CHECKS.pack, packCheck(packs)),
  ];
  return () => {
    for (const f of off) f();
  };
}

/** Exposed for tests. */
export const renameCheckers = { documentCheck, documentVerify };

/** Whether a value is a block's edits list (for the planner's own checks). */
export const isEdits = (v: unknown): v is BlockEdit[] =>
  Array.isArray(v) && v.every((e) => isObj(e) && (e.kind === 'text' || e.kind === 'mention'));
