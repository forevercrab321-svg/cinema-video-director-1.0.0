// Halloween Town gameplay stills (solo autopilot): grow, scores locked, villains rising, chase.
// node tools/halloween-shots.mjs → renders/review/halloween/game-*.png
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
  await p.screenshot({ path: out + name + '.png' });
  console.log(name, JSON.stringify(await p.evaluate(() => window.__ARENA__.stats())));
}
await b.close(); await server.close();
