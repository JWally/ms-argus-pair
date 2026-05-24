import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true, // expose to LAN so a phone on the same network can reach it
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
