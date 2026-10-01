// Room browser / lobby presence test — deterministic, no network.
//
// Pages run the real game/src/net/Hub.ts client against a fake Postgres backend that mirrors
// supabase/migrations/0004_lobby_presence.sql (lobby_beat: validation, clamping, 4 s per-page
// rate limit, 5000 live-row cap; lobby_snapshot: 30 s window, public rooms only, waiting rooms
// with most players first), with per-call latency, on a virtual clock:
//   · 3 rooms × (host + guest) — AAAA1 public waiting, BBBB2 PRIVATE, CCCC3 public playing —
//     plus 2 solo pages and a visitor on the room browser: online 9, only the two public rooms
//     listed with the right players / phases / "ends in", 3 rooms counted;
//   · pages in a round never poll; the browser polls every 5 s, a room lobby every 15 s;
//   · a page that goes silent disappears within 30 s (+ one poll); a host that leaves takes its
//     room with it; a host's state change reaches the browser within ~11 s, beats ≥ 5 s apart;
//   · hostile beats (huge names, negative / huge numbers, junk, 1000 fake ids, one id spamming)
//     are clamped / rate-limited server-side, and a hostile snapshot is clamped client-side;
//   · RPC volume is linear: 100 vs 200 pages, and < 200·4 beats + viewers·12 snapshots per minute;
//   · no Realtime channel is ever opened.
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

// ── Deterministic RNG (Math.random too: tab ids) ──
let rs = SEED >>> 0;
const rand = () => {
  rs = (rs + 0x6d2b79f5) >>> 0;
  let t = rs;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
Math.random = rand;

// ── Browser globals ──
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.document = { visibilityState: 'visible', addEventListener() {} };
globalThis.location = { search: '', href: 'http://localhost/game/', hostname: 'localhost' };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'en', languages: ['en'] }, configurable: true });

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

// ── Fake backend: the SQL functions, in JS ──
const db = {
  rows: new Map(), // client_id → { seen, where, code, room }
  calls: { lobby_beat: 0, lobby_snapshot: 0 },
  accepted: 0,
  acceptedBy: new Map(),
  realtimeOpened: 0,
};
const CID = /^h-[a-z0-9]{6,16}$/;
const CODE = /^[A-Z0-9]{4,8}$/;
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function sqlBeat(id, where, room) {
  if (typeof id !== 'string' || !CID.test(id)) return;
  if (!['browser', 'room', 'solo'].includes(where)) return;
  if (room !== null && room !== undefined && (typeof room !== 'object' || Array.isArray(room) || JSON.stringify(room).length > 2000)) return;
  const last = db.rows.get(id);
  if (last && last.seen > now - 4000) return;
  if (!last && [...db.rows.values()].filter((r) => r.seen > now - 30_000).length >= 5000) return;
  let code = null;
  if (where === 'room' && room) {
    code = String(room.code ?? '').toUpperCase();
    if (!CODE.test(code)) code = null;
  }
  let summary = null;
  if (code && room.host === true && ['waiting', 'warmup', 'playing', 'results'].includes(room.phase)) {
    const n = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? clampN(Math.round(v), lo, hi) : d);
    summary = {
      name: String(room.name ?? '')
        .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 16),
      city: /^[a-z0-9_-]{1,24}$/.test(room.city ?? '') ? room.city : '',
      players: n(room.players, 0, 4, 0),
      max: n(room.max, 1, 4, 4),
      phase: room.phase,
      public: room.public === true,
      bots: room.bots === true,
      ends_in: room.phase === 'playing' || room.phase === 'results' ? n(room.ends_in, 0, 900, null) : null,
    };
  }
  db.accepted++;
  db.acceptedBy.set(id, (db.acceptedBy.get(id) ?? 0) + 1);
  db.rows.set(id, { seen: now, where, code, room: summary });
}
function sqlSnapshot() {
  const live = [...db.rows.values()].filter((r) => r.seen > now - 30_000);
  const hosts = new Map();
  for (const r of live) if (r.where === 'room' && r.code && r.room && (!hosts.has(r.code) || hosts.get(r.code).seen < r.seen)) hosts.set(r.code, r);
  const rank = (r) => (r.room.players >= r.room.max ? 4 : { waiting: 0, warmup: 1, results: 2, playing: 3 }[r.room.phase]);
  const pub = [...hosts.values()].filter((r) => r.room.public);
  pub.sort((a, b) => rank(a) - rank(b) || b.room.players - a.room.players || (a.code < b.code ? -1 : 1));
  return {
    online: live.length,
    rooms: new Set(live.filter((r) => r.where === 'room' && r.code).map((r) => r.code)).size,
    public: pub.length,
    list: pub.slice(0, 50).map((r) => {
      const { public: _p, ...rest } = r.room;
      return { ...rest, code: r.code, age: Math.round((now - r.seen) / 100) / 10 };
    }),
  };
}
/** An RPC as the browser makes it: request latency, server work, response latency. */
function rpcFor(page) {
  return (fn, args) =>
    new Promise((resolve) => {
      if (page.frozen) return; // a frozen page's requests never complete
      db.calls[fn]++;
      page.calls[fn] = (page.calls[fn] ?? 0) + 1;
      if (fn === 'lobby_beat') page.beatTimes.push(now);
      setTimeout(() => {
        if (page.backendDown) return resolve({ data: null, error: { message: 'down' } });
        let data = null;
        if (fn === 'lobby_beat') sqlBeat(args.p_client_id, args.p_where, args.p_room);
        else data = sqlSnapshot();
        setTimeout(() => resolve({ data, error: null }), 20 + rand() * 40);
      }, 20 + rand() * 40);
    });
}

// ── The real module (one load; one HubPresence instance per simulated page) ──
const fake = '\0fake-supabase';
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
        return `export const backendConfigured = () => true;
          export const supabase = () => ({ rpc: () => Promise.reject(new Error('use the test rpc')), channel() { globalThis.__DB__.realtimeOpened++; } });
          export const realtimeClient = () => { globalThis.__DB__.realtimeOpened++; return null; };
          export const currentUser = () => Promise.resolve(null);
          export let authError = ''; export let authStatus = 'ok';
          export const socketBeats = {};`;
      },
    },
  ],
});
globalThis.__DB__ = db;
const M = await server.ssrLoadModule('/game/src/net/Hub.ts');
await server.close();

const pages = [];
function open(name, self) {
  const p = { name, self, calls: {}, beatTimes: [], frozen: false };
  p.hub = new M.HubPresence(rpcFor(p));
  p.hub.setSource(() => p.self());
  pages.push(p);
  return p;
}
const byName = (n) => pages.find((p) => p.name === n);

// ── Pure helpers ──
{
  const self = { room: 'aaaa1', state: 'lobby', announce: { code: 'AAAA1', host: 'x'.repeat(40), city: '<b>', humans: 99, bots: true, phase: 'waiting', public: true, since: 0, left: -5 } };
  const a = M.roomArg(self);
  if (!a || a.code !== 'AAAA1' || a.host !== true || a.name.length > 16 || a.city !== '' || a.players !== 4 || a.ends_in !== 0) failures.push(`roomArg not clamped: ${JSON.stringify(a)}`);
  if (JSON.stringify(a).length > 600) failures.push('roomArg too large');
  if (M.whereOf({ room: null, state: 'hub', announce: null }) !== 'browser' || M.whereOf({ room: null, state: 'play', announce: null }) !== 'solo' || M.whereOf({ room: 'BBBB2', state: 'lobby', announce: null }) !== 'room') failures.push('whereOf');
  if (M.roomArg({ room: 'x', state: 'lobby', announce: null }) !== null) failures.push('roomArg accepted a bad code');
  // A hostile / broken snapshot is clamped client-side too.
  const evil = {
    online: -3,
    rooms: 1e12,
    public: 'lots',
    list: [
      { code: 'ZZZZ9', name: 'fuck you', city: '<script>', players: 99, max: 99, phase: 'waiting', bots: 'yes', ends_in: 5, age: -100 },
      { code: 'NEG77', name: 'Ne\u0007g'.repeat(30), players: -4, phase: 'playing', ends_in: -9, age: 1e9 },
      { code: '../x', name: 'a', players: 1, phase: 'waiting' },
      { code: 'BAD00', players: 1, phase: 'sleeping' },
      'junk',
      null,
      ...Array.from({ length: 1000 }, (_, i) => ({ code: `F${String(i).padStart(4, '0')}`, name: 'f', players: 1, phase: 'waiting' })),
    ],
  };
  const s = M.parseSnapshot(evil, now);
  if (!s || s.online !== 0 || s.list.length > 50) failures.push(`parseSnapshot bounds: online=${s?.online} list=${s?.list.length}`);
  const z = s?.list.find((r) => r.code === 'ZZZZ9');
  if (!z || z.host !== '' || z.humans !== 4 || !z.full || z.city !== '' || z.bots !== false || z.endsAt !== 0 || z.updatedAt !== now) failures.push(`parseSnapshot ZZZZ9: ${JSON.stringify(z)}`);
  const n = s?.list.find((r) => r.code === 'NEG77');
  if (!n || n.humans !== 0 || [...n.host].length > 16 || /\u0007/.test(n.host) || n.endsAt !== now - 60_000) failures.push(`parseSnapshot NEG77: ${JSON.stringify(n)}`);
  if (s?.list.some((r) => r.code === '../x' || r.code === 'BAD00')) failures.push('parseSnapshot kept a malformed room');
  if (M.parseSnapshot('x', now) !== null || M.parseSnapshot([1], now) !== null || M.parseSnapshot({ list: 'x'.repeat(70_000) }, now) !== null) failures.push('parseSnapshot accepted junk');
}

// ── Scenario ──
const ROUND_END = T(200);
const ann = (code, host, humans, phase, pub, city = 'shanghai') => ({ code, host, city, humans, bots: true, phase, public: pub, since: 0 });
const hostSelf = (a) => () => ({ room: a.code, state: a.phase === 'playing' ? 'play' : 'lobby', announce: { ...a, left: a.phase === 'playing' ? Math.max(0, (ROUND_END - now) / 1000) : null } });
const specs = [
  ['A-host', hostSelf(ann('AAAA1', 'Alice', 2, 'waiting', true))],
  ['A-guest', () => ({ room: 'AAAA1', state: 'lobby', announce: null })],
  ['B-host', hostSelf(ann('BBBB2', 'Bob', 2, 'waiting', false))],
  ['B-guest', () => ({ room: 'BBBB2', state: 'lobby', announce: null })],
  ['C-host', hostSelf(ann('CCCC3', 'Chen', 2, 'playing', true, 'paris'))],
  ['C-guest', () => ({ room: 'CCCC3', state: 'play', announce: null })],
  ['Solo1', () => ({ room: null, state: 'play', announce: null })],
  ['Solo2', () => ({ room: null, state: 'play', announce: null })],
  ['Visitor', () => ({ room: null, state: 'hub', announce: null })],
];
for (const [i, [name, self]] of specs.entries()) {
  await advanceTo(T(i * 0.4));
  open(name, self);
}

let expectOnline = 9;
let expectRooms = { AAAA1: [2, 'waiting'], CCCC3: [2, 'playing'] };
let expectPrivate = 1;
const viewers = () => pages.filter((p) => !p.frozen && ['hub', 'lobby'].includes(p.self().state));
function sample(label, who = viewers()) {
  for (const p of who) {
    const v = p.hub.view();
    if (!v.available) {
      fail(`${label} ${p.name} view not available (${v.status})`);
      continue;
    }
    if (v.online !== expectOnline) fail(`${label} ${p.name} online=${v.online} expected ${expectOnline}`);
    const got = Object.fromEntries(v.rooms.map((r) => [r.code, [r.humans, r.phase]]));
    if (JSON.stringify(Object.entries(got).sort()) !== JSON.stringify(Object.entries(expectRooms).sort())) fail(`${label} ${p.name} rooms=${JSON.stringify(got)} expected ${JSON.stringify(expectRooms)}`);
    if (v.rooms.some((r) => r.code === 'BBBB2')) fail(`${label} ${p.name} lists the private room`);
    if (v.privateRooms !== expectPrivate) fail(`${label} ${p.name} privateRooms=${v.privateRooms} expected ${expectPrivate}`);
    const c3 = v.rooms.find((r) => r.code === 'CCCC3');
    if (c3 && (c3.joinable || !c3.endsAt || Math.abs(c3.endsAt - ROUND_END) > 1500)) fail(`${label} ${p.name} CCCC3 endsAt off by ${c3.endsAt ? (c3.endsAt - ROUND_END) / 1000 : 'n/a'} s`);
  }
}

// Phase 1: the room browser has the full picture within ~1 s of opening.
let firstFull = null;
for (let ms = 100; ms <= 5000; ms += 100) {
  await advanceTo(T(3.2) + ms);
  const v = byName('Visitor').hub.view();
  if (firstFull === null && v.available && v.online === 9 && v.rooms.length === 2) firstFull = ms;
}
if (firstFull === null || firstFull > 1500) failures.push(`visitor saw the directory after ${firstFull} ms (expected ≤ 1500)`);
note(`visitor full directory ${firstFull} ms after opening`);
// Room lobbies poll every 15 s: give every lobby one poll before sampling them.
await advanceTo(T(20));
for (let s = 20; s <= 80; s += 0.5) {
  await advanceTo(T(s));
  sample('p1');
}
for (const p of pages) {
  const polls = p.calls.lobby_snapshot ?? 0;
  const beats = p.calls.lobby_beat ?? 0;
  const st = p.self().state;
  if ((st === 'play' || st === 'watch') && polls) failures.push(`${p.name} (in a round) polled ${polls} times`);
  if (st === 'hub' && (polls < 80 / 5 - 2 || polls > 80 / 5 + 2)) failures.push(`${p.name} (browser) polled ${polls} times in 80 s (expected ~16)`);
  if (st === 'lobby' && (polls < 80 / 15 - 1 || polls > 80 / 15 + 2)) failures.push(`${p.name} (room lobby) polled ${polls} times in 80 s (expected ~5)`);
  if (beats < 80 / 15 - 1 || beats > 80 / 15 + 2) failures.push(`${p.name} beat ${beats} times in 80 s (expected ~5-6)`);
}

// Phase 2: A's guest freezes (no goodbye): gone within 30 s of its last beat (+ one poll).
byName('A-guest').frozen = true;
note('A-guest frozen');
const frozenAt = now;
let silentGone = null;
for (let ms = 500; ms <= 50_000; ms += 500) {
  await advanceTo(frozenAt + ms);
  if (silentGone === null && byName('Visitor').hub.view().online === 8) silentGone = ms;
}
if (silentGone === null || silentGone > 36_000) failures.push(`silent page disappeared after ${silentGone} ms (expected ≤ 36 s)`);
if (silentGone !== null && silentGone < 14_000) failures.push(`silent page dropped too early (${silentGone} ms)`);
expectOnline = 8;

// Phase 3: Alice's room changes three times within 2 s → one beat (≥ 5 s apart); visible in ≤ 11 s.
const A = byName('A-host');
const changeAt = now;
A.self = hostSelf(ann('AAAA1', 'Alice', 1, 'waiting', true));
await advanceTo(now + 700);
A.self = hostSelf(ann('AAAA1', 'Alice', 1, 'warmup', true));
await advanceTo(now + 700);
A.self = hostSelf(ann('AAAA1', 'Alice', 1, 'waiting', true));
let seenAfter = null;
for (let ms = 250; ms <= 20_000; ms += 250) {
  await advanceTo(changeAt + 1400 + ms);
  const r = byName('Visitor').hub.view().rooms.find((x) => x.code === 'AAAA1');
  if (seenAfter === null && r?.humans === 1) seenAfter = 1400 + ms;
}
if (seenAfter === null || seenAfter > 11_500) failures.push(`host change reached the browser after ${seenAfter} ms (expected ≤ ~11 s)`);
const gaps = A.beatTimes.slice(1).map((t, i) => t - A.beatTimes[i]);
if (gaps.some((g) => g < 5000)) failures.push(`host beats closer than 5 s: ${gaps.join(',')}`);
if (A.beatTimes.filter((t) => t >= changeAt && t < changeAt + 5000).length > 1) failures.push('three quick changes caused more than one beat within 5 s');
expectRooms = { AAAA1: [1, 'waiting'], CCCC3: [2, 'playing'] };
await advanceTo(now + 16_000);
for (let s0 = (now - t0) / 1000, s = s0; s <= s0 + 20; s += 0.5) {
  await advanceTo(T(s));
  sample('p3');
}

// Phase 4: Chen (host of CCCC3) closes the tab → his room is gone within 30 s (+ a poll).
// (His guest goes back to the room browser.)
byName('C-host').frozen = true;
byName('C-guest').self = () => ({ room: null, state: 'hub', announce: null });
note('C-host closed');
const closedAt = now;
let roomGone = null;
for (let ms = 500; ms <= 50_000; ms += 500) {
  await advanceTo(closedAt + ms);
  if (roomGone === null && !byName('Visitor').hub.view().rooms.some((r) => r.code === 'CCCC3')) roomGone = ms;
}
if (roomGone === null || roomGone > 36_000) failures.push(`closed host's room gone after ${roomGone} ms (expected ≤ 36 s)`);
expectOnline = 7;
expectRooms = { AAAA1: [1, 'waiting'] };
for (let s0 = (now - t0) / 1000, s = s0; s <= s0 + 20; s += 0.5) {
  await advanceTo(T(s));
  sample('p4');
}

// Phase 5: hostile clients call the RPC directly.
const hostile = [
  ['h-evil0001', 'room', { code: 'ZZZZ9', host: true, name: 'a\u0007very​long name '.repeat(40), city: '<img>', players: -5, max: 99, phase: 'waiting', public: true, bots: 'yes' }],
  ['h-evil0002', 'room', { code: 'NEG77', host: true, name: 'Neg', players: 2, phase: 'playing', public: true, ends_in: 1e12 }],
  ['h-evil0003', 'room', { code: '../x', host: true, players: 3, phase: 'waiting', public: true }],
  ['h-evil0004', 'room', { code: 'HUGE1', host: true, name: 'x'.repeat(5000), players: 1, phase: 'waiting', public: true }],
  ['not-an-id', 'browser', null],
  ['h-evil0005', 'dancing', null],
  ['h-evil0006', 'room', 'string'],
];
for (const [id, w, r] of hostile) sqlBeat(id, w, r);
for (let i = 0; i < 100; i++) {
  await advanceTo(now + 10);
  sqlBeat('h-spam0001', 'browser', null);
}
const spamAccepted = db.acceptedBy.get('h-spam0001') ?? 0;
if (spamAccepted !== 1) failures.push(`one id spamming 100 beats/s: ${spamAccepted} accepted (expected 1)`);
const fakes = Array.from({ length: 1000 }, (_, i) => `h-fake${String(i).padStart(5, '0')}`);
for (const id of fakes) sqlBeat(id, 'browser', null);
await advanceTo(now + 6000);
{
  const v = byName('Visitor').hub.view();
  // 7 real + evil0001, 0002, 0003 + spam + 1000 fakes (the server cap is 5000 live rows)
  if (v.online !== 7 + 3 + 1 + 1000) failures.push(`hostile: online=${v.online} expected ${7 + 3 + 1 + 1000}`);
  const z = v.rooms.find((r) => r.code === 'ZZZZ9');
  if (!z || z.humans !== 0 || [...z.host].length > 16 || /[\u0007​]/.test(z.host) || z.city !== '' || z.bots) failures.push(`hostile room not clamped: ${JSON.stringify(z)}`);
  const n = v.rooms.find((r) => r.code === 'NEG77');
  if (!n || n.endsAt - now > 900_000 + 1000) failures.push(`ends_in not clamped: ${JSON.stringify(n)}`);
  if (v.rooms.some((r) => r.code === 'HUGE1' || r.code.includes('/'))) failures.push('malformed room listed');
}
// They stop: 30 s later (+ a poll) everything hostile is gone.
await advanceTo(now + 36_000);
{
  const v = byName('Visitor').hub.view();
  if (v.online !== 7 || v.rooms.some((r) => ['ZZZZ9', 'NEG77'].includes(r.code))) failures.push(`hostile entries did not expire: online=${v.online}`);
}

// Phase 6: offline backend → 'error' state (the UI shows "unreachable"), then recovery.
for (const p of pages) p.backendDown = true;
await advanceTo(now + 40_000);
if (byName('Visitor').hub.view().status !== 'error') failures.push(`backend down: visitor status ${byName('Visitor').hub.view().status}`);
for (const p of pages) p.backendDown = false;
await advanceTo(now + 90_000);
if (!byName('Visitor').hub.view().available || byName('Visitor').hub.view().online !== 7) failures.push(`no recovery after the backend came back: ${JSON.stringify(byName('Visitor').hub.view().status)}`);

// ── Phase 7: RPC volume is linear in the number of pages ──
async function crowd(n) {
  for (const p of pages) p.frozen = true;
  await advanceTo(now + 40_000);
  const start = pages.length;
  for (let i = 0; i < n; i++) {
    const st = i < n * 0.2 ? 'hub' : i < n * 0.5 ? 'lobby' : 'play';
    const code = st === 'hub' ? null : `R${String(Math.floor(i / 4)).padStart(4, '0')}`;
    const host = st !== 'hub' && i % 4 === 0;
    open(`crowd${n}-${i}`, host ? hostSelf(ann(code, `H${i}`, 4, st === 'play' ? 'playing' : 'waiting', i % 8 === 0)) : () => ({ room: code, state: st, announce: null }));
    if (i % 10 === 9) await advanceTo(now + 50);
  }
  await advanceTo(now + 30_000); // settle
  const c0 = { ...db.calls };
  await advanceTo(now + 120_000);
  const perMin = { beats: (db.calls.lobby_beat - c0.lobby_beat) / 2, snapshots: (db.calls.lobby_snapshot - c0.lobby_snapshot) / 2 };
  const viewersN = n * 0.5;
  const budget = n * 4 + viewersN * 12;
  const online = pages[start].hub.view().online;
  note(`${n} pages: ${perMin.beats} beats/min, ${perMin.snapshots} snapshots/min (budget ${budget}), browser sees ${online}`);
  if (perMin.beats + perMin.snapshots >= budget) failures.push(`${n} pages: ${perMin.beats + perMin.snapshots} RPC/min ≥ budget ${budget}`);
  if (online !== n) failures.push(`${n} pages: browser page sees online=${online}`);
  return perMin;
}
const c100 = await crowd(100);
const c200 = await crowd(200);
const ratio = (c200.beats + c200.snapshots) / (c100.beats + c100.snapshots);
if (ratio < 1.8 || ratio > 2.2) failures.push(`RPC volume not linear: 200 pages / 100 pages = ${ratio.toFixed(2)}`);

if (db.realtimeOpened) failures.push(`the lobby opened Realtime ${db.realtimeOpened} times`);

const report = {
  seed: SEED,
  simulatedSeconds: Math.round((now - t0) / 1000),
  visitorFirstFullMs: firstFull,
  silentPageGoneMs: silentGone,
  hostChangeVisibleMs: seenAfter,
  closedRoomGoneMs: roomGone,
  spamAccepted,
  rpcPerMinute: { pages100: c100, pages200: c200, ratio: +ratio.toFixed(2) },
  realtimeOpened: db.realtimeOpened,
  log,
  failures,
};
console.log(JSON.stringify(report, null, 2));
console.log(failures.length ? `FAIL (${failures.length} problems)` : 'PASS: online / rooms correct, private rooms hidden, expiry ≤ 30 s + poll, hostile input clamped, RPC volume linear, no Realtime');
process.exit(failures.length ? 1 : 0);
