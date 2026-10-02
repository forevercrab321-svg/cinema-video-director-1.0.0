// Halloween Town gameplay stills (solo autopilot): grow, scores locked, villains rising, chase.
// node tools/halloween-shots.mjs → renders/review/halloween/game-*.jpg
import { chromium } from 'playwright';
const root = '/home/user/cinema-video-director-1.0.0';
const vite = await import('vite');
const server = await vite.createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 5201, strictPort: false, hmr: false } });
await server.listen();
const base = `${server.resolvedUrls.local[0]}game/`;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.log('pageerror', e.message));
await p.goto(`${base}?mode=arena&net=solo&test=1&quality=high&name=You&lang=en`);
await p.waitForFunction(() => window.__ARENA__?.ready, null, { timeout: 180000 });
await p.evaluate(() => { const S = window.__ARENA__.session; S.setCity('halloween'); S.start(); window.__ARENA__.step(0.1); window.__ARENA__.autopilot(true); });
const out = root + '/renders/review/halloween/';
for (const [t, name] of [[25, 'game-grow-25s'], [160, 'game-grow-160s'], [301.5, 'game-locked'], [304.5, 'game-rise'], [312, 'game-chase']]) {
  for (;;) { const s = await p.evaluate(() => window.__ARENA__.step(1)); if (s.t >= t || s.phase === 'results') break; }
  await p.evaluate(() => window.__ARENA__.render());
  await p.screenshot({ path: out + name + '.jpg' });
  console.log(name, JSON.stringify(await p.evaluate(() => window.__ARENA__.stats())));
}
// Egg Valley: drive up to her hiding place, see the ghost, honk, get the backpack and turn invisible.
const egg = await p.evaluate(() => { const g = window.__ARENA__.game(); window.__ARENA__.autopilot(false); return { x: g.hunt.egg.x, z: g.hunt.egg.z }; });
const park = () => p.evaluate(({ x, z }) => { const g = window.__ARENA__.game(); if (!g.local?.alive) return; g.local.x = x + 2; g.local.z = z + 2; g.local.heading = Math.atan2(2, 2); g.local.speed = 0; g.rig.yaw = g.local.heading; }, egg);
await park(); await p.evaluate(() => window.__ARENA__.step(0.6)); await park();
await p.evaluate(() => window.__ARENA__.render()); await p.screenshot({ path: out + 'game-egg-hint.jpg' });
await p.evaluate(() => window.__ARENA__.game().emote(6));
for (let i = 0; i < 6; i++) { await park(); await p.evaluate(() => window.__ARENA__.step(0.15)); }
await p.evaluate(() => window.__ARENA__.render()); await p.screenshot({ path: out + 'game-egg-reveal.jpg' });
if (process.env.EGG_DEBUG) {
  const info = await p.evaluate(() => { const g = window.__ARENA__.game(); const m = g.hunt.egg.model; const r = []; m.root.traverse((o) => { if (o.visible && (o.isMesh || o.isPoints || o.isSprite)) r.push(o.type + ':' + o.name + ':' + (Array.isArray(o.material) ? o.material.map((x) => x.name || x.type).join('|') : (o.material.name || o.material.type)) + ':' + (o.material.blending ?? '')); }); m.root.visible = false; return r; });
  console.log('egg meshes', JSON.stringify(info));
  await p.evaluate(() => window.__ARENA__.render()); await p.screenshot({ path: out + 'game-egg-reveal-nogirl.jpg' });
}
for (let i = 0; i < 12; i++) { await park(); await p.evaluate(() => window.__ARENA__.step(0.2)); }
await p.evaluate(() => window.__ARENA__.render()); await p.screenshot({ path: out + 'game-egg-stealth.jpg' });
console.log('egg', JSON.stringify(await p.evaluate(() => window.__ARENA__.summary().hunt.egg)));
await b.close(); await server.close();
