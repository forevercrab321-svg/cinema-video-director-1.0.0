-- Server-confirmed room host (0006_room_host.sql): lease rules and abuse cases. Run by
-- tools/sql-security-test.sh on a scratch cluster after exploits.sql (it reuses sectest.*).
-- Every check raises on failure.
\set ON_ERROR_STOP 1
set client_min_messages = notice;

insert into auth.users (id) values
  ('a0000000-0000-4000-8000-00000000000a'),
  ('b0000000-0000-4000-8000-00000000000b'),
  ('c0000000-0000-4000-8000-00000000000c')
on conflict do nothing;

create function sectest.lease_age(code text, secs int) returns void language sql as $$
  update public.room_hosts set seen_at = now() - make_interval(secs => secs) where room_code = code $$;

set role authenticated;
select sectest.as_user('a0000000-0000-4000-8000-00000000000a');
select sectest.ok((public.room_host('ROOM1', 'p-aaaaaaaa01', null, false, false)) ->> 'peer' is null, 'host: nobody holds a new room');
select sectest.ok((public.room_host('ROOM1', 'p-aaaaaaaa01', 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB', true, false)) ->> 'peer' = 'p-aaaaaaaa01', 'host: first claim wins the lease');
select sectest.ok((public.room_host('ROOM1', 'p-aaaaaaaa01', null, false, false)) ->> 'term' = '1', 'host: first term is 1');
select sectest.ok((public.room_host('ROOM1', 'p-aaaaaaaa01', null, false, false)) ->> 'key' = 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB', 'host: the key is published with the lease');

-- A rival account (and a rival page of the same account) cannot take a live lease.
select sectest.as_user('b0000000-0000-4000-8000-00000000000b');
select sectest.ok((public.room_host('ROOM1', 'p-bbbbbbbb01', 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJC', true, false)) ->> 'peer' = 'p-aaaaaaaa01', 'host: a rival claim on a live lease is refused');
select sectest.ok((public.room_host('ROOM1', 'p-aaaaaaaa01', 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJC', true, false)) ->> 'key' = 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB', 'host: another account using the holder''s peer id cannot swap the key');
select public.room_host('ROOM1', 'p-aaaaaaaa01', null, false, true);
select sectest.ok((public.room_host('ROOM1', 'p-bbbbbbbb01', null, false, false)) ->> 'peer' = 'p-aaaaaaaa01', 'host: another account cannot release the lease');
select sectest.as_user('a0000000-0000-4000-8000-00000000000a');
select sectest.ok((public.room_host('ROOM1', 'p-aaaaaaaa02', null, true, false)) ->> 'peer' = 'p-aaaaaaaa01', 'host: a second page of the holder''s account does not take over');

-- Signed out: may ask, never claim.
select sectest.as_user(null);
select sectest.ok((public.room_host('ROOM9', 'p-cccccccc01', null, true, false)) ->> 'peer' is null, 'host: a signed-out page cannot claim');

-- Renewal keeps the term; a new key (page reloaded) is a new term.
select sectest.as_user('a0000000-0000-4000-8000-00000000000a');
select sectest.ok((public.room_host('ROOM1', 'p-aaaaaaaa01', 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB', true, false)) ->> 'term' = '1', 'host: renewal keeps the term');
select sectest.ok((public.room_host('ROOM1', 'p-aaaaaaaa01', 'WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpa', true, false)) ->> 'term' = '2', 'host: a new key is a new term');
reset role;

-- Expiry: 6 s after the last renewal anyone may claim, with a higher term.
select sectest.lease_age('ROOM1', 7);
set role authenticated;
select sectest.as_user('b0000000-0000-4000-8000-00000000000b');
select sectest.ok((public.room_host('ROOM1', 'p-bbbbbbbb01', null, false, false)) ->> 'peer' is null, 'host: an expired lease reads as free');
select sectest.ok((public.room_host('ROOM1', 'p-bbbbbbbb01', 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJC', true, false)) ->> 'peer' = 'p-bbbbbbbb01', 'host: an expired lease can be claimed');
select sectest.ok((public.room_host('ROOM1', 'p-bbbbbbbb01', null, false, false)) ->> 'term' = '3', 'host: the takeover has a higher term');

-- Release: the next claim wins at once, still with a higher term.
select public.room_host('ROOM1', 'p-bbbbbbbb01', 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJC', false, true);
select sectest.as_user('a0000000-0000-4000-8000-00000000000a');
select sectest.ok((public.room_host('ROOM1', 'p-aaaaaaaa01', null, false, false)) ->> 'peer' is null, 'host: a released lease is free at once');
select sectest.ok((public.room_host('ROOM1', 'p-aaaaaaaa01', 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB', true, false)) ->> 'term' = '4', 'host: the next holder''s term still rises after a release');

-- Abuse: bad input, the table is private, at most 3 rooms per account at once.
select sectest.ok((public.room_host('bad code!', 'p-aaaaaaaa01', null, true, false)) ? 'error', 'host: bad room code rejected');
select sectest.ok((public.room_host('ROOM1', 'x-not-a-peer', null, true, false)) ? 'error', 'host: bad peer id rejected');
select sectest.ok((public.room_host('ROOM1', 'p-aaaaaaaa01', '<script>', true, false)) ? 'error', 'host: bad key rejected');
select sectest.fails('select * from public.room_hosts', 'host: room_hosts is not readable by clients');
select sectest.fails('update public.room_hosts set host_peer = ''p-cccccccc01''', 'host: room_hosts is not writable by clients');
select sectest.as_user('c0000000-0000-4000-8000-00000000000c');
select public.room_host('ROOMA', 'p-cccccccc01', null, true, false);
select public.room_host('ROOMB', 'p-cccccccc02', null, true, false);
select public.room_host('ROOMC', 'p-cccccccc03', null, true, false);
select sectest.ok((public.room_host('ROOMD', 'p-cccccccc04', null, true, false)) ->> 'peer' is null, 'host: an account holds at most 3 rooms at once');
reset role;
set role anon;
select sectest.ok((public.room_host('ROOM1', 'p-aaaaaaaa01', null, false, false)) ->> 'peer' = 'p-aaaaaaaa01', 'host: anon may ask who hosts');
select sectest.ok((public.room_host('ROOMZ', 'p-aaaaaaaa01', null, true, false)) ->> 'peer' is null, 'host: anon cannot claim');
reset role;

select 'room-host.sql: all checks passed';
