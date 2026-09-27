import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Portal build (CrazyGames / Poki / itch.io / Newgrounds …): npm run build:portal → dist-portal/
// and dist-portal.zip. Relative base so the zip runs from any path; the game page is the
// zip's root index.html. The platform SDK is picked at runtime from the host (game/src/platform).
export default defineConfig({
  root: resolve(import.meta.dirname, 'game'),
  publicDir: resolve(import.meta.dirname, 'public'),
  // root is game/, but .env.local (Supabase anon key, GD game id) lives at the repo root.
  envDir: import.meta.dirname,
  base: './',
  build: {
    outDir: resolve(import.meta.dirname, 'dist-portal'),
    emptyOutDir: true,
  },
});
