import { currentUser, supabase } from './supabase';

/**
 * Product telemetry: small named events batched to the `events` table every few seconds.
 * The event list is the funnel we need to decide what to build and where to publish:
 *   session_start → lobby_view → match_start → first_absorb → tier_up → eaten / ate →
 *   landmark_down → match_end → rematch | share_click | quit
 * No personal data is sent: player ids are anonymous auth ids; props carry game facts only.
 *
 * Server limits (supabase/migrations/0005_security_hardening.sql, BEFORE INSERT triggers): events
 * must reference the caller's own session, ≤ 500 per session, ≤ 120 per account per minute,
 * props ≤ 1 KB; ≤ 20 sessions per account per hour. Over-limit events are dropped server-side
 * without an error, so the client stays under the same limits instead of relying on that.
 */
type Props = Record<string, string | number | boolean | null>;

const SESSION_EVENT_BUDGET = 480; // server: 500 per session
const BATCH = 50; // one batch per 5 s ≤ 600/min, but see MINUTE_BUDGET
const MINUTE_BUDGET = 100; // server: 120 per account per minute

const queue: { name: string; props: Props; ts: string }[] = [];
let sessionId: string | null = null;
let playerId: string | null = null;
let started = false;
let flushing = false;
let sent = 0;
let minuteStart = 0;
let minuteSent = 0;
let sessionTries = 0;
let sessionRow: Record<string, unknown> | null = null;

/** Keep props small and flat (server cap 1 KB): short strings, finite numbers. */
function clean(props: Props): Props {
  const out: Props = {};
  let n = 0;
  for (const [k, v] of Object.entries(props)) {
    if (++n > 16) break;
    const key = k.slice(0, 32);
    if (typeof v === 'string') out[key] = v.slice(0, 64);
    else if (typeof v === 'number') out[key] = Number.isFinite(v) ? v : null;
    else out[key] = v;
  }
  return out;
}

export function track(name: string, props: Props = {}): void {
  if (!supabase()) return;
  if (sent + queue.length >= SESSION_EVENT_BUDGET) return;
  queue.push({ name, props: clean(props), ts: new Date().toISOString() });
  if (queue.length > 200) queue.splice(0, queue.length - 200);
}

/** Creates the sessions row; retried from flush() (at most 3 tries per page). */
async function openSession(): Promise<void> {
  const sb = supabase();
  if (!sb || !sessionRow || sessionId || sessionTries >= 3) return;
  sessionTries++;
  const { data, error } = await sb.from('sessions').insert(sessionRow).select('id').single();
  if (error) console.warn('[telemetry] session', error.code, error.message);
  sessionId = (data as { id?: string } | null)?.id ?? null;
}

export async function startTelemetry(nickname: string, platform: string): Promise<void> {
  const sb = supabase();
  if (!sb || started) return;
  started = true;
  const user = await currentUser(nickname);
  if (!user) return;
  playerId = user.id;
  const q = new URLSearchParams(location.search);
  const utm: Record<string, string> = {};
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']) if (q.get(k)) utm[k] = q.get(k)!.slice(0, 64);
  const device = matchMedia('(pointer: coarse)').matches ? (Math.min(innerWidth, innerHeight) > 700 ? 'tablet' : 'phone') : 'desktop';
  sessionRow = { player_id: playerId, platform, device, build: ((import.meta.env.VITE_BUILD_ID as string | undefined) ?? 'dev').slice(0, 32), referrer: document.referrer.slice(0, 200) || null, utm };
  await openSession();
  track('session_start', { device, platform });
  setInterval(() => void flush(), 5000);
  addEventListener('pagehide', () => {
    track('session_end', { seconds: Math.round(performance.now() / 1000) });
    void flush();
  });
}

async function flush(): Promise<void> {
  const sb = supabase();
  if (!sb || !playerId || flushing || !queue.length) return;
  flushing = true;
  // Events without a session are dropped by the server: (re)open it first, keep the queue.
  if (!sessionId) await openSession();
  const now = Date.now();
  if (now - minuteStart >= 60_000) {
    minuteStart = now;
    minuteSent = 0;
  }
  const room = Math.min(BATCH, MINUTE_BUDGET - minuteSent, SESSION_EVENT_BUDGET - sent);
  if (!sessionId || room <= 0) {
    flushing = false;
    return;
  }
  const batch = queue.splice(0, room);
  minuteSent += batch.length;
  sent += batch.length;
  const { error } = await sb.from('events').insert(batch.map((e) => ({ player_id: playerId, session_id: sessionId, name: e.name, props: e.props, ts: e.ts })));
  // Keep for the next try only on transient failures; a rejected row (constraint / permission,
  // Postgres codes 23xxx / 42xxx) would otherwise be re-sent every 5 s forever.
  if (error && !/^(23|42)/.test(error.code ?? '')) queue.unshift(...batch.slice(0, 50));
  else if (error) console.warn('[telemetry] dropped batch', error.code, error.message);
  flushing = false;
}
