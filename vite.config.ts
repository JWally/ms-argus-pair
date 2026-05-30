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
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
