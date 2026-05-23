import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true, // expose to LAN so a phone on the same network can reach it
    proxy: {
      // Local dev: proxy /api/* to the local signaling server (npm run dev:signaling)
      '/api': {
        target: 'http://localhost:9090',
        changeOrigin: false,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
