/**
 * Server-confirmed room host (supabase/migrations/0006_room_host.sql) and signed host messages.
 *
 * Every page in an online room asks the server who hosts it. The page that the client election
 * (ArenaSession) picks claims the lease. The server grants it only while it is free, expired or
 * already that page's, so everybody agrees on one host whatever their peer lists say: a host
 * that tabbed out for 3 s cannot come back as a second host, and a newcomer cannot take over.
 * The holder renews every 2 s while visible and releases the lease when hidden or closed;
 * otherwise it expires 6 s after the last renewal.
 *
 * The holder signs its authority messages (match / grant / eaten) with an ECDSA P-256 key. The
 * public half is stored with the lease, so a page that writes the host's id into `from` cannot
 * speak for it. A counter inside the signature stops replays.
 *
 * Without the RPC (no backend, 0006 not applied yet, network down), current() stays null and
 * the client election decides alone, as before.
 */
export const LEASE_TIMING = {
  /** Server-side lease length (0006 c_lease). */
  leaseMs: 6000,
  /** The holder renews this often while its page is visible. */
  renewMs: 2000,
  /** Everyone else asks this often. */
  pollMs: 3000,
  /** Never ask more often than this (a page that wants the lease retries at this pace). */
  minAskMs: 700,
  /** An RPC that has not answered after this long is given up. */
  timeoutMs: 5000,
} as const;

export type RpcFn = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;

export interface LeaseView {
  peer: string;
  term: number;
  /** Base64 raw public key of the holder, or null (its messages are not signed). */
  key: string | null;
}

/** A signed host message may arrive up to this many messages late (older ones are replays). */
const REPLAY_WINDOW = 256;

/** Topics only the host may send; signed when a lease with a key exists. */
export const HOST_TOPICS: ReadonlySet<string> = new Set(['match', 'grant', 'eaten']);

const subtle = (): SubtleCrypto | null => (globalThis.crypto?.subtle as SubtleCrypto | undefined) ?? null;
const enc = new TextEncoder();
const b64 = (buf: ArrayBuffer): string => {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
/** What a host signature covers: topic, sender, counter and the exact data. */
export const signedText = (topic: string, from: string, n: number, data: unknown): string => `${topic}|${from}|${n}|${JSON.stringify(data)}`;

export class HostLease {
  private view: LeaseView | null = null;
  private expiresAt = 0;
  private want = false;
  private busySince = 0;
  private lastAsk = 0;
  /** Bumped by release(): an answer to a request sent before it must not revive the lease locally. */
  private epoch = 0;
  private priv: CryptoKey | null = null;
  /** My public key (base64 raw), once generated; null without WebCrypto. */
  pub: string | null = null;
  /** False once the server says the RPC does not exist (0006 not applied): stop asking. */
  available = true;
  /** Last answer, for window.__NET__. */
  last = '';
  private readonly verifyKeys = new Map<string, Promise<CryptoKey | null>>();
  private sendN = 0;
  /**
   * Replay guard per signer key: the highest counter accepted and the counters accepted within
   * the window below it (messages may arrive slightly out of order; a repeat never counts).
   */
  private readonly seenN = new Map<string, { max: number; recent: Set<number> }>();

  constructor(
    private readonly room: string,
    private readonly self: string,
    private readonly rpc: RpcFn,
    private readonly changed: () => void,
    private readonly beacon?: (fn: string, args: Record<string, unknown>) => void,
  ) {
    void this.makeKey();
  }

  private async makeKey(): Promise<void> {
    const s = subtle();
    if (!s) return;
    try {
      const pair = (await s.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
      this.priv = pair.privateKey;
      this.pub = b64(await s.exportKey('raw', pair.publicKey));
    } catch (e) {
      console.warn('[host-lease] no signing key', e);
    }
  }

  /** The live lease (null when unknown, expired, or the server is not reachable). */
  current(now = Date.now()): LeaseView | null {
    return this.view && now < this.expiresAt ? this.view : null;
  }

  /** This page holds the live lease (with the key it registered). */
  holds(now = Date.now()): boolean {
    const v = this.current(now);
    return !!v && v.peer === this.self && v.key === this.pub;
  }

  /**
   * The client election wants this page to host (and the holder, if any, has left): claim as soon
   * as the lease is free. A holder the election no longer picks (it stepped out of the round or
   * stopped playing) hands the lease back at once.
   */
  setWant(w: boolean): void {
    if (this.want && !w && this.holds()) this.release(false);
    this.want = w;
  }

  /** Called every pump tick (~15 Hz). */
  tick(now: number, visible: boolean): void {
    if (!this.available) return;
    if (this.busySince && now - this.busySince < LEASE_TIMING.timeoutMs) return;
    const holder = this.holds(now);
    // Holder: renew. Wanting it (the holder left): retry at the minimum pace. Everyone else: poll.
    const due = holder ? LEASE_TIMING.renewMs : this.want && visible ? LEASE_TIMING.minAskMs : LEASE_TIMING.pollMs;
    if (now - this.lastAsk < due) return;
    // A hidden page never claims or renews: it has said goodbye and is not playing.
    void this.ask(visible && (holder || this.want) && (this.pub !== null || !subtle()), false);
  }

  /** A host message arrived from someone the lease does not name: maybe our view is stale. */
  nudge(now = Date.now()): void {
    if (this.available && !this.busySince && now - this.lastAsk >= LEASE_TIMING.minAskMs) void this.ask(false, false);
  }

  /** Give the lease up now (page hidden: a normal call; page closing: a keepalive beacon). */
  release(closing: boolean): void {
    if (!this.available || !this.holds()) return;
    const args = { p_room: this.room, p_peer: this.self, p_key: this.pub, p_claim: false, p_release: true };
    this.view = null;
    this.expiresAt = 0;
    this.epoch++;
    if (closing && this.beacon) this.beacon('room_host', args);
    else void this.ask(false, true);
    this.changed();
  }

  private async ask(claim: boolean, release: boolean): Promise<void> {
    const sentAt = Date.now();
    const epoch = this.epoch;
    this.lastAsk = sentAt;
    this.busySince = sentAt;
    try {
      const { data, error } = await this.rpc('room_host', { p_room: this.room, p_peer: this.self, p_key: claim || release ? this.pub : null, p_claim: claim, p_release: release });
      if (error) {
        const e = error as { code?: string; message?: string };
        this.last = `error ${e.code ?? ''} ${e.message ?? ''}`.trim();
        // PostgREST "function not found": 0006 is not applied; the client election decides alone.
        if (e.code === 'PGRST202' || e.code === '42883' || /room_host/.test(e.message ?? '')) this.available = false;
        return;
      }
      if (epoch !== this.epoch && !release) return;
      this.accept(data, sentAt);
    } catch (e) {
      this.last = `error ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      this.busySince = 0;
    }
  }

  private accept(data: unknown, sentAt: number): void {
    const d = data as { peer?: unknown; term?: unknown; key?: unknown; age?: unknown; error?: unknown } | null;
    if (!d || typeof d !== 'object' || d.error) {
      this.last = `bad answer ${JSON.stringify(data)?.slice(0, 80)}`;
      return;
    }
    const before = this.view ? `${this.view.peer}#${this.view.term}` : '';
    if (typeof d.peer === 'string' && typeof d.term === 'number') {
      const age = typeof d.age === 'number' && d.age >= 0 ? d.age : 0;
      this.view = { peer: d.peer, term: d.term, key: typeof d.key === 'string' ? d.key : null };
      // Measured from when we asked: never later than the server's own expiry.
      this.expiresAt = sentAt + LEASE_TIMING.leaseMs - age;
    } else {
      this.view = null;
      this.expiresAt = 0;
    }
    this.last = this.view ? `${this.view.peer}#${this.view.term}` : 'free';
    if (this.last !== before && (this.view || before)) this.changed();
  }

  // ── Signatures ────────────────────────────────────────────────────────────
  /** Sign a host message: resolves {n, sig}, or null when this page has no key. */
  async sign(topic: string, from: string, data: unknown): Promise<{ n: number; sig: string } | null> {
    const s = subtle();
    if (!s || !this.priv) return null;
    const n = ++this.sendN;
    const sig = await s.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.priv, enc.encode(signedText(topic, from, n, data)));
    return { n, sig: b64(sig) };
  }

  /** Check a host message against the lease key (and the replay counter). */
  async verify(key: string, topic: string, from: string, data: unknown, n: unknown, sig: unknown): Promise<boolean> {
    const s = subtle();
    if (!s || typeof n !== 'number' || !Number.isSafeInteger(n) || typeof sig !== 'string' || sig.length > 200) return false;
    const seen = this.seenN.get(key) ?? { max: 0, recent: new Set<number>() };
    if (n <= seen.max - REPLAY_WINDOW || seen.recent.has(n)) return false;
    let pk = this.verifyKeys.get(key);
    if (!pk) {
      pk = s.importKey('raw', unb64(key), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']).catch(() => null);
      this.verifyKeys.set(key, pk);
    }
    const k = await pk;
    if (!k) return false;
    let ok = false;
    try {
      ok = await s.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, unb64(sig), enc.encode(signedText(topic, from, n, data)));
    } catch {
      ok = false;
    }
    if (ok) {
      seen.recent.add(n);
      seen.max = Math.max(seen.max, n);
      if (seen.recent.size > 2 * REPLAY_WINDOW) for (const x of seen.recent) if (x <= seen.max - REPLAY_WINDOW) seen.recent.delete(x);
      this.seenN.set(key, seen);
    }
    return ok;
  }
}
