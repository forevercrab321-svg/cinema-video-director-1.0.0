import type { RealtimeChannel } from '@supabase/supabase-js';
import { realtimeClient } from '../backend/supabase';

/**
 * One Supabase Realtime BROADCAST channel that stays up. Shared by the room transport
 * (SupabaseNet, `arena:<code>`) and the site directory (HubPresence, `ge-lobby`); both run on the
 * dedicated realtimeClient(), so a page holds ONE socket however many channels it joins.
 *
 * What it survives (all seen in the field, all modelled by tools/net-presence-test.mjs):
 *   · the server closes the channel: realtime-js does not resubscribe → rebuild with backoff;
 *   · the socket drops: the library rejoins by itself; if that stalls, rebuild after stuckMs;
 *   · realtime-js hands back an existing instance for a known topic, and a retired instance's
 *     late close unregisters channels BY TOPIC (i.e. the new one), after which the client
 *     disconnects the "empty" socket 50 s later → retire by instance, re-register if dropped;
 *   · subscribed yet nothing relayed (not even our own echo) → status 'error'.
 * The owner decides what "down" means for its peers (usually: while we are deaf nobody expires).
 */
export type AnyChannel = RealtimeChannel & { channelAdapter?: { getChannel?(): unknown } };
interface RealtimeInternals {
  channels?: AnyChannel[];
  getChannels?(): AnyChannel[];
  _cancelPendingDisconnect?(): void;
  socketAdapter?: { getSocket?(): { remove?(c: unknown): void } };
  vsn?: string;
}

export interface LinkTiming {
  /** Not subscribed this long after a join attempt: rebuild the channel. */
  stuckMs: number;
  /** Down this long: status 'error' (brief blips stay 'connecting'). */
  errorAfterMs: number;
}

export interface LinkHooks {
  /** A broadcast on the live channel instance; `from` is the validated sender id (or null). */
  receive(event: string, payload: unknown, from: string | null): void;
  /** Subscribed (again). `wasDownSince` = when the link went down (0 = it never was). */
  up(wasDownSince: number): void;
  /** Link state changed (after up / down). */
  changed(): void;
}

export type LinkStatus = 'connecting' | 'connected' | 'error';

export class RealtimeLink {
  private channel: AnyChannel | null = null;
  /** Bumped per channel instance; callbacks and messages from a retired instance are ignored. */
  private joinSeq = 0;
  private joinStartedAt = 0;
  live = false;
  /** When our link went down (0 = up). */
  downSince = 0;
  private rejoinTimer: ReturnType<typeof setTimeout> | null = null;
  /** Backoff step (reset once subscribed); `rejoins` counts every rebuild and is never reset. */
  private attempt = 0;
  rejoins = 0;
  joins = 0;
  lastRejoinReason = '';
  private lastStatus = '';
  status: LinkStatus = 'connecting';
  statusDetail = '';
  /** Broadcast traffic counters (self = our own echoes, proof the server relays). */
  readonly traffic = { sent: 0, recv: 0, self: 0, subscribedAt: 0, sentSinceSub: 0, selfSinceSub: 0 };
  /** Last channel state changes (t = seconds since the page opened). */
  readonly history: string[] = [];

  constructor(
    /** Channel topic without the `realtime:` prefix, e.g. `arena:ABCD` or `ge-lobby`. */
    readonly topic: string,
    private readonly selfId: string,
    private readonly events: readonly string[],
    private readonly hooks: LinkHooks,
    private readonly timing: LinkTiming,
  ) {
    this.join('initial');
  }

  // ── Channel lifecycle ─────────────────────────────────────────────────────
  private get rt(): RealtimeInternals | null {
    return (realtimeClient()?.realtime as unknown as RealtimeInternals | undefined) ?? null;
  }

  get vsn(): string | undefined {
    return this.rt?.vsn;
  }

  /**
   * Subscribe (again, after a server close). Every older instance for this topic is retired
   * first (see the class comment). Presence stays disabled: membership runs on broadcast.
   */
  private join(reason: string): void {
    const sb = realtimeClient()!;
    this.retireTopic(`realtime:${this.topic}`);
    const seq = ++this.joinSeq;
    const mine = () => seq === this.joinSeq;
    const channel = sb.channel(this.topic, { config: { broadcast: { self: true, ack: false }, presence: { key: this.selfId, enabled: false } } }) as AnyChannel;
    this.channel = channel;
    this.joins++;
    this.joinStartedAt = Date.now();
    this.log(`join #${this.joins} (${reason})`);
    for (const event of this.events) {
      channel.on('broadcast', { event }, ({ payload }) => {
        if (mine()) this.hooks.receive(event, payload, this.count(payload));
      });
    }
    channel.subscribe((status, err) => {
      if (mine()) this.onChannelStatus(status, err);
    });
  }

  /** Unsubscribe and tear down every channel instance for `topic` (by instance, never by topic). */
  private retireTopic(topic: string): void {
    const rt = this.rt;
    if (!rt) return;
    const list = rt.getChannels?.() ?? rt.channels ?? [];
    for (const c of [...list]) {
      if (c.topic !== topic) continue;
      const inner = c.channelAdapter?.getChannel?.();
      try {
        void c.unsubscribe().catch(() => undefined); // tells the server, if it still has us
      } catch {
        /* already gone */
      }
      try {
        c.teardown(); // drops its bindings: its late close can no longer touch the new channel
      } catch {
        /* already gone */
      }
      if (inner) rt.socketAdapter?.getSocket?.()?.remove?.(inner);
      if (rt.channels) rt.channels = rt.channels.filter((x) => x !== c);
    }
  }

  /** The client lost track of our live channel (see join): register it again. */
  private guardRegistration(): void {
    const rt = this.rt;
    const ch = this.channel;
    if (!rt?.channels || !ch || rt.channels.includes(ch)) return;
    rt.channels.push(ch);
    rt._cancelPendingDisconnect?.();
    this.log('re-registered channel');
  }

  private onChannelStatus(status: string, err?: Error): void {
    this.lastStatus = status;
    this.log(`${status}${err?.message ? ` (${err.message})` : ''}`);
    const now = Date.now();
    if (status === 'SUBSCRIBED') {
      const wasDown = this.downSince;
      this.live = true;
      this.downSince = 0;
      this.attempt = 0;
      this.status = 'connected';
      this.statusDetail = '';
      this.traffic.subscribedAt = now;
      this.traffic.sentSinceSub = this.traffic.selfSinceSub = 0;
      this.hooks.up(wasDown);
    } else {
      this.live = false;
      this.downSince ||= now;
      // The server closed the channel: realtime-js will not resubscribe, so we do.
      if (status === 'CLOSED') this.scheduleRejoin('server closed channel');
      // CHANNEL_ERROR / TIMED_OUT: realtime-js rejoins these itself (tick() rebuilds if it stalls).
      this.status = now - this.downSince > this.timing.errorAfterMs ? 'error' : 'connecting';
      this.statusDetail = err?.message ? `${status}: ${err.message}` : status;
      console.warn(`[net] realtime ${this.topic}`, status, err ?? '');
    }
    this.hooks.changed();
  }

  private scheduleRejoin(reason: string): void {
    if (this.rejoinTimer !== null) return;
    const delay = this.attempt === 0 ? 250 : Math.min(10_000, 1000 * 2 ** (this.attempt - 1));
    this.attempt++;
    this.rejoins++;
    this.lastRejoinReason = reason;
    this.rejoinTimer = setTimeout(() => {
      this.rejoinTimer = null;
      this.live = false;
      this.join(reason);
    }, delay);
  }

  // ── Traffic ───────────────────────────────────────────────────────────────
  /** Count a received broadcast; returns its sender id when it is a plausible one. */
  private count(payload: unknown): string | null {
    this.traffic.recv++;
    const from = (payload as { from?: unknown } | null)?.from;
    if (typeof from !== 'string' || !from || from.length > 64) return null;
    if (from === this.selfId) {
      this.traffic.self++;
      this.traffic.selfSinceSub++;
    }
    return from;
  }

  send(event: string, payload: Record<string, unknown>): void {
    const ch = this.channel;
    if (!ch) return;
    this.traffic.sent++;
    this.traffic.sentSinceSub++;
    void ch.send({ type: 'broadcast', event, payload }).catch(() => undefined);
  }

  // ── Tick (about once a second) ────────────────────────────────────────────
  tick(now = Date.now()): void {
    this.guardRegistration();
    if (!this.live) {
      if (this.downSince && this.status === 'connecting' && now - this.downSince > this.timing.errorAfterMs) {
        this.status = 'error';
        this.statusDetail ||= 'offline';
      }
      // The library's own retries have not brought the channel back: rebuild it.
      if (this.rejoinTimer === null && now - Math.max(this.joinStartedAt, this.downSince) > this.timing.stuckMs) this.scheduleRejoin(`stuck ${this.lastStatus || 'joining'}`);
    }
    this.checkRelay(now);
  }

  /** Subscribed, yet not even our own echo came back: the relay is not delivering. */
  private checkRelay(now: number): void {
    const t = this.traffic;
    const silent = this.live && now - t.subscribedAt > 6000 && t.selfSinceSub === 0 && t.sentSinceSub > 3;
    if (silent && this.status !== 'error') {
      this.status = 'error';
      this.statusDetail = 'broadcast not delivered';
      console.warn(`[net] ${this.topic}: subscribed but no broadcast echo`, t);
    } else if (!silent && this.live && this.status !== 'connected' && (t.selfSinceSub > 0 || now - t.subscribedAt <= 6000)) {
      this.status = 'connected';
      this.statusDetail = '';
    }
  }

  log(line: string): void {
    this.history.push(`${Math.round(performance.now() / 1000)}s ${line}`);
    if (this.history.length > 12) this.history.shift();
  }
}

/**
 * Stable per tab: a reload (or a phone browser restoring the page) keeps the same id, so the
 * others never list a "ghost" of the previous load next to the new one. A new tab, a duplicated
 * tab or a second iframe (sessionStorage is shared with same-origin frames) gets a fresh id.
 */
export function tabId(storageKey: string, prefix: string): string {
  const fresh = prefix + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  try {
    const nav = performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
    const v = sessionStorage.getItem(storageKey);
    const ok = new RegExp(`^${prefix}[a-z0-9]{6,16}$`);
    if (nav?.type === 'reload' && v && ok.test(v)) return v;
    sessionStorage.setItem(storageKey, fresh);
  } catch {
    /* storage blocked (private mode / sandboxed iframe): a fresh id per load */
  }
  return fresh;
}
