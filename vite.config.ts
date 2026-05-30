import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';

// Bundle visualizer: emits stats.html during build when ANALYZE=1.
// Skipped by default so the standard build / deploy path is unchanged.
const analyze = process.env.ANALYZE === '1';

export default defineConfig({
  plugins: [
    react(),
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
