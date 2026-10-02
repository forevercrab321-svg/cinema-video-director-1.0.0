#!/usr/bin/env node
// QA (release gate, Halloween update): edge cases the happy-path test does not cover.
//   leak      solo: 3 Halloween rounds back to back (chase + Egg Valley woken + ghost materials each
//             time, then Rematch) → renderer.info.memory and leftover villain / egg / backpack
//             objects per round
//   switch    lobby Halloween preview → Paris: fog, lights, atmosphere root, scene.environment
//             compared against a page that opened straight on Paris
//   honkcatch solo: honk next to Egg Valley in the very frame a boss reaches you
//   hostleave duo over LocalNet: the host's page closes during the chase → guest takes over,
//             villains keep hunting, egg stays put, no duplicate catches
//   falsewake solo: honk far away, later get stunned (💫 bubble) next to her without honking
//   guesthonk duo over LocalNet: the GUEST parks next to Egg Valley and honks
//   hidden    duo over LocalNet: the guest's tab is hidden 6 s during the chase, then comes back
//   node tools/qa-halloween-edge.mjs [--only leak,switch,honkcatch,hostleave,hidden]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const only = arg('--only', 'leak,switch,honkcatch,stealth10,falsewake,guesthonk,hostleave,hidden').split(',');
const out = resolve(root, 'renders/review/qa/edge');
mkdirSync(out, { recursive: true });
const vite = await import('vite');
const server = await vite.createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 5207, strictPort: false, hmr: false } });
await server.listen();
const base = `${server.resolvedUrls.local[0]}game/`;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let failures = 0;
const results = {};
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openPage(ctx, query, vp = { width: 960, height: 540 }) {
  const p = await ctx.newPage({ viewport: vp });
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => m.type() === 'error' && !/favicon|404|Failed to load resource|supabase/i.test(m.text()) && errors.push(m.text()));
  await p.goto(`${base}?mode=arena&test=1&quality=low&lang=en&${query}`);
  await p.waitForFunction(() => window.__ARENA__?.ready, null, { timeout: 180000 });
  return { p, errors };
}
const step = (p, s) => p.evaluate((x) => window.__ARENA__.step(x), s);
async function stepTo(p, t, chunk = 1) {
  for (;;) {
    const s = await step(p, chunk);
    if (s.t >= t || s.phase === 'results' || s.phase === 'lobby') return s;
  }
}
/** Memory + scene census (villains, egg girl, backpacks, ghost-cloned materials). */
const census = (p) =>
  p.evaluate(() => {
    const i = window.__GROW_RENDERER__?.info;
    const g = window.__ARENA__.game() ?? window.__ARENA__.preview();
    const names = {};
    let transparentClones = 0;
    const mats = new Set();
    g?.scene.traverse((o) => {
      if (/Hunter|Egg|Backpack/i.test(o.name)) names[o.name] = (names[o.name] ?? 0) + 1;
      if (o.isMesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        mats.add(m.uuid);
        if (m.transparent && m.opacity <= 0.36 && m.depthWrite === false) transparentClones++;
      }
    });
    return { textures: i?.memory.textures, geometries: i?.memory.geometries, programs: i?.programs?.length, sceneChildren: g?.scene.children.length, materials: mats.size, transparentClones, names };
  });

// ── leak ─────────────────────────────────────────────────────────────────────
async function leak() {
  const ctx = await browser.newContext();
  const { p, errors } = await openPage(ctx, 'net=solo&name=Leak');
  await p.evaluate(() => { const S = window.__ARENA__.session; S.setCity('halloween'); });
  await step(p, 0.5);
  const rows = [{ at: 'lobby', ...(await census(p)) }];
  for (let round = 1; round <= 3; round++) {
    if (round === 1) await p.evaluate(() => window.__ARENA__.session.start());
    else await p.evaluate(() => window.__ARENA__.session.rematch());
    await stepTo(p, 4);
    await p.evaluate(() => (window.__ARENA__.game().matchTime = 299.5));
    let s = await stepTo(p, 307, 0.5);
    const egg = s.hunt.egg;
    for (let i = 0; i < 6 && !s.hunt.egg.by; i++) {
      await p.evaluate(({ x, z, i }) => { const g = window.__ARENA__.game(); if (!g.local?.alive) return; g.local.x = x + 1.5; g.local.z = z; g.local.speed = 0; if (i % 3 === 0) g.emote(6); }, { ...egg, i });
      s = await step(p, 0.2);
    }
    await p.evaluate(() => window.__ARENA__.render());
    const mid = await census(p);
    rows.push({ at: `round${round}-stealth`, eggBy: !!s.hunt.egg.by, ...mid });
    // End the round, then (rounds 1–2) Rematch in the next iteration.
    await p.evaluate(() => { const g = window.__ARENA__.game(); g.matchTime = g.hunt.endsAt() - 0.2; });
    s = await stepTo(p, 9999, 0.5);
    await step(p, 0.5);
    await p.evaluate(() => window.__ARENA__.render());
    rows.push({ at: `round${round}-results`, phase: s.phase, ...(await census(p)) });
  }
  await p.evaluate(() => window.__ARENA__.session.rematch());
  await stepTo(p, 2);
  await p.evaluate(() => window.__ARENA__.render());
  rows.push({ at: 'round4-start', ...(await census(p)) });
  for (const r of rows) console.log(`      ${r.at.padEnd(18)} tex ${r.textures} geo ${r.geometries} prog ${r.programs} mats ${r.materials} ghostMats ${r.transparentClones} children ${r.sceneChildren} egg ${r.eggBy ?? ''} ${JSON.stringify(r.names)}`);
  const st = rows.filter((r) => r.at.endsWith('stealth'));
  ok(st.every((r) => r.eggBy), '[leak] Egg Valley woken in each of the 3 rounds');
  ok(st[2].geometries - st[0].geometries <= 8 && st[2].textures - st[0].textures <= 2, `[leak] geometries/textures stable across rounds at the same moment (geo ${st.map((r) => r.geometries).join('→')}, tex ${st.map((r) => r.textures).join('→')})`);
  ok(st[2].programs - st[1].programs <= 0, `[leak] shader programs plateau after round 2 (${st.map((r) => r.programs).join('→')})`);
  const r4 = rows.at(-1);
  ok(!r4.transparentClones || r4.transparentClones < st[0].transparentClones, `[leak] no ghost materials left at the start of round 4 (${r4.transparentClones})`);
  ok(errors.length === 0, `[leak] no page errors ${errors.slice(0, 3).join(' | ')}`);
  results.leak = rows;
  await ctx.close();
}

// ── switch ──────────────────────────────────────────────────────────────────
const sceneLook = (p) =>
  p.evaluate(() => {
    const g = window.__ARENA__.preview() ?? window.__ARENA__.game();
    const sc = g.scene;
    const lights = [];
    let fxRoots = 0;
    sc.traverse((o) => {
      if (o.isLight) lights.push(o.type);
      if (/halloween|atmos|fx/i.test(o.name)) fxRoots++;
    });
    return { city: g.city.id, fog: sc.fog ? { type: sc.fog.type ?? sc.fog.constructor.name, color: sc.fog.color.getHexString(), near: sc.fog.near, far: sc.fog.far, density: sc.fog.density } : null, bg: sc.background?.isColor ? sc.background.getHexString() : (sc.background ? 'tex' : null), lights: lights.sort().join(','), nLights: lights.length, fxRoots, atmosphere: !!g.atmosphere, children: sc.children.length, envIntensity: sc.environmentIntensity };
  });
async function sw() {
  const ctx = await browser.newContext();
  const a = await openPage(ctx, 'net=solo&name=Sw');
  await a.p.evaluate(() => window.__ARENA__.session.setCity('halloween'));
  await step(a.p, 0.5);
  const hw = await sceneLook(a.p);
  await a.p.evaluate(() => window.__ARENA__.session.setCity('paris'));
  await step(a.p, 0.5);
  await a.p.evaluate(() => window.__ARENA__.render());
  await a.p.screenshot({ path: `${out}/switch-halloween-to-paris.jpg`, type: 'jpeg', quality: 75 });
  const after = await sceneLook(a.p);
  const ctx2 = await browser.newContext();
  const b = await openPage(ctx2, 'net=solo&name=Sw');
  await b.p.evaluate(() => window.__ARENA__.session.setCity('paris'));
  await step(b.p, 0.5);
  await b.p.evaluate(() => window.__ARENA__.render());
  await b.p.screenshot({ path: `${out}/switch-fresh-paris.jpg`, type: 'jpeg', quality: 75 });
  const fresh = await sceneLook(b.p);
  console.log(`      halloween ${JSON.stringify(hw)}\n      →paris    ${JSON.stringify(after)}\n      fresh     ${JSON.stringify(fresh)}`);
  const same = (k) => JSON.stringify(after[k]) === JSON.stringify(fresh[k]);
  ok(after.city === 'paris' && !after.atmosphere && same('fog') && same('lights') && same('bg') && same('children') && same('envIntensity'), '[switch] Halloween → Paris preview matches a fresh Paris preview (fog, lights, background, children, env)');
  // Also: start a Paris round after the switch and compare with the fresh page's Paris round.
  for (const pg of [a.p, b.p]) { await pg.evaluate(() => window.__ARENA__.session.start()); await stepTo(pg, 3); }
  const ra = await sceneLook(a.p);
  const rb = await sceneLook(b.p);
  console.log(`      round after switch ${JSON.stringify(ra)}\n      round fresh        ${JSON.stringify(rb)}`);
  ok(JSON.stringify({ ...ra, children: 0 }) === JSON.stringify({ ...rb, children: 0 }) && Math.abs(ra.children - rb.children) <= 0, '[switch] Paris round after a Halloween preview matches a fresh Paris round');
  ok(a.errors.length === 0 && b.errors.length === 0, `[switch] no page errors ${[...a.errors, ...b.errors].slice(0, 3).join(' | ')}`);
  results.switch = { hw, after, fresh, ra, rb };
  await ctx.close();
  await ctx2.close();
}

// ── honkcatch ───────────────────────────────────────────────────────────────
async function honkcatch() {
  const ctx = await browser.newContext();
  const { p, errors } = await openPage(ctx, 'net=solo&name=Honk');
  await p.evaluate(() => { const S = window.__ARENA__.session; S.setCity('halloween'); S.start(); });
  await stepTo(p, 3);
  await p.evaluate(() => (window.__ARENA__.game().matchTime = 299.5));
  await stepTo(p, 308, 0.5);
  const r = await p.evaluate(() => {
    const g = window.__ARENA__.game();
    const h = g.hunt;
    const me = g.local;
    me.x = h.egg.x + 1.5;
    me.z = h.egg.z;
    me.speed = 0;
    me.invulnerableUntil = 0;
    for (const v of h.hunters) { v.x = me.x; v.z = me.z; v.lungeUntil = 0; }
    g.emote(6);
    return { stage: h.stage() };
  });
  const s = await step(p, 1 / 30);
  await step(p, 0.5);
  const s2 = await p.evaluate(() => window.__ARENA__.summary());
  const caught = s2.hunt.caught.includes(s2.me);
  const woke = s2.hunt.egg.by === s2.me;
  console.log(`      stage ${r.stage} → caught ${caught}, woke ${woke}, stealth ${s2.hunt.egg.stealth.includes(s2.me)}, bonus ${s2.hunt.bonus[s2.me] ?? 0}`);
  ok(caught !== woke, `[honkcatch] exactly one outcome when honking in the frame a boss arrives (caught ${caught}, woke ${woke})`);
  ok(!(caught && s2.hunt.egg.stealth.includes(s2.me)), '[honkcatch] a caught machine is not left invisible');
  ok(errors.length === 0, `[honkcatch] no page errors ${errors.slice(0, 3).join(' | ')}`);
  results.honkcatch = { caught, woke };
  void s;
  await ctx.close();
}

// ── duo helpers ─────────────────────────────────────────────────────────────
async function duoToChase(tag) {
  const ctx = await browser.newContext();
  const room = `${tag}${Date.now() % 100000}`;
  const A = await openPage(ctx, `net=local&room=${room}&name=Hosty`);
  const B = await openPage(ctx, `net=local&room=${room}&name=Guesty`);
  const pages = [A, B];
  const both = async (secs, chunk = 0.25, list = pages) => {
    for (let t = 0; t < secs; t += chunk) {
      for (const pg of list) await step(pg.p, chunk);
      await sleep(5);
    }
    return Promise.all(list.map((pg) => pg.p.evaluate(() => window.__ARENA__.summary())));
  };
  let [a] = await both(4);
  const host = a.isHost ? A : B;
  const guest = a.isHost ? B : A;
  await guest.p.evaluate(() => window.__ARENA__.session.setReady(true));
  await both(2);
  await host.p.evaluate(() => { const S = window.__ARENA__.session; S.setCity('halloween'); S.start(); });
  await both(5);
  for (const pg of pages) await pg.p.evaluate(() => window.__ARENA__.autopilot(true));
  for (const pg of pages) await pg.p.evaluate(() => (window.__ARENA__.game().matchTime = 296));
  await both(12);
  return { ctx, A, B, host, guest, both };
}



// ── stealth10 ───────────────────────────────────────────────────────────────
async function stealth10() {
  const ctx = await browser.newContext();
  const { p, errors } = await openPage(ctx, 'net=solo&name=Ghost');
  await p.evaluate(() => { const S = window.__ARENA__.session; S.setCity('halloween'); S.start(); });
  await stepTo(p, 3);
  await p.evaluate(() => (window.__ARENA__.game().matchTime = 299.5));
  await stepTo(p, 308, 0.5);
  let s;
  for (let i = 0; i < 6; i++) {
    await p.evaluate(({ i }) => { const g = window.__ARENA__.game(); for (const v of g.hunt.hunters) { v.x = 0; v.z = 0; } const me = g.local; me.x = g.hunt.egg.x + 1.5; me.z = g.hunt.egg.z; me.speed = 0; if (i % 3 === 0) g.emote(6); }, { i });
    s = await step(p, 0.2);
    if (s.hunt.egg.by) break;
  }
  const egAt = await p.evaluate(() => window.__ARENA__.game().hunt.egg.at);
  let caughtAt = null;
  for (let i = 0; i < 70 && caughtAt === null; i++) {
    const t = await p.evaluate(() => { const g = window.__ARENA__.game(); if (!g?.local?.alive) return null; const me = g.local; for (const v of g.hunt.hunters) { v.x = me.x; v.z = me.z; v.restUntil = 0; } return g.matchTime; });
    if (t === null) break;
    const x = await step(p, 0.2);
    if (x.hunt?.caught.includes(x.me)) caughtAt = x.t;
  }
  console.log(`      woke at ${egAt}, bosses parked on the machine from then on, caught at ${caughtAt}`);
  ok(s.hunt.egg.by && caughtAt !== null && caughtAt >= egAt + 10 - 0.05 && caughtAt <= egAt + 10.6, `[stealth10] invisible for the full 10 s, catchable right after (caught at +${caughtAt === null ? '—' : (caughtAt - egAt).toFixed(2)} s)`);
  ok(errors.length === 0, `[stealth10] no page errors ${errors.slice(0, 3).join(' | ')}`);
  results.stealth10 = { egAt, caughtAt };
  await ctx.close();
}

// ── falsewake ───────────────────────────────────────────────────────────────
async function falsewake() {
  const ctx = await browser.newContext();
  const { p, errors } = await openPage(ctx, 'net=solo&name=Stun');
  await p.evaluate(() => { const S = window.__ARENA__.session; S.setCity('halloween'); S.start(); });
  await stepTo(p, 3);
  await p.evaluate(() => (window.__ARENA__.game().matchTime = 299.5));
  await stepTo(p, 307, 0.5);
  // Honk far from her (at the plaza edge), let the bubble expire.
  await p.evaluate(() => { const g = window.__ARENA__.game(); for (const v of g.hunt.hunters) { v.x = 0; v.z = 0; } g.emote(6); });
  await step(p, 3);
  const r = await p.evaluate(() => {
    const g = window.__ARENA__.game();
    const me = g.local;
    for (const v of g.hunt.hunters) { v.x = 0; v.z = 0; }
    me.x = g.hunt.egg.x + 1.5; me.z = g.hunt.egg.z; me.speed = 0;
    me.stunUntil = g.matchTime + 1; // stunned (e.g. dashed into a tombstone): the game shows 💫, no honk
    return { emote: me.emote, by: g.hunt.egg.by };
  });
  const s = await step(p, 0.3);
  console.log(`      last emote ${r.emote}, stunned next to her without honking → egg.by ${s.hunt.egg.by}`);
  ok(!s.hunt.egg.by, '[falsewake] a stun bubble next to her does not count as a honk');
  ok(errors.length === 0, `[falsewake] no page errors ${errors.slice(0, 3).join(' | ')}`);
  results.falsewake = { lastEmote: r.emote, by: s.hunt.egg.by };
  await ctx.close();
}

// ── guesthonk ───────────────────────────────────────────────────────────────
async function guesthonk() {
  const { ctx, host, guest, both } = await duoToChase('GH');
  let [h, g] = await both(0.5, 0.25, [host, guest]);
  const egg = g.hunt.egg;
  for (const pg of [host, guest]) await pg.p.evaluate(() => window.__ARENA__.autopilot(false));
  let woke = null;
  for (let i = 0; i < 30; i++) {
    // Keep the bosses off both machines for the experiment (host simulates them).
    await host.p.evaluate(() => { const gm = window.__ARENA__.game(); for (const v of gm.hunt.hunters) { v.x = 0; v.z = 0; } });
    await guest.p.evaluate(({ x, z, i }) => { const gm = window.__ARENA__.game(); if (!gm.local?.alive) return; gm.local.x = x + 1.5; gm.local.z = z; gm.local.speed = 0; if (i % 6 === 0) gm.emote(6); }, { ...egg, i });
    [h, g] = await both(0.1, 0.1, [host, guest]);
    if (h.hunt.egg.by) { woke = h.hunt.egg.by; break; }
  }
  const remote = await host.p.evaluate((gid) => { const a = window.__ARENA__.game().byId.get(gid); return a ? { x: +a.x.toFixed(1), z: +a.z.toFixed(1), emote: a.emote, emoteSeq: a.emoteSeq, say: a.say } : null; }, g.me);
  console.log(`      guest ${g.me} honked 5× at 1.5 m; host sees guest ${JSON.stringify(remote)} egg (${egg.x}, ${egg.z}); egg.by host=${h.hunt.egg.by} guest=${g.hunt.egg.by}`);
  ok(woke === g.me, `[guesthonk] a guest honking next to Egg Valley wakes her (by ${woke})`);
  await guest.p.evaluate(() => window.__ARENA__.render());
  await guest.p.screenshot({ path: `${out}/guesthonk-guest.jpg`, type: 'jpeg', quality: 75 });
  ok(host.errors.length === 0 && guest.errors.length === 0, `[guesthonk] no page errors ${[...host.errors, ...guest.errors].slice(0, 3).join(' | ')}`);
  results.guesthonk = { woke, remote, egg };
  await ctx.close();
}

async function hostleave() {
  const { ctx, host, guest, both } = await duoToChase('HL');
  let [h, g] = await both(1, 0.25, [host, guest]);
  ok(h.hunt.stage === 'chase' && g.hunt.stage === 'chase', `[hostleave] both in the chase [${h.hunt.stage}/${g.hunt.stage}] t=${h.t.toFixed(1)}`);
  const eggBefore = g.hunt.egg;
  const caughtBefore = g.hunt.caught.slice();
  const guestId = g.me;
  await host.p.close();
  // The guest keeps stepping; LocalNet expires a peer after ~4 s of silence ('bye' on pagehide is faster).
  let took = null;
  const t0 = Date.now();
  const huntersTrack = [];
  for (let i = 0; i < 400; i++) {
    [g] = await both(0.25, 0.25, [guest]);
    huntersTrack.push(g.hunt.hunters.map((x) => [x.x, x.z]));
    if (g.isHost && took === null) took = (Date.now() - t0) / 1000;
    if (took !== null && huntersTrack.length > 40) break;
    await sleep(20);
  }
  ok(took !== null, `[hostleave] guest became host after ${took?.toFixed(1)} s real time`);
  const last = huntersTrack.at(-1);
  const prev = huntersTrack.at(-20);
  const moved = last && prev ? Math.max(...last.map((p, i) => Math.hypot(p[0] - prev[i][0], p[1] - prev[i][1]))) : 0;
  let jump = 0;
  for (let i = 1; i < huntersTrack.length; i++) jump = Math.max(jump, ...huntersTrack[i].map((p, k) => Math.hypot(p[0] - huntersTrack[i - 1][k][0], p[1] - huntersTrack[i - 1][k][1])));
  ok(g.hunt.stage === 'chase' && moved > 1, `[hostleave] villains keep hunting on the new host (moved ${moved.toFixed(1)} m in 5 s game time, max per-step jump ${jump.toFixed(2)} m)`);
  ok(g.hunt.egg.x === eggBefore.x && g.hunt.egg.z === eggBefore.z, '[hostleave] Egg Valley stays in her spot');
  ok(caughtBefore.every((id) => g.hunt.caught.includes(id)), '[hostleave] earlier catches survive the migration');
  // Catch the (new host) guest: exactly one catch entry for it.
  for (let i = 0; i < 30; i++) {
    await guest.p.evaluate(() => { const gm = window.__ARENA__.game(); const me = gm.local; if (!me?.alive) return; const v = gm.hunt.hunters[0]; me.x = v.x + 0.2; me.z = v.z; me.invulnerableUntil = 0; });
    [g] = await both(0.1, 0.1, [guest]);
    if (g.hunt.caught.includes(guestId)) break;
  }
  [g] = await both(1, 0.25, [guest]);
  const hc = await guest.p.evaluate(() => window.__ARENA__.session.match.hc ?? []);
  const slots = hc.map((r) => r[0]);
  ok(g.hunt.caught.includes(guestId), '[hostleave] the new host can still be caught');
  ok(new Set(slots).size === slots.length, `[hostleave] no duplicate catches in the match message (hc slots ${JSON.stringify(slots)})`);
  console.log(`      phase after: ${g.phase}, caught ${g.hunt.caught.length}, actors ${g.actors.map((a) => `${a.name}${a.alive ? '' : '✗'}`).join(' ')}`);
  await guest.p.screenshot({ path: `${out}/hostleave-guest.jpg`, type: 'jpeg', quality: 75 });
  ok(guest.errors.length === 0, `[hostleave] no page errors on the guest ${guest.errors.slice(0, 3).join(' | ')}`);
  results.hostleave = { took, moved, jump, hc };
  await ctx.close();
}

async function hidden() {
  const { ctx, host, guest, both } = await duoToChase('HD');
  let [h, g] = await both(1, 0.25, [host, guest]);
  const gid = g.me;
  const scoreBefore = h.hunt.scores[gid];
  // Hide the guest's tab: no frames (we stop stepping it) and the page fires visibilitychange.
  await guest.p.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 6500) { [h] = await both(0.25, 0.25, [host]); await sleep(30); }
  const hostView = h.actors.find((a) => a.id === gid);
  console.log(`      host's view of the hidden guest after 6.5 s: ${JSON.stringify(hostView)} caught=${h.hunt.caught.includes(gid)}`);
  await guest.p.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  [h, g] = await both(6, 0.25, [host, guest]);
  const meG = g.actors.find((a) => a.id === gid);
  const meH = h.actors.find((a) => a.id === gid);
  console.log(`      after return: guest sees itself ${JSON.stringify(meG)}; host sees ${JSON.stringify(meH)}; phase ${g.phase}/${h.phase}`);
  await guest.p.evaluate(() => window.__ARENA__.render());
  await guest.p.screenshot({ path: `${out}/hidden-guest-after-return.jpg`, type: 'jpeg', quality: 75 });
  // End and look at the standings.
  await host.p.evaluate(() => { const gm = window.__ARENA__.game(); gm.matchTime = gm.hunt.endsAt() - 0.3; });
  [h, g] = await both(3, 0.25, [host, guest]);
  const st = h.standings ?? [];
  const row = st.find((x) => x.id === gid);
  console.log(`      standings: ${st.map((x) => `${x.rank}.${x.name} ${x.mass}${x.alive ? '' : '✗'}`).join('  ')}`);
  ok(meG && meH && meG.alive === meH.alive, `[hidden] guest and host agree whether the guest is still running after a 6.5 s hide (guest alive=${meG?.alive}, host alive=${meH?.alive})`);
  ok(!!row, `[hidden] the hidden player appears in the results (rank ${row?.rank}, score ${row?.mass}, locked ${scoreBefore})`);
  results.hidden = { hostView, meG, meH, standings: st, scoreBefore };
  ok(host.errors.length === 0 && guest.errors.length === 0, `[hidden] no page errors ${[...host.errors, ...guest.errors].slice(0, 3).join(' | ')}`);
  await ctx.close();
}

try {
  if (only.includes('leak')) await leak();
  if (only.includes('switch')) await sw();
  if (only.includes('honkcatch')) await honkcatch();
  if (only.includes('stealth10')) await stealth10();
  if (only.includes('falsewake')) await falsewake();
  if (only.includes('guesthonk')) await guesthonk();
  if (only.includes('hostleave')) await hostleave();
  if (only.includes('hidden')) await hidden();
} catch (e) {
  console.log('EXCEPTION', e);
  failures++;
} finally {
  writeFileSync(`${out}/edge-report.json`, JSON.stringify(results, null, 1));
  await browser.close();
  await server.close();
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nqa-halloween-edge: all checks passed');
process.exit(failures ? 1 : 0);
