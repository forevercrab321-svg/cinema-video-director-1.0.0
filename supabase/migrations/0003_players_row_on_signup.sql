-- Every signed-in (incl. anonymous) user gets a players row server-side.
-- Why: the client created it with an upsert (INSERT … ON CONFLICT DO UPDATE), which needs UPDATE
-- rights on every written column; players only grants display_name / last_seen_at / equipped, so
-- the request failed (403), no row existed, and every sessions / events insert then failed its
-- foreign key (409). Telemetry stayed at 0 while auth.users kept growing.

create or replace function public.handle_new_player()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.players (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_player on auth.users;
create trigger on_auth_user_created_player
  after insert on auth.users
  for each row execute function public.handle_new_player();

-- Backfill everyone who signed in before this fix.
insert into public.players (id, created_at, last_seen_at)
select u.id, u.created_at, coalesce(u.last_sign_in_at, u.created_at)
from auth.users u
on conflict (id) do nothing;
