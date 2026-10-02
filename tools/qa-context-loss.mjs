// QA: a WebGL context loss in the middle of a round must not reload the page: the round keeps
// running, the picture comes back, the lighting environment is re-baked.
//   node tools/qa-context-loss.mjs [--city halloween]
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const root = resolve(import.meta.dirname, '..');
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const city = arg('--city', 'shanghai');
const out = resolve(root, 'renders/review/qa/stability');
mkdirSync(out, { recursive: true });
const vite = await import('vite');
const server = await vite.createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 5211, strictPort: false, hmr: false } });
await server.listen();
const base = `${server.resolvedUrls.local[0]}game/`;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
const errors = [];
let navigations = 0;
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && !/favicon|Failed to load resource|supabase|ERR_/i.test(m.text()) && errors.push(m.text()));
page.on('framenavigated', (f) => f === page.mainFrame() && navigations++);
let failures = 0;
const ok = (c, msg) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${msg}`); if (!c) failures++; };
// Real-time loop (no test=1): solo vs AI, low quality, start the round through the session.
await page.goto(`${base}?mode=arena&net=solo&quality=low&lang=en&name=CL&city=${city}`);
await page.waitForFunction(() => window.__ARENA__?.ready, null, { timeout: 180000 });
await page.evaluate((c) => { const s = window.__ARENA__.session; if (c && s.setCity) s.setCity(c); s.start(); }, city);
await page.waitForFunction(() => window.__ARENA__.summary().phase === 'playing', null, { timeout: 300000, polling: 1000 });
const nav0 = navigations;
const px0 = await page.evaluate((() => {
  window.__ARENA__.render(); // read back in the same task: the drawing buffer is not preserved
  const c = document.createElement('canvas');
  const src = document.querySelector('canvas');
  c.width = 64; c.height = 36;
  const x = c.getContext('2d');
  x.drawImage(src, 0, 0, 64, 36);
  const d = x.getImageData(0, 0, 64, 36).data;
  let sum = 0, sq = 0;
  for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += l; sq += l * l; }
  const n = d.length / 4;
  return { mean: +(sum / n).toFixed(1), std: +Math.sqrt(sq / n - (sum / n) ** 2).toFixed(1) };
}));
await page.screenshot({ path: `${out}/context-before-${city}.jpg`, type: 'jpeg', quality: 75 });
await page.evaluate(() => { window.__marker = 42; });
const before = await page.evaluate(() => ({ t: window.__ARENA__.game().matchTime, env: !!window.__ARENA__.game().scene.environment }));
const res = await page.evaluate(async () => {
  const c = document.querySelector('canvas');
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  const ext = gl.getExtension('WEBGL_lose_context');
  const lost = new Promise((r) => c.addEventListener('webglcontextlost', r, { once: true }));
  ext.loseContext();
  await lost;
  await new Promise((r) => setTimeout(r, 2000));
  const noteWhileLost = [...document.body.children].some((e) => /RESTORING/.test(e.textContent ?? ''));
  const restored = new Promise((r) => c.addEventListener('webglcontextrestored', r, { once: true }));
  ext.restoreContext();
  await restored;
  return { noteWhileLost, envSame: null };
});
await page.waitForTimeout(8000);
const after = await page.evaluate(() => {
  const g = window.__ARENA__.game();
  window.__ARENA__.render();
  const c = document.querySelector('canvas');
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  return { marker: window.__marker, t: g.matchTime, phase: window.__ARENA__.summary().phase, env: !!g.scene.environment, lost: gl.isContextLost(), note: [...document.body.children].some((e) => /RESTORING|RELOADING/.test(e.textContent ?? '')) };
});
await page.screenshot({ path: `${out}/context-restored-${city}.jpg`, type: 'jpeg', quality: 75 });
const px = await page.evaluate((() => {
  window.__ARENA__.render(); // read back in the same task: the drawing buffer is not preserved
  const c = document.createElement('canvas');
  const src = document.querySelector('canvas');
  c.width = 64; c.height = 36;
  const x = c.getContext('2d');
  x.drawImage(src, 0, 0, 64, 36);
  const d = x.getImageData(0, 0, 64, 36).data;
  let sum = 0, sq = 0;
  for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += l; sq += l * l; }
  const n = d.length / 4;
  return { mean: +(sum / n).toFixed(1), std: +Math.sqrt(sq / n - (sum / n) ** 2).toFixed(1) };
}));
ok(res.noteWhileLost, 'a "restoring" note shows while the context is lost');
ok(after.marker === 42 && navigations === nav0, `no page reload (navigations ${navigations - nav0})`);
ok(!after.lost && !after.note, 'context back, note gone');
ok(after.phase === 'playing' && after.t > before.t, `round kept running (t ${before.t.toFixed(1)} → ${after.t.toFixed(1)}, ${after.phase})`);
ok(after.env, 'scene has an environment again');
ok(px.std > 8 && px.mean > 15 && Math.abs(px.mean - px0.mean) < 25, `picture is back (canvas mean ${px0.mean} → ${px.mean}, std ${px0.std} → ${px.std})`);
ok(errors.length === 0, `no page errors ${errors.slice(0, 3).join(' | ')}`);
await browser.close();
await server.close();
console.log(failures ? `qa-context-loss: ${failures} FAILED` : 'qa-context-loss: all checks passed');
process.exit(failures ? 1 : 0);
