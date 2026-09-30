import { backendConfigured } from '../backend/supabase';
import { cleanName } from '../arena/nameFilter';
import { RealtimeLink, tabId, type LinkStatus } from './RealtimeLink';

/**
 * The site directory ("room browser"): ONE Realtime broadcast channel (`ge-lobby`) for every
 * arena page — on the room browser, in a room lobby, in a match, vs AI. It answers two questions:
 *   · how many people are here right now (distinct tab ids heard within their timeout, + me),
 *   · which public rooms can I join (announced by each room's host).
 *
 * Wire (all on the one channel, every field re-validated on receipt — never trust a peer):
 *   hb  {from, s: state, i: my beat interval (s), r?: public room code, hi?: 1, rm?: room}
 *       rm = {pub, h: humans, p: phase, c?: code, n?: host name, ci?: city, b?: bots, t0?: opened,
 *             e?: seconds until the round / results screen ends}
 *   bye {from}                                   (page hidden / closed)
 *   dg  {from, cl: [[cid, ageMs, i, s]…], rm: [[hostCid, ageMs, i, room]…]}
 *       a digest of the directory, sent by ONE page (lowest id) when a newcomer says hello,
 *       so a fresh hub lists rooms in ~0.1 s instead of after a full beat interval, without
 *       every page answering (that would be N² deliveries per arrival).
 * Private rooms never travel with their code / name / city (a code is the only key to a
 * private room): they are counted, never listed.
 *
 * Cost: every beat reaches every page, so deliveries grow with N². The beat interval is 3 s up
 * to ~13 pages, then stretches so the whole site stays near HUB_TIMING.deliveriesPerSec (each
 * beat carries its interval, and receivers time each entry out by the sender's own cadence).
 * Abuse: at most HUB_LIMITS.maxClients ids are tracked, one beat per id per 300 ms is processed,
 * new ids / digests / junk share a token bucket (HUB_LIMITS.ratePerSec), numbers are clamped
 * (a claimed interval to 3–120 s), names go through cleanName. Counts are still client-reported:
 * without a server a hostile page can inflate "online" (never past maxClients) until it expires.
 */
export const HUB_TIMING = {
  topic: 'ge-lobby',
  /** Beat cadence while the site is small. */
  baseIntervalMs: 3000,
  /** Longest beat interval (a very busy site). */
  maxIntervalMs: 120_000,
  /** Site-wide delivery budget for beats: interval = N² / budget (never below the base). */
  deliveriesPerSec: 60,
  /** An entry expires after max(this, 2.5 × its interval + 2 s): 10 s at the base cadence. */
  timeoutMinMs: 10_000,
  /** While our own link is down, known entries are kept this long (we are deaf, they are not gone). */
  deafGraceMs: 30_000,
  /** Without a digest (nobody else here) the list counts as complete this long after subscribing. */
  readyAfterMs: 3500,
  /** A host's room changed (phase, players): beat now, but not more often than this. */
  changeMinGapMs: 2000,
  /** After a goodbye, late beats from that page are ignored this long (a hello still revives it). */
  goneMs: 5000,
  /** Digest answers at most this often. */
  digestMinMs: 1000,
  /** online_snapshot telemetry cadence (aligned minutes, lowest id sends). */
  snapshotEveryMs: 60_000,
  stuckMs: 15_000,
  errorAfterMs: 8_000,
  pumpMs: 500,
} as const;

export const HUB_LIMITS = {
  maxClients: 500,
  maxRooms: 120,
  listRooms: 50,
  maxRoomJson: 400,
  maxDigestJson: 40_000,
  digestClients: 500,
  digestRooms: 80,
  maxPlayers: 4,
  /** One beat per sender per this long is processed (a hello is a beat too). */
  perSenderMs: 300,
  /** Token bucket over everything received on the channel (messages / s, burst). */
  ratePerSec: 250,
  burst: 600,
  /** Longest "ends in" a host may claim (s): a round is 300 s, results 12 s. */
  maxLeftS: 900,
} as const;

export type HubState = 'hub' | 'lobby' | 'play' | 'watch';
export type RoomPhase = 'waiting' | 'warmup' | 'playing' | 'results';
const STATES: readonly HubState[] = ['hub', 'lobby', 'play', 'watch'];
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
  /** When the room opened (ms, host clock) — "oldest first" among equals. */
  since: number;
  /** Seconds until the current round (or results screen) ends; null = unknown / not in a round. */
  left?: number | null;
}

/** What this page says about itself (polled each pump). */
export interface HubSelf {
  /** Public room code this page is in (private rooms are never named on the hub). */
  room: string | null;
  state: HubState;
  /** Set only on the host of an online room. */
  announce: RoomAnnounce | null;
}

export interface HubRoom extends RoomAnnounce {
  key: string;
  max: number;
  /** Local time the latest announcement arrived. */
  updatedAt: number;
  joinable: boolean;
  full: boolean;
  /** Announced by this page. */
  mine: boolean;
  /** Local time the current round / results screen ends (0 = unknown). */
  endsAt: number;
}

export interface HubView {
  /** The number is real and may be shown (hub reachable, first full picture in). */
  available: boolean;
  ready: boolean;
  status: LinkStatus | 'off';
  /** Distinct pages heard within their timeout, me included. */
  online: number;
  /** The count hit HUB_LIMITS.maxClients (show "500+"). */
  capped: boolean;
  /** Public rooms, best first, at most 50. */
  rooms: HubRoom[];
  privateRooms: number;
  /** Pages in a round (warm-ups and solo rounds included). */
  playing: number;
}

/** The directory as the UI sees it (the live one, or the dev-only demo). */
export interface HubLike {
  view(): HubView;
  onChange(fn: () => void): void;
  whenReady(maxMs: number): Promise<void>;
  setSource(fn: () => HubSelf): void;
  onSnapshot: ((s: { online: number; rooms: number; playing: number; public: number }) => void) | null;
}

// ── Validation ──────────────────────────────────────────────────────────────
const CID = /^h-[a-z0-9]{6,16}$/;
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
const intervalOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? clamp(v * 1000, HUB_TIMING.baseIntervalMs, HUB_TIMING.maxIntervalMs) : HUB_TIMING.baseIntervalMs);
const timeoutOf = (iMs: number): number => Math.max(HUB_TIMING.timeoutMinMs, iMs * 2.5 + 2000);
const stateOf = (v: unknown): HubState | null => (STATES.includes(v as HubState) ? (v as HubState) : null);

interface RoomWire {
  pub: 0 | 1;
  h: number;
  p: RoomPhase;
  c?: string;
  n?: string;
  ci?: string;
  b?: 0 | 1;
  t0?: number;
  e?: number;
}

function roomToWire(a: RoomAnnounce): RoomWire {
  const h = clamp(Math.round(a.humans), 0, HUB_LIMITS.maxPlayers);
  if (!a.public) return { pub: 0, h, p: a.phase };
  const w: RoomWire = { pub: 1, h, p: a.phase, c: a.code, n: a.host.slice(0, 16), ci: a.city.slice(0, 24), b: a.bots ? 1 : 0, t0: Math.round(a.since) };
  if (typeof a.left === 'number' && Number.isFinite(a.left)) w.e = clamp(Math.round(a.left), 0, HUB_LIMITS.maxLeftS);
  return w;
}

/** Untrusted room from another page → a clean announcement (or null). */
export function parseRoom(raw: unknown): RoomAnnounce | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  try {
    if (JSON.stringify(raw).length > HUB_LIMITS.maxRoomJson) return null;
  } catch {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const phase = PHASES.includes(r.p as RoomPhase) ? (r.p as RoomPhase) : null;
  const humans = typeof r.h === 'number' && Number.isFinite(r.h) ? clamp(Math.round(r.h), 0, HUB_LIMITS.maxPlayers) : null;
  if (!phase || humans === null) return null;
  if (r.pub !== 1) return { code: '', host: '', city: '', humans, bots: false, phase, public: false, since: 0 };
  const code = typeof r.c === 'string' && CODE.test(r.c) ? r.c : null;
  if (!code) return null;
  const now = Date.now();
  const since = typeof r.t0 === 'number' && Number.isFinite(r.t0) && Math.abs(r.t0 - now) < 86_400_000 ? r.t0 : now;
  return {
    code,
    host: cleanName(r.n, ''),
    city: typeof r.ci === 'string' && CITY.test(r.ci) ? r.ci : '',
    humans,
    bots: r.b === 1,
    phase,
    public: true,
    since,
    left: typeof r.e === 'number' && Number.isFinite(r.e) && (phase === 'playing' || phase === 'results') ? clamp(Math.round(r.e), 0, HUB_LIMITS.maxLeftS) : null,
  };
}

/** Joinable: public, waiting or warming up vs AI, a free seat. */
export function isJoinable(r: RoomAnnounce): boolean {
  return r.public && (r.phase === 'waiting' || r.phase === 'warmup') && r.humans < HUB_LIMITS.maxPlayers;
}

/**
 * List order: waiting rooms first (most players first — the fullest open lobby starts soonest),
 * then warm-ups vs AI, results (next round soon), rounds in progress, full rooms; oldest first.
 */
export function sortRooms<T extends RoomAnnounce>(rooms: T[]): T[] {
  const RANK: Record<RoomPhase, number> = { waiting: 0, warmup: 1, results: 2, playing: 3 };
  const rank = (r: T) => (r.humans >= HUB_LIMITS.maxPlayers ? 4 : RANK[r.phase]);
  return rooms.sort((a, b) => rank(a) - rank(b) || b.humans - a.humans || a.since - b.since || (a.code < b.code ? -1 : 1));
}

// ── Live directory ──────────────────────────────────────────────────────────
interface ClientEntry {
  seen: number;
  iMs: number;
  state: HubState;
  /** Local time of the last beat processed from this page (rate limit; 0 = digest only). */
  beatAt: number;
}
interface RoomEntry {
  room: RoomAnnounce;
  host: string;
  seen: number;
  iMs: number;
  /** Local time the round / results screen ends (0 = unknown). */
  endsAt: number;
}
const endsAtOf = (r: RoomAnnounce, seen: number): number => (typeof r.left === 'number' ? seen + r.left * 1000 : 0);

let instance: HubPresence | null = null;

export class HubPresence implements HubLike {
  /** Stable per tab (a reload keeps it), distinct from the room peer id. */
  readonly cid = tabId('ge-lobby-id', 'h-');
  private readonly link: RealtimeLink;
  private readonly clients = new Map<string, ClientEntry>();
  private readonly rooms = new Map<string, RoomEntry>();
  /** Pages that said goodbye → until when a late beat of theirs (still in flight) is ignored. */
  private readonly gone = new Map<string, number>();
  private source: () => HubSelf = () => ({ room: null, state: 'hub', announce: null });
  private readonly listeners: (() => void)[] = [];
  private ready = false;
  private readyAt = 0;
  private lastBeat = 0;
  private nextBeatAt = 0;
  private lastSig = '';
  private digestDue = false;
  private lastDigest = 0;
  private lastTick = 0;
  private snapBucket = -1;
  private viewCache: HubView | null = null;
  private viewSig = '';
  private readonly counters = { hbSent: 0, hbRecv: 0, dgSent: 0, dgRecv: 0, byeRecv: 0, rejected: 0, limited: 0 };
  /** Token bucket over everything received (see HUB_LIMITS.ratePerSec). */
  private tokens: number = HUB_LIMITS.burst;
  private tokensAt = 0;
  onSnapshot: HubLike['onSnapshot'] = null;

  /** The page's directory (null without a backend). One per page. */
  static start(): HubPresence | null {
    if (!backendConfigured()) return null;
    instance ??= new HubPresence();
    return instance;
  }

  private constructor() {
    this.link = new RealtimeLink(HUB_TIMING.topic, this.cid, ['hb', 'bye', 'dg'], { receive: (e, p, f) => this.onReceive(e, p, f), up: (w) => this.onUp(w), changed: () => this.changed() }, HUB_TIMING);
    setInterval(() => this.pump(), HUB_TIMING.pumpMs);
    addEventListener('pagehide', () => this.goodbye());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.goodbye();
      else if (this.link.live) this.beat(true);
    });
    (window as unknown as Record<string, unknown>).__HUB__ = () => this.diagnostics();
  }

  // ── HubLike ───────────────────────────────────────────────────────────────
  setSource(fn: () => HubSelf): void {
    this.source = fn;
    this.lastSig = ''; // announce the new state on the next pump
  }
  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }
  view(): HubView {
    return (this.viewCache ??= this.computeView(Date.now()));
  }
  whenReady(maxMs: number): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve) => {
      const t0 = Date.now();
      const poll = () => (this.ready || Date.now() - t0 >= maxMs ? resolve() : setTimeout(poll, 100));
      poll();
    });
  }
  /** Leave the directory now (page hidden or closing). */
  goodbye(): void {
    if (this.link.live) this.link.send('bye', { from: this.cid });
  }

  // ── Receive ───────────────────────────────────────────────────────────────
  private onReceive(event: string, payload: unknown, from: string | null): void {
    if (!from || from === this.cid) return; // our own echo (counted by the link)
    // Pages we already know are limited per sender (onBeat); everything else — new ids, digests,
    // junk — draws from the shared bucket, so a flood of fake ids can never starve real pages.
    const known = event !== 'dg' && this.clients.has(from);
    if (!known && !this.admit()) return;
    if (!CID.test(from)) {
      this.counters.rejected++;
      return;
    }
    if (event === 'hb') this.onBeat(from, payload as Record<string, unknown>);
    else if (event === 'bye') this.onBye(from);
    else if (event === 'dg') this.onDigest(payload as Record<string, unknown>);
    this.changed();
  }

  /** Token bucket: a flood of messages (a hostile page, a bug) costs us a bounded amount of work. */
  private admit(): boolean {
    const now = Date.now();
    this.tokens = Math.min(HUB_LIMITS.burst, this.tokens + ((now - this.tokensAt) / 1000) * HUB_LIMITS.ratePerSec);
    this.tokensAt = now;
    if (this.tokens < 1) {
      this.counters.limited++;
      return false;
    }
    this.tokens--;
    return true;
  }

  private onBeat(from: string, p: Record<string, unknown>): void {
    if (!p || typeof p !== 'object') return;
    const state = stateOf(p.s);
    if (!state) {
      this.counters.rejected++;
      return;
    }
    const now = Date.now();
    const prev = this.clients.get(from);
    if (prev && now - prev.beatAt < HUB_LIMITS.perSenderMs) {
      this.counters.limited++;
      return;
    }
    this.counters.hbRecv++;
    // A beat sent just before the goodbye may land after it; only a hello (page back) revives.
    if (!p.hi && (this.gone.get(from) ?? 0) > now) return;
    this.gone.delete(from);
    const iMs = intervalOf(p.i);
    if (!prev && this.clients.size >= HUB_LIMITS.maxClients) return;
    this.clients.set(from, { seen: now, iMs, state, beatAt: now });
    const room = p.rm === undefined ? null : parseRoom(p.rm);
    const key = room ? (room.public ? room.code : `p:${from}`) : null;
    // A host announces one room; a page that stopped announcing (left, no longer host) has none.
    for (const [k, r] of this.rooms) if (r.host === from && k !== key) this.rooms.delete(k);
    if (room && key) {
      const cur = this.rooms.get(key);
      if (cur || this.rooms.size < HUB_LIMITS.maxRooms) this.rooms.set(key, { room, host: from, seen: now, iMs, endsAt: endsAtOf(room, now) });
    }
    // A newcomer said hello: the lowest id among the others answers with a digest.
    if (p.hi && this.lowestLive(now, from) === this.cid) this.digestDue = true;
  }

  private onBye(from: string): void {
    this.counters.byeRecv++;
    this.gone.set(from, Date.now() + HUB_TIMING.goneMs);
    if (this.gone.size > 500) for (const [k, until] of this.gone) if (until < Date.now()) this.gone.delete(k);
    this.clients.delete(from);
    for (const [k, r] of this.rooms) if (r.host === from) this.rooms.delete(k);
  }

  private onDigest(p: Record<string, unknown>): void {
    if (!p || typeof p !== 'object') return;
    try {
      if (JSON.stringify(p).length > HUB_LIMITS.maxDigestJson) return;
    } catch {
      return;
    }
    this.counters.dgRecv++;
    const now = Date.now();
    const ageOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 10 * 60_000) : null);
    if (Array.isArray(p.cl)) {
      for (const row of p.cl.slice(0, HUB_LIMITS.digestClients)) {
        if (!Array.isArray(row)) continue;
        const [cid, age, i, s] = row as unknown[];
        const a = ageOf(age);
        const state = stateOf(s);
        if (typeof cid !== 'string' || !CID.test(cid) || cid === this.cid || a === null || !state || (this.gone.get(cid) ?? 0) > now) continue;
        const seen = now - a;
        const cur = this.clients.get(cid);
        if (cur && cur.seen >= seen) continue;
        if (!cur && this.clients.size >= HUB_LIMITS.maxClients) continue;
        this.clients.set(cid, { seen, iMs: intervalOf(i), state, beatAt: cur?.beatAt ?? 0 });
      }
    }
    if (Array.isArray(p.rm)) {
      for (const row of p.rm.slice(0, HUB_LIMITS.digestRooms)) {
        if (!Array.isArray(row)) continue;
        const [host, age, i, raw] = row as unknown[];
        const a = ageOf(age);
        const room = parseRoom(raw);
        if (typeof host !== 'string' || !CID.test(host) || host === this.cid || a === null || !room || (this.gone.get(host) ?? 0) > now) continue;
        const key = room.public ? room.code : `p:${host}`;
        const seen = now - a;
        const cur = this.rooms.get(key);
        if (cur && cur.seen >= seen) continue;
        if (!cur && this.rooms.size >= HUB_LIMITS.maxRooms) continue;
        // A digest relays the room as last heard: its "ends in" counts from then.
        this.rooms.set(key, { room, host, seen, iMs: intervalOf(i), endsAt: endsAtOf(room, seen) });
      }
    }
    this.ready = true;
  }

  private onUp(wasDown: number): void {
    const now = Date.now();
    // We were deaf, the others were not silent: everyone gets a fresh window to be heard.
    if (wasDown) {
      for (const c of this.clients.values()) c.seen = Math.max(c.seen, now - 1000);
      for (const r of this.rooms.values()) r.seen = Math.max(r.seen, now - 1000);
    }
    if (!this.ready) this.readyAt = now + HUB_TIMING.readyAfterMs;
    if (document.visibilityState === 'visible') this.beat(true); // hello: a digest comes back
  }

  // ── Send ──────────────────────────────────────────────────────────────────
  /** Beat interval for the current site size (see HUB_TIMING.deliveriesPerSec). */
  intervalMs(): number {
    const n = Math.max(1, this.liveCount(Date.now()) + 1);
    return clamp((n * n * 1000) / HUB_TIMING.deliveriesPerSec, HUB_TIMING.baseIntervalMs, HUB_TIMING.maxIntervalMs);
  }

  private beat(hello: boolean): void {
    if (!this.link.live) return;
    const self = this.safeSource();
    const iMs = this.intervalMs();
    const now = Date.now();
    this.lastBeat = now;
    this.nextBeatAt = now + iMs * (0.9 + Math.random() * 0.2); // jitter: pages never beat in lockstep
    this.lastSig = this.sigOf(self);
    const payload: Record<string, unknown> = { from: this.cid, s: self.state, i: Math.round(iMs / 1000) };
    const code = normalizeCode(self.room);
    if (code) payload.r = code; // the owner passes public rooms only
    if (self.announce && normalizeCode(self.announce.code)) payload.rm = roomToWire(self.announce);
    if (hello) payload.hi = 1;
    this.counters.hbSent++;
    this.link.send('hb', payload);
  }

  private sendDigest(now: number): void {
    this.digestDue = false;
    this.lastDigest = now;
    const self = this.safeSource();
    const iSelf = Math.round(this.intervalMs() / 1000);
    const cl: unknown[] = [[this.cid, 0, iSelf, self.state]];
    for (const [cid, c] of this.clients) {
      if (cl.length >= HUB_LIMITS.digestClients) break;
      if (this.isLive(c.seen, c.iMs, now)) cl.push([cid, now - c.seen, Math.round(c.iMs / 1000), c.state]);
    }
    const rm: unknown[] = [];
    if (self.announce && normalizeCode(self.announce.code)) rm.push([this.cid, 0, iSelf, roomToWire(self.announce)]);
    for (const r of this.rooms.values()) {
      if (rm.length >= HUB_LIMITS.digestRooms) break;
      // "ends in" as of when it was heard (seen may have been refreshed after a rejoin).
      if (this.isLive(r.seen, r.iMs, now)) rm.push([r.host, now - r.seen, Math.round(r.iMs / 1000), roomToWire({ ...r.room, left: r.endsAt ? (r.endsAt - r.seen) / 1000 : null })]);
    }
    this.counters.dgSent++;
    this.link.send('dg', { from: this.cid, cl, rm });
  }

  // ── Tick ──────────────────────────────────────────────────────────────────
  private pump(): void {
    const now = Date.now();
    const visible = document.visibilityState === 'visible';
    if (this.link.live && visible) {
      const self = this.safeSource();
      const sig = this.sigOf(self);
      const iMs = this.intervalMs();
      // The site shrank (a crowd left): do not sit out a long interval chosen for the crowd.
      this.nextBeatAt = Math.min(this.nextBeatAt, this.lastBeat + iMs * 1.1);
      const gap = Math.max(HUB_TIMING.changeMinGapMs, iMs / 4);
      if (now >= this.nextBeatAt || (sig !== this.lastSig && now - this.lastBeat >= gap)) this.beat(false);
      if (this.digestDue && now - this.lastDigest >= HUB_TIMING.digestMinMs) this.sendDigest(now);
    }
    if (!this.ready && this.readyAt && now >= this.readyAt) this.ready = true;
    if (now - this.lastTick >= 1000) {
      this.lastTick = now;
      this.link.tick(now);
      this.expire(now);
      this.snapshotDuty(now);
    }
    this.changed();
  }

  private expire(now: number): void {
    for (const [cid, c] of this.clients) if (!this.isLive(c.seen, c.iMs, now)) this.clients.delete(cid);
    for (const [k, r] of this.rooms) if (!this.isLive(r.seen, r.iMs, now) || !this.clients.has(r.host)) this.rooms.delete(k);
  }

  /** Every minute (aligned), the lowest id on the hub records the site's concurrency. */
  private snapshotDuty(now: number): void {
    const bucket = Math.floor(now / HUB_TIMING.snapshotEveryMs);
    // Near the start of each minute only: a leader change mid-minute never sends a second row.
    if (bucket === this.snapBucket || now % HUB_TIMING.snapshotEveryMs > 5000) return;
    const v = this.view();
    if (!v.available || this.lowestLive(now, null) !== this.cid) return;
    this.snapBucket = bucket;
    this.onSnapshot?.({ online: v.online, rooms: v.rooms.length + v.privateRooms, playing: v.playing, public: v.rooms.length });
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  private isLive(seen: number, iMs: number, now: number): boolean {
    if (now - seen < timeoutOf(iMs)) return true;
    const down = this.link.downSince;
    return !!down && now - down < HUB_TIMING.deafGraceMs;
  }

  private liveCount(now: number): number {
    let n = 0;
    for (const [cid, c] of this.clients) if (cid !== this.cid && this.isLive(c.seen, c.iMs, now)) n++;
    return n;
  }

  /** Lowest id among live pages (me included), leaving out `except`. */
  private lowestLive(now: number, except: string | null): string {
    let low = this.cid;
    for (const [cid, c] of this.clients) if (cid !== except && cid < low && this.isLive(c.seen, c.iMs, now)) low = cid;
    return low;
  }

  private safeSource(): HubSelf {
    try {
      return this.source();
    } catch {
      return { room: null, state: 'hub', announce: null };
    }
  }

  /** What a beat says, minus the round clock (it ticks every second; receivers extrapolate it). */
  private sigOf(s: HubSelf): string {
    const w = s.announce && roomToWire(s.announce);
    if (w) delete w.e;
    return JSON.stringify([s.state, s.room, w]);
  }

  private computeView(now: number): HubView {
    const self = this.safeSource();
    const rooms: HubRoom[] = [];
    let privateRooms = 0;
    const add = (r: RoomAnnounce, key: string, updatedAt: number, mine: boolean, endsAt: number) => {
      if (!r.public) return void privateRooms++;
      const full = r.humans >= HUB_LIMITS.maxPlayers;
      rooms.push({ ...r, key, max: HUB_LIMITS.maxPlayers, updatedAt, joinable: isJoinable(r), full, mine, endsAt });
    };
    const mineCode = self.announce && normalizeCode(self.announce.code);
    if (self.announce && mineCode) add(self.announce, self.announce.public ? mineCode : `p:${this.cid}`, now, true, endsAtOf(self.announce, now));
    for (const [key, r] of this.rooms) {
      if (!this.isLive(r.seen, r.iMs, now) || (mineCode && key === mineCode)) continue;
      add(r.room, key, r.seen, false, r.endsAt);
    }
    let playing = self.state === 'play' ? 1 : 0;
    for (const [cid, c] of this.clients) if (cid !== this.cid && c.state === 'play' && this.isLive(c.seen, c.iMs, now)) playing++;
    const status = this.link.status;
    return {
      available: this.ready && status !== 'error',
      ready: this.ready,
      status,
      online: Math.min(HUB_LIMITS.maxClients, this.liveCount(now) + 1),
      capped: this.clients.size >= HUB_LIMITS.maxClients,
      rooms: sortRooms(rooms).slice(0, HUB_LIMITS.listRooms),
      privateRooms,
      playing,
    };
  }

  private changed(): void {
    this.viewCache = null;
    const v = this.view();
    const sig = JSON.stringify([v.available, v.ready, v.status, v.online, v.playing, v.privateRooms, v.rooms.map((r) => [r.key, r.phase, r.humans, r.host, r.city, r.bots])]);
    if (sig === this.viewSig) return;
    this.viewSig = sig;
    for (const fn of this.listeners) fn();
  }

  private diagnostics() {
    const now = Date.now();
    const link = this.link;
    return {
      self: this.cid,
      status: link.status,
      detail: link.statusDetail,
      live: link.live,
      ready: this.ready,
      intervalMs: this.intervalMs(),
      view: this.view(),
      clients: Object.fromEntries([...this.clients].map(([id, c]) => [id, { ms: now - c.seen, i: c.iMs, s: c.state }])),
      rooms: Object.fromEntries([...this.rooms].map(([k, r]) => [k, { ms: now - r.seen, host: r.host, phase: r.room.phase, humans: r.room.humans }])),
      counters: { ...this.counters },
      traffic: { ...link.traffic },
      joins: link.joins,
      rejoins: link.rejoins,
      lastRejoinReason: link.lastRejoinReason,
      history: [...link.history],
    };
  }
}
