// Online-room authority test (deterministic, no network). Audit 2026-10-01, netcode batch 1.
//
// Up to four pages run the real game/src/net/SupabaseNet.ts + HostLease.ts + arena/ArenaSession.ts
// + arena/massLedger.ts against:
//   · the fake Supabase Realtime of tools/net-presence-test.mjs (per-message latency, self-echo),
//     with per-page visibility (a hidden page stops its frame loop and says goodbye) and per-page
//     receive filters (lost messages);
//   · a fake `room_host` RPC with the semantics of supabase/migrations/0006_room_host.sql
//     (mode "lease"), or no RPC at all (mode "fallback": 0006 not applied, client election only);
//   · a small stand-in for ArenaGame (objects, grants, eats, presence wire, MassLedger).
// A virtual clock runs each scenario; every check is sampled, and the script exits 1 on any failure.
//
// Scenarios (each in both modes unless noted):
//   ready      guest's Ready survives the host's 1 s lobby beacons; the host can start
//   tabout     host hidden 3 s mid-round → one host at a time, everyone agrees, round continues
//   longaway   host hidden 8 s → a new host carries on; the old one comes back as a guest
//   newcomer   a later joiner with the lowest id neither takes over nor resets the city / bots
//   lostgrant  a guest's grants are dropped → its re-claim gets the same grant, mass credited once
//   losteaten  the victim never receives 'eaten' → the beacon repairs it, applied exactly once
//   forgery    nobody can make the host accept a message in its own name; with the lease also
//              unsigned / badly signed / replayed host messages and a rival claim are ignored
//   masslie    honest growth seen exactly (also by a guest that missed the grants: beacon caps);
//              then the guest reports 99 999 kg and 9 kills → host and other guests clamp it
//
// Usage: node tools/net-room-test.mjs [--only name] [--mode lease|fallback] [--seed N] [--verbose]
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const ONLY = arg('--only', null);
const MODES = arg('--mode', null) ? [arg('--mode')] : ['lease', 'fallback'];
const SEED = Number(arg('--seed', 11));
const VERBOSE = process.argv.includes('--verbose');

// ── Virtual clock (timers remember which page created them) ──
const realImmediate = setImmediate;
let now = 1_700_000_000_000;
const t0 = now;
let seq = 0;
const timers = new Map();
let current = null; // the page whose code is running
const addTimer = (fn, ms, every) => {
  const id = ++seq;
  timers.set(id, { at: now + Math.max(0, ms | 0), fn, every: every ? Math.max(1, ms | 0) : 0, id, page: current });
  return id;
};
globalThis.setTimeout = (fn, ms = 0) => addTimer(fn, ms, false);
globalThis.setInterval = (fn, ms = 0) => addTimer(fn, ms, true);
globalThis.clearTimeout = globalThis.clearInterval = (id) => void timers.delete(typeof id === 'object' ? id?.id : id);
Date.now = () => now;
let forceId = null;
Object.defineProperty(globalThis, 'performance', {
  value: { now: () => now - t0, getEntriesByType: () => [{ type: forceId ? 'reload' : 'navigate' }] },
  configurable: true,
});
const flush = () => new Promise((r) => realImmediate(r));
async function advanceTo(target) {
  for (;;) {
    let next = null;
    for (const t of timers.values()) if (t.at <= target && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
    if (!next) break;
    now = next.at;
    if (next.every) next.at += next.every;
    else timers.delete(next.id);
    current = next.page;
    try {
      next.fn();
    } catch (e) {
      console.error('timer threw', e);
    }
    await flush();
  }
  now = target;
  await flush();
}

// ── Browser globals (per page: listeners, visibility) ──
let building = null;
const listen = (kind) => (type, fn) => building?.listeners.push({ kind, type, fn });
globalThis.window = globalThis;
globalThis.addEventListener = listen('window');
globalThis.document = {
  get visibilityState() {
    return current?.hidden ? 'hidden' : 'visible';
  },
  addEventListener: listen('document'),
};
globalThis.location = { search: '', href: 'http://localhost/game/', hostname: 'localhost' };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.sessionStorage = { getItem: () => forceId, setItem() {}, removeItem() {} };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'en', languages: ['en'] }, configurable: true });

// ── Deterministic RNG (latency) ──
let rs = SEED >>> 0;
const rand = () => {
  rs = (rs + 0x6d2b79f5) >>> 0;
  let t = rs;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ── Fake Supabase Realtime (broadcast only: the room runs on broadcast, see SupabaseNet) ──
const hub = {
  joined: new Map(),
  /** (receiverPage, event, payload) → true to drop that delivery. */
  drop: null,
  latency: () => 25 + rand() * 50,
  set(topic) {
    if (!this.joined.has(topic)) this.joined.set(topic, new Set());
    return this.joined.get(topic);
  },
};
class FakeChannel {
  constructor(topic, params, client) {
    this.topic = `realtime:${topic}`;
    this.client = client;
    this.state = 'closed';
    this.bindings = [];
    this.closeHooks = [];
    this.self = !!params?.config?.broadcast?.self;
    this.channelAdapter = { getChannel: () => this };
  }
  on(type, filter, cb) {
    this.bindings.push({ type, event: filter?.event, cb });
    return this;
  }
  subscribe(cb) {
    if (this.state !== 'closed') return this;
    this.state = 'joining';
    this.closeHooks.push(() => cb?.('CLOSED'));
    setTimeout(() => {
      if (this.state !== 'joining') return;
      this.state = 'joined';
      hub.set(this.topic).add(this);
      cb?.('SUBSCRIBED');
    }, 40 + rand() * 60);
    return this;
  }
  send({ event, payload: live }) {
    const payload = JSON.parse(JSON.stringify(live)); // serialised at send time, like the socket
    const sender = this.client.page;
    if (sender) sender.sent[event] = (sender.sent[event] ?? 0) + 1;
    for (const ch of hub.set(this.topic)) {
      if (ch === this && !this.self) continue;
      const to = ch.client.page;
      setTimeout(() => {
        if (ch.state !== 'joined') return;
        if (hub.drop?.(to, event, payload)) return;
        current = to;
        for (const b of ch.bindings) if (b.type === 'broadcast' && b.event === event) b.cb({ type: 'broadcast', event, payload: JSON.parse(JSON.stringify(payload)) });
      }, hub.latency());
    }
    return Promise.resolve('ok');
  }
  unsubscribe() {
    this.state = 'closed';
    hub.set(this.topic).delete(this);
    return Promise.resolve('ok');
  }
}
class FakeRealtime {
  constructor(page) {
    this.page = page;
    this.channels = [];
    this.vsn = '1.0.0';
    this.socketAdapter = { getSocket: () => ({ remove() {} }) };
  }
  getChannels() {
    return this.channels;
  }
  channel(topic, params) {
    const found = this.channels.find((c) => c.topic === `realtime:${topic}`);
    if (found) return found;
    const ch = new FakeChannel(topic, params, this);
    this.channels.push(ch);
    return ch;
  }
  async removeChannel(ch) {
    await ch.unsubscribe();
    this.channels = this.channels.filter((c) => c !== ch);
    return 'ok';
  }
  _remove(ch) {
    this.channels = this.channels.filter((c) => c !== ch);
  }
  current() {
    return this.channels.find((c) => c.state === 'joined');
  }
}

// ── Fake room_host RPC: the semantics of supabase/migrations/0006_room_host.sql ──
const LEASE_MS = 6000;
let leases = new Map();
let rpcMode = 'lease';
const rpcLog = [];
function roomHost(uid, a) {
  const code = String(a.p_room ?? '').toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(code) || !/^p-[a-z0-9]{6,16}$/.test(a.p_peer ?? '')) return { error: 'bad_args' };
  let row = leases.get(code);
  if (uid && (a.p_claim || a.p_release)) {
    if (row && row.peer === a.p_peer && row.uid === uid) {
      if (a.p_release) row.seen = now - 3_600_000;
      else if (row.seen >= now - LEASE_MS) {
        if (row.key !== a.p_key) row.term++;
        row.key = a.p_key;
        row.seen = now;
      } else Object.assign(row, { key: a.p_key, term: row.term + 1, seen: now });
    } else if (a.p_claim && !a.p_release) {
      if (!row) leases.set(code, (row = { peer: a.p_peer, uid, key: a.p_key, term: 1, seen: now }));
      else if (row.seen < now - LEASE_MS) Object.assign(row, { peer: a.p_peer, uid, key: a.p_key, term: row.term + 1, seen: now });
    }
  }
  row = leases.get(code);
  if (!row) return { peer: null, term: 0 };
  if (row.seen < now - LEASE_MS) return { peer: null, term: row.term };
  return { peer: row.peer, term: row.term, key: row.key, age: now - row.seen };
}
function makeSb(page) {
  const rt = new FakeRealtime(page);
  return {
    rt,
    sb: {
      realtime: rt,
      channel: (t, p) => rt.channel(t, p),
      removeChannel: (c) => rt.removeChannel(c),
      getChannels: () => rt.getChannels(),
      rpc: (fn, args) =>
        new Promise((resolve) => {
          const lat = 30 + rand() * 90;
          setTimeout(() => {
            if (rpcMode !== 'lease' || fn !== 'room_host') return resolve({ data: null, error: { code: 'PGRST202', message: `Could not find the function public.${fn}` } });
            const data = roomHost(page.uid, args);
            rpcLog.push([page.name, args.p_claim ? 'claim' : args.p_release ? 'release' : 'ask']);
            resolve({ data, error: null });
          }, lat);
        }),
    },
  };
}

// ── Load the real modules once per page name ──
globalThis.__FAKE_SB__ = {};
const mods = new Map();
async function loadModules(name) {
  if (mods.has(name)) return mods.get(name);
  globalThis.__FAKE_SB__[name] = { sb: null, uid: `00000000-0000-4000-8000-00000000000${'ABCDM'.indexOf(name) + 1}` };
  const fake = '\0fake-supabase-' + name;
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [
      {
        name: 'fake-supabase',
        enforce: 'pre',
        resolveId(id) {
          return /backend\/supabase(\.ts)?$/.test(id) ? fake : null;
        },
        load(id) {
          if (id !== fake) return null;
          return `const F = globalThis.__FAKE_SB__[${JSON.stringify(name)}];
            export let authError = ''; export let authStatus = 'ok';
            export const socketBeats = { sent: 0, ok: 0, timeout: 0, error: 0, lastLatency: 0 };
            export const backendConfigured = () => true;
            export const supabase = () => F.sb;
            export const realtimeClient = () => F.sb;
            export const rpcBeacon = () => {};
            export const currentUser = () => Promise.resolve({ id: F.uid });`;
        },
      },
    ],
  });
  const m = {
    SupabaseNet: (await server.ssrLoadModule('/game/src/net/SupabaseNet.ts')).SupabaseNet,
    ArenaSession: (await server.ssrLoadModule('/game/src/arena/ArenaSession.ts')).ArenaSession,
    MassLedger: (await server.ssrLoadModule('/game/src/arena/massLedger.ts')).MassLedger,
    A: (await server.ssrLoadModule('/game/src/config/arena.ts')).arenaConfig,
  };
  await server.close();
  mods.set(name, m);
  return m;
}

// ── ArenaGame stand-in: the API ArenaSession drives, with the real MassLedger ──
const START_MASS = 5;
class FakeGame {
  constructor(state, localId, page) {
    this.page = page;
    this.ledger = new page.m.MassLedger();
    this.byId = new Map();
    this.actors = [];
    this.local = null;
    this.outbox = { claims: [], eats: [] };
    this.grants = new Map();
    this.countdown = 0.4;
    this.matchTime = 0;
    this.time = 0;
    this.phase = 'countdown';
    this.pending = new Map(); // object id → last claim time (re-claim like ArenaGame.updatePulls)
    this.lie = null; // [mass, kills] this page reports for its own machine
    this.world = {
      objects: Array.from({ length: 80 }, (_, id) => ({ id, state: 'idle', owner: undefined, def: { rewardMass: 2, objectClass: 1 } })),
      isEligible: () => true,
    };
    for (const r of state.roster) this.addActor(r, localId);
  }
  host() {
    return !!this.page.session?.isHost();
  }
  addActor(r, localId) {
    const kind = r.kind === 'bot' ? 'bot' : r.id === localId ? 'local' : 'remote';
    const a = { id: r.id, slot: r.slot, kind, owned: kind === 'local' || (kind === 'bot' && this.host()), mass: r.st ? r.st[3] : START_MASS, alive: true, eliminated: false, left: false, gen: r.g ?? 0, x: r.slot * 30, z: 0, heading: 0, diameter: 1, power: 1, lives: 3, kills: 0, deaths: 0, objects: 0 };
    this.actors.push(a);
    this.byId.set(a.id, a);
    if (kind === 'local') this.local = a;
    this.ledger.set(a.id, a.mass);
  }
  wireState(a) {
    const [mass, kills] = a === this.local && this.lie ? this.lie : [a.mass, a.kills];
    return [a.x, a.z, a.heading, a.diameter, 0, mass, a.lives, a.alive ? 1 : 0, kills, a.deaths, a.objects, 1, 0, 0];
  }
  applyWire(id, s) {
    const a = this.byId.get(id);
    if (!a || a.owned || a.left) return;
    const human = a.kind === 'remote';
    a.mass = Math.max(START_MASS, human ? this.ledger.clampMass(id, s[5]) : s[5]);
    a.kills = human ? this.ledger.clampKills(id, s[8]) : s[8];
    a.deaths = s[9];
    a.alive = (s[7] & 1) === 1;
    a.x = s[0];
    a.z = s[1];
  }
  refreshOwnership() {
    for (const a of this.actors) if (a.kind === 'bot') a.owned = this.host();
  }
  markLeft(id, self = false) {
    const a = this.byId.get(id);
    if (!a || a.left || a.kind !== (self ? 'local' : 'remote')) return;
    a.left = true;
    a.alive = false;
  }
  swapIn(r, localId) {
    const old = this.actors.find((x) => x.slot === r.slot);
    if (old) {
      this.actors.splice(this.actors.indexOf(old), 1);
      this.byId.delete(old.id);
      if (this.local === old) this.local = null;
    }
    this.addActor(r, localId);
  }
  standings() {
    return [...this.actors].sort((p, q) => q.mass - p.mass).map((a, i) => ({ id: a.id, name: a.id, slot: a.slot, mass: a.mass, kills: a.kills, deaths: a.deaths, objects: a.objects, alive: a.alive, rank: i + 1 }));
  }
  climaxLeft() {
    return 1;
  }
  absorbedBits() {
    const bytes = new Uint8Array(Math.ceil(this.world.objects.length / 8));
    for (const o of this.world.objects) if (o.state === 'absorbed') bytes[o.id >> 3] |= 1 << (o.id & 7);
    return btoa(String.fromCharCode(...bytes));
  }
  syncAbsorbed() {}
  refillCandidates() {
    return [];
  }
  revive() {}
  applyGrant(oid, actorId) {
    if (this.grants.has(oid)) return;
    this.grants.set(oid, actorId);
    const o = this.world.objects[oid];
    this.ledger.grant(actorId, o.def, false);
    o.state = 'absorbed';
    o.owner = actorId;
    const a = this.byId.get(actorId);
    if (a?.owned) {
      a.mass += o.def.rewardMass;
      a.objects++;
    }
    this.pending.delete(oid);
  }
  canEat(a, v) {
    return a.alive && v.alive && a.mass >= v.mass * 1.25;
  }
  applyEaten(e) {
    const v = this.byId.get(e.v);
    const a = this.byId.get(e.a);
    if (!v || !a) return;
    this.ledger.eaten(e.v, e.a, e.gain);
    v.deaths++;
    a.kills++;
    if (v.owned) {
      v.alive = false;
      v.lives = Math.max(0, v.lives - 1);
      v.mass = Math.max(START_MASS, v.mass * 0.45);
      v.respawnAt = this.matchTime + 3;
    }
    if (a.owned) a.mass += e.gain;
  }
  /** Like ArenaGame.proposeCollection: start pulling, claim, re-claim every 1.5 s until granted. */
  claim(oid) {
    if (!this.local || this.grants.has(oid)) return;
    this.pending.set(oid, this.time);
    this.outbox.claims.push([oid, this.local.id]);
  }
  step(dt) {
    this.time += dt;
    if (this.phase === 'countdown') this.countdown -= dt;
    else if (this.phase === 'playing') this.matchTime += dt;
    for (const [oid, at] of this.pending) {
      if (this.grants.has(oid)) this.pending.delete(oid);
      else if (this.time - at > 1.5) {
        this.pending.set(oid, this.time);
        this.outbox.claims.push([oid, this.local.id]);
      }
    }
    for (const a of this.actors) if (a.owned && !a.alive && a.respawnAt !== undefined && this.matchTime >= a.respawnAt) (a.alive = true), (a.respawnAt = undefined);
  }
}

// ── Pages and scenarios ──
const T = (s) => scenarioStart + s * 1000;
let scenarioStart = now;
let pages = [];
async function openPage(name, id, room) {
  const m = await loadModules(name);
  const page = { name, m, uid: globalThis.__FAKE_SB__[name].uid, listeners: [], hidden: false, sent: {}, session: null, net: null };
  const { sb, rt } = makeSb(page);
  page.rt = rt;
  globalThis.__FAKE_SB__[name].sb = sb;
  current = page;
  building = page;
  forceId = id;
  page.net = await m.SupabaseNet.connect(room, `Player${name}`);
  forceId = null;
  page.session = new m.ArenaSession(page.net, { startGame: (state, localId) => new FakeGame(state, localId, page), endGame() {}, changed() {} }, `Player${name}`);
  building = null;
  setInterval(() => {
    if (page.hidden || page.closed) return; // requestAnimationFrame stops on a hidden page
    page.session.update(0.05);
    page.session.game?.step(0.05);
  }, 50);
  current = null;
  pages.push(page);
  return page;
}
function setHidden(page, hidden) {
  page.hidden = hidden;
  current = page;
  for (const l of page.listeners) if (l.kind === 'document' && l.type === 'visibilitychange') l.fn();
  current = null;
}
const fresh = () => {
  timers.clear();
  hub.joined.clear();
  hub.drop = null;
  leases = new Map();
  rpcLog.length = 0;
  pages = [];
  scenarioStart = now;
};
const at = (s) => advanceTo(T(s));
const hosts = () => pages.filter((p) => !p.hidden && !p.closed && p.session.isHost()).map((p) => p.name);
const hostIds = () => [...new Set(pages.filter((p) => !p.hidden && !p.closed).map((p) => p.session.hostId()))];
const nameOf = (id) => pages.find((p) => p.net.selfId() === id)?.name ?? id;
async function startRound(host, opts = {}) {
  if (opts.city) host.session.setCity(opts.city);
  host.session.setBots(opts.bots ?? true);
  for (const p of pages) if (p !== host) p.session.setReady(true);
  await at(opts.readyAt ?? 4);
  host.session.start();
  await at((opts.readyAt ?? 4) + 2);
}

const results = [];
async function scenario(name, mode, fn) {
  if (ONLY && ONLY !== name) return;
  fresh();
  rpcMode = mode;
  const failures = [];
  const notes = [];
  const fail = (s) => failures.length < 12 && failures.push(`${((now - scenarioStart) / 1000).toFixed(2)}s ${s}`);
  const note = (s) => notes.push(`${((now - scenarioStart) / 1000).toFixed(2)}s ${s}`);
  try {
    await fn({ fail, note, mode });
  } catch (e) {
    failures.push(`threw: ${e?.stack ?? e}`);
  }
  // Honest host messages are never rejected (only the forgery scenario sends bad ones).
  if (mode === 'lease' && name !== 'forgery')
    for (const p of pages) {
      const r = p.net.diagnostics?.().host?.rejected ?? 0;
      if (r) failures.push(`${p.name} rejected ${r} honest host messages`);
    }
  for (const p of pages) p.closed = true;
  results.push({ name, mode, failures, notes });
  console.log(`${failures.length ? 'FAIL' : 'PASS'}  ${name} [${mode}]${failures.length ? '\n      ' + failures.join('\n      ') : ''}`);
  if (VERBOSE) for (const n of notes) console.log('      · ' + n);
}

const ID = { low: 'p-000000aaaa', A: 'p-mmmmmm0001', B: 'p-mmmmmm0002', C: 'p-mmmmmm0003', M: 'p-000000mmmm' };

for (const mode of MODES) {
  // ── ready ──
  await scenario('ready', mode, async ({ fail }) => {
    const A = await openPage('A', ID.A, 'RDY1');
    await at(0.5);
    const B = await openPage('B', ID.B, 'RDY1');
    await at(3);
    if (A.session.hostId() !== ID.A || B.session.hostId() !== ID.A) fail(`host not A: A→${nameOf(A.session.hostId())} B→${nameOf(B.session.hostId())}`);
    B.session.setReady(true);
    for (let s = 3.25; s <= 15; s += 0.25) {
      await at(s);
      if (!B.session.ready) fail('B ready flag was cleared');
      if (s >= 4.5 && !A.session.canStart()) fail(`host cannot start (B listed ready=${A.session.lobbyPlayers().find((p) => !p.isMe)?.ready})`);
    }
    A.session.start();
    await at(17);
    if (B.session.match.ph === 'lobby') fail('start did not reach the guest');
    // A new lobby (after the round) does reset Ready, as it should.
    A.session.toLobby();
    await at(18);
    if (B.session.ready) fail('Ready survived the return to the lobby');
  });

  // ── tabout ──
  await scenario('tabout', mode, async ({ fail, note }) => {
    const A = await openPage('A', ID.A, 'TAB1');
    await at(0.4);
    const B = await openPage('B', ID.B, 'TAB1');
    const C = await openPage('C', ID.C, 'TAB1');
    await at(3);
    await startRound(A);
    if (A.session.match.ph !== 'playing') fail(`round not playing (${A.session.match.ph})`);
    const ep = A.session.match.ep;
    const settle = mode === 'lease' ? 0 : 1.2;
    let last = null;
    let changedAt = 0;
    const sample = async (from, to) => {
      for (let s = from; s <= to; s += 0.1) {
        await at(s);
        const h = hosts();
        const ids = hostIds();
        const key = `${h.join(',')}|${ids.join(',')}`;
        if (key !== last) (last = key), (changedAt = s), note(`hosts=[${h}] agree=${ids.map(nameOf)}`);
        if (h.length > 1 && s - changedAt > settle) fail(`two hosts: ${h.join(', ')}`);
        if (ids.length > 1 && s - changedAt > 1.5) fail(`pages disagree on the host: ${ids.map(nameOf).join(' / ')}`);
      }
    };
    await sample(6.1, 10);
    note('A hidden');
    setHidden(A, true);
    await sample(10.1, 13);
    note('A visible');
    setHidden(A, false);
    await sample(13.1, 22);
    const finalHost = hostIds();
    if (finalHost.length !== 1 || hosts().length !== 1) fail(`final: hosts=${hosts()} agree=${finalHost.map(nameOf)}`);
    for (const p of pages) if (p.session.match.ep !== ep || p.session.match.ph !== 'playing') fail(`${p.name} left the round (ep ${p.session.match.ep}, ${p.session.match.ph})`);
    const botOwners = pages.filter((p) => p.session.game?.actors.some((a) => a.kind === 'bot' && a.owned)).map((p) => p.name);
    if (botOwners.length !== 1) fail(`AI rivals simulated by ${botOwners.length} pages (${botOwners})`);
  });

  // ── longaway ──
  await scenario('longaway', mode, async ({ fail, note }) => {
    const A = await openPage('A', ID.A, 'AWY1');
    await at(0.4);
    const B = await openPage('B', ID.B, 'AWY1');
    await at(3);
    await startRound(A);
    setHidden(A, true);
    await at(10);
    if (!B.session.isHost()) fail('B did not take over while A was away');
    setHidden(A, false);
    for (let s = 10.1; s <= 20; s += 0.1) {
      await at(s);
      if (s > 11.5 && hosts().length !== 1) fail(`hosts: ${hosts()}`);
    }
    if (A.session.isHost()) fail('A grabbed the round back');
    const me = A.session.game?.byId.get(ID.A);
    note(`A back in the round: ${!!me && !me.left}`);
    if (!me || me.left) fail('A was not re-admitted to its machine');
  });

  // ── newcomer ──
  await scenario('newcomer', mode, async ({ fail }) => {
    const A = await openPage('A', ID.A, 'NEW1');
    await at(0.4);
    const B = await openPage('B', ID.B, 'NEW1');
    await at(3);
    A.session.setCity('paris');
    A.session.setBots(false);
    await at(6);
    if (B.session.city !== 'paris') fail(`B did not follow the host's city (${B.session.city})`);
    const C = await openPage('C', ID.low, 'NEW1'); // lowest id of the room, default city
    for (let s = 6.1; s <= 18; s += 0.1) {
      await at(s);
      if (s > 7.5) {
        for (const p of pages) if (p.session.hostId() !== ID.A) fail(`${p.name} names ${nameOf(p.session.hostId())} as host`);
        if (A.session.city !== 'paris' || A.session.bots !== false) fail(`host settings reset: ${A.session.city} bots=${A.session.bots}`);
      }
      if (s > 9 && (C.session.city !== 'paris' || C.session.bots !== false)) fail(`newcomer did not adopt the room: ${C.session.city} bots=${C.session.bots}`);
    }
  });

  // ── lostgrant ──
  await scenario('lostgrant', mode, async ({ fail, note }) => {
    const A = await openPage('A', ID.A, 'GRT1');
    await at(0.4);
    const B = await openPage('B', ID.B, 'GRT1');
    await at(3);
    await startRound(A);
    let dropped = 0;
    hub.drop = (to, event, payload) => {
      if (to !== B || event !== 'msg' || payload?.topic !== 'grant') return false;
      if (dropped < 3 && JSON.stringify(payload.data?.g ?? []).includes('[7,')) return ++dropped > 0;
      return false;
    };
    const g = B.session.game;
    const before = g.local.mass;
    g.claim(7);
    await at(12);
    note(`grant messages for object 7 dropped: ${dropped}`);
    if (dropped < 1) fail('test did not drop any grant');
    if (g.grants.get(7) !== ID.B) fail(`object 7 never granted to B (${g.grants.get(7)})`);
    if (g.local.mass !== before + 2) fail(`B mass ${before} → ${g.local.mass} (expected +2 exactly once)`);
    const hostGrant = A.session.game.grants.get(7);
    if (hostGrant !== ID.B) fail(`host's world: object 7 → ${hostGrant}`);
  });

  // ── losteaten ──
  await scenario('losteaten', mode, async ({ fail, note }) => {
    const A = await openPage('A', ID.A, 'EAT1');
    await at(0.4);
    const B = await openPage('B', ID.B, 'EAT1');
    const C = await openPage('C', ID.C, 'EAT1');
    await at(3);
    await startRound(A, { bots: false });
    // A is big and right on top of B.
    const ga = A.session.game;
    ga.local.mass = 200;
    ga.ledger.set(ID.A, 200);
    B.session.game.local.x = ga.local.x = 0;
    B.session.game.local.z = ga.local.z = 0;
    await at(7);
    hub.drop = (to, event, payload) => to === B && event === 'msg' && payload?.topic === 'eaten';
    ga.outbox.eats.push([ID.B, ID.A]);
    let deadAt = null;
    for (let s = 7.1; s <= 14; s += 0.1) {
      await at(s);
      if (deadAt === null && B.session.game.local.deaths > 0) deadAt = s - 7;
    }
    note(`victim applied the eat after ${deadAt?.toFixed(1)} s (only through the beacon)`);
    if (deadAt === null) fail('victim never applied the lost eat');
    if (B.session.game.local.deaths !== 1) fail(`victim applied it ${B.session.game.local.deaths} times`);
    const cb = C.session.game.byId.get(ID.B);
    const ca = C.session.game.byId.get(ID.A);
    if (ca.kills !== 1) fail(`bystander counted A's kills = ${ca.kills}`);
    if (A.session.game.local.kills !== 1) fail(`attacker kills = ${A.session.game.local.kills}`);
    void cb;
  });

  // ── forgery. Without the server (fallback) a guest cannot tell a forged `from`, so there only the
  //    host's own protection is checked: nobody can make it accept a message in its own name. ──
  await scenario('forgery', mode, async ({ fail, note }) => {
      const A = await openPage('A', ID.A, 'FRG1');
      await at(0.4);
      const B = await openPage('B', ID.B, 'FRG1');
      await at(3);
      await startRound(A, { bots: false });
      const M = await openPage('M', ID.M, 'FRG1'); // a modified client with the lowest id
      await at(9);
      const ch = M.rt.current();
      const send = (payload) => ch.send({ type: 'broadcast', event: 'msg', payload });
      const gb = B.session.game;
      const ep = A.session.match.ep;
      // 1. Unsigned beacon in the host's name: "round over, M won".
      send({ topic: 'match', from: ID.A, data: { ...A.session.match, ph: 'results', standings: [] } });
      // 2. Same with a made-up signature and counter.
      send({ topic: 'match', from: ID.A, data: { ...A.session.match, ph: 'results' }, n: 999999, sig: 'AAAA' });
      // 3. Forged eat and grant in the host's name.
      send({ topic: 'eaten', from: ID.A, data: { ep, id: 4242, v: 1, a: 0, gain: 1e6, first: true } });
      send({ topic: 'grant', from: ID.A, data: { ep, g: [[11, 0], [12, 0]] } });
      // 4. Its own beacon with a huge term and a newer epoch (and a claim for the lease). Without the
      //    server this one wins by design (any page may take over a room whose host it outranks):
      //    the known limit of the fallback, closed by the lease.
      if (mode === 'lease') send({ topic: 'match', from: ID.M, data: { ...A.session.match, ep: ep + 5, host: ID.M, hg: 99, ph: 'lobby' } });
      if (mode === 'lease') {
        const claim = roomHost(M.uid, { p_room: 'FRG1', p_peer: ID.M, p_key: null, p_claim: true });
        if (claim.peer !== ID.A) fail(`rival claim took the lease: ${JSON.stringify(claim)}`);
      }
      // 5. Replay of a real signed host message (captured from the wire).
      let captured = null;
      hub.drop = (to, event, payload) => {
        if (!captured && to === M && event === 'msg' && payload?.topic === 'match' && payload.sig) captured = payload;
        return false;
      };
      await at(12);
      if (captured) send(captured);
      await at(14);
      if (mode === 'lease') {
        if (B.session.match.ph !== 'playing' || B.session.match.ep !== ep) fail(`B followed a forged beacon: ${B.session.match.ph} ep ${B.session.match.ep}`);
        if (gb.byId.get(ID.B).deaths !== 0) fail('B applied a forged eat');
        if (gb.grants.has(11) || gb.grants.has(12)) fail('B applied a forged grant');
        for (const p of [A, B, M]) if (p.session.hostId() !== ID.A) fail(`${p.name} names ${nameOf(p.session.hostId())} as host`);
        const d = B.net.diagnostics?.() ?? {};
        note(`B rejected ${d.host?.rejected} host messages; replay captured: ${!!captured}`);
        if (!(d.host?.rejected >= 2)) fail(`B rejected only ${d.host?.rejected} forged / replayed host messages`);
      }
      if (A.session.match.ph !== 'playing') fail('the real host was disturbed');
      // The forged eat names A (slot 0) as the attacker with a 1e6 kg gain.
      if (A.session.game.local.kills !== 0 || A.session.game.local.mass > 1000) fail('the host applied a forged eat sent in its own name');
      if (A.session.game.grants.has(11) || A.session.game.grants.has(12)) fail('the host applied a forged grant sent in its own name');
      const sa = A.net.diagnostics?.().spoofed ?? 0;
      note(`A dropped ${sa} messages forged in its own name`);
      if (sa < 3) fail(`A dropped only ${sa} messages forged in its own name`);
    });

  // ── masslie ──
  await scenario('masslie', mode, async ({ fail, note }) => {
    const A = await openPage('A', ID.A, 'LIE1');
    await at(0.4);
    const B = await openPage('B', ID.B, 'LIE1');
    const C = await openPage('C', ID.C, 'LIE1');
    await at(3);
    await startRound(A, { bots: false });
    const gb = B.session.game;
    // Honest growth first: 3 granted objects (+2 kg each). C never receives those grants: its cap
    // for B must come from the host's beacon, or it would clamp B's honest mass.
    hub.drop = (to, event, payload) => to === C && event === 'msg' && payload?.topic === 'grant';
    for (const o of [20, 21, 22]) gb.claim(o);
    await at(9);
    hub.drop = null;
    const honest = gb.local.mass;
    const onA = () => A.session.game.byId.get(ID.B);
    const onC = () => C.session.game.byId.get(ID.B);
    if (Math.abs(onA().mass - honest) > 0.01 || Math.abs(onC().mass - honest) > 0.01) fail(`honest mass ${honest} seen as A:${onA().mass} C:${onC().mass}`);
    gb.lie = [99999, 9];
    await at(13);
    const capA = A.session.game.ledger.capOf(ID.B);
    note(`B honest ${honest} kg · claims 99999 kg / 9 kills · host sees ${onA().mass.toFixed(1)} kg / ${onA().kills} kills (cap ${capA?.toFixed(1)}) · C sees ${onC().mass.toFixed(1)} kg / ${onC().kills}`);
    for (const [who, a] of [['host', onA()], ['guest C', onC()]]) {
      if (a.mass > 60) fail(`${who} accepts ${a.mass} kg`);
      if (a.kills !== 0) fail(`${who} accepts ${a.kills} kills`);
    }
    const st = A.session.game.standings().find((r) => r.id === ID.B);
    if (st.mass > 60) fail(`standings use the lie: ${st.mass}`);
  });
}

const failed = results.filter((r) => r.failures.length);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
process.exit(failed.length ? 1 : 0);
