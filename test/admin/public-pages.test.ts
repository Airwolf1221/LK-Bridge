import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderPrivacy } from '../../src/public/pages.js';
import { UI_CSP } from '../../src/admin/ui.js';
import { startAdminStack, type AdminStack } from './helpers.js';

let stack: AdminStack;
beforeAll(async () => {
  stack = await startAdminStack();
});
afterAll(() => stack.close());

const anon = (path: string) => fetch(stack.base + path, { redirect: 'manual' });

describe('public pages', () => {
  it.each(['/about', '/privacy', '/public.css'])(
    '%s answers 200 with no session, no cookie and the strict CSP',
    async (path) => {
      const res = await anon(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(res.headers.get('content-security-policy')).toBe(UI_CSP);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      if (path !== '/public.css') {
        const text = await res.text();
        expect(res.headers.get('content-type')).toMatch(/text\/html/);
        expect(text.toLowerCase()).not.toContain('<script');
        expect(text).not.toMatch(/\son[a-z]+=|style=|<style/i);
        expect(text).toContain('lang="en-GB"');
      }
    },
  );

  it('privacy names drive.file and the key facts', async () => {
    const text = await (await anon('/privacy')).text();
    for (const s of ['drive.file', 'encrypted', 'shares nothing', 'Disconnect', 'third-party access'])
      expect(text, s).toContain(s);
  });

  it('shows the contact line only when the setting is set, and escapes it', async () => {
    expect(await (await anon('/privacy')).text()).not.toContain('Contact');
    const ok = await stack.put('/api/admin/settings/contact-email', {
      value: 'owner@example.test',
      confirm: true,
    });
    expect(ok.status).toBe(200);
    expect(await (await anon('/privacy')).text()).toContain('owner@example.test');
    // A value that would break out of the HTML is not a valid email, so it is refused...
    const bad = await stack.put('/api/admin/settings/contact-email', {
      value: '<b>x</b>@example.test',
      confirm: true,
    });
    expect(bad.status).toBe(400);
    // The renderer escapes whatever it is given, as a second line of defence.
    const html = renderPrivacy('"><script>alert(1)</script>&@x.test');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&#34;&#62;&#60;script&#62;');
    await stack.put('/api/admin/settings/contact-email', { value: null, confirm: true });
    expect(await (await anon('/privacy')).text()).not.toContain('Contact');
  });

  it('leaves GET / and the dashboard as they were', async () => {
    const root = await anon('/');
    expect(root.status).toBe(404);
    const ui = await anon('/ui');
    expect(ui.status).toBe(303);
    expect(new URL(ui.headers.get('location')!, 'https://x.invalid').pathname).toBe('/oauth/login');
  });
});
