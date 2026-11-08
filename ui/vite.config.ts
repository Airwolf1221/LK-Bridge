import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The dashboard is built to static files under `ui/dist` and served by the bridge at `/ui`. Everything is bundled:
 * no external fonts or scripts, and nothing inline, because the bridge's Content-Security-Policy forbids them.
 */
export default defineConfig({
  root: import.meta.dirname,
  base: '/ui/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // Nothing may be inlined into the page (CSP): keep assets as files.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    cssCodeSplit: false,
    target: 'es2022',
  },
  server: {
    port: 5173,
    // `npm run dev:ui` talks to a bridge running on 8787 (sign in there first; cookies are per host).
    proxy: { '/api/admin': 'http://127.0.0.1:8787', '/oauth': 'http://127.0.0.1:8787' },
  },
});
