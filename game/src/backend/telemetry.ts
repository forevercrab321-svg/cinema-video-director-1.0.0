import { currentUser, supabase } from './supabase';

/**
 * Product telemetry: small named events batched to the `events` table every few seconds.
 * The event list is the funnel we need to decide what to build and where to publish:
 *   session_start → lobby_view → match_start → first_absorb → tier_up → eaten / ate →
 *   landmark_down → match_end → rematch | share_click | quit
 * No personal data is sent: player ids are anonymous auth ids; props carry game facts only.
 */
type Props = Record<string, string | number | boolean | null>;

const queue: { name: string; props: Props; ts: string }[] = [];
let sessionId: string | null = null;
let playerId: string | null = null;
let started = false;
let flushing = false;

export function track(name: string, props: Props = {}): void {
  if (!supabase()) return;
  queue.push({ name, props, ts: new Date().toISOString() });
  if (queue.length > 200) queue.splice(0, queue.length - 200);
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
  const { data } = await sb.from('sessions').insert({ player_id: playerId, platform, device, build: (import.meta.env.VITE_BUILD_ID as string | undefined) ?? 'dev', referrer: document.referrer.slice(0, 200) || null, utm }).select('id').single();
  sessionId = data?.id ?? null;
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
  const batch = queue.splice(0, 50);
  const { error } = await sb.from('events').insert(batch.map((e) => ({ player_id: playerId, session_id: sessionId, name: e.name, props: e.props, ts: e.ts })));
  // Keep for the next try only on transient failures; a rejected row (constraint / permission,
  // Postgres codes 23xxx / 42xxx) would otherwise be re-sent every 5 s forever.
  if (error && !/^(23|42)/.test(error.code ?? '')) queue.unshift(...batch.slice(0, 50));
  else if (error) console.warn('[telemetry] dropped batch', error.code, error.message);
  flushing = false;
}
