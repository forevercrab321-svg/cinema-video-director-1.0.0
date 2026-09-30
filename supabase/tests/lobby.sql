-- Sanity checks for supabase/migrations/0004_lobby_presence.sql.
-- Paste into the Supabase SQL editor after running the migration (everything is rolled back),
-- or run locally: psql -v ON_ERROR_STOP=1 -f supabase/tests/lobby.sql
-- Each failed check raises an exception; success ends with the snapshot and 'lobby.sql: all checks passed'.
begin;

-- Start from an empty table inside this transaction (rolled back at the end).
delete from public.lobby_presence;

-- Room AAAA1 (public, waiting, 2 players): host + guest
select public.lobby_beat('h-host0001', 'room', '{"code":"AAAA1","host":true,"name":"Alice","city":"shanghai","players":2,"max":4,"phase":"waiting","public":true,"bots":true}');
select public.lobby_beat('h-gues0001', 'room', '{"code":"AAAA1"}');
-- Room BBBB2 (PRIVATE): host + guest
select public.lobby_beat('h-host0002', 'room', '{"code":"BBBB2","host":true,"name":"Bob","city":"paris","players":2,"max":4,"phase":"waiting","public":false,"bots":true}');
select public.lobby_beat('h-gues0002', 'room', '{"code":"bbbb2"}');
-- Room CCCC3 (public, playing, ends in 140 s): host + guest
select public.lobby_beat('h-host0003', 'room', '{"code":"CCCC3","host":true,"name":"Chen","city":"newyork","players":2,"max":4,"phase":"playing","public":true,"bots":true,"ends_in":140}');
select public.lobby_beat('h-gues0003', 'room', '{"code":"CCCC3"}');
-- Two solo pages and one page on the room browser
select public.lobby_beat('h-solo0001', 'solo', null);
select public.lobby_beat('h-solo0002', 'solo', null);
select public.lobby_beat('h-brow0001', 'browser', null);

-- Hostile / malformed calls: all ignored or clamped
select public.lobby_beat('not-an-id', 'browser', null);
select public.lobby_beat('h-evil0001', 'dancing', null);
select public.lobby_beat('h-evil0002', 'room', '"just a string"');
select public.lobby_beat('h-evil0003', 'room', '{"code":"ZZZZ9","host":true,"name":"   a\u0007very​long\n name that keeps going","city":"<script>","players":-5,"max":99,"phase":"waiting","public":true,"bots":"yes"}');
select public.lobby_beat('h-evil0004', 'room', '{"code":"../x","host":true,"players":3,"phase":"waiting","public":true}');
select public.lobby_beat('h-evil0005', 'room', '{"code":"NEG77","host":true,"name":"Neg","players":2,"phase":"playing","public":true,"ends_in":1e12}');
select public.lobby_beat('h-evil0006', 'room', '{"code":"BAD00","host":true,"players":2,"phase":"sleeping","public":true}');
select public.lobby_beat('h-evil0007', 'room', jsonb_build_object('code', 'HUGE1', 'host', true, 'name', repeat('x', 5000), 'players', 1, 'phase', 'waiting', 'public', true));

do $$
declare
  s jsonb := public.lobby_snapshot();
  z jsonb;
begin
  -- 9 real pages + h-evil0003/0004/0005/0006 (valid id and place; rooms cleaned or dropped).
  -- h-evil0002 (room not an object) and h-evil0007 (oversized) are ignored entirely.
  if (s->>'online')::int <> 13 then raise exception 'online = %, expected 13', s->>'online'; end if;
  -- AAAA1, BBBB2, CCCC3 + ZZZZ9, NEG77, BAD00 (a member code counts, even without a valid summary)
  if (s->>'rooms')::int <> 6 then raise exception 'rooms = %, expected 6', s->>'rooms'; end if;
  if s::text like '%BBBB2%' then raise exception 'private room code leaked: %', s; end if;
  if s::text like '%HUGE1%' or s::text like '%../x%' or s::text like '%BAD00%' then raise exception 'malformed room listed: %', s; end if;
  if (s->'list'->0->>'code') <> 'AAAA1' then raise exception 'waiting room with most players must be first: %', s->'list'; end if;
  select x into z from jsonb_array_elements(s->'list') x where x->>'code' = 'ZZZZ9';
  if z is null or (z->>'players')::int <> 0 or (z->>'max')::int <> 4 or z->>'city' <> '' or length(z->>'name') > 16 or z->>'name' ~ '[[:cntrl:]]' or (z->>'bots')::boolean then
    raise exception 'hostile room not clamped: %', z;
  end if;
  select x into z from jsonb_array_elements(s->'list') x where x->>'code' = 'NEG77';
  if z is null or (z->>'ends_in')::numeric <> 900 then raise exception 'ends_in not clamped: %', z; end if;
  select x into z from jsonb_array_elements(s->'list') x where x->>'code' = 'CCCC3';
  if z is null or (z->>'ends_in')::numeric <> 140 or z->>'phase' <> 'playing' or (z->>'players')::int <> 2 then raise exception 'CCCC3 wrong: %', z; end if;
end $$;

-- Rate limit: a second beat within 4 s changes nothing.
select public.lobby_beat('h-host0001', 'room', '{"code":"AAAA1","host":true,"name":"Alice","players":1,"max":4,"phase":"waiting","public":true}');
do $$
begin
  if (select (room->>'players')::int from public.lobby_presence where client_id = 'h-host0001') <> 2 then raise exception 'rate limit did not hold'; end if;
end $$;

-- Expiry: a page silent for 31 s is not counted, and rows older than 60 s are eventually deleted.
update public.lobby_presence set seen_at = now() - interval '31 seconds' where client_id in ('h-gues0001', 'h-host0003');
do $$
declare s jsonb := public.lobby_snapshot();
begin
  if (s->>'online')::int <> 11 then raise exception 'expired pages still counted: %', s->>'online'; end if;
  if s::text like '%CCCC3%' and exists (select 1 from jsonb_array_elements(s->'list') x where x->>'code' = 'CCCC3') then raise exception 'room of a silent host still listed'; end if;
end $$;

-- The table itself is not reachable by clients.
do $$
begin
  if has_table_privilege('anon', 'public.lobby_presence', 'select') or has_table_privilege('authenticated', 'public.lobby_presence', 'insert') then raise exception 'lobby_presence is exposed'; end if;
  if not has_function_privilege('anon', 'public.lobby_beat(text, text, jsonb)', 'execute') or not has_function_privilege('anon', 'public.lobby_snapshot()', 'execute') then raise exception 'anon cannot call the lobby functions'; end if;
end $$;

select public.lobby_snapshot() as snapshot;
select 'lobby.sql: all checks passed' as result;
rollback;
