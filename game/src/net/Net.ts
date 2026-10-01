/**
 * Transport for the arena. One interface, three implementations:
 *   RoomNet  — the claude.ai artifact `room` capability (real online play, viewers' own accounts)
 *   LocalNet — BroadcastChannel between tabs of one browser (development and automated tests)
 *   SoloNet  — nobody else; messages loop back (single player vs AI rivals)
 * Semantics follow the room capability: presence is "my current state" (coalesced, shared with
 * newcomers, cleared on leave); emit sends a moment to everyone including myself; nothing
 * persists; messages can drop. Every payload is untrusted input from another player.
 */
export type Json = unknown;

export interface NetPeer {
  /** One open document (tab); stable while it stays open. */
  id: string;
  isMe: boolean;
  /** Durable account id when the platform vouches for it (RoomNet with `user`), else null. */
  by: string | null;
  guest: boolean;
  presence: Readonly<Record<string, Json>>;
}

export interface NetMessage {
  from: string;
  isMe: boolean;
  data: Json;
}

export interface Net {
  readonly kind: 'room' | 'local' | 'solo' | 'online';
  /** My peer id once known (null until the transport answers). */
  selfId(): string | null;
  peers(): readonly NetPeer[];
  onPeers(fn: (peers: readonly NetPeer[]) => void): void;
  setPresence(patch: Record<string, Json | null>): void;
  emit(topic: string, data: Json): void;
  on(topic: string, fn: (msg: NetMessage) => void): void;
  connected(): boolean;
  /** Display name for a peer (account name where available, else the nickname in presence). */
  nameOf(peer: NetPeer): string;
  /** Server-confirmed host (online rooms, 0006 RPC); null = unknown: the client election decides. */
  lease?(): { peer: string; term: number } | null;
  /** The client election picks this page as host: claim the server lease when it is free. */
  wantHost?(want: boolean): void;
}

const randomId = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);

// ── Solo ──────────────────────────────────────────────────────────────────────
export class SoloNet implements Net {
  readonly kind = 'solo' as const;
  private readonly id = 'me-' + randomId();
  private presence: Record<string, Json> = {};
  private readonly handlers = new Map<string, ((m: NetMessage) => void)[]>();
  private readonly peerFns: ((p: readonly NetPeer[]) => void)[] = [];
  private snapshot: readonly NetPeer[] = [];

  constructor(private readonly nickname = 'You') {
    this.refresh();
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
    this.presence = mergePresence(this.presence, patch);
    this.refresh();
  }
  emit(topic: string, data: Json): void {
    // Loop back asynchronously, like a real transport echo.
    queueMicrotask(() => for_(this.handlers.get(topic), (fn) => fn({ from: this.id, isMe: true, data })));
  }
  on(topic: string, fn: (m: NetMessage) => void): void {
    const list = this.handlers.get(topic) ?? [];
    list.push(fn);
    this.handlers.set(topic, list);
  }
  connected(): boolean {
    return true;
  }
  nameOf(peer: NetPeer): string {
    return (typeof peer.presence.nk === 'string' && peer.presence.nk) || this.nickname;
  }
  private refresh(): void {
    this.snapshot = Object.freeze([Object.freeze({ id: this.id, isMe: true, by: null, guest: false, presence: Object.freeze({ ...this.presence }) })]);
    for (const fn of this.peerFns) fn(this.snapshot);
  }
}

// ── Local (BroadcastChannel) ──────────────────────────────────────────────────
/** Tabs of one browser on one origin share a room named by `channel`. */
export class LocalNet implements Net {
  readonly kind = 'local' as const;
  private readonly id = 'tab-' + randomId();
  private readonly bc: BroadcastChannel;
  private presence: Record<string, Json> = {};
  private readonly others = new Map<string, { presence: Record<string, Json>; seen: number }>();
  private readonly handlers = new Map<string, ((m: NetMessage) => void)[]>();
  private readonly peerFns: ((p: readonly NetPeer[]) => void)[] = [];
  private snapshot: readonly NetPeer[] = [];
  private dirty = false;

  constructor(channel: string, nickname: string) {
    this.bc = new BroadcastChannel(`grow-arena-${channel}`);
    this.bc.onmessage = (e) => this.receive(e.data as { t: string; from: string; topic?: string; data?: Json; presence?: Record<string, Json> });
    this.presence = { nk: nickname };
    this.post({ t: 'hello' });
    // Presence at ~30 Hz, keepalive and peer expiry like the room runtime.
    setInterval(() => {
      if (this.dirty) {
        this.dirty = false;
        this.post({ t: 'presence', presence: this.presence });
      }
    }, 33);
    setInterval(() => {
      // Like the online transport: a hidden page sends no keepalive and expires for the others.
      if (document.visibilityState === 'visible') this.post({ t: 'presence', presence: this.presence });
      const now = Date.now();
      for (const [id, o] of this.others) if (now - o.seen > 4000) this.others.delete(id);
      this.refresh();
    }, 1000);
    addEventListener('pagehide', () => this.post({ t: 'bye' }));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.post({ t: 'bye' });
      else this.post({ t: 'presence', presence: this.presence });
    });
    this.refresh();
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
    this.presence = mergePresence(this.presence, patch);
    const st = (this.stats.presence ??= { n: 0, max: 0 });
    st.n++;
    st.max = Math.max(st.max, JSON.stringify(this.presence).length);
    this.dirty = true;
    this.refresh();
  }
  /** Dev/test stats: count and largest JSON payload per topic (the room caps payloads at 4 KiB). */
  readonly stats: Record<string, { n: number; max: number }> = {};

  emit(topic: string, data: Json): void {
    const st = (this.stats[topic] ??= { n: 0, max: 0 });
    st.n++;
    st.max = Math.max(st.max, JSON.stringify(data).length);
    this.post({ t: 'msg', topic, data });
    queueMicrotask(() => for_(this.handlers.get(topic), (fn) => fn({ from: this.id, isMe: true, data })));
  }
  on(topic: string, fn: (m: NetMessage) => void): void {
    const list = this.handlers.get(topic) ?? [];
    list.push(fn);
    this.handlers.set(topic, list);
  }
  connected(): boolean {
    return true;
  }
  nameOf(peer: NetPeer): string {
    return (typeof peer.presence.nk === 'string' && peer.presence.nk) || 'Player';
  }
  private post(m: Record<string, Json>): void {
    this.bc.postMessage({ ...m, from: this.id });
  }
  private receive(m: { t: string; from: string; topic?: string; data?: Json; presence?: Record<string, Json> }): void {
    if (m.from === this.id) return;
    if (m.t === 'hello') {
      this.post({ t: 'presence', presence: this.presence });
      this.others.set(m.from, this.others.get(m.from) ?? { presence: {}, seen: Date.now() });
      this.refresh();
    } else if (m.t === 'presence' && m.presence) {
      this.others.set(m.from, { presence: m.presence, seen: Date.now() });
      this.refresh();
    } else if (m.t === 'bye') {
      this.others.delete(m.from);
      this.refresh();
    } else if (m.t === 'msg' && m.topic) {
      for_(this.handlers.get(m.topic), (fn) => fn({ from: m.from, isMe: false, data: m.data }));
    }
  }
  private refresh(): void {
    const list: NetPeer[] = [{ id: this.id, isMe: true, by: null, guest: false, presence: { ...this.presence } }];
    for (const [id, o] of this.others) list.push({ id, isMe: false, by: null, guest: false, presence: o.presence });
    list.sort((a, b) => (a.id < b.id ? -1 : 1));
    this.snapshot = Object.freeze(list);
    for (const fn of this.peerFns) fn(this.snapshot);
  }
}

// ── Room (claude.ai artifact capability) ──────────────────────────────────────
interface RoomSender {
  peer: string;
  by: string | null;
  isMe: boolean;
  sameTab: boolean;
  kind: 'viewer' | 'agent';
  guest: boolean;
}
interface RoomPeer extends RoomSender {
  presence: Readonly<Record<string, Json>>;
}
interface RoomApi {
  emit(topic: string, data?: Json): Promise<void>;
  on(topic: string, fn: (m: RoomSender & { data?: Json }) => void, onError?: (e: { code: string }) => void): () => void;
  presence(patch: Record<string, Json | null>): Promise<void>;
  peers(): readonly RoomPeer[];
  onPeers(fn: (c: { peers: readonly RoomPeer[] }) => void, onError?: (e: { code: string }) => void): () => void;
  connected(): boolean;
}
interface UserApi {
  profiles(ids: readonly string[]): Promise<Record<string, { name: string; avatarUrl: string; color: string }>>;
  me(): Promise<{ id: string | null; name: string }>;
}

/**
 * Online play over the artifact room. Viewers are signed-in claude.ai accounts the artifact
 * is shared with; names come from the `user` capability (resolved per viewer, never stored).
 */
export class RoomNet implements Net {
  readonly kind = 'room' as const;
  private snapshot: readonly NetPeer[] = [];
  private readonly peerFns: ((p: readonly NetPeer[]) => void)[] = [];
  private readonly names = new Map<string, string>();
  private me: string | null = null;
  myName = '';

  private constructor(
    private readonly room: RoomApi,
    private readonly user: UserApi | null,
  ) {
    room.onPeers((c) => {
      this.snapshot = Object.freeze(
        c.peers
          .filter((p) => p.kind === 'viewer')
          .map((p) => ({ id: p.peer, isMe: p.isMe && p.sameTab, by: p.by, guest: p.guest, presence: p.presence }))
          .sort((a, b) => (a.id < b.id ? -1 : 1)),
      );
      const mine = this.snapshot.find((p) => p.isMe);
      if (mine) this.me = mine.id;
      void this.resolveNames();
      for (const fn of this.peerFns) fn(this.snapshot);
    });
  }

  /** Resolve the room (null when this view cannot connect: open the page on claude.ai, signed in). */
  static async connect(): Promise<RoomNet | null> {
    const claude = (window as unknown as { claude?: { use(n: string): Promise<unknown> } }).claude;
    if (!claude?.use) return null;
    const room = (await claude.use('room').catch(() => null)) as RoomApi | null;
    if (!room) return null;
    const user = (await claude.use('user').catch(() => null)) as UserApi | null;
    const net = new RoomNet(room, user);
    if (user) net.myName = (await user.me().catch(() => ({ name: '' }))).name;
    return net;
  }

  selfId(): string | null {
    return this.me;
  }
  peers(): readonly NetPeer[] {
    return this.snapshot;
  }
  onPeers(fn: (p: readonly NetPeer[]) => void): void {
    this.peerFns.push(fn);
    queueMicrotask(() => fn(this.snapshot));
  }
  setPresence(patch: Record<string, Json | null>): void {
    this.room.presence(patch).catch(() => {});
  }
  emit(topic: string, data: Json): void {
    this.room.emit(topic, data).catch(() => {});
  }
  on(topic: string, fn: (m: NetMessage) => void): void {
    this.room.on(topic, (m) => {
      if (m.kind !== 'viewer') return;
      fn({ from: m.peer, isMe: m.isMe && m.sameTab, data: m.data });
    });
  }
  connected(): boolean {
    return this.room.connected();
  }
  nameOf(peer: NetPeer): string {
    return (peer.by && this.names.get(peer.by)) || (typeof peer.presence.nk === 'string' && peer.presence.nk) || 'Player';
  }
  private async resolveNames(): Promise<void> {
    if (!this.user) return;
    const ids = this.snapshot.map((p) => p.by).filter((x): x is string => !!x);
    if (!ids.length) return;
    const ps = await this.user.profiles(ids).catch(() => ({}) as Record<string, { name: string }>);
    for (const id of ids) if (ps[id]?.name) this.names.set(id, ps[id].name);
  }
}

function mergePresence(cur: Record<string, Json>, patch: Record<string, Json | null>): Record<string, Json> {
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next;
}

function for_<T>(list: T[] | undefined, fn: (x: T) => void): void {
  if (list) for (const x of list) fn(x);
}
