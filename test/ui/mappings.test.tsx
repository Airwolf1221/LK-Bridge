// @vitest-environment jsdom

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { baseRoutes, installApi, renderApp, useDom } from './helpers';

useDom();

const AT = Date.UTC(2026, 10, 8, 10, 0, 0);
const KINDS = ['text', 'number', 'resource_link', 'list', 'date', 'boolean', 'image', 'other'];
const SUGGESTED = ['Character', 'Nation', 'Species', 'Institution', 'Place', 'Class'];

const set = (over: Record<string, unknown> = {}) => ({
  id: 'ms_1',
  name: 'Baisheng taxonomy',
  description: 'The main repository',
  notes: 'First draft',
  active: true,
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

const rule = {
  id: 'tr_1',
  selector: { kind: 'subtree', resourceId: 'rcharact', descendants: true },
  semanticType: 'Character',
  priority: 10,
  notes: 'Everything under Characters',
  createdAt: AT,
  updatedAt: AT,
};
const tagRule = {
  id: 'tr_2',
  selector: { kind: 'tag', tag: 'nation' },
  semanticType: 'Nation',
  priority: 20,
  notes: '',
  createdAt: AT,
  updatedAt: AT,
};
const field = {
  id: 'fm_1',
  semanticType: 'Character',
  fieldName: 'Born',
  location: { kind: 'infobox_row', infoboxTitle: 'Vitals', rowKey: 'Born' },
  expectedKind: 'date',
  notes: '',
  createdAt: AT,
  updatedAt: AT,
};

const detail = (over: Record<string, unknown> = {}) => ({
  set: set(),
  rules: [tagRule, rule],
  fields: [field],
  summary: {
    headline: 'Active set “Baisheng taxonomy”: 2 type rules, 1 field map, 2 semantic types.',
    types: [
      {
        semanticType: 'Character',
        rules: ['Resource rcharact and everything below it (priority 10)'],
        fields: ['Born: Infobox “Vitals”, row “Born”, expected a date'],
      },
      { semanticType: 'Nation', rules: ['Resources tagged “nation” (priority 20)'], fields: [] },
    ],
    warnings: ['Nation has type rules but no field maps yet.'],
  },
  ...over,
});

const routes = (extra: Record<string, unknown> = {}) => ({
  ...baseRoutes(),
  'GET /mappings': {
    sets: [
      { ...set(), ruleCount: 2, fieldCount: 1 },
      { ...set({ id: 'ms_2', name: 'Draft', description: '', active: false }), ruleCount: 0, fieldCount: 0 },
    ],
    expectedKinds: KINDS,
    suggestedTypes: SUGGESTED,
  },
  'GET /mappings/sets/ms_1': detail(),
  ...extra,
});

describe('Repository Mappings: the list of sets', () => {
  it('shows each set with its status and counts, and an empty state when there are none', async () => {
    installApi(routes());
    renderApp('/ui/mappings');
    expect(await screen.findByRole('heading', { level: 1, name: 'Repository Mappings' })).toBeInTheDocument();
    const first = within(await waitRow('ms_1'));
    expect(first.getByRole('link', { name: 'Baisheng taxonomy' })).toHaveAttribute(
      'href',
      '/ui/mappings/ms_1',
    );
    expect(first.getByText('Active')).toBeInTheDocument();
    expect(within(await waitRow('ms_2')).getByText('Inactive')).toBeInTheDocument();
  });

  it('has an empty state', async () => {
    installApi(routes({ 'GET /mappings': { sets: [], expectedKinds: KINDS, suggestedTypes: SUGGESTED } }));
    renderApp('/ui/mappings');
    expect(await screen.findByText(/No mapping sets yet/)).toBeInTheDocument();
  });

  it('creates a set and opens it', async () => {
    const api = installApi(
      routes({ 'POST /mappings/sets': { status: 201, body: { set: set({ id: 'ms_1' }) } } }),
    );
    const user = userEvent.setup();
    renderApp('/ui/mappings');
    await user.type(await screen.findByLabelText('Name'), 'Baisheng taxonomy');
    await user.type(screen.getByLabelText('Description'), 'The main repository');
    await user.click(screen.getByRole('button', { name: 'Create set' }));
    await waitFor(() => expect(api.find('POST', '/mappings/sets')).toHaveLength(1));
    expect(api.find('POST', '/mappings/sets')[0]!.body).toEqual({
      name: 'Baisheng taxonomy',
      description: 'The main repository',
    });
    expect(await screen.findByText('About this set')).toBeInTheDocument(); // navigated to the set
  });

  it('activates and deactivates', async () => {
    const api = installApi(
      routes({
        'POST /mappings/sets/ms_2/activate': { set: set({ id: 'ms_2', active: true }) },
        'POST /mappings/sets/ms_1/deactivate': { set: set({ active: false }) },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/mappings');
    await user.click(await screen.findByRole('button', { name: 'Activate Draft' }));
    await waitFor(() => expect(api.find('POST', '/mappings/sets/ms_2/activate')).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Deactivate Baisheng taxonomy' }));
    await waitFor(() => expect(api.find('POST', '/mappings/sets/ms_1/deactivate')).toHaveLength(1));
  });

  it('asks before deleting, and sends the confirmation', async () => {
    const api = installApi(routes({ 'POST /mappings/sets/ms_2/delete': { ok: true } }));
    const user = userEvent.setup();
    renderApp('/ui/mappings');
    await user.click(await screen.findByRole('button', { name: 'Delete Draft' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Delete “Draft”?');
    expect(api.find('POST', /delete/)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.find('POST', /delete/)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Delete Draft' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.find('POST', '/mappings/sets/ms_2/delete')).toHaveLength(1));
    expect(api.find('POST', '/mappings/sets/ms_2/delete')[0]!.body).toEqual({ confirm: true });
  });

  it('exports a set through the API', async () => {
    const api = installApi(
      routes({
        'GET /mappings/sets/ms_1/export': { document: { schema: 'lk-bridge.mapping-set', version: 1 } },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/mappings');
    await user.click(await screen.findByRole('button', { name: 'Export Baisheng taxonomy' }));
    await waitFor(() => expect(api.find('GET', '/mappings/sets/ms_1/export')).toHaveLength(1));
  });

  it('imports pasted JSON, and shows the bridge’s reason when the file is refused', async () => {
    let refuse = true;
    const api = installApi(
      routes({
        'POST /mappings/import': () =>
          refuse
            ? {
                status: 400,
                body: {
                  error: {
                    code: 'INVALID_IMPORT',
                    message: 'This file is version 9 of the mapping format; this bridge reads version 1',
                  },
                },
              }
            : { status: 201, body: detail({ set: set({ id: 'ms_1' }) }) },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/mappings');
    const text = await screen.findByLabelText('Or paste the JSON');
    const button = screen.getByRole('button', { name: 'Import' });
    expect(button).toBeDisabled();
    await user.click(text);
    await user.paste('{"schema":"lk-bridge.mapping-set","version":9}');
    await user.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('version 9 of the mapping format');
    expect(screen.getByText('Import a mapping set')).toBeInTheDocument(); // still on the list
    refuse = false;
    await user.type(screen.getByLabelText('Name (optional, to avoid a clash)'), 'Copy');
    await user.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(api.find('POST', '/mappings/import')).toHaveLength(2));
    expect(api.find('POST', '/mappings/import')[1]!.body).toEqual({
      document: '{"schema":"lk-bridge.mapping-set","version":9}',
      name: 'Copy',
    });
    expect(await screen.findByText('About this set')).toBeInTheDocument();
  });
});

async function waitRow(id: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const el = document.querySelector<HTMLElement>(`tr[data-set="${id}"]`);
    if (!el) throw new Error('row not yet there');
    return el;
  });
}

describe('Repository Mappings: one set', () => {
  it('shows a readable summary with warnings, and the rules and field maps', async () => {
    installApi(routes());
    renderApp('/ui/mappings/ms_1');
    expect(await screen.findByText(/2 type rules, 1 field map, 2 semantic types/)).toBeInTheDocument();
    expect(screen.getByText('Worth a second look')).toBeInTheDocument();
    expect(screen.getAllByText('Nation has type rules but no field maps yet.').length).toBeGreaterThan(0);
    expect(screen.getByText('Born: Infobox “Vitals”, row “Born”, expected a date')).toBeInTheDocument();
    const rules = document.querySelector('tr[data-rule="tr_1"]') as HTMLElement;
    expect(within(rules).getByText('Resource and everything below: rcharact')).toBeInTheDocument();
    expect(within(rules).getByText('Character')).toBeInTheDocument();
    const fieldRow = document.querySelector('tr[data-field="fm_1"]') as HTMLElement;
    expect(within(fieldRow).getByText('Infobox “Vitals”, row “Born”')).toBeInTheDocument();
    expect(within(fieldRow).getByText('Date')).toBeInTheDocument();
  });

  it('saves the set’s name, description and notes', async () => {
    const api = installApi(routes({ 'PUT /mappings/sets/ms_1': { set: set() } }));
    const user = userEvent.setup();
    renderApp('/ui/mappings/ms_1');
    const notes = await screen.findByLabelText('Notes');
    await user.clear(notes);
    await user.type(notes, 'Second draft');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.find('PUT', '/mappings/sets/ms_1')).toHaveLength(1));
    expect(api.find('PUT', '/mappings/sets/ms_1')[0]!.body).toEqual({
      name: 'Baisheng taxonomy',
      description: 'The main repository',
      notes: 'Second draft',
    });
  });

  it('adds a type rule for each selector kind', async () => {
    const api = installApi(routes({ 'POST /mappings/sets/ms_1/rules': { status: 201, body: { rule } } }));
    const user = userEvent.setup();
    renderApp('/ui/mappings/ms_1');
    await user.click(await screen.findByRole('button', { name: 'Add a type rule' }));
    let form = await screen.findByRole('form', { name: 'New type rule' });
    const save = () => within(form).getByRole('button', { name: 'Save type rule' });
    expect(save()).toBeDisabled();
    await user.type(within(form).getByLabelText('Resource id'), 'rkingdom');
    await user.click(within(form).getByLabelText('Include everything below it')); // off
    await user.type(within(form).getByLabelText('Semantic type'), 'Nation');
    await user.clear(within(form).getByLabelText('Priority (higher wins)'));
    await user.type(within(form).getByLabelText('Priority (higher wins)'), '5');
    await user.click(save());
    await waitFor(() => expect(api.find('POST', '/mappings/sets/ms_1/rules')).toHaveLength(1));
    expect(api.find('POST', '/mappings/sets/ms_1/rules')[0]!.body).toEqual({
      selector: { kind: 'subtree', resourceId: 'rkingdom', descendants: false },
      semanticType: 'Nation',
      priority: 5,
      notes: '',
    });

    await user.click(await screen.findByRole('button', { name: 'Add a type rule' }));
    form = await screen.findByRole('form', { name: 'New type rule' });
    await user.selectOptions(within(form).getByLabelText('Selects'), 'template');
    await user.type(within(form).getByLabelText('Template id'), 'tspecies');
    expect(within(form).getByText(/does not record which template/)).toBeInTheDocument();
    await user.type(within(form).getByLabelText('Semantic type'), 'Species');
    await user.click(save());
    await waitFor(() => expect(api.find('POST', '/mappings/sets/ms_1/rules')).toHaveLength(2));
    expect(
      (api.find('POST', '/mappings/sets/ms_1/rules')[1]!.body as { selector: unknown }).selector,
    ).toEqual({
      kind: 'template',
      templateId: 'tspecies',
    });

    await user.click(await screen.findByRole('button', { name: 'Add a type rule' }));
    form = await screen.findByRole('form', { name: 'New type rule' });
    await user.selectOptions(within(form).getByLabelText('Selects'), 'tag');
    await user.type(within(form).getByLabelText('Tag'), 'nation');
    await user.type(within(form).getByLabelText('Semantic type'), 'Nation');
    await user.click(save());
    await waitFor(() => expect(api.find('POST', '/mappings/sets/ms_1/rules')).toHaveLength(3));
    expect(
      (api.find('POST', '/mappings/sets/ms_1/rules')[2]!.body as { selector: unknown }).selector,
    ).toEqual({ kind: 'tag', tag: 'nation' });
  });

  it('edits and deletes a type rule', async () => {
    const api = installApi(
      routes({ 'PUT /mappings/rules/tr_1': { rule }, 'POST /mappings/rules/tr_1/delete': { ok: true } }),
    );
    const user = userEvent.setup();
    renderApp('/ui/mappings/ms_1');
    await user.click(
      await screen.findByRole('button', {
        name: 'Edit the Character rule for Resource and everything below: rcharact',
      }),
    );
    const form = await screen.findByRole('form', { name: 'Edit type rule' });
    expect(within(form).getByLabelText('Resource id')).toHaveValue('rcharact');
    expect(within(form).getByLabelText('Include everything below it')).toBeChecked();
    const priority = within(form).getByLabelText('Priority (higher wins)');
    await user.clear(priority);
    await user.type(priority, '99');
    await user.click(within(form).getByRole('button', { name: 'Save type rule' }));
    await waitFor(() => expect(api.find('PUT', '/mappings/rules/tr_1')).toHaveLength(1));
    expect((api.find('PUT', '/mappings/rules/tr_1')[0]!.body as { priority: number }).priority).toBe(99);

    await user.click(
      screen.getByRole('button', {
        name: 'Delete the Character rule for Resource and everything below: rcharact',
      }),
    );
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.find('POST', '/mappings/rules/tr_1/delete')).toHaveLength(1));
  });

  it('adds a field map for each kind of location', async () => {
    const api = installApi(routes({ 'POST /mappings/sets/ms_1/fields': { status: 201, body: { field } } }));
    const user = userEvent.setup();
    renderApp('/ui/mappings/ms_1');
    const open = async () => {
      await user.click(await screen.findByRole('button', { name: 'Add a field map' }));
      return screen.findByRole('form', { name: 'New field map' });
    };
    const posted = (n: number) => api.find('POST', '/mappings/sets/ms_1/fields')[n]!.body;

    let form = await open();
    await user.type(within(form).getByLabelText('Semantic type'), 'Character');
    await user.type(within(form).getByLabelText('Semantic field name'), 'Species');
    await user.selectOptions(within(form).getByLabelText('Expected kind'), 'resource_link');
    await user.type(within(form).getByLabelText('Property title'), 'Species');
    await user.click(within(form).getByRole('button', { name: 'Save field map' }));
    await waitFor(() => expect(api.find('POST', '/mappings/sets/ms_1/fields')).toHaveLength(1));
    expect(posted(0)).toEqual({
      semanticType: 'Character',
      fieldName: 'Species',
      location: { kind: 'sidebar_property', title: 'Species' },
      expectedKind: 'resource_link',
      notes: '',
    });

    form = await open();
    await user.type(within(form).getByLabelText('Semantic type'), 'Character');
    await user.type(within(form).getByLabelText('Semantic field name'), 'Born');
    await user.selectOptions(within(form).getByLabelText('Found in'), 'infobox_row');
    await user.type(within(form).getByLabelText('Infobox title'), 'Vitals');
    await user.type(within(form).getByLabelText('Row key'), 'Born');
    await user.click(within(form).getByRole('button', { name: 'Save field map' }));
    await waitFor(() => expect(api.find('POST', '/mappings/sets/ms_1/fields')).toHaveLength(2));
    expect((posted(1) as { location: unknown }).location).toEqual({
      kind: 'infobox_row',
      infoboxTitle: 'Vitals',
      rowKey: 'Born',
    });

    form = await open();
    await user.type(within(form).getByLabelText('Semantic type'), 'Character');
    await user.type(within(form).getByLabelText('Semantic field name'), 'Biography');
    await user.selectOptions(within(form).getByLabelText('Found in'), 'block');
    await user.type(within(form).getByLabelText('Heading text'), 'Biography');
    await user.click(within(form).getByRole('button', { name: 'Save field map' }));
    await waitFor(() => expect(api.find('POST', '/mappings/sets/ms_1/fields')).toHaveLength(3));
    expect((posted(2) as { location: unknown }).location).toEqual({ kind: 'block', heading: 'Biography' });

    form = await open();
    await user.type(within(form).getByLabelText('Semantic type'), 'Nation');
    await user.type(within(form).getByLabelText('Semantic field name'), 'Motto');
    await user.selectOptions(within(form).getByLabelText('Found in'), 'block');
    await user.selectOptions(within(form).getByLabelText('Identified by'), 'blockId');
    await user.type(within(form).getByLabelText('Block id'), 'blk_motto');
    await user.click(within(form).getByRole('button', { name: 'Save field map' }));
    await waitFor(() => expect(api.find('POST', '/mappings/sets/ms_1/fields')).toHaveLength(4));
    expect((posted(3) as { location: unknown }).location).toEqual({ kind: 'block', blockId: 'blk_motto' });
  });

  it('shows the bridge’s reason when a field map is refused (a duplicate)', async () => {
    installApi(
      routes({
        'POST /mappings/sets/ms_1/fields': {
          status: 409,
          body: {
            error: { code: 'DUPLICATE_FIELD', message: 'Character already has a field called “Born”' },
          },
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/mappings/ms_1');
    await user.click(await screen.findByRole('button', { name: 'Add a field map' }));
    const form = await screen.findByRole('form', { name: 'New field map' });
    await user.type(within(form).getByLabelText('Semantic type'), 'Character');
    await user.type(within(form).getByLabelText('Semantic field name'), 'Born');
    await user.type(within(form).getByLabelText('Property title'), 'Born');
    await user.click(within(form).getByRole('button', { name: 'Save field map' }));
    expect(await screen.findByText('Character already has a field called “Born”')).toBeInTheDocument();
  });

  it('edits and deletes a field map', async () => {
    const api = installApi(
      routes({ 'PUT /mappings/fields/fm_1': { field }, 'POST /mappings/fields/fm_1/delete': { ok: true } }),
    );
    const user = userEvent.setup();
    renderApp('/ui/mappings/ms_1');
    await user.click(await screen.findByRole('button', { name: 'Edit Character field Born' }));
    const form = await screen.findByRole('form', { name: 'Edit field map' });
    expect(within(form).getByLabelText('Found in')).toHaveValue('infobox_row');
    expect(within(form).getByLabelText('Infobox title')).toHaveValue('Vitals');
    await user.selectOptions(within(form).getByLabelText('Expected kind'), 'text');
    await user.click(within(form).getByRole('button', { name: 'Save field map' }));
    await waitFor(() => expect(api.find('PUT', '/mappings/fields/fm_1')).toHaveLength(1));
    expect((api.find('PUT', '/mappings/fields/fm_1')[0]!.body as { expectedKind: string }).expectedKind).toBe(
      'text',
    );
    await user.click(screen.getByRole('button', { name: 'Delete Character field Born' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.find('POST', '/mappings/fields/fm_1/delete')).toHaveLength(1));
  });
});

describe('Repository Mappings: the read-only preview', () => {
  const preview = {
    resource: { id: 'rduke', name: 'The Duke', tags: ['ruler'] },
    ancestors: [{ id: 'rcharact', name: 'Characters' }],
    ancestorsIncomplete: false,
    matches: [
      {
        ruleId: 'tr_1',
        semanticType: 'Character',
        priority: 10,
        description: 'Resource rcharact and everything below it',
        via: 'an ancestor (1 level up)',
      },
    ],
    notEvaluable: [
      {
        ruleId: 'tr_9',
        description: 'Resources made from template tchar',
        reason:
          'LegendKeeper does not record which template a resource was made from, so a template rule cannot be checked.',
      },
    ],
    semanticType: 'Character',
    tie: false,
    fields: [field],
    readsMade: 2,
  };

  it('asks for a resource id and shows the matching rules and the resulting type, using only a GET', async () => {
    const api = installApi(routes({ 'GET /mappings/sets/ms_1/preview': { preview } }));
    const user = userEvent.setup();
    renderApp('/ui/mappings/ms_1');
    const input = await screen.findByLabelText('Resource id', { selector: '#prev-id' });
    const go = screen.getByRole('button', { name: 'Preview' });
    expect(go).toBeDisabled();
    await user.type(input, 'rduke');
    await user.click(go);
    const result = await screen.findByLabelText('Preview result');
    expect(result).toHaveTextContent('The Duke');
    expect(result).toHaveTextContent('would be a Character');
    expect(result).toHaveTextContent(
      'Character (priority 10): Resource rcharact and everything below it, through an ancestor (1 level up)',
    );
    expect(result).toHaveTextContent('does not record which template');
    expect(result).toHaveTextContent('Born: Infobox “Vitals”, row “Born” (Date)');
    expect(result).toHaveTextContent('2 reads from LegendKeeper; nothing was written.');
    expect(api.find('GET', '/mappings/sets/ms_1/preview')[0]!.query).toBe('?resourceId=rduke');
    // Reads only: nothing but GETs for the preview, and no write was sent by anything on this page.
    expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('shows the reason when LegendKeeper does not have the resource', async () => {
    installApi(
      routes({
        'GET /mappings/sets/ms_1/preview': {
          status: 502,
          body: { error: { code: 'LK_ERROR', message: 'LegendKeeper has no resource rmissing' } },
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/mappings/ms_1');
    await user.type(await screen.findByLabelText('Resource id', { selector: '#prev-id' }), 'rmissing');
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('LegendKeeper has no resource rmissing');
  });

  it('says so when nothing matches', async () => {
    installApi(
      routes({
        'GET /mappings/sets/ms_1/preview': {
          preview: {
            ...preview,
            matches: [],
            notEvaluable: [],
            semanticType: null,
            fields: [],
            readsMade: 1,
          },
        },
      }),
    );
    const user = userEvent.setup();
    renderApp('/ui/mappings/ms_1');
    await user.type(await screen.findByLabelText('Resource id', { selector: '#prev-id' }), 'rother');
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('no semantic type')).toBeInTheDocument();
    expect(screen.getByLabelText('Preview result')).toHaveTextContent('1 read from LegendKeeper');
  });
});
