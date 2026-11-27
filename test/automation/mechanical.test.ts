/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- the mock's raw state */
/**
 * v3 F5b (ADR 0068, H5): every flagged code's fix is mechanical. Each code is switched to Apply on its own and run on
 * the fixtures; the mock LegendKeeper's whole state (every page, sidebar, document and asset, as the mock holds them)
 * is compared before and after, independently of the bridge's own read-back: the difference must be exactly the code's
 * one transformation, on the pages the run reports as applied, and nothing else anywhere.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ELIGIBLE } from '../../src/automation/registry.js';
import { replaceRunDashes } from '../../src/appraisal/fixes.js';
import { automationWorld, DASH_ROLE, DASH_WORKING, PROJECT, type AutomationWorld } from './world.js';
import { narrativeAutomationWorld, type NarrativeAutomationWorld } from './narrative-world.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

type W = AutomationWorld | NarrativeAutomationWorld;
const VOLATILE = new Set(['updatedAt', 'createdAt', 'version', 'etag']);
const stable = (v: any): any =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .filter((k) => !VOLATILE.has(k))
            .sort()
            .map((k) => [k, stable(v[k])]),
        )
      : v;

/** The mock's whole state, by entity: `res:<id>`, `side:<id>`, `doc:<id>`, `asset:<id>`. */
function state(w: W): Map<string, any> {
  const out = new Map<string, any>();
  for (const r of (w.repo as any).res.values())
    if (r.deletedAt === null) out.set(`res:${r.id}`, stable((w.repo as any).resourceView(r)));
  for (const [id, sb] of (w as any).sidebars.pages as Map<string, any>)
    out.set(`side:${id}`, stable(sb.props));
  for (const [id, d] of w.repo.blocks as Map<string, any>) out.set(`doc:${id}`, stable(d.blocks));
  for (const [id, a] of (w as any).assets.assets as Map<string, any>) out.set(`asset:${id}`, stable(a));
  return out;
}

function changed(a: Map<string, any>, b: Map<string, any>): string[] {
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].filter((k) => JSON.stringify(a.get(k)) !== JSON.stringify(b.get(k))).sort();
}

const text = (b: any) => (b?.content ?? []).map((r: any) => r.text ?? r.mention?.text ?? '').join('');
const isBlank = (b: any) => b.kind === 'paragraph' && text(b).trim() === '';

/** Runs one code in Apply alone; returns the pages applied and the state before and after. */
async function applyAlone(w: W, code: string) {
  const a = w.stack.runtime.automation;
  await a.setMode('owner', PROJECT, code, 'apply');
  const before = state(w);
  const run = await a.run(PROJECT, 'manual');
  const after = state(w);
  await a.setMode('owner', PROJECT, code, 'off');
  const items = a.store.items(run.id).filter((i) => i.code === code);
  return {
    run,
    items,
    applied: items.filter((i) => i.outcome === 'applied').map((i) => i.pageId!),
    before,
    after,
  };
}

/** The entities a page owns (its resource, its sidebar, its documents). */
const owned = (w: W, pageId: string): string[] => {
  const r = (w.repo as any).res.get(pageId);
  const docs = r ? (w.repo as any).liveDocs(r).map((d: any) => `doc:${d.id}`) : [];
  return [`res:${pageId}`, `side:${pageId}`, ...docs];
};

/** What each code may change, checked entity by entity (before → after). */
const CHECK: Record<string, (key: string, b: any, a: any) => void> = {
  out_of_order: (k, b, a) => {
    expect(k).toMatch(/^res:/);
    expect({ ...a, rank: 0, pos: 0 }).toEqual({ ...b, rank: 0, pos: 0 });
    expect(a.parentId).toBe(b.parentId);
  },
  lifecycle_tag_not_leading: (k, b, a) => {
    expect(k).toMatch(/^res:/);
    expect({ ...a, tags: 0 }).toEqual({ ...b, tags: 0 });
    expect([...a.tags].sort()).toEqual([...b.tags].sort());
    expect(a.tags[0]).toMatch(/^(Working|Archived)$/);
  },
  retag_correction: (k, b, a) => {
    expect(k).toMatch(/^res:/);
    expect({ ...a, tags: 0 }).toEqual({ ...b, tags: 0 });
  },
  em_dash_name: (k, b, a) => {
    expect(k).toMatch(/^res:/);
    expect({ ...a, name: 0, rank: 0, pos: 0 }).toEqual({ ...b, name: 0, rank: 0, pos: 0 });
    expect(a.name).toBe(b.name.replace(/—/g, ' - '));
  },
  em_dash_text: (k, b, a) => {
    expect(k).toMatch(/^doc:/);
    expect(a.length).toBe(b.length);
    b.forEach((blk: any, i: number) => {
      const out = a[i];
      expect({ ...out, content: 0 }).toEqual({ ...blk, content: 0 });
      (blk.content ?? []).forEach((r: any, j: number) => {
        const t = typeof r.text === 'string' ? replaceRunDashes(r.text) : r.text;
        expect({ ...out.content[j], text: 0 }).toEqual({ ...r, text: 0 });
        expect(out.content[j].text).toBe(t);
      });
    });
  },
  blank_paragraphs: (k, b, a) => {
    expect(k).toMatch(/^doc:/);
    expect(a).toEqual(b.filter((x: any) => !isBlank(x)));
  },
  heading_links: (k, b, a) => {
    expect(k).toMatch(/^doc:/);
    expect(a.length).toBe(b.length);
    b.forEach((blk: any, i: number) => {
      if (JSON.stringify(blk) === JSON.stringify(a[i])) return;
      expect(blk.kind).toBe('heading');
      expect(a[i].kind).toBe('heading');
      expect(a[i].level).toBe(blk.level);
      expect(text(a[i])).toBe(text(blk));
      expect(JSON.stringify(a[i])).not.toMatch(/mention/);
    });
  },
  asset_extension: (k, b, a) => {
    expect(k).toMatch(/^asset:/);
    expect({ ...a, name: 0 }).toEqual({ ...b, name: 0 });
    expect(a.name).toBe(b.name.replace(/\.(png|jpe?g|webp|gif)$/i, '').trim());
  },
  related_noncurrent: (k, b, a) => {
    expect(k).toMatch(/^side:/);
    const diff = b.filter((p: any, i: number) => JSON.stringify(p) !== JSON.stringify(a[i]));
    expect(diff).toHaveLength(1);
    expect(diff[0].title).toBe('Related Sources');
    const after = a.find((p: any) => p.id === diff[0].id);
    const items = (p: any) => (p.items ?? p.rows ?? []).map((x: any) => JSON.stringify(x));
    expect(items(after).every((x: string) => items(diff[0]).includes(x))).toBe(true);
    expect(items(diff[0]).length - items(after).length).toBe(1);
  },
  narrative_number_mismatch: (k, b, a) => {
    expect(k).toMatch(/^side:/);
    const rows = (p: any[]) => p.flatMap((x) => (x.rows ?? []).map((r: any) => [r.key, JSON.stringify(r)]));
    const changedRows = rows(b).filter(([key, v]: any) => rows(a).find(([k2]: any) => k2 === key)?.[1] !== v);
    expect(changedRows.map(([key]: any) => key)).toEqual(['Chapter Number']);
  },
  narrative_link_broken: (k, b, a) => {
    expect(k).toMatch(/^side:/);
    const rows = (p: any[]) => p.flatMap((x) => (x.rows ?? []).map((r: any) => [r.key, JSON.stringify(r)]));
    const changedRows = rows(b).filter(([key, v]: any) => rows(a).find(([k2]: any) => k2 === key)?.[1] !== v);
    expect(changedRows).toHaveLength(1);
    expect(['Chapter', 'Chapter Plan']).toContain(changedRows[0][0]);
  },
  narrative_dateline_mismatch: (k, b, a) => {
    expect(k).toMatch(/^doc:/);
    // Only the first line: replaced (a wrong dateline) or put before the text; the prose echoed exactly.
    const rest = a.length === b.length ? a.slice(1) : a.slice(1);
    expect(rest).toEqual(a.length === b.length ? b.slice(1) : b);
    expect(text(a[0])).toMatch(/4A 400/);
  },
  narrative_tags: (k, b, a) => {
    expect(k).toMatch(/^res:/);
    expect({ ...a, tags: 0 }).toEqual({ ...b, tags: 0 });
    for (const t of b.tags) expect(a.tags).toContain(t);
    expect(a.tags).toContain('Narrative');
  },
};

describe('every flagged code’s fix is mechanical: the diff holds only its transformation', () => {
  let w: AutomationWorld;
  beforeAll(async () => {
    w = await automationWorld();
    await w.snapshot();
  });
  afterAll(async () => w?.close());

  for (const e of ELIGIBLE.filter((x) => !x.code.startsWith('narrative_'))) {
    it(e.code, async () => {
      // The Authoritative dash page is renamed in the app first: its fix would be a canonical change, which the canon
      // guard catches (pausing the code: engine.test.ts), so only the Working page's plain dash fix runs here.
      if (e.code === 'em_dash_name')
        (w.repo as any).res.get(DASH_ROLE).name = '[BSRC] Varn Harbour - Toll Ledger Annex';
      const r = await applyAlone(w, e.code);
      expect(r.applied.length, `${e.code}: ${JSON.stringify(r.items)}`).toBeGreaterThan(0);
      const diff = changed(r.before, r.after);
      // Every change is on what the run applied: the pages' own entities (an asset is its own entity).
      const allowed = new Set(
        r.applied.flatMap((id) => (e.target === 'asset' ? [`asset:${id}`] : owned(w, id))),
      );
      // A page moved among its siblings re-ranks only itself.
      expect(
        diff.filter((k) => !allowed.has(k)),
        e.code,
      ).toEqual([]);
      expect(diff.length).toBeGreaterThan(0);
      for (const k of diff) CHECK[e.code]!(k, r.before.get(k), r.after.get(k));
      if (e.code === 'em_dash_name') expect(r.applied).toEqual([DASH_WORKING]);
    });
  }
});

describe('the narrative codes (the narrative world)', () => {
  let w: NarrativeAutomationWorld;
  beforeAll(async () => {
    w = await narrativeAutomationWorld();
  });
  afterAll(async () => w?.close());

  for (const e of ELIGIBLE.filter((x) => x.code.startsWith('narrative_'))) {
    it(e.code, async () => {
      const r = await applyAlone(w, e.code);
      expect(r.applied.length, `${e.code}: ${JSON.stringify(r.items)}`).toBeGreaterThan(0);
      const diff = changed(r.before, r.after);
      const allowed = new Set(r.applied.flatMap((id) => owned(w, id)));
      expect(
        diff.filter((k) => !allowed.has(k)),
        e.code,
      ).toEqual([]);
      for (const k of diff) CHECK[e.code]!(k, r.before.get(k), r.after.get(k));
    });
  }
});
