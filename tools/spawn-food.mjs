#!/usr/bin/env node
// GROW EVERYTHING — food around each arena spawn, per city (level-design density audit).
// Spawns every city's arena world in test mode and sums the reward mass of the objects within
// 10 / 20 / 35 m of each spawn, split by size class — the food a machine can reach in its first
// minute. Cities should offer comparable early food, or one city's pacing runs away.
// Usage: node tools/spawn-food.mjs [--cities shanghai,newyork,paris,scrap]
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const cities = String(arg('--cities', 'shanghai,newyork,paris,scrap')).split(',');

const server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 5251, strictPort: false, hmr: false, watch: null } });
await server.listen();
const base = server.resolvedUrls.local[0];
const executablePath = existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch({ executablePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  await page.goto(`${base}game/?mode=arena&net=solo&test=1&quality=low&name=Audit&lang=en`);
  await page.waitForFunction(() => window.__ARENA__?.ready, null, { timeout: 180_000 });
  for (const city of cities) {
    const rows = await page.evaluate(async (city) => {
      const A = window.__ARENA__;
      A.session.setCity(city);
      A.session.setBots(true);
      A.session.setJoined(true);
      A.session.start();
      await new Promise((res) => setTimeout(res, 0));
      const g = A.game();
      const out = [];
      for (const [i, sp] of g.city.spawns.entries()) {
        const row = { spawn: i, at: `${sp.x},${sp.z}` };
        for (const R of [10, 20, 35]) {
          const byCls = {};
          for (const o of g.world.objects) {
            if (o.def.climax || o.def.bonus || o.def.power) continue;
            if (Math.hypot(o.x - sp.x, o.z - sp.z) > R) continue;
            const c = o.def.objectClass <= 2 ? '0-2' : o.def.objectClass <= 4 ? '3-4' : '5+';
            byCls[c] = (byCls[c] ?? 0) + o.def.rewardMass;
          }
          row[`${R}m`] = Object.fromEntries(Object.entries(byCls).map(([k, v]) => [k, Math.round(v)]));
        }
        out.push(row);
      }
      const total = {};
      for (const o of g.world.objects) {
        if (o.def.climax) continue;
        const c = o.def.objectClass <= 2 ? '0-2' : o.def.objectClass <= 4 ? '3-4' : o.def.objectClass <= 6 ? '5-6' : '7+';
        total[c] = (total[c] ?? 0) + o.def.rewardMass;
      }
      A.session.toLobby();
      await new Promise((res) => setTimeout(res, 0));
      return { objects: g.world.objects.length, total: Object.fromEntries(Object.entries(total).map(([k, v]) => [k, Math.round(v)])), out };
    }, city);
    console.log(`${city}: ${rows.objects} objects · whole map by class ${JSON.stringify(rows.total)}`);
    for (const r of rows.out) console.log(`  spawn ${r.spawn} (${r.at}): ≤10 m ${JSON.stringify(r['10m'])} · ≤20 m ${JSON.stringify(r['20m'])} · ≤35 m ${JSON.stringify(r['35m'])}`);
  }
} finally {
  await browser.close();
  await server.close();
}
