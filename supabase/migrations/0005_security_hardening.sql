-- 0005 — security hardening (audit 2026-09-30: C1, M1, M2, L1, L2).
-- Run AFTER 0004_lobby_presence.sql. Idempotent: running it twice is a no-op the second time.
-- Everything runs in one transaction; a failure leaves the database exactly as before.
--
--   C1  submit-match minted coins for any id, any number of times, with any mass/kills.
--       → public.submit_match(caller, body): one atomic, service-role-only function. The caller is
--         credited only for its own row, once per (caller, room, start), ≥ 120 s between
--         submissions, ≤ 1500 coins per 24 h, every number clamped to what a round allows.
--   M1  lobby_beat trusted whoever sent a beat: rows could be overwritten, any room's listing
--       hijacked or a private room published, and a flood of fresh ids locked everyone out.
--       → client_id rows are owned by the first uid that wrote them; a room summary is accepted
--         only from the room's host (first signed-in claimant, kept while it beats); ≤ 3 rows per
--         uid; anonymous (pre-sign-in) pages share a 2000-row budget inside the 5000 global cap.
--   M2  sessions / events had no limits. → BEFORE INSERT triggers: ≤ 20 sessions per uid per hour,
--       events only on the caller's own session, ≤ 500 per session, ≤ 120 per uid per minute,
--       props ≤ 1 KB, server-side timestamps. Over-limit events are dropped silently (no retries).
--   L1  players (coins, country, cosmetics…) readable by anyone. → own row only; public view
--       players_public (id, display_name, equipped) for everything else.
--   L2  equipped unbounded. → object ≤ 2 KB, keys skin/horn/hat/eyes, short id values.
--       (Cosmetic ownership is still client-side, so ownership is not checked here.)

begin;

do $$
begin
  if to_regclass('public.lobby_presence') is null then
    raise exception '0005 needs 0004_lobby_presence.sql: run 0004 first';
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- L1 / L2 — players
-- ════════════════════════════════════════════════════════════════════════════
drop policy if exists players_read on public.players;
drop policy if exists players_read_own on public.players;
create policy players_read_own on public.players for select using (id = auth.uid());

-- Clients may insert only id + display_name (the 0003 trigger normally creates the row anyway);
-- coins / unlocked_level / country / platform / cosmetics are server-owned.
revoke insert, update, delete, truncate, references, trigger on public.players from anon, authenticated;
revoke all on public.players from anon;
grant select on public.players to authenticated;
grant insert (id, display_name) on public.players to authenticated;
grant update (display_name, last_seen_at, equipped) on public.players to authenticated;

-- Public face of a player (leaderboards, future profile cards). Runs with the view owner's rights
-- (not security_invoker) on purpose: it is the only way to see another player's row, and it
-- exposes these three columns only.
create or replace view public.players_public as
  select id, display_name, equipped from public.players;
revoke all on public.players_public from public, anon, authenticated;
grant select on public.players_public to anon, authenticated;

create or replace function public.equipped_ok(e jsonb) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select e is not null
    and jsonb_typeof(e) = 'object'
    and pg_column_size(e) <= 2048
    and not exists (
      select 1 from jsonb_each(e) kv
      where kv.key not in ('skin', 'horn', 'hat', 'eyes')
         or jsonb_typeof(kv.value) <> 'string'
         or (kv.value #>> '{}') !~ '^[a-z0-9_-]{1,32}$'
    );
$$;

create or replace function public.players_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  -- Names: no control / bidi / zero-width characters, no markup brackets, whitespace collapsed.
  new.display_name := left(btrim(regexp_replace(regexp_replace(coalesce(new.display_name, ''),
    '[[:cntrl:]<>\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]', '', 'g'), '\s+', ' ', 'g')), 24);
  if new.display_name = '' then new.display_name := 'Player'; end if;
  if tg_op = 'INSERT' or new.equipped is distinct from old.equipped then
    if not public.equipped_ok(new.equipped) then
      raise exception 'equipped must be an object of {skin|horn|hat|eyes: id}, at most 2 KB'
        using errcode = '22023';
    end if;
  end if;
  if tg_op = 'UPDATE' and new.last_seen_at is distinct from old.last_seen_at then
    new.last_seen_at := least(new.last_seen_at, now());
  end if;
  return new;
end;
$$;
revoke all on function public.players_guard() from public, anon, authenticated;

-- Clean rows written before this migration so later legitimate updates are not blocked.
update public.players set equipped = '{}'::jsonb where not public.equipped_ok(equipped);

drop trigger if exists players_guard on public.players;
create trigger players_guard before insert or update on public.players
  for each row execute function public.players_guard();

-- ════════════════════════════════════════════════════════════════════════════
-- Defence in depth: server-written tables stay server-written
-- ════════════════════════════════════════════════════════════════════════════
revoke insert, update, delete, truncate, references, trigger on public.matches, public.match_players,
  public.products, public.purchases from anon, authenticated;
revoke all on public.lobby_presence from public, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- C1 — match results and coins
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.match_submissions (
  player_id   uuid not null references public.players (id) on delete cascade,
  room        text not null,
  started_at  timestamptz not null,
  match_id    uuid references public.matches (id) on delete set null,
  coins       integer not null default 0 check (coins >= 0),
  created_at  timestamptz not null default now(),
  primary key (player_id, room, started_at)
);
create index if not exists match_submissions_player_created_idx on public.match_submissions (player_id, created_at desc);
alter table public.match_submissions enable row level security;
revoke all on public.match_submissions from public, anon, authenticated;

-- p_body is what the host posts today (game/src/arena/arenaMain.ts submitMatch):
--   {room, city, durationS, endReason, build, startedAt?, rows: [{slot, playerId, vehicle, rank,
--    mass, kills, deaths, objects, leftEarly}]}
-- Returns {status: 200|400|403|429, ...}. Everything happens in one transaction: if any insert
-- fails, nothing is recorded and no coin is granted.
create or replace function public.submit_match(p_caller uuid, p_body jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  -- Limits (keep in sync with game/src/config/arena.ts: roundSeconds 300 + countdown/slack).
  c_max_duration constant numeric := 330;
  c_min_reward_duration constant numeric := 30;
  c_max_mass constant double precision := 1000000;   -- ≈ 2× every object of every city combined
  c_max_deaths constant int := 10;
  c_max_objects constant int := 20000;
  c_gap constant interval := interval '120 seconds';
  c_daily_cap constant int := 1500;
  c_by_rank constant int[] := array[100, 60, 35, 20];  -- arenaConfig.coinsByRank
  c_per_kill constant int := 15;                      -- arenaConfig.coinsPerKill
  v_rows jsonb;
  v_n int;
  v_city text;
  v_room text;
  v_dur numeric;
  v_started timestamptz;
  v_prev record;
  v_last timestamptz;
  v_match uuid;
  v_rank int;
  v_kills int;
  v_coins int := 0;
  v_today int;
  v_slots_ok boolean;
begin
  if p_caller is null or not exists (select 1 from players where id = p_caller) then
    return jsonb_build_object('status', 403, 'error', 'unknown_player');
  end if;
  -- Serialises concurrent submissions of one player (rate limit / daily cap races).
  perform 1 from players where id = p_caller for update;

  if p_body is null or jsonb_typeof(p_body) <> 'object' or pg_column_size(p_body) > 8192 then
    return jsonb_build_object('status', 400, 'error', 'bad_body');
  end if;
  v_city := p_body->>'city';
  if v_city is null or v_city not in ('shanghai', 'newyork', 'paris', 'scrap') then
    return jsonb_build_object('status', 400, 'error', 'bad_city');
  end if;
  v_rows := p_body->'rows';
  if v_rows is null or jsonb_typeof(v_rows) <> 'array' then
    return jsonb_build_object('status', 400, 'error', 'bad_rows');
  end if;
  v_n := jsonb_array_length(v_rows);
  if v_n < 1 or v_n > 4 or exists (select 1 from jsonb_array_elements(v_rows) r where jsonb_typeof(r) <> 'object') then
    return jsonb_build_object('status', 400, 'error', 'bad_rows');
  end if;
  -- The caller must appear exactly once; a row may name the caller or nobody (bot / other human).
  if (select count(*) from jsonb_array_elements(v_rows) r where r->>'playerId' = p_caller::text) <> 1 then
    return jsonb_build_object('status', 403, 'error', 'not_in_match');
  end if;

  v_dur := case when jsonb_typeof(p_body->'durationS') = 'number'
                then least(c_max_duration, greatest(0, (p_body->>'durationS')::numeric)) else 0 end;
  v_room := left(regexp_replace(coalesce(p_body->>'room', ''), '[^A-Za-z0-9_-]', '', 'g'), 64);
  if v_room = '' then v_room := '-'; end if;

  -- Match key: the client's start time if plausible, else now − duration rounded to the minute.
  begin
    v_started := date_trunc('second', (p_body->>'startedAt')::timestamptz);
  exception when others then
    v_started := null;
  end;
  if v_started is null or v_started > now() or v_started < now() - interval '15 minutes' then
    v_started := date_trunc('minute', now() - make_interval(secs => v_dur::double precision));
  end if;

  -- Same match again (client retry): idempotent, nothing new.
  select match_id, coins into v_prev from match_submissions
  where player_id = p_caller and room = v_room and started_at = v_started;
  if found then
    return jsonb_build_object('status', 200, 'matchId', v_prev.match_id, 'coins', 0, 'duplicate', true);
  end if;

  select max(created_at) into v_last from match_submissions where player_id = p_caller;
  if v_last is not null and v_last > now() - c_gap then
    return jsonb_build_object('status', 429, 'error', 'rate_limited',
      'retryAfter', ceil(extract(epoch from (v_last + c_gap - now()))));
  end if;

  -- Slots: keep the client's when they are distinct and 0..3, else use the row order.
  select count(distinct (r->>'slot')) = v_n
     and bool_and(jsonb_typeof(r->'slot') = 'number' and (r->>'slot')::numeric in (0, 1, 2, 3))
    into v_slots_ok
  from jsonb_array_elements(v_rows) r;

  insert into matches (room, city, started_at, ended_at, duration_s, end_reason, humans, bots, build)
  values (
    v_room, v_city, v_started, now(), v_dur,
    nullif(left(regexp_replace(coalesce(p_body->>'endReason', ''), '[^a-z_]', '', 'g'), 24), ''),
    (select count(*) from jsonb_array_elements(v_rows) r where coalesce(r->>'playerId', '') <> ''),
    (select count(*) from jsonb_array_elements(v_rows) r where coalesce(r->>'playerId', '') = ''),
    nullif(left(regexp_replace(coalesce(p_body->>'build', ''), '[^A-Za-z0-9._-]', '', 'g'), 32), '')
  )
  returning id into v_match;

  insert into match_players (match_id, slot, player_id, is_bot, vehicle, rank, mass_kg, kills, deaths, objects, left_early)
  select
    v_match,
    case when coalesce(v_slots_ok, false) then (r->>'slot')::numeric::int else (i - 1)::int end,
    -- Only the caller's own row is attributed; other humans are stored anonymously so a host can
    -- neither credit friends nor plant results on someone else's id.
    case when r->>'playerId' = p_caller::text then p_caller else null end,
    coalesce(r->>'playerId', '') = '',
    case when (r->>'vehicle') ~ '^[a-z0-9_-]{1,16}$' then r->>'vehicle' else 'collector' end,
    case when jsonb_typeof(r->'rank') = 'number' then least(v_n, greatest(1, round((r->>'rank')::numeric)))::int else v_n end,
    case when jsonb_typeof(r->'mass') = 'number' then least(c_max_mass, greatest(0, (r->>'mass')::numeric)::double precision) else 0 end,
    case when jsonb_typeof(r->'kills') = 'number' then least(3 * (v_n - 1), greatest(0, floor((r->>'kills')::numeric)))::int else 0 end,
    case when jsonb_typeof(r->'deaths') = 'number' then least(c_max_deaths, greatest(0, floor((r->>'deaths')::numeric)))::int else 0 end,
    case when jsonb_typeof(r->'objects') = 'number' then least(c_max_objects, greatest(0, floor((r->>'objects')::numeric)))::int else 0 end,
    coalesce(r->>'leftEarly', '') = 'true'
  from jsonb_array_elements(v_rows) with ordinality as t(r, i);

  -- Coins from the stored (clamped) row of the caller only.
  select rank, kills into v_rank, v_kills from match_players where match_id = v_match and player_id = p_caller;
  if v_dur >= c_min_reward_duration then
    v_coins := case when v_n = 1 then 10 else coalesce(c_by_rank[v_rank], 10) end + v_kills * c_per_kill;
    select coalesce(sum(coins), 0) into v_today from match_submissions
    where player_id = p_caller and created_at > now() - interval '24 hours';
    v_coins := greatest(0, least(v_coins, c_daily_cap - v_today));
  end if;

  insert into match_submissions (player_id, room, started_at, match_id, coins)
  values (p_caller, v_room, v_started, v_match, v_coins);
  if v_coins > 0 then
    update players set coins = coins + v_coins where id = p_caller;
  end if;
  return jsonb_build_object('status', 200, 'matchId', v_match, 'coins', v_coins);
end;
$$;
revoke all on function public.submit_match(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.submit_match(uuid, jsonb) to service_role;

-- The old per-row helper stays server-only (0001 already revoked it; restated for safety).
revoke all on function public.grant_coins(uuid, integer) from public, anon, authenticated;

-- Leaderboard: names through players_public (players is own-row only now), and legacy rows that
-- predate the clamps are ignored.
create or replace view public.weekly_leaderboard with (security_invoker = true) as
select m.city, p.display_name, max(mp.mass_kg) as best_mass_kg, count(*) as matches, sum(mp.kills) as kills
from public.match_players mp
join public.matches m on m.id = mp.match_id
join public.players_public p on p.id = mp.player_id
where not mp.is_bot
  and m.started_at > now() - interval '7 days'
  and mp.mass_kg <= 1000000
  and mp.kills <= 9
group by m.city, p.display_name;
grant select on public.weekly_leaderboard to anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- M2 — sessions and events
-- ════════════════════════════════════════════════════════════════════════════
alter table public.sessions add column if not exists event_count integer not null default 0;

create table if not exists public.telemetry_rate (
  player_id    uuid primary key references public.players (id) on delete cascade,
  window_start timestamptz not null,
  n            integer not null
);
alter table public.telemetry_rate enable row level security;
revoke all on public.telemetry_rate from public, anon, authenticated;

-- Clients only insert (and read their own sessions); no update / delete.
revoke update, delete, truncate, references, trigger on public.sessions, public.events from anon, authenticated;
revoke all on public.sessions, public.events from anon;

create or replace function public.sessions_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return new; end if;            -- service role / SQL editor: unchanged
  if new.player_id is distinct from v_uid then return new; end if;  -- RLS rejects it
  if (select count(*) from sessions where player_id = v_uid and started_at > now() - interval '1 hour') >= 20 then
    raise exception 'too many sessions' using errcode = 'P0001', hint = 'session_rate_limit';
  end if;
  new.started_at := now();
  new.ended_at := null;
  new.event_count := 0;
  new.platform := coalesce(nullif(left(regexp_replace(coalesce(new.platform, ''), '[^a-z0-9_-]', '', 'g'), 16), ''), 'web');
  new.device := case when new.device in ('desktop', 'phone', 'tablet') then new.device else null end;
  new.build := left(new.build, 32);
  new.referrer := left(new.referrer, 200);
  if new.utm is null or jsonb_typeof(new.utm) <> 'object' or pg_column_size(new.utm) > 512 then
    new.utm := '{}'::jsonb;
  end if;
  return new;
end;
$$;
revoke all on function public.sessions_guard() from public, anon, authenticated;
drop trigger if exists sessions_guard on public.sessions;
create trigger sessions_guard before insert on public.sessions
  for each row execute function public.sessions_guard();

-- Returning NULL drops just that event (the insert still succeeds), so an over-limit client is
-- not told to retry.
create or replace function public.events_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_n int;
begin
  if v_uid is null then return new; end if;
  if new.player_id is distinct from v_uid then return new; end if;  -- RLS rejects it
  if new.session_id is null or new.name is null or new.name !~ '^[a-z0-9_]{1,48}$' then return null; end if;

  insert into telemetry_rate as t (player_id, window_start, n)
  values (v_uid, date_trunc('minute', now()), 1)
  on conflict (player_id) do update
    set n = case when t.window_start = excluded.window_start then t.n + 1 else 1 end,
        window_start = excluded.window_start
  returning n into v_n;
  if v_n > 120 then return null; end if;

  -- The session must be the caller's, recent, and under its event budget.
  update sessions set event_count = event_count + 1
  where id = new.session_id and player_id = v_uid and event_count < 500 and started_at > now() - interval '12 hours';
  if not found then return null; end if;

  if new.ts is null or new.ts > now() or new.ts < now() - interval '1 hour' then new.ts := now(); end if;
  if new.props is null or jsonb_typeof(new.props) <> 'object' or pg_column_size(new.props) > 1024 then
    new.props := '{"_dropped":"props"}'::jsonb;
  end if;
  return new;
end;
$$;
revoke all on function public.events_guard() from public, anon, authenticated;
drop trigger if exists events_guard on public.events;
create trigger events_guard before insert on public.events
  for each row execute function public.events_guard();

-- ════════════════════════════════════════════════════════════════════════════
-- M1 — lobby presence
-- ════════════════════════════════════════════════════════════════════════════
-- Who hosts a room code: the first signed-in page that announced it, for as long as it keeps
-- beating (30 s). After that anyone (in practice the migrated host) can claim it.
create table if not exists public.lobby_rooms (
  room_code      text primary key check (room_code ~ '^[A-Z0-9]{4,8}$'),
  host_client_id text not null,
  host_uid       uuid not null,
  claimed_at     timestamptz not null default now(),
  seen_at        timestamptz not null default now()
);
create index if not exists lobby_rooms_seen_at_idx on public.lobby_rooms (seen_at);
create index if not exists lobby_presence_player_idx on public.lobby_presence (player_id, seen_at);
alter table public.lobby_rooms enable row level security;
revoke all on public.lobby_rooms from public, anon, authenticated;

-- Same signature as 0004 (game/src/net/Hub.ts calls it with p_client_id, p_where, p_room).
-- Anonymous (pre-sign-in) beats are still accepted, so the counter works from the first second,
-- but they are second-class: they never publish a room summary, cannot touch a row a uid owns,
-- and share a 2000-row budget. The client id itself is a per-tab random secret that no RPC ever
-- returns, which is what protects an unowned row until its page signs in and claims it.
create or replace function public.lobby_beat(p_client_id text, p_where text, p_room jsonb default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_global_cap constant int := 5000;
  c_anon_cap constant int := 2000;
  c_per_uid constant int := 3;
  v_uid uuid;
  v_owner uuid;
  v_last timestamptz;
  v_exists boolean;
  v_live int;
  v_live_anon int;
  v_code text;
  v_room jsonb := null;
  v_phase text;
  v_city text;
  v_name text;
  v_players int;
  v_max int;
  v_ends numeric;
  v_host boolean;
begin
  if p_client_id is null or p_client_id !~ '^h-[a-z0-9]{6,16}$' then return; end if;
  if p_where is null or p_where not in ('browser', 'room', 'solo') then return; end if;
  if p_room is not null and (jsonb_typeof(p_room) <> 'object' or pg_column_size(p_room) > 2000) then return; end if;

  begin
    v_uid := auth.uid();
  exception when others then
    v_uid := null;
  end;

  select player_id, seen_at into v_owner, v_last from lobby_presence where client_id = p_client_id for update;
  v_exists := found;
  -- A row belongs to the first uid that wrote it; anyone else (or an anonymous call) is ignored.
  if v_exists and v_owner is not null and v_owner is distinct from v_uid then return; end if;
  -- One beat per page per 4 s (clients send every 15 s, state changes ≥ 5 s apart).
  if v_exists and v_last > now() - interval '4 seconds' then return; end if;

  if not v_exists then
    -- Housekeeping first, bounded: rows are dead 30 s after their last beat.
    delete from lobby_presence
    where client_id in (select client_id from lobby_presence where seen_at < now() - interval '60 seconds' order by seen_at limit 100);
    if v_uid is not null then
      -- Keep at most c_per_uid pages per account: its oldest pages make room.
      delete from lobby_presence
      where client_id in (select client_id from lobby_presence where player_id = v_uid order by seen_at desc offset c_per_uid - 1);
    end if;
    select count(*), count(*) filter (where player_id is null) into v_live, v_live_anon
    from lobby_presence where seen_at > now() - interval '30 seconds';
    if v_live >= c_global_cap then return; end if;
    if v_uid is null and v_live_anon >= c_anon_cap then return; end if;
  end if;

  if p_where = 'room' and p_room is not null then
    v_code := upper(coalesce(p_room->>'code', ''));
    if v_code !~ '^[A-Z0-9]{4,8}$' then v_code := null; end if;
  end if;

  if v_code is not null and p_room->>'host' = 'true' and v_uid is not null then
    v_phase := p_room->>'phase';
    if v_phase in ('waiting', 'warmup', 'playing', 'results') then
      -- Claim or refresh the room: only when unclaimed, expired, or already ours.
      v_host := null;
      insert into lobby_rooms as r (room_code, host_client_id, host_uid, claimed_at, seen_at)
      values (v_code, p_client_id, v_uid, now(), now())
      on conflict (room_code) do update
        set host_client_id = excluded.host_client_id,
            host_uid = excluded.host_uid,
            claimed_at = case when r.host_client_id = excluded.host_client_id and r.host_uid = excluded.host_uid then r.claimed_at else now() end,
            seen_at = now()
        where r.seen_at < now() - interval '30 seconds'
           or (r.host_client_id = excluded.host_client_id and r.host_uid = excluded.host_uid)
      returning true into v_host;

      if v_host then
        v_city := coalesce(p_room->>'city', '');
        if v_city !~ '^[a-z0-9_-]{1,24}$' then v_city := ''; end if;
        -- Control / format characters out, whitespace collapsed, 16 characters max. The client
        -- still runs every name through its name filter before showing it.
        v_name := left(btrim(regexp_replace(regexp_replace(coalesce(p_room->>'name', ''), '[[:cntrl:]<>\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]', '', 'g'), '\s+', ' ', 'g')), 16);
        v_players := case when jsonb_typeof(p_room->'players') = 'number' then least(4, greatest(0, round((p_room->>'players')::numeric)))::int else 0 end;
        v_max := case when jsonb_typeof(p_room->'max') = 'number' then least(4, greatest(1, round((p_room->>'max')::numeric)))::int else 4 end;
        v_ends := case when jsonb_typeof(p_room->'ends_in') = 'number' and v_phase in ('playing', 'results') then least(900, greatest(0, round((p_room->>'ends_in')::numeric))) else null end;
        v_room := jsonb_build_object(
          'name', v_name,
          'city', v_city,
          'players', v_players,
          'max', v_max,
          'phase', v_phase,
          'public', coalesce(p_room->>'public', '') = 'true',
          'bots', coalesce(p_room->>'bots', '') = 'true',
          'ends_in', v_ends
        );
      end if;
    end if;
  end if;

  insert into lobby_presence as lp (client_id, player_id, seen_at, where_, room_code, room)
  values (p_client_id, v_uid, now(), p_where, v_code, v_room)
  on conflict (client_id) do update
    set seen_at = excluded.seen_at, where_ = excluded.where_, room_code = excluded.room_code, room = excluded.room,
        player_id = coalesce(lp.player_id, excluded.player_id);

  if random() < 0.02 then
    delete from lobby_rooms
    where room_code in (select room_code from lobby_rooms where seen_at < now() - interval '120 seconds' limit 200);
  end if;
end;
$$;

-- Same output as 0004; a room's summary now comes only from the row of its current host.
create or replace function public.lobby_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with live as (
    select client_id, where_, room_code, room, seen_at
    from lobby_presence
    where seen_at > now() - interval '30 seconds'
  ),
  hosts as (
    select distinct on (l.room_code) l.room_code, l.room, l.seen_at
    from live l
    join lobby_rooms r on r.room_code = l.room_code and r.host_client_id = l.client_id
    where l.where_ = 'room' and l.room is not null and r.seen_at > now() - interval '30 seconds'
    order by l.room_code, l.seen_at desc
  ),
  pub as (
    select room_code, room, seen_at,
      case
        when (room->>'players')::int >= (room->>'max')::int then 4
        when room->>'phase' = 'waiting' then 0
        when room->>'phase' = 'warmup' then 1
        when room->>'phase' = 'results' then 2
        else 3
      end as rank
    from hosts
    where room->>'public' = 'true'
  ),
  top as (
    select * from pub order by rank, (room->>'players')::int desc, room_code limit 50
  )
  select jsonb_build_object(
    'online', (select count(*) from live),
    'rooms', (select count(distinct room_code) from live where where_ = 'room' and room_code is not null),
    'public', (select count(*) from pub),
    'list', coalesce((
      select jsonb_agg(
        (room - 'public') || jsonb_build_object('code', room_code, 'age', round(extract(epoch from now() - seen_at)::numeric, 1))
        order by rank, (room->>'players')::int desc, room_code)
      from top
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.lobby_beat(text, text, jsonb) from public;
revoke all on function public.lobby_snapshot() from public;
grant execute on function public.lobby_beat(text, text, jsonb) to anon, authenticated;
grant execute on function public.lobby_snapshot() to anon, authenticated;

commit;
