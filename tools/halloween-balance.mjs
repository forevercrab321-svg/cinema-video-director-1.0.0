#!/usr/bin/env node
// GROW EVERYTHING — Halloween Town balance audit (docs/halloween-mode.md; data, not guesses).
// Plays full 10-minute Halloween rounds through the REAL arena session (solo transport, host rules,
// hunt, Egg Valley) in deterministic test mode with 6 AI machines (veteran skill) and records:
//   first half  time to first object of class 3/5/6/7/8 (leader = earliest machine, and median
//               machine), mass at the lock per machine, classes per minute;
//   hunt        catch times (and by which boss), survivors, did the first-half leader survive,
//               rank lock → final, comebacks (rank gain ≥ 2), trailing machine wins;
//   Egg Valley  found or not, when, by whom, her spot's distance to spawns / centre, how close
//               machines came (min distance, machine-seconds inside hint / wake range);
//   bosses      idle (no target) and stuck (chasing but not moving) seconds, catches per boss.
// Math.random is seeded per round, so a seed reproduces its round (match seed → map, egg spot).
//
// Usage: node tools/halloween-balance.mjs [--seeds 1,2,3,4,5,6] [--pages 3] [--out file.json] [--port 5241]
//        node tools/halloween-balance.mjs --resummarise file.json
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const list = (s) => (s ? String(s).split(',').filter(Boolean) : []);
const seeds = list(arg('--seeds', '1,2,3,4,5,6')).map(Number);
const outFile = path.resolve(arg('--out', path.join(root, 'renders/review/halloween-balance.json')));
const pages = Math.max(1, Number(arg('--pages', 3)));
const CLASSES = [3, 5, 6, 7, 8];

/** Runs inside the page: one full Halloween round (6 AI machines), returns the metrics. */
async function playRound({ seed, classes }) {
  const W = window;
  const A = W.__ARENA__;
  const S = A.session;
  let st = (seed * 2654435761) >>> 0 || 1;
  const rnd = () => {
    st = (st + 0x6d2b79f5) >>> 0;
    let t = st;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  Math.random = rnd;
  const ORDER = ['collector', 'dozer', 'racer', 'magnet'];
  S.setCity('halloween');
  S.setBots(true);
  S.setJoined(true);
  S.start();
  for (const r of S.match.roster) {
    r.vehicle = ORDER[(r.slot + seed) % 4];
    if (r.slot === 0) Object.assign(r, { id: 'bot-0', kind: 'bot', name: 'Rival0' });
  }
  S.setJoined(false);
  const flush = () => new Promise((res) => setTimeout(res, 0));
  await flush();
  const g = A.game();
  if (!g || !g.hunt) return { seed, error: 'no halloween game' };
  if ('botSkill' in g) g.botSkill = 1;
  const T = () => g.matchTime;
  const per = new Map();
  for (const a of g.actors) per.set(a.id, { id: a.id, slot: a.slot, vehicle: a.vehicle.id, sx: +a.x.toFixed(1), sz: +a.z.toFixed(1), firstCls: {}, curve: [], lockMass: null, caughtAt: null, caughtBy: null });
  const absorb0 = g.absorb.bind(g);
  g.absorb = (o, a) => {
    absorb0(o, a);
    const p = per.get(a.id);
    if (!p || !a.owned) return;
    const c = o.def.objectClass;
    if (p.firstCls[c] === undefined) p.firstCls[c] = +T().toFixed(1);
  };
  const h = g.hunt;
  const caught0 = h.applyCaught.bind(h);
  h.applyCaught = (id, at, by) => {
    const r = caught0(id, at, by);
    const p = per.get(id);
    if (r && p) {
      p.caughtAt = +(at - (h.start ?? 0)).toFixed(1);
      p.caughtBy = h.hunters[by]?.def.kind ?? String(by);
    }
    return r;
  };
  const egg = h.egg;
  const eggSpot = { x: +egg.x.toFixed(1), z: +egg.z.toFixed(1), fromCentre: +Math.hypot(egg.x, egg.z).toFixed(1), fromSpawnMin: +Math.min(...g.city.spawns.map((s) => Math.hypot(s.x - egg.x, s.z - egg.z))).toFixed(1) };
  const bounds = { ...g.city.bounds };
  let eggMin = Infinity;
  let eggHintSec = 0;
  let eggWakeSec = 0;
  let eggVisitors = new Set();
  let eggMinFirstHalf = Infinity;
  const boss = h.hunters.map((x) => ({ kind: x.def.kind, idle: 0, stuck: 0, catches: 0, last: null, dist: 0 }));
  let lastBoss = -1;
  let lastSec = 0;
  let lastSample = -1;
  let guard = 0;
  let lockSeen = false;
  const lockCurve = [];
  while (S.match.ph !== 'results' && S.match.ph !== 'lobby' && guard++ < 60 * 700) {
    A.step(1 / 60);
    await null;
    await null;
    if (g.phase !== 'playing') continue;
    const t = T();
    if (!lockSeen && h.start !== null) {
      lockSeen = true;
      for (const [id, s] of h.scores) if (per.get(id)) per.get(id).lockMass = Math.round(s);
    }
    if (t - lastSample >= 10) {
      lastSample = Math.floor(t / 10) * 10;
      if (!lockSeen) for (const a of g.actors) per.get(a.id).curve.push(Math.round(a.mass));
    }
    const stage = h.stage();
    if (t - lastSec >= 1) {
      lastSec = Math.floor(t);
      for (const a of g.actors) {
        if (!a.alive) continue;
        const d = Math.hypot(a.x - egg.x, a.z - egg.z);
        if (stage !== 'chase') eggMinFirstHalf = Math.min(eggMinFirstHalf, d);
        if (stage === 'chase' && !egg.by && !h.caught.has(a.id)) {
          eggMin = Math.min(eggMin, d);
          if (d < 15) {
            eggHintSec++;
            eggVisitors.add(a.id);
          }
          if (d < 4 + a.diameter * 0.5) eggWakeSec++;
        }
      }
    }
    if (stage === 'chase' && t - lastBoss >= 0.5) {
      lastBoss = t;
      h.hunters.forEach((x, i) => {
        const b = boss[i];
        if (b.last) {
          const moved = Math.hypot(x.x - b.last[0], x.z - b.last[1]);
          b.dist += moved;
          if (t >= x.restUntil) {
            if (!x.target) b.idle += 0.5;
            else if (moved < 0.4) b.stuck += 0.5;
          }
        }
        b.last = [x.x, x.z];
      });
    }
  }
  const standings = S.match.standings ?? g.standings();
  const lockOrder = [...per.values()].sort((p, q) => q.lockMass - p.lockMass).map((p) => p.id);
  const actors = [...per.values()].map((p) => {
    const s = standings.find((x) => x.id === p.id);
    const lockRank = lockOrder.indexOf(p.id) + 1;
    return { ...p, lockRank, finalRank: s?.rank ?? null, finalScore: s?.mass ?? null, gain: lockRank - (s?.rank ?? lockRank), caught: p.caughtAt !== null };
  });
  for (const a of actors) if (a.caughtBy) boss.find((b) => b.kind === a.caughtBy).catches++;
  const leader = actors.find((a) => a.lockRank === 1);
  const winner = actors.find((a) => a.finalRank === 1);
  const res = {
    seed,
    matchSeed: S.match.seed,
    huntStart: h.start,
    end: +T().toFixed(1),
    bounds,
    actors: actors.map(({ curve, ...a }) => ({ ...a, curve })),
    caught: actors.filter((a) => a.caught).length,
    catchTimes: actors.filter((a) => a.caught).map((a) => a.caughtAt).sort((x, y) => x - y),
    leaderCaught: !!leader?.caught,
    leaderCaughtAt: leader?.caughtAt ?? null,
    winnerLockRank: winner?.lockRank ?? null,
    maxGain: Math.max(...actors.map((a) => a.gain)),
    comebacks: actors.filter((a) => a.gain >= 2).length,
    egg: { ...eggSpot, by: egg.by, at: egg.by ? +(egg.at - h.start).toFixed(1) : null, byLockRank: egg.by ? actors.find((a) => a.id === egg.by)?.lockRank : null, byCaught: egg.by ? actors.find((a) => a.id === egg.by)?.caught : null, minDistChase: +eggMin.toFixed(1), minDistFirstHalf: +eggMinFirstHalf.toFixed(1), hintMachineSec: eggHintSec, wakeMachineSec: eggWakeSec, visitors: eggVisitors.size },
    boss: boss.map(({ last, ...b }) => ({ ...b, dist: Math.round(b.dist), idle: +b.idle.toFixed(1), stuck: +b.stuck.toFixed(1) })),
  };
  S.toLobby?.();
  await flush();
  return res;
}

const median = (xs) => {
  const v = xs.filter((x) => x !== null && x !== undefined && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return +(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2).toFixed(1);
};
const mean = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null;
};

function summarise(rounds) {
  const ok = rounds.filter((r) => !r.error);
  const n = ok.length || 1;
  const all = ok.flatMap((r) => r.actors);
  const pacing = {};
  for (const c of CLASSES) {
    pacing[`cls${c}`] = {
      leader: median(ok.map((r) => Math.min(...r.actors.map((a) => a.firstCls[c] ?? Infinity)))),
      median: median(ok.map((r) => median(r.actors.map((a) => a.firstCls[c] ?? Infinity)))),
      reachedShare: +(all.filter((a) => a.firstCls[c] !== undefined).length / (all.length || 1)).toFixed(2),
    };
  }
  const lockMasses = ok.map((r) => r.actors.map((a) => a.lockMass).sort((x, y) => y - x));
  return {
    rounds: ok.length,
    firstHalf: {
      pacing,
      lockMassByRank: [0, 1, 2, 3, 4, 5].map((i) => median(lockMasses.map((m) => m[i]))),
      lockTop2Ratio: median(lockMasses.map((m) => +(m[0] / Math.max(1, m[1])).toFixed(2))),
    },
    hunt: {
      caughtPerRound: ok.map((r) => r.caught),
      caughtShare: +(ok.reduce((s, r) => s + r.caught, 0) / (6 * n)).toFixed(2),
      medianCatchTime: median(ok.flatMap((r) => r.catchTimes)),
      firstCatchMedian: median(ok.map((r) => r.catchTimes[0] ?? null)),
      catchTimes: ok.map((r) => r.catchTimes),
      survivorsPerRound: ok.map((r) => 6 - r.caught),
      leaderCaughtRounds: ok.filter((r) => r.leaderCaught).length,
      comebackRounds: ok.filter((r) => r.comebacks > 0).length,
      maxGainPerRound: ok.map((r) => r.maxGain),
      trailingWinnerRounds: ok.filter((r) => r.winnerLockRank && r.winnerLockRank > 1).length,
      winnerLockRanks: ok.map((r) => r.winnerLockRank),
      earlyEnd: ok.filter((r) => r.end < 599).map((r) => r.end),
    },
    egg: {
      foundRounds: ok.filter((r) => r.egg.by).length,
      foundAt: ok.map((r) => r.egg.at),
      byLockRank: ok.map((r) => r.egg.byLockRank ?? null),
      spots: ok.map((r) => `${r.egg.x},${r.egg.z} c${r.egg.fromCentre} s${r.egg.fromSpawnMin}`),
      minDistChase: ok.map((r) => r.egg.minDistChase),
      hintMachineSec: ok.map((r) => r.egg.hintMachineSec),
      wakeMachineSec: ok.map((r) => r.egg.wakeMachineSec),
    },
    boss: ['shock', 'cannibal', 'motel'].map((k) => {
      const bs = ok.map((r) => r.boss.find((b) => b.kind === k));
      return { kind: k, catches: bs.reduce((s, b) => s + b.catches, 0), idleMean: mean(bs.map((b) => b.idle)), stuckMean: mean(bs.map((b) => b.stuck)), distMean: mean(bs.map((b) => b.dist)) };
    }),
  };
}

if (process.argv.includes('--resummarise')) {
  const file = path.resolve(arg('--resummarise'));
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.summary = summarise(saved.rounds);
  await writeFile(file, JSON.stringify(saved, null, 1));
  console.log(JSON.stringify(saved.summary, null, 1));
  process.exit(0);
}

const { createServer } = await import('vite');
const { chromium } = await import('playwright');
const server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: Number(arg('--port', 5241)), strictPort: false, hmr: false, watch: null } });
await server.listen();
const base = server.resolvedUrls.local[0];
const executablePath = existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch({ executablePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const jobs = seeds.map((seed) => ({ seed, classes: CLASSES }));
const rounds = [];
const errors = [];
async function worker(id) {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  page.on('pageerror', (e) => errors.push(`page${id}: ${e.message}`));
  await page.goto(`${base}game/?mode=arena&net=solo&test=1&quality=low&name=Sim&lang=en`);
  await page.waitForFunction(() => window.__ARENA__?.ready, null, { timeout: 180_000 });
  while (jobs.length) {
    const job = jobs.shift();
    const t0 = Date.now();
    const r = await page.evaluate(playRound, job).catch((e) => ({ ...job, error: String(e) }));
    rounds.push(r);
    console.log(r.error ? `seed=${job.seed} ERROR ${r.error}` : `seed=${job.seed}: end ${r.end}s caught=${r.caught}/6 [${r.catchTimes.join(',')}] leaderCaught=${r.leaderCaught} winnerLockRank=${r.winnerLockRank} maxGain=${r.maxGain} egg=${r.egg.by ? `${r.egg.by}@${r.egg.at}s` : `no (min ${r.egg.minDistChase} m)`} lock=${r.actors.map((a) => a.lockMass).join('/')} [${((Date.now() - t0) / 1000).toFixed(0)}s wall]`);
  }
  await page.close();
}
try {
  await Promise.all(Array.from({ length: pages }, (_, i) => worker(i)));
} finally {
  await browser.close();
  await server.close();
}
rounds.sort((a, b) => a.seed - b.seed);
const report = { date: new Date().toISOString(), summary: summarise(rounds), errors: errors.slice(0, 20), rounds };
await writeFile(outFile, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report.summary, null, 1));
console.log(`→ ${outFile}`);
