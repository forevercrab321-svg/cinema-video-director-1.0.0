import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Portal build (CrazyGames / Poki / itch.io / Newgrounds …): npm run build:portal → dist-portal/
// and dist-portal.zip. Relative base so the zip runs from any path; the game page is the
// zip's root index.html. The platform SDK is picked at runtime from the host (game/src/platform).
// Browser floor: Safari / iOS 15 (WebGL 2 + top-level await). Vite's default target
// (baseline-widely-available = Safari 16.4) leaves three.js's class static blocks in the bundle,
// a SyntaxError on iOS 15.x–16.3 that left a blank page. Down-levelled syntax costs ~nothing.
const browserTarget = ['chrome100', 'edge100', 'firefox100', 'safari15', 'ios15'];
// Vendor chunks: three.js and the Supabase client change far less often than the game code, so
// returning players keep them cached across releases, and the browser fetches them in parallel.
const vendorChunks = {
  groups: [
    { name: 'three', test: /node_modules[\\/]three[\\/]/, priority: 2 },
    { name: 'supabase', test: /node_modules[\\/]@supabase[\\/]/, priority: 1 },
  ],
};

export default defineConfig({
  root: resolve(import.meta.dirname, 'game'),
  publicDir: resolve(import.meta.dirname, 'public'),
  // root is game/, but .env.local (Supabase anon key, GD game id) lives at the repo root.
  envDir: import.meta.dirname,
  base: './',
  build: {
    target: browserTarget,
    outDir: resolve(import.meta.dirname, 'dist-portal'),
    emptyOutDir: true,
    rolldownOptions: { output: { codeSplitting: vendorChunks } },
  },
});
