# Netcode and security audit: verified root causes and fix plan (2026-10-01)

These are the verification results for the full audit run by the other session.
- The analysis was read-only, against HEAD 90fcfce.
- Line numbers refer to that version.
- This work waits for the room-browser patch (`grow-everything-rooms-and-fixes.patch` + `0004_lobby_presence.sql`) to land. After it lands, re-locate each line before fixing.

## Batch 1: online play (all 4 confirmed)

### 1. Ready is cleared about every 1 s
- **Where:** in `ArenaSession.onMatch` (about line 434), every lobby beacon (`matchBeaconMs = 1000`) runs `this.ready = false`. The beacon itself is sent at about lines 400-410.
- **Effect:** `canStart()` requires every guest to be ready, so the host almost never sees all players ready. Warm-up and rematch skip this check, which is why only those two work.
- **Fix:** reset ready only on a new epoch or a phase change into the lobby (`newEpoch || prev.ph !== 'lobby'`).

### 2. Host away for under 5 s → two hosts
- **Sequence:**
  1. When the host's tab is hidden, it sends `bye` straight away.
  2. Guests delete the host and elect the lowest id as the new host.
  3. When the old host comes back, it only re-hands host authority if it was away longer than `awayMs = 5000`.
- **Result:** both sides believe they are host and ignore each other's beacons.
- **Fix:**
  - Add a host term `hg` to `MatchState`. Every takeover sets `hg + 1`.
  - `outranks()` resolves conflicts: the higher `hg` wins; on a tie, the smaller id wins.
  - The new host inherits `city` and `bots`.
- **Do not** take the shortcut of "always run cameBack after a bye". If the bye itself was lost, the room ends up with no host at all.

### 3. A later joiner steals host and resets the city
- **Cause:** in the lobby, `hostId()` is simply the lowest random id. The newcomer's first beacon carries `CITIES[0]` and `bots=true`, which overwrite the original host's choice.
- **Fix:**
  - Make the lobby host sticky: if `match.host` is still online, it stays host.
  - A newcomer waits `2.5 × matchBeaconMs` to hear a beacon before it may claim host.
  - Combine this with `hg`/`outranks` from item 2.

### 4. Lost grant → mass never credited
- **What already works:** the client re-claims every 1.5 s.
- **What breaks:** the host's `onClaim` does `continue` for objects already in `granted`, and also skips objects already absorbed. So if the grant message is lost, it is never re-sent.
- **Fix:** change `granted` to a `Map<id, actor>`. When a repeated claim arrives, re-send the original grant. This is safe because `applyGrant` is idempotent.
- **Same problem with `eaten`:** it is sent only once. Give each event an id, put the last ~3 s of eaten ids in the beacon, and have clients skip ids they have already applied.

## Batch 3: security (confirmed; must be done before a leaderboard or real coins)
- **Coin/leaderboard farming:** `supabase/functions/submit-match` only checks that the caller is in `rows`. Rank, kills, mass, duration and `startedAt` all come from the client. There is no match ticket, no dedup and no rate limit, so a loop can farm 400 coins per call and fill the leaderboard.
- **Host impersonation:** the channel is public, and `from` is a field the client writes itself. Anyone who knows the room code can forge `match`/`grant`/`eaten`.
- **Self-reported mass:** `applyWire` trusts the mass sent by each peer, and both eat checks and standings use it.
- **Already sound:** the RLS in `0001_init.sql`. `matches`/`match_players` have no client write path, and `grant_coins` has been revoked.
- **Small leak:** `players_read using(true)` exposes every player's coins. Switch to a view that exposes only public columns.

### Server-side plan (small-team scale)

**A. Required before a leaderboard or coins**
1. **`match_open`:** the host calls it and the server stamps `host_uid` and `started_at`. Each player then calls `match_join` to bind `auth.uid()`.
2. **`match_settle`:**
   - single-use, host only;
   - ranks must be a permutation of 1..n;
   - duration is computed by the server;
   - caps on kills and mass;
   - coins are computed in SQL with a daily cap;
   - suspicious matches are flagged `suspect` and kept off the leaderboard.
3. **Optional `match_report`:** each human reports their own result and the server takes the minimum or majority.
4. **Server-held coins:** the server owns the coin balance and shop purchases go through an RPC. Real-money items are granted only by the payment webhook.

**B. Before prizes or ranked play**
- A `room_host_lease` table plus a `claim_host` RPC, so the server picks the host (this fixes items 2 and 3 at the root).
- Realtime Authorization (`private: true`).
- The host signs key messages.
- The host recomputes mass itself.

**C. Lobby (pending 0004)**
- Only `lobby_upsert` (SECURITY DEFINER) may write rows, and `owner_uid = auth.uid()`.
- Only the owner can change a room's visibility.
- Player counts come from per-player heartbeat rows.
- Only rows from the last 30 s are shown.
- Each uid may have at most 1 room, with a rate limit.
- Private room codes are at least 8 characters and never listed (current 5-character codes are too short).

## Overlap with the pending patch
- **10 Hz position sync and lobby presence:** these touch `ArenaSession.update()`, `SupabaseNet` heartbeat/bye, and possibly `hostId()`. Expect conflicts with items 2, 3 and 4. If the lobby row records a host, use it directly as the server-side host instead of adding a second election.
- **Item 1** is self-contained.

## Status (2026-10-01, on top of the room browser + 0005 patch)

| Item | Fixed in | Test (`node tools/net-room-test.mjs`, with and without the lease RPC) |
| --- | --- | --- |
| 1. Ready cleared every beacon | `ArenaSession.onMatch`: reset only on a new epoch / phase change into the lobby | `ready` |
| 2. Two hosts after a < 5 s tab-out | server lease (`0006_room_host.sql`, `net/HostLease.ts`): the host releases on hide, the next claims, everyone follows the lease; fallback: host term `hg` + `outranks()` | `tabout`, `longaway` |
| 3. Newcomer steals host / resets city | lobby host is sticky; a new page listens `hostGraceMs` before claiming the lease; equal terms go to the older page (`sn`) | `newcomer` |
| 4. Lost grant | host keeps `granted: Map` and answers a repeated claim with the same grant | `lostgrant` |
| 4b. Lost `eaten` | eats carry an id and ride in the beacon for `eatenReplaySeconds`; applied once | `losteaten` |
| Server-confirmed host | lease holder signs `match` / `grant` / `eaten` (ECDSA P-256, key stored with the lease, replay window); a page drops messages forged in its own name (nonces) | `forgery` (+ `tools/sql-security/room-host.sql`) |
| Lied-about mass / kills | `arena/massLedger.ts`: caps from host decisions (grants, eats, roster), clamped in `ArenaGame.applyWire`, caps sent in the beacon | `masslie` |

Still open:
- Without 0006 applied, a modified client can still forge host messages.
- Non-host messages (position, own state) can still be forged by any page; only host authority is signed.
- Movement validation (a speed cap on reported positions) is not done.
- Coins and progress remain client-side (see `docs/backend-migrations.md`).
