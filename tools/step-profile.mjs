#!/usr/bin/env node
// GROW EVERYTHING — simulation-step hitch probe (CPU side of "it stutters when I eat").
// Plays an autopilot arena round per city in deterministic test mode, one fixed tick at a time,
// and records every tick's wall time together with how many objects were absorbed in it:
// tick-time distribution (p50 / p95 / p99 / max), ticks with an absorb vs without, the worst
// ticks, a CPU profile's top self-time functions, and shader programs created after the first
// rendered frame (a program created mid-round is a shader compile hitch).
//
// Usage: node tools/step-profile.mjs [--cities shanghai,newyork,paris,scrap] [--seconds 120] [--seed 3]
//                                    [--renders 6] [--profile 1] [--out file.json]
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const cities = String(arg('--cities', 'shanghai,newyork,paris,scrap')).split(',');
const seconds = Number(arg('--seconds', 120));
const seed = Number(arg('--seed', 3));
const renders = Number(arg('--renders', 6));
const profile = arg('--profile', '1') !== '0';
const outFile = arg('--out', null);

const server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 5241, strictPort: false, hmr: false, watch: null } });
await server.listen();
const base = server.resolvedUrls.local[0];
const executablePath = existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch({ executablePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-precise-memory-info'] });

const stat = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  return { n: s.length, mean: +(s.reduce((a, b) => a + b, 0) / (s.length || 1)).toFixed(3), p50: +q(0.5).toFixed(3), p95: +q(0.95).toFixed(3), p99: +q(0.99).toFixed(3), max: +(s[s.length - 1] ?? 0).toFixed(3) };
};

const out = { date: new Date().toISOString(), seconds, seed, cities: {} };
try {
  for (const city of cities) {
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}game/?mode=arena&net=solo&test=1&quality=low&name=Probe&lang=en&seed=${seed}`);
    await page.waitForFunction(() => window.__ARENA__?.ready, null, { timeout: 180_000 });
    await page.evaluate(async ({ city }) => {
      const A = window.__ARENA__;
      A.session.setCity(city);
      A.session.setBots(true);
      A.session.setJoined(true);
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
      A.render(); // first frame: compiles everything visible at round start
    }, { city });
    const cdp = await page.context().newCDPSession(page);
    const alloc = process.argv.includes('--alloc');
    if (alloc) {
      await cdp.send('HeapProfiler.enable');
      await cdp.send('HeapProfiler.startSampling', { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    }
    if (profile) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
      await cdp.send('Profiler.start');
    }
    const r = await page.evaluate(async ({ seconds, renders }) => {
      const A = window.__ARENA__;
      const g = A.game();
      const R = window.__GROW_RENDERER__;
      const dt = 1 / 60;
      const ticks = Math.round(seconds / dt);
      const renderEvery = Math.max(1, Math.floor(ticks / Math.max(1, renders)));
      const objectsOf = () => g.actors.reduce((s, a) => s + a.objects, 0);
      // Per-tick time by subsystem (instance-level wrappers; the game code is untouched).
      const parts = {};
      const wrap = (obj, name, label = name) => {
        const fn = obj[name];
        if (typeof fn !== 'function') return;
        obj[name] = function (...args) {
          const t = performance.now();
          try {
            return fn.apply(this, args);
          } finally {
            parts[label] = (parts[label] ?? 0) + performance.now() - t;
          }
        };
      };
      for (const m of ['collideObjects', 'proposeCollection', 'proposeEats', 'updatePulls', 'absorb', 'setMass', 'bumpActors', 'updateSun']) wrap(g, m);
      for (const m of ['updateFalling', 'syncInstances', 'applyEligibility', 'releaseDependents']) wrap(g.world, m, `world.${m}`);
      wrap(g.effects, 'update', 'effects.update');
      wrap(g.hud, 'update', 'hud.update');
      wrap(A.session, 'update', 'session.update');
      for (const a of g.actors) if (a.bot) wrap(a.bot, 'intents', 'bot.intents');
      let absorbs = 0;
      const absorbFn = g.absorb;
      g.absorb = function (...args) {
        absorbs++;
        return absorbFn.apply(this, args);
      };
      const breakdown = [];
      const ch = new MessageChannel();
      const yieldTask = () => new Promise((res) => ((ch.port1.onmessage = () => res()), ch.port2.postMessage(0)));
      let allocated = 0; // bytes the heap grew by across ticks without a collection
      let gcs = 0; // ticks during which the heap shrank (a GC ran inside the tick)
      const programs0 = R?.info.programs?.length ?? 0;
      const tick = [];
      const eat = [];
      const programLog = [];
      for (let i = 0; i < ticks; i++) {
        for (const k in parts) parts[k] = 0;
        absorbs = 0;
        const h0 = performance.memory?.usedJSHeapSize ?? 0;
        const t = performance.now();
        A.step(dt);
        const ms = performance.now() - t;
        const h1 = performance.memory?.usedJSHeapSize ?? 0;
        if (h1 >= h0) allocated += h1 - h0;
        else gcs++;
        tick.push(ms);
        eat.push(absorbs);
        // The solo transport delivers host grants asynchronously: yield so claims are granted.
        await yieldTask();
        if (ms > 12) breakdown.push({ tick: i, t: +g.matchTime.toFixed(2), ms: +ms.toFixed(1), absorbs, gc: h1 < h0, parts: Object.fromEntries(Object.entries(parts).filter(([, v]) => v > 0.5).map(([k, v]) => [k, +v.toFixed(1)])) });
        if (i % renderEvery === renderEvery - 1) {
          A.render();
          const p = R?.info.programs?.length ?? 0;
          if (p !== (programLog.at(-1)?.programs ?? programs0)) programLog.push({ t: +g.matchTime.toFixed(1), programs: p, names: R.info.programs.slice(programLog.at(-1)?.programs ?? programs0).map((x) => x.name) });
          await new Promise((res) => setTimeout(res, 0));
        }
      }
      return { tick, eat, objects: g.world.objects.length, eaten: objectsOf(), programs0, programLog, matchTime: g.matchTime, allocKBPerTick: +(allocated / 1024 / Math.max(1, ticks - gcs)).toFixed(1), gcTicks: gcs, breakdown: breakdown.sort((x, y) => y.ms - x.ms).slice(0, 12) };
    }, { seconds, renders });
    const withEat = r.tick.filter((_, i) => r.eat[i] > 0);
    const without = r.tick.filter((_, i) => r.eat[i] === 0);
    const worst = r.tick
      .map((ms, i) => ({ ms: +ms.toFixed(2), tick: i, eats: r.eat[i] }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 8);
    const res = { allocKBPerTick: r.allocKBPerTick, gcTicks: r.gcTicks, breakdown: r.breakdown, objects: r.objects, eaten: r.eaten, ticks: stat(r.tick), ticksWithAbsorb: stat(withEat), ticksWithoutAbsorb: stat(without), worst, programsAtStart: r.programs0, programsCreatedMidRound: r.programLog, errors };
    if (alloc) {
      const { profile: hp } = await cdp.send('HeapProfiler.stopSampling');
      const sites = new Map();
      const walk = (n, stack) => {
        const f = n.callFrame;
        const here = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
        const st = [here, ...stack].slice(0, 3);
        if (n.selfSize) sites.set(st.join(' < '), (sites.get(st.join(' < ')) ?? 0) + n.selfSize);
        for (const c of n.children) walk(c, st);
      };
      walk(hp.head, []);
      const tot = [...sites.values()].reduce((a, b) => a + b, 0);
      res.allocSites = [...sites.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, b]) => `${((b / tot) * 100).toFixed(1)}% ${k}`);
      console.log(`  alloc sites:\n    ${res.allocSites.join('\n    ')}`);
    }
    if (profile) {
      const { profile: p } = await cdp.send('Profiler.stop');
      const self = new Map();
      const dts = p.timeDeltas;
      const byId = new Map(p.nodes.map((n) => [n.id, n]));
      p.samples.forEach((id, i) => {
        const n = byId.get(id);
        const f = n.callFrame;
        const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
        self.set(key, (self.get(key) ?? 0) + (dts[i] ?? 0));
      });
      const total = [...self.values()].reduce((a, b) => a + b, 0);
      res.topSelf = [...self.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 14)
        .map(([k, us]) => `${((us / total) * 100).toFixed(1)}% ${k}`);
    }
    out.cities[city] = res;
    console.log(`${city}: ${r.objects} objects, ${r.eaten} eaten · tick p50 ${res.ticks.p50} p99 ${res.ticks.p99} max ${res.ticks.max} ms · absorb ticks p50 ${res.ticksWithAbsorb.p50} p95 ${res.ticksWithAbsorb.p95} max ${res.ticksWithAbsorb.max} · no-absorb p50 ${res.ticksWithoutAbsorb.p50} p95 ${res.ticksWithoutAbsorb.p95} · new programs mid-round ${JSON.stringify(r.programLog)}`);
    for (const b of r.breakdown.slice(0, 5)) console.log(`  slow tick t=${b.t}s ${b.ms}ms absorbs=${b.absorbs}${b.gc ? ' GC' : ''} ${JSON.stringify(b.parts)}`);
    console.log(`  heap growth ${r.allocKBPerTick} KB/tick · ticks with a GC inside: ${r.gcTicks}`);
    console.log(`  worst: ${worst.map((w) => `${w.ms}ms(eats ${w.eats})`).join(', ')}`);
    if (res.topSelf) console.log(`  top self: ${res.topSelf.slice(0, 10).join(' | ')}`);
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
if (outFile) await writeFile(outFile, JSON.stringify(out, null, 1));
