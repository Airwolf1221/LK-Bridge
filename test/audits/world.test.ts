/**
 * v2 E2 (ADR 0044): the audits against the REAL stack on the mock world: a full audit makes no request to LegendKeeper,
 * every finding records its snapshot and its age, a stale snapshot is flagged, findings are tracked across runs (new,
 * still present, gone), and acknowledging hides a finding until its evidence changes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidebarModel, T } from '../resources/world.js';
import { PROJECT } from '../tools/helpers.js';
import { A, auditsWorld, type AuditsWorld } from './world.js';

vi.setConfig({ testTimeout: 120_000 });

let w: AuditsWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const audits = () => w!.stack.runtime.audits;
const open = (o: Parameters<ReturnType<typeof audits>['list']>[1] = {}) =>
  audits().list(PROJECT, { limit: 1000, ...o }).findings;
const byCode = (code: string, pageId?: string) =>
  open().filter((f) => f.code === code && (pageId === undefined || f.pageId === pageId));

describe('a full audit of the mock world', () => {
  it('reads the snapshot store and the bridge’s database only: no request to LegendKeeper at all', async () => {
    w = await auditsWorld();
    await w.stack.runtime.snapshots.full(PROJECT, 'manual');
    await w.stack.runtime.audits.settled(); // the audit the full snapshot's own hook started
    const before = w.requests();
    const out = await audits().run(PROJECT, 'manual');
    expect(out.state, out.summary).toBe('succeeded');
    expect(w.requests()).toBe(before);
    const run = audits().store.latestRun(PROJECT)!;
    expect(run).toMatchObject({ state: 'succeeded', trigger: 'manual', changeSnapshots: 0, stale: false });
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    expect(run.pages).toBeGreaterThan(50);
  });

  it('finds what the world holds: every check, with the owner’s first findings', async () => {
    w = await auditsWorld();
    await w.snapshotAndAudit();
    // Kamigawa Miyuki: Reference Type "Character Reference" is not a registry value; the page's name gives the right one.
    const kami = byCode('unknown_reference_type', A.kami);
    expect(kami).toHaveLength(1);
    expect(kami[0]!.evidence).toMatchObject({
      found: 'Character Reference',
      expected: 'Compact Character Reference',
    });
    expect(kami[0]!.fix).toMatchObject({ kind: 'set_facts' });
    // Mehrana al-Khalid, Founder: another Reference Type, and a Subject that does not match the page.
    expect(byCode('unknown_reference_type', A.mehrana)[0]!.evidence).toMatchObject({
      found: 'Historical Character Reference',
      expected: 'Character Core',
    });
    const subject = byCode('subject_mismatch', A.mehrana)[0]!;
    expect(subject.evidence).toMatchObject({
      found: 'Mehrana al-Khalid',
      expected: 'Mehrana al-Khalid, Founder',
    });
    expect(subject.fix).toBeNull();
    // Unclassified, ordering (Cherry is the one that moves), references (each state of absence apart).
    expect(byCode('unclassified_page').map((f) => f.pageId)).toEqual([A.loose]);
    expect(byCode('out_of_order', A.zoo).length + byCode('out_of_order', A.cherry).length).toBe(1);
    expect(byCode('out_of_order', A.cherry)[0]!.fix).toMatchObject({
      kind: 'move_resource',
      args: { pageId: A.cherry, parentId: A.zoo },
    });
    const refs = open().filter((f) => f.pageId === A.linker && f.category === 'references');
    expect(refs.map((f) => [f.code, (f.evidence as { target: string }).target]).sort()).toEqual([
      ['inaccessible_target', T.general],
      ['missing_target', 'apple001'],
      ['missing_target', 'ghost001'],
    ]);
    // Keep regions: the two splittable paragraphs of one page, one of the icon page, the icon page, unsupported blocks.
    expect(
      byCode('line_break_paragraph', A.breaks)
        .map((f) => f.blockId)
        .sort(),
    ).toEqual(['bp1', 'bp3']);
    expect(byCode('line_break_paragraph', A.breaks).every((f) => f.fix?.kind === 'split_paragraph')).toBe(
      true,
    );
    expect(byCode('line_break_paragraph', A.icons).map((f) => f.blockId)).toEqual(['ip2']);
    expect(byCode('inline_icon_page').map((f) => f.pageId)).toEqual([A.icons]);
    expect(byCode('unsupported_blocks', A.icons)[0]!.evidence).toMatchObject({ total: 1 });
    // Templates were taken with the snapshot: pages follow their rules (the seeded defaults from the registry).
    expect(
      audits()
        .config(PROJECT)
        .effectiveRules.map((r) => r.id),
    ).toEqual(['character-core', 'character-compact', 'index']);
    expect(byCode('templates_unavailable')).toHaveLength(0);
  });

  it('every finding records its snapshot and its age; a change snapshot becomes the source of the page it changed', async () => {
    w = await auditsWorld();
    await w.snapshotAndAudit();
    const run = audits().store.latestRun(PROJECT)!;
    for (const f of open().filter((x) => x.pageId)) {
      expect(f.source).toMatchObject({
        kind: 'snapshot',
        snapshotId: run.snapshotId,
        baseSnapshotId: run.snapshotId,
      });
      expect(f.source.ageMs).toBeGreaterThanOrEqual(0);
    }
    // A bridge write makes a change snapshot; the next audit lays it over the full one.
    const c = await w.stack.connect();
    const r = await w.stack.call(c, 'update_resource', { project: 'test', page: A.apple, name: 'Apple pie' });
    expect(r.body.status, JSON.stringify(r.body)).toBe('written');
    await w.stack.runtime.snapshots.settled();
    await audits().run(PROJECT, 'manual');
    const after = audits().store.latestRun(PROJECT)!;
    expect(after.changeSnapshots).toBeGreaterThanOrEqual(1);
    expect(after.newestSnapshotId).not.toBe(after.snapshotId);
    expect(after.snapshotId).toBe(run.snapshotId);
    const model = open().find((f) => f.pageId === A.apple && f.source.kind === 'snapshot');
    if (model) expect(model.source).toMatchObject({ kind: 'snapshot' });
    // The page the write changed is now sourced from the change snapshot (a finding on it names that snapshot).
    const changed = open({ pageId: A.apple });
    for (const f of changed)
      expect((f.source as { snapshotId: string }).snapshotId).toBe(after.newestSnapshotId);
  });

  it('a snapshot older than the audit allows is flagged, and what it says is as of then', async () => {
    w = await auditsWorld();
    await w.snapshotAndAudit();
    expect(byCode('stale_snapshot')).toHaveLength(0);
    // Make the full snapshot three days old.
    w.stack.db.prepare('UPDATE snapshots SET taken_at = taken_at - ?').run(3 * 86_400_000);
    await audits().run(PROJECT, 'manual');
    const run = audits().store.latestRun(PROJECT)!;
    expect(run.stale).toBe(true);
    expect(run.snapshotAgeMs).toBeGreaterThan(2.9 * 86_400_000);
    const stale = byCode('stale_snapshot');
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ category: 'audit', severity: 'warning' });
    expect(stale[0]!.message).toMatch(/hours old/);
    // The limit is the owner's.
    audits().setConfig('owner', PROJECT, { settings: { maxSnapshotAgeHours: 24 * 5 } });
    await audits().run(PROJECT, 'manual');
    expect(audits().store.latestRun(PROJECT)!.stale).toBe(false);
    expect(byCode('stale_snapshot')).toHaveLength(0);
    expect(
      audits()
        .list(PROJECT, { state: 'gone', limit: 50 })
        .findings.map((f) => f.code),
    ).toContain('stale_snapshot');
  });

  it('with no complete full snapshot the run is skipped and nothing is committed', async () => {
    w = await auditsWorld();
    const out = await audits().run(PROJECT, 'manual');
    expect(out).toMatchObject({ state: 'skipped', skipped: true });
    expect(audits().store.summary(PROJECT).open).toBe(0);
  });
});

describe('findings across runs', () => {
  it('new, still present (first seen kept), gone (when), and back; the run after a full snapshot is automatic', async () => {
    w = await auditsWorld();
    await w.snapshotAndAudit(); // the first audit, started by the full snapshot itself
    const runs = audits().store.runs(PROJECT);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: 'snapshot', state: 'succeeded' });
    const loose = byCode('unclassified_page', A.loose)[0]!;
    expect(loose.firstSeenRun).toBe(runs[0]!.id);
    expect(audits().store.summary(PROJECT).new).toBe(audits().store.summary(PROJECT).open);

    // The owner names the page properly in LegendKeeper; the next nightly snapshot sees it.
    w.repo.live(A.loose)!.name = '[BSRC] Loose notes';
    await w.snapshotAndAudit();
    const second = audits().store.latestRun(PROJECT)!;
    expect(second.id).not.toBe(runs[0]!.id);
    // Named properly, the page is a [BSRC] page now, so the checks that apply to pages find it (and only it) anew.
    expect(second.counts).toMatchObject({ gone: 1, new: 2 });
    expect(
      audits()
        .list(PROJECT, { onlyNew: true })
        .findings.map((f) => [f.code, f.pageId])
        .sort(),
    ).toEqual([
      ['lifecycle_inconsistent', A.loose],
      ['no_matching_rule', A.loose],
    ]);
    const gone = audits()
      .list(PROJECT, { state: 'gone' })
      .findings.find((f) => f.code === 'unclassified_page')!;
    expect(gone).toMatchObject({ state: 'gone', resolvedRun: second.id });
    expect(gone.resolvedAt).toBeGreaterThan(gone.firstSeenAt);
    // Everything else is still present, with its first-seen date from the first run.
    const kami = byCode('unknown_reference_type', A.kami)[0]!;
    expect(kami).toMatchObject({ firstSeenRun: runs[0]!.id, lastSeenRun: second.id });

    // It goes wrong again: a new finding, first seen now.
    w.repo.live(A.loose)!.name = 'Loose notes again';
    await w.snapshotAndAudit();
    const third = audits().store.latestRun(PROJECT)!;
    const back = byCode('unclassified_page', A.loose)[0]!;
    expect(back).toMatchObject({ state: 'open', firstSeenRun: third.id, resolvedAt: null });
    expect(
      audits()
        .list(PROJECT, { onlyNew: true })
        .findings.map((f) => f.code),
    ).toEqual(['unclassified_page']);
    expect(
      audits()
        .list(PROJECT, { state: 'gone' })
        .findings.map((f) => f.code)
        .sort(),
    ).toEqual(['lifecycle_inconsistent', 'no_matching_rule']);
  });

  it('acknowledging hides a finding while the evidence persists, and it reappears when the evidence changes', async () => {
    w = await auditsWorld();
    await w.snapshotAndAudit();
    const f = byCode('out_of_order', A.cherry)[0]!;
    const total = audits().store.summary(PROJECT).open;
    audits().acknowledge('owner', PROJECT, f.id, 'The owner keeps the Zoo in this order.');
    expect(open().some((x) => x.id === f.id)).toBe(false);
    expect(audits().store.summary(PROJECT)).toMatchObject({ open: total - 1, acknowledged: 1 });
    expect(open({ acknowledged: 'only' }).map((x) => x.id)).toEqual([f.id]);
    // The audit log has it, with the reason.
    const log = w.stack.db
      .prepare("SELECT after FROM audit_log WHERE action = 'audits.acknowledge'")
      .all() as { after: string }[];
    expect(log).toHaveLength(1);
    expect(log[0]!.after).toContain('The owner keeps the Zoo in this order.');
    // Same evidence next run: still hidden.
    await w.snapshotAndAudit();
    expect(open().some((x) => x.id === f.id)).toBe(false);
    // The evidence changes (Cherry now belongs after another page's name), so the acknowledgement lapses.
    w.repo.live(A.banana)!.name = '[BSRC] Blackberry';
    await w.snapshotAndAudit();
    const again = open().find((x) => x.id === f.id)!;
    expect(again).toMatchObject({ acknowledgement: null, acknowledgementLapsed: true, state: 'open' });
    expect(again.evidence).toMatchObject({ belongsAfter: { name: '[BSRC] Blackberry' } });
    expect(open({ acknowledged: 'only' })).toEqual([]);
  });
});

describe('Arkona’s free-form Reference Types on the mock snapshot (15 Nov)', () => {
  const kinds = [
    'Continent',
    'Culture',
    'Historical Cross-National Conflict',
    'Magical Applications',
    'Creature',
    'Nation',
    'City',
    'Religion',
    'Deity',
    'Language',
    'Artefact',
    'Organisation',
    'Dynasty',
    'Battle',
    'Treaty',
    'Plant',
    'Mineral',
    'Trade Route',
    'Mythic Event',
    'Regional Cuisine',
  ];
  const ids = kinds.map((_, i) => `arkrt${String(i).padStart(3, '0')}`);

  it('about 20 distinct “… Reference” values give no unknown_reference_type unless strict; Mehrana I keeps her fix', async () => {
    w = await auditsWorld({
      seed: (world) => {
        kinds.forEach((k, i) =>
          world.repo.seed({
            id: ids[i]!,
            name: `[BSRC] Synthetic ${k} ${i}`,
            parentId: A.zoo,
            referenceType: `${k} Reference`,
          }),
        );
      },
    });
    kinds.forEach((k, i) =>
      w!.sidebars.page(ids[i]!, [
        SidebarModel.kv(`kvark${String(i).padStart(3, '0')}`, 'PROPERTIES', [
          ['Reference Type', `${k} Reference`],
        ]),
      ]),
    );
    const before = w.requests();
    await w.stack.runtime.snapshots.full(PROJECT, 'manual');
    const afterSnapshot = w.requests();
    await audits().settled();
    expect(w.requests()).toBe(afterSnapshot); // the audit itself reads nothing live
    expect(afterSnapshot).toBeGreaterThan(before);
    expect(open().filter((f) => f.code === 'unknown_reference_type' && ids.includes(f.pageId!))).toEqual([]);
    // Mehrana (“… - Character Core”, “Historical Character Reference”) is still flagged, with the fix.
    expect(byCode('unknown_reference_type', A.mehrana)[0]!).toMatchObject({
      evidence: { expected: 'Character Core' },
      fix: { kind: 'set_facts' },
    });
    // Strict mode flags every unknown value, Continent Reference included, with no fix.
    audits().setConfig('owner', PROJECT, { settings: { strictReferenceTypes: true } });
    await audits().run(PROJECT, 'manual');
    const strict = open().filter((f) => f.code === 'unknown_reference_type' && ids.includes(f.pageId!));
    expect(strict).toHaveLength(kinds.length);
    const continent = strict.find((f) => f.pageId === ids[0])!;
    expect(continent.evidence).toMatchObject({ found: 'Continent Reference', expected: null });
    expect(continent.fix).toBeNull();
  });
});
