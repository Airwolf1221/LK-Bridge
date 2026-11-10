// @vitest-environment jsdom

/**
 * v2 A3: the type registry, taxonomy, drift and "Try it" sections of the Repository Mappings page: what each shows,
 * what each action sends, the confirmations, and the read-only panel's answers and refusals.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { baseRoutes, installApi, renderApp, useDom } from './helpers';

useDom();

const AT = Date.UTC(2026, 10, 10, 10, 0, 0);
const ref = (id: string, displayName: string, path: string, kind = 'index') => ({
  id,
  rawName: kind === 'index' ? `[INDEX] ${displayName}` : `[BSRC] ${displayName}`,
  displayName,
  kind,
  path,
});

const type = (over: Record<string, unknown> = {}) => ({
  id: 'typ_1',
  singular: 'Character',
  plural: 'Characters',
  rootIndexId: 'chars001',
  rootIndex: ref('chars001', 'Characters', 'AI REPOSITORY / Characters'),
  indexTemplateId: 'tplindex',
  pageTemplates: [
    { role: 'core', templateId: 'tplcore1' },
    { role: 'compact', templateId: null },
  ],
  assetRootFolder: 'Characters',
  placementKind: 'character',
  status: 'needs_review',
  review: [{ code: 'template_not_found', message: 'The “compact” template: No template is named “X”.' }],
  checks: [],
  notes: '',
  taxonomySeededAt: AT,
  entries: 3,
  entriesNeedingReview: 1,
  updatedAt: AT,
  ...over,
});

const entry = (id: string, plural: string, singular: string, parentId: string | null, over = {}) => ({
  id,
  plural,
  singular,
  singularSource: 'list',
  parentId,
  aliases: [],
  sourceNodeId: `n_${id}`,
  source: ref(`n_${id}`, plural, `AI REPOSITORY / Characters / ${plural}`),
  assetFolder: plural,
  status: 'ok',
  review: [],
  notes: '',
  ...over,
});

const foxians = entry('tax_fox', 'Foxians', 'Foxian', 'tax_beast', {
  singularSource: 'rule',
  status: 'needs_review',
  review: [{ code: 'singular_guess', message: 'The singular “Foxian” is a guess (-s removed); check it.' }],
});
const entries = [
  entry('tax_beast', 'Beastkin', 'Beastkin', null),
  foxians,
  entry('tax_dwarf', 'Dwarves', 'Dwarf', null),
];

const routes = (extra: Record<string, unknown> = {}) => ({
  ...baseRoutes(),
  'GET /mappings': { sets: [], expectedKinds: [], suggestedTypes: [] },
  'GET /registry': {
    types: [type()],
    templates: {
      templates: [
        { id: 'tplindex', name: '[INDEX] AI Index' },
        { id: 'tplcore1', name: '[BSRC] AI Character Core' },
      ],
      readAt: AT,
      error: null,
    },
    tree: { status: 'ready', reason: null },
  },
  'GET /registry/types/typ_1/taxonomy': {
    type: type(),
    entries,
    reviewQueue: [foxians],
  },
  'GET /registry/drift': {
    latest: {
      id: 3,
      at: AT,
      source: 'check',
      treeStatus: 'ready',
      note: null,
      count: 1,
      findings: [
        {
          code: 'unmapped_index',
          typeName: 'Character',
          entryName: null,
          nodeId: 'half0001',
          nodePath: 'AI REPOSITORY / Characters / Elves / Half-Elves',
          message: '“Half-Elves” has no taxonomy entry.',
        },
      ],
    },
    recent: [],
  },
  ...extra,
});

describe('Repository Mappings: types and taxonomy', () => {
  it('shows the types with their templates and review reasons, and seeds the Character type when there is none', async () => {
    const api = installApi(
      routes({
        'GET /registry': {
          types: [],
          templates: { templates: [], readAt: null, error: null },
          tree: { status: 'ready', reason: null },
        },
        'POST /registry/seed-character': { status: 201, body: { type: type() } },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/mappings');
    expect(await screen.findByText(/No types yet/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Seed the Character type' }));
    await waitFor(() => expect(api.find('POST', '/registry/seed-character')).toHaveLength(1));
  });

  it('lists a type and edits it, marking it reviewed', async () => {
    const api = installApi(routes({ 'PUT /registry/types/typ_1': { type: type({ status: 'ok' }) } }));
    const user = userEvent.setup();
    renderApp('/ui/mappings');
    const row = (await screen.findByRole('link', { name: 'AI REPOSITORY / Characters' })).closest('tr')!;
    expect(row).toHaveTextContent('Index: [INDEX] AI Index');
    expect(row).toHaveTextContent('core: [BSRC] AI Character Core');
    expect(row).toHaveTextContent('Needs review');
    expect(row).toHaveTextContent('No template is named');
    expect(within(row).getByRole('link', { name: 'AI REPOSITORY / Characters' })).toHaveAttribute(
      'href',
      '/ui/tree?node=chars001',
    );
    await user.click(within(row).getByRole('button', { name: 'Edit Character' }));
    const form = screen.getByRole('form', { name: 'Edit Character' });
    await user.type(within(form).getByLabelText('Template', { selector: '#ty-tpl-1' }), 'tplcomp1');
    await user.click(within(form).getByLabelText(/Mark as reviewed/));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.find('PUT', '/registry/types/typ_1')).toHaveLength(1));
    expect(api.find('PUT', '/registry/types/typ_1')[0]!.body).toMatchObject({
      singular: 'Character',
      rootIndexId: 'chars001',
      pageTemplates: [
        { role: 'core', templateId: 'tplcore1' },
        { role: 'compact', templateId: 'tplcomp1' },
      ],
      placementKind: 'character',
      reviewed: true,
    });
  });

  it('shows the taxonomy as a tree with its review queue, and edits an entry', async () => {
    const api = installApi(
      routes({ 'PUT /registry/taxonomy/tax_fox': { entry: { ...foxians, status: 'ok' } } }),
    );
    const user = userEvent.setup();
    renderApp('/ui/mappings');
    const queue = await screen.findByTestId('review-queue');
    expect(queue).toHaveTextContent('Foxians: The singular “Foxian” is a guess');
    // Foxians is drawn under Beastkin.
    const beast = document.querySelector('[data-entry="tax_beast"]')!;
    expect(within(beast as HTMLElement).getByText('Foxians')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit Foxians' }));
    const form = screen.getByRole('form', { name: 'Edit Foxians' });
    await user.type(within(form).getByLabelText('Aliases (comma-separated)'), 'Kitsune, Fox folk');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.find('PUT', '/registry/taxonomy/tax_fox')).toHaveLength(1));
    expect(api.find('PUT', '/registry/taxonomy/tax_fox')[0]!.body).toEqual({
      singular: 'Foxian', // a guessed singular, once saved, is the owner's
      aliases: ['Kitsune', 'Fox folk'],
      assetFolder: 'Foxians',
      parentId: 'tax_beast',
      notes: '',
      reviewed: true,
    });
  });

  it('seeds a taxonomy only after a confirmation', async () => {
    const api = installApi(
      routes({
        'GET /registry': {
          types: [type({ taxonomySeededAt: null, entries: 0 })],
          templates: { templates: [], readAt: AT, error: null },
          tree: { status: 'ready', reason: null },
        },
        'GET /registry/types/typ_1/taxonomy': {
          type: type({ taxonomySeededAt: null }),
          entries: [],
          reviewQueue: [],
        },
        'POST /registry/types/typ_1/taxonomy/seed': {
          result: {
            created: entries,
            characterIndexes: [ref('a', 'Asagiri Miyabi', 'x')],
            reserved: [ref('u', 'Undetermined / Unknown', 'y')],
            unchanged: 0,
            needsReview: 1,
            warnings: [],
          },
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/mappings');
    await user.click(await screen.findByRole('button', { name: 'Seed the taxonomy' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Seed the Characters taxonomy?');
    expect(api.find('POST', /taxonomy\/seed/)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Seed' }));
    await waitFor(() => expect(api.find('POST', '/registry/types/typ_1/taxonomy/seed')).toHaveLength(1));
    expect(api.find('POST', '/registry/types/typ_1/taxonomy/seed')[0]!.body).toEqual({ confirm: true });
    expect(await screen.findByTestId('seed-result')).toHaveTextContent(
      '3 entries created (1 to review); 1 character indexes',
    );
  });

  it('shows the drift report with links into the tree, and compares on request', async () => {
    const api = installApi(routes({ 'POST /registry/drift/run': { report: {} } }));
    const user = userEvent.setup();
    renderApp('/ui/mappings');
    expect(await screen.findByTestId('drift-summary')).toHaveTextContent('1 finding');
    expect(screen.getByText('Index with no entry')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'AI REPOSITORY / Characters / Elves / Half-Elves' }),
    ).toHaveAttribute('href', '/ui/tree?node=half0001');
    await user.click(screen.getByRole('button', { name: 'Compare now' }));
    await waitFor(() => expect(api.find('POST', '/registry/drift/run')).toHaveLength(1));
  });
});

describe('Repository Mappings: Try it', () => {
  it('resolves a name and shows every candidate of an ambiguous one', async () => {
    const api = installApi(
      routes({
        'GET /registry/try/resolve': {
          result: {
            status: 'ambiguous',
            candidates: [
              {
                ...ref('asagi001', 'Asagiri Miyabi', 'AI REPOSITORY / Characters / Asagiri Miyabi'),
                matchedBy: 'display',
              },
              {
                ...ref(
                  'asagi002',
                  'Asagiri Miyabi',
                  'AI REPOSITORY / Characters / Asagiri Miyabi / Asagiri Miyabi',
                  'bsrc',
                ),
                matchedBy: 'display',
              },
            ],
          },
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/mappings');
    await user.type(await screen.findByLabelText('Name or id'), 'Asagiri Miyabi');
    await user.selectOptions(screen.getByLabelText('Within type'), 'Character');
    await user.click(screen.getByRole('button', { name: 'Resolve' }));
    const out = await screen.findByTestId('try-resolve');
    expect(out).toHaveTextContent('Ambiguous: refused');
    expect(out).toHaveTextContent('asagi002');
    const call = api.find('GET', '/registry/try/resolve')[0]!;
    expect(new URLSearchParams(call.query).get('query')).toBe('Asagiri Miyabi');
    expect(new URLSearchParams(call.query).get('type')).toBe('Character');
  });

  it('plans a placement, and shows a refusal with the labels available', async () => {
    let refuse = true;
    installApi(
      routes({
        'GET /registry/try/placement': () =>
          refuse
            ? {
                status: 409,
                body: {
                  error: {
                    code: 'RACE_NOT_FOUND',
                    message: 'No race “Atlanteans”.',
                    available: ['Dwarf', 'Dwarves'],
                  },
                },
              }
            : {
                plan: {
                  raceIndex: ref(
                    'undet001',
                    'Undetermined / Unknown',
                    'AI REPOSITORY / Characters / Undetermined / Unknown',
                  ),
                  species: { row: 'Race / Species', value: 'Unestablished' },
                  characterIndex: {
                    action: 'create',
                    rawName: '[INDEX] Nameless',
                    slot: { after: 'nobo0001' },
                  },
                  page: {
                    action: 'create',
                    rawName: '[BSRC] Nameless',
                    parentId: null,
                    templateId: 'tplcore1',
                    slot: {},
                  },
                  warnings: [],
                },
              },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/mappings');
    await user.type(await screen.findByLabelText('Character name'), 'Kai');
    await user.type(screen.getByLabelText('Race (blank: unknown)'), 'Atlanteans');
    await user.click(screen.getByRole('button', { name: 'Plan' }));
    const alert = await screen.findByText('RACE_NOT_FOUND');
    expect(alert.closest('[role="alert"]')).toHaveTextContent('Dwarves');
    refuse = false;
    await user.click(screen.getByRole('button', { name: 'Plan' }));
    const plan = await screen.findByTestId('try-plan');
    expect(plan).toHaveTextContent('Race / Species: Unestablished');
    expect(plan).toHaveTextContent('create [INDEX] Nameless, after nobo0001');
    expect(plan).toHaveTextContent('in the new index');
  });

  it('computes an ordering slot and lists siblings already out of order', async () => {
    installApi(
      routes({
        'GET /registry/try/ordering': {
          slot: { after: 'eq000003' },
          outOfOrder: [
            {
              outOfOrder: [
                {
                  node: ref('eq000001', 'Zulfiqar', 'x', 'bsrc'),
                  belongsAfter: ref('eq000003', 'Aegis', 'y', 'bsrc'),
                },
              ],
            },
          ],
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/mappings');
    await user.type(await screen.findByLabelText('Parent (resource id)'), 'equip001');
    await user.type(screen.getByLabelText("New page's display name"), 'Bow');
    await user.click(screen.getByRole('button', { name: 'Compute' }));
    const out = await screen.findByTestId('try-ordering');
    expect(out).toHaveTextContent('Goes after eq000003');
    expect(out).toHaveTextContent('[BSRC] Zulfiqar belongs after [BSRC] Aegis');
  });
});
