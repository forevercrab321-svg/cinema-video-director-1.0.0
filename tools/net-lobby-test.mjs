// Room browser / global presence ("ge-lobby") test — deterministic, no network.
//
// Pages run the real game/src/net/Hub.ts (+ RealtimeLink.ts) against a fake Supabase Realtime
// modelled on tools/net-presence-test.mjs (topic-keyed channel reuse, close-by-topic, no
// resubscribe after a server close, socket drops that error channels, broadcast self-echo,
// per-message latency), on a virtual clock:
//   · 8 pages: 3 rooms × (host + guest) — AAAA1 public waiting, BBBB2 PRIVATE, CCCC3 public
//     playing — plus 2 solo-vs-AI pages. Every page must read online = 8 and list exactly the two
//     public rooms with the right player counts / phases / "ends in", through server CLOSEs on
//     every page at once, one at a time, and socket drops (closed channel + rejoin drops nobody).
//   · a late visitor on the room browser sees the full directory within ~1 s (digest);
//   · a page that goes silent disappears within 10 s; a host's goodbye removes its room at once;
//   · malicious payloads: huge names, negative / huge numbers, junk types, bad ids, a 1000-id
//     burst (tracked ids capped at 500, real pages stay listed), a single id flooding beats
//     (rate-limited), then everything expires back to the real count;
//   · 60 synthetic pages: the beat interval stretches (N² budget) and shrinks back;
//   · the private room's code never goes over the wire; one online_snapshot per minute.
//
// Usage: node tools/net-lobby-test.mjs [--seed N] [--verbose]
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const SEED = Number(arg('--seed', 11));
const VERBOSE = process.argv.includes('--verbose');
const TOPIC = 'ge-lobby';

// ── Deterministic RNG (Math.random too: tab ids and beat jitter) ──
let rs = SEED >>> 0;
const rand = () => {
  rs = (rs + 0x6d2b79f5) >>> 0;
  let t = rs;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
Math.random = rand;

// ── Browser globals (per-page listeners are captured while that page's objects are built) ──
let building = null;
const listen = (kind) => (type, fn) => building?.listeners.push({ kind, type, fn });
globalThis.window = globalThis;
globalThis.addEventListener = listen('window');
globalThis.document = { visibilityState: 'visible', addEventListener: listen('document') };
globalThis.location = { search: '', href: 'http://localhost/game/', hostname: 'localhost' };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'en', languages: ['en'] }, configurable: true });

// ── Fake Supabase Realtime (broadcast only) ──
const hub = {
  joined: new Map(), // topic → Set<FakeChannel>
  blocked: new Set(), // page names whose outbound traffic is dropped (a frozen page)
  wire: [], // every payload sent (privacy check)
  deliveries: 0,
  latency: () => 30 + rand() * 60,
  set(topic) {
    if (!this.joined.has(topic)) this.joined.set(topic, new Set());
    return this.joined.get(topic);
  },
  /** A raw broadcast from outside the real module (synthetic / hostile pages). */
  inject(topic, event, payload) {
    this.wire.push(JSON.stringify(payload));
    for (const ch of this.set(`realtime:${topic}`)) {
      this.deliveries++;
      setTimeout(() => {
        if (ch.dead || ch.state !== 'joined') return;
        for (const b of ch.bindings) if (b.type === 'broadcast' && b.event === event) b.cb({ type: 'broadcast', event, payload });
      }, hub.latency());
    }
  },
};

class FakeChannel {
  constructor(topic, params, client) {
    this.topic = `realtime:${topic}`;
    this.client = client;
    this.state = 'closed';
    this.joinedOnce = false;
    this.bindings = [];
    this.closeHooks = [() => client.socketChannels.delete(this), () => client._remove(this)];
    this.errorHooks = [];
    this.okHooks = [];
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
    if (this.state !== 'closed') return this;
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
    }, 40 + rand() * 80);
  }
  send({ event, payload }) {
    if (hub.blocked.has(this.client.name)) return Promise.resolve('ok');
    this.client.sent[event] = (this.client.sent[event] ?? 0) + 1;
    hub.wire.push(JSON.stringify(payload));
    for (const ch of hub.set(this.topic)) {
      if (ch === this && !this.self) continue;
      hub.deliveries++;
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
      setTimeout(() => {
        this._close();
        resolve('ok');
      }, hub.latency() * 2);
    });
  }
  teardown() {
    this.bindings = [];
    this.closeHooks = [];
    this.errorHooks = [];
    this.okHooks = [];
    this.state = 'closed';
    this.dead = true;
    hub.set(this.topic).delete(this);
  }
  _close() {
    this.state = 'closed';
    hub.set(this.topic).delete(this);
    for (const h of [...this.closeHooks]) h();
  }
  serverClose() {
    if (this.state !== 'joined') return false;
    this._close();
    return true;
  }
  _error() {
    if (this.state !== 'joined' && this.state !== 'joining') return;
    this.state = 'errored';
    hub.set(this.topic).delete(this);
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
  disconnect(reconnectAfter) {
    this.socketUp = false;
    for (const ch of [...this.socketChannels]) ch._error();
    if (reconnectAfter) setTimeout(() => this.connect(), reconnectAfter);
  }
  current() {
    return this.channels.find((c) => c.state === 'joined');
  }
}

// ── Load the real module once per page (own module graph → own singleton, own fake client) ──
globalThis.__FAKE_SB__ = {};
async function loadPage(name) {
  const rt = new FakeRealtime(name);
  const sb = { realtime: rt, channel: (t, p) => rt.channel(t, p), getChannels: () => rt.getChannels() };
  globalThis.__FAKE_SB__[name] = { sb };
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
        resolveId: (id) => (/backend\/supabase(\.ts)?$/.test(id) ? fake : null),
        load(id) {
          if (id !== fake) return null;
          return `const F = globalThis.__FAKE_SB__[${JSON.stringify(name)}];
            export let authError = ''; export let authStatus = 'ok';
            export const socketBeats = { sent: 0, ok: 0, timeout: 0, error: 0, lastLatency: 0 };
            export const backendConfigured = () => true;
            export const supabase = () => F.sb;
            export const realtimeClient = () => F.sb;
            export const currentUser = () => Promise.resolve(null);`;
        },
      },
    ],
  });
  const mod = await server.ssrLoadModule('/game/src/net/Hub.ts');
  await server.close();
  return { name, rt, mod, listeners: [], self: { room: null, state: 'hub', announce: null } };
}

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
const log = [];
const note = (s) => {
  log.push(`${((now - t0) / 1000).toFixed(1)}s ${s}`);
  if (VERBOSE) console.log(log.at(-1));
};
const failures = [];
const fail = (s) => {
  if (failures.length < 40) failures.push(`${((now - t0) / 1000).toFixed(2)}s ${s}`);
};

// ── Pages ──
const ROUND_END = T(200); // CCCC3's round ends at 200 s (simulated)
const ann = (code, host, humans, phase, pub, city = 'shanghai') => ({ code, host, city, humans, bots: true, phase, public: pub, since: T(0) });
const hostSelf = (a) => () => ({ room: a.public ? a.code : null, state: a.phase === 'playing' ? 'play' : 'lobby', announce: { ...a, left: a.phase === 'playing' ? Math.max(0, (ROUND_END - now) / 1000) : null } });
const specs = [
  ['A-host', hostSelf(ann('AAAA1', 'Alice', 2, 'waiting', true))],
  ['A-guest', () => ({ room: 'AAAA1', state: 'lobby', announce: null })],
  ['B-host', hostSelf(ann('BBBB2', 'Bob', 2, 'waiting', false))], // private: counted, never listed
  ['B-guest', () => ({ room: null, state: 'lobby', announce: null })],
  ['C-host', hostSelf(ann('CCCC3', 'Chen', 2, 'playing', true, 'paris'))],
  ['C-guest', () => ({ room: 'CCCC3', state: 'play', announce: null })],
  ['Solo1', () => ({ room: null, state: 'play', announce: null })],
  ['Solo2', () => ({ room: null, state: 'play', announce: null })],
];
const pages = [];
for (const [name, self] of specs) {
  const p = await loadPage(name);
  p.self = self;
  pages.push(p);
}
const late = await loadPage('Visitor');
late.self = () => ({ room: null, state: 'hub', announce: null });
const byName = (n) => [...pages, late].find((p) => p.name === n);
async function start(p) {
  building = p;
  p.hub = p.mod.HubPresence.start();
  p.hub.setSource(() => p.self());
  p.snapshots = [];
  p.hub.onSnapshot = (s) => !p.gone && !hub.blocked.has(p.name) && p.snapshots.push({ at: (now - t0) / 1000, ...s });
  building = null;
}
for (const [i, p] of pages.entries()) {
  await advanceTo(T(i * 0.3));
  await start(p);
}
const M = pages[0].mod;
if (M.HUB_TIMING.topic !== TOPIC) failures.push(`topic ${M.HUB_TIMING.topic}, expected ${TOPIC}`);

// ── Pure helpers ──
{
  const bad = M.parseRoom({ pub: 1, c: 'ZZZZ9', n: 'fuck you', h: 99, p: 'waiting', ci: '<script>', b: 1, t0: 1 });
  if (!bad || bad.host !== '' || bad.humans !== 4 || bad.city !== '' || Math.abs(bad.since - now) > 1000) failures.push(`parseRoom sanitising: ${JSON.stringify(bad)}`);
  const neg = M.parseRoom({ pub: 1, c: 'NEG01', n: 'Nina', h: -7, p: 'playing', e: -50 });
  if (!neg || neg.humans !== 0 || neg.left !== 0) failures.push(`parseRoom negatives: ${JSON.stringify(neg)}`);
  const huge = M.parseRoom({ pub: 1, c: 'HUG01', n: 'Hugo', h: 1, p: 'playing', e: 1e12 });
  if (!huge || huge.left !== M.HUB_LIMITS.maxLeftS) failures.push(`parseRoom huge "ends in": ${JSON.stringify(huge)}`);
  const long = M.parseRoom({ pub: 1, c: 'LNG01', n: 'Q'.repeat(60), h: 1, p: 'waiting' });
  if (!long || [...long.host].length > 16) failures.push(`parseRoom long name not clipped: ${JSON.stringify(long)}`);
  if (M.parseRoom({ pub: 1, c: 'zz', h: 1, p: 'waiting' }) !== null || M.parseRoom({ pub: 1, c: 'ZZZZ9', h: 1, p: 'dancing' }) !== null || M.parseRoom({ pub: 1, c: 'ZZZZ9', h: 1, p: 'waiting', n: 'x'.repeat(500) }) !== null || M.parseRoom('x') !== null || M.parseRoom([1]) !== null)
    failures.push('parseRoom accepted a malformed room');
  if (M.normalizeCode(' ab-c1 ') !== 'ABC1' || M.normalizeCode('abc') !== null || M.normalizeCode('ABCDEFGHJ') !== null) failures.push('normalizeCode');
  const r = (code, humans, phase) => ({ code, host: '', city: '', humans, bots: true, phase, public: true, since: 0 });
  const order = M.sortRooms([r('P0001', 3, 'playing'), r('F0001', 4, 'waiting'), r('W0001', 1, 'waiting'), r('U0001', 2, 'warmup'), r('W0002', 3, 'waiting'), r('R0001', 1, 'results')]).map((x) => x.code).join(',');
  if (order !== 'W0002,W0001,U0001,R0001,P0001,F0001') failures.push(`sortRooms → ${order} (waiting rooms with most players first)`);
}

// ── Expectations ──
let expectOnline = 8;
let expectRooms = { AAAA1: [2, 'waiting'], CCCC3: [2, 'playing'] };
let expectPrivate = 1;
const live = () => [...pages, late].filter((p) => p.hub && !p.gone);
const counts = {};
function sample(label) {
  for (const p of live()) {
    const v = p.hub.view();
    if (!v.available) {
      fail(`${label} ${p.name} view not available (status ${v.status})`);
      continue;
    }
    if (v.online !== expectOnline) fail(`${label} ${p.name} online=${v.online} expected ${expectOnline}`);
    const got = Object.fromEntries(v.rooms.map((r) => [r.code, [r.humans, r.phase]]));
    if (JSON.stringify(Object.entries(got).sort()) !== JSON.stringify(Object.entries(expectRooms).sort())) fail(`${label} ${p.name} rooms=${JSON.stringify(got)} expected ${JSON.stringify(expectRooms)}`);
    if (v.rooms.some((r) => r.code === 'BBBB2' || !r.public)) fail(`${p.name} lists the private room`);
    if (v.privateRooms !== expectPrivate) fail(`${label} ${p.name} privateRooms=${v.privateRooms} expected ${expectPrivate}`);
    const c3 = v.rooms.find((r) => r.code === 'CCCC3');
    if (c3 && (c3.joinable || !c3.endsAt || Math.abs(c3.endsAt - ROUND_END) > 1500)) fail(`${label} ${p.name} CCCC3 joinable=${c3.joinable} endsAt off by ${c3.endsAt ? (c3.endsAt - ROUND_END) / 1000 : 'n/a'} s`);
    const a1 = v.rooms.find((r) => r.code === 'AAAA1');
    if (a1 && (!a1.joinable || a1.full || a1.host !== 'Alice')) fail(`${label} AAAA1 not joinable / wrong host`);
    const c = (counts[p.name] ??= { last: v.online, changes: 0 });
    if (v.online !== c.last) (c.changes++, (c.last = v.online));
  }
}

// ── Chaos: server CLOSE on each page in turn / on all at once, socket drops ──
const serverClose = (p) => note(`server CLOSE ${p.name}: ${p.rt.current()?.serverClose() ? 'closed' : 'none'}`);
const chaos = [
  [14, () => serverClose(byName('A-host'))],
  [21, () => live().forEach(serverClose)],
  [28, () => (note('socket drop Solo1 3s'), byName('Solo1').rt.disconnect(3000))],
  [33, () => (note('socket drop C-host 6s'), byName('C-host').rt.disconnect(6000))],
  [44, () => (serverClose(byName('B-guest')), serverClose(byName('C-guest')))],
  [58, () => live().forEach(serverClose)],
];
for (const [s, fn] of chaos) setTimeout(fn, T(s) - now);

// Phase 1 (5–70 s): 8 pages, 3 rooms (1 private), channel churn. Counts must hold the whole time.
for (let s = 5; s <= 70; s += 0.25) {
  await advanceTo(T(s));
  sample('p1');
}
for (const p of pages) {
  const n = p.rt.sent.hb ?? 0;
  if (n > 70 / 2 || n < 70 / 4.5) failures.push(`${p.name} sent ${n} beats in 70 s (expected ~3 s cadence)`);
}

// Phase 2: a visitor opens the room browser: full directory within ~1 s (digest from the lowest id).
await start(late);
const arrived = now;
let fullAfter = null;
for (let ms = 100; ms <= 6000; ms += 100) {
  await advanceTo(arrived + ms);
  const v = late.hub.view();
  if (fullAfter === null && v.rooms.length === 2 && v.online === 9 && v.privateRooms === 1) fullAfter = ms;
}
if (fullAfter === null || fullAfter > 1200) failures.push(`late visitor saw the full directory after ${fullAfter} ms (expected ≤1200 via digest)`);
note(`Visitor full directory after ${fullAfter} ms`);
expectOnline = 9;
for (let s = (now - t0) / 1000 + 0.25; s <= 85; s += 0.25) {
  await advanceTo(T(s));
  sample('p2');
}

// Phase 3: Alice's guest goes silent (frozen tab, no goodbye) → gone everywhere within 10 s;
// Alice's page notices the peer left and announces 1 human.
hub.blocked.add('A-guest');
byName('A-guest').gone = true;
note('A-guest frozen');
const frozenAt = now;
let silentGone = null;
for (let ms = 250; ms <= 14000; ms += 250) {
  await advanceTo(frozenAt + ms);
  if (silentGone === null && live().every((p) => p.hub.view().online === 8)) silentGone = ms;
}
if (silentGone === null || silentGone > 10_000) failures.push(`silent page disappeared after ${silentGone} ms (expected ≤ 10 000)`);
if (silentGone !== null && silentGone < 6000) failures.push(`silent page dropped too early (${silentGone} ms: its last beat was ≤ 3.3 s before the freeze, timeout 10 s)`);
byName('A-host').self = hostSelf(ann('AAAA1', 'Alice', 1, 'waiting', true));
expectOnline = 8;
expectRooms = { AAAA1: [1, 'waiting'], CCCC3: [2, 'playing'] };
await advanceTo(now + 2500); // a change is announced within changeMinGapMs
for (let s = (now - t0) / 1000 + 0.25; s <= 105; s += 0.25) {
  await advanceTo(T(s));
  sample('p3');
}

// Phase 4: Chen (host of CCCC3) closes the tab → the room is gone at once, his guest remains.
for (const l of byName('C-host').listeners) if (l.kind === 'window' && l.type === 'pagehide') l.fn();
hub.blocked.add('C-host');
byName('C-host').gone = true;
note('C-host pagehide');
await advanceTo(now + 500);
expectOnline = 7;
expectRooms = { AAAA1: [1, 'waiting'] };
for (let s = (now - t0) / 1000 + 0.25; s <= 112; s += 0.25) {
  await advanceTo(T(s));
  sample('p4');
}

// Phase 5: hostile traffic. Nothing may crash, junk is dropped, the rest is clamped.
const V = () => late.hub.view();
const diag = (p) => p.hub.diagnostics();
const evil = [
  ['hb', null],
  ['hb', 'lol'],
  ['hb', { from: 'x', s: 'hub', i: 4 }],
  ['hb', { from: 'h-ABCDEFGH', s: 'hub', i: 4 }],
  ['hb', { from: 'h-' + 'a'.repeat(80), s: 'hub', i: 4 }],
  ['hb', { from: 'h-evil0001', s: 'sleeping', i: 4 }],
  ['hb', { from: 'h-evil0002', s: 'hub', i: -9, rm: { pub: 1, c: '../x', h: 2, p: 'waiting' } }],
  ['hb', { from: 'h-evil0003', s: 'lobby', i: 1e9, rm: { pub: 1, c: 'NAME1', n: '𝕏'.repeat(3000), h: 1, p: 'waiting' } }],
  ['hb', { from: 'h-evil0004', s: 'lobby', i: 0.001, rm: { pub: 1, c: 'ZZZZ9', n: 'f.u.c.k', h: 99, p: 'waiting', ci: '<img src=x>', b: 1 } }],
  ['hb', { from: 'h-evil0005', s: 'play', i: 3, rm: { pub: 1, c: 'NEG77', n: 'Mallory Mallory Mallory', h: -3, p: 'playing', e: -99 } }],
  ['dg', { from: 'h-evil0006', cl: 'nope', rm: [[1, 2, 3, 4]] }],
  ['dg', { from: 'h-evil0007', cl: Array.from({ length: 3000 }, (_, i) => [`h-dgfake${String(i).padStart(4, '0')}`, 0, 3, 'hub']) }],
  ['bye', { from: 12 }],
];
for (const [e, pl] of evil) hub.inject(TOPIC, e, pl);
await advanceTo(now + 1000);
{
  const v = V();
  // + evil0002, 0003, 0004, 0005 (valid ids / states; their rooms are cleaned or dropped). The
  // 3000-row digest is over the size cap and ignored.
  if (v.online !== 11) failures.push(`hostile: online=${v.online} (expected 7 + 4 valid hostile ids = 11)`);
  const z = v.rooms.find((r) => r.code === 'ZZZZ9');
  if (!z || z.host !== '' || z.humans !== 4 || !z.full || z.city !== '') failures.push(`hostile room not sanitised: ${JSON.stringify(z)}`);
  const n = v.rooms.find((r) => r.code === 'NEG77');
  if (!n || n.humans !== 0 || [...n.host].length > 16 || n.endsAt > now + 1) failures.push(`negative room not clamped: ${JSON.stringify(n)}`);
  if (v.rooms.some((r) => r.code === 'NAME1')) failures.push('oversized room payload was listed');
  if (v.rooms.some((r) => r.code.includes('/'))) failures.push('hostile code listed');
}
// A claimed interval is clamped to the 120 s ceiling (timeout 302 s); its goodbye removes it.
{
  const e3 = diag(late).clients['h-evil0003'];
  if (!e3 || e3.i !== M.HUB_TIMING.maxIntervalMs) failures.push(`hostile interval not clamped: ${JSON.stringify(e3)}`);
  if (diag(late).clients['h-evil0002']?.i !== M.HUB_TIMING.baseIntervalMs) failures.push('negative interval not clamped to the base');
  hub.inject(TOPIC, 'bye', { from: 'h-evil0003' });
  await advanceTo(now + 300);
}
// A single id flooding 1000 beats in one second: only a handful are processed.
const flood = byName('Solo2');
const before = diag(late).counters.hbRecv;
for (let i = 0; i < 1000; i++) setTimeout(() => hub.inject(TOPIC, 'hb', { from: 'h-flood001', s: 'hub', i: 3 }), i);
await advanceTo(now + 1200);
const floodProcessed = diag(late).counters.hbRecv - before;
if (floodProcessed > 12) failures.push(`one id flooding 1000 beats/s: ${floodProcessed} processed (expected ≤ ~5 + real beats)`);
void flood;
// 1000 fake ids at once: tracked ids stay ≤ 500 and every real page stays counted.
const fakes = Array.from({ length: 1000 }, (_, i) => `h-fake${String(i).padStart(4, '0')}`);
for (const cid of fakes) hub.inject(TOPIC, 'hb', { from: cid, s: 'hub', i: 3 });
const realIds = live().map((p) => p.hub.cid);
let maxOnline = 0;
for (let ms = 250; ms <= 8000; ms += 250) {
  await advanceTo(now + 250);
  for (const p of live()) {
    const v = p.hub.view();
    maxOnline = Math.max(maxOnline, v.online);
    if (v.online > M.HUB_LIMITS.maxClients) fail(`flood: ${p.name} online=${v.online} > cap`);
    const d = p.hub.diagnostics();
    if (Object.keys(d.clients).length > M.HUB_LIMITS.maxClients) fail(`flood: ${p.name} tracks ${Object.keys(d.clients).length} ids`);
    for (const id of realIds) if (id !== p.hub.cid && !d.clients[id]) fail(`flood: ${p.name} lost real page ${id}`);
    if (!v.rooms.some((r) => r.code === 'AAAA1')) fail(`flood: ${p.name} lost room AAAA1`);
  }
}
if (!V().capped && maxOnline < M.HUB_LIMITS.maxClients) note(`flood peak online ${maxOnline}`);
note(`flood: peak online ${maxOnline}, capped=${V().capped}`);
// Silence: 10 s after their last beat every fake / hostile entry is gone.
await advanceTo(now + 11_000);
for (const p of live()) {
  const v = p.hub.view();
  if (v.online !== 7 || v.capped || v.rooms.some((r) => r.code === 'ZZZZ9' || r.code === 'NEG77')) failures.push(`after the flood ${p.name}: online=${v.online} capped=${v.capped} rooms=${v.rooms.map((r) => r.code)}`);
}
const floodEnd = (now - t0) / 1000;
for (let s = floodEnd + 0.25; s <= floodEnd + 10; s += 0.25) {
  await advanceTo(T(s));
  sample('p5');
}

// Phase 6: 60 synthetic pages (a busy evening): the interval stretches (N² / budget), the count
// reads 67, and they leave by timeout without a goodbye.
const synth = Array.from({ length: 60 }, (_, i) => `h-synth${String(i).padStart(3, '0')}`);
// Like real pages they arrive at the base cadence and stretch once everyone sees the crowd.
const synthBeat = (i) => {
  for (const cid of synth) hub.inject(TOPIC, 'hb', { from: cid, s: cid.endsWith('0') ? 'play' : 'hub', i });
};
const synthI = 60;
const rampTimer = setInterval(() => synthBeat(3), 3000);
synthBeat(3);
await advanceTo(now + 10_500);
clearInterval(rampTimer);
await advanceTo(now + 1500);
synthBeat(synthI);
const synthTimer = setInterval(() => synthBeat(synthI), synthI * 1000);
const busyAt = (now - t0) / 1000 + 5;
await advanceTo(T(busyAt));
const sentBefore = Object.fromEntries(live().map((p) => [p.name, p.rt.sent.hb ?? 0]));
for (let s = busyAt; s <= busyAt + 120; s += 1) {
  await advanceTo(T(s));
  for (const p of live()) if (p.hub.view().online !== 67) fail(`busy: ${p.name} online=${p.hub.view().online} (expected 67)`);
}
const intervals = live().map((p) => p.hub.intervalMs());
if (intervals.some((i) => i < (67 * 67 * 1000) / M.HUB_TIMING.deliveriesPerSec - 1)) failures.push(`busy: intervals ${intervals.join(',')} did not stretch to N²/budget`);
for (const p of live()) {
  const n = (p.rt.sent.hb ?? 0) - sentBefore[p.name];
  if (n > 3) failures.push(`busy: ${p.name} sent ${n} beats in 120 s at 67 pages (expected ≤3)`);
}
clearInterval(synthTimer);
note('synthetic pages vanish');
const vanishAt = now;
let back = null;
for (let s = 1; s <= 200; s++) {
  await advanceTo(vanishAt + s * 1000);
  if (back === null && late.hub.view().online === 7) back = s;
}
if (back === null || back > 155) failures.push(`synthetic pages expired after ${back} s (expected ≤ 152 s)`);
await advanceTo(now + 130_000);
const small = live().map((p) => p.hub.intervalMs());
if (small.some((i) => i !== M.HUB_TIMING.baseIntervalMs)) failures.push(`intervals after the crowd left: ${small.join(',')}`);
if (live().some((p) => p.hub.view().online !== 7)) failures.push(`after the crowd: ${live().map((p) => p.hub.view().online).join(',')}`);

// ── Privacy: the private room's code never went over the wire ──
if (hub.wire.some((w) => w.includes('BBBB2'))) failures.push('the private room code BBBB2 was broadcast');

// ── online_snapshot: at most one page per minute ──
const snaps = [...pages, late].flatMap((p) => (p.snapshots ?? []).map((s) => ({ page: p.name, ...s })));
const perMinute = new Map();
const minuteOf = (s) => Math.floor((t0 + s.at * 1000) / 60_000);
for (const s of snaps) perMinute.set(minuteOf(s), (perMinute.get(minuteOf(s)) ?? 0) + 1);
if (snaps.length < 4) failures.push(`only ${snaps.length} online_snapshot events in ${Math.round((now - t0) / 60000)} min`);
if ([...perMinute.values()].some((n) => n > 1)) failures.push(`duplicate online_snapshot in a minute: ${JSON.stringify([...perMinute])}`);

// ── No flapping during the sampled phases ──
const flaps = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v.changes]));
for (const [k, n] of Object.entries(flaps)) if (n > 5) failures.push(`${k} online count changed ${n} times (flapping)`);

const report = {
  seed: SEED,
  simulatedSeconds: Math.round((now - t0) / 1000),
  lateVisitorFullListMs: fullAfter,
  silentPageGoneMs: silentGone,
  floodOneIdProcessed: floodProcessed,
  floodPeakOnline: maxOnline,
  syntheticGoneS: back,
  busyIntervalsMs: intervals,
  beatsSent: Object.fromEntries([...pages, late].map((p) => [p.name, p.rt.sent])),
  countChanges: flaps,
  snapshots: snaps.map((s) => `${s.at.toFixed(0)}s ${s.page} online=${s.online} rooms=${s.rooms} playing=${s.playing}`),
  deliveries: hub.deliveries,
  chaos: log,
  failures,
};
console.log(JSON.stringify(report, null, 2));
console.log(failures.length ? `FAIL (${failures.length} problems)` : 'PASS: online = 8 through channel churn, only public rooms listed, silent pages gone within 10 s, hostile payloads clamped / capped');
process.exit(failures.length ? 1 : 0);
