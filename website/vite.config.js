import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' keeps asset URLs relative so the same build works on
// GitHub Pages (saaranshM.github.io/unsnooze/) and any static host.
// Multi-page: /, /docs/ and /changelog/ are real static routes — no SPA
// fallback needed on Pages.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        docs: resolve(import.meta.dirname, 'docs/index.html'),
        changelog: resolve(import.meta.dirname, 'changelog/index.html'),
        feedback: resolve(import.meta.dirname, 'feedback/index.html'),
      },
    },
  },
  server: {
    fs: {
      // the changelog page imports ../CHANGELOG.md?raw straight from the repo
      allow: [resolve(import.meta.dirname, '..')],
    },
  },
});
