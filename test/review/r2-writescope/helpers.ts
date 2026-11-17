/**
 * CR-2026-11 round 2 (write scope): shared helpers for the adversarial tests in this directory. Each test asserts the
 * SAFE behaviour; it fails on the current code when the attack works.
 *
 * - `writeAgent`: a profile at scope `write` with the DEFAULT rails (as `newToken` makes it), low-level tools shown.
 * - `mutationsSince` / `writeCallsSince`: what reached the mock LegendKeeper.
 * - `modelSaveAsTemplate`: the mock tree has no `saveResourceAsTemplate`; this models the spec ("Creates a top-level
 *   template as a copy of the resource … the copy takes the resource's fields, properties and documents"), with
 *   `includeChildren` copying every descendant.
 * - `modelTemplateFields`: the spec says a template copy "takes the template's fields" (tags among them); the mock tree
 *   drops a template's tags on a copy. This wraps the world's from-template route to copy the template's tags (and
 *   each copied child's) as the spec says.
 */
import type { Client } from '@modelcontextprotocol/client';
import type { MockRequest, MockResponse } from '../../contract/mock-lk.js';
import type { DiscoverWorld } from '../../discover/world.js';
import type { Res } from '../../tree/model.js';

export interface Agent {
  readonly client: Client;
  readonly profileId: string;
  readonly patId: string;
}

/** A write-scope agent with the default rails (`newToken` keeps the defaults), its low-level tools shown. */
export async function writeAgent(w: DiscoverWorld, label: string): Promise<Agent> {
  const t = w.stack.newToken(label, 'write');
  w.stack.runtime.policy.commands.setShowLowLevelTools('owner', t.profileId, true);
  const client = await w.stack.connect(t.token);
  return { client, profileId: t.profileId, patId: t.patId };
}

/** The rails a profile has now (to show they are the defaults). */
export function railsOf(w: DiscoverWorld, profileId: string): unknown {
  const p = w.stack.runtime.policy.store.getProfile(profileId) as unknown as { rails?: unknown };
  return p?.rails;
}

export const mutationsSince = (w: DiscoverWorld, n: number) => w.repo.mutations.slice(n);
export const writeCallsSince = (w: DiscoverWorld, n: number) =>
  w.stack.mock.calls.slice(n).filter((c) => c.method !== 'GET');

/** Live descendants of a page in the model (not counting it). */
export function liveUnder(w: DiscoverWorld, id: string): Res[] {
  return w.repo.subtree(id).filter((r) => r.id !== id);
}

/** Waits for a job to finish (or 20 s). */
export async function settle(w: DiscoverWorld, project: string, jobId: string) {
  return w.stack.runtime.engine.wait(project, jobId, 20_000);
}

/** Models `saveResourceAsTemplate` (with `includeChildren`) on the mock tree, as the spec describes it. */
export function modelSaveAsTemplate(w: DiscoverWorld): void {
  w.overrides.set(/\/resources\/[^/]+\/save-as-template$/, (req: MockRequest): MockResponse | undefined => {
    if (req.method !== 'POST') return undefined;
    const m = /\/resources\/([^/]+)\/save-as-template$/.exec(req.path.replace(/\/$/, ''))!;
    const src = w.repo.live(decodeURIComponent(m[1]!));
    if (!src) return { status: 404, body: { code: 'NOT_FOUND', message: 'not found' } };
    const body = (req.body ?? {}) as { id?: string; name?: string; includeChildren?: boolean };
    if (body.id && w.repo.res.has(body.id))
      return { status: 409, body: { code: 'DUPLICATE_ID', message: 'dup' } };
    const copy = (r: Res, parentId: string | null, id?: string, name?: string): Res => {
      const kids = w.repo.children(r.id);
      const c = w.repo.seed({
        ...(id ? { id } : {}),
        name: name ?? r.name,
        parentId,
        tags: [...r.tags],
        props: false,
      });
      c.props = structuredClone(r.props);
      if (body.includeChildren === true) for (const k of kids) copy(k, c.id);
      return c;
    };
    const top = copy(src, null, body.id, body.name);
    w.repo.mutations.push({ op: 'saveResourceAsTemplate', id: top.id });
    return { status: 201, body: w.repo.resourceView(top) };
  });
}

/**
 * Wraps the world's from-template route so the copy (and every copied child) takes its template's tags, as the spec
 * says a copy "takes the template's fields". Falls back to the tree model's own route when the world has none.
 */
export function modelTemplateFields(w: DiscoverWorld): void {
  let inner: ((req: MockRequest) => MockResponse | undefined) | undefined;
  for (const [re, fn] of w.overrides) {
    if (re.source.includes('from-template')) {
      inner = fn;
      w.overrides.delete(re);
    }
  }
  const handler = (req: MockRequest): MockResponse | undefined => {
    if (req.method !== 'POST') return undefined;
    const before = new Set(w.repo.res.keys());
    const r = inner ? inner(req) : w.repo.respond(req);
    if (!r || r.status !== 201) return r;
    const body = req.body as { templateId: string };
    const tpl = w.repo.res.get(body.templateId);
    const id = (r.body as { id: string }).id;
    // The copy takes the template's tags; each copied child takes its own template child's (same names, same tree).
    const copy = w.repo.res.get(id);
    if (tpl && copy) {
      copy.tags = [...tpl.tags];
      const made = [...w.repo.res.values()].filter((x) => !before.has(x.id) && x.id !== id);
      const tplKids = liveUnder(w, tpl.id);
      for (const m of made) {
        const twin = tplKids.find((k) => k.name === m.name);
        if (twin) m.tags = [...twin.tags];
      }
      return { ...r, body: { ...(r.body as object), tags: [...copy.tags] } };
    }
    return r;
  };
  // First in the map, so it answers before anything else that matches.
  const rest = [...w.overrides.entries()];
  w.overrides.clear();
  w.overrides.set(/\/resources\/from-template$/, handler);
  for (const [k, v] of rest) w.overrides.set(k, v);
}
