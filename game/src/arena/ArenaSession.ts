import { arenaConfig as A, MAX_SEATS, maxPlayersFor, roundSecondsFor } from '../config/arena';
import { HALLOWEEN as HW, isHalloween } from '../config/halloween';
import { HATS, HORNS, SKINS } from '../config/cosmetics';
import { VEHICLE_ORDER, type VehicleLook } from '../config/vehicles';
import type { Net, NetPeer } from '../net/Net';
import type { HubState, RoomPhase } from '../net/Hub';
import { L } from '../i18n';
import { CITIES, cityById } from '../world/cities';
import type { ArenaGame, EatenEvent, RosterEntry, Standing, WireState } from './ArenaGame';
import { cleanName } from './nameFilter';

/**
 * Lobby, match flow and host authority on top of a Net.
 *
 * Everyone who opens the page is in the room; up to four JOIN a match (others spectate).
 * The HOST: in an online room with the backend, the page holding the server lease
 * (net/HostLease.ts, migration 0006); everyone agrees on it whatever their peer lists say, and
 * its messages are signed. Without the lease, a client election: the announced host keeps the
 * job while present; when it is gone the lowest joined peer id takes over with a higher term
 * (`hg`), and competing claims resolve the same way on every client (higher term, then the
 * older page, then the lower id). The host:
 *   · owns the match clock and phase (lobby → countdown → playing → results → lobby),
 *   · grants each object to the first machine that claims it,
 *   · validates "A ate B" and broadcasts the result,
 *   · simulates the AI rivals that fill empty slots.
 * Messages are small, batched (~11/s) and re-sent periodically, because the room may drop them.
 */
export type MatchPhase = 'lobby' | 'countdown' | 'playing' | 'results';

export interface MatchState {
  ep: number;
  ph: MatchPhase;
  host: string;
  city: string;
  seed: number;
  bots: boolean;
  roster: RosterEntry[];
  t: number;
  standings?: Standing[];
  /** Host, while playing: base64 bitset of absorbed objects (late joiners and drift repair). */
  abs?: string;
  /**
   * Warm-up: the host was alone in an online room and plays the AI while waiting for invited
   * friends. The first friend to arrive restarts the round as a real match for everyone.
   */
  wu?: boolean;
  /** Names of the friends whose arrival ended a warm-up (announced when the real match starts). */
  wj?: string;
  /** Host term: the server lease term, or +1 per client-side takeover. Higher wins a conflict. */
  hg?: number;
  /** When the host's page opened the room (ms): the older page wins a tie between equal terms. */
  sn?: number;
  /** Host, while playing: recent eats [id, victim slot, attacker slot, gain, first] (lost 'eaten' repair). */
  ev?: number[][];
  /** Host, while playing: mass / kill caps [slot, kg, kills] (massLedger.ts). */
  mc?: number[][];
  /** Halloween map: match time the hunt started (scores locked); absent while growing. */
  hk?: number;
  /** Halloween map: locked scores [slot, kg] stamped at `hk`. */
  hs?: number[][];
  /** Halloween map: catches [slot, match time, villain index]. */
  hc?: number[][];
}

export interface LobbyPlayer {
  id: string;
  name: string;
  vehicle: VehicleLook;
  /** Cosmetics (skin id, horn id): looks only, never stats. */
  skin?: string;
  horn?: string;
  hat?: string;
  ready: boolean;
  isMe: boolean;
  guest: boolean;
}

export interface SessionHooks {
  /** A match (re)started: build the arena game for this roster. */
  startGame(state: MatchState, localId: string | null): ArenaGame;
  endGame(): void;
  changed(): void;
}

const BOT_NAMES = ['Rustbucket', 'Magna', 'Gearjaw', 'Scrapper', 'Hoover-9', 'Chomp'];

export class ArenaSession {
  match: MatchState;
  game: ArenaGame | null = null;
  /** My lobby choices (published in presence). */
  vehicle: VehicleLook = 'collector';
  skin = 'stock';
  horn = 'clown';
  hat = 'none';
  joined = true;
  ready = false;
  /** Host-side lobby settings. */
  city = CITIES[0].id;
  bots = true;
  /**
   * Public room: listed in the hub, strangers can join. A last-writer-wins register gossiped in
   * every member's lobby presence (pb, pa), so it survives host changes: whoever set it last
   * (pa = when) wins, and a member who never chose (pa = 0) adopts it.
   */
  pub = false;
  private pubAt = 0;
  /** When this page opened the room (the hub lists older rooms first among equals). */
  readonly since = Date.now();
  private readonly grantQueue: [number, string][] = [];
  /** Host: object id → the machine it was granted to (a repeated claim gets the same answer again). */
  private readonly granted = new Map<number, string>();
  /** Host: eats of this round, re-sent in the beacon for a few seconds (a lost 'eaten' is repaired). */
  private recentEaten: { id: number; at: number; row: number[] }[] = [];
  /** Eat ids already applied this round (the beacon repeats them). */
  private readonly seenEaten = new Set<number>();
  private readonly lastEaten = new Map<string, number>();
  private firstBlood = false;
  private grantTimer = 0;
  private refillTimer = 0;
  private claimTimer = 0;
  private presenceTimer = 0;
  private lastPresence = '';
  private beaconTimer = 0;
  private resultsTimer = 0;
  private wasHost = false;
  private admitTimer = 0;
  /** When this page was hidden during a round (ms timestamp), for away detection. */
  private hiddenAt = 0;
  /** When this session started, and whether it has heard another page's host beacon since. */
  private readonly bornAt = performance.now();
  private heardHost = false;

  constructor(
    readonly net: Net,
    private readonly hooks: SessionHooks,
    private nickname: string,
  ) {
    this.match = { ep: 0, ph: 'lobby', host: '', city: this.city, seed: 1, bots: true, roster: [], t: 0 };
    this.publishLobbyPresence();
    net.onPeers(() => {
      this.adoptPublic();
      this.hooks.changed();
    });
    net.on('match', (m) => this.onMatch(m.from, m.data as MatchState));
    // Wire format uses roster SLOTS (0–3) for machines, not peer ids: payloads stay small.
    net.on('claim', (m) => this.onClaim(m.data as { ep: number; c: [number, number][] }));
    net.on('grant', (m) => this.onGrant(m.from, m.data as { ep: number; g: [number, number][]; r?: number[] }));
    net.on('eat', (m) => this.onEat(m.data as { ep: number; e: [number, number][] }));
    net.on('eaten', (m) => this.onEaten(m.from, m.data as { ep: number; v: number; a: number; gain: number; first: boolean }));
    // A page that was hidden (phone locked, app switched, tab in background) stops simulating.
    // After a few seconds away the others have moved on without it: on return it steps out of
    // the round and asks back in (the host re-admits it to its own machine).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.hiddenAt = Date.now();
      else if (this.hiddenAt) {
        const away = Date.now() - this.hiddenAt;
        this.hiddenAt = 0;
        if (away > A.awayMs) this.cameBack();
      }
    });
  }

  private cameBack(): void {
    const g = this.game;
    const me = this.net.selfId();
    const others = this.match.roster.some((r) => r.kind === 'player' && r.id !== me);
    if (!g?.local || !me || !others || this.match.ph === 'lobby' || this.match.ph === 'results') return;
    g.markLeft(me, true);
    this.net.setPresence({ aw: this.match.ep });
  }

  // ── Who is here ───────────────────────────────────────────────────────────
  selfId(): string | null {
    return this.net.selfId();
  }

  lobbyPlayers(): LobbyPlayer[] {
    return this.net
      .peers()
      .filter((p) => p.presence.j === true)
      .slice(0, this.seats())
      .map((p) => ({ id: p.id, name: cleanName(this.net.nameOf(p), `${L('玩家', 'Player')}${p.id.replace(/\W/g, '').slice(-3).toUpperCase()}`), vehicle: asVehicle(p.presence.v), skin: shortId(p.presence.k), horn: shortId(p.presence.hn), hat: shortId(p.presence.ht), ready: p.presence.r === true, isMe: p.isMe, guest: p.guest }));
  }

  /** Seats in this room: 6 on the Halloween map, 4 elsewhere (the host's pick in the lobby, else the round's map). */
  seats(): number {
    return maxPlayersFor(this.match.ph === 'lobby' ? this.city : this.match.city);
  }

  spectators(): NetPeer[] {
    const joined = new Set(this.lobbyPlayers().map((p) => p.id));
    return this.net.peers().filter((p) => !joined.has(p.id));
  }

  /** The host: the server lease holder when the backend confirms one, else the client election. */
  hostId(): string | null {
    const lease = this.net.lease?.();
    if (lease) return lease.peer;
    return this.electLocal();
  }

  /**
   * Client-side election. The announced host keeps the job while it is here (in the lobby too:
   * a newcomer with a lower id never takes over); otherwise the lowest joined peer id.
   */
  private electLocal(): string | null {
    const inMatch = this.match.ph !== 'lobby' ? new Set(this.match.roster.filter((r) => r.kind === 'player').map((r) => r.id)) : null;
    const peers = this.net.peers();
    if (inMatch) {
      // In a round the host is sticky: whoever the match names keeps the job while present.
      // Players who left or froze (marked left) never host, so a returning page cannot grab
      // the round back with a stale simulation.
      const eligible = (id: string) => inMatch.has(id) && !this.game?.byId.get(id)?.left && peers.some((p) => p.id === id);
      if (this.match.host && eligible(this.match.host)) return this.match.host;
      const next = peers.filter((p) => eligible(p.id)).map((p) => p.id).sort()[0];
      if (next) return next;
    } else {
      const h = this.match.host;
      if (h && peers.some((p) => p.id === h && p.presence.j === true)) return h;
    }
    const candidates = peers.filter((p) => (inMatch ? inMatch.has(p.id) : p.presence.j === true));
    const pool = candidates.length ? candidates : peers;
    return pool.length ? pool.map((p) => p.id).sort()[0] : this.net.selfId();
  }

  /**
   * Without a server lease: does `from`'s beacon beat the host this page follows? A higher term
   * wins; equal terms go to the page that opened the room first, then the lower id. Every client
   * ranks two claims the same way, so a split heals at the next beacon.
   */
  private outranks(from: string, m: MatchState): boolean {
    if (m.host !== from) return false;
    const cur = this.match.host;
    if (!cur || cur === from || !this.net.peers().some((p) => p.id === cur)) return true;
    const a = m.hg ?? 0;
    const b = this.match.hg ?? 0;
    if (a !== b) return a > b;
    const sa = m.sn ?? Number.MAX_SAFE_INTEGER;
    const sb = this.match.sn ?? Number.MAX_SAFE_INTEGER;
    return sa !== sb ? sa < sb : from < cur;
  }

  isHost(): boolean {
    const me = this.net.selfId();
    return !!me && this.hostId() === me;
  }

  // ── Lobby actions ─────────────────────────────────────────────────────────
  setNickname(n: string): void {
    this.nickname = cleanName(n, this.nickname);
    this.publishLobbyPresence();
  }

  get name(): string {
    return this.nickname;
  }

  setVehicle(v: VehicleLook): void {
    this.vehicle = v;
    this.publishLobbyPresence();
  }

  setCosmetics(skin: string, horn: string, hat: string): void {
    this.skin = skin;
    this.horn = horn;
    this.hat = hat;
    this.publishLobbyPresence();
  }

  setJoined(j: boolean): void {
    this.joined = j;
    if (!j) this.ready = false;
    this.publishLobbyPresence();
  }

  setReady(r: boolean): void {
    this.ready = r;
    this.publishLobbyPresence();
  }

  setCity(id: string): void {
    this.city = id;
    this.beaconTimer = 99; // re-announce now
  }

  setBots(b: boolean): void {
    this.bots = b;
    this.beaconTimer = 99;
  }

  /** Someone in the room chose public / friends-only (explicit: a person picked it just now). */
  setPublic(pub: boolean, explicit = true): void {
    this.pub = pub;
    this.pubAt = explicit ? Date.now() : 0;
    this.publishLobbyPresence();
  }

  /** Adopt the room's latest public / friends-only choice from any member. */
  private adoptPublic(): void {
    let best = this.pubAt;
    let pub = this.pub;
    const limit = Date.now() + 86_400_000;
    for (const p of this.net.peers()) {
      const at = p.presence.pa;
      if (p.isMe || typeof at !== 'number' || !Number.isFinite(at) || at <= best || at > limit) continue;
      best = at;
      pub = p.presence.pb === 1;
    }
    if (best === this.pubAt) return;
    this.pubAt = best;
    this.pub = pub;
    this.publishLobbyPresence();
  }

  /** The room as the site directory shows it. */
  roomPhase(): RoomPhase {
    const m = this.match;
    if (m.ph === 'lobby') return 'waiting';
    // A warm-up (even its results card) restarts as soon as someone joins.
    if (m.wu) return 'warmup';
    return m.ph === 'results' ? 'results' : 'playing';
  }

  /** Seconds until this round (or its results screen) ends, for the room browser; null outside a round. */
  roundLeft(): number | null {
    const m = this.match;
    const round = roundSecondsFor(m.city);
    if (m.ph === 'countdown') return round + A.countdownSeconds;
    if (m.ph === 'playing') return Math.max(0, (typeof m.hk === 'number' ? m.hk + HW.huntSeconds : round) - (m.t || 0));
    if (m.ph === 'results') return Math.max(0, A.resultsSeconds - this.resultsTimer);
    return null;
  }

  /** What this page is doing, for the site directory's counts. */
  hubState(): HubState {
    if (this.match.ph === 'lobby') return 'lobby';
    const me = this.net.selfId();
    return this.match.roster.some((r) => r.id === me && r.kind === 'player') ? 'play' : 'watch';
  }

  canStart(): boolean {
    const players = this.lobbyPlayers();
    if (!this.isHost() || this.match.ph !== 'lobby' || !players.length) return false;
    // Everyone but the host must be ready (a solo host can always start; alone in an online
    // room that start is a warm-up against the AI).
    return players.every((p) => p.isMe || p.ready) && (players.length > 1 || this.bots || this.warmupReady());
  }

  /** Host alone in a room friends can join: Start begins a warm-up vs AI instead of waiting idle. */
  warmupReady(): boolean {
    return this.net.kind !== 'solo' && this.lobbyPlayers().length === 1;
  }

  /** Host: leave the warm-up round (back to the lobby) at any time. */
  leaveWarmup(): void {
    if (this.match.wu) this.toLobby();
  }

  /** Host, from the results card: same city, same joined players, new round (no ready check). */
  rematch(): void {
    if (!this.isHost() || this.match.ph !== 'results' || !this.lobbyPlayers().length) return;
    this.launch();
  }

  start(): void {
    if (!this.canStart()) return;
    this.launch();
  }

  private launch(joined?: string): void {
    // Drop the finished round first: host duties must never run the new epoch on the old game.
    if (this.game) this.endGame();
    const players = this.lobbyPlayers();
    const warmup = this.warmupReady();
    const roster: RosterEntry[] = players.map((p, i) => ({ id: p.id, slot: i, kind: 'player', name: p.name, vehicle: p.vehicle, skin: p.skin, horn: p.horn, hat: p.hat }));
    if (this.bots || warmup) {
      const seedNames = [...BOT_NAMES];
      for (let slot = roster.length; slot < maxPlayersFor(this.city); slot++) {
        const name = seedNames.splice(Math.floor(Math.random() * seedNames.length), 1)[0];
        // Rivals show off a random shop skin and horn half of the time.
        const skin = Math.random() < 0.5 ? SKINS[1 + Math.floor(Math.random() * (SKINS.length - 1))].id : undefined;
        const horn = HORNS[Math.floor(Math.random() * HORNS.length)].id;
        const buyable = HATS.filter((h) => h.price > 0);
        const hat = Math.random() < 0.4 ? buyable[Math.floor(Math.random() * buyable.length)].id : undefined;
        roster.push({ id: `bot-${slot}`, slot, kind: 'bot', name, vehicle: VEHICLE_ORDER[(slot + 1) % VEHICLE_ORDER.length], skin, horn, hat });
      }
    }
    this.match = { ep: this.match.ep + 1, ph: 'countdown', host: this.net.selfId() ?? '', city: this.city, seed: Math.floor(Math.random() * 1e9), bots: this.bots, roster, t: 0, wu: warmup || undefined, wj: joined, hg: this.term(), sn: this.since };
    this.net.emit('match', this.match);
  }

  /** Host during a warm-up: a friend arrived → start a fresh real round with everyone here. */
  private endWarmupIfJoined(): boolean {
    const m = this.match;
    if (!m.wu || m.ph === 'lobby') return false;
    const inRound = new Set(m.roster.map((r) => r.id));
    const newcomers = this.lobbyPlayers().filter((p) => !inRound.has(p.id));
    if (!newcomers.length) return false;
    this.launch(newcomers.map((p) => p.name).join(L('、', ', ')));
    this.hooks.changed();
    return true;
  }

  /** Host: back to the lobby (from results, or to abort). */
  toLobby(): void {
    if (!this.isHost()) return;
    this.match = { ...this.match, ep: this.match.ep + 1, ph: 'lobby', roster: [], t: 0, standings: undefined, city: this.city, bots: this.bots, wu: undefined, wj: undefined, ev: undefined, mc: undefined, hk: undefined, hs: undefined, hc: undefined };
    this.net.emit('match', this.match);
  }

  private publishLobbyPresence(): void {
    this.net.setPresence({ nk: this.nickname, j: this.joined, v: this.vehicle, k: this.skin, hn: this.horn, ht: this.hat, r: this.ready, pb: this.pub ? 1 : 0, pa: this.pubAt });
  }

  // ── Per-frame driver ──────────────────────────────────────────────────────
  /** My term as host: the server's lease term, else one above the term I last followed. */
  private term(): number {
    const lease = this.net.lease?.();
    const me = this.net.selfId();
    if (lease && lease.peer === me) return lease.term;
    return this.match.host === me ? (this.match.hg ?? 0) : (this.match.hg ?? 0) + (this.match.host ? 1 : 0);
  }

  update(dt: number): void {
    const me = this.net.selfId();
    // The client election picks this page and the lease holder (if any) has left: claim the server
    // lease (granted only when it is free or expired).
    // A page that just arrived first listens for the room's host (hostGraceMs).
    const lease = this.net.lease?.();
    const holderHere = !!lease && this.net.peers().some((p) => p.id === lease.peer);
    const settled = this.heardHost || performance.now() - this.bornAt >= A.hostGraceMs;
    this.net.wantHost?.(!!me && settled && this.electLocal() === me && (!lease || lease.peer === me || !holderHere));
    const host = this.isHost();
    const g = this.game;
    if (host !== this.wasHost) {
      this.wasHost = host;
      if (host && me && this.match.host !== me) {
        // Taking over (the old host left, or the server moved the lease): a higher term, the room's
        // settings as last announced (city / bots mirror the beacon), and an announcement right now.
        this.match = { ...this.match, host: me, hg: this.term(), sn: this.since };
        this.beaconTimer = A.matchBeaconMs;
      }
      g?.refreshOwnership();
      if (host && g) for (const [id, actor] of g.grants) this.granted.set(id, actor);
    }
    if (g) {
      // Publish my machine (and the AI rivals when hosting).
      const presence: Record<string, unknown> = { ep: this.match.ep };
      if (g.local) presence.s = g.wireState(g.local);
      if (host) {
        // AI rivals as [slot, ...state] rows: presence keys stay plain identifiers.
        const b: number[][] = [];
        for (const a of g.actors) if (a.kind === 'bot') b.push([a.slot, ...g.wireState(a)]);
        presence.b = b;
        presence.hu = g.hunt && g.hunt.stage() !== 'grow' ? g.hunt.wire((id) => this.slotOf(id)) : null;
      } else {
        presence.b = null;
        presence.hu = null;
      }
      // ~20 Hz and only when something changed (the room coalesces at ~30 Hz anyway).
      this.presenceTimer += dt * 1000;
      if (this.presenceTimer >= 50) {
        this.presenceTimer = 0;
        const sig = JSON.stringify(presence);
        if (sig !== this.lastPresence) {
          this.lastPresence = sig;
          this.net.setPresence(presence);
        }
      }
      // Players whose page is gone drop out of the round.
      if (this.match.ph === 'playing') {
        const present = new Set(this.net.peers().map((p) => p.id));
        for (const r of this.match.roster) if (r.kind === 'player' && !present.has(r.id)) g.markLeft(r.id);
      }
      // Mirror everyone else.
      for (const p of this.net.peers()) {
        if (p.isMe || p.presence.ep !== this.match.ep) continue;
        if (Array.isArray(p.presence.s)) g.applyWire(p.id, p.presence.s as WireState);
        if (p.id === this.hostId() && g.hunt && !host) g.hunt.applyWire(p.presence.hu);
        if (p.id === this.hostId() && Array.isArray(p.presence.b)) {
          for (const row of p.presence.b as unknown[]) {
            if (!Array.isArray(row)) continue;
            const id = this.idOf(row[0]);
            if (id?.startsWith('bot-')) g.applyWire(id, row.slice(1) as WireState);
          }
        }
      }
      // Proposals → host, batched.
      this.claimTimer += dt * 1000;
      if (this.claimTimer >= A.grantBatchMs) {
        this.claimTimer = 0;
        if (g.outbox.claims.length) this.net.emit('claim', { ep: this.match.ep, c: g.outbox.claims.splice(0, 60).map(([o, a]) => [o, this.slotOf(a)]) });
        if (g.outbox.eats.length) this.net.emit('eat', { ep: this.match.ep, e: g.outbox.eats.splice(0, 8).map(([v, a]) => [this.slotOf(v), this.slotOf(a)]) });
      }
    }
    if (!host) return;

    // ── Host duties ──
    this.grantTimer += dt * 1000;
    if (this.grantTimer >= A.grantBatchMs && this.grantQueue.length) {
      this.grantTimer = 0;
      this.net.emit('grant', { ep: this.match.ep, g: this.grantQueue.splice(0, 80).map(([o, a]) => [o, this.slotOf(a)]) });
    }
    if (this.match.wu) {
      this.admitTimer += dt;
      if (this.admitTimer >= 0.5) {
        this.admitTimer = 0;
        if (this.endWarmupIfJoined()) return;
      }
    }
    const m = this.match;
    if (m.ph === 'playing' && g) {
      this.refillTimer += dt;
      if (this.refillTimer >= A.refillCheckSeconds) {
        this.refillTimer = 0;
        const ids = g.refillCandidates(A.refillPerCheck);
        if (ids.length) {
          for (const id of ids) {
            this.granted.delete(id);
            g.revive(id);
          }
          this.net.emit('grant', { ep: m.ep, g: [], r: ids });
        }
      }
    }
    if ((m.ph === 'countdown' || m.ph === 'playing') && g && !m.wu) {
      this.admitTimer += dt;
      if (this.admitTimer >= 1) {
        this.admitTimer = 0;
        this.admitLateJoiners(g);
      }
    }
    if (m.ph === 'countdown' && g) {
      if (g.countdown <= 0) this.setPhase('playing');
    } else if (m.ph === 'playing' && g && g.hunt) {
      m.t = g.matchTime;
      this.hostHunt(g, g.hunt);
    } else if (m.ph === 'playing' && g) {
      m.t = g.matchTime;
      const humans = g.actors.filter((a) => a.kind !== 'bot');
      const alive = g.actors.filter((a) => !a.eliminated);
      const timeUp = g.matchTime >= A.roundSeconds;
      const lastStanding = g.actors.length > 1 && alive.length <= 1;
      const humansOut = humans.length > 0 && humans.every((a) => a.eliminated) && g.actors.length > humans.length;
      const landmark = g.climaxLeft() === 0;
      if (timeUp || lastStanding || landmark || humansOut) {
        m.standings = g.standings();
        this.setPhase('results');
        this.resultsTimer = 0;
      }
    } else if (m.ph === 'results') {
      this.resultsTimer += dt;
      if (this.resultsTimer >= A.resultsSeconds) this.toLobby();
    }
    this.beaconTimer += dt * 1000;
    if (this.beaconTimer >= A.matchBeaconMs) {
      this.beaconTimer = 0;
      if (m.ph === 'lobby') {
        m.city = this.city;
        m.bots = this.bots;
      }
      m.host = this.net.selfId() ?? m.host;
      m.hg = this.term();
      m.sn = this.since;
      const playing = m.ph === 'playing' && g;
      m.abs = playing ? g.absorbedBits() : undefined;
      // Recent eats ride along for a few seconds: a page that lost the 'eaten' message applies it now.
      const now = g?.matchTime ?? 0;
      this.recentEaten = this.recentEaten.filter((e) => e.at > now - A.eatenReplaySeconds);
      m.ev = playing && this.recentEaten.length ? this.recentEaten.map((e) => e.row) : undefined;
      m.mc = playing ? g.ledger.toWire((id) => this.slotOf(id)) : undefined;
      this.net.emit('match', m);
    }
  }

  /**
   * Host, Halloween map: start the hunt at halftime (or as soon as the first half empties out),
   * stamp the locked scores, decide catches, end the round when time is up or nobody is left.
   */
  private hostHunt(g: ArenaGame, h: NonNullable<ArenaGame['hunt']>): void {
    const m = this.match;
    const humans = g.actors.filter((a) => a.kind !== 'bot');
    if (typeof m.hk !== 'number') {
      const alive = g.actors.filter((a) => !a.eliminated);
      const emptied = (g.actors.length > 1 && alive.length <= 1) || (humans.length > 0 && humans.every((a) => a.eliminated));
      if (g.matchTime >= HW.huntAt || emptied) {
        const hk = Math.round(g.matchTime * 100) / 100;
        const scores = new Map<string, number>();
        for (const a of g.actors) scores.set(a.id, a.left ? 0 : Math.round(a.mass));
        h.setStart(hk, scores);
        // In place: the beacon later this frame sends this same object.
        m.hk = hk;
        m.hs = [...scores].map(([id, kg]) => [this.slotOf(id), kg]);
        m.t = g.matchTime;
        this.net.emit('match', m);
      }
      return;
    }
    const caught = h.detectCatches();
    if (caught.length) {
      const hc = [...(m.hc ?? [])];
      for (const c of caught) {
        const at = Math.round(g.matchTime * 100) / 100;
        if (h.applyCaught(c.id, at, c.by)) hc.push([this.slotOf(c.id), at, c.by]);
      }
      m.hc = hc;
      m.t = g.matchTime;
      this.net.emit('match', m);
    }
    const runners = g.actors.filter((a) => !a.left && !h.caught.has(a.id));
    const humansOut = humans.length > 0 && humans.every((a) => a.left || h.caught.has(a.id));
    if (g.matchTime >= h.endsAt() || !runners.length || (humansOut && h.stage() === 'chase')) {
      m.standings = g.standings();
      this.setPhase('results');
      this.resultsTimer = 0;
    }
  }

  private setPhase(ph: MatchPhase): void {
    this.match = { ...this.match, ph, t: this.game?.matchTime ?? 0 };
    this.net.emit('match', this.match);
  }

  // ── Message handlers ──────────────────────────────────────────────────────
  private onMatch(from: string, m: MatchState): void {
    if (!m || typeof m !== 'object' || typeof m.ep !== 'number') return;
    const me = this.net.selfId();
    // Only the host speaks for the match. With a server lease, only its holder (whose messages the
    // transport has verified); without one, the current host or a claim that outranks it.
    let newTerm = false;
    if (from !== me) {
      if (this.net.lease?.()) {
        if (from !== this.hostId()) return;
      } else if (from !== this.hostId() && !this.outranks(from, m) && m.ep <= this.match.ep) return;
      newTerm = (m.hg ?? 0) > (this.match.hg ?? 0);
      this.heardHost = true;
    }
    // A new host (higher term) may continue from an older epoch than a stale host had reached.
    if (m.ep < this.match.ep && !newTerm) return;
    const newEpoch = m.ep !== this.match.ep;
    const prev = this.match;
    this.match = { ...m, roster: Array.isArray(m.roster) ? m.roster.slice(0, MAX_SEATS) : [] };
    if (!cityById(this.match.city)) this.match.city = CITIES[0].id;
    if (!this.isHost()) {
      this.city = this.match.city;
      this.bots = !!this.match.bots;
    }
    if (m.ph === 'lobby') {
      if (this.game) this.endGame();
      // Ready resets only when the room (re)enters the lobby: the host repeats the lobby beacon
      // every second, and clearing on each one meant the host could never start.
      if (newEpoch || prev.ph !== 'lobby') {
        this.ready = false;
        this.publishLobbyPresence();
      }
    } else if (newEpoch || !this.game) {
      if (this.game) this.endGame();
      this.granted.clear();
      this.grantQueue.length = 0;
      this.lastEaten.clear();
      this.recentEaten = [];
      this.seenEaten.clear();
      // Joining a round in progress: eats that already happened are part of the state we receive,
      // not news (replaying them could pay a machine twice).
      if (Array.isArray(m.ev)) for (const row of m.ev) if (Array.isArray(row) && typeof row[0] === 'number') this.seenEaten.add(row[0]);
      this.firstBlood = false;
      const me = this.net.selfId();
      const inRoster = this.match.roster.some((r) => r.id === me);
      this.game = this.hooks.startGame(this.match, inRoster ? me : null);
    }
    const g = this.game;
    if (g && m.ph !== 'lobby' && !newEpoch) {
      // Drop-ins: rebuild any slot whose roster entry changed (a new player or a returning one).
      const me = this.net.selfId();
      for (const r of this.match.roster) {
        const a = g.byId.get(r.id);
        if (!a || a.gen !== (r.g ?? 0)) {
          g.swapIn(r, r.id === me ? me : null);
          if (r.id === me) this.net.setPresence({ aw: null });
          this.hooks.changed();
        }
      }
    }
    if (g && m.ph !== 'lobby') {
      if (m.ph === 'playing' && g.phase === 'countdown') g.phase = 'playing';
      if (m.ph === 'results') g.phase = 'results';
      if (m.ph === 'playing' && !this.isHost() && Math.abs(g.matchTime - m.t) > 0.35) g.matchTime = m.t;
      if (m.ph === 'playing' && from !== me && typeof m.abs === 'string' && m.abs.length < 8000) g.syncAbsorbed(m.abs);
      if (g.hunt && m.ph !== 'countdown' && from !== me) this.applyHunt(g.hunt, m);
      if (m.ph === 'playing' && from !== me) {
        g.ledger.fromWire(m.mc, (slot) => this.idOf(slot));
        if (Array.isArray(m.ev)) for (const row of m.ev.slice(0, 32)) if (Array.isArray(row)) this.applyEatenRow(row);
      }
    }
    if (prev.ph !== this.match.ph || newEpoch) this.hooks.changed();
  }

  /** The host's hunt state (start, locked scores, catches) applied on this page. */
  private applyHunt(h: NonNullable<ArenaGame['hunt']>, m: MatchState): void {
    if (typeof m.hk !== 'number' || !Number.isFinite(m.hk)) return;
    const scores = new Map<string, number>();
    for (const row of Array.isArray(m.hs) ? m.hs.slice(0, MAX_SEATS) : []) {
      const id = Array.isArray(row) ? this.idOf(row[0]) : null;
      if (id && typeof row[1] === 'number' && Number.isFinite(row[1])) scores.set(id, Math.max(0, row[1]));
    }
    h.setStart(m.hk, scores);
    for (const row of Array.isArray(m.hc) ? m.hc.slice(0, MAX_SEATS * 2) : []) {
      if (!Array.isArray(row) || typeof row[1] !== 'number') continue;
      const id = this.idOf(row[0]);
      if (id) h.applyCaught(id, row[1], typeof row[2] === 'number' ? row[2] : 0);
    }
  }

  /**
   * Host: players who arrive mid-round (an invite link) or come back after being away take a
   * slot now instead of waiting for the next round: a returning player gets their own machine
   * back, a newcomer takes over the smallest living AI rival (or a free / abandoned slot).
   */
  private admitLateJoiners(g: ArenaGame): void {
    const m = this.match;
    // Halloween: nobody drops in once the hunt is near (a newcomer would join with no score).
    const lastCall = isHalloween(m.city) ? HW.huntAt : A.roundSeconds;
    if (m.ph === 'playing' && (typeof m.hk === 'number' || g.matchTime > lastCall - A.dropInCutoffSeconds)) return;
    let changed = false;
    for (const p of this.lobbyPlayers()) {
      const cur = g.byId.get(p.id);
      const peer = this.net.peers().find((x) => x.id === p.id);
      const away = peer?.presence.aw === m.ep;
      if (cur && !cur.left && !away) continue;
      let slot = m.roster.find((r) => r.id === p.id)?.slot;
      if (slot === undefined) {
        const bot = g.actors.filter((a) => a.kind === 'bot' && !a.eliminated).sort((a, b) => a.mass - b.mass)[0];
        const present = new Set(this.net.peers().map((x) => x.id));
        const abandoned = m.roster.find((r) => r.kind === 'player' && !present.has(r.id));
        const used = new Set(m.roster.map((r) => r.slot));
        const free = Array.from({ length: maxPlayersFor(m.city) }, (_, i) => i).find((s) => !used.has(s));
        slot = bot?.slot ?? abandoned?.slot ?? free;
      }
      if (slot === undefined) continue; // full: they watch until the next round
      const prev = m.roster.find((r) => r.slot === slot);
      const entry: RosterEntry = { id: p.id, slot, kind: 'player', name: p.name, vehicle: p.vehicle, skin: p.skin, horn: p.horn, hat: p.hat, g: (prev?.g ?? 0) + 1 };
      m.roster = [...m.roster.filter((r) => r.slot !== slot), entry].sort((a, b) => a.slot - b.slot);
      g.swapIn(entry, null);
      const a = g.byId.get(p.id)!;
      entry.st = [+a.x.toFixed(2), +a.z.toFixed(2), +a.heading.toFixed(3), Math.round(a.mass * 10) / 10, a.lives];
      changed = true;
    }
    if (changed) {
      this.match = { ...m };
      this.net.emit('match', this.match);
      this.hooks.changed();
    }
  }

  /** Roster slot of a machine id (−1 if unknown) and back. */
  private slotOf(id: string): number {
    return this.match.roster.find((r) => r.id === id)?.slot ?? -1;
  }

  private idOf(slot: unknown): string | null {
    return typeof slot === 'number' ? (this.match.roster.find((r) => r.slot === slot)?.id ?? null) : null;
  }

  private onClaim(d: { ep: number; c: [number, number][] }): void {
    const g = this.game;
    if (!this.isHost() || !g || !d || d.ep !== this.match.ep || !Array.isArray(d.c)) return;
    for (const pair of d.c) {
      if (!Array.isArray(pair)) continue;
      const id = pair[0];
      const actor = this.idOf(pair[1]);
      if (typeof id !== 'number' || !actor) continue;
      const prior = this.granted.get(id);
      if (prior !== undefined) {
        // Asked again: the grant (or the redirect to whoever won it) was lost. Same answer again.
        if (!this.grantQueue.some(([o]) => o === id)) this.grantQueue.push([id, prior]);
        continue;
      }
      const o = g.world.objects[id];
      const a = g.byId.get(actor);
      if (!o || !a || !a.alive || o.state === 'absorbed') continue;
      if (!g.world.isEligible(o, a.power * 1.05) && o.owner !== actor) continue; // size check with a little slack for lag
      this.granted.set(id, actor);
      this.grantQueue.push([id, actor]);
    }
  }

  private onGrant(from: string, d: { ep: number; g: [number, number][]; r?: number[] }): void {
    const g = this.game;
    if (!g || !d || d.ep !== this.match.ep || !Array.isArray(d.g) || from !== this.hostId()) return;
    for (const pair of d.g) {
      if (!Array.isArray(pair)) continue;
      const actor = this.idOf(pair[1]);
      if (typeof pair[0] === 'number' && actor) g.applyGrant(pair[0], actor);
    }
    // Refills (the host already applied its own; revive ignores anything not absorbed).
    if (Array.isArray(d.r)) for (const id of d.r) if (typeof id === 'number') g.revive(id);
  }

  private onEat(d: { ep: number; e: [number, number][] }): void {
    const g = this.game;
    if (!this.isHost() || !g || !d || d.ep !== this.match.ep || !Array.isArray(d.e) || this.match.ph !== 'playing') return;
    for (const pair of d.e) {
      if (!Array.isArray(pair)) continue;
      const victim = this.idOf(pair[0]);
      const attacker = this.idOf(pair[1]);
      const v = victim ? g.byId.get(victim) : undefined;
      const a = attacker ? g.byId.get(attacker) : undefined;
      if (!v || !a || !victim) continue;
      if ((this.lastEaten.get(victim) ?? -99) > g.matchTime - (A.respawnDelay + 0.5)) continue;
      // Validate on the host's view with slack for latency.
      if (!g.canEat(a, v)) continue;
      if (Math.hypot(a.x - v.x, a.z - v.z) > (a.diameter / 2) * A.eatReach * 1.6 + v.diameter + 2) continue;
      this.lastEaten.set(victim, g.matchTime);
      const first = !this.firstBlood;
      this.firstBlood = true;
      const leader = g.actors.every((b) => b === v || !b.alive || b.mass <= v.mass);
      const gain = v.mass * A.eatGain * (first ? 1 + A.firstBloodBonus : 1) * (leader ? 1 + A.leaderBounty : 1);
      const eid = 1 + Math.floor(Math.random() * 0x7ffffffe);
      this.recentEaten.push({ id: eid, at: g.matchTime, row: [eid, v.slot, a.slot, Math.round(gain * 10) / 10, first ? 1 : 0] });
      this.net.emit('eaten', { ep: this.match.ep, id: eid, v: v.slot, a: a.slot, gain, first });
    }
  }

  private onEaten(from: string, d: { ep: number; id?: number; v: number; a: number; gain: number; first: boolean }): void {
    if (!this.game || !d || d.ep !== this.match.ep || from !== this.hostId()) return;
    this.applyEatenRow([typeof d.id === 'number' ? d.id : 0, d.v, d.a, d.gain, d.first ? 1 : 0]);
  }

  /** Apply one host-confirmed eat once (the 'eaten' message and the beacon both carry it). */
  private applyEatenRow(row: unknown[]): void {
    const g = this.game;
    const [id, vs, as, gain, first] = row;
    if (!g || typeof id !== 'number' || typeof gain !== 'number' || !Number.isFinite(gain)) return;
    if (id > 0) {
      if (this.seenEaten.has(id)) return;
      this.seenEaten.add(id);
    }
    const v = this.idOf(vs);
    const a = this.idOf(as);
    if (!v || !a) return;
    const e: EatenEvent = { v, a, gain: Math.max(0, gain), first: first === 1 || first === true };
    g.applyEaten(e);
  }

  private endGame(): void {
    this.hooks.endGame();
    this.game = null;
  }
}

/** Cosmetic ids from other peers: short identifiers only (resolved against the catalog). */
function shortId(v: unknown): string | undefined {
  return typeof v === 'string' && /^[a-z0-9_]{1,16}$/.test(v) ? v : undefined;
}

function asVehicle(v: unknown): VehicleLook {
  return typeof v === 'string' && (VEHICLE_ORDER as string[]).includes(v) ? (v as VehicleLook) : 'collector';
}
