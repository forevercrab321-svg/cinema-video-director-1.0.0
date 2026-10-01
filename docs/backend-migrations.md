# Backend migrations — operator note

Production state (2026-09-30): `0001`–`0003` applied. Still to run: **`0004` then `0005`**, then
redeploy the `submit-match` edge function. Never edit a migration that has already been applied;
fixes go into a new numbered file.

## 1. Run the SQL (Supabase dashboard → SQL Editor)

Run each file as one query, in this order, waiting for “Success” before the next:

1. `supabase/migrations/0004_lobby_presence.sql` — room browser presence (`lobby_beat`, `lobby_snapshot`).
2. `supabase/migrations/0005_security_hardening.sql` — security fixes from the 2026-09-30 audit.
   It refuses to run if 0004 is missing, runs inside one transaction (all or nothing) and is
   idempotent: running it again is harmless.

Optional check afterwards: paste `supabase/tests/lobby.sql` into the editor. It rolls itself back
and ends with `lobby.sql: all checks passed`.

With the Supabase CLI instead of the editor: `supabase db push` applies pending files in order.

## 2. Deploy the edge function

```sh
supabase login                      # once
supabase link --project-ref <ref>   # once per checkout
supabase functions deploy submit-match
```

Deploy **after** 0005: the new function calls `public.submit_match(...)`, which 0005 creates.
Between the SQL run and the deploy the old function keeps working (with its old bugs); the new
function against a database without 0005 answers 500. JWT verification stays on (the default).
The function needs no new secrets (`SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY` are provided by the platform).

## 3. Verify locally (any machine with Postgres ≥ 14 server binaries and Node ≥ 22.6)

```sh
tools/sql-security-test.sh
```

Starts a throw-away Postgres, loads a Supabase stand-in (`tools/sql-security/stub.sql`), applies
0001 → 0005 (0005 twice), runs `supabase/tests/lobby.sql`, replays every audit exploit
(`tools/sql-security/exploits.sql`) and runs the real edge function under Node with a mocked
supabase-js (`tools/sql-security/submit-match-test.mjs`). Ends with `ALL SECURITY CHECKS PASSED`.

## What 0005 changes for clients

| Area | Before | After |
| --- | --- | --- |
| `submit-match` | host credited every listed uid, unlimited | caller credited for its own row only; one submission per (caller, room, start); ≥ 120 s apart; ≤ 1500 coins / 24 h; duration ≤ 330 s, kills ≤ 3 × opponents, mass ≤ 1e6 kg; atomic |
| `players` | everyone could read every row (coins, country…) | own row only; others through view `players_public (id, display_name, equipped)` |
| `players` writes | insert any column | insert `id, display_name`; update `display_name, last_seen_at, equipped`; names cleaned; `equipped` must be `{skin,horn,hat,eyes: id}` ≤ 2 KB |
| `sessions` | unlimited, any fields | ≤ 20 per account per hour, server-set start time, no client update/delete |
| `events` | unlimited, any session | caller's own session only, ≤ 500 per session, ≤ 120 per account per minute, props ≤ 1 KB, server time; excess silently dropped |
| `lobby_beat` | anyone could overwrite any row or room listing | row owned by the first account that wrote it; a room's listing only from its host (first signed-in claimant, kept while it beats, free again after 30 s silence); ≤ 3 rows per account; pre-sign-in pages limited to 2000 rows of the 5000 cap and never list a room |

RPC names and signatures used by `game/src/net/Hub.ts` are unchanged. The `submit-match` request
body is unchanged.

Known limits:
- A room is listed only once its host has finished the anonymous sign-in (normally within a
  second or two of page load; it is still counted in “rooms” before that). If anonymous sign-ins
  are disabled in the Supabase Auth settings, no room is ever listed publicly.
- After host migration the room disappears from the public list for up to 30 s, until the old
  host's claim expires and the new host's beat claims it.
- Today only the host calls `submit-match` (`arenaMain.ts`), so only the host receives server
  coins. To credit every human, each client should call it with the same body at match end
  (the server de-duplicates and credits each caller for its own row).
- Results are still reported by clients; the clamps bound the damage (leaderboard mass ≤ 1e6 kg,
  ≤ 190 coins per match, ≤ 1500 per day) but cannot prove a result. A server-authoritative match
  is the only full fix.

## Coins and progress in localStorage (audit L3)

The coins, unlocks, owned cosmetics and gift records the player sees live in the browser
(`localStorage`, `game/src/arena/progress.ts`). Anyone can edit them, and that is accepted while
there is no server economy: they only unlock cosmetics on that device.

Rules that keep it safe:
- **Nothing server-side reads or trusts these values.** The server's `players.coins` is written
  only by `public.submit_match` (service role, from clamped results) and is not shown in the game.
  `players.cosmetics` is server-owned (clients cannot write it); `players.equipped` is checked for
  shape only, because ownership is still client-side.
- When a real economy launches (paid coins, tradable items, server-checked ownership), the client
  must read balances and ownership from the server, purchases must be granted only by the payment
  webhook, and spending must go through a server function — never by syncing localStorage up.
