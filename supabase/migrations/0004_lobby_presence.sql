-- Room browser presence ("N online · M rooms" and the public room list), Postgres-backed.
-- Why: the first version broadcast a heartbeat from every page to every page on one Realtime
-- channel. Supabase counts every broadcast delivery, so that grew with N² (~40 open pages ≈ the
-- 500 msg/s Pro quota) and the quota disconnects would also have killed in-room play.
-- Now every page calls lobby_beat() every 15 s (plus on a state change, ≥ 5 s apart) and only
-- pages that show the counter / list call lobby_snapshot() (room browser every 5 s, room lobby
-- every 15 s): linear in the number of pages, no Realtime at all.
--
-- The table is private (RLS on, no grants): clients only reach it through the two security
-- definer functions below, which validate and clamp everything. Private room codes are stored
-- (to count rooms) but never returned.

create table if not exists public.lobby_presence (
  client_id text primary key check (client_id ~ '^h-[a-z0-9]{6,16}$'),
  player_id uuid null,
  seen_at timestamptz not null default now(),
  where_ text not null check (where_ in ('browser', 'room', 'solo')),
  room_code text null check (room_code is null or room_code ~ '^[A-Z0-9]{4,8}$'),
  -- Host rows only: {name, city, players, max, phase, public, bots, ends_in}
  room jsonb null check (room is null or (jsonb_typeof(room) = 'object' and pg_column_size(room) <= 600))
);

create index if not exists lobby_presence_seen_at_idx on public.lobby_presence (seen_at);

alter table public.lobby_presence enable row level security;
revoke all on public.lobby_presence from public, anon, authenticated;

-- ── lobby_beat ──────────────────────────────────────────────────────────────
-- p_where: 'browser' | 'room' | 'solo'
-- p_room:  null, or {code} for a room member, or {code, host: true, name, city, players, max,
--          phase, public, bots, ends_in} for the room's host.
create or replace function public.lobby_beat(p_client_id text, p_where text, p_room jsonb default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_last timestamptz;
  v_code text;
  v_room jsonb := null;
  v_phase text;
  v_city text;
  v_name text;
  v_players int;
  v_max int;
  v_ends numeric;
  v_uid uuid;
begin
  if p_client_id is null or p_client_id !~ '^h-[a-z0-9]{6,16}$' then return; end if;
  if p_where is null or p_where not in ('browser', 'room', 'solo') then return; end if;
  if p_room is not null and (jsonb_typeof(p_room) <> 'object' or pg_column_size(p_room) > 2000) then return; end if;

  -- One beat per page per 4 s (clients send every 15 s, state changes ≥ 5 s apart).
  select seen_at into v_last from lobby_presence where client_id = p_client_id;
  if v_last is not null and v_last > now() - interval '4 seconds' then return; end if;

  -- A flood of fresh ids cannot grow the table without bound.
  if v_last is null and (select count(*) from lobby_presence where seen_at > now() - interval '30 seconds') >= 5000 then return; end if;

  if p_where = 'room' and p_room is not null then
    v_code := upper(coalesce(p_room->>'code', ''));
    if v_code !~ '^[A-Z0-9]{4,8}$' then v_code := null; end if;
  end if;

  if v_code is not null and p_room->>'host' = 'true' then
    v_phase := p_room->>'phase';
    if v_phase in ('waiting', 'warmup', 'playing', 'results') then
      v_city := coalesce(p_room->>'city', '');
      if v_city !~ '^[a-z0-9_-]{1,24}$' then v_city := ''; end if;
      -- Control / format characters out, whitespace collapsed, 16 characters max. The client
      -- still runs every name through its name filter before showing it.
      v_name := left(btrim(regexp_replace(regexp_replace(coalesce(p_room->>'name', ''), '[[:cntrl:]​-‏‪-‮⁠-⁯﻿]', '', 'g'), '\s+', ' ', 'g')), 16);
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

  begin
    v_uid := auth.uid();
  exception when others then
    v_uid := null;
  end;

  insert into lobby_presence as lp (client_id, player_id, seen_at, where_, room_code, room)
  values (p_client_id, v_uid, now(), p_where, v_code, v_room)
  on conflict (client_id) do update
    set seen_at = excluded.seen_at, where_ = excluded.where_, room_code = excluded.room_code, room = excluded.room,
        player_id = coalesce(excluded.player_id, lp.player_id);

  -- Opportunistic cleanup (~2 % of calls, bounded): rows are dead 30 s after their last beat.
  if random() < 0.02 then
    delete from lobby_presence
    where client_id in (select client_id from lobby_presence where seen_at < now() - interval '60 seconds' limit 200);
  end if;
end;
$$;

-- ── lobby_snapshot ──────────────────────────────────────────────────────────
-- {online, rooms, public, list: [{code, name, city, players, max, phase, bots, ends_in, age}]}
-- online = pages heard within 30 s; rooms = distinct room codes (public and private) with a
-- member heard within 30 s; list = up to 50 public rooms (latest host summary per code), waiting
-- rooms with the most players first, then warm-ups, results, rounds in progress, full rooms.
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
    select distinct on (room_code) room_code, room, seen_at
    from live
    where where_ = 'room' and room_code is not null and room is not null
    order by room_code, seen_at desc
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
