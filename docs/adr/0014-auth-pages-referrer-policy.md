# ADR 0014: Sign-in, consent and sign-out pages use `Referrer-Policy: same-origin`

Status: Accepted (chunk 5, 8 November 2026). Amends chunk 4's page headers; no PLAN decision is changed.

## Context

Chunk 4's pages sent `Referrer-Policy: no-referrer` (and a matching `<meta>`), and their form POSTs are checked against
the bridge's own `Origin`. Driving the real sign-in in Chromium for the dashboard's browser test showed every sign-in
refused ("This form must be submitted from LK-Bridge itself"). Under `no-referrer` a browser serialises the `Origin` of a
**form** POST as `null` (the Fetch standard does this for non-CORS requests), so the check failed. Chunk 4's tests use
`fetch`, which sends the real Origin, so they could not see it. The bridge could not be signed into from a browser.

## Decision

Send `Referrer-Policy: same-origin` (header and `<meta>`) on the pages in `src/auth` (`htmlHeaders`, `layout`). Nothing is
sent to any other site, which was the point of `no-referrer`; same-origin requests carry the real `Origin`, so the existing
Origin check works unchanged. It was preferred to accepting `Origin: null`, which would weaken the check.

The dashboard keeps `no-referrer`, as specified. It uses `fetch`, which sends the correct Origin; its sign-out therefore
`fetch`es `/oauth/logout` instead of submitting a form.

## Consequences

- Owner sign-in, consent and sign-out work in a real browser. Regression test: `test/admin/ui.test.ts`; the browser test
  signs in for real.
- Every future form on a `no-referrer` page would have the same problem; keep forms on the auth pages, or use `fetch`.
