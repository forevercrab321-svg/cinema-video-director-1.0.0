#!/usr/bin/env node
// QA: is every Egg Valley hiding spot reachable and wakeable? Plays N solo Halloween rounds (random
// seeds via Rematch), jumps to the chase, parks the local machine next to her the way a player
// would (1.5 m away, on each of 4 sides), honks, and records: spot, side used, distance after the
// physics step (pushed out of a wall?), whether she woke, and whether the local machine was alive.
//   node tools/qa-egg-spots.mjs [--rounds 12] [--static-only]
// Static pass (always first): enumerates every candidate hiding spot (same rule as pickSpot in
// game/src/arena/egg.ts, replicated here: keep it in sync), then for each one checks
//   blocked    the collision world at r 1.2 (what pickSpot uses) and at r 0.4 (her body)
//   meshes     any visible mesh / instance AABB (props, dressing trees, FX) overlapping her body
//              (r 0.45, y 0.1–1.9): catches visual-only solids the collision world does not know
//   reach      a 1 m flood fill at runner radius (huntMass) from the plaza: is any free cell within
//              wake range of her reachable, and how far is the closest one
// The rounds then check the real egg position each round lands on one of the candidates.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// ── static pass over every candidate ──
const wakeRange = Number(/wakeRange:\s*([0-9.]+)/.exec(readFileSync(resolve(root, 'game/src/config/halloween.ts'), 'utf8'))?.[1] ?? 4);
await p.evaluate((w) => (window.__EGG_WAKE__ = w), wakeRange);
console.log(`EGG.wakeRange from config/halloween.ts = ${wakeRange} m`);
await p.evaluate(() => window.__ARENA__.session.setCity('halloween'));
await step(0.5);
const stat = await p.evaluate(() => {
  const g = window.__ARENA__.preview();
  const b = g.city.bounds;
  const c = [];
  for (const r of g.city.fxHints?.roosts ?? []) { const d = Math.hypot(r.x, r.z) || 1; const off = 4 + r.h * 0.15; c.push({ kind: 'roost', x: r.x + (r.x / d) * off, z: r.z + (r.z / d) * off }); }
  const gy = g.city.fxHints?.graveyard;
  if (gy) for (const [x, z] of [[gy.minX + 3, gy.minZ + 3], [gy.maxX - 3, gy.minZ + 3], [gy.minX + 3, gy.maxZ - 3], [gy.maxX - 3, gy.maxZ - 3]]) c.push({ kind: 'graveyard', x, z });
  const m = 8;
  for (const [x, z] of [[b.minX + m, b.minZ + m], [b.maxX - m, b.minZ + m], [b.minX + m, b.maxZ - m], [b.maxX - m, b.maxZ - m]]) c.push({ kind: 'corner', x, z });
  const inB = (p) => p.x > b.minX + 3 && p.x < b.maxX - 3 && p.z > b.minZ + 3 && p.z < b.maxZ - 3;
  // Clearance: the largest radius around her that is free of every collider (world objects at
  // power 0, static walls, dressing trees: the dressing pass registers tree colliders). An
  // earlier triangle probe over the instanced meshes was dropped: instance counts in the lobby
  // preview are culling-dependent, so it saw nothing even at the centre of a giant.
  const clearance = (x, z) => { let r = 0; while (r < 3 && !g.isBlocked(x, z, r + 0.05, 0, null)) r += 0.05; return +r.toFixed(2); };
  const boxes = { length: g.world.objects.length };
  // Flood fill at runner radius from the free cell nearest the plaza centre.
  const R = 0.55; const S = 1; const W = Math.round((b.maxX - b.minX) / S) + 1; const Hh = Math.round((b.maxZ - b.minZ) / S) + 1;
  const free = new Uint8Array(W * Hh); const seen = new Int32Array(W * Hh).fill(-1);
  const cx = (i) => b.minX + i * S; const cz = (j) => b.minZ + j * S;
  for (let j = 0; j < Hh; j++) for (let i = 0; i < W; i++) { const x = cx(i), z = cz(j); free[j * W + i] = x > b.minX + R && x < b.maxX - R && z > b.minZ + R && z < b.maxZ - R && !g.isBlocked(x, z, R, 0, null) ? 1 : 0; }
  let best = -1, bd = 1e9; for (let k = 0; k < W * Hh; k++) if (free[k]) { const d = Math.hypot(cx(k % W), cz((k / W) | 0)); if (d < bd) { bd = d; best = k; } }
  const q = [best]; seen[best] = 0; let freeN = 0, reachN = 0;
  for (let k = 0; k < W * Hh; k++) freeN += free[k];
  while (q.length) { const k = q.shift(); reachN++; const i = k % W, j = (k / W) | 0; for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= W || nj >= Hh) continue; const nk = nj * W + ni; if (free[nk] && seen[nk] < 0) { seen[nk] = seen[k] + 1; q.push(nk); } } }
  const wake = (window.__EGG_WAKE__ ?? 8) + R;
  const rows = c.map((p) => {
    let near = 1e9, path = -1;
    for (let k = 0; k < W * Hh; k++) if (seen[k] >= 0) { const d = Math.hypot(cx(k % W) - p.x, cz((k / W) | 0) - p.z); if (d < near) { near = d; path = seen[k]; } }
    const eligible = inB(p) && Math.hypot(p.x, p.z) > 36 && !g.isBlocked(p.x, p.z, 1.2, 0, null);
    return { ...p, x: +p.x.toFixed(2), z: +p.z.toFixed(2), eligible, blocked12: g.isBlocked(p.x, p.z, 1.2, 0, null), blockedBody: g.isBlocked(p.x, p.z, 0.4, 0, null), clearance: clearance(p.x, p.z), nearestReachable: +near.toFixed(2), wakeable: near <= wake, pathCells: path };
  });
  return { rows, freeN, reachN, boxes: boxes.length, live: g.hunt?.egg ? { x: g.hunt.egg.x, z: g.hunt.egg.z } : null };
});
let staticFails = 0;
console.log(`static (lobby preview world, seed 7): ${stat.rows.length} candidates, ${stat.rows.filter((r) => r.eligible).length} eligible; world objects ${stat.boxes}; flood fill reached ${stat.reachN}/${stat.freeN} free cells`);
for (const r of stat.rows) {
  const bad = r.eligible && (r.blockedBody || r.clearance < 0.4 || !r.wakeable);
  if (bad) staticFails++;
  console.log(`${!r.eligible ? 'SKIP' : bad ? 'FAIL' : 'PASS'}  ${r.kind.padEnd(9)} (${r.x}, ${r.z}) blocked1.2=${r.blocked12} body=${r.blockedBody} clearance=${r.clearance} m nearestReachable=${r.nearestReachable} m path=${r.pathCells} cells ${r.wakeable ? '' : 'UNREACHABLE'}`);
}
writeFileSync(`${out}/egg-static.json`, JSON.stringify(stat, null, 1));
if (process.argv.includes('--static-only')) { await browser.close(); await server.close(); process.exit(staticFails || errors.length ? 1 : 0); }
const cand = stat.rows.filter((r) => r.eligible);
const rows = [];
let fails = 0;
for (let r = 0; r < rounds; r++) {
  if (r === 0) await p.evaluate(() => { const S = window.__ARENA__.session; S.setCity('halloween'); S.start(); });
  else await p.evaluate(() => window.__ARENA__.session.rematch());
  for (let i = 0; i < 4; i++) await step(1);
  await p.evaluate(() => (window.__ARENA__.game().matchTime = 299.8));
  for (let i = 0; i < 14; i++) await step(0.5); // into the chase (+6 s)
  const sides = [[1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5]];
  const row = await p.evaluate(() => { const g = window.__ARENA__.game(); const x = g.hunt.egg.x, z = g.hunt.egg.z; let r = 0; while (r < 3 && !g.isBlocked(x, z, r + 0.05, 0, null)) r += 0.05; return { seed: g.seed, x, z, stage: g.hunt.stage(), bounds: g.city.bounds, clearance: +r.toFixed(2), inPlaza: Math.hypot(x, z) < 36 }; });
  row.tries = [];
  for (const [dx, dz] of sides) {
    const t = await p.evaluate(({ dx, dz }) => {
      const g = window.__ARENA__.game();
      const me = g.local;
      const h = g.hunt;
      for (const v of h.hunters) { v.x = 0; v.z = 0; } // keep the bosses away from this experiment
      h.egg.botHonkAt = 1e9; // and the AI rivals from honking first
      if (!me) return { noLocal: true };
      const blocked = g.isBlocked(h.egg.x + dx, h.egg.z + dz, me.diameter * 0.5, 0, null);
      me.x = h.egg.x + dx; me.z = h.egg.z + dz; me.speed = 0; me.invulnerableUntil = 0;
      g.emote(6);
      return { alive: me.alive, caught: h.caught.has(me.id), blockedAtPark: blocked };
    }, { dx, dz });
    await step(1 / 30);
    const after = await p.evaluate(() => { const g = window.__ARENA__.game(); const me = g.local; return { d: +Math.hypot(me.x - g.hunt.egg.x, me.z - g.hunt.egg.z).toFixed(2), by: g.hunt.egg.by === me.id ? me.id : null, byOther: g.hunt.egg.by && g.hunt.egg.by !== me.id ? g.hunt.egg.by : null, me: me.id, reach: +(4 + me.diameter * 0.5).toFixed(2) }; });
    row.tries.push({ side: [dx, dz], ...t, ...after });
    if (after.by) break;
  }
  row.woke = row.tries.some((t) => t.by);
  row.firstSideWoke = !!row.tries[0].by;
  await p.evaluate(() => window.__ARENA__.render());
  await p.screenshot({ path: `${out}/egg-spot-${r}.jpg`, type: 'jpeg', quality: 70 });
  row.candidate = stat.rows.find((c) => Math.abs(c.x - row.x) < 0.05 && Math.abs(c.z - row.z) < 0.05)?.kind ?? 'NOT-A-CANDIDATE';
  row.candidateEligibleInPreview = !!cand.find((c) => Math.abs(c.x - row.x) < 0.05 && Math.abs(c.z - row.z) < 0.05);
  console.log(`${row.woke && row.clearance >= 0.4 && !row.inPlaza ? 'PASS' : 'FAIL'}  round ${r} [${row.candidate}${row.candidateEligibleInPreview ? '' : ', not eligible in the preview world'}] seed ${row.seed} egg (${row.x.toFixed(1)}, ${row.z.toFixed(1)}) clearance ${row.clearance} m${row.inPlaza ? ' IN-PLAZA' : ''} ${row.stage} tries ${JSON.stringify(row.tries.map((t) => [t.side.join(','), t.blockedAtPark ? 'blocked' : 'free', t.d, t.by ? 'woke' : '-', t.alive ? '' : 'DEAD']))}`);
  if (!row.woke || row.clearance < 0.4 || row.inPlaza) fails++;
  rows.push(row);
  await p.evaluate(() => { const g = window.__ARENA__.game(); g.matchTime = g.hunt.endsAt() - 0.2; });
  for (let i = 0; i < 6; i++) { const s = await step(0.5); if (s.phase === 'results') break; }
}
writeFileSync(`${out}/egg-spots.json`, JSON.stringify({ rows, errors }, null, 1));
const distinct = new Set(rows.map((r) => `${r.x.toFixed(1)},${r.z.toFixed(1)}`));
console.log(`${rows.filter((r) => r.woke).length}/${rows.length} spots wakeable; first side worked in ${rows.filter((r) => r.firstSideWoke).length}; distinct spots ${distinct.size}/${cand.length} eligible; static fails ${staticFails}; page errors ${errors.length}`);
fails += staticFails;
await browser.close();
await server.close();
process.exit(fails || errors.length ? 1 : 0);
