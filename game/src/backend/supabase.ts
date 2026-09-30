import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';

/**
 * Optional online backend (Supabase). Configured at build time through
 *   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY   (see .env.example)
 * The anon key is a public client key by design: every table is protected by the row-level
 * security policies in supabase/migrations. Without these variables (e.g. the claude.ai
 * artifact build) the game runs exactly as before: no telemetry, no online rooms.
 */
const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

let client: SupabaseClient | null = null;
let rtClient: SupabaseClient | null = null;
let userPromise: Promise<User | null> | null = null;
/** Why the last sign-in failed (shown in the lobby's connection line and in window.__NET__). */
export let authError = '';
/**
 * Sign-in progress for window.__NET__: 'off' (no backend), 'pending', 'ok' (signed in, anonymous
 * or not), 'none' (finished without a user). An empty authError alone never meant "unused".
 */
export let authStatus: 'off' | 'pending' | 'ok' | 'none' = 'off';

export function backendConfigured(): boolean {
  return !!URL && !!KEY;
}

export function supabase(): SupabaseClient | null {
  if (!backendConfigured()) return null;
  // Realtime protocol 1.0.0 (JSON frames). The 2.0.0 default sends broadcasts as binary frames;
  // in the field presence synced but no broadcast (heartbeats, match state) ever arrived, so every
  // client dropped its peers after the heartbeat timeout and played alone.
  client ??= createClient(URL!, KEY!, { auth: { persistSession: true, autoRefreshToken: true }, realtime: { vsn: '1.0.0' } });
  return client;
}

/** Realtime socket heartbeat outcomes (window.__NET__): timeouts mean the socket was dropped. */
export const socketBeats = { sent: 0, ok: 0, timeout: 0, error: 0, lastLatency: 0 };

/**
 * Dedicated client for online rooms. It never signs in, so its realtime token stays the public
 * key for the life of the page. On the shared client, the anonymous sign-in landing a few seconds
 * after the room was joined swapped the channel's token mid-session, and the server closed the
 * channel (realtime-js does not resubscribe after a server close): both players fell back to
 * "1 online" about ten seconds in. Room membership never depends on sign-in: the account id
 * rides along in the room state once it lands.
 */

export function realtimeClient(): SupabaseClient | null {
  if (!backendConfigured()) return null;
  rtClient ??= createClient(URL!, KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'grow-rt' },
    realtime: {
      vsn: '1.0.0',
      heartbeatCallback: (status: string, latency?: number) => {
        if (status in socketBeats) (socketBeats as Record<string, number>)[status]++;
        if (typeof latency === 'number') socketBeats.lastLatency = Math.round(latency);
      },
    },
  });
  return rtClient;
}

/** The signed-in player (anonymous on first visit), with a players row ensured. */
export function currentUser(nickname = 'Player'): Promise<User | null> {
  const sb = supabase();
  if (!sb) return Promise.resolve(null);
  userPromise ??= (async () => {
    authStatus = 'pending';
    const { data } = await sb.auth.getSession();
    let user = data.session?.user ?? null;
    if (!user) {
      const res = await sb.auth.signInAnonymously();
      user = res.data.user;
      if (res.error) authError = res.error.message || String(res.error);
    }
    authStatus = user ? 'ok' : 'none';
    if (user) {
      // Never a plain upsert: ON CONFLICT DO UPDATE needs UPDATE rights on every written column
      // (incl. id), and players only grants display_name / last_seen_at / equipped → 403, no row,
      // and every sessions / events insert then failed its foreign key (409). Insert-if-missing,
      // then update the allowed columns. (A trigger on auth.users also creates the row, 0003.)
      const name = nickname.slice(0, 24) || 'Player';
      const ins = await sb.from('players').upsert({ id: user.id, display_name: name }, { onConflict: 'id', ignoreDuplicates: true });
      if (ins.error) console.warn('[backend] players insert', ins.error.code, ins.error.message);
      const upd = await sb.from('players').update({ display_name: name, last_seen_at: new Date().toISOString() }).eq('id', user.id);
      if (upd.error) console.warn('[backend] players update', upd.error.code, upd.error.message);
    }
    return user;
  })().catch((e: unknown) => {
    authError = e instanceof Error ? e.message : String(e);
    authStatus = 'none';
    return null;
  });
  return userPromise;
}
