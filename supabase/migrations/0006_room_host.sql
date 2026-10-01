-- 0006: server-confirmed room host (audit 2026-10-01, netcode batch 1).
-- Run AFTER 0005_security_hardening.sql. It is idempotent: a second run changes nothing.
-- Everything runs in one transaction, so a failure leaves the database as it was.
--
-- Before this, the host of an online room was whoever every client's own election picked.
-- That caused three problems:
--   · a host that tabbed out for under 5 s came back as a second host;
--   · a newcomer with a lower peer id took over and reset the room's city;
--   · any page could write the host's id into a message's `from` field and speak for the host.
--
-- How it works now:
--   · The server keeps one lease per room code: (peer id, account, signing key, term).
--   · A page may claim the lease only while it is free or expired, or when it already holds it.
--   · The holder renews it every 2 s while its page is visible and releases it when hidden or
--     closed. Otherwise the lease expires 6 s after the last renewal.
--   · The term only ever rises, so every client can rank two hosts' claims the same way.
--   · The public half of the holder's ECDSA P-256 key is stored with the lease. Clients only
--     accept host messages (match / grant / eaten) that are signed with that key (see
--     game/src/net/HostLease.ts).
--
-- Clients call room_host() about every 3 s (the holder every 2 s). The cost grows linearly
-- with the number of open room pages, and the call never touches Realtime.

begin;

do $$
begin
  if to_regclass('public.lobby_rooms') is null then
    raise exception '0006 needs 0005_security_hardening.sql: run 0004 and 0005 first';
  end if;
end $$;

create table if not exists public.room_hosts (
  room_code  text primary key check (room_code ~ '^[A-Z0-9]{4,8}$'),
  host_peer  text not null check (host_peer ~ '^p-[a-z0-9]{6,16}$'),
  host_uid   uuid not null,
  -- Base64 of the raw (65-byte) public key; null if the page has no WebCrypto (messages unsigned).
  host_key   text null check (host_key is null or host_key ~ '^[A-Za-z0-9+/]{40,100}={0,2}$'),
  term       integer not null default 1 check (term > 0),
  seen_at    timestamptz not null default now()
);
create index if not exists room_hosts_uid_idx on public.room_hosts (host_uid, seen_at);
create index if not exists room_hosts_seen_idx on public.room_hosts (seen_at);
alter table public.room_hosts enable row level security;
revoke all on public.room_hosts from public, anon, authenticated;

-- p_claim:   take the lease if it is free or expired, or renew it if this page already holds it.
-- p_release: give it up now (only the holder can), so the next host takes over without
--            waiting for the 6 s expiry.
-- Returns {peer, term, key, age} for a live lease (age = ms since the last renewal), or
-- {peer: null, term} when nobody holds it. Bad input returns {error}.
create or replace function public.room_host(
  p_room text,
  p_peer text,
  p_key text default null,
  p_claim boolean default false,
  p_release boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_lease constant interval := interval '6 seconds';
  c_per_uid constant int := 3;
  v_code text := upper(coalesce(p_room, ''));
  v_uid uuid;
  v_row public.room_hosts%rowtype;
  v_found boolean;
begin
  if v_code !~ '^[A-Z0-9]{4,8}$' or p_peer is null or p_peer !~ '^p-[a-z0-9]{6,16}$' then
    return jsonb_build_object('error', 'bad_args');
  end if;
  if p_key is not null and p_key !~ '^[A-Za-z0-9+/]{40,100}={0,2}$' then
    return jsonb_build_object('error', 'bad_key');
  end if;
  begin
    v_uid := auth.uid();
  exception when others then
    v_uid := null;
  end;

  -- Only signed-in pages may claim, renew or release; anyone may ask who holds the lease.
  if v_uid is not null and (coalesce(p_claim, false) or coalesce(p_release, false)) then
    select * into v_row from room_hosts where room_code = v_code for update;
    v_found := found;
    if v_found and v_row.host_peer = p_peer and v_row.host_uid = v_uid then
      if coalesce(p_release, false) then
        -- Expire rather than delete, so the next holder's term is still higher.
        update room_hosts set seen_at = now() - interval '1 hour' where room_code = v_code;
      elsif v_row.seen_at >= now() - c_lease then
        -- Renewal. A new key (the page reloaded) is a new term.
        update room_hosts
          set seen_at = now(),
              host_key = p_key,
              term = case when host_key is distinct from p_key then term + 1 else term end
          where room_code = v_code;
      else
        -- Our own lease ran out and nobody took it: claim it again with a new term.
        update room_hosts set seen_at = now(), host_key = p_key, term = term + 1 where room_code = v_code;
      end if;
    elsif coalesce(p_claim, false) and not coalesce(p_release, false)
      and (select count(*) from room_hosts where host_uid = v_uid and seen_at >= now() - c_lease and room_code <> v_code) < c_per_uid then
      if not v_found then
        insert into room_hosts (room_code, host_peer, host_uid, host_key, term, seen_at)
        values (v_code, p_peer, v_uid, p_key, 1, now())
        on conflict (room_code) do nothing;
      elsif v_row.seen_at < now() - c_lease then
        update room_hosts
          set host_peer = p_peer, host_uid = v_uid, host_key = p_key, term = v_row.term + 1, seen_at = now()
          where room_code = v_code;
      end if;
    end if;
  end if;

  -- Housekeeping, bounded: leases nobody has touched for a day.
  if random() < 0.01 then
    delete from room_hosts
    where room_code in (select room_code from room_hosts where seen_at < now() - interval '1 day' limit 200);
  end if;

  select * into v_row from room_hosts where room_code = v_code;
  if not found then
    return jsonb_build_object('peer', null, 'term', 0);
  end if;
  if v_row.seen_at < now() - c_lease then
    return jsonb_build_object('peer', null, 'term', v_row.term);
  end if;
  return jsonb_build_object(
    'peer', v_row.host_peer,
    'term', v_row.term,
    'key', v_row.host_key,
    'age', round(extract(epoch from now() - v_row.seen_at) * 1000)
  );
end;
$$;

revoke all on function public.room_host(text, text, text, boolean, boolean) from public;
grant execute on function public.room_host(text, text, text, boolean, boolean) to anon, authenticated;

commit;
