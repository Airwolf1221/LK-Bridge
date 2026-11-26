/* eslint-disable @typescript-eslint/no-explicit-any -- LK results are untyped JSON */
/**
 * The setting packs' governance sources in a sandbox check (harness only; no product code).
 *
 * On the server the Arkona pack attached to `test` reads its governance sources (six pages) from project `arkona`. A
 * sandbox runtime registers only the sandbox project: it never holds another project's key, and the guard refuses any
 * project not marked as a sandbox. So, copied as they are (`copyBridgeState`), those sources read "project arkona is not
 * registered", the pack's governance is not current, and every tool that computes tags fails closed with
 * PACK_NOT_CURRENT. (The 23 November 2026 live run of f7-1-core failed C1 this way; the owners world of the mock suite
 * keeps its governance in `test`, which hid it.)
 *
 * A check that runs pack tools opts in with {@link ensureSandboxGovernance}: when a source's project is not registered
 * here, it makes ONE throwaway governance page in the sandbox project (every pinned heading, with the sentences the
 * rules parse), points the pack's sources at it IN THE TEMPORARY DATABASE ONLY, and approves the pack there, as the
 * owner would: what identity-f5c's I1 has done since F5c. The bridge's own database and the `arkona` project are never
 * touched or read. When every source is already reachable, it does nothing.
 */
import { ARKONA_PACK } from '../../src/packs/arkona.js';
import { effectiveVocabulary } from '../../src/packs/reftypes/service.js';
import type { Runtime } from '../../src/runtime.js';
import type { RawLk } from './f4b-probe.js';
import { buildGovernanceBlocks } from './governance-blocks.js';
import { SWEEP_SENTENCE } from './automation-f5b.js';
import { SUPPLEMENTARY_SENTENCE } from './tagging-f5a.js';

type Obj = Record<string, any>;

export interface GovernanceReach {
  readonly pack: string;
  /** The projects the pack's governance sources are read from. */
  readonly projects: readonly string[];
  /** Those this runtime has not registered (the sources there cannot be read). */
  readonly missing: readonly string[];
}

/** Which projects a pack's governance sources need, and which of them this runtime lacks. Free (no request). */
export function governanceReach(rt: Runtime, packId: string): GovernanceReach {
  const pack = rt.packs.get(packId);
  const projects = [...new Set((pack?.governance ?? []).map((g) => g.project.toLowerCase()))];
  const have = new Set(
    rt.projects
      .list()
      .filter((p) => p.status !== 'archived')
      .map((p) => p.name.toLowerCase()),
  );
  return { pack: packId, projects, missing: projects.filter((p) => !have.has(p)) };
}

/** The refusal a pack check gives when its governance cannot be read here and it has not opted in. */
export function governanceMissingMessage(r: GovernanceReach): string {
  return (
    `the ${r.pack} pack's governance sources are read from project ${r.missing.join(', ')}, which this sandbox ` +
    `runtime does not register (it registers the sandbox project only), so every tag computation would fail ` +
    `PACK_NOT_CURRENT. The check must opt in to a throwaway governance page (ensureSandboxGovernance), as identity-f5c does.`
  );
}

export interface SandboxGovernance {
  /** True when the sources were pointed at a throwaway page (false: they were reachable already). */
  readonly replaced: boolean;
  /** The throwaway governance page (null when none was made); the caller deletes it when the check ends. */
  readonly resourceId: string | null;
  readonly documentId: string | null;
  readonly detail: string;
}

/**
 * Opt-in: makes the pack's governance current in the TEMPORARY database. If any source's project is not registered
 * here, creates `<label>` under `parentId` (a page document with every pinned heading), points every source (the
 * stored ones, plus any of the code's that are missing) at it, and approves the pack as the owner. `made` is called with
 * the page's id as soon as it exists, so the caller can defer its deletion even if a later step fails. Throws when the
 * governance is still not current afterwards.
 */
export async function ensureSandboxGovernance(o: {
  readonly rt: Runtime;
  readonly raw: RawLk;
  /** The bridge's name for the sandbox project (the governance sources' `project`). */
  readonly projectName: string;
  readonly packId: string;
  readonly parentId?: string;
  readonly label: string;
  readonly made?: (resourceId: string) => void;
  /**
   * v3 F6a: make the throwaway page even when every source is reachable, so a check that WRITES to governance
   * (f6a-reftypes publishes the vocabulary) never writes to the project's real governance pages.
   */
  readonly always?: boolean;
}): Promise<SandboxGovernance> {
  const { rt, raw, packId } = o;
  const pack = rt.packs.get(packId);
  if (!pack) throw new Error(`the ${packId} pack is not in this runtime`);
  const reach = governanceReach(rt, packId);
  if (reach.missing.length === 0 && o.always !== true) {
    const g = await rt.packs.governance(packId);
    if (g.state !== 'current') throw new Error(`the ${packId} pack is ${g.state}: ${g.message}`);
    return {
      replaced: false,
      resourceId: null,
      documentId: null,
      detail: `governance read from ${reach.projects.join(', ')} (registered here)`,
    };
  }
  const gov = await raw.request('createResource', 'POST', '/resources', {
    name: o.label,
    ...(o.parentId ? { parentId: o.parentId } : {}),
    documents: [{ name: 'Main', type: 'page' }],
  });
  const resourceId = String(gov.id);
  o.made?.(resourceId);
  const docs = (gov.documents ?? []) as Obj[];
  const documentId = String((docs.find((d) => d.name === 'Main') ?? docs[0])?.id ?? '');
  if (documentId === '') throw new Error(`the governance page ${resourceId} came back with no document`);
  const code = packId === ARKONA_PACK.id ? ARKONA_PACK.governance : [];
  const sources = [...pack.governance, ...code.filter((g) => !pack.governance.some((x) => x.key === g.key))];
  // v3 F6a/F6b (ADR 0076, 0079): the Reference Type Vocabulary and the Navigation and Subject Index Tags sections are
  // left out while their rules are drafts (the pins read "unpublished", never refusing the approval) and written for
  // real, from the copied pack state, once the owner has published them (a placeholder would not parse). A pinned
  // section the bridge parses that this helper cannot write fails here, naming the heading. See governance-blocks.ts.
  const vocab = pack.rules.referenceTypes;
  const projectId = rt.projects.list().find((p) => p.name.toLowerCase() === o.projectName.toLowerCase())?.id;
  // The lists "Publish vocabulary" writes: the pack's vocabulary and the owner's decisions (the copied database's).
  const vocabulary =
    vocab?.status === 'published' && typeof projectId === 'string'
      ? effectiveVocabulary(vocab, rt.referenceTypes.store.decisions(projectId)).lists
      : null;
  const built = buildGovernanceBlocks({
    label: o.label,
    sources,
    rules: pack.rules,
    vocabulary,
    supplementarySentence: SUPPLEMENTARY_SENTENCE,
    sweepSentence: SWEEP_SENTENCE,
    fallbackSweepSection: ARKONA_PACK.rules.automation?.section,
  });
  const { blocks, headings } = built;
  const path = `/resources/${resourceId}/docs/${documentId}/blocks`;
  const doc = await raw.request('getDocumentBlocks', 'GET', path);
  await raw.request('replaceDocumentBlocks', 'PUT', path, { blocks }, { ifMatch: String(doc.version) });
  rt.packs.store.setGovernance(
    packId,
    sources.map((g) => ({ ...g, project: o.projectName, resourceId, documentId })),
  );
  await rt.packs.commands.approve('owner', packId);
  const g = await rt.packs.governance(packId);
  if (g.state !== 'current')
    throw new Error(`the ${packId} pack is ${g.state} after the throwaway governance: ${g.message}`);
  return {
    replaced: true,
    resourceId,
    documentId,
    detail:
      `governance (read from ${reach.missing.length > 0 ? `${reach.missing.join(', ')}, not registered here` : `${reach.projects.join(', ')}, left untouched`}) pointed at the throwaway page ` +
      `${resourceId}, ${headings.length} pinned headings${built.published.length > 0 ? `, written as published: ${built.published.join('; ')}` : ''}; pack version ${rt.packs.get(packId)!.approved!.version} ` +
      'approved (temporary database only)',
  };
}
