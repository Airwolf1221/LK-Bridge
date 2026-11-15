/**
 * Lifecycle consistency, keep-region health and the chronology fold-in (v2 E2, ADR 0044; PLAN-v2 E2 row).
 *
 * **Lifecycle** (exactly as the E2 row states, C2d's set exception included). Every content page's prefix, Status,
 * status tag and location agree:
 *
 * - `[BSRC]` / Authoritative / CANON / its normal place (outside both lifecycle areas); beneath an index the owner lists
 *   as Authoritative without CANON (E5.3, "Design References"), `[BSRC]` / Authoritative / no CANON;
 * - `[BWRK]` / Working / Working / directly under `[INDEX] Working`;
 * - `[BARC]` / Archived / Archived / directly under `[INDEX] Archived`;
 *
 * and, the one exception, a whole set kept together: under an archived set's index (any `[INDEX]` page under
 * `[INDEX] Archived`) every content page is `[BARC]`; under a Working set's index (any `[INDEX]` under `[INDEX] Working`)
 * every content page is `[BWRK]`; a set's indexes carry the set's status tag and no Status. An incomplete lifecycle record
 * and an incomplete set record are reported with their pages. NEVER fixed by an audit: the lifecycle tools refuse an
 * inconsistent page (`LIFECYCLE_INCONSISTENT`) and the owner decides.
 *
 * **Keep regions** (ADR 0031): paragraphs holding a line break inside a text run (kept as keep regions; the fix splits
 * them), pages holding inline icons (which `write_page` cannot write back), `unsupported` blocks per page, and collection
 * blocks in page documents.
 *
 * **Chronology**: D1's `chronology-check` findings, taken from its last stored run, each kind its own code. Nothing is
 * re-implemented and nothing is read from LegendKeeper: the check is a separate job with its own schedule.
 */
import { areaOf, canonExemptionOfPage } from '../../lifecycle/settings.js';
import { contentPages, fact, factAmbiguous, type AuditContext } from '../context.js';
import type { AuditPage } from '../model.js';
import { nameKey } from '../model.js';
import type { FindingCode, FindingDraft } from '../types.js';

type State = 'authoritative' | 'working' | 'archived';
const STATE_OF: Record<string, State | undefined> = {
  bsrc: 'authoritative',
  bwrk: 'working',
  barc: 'archived',
};
const PREFIX: Record<State, string> = { authoritative: '[BSRC]', working: '[BWRK]', archived: '[BARC]' };

export function lifecycleCheck(ctx: AuditContext): FindingDraft[] {
  const out: FindingDraft[] = [];
  const lc = ctx.lifecycle;
  const ids = { workingIndexId: lc.workingIndexId, archiveIndexId: lc.archiveIndexId };
  const confirmed = lc.workingIndexId !== null && lc.archiveIndexId !== null;
  if (!confirmed)
    out.push({
      code: 'lifecycle_not_configured',
      message:
        'The two lifecycle indexes are not confirmed on the dashboard, so the audit could not check where pages are; the prefix, Status and status tag were still compared.',
      evidence: { working: lc.workingIndexId, archived: lc.archiveIndexId },
      sourceKind: 'bridge',
    });
  const tagOf: Record<State, string> = {
    authoritative: lc.tags.canon,
    working: lc.tags.working,
    archived: lc.tags.archived,
  };
  const hasTag = (p: AuditPage, tag: string) => p.tags.some((t) => nameKey(t) === nameKey(tag));

  for (const p of contentPages(ctx)) {
    const node = ctx.snapshotTree.node(p.id);
    if (!node) continue;
    const area = confirmed ? areaOf(node, ids) : null;
    const parent = p.parentId ? ctx.model.pages.get(p.parentId) : undefined;
    const areaIndexId =
      area === 'working' ? lc.workingIndexId : area === 'archived' ? lc.archiveIndexId : null;
    // The lifecycle indexes themselves are the areas, not pages in one.
    if (p.id === lc.workingIndexId || p.id === lc.archiveIndexId) continue;

    if (p.kind === 'index') {
      if (area === null) continue; // an index outside the areas has no lifecycle state
      // A set's index: the set's status tag and no Status.
      const want: State = area;
      const problems: { signal: string; expected: unknown; found: unknown }[] = [];
      if (!hasTag(p, tagOf[want])) problems.push({ signal: 'tag', expected: tagOf[want], found: p.tags });
      const status = fact(ctx, p, lc.fields.status);
      if (status !== null || factAmbiguous(p, lc.fields.status))
        problems.push({ signal: 'status', expected: '(none: an index has no Status)', found: status });
      if (problems.length > 0)
        out.push({
          code: 'lifecycle_set_inconsistent',
          pageId: p.id,
          message: `“${p.rawName}” is an index inside the ${area} area; ${problems.map((x) => x.signal).join(' and ')} disagree${problems.length === 1 ? 's' : ''} with a ${area} set.`,
          evidence: { area, problems },
        });
      continue;
    }
    const state = STATE_OF[p.kind];
    if (!state) continue; // unclassified: reported by its own check
    const problems: { signal: string; expected: unknown; found: unknown }[] = [];
    const statusRow = fact(ctx, p, lc.fields.status);
    if (factAmbiguous(p, lc.fields.status))
      problems.push({
        signal: 'status',
        expected: lc.status[state],
        found: '(the row appears more than once)',
      });
    else if ((statusRow ?? '').trim().toLowerCase() !== lc.status[state].trim().toLowerCase())
      problems.push({ signal: 'status', expected: lc.status[state], found: statusRow });
    // E5.3 (ADR 0046 decision 13): beneath an index the owner lists, a [BSRC] page is Authoritative WITHOUT CANON.
    const exemptId = state === 'authoritative' ? canonExemptionOfPage(lc, node) : null;
    const exempt = exemptId
      ? {
          id: exemptId,
          name:
            ctx.model.pages.get(exemptId)?.displayName ??
            ctx.snapshotTree.node(exemptId)?.displayName ??
            exemptId,
        }
      : null;
    if (exempt) {
      if (hasTag(p, tagOf.authoritative))
        problems.push({
          signal: 'tag',
          expected: `no ${tagOf.authoritative} (${exempt.name} area)`,
          found: p.tags,
        });
    } else if (!hasTag(p, tagOf[state]))
      problems.push({ signal: 'tag', expected: tagOf[state], found: p.tags });
    for (const other of ['authoritative', 'working', 'archived'] as const)
      if (other !== state && hasTag(p, tagOf[other]))
        problems.push({ signal: 'tag', expected: `not ${tagOf[other]}`, found: p.tags });
    let underSet = false;
    if (confirmed) {
      const want = state === 'authoritative' ? null : state;
      if (area !== want) {
        problems.push({
          signal: 'location',
          expected: want === null ? 'outside both lifecycle areas' : `under the ${want} index`,
          found: area === null ? 'outside both lifecycle areas' : `under the ${area} index`,
        });
      } else if (want !== null) {
        // Directly under the area's index, or under an [INDEX] inside it (a set kept together); never under a page.
        const direct = p.parentId === areaIndexId;
        const inSet = parent?.kind === 'index';
        underSet = !direct && inSet;
        if (!direct && !inSet)
          problems.push({
            signal: 'location',
            expected: `directly under the ${want} index, or under an [INDEX] inside it`,
            found: parent ? `under ${parent.rawName}` : 'no parent in the snapshot',
          });
      }
    }
    if (problems.length === 0) continue;
    // A page in an area with the wrong prefix for it, inside a set: the set rule; everywhere else the page rule.
    const inAreaSet = area !== null && parent?.kind === 'index' && p.parentId !== areaIndexId;
    const code: FindingCode =
      inAreaSet && area !== state ? 'lifecycle_set_inconsistent' : 'lifecycle_inconsistent';
    out.push({
      code,
      pageId: p.id,
      message:
        code === 'lifecycle_set_inconsistent'
          ? `“${p.rawName}” sits under a ${area} set’s index, so it should be ${PREFIX[area as State]}; it is ${PREFIX[state]}.`
          : `${PREFIX[state]} page: ${problems.map((x) => `${x.signal} should be ${typeof x.expected === 'string' ? `“${x.expected}”` : JSON.stringify(x.expected)}`).join('; ')}.`,
      evidence: {
        prefix: PREFIX[state],
        area,
        ...(underSet ? { set: true } : {}),
        ...(exempt ? { canonExemptArea: exempt } : {}),
        problems,
      },
    });
  }

  for (const r of ctx.incompleteRecords)
    out.push({
      code: 'lifecycle_record_incomplete',
      key: String(r.id),
      pageId: ctx.model.pages.has(r.pageId) ? r.pageId : null,
      message: `The ${r.action.replace(/_/g, ' ')} of “${r.pageName}” stopped part-way (record ${r.id}${r.jobId ? `, job ${r.jobId}` : ''}). Call the same tool again to resume it; until then the lifecycle tools refuse the page.`,
      evidence: {
        record: r.id,
        action: r.action,
        page: r.pageName,
        job: r.jobId,
        since: new Date(r.createdAt).toISOString(),
      },
      sourceKind: 'bridge',
    });
  for (const r of ctx.incompleteSets)
    out.push({
      code: 'lifecycle_set_incomplete',
      key: String(r.id),
      pageId: ctx.model.pages.has(r.pageId) ? r.pageId : null,
      message: `The ${r.action.replace(/_/g, ' ')} of the set “${r.pageName}” (${r.set?.pages.length ?? 0} pages) stopped part-way (record ${r.id}). Call the same tool again on its root to resume it.`,
      evidence: {
        record: r.id,
        action: r.action,
        root: r.pageName,
        job: r.jobId,
        pages: (r.set?.pages ?? []).slice(0, 200),
        since: new Date(r.createdAt).toISOString(),
      },
      sourceKind: 'bridge',
    });
  return out;
}

// ============================================================================================ keep regions

export function keepRegionsCheck(ctx: AuditContext): FindingDraft[] {
  const out: FindingDraft[] = [];
  for (const p of contentPages(ctx)) {
    for (const s of p.scans) {
      for (const lb of s.lineBreaks) {
        out.push({
          code: 'line_break_paragraph',
          key: lb.blockId ?? lb.runsHash,
          pageId: p.id,
          documentId: s.documentId,
          blockId: lb.blockId,
          message: `A paragraph (${lb.blockId ?? 'no id'}) holds ${lb.characters.join(', ')} inside a text run, so Markdown keeps it as a keep region: “${lb.preview}”.`,
          evidence: {
            characters: lb.characters,
            parts: lb.parts,
            splittable: lb.splittable,
            preview: lb.preview,
            runsHash: lb.runsHash,
          },
          ...(lb.splittable && lb.blockId
            ? {
                fix: {
                  kind: 'split_paragraph' as const,
                  args: {
                    pageId: p.id,
                    documentId: s.documentId,
                    blockId: lb.blockId,
                    runsHash: lb.runsHash,
                  },
                  summary: `Split the paragraph into ${lb.parts} paragraphs on “${p.displayName}”.`,
                },
              }
            : {}),
        });
      }
    }
    const icons = p.scans.filter((s) => s.iconBlocks.length > 0);
    if (icons.length > 0)
      out.push({
        code: 'inline_icon_page',
        pageId: p.id,
        message: `${p.displayName} holds inline icons in ${icons.reduce((n, s) => n + s.iconBlocks.length, 0)} block(s); write_page cannot write this page back (it is refused as PAGE_NOT_WRITABLE). Block-by-block edits still work.`,
        evidence: { documents: icons.map((s) => ({ id: s.documentId, name: s.name, blocks: s.iconBlocks })) },
      });
    const unsupported = p.scans.filter((s) => s.unsupported.count > 0);
    if (unsupported.length > 0)
      out.push({
        code: 'unsupported_blocks',
        pageId: p.id,
        message: `${p.displayName} holds ${unsupported.reduce((n, s) => n + s.unsupported.count, 0)} unsupported block(s), which every write keeps as they are.`,
        evidence: {
          total: unsupported.reduce((n, s) => n + s.unsupported.count, 0),
          documents: unsupported.map((s) => ({
            id: s.documentId,
            name: s.name,
            count: s.unsupported.count,
            blocks: s.unsupported.blockIds.slice(0, 50),
          })),
        },
      });
    const collections = p.scans.filter((s) => s.collectionBlocks > 0);
    if (collections.length > 0)
      out.push({
        code: 'collection_blocks',
        pageId: p.id,
        message: `${p.displayName} holds ${collections.reduce((n, s) => n + s.collectionBlocks, 0)} collection block(s) in its documents (keep regions in Markdown).`,
        evidence: {
          total: collections.reduce((n, s) => n + s.collectionBlocks, 0),
          documents: collections.map((s) => ({ id: s.documentId, name: s.name, count: s.collectionBlocks })),
        },
      });
  }
  return out;
}

// ============================================================================================ chronology

const CHRONOLOGY_CODE: Record<string, FindingCode> = {
  row_without_event: 'chronology_row_without_event',
  event_without_row: 'chronology_event_without_row',
  date_mismatch: 'chronology_date_mismatch',
  row_out_of_order: 'chronology_row_out_of_order',
  wrong_kcy: 'chronology_wrong_kcy',
  count_mismatch: 'chronology_count_mismatch',
  wrong_uri: 'chronology_wrong_uri',
  unreadable_date: 'chronology_unreadable_date',
  date_text_differs: 'chronology_date_text_differs',
  not_found: 'chronology_not_found',
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function chronologyCheck(ctx: AuditContext): FindingDraft[] {
  if (!ctx.chronologyConfigured) return [];
  const run = ctx.chronology;
  if (!run)
    return [
      {
        code: 'chronology_not_checked',
        message:
          'The chronology is confirmed but its check has not run yet (it reads LegendKeeper; run it on the Chronology page).',
        evidence: {},
        sourceKind: 'bridge',
      },
    ];
  const out: FindingDraft[] = [];
  for (const f of run.findings) {
    const code = CHRONOLOGY_CODE[f.kind];
    if (!code) continue;
    const d = (f.detail ?? {}) as Record<string, unknown>;
    const id = str(d.rowId) || str(d.eventId);
    const fixable =
      (f.kind === 'row_without_event' || f.kind === 'date_mismatch') && typeof d.rowId === 'string';
    // v2 E5 hotfix: a count mismatch has a fix when the Main table has a row for the age (it has a count to set).
    const countFixable = f.kind === 'count_mismatch' && typeof d.main === 'string';
    out.push({
      code,
      key: `${f.age}:${f.kind}:${id}:${f.kind === 'count_mismatch' ? '' : str(d.cell) || str(d.date)}`,
      pageId: ctx.chronologyResourceId,
      message: `${f.age}: ${f.message}`,
      evidence: { age: f.age, ...d },
      sourceKind: 'chronology-check',
      source: { kind: 'chronology-check', checkId: run.id, takenAt: run.finishedAt ?? run.startedAt },
      ...(fixable
        ? {
            fix: {
              kind: 'chronology_sync' as const,
              args: { age: f.age, rowId: d.rowId },
              summary: `Propose sync_timeline_event for the ${f.age} row.`,
            },
          }
        : countFixable
          ? {
              fix: {
                kind: 'chronology_count' as const,
                args: { age: f.age },
                summary: `Propose setting the ${f.age} count on the Main table to its table's row count.`,
              },
            }
          : {}),
    });
  }
  return out;
}
