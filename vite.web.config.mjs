import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Production build for our own website (npm run build:web → dist-web/).
// Only the game entry is built; public/ (hdri, music, legal, icons, og.png,
// manifest, robots.txt, index.html redirect) is copied to the site root.
// The studio model viewer (root index.html) stays in the default vite.config.ts build.
// Vendor chunks: three.js and the Supabase client change far less often than the game code, so
// returning players keep them cached across releases, and the browser fetches them in parallel.
const vendorChunks = {
  groups: [
    { name: 'three', test: /node_modules[\\/]three[\\/]/, priority: 2 },
    { name: 'supabase', test: /node_modules[\\/]@supabase[\\/]/, priority: 1 },
  ],
};

export default defineConfig({
  root: import.meta.dirname,
  base: '/',
  build: {
    outDir: resolve(import.meta.dirname, 'dist-web'),
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        game: resolve(import.meta.dirname, 'game/index.html'),
      },
      output: { codeSplitting: vendorChunks },
    },
  },
});
