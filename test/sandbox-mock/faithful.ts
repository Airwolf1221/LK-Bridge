/**
 * CR-2026-11-R4 (the owner's request S): the mock LegendKeeper's FAITHFUL setting, turned on by the sandbox checks' runs
 * on the mock (test/sandbox-mock/ and the sandbox dry runs) and by nothing else. Each behaviour below is LegendKeeper's
 * as its specification and the owner's real runs describe it (the source is named beside it), where the mock's default,
 * which the older tests were written against, differs or answers with a generic body. A behaviour no real run has
 * established yet is modelled as the bridge assumes it, and says so ("the real run decides").
 */
import { readFileSync } from 'node:fs';
import type { MockLk, MockRequest, MockResponse } from '../contract/mock-lk.js';
import type { SidebarModel } from '../facts/sidebar-model.js';
import type { TreeModel } from '../tree/model.js';
import { faithfulRoutes } from './faithful-routes.js';

const ORACLE = JSON.parse(
  readFileSync(new URL('../fixtures/calendar/oracle.json', import.meta.url), 'utf8'),
) as { calendar: Record<string, unknown> };

/** The test world's calendar exactly as LegendKeeper's `listCalendars` answered it (PLAN-v2 4.8's oracle). */
export const TEST_WORLD_CALENDAR = ORACLE.calendar;

/** What a mock world must expose to be made faithful (every DiscoverWorld-based world does). */
export interface FaithfulTarget {
  readonly stack: { readonly mock: MockLk };
  readonly repo: TreeModel;
  readonly overrides: Map<RegExp, (req: MockRequest) => MockResponse | undefined>;
  readonly sidebars?: Pick<SidebarModel, 'pages' | 'rowVersions' | 'adoptNewPages' | 'faithful'>;
}

/**
 * Turns the faithful setting on for a mock world:
 *
 * - **Blocks as a write stores them** (`TreeModel.faithful`, where the sources are named): a block sent without an id is
 *   given one, the same id twice is refused, and `createResource` makes the `documents` it is sent. consistency-f4b's F4
 *   could not edit the probe's sentence on the mock: its paragraphs were written without ids, and the mock kept none.
 * - **Mentions on read-back** (the owner's runs of assumptions-r3, 19 November 2026: X8 and X2; ADR 0061 decision 11):
 *   LegendKeeper fills in a mention's `name` (the page's current name) always, and its `text` only where none was sent;
 *   a label the bridge sent is kept as sent (`TreeModel.fillMentions`).
 * - **The calendar** (the oracle, `test/fixtures/calendar/oracle.json`: LegendKeeper's own answers, PLAN-v2 4.8):
 *   `listCalendars` answers the test world's Kumikan Epochal as LegendKeeper does, never the discover world's
 *   five-month stub that shares its id (consistency-f4b's F1 remembered the stub, and F3 could not read a Camue date).
 * - **The routes the mock left generic** (`faithfulRoutes`, with their sources): block rows, infobox properties,
 *   moveBlock, calendar writes, saveResourceAsTemplate, getProject, listMembers and listTags.
 * - **A client-supplied `x-request-id` echoed, and an Idempotency-Key reused with another body refused**
 *   (`MockLk.faithful`; the spec, PLAN §1.1 and ADR 0010; no recorded run states the smoke's item (a) on its own: the
 *   real run decides).
 * - **Sidebars** (where the world models them faithfully, `SidebarModel`): a row write answers its new version as an
 *   `ETag` header and none in its body, a delete's 204 too (the owner's assumptions run of 11 November 2026, B12 and B13;
 *   ADR 0039); every page made while the run goes has a sidebar (every LegendKeeper page has one), modelled from its
 *   first property request; a text field keeps the children it is created with (`SidebarModel.faithful`, G30b).
 */
export function makeFaithful<W extends FaithfulTarget>(
  w: W,
  o: {
    /**
     * `false`: the models' settings only, none of `faithfulRoutes` (for a dry run that models those routes itself, with
     * switches that make LegendKeeper answer otherwise: assumptions-r2's).
     */
    readonly routes?: boolean;
  } = {},
): W {
  w.repo.faithful = true;
  w.repo.fillMentions = true;
  w.stack.mock.faithful = true;
  if (w.sidebars) {
    w.sidebars.rowVersions = 'etag';
    w.sidebars.faithful = true;
    w.sidebars.adoptNewPages ??= (id) => w.repo.live(id) !== undefined;
  }
  if (o.routes === false) return w;
  const own = (source: string) => [...w.overrides.entries()].find(([re]) => re.source === source)?.[1];
  const routes = faithfulRoutes({
    repo: w.repo,
    ...(w.sidebars ? { sidebars: w.sidebars } : {}),
    calendar: TEST_WORLD_CALENDAR,
    templatesRoute: own('\\/templates$'),
    fromTemplateRoute: own('\\/resources\\/from-template$'),
  });
  const rest = [...w.overrides.entries()].filter(
    ([re]) => ![...routes.keys()].some((k) => k.source === re.source),
  );
  w.overrides.clear();
  for (const [k, v] of routes) w.overrides.set(k, v);
  for (const [k, v] of rest) w.overrides.set(k, v);
  return w;
}
