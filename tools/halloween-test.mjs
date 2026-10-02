#!/usr/bin/env node
// Halloween Town — "The Hunt" end-to-end test (docs/halloween-mode.md). Real game in headless
// Chromium, deterministic game-time steps through window.__ARENA__, autopilot drives every machine.
//
//   solo   one page, 6 seats (you + 5 AI): grow half → scores lock at 300 s → everyone shrinks to
//          huntMass and comes back → villains rise and chase → caught = score 0, out → results at
//          ≤ 600 s ranked by locked score (caught below runners, later catch higher). Also logs the
//          catch curve (balance: how many survive the hunt).
//   duo    two pages in one browser over LocalNet (?net=local): the guest follows the host's hunt
//          start, locked scores, villain positions and catches.
//
// Screenshots: renders/review/halloween/test-*.jpg · exit 1 on any failed check.
//   node tools/halloween-test.mjs [--only solo|duo] [--runs N]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const only = arg('--only', null);
const runs = Number(arg('--runs', 1));
const shots = resolve(root, 'renders/review/halloween');
mkdirSync(shots, { recursive: true });

const HUNT_AT = 300;
const HUNT_SECONDS = 300;
const HUNT_MASS = 120;

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

const vite = await import('vite');
const server = await vite.createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 5199, strictPort: false, hmr: false } });
await server.listen();
const base = `${server.resolvedUrls.local[0]}game/`;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

async function openPage(ctx, query) {
  const p = await ctx.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => m.type() === 'error' && !/favicon|404|Failed to load resource|supabase/i.test(m.text()) && errors.push(m.text()));
  await p.goto(`${base}?mode=arena&test=1&quality=low&lang=en&${query}`);
  await p.waitForFunction(() => window.__ARENA__?.ready, null, { timeout: 180000 });
  return { p, errors };
}

/** Step in chunks so the page stays responsive; returns the last summary. */
async function stepTo(p, t, chunk = 2) {
  for (;;) {
    const s = await p.evaluate((c) => window.__ARENA__.step(c), chunk);
    if (s.t >= t || s.phase === 'results' || s.phase === 'lobby') return s;
  }
}

// ── Solo ────────────────────────────────────────────────────────────────────
async function solo(run) {
  const ctx = await browser.newContext();
  const { p, errors } = await openPage(ctx, 'net=solo&name=You');
  await p.evaluate(() => {
    const S = window.__ARENA__.session;
    S.setCity('halloween');
    S.start();
    window.__ARENA__.step(0.1);
    window.__ARENA__.autopilot(true);
  });
  let s = await stepTo(p, 4);
  ok(s.city === 'halloween' && s.actors.length === 6, `[solo ${run}] halloween round with 6 machines (you + 5 AI) [${s.city}, ${s.actors.length}]`);
  s = await stepTo(p, 120);
  const grew = Math.max(...s.actors.map((a) => a.mass));
  ok(grew > 500, `[solo ${run}] machines grow in the first half (top ${grew} kg at 120 s)`);
  if (run === 1) await p.screenshot({ path: `${shots}/test-grow-120s.jpg` });
  s = await stepTo(p, HUNT_AT - 1);
  ok(s.hunt && s.hunt.start === null && s.hunt.stage === 'grow', `[solo ${run}] no hunt before ${HUNT_AT} s`);
  const before = Object.fromEntries(s.actors.map((a) => [a.id, a.mass]));
  s = await stepTo(p, HUNT_AT + 0.5, 0.5);
  ok(Math.abs((s.hunt?.start ?? -1) - HUNT_AT) < 0.6, `[solo ${run}] hunt starts at ${HUNT_AT} s [${s.hunt?.start}]`);
  const locked = s.hunt?.scores ?? {};
  const scoreOk = s.actors.every((a) => Math.abs((locked[a.id] ?? -1) - before[a.id]) <= Math.max(5, before[a.id] * 0.05));
  ok(scoreOk, `[solo ${run}] locked scores = masses at the lock (${s.actors.map((a) => `${a.name} ${locked[a.id]}`).join(', ')})`);
  s = await stepTo(p, HUNT_AT + 2, 0.5);
  ok(s.actors.every((a) => a.mass === HUNT_MASS && a.alive && !a.out), `[solo ${run}] everyone shrank to ${HUNT_MASS} kg and is back in play [${s.actors.map((a) => `${a.mass}${a.alive ? '' : ' dead'}${a.out ? ' out' : ''}`).join(', ')}]`);
  s = await stepTo(p, HUNT_AT + 4.5, 0.5);
  ok(s.hunt.stage === 'rise', `[solo ${run}] villains rise at +3 s [${s.hunt.stage}]`);
  if (run === 1) await p.screenshot({ path: `${shots}/test-rise.jpg` });
  s = await stepTo(p, HUNT_AT + 8, 0.5);
  ok(s.hunt.stage === 'chase' && s.hunt.hunters.every((h) => h.target), `[solo ${run}] chase from +6 s, every villain has a target`);
  if (run === 1) await p.screenshot({ path: `${shots}/test-chase-start.jpg` });
  // Eating stops once the scores lock.
  const huntMasses = s.actors.map((a) => a.mass);
  ok(huntMasses.every((m) => m === HUNT_MASS), `[solo ${run}] no mass gained during the hunt`);
  const curve = [];
  let shotAt = 0;
  for (let t = HUNT_AT + 30; t <= HUNT_AT + HUNT_SECONDS + 10; t += 30) {
    s = await stepTo(p, t);
    curve.push(`${Math.round(s.t)}s:${s.hunt?.caught.length ?? '?'}`);
    if (run === 1 && !shotAt && s.hunt?.caught.length) {
      shotAt = s.t;
      await p.screenshot({ path: `${shots}/test-first-catch.jpg` });
    }
    if (s.phase === 'results') break;
  }
  console.log(`      catches over the hunt: ${curve.join(' ')}`);
  ok(s.phase === 'results', `[solo ${run}] round ends in results [${s.phase} at ${s.t.toFixed(1)} s]`);
  ok(s.t <= HUNT_AT + HUNT_SECONDS + 2.5, // the test steps in 2 s chunks
     `[solo ${run}] round lasts at most ${HUNT_AT + HUNT_SECONDS} s [${s.t.toFixed(1)}]`);
  const st = s.standings ?? [];
  const caught = new Set(s.hunt.caught);
  ok(st.length === 6 && st.every((x) => (caught.has(x.id) ? x.mass === 0 && !x.alive : x.mass === locked[x.id])), `[solo ${run}] results: caught = 0, runners keep their locked score`);
  const firstCaught = st.findIndex((x) => caught.has(x.id));
  ok(firstCaught === -1 || st.slice(firstCaught).every((x) => caught.has(x.id)), `[solo ${run}] every runner ranks above every caught machine`);
  const runners = st.filter((x) => !caught.has(x.id));
  ok(runners.every((x, i) => i === 0 || runners[i - 1].mass >= x.mass), `[solo ${run}] runners ranked by locked score`);
  console.log(`      results: ${st.map((x) => `${x.rank}.${x.name} ${x.mass}${caught.has(x.id) ? '👻' : ''}`).join('  ')}`);
  if (run === 1) await p.screenshot({ path: `${shots}/test-results.jpg` });
  ok(errors.length === 0, `[solo ${run}] no page errors${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
  await ctx.close();
  return { caught: caught.size, curve };
}

// ── Duo over LocalNet ───────────────────────────────────────────────────────
async function duo() {
  const ctx = await browser.newContext();
  const room = `HW${Date.now() % 100000}`;
  const A = await openPage(ctx, `net=local&room=${room}&name=Hosty`);
  const B = await openPage(ctx, `net=local&room=${room}&name=Guesty`);
  const both = async (secs, chunk = 0.25) => {
    for (let t = 0; t < secs; t += chunk) {
      await A.p.evaluate((c) => window.__ARENA__.step(c), chunk);
      await B.p.evaluate((c) => window.__ARENA__.step(c), chunk);
      await new Promise((r) => setTimeout(r, 5));
    }
    return [await A.p.evaluate(() => window.__ARENA__.summary()), await B.p.evaluate(() => window.__ARENA__.summary())];
  };
  let [a, b] = await both(4);
  const hostPage = a.isHost ? A : B;
  const guestPage = a.isHost ? B : A;
  await guestPage.p.evaluate(() => window.__ARENA__.session.setReady(true));
  await both(2);
  await hostPage.p.evaluate(() => {
    const S = window.__ARENA__.session;
    S.setCity('halloween');
    S.start();
  });
  [a, b] = await both(5);
  ok(a.city === 'halloween' && b.city === 'halloween' && a.phase === 'playing' && b.phase === 'playing', `[duo] both pages playing Halloween [${a.phase}/${b.phase}]`);
  ok(a.actors.length === 6 && b.actors.length === 6, `[duo] 2 players + 4 AI on both pages [${a.actors.length}/${b.actors.length}]`);
  await A.p.evaluate(() => window.__ARENA__.autopilot(true));
  await B.p.evaluate(() => window.__ARENA__.autopilot(true));
  // Jump both clocks close to the hunt (the host's beacon re-syncs the guest's match time).
  for (const pg of [A, B]) await pg.p.evaluate(() => (window.__ARENA__.game().matchTime = 296));
  [a, b] = await both(6, 0.25);
  const ha = hostPage === A ? a : b;
  const gb = hostPage === A ? b : a;
  ok(ha.hunt.start !== null && gb.hunt.start === ha.hunt.start, `[duo] guest follows the host's hunt start [${ha.hunt.start} / ${gb.hunt.start}]`);
  ok(JSON.stringify(ha.hunt.scores) === JSON.stringify(gb.hunt.scores), '[duo] guest has the same locked scores');
  const meG = gb.actors.find((x) => x.id === gb.me);
  ok(meG && meG.mass === HUNT_MASS, `[duo] the guest shrank its own machine [${meG?.mass}]`);
  [a, b] = await both(6, 0.25);
  const H = hostPage === A ? a : b;
  const G = hostPage === A ? b : a;
  const drift = Math.max(...H.hunt.hunters.map((h, i) => Math.hypot(h.x - G.hunt.hunters[i].x, h.z - G.hunt.hunters[i].z)));
  ok(G.hunt.stage === 'chase' && drift < 4, `[duo] guest mirrors the villains (max drift ${drift.toFixed(2)} m)`);
  // Put the guest's machine right in front of a villain: the host decides the catch, both pages agree.
  // Egg Valley: the host drives up to her hiding place and honks; both pages agree on who woke her,
  // the host's machine turns invisible (the bosses ignore it) and its locked score gains 1/3.
  {
    const egg = H.hunt.egg;
    ok(egg && Math.hypot(egg.x, egg.z) > 30 && egg.x === G.hunt.egg.x && egg.z === G.hunt.egg.z, `[duo] Egg Valley hides at the same spot on both pages, outside the plaza [${egg?.x?.toFixed(1)}, ${egg?.z?.toFixed(1)}]`);
    // Park next to her and honk (the autopilot would drive away between steps).
    for (let i = 0; i < 20; i++) {
      const st = await hostPage.p.evaluate(({ x, z, i }) => {
        const g = window.__ARENA__.game();
        g.local.x = x + 1.5;
        g.local.z = z;
        g.local.speed = 0;
        if (i % 5 === 0) g.emote(6);
        return { by: g.hunt.egg.by, stage: g.hunt.stage(), d: Math.hypot(g.local.x - x, g.local.z - z) };
      }, { ...egg, i });
      if (st.by) break;
      if (i === 19) console.log('      egg debug', JSON.stringify(st));
      await both(0.1, 0.1);
    }
    [a, b] = await both(0.5, 0.1);
    const H3 = hostPage === A ? a : b;
    const G3 = hostPage === A ? b : a;
    ok(H3.hunt.egg.by === H3.me && G3.hunt.egg.by === H3.me, `[duo] honking next to her wakes her, both pages agree [${H3.hunt.egg.by} / ${G3.hunt.egg.by}]`);
    ok(H3.hunt.egg.stealth.includes(H3.me) && G3.hunt.egg.stealth.includes(H3.me), '[duo] the waker is invisible on both pages');
    ok(Math.abs((H3.hunt.bonus[H3.me] ?? 0) - 1 / 3) < 1e-9 && Math.abs((G3.hunt.bonus[H3.me] ?? 0) - 1 / 3) < 1e-9, '[duo] +1/3 score bonus on both pages');
    const chasing = H3.hunt.hunters.filter((h) => h.target === H3.me).length;
    [a, b] = await both(1, 0.25);
    const H4 = hostPage === A ? a : b;
    ok(H4.hunt.hunters.every((h) => h.target !== H4.me), `[duo] no boss targets the invisible machine [${chasing} before, ${H4.hunt.hunters.filter((h) => h.target === H4.me).length} after]`);
  }
  // Keep the guest's machine parked on villain 0 (as the host sees it) until the host decides.
  for (let i = 0; i < 40; i++) {
    const v = (await hostPage.p.evaluate(() => window.__ARENA__.summary())).hunt.hunters[0];
    await guestPage.p.evaluate(({ x, z }) => {
      const g = window.__ARENA__.game();
      if (!g.local?.alive) return;
      g.local.x = x + 0.2;
      g.local.z = z;
      g.local.invulnerableUntil = 0;
    }, v);
    [a, b] = await both(0.1, 0.1);
    const G = hostPage === A ? b : a;
    if (G.hunt.caught.includes(G.me)) break;
  }
  [a, b] = await both(0.5, 0.1);
  const H2 = hostPage === A ? a : b;
  const G2 = hostPage === A ? b : a;
  ok(H2.hunt.caught.includes(G2.me) && G2.hunt.caught.includes(G2.me), `[duo] host catches the guest and the guest agrees [host ${H2.hunt.caught.length}, guest ${G2.hunt.caught.length}]`);
  const meG2 = G2.actors.find((x) => x.id === G2.me);
  ok(meG2 && !meG2.alive && meG2.out, '[duo] the caught guest is out (spectating)');
  await guestPage.p.screenshot({ path: `${shots}/test-duo-guest-caught.jpg` });
  ok(A.errors.length === 0 && B.errors.length === 0, `[duo] no page errors${[...A.errors, ...B.errors].slice(0, 3).join(' | ')}`);
  await ctx.close();
}

try {
  if (!only || only === 'solo') {
    const results = [];
    for (let r = 1; r <= runs; r++) results.push(await solo(r));
    if (runs > 1) console.log(`      caught per round: ${results.map((x) => x.caught).join(', ')} (of 6)`);
  }
  if (!only || only === 'duo') await duo();
} finally {
  await browser.close();
  await server.close();
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nhalloween-test: all checks passed');
process.exit(failures ? 1 : 0);
