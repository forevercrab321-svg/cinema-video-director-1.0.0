// Online-room presence soak test (deterministic, no network).
//
// Two pages (A, B) run the real game/src/net/SupabaseNet.ts + game/src/arena/ArenaSession.ts
// against a fake Supabase Realtime that models what matters from realtime-js 2.117 / phoenix:
//   · channel(topic) hands back an existing instance for a known topic,
//   · a channel's close unregisters channels from the client BY TOPIC, and an empty client
//     disconnects its socket 50 s later,
//   · a server-closed channel is never resubscribed by the library; a socket drop errors the
//     channel (CHANNEL_ERROR) and the library rejoins it when the socket is back,
//   · broadcast self-echo, per-message latency, presence (with lost re-tracks after a rejoin).
// A virtual clock runs 130 s of simulated time with chaos (server CLOSE every 30 s and in
// between, socket drops, a slow leave reply) and asserts, every 250 ms:
//   both pages list 2 peers and 2 lobby players, agree on one host, and the host never changes;
// plus a steady heartbeat rate, a rejoin counter that is never reset, and correct liveness
// (a frozen page expires after the timeout; a page that says goodbye leaves at once).
//
// Usage: node tools/net-presence-test.mjs [--impl path/to/SupabaseNet.ts] [--seed N] [--verbose]
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const IMPL = arg('--impl', null);
const SEED = Number(arg('--seed', 7));
const VERBOSE = process.argv.includes('--verbose');

// ── Browser globals (per-page listeners are captured while that page's objects are built) ──
const pages = [];
let building = null;
const listen = (kind) => (type, fn) => building?.listeners.push({ kind, type, fn });
globalThis.window = globalThis;
globalThis.addEventListener = listen('window');
globalThis.document = { visibilityState: 'visible', addEventListener: listen('document') };
globalThis.location = { search: '', href: 'http://localhost/game/', hostname: 'localhost' };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'en', languages: ['en'] }, configurable: true });

// ── Deterministic RNG ──
let rs = SEED >>> 0;
const rand = () => {
  rs = (rs + 0x6d2b79f5) >>> 0;
  let t = rs;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ── Fake Supabase Realtime ──
const hub = {
  joined: new Map(), // topic → Set<FakeChannel>
  presence: new Map(), // topic → Map<key, meta>
  blocked: new Set(), // page names whose outbound traffic is dropped (a frozen page)
  trackLoss: 0.5, // chance a presence track after a rejoin never lands (field observation)
  latency: () => 30 + rand() * 60,
  set(topic) {
    if (!this.joined.has(topic)) this.joined.set(topic, new Set());
    return this.joined.get(topic);
  },
  pres(topic) {
    if (!this.presence.has(topic)) this.presence.set(topic, new Map());
    return this.presence.get(topic);
  },
  syncPresence(topic) {
    for (const ch of this.set(topic)) ch._presenceSync();
  },
  leave(ch) {
    this.set(ch.topic).delete(ch);
    if (ch.presenceKey && this.pres(ch.topic).get(ch.presenceKey)?.ch === ch) {
      this.pres(ch.topic).delete(ch.presenceKey);
      this.syncPresence(ch.topic);
    }
  },
};

let refN = 0;
class FakeChannel {
  constructor(topic, params, client) {
    this.topic = `realtime:${topic}`;
    this.params = params;
    this.client = client;
    this.state = 'closed';
    this.joinedOnce = false;
    this.bindings = [];
    this.closeHooks = [() => client.socketChannels.delete(this), () => client._remove(this)]; // phoenix + realtime-js
    this.errorHooks = [];
    this.okHooks = [];
    this.presenceKey = params?.config?.presence?.key || '';
    this.self = !!params?.config?.broadcast?.self;
    this.channelAdapter = { getChannel: () => this };
    this.dead = false;
    client.socketChannels.add(this);
  }
  on(type, filter, cb) {
    this.bindings.push({ type, event: filter?.event, cb });
    return this;
  }
  subscribe(cb) {
    if (this.state !== 'closed') return this; // realtime-js: only a closed channel (re)subscribes
    if (this.joinedOnce) throw new Error("tried to join multiple times. 'join' can only be called a single time per channel instance");
    this.joinedOnce = true;
    this.errorHooks.push(() => cb?.('CHANNEL_ERROR', new Error('socket closed')));
    this.closeHooks.push(() => cb?.('CLOSED'));
    this.okHooks.push(() => cb?.('SUBSCRIBED'));
    if (!this.client.socketUp) this.client.connect();
    this._join();
    return this;
  }
  _join() {
    this.state = 'joining';
    setTimeout(() => {
      if (this.dead || this.state !== 'joining' || !this.client.socketUp) return;
      this.state = 'joined';
      hub.set(this.topic).add(this);
      for (const h of this.okHooks) h();
      this._presenceSync();
    }, 40 + rand() * 80);
  }
  _presenceSync() {
    if (this.state !== 'joined') return;
    for (const b of this.bindings) if (b.type === 'presence' && b.event === 'sync') setTimeout(() => !this.dead && b.cb(), hub.latency());
  }
  presenceState() {
    const out = {};
    for (const [k, v] of hub.pres(this.topic)) out[k] = [{ ...v.meta, presence_ref: v.ref }];
    return out;
  }
  track(meta) {
    if (this.state !== 'joined') return Promise.resolve('error');
    if (this.client.rejoinedOnce && rand() < hub.trackLoss) return Promise.resolve('timed out');
    hub.pres(this.topic).set(this.presenceKey, { meta, ref: ++refN, ch: this });
    hub.syncPresence(this.topic);
    return Promise.resolve('ok');
  }
  send({ event, payload }) {
    // Not joined: realtime-js falls back to the REST endpoint (still delivered to the room).
    if (hub.blocked.has(this.client.name)) return Promise.resolve('ok');
    this.client.sent[event] = (this.client.sent[event] ?? 0) + 1;
    for (const ch of hub.set(this.topic)) {
      if (ch === this && !this.self) continue;
      setTimeout(() => {
        if (ch.dead || ch.state !== 'joined') return;
        for (const b of ch.bindings) if (b.type === 'broadcast' && b.event === event) b.cb({ type: 'broadcast', event, payload });
      }, hub.latency());
    }
    return Promise.resolve('ok');
  }
  unsubscribe() {
    return new Promise((resolve) => {
      const wasJoined = this.state === 'joined' && this.client.socketUp;
      this.state = 'leaving';
      if (!wasJoined) {
        this._close();
        return resolve('ok');
      }
      // The server answers the leave; sometimes slowly (the old code raced it against 3 s).
      const delay = this.client.slowLeaveOnce ? ((this.client.slowLeaveOnce = false), 4000) : hub.latency() * 2;
      setTimeout(() => {
        hub.leave(this);
        this._close();
        resolve('ok');
      }, delay);
    });
  }
  teardown() {
    this.bindings = [];
    this.closeHooks = [];
    this.errorHooks = [];
    this.okHooks = [];
    this.state = 'closed';
    this.dead = true;
    hub.leave(this);
  }
  _close() {
    this.state = 'closed';
    hub.leave(this);
    for (const h of [...this.closeHooks]) h();
  }
  /** Server-side phx_close. */
  serverClose() {
    if (this.state !== 'joined') return false;
    this._close();
    return true;
  }
  _error() {
    if (this.state !== 'joined' && this.state !== 'joining') return;
    this.state = 'errored';
    hub.leave(this);
    for (const h of [...this.errorHooks]) h();
  }
}

class FakeRealtime {
  constructor(name) {
    this.name = name;
    this.channels = [];
    this.socketChannels = new Set();
    this.socketUp = false;
    this.pending = null;
    this.vsn = '1.0.0';
    this.sent = {};
    this.disconnects = 0;
    this.socketAdapter = { getSocket: () => ({ remove: (c) => this.socketChannels.delete(c) }) };
  }
  getChannels() {
    return this.channels;
  }
  channel(topic, params) {
    const found = this.channels.find((c) => c.topic === `realtime:${topic}`);
    if (found) return found;
    const ch = new FakeChannel(topic, params, this);
    this._cancelPendingDisconnect();
    this.channels.push(ch);
    return ch;
  }
  async removeChannel(ch) {
    const s = await ch.unsubscribe();
    if (s === 'ok') ch.teardown();
    return s;
  }
  _remove(ch) {
    this.channels = this.channels.filter((c) => c.topic !== ch.topic);
    if (!this.channels.length) {
      this._cancelPendingDisconnect();
      this.pending = setTimeout(() => {
        this.pending = null;
        if (!this.channels.length) this.disconnect(false);
      }, 50_000);
    }
  }
  _cancelPendingDisconnect() {
    if (this.pending) clearTimeout(this.pending), (this.pending = null);
  }
  connect() {
    this.socketUp = true;
    for (const ch of this.socketChannels) if (ch.state === 'errored' && !ch.dead) ch._join();
  }
  /** Socket closes; `reconnectAfter` null = clean disconnect (the library does not reconnect). */
  disconnect(reconnectAfter) {
    this.disconnects++;
    this.socketUp = false;
    for (const ch of [...this.socketChannels]) ch._error();
    if (reconnectAfter) setTimeout(() => this.connect(), reconnectAfter);
  }
  current() {
    return this.channels.find((c) => c.state === 'joined') ?? [...this.socketChannels].find((c) => c.state === 'joined');
  }
}

// ── Load the real modules (one module graph per page, each bound to its own fake client) ──
globalThis.__FAKE_SB__ = {};
async function loadPage(name) {
  const rt = new FakeRealtime(name);
  const sb = { realtime: rt, channel: (t, p) => rt.channel(t, p), removeChannel: (c) => rt.removeChannel(c), getChannels: () => rt.getChannels() };
  globalThis.__FAKE_SB__[name] = { sb, uid: `uid-${name}` };
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
          if (/backend\/supabase(\.ts)?$/.test(id)) return fake;
          if (IMPL && /net\/SupabaseNet(\.ts)?$/.test(id)) return path.resolve(IMPL);
          return null;
        },
        load(id) {
          if (id !== fake) return null;
          return `const F = globalThis.__FAKE_SB__[${JSON.stringify(name)}];
            export let authError = ''; export let authStatus = 'ok';
            export const socketBeats = { sent: 0, ok: 0, timeout: 0, error: 0, lastLatency: 0 };
            export const backendConfigured = () => true;
            export const supabase = () => F.sb;
            export const realtimeClient = () => F.sb;
            export const currentUser = () => Promise.resolve({ id: F.uid });`;
        },
      },
    ],
  });
  const netMod = await server.ssrLoadModule(IMPL ? path.resolve(IMPL) : '/game/src/net/SupabaseNet.ts');
  const sessMod = await server.ssrLoadModule('/game/src/arena/ArenaSession.ts');
  await server.close();
  return { name, rt, SupabaseNet: netMod.SupabaseNet, ArenaSession: sessMod.ArenaSession, listeners: [] };
}

const specs = [await loadPage('A'), await loadPage('B')];

// ── Virtual clock ──
const realImmediate = setImmediate;
let now = 1_700_000_000_000;
const t0 = now;
let seq = 0;
const timers = new Map();
const addTimer = (fn, ms, every) => {
  const id = ++seq;
  timers.set(id, { at: now + Math.max(0, ms | 0), fn, every: every ? Math.max(1, ms | 0) : 0, id });
  return id;
};
globalThis.setTimeout = (fn, ms = 0) => addTimer(fn, ms, false);
globalThis.setInterval = (fn, ms = 0) => addTimer(fn, ms, true);
globalThis.clearTimeout = globalThis.clearInterval = (id) => void timers.delete(typeof id === 'object' ? id?.id : id);
Date.now = () => now;
Object.defineProperty(globalThis, 'performance', { value: { now: () => now - t0 }, configurable: true });
const flush = () => new Promise((r) => realImmediate(r));
async function advanceTo(target) {
  for (;;) {
    let next = null;
    for (const t of timers.values()) if (t.at <= target && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
    if (!next) break;
    now = next.at;
    if (next.every) next.at += next.every;
    else timers.delete(next.id);
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
const T = (s) => t0 + s * 1000;

// ── Pages ──
const hooks = { startGame: () => ({}), endGame() {}, changed() {} };
for (const [i, p] of specs.entries()) {
  pages.push(p);
  await advanceTo(T(i * 0.5));
  building = p;
  p.net = await p.SupabaseNet.connect('TEST3', `Player${p.name}`);
  p.session = new p.ArenaSession(p.net, hooks, `Player${p.name}`);
  building = null;
  setInterval(() => p.session.update(0.1), 100); // the frame loop (lobby)
}
const [A, B] = pages;

// ── Chaos schedule ──
const log = [];
const note = (s) => {
  log.push(`${((now - t0) / 1000).toFixed(1)}s ${s}`);
  if (VERBOSE) console.log(log.at(-1));
};
const serverClose = (p) => {
  const ch = p.rt.current();
  note(`server CLOSE ${p.name}: ${ch?.serverClose() ? 'closed' : 'no joined channel'}`);
};
const chaos = [
  [15, () => serverClose(B)],
  [30, () => (serverClose(A), serverClose(B))],
  [45, () => (note('socket drop A 3s'), A.rt.disconnect(3000))],
  [58, () => (A.rt.slowLeaveOnce = true)],
  [60, () => (serverClose(A), serverClose(B))],
  [75, () => (note('B ready'), B.session.setReady(true))],
  [90, () => (serverClose(A), serverClose(B))],
  [100, () => (note('socket drop B 6s'), B.rt.disconnect(6000))],
  [120, () => (serverClose(A), serverClose(B))],
];
for (const [s, fn] of chaos)
  setTimeout(() => {
    for (const p of pages) p.rt.rejoinedOnce = true;
    fn();
  }, T(s) - now);

// ── Soak: sample every 250 ms from 5 s to 130 s ──
const failures = [];
const fail = (s) => {
  if (failures.length < 25) failures.push(`${((now - t0) / 1000).toFixed(2)}s ${s}`);
};
let host0 = null;
let hostChanges = 0;
const hbWindows = { A: [], B: [] };
let lastHb = { A: 0, B: 0 };
let minPeers = { A: 9, B: 9 };
for (let s = 5; s <= 130; s += 0.25) {
  await advanceTo(T(s));
  const pa = A.net.peers().length;
  const pb = B.net.peers().length;
  minPeers.A = Math.min(minPeers.A, pa);
  minPeers.B = Math.min(minPeers.B, pb);
  const la = A.session.lobbyPlayers().length;
  const lb = B.session.lobbyPlayers().length;
  const ha = A.session.hostId();
  const hb = B.session.hostId();
  if (pa !== 2 || pb !== 2) fail(`peers A=${pa} B=${pb}`);
  if (la !== 2 || lb !== 2) fail(`lobby list A=${la} B=${lb}`);
  if (ha !== hb) fail(`host disagreement A→${ha} B→${hb}`);
  if (A.session.isHost() === B.session.isHost()) fail(`isHost A=${A.session.isHost()} B=${B.session.isHost()}`);
  if (host0 === null) host0 = ha;
  else if (ha !== host0) hostChanges++, (host0 = ha), fail(`host changed to ${ha}`);
  if (Number.isInteger(s / 10)) {
    for (const p of pages) {
      const n = p.rt.sent.hb ?? 0;
      hbWindows[p.name].push(n - lastHb[p.name]);
      lastHb[p.name] = n;
    }
  }
}
// Heartbeats: ~1 Hz. At least 3 per 10 s window per page (one window holds B's 6 s socket
// outage, when nothing can be sent), so the field's "1 message in 17 s" collapse fails here.
for (const p of pages) {
  const w = hbWindows[p.name].slice(1);
  if (w.some((n) => n < 3)) failures.push(`heartbeat windows ${p.name}: ${w.join(',')}`);
}
const diag = (p) => {
  // Each page's net exposes diagnostics through window.__NET__ at construction; call the method directly.
  const d = p.net.diagnostics?.();
  return d ?? { status: p.net.status, rejoins: p.net.rejoins };
};
const dA = diag(A);
const dB = diag(B);
if (dA.status !== 'connected' || dB.status !== 'connected') failures.push(`final status A=${dA.status} B=${dB.status}`);
if (!(dA.rejoins >= 4 && dB.rejoins >= 5)) failures.push(`rejoin counters A=${dA.rejoins} B=${dB.rejoins} (expected ≥4/≥5: never reset)`);

// ── Liveness still works: a frozen page expires after the timeout, a goodbye leaves at once ──
hub.blocked.add('B');
note('B frozen (outbound dropped)');
let droppedAt = null;
for (let s = 130.25; s <= 146; s += 0.25) {
  await advanceTo(T(s));
  if (droppedAt === null && A.net.peers().length === 1) droppedAt = s - 130;
}
if (droppedAt === null || droppedAt < 10 || droppedAt > 13.5) failures.push(`frozen B dropped after ${droppedAt}s (expected ~12s)`);
hub.blocked.delete('B');
note('B unfrozen');
let backAt = null;
for (let s = 146.25; s <= 150; s += 0.25) {
  await advanceTo(T(s));
  if (backAt === null && A.net.peers().length === 2 && A.session.lobbyPlayers().length === 2) backAt = s - 146;
}
if (backAt === null || backAt > 1.5) failures.push(`B back after ${backAt}s (expected ≤1.5s)`);
for (const l of B.listeners) if (l.kind === 'window' && l.type === 'pagehide') l.fn();
note('B pagehide');
await advanceTo(T(150.5));
if (A.net.peers().length !== 1) failures.push(`after B's goodbye A still lists ${A.net.peers().length} peers`);
if (!A.session.isHost()) failures.push('A alone is not host');

const report = {
  impl: IMPL ?? 'game/src/net/SupabaseNet.ts',
  seed: SEED,
  simulatedSeconds: 150,
  minPeers,
  hostChanges,
  heartbeatsPer10s: hbWindows,
  frozenDroppedAfterS: droppedAt,
  unfrozenBackAfterS: backAt,
  A: { status: dA.status, rejoins: dA.rejoins, joins: dA.joins, lastRejoinReason: dA.lastRejoinReason, socketDisconnects: A.rt.disconnects, sent: A.rt.sent },
  B: { status: dB.status, rejoins: dB.rejoins, joins: dB.joins, lastRejoinReason: dB.lastRejoinReason, socketDisconnects: B.rt.disconnects, sent: B.rt.sent },
  chaos: log,
  failures,
};
console.log(JSON.stringify(report, null, 2));
console.log(failures.length ? `FAIL (${failures.length} problems)` : 'PASS: peers stayed 2 and the host never changed through 130 s of channel churn');
process.exit(failures.length ? 1 : 0);
