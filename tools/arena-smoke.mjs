#!/usr/bin/env node
// Arena smoke test (develop-web-game loop: act → pause → observe). Loads the game, starts a solo
// arena round through the window.__ARENA__ harness, drives it with REAL keyboard input bursts
// (W / arrows to steer, SPACE to dash) in deterministic game-time steps, and asserts:
//   no console/page errors · non-blank canvas (pixel variance) · round reaches "playing" ·
//   W moves the machine · SPACE triggers a dash · MASS grows · a restart does not leak GPU
//   textures or geometries.
// Screenshots: <shots>/smoke-<tier>-<step>.png ; report: <shots>/smoke-report.json
//   npm run smoke                                   (dev server, low tier)
//   node tools/arena-smoke.mjs --tiers low,high     (several tiers)
//   node tools/arena-smoke.mjs --url http://127.0.0.1:4173/game/   (an already running build)
//   node tools/arena-smoke.mjs --dist dist-web      (serve a production build)
// Exit code 1 on any failed assertion. Headless Chromium uses SwiftShader (software GL): slow
// but pixel-correct; the assertions are on game time, so they hold at any frame rate.
import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';

const root = resolve(import.meta.dirname, '..');
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const tiers = arg('--tiers', 'low').split(',');
const shots = resolve(arg('--shots', process.env.SMOKE_SHOTS ?? resolve(root, 'renders/review/smoke')));
const city = arg('--city', 'shanghai');
const viewport = { width: Number(arg('--width', 960)), height: Number(arg('--height', 540)) };
mkdirSync(shots, { recursive: true });

// ── Server: an explicit URL, a production build (vite preview), or the dev server ──
let base = arg('--url', null);
let close = async () => {};
if (!base) {
  const vite = await import('vite');
  const dist = arg('--dist', null);
  if (dist) {
    const server = await vite.preview({ configFile: resolve(root, 'vite.web.config.mjs'), logLevel: 'error', build: { outDir: resolve(dist) }, preview: { host: '127.0.0.1', port: 5196, strictPort: false } });
    base = `${server.resolvedUrls.local[0]}game/`;
    close = () => new Promise((res) => server.httpServer.close(res));
  } else {
    const server = await vite.createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 5196, strictPort: false, hmr: false } });
    await server.listen();
    base = `${server.resolvedUrls.local[0]}game/`;
    close = () => server.close();
  }
}

const executablePath = existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch({ executablePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const report = { date: new Date().toISOString(), base, viewport, city, tiers: {}, assertions: [] };
const check = (tier, name, pass, detail) => {
  report.assertions.push({ tier, name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${tier}] ${name} — ${detail}`);
};

/** Pixel statistics of a PNG: luminance standard deviation and number of distinct coarse colours. */
function pixelStats(buf) {
  const png = PNG.sync.read(buf);
  const { data } = png;
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  const colours = new Set();
  for (let i = 0; i < data.length; i += 4 * 7) {
    const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    sum += l;
    sum2 += l * l;
    n++;
    colours.add(((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4));
  }
  const mean = sum / n;
  return { mean: +mean.toFixed(1), std: +Math.sqrt(Math.max(0, sum2 / n - mean * mean)).toFixed(1), colours: colours.size };
}

try {
  for (const tier of tiers) {
    const errors = [];
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
    const t = { tier };
    /** Page screenshot (with HUD) for humans; pixel stats from the WebGL canvas alone (no DOM overlays). */
    const canvasShot = async (name) => {
      const dataUrl = await page.evaluate(() => {
        window.__ARENA__.render();
        return document.querySelector('canvas').toDataURL('image/png'); // test mode preserves the drawing buffer
      });
      writeFileSync(resolve(shots, `smoke-${tier}-${name}.png`), await page.screenshot());
      return pixelStats(Buffer.from(dataUrl.split(',')[1], 'base64'));
    };
    const local = () => page.evaluate(() => {
      const a = window.__ARENA__.game()?.local;
      return a ? { x: a.x, z: a.z, mass: a.mass, alive: a.alive, dashTime: a.dashTime, dashCooldown: a.dashCooldown } : null;
    });
    const gpu = () => page.evaluate(() => {
      const i = window.__GROW_RENDERER__?.info;
      return i ? { textures: i.memory.textures, geometries: i.memory.geometries } : null;
    });
    /** Advance game time in small deterministic steps (the harness has no RAF loop in test mode). */
    const step = (seconds, dt = 1 / 30) =>
      page.evaluate(
        async ({ seconds, dt }) => {
          for (let s = 0; s < seconds - 1e-6; s += dt) window.__ARENA__.step(dt);
          await new Promise((r) => setTimeout(r, 0));
        },
        { seconds, dt },
      );
    /** Start a round and wait out the countdown (the match message is delivered asynchronously). */
    const startRound = () =>
      page.evaluate(async () => {
        const A = window.__ARENA__;
        A.autopilot(false);
        A.session.start();
        const until = performance.now() + 60_000;
        while ((!A.game() || A.game().phase === 'countdown') && performance.now() < until) {
          A.step(0.1);
          await new Promise((r) => setTimeout(r, 10));
        }
        return A.game()?.phase ?? 'none';
      });

    const t0 = Date.now();
    await page.goto(`${base}?mode=arena&net=solo&test=1&seed=1&quality=${tier}&name=Smoke&lang=en`);
    await page.waitForFunction(() => window.__ARENA__?.ready, null, { timeout: 240_000 });
    t.loadMs = Date.now() - t0;
    await page.evaluate((city) => window.__ARENA__.session.setCity(city), city);
    await step(0.2);
    const lobby = await canvasShot('0-lobby');
    check(tier, 'lobby canvas is not blank', lobby.std > 8 && lobby.colours > 24, JSON.stringify(lobby));

    const phase = await startRound();
    check(tier, 'round starts and reaches "playing"', phase === 'playing', `phase ${phase}`);
    const s0 = await local();
    check(tier, 'local machine spawned', !!s0?.alive, JSON.stringify(s0));
    const gpu0 = await gpu();
    await canvasShot('1-spawn');

    // Burst 1: drive forward (W) for 2 s of game time.
    await page.keyboard.down('KeyW');
    await step(2);
    const s1 = await local();
    const moved = Math.hypot(s1.x - s0.x, s1.z - s0.z);
    check(tier, 'W moves the machine', moved > 1, `${moved.toFixed(2)} m in 2 s`);

    // Burst 2: SPACE dash while driving.
    await page.keyboard.press('Space');
    await step(1 / 15);
    const s2 = await local();
    check(tier, 'SPACE triggers a dash', s2.dashTime > 0 || s2.dashCooldown > 0, `dashTime ${s2.dashTime.toFixed(2)} · cooldown ${s2.dashCooldown.toFixed(2)}`);
    const dash = await canvasShot('2-dash');

    // Bursts 3…: sweep the starter scrap ring — forward with alternating arrow turns.
    for (const [key, secs] of [['ArrowLeft', 1.2], [null, 1.5], ['ArrowRight', 2.0], [null, 1.5], ['ArrowLeft', 2.5], [null, 2], ['ArrowRight', 1.5], [null, 2]]) {
      if (key) await page.keyboard.down(key);
      await step(secs);
      if (key) await page.keyboard.up(key);
      if ((await local()).mass > s0.mass * 1.2) break;
    }
    await page.keyboard.press('Space');
    await step(3);
    await page.keyboard.up('KeyW');
    await step(0.5);
    const s3 = await local();
    check(tier, 'MASS grows from eating', s3.mass > s0.mass, `${s0.mass.toFixed(1)} → ${s3.mass.toFixed(1)} kg`);
    const play = await canvasShot('3-play');
    check(tier, 'gameplay canvas is not blank', play.std > 8 && play.colours > 24, JSON.stringify(play));
    check(tier, 'dash frame is not blank', dash.std > 8 && dash.colours > 24, JSON.stringify(dash));

    // Restart twice: GPU resources must return to the same level (no per-round leaks).
    const levels = [];
    for (let k = 0; k < 2; k++) {
      await page.evaluate(() => window.__ARENA__.session.toLobby());
      await step(0.3);
      const ph = await startRound();
      if (ph !== 'playing') {
        check(tier, `restart ${k + 1} reaches "playing"`, false, `phase ${ph}`);
        break;
      }
      await step(1);
      await page.evaluate(() => window.__ARENA__.render());
      levels.push(await gpu());
    }
    await canvasShot('4-restart');
    if (gpu0 && levels.length === 2) {
      const dTex = levels[1].textures - levels[0].textures;
      const dGeo = levels[1].geometries - levels[0].geometries;
      check(tier, 'restart does not leak GPU textures/geometries', dTex <= 2 && dGeo <= 8, `round textures ${gpu0.textures} → ${levels.map((l) => l.textures).join(' → ')}, geometries ${gpu0.geometries} → ${levels.map((l) => l.geometries).join(' → ')}`);
    }
    check(tier, 'no console or page errors', errors.length === 0, errors.slice(0, 5).join(' | ') || 'none');
    Object.assign(t, { lobby, dash, play, start: s0, end: s3, moved, gpu: { round1: gpu0, restarts: levels }, errors });
    report.tiers[tier] = t;
    await page.close();
  }
} finally {
  await browser.close();
  await close();
}
writeFileSync(resolve(shots, 'smoke-report.json'), JSON.stringify(report, null, 2) + '\n');
const failed = report.assertions.filter((a) => !a.pass);
console.log(`\n${report.assertions.length - failed.length}/${report.assertions.length} passed · screenshots in ${shots}`);
process.exit(failed.length ? 1 : 0);
