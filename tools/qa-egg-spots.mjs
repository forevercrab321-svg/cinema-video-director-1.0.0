#!/usr/bin/env node
// QA: is every Egg Valley hiding spot reachable and wakeable? Plays N solo Halloween rounds (random
// seeds via Rematch), jumps to the chase, parks the local machine next to her the way a player
// would (1.5 m away, on each of 4 sides), honks, and records: spot, side used, distance after the
// physics step (pushed out of a wall?), whether she woke, and whether the local machine was alive.
//   node tools/qa-egg-spots.mjs [--rounds 12]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const rounds = Number(arg('--rounds', 12));
const out = resolve(root, 'renders/review/qa/egg');
mkdirSync(out, { recursive: true });
const vite = await import('vite');
const server = await vite.createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 5209, strictPort: false, hmr: false } });
await server.listen();
const base = `${server.resolvedUrls.local[0]}game/`;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
p.on('pageerror', (e) => errors.push(String(e)));
await p.goto(`${base}?mode=arena&net=solo&test=1&quality=low&lang=en&name=Egg`);
await p.waitForFunction(() => window.__ARENA__?.ready, null, { timeout: 180000 });
const step = (s) => p.evaluate((x) => window.__ARENA__.step(x), s);
const rows = [];
let fails = 0;
for (let r = 0; r < rounds; r++) {
  if (r === 0) await p.evaluate(() => { const S = window.__ARENA__.session; S.setCity('halloween'); S.start(); });
  else await p.evaluate(() => window.__ARENA__.session.rematch());
  for (let i = 0; i < 4; i++) await step(1);
  await p.evaluate(() => (window.__ARENA__.game().matchTime = 299.8));
  for (let i = 0; i < 14; i++) await step(0.5); // into the chase (+6 s)
  const sides = [[1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5]];
  const row = await p.evaluate(() => { const g = window.__ARENA__.game(); return { seed: g.seed, x: g.hunt.egg.x, z: g.hunt.egg.z, stage: g.hunt.stage(), bounds: g.city.bounds }; });
  row.tries = [];
  for (const [dx, dz] of sides) {
    const t = await p.evaluate(({ dx, dz }) => {
      const g = window.__ARENA__.game();
      const me = g.local;
      const h = g.hunt;
      for (const v of h.hunters) { v.x = 0; v.z = 0; } // keep the bosses away from this experiment
      if (!me) return { noLocal: true };
      const blocked = g.isBlocked(h.egg.x + dx, h.egg.z + dz, me.diameter * 0.5, 0, null);
      me.x = h.egg.x + dx; me.z = h.egg.z + dz; me.speed = 0; me.invulnerableUntil = 0;
      g.emote(6);
      return { alive: me.alive, caught: h.caught.has(me.id), blockedAtPark: blocked };
    }, { dx, dz });
    await step(1 / 30);
    const after = await p.evaluate(() => { const g = window.__ARENA__.game(); const me = g.local; return { d: +Math.hypot(me.x - g.hunt.egg.x, me.z - g.hunt.egg.z).toFixed(2), by: g.hunt.egg.by, me: me.id, reach: +(4 + me.diameter * 0.5).toFixed(2) }; });
    row.tries.push({ side: [dx, dz], ...t, ...after });
    if (after.by) break;
  }
  row.woke = row.tries.some((t) => t.by);
  row.firstSideWoke = !!row.tries[0].by;
  await p.evaluate(() => window.__ARENA__.render());
  await p.screenshot({ path: `${out}/egg-spot-${r}.jpg`, type: 'jpeg', quality: 70 });
  console.log(`${row.woke ? 'PASS' : 'FAIL'}  round ${r} seed ${row.seed} egg (${row.x.toFixed(1)}, ${row.z.toFixed(1)}) ${row.stage} tries ${JSON.stringify(row.tries.map((t) => [t.side.join(','), t.blockedAtPark ? 'blocked' : 'free', t.d, t.by ? 'woke' : '-', t.alive ? '' : 'DEAD']))}`);
  if (!row.woke) fails++;
  rows.push(row);
  await p.evaluate(() => { const g = window.__ARENA__.game(); g.matchTime = g.hunt.endsAt() - 0.2; });
  for (let i = 0; i < 6; i++) { const s = await step(0.5); if (s.phase === 'results') break; }
}
writeFileSync(`${out}/egg-spots.json`, JSON.stringify({ rows, errors }, null, 1));
console.log(`${rows.filter((r) => r.woke).length}/${rows.length} spots wakeable; first side worked in ${rows.filter((r) => r.firstSideWoke).length}; page errors ${errors.length}`);
await browser.close();
await server.close();
process.exit(fails || errors.length ? 1 : 0);
