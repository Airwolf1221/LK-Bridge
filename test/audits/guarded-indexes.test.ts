/**
 * v3 F5b.2: a page the lifecycle guard always refuses to rename (or retag), the two lifecycle indexes first, is a finding
 * with no fix: automation never picks it, so the "skipped in a row for the same reason" brake never counts it and the
 * pages after it are reached.
 */
import { describe, expect, it } from 'vitest';
import type { AuditContext } from '../../src/audits/context.js';
import { indexTaxonomyCheck } from '../../src/audits/checks/index-taxonomy.js';
import { DEFAULT_LIFECYCLE } from '../../src/lifecycle/index.js';

const page = (id: string, rawName: string, tags: string[] = []) => ({
  id,
  kind: 'index',
  rawName,
  displayName: rawName.replace(/^\[[A-Z]+\]\s*/, ''),
  tags,
  parentId: null,
});

function ctxOf(pages: ReturnType<typeof page>[], o: { working?: string; archive?: string } = {}) {
  const approved = new Map(pages.map((p) => [p.id, { role: 'nav', subject: null }]));
  return {
    model: { pages: new Map(pages.map((p) => [p.id, p])) },
    lifecycle: {
      ...DEFAULT_LIFECYCLE,
      workingIndexId: o.working ?? null,
      archiveIndexId: o.archive ?? null,
      problem: null,
    },
    indexTaxonomy: {
      approved,
      tagsInForce: true,
      rules: { nav: ['Navigation'] },
    },
    narrativeIds: new Set<string>(),
  } as unknown as AuditContext;
}

describe('findings the lifecycle guard always refuses carry no fix', () => {
  const pages = [
    page('w', `[INDEX] ${DEFAULT_LIFECYCLE.indexNames.working}`),
    page('a', `[INDEX] ${DEFAULT_LIFECYCLE.indexNames.archived}`),
    page('x', '[INDEX] Zeta Group'),
    page('y', '[INDEX] Alpha Group'),
  ];

  it('the two lifecycle indexes (by id) get a finding that tells the owner what to do, and no fix', () => {
    const f = indexTaxonomyCheck(ctxOf(pages, { working: 'w', archive: 'a' })).filter(
      (x) => x.code === 'index_prefix',
    );
    expect(f.map((x) => x.pageId)).toEqual(['w', 'a', 'x', 'y']);
    for (const x of f.slice(0, 2)) {
      expect(x.fix ?? null).toBeNull();
      expect(x.message).toMatch(
        /a lifecycle index: rename it by hand in LegendKeeper, then confirm the lifecycle indexes again on the dashboard/,
      );
    }
  });

  it('they are known by name too when their ids are not confirmed yet (as lifecycle.find reads them)', () => {
    const f = indexTaxonomyCheck(ctxOf(pages)).filter((x) => x.code === 'index_prefix');
    expect(f.slice(0, 2).map((x) => x.fix ?? null)).toEqual([null, null]);
  });

  it('a code whose first findings are lifecycle indexes still has fixes for the rest, so a run goes on to them', () => {
    const three = [
      ...pages.slice(0, 2),
      page('w2', `[INDEX] ${DEFAULT_LIFECYCLE.indexNames.working}`),
      ...pages.slice(2),
    ];
    const f = indexTaxonomyCheck(ctxOf(three, { working: 'w', archive: 'a' })).filter(
      (x) => x.code === 'index_prefix',
    );
    // What automation's candidates keep (`fix !== null`): the first three are never offered, so they never skip.
    expect(f.slice(0, 3).every((x) => (x.fix ?? null) === null)).toBe(true);
    const actionable = f.filter((x) => (x.fix ?? null) !== null).map((x) => x.pageId);
    expect(actionable).toEqual(['x', 'y']);
  });

  it('index_tags on a lifecycle index is the same: reported, no fix', () => {
    const f = indexTaxonomyCheck(ctxOf(pages, { working: 'w', archive: 'a' })).filter(
      (x) => x.code === 'index_tags',
    );
    expect(f.map((x) => [x.pageId, (x.fix ?? null) === null])).toEqual([
      ['w', true],
      ['a', true],
      ['x', false],
      ['y', false],
    ]);
  });
});
