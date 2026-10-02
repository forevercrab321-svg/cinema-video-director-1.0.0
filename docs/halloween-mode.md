# Halloween Town — map + "The Hunt" mode (spec, 2026-10-02)

The Creative Director asked for this on 2026-10-02.

- **Map:** a Halloween map built entirely from Halloween elements: slime ghosts, graveyard, skeletons, vampire, werewolf, pumpkins, witch.
- **Centre:** the central plaza stays **empty** for now. Something hidden will go there later.
- **Bosses vs food** (2026-10-02): the three villains are the only bosses — scariest things on the map, never edible, never beatable. Every other Halloween element, monsters included (vampires, werewolves, witches, skeletons, the giant skeleton…), is food for the player's machine in the first half. UI: villain tags read `☠ BOSS · name`; rise banner "3 BOSSES AWAKEN".
- **Egg Valley / 蛋之谷** (2026-10-02, character art: `references/characters/egg-girl-danzhigu.jpg`): an invisible girl hidden in a different hidden corner every round (behind a giant, a graveyard corner or a wall corner; picked from the round seed, so every page agrees; never in the plaza). She is out from the start of the chase. Within 15 m golden egg sparkles give her away, within 6 m a translucent ghost shows; honk 📯 within 4 m to wake her. The first machine to do so gets her fried-egg backpack: 10 s invisible (bosses neither target nor catch it) and locked score × 4/3. Once per round; the host decides (`eg: [slot, t]` in the match message). Config: `EGG` in `config/halloween.ts`; code: `arena/egg.ts`, `entities/EggGirlModel.ts`.
- **Only Halloween elements** (2026-10-02 correction): no houses, cars, street furniture, roads or city skyline. Graveyard and pumpkin-patch landscape; every size class is a Halloween object.
- **Round length:** doubled.
- **Second half:** every machine shrinks back to small, and three horror characters chase everyone.
- **Caught:** the player's score goes to **0** and they are **out, spectating**.
- **Players:** up to **6** per room on this map.
- **Music:** a Halloween / horror BGM. Prompts are in `docs/music/suno-prompts.md`.

## Decisions

These were confirmed with the Creative Director on 2026-10-02.

- **Scope:** the mode runs on the Halloween map only. Other cities keep 4 players and 5 minutes.
- **Caught:** score 0, out for the rest of the round (spectate).
- **Hunters:** three cartoon 3D characters with costumes and names.
  - Names are configurable in `game/src/config/halloween.ts`.
  - Own-site build: real names.
  - Portal builds (`PORTAL_BUILD`): neutral nicknames. This keeps platform review safe; the Creative Director can flip it.

| id | Own-site name | Portal name | Look |
| --- | --- | --- | --- |
| `shock` | 杨永信 / Yang Yongxin | The Shock Doctor / 电击院长 | Middle-aged doctor, square glasses, short black side-parted hair, white coat with a name badge, crackling electro-baton |
| `cannibal` | 汉尼拔 / Hannibal | The Cannibal / 食人魔 | Slicked-back hair, orange prison jumpsuit, white muzzle mask, maroon eyes, hands cuffed in front |
| `motel` | 诺曼·贝茨 / Norman Bates | The Motel Keeper / 汽车旅馆老板 | Lanky young man, cardigan under his mother's floral dress, grey bun wig, raised kitchen knife |

## Round timeline (Halloween map)

All times are match seconds; the values live in `HALLOWEEN` in `game/src/config/halloween.ts`.

| t | What happens |
| --- | --- |
| 0 – `huntAt` (300) | **Grow.** Normal arena rules: eat objects and smaller machines, 3 lives. |
| `hk` = hunt start | **Scores lock.** The host stamps each machine's mass as its banked score (`hs`). No more eating, of objects or of machines. Banner: "HALF TIME — SCORES LOCKED". |
| `hk` + 1 | **Shrink.** Every machine resets to `huntMass`. Every machine still in the match is revived, including players eliminated in the first half. |
| `hk` + 3 | **Rise.** The three hunters rise out of the empty central plaza. |
| `hk` + 6 | **Hunt.** Hunters chase. Machines are invulnerable until this moment. |
| `hk` + `huntSeconds` (300) | **End.** Ranked by banked score. Caught players have 0; among them, the later catch ranks higher. |

How `hk` is set:
- `hk` is normally `huntAt`.
- The host starts the hunt early if every human (or all but one machine) is eliminated in the first half.
- The round ends early when every human has been caught.

## Hunter rules

- **AI:** the host simulates the hunters. Each hunter picks the runner that best balances distance against spreading the hunters out, and leads its target a little.
- **Speed:** `speedStart` → `speedEnd` × the runner's top speed at `huntMass`, ramping over the hunt. A short lunge triggers near the target.
  - A runner who keeps dashing (≈1.28× average) can escape one hunter in the open.
  - Three hunters, buildings and dead ends are what catch people.
- **Movement:** hunters pass through props (they are horror villains) at `phaseSlow` speed. The district bounds keep them in.
- **Catch:** hunter reach + runner radius. The host decides; the catch rides the signed `match` message (`hc`).

## Network

| Field | Sent in | Meaning |
| --- | --- | --- |
| `hk` | `MatchState` (host, signed) | Hunt start time; absent means the hunt has not started |
| `hs: [slot, score][]` | `MatchState` | Banked scores, stamped at `hk` |
| `hc: [slot, t][]` | `MatchState` | Catches, emitted immediately when they happen |
| `hu: [x, z, heading, state][]` | Host presence (~20 Hz, like the AI rivals' `b`) | Hunter positions |

Each owner applies the shrink and revive to its own machine (as with mass today), so the existing wire and ledger paths carry the result.

## Six players

- **Client:** `maxPlayersFor(city)` returns 6 for Halloween and 4 for every other city. It is used by the lobby, AI fill, drop-in, the room browser and CrazyGames `updateRoom`.
- **Database:** migration `0007_six_player_rooms.sql` (the Creative Director applies it in Supabase).
  - `lobby_beat` accepts up to 6 players.
  - `submit_match` accepts up to 6 rows and up to 630 s.
  - Until 0007 is applied, a 6-player room still plays. The directory shows at most 4, and a 5–6-row result submission is rejected (coins are client-side anyway).

## Status (2026-10-02, release candidate rev 5)

| Part | State | Evidence |
| --- | --- | --- |
| Hunt mode (lock, shrink, rise, chase, catch, ranking) | DONE | `node tools/halloween-test.mjs` — solo (6 machines, full 10 min) + duo over LocalNet, all checks pass. Balance (`tools/halloween-balance.mjs`, 16 rounds): 59 % caught, first-half leader caught in 5/16, trailing machines can win |
| Egg Valley / 蛋之谷 | DONE | duo test (same spot on both pages, wake, stealth, +1/3); `tools/qa-halloween-edge.mjs` (honk-vs-catch frame, full 10 s stealth, guest honk); `tools/qa-egg-spots.mjs` (24 seeds reachable, never in the plaza) |
| UI (EN / 中文, phone / tablet / desktop) | DONE | `tools/qa-halloween-ui.mjs` → `renders/review/qa/ui/`: no off-screen blocks, board clears the minimap; only transient banners overlap the feed on small phones |
| Map (Halloween-only, 541 placements, classes 0–8) | DONE | `renders/review/halloween/*.jpg`; other cities hash-identical |
| Villains (3 bosses) | DONE, NEEDS CD REVIEW | `renders/review/hunters/` |
| Atmosphere / VFX | DONE | `renders/review/halloween-fx/`, 8–10 draw calls |
| Music / SFX | DONE (procedural); Suno tracks optional | `docs/music/suno-prompts.md` §7 |
| Migration 0007 | DONE — applied to production (grow-everything, main) 2026-10-02; read-only check confirms 0005, 0006 and 0007 objects present | `bash tools/sql-security-test.sh`; CD's SQL Editor check |
| Perf | High tier 258–339 draw calls in play (6 machines × ~30 parts dominate); world itself 43 | `tools/halloween-shots.mjs` |
