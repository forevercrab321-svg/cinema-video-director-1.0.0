// QA (CrazyGames rejection "stability and technical improvements"): play the PORTAL package the
// way the CrazyGames QA tool does: inside an iframe, with a CrazyGames SDK stand-in (environment
// 'crazygames', records every call), CPU throttled ×4, driving the real UI (no test hooks for input).
// Backend scenarios: refuse (Supabase connection refused), hang (Supabase never answers),
// slow (answers after 3 s with 503).
//   node tools/qa-portal-stability.mjs --dir <unzipped package> [--backend refuse,hang] [--play 60] [--cpu 4]
// Report: renders/review/qa/stability/report.json + screenshots.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const dir = resolve(arg('--dir', ''));
const scenarios = arg('--backend', 'refuse,hang').split(',');
const playSeconds = Number(arg('--play', 60));
const cpu = Number(arg('--cpu', 4));
const out = resolve(root, arg('--out', 'renders/review/qa/stability'));
mkdirSync(out, { recursive: true });
if (!existsSync(join(dir, 'index.html'))) throw new Error(`no index.html in ${dir}`);

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mp3': 'audio/mpeg', '.png': 'image/png', '.hdr': 'application/octet-stream', '.md': 'text/plain', '.json': 'application/json' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/host.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><body style="margin:0;background:#000"><iframe id="g" src="/game/index.html" style="border:0;width:100vw;height:100vh" allow="autoplay; fullscreen"></iframe></body>');
    return;
  }
  const f = join(dir, path.replace(/^\/game\//, '/'));
  if (!f.startsWith(dir) || !existsSync(f) || statSync(f).isDirectory()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': types[extname(f)] ?? 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// CrazyGames SDK v3 stand-in: environment 'crazygames', ads finish immediately, every call logged.
const SDK_STUB = `(() => {
  const log = (k, a) => { (window.__cg ??= []).push([k, Math.round(performance.now()), a ?? null]); };
  const g = (k) => (...a) => log('game.' + k, a[0]);
  window.CrazyGames = { SDK: {
    environment: 'crazygames',
    init: async () => log('init'),
    ad: { requestAd: (type, cb) => { log('ad.' + type); setTimeout(() => { cb.adStarted?.(); setTimeout(() => cb.adFinished?.(), 300); }, 50); } },
    game: { gameplayStart: g('gameplayStart'), gameplayStop: g('gameplayStop'), loadingStart: g('loadingStart'), loadingStop: g('loadingStop'),
      happytime: g('happytime'), inviteLink: (p) => { log('game.inviteLink', p); return 'https://www.crazygames.com/game/x?room=' + (p.room ?? ''); },
      getInviteParam: () => null, showInviteButton: g('showInviteButton'), hideInviteButton: g('hideInviteButton'),
      settings: { muteAudio: false, disableChat: false }, addSettingsChangeListener: g('addSettingsChangeListener'),
      isInstantMultiplayer: false, inviteParams: null, updateRoom: g('updateRoom'), leftRoom: g('leftRoom'), addJoinRoomListener: g('addJoinRoomListener') },
    user: { getUser: async () => null, addAuthListener: g('addAuthListener') },
  } };
})();`;

const report = { date: new Date().toISOString(), dir, cpu, playSeconds, scenarios: {} };
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });

for (const backend of scenarios) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const r = { backend, errors: [], warnings: [], timeline: [], requests: { supabase: 0, failed: 0 } };
  report.scenarios[backend] = r;
  const t0 = Date.now();
  const mark = (what, extra) => {
    r.timeline.push({ t: +((Date.now() - t0) / 1000).toFixed(1), what, ...(extra ?? {}) });
    console.log(`  [${backend}] ${((Date.now() - t0) / 1000).toFixed(1)} s ${what}${extra ? ' ' + JSON.stringify(extra) : ''}`);
  };
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') r.errors.push(t.slice(0, 300));
    else if (m.type() === 'warning') r.warnings.push(t.slice(0, 300));
  });
  page.on('pageerror', (e) => r.errors.push('PAGEERROR ' + String(e).slice(0, 300)));
  await ctx.route('https://sdk.crazygames.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: SDK_STUB }));
  await ctx.route(/supabase\.co/, async (route) => {
    r.requests.supabase++;
    if (backend === 'refuse') return route.abort('connectionrefused');
    if (backend === 'slow') {
      await new Promise((res) => setTimeout(res, 3000));
      return route.fulfill({ status: 503, body: '{"message":"unavailable"}', contentType: 'application/json' }).catch(() => {});
    }
    // hang: never answer (abort after 5 min so the browser can close)
    await new Promise((res) => setTimeout(res, 300000));
    return route.abort('timedout').catch(() => {});
  });
  // Anything else external (fonts, analytics): refuse, as a sandboxed QA box would not.
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)(?!sdk\.crazygames)(?!.*supabase\.co)/, (route) => route.abort('connectionrefused'));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });

  await page.goto(`${base}/host.html`);
  mark('host page loaded');
  const frame = async () => {
    for (let i = 0; i < 100; i++) {
      const f = page.frames().find((x) => x.url().includes('/game/index.html'));
      if (f) return f;
      await page.waitForTimeout(100);
    }
    throw new Error('no game frame');
  };
  const f = await frame();
  // A person's click: mouse at the element's centre (no actionability waits, so a pulsing CTA or a
  // slow frame does not block it). The iframe fills the host page, so frame coordinates = page coordinates.
  const realClick = async (sel) => {
    const b = await f.locator(sel).first().boundingBox({ timeout: 10000 });
    if (!b) throw new Error('no box for ' + sel);
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  };
  const shot = (name) => page.screenshot({ path: `${out}/${backend}-${name}.jpg`, type: 'jpeg', quality: 70 });
  // What is on screen as time passes (boot screen / room browser / lobby).
  const state = () =>
    f.evaluate(() => ({
      boot: !!document.querySelector('#ge-boot:not(.done), .ge-boot:not(.done)') && getComputedStyle(document.querySelector('#ge-boot, .ge-boot')).display !== 'none',
      bootText: (document.querySelector('#ge-boot, .ge-boot')?.innerText ?? '').slice(0, 80),
      hub: !!document.querySelector('#ge-hub'),
      hubStatus: document.querySelector('#ge-hub .live .txt')?.textContent ?? null,
      lobby: !!document.querySelector('#arena .lobby'),
      start: (() => { const b = document.querySelector('#arena [data-a="start"]'); return b ? { disabled: b.disabled, text: b.innerText.slice(0, 40) } : null; })(),
      arena: !!window.__ARENA__,
      phase: window.__ARENA__?.summary?.().phase ?? null,
      cg: (window.__cg ?? []).map((c) => c[0]),
    }));
  let s;
  let hubClicked = false;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1000);
    s = await state().catch((e) => ({ err: String(e).slice(0, 100) }));
    if (i === 2 || i === 7 || i === 14) await shot(`boot-${i + 1}s`);
    if (s.hub && !hubClicked) {
      mark('room browser shown', { status: s.hubStatus });
      await shot('hub');
      await realClick('#ge-hub [data-a="quick"]').then(() => mark('clicked Quick play vs AI'), (e) => mark('quick click failed', { e: String(e).slice(0, 120) }));
      hubClicked = true;
      continue;
    }
    if (s.start && !s.start.disabled) break;
  }
  mark('ready to start', s);
  await shot('lobby');
  r.loadState = s;
  if (!(s.start && !s.start.disabled)) {
    mark('STUCK: start button never became available');
    await ctx.close();
    continue;
  }
  // How often the lobby DOM is rebuilt while idle (a rebuild between mousedown and mouseup eats a click).
  r.lobbyRebuildsPer10s = await f.evaluate(async () => {
    let n = 0;
    const mo = new MutationObserver((l) => { for (const m of l) if (m.type === 'childList' && m.target.classList?.contains('lobby')) n++; });
    mo.observe(document.querySelector('#arena .lobby'), { childList: true });
    await new Promise((r) => setTimeout(r, 10000));
    mo.disconnect();
    return n;
  });
  mark('lobby rebuilds in 10 s idle', { n: r.lobbyRebuildsPer10s });
  r.phaseBeforeStart = await f.evaluate(() => window.__ARENA__.summary().phase);
  mark('phase before clicking Start', { phase: r.phaseBeforeStart });
  for (let i = 0; r.phaseBeforeStart === 'lobby'; i++) {
    try {
      await realClick('#arena [data-a="start"]');
      break;
    } catch (e) {
      if (i > 5) throw e;
      mark('start button vanished mid-click, retrying');
    }
  }
  mark('clicked Start');
  // Frame rate + countdown progress (tells a stuck countdown from a slow software renderer).
  r.countdownProbe = await f.evaluate(async () => {
    let n = 0;
    let on = true;
    const loop = () => { n++; if (on) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    const g0 = window.__ARENA__.game();
    const c0 = g0?.countdown ?? null;
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, 8000));
    on = false;
    const g = window.__ARENA__.game();
    return { fps: +(n / ((performance.now() - t0) / 1000)).toFixed(2), countdownFrom: c0, countdownTo: g?.countdown ?? null, phase: window.__ARENA__.summary().phase, quality: document.querySelector('canvas')?.width + 'x' + document.querySelector('canvas')?.height };
  });
  mark('countdown probe', r.countdownProbe);
  let phase = null;
  for (let i = 0; i < 240 && phase !== 'playing'; i++) {
    await page.waitForTimeout(500);
    phase = await f.evaluate(() => window.__ARENA__?.summary().phase).catch(() => null);
  }
  mark('phase', { phase });
  if (phase !== 'playing') {
    await shot('not-playing');
    await ctx.close();
    continue;
  }
  // Frame pacing + long tasks while playing (keyboard input through the real listeners).
  await f.evaluate(() => {
    window.__fr = [];
    const loop = (t) => { window.__fr.push(t); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    window.__lt = [];
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: false }); } catch {}
  });
  await page.mouse.click(640, 360);
  const keys = ['w', 'a', 'd'];
  const heap0 = await f.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
  for (let t = 0; t < playSeconds; t += 2) {
    await page.keyboard.down('w');
    const k = keys[(t / 2) % 3 | 0];
    if (k !== 'w') await page.keyboard.down(k);
    if (t % 6 === 0) await page.keyboard.press('Space');
    await page.waitForTimeout(2000);
    if (k !== 'w') await page.keyboard.up(k);
    if (t === 20) await shot('play-20s');
  }
  await page.keyboard.up('w');
  await shot('play-end');
  const perf = await f.evaluate(() => {
    const fr = window.__fr;
    const d = fr.slice(1).map((t, i) => t - fr[i]).sort((a, b) => a - b);
    const q = (p) => +(d[Math.min(d.length - 1, Math.floor(d.length * p))] ?? 0).toFixed(1);
    const s = window.__ARENA__.summary();
    const me = s.actors.find((a) => a.id === s.me);
    return { frames: fr.length, fps: +(fr.length / ((fr.at(-1) - fr[0]) / 1000)).toFixed(1), p50: q(0.5), p95: q(0.95), max: q(1), longTasks: window.__lt.length, longTaskMax: Math.max(0, ...window.__lt), heap: performance.memory?.usedJSHeapSize ?? 0, phase: s.phase, t: s.t, me: me ? { mass: me.mass, alive: me.alive } : null, quality: localStorage.getItem('grow-quality') };
  });
  perf.heapGrowthMB = +((perf.heap - heap0) / 1048576).toFixed(1);
  r.play = perf;
  mark('played', perf);
  // Tab hidden → visible (CrazyGames QA switches tabs); then the in-game cg log.
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); });
  await f.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(3000);
  await f.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(2000);
  r.afterHide = await f.evaluate(() => window.__ARENA__.summary().phase);
  // WebGL context loss and restore.
  const lost = await f.evaluate(async () => {
    const c = document.querySelector('canvas');
    const ext = (c.getContext('webgl2') || c.getContext('webgl'))?.getExtension('WEBGL_lose_context');
    if (!ext) return 'no extension';
    ext.loseContext();
    await new Promise((r) => setTimeout(r, 1500));
    ext.restoreContext();
    await new Promise((r) => setTimeout(r, 3000));
    return 'restored';
  });
  await shot('after-context-restore');
  r.contextLoss = { lost, phase: await f.evaluate(() => window.__ARENA__.summary().phase) };
  r.cg = await f.evaluate(() => window.__cg ?? []);
  mark('done', { afterHide: r.afterHide, contextLoss: r.contextLoss });
  await ctx.close();
}
await browser.close();
server.close();
writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 1));
for (const [k, v] of Object.entries(report.scenarios)) {
  console.log(`\n== ${k}: errors ${v.errors.length}, warnings ${v.warnings.length}, supabase requests ${v.requests.supabase}`);
  for (const e of [...new Set(v.errors)].slice(0, 12)) console.log('   ERR ' + e);
  for (const e of [...new Set(v.warnings)].slice(0, 8)) console.log('   WARN ' + e);
}
