import { authError, authStatus, currentUser, socketBeats, supabase } from '../backend/supabase';
import type { Json, Net, NetMessage, NetPeer } from './Net';
import { RealtimeLink, tabId, type LinkStatus } from './RealtimeLink';

/**
 * Public online rooms over Supabase Realtime (for the stand-alone web / portal builds, where
 * the claude.ai room is not available). One channel per room code (`?room=ABCD`); share the
 * page URL to invite friends.
 *
 * Same semantics as the other transports: presence = "my current state", emit = a moment to
 * everyone including me.
 *
 * Membership runs on BROADCAST only, never on Realtime Presence. In the field presence lost
 * players while broadcasts kept flowing (a rejoin wiped the peer map, a re-track never landed),
 * so the lobby showed "1 online", both pages elected themselves host, and the round split.
 * Now every visible page sends a heartbeat each second that carries its whole lobby state
 * (`s`, a few hundred bytes) and its latest machine state (`f`); per-frame machine state also
 * travels as a throttled 'st' broadcast. A peer is in the room from the first heartbeat heard
 * until it says goodbye ('bye' on hide / pagehide) or stays silent for PEER_TIMEOUT_MS.
 *
 * Channel churn never drops anyone: the server may close the channel (realtime-js then does
 * not resubscribe, so we rebuild it with backoff) and the socket may drop (the library rejoins
 * by itself). While our own link is down we are deaf, not the others silent, so nobody expires;
 * after the link is back everyone gets a fresh timeout window and a hello asks them to answer
 * at once.
 */
export const NET_TIMING = {
  /** Heartbeat cadence (wall clock; a late timer tick beats at once). */
  heartbeatMs: 1000,
  /** A peer silent this long (while our link is up) has left. */
  peerTimeoutMs: 12_000,
  /** While our own link is down, known peers are kept this long. */
  deafGraceMs: 30_000,
  /** Not subscribed this long after a join attempt: rebuild the channel. */
  stuckMs: 15_000,
  /** Down this long: the status line says the service is unreachable (brief blips stay "connecting"). */
  errorAfterMs: 8_000,
  /** A same-account peer silent this long is replaced as soon as a new id of that account speaks. */
  ghostAfterMs: 2_500,
  /** Answer hellos at most this often. */
  helloMinMs: 300,
  pumpMs: 66,
} as const;

const FAST_KEYS = new Set(['s', 'b', 'ep']);
const MAX_STATE_JSON = 2048;
const MAX_PEERS = 16;

interface Remote {
  slow: Record<string, Json>;
  fast: Record<string, Json>;
  /** Last time we heard anything from it (heartbeat, state or message). */
  seen: number;
  /** Its lobby state arrived (only then is it listed: count and list come from one set). */
  hasState: boolean;
}

export class SupabaseNet implements Net {
  readonly kind = 'online' as const;
  /**
   * Stable per tab and room: a reload (or a phone browser restoring the page) keeps the same id,
   * so the room never lists a "ghost" of the previous load next to the new one.
   */
  private readonly id = tabId('ge-net-id', 'p-');
  /** The room channel (join / rejoin / stuck / relay checks live there, shared with the hub). */
  private readonly link: RealtimeLink;
  private slow: Record<string, Json> = {};
  private fast: Record<string, Json> = {};
  private slowSig = '';
  private readonly others = new Map<string, Remote>();
  private readonly handlers = new Map<string, ((m: NetMessage) => void)[]>();
  private readonly peerFns: ((p: readonly NetPeer[]) => void)[] = [];
  private snapshot: readonly NetPeer[] = [];
  private visibleSig = '';
  /** Heartbeat counters for window.__NET__ (the link counts all broadcast traffic). */
  private readonly beats = { hbSent: 0, hbRecv: 0 };
  private slowDirty = false;
  private fastDirty = false;
  private uid: string | null = null;
  private lastHb = 0;
  private lastHelloAnswer = 0;
  private lastHelloAsk = 0;
  private lastSlowTick = 0;

  private constructor(
    readonly room: string,
    nickname: string,
  ) {
    this.setSlow({ nk: nickname });
    this.link = new RealtimeLink(`arena:${room}`, this.id, ['msg', 'st', 'hb', 'bye'], { receive: (e, p, f) => this.onReceive(e, p, f), up: (w) => this.onUp(w), changed: () => this.refresh() }, NET_TIMING);
    // Remote diagnosis: window.__NET__() in the console (or a browser agent) reports the link state.
    (window as unknown as Record<string, unknown>).__NET__ = () => this.diagnostics();
    setInterval(() => this.pump(), NET_TIMING.pumpMs); // ~15 Hz state, presence changes debounced into the same tick
    const goodbye = () => {
      if (this.live) this.push('bye', { from: this.id });
    };
    addEventListener('pagehide', goodbye);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') goodbye();
      else {
        // Back: re-announce everything at once and ask the others for theirs.
        this.slowDirty = this.fastDirty = true;
        if (this.live) this.sendHeartbeat(true);
      }
    });
    this.refresh();
  }

  /** Join (or create) room `code`; null when no backend is configured. */
  static async connect(code: string, nickname: string): Promise<SupabaseNet | null> {
    if (!supabase()) return null;
    // Never hold the lobby on auth: a blocked or slow backend retries for a long time. Join the
    // room now and attach the account id whenever sign-in lands.
    const pending = currentUser(nickname);
    const user = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), 4000))]);
    const net = new SupabaseNet(code, nickname);
    const attach = (u: { id: string } | null) => {
      if (!u || net.uid) return;
      net.uid = u.id;
      net.setSlow({ ...net.slow, uid: u.id });
      net.refresh();
    };
    attach(user);
    void pending.then(attach);
    return net;
  }

  // ── Net ───────────────────────────────────────────────────────────────────
  selfId(): string {
    return this.id;
  }
  peers(): readonly NetPeer[] {
    return this.snapshot;
  }
  onPeers(fn: (p: readonly NetPeer[]) => void): void {
    this.peerFns.push(fn);
    queueMicrotask(() => fn(this.snapshot));
  }
  setPresence(patch: Record<string, Json | null>): void {
    let slowNext: Record<string, Json> | null = null;
    for (const [k, v] of Object.entries(patch)) {
      if (FAST_KEYS.has(k)) {
        if (v === null) delete this.fast[k];
        else this.fast[k] = v;
        this.fastDirty = true;
      } else {
        slowNext ??= { ...this.slow };
        if (v === null) delete slowNext[k];
        else slowNext[k] = v;
      }
    }
    if (slowNext) this.setSlow(slowNext);
    this.refresh();
  }
  emit(topic: string, data: Json): void {
    if (!this.live) {
      // Not subscribed (connecting, blocked or offline): nobody else can hear it, but this client must —
      // the host drives its own match from the self-echo, so dropping it froze the round in countdown.
      queueMicrotask(() => this.dispatch(topic, this.id, data));
      return;
    }
    this.push('msg', { topic, from: this.id, data });
  }
  on(topic: string, fn: (m: NetMessage) => void): void {
    const list = this.handlers.get(topic) ?? [];
    list.push(fn);
    this.handlers.set(topic, list);
  }
  connected(): boolean {
    return this.live;
  }
  nameOf(peer: NetPeer): string {
    return (typeof peer.presence.nk === 'string' && peer.presence.nk) || 'Player';
  }

  // ── Link ──────────────────────────────────────────────────────────────────
  get status(): LinkStatus {
    return this.link.status;
  }
  get statusDetail(): string {
    return this.link.statusDetail;
  }
  private get live(): boolean {
    return this.link.live;
  }

  private onReceive(event: string, payload: unknown, from: string | null): void {
    if (event === 'msg') this.onMsg(payload, from);
    else if (event === 'st') this.onState(payload, from);
    else if (event === 'hb') this.onHeartbeat(payload, from);
    else if (event === 'bye') this.onBye(from);
  }

  private onUp(wasDown: number): void {
    // We were deaf, the others were not silent: everyone gets a fresh window to be heard.
    const now = Date.now();
    if (wasDown) for (const o of this.others.values()) o.seen = Math.max(o.seen, now);
    this.slowDirty = this.fastDirty = true;
    this.sendHeartbeat(true); // hello: announce me, ask everyone to answer now
  }

  // ── Receive ───────────────────────────────────────────────────────────────
  private onMsg(payload: unknown, from: string | null): void {
    const m = payload as { topic?: unknown; data?: Json };
    if (!from || typeof m.topic !== 'string') return;
    if (from !== this.id) this.heard(from);
    this.dispatch(m.topic, from, m.data);
  }

  private onState(payload: unknown, from: string | null): void {
    const st = (payload as { st?: unknown }).st;
    if (!from || from === this.id || !isPlainState(st)) return;
    const o = this.heard(from);
    if (o) o.fast = { ...o.fast, ...st };
    this.refresh();
  }

  private onHeartbeat(payload: unknown, from: string | null): void {
    if (!from || from === this.id) return;
    this.beats.hbRecv++;
    const p = payload as { s?: unknown; f?: unknown; hi?: unknown };
    const o = this.heard(from, isPlainState(p.s) ? p.s : undefined);
    if (o && isPlainState(p.f)) o.fast = { ...o.fast, ...p.f };
    if (p.hi && this.live && Date.now() - this.lastHelloAnswer > NET_TIMING.helloMinMs) {
      this.lastHelloAnswer = Date.now();
      this.sendHeartbeat(false);
    }
    this.refresh();
  }

  private onBye(from: string | null): void {
    if (!from || from === this.id || !this.others.has(from)) return;
    this.others.delete(from);
    this.refresh();
  }

  /** Any sign of life: create / refresh the peer (and its lobby state when the message carries it). */
  private heard(from: string, slow?: Record<string, Json>): Remote | null {
    let o = this.others.get(from);
    if (!o) {
      if (this.others.size >= MAX_PEERS) return null;
      o = { slow: {}, fast: {}, seen: 0, hasState: false };
      this.others.set(from, o);
    }
    const wasVisible = this.isVisible(o, Date.now());
    o.seen = Date.now();
    if (slow) {
      o.slow = slow;
      o.hasState = true;
      this.dropGhosts(from, slow);
    } else if (!o.hasState && this.live && Date.now() - this.lastHelloAsk > NET_TIMING.helloMinMs) {
      // Someone we have no state for (we just (re)joined, or missed its hello): ask for it.
      this.lastHelloAsk = Date.now();
      this.sendHeartbeat(true);
    }
    if (!wasVisible && this.isVisible(o, Date.now())) this.refresh();
    return o;
  }

  /**
   * Same device, new id (e.g. the page was reopened in a new tab / app webview without a goodbye):
   * an older id with the same account that has already missed heartbeats is that device's ghost.
   * Two live tabs of one browser keep beating, so both stay listed (local multi-tab tests).
   */
  private dropGhosts(from: string, slow: Record<string, Json>): void {
    const uid = typeof slow.uid === 'string' ? slow.uid : null;
    if (!uid) return;
    const now = Date.now();
    let changed = false;
    for (const [id, o] of this.others) {
      if (id === from || o.slow.uid !== uid) continue;
      if (now - o.seen > NET_TIMING.ghostAfterMs) {
        this.others.delete(id);
        changed = true;
      }
    }
    if (changed) this.refresh();
  }

  private dispatch(topic: string, from: string, data: Json): void {
    for (const fn of this.handlers.get(topic) ?? []) fn({ from, isMe: from === this.id, data });
  }

  // ── Send ──────────────────────────────────────────────────────────────────
  private push(event: string, payload: Record<string, Json>): void {
    this.link.send(event, payload);
  }

  private sendHeartbeat(hello: boolean): void {
    if (!this.live) return;
    this.lastHb = Date.now();
    this.beats.hbSent++;
    const payload: Record<string, Json> = { from: this.id, s: this.slow };
    if (Object.keys(this.fast).length) payload.f = this.fast;
    if (hello) payload.hi = 1;
    this.slowDirty = false;
    this.push('hb', payload);
  }

  private setSlow(next: Record<string, Json>): void {
    const sig = JSON.stringify(next);
    if (sig === this.slowSig) return; // unchanged: nothing to announce
    this.slowSig = sig;
    this.slow = next;
    this.slowDirty = true;
  }

  // ── Tick ──────────────────────────────────────────────────────────────────
  private pump(): void {
    const now = Date.now();
    if (this.live) {
      // Heartbeat by wall clock (timers slow down on a busy page; a late tick still beats at
      // once) — only while visible: a hidden page is not playing and has said goodbye.
      const visible = document.visibilityState === 'visible';
      if (visible && (this.slowDirty || now - this.lastHb >= NET_TIMING.heartbeatMs)) this.sendHeartbeat(false);
      if (this.fastDirty) {
        this.fastDirty = false;
        if (visible) this.push('st', { from: this.id, st: this.fast });
      }
    }
    if (now - this.lastSlowTick < 1000) return;
    this.lastSlowTick = now;
    this.link.tick(now);
    for (const [id, o] of this.others) if (now - o.seen > 10 * 60_000) this.others.delete(id);
    this.refresh(); // expiry: someone went silent (or came back)
  }

  private isVisible(o: Remote, now: number): boolean {
    if (!o.hasState) return false;
    if (now - o.seen < NET_TIMING.peerTimeoutMs) return true;
    // Our own link is down: we cannot hear anyone, which says nothing about them.
    const down = this.link.downSince;
    return !!down && now - down < NET_TIMING.deafGraceMs;
  }

  private refresh(): void {
    const now = Date.now();
    const me: NetPeer = { id: this.id, isMe: true, by: this.uid, guest: false, presence: { ...this.slow, ...this.fast } };
    const list: NetPeer[] = [me];
    for (const [id, o] of this.others) {
      if (!this.isVisible(o, now)) continue;
      list.push({ id, isMe: false, by: typeof o.slow.uid === 'string' ? o.slow.uid : null, guest: false, presence: { ...o.slow, ...o.fast } });
    }
    list.sort((a, b) => (a.id < b.id ? -1 : 1));
    this.snapshot = Object.freeze(list);
    this.visibleSig = `${list.map((p) => p.id).join(',')}|${this.status}`;
    for (const fn of this.peerFns) fn(this.snapshot);
  }

  private diagnostics() {
    const now = Date.now();
    const link = this.link;
    return {
      room: this.room,
      status: this.status,
      detail: this.statusDetail,
      live: this.live,
      auth: authError || authStatus,
      uid: this.uid,
      self: this.id,
      peers: this.snapshot.map((p) => p.id),
      others: [...this.others.keys()],
      peerAges: Object.fromEntries([...this.others].map(([id, o]) => [id, { ms: now - o.seen, state: o.hasState }])),
      traffic: { ...link.traffic, ...this.beats },
      heartbeat: { ms: NET_TIMING.heartbeatMs, lastAgo: this.lastHb ? now - this.lastHb : -1, peerTimeoutMs: NET_TIMING.peerTimeoutMs },
      vsn: link.vsn,
      joins: link.joins,
      rejoins: link.rejoins,
      lastRejoinReason: link.lastRejoinReason,
      downFor: link.downSince ? now - link.downSince : 0,
      sig: this.visibleSig,
      history: [...link.history],
      socket: { ...socketBeats },
    };
  }
}

/** Untrusted peer state: a plain, small object. */
function isPlainState(v: unknown): v is Record<string, Json> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  try {
    return JSON.stringify(v).length <= MAX_STATE_JSON;
  } catch {
    return false;
  }
}
