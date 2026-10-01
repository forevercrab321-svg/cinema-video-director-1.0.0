// Supabase Edge Function: a player posts the final standings of a finished online match; the
// server records it and grants coins. Deploy: `supabase functions deploy submit-match`.
//
// All validation, clamping, de-duplication, rate limiting and the coin grant happen inside one
// Postgres function, public.submit_match (supabase/migrations/0005_security_hardening.sql), so the
// match row, its player rows and the coins are written in a single transaction or not at all.
// This function only authenticates the caller and passes its verified uid along:
//   · the caller is credited for its own row only (other rows are stored without an account id);
//   · one submission per (caller, room, match start); ≥ 120 s between submissions; ≤ 1500 coins
//     per 24 h; duration ≤ 330 s, kills ≤ 3 × opponents, mass ≤ 1e6 kg.
// Request body (unchanged, see game/src/arena/arenaMain.ts submitMatch):
//   {room, city, durationS, endReason, build, startedAt?, rows: [{slot, playerId, vehicle, rank,
//    mass, kills, deaths, objects, leftEarly}]}
// Response: 200 {matchId, coins[, duplicate]} · 400 · 401 · 403 · 413 · 429 {retryAfter} · 500.
import { createClient } from 'npm:@supabase/supabase-js@2';

const MAX_BODY_BYTES = 8192;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function reply(status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', ...extra } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'method' });

  const auth = req.headers.get('Authorization') ?? '';
  if (!/^Bearer \S+$/.test(auth)) return reply(401, { error: 'unauthenticated' });
  const url = Deno.env.get('SUPABASE_URL')!;
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: who, error: authErr } = await asCaller.auth.getUser(auth.slice(7));
  const uid = who?.user?.id;
  if (authErr || !uid) return reply(401, { error: 'unauthenticated' });

  const text = await req.text().catch(() => '');
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return reply(413, { error: 'too_large' });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return reply(400, { error: 'bad_json' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { error: 'bad_body' });

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await admin.rpc('submit_match', { p_caller: uid, p_body: body });
  if (error || !data || typeof data !== 'object') {
    console.error('submit_match failed', error?.message ?? 'no result');
    return reply(500, { error: 'db' });
  }
  const res = data as { status?: number; retryAfter?: number } & Record<string, unknown>;
  const status = typeof res.status === 'number' ? res.status : 500;
  const { status: _s, ...out } = res;
  return reply(status, out, status === 429 && res.retryAfter ? { 'Retry-After': String(res.retryAfter) } : {});
});
