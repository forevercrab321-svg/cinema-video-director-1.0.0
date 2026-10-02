// Build a portal zip: vite build (vite.portal.config.mjs) → strip site-only files → zip.
// Portals host the game themselves, so the website redirect, robots.txt and PWA manifest go.
//   node tools/build-portal.mjs [target]
//     (none)            dist-portal.zip — CrazyGames / Poki (SDK picked from the host), itch.io, Newgrounds, Y8
//     gamedistribution  dist-portal-gamedistribution.zip — GD SDK; needs VITE_GD_GAME_ID in .env.local
//     nosdk             dist-portal-nosdk.zip — no third-party SDK code (GamePix: "GamePix SDK or none")
//     crazygames        dist-portal-crazygames.zip — CrazyGames SDK only (their terms forbid other portals' SDKs)
// Online rooms need VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in .env.local (anon key only).
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const target = process.argv[2] ?? '';
if (!['', 'gamedistribution', 'nosdk', 'crazygames'].includes(target)) throw new Error(`unknown portal target "${target}"`);
const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'dist-portal');
const zipName = target ? `dist-portal-${target}.zip` : 'dist-portal.zip';

const envLocal = resolve(root, '.env.local');
const envText = existsSync(envLocal) ? readFileSync(envLocal, 'utf8') : '';
const hasEnv = (k) => new RegExp(`^${k}=\\S+`, 'm').test(envText) || !!process.env[k];
if (!hasEnv('VITE_SUPABASE_URL') || !hasEnv('VITE_SUPABASE_ANON_KEY')) console.warn('⚠ no Supabase config: this zip runs solo vs AI only (no online rooms, no telemetry)');
if (target === 'gamedistribution' && !hasEnv('VITE_GD_GAME_ID')) console.warn('⚠ no VITE_GD_GAME_ID: GD ads will not serve until the game id is set');

execSync('npx vite build -c vite.portal.config.mjs', { cwd: root, stdio: 'inherit', env: { ...process.env, VITE_PORTAL: target, VITE_PORTAL_BUILD: '1' } });
for (const f of ['robots.txt', 'manifest.webmanifest', 'og.png']) rmSync(resolve(out, f), { force: true });
// Portal uploaders (and the browser agent that drives them) refuse SVG files; the PNG favicon covers it.
for (const f of ['icons/icon.svg', 'icons/icon-maskable.svg']) rmSync(resolve(out, f), { force: true });
const html = resolve(out, 'index.html');
if (!existsSync(html) || !readFileSync(html, 'utf8').includes('<script')) throw new Error('portal index.html missing the game script (public/index.html overwrote it?)');
// Portal pages must not link out to our own site: drop the manifest link and absolute icon paths.
writeFileSync(html, readFileSync(html, 'utf8').replace(/\s*<link rel="manifest"[^>]*>/, '').replace(/\s*<link[^>]*icon\.svg[^>]*>/g, '').replaceAll('href="/icons/', 'href="./icons/'));
if (target === 'crazygames') {
  const leaks = readdirSync(resolve(out, 'assets')).filter((f) => /Poki|GameDistribution/.test(f) || /poki-sdk|game-cdn\.poki|gamedistribution\.com/.test(readFileSync(resolve(out, 'assets', f), 'latin1')));
  if (leaks.length) throw new Error(`crazygames build still references another portal SDK: ${leaks.join(', ')}`);
}
if (target === 'gamedistribution') {
  const leaks = readdirSync(resolve(out, 'assets')).filter((f) => /CrazyGames|Poki/.test(f) || /sdk\.crazygames|CrazyGames\??\.SDK|updateRoom|poki-sdk|game-cdn\.poki/.test(readFileSync(resolve(out, 'assets', f), 'latin1')));
  if (leaks.length) throw new Error(`gamedistribution build still references another portal SDK: ${leaks.join(', ')}`);
}
if (target === 'nosdk') {
  const leaks = readdirSync(resolve(out, 'assets')).filter((f) => /CrazyGames|Poki|GameDistribution/.test(f) || /sdk\.crazygames|CrazyGames\??\.SDK|updateRoom|poki-sdk|gamedistribution\.com/.test(readFileSync(resolve(out, 'assets', f), 'latin1')));
  if (leaks.length) throw new Error(`nosdk build still references a portal SDK: ${leaks.join(', ')}`);
}
rmSync(resolve(root, zipName), { force: true });
execSync(`zip -qr ../${zipName} .`, { cwd: out });
const mb = (statSync(resolve(root, zipName)).size / 1048576).toFixed(2);
console.log(`${zipName} ${mb} MB`);
