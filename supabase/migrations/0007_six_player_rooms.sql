-- 0007 — six-player rooms and 10-minute rounds on the Halloween map (docs/halloween-mode.md).
--
-- Requires 0005 (submit_match, lobby_beat). Re-runnable: both functions are replaced whole, with
-- the same signatures, so the grants from 0005 stay in place. Changes against 0005, nothing else:
--   submit_match: city 'halloween' accepted; up to 6 rows and duration ≤ 630 s on that map only
--                 (other maps keep 4 rows / 330 s); slots 0..5; Halloween coins by rank
--                 [120, 80, 55, 35, 25, 15] (game/src/config/halloween.ts).
--   lobby_beat:   a Halloween room's summary may report up to 6 players / 6 seats (other maps: 4).

create or replace function public.submit_match(p_caller uuid, p_body jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  -- Limits (keep in sync with game/src/config/arena.ts and config/halloween.ts): 300 s rounds,
  -- 600 s on the Halloween map, + countdown/slack.
  c_max_duration constant numeric := 330;
  c_max_duration_halloween constant numeric := 630;
  c_min_reward_duration constant numeric := 30;
  c_max_mass constant double precision := 1000000;   -- ≈ 2× every object of every city combined
  c_max_deaths constant int := 10;
  c_max_objects constant int := 20000;
  c_gap constant interval := interval '120 seconds';
  c_daily_cap constant int := 1500;
  c_by_rank constant int[] := array[100, 60, 35, 20];  -- arenaConfig.coinsByRank
  c_by_rank_halloween constant int[] := array[120, 80, 55, 35, 25, 15];  -- HALLOWEEN.coinsByRank
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
  if v_city is null or v_city not in ('shanghai', 'newyork', 'paris', 'scrap', 'halloween') then
    return jsonb_build_object('status', 400, 'error', 'bad_city');
  end if;
  v_rows := p_body->'rows';
  if v_rows is null or jsonb_typeof(v_rows) <> 'array' then
    return jsonb_build_object('status', 400, 'error', 'bad_rows');
  end if;
  v_n := jsonb_array_length(v_rows);
  if v_n < 1 or v_n > (case when v_city = 'halloween' then 6 else 4 end) or exists (select 1 from jsonb_array_elements(v_rows) r where jsonb_typeof(r) <> 'object') then
    return jsonb_build_object('status', 400, 'error', 'bad_rows');
  end if;
  -- The caller must appear exactly once; a row may name the caller or nobody (bot / other human).
  if (select count(*) from jsonb_array_elements(v_rows) r where r->>'playerId' = p_caller::text) <> 1 then
    return jsonb_build_object('status', 403, 'error', 'not_in_match');
  end if;

  v_dur := case when jsonb_typeof(p_body->'durationS') = 'number'
                then least(case when v_city = 'halloween' then c_max_duration_halloween else c_max_duration end, greatest(0, (p_body->>'durationS')::numeric)) else 0 end;
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

  -- Slots: keep the client's when they are distinct and 0..5, else use the row order.
  select count(distinct (r->>'slot')) = v_n
     and bool_and(jsonb_typeof(r->'slot') = 'number' and (r->>'slot')::numeric in (0, 1, 2, 3, 4, 5))
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
    v_coins := case when v_n = 1 then 10 else coalesce(case when v_city = 'halloween' then c_by_rank_halloween[v_rank] else c_by_rank[v_rank] end, 10) end + v_kills * c_per_kill;
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
        v_players := case when jsonb_typeof(p_room->'players') = 'number' then least(case when v_city = 'halloween' then 6 else 4 end, greatest(0, round((p_room->>'players')::numeric)))::int else 0 end;
        v_max := case when jsonb_typeof(p_room->'max') = 'number' then least(case when v_city = 'halloween' then 6 else 4 end, greatest(1, round((p_room->>'max')::numeric)))::int else 4 end;
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
