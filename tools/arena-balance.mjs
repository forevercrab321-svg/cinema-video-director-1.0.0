#!/usr/bin/env node
// GROW EVERYTHING — arena balance audit (game-design data, not guesses).
// Plays full rounds through the REAL arena session (solo transport, host rules, grants, refill,
// end conditions) in deterministic test mode and records pacing / fairness metrics:
//   time to first eat, mass curve, time to first car-class (class ≥ 5) object, landmark timing,
//   machine eats, lives lost, snowball (leader's mass share), comebacks, dry time with no
//   eligible food nearby, winners by machine type — and, in "novice" rounds, how a simple
//   new-player proxy fares against the AI rivals (the first-round experience).
//
// Rounds: bot-only (4 AI rivals) and novice (slot 0 = scripted new player + 3 AI rivals).
// Vehicles rotate through the slots with the seed so machine type and spawn are decorrelated.
// Math.random is seeded per round, so the whole round (seed, names, quips) is reproducible.
//
// Usage: node tools/arena-balance.mjs [--seeds 1,2,3,4] [--cities shanghai,newyork,paris,scrap]
//                                     [--novice 1,2] [--out file.json] [--port 5231] [--pages 2]
//        node tools/arena-balance.mjs --resummarise file.json   (recompute the summary of a saved run)
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const list = (s) => (s ? String(s).split(',').filter(Boolean) : []);
const seeds = list(arg('--seeds', '1,2,3,4')).map(Number);
const cities = list(arg('--cities', 'shanghai,newyork,paris,scrap'));
const noviceSeeds = list(arg('--novice', '1,2')).map(Number);
const outFile = path.resolve(arg('--out', path.join(root, 'renders/review/arena-balance.json')));
const pages = Math.max(1, Number(arg('--pages', 2)));

const jobs = [];
for (const city of cities) {
  for (const seed of seeds) jobs.push({ city, seed, novice: false });
  for (const seed of noviceSeeds) jobs.push({ city, seed: 1000 + seed, novice: true });
}

/** Runs inside the page: one full round, returns the metrics. */
async function playRound({ city, seed, novice }) {
  const W = window;
  const A = W.__ARENA__;
  const S = A.session;
  // Seeded Math.random for the round (match seed, bot names, cosmetics, quips).
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
  S.setCity(city);
  S.setBots(true);
  S.setJoined(true);
  S.start();
  const roster = S.match.roster;
  for (const r of roster) {
    r.vehicle = ORDER[(r.slot + seed) % 4];
    if (r.slot === 0 && !novice) Object.assign(r, { id: 'bot-0', kind: 'bot', name: 'Rival0' });
  }
  // Bot-only: step out of the lobby so the host does not drop us into an AI rival's slot.
  if (!novice) S.setJoined(false);
  const flush = () => new Promise((res) => setTimeout(res, 0));
  await flush();
  const g = A.game();
  if (!g) return { error: 'no game' };
  // Bot-only rounds measure veteran AI; novice rounds keep the game's own choice (a fresh
  // browser = first round = rookie AI, when the build has the difficulty ramp).
  if (!novice && 'botSkill' in g) g.botSkill = 1;
  const botSkill = g.botSkill ?? 1;

  // ── Instrumentation ──
  const T = () => g.matchTime;
  const per = new Map();
  for (const a of g.actors)
    per.set(a.id, { id: a.id, slot: a.slot, kind: a.kind === 'local' ? 'novice' : 'bot', vehicle: a.vehicle.id, firstEat: null, firstCls: {}, firstCar: null, curve: [], drySec: 0, noFoodSec: 0, aliveSec: 0, lastAbsorb: 0, firstDeath: null, eatenBy: [], peakMass: a.mass, objMass: 0, killMass: 0, crashes: 0 });
  const eats = [];
  let landmarkFirst = null;
  let landmarkDone = null;
  let landmarkBy = null;
  const absorb0 = g.absorb.bind(g);
  g.absorb = (o, a) => {
    const before = a.mass;
    absorb0(o, a);
    const p = per.get(a.id);
    if (!p || !a.owned) return;
    const t = T();
    p.objMass += a.mass - before;
    p.lastAbsorb = t;
    if (p.firstEat === null) p.firstEat = t;
    const c = o.def.objectClass;
    if (p.firstCls[c] === undefined) p.firstCls[c] = +t.toFixed(1);
    if (c >= 5 && !o.def.climax && p.firstCar === null) p.firstCar = t;
    if (o.def.climax) {
      if (landmarkFirst === null) landmarkFirst = { t, by: a.id };
      if (g.climaxLeft() === 0 && landmarkDone === null) {
        landmarkDone = t;
        landmarkBy = a.id;
      }
    }
  };
  const eaten0 = g.applyEaten.bind(g);
  g.applyEaten = (e) => {
    const v = g.byId.get(e.v);
    const a = g.byId.get(e.a);
    if (v && a) {
      const rankOf = (x) => [...g.actors].sort((p, q) => q.mass - p.mass).indexOf(x) + 1;
      eats.push({ t: +T().toFixed(1), a: a.id, v: v.id, aVeh: a.vehicle.id, vVeh: v.vehicle.id, aMass: Math.round(a.mass), vMass: Math.round(v.mass), gain: Math.round(e.gain), vRank: rankOf(v), aRank: rankOf(a) });
      const pv = per.get(v.id);
      if (pv && pv.firstDeath === null) pv.firstDeath = T();
      pv?.eatenBy.push(a.kind === 'local' ? 'novice' : 'bot');
      const pa = per.get(a.id);
      if (pa) pa.killMass += e.gain;
    }
    eaten0(e);
  };
  const setMass0 = g.setMass.bind(g);
  g.setMass = (a, m) => {
    setMass0(a, m);
    const p = per.get(a.id);
    if (p) p.peakMass = Math.max(p.peakMass, m);
  };

  // ── Novice proxy: steers at nearby food with noise, hesitates, notices threats late ──
  let inputRestore = null;
  if (novice) {
    const input = g.input;
    const read0 = input.read;
    inputRestore = () => (input.read = read0);
    let thinkAt = 0;
    let dx = 0;
    let dz = -1;
    let dash = false;
    input.read = () => {
      const me = g.local;
      if (!me || !me.alive) return { forward: 0, right: 0, dash: false, restart: false };
      const t = g.time;
      if (t >= thinkAt) {
        thinkAt = t + 0.45 + rnd() * 0.5; // human reaction + indecision
        dash = rnd() < 0.08;
        let threat = null;
        for (const o of g.actors) if (o !== me && o.alive && g.canEat(o, me) && Math.hypot(o.x - me.x, o.z - me.z) < 5 + o.diameter * 1.5) threat = o;
        let prey = null;
        for (const o of g.actors) if (o !== me && o.alive && g.canEat(me, o) && Math.hypot(o.x - me.x, o.z - me.z) < 7 + me.diameter * 2) prey = o;
        if (threat && rnd() < 0.55) {
          dx = me.x - threat.x;
          dz = me.z - threat.z;
          dash = rnd() < 0.3;
        } else if (prey && rnd() < 0.6) {
          dx = prey.x - me.x;
          dz = prey.z - me.z;
        } else {
          // One of the 6 nearest things it can eat (no value judgement), within sight.
          const near = [];
          for (const o of g.world.objects) {
            if (!g.world.isEligible(o, me.power)) continue;
            const d = Math.hypot(o.x - me.x, o.z - me.z);
            if (d < 20 + me.diameter * 4) near.push([d, o]);
          }
          near.sort((p, q) => p[0] - q[0]);
          const pick = near.length ? near[Math.floor(rnd() * Math.min(6, near.length))][1] : null;
          if (pick) {
            dx = pick.x - me.x;
            dz = pick.z - me.z;
          } else if (rnd() < 0.5) {
            const b = g.city.bounds;
            dx = (b.minX + b.maxX) / 2 - me.x + (rnd() - 0.5) * 40;
            dz = (b.minZ + b.maxZ) / 2 - me.z + (rnd() - 0.5) * 40;
          }
        }
        const noise = (rnd() - 0.5) * 0.9;
        const c = Math.cos(noise);
        const s = Math.sin(noise);
        [dx, dz] = [dx * c - dz * s, dx * s + dz * c];
        // Steer around a wall ahead like a person would (a few tries).
        const len = Math.hypot(dx, dz) || 1;
        dx /= len;
        dz /= len;
        for (const deg of [0, 45, -45, 90, -90]) {
          const ang = (deg * Math.PI) / 180;
          const cx = dx * Math.cos(ang) - dz * Math.sin(ang);
          const cz = dx * Math.sin(ang) + dz * Math.cos(ang);
          if (!g.isBlocked(me.x + cx * (me.diameter + 0.5), me.z + cz * (me.diameter + 0.5), me.diameter * 0.5, me.power, null)) {
            dx = cx;
            dz = cz;
            break;
          }
        }
      }
      const yaw = g.rig.controlYaw ?? g.rig.yaw;
      const sy = Math.sin(yaw);
      const cy = Math.cos(yaw);
      const d = dash;
      dash = false;
      return { forward: -sy * dx - cy * dz, right: cy * dx - sy * dz, dash: d, restart: false };
    };
  }

  // ── Play ──
  const snow = [];
  let lastSample = -1;
  let lastSec = 0;
  const leaderHist = [];
  let guard = 0;
  while (S.match.ph !== 'results' && S.match.ph !== 'lobby' && guard++ < 60 * 400) {
    A.step(1 / 60);
    await null; // let the loop-back transport deliver (claims → grants, eats → eaten)
    await null;
    if (g.phase !== 'playing') continue;
    const t = T();
    if (t - lastSec >= 1) {
      lastSec = Math.floor(t);
      for (const a of g.actors) {
        const p = per.get(a.id);
        if (!a.alive) continue;
        p.aliveSec++;
        if (t - p.lastAbsorb > 3 && t > 3) p.drySec++;
        const R = 12 + a.diameter * 4;
        let any = false;
        for (const o of g.world.objects) {
          if (o.state !== 'idle' || !g.world.isEligible(o, a.power)) continue;
          if (Math.abs(o.x - a.x) < R && Math.abs(o.z - a.z) < R) {
            any = true;
            break;
          }
        }
        if (!any) p.noFoodSec++;
      }
    }
    if (t - lastSample >= 5) {
      lastSample = Math.floor(t / 5) * 5;
      const masses = g.actors.map((a) => a.mass);
      const sum = masses.reduce((x, y) => x + y, 0);
      const sorted = [...g.actors].sort((p, q) => q.mass - p.mass);
      snow.push({ t: lastSample, share: +(sorted[0].mass / sum).toFixed(3), top2: +(sorted[0].mass / Math.max(1, sorted[1]?.mass ?? 1)).toFixed(2), leader: sorted[0].id });
      leaderHist.push(sorted.map((a) => a.id));
      for (const a of g.actors) per.get(a.id).curve.push(Math.round(a.mass));
    }
  }
  inputRestore?.();
  const standings = S.match.standings ?? g.standings();
  // Comebacks: a machine ranked last (or ≤ 25 % of the leader) at some 5 s sample after 30 s
  // that later leads or finishes top 2.
  const comebacks = [];
  for (const a of g.actors) {
    let low = null;
    for (let i = 6; i < leaderHist.length; i++) {
      const order = leaderHist[i];
      const curve = per.get(a.id).curve;
      const leadMass = Math.max(...g.actors.map((b) => per.get(b.id).curve[i] ?? 0));
      if (low === null && (order.indexOf(a.id) === order.length - 1 || curve[i] <= leadMass * 0.25)) low = i;
      if (low !== null && order[0] === a.id) {
        comebacks.push({ id: a.id, from: low * 5, led: i * 5 });
        break;
      }
    }
  }
  let leadChanges = 0;
  for (let i = 1; i < snow.length; i++) if (snow[i].leader !== snow[i - 1].leader && snow[i].t >= 30) leadChanges++;
  const end = T();
  const reason = g.climaxLeft() === 0 ? 'landmark' : end >= 299 ? 'time' : 'last_standing_or_humans_out';
  const actors = g.actors.map((a) => {
    const p = per.get(a.id);
    const s = standings.find((x) => x.id === a.id);
    return { ...p, finalMass: Math.round(a.mass), peakMass: Math.round(p.peakMass), objMass: Math.round(p.objMass), killMass: Math.round(p.killMass), kills: a.kills, deaths: a.deaths, livesLost: 3 - a.lives, eliminated: a.eliminated, rank: s?.rank ?? null, maxCls: Math.max(...Object.keys(p.firstCls).map(Number), 0), curve: p.curve };
  });
  const winner = actors.find((x) => x.rank === 1);
  const res = { city, seed, novice, botSkill, matchSeed: S.match.seed, end: +end.toFixed(1), reason, landmarkFirst, landmarkDone, landmarkBy, eats, snow, comebacks, leadChanges, actors, winner: winner ? { id: winner.id, vehicle: winner.vehicle, kind: winner.kind } : null };
  S.toLobby?.();
  await flush();
  return res;
}

const median = (xs) => {
  const v = xs.filter((x) => x !== null && x !== undefined && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return +(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2).toFixed(2);
};
const mean = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3) : null;
};

function summarise(rounds) {
  const bot = rounds.filter((r) => !r.novice && !r.error);
  const nov = rounds.filter((r) => r.novice && !r.error);
  const all = [...bot, ...nov];
  const actorsOf = (rs) => rs.flatMap((r) => r.actors.map((a) => ({ ...a, city: r.city, end: r.end })));
  const botActors = actorsOf(bot);
  const byVehicle = {};
  for (const v of ['collector', 'dozer', 'racer', 'magnet']) {
    const xs = botActors.filter((a) => a.vehicle === v);
    byVehicle[v] = {
      wins: bot.filter((r) => r.winner?.vehicle === v).length,
      meanRank: mean(xs.map((a) => a.rank)),
      medianFinalMass: median(xs.map((a) => a.finalMass)),
      kills: xs.reduce((s, a) => s + a.kills, 0),
      deaths: xs.reduce((s, a) => s + a.deaths, 0),
      eliminated: xs.filter((a) => a.eliminated).length,
    };
  }
  const shareAt = (rs, t) => median(rs.map((r) => r.snow.find((s) => s.t === t)?.share));
  const novices = actorsOf(nov).filter((a) => a.kind === 'novice');
  const n = (rs) => rs.length || 1;
  return {
    rounds: all.length,
    botRounds: bot.length,
    noviceRounds: nov.length,
    endReasons: Object.fromEntries(['time', 'landmark', 'last_standing_or_humans_out'].map((k) => [k, all.filter((r) => r.reason === k).length])),
    medianRoundEnd: median(all.map((r) => r.end)),
    medianFirstEat: median(botActors.map((a) => a.firstEat)),
    medianFirstCar: median(botActors.map((a) => a.firstCar)),
    carReachedShare: +(botActors.filter((a) => a.firstCar !== null).length / (botActors.length || 1)).toFixed(2),
    firstCarByLeaderMedian: median(bot.map((r) => Math.min(...r.actors.map((a) => a.firstCar ?? Infinity)))),
    landmarkFirstPartMedian: median(all.map((r) => r.landmarkFirst?.t ?? null)),
    landmarkDoneMedian: median(all.map((r) => r.landmarkDone)),
    landmarkDoneShare: +(all.filter((r) => r.landmarkDone !== null).length / n(all)).toFixed(2),
    machineEatsPerRound: +(bot.reduce((s, r) => s + r.eats.length, 0) / n(bot)).toFixed(2),
    firstMachineEatMedian: median(bot.map((r) => r.eats[0]?.t ?? null)),
    livesLostPerMachine: mean(botActors.map((a) => a.livesLost)),
    eliminatedPerRound: +(botActors.filter((a) => a.eliminated).length / n(bot)).toFixed(2),
    leaderShare: { t60: shareAt(bot, 60), t120: shareAt(bot, 120), t180: shareAt(bot, 180), t240: shareAt(bot, 240), final: median(bot.map((r) => r.snow.at(-1)?.share)) },
    top2RatioFinal: median(bot.map((r) => r.snow.at(-1)?.top2)),
    leadChangesAfter30s: mean(bot.map((r) => r.leadChanges)),
    comebacksPerRound: +(bot.reduce((s, r) => s + r.comebacks.length, 0) / n(bot)).toFixed(2),
    drySecShare: +(botActors.reduce((s, a) => s + a.drySec, 0) / Math.max(1, botActors.reduce((s, a) => s + a.aliveSec, 0))).toFixed(3),
    noFoodSecShare: +(botActors.reduce((s, a) => s + a.noFoodSec, 0) / Math.max(1, botActors.reduce((s, a) => s + a.aliveSec, 0))).toFixed(3),
    eatsOfLastPlace: +(bot.reduce((s, r) => s + r.eats.filter((e) => e.vRank === 4).length, 0) / n(bot)).toFixed(2),
    winnersByVehicle: byVehicle,
    novice: {
      rounds: novices.length,
      medianRank: median(novices.map((a) => a.rank)),
      medianFirstDeath: median(novices.map((a) => a.firstDeath)),
      eliminated: novices.filter((a) => a.eliminated).length,
      livesLost: mean(novices.map((a) => a.livesLost)),
      medianFirstEat: median(novices.map((a) => a.firstEat)),
      medianFirstCar: median(novices.map((a) => a.firstCar)),
      carReachedShare: +(novices.filter((a) => a.firstCar !== null).length / (novices.length || 1)).toFixed(2),
      firstDeathShareBefore90s: +(novices.filter((a) => a.firstDeath !== null && a.firstDeath < 90).length / (novices.length || 1)).toFixed(2),
      medianFinalMass: median(novices.map((a) => a.finalMass)),
      kills: novices.reduce((s, a) => s + a.kills, 0),
      roundEndMedian: median(nov.map((r) => r.end)),
      drySecShare: +(novices.reduce((s, a) => s + a.drySec, 0) / Math.max(1, novices.reduce((s, a) => s + a.aliveSec, 0))).toFixed(3),
    },
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
const server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: Number(arg('--port', 5231)), strictPort: false, hmr: false, watch: null } });
await server.listen();
const base = server.resolvedUrls.local[0];
const executablePath = existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch({ executablePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

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
    const w = r.winner ? `${r.winner.vehicle}/${r.winner.kind}` : '-';
    console.log(`${job.city} seed=${job.seed}${job.novice ? ' novice' : ''}: end ${r.end}s (${r.reason}) eats=${r.eats?.length} winner=${w} landmark=${r.landmarkDone ?? '-'} [${((Date.now() - t0) / 1000).toFixed(0)}s wall]${r.error ? ' ERROR ' + r.error : ''}`);
  }
  await page.close();
}
try {
  await Promise.all(Array.from({ length: pages }, (_, i) => worker(i)));
} finally {
  await browser.close();
  await server.close();
}
rounds.sort((a, b) => (a.city + a.seed).localeCompare(b.city + b.seed));
const report = { date: new Date().toISOString(), summary: summarise(rounds), errors: errors.slice(0, 20), rounds };
await writeFile(outFile, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report.summary, null, 1));
console.log(`→ ${outFile}`);
