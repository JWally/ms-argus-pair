import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';

// Bundle visualizer: emits stats.html during build when ANALYZE=1.
// Skipped by default so the standard build / deploy path is unchanged.
const analyze = process.env.ANALYZE === '1';

/**
 * Make Vite's auto-injected `<link rel="stylesheet">` non-render-blocking.
 *
 * The browser blocks first paint on ANY <link rel=stylesheet> in <head>,
 * even when the visible above-the-fold content (our inline splash) uses
 * only inline styles. That defeats the splash's whole purpose: on a cold
 * load the user stares at a blank screen until the CSS round-trips.
 *
 * Fix: swap rel="stylesheet" → media="print" onload="this.media='all'".
 * Browser fetches it but doesn't block screen render on it; once
 * downloaded the onload swaps media to 'all' and the stylesheet applies.
 * Standard pattern, supported everywhere. <noscript> fallback for
 * JS-disabled clients gets a normal blocking link.
 *
 * Only touches Vite-emitted stylesheet links; manual <style> blocks
 * stay as written. Runs on every build (no flag).
 */
function nonBlockingCssPlugin(): Plugin {
  return {
    name: 'non-blocking-css',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(
        /<link([^>]*?)\srel="stylesheet"([^>]*?)>/g,
        (_match, before: string, after: string) =>
          `<link${before} rel="stylesheet"${after} media="print" onload="this.media='all'"><noscript><link${before} rel="stylesheet"${after}></noscript>`
      );
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    nonBlockingCssPlugin(),
    ...(analyze
      ? [
          visualizer({
            filename: 'dist/stats.html',
            template: 'treemap',
            gzipSize: true,
            brotliSize: true,
            open: false,
          }),
        ]
      : []),
  ],
  server: {
    port: 5173,
    host: true, // expose to LAN so a phone on the same network can reach it
    // Proxy /api → deployed dev-jw API so `vite dev` can drive a real
    // pair session against AWS without spinning up the Lambda locally.
    // changeOrigin rewrites Host so API Gateway routes correctly. The
    // origin-allowlist on the API side accepts captcha-dev-jw.argus.pw,
    // so we set Origin to that explicitly via the configure hook.
    proxy: {
      '/api': {
        target: 'https://captcha-dev-jw.argus.pw',
        changeOrigin: true,
        secure: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('origin', 'https://captcha-dev-jw.argus.pw');
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
