import { backendConfigured, supabase } from '../backend/supabase';
import { MAX_SEATS, maxPlayersFor } from '../config/arena';
import { cleanName } from '../arena/nameFilter';
import { tabId } from './RealtimeLink';

/**
 * The site directory behind the room browser: "N online · M rooms" and the public room list.
 *
 * Postgres-backed and LINEAR in the number of pages (supabase/migrations/0004_lobby_presence.sql).
 * A first version broadcast a heartbeat from every page to every page on one Realtime channel;
 * Supabase counts every delivery, so that grew with N² (~40 pages ≈ the 500 msg/s quota) and
 * quota disconnects would have taken in-room play down with it. This module opens NO Realtime
 * channel:
 *   · every visible page calls lobby_beat() every 15 s, and on a state change (created / joined
 *     a room, phase change, public ↔ private) — never two beats within 5 s;
 *   · only pages that SHOW the numbers call lobby_snapshot(): the room browser every 5 s, a room
 *     lobby every 15 s, nobody during a round (the in-round chip keeps the last known count);
 *   · the server keeps a row per page and forgets it 30 s after its last beat (no goodbye needed).
 * Everything the server returns is re-validated here (names through cleanName, numbers clamped,
 * lengths capped) — never trust the wire, even our own function's.
 */
export const HUB_TIMING = {
  /** Regular beat. The server counts a page for 30 s after its last beat (2 missed beats). */
  beatMs: 15_000,
  /** A state change beats at once, but never within this long of the previous beat (server: 4 s). */
  changeMinGapMs: 5_000,
  /** Snapshot cadence while the room browser is on screen. */
  browserPollMs: 5_000,
  /** Snapshot cadence in a room lobby (the header counter). */
  lobbyPollMs: 15_000,
  /** After failures, polls back off up to this. */
  maxBackoffMs: 60_000,
  /** Failing this long without a success: status 'error'. */
  errorAfterMs: 12_000,
  /** An RPC that has not answered after this long is abandoned (the next one may go). */
  rpcTimeoutMs: 10_000,
  pumpMs: 1000,
} as const;

export const HUB_LIMITS = { listRooms: 50, maxPlayers: MAX_SEATS, maxLeftS: 900, maxOnline: 1_000_000, maxSnapshotJson: 64_000 } as const;

export type HubState = 'hub' | 'lobby' | 'play' | 'watch';
export type RoomPhase = 'waiting' | 'warmup' | 'playing' | 'results';
const PHASES: readonly RoomPhase[] = ['waiting', 'warmup', 'playing', 'results'];

/** What a room host says about its room. */
export interface RoomAnnounce {
  code: string;
  /** Host nickname (the UI shows "<name>的房间" / "<name>'s room"). */
  host: string;
  city: string;
  humans: number;
  bots: boolean;
  phase: RoomPhase;
  public: boolean;
  /** When the room opened (ms) — "oldest first" among equals (0 = unknown). */
  since: number;
  /** Seconds until the current round (or results screen) ends; null = unknown / not in a round. */
  left?: number | null;
}

/** What this page says about itself (polled each pump). */
export interface HubSelf {
  /** Room code this page is in (public or private; private codes are never listed), null = none. */
  room: string | null;
  state: HubState;
  /** Set only on the host of an online room. */
  announce: RoomAnnounce | null;
}

export interface HubRoom extends RoomAnnounce {
  key: string;
  max: number;
  /** Local time the announcement was made (server age applied). */
  updatedAt: number;
  joinable: boolean;
  full: boolean;
  /** Announced by this page. */
  mine: boolean;
  /** Local time the current round / results screen ends (0 = unknown). */
  endsAt: number;
}

export type HubStatus = 'connecting' | 'connected' | 'error';

export interface HubView {
  /** The number is real and may be shown (a snapshot arrived, the service answers). */
  available: boolean;
  ready: boolean;
  status: HubStatus | 'off';
  /** Pages heard within 30 s (me included). */
  online: number;
  /** Kept for the UI ("N+"); the Postgres directory has no client-side cap. */
  capped: boolean;
  /** Public rooms, best first, at most 50. */
  rooms: HubRoom[];
  /** Rooms that are not listed (private). */
  privateRooms: number;
}

/** The directory as the UI sees it (the live one, or the dev-only demo). */
export interface HubLike {
  view(): HubView;
  onChange(fn: () => void): void;
  whenReady(maxMs: number): Promise<void>;
  setSource(fn: () => HubSelf): void;
}

// ── Validation ──────────────────────────────────────────────────────────────
const CODE = /^[A-Z0-9]{4,8}$/;
const CITY = /^[a-z0-9_-]{1,24}$/;

/** Room code from user input: uppercase letters and digits, 4–8 of them; null otherwise. */
export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return CODE.test(c) ? c : null;
}

export function newRoomCode(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 5; i++) c += abc[Math.floor(Math.random() * abc.length)];
  return c;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Joinable: public, waiting or warming up vs AI, a free seat. */
export function isJoinable(r: RoomAnnounce): boolean {
  return r.public && (r.phase === 'waiting' || r.phase === 'warmup') && r.humans < maxPlayersFor(r.city);
}

/**
 * List order: waiting rooms first (most players first — the fullest open lobby starts soonest),
 * then warm-ups vs AI, results (next round soon), rounds in progress, full rooms; oldest first.
 */
export function sortRooms<T extends RoomAnnounce>(rooms: T[]): T[] {
  const RANK: Record<RoomPhase, number> = { waiting: 0, warmup: 1, results: 2, playing: 3 };
  const rank = (r: T) => (r.humans >= maxPlayersFor(r.city) ? 4 : RANK[r.phase]);
  return rooms.sort((a, b) => rank(a) - rank(b) || b.humans - a.humans || a.since - b.since || (a.code < b.code ? -1 : 1));
}

/** The beat's room argument: {code} for a member, the sanitised summary for the host. */
export function roomArg(self: HubSelf): Record<string, unknown> | null {
  const code = normalizeCode(self.room ?? self.announce?.code);
  if (!code || self.state === 'hub') return null;
  const a = self.announce;
  if (!a || normalizeCode(a.code) !== code) return { code };
  const left = num(a.left);
  return {
    code,
    host: true,
    name: cleanName(a.host, '').slice(0, 16),
    city: CITY.test(a.city) ? a.city : '',
    players: clamp(Math.round(num(a.humans) ?? 0), 0, maxPlayersFor(a.city)),
    max: maxPlayersFor(a.city),
    phase: PHASES.includes(a.phase) ? a.phase : 'waiting',
    public: !!a.public,
    bots: !!a.bots,
    ends_in: left === null ? null : clamp(Math.round(left), 0, HUB_LIMITS.maxLeftS),
  };
}

/** Where this page is, for the server's counts. */
export function whereOf(self: HubSelf): 'browser' | 'room' | 'solo' {
  if (self.state === 'hub') return 'browser';
  return normalizeCode(self.room ?? self.announce?.code) ? 'room' : 'solo';
}

export interface Snapshot {
  online: number;
  rooms: number;
  publicRooms: number;
  list: HubRoom[];
}

/** Untrusted lobby_snapshot() result → clean rooms (or null when it is not a snapshot at all). */
export function parseSnapshot(raw: unknown, now: number): Snapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  try {
    if (JSON.stringify(raw).length > HUB_LIMITS.maxSnapshotJson) return null;
  } catch {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const count = (v: unknown) => clamp(Math.round(num(v) ?? 0), 0, HUB_LIMITS.maxOnline);
  const list: HubRoom[] = [];
  const seen = new Set<string>();
  for (const it of Array.isArray(r.list) ? r.list.slice(0, HUB_LIMITS.listRooms) : []) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
    const x = it as Record<string, unknown>;
    const code = typeof x.code === 'string' && CODE.test(x.code) ? x.code : null;
    const phase = PHASES.includes(x.phase as RoomPhase) ? (x.phase as RoomPhase) : null;
    if (!code || !phase || seen.has(code)) continue;
    seen.add(code);
    const max = maxPlayersFor(typeof x.city === 'string' ? x.city : '');
    const humans = clamp(Math.round(num(x.players) ?? 0), 0, max);
    const age = clamp(num(x.age) ?? 0, 0, 60);
    const updatedAt = now - age * 1000;
    const leftRaw = phase === 'playing' || phase === 'results' ? num(x.ends_in) : null;
    const left = leftRaw === null ? null : clamp(Math.round(leftRaw), 0, HUB_LIMITS.maxLeftS);
    const room: RoomAnnounce = { code, host: cleanName(x.name, ''), city: typeof x.city === 'string' && CITY.test(x.city) ? x.city : '', humans, bots: x.bots === true, phase, public: true, since: 0, left };
    list.push({ ...room, key: code, max, updatedAt, joinable: isJoinable(room), full: humans >= max, mine: false, endsAt: left === null ? 0 : updatedAt + left * 1000 });
  }
  const publicRooms = Math.max(count(r.public), list.length);
  return { online: count(r.online), rooms: Math.max(count(r.rooms), publicRooms), publicRooms, list };
}

// ── Live directory ──────────────────────────────────────────────────────────
/** `supabase().rpc` in the game; a fake backend in tools/net-lobby-test.mjs. */
export type RpcFn = (fn: 'lobby_beat' | 'lobby_snapshot', args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;

let instance: HubPresence | null = null;

export class HubPresence implements HubLike {
  /** Stable per tab (a reload keeps it), distinct from the room peer id. */
  readonly cid = tabId('ge-lobby-id', 'h-');
  private source: () => HubSelf = () => ({ room: null, state: 'hub', announce: null });
  private readonly listeners: (() => void)[] = [];
  private snap: Snapshot | null = null;
  private snapAt = 0;
  private lastBeat = 0;
  private beatSig = '';
  private beatBusy = 0;
  private lastPoll = 0;
  private pollBusy = 0;
  private failures = 0;
  private lastOk = 0;
  private readonly startedAt = Date.now();
  private status: HubStatus = 'connecting';
  private viewCache: HubView | null = null;
  private viewSig = '';
  private readonly counters = { beats: 0, beatErrors: 0, polls: 0, pollErrors: 0 };

  /** The page's directory (null without a backend). One per page. */
  static start(): HubPresence | null {
    if (!backendConfigured()) return null;
    const sb = supabase();
    if (!sb) return null;
    instance ??= new HubPresence((fn, args) => sb.rpc(fn, args) as unknown as Promise<{ data: unknown; error: unknown }>);
    return instance;
  }

  /** Public for the test harness; the game uses start(). */
  constructor(private readonly rpc: RpcFn) {
    setInterval(() => this.pump(), HUB_TIMING.pumpMs);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.pump();
    });
    (window as unknown as Record<string, unknown>).__HUB__ = () => this.diagnostics();
    queueMicrotask(() => this.pump());
  }

  // ── HubLike ───────────────────────────────────────────────────────────────
  setSource(fn: () => HubSelf): void {
    this.source = fn;
    this.changed();
    queueMicrotask(() => this.pump());
  }
  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }
  view(): HubView {
    return (this.viewCache ??= this.computeView(Date.now()));
  }
  whenReady(maxMs: number): Promise<void> {
    if (this.snap) return Promise.resolve();
    return new Promise((resolve) => {
      const t0 = Date.now();
      const poll = () => (this.snap || Date.now() - t0 >= maxMs ? resolve() : setTimeout(poll, 100));
      poll();
    });
  }

  // ── Pump (once a second, and right after a state change) ──────────────────
  private pump(): void {
    const now = Date.now();
    if (this.beatBusy && now - this.beatBusy > HUB_TIMING.rpcTimeoutMs) this.beatBusy = 0;
    if (this.pollBusy && now - this.pollBusy > HUB_TIMING.rpcTimeoutMs) this.pollBusy = 0;
    if (document.visibilityState !== 'visible') return; // hidden = not here; the row expires
    const self = this.safeSource();
    const sig = this.sigOf(self);
    const since = now - this.lastBeat;
    const due = !this.lastBeat || since >= HUB_TIMING.beatMs || (sig !== this.beatSig && since >= HUB_TIMING.changeMinGapMs);
    if (due && !this.beatBusy) this.beat(self, sig, now);
    const every = this.pollEvery(self);
    const wait = every && this.failures ? Math.min(HUB_TIMING.maxBackoffMs, every * 2 ** Math.min(4, this.failures)) : every;
    // The first poll waits for our first beat, so the count includes this page.
    if (every && !this.pollBusy && this.lastBeat && !this.beatBusy && now - this.lastPoll >= wait) void this.poll(now);
    if (this.status !== 'error' && now - Math.max(this.lastOk, this.startedAt) > HUB_TIMING.errorAfterMs && this.failures > 0) {
      this.status = 'error';
      this.changed();
    }
  }

  /** Snapshot cadence for what is on screen (0 = no counter on screen: do not poll). */
  private pollEvery(self: HubSelf): number {
    if (self.state === 'hub') return HUB_TIMING.browserPollMs;
    if (self.state === 'lobby') return HUB_TIMING.lobbyPollMs;
    return 0;
  }

  private beat(self: HubSelf, sig: string, now: number): void {
    this.lastBeat = now;
    this.beatSig = sig;
    this.beatBusy = now;
    this.counters.beats++;
    const done = (ok: boolean) => {
      this.beatBusy = 0;
      if (!ok) this.counters.beatErrors++;
    };
    this.rpc('lobby_beat', { p_client_id: this.cid, p_where: whereOf(self), p_room: roomArg(self) }).then(
      (r) => done(!r.error),
      () => done(false),
    );
  }

  private async poll(now: number): Promise<void> {
    this.lastPoll = now;
    this.pollBusy = now;
    this.counters.polls++;
    let snap: Snapshot | null = null;
    try {
      const r = await this.rpc('lobby_snapshot', {});
      snap = r.error ? null : parseSnapshot(r.data, Date.now());
    } catch {
      snap = null;
    }
    this.pollBusy = 0;
    if (snap) {
      this.snap = snap;
      this.snapAt = Date.now();
      this.lastOk = this.snapAt;
      this.failures = 0;
      this.status = 'connected';
    } else {
      this.counters.pollErrors++;
      this.failures++;
    }
    this.changed();
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  private safeSource(): HubSelf {
    try {
      return this.source();
    } catch {
      return { room: null, state: 'hub', announce: null };
    }
  }

  /** What a beat says, minus the round clock (it ticks every second; the server extrapolates). */
  private sigOf(s: HubSelf): string {
    const room = roomArg(s);
    if (room) delete room.ends_in;
    return JSON.stringify([whereOf(s), room]);
  }

  private computeView(now: number): HubView {
    const self = this.safeSource();
    const snap = this.snap;
    const rooms: HubRoom[] = snap ? snap.list.slice() : [];
    // My own public room shows at once, with my current numbers (the server copy lags a beat).
    const a = self.announce;
    const mine = a && a.public ? normalizeCode(a.code) : null;
    if (a && mine) {
      const i = rooms.findIndex((r) => r.code === mine);
      if (i >= 0) rooms.splice(i, 1);
      const left = num(a.left);
      rooms.push({ ...a, code: mine, key: mine, max: maxPlayersFor(a.city), updatedAt: now, joinable: isJoinable(a), full: a.humans >= maxPlayersFor(a.city), mine: true, endsAt: left === null ? 0 : now + left * 1000 });
    }
    const listed = sortRooms(rooms).slice(0, HUB_LIMITS.listRooms);
    const total = snap ? Math.max(snap.rooms, listed.length) : listed.length;
    return {
      available: !!snap && this.status !== 'error',
      ready: !!snap,
      status: this.status,
      online: Math.max(1, snap?.online ?? 1),
      capped: false,
      rooms: listed,
      privateRooms: snap ? Math.max(0, total - Math.max(snap.publicRooms, listed.length)) : 0,
    };
  }

  private changed(): void {
    this.viewCache = null;
    const v = this.view();
    const sig = JSON.stringify([v.available, v.ready, v.status, v.online, v.privateRooms, v.rooms.map((r) => [r.key, r.phase, r.humans, r.host, r.city, r.bots, Math.round(r.endsAt / 5000)])]);
    if (sig === this.viewSig) return;
    this.viewSig = sig;
    for (const fn of this.listeners) fn();
  }

  diagnostics() {
    const now = Date.now();
    return {
      self: this.cid,
      status: this.status,
      where: whereOf(this.safeSource()),
      lastBeatAgo: this.lastBeat ? now - this.lastBeat : -1,
      lastSnapshotAgo: this.snapAt ? now - this.snapAt : -1,
      failures: this.failures,
      view: this.view(),
      counters: { ...this.counters },
    };
  }
}
