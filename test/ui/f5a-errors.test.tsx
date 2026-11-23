// @vitest-environment jsdom
/**
 * v3 F5a (ADR 0067, H10 and H11): the error card. "Refused before it was sent" only when the request truly never left;
 * a write whose connection broke after it was sent says so, and shows that its outcome is unknown; a call the caller
 * cancelled is "cancelled by the caller", never "bridge".
 */
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { baseRoutes, installApi, renderApp, useDom } from './helpers';

useDom();

const group = (classification: string, code: string) => ({
  fingerprint: `replaceDocumentBlocks|${code}|`,
  opId: 'replaceDocumentBlocks',
  code,
  path: '',
  classification,
  count: 1,
  firstSeen: Date.now() - 60_000,
  lastSeen: Date.now() - 60_000,
  resolved: false,
  lastMessage: 'x',
  lastRequestId: null,
  lastJobId: 'job_1',
});

const occurrence = (o: { classification: string; code: string; detail: Record<string, unknown> }) => ({
  id: 1,
  at: Date.now() - 60_000,
  opId: 'replaceDocumentBlocks',
  jobId: 'job_1',
  stepNo: 3,
  principalId: 'oauth_x',
  profile: 'chatgpt',
  status: null,
  code: o.code,
  message:
    'The connection to LegendKeeper broke after the request was sent, while its reply was being read: terminated',
  issues: [],
  requestId: null,
  retryable: false,
  classification: o.classification,
  detail: o.detail,
  resolvedAt: null,
});

async function card(o: { classification: string; code: string; detail: Record<string, unknown> }) {
  installApi({
    ...baseRoutes(),
    'GET /errors/group': { group: group(o.classification, o.code), occurrences: [occurrence(o)] },
  });
  renderApp(`/ui/errors?fp=${encodeURIComponent(`replaceDocumentBlocks|${o.code}|`)}`);
  return screen.findByRole('article', { name: /Occurrence at/ });
}

describe('H10: the error card', () => {
  it('terminated after it was sent: not "refused before it was sent"; the outcome is unknown', async () => {
    const a = await card({
      classification: 'upstream',
      code: 'RESPONSE_INTERRUPTED',
      detail: { sent: 'yes', ambiguous: true },
    });
    expect(within(a).getByText('none (the request was sent; its reply never arrived)')).toBeInTheDocument();
    expect(within(a).queryByText(/refused before it was sent/)).toBeNull();
    expect(within(a).getByText('outcome unknown: it may have applied')).toBeInTheDocument();
  });

  it('never sent: "refused before it was sent", and no unknown outcome', async () => {
    const a = await card({
      classification: 'bridge',
      code: 'IF_MATCH_REQUIRED',
      detail: { sent: 'no', ambiguous: false },
    });
    expect(within(a).getByText('none (refused before it was sent)')).toBeInTheDocument();
    expect(within(a).queryByText(/outcome unknown/)).toBeNull();
  });

  it('an older record that does not say: "none recorded", never the wrong claim', async () => {
    const a = await card({ classification: 'bridge', code: 'UNEXPECTED', detail: { ambiguous: false } });
    expect(within(a).getByText('none recorded')).toBeInTheDocument();
  });
});

describe('H11: a call the caller cancelled', () => {
  it('is shown as "cancelled by the caller", not as a bridge error', async () => {
    const a = await card({ classification: 'client', code: 'ABORTED', detail: { sent: 'yes' } });
    expect(within(a).getByText('cancelled by the caller')).toBeInTheDocument();
    expect(within(a).queryByText('bridge')).toBeNull();
  });
});
