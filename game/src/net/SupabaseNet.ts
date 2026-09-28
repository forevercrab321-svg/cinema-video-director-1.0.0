import type { RealtimeChannel } from '@supabase/supabase-js';
import { authError, currentUser, realtimeClient, socketBeats, supabase } from '../backend/supabase';
import type { Json, Net, NetMessage, NetPeer } from './Net';

/**
 * Public online rooms over Supabase Realtime (for the stand-alone web / portal builds, where
 * the claude.ai room is not available). One channel per room code (`?room=ABCD`); share the
 * page URL to invite friends.
 *
 * Same semantics as the other transports: presence = "my current state", emit = a moment to
 * everyone including me. Realtime presence is meant for low-rate state, so fields that change
 * every frame (`s`, `b`, `ep`: the machine state) travel as a throttled broadcast instead and are
 * merged back into that peer's presence object here — the session never sees the difference.
 *
 * Liveness: Realtime presence only drops a peer when its socket closes, but a phone that locks
 * or switches apps freezes the page with the socket still open. Every visible page therefore
 * sends a heartbeat each second; a peer silent for PEER_TIMEOUT_MS is treated as gone (and
 * comes back as soon as it speaks again). Hiding or closing the page says goodbye at once.
 */
// Generous: a busy or briefly throttled page (or a channel rejoin) must not drop a player. A page
// that is really leaving says goodbye ('bye' on hide / pagehide), which drops it at once.
const PEER_TIMEOUT_MS = 12_000;
const HEARTBEAT_MS = 1000;
const FAST_KEYS = new Set(['s', 'b', 'ep']);

export class SupabaseNet implements Net {
  readonly kind = 'online' as const;
  private readonly id = 'p-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  private channel!: RealtimeChannel;
  /** Rejoin bookkeeping: a server-closed or long-failing channel is rebuilt with backoff. */
  private rejoinTimer: number | null = null;
  private rejoins = 0;
  private retiring: RealtimeChannel | null = null;
  private downSince = 0;
  private slow: Record<string, Json> = {};
  private fast: Record<string, Json> = {};
  private readonly others = new Map<string, { slow: Record<string, Json>; fast: Record<string, Json> }>();
  private readonly handlers = new Map<string, ((m: NetMessage) => void)[]>();
  private readonly peerFns: ((p: readonly NetPeer[]) => void)[] = [];
  private snapshot: readonly NetPeer[] = [];
  private live = false;
  /** Realtime channel state for the lobby's connection line: connecting → connected, or the error. */
  status: 'connecting' | 'connected' | 'error' = 'connecting';
  statusDetail = '';
  /** Broadcast traffic counters for window.__NET__ (self = our own echoes, proof the server relays). */
  private readonly traffic = { sent: 0, recv: 0, self: 0, subscribedAt: 0 };
  private slowDirty = false;
  private fastDirty = false;
  private uid: string | null = null;
  /** Last time each other peer was heard from (heartbeat, state or message). */
  private readonly seen = new Map<string, number>();
  private hbTimer = 0;
  private lastHb = 0;
  /** Last channel state changes, for window.__NET__ (t = seconds since the page opened). */
  private readonly history: string[] = [];

  private constructor(
    readonly room: string,
    nickname: string,
  ) {
    this.slow = { nk: nickname };
    this.join();
    // Remote diagnosis: window.__NET__() in the console (or a browser agent) reports the link state.
    (window as unknown as Record<string, unknown>).__NET__ = () => ({
      room,
      status: this.status,
      detail: this.statusDetail,
      auth: authError,
      self: this.id,
      peers: this.snapshot.map((p) => p.id),
      traffic: { ...this.traffic },
      vsn: (realtimeClient()?.realtime as unknown as { vsn?: string } | undefined)?.vsn,
      rejoins: this.rejoins,
      history: [...this.history],
      socket: { ...socketBeats },
      others: [...this.others.keys()],
    });
    setInterval(() => this.pump(), 66); // ~15 Hz state, presence changes debounced into the same tick
    const goodbye = () => {
      if (this.live) void this.channel.send({ type: 'broadcast', event: 'bye', payload: { from: this.id } });
    };
    addEventListener('pagehide', goodbye);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') goodbye();
      else this.slowDirty = this.fastDirty = true; // back: re-announce everything at once
    });
    this.refresh();
  }

  /** Subscribe to the room channel (again, after a server close). Presence key stays this.id. */
  private join(): void {
    const sb = realtimeClient()!;
    const channel = sb.channel(`arena:${this.room}`, { config: { presence: { key: this.id }, broadcast: { self: true, ack: false } } });
    this.channel = channel;
    channel
      .on('presence', { event: 'sync' }, () => this.syncPresence())
      .on('broadcast', { event: 'msg' }, ({ payload }) => {
        this.count(payload);
        const m = payload as { topic?: string; from?: string; data?: Json };
        if (typeof m?.topic !== 'string' || typeof m.from !== 'string') return;
        this.heard(m.from);
        for (const fn of this.handlers.get(m.topic) ?? []) fn({ from: m.from, isMe: m.from === this.id, data: m.data });
      })
      .on('broadcast', { event: 'st' }, ({ payload }) => {
        this.count(payload);
        const m = payload as { from?: string; st?: Record<string, Json> };
        if (typeof m?.from !== 'string' || m.from === this.id || !m.st || typeof m.st !== 'object') return;
        this.seen.set(m.from, Date.now());
        const o = this.others.get(m.from) ?? { slow: {}, fast: {} };
        o.fast = { ...o.fast, ...m.st };
        this.others.set(m.from, o);
        this.refresh();
      })
      .on('broadcast', { event: 'hb' }, ({ payload }) => {
        this.count(payload);
        const from = (payload as { from?: string })?.from;
        if (typeof from === 'string' && from !== this.id) this.heard(from);
      })
      .on('broadcast', { event: 'bye' }, ({ payload }) => {
        const from = (payload as { from?: string })?.from;
        if (typeof from !== 'string' || from === this.id) return;
        this.seen.delete(from);
        this.refresh();
      })
      .subscribe((status, err) => {
        if (channel !== this.channel || channel === this.retiring) return; // a retired channel reporting its own shutdown
        this.history.push(`${Math.round(performance.now() / 1000)}s ${status}${err?.message ? ` (${err.message})` : ''}`);
        if (this.history.length > 8) this.history.shift();
        this.live = status === 'SUBSCRIBED';
        if (this.live) {
          this.slowDirty = true;
          this.traffic.subscribedAt = Date.now();
          this.status = 'connected';
          this.statusDetail = '';
          this.downSince = 0;
          this.rejoins = 0;
        } else {
          this.downSince ||= Date.now();
          // The server closed the channel: realtime-js will not resubscribe, so we do.
          if (status === 'CLOSED') this.scheduleRejoin();
          // CHANNEL_ERROR / TIMED_OUT: supabase-js retries these itself; say why meanwhile.
          this.status = status === 'CLOSED' ? 'connecting' : 'error';
          this.statusDetail = err?.message ? `${status}: ${err.message}` : status;
          console.warn('[net] realtime', status, err ?? '');
        }
        this.refresh();
      });
  }

  private scheduleRejoin(): void {
    if (this.rejoinTimer !== null) return;
    const delay = Math.min(10_000, 1000 * 2 ** this.rejoins++);
    this.rejoinTimer = window.setTimeout(() => void this.rejoin(), delay);
  }

  /** Tear the dead channel down completely (channel() hands back an existing topic), then join again. */
  private async rejoin(): Promise<void> {
    const rt = realtimeClient()!;
    const old = this.channel;
    this.retiring = old;
    this.live = false;
    try {
      await Promise.race([rt.removeChannel(old), new Promise((r) => setTimeout(r, 3000))]);
    } catch {
      /* already gone */
    }
    (rt.realtime as unknown as { _remove?(c: RealtimeChannel): void })._remove?.(old);
    this.rejoinTimer = null;
    this.join();
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
      net.slow.uid = u.id;
      net.slowDirty = true;
    };
    attach(user);
    void pending.then(attach);
    return net;
  }

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
    for (const [k, v] of Object.entries(patch)) {
      const bag = FAST_KEYS.has(k) ? this.fast : this.slow;
      if (v === null) delete bag[k];
      else bag[k] = v;
      if (FAST_KEYS.has(k)) this.fastDirty = true;
      else this.slowDirty = true;
    }
    this.refresh();
  }
  emit(topic: string, data: Json): void {
    if (!this.live) {
      // Not subscribed (connecting, blocked or offline): nobody else can hear it, but this client must —
      // the host drives its own match from the self-echo, so dropping it froze the round in countdown.
      queueMicrotask(() => {
        for (const fn of this.handlers.get(topic) ?? []) fn({ from: this.id, isMe: true, data });
      });
      return;
    }
    void this.push({ type: 'broadcast', event: 'msg', payload: { topic, from: this.id, data } });
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

  private push(args: { type: 'broadcast'; event: string; payload: Json }): Promise<unknown> {
    this.traffic.sent++;
    return this.channel.send(args);
  }

  private count(payload: unknown): void {
    this.traffic.recv++;
    if ((payload as { from?: unknown } | null)?.from === this.id) this.traffic.self++;
  }

  /** Subscribed, yet not even our own heartbeat echo came back: the relay is not delivering. */
  private checkRelay(): void {
    const t = this.traffic;
    const silent = this.live && t.subscribedAt > 0 && Date.now() - t.subscribedAt > 6000 && t.self === 0 && t.sent > 3;
    if (silent && this.status !== 'error') {
      this.status = 'error';
      this.statusDetail = 'broadcast not delivered';
      console.warn('[net] subscribed but no broadcast echo', t);
      this.refresh();
    } else if (!silent && this.live && t.self > 0 && this.status === 'error') {
      this.status = 'connected';
      this.statusDetail = '';
      this.refresh();
    }
  }

  private heard(from: string): void {
    const was = this.isAlive(from);
    this.seen.set(from, Date.now());
    if (!was) this.refresh();
  }

  private isAlive(id: string): boolean {
    return Date.now() - (this.seen.get(id) ?? 0) < PEER_TIMEOUT_MS;
  }

  private pump(): void {
    if (!this.live) {
      // Down: still expire silent peers (so the lobby stops showing them), and rebuild the channel
      // if the library's own retries have not brought it back within 15 s.
      this.hbTimer += 66;
      if (this.hbTimer >= 1000) {
        this.hbTimer = 0;
        const alive = 1 + [...this.others.keys()].filter((id) => this.isAlive(id)).length;
        if (alive !== this.snapshot.length) this.refresh();
        if (this.downSince && Date.now() - this.downSince > 15_000) {
          this.downSince = Date.now();
          this.scheduleRejoin();
        }
      }
      return;
    }
    // Heartbeat by wall clock (timers slow down on a busy page; each late tick still beats at once)
    // — only while visible: a hidden page is not playing — plus expiry of silent peers.
    const now = Date.now();
    if (now - this.lastHb >= HEARTBEAT_MS) {
      this.lastHb = now;
      if (document.visibilityState === 'visible') void this.push({ type: 'broadcast', event: 'hb', payload: { from: this.id } });
      const alive = 1 + [...this.others.keys()].filter((id) => this.isAlive(id)).length;
      if (alive !== this.snapshot.length) this.refresh(); // someone went silent (or came back)
      this.checkRelay();
    }
    if (this.slowDirty) {
      this.slowDirty = false;
      void this.channel.track({ ...this.slow });
    }
    if (this.fastDirty) {
      this.fastDirty = false;
      void this.push({ type: 'broadcast', event: 'st', payload: { from: this.id, st: this.fast } });
    }
  }

  private syncPresence(): void {
    const state = this.channel.presenceState() as Record<string, Record<string, Json>[]>;
    const seen = new Set<string>();
    for (const [key, metas] of Object.entries(state)) {
      if (key === this.id) continue;
      seen.add(key);
      const meta = { ...(metas[metas.length - 1] ?? {}) };
      delete meta.presence_ref;
      const o = this.others.get(key) ?? { slow: {}, fast: {} };
      if (!this.others.has(key)) this.seen.set(key, Date.now()); // a fresh join counts as heard
      o.slow = meta;
      this.others.set(key, o);
    }
    for (const id of [...this.others.keys()]) if (!seen.has(id)) this.others.delete(id);
    this.refresh();
  }

  private refresh(): void {
    const me: NetPeer = { id: this.id, isMe: true, by: this.uid, guest: false, presence: { ...this.slow, ...this.fast } };
    const list: NetPeer[] = [me];
    for (const [id, o] of this.others) if (this.isAlive(id)) list.push({ id, isMe: false, by: typeof o.slow.uid === 'string' ? o.slow.uid : null, guest: false, presence: { ...o.slow, ...o.fast } });
    list.sort((a, b) => (a.id < b.id ? -1 : 1));
    this.snapshot = Object.freeze(list);
    for (const fn of this.peerFns) fn(this.snapshot);
  }
}
