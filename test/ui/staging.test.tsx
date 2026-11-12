// @vitest-environment jsdom
/**
 * v2 D3 (ADR 0041) on the dashboard: the Staging page lists staged images with thumbnails, uploads chosen files as raw
 * bodies with the CSRF token, places one at a destination, discards one after a confirmation, and reports old ones.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  OTHER_PROJECT_ID,
  PROJECT_ID,
  baseRoutes,
  installApi,
  openStream,
  renderApp,
  useDom,
} from './helpers';

useDom();

const image = (over: Record<string, unknown> = {}) => ({
  stagedId: 'img_AAAAAAAAAAAAAAAA',
  state: 'uploaded',
  staged: true,
  name: 'Shrine',
  assetId: 'a1',
  url: 'https://assets.legendkeeper.com/a1.webp',
  width: 20,
  height: 30,
  frames: 1,
  bytes: 1234,
  originalFormat: 'jpeg',
  originalBytes: 5555,
  conversion: 'converted',
  storedVerified: true,
  verifyReason: null,
  principalId: 'system',
  source: 'dashboard',
  createdAt: Date.now() - 60_000,
  intended: 'Characters / Beastkin / Foxians / Asagiri Miyabi',
  intendedDestination: { for_character: { name: 'Asagiri Miyabi', race: 'Foxian' } },
  placing: null,
  discarding: null,
  error: null,
  old: false,
  ...over,
});

const staging = (over: Record<string, unknown> = {}) => ({
  project: 'baisheng',
  folder: 'LK-Bridge staging',
  reportDays: 30,
  staged: [
    image(),
    image({
      stagedId: 'img_BBBBBBBBBBBBBBBB',
      name: 'Old one',
      old: true,
      intended: null,
      intendedDestination: null,
    }),
  ],
  old: 1,
  limits: { maxBytes: 10 * 1024 * 1024, maxPixels: 100_000_000, maxFrames: 300 },
  kept: { files: 2, bytes: 4096, retentionDays: 90, recent: [] },
  overrides: [],
  ...over,
});

describe('the Staging page', () => {
  it('lists staged images with thumbnails and reports old ones', async () => {
    installApi({ ...baseRoutes(), 'GET /staging': staging() });
    renderApp('/ui/staging');
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('img', { name: 'Shrine' })).toHaveAttribute(
      'src',
      'https://assets.legendkeeper.com/a1.webp',
    );
    expect(within(table).getByText('img_AAAAAAAAAAAAAAAA')).toBeInTheDocument();
    expect(within(table).getByText('Characters / Beastkin / Foxians / Asagiri Miyabi')).toBeInTheDocument();
    expect(screen.getByText(/1 staged image older than 30 days/)).toBeInTheDocument();
  });

  it('uploads chosen files as the raw body, with the CSRF token, and shows each staged id', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /staging': staging({ staged: [], old: 0 }),
      'POST /staging/upload': {
        deduplicated: false,
        image: image({ stagedId: 'img_CCCCCCCCCCCCCCCC', name: 'portrait' }),
      },
    });
    renderApp('/ui/staging');
    const input = await screen.findByLabelText(/Choose images/);
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'portrait.png', { type: 'image/png' });
    await userEvent.upload(input, file);
    await waitFor(() => expect(api.find('POST', '/staging/upload')).toHaveLength(1));
    const call = api.find('POST', '/staging/upload')[0]!;
    expect(call.query).toContain('name=portrait.png');
    expect(call.headers['content-type']).toBe('application/octet-stream');
    expect(call.headers['x-csrf-token']).toBeTruthy();
    expect(call.body).toBeInstanceOf(File);
    expect(await screen.findByText('img_CCCCCCCCCCCCCCCC')).toBeInTheDocument();
  });

  it('places an image at its intended destination, and discards another after a confirmation', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /staging': staging(),
      'POST /staging/img_AAAAAAAAAAAAAAAA/place': { jobId: 'j1', status: 'succeeded', verified: true },
      'POST /staging/img_BBBBBBBBBBBBBBBB/discard': { jobId: 'j2', status: 'succeeded' },
    });
    renderApp('/ui/staging');
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row');
    await userEvent.click(within(rows[1]!).getByRole('button', { name: 'Place' }));
    const form = within(rows[1]!).getByRole('form', { name: 'Place Shrine' });
    await userEvent.click(within(form).getByRole('button', { name: 'Place' }));
    await waitFor(() => expect(api.find('POST', '/staging/img_AAAAAAAAAAAAAAAA/place')).toHaveLength(1));
    expect(api.find('POST', '/staging/img_AAAAAAAAAAAAAAAA/place')[0]!.body).toEqual({});

    await userEvent.click(within(rows[2]!).getByRole('button', { name: 'Discard' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Its bytes are kept by the bridge first');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(api.find('POST', '/staging/img_BBBBBBBBBBBBBBBB/discard')).toHaveLength(1));
    expect(api.find('POST', '/staging/img_BBBBBBBBBBBBBBBB/discard')[0]!.body).toEqual({ confirm: true });
  });

  it('places at a character the owner names', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /staging': staging({ staged: [image({ intended: null, intendedDestination: null })], old: 0 }),
      'POST /staging/img_AAAAAAAAAAAAAAAA/place': { jobId: 'j1', status: 'succeeded', verified: true },
    });
    renderApp('/ui/staging');
    await userEvent.click(await screen.findByRole('button', { name: 'Place' }));
    await userEvent.type(screen.getByLabelText('Character name'), 'Mehrana al-Khalid');
    await userEvent.type(screen.getByLabelText('Race (optional)'), 'Qishen');
    await userEvent.type(screen.getByLabelText('New name (optional)'), 'Scholar');
    const form = screen.getByRole('form', { name: 'Place Shrine' });
    await userEvent.click(within(form).getByRole('button', { name: 'Place' }));
    await waitFor(() => expect(api.find('POST', '/staging/img_AAAAAAAAAAAAAAAA/place')).toHaveLength(1));
    expect(api.find('POST', '/staging/img_AAAAAAAAAAAAAAAA/place')[0]!.body).toEqual({
      destination: { for_character: { name: 'Mehrana al-Khalid', race: 'Qishen' } },
      name: 'Scholar',
    });
  });
});

describe('a proposal to place a staged image', () => {
  it('says which image goes where, and that it holds no bytes', async () => {
    const op = {
      kind: 'place_image',
      stagedId: 'img_AAAAAAAAAAAAAAAA',
      assetId: 'a1',
      name: 'Shrine',
      from: ['LK-Bridge staging'],
      to: ['Characters', 'Beastkin', 'Foxians', 'Asagiri Miyabi'],
      createsFolders: ['Characters / Beastkin / Foxians / Asagiri Miyabi'],
      image: { format: 'jpeg', width: 20, height: 30, frames: 1, bytes: 1234, storedBytesVerified: true },
    };
    const p = {
      id: 'prop_img',
      principalId: 'pat_abc',
      principalLabel: 'Claude on the web',
      profile: 'Scribe',
      title: 'upload_image: place staged image “Shrine”',
      summary:
        'upload_image: place staged image “Shrine” in Characters / Beastkin / Foxians / Asagiri Miyabi',
      state: 'pending',
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 86_400_000,
      decidedAt: null,
      rejectReason: null,
      jobId: null,
      conflict: null,
      error: null,
      opCount: 3,
      requiresCanonicalApproval: false,
      canonicalApprovedBy: null,
      canonicalApprovedAt: null,
      pages: [],
    };
    installApi({
      ...baseRoutes(),
      'GET /proposals': { proposals: [p] },
      'GET /proposals/prop_img': { proposal: { ...p, ops: [], operations: [op], pageSummary: [] } },
    });
    renderApp('/ui/proposals?id=prop_img');
    const card = await screen.findByRole('region', { name: 'Image placement' });
    expect(card).toHaveTextContent('Shrine');
    expect(card).toHaveTextContent('img_AAAAAAAAAAAAAAAA');
    expect(card).toHaveTextContent('stored bytes verified');
    expect(card).toHaveTextContent('Characters / Beastkin / Foxians / Asagiri Miyabi');
    expect(card).toHaveTextContent('creating Characters / Beastkin / Foxians / Asagiri Miyabi');
  });
});

const event = (over: Record<string, unknown> = {}) => ({
  projectId: PROJECT_ID,
  stagedId: 'img_CCCCCCCCCCCCCCCC',
  change: 'uploaded',
  name: 'Agent’s portrait',
  state: 'uploaded',
  source: 'mcp',
  staged: 3,
  old: 1,
  ...over,
});

describe('the Staging page follows the stream (v2 D3.1)', () => {
  it('shows an agent’s staged image, a placement and a failure without a reload, and ignores another project', async () => {
    let current = staging({ staged: [image()], old: 0 });
    const api = installApi({ ...baseRoutes(), 'GET /staging': () => current });
    renderApp('/ui/staging');
    const table = await screen.findByRole('table');
    expect(within(table).queryByText('img_CCCCCCCCCCCCCCCC')).not.toBeInTheDocument();
    const stream = await openStream();
    // the first `hello` reloads once; let it settle so it cannot overwrite what the events bring
    await waitFor(() => expect(api.find('GET', '/staging').length).toBeGreaterThanOrEqual(2));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    const loads = () => api.find('GET', '/staging').length;
    const before = loads();

    // an event about ANOTHER project changes nothing and fetches nothing
    act(() => stream.emit('staging', event({ projectId: OTHER_PROJECT_ID })));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(loads()).toBe(before);

    // an agent stages an image: the list gains it, with no click and no navigation
    current = staging({
      staged: [image({ stagedId: 'img_CCCCCCCCCCCCCCCC', name: 'Agent’s portrait', source: 'mcp' }), image()],
      old: 0,
    });
    act(() => stream.emit('staging', event({ change: 'created', state: 'uploading' })));
    expect(await screen.findByText('img_CCCCCCCCCCCCCCCC')).toBeInTheDocument();
    expect(loads()).toBe(before + 1);

    // an approved proposal places one: it leaves the list
    current = staging({ staged: [image()], old: 0 });
    act(() => stream.emit('staging', event({ change: 'placed', staged: 1, old: 0 })));
    await waitFor(() => expect(screen.queryByText('img_CCCCCCCCCCCCCCCC')).not.toBeInTheDocument());

    // a failed upload leaves it, and the old-images report follows the counts (an old one has been discarded)
    current = staging({ staged: [image(), image({ stagedId: 'img_DDDDDDDDDDDDDDDD', old: true })], old: 1 });
    act(() => stream.emit('staging', event({ stagedId: 'img_DDDDDDDDDDDDDDDD', change: 'updated', old: 1 })));
    expect(await screen.findByText(/1 staged image older than 30 days/)).toBeInTheDocument();
    current = staging({ staged: [image()], old: 0 });
    act(() => stream.emit('staging', event({ stagedId: 'img_DDDDDDDDDDDDDDDD', change: 'failed', old: 0 })));
    await waitFor(() => expect(screen.queryByText(/staged image older than/)).not.toBeInTheDocument());
    expect(screen.queryByText('img_DDDDDDDDDDDDDDDD')).not.toBeInTheDocument();
  });

  it('several events in a burst cost one reload, not one each', async () => {
    const api = installApi({ ...baseRoutes(), 'GET /staging': staging() });
    renderApp('/ui/staging');
    await screen.findByRole('table');
    const stream = await openStream();
    await waitFor(() => expect(api.find('GET', '/staging').length).toBeGreaterThanOrEqual(2));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    const before = api.find('GET', '/staging').length;
    act(() => {
      for (let i = 0; i < 5; i++) stream.emit('staging', event({ stagedId: `img_E${i}` }));
    });
    await waitFor(() => expect(api.find('GET', '/staging').length).toBe(before + 1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(api.find('GET', '/staging').length).toBe(before + 1);
  });
});

describe('the subfolder of a character or page destination (v2 D3.2)', () => {
  const LANDS = 'Characters / Beastkin / Qishen / Mehrana al-Khalid / Wardrobe / Qipao';
  const previewOf = (call: { body: unknown }) => {
    const sub = (call.body as { destination?: { subfolders?: string } }).destination?.subfolders ?? '';
    if (/\/\s*\/|^\s*\/|\/\s*$/.test(sub)) {
      return {
        status: 400,
        body: {
          error: {
            code: 'INVALID_SUBFOLDER',
            message: `The subfolder path “${sub}” has an empty part (a slash at the start or the end, two slashes in a row, or a blank name). Write it like “Wardrobe / Qipao”.`,
          },
        },
      };
    }
    const segs = [
      ...['Characters', 'Beastkin', 'Qishen', 'Mehrana al-Khalid'].map((name) => ({ name, new: false })),
      ...sub
        .split('/')
        .map((p) => p.trim())
        .filter(Boolean)
        .map((name) => ({ name, new: true })),
    ];
    return {
      path: segs.map((s) => s.name).join(' / '),
      segments: segs,
      newFolders: segs.filter((s) => s.new).length,
      exists: false,
      notes: [],
      dryRun: true,
    };
  };

  async function openPlace(api: ReturnType<typeof installApi>) {
    renderApp('/ui/staging');
    await userEvent.click(await screen.findByRole('button', { name: 'Place' }));
    return api;
  }

  it('offers a Subfolder field for a character and a page, not for a folder path', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /staging': staging({ staged: [image({ intended: null, intendedDestination: null })], old: 0 }),
      'POST /staging/preview': previewOf,
    });
    await openPlace(api);
    const sub = screen.getByLabelText('Subfolder (optional)');
    expect(sub).toBeDisabled(); // a subfolder goes with a character or page: name one first
    await userEvent.type(screen.getByLabelText('Character name'), 'Mehrana al-Khalid');
    expect(sub).toBeEnabled();
    await userEvent.selectOptions(screen.getByLabelText('Destination'), 'page');
    expect(screen.getByLabelText('Subfolder (optional)')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Destination'), 'folder');
    expect(screen.queryByLabelText('Subfolder (optional)')).not.toBeInTheDocument();
  });

  it('shows the full resolved path before placing, new folders marked and counted, then places with the path as written', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /staging': staging({ staged: [image({ intended: null, intendedDestination: null })], old: 0 }),
      'POST /staging/preview': previewOf,
      'POST /staging/img_AAAAAAAAAAAAAAAA/place': { jobId: 'j1', status: 'succeeded', verified: true },
    });
    await openPlace(api);
    await userEvent.type(screen.getByLabelText('Character name'), 'Mehrana al-Khalid');
    await userEvent.type(screen.getByLabelText('Race (optional)'), 'Qishen');
    await userEvent.type(screen.getByLabelText('Subfolder (optional)'), 'Wardrobe / Qipao');
    const preview = await screen.findByTestId('path-preview');
    await waitFor(() => expect(preview).toHaveTextContent(`It will land in: ${LANDS} (2 new folders)`));
    // the new folders are marked, the existing ones are not
    const marked = [...preview.querySelectorAll('em.new-folder')].map((e) => e.textContent);
    expect(marked).toEqual(['Wardrobe', 'Qipao']);
    // the preview asked the bridge for a dry run with the path as written
    const last = api.find('POST', '/staging/preview').at(-1)!;
    expect(last.body).toEqual({
      destination: {
        for_character: { name: 'Mehrana al-Khalid', race: 'Qishen' },
        subfolders: 'Wardrobe / Qipao',
      },
    });
    // one level says "1 new folder"
    await userEvent.clear(screen.getByLabelText('Subfolder (optional)'));
    await userEvent.type(screen.getByLabelText('Subfolder (optional)'), 'Wardrobe');
    await waitFor(() =>
      expect(screen.getByTestId('path-preview')).toHaveTextContent('Wardrobe (1 new folder)'),
    );
    await userEvent.clear(screen.getByLabelText('Subfolder (optional)'));
    await userEvent.type(screen.getByLabelText('Subfolder (optional)'), 'Wardrobe / Qipao');
    await waitFor(() => expect(screen.getByTestId('path-preview')).toHaveTextContent('(2 new folders)'));
    const form = screen.getByRole('form', { name: 'Place Shrine' });
    await userEvent.click(within(form).getByRole('button', { name: 'Place' }));
    await waitFor(() => expect(api.find('POST', '/staging/img_AAAAAAAAAAAAAAAA/place')).toHaveLength(1));
    expect(api.find('POST', '/staging/img_AAAAAAAAAAAAAAAA/place')[0]!.body).toEqual({
      destination: {
        for_character: { name: 'Mehrana al-Khalid', race: 'Qishen' },
        subfolders: 'Wardrobe / Qipao',
      },
    });
  });

  it('shows the bridge’s reason for a bad path instead of a preview', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /staging': staging({ staged: [image({ intended: null, intendedDestination: null })], old: 0 }),
      'POST /staging/preview': previewOf,
    });
    await openPlace(api);
    await userEvent.type(screen.getByLabelText('Character name'), 'Mehrana al-Khalid');
    await userEvent.type(screen.getByLabelText('Subfolder (optional)'), 'Wardrobe //Qipao');
    expect(await screen.findByRole('alert')).toHaveTextContent(/has an empty part/);
    expect(screen.queryByTestId('path-preview')).not.toBeInTheDocument();
  });

  it('with no subfolder the preview is just the character’s folder, and a page destination sends for_page', async () => {
    const api = installApi({
      ...baseRoutes(),
      'GET /staging': staging({ staged: [image({ intended: null, intendedDestination: null })], old: 0 }),
      'POST /staging/preview': previewOf,
    });
    await openPlace(api);
    await userEvent.type(screen.getByLabelText('Character name'), 'Mehrana al-Khalid');
    const preview = await screen.findByTestId('path-preview');
    await waitFor(() =>
      expect(preview).toHaveTextContent(
        'It will land in: Characters / Beastkin / Qishen / Mehrana al-Khalid',
      ),
    );
    expect(preview).not.toHaveTextContent('new folder');
    await userEvent.selectOptions(screen.getByLabelText('Destination'), 'page');
    await userEvent.clear(screen.getByLabelText('Page name or id')); // the field keeps what was typed for the character
    await userEvent.type(screen.getByLabelText('Page name or id'), 'Mehrana');
    await userEvent.type(screen.getByLabelText('Subfolder (optional)'), 'Wardrobe');
    await waitFor(() =>
      expect(api.find('POST', '/staging/preview').at(-1)!.body).toEqual({
        destination: { for_page: 'Mehrana', subfolders: 'Wardrobe' },
      }),
    );
  });
});
