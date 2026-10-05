// Steam store stills from the Steam/portal build flavour (VITE_PORTAL_BUILD=1 → neutral villain
// names): Halloween Town gameplay with HUD (store screenshots) and HUD-free key art (capsules,
// library hero). Solo autopilot, fixed match times, so reruns give the same shots.
//   node tools/steam-shots.mjs → release/steam-store/screenshots/*.jpg, release/steam-store/art/*.png
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const shotsDir = resolve(root, 'release/steam-store/screenshots');
const artDir = resolve(root, 'release/steam-store/art');
mkdirSync(shotsDir, { recursive: true });
mkdirSync(artDir, { recursive: true });
process.env.VITE_PORTAL_BUILD = '1';
process.env.VITE_PORTAL = 'nosdk';
const vite = await import('vite');
const server = await vite.createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 5203, strictPort: false, hmr: false } });
await server.listen();
const base = `${server.resolvedUrls.local[0]}game/`;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
p.on('pageerror', (e) => console.log('pageerror', e.message));
await p.goto(`${base}?mode=arena&net=solo&test=1&quality=high&name=You&lang=en`);
await p.waitForFunction(() => window.__ARENA__?.ready, null, { timeout: 240000 });
await p.evaluate(() => { const S = window.__ARENA__.session; S.setCity('halloween'); S.start(); window.__ARENA__.step(0.1); window.__ARENA__.autopilot(true); });

const hud = (on) => p.evaluate((on) => {
  let st = document.getElementById('steam-shot-nohud');
  if (!on && !st) { st = document.createElement('style'); st.id = 'steam-shot-nohud'; st.textContent = 'body *:not(canvas){visibility:hidden!important}'; document.head.appendChild(st); }
  if (on && st) st.remove();
}, on);
const runTo = (t) => p.evaluate(async (t) => { for (;;) { const s = window.__ARENA__.step(1); if (s.t >= t || s.phase === 'results') return s; await new Promise((r) => setTimeout(r, 0)); } }, t);
const settle = () => p.evaluate(() => { for (let i = 0; i < 6; i++) window.__ARENA__.step(1 / 30); window.__ARENA__.render(); });
const shoot = async (name, { art = false, size = [1920, 1080], scale = 1 } = {}) => {
  await p.setViewportSize({ width: size[0], height: size[1] });
  if (scale !== 1) await p.evaluate(() => window.dispatchEvent(new Event('resize')));
  await hud(!art);
  await settle();
  await p.screenshot(art ? { path: resolve(artDir, `${name}.png`) } : { path: resolve(shotsDir, `${name}.jpg`), type: 'jpeg', quality: 90 });
  await hud(true);
  await p.setViewportSize({ width: 1920, height: 1080 });
  console.log(name);
};

await runTo(40); await shoot('halloween-01-grow-40s');
await shoot('art-halloween-40s', { art: true });
await runTo(160); await shoot('halloween-02-grow-160s');
await shoot('art-halloween-160s', { art: true });
await shoot('art-hero-160s', { art: true, size: [1920, 620] });
await runTo(250); await shoot('halloween-03-grow-250s');
await shoot('art-halloween-250s', { art: true });
await runTo(304.5); await shoot('halloween-04-bosses-awaken');
await runTo(312); await shoot('halloween-05-chase');
await shoot('art-chase-312s', { art: true });
await runTo(330); await shoot('halloween-06-chase-330s');
await shoot('art-chase-330s', { art: true });
await b.close();
await server.close();
