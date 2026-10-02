// Runs the real supabase/functions/submit-match/index.ts under Node against the scratch database
// started by tools/sql-security-test.sh (PGHOST / PGPORT / PGUSER from the environment).
// supabase-js is replaced by a tiny mock: auth.getUser(token) treats the bearer token as the uid
// of an existing auth.users row; rpc() runs the SQL function as service_role through psql.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let failures = 0;
const ok = (cond, label) => {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}`);
  }
};

function sql(text, vars = {}) {
  const args = ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'];
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  return execFileSync('psql', args, { input: text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
const one = (text, vars) => sql(text, vars).split('\n').pop();

// ── Mock supabase-js ──────────────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'submit-match-'));
const mockPath = join(work, 'supabase-mock.mjs');
writeFileSync(
  mockPath,
  `export function createClient(_url, key) { return globalThis.__mockClient(key); }\n`,
);
globalThis.__mockClient = (key) => ({
  auth: {
    getUser: async (jwt) => {
      if (key !== 'anon-key') return { data: { user: null }, error: { message: 'wrong key' } };
      const uid = /^[0-9a-f-]{36}$/.test(jwt ?? '') ? jwt : null;
      const exists = uid && one(`select count(*) from auth.users where id = :'u'::uuid;`, { u: uid }) === '1';
      return exists ? { data: { user: { id: uid } }, error: null } : { data: { user: null }, error: { message: 'invalid JWT' } };
    },
  },
  rpc: async (fn, args) => {
    if (key !== 'service-key') return { data: null, error: { message: 'permission denied' } };
    if (fn !== 'submit_match') return { data: null, error: { message: 'unknown function' } };
    try {
      const out = one(`set role service_role;\nselect public.submit_match(:'c'::uuid, :'b'::jsonb);`, { c: args.p_caller, b: JSON.stringify(args.p_body) });
      return { data: JSON.parse(out), error: null };
    } catch (e) {
      return { data: null, error: { message: String(e.stderr || e.message) } };
    }
  },
});

let handler;
globalThis.Deno = {
  serve: (h) => (handler = h),
  env: { get: (k) => ({ SUPABASE_URL: 'http://db.test', SUPABASE_ANON_KEY: 'anon-key', SUPABASE_SERVICE_ROLE_KEY: 'service-key' })[k] },
};
const src = readFileSync(join(ROOT, 'supabase/functions/submit-match/index.ts'), 'utf8').replace(
  /['"]npm:@supabase\/supabase-js@2['"]/,
  JSON.stringify(pathToFileURL(mockPath).href),
);
const fnPath = join(work, 'submit-match.mts');
writeFileSync(fnPath, src);
await import(pathToFileURL(fnPath).href);
if (!handler) throw new Error('index.ts did not call Deno.serve');

async function call(uid, body, init = {}) {
  const headers = uid ? { Authorization: `Bearer ${uid}`, 'Content-Type': 'application/json' } : {};
  const res = await handler(new Request('http://fn.test/submit-match', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body), ...init }));
  let json = null;
  try {
    json = await res.clone().json();
  } catch {
    /* not json */
  }
  return { status: res.status, json, headers: res.headers };
}

// ── Accounts ──────────────────────────────────────────────────────────────────
const HOST = 'aaaaaaaa-0000-4000-8000-000000000001';
const FRIEND = 'aaaaaaaa-0000-4000-8000-000000000002';
const VICTIM = 'aaaaaaaa-0000-4000-8000-000000000003';
const CHEAT = 'aaaaaaaa-0000-4000-8000-000000000004';
const CAPPER = 'aaaaaaaa-0000-4000-8000-000000000005';
const SPOOKY = 'aaaaaaaa-0000-4000-8000-000000000006';
sql(`insert into auth.users (id) values ('${HOST}'), ('${FRIEND}'), ('${VICTIM}'), ('${CHEAT}'), ('${CAPPER}'), ('${SPOOKY}');
update public.players set display_name = 'Hosty' where id = '${HOST}';
update public.players set display_name = 'Cheaty' where id = '${CHEAT}';`);
const coins = (id) => Number(one(`select coins from public.players where id = '${id}';`));
const backdate = (id, s = 200) => sql(`update public.match_submissions set created_at = created_at - interval '${s} seconds' where player_id = '${id}';`);

// ── Transport ────────────────────────────────────────────────────────────────
{
  const pre = await handler(new Request('http://fn.test/submit-match', { method: 'OPTIONS' }));
  ok(pre.status === 200 && pre.headers.get('access-control-allow-origin') === '*', 'CORS preflight answered (browser functions.invoke)');
  ok((await call(null, {})).status === 401, 'no Authorization → 401');
  ok((await call('not-a-user', {})).status === 401, 'invalid token → 401');
  ok((await call(HOST, 'x'.repeat(9000))).status === 413, 'oversized body → 413');
  ok((await call(HOST, '{nope')).status === 400, 'malformed JSON → 400');
}

// ── Happy path: the body game/src/arena/arenaMain.ts sends today ──────────────
const room = 'ROOM42';
const happy = {
  room,
  city: 'paris',
  durationS: 300.4,
  // arenaMain.ts does not send startedAt today; the server then keys the match on
  // now − duration rounded to the minute. Sent here so the retry check is deterministic.
  startedAt: new Date(Date.now() - 305_000).toISOString(),
  endReason: 'time',
  build: 'dev',
  rows: [
    { slot: 0, playerId: HOST, vehicle: 'collector', rank: 1, mass: 5400.5, kills: 2, deaths: 1, objects: 310, leftEarly: false },
    { slot: 1, playerId: FRIEND, vehicle: 'roller', rank: 2, mass: 3100, kills: 1, deaths: 2, objects: 240, leftEarly: false },
    { slot: 2, playerId: null, vehicle: 'digger', rank: 3, mass: 900, kills: 0, deaths: 3, objects: 120, leftEarly: false },
  ],
};
{
  const before = { host: coins(HOST), friend: coins(FRIEND) };
  const r = await call(HOST, happy);
  ok(r.status === 200 && r.json?.coins === 130 && typeof r.json?.matchId === 'string', `happy path → 200, 130 coins (rank 1 + 2 kills) [got ${r.status} ${JSON.stringify(r.json)}]`);
  ok(coins(HOST) === before.host + 130, 'happy path: caller credited');
  ok(coins(FRIEND) === before.friend, 'C1 other humans in the body are never credited by the caller');
  const mp = sql(`select coalesce(player_id::text, '-') || ',' || is_bot || ',' || mass_kg from public.match_players where match_id = '${r.json.matchId}' order by slot;`).split('\n');
  ok(mp[0] === `${HOST},false,5400.5` && mp[1] === '-,false,3100' && mp[2] === '-,true,900', `rows stored, only the caller's attributed [${mp.join(' | ')}]`);
  const lb = one(`set role anon;\nselect best_mass_kg from public.weekly_leaderboard where display_name = 'Hosty' and city = 'paris';`);
  ok(lb === '5400.5', `leaderboard shows the caller's clamped result to anon [${lb}]`);

  const again = await call(HOST, happy);
  ok(again.status === 200 && again.json?.duplicate === true && again.json?.coins === 0 && coins(HOST) === before.host + 130, 'retry of the same match → idempotent, no coins');
  const replay = await call(HOST, { ...happy, startedAt: new Date(Date.now() - 200_000).toISOString() });
  ok(replay.status === 429 && Number(replay.headers.get('retry-after')) > 0, `new submission within 120 s → 429 [${replay.status}]`);
}

// ── C1: the audit's exploit (100 forged 1-second "matches" crediting other ids) ──
{
  const forged = {
    city: 'paris',
    durationS: 1,
    rows: [
      { slot: 0, playerId: CHEAT, vehicle: 'x', rank: 1, mass: 1e308, kills: 20, deaths: 0, objects: 0 },
      { slot: 0, playerId: FRIEND, vehicle: 'x', rank: 1, mass: 1, kills: 20, deaths: 0, objects: 0 },
      { slot: 0, playerId: VICTIM, vehicle: 'x', rank: 1, mass: 1, kills: 20, deaths: 0, objects: 0 },
    ],
  };
  const before = { cheat: coins(CHEAT), friend: coins(FRIEND), victim: coins(VICTIM) };
  const statuses = {};
  for (let i = 0; i < 100; i++) {
    const r = await call(CHEAT, forged);
    statuses[r.status] = (statuses[r.status] ?? 0) + 1;
  }
  ok(coins(CHEAT) === before.cheat && coins(FRIEND) === before.friend && coins(VICTIM) === before.victim,
    `C1 100 forged 1 s submissions mint 0 coins for anyone [HTTP ${JSON.stringify(statuses)}: 1 recorded, 99 idempotent repeats]`);
  ok(Number(one(`select count(*) from public.match_submissions where player_id = '${CHEAT}';`)) === 1, 'C1 only one of 100 rapid submissions is recorded');
  const stored = one(`select max(mass_kg) || ',' || max(kills) || ',' || count(distinct slot) from public.match_players mp join public.match_submissions s on s.match_id = mp.match_id where s.player_id = '${CHEAT}';`);
  ok(stored === '1000000,6,3', `C1 mass ≤ 1e6, kills ≤ 3 × opponents, distinct slots [${stored}]`);
  ok(Number(one(`select count(*) from public.match_players where player_id in ('${VICTIM}', '${FRIEND}');`)) === 0, 'C1 no result is ever stored on another account');

  backdate(CHEAT);
  const r = await call(CHEAT, { ...forged, durationS: 9999 });
  ok(r.status === 200 && r.json?.coins === 190, `C1 full-length forged match pays at most rank 1 + 6 kills = 190 [${JSON.stringify(r.json)}]`);
  ok(Number(one(`select max(duration_s) from public.matches m join public.match_submissions s on s.match_id = m.id where s.player_id = '${CHEAT}';`)) === 330, 'C1 duration clamped to 330 s');

  ok((await call(CHEAT, { ...forged, rows: forged.rows.slice(1) })).status === 403, 'C1 caller not in the rows → 403');
  ok((await call(CHEAT, { ...forged, rows: [forged.rows[0], forged.rows[0]] })).status === 403, 'C1 caller listed twice → 403');
  ok((await call(CHEAT, { ...forged, city: 'atlantis' })).status === 400, 'unknown city → 400');
  ok((await call(CHEAT, { ...forged, rows: [...forged.rows, ...forged.rows] })).status === 400, 'more than 4 rows → 400');
}

// ── 0007: Halloween Town — 6 rows, 10-minute rounds, its own coin table; other maps unchanged ──
{
  const six = {
    room: 'BOO66',
    city: 'halloween',
    durationS: 600.2,
    startedAt: new Date(Date.now() - 610_000).toISOString(),
    endReason: 'time',
    build: 'dev',
    rows: [0, 1, 2, 3, 4, 5].map((slot) => ({ slot, playerId: slot === 5 ? SPOOKY : null, vehicle: 'collector', rank: slot === 5 ? 1 : slot + 2, mass: 1000 * (6 - slot), kills: slot === 5 ? 1 : 0, deaths: 0, objects: 10 })),
  };
  const before = coins(SPOOKY);
  const r = await call(SPOOKY, six);
  ok(r.status === 200 && r.json?.coins === 135, `halloween: 6 rows accepted, rank 1 pays 120 + 1 kill [${r.status} ${JSON.stringify(r.json)}]`);
  ok(coins(SPOOKY) === before + 135, 'halloween: caller credited');
  const st = one(`select m.duration_s || ',' || count(mp.*) || ',' || max(mp.slot) from public.matches m join public.match_players mp on mp.match_id = m.id where m.id = '${r.json?.matchId}' group by m.duration_s;`);
  ok(st === '600.2,6,5', `halloween: 600 s round and slots 0..5 stored [${st}]`);
  backdate(SPOOKY);
  const long = await call(SPOOKY, { ...six, room: 'BOO67', durationS: 9999, startedAt: undefined });
  ok(long.status === 200 && Number(one(`select duration_s from public.matches where id = '${long.json?.matchId}';`)) === 630, 'halloween: duration clamped to 630 s');
  backdate(SPOOKY);
  ok((await call(SPOOKY, { ...six, room: 'BOO68', rows: [...six.rows, { ...six.rows[0], slot: 6 }] })).status === 400, 'halloween: 7 rows → 400');
  ok((await call(SPOOKY, { ...six, room: 'BOO69', city: 'paris' })).status === 400, 'paris: still at most 4 rows (6 → 400)');
}

// ── Daily cap ────────────────────────────────────────────────────────────────
{
  let total = 0;
  for (let i = 0; i < 12; i++) {
    const body = { ...happy, room: `CAP${i}`, rows: [{ ...happy.rows[0], playerId: CAPPER, kills: 6 }, happy.rows[1], happy.rows[2]] };
    const r = await call(CAPPER, body);
    total += r.json?.coins ?? 0;
    backdate(CAPPER);
  }
  ok(total === 1500 && coins(CAPPER) === 1500, `daily coin cap 1500 holds [${total}]`);
}

// ── Atomicity: a failing match_players insert grants nothing and records nothing ──
{
  sql(`create function public._t_fail() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$;
create trigger _t_fail before insert on public.match_players for each row execute function public._t_fail();`);
  backdate(HOST);
  const before = { coins: coins(HOST), matches: one('select count(*) from public.matches;'), subs: one('select count(*) from public.match_submissions;') };
  const logError = console.error;
  console.error = () => {}; // the function logs the (expected) database error
  const r = await call(HOST, { ...happy, room: 'FAIL1' });
  console.error = logError;
  ok(r.status === 500, `match_players failure → 500 [${r.status}]`);
  ok(coins(HOST) === before.coins && one('select count(*) from public.matches;') === before.matches && one('select count(*) from public.match_submissions;') === before.subs,
    'C1 no coins, no match, no submission when match_players insert fails');
  sql('drop trigger _t_fail on public.match_players; drop function public._t_fail();');
}

rmSync(work, { recursive: true, force: true });
if (failures) {
  console.log(`\nsubmit-match: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('  submit-match: all checks passed');
