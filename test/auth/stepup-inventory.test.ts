/* eslint-disable @typescript-eslint/no-unsafe-member-access -- parsed JSON replies in tests */
/**
 * ADR 0081 (the owner, 26 November 2026): only the credential changes ask for a fresh authenticator code. This test
 * enumerates every registered admin route that asks and fails when that set differs from the explicit list in
 * `stepup-routes.ts` (`STEP_UP_ROUTES`), either way:
 *
 * - statically: every call of `requireReauth` or `hasStepUp` in `src` is found, and the route whose handler makes it
 *   (`api.<method>('<path>', ...)` in `src/admin/routes/`) must be a registered route on the list; a call anywhere else,
 *   or a `REAUTH_REQUIRED` answer made by hand outside `src/admin/guard.ts`, fails. A conditional call counts: a route
 *   that asks only sometimes asks.
 * - by request: every listed route, sent by a session signed in but not stepped up, with an empty body, answers
 *   `403 REAUTH_REQUIRED` (the check comes before the route's own input checks); stepped up, it does not.
 *
 * The consent page's own step-up (`consentStepUp`) reads the same window and is tested in consent-stepup.test.ts; here
 * only its use of the window is pinned (`reauthUntil` read nowhere else but the Account page's report).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAdminStack, type AdminStack } from '../admin/helpers.js';
import { notSteppedUp, ownerSession, nowS, type Owner } from '../review/r4-sessions/helpers.js';
import { STEP_UP_ROUTES } from './stepup-routes.js';

const root = new URL('../../', import.meta.url).pathname;

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** The source without its comments (a comment may name `requireReauth(` without calling it). */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');

interface Scan {
  /** `METHOD /api/admin/path` of each route whose handler calls `requireReauth` or `hasStepUp`. */
  readonly asking: Set<string>;
  /** Calls, or hand-made `REAUTH_REQUIRED` answers, outside any admin route's handler. */
  readonly elsewhere: string[];
  /** Files that read a session's step-up window directly (`reauthUntil`). */
  readonly readsWindow: Set<string>;
}

function scan(): Scan {
  const asking = new Set<string>();
  const elsewhere: string[] = [];
  const readsWindow = new Set<string>();
  for (const file of filesUnder(join(root, 'src'))) {
    const rel = relative(root, file);
    const text = code(readFileSync(file, 'utf8'));
    if (/\breauthUntil\(/.test(text)) readsWindow.add(rel);
    if (rel === 'src/admin/guard.ts') continue; // where they are defined
    if (/['"`]REAUTH_REQUIRED['"`]/.test(text)) elsewhere.push(`${rel}: REAUTH_REQUIRED`);
    const calls = [...text.matchAll(/\b(requireReauth|hasStepUp)\(/g)];
    if (calls.length === 0) continue;
    if (!rel.startsWith('src/admin/routes/')) {
      elsewhere.push(`${rel}: ${calls.length} call(s)`);
      continue;
    }
    const routes = [...text.matchAll(/\bapi\.(get|post|put|delete|patch)\(\s*(['`])([^'`]*)\2/g)].map(
      (m) => ({
        at: m.index,
        key: `${m[1]!.toUpperCase()} /api/admin${m[3]!}`,
      }),
    );
    for (const c of calls) {
      const route = routes.filter((r) => r.at < c.index).at(-1);
      if (route) asking.add(route.key);
      else elsewhere.push(`${rel}: a call before any route`);
    }
  }
  return { asking, elsewhere, readsWindow };
}

let s: AdminStack;
let owner: Owner;
let project: string;
beforeAll(async () => {
  s = await startAdminStack();
  await s.runtime.ready;
  owner = notSteppedUp(s);
  project = s.runtime.projects.defaultProject().name;
});
afterAll(async () => {
  await s?.close();
});

const fill = (url: string) =>
  url.replace(/:([A-Za-z]+)/g, (_, k: string) => (k === 'name' ? project : 'adr81x'));
const sorted = (xs: Iterable<string>) => [...xs].sort();

describe('ADR 0081: the routes that ask for a fresh authenticator code', () => {
  it('the list names each route once, and every one is registered (or leaving)', () => {
    expect(new Set(STEP_UP_ROUTES).size).toBe(STEP_UP_ROUTES.length);
    const registered = new Set(s.routes.map((r) => `${r.method} ${r.url}`));
    expect(STEP_UP_ROUTES.filter((r) => !registered.has(r))).toEqual([]);
  });

  it('the routes whose handlers ask are exactly the list (a route not on it that asks fails)', () => {
    const { asking, elsewhere } = scan();
    const registered = new Set(s.routes.map((r) => `${r.method} ${r.url}`));
    // Every route found in the source is a registered one (so the scan reads the paths right).
    expect(sorted([...asking].filter((r) => !registered.has(r)))).toEqual([]);
    const listed = STEP_UP_ROUTES.filter((r) => registered.has(r));
    expect(sorted(asking)).toEqual(sorted(listed));
    expect(elsewhere).toEqual([]);
  });

  it('only the Account page and the consent page read the window themselves', () => {
    expect(sorted(scan().readsWindow)).toEqual(
      sorted([
        'src/admin/guard.ts',
        'src/admin/routes/security.ts',
        'src/auth/owner.ts',
        'src/auth/routes/authorize.ts',
      ]),
    );
  });

  it('every listed route answers 403 REAUTH_REQUIRED to a session not stepped up, before reading its input', async () => {
    const registered = new Set(s.routes.map((r) => `${r.method} ${r.url}`));
    const notAsking: string[] = [];
    for (const key of STEP_UP_ROUTES) {
      if (!registered.has(key)) continue;
      const [method, url] = key.split(' ') as [string, string];
      const res = await owner.call(method, fill(url), {});
      if (res.status !== 403 || res.json?.error?.code !== 'REAUTH_REQUIRED')
        notAsking.push(`${key} → ${res.status} ${res.text.slice(0, 160)}`);
    }
    expect(notAsking).toEqual([]);
  });

  it('stepped up within the window, none of them asks', async () => {
    const stepped = ownerSession(s, s.bridge.publicUrl);
    stepped.setReauth(nowS());
    const asked: string[] = [];
    // Only the routes whose answer to an empty body changes nothing (each refuses the input, or has nothing to do).
    for (const key of STEP_UP_ROUTES.filter((k) => !/totp\/enrol|keys\/generate|offsite\/connect/.test(k))) {
      const [method, url] = key.split(' ') as [string, string];
      if (!s.routes.some((r) => `${r.method} ${r.url}` === key)) continue;
      const res = await stepped.call(method, fill(url), {});
      if (res.json?.error?.code === 'REAUTH_REQUIRED') asked.push(key);
    }
    expect(asked).toEqual([]);
  });
});
