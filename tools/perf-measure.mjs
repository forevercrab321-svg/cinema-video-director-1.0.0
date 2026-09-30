#!/usr/bin/env node
// Render-budget baseline for the arena, per quality tier, on the PRODUCTION build (dist-web).
//   npm run build:web && node tools/perf-measure.mjs [--dist dist-web] [--out perf.json] [--seconds 20] [--tiers high,medium,low] [--rounds 3]
// Per tier: time to first frame (live loop), renderer.info (calls / triangles / geometries /
// textures / programs), JS heap, CPU step time and synced render time over an autopilot arena
// round, plus heap + GPU-resource growth across round restarts (leak check).
// Headless Chromium rasterises WebGL in software (SwiftShader): frame times are RELATIVE
// evidence only (compare before/after on the same machine), never absolute FPS.
import { chromium } from 'playwright';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { preview } from 'vite';

const root = resolve(import.meta.dirname, '..');
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const outFile = arg('--out', null);
const seconds = Number(arg('--seconds', 20));
const tiers = arg('--tiers', 'high,medium,low').split(',');
const rounds = Number(arg('--rounds', 3));
// Software GL renders a frame in seconds: simulate every 1/15 s but draw only every `renderEvery` s.
const renderEvery = Number(arg('--render-every', 2));
const viewport = { width: 960, height: 540 };

const dist = resolve(arg('--dist', resolve(root, 'dist-web')));
if (!existsSync(resolve(dist, 'game/index.html'))) throw new Error('dist-web missing: run npm run build:web first');

// ── Bundle ───────────────────────────────────────────────────────────────────
const bundle = { chunks: [], totalJs: 0, totalJsGzip: 0 };
for (const f of readdirSync(resolve(dist, 'assets'))) {
  const buf = readFileSync(resolve(dist, 'assets', f));
  const gz = gzipSync(buf, { level: 9 }).length;
  bundle.chunks.push({ file: f, bytes: buf.length, gzip: gz });
  if (f.endsWith('.js')) {
    bundle.totalJs += buf.length;
    bundle.totalJsGzip += gz;
  }
}
bundle.chunks.sort((a, b) => b.bytes - a.bytes);
const hdr = resolve(dist, 'hdri');
bundle.hdri = existsSync(hdr) ? Object.fromEntries(readdirSync(hdr).filter((f) => /\.(hdr|webp|png)$/.test(f)).map((f) => [f, statSync(resolve(hdr, f)).size])) : {};

const server = await preview({ configFile: resolve(root, 'vite.web.config.mjs'), logLevel: 'error', build: { outDir: dist }, preview: { host: '127.0.0.1', port: 5197, strictPort: false } });
const base = server.resolvedUrls.local[0];
const executablePath = existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch({ executablePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-precise-memory-info', '--js-flags=--expose-gc'] });

const stat = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2), p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +s[s.length - 1].toFixed(2) };
};

const result = { date: new Date().toISOString(), viewport, seconds, renderEvery, renderer: 'swiftshader (software; frame times relative only)', bundle, tiers: {} };
try {
  for (const quality of tiers) {
    const r = {};
    // ── Time to first frame (live loop, no test hooks) ──────────────────────
    {
      const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${base}game/?mode=arena&net=solo&seed=1&quality=${quality}&name=Perf&lang=en`);
      await page.waitForFunction(() => performance.getEntriesByName('grow:first-frame').length > 0, null, { timeout: 180_000, polling: 100 });
      r.firstFrameMs = await page.evaluate(() => Math.round(performance.getEntriesByName('grow:first-frame')[0].startTime));
      r.bootMs = await page.evaluate(() => Math.round(performance.getEntriesByName('grow:boot')[0]?.startTime ?? -1));
      r.liveErrors = errors;
      await page.close();
    }
    // ── Arena round via the harness ─────────────────────────────────────────
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    const cdp = await page.context().newCDPSession(page);
    const heap = async () => {
      await cdp.send('HeapProfiler.collectGarbage');
      return +((await cdp.send('Runtime.getHeapUsage')).usedSize / 1048576).toFixed(1);
    };
    await page.goto(`${base}game/?mode=arena&net=solo&test=1&seed=1&quality=${quality}&name=Perf&lang=en`);
    await page.waitForFunction(() => window.__ARENA__?.ready && window.__GROW_RENDERER__, null, { timeout: 180_000 });
    const info = () =>
      page.evaluate(() => {
        const i = window.__GROW_RENDERER__.info;
        return { calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures, programs: i.programs?.length ?? 0 };
      });
    const startRound = () =>
      page.evaluate(async () => {
        const A = window.__ARENA__;
        A.session.start();
        for (let i = 0; i < 6; i++) {
          A.step(0.05);
          await new Promise((res) => setTimeout(res, 0));
        }
        A.autopilot(true);
        const g = A.game();
        while (g && g.phase === 'countdown') {
          A.step(0.25);
          await new Promise((res) => setTimeout(res, 0));
        }
        return !!A.game();
      });
    r.heapLobbyMB = await heap();
    if (!(await startRound())) throw new Error(`${quality}: round did not start`);
    // Warm-up frames (shader compile, shadow map allocation) are not steady-state evidence.
    const warm = await page.evaluate(() => {
      const t0 = performance.now();
      window.__ARENA__.render();
      const gl = window.__GROW_RENDERER__.getContext();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      for (let i = 0; i < 4; i++) window.__ARENA__.render();
      return performance.now() - t0;
    });
    r.firstRoundFrameMs = Math.round(warm);
    const samples = await page.evaluate(async ({ seconds, renderEvery }) => {
      const A = window.__ARENA__;
      const gl = window.__GROW_RENDERER__.getContext();
      const px = new Uint8Array(4);
      const step = [];
      const render = [];
      const info = [];
      const frames = Math.round(seconds * 15);
      const every = Math.max(1, Math.round(renderEvery * 15));
      for (let f = 0; f < frames; f++) {
        let t = performance.now();
        A.step(1 / 15);
        step.push(performance.now() - t);
        if (f % every !== every - 1) continue;
        await new Promise((res) => setTimeout(res, 0));
        t = performance.now();
        A.render();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // sync: include GPU (software) time
        render.push(performance.now() - t);
        const i = window.__GROW_RENDERER__.info.render;
        info.push([i.calls, i.triangles]);
      }
      const me = A.summary().actors.find((a) => a.kind === 'local');
      return { step, render, info, mass: me?.mass ?? null, t: A.game()?.matchTime ?? 0 };
    }, { seconds, renderEvery });
    r.stepMs = stat(samples.step);
    r.renderMs = stat(samples.render);
    r.calls = stat(samples.info.map((x) => x[0]));
    r.triangles = stat(samples.info.map((x) => x[1]));
    r.localMassAtEnd = samples.mass;
    r.matchTime = +samples.t.toFixed(1);
    r.infoEndOfRound = await info();
    r.heapRound1MB = await heap();
    // ── Restart leak check: back to lobby, new round, a few seconds, repeat ──
    r.restarts = [];
    for (let k = 0; k < rounds; k++) {
      await page.evaluate(async () => {
        const A = window.__ARENA__;
        A.session.toLobby();
        for (let i = 0; i < 4; i++) {
          A.step(0.05);
          await new Promise((res) => setTimeout(res, 0));
        }
      });
      if (!(await startRound())) throw new Error(`${quality}: restart ${k} did not start`);
      await page.evaluate(() => {
        for (let i = 0; i < 30; i++) window.__ARENA__.step(1 / 15);
        window.__ARENA__.render();
      });
      r.restarts.push({ heapMB: await heap(), ...(await info()) });
    }
    r.errors = errors;
    await page.close();
    result.tiers[quality] = r;
    console.log(`${quality}: ttff ${r.firstFrameMs} ms · calls p50 ${r.calls.p50} · tris p50 ${r.triangles.p50} · render p50 ${r.renderMs.p50} ms · step p50 ${r.stepMs.p50} ms · heap ${r.heapRound1MB} MB → ${r.restarts.map((x) => x.heapMB).join(' → ')} · tex ${r.infoEndOfRound.textures} → ${r.restarts.map((x) => x.textures).join(' → ')} · geo ${r.infoEndOfRound.geometries} → ${r.restarts.map((x) => x.geometries).join(' → ')} · errors ${errors.length}`);
  }
} finally {
  await browser.close();
  await new Promise((res) => server.httpServer.close(res));
}
console.log(`bundle: ${(bundle.totalJs / 1024).toFixed(0)} kB JS (${(bundle.totalJsGzip / 1024).toFixed(0)} kB gzip) · ${bundle.chunks
  .filter((c) => c.file.endsWith('.js'))
  .slice(0, 6)
  .map((c) => `${c.file} ${(c.gzip / 1024).toFixed(0)}k`)
  .join(', ')}`);
if (outFile) writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n');
