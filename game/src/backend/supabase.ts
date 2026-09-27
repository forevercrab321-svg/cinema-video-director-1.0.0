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
let userPromise: Promise<User | null> | null = null;
/** Why the last sign-in failed (shown in the lobby's connection line and in window.__NET__). */
export let authError = '';

export function backendConfigured(): boolean {
  return !!URL && !!KEY;
}

export function supabase(): SupabaseClient | null {
  if (!backendConfigured()) return null;
  client ??= createClient(URL!, KEY!, { auth: { persistSession: true, autoRefreshToken: true } });
  return client;
}

/** The signed-in player (anonymous on first visit), with a players row ensured. */
export function currentUser(nickname = 'Player'): Promise<User | null> {
  const sb = supabase();
  if (!sb) return Promise.resolve(null);
  userPromise ??= (async () => {
    const { data } = await sb.auth.getSession();
    let user = data.session?.user ?? null;
    if (!user) {
      const res = await sb.auth.signInAnonymously();
      user = res.data.user;
      if (res.error) authError = res.error.message || String(res.error);
    }
    if (user) await sb.from('players').upsert({ id: user.id, display_name: nickname.slice(0, 24) || 'Player', last_seen_at: new Date().toISOString() }, { onConflict: 'id' });
    return user;
  })().catch((e: unknown) => {
    authError = e instanceof Error ? e.message : String(e);
    return null;
  });
  return userPromise;
}
