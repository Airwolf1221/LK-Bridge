// @vitest-environment jsdom
/**
 * v2 D3 (ADR 0041) on the dashboard: the Staging page lists staged images with thumbnails, uploads chosen files as raw
 * bodies with the CSRF token, places one at a destination, discards one after a confirmation, and reports old ones.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { baseRoutes, installApi, renderApp, useDom } from './helpers';

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
