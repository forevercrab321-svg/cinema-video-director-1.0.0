# Steam

Status: **build and store materials in progress** (2026-10-05). Steamworks account not yet registered.

## Decisions

| Item | Decision | Who |
| --- | --- | --- |
| Villain names | Neutral nicknames that still say who they are (Creative Director, 2026-10-05): 戒网瘾电击院长 / The Net-Addiction Shock Doctor, 食人魔医生 / Dr. Cannibal, 惊魂旅馆老板 / The Psycho Motel Keeper. Real names stay on our own website only; the Steam build is a portal build (`VITE_PORTAL_BUILD=1`) and `tools/build-steam.mjs` fails if a real name is in the bundle. | User |
| Price | **Pending.** Recommendation: Free to Play, same as the web version (players can find it free on the web, so a price invites refund requests and bad reviews); add a paid Supporter Pack (cosmetics only) later via Steam microtransactions. | User |
| Ads | None on Steam (the `nosdk` build has no ad SDK). | — |

## What we have (repository)

| Thing | Where | How |
| --- | --- | --- |
| Desktop app (Electron shell) | `steam/main.cjs`, `steam/package.json` | serves the SDK-free web build from `app://game`, single instance, F11 fullscreen, external links → system browser |
| Windows / Linux builds | `release/steam/` (not in git, ~120 MB each) | `npm install` in `steam/` once, then `node tools/build-steam.mjs win32 linux` |
| Smoke test | `tools/qa-steam.mjs` | `xvfb-run -a node tools/qa-steam.mjs` — Linux build: window opens, lobby, Quick play reaches a round, no page errors |
| Store images | `release/steam-store/` | `node tools/steam-shots.mjs` (stills) then `node tools/build-steam-store-art.mjs` (capsules) |

Verified 2026-10-05 (Linux build under Xvfb): app opens from `app://game`, lobby renders, Quick play vs AI starts a round in ~28 s on software rendering, 0 page errors, 0 failed requests.
Not verified here: online rooms (the sandbox cannot reach Supabase), Windows build on a real PC, Steam Deck.
Known gap: the Windows `.exe` still has the default Electron icon (setting it from Linux needs Wine); Steam shows its own library icon, so it is cosmetic.

## Steam requirements we must meet (check the current Steamworks docs before each step)

- Steam Direct fee: USD 100 per game, paid by the user; recoupable after the game earns USD 1,000.
- New developer accounts wait 30 days after paying before the first release.
- The store page must be public as "Coming Soon" for at least 2 weeks before release.
- Store page and build are each reviewed by Valve (typically a few business days).
- Capsule images may show only game art and the game name (no taglines, awards or prices).

## Store assets checklist

| Asset | Size | File |
| --- | --- | --- |
| Header capsule | 920×430 | `release/steam-store/header_capsule_920x430.png` |
| Small capsule | 462×174 | `release/steam-store/small_capsule_462x174.png` |
| Main capsule | 1232×706 | `release/steam-store/main_capsule_1232x706.png` |
| Vertical capsule | 748×896 | `release/steam-store/vertical_capsule_748x896.png` |
| Library capsule | 600×900 | `release/steam-store/library_capsule_600x900.png` |
| Library hero | 3840×1240 | `release/steam-store/library_hero_3840x1240.png` |
| Library logo | 1280×720, transparent | `release/steam-store/library_logo_1280x720.png` |
| Screenshots | 1920×1080, at least 5 | `release/steam-store/screenshots/` + `marketing/press-kit/screenshots/` |
| Trailer | optional at first | `renders/marketing/` clips can be cut later |

## Store text

**Short description (EN)**: Eat anything smaller than you, grow, and swallow a whole city. Then survive Halloween Town, where three bosses hunt you down. Online rooms with friends, and AI fills empty seats.

**Short description (中文)**: 吃掉比你小的一切，越吃越大，最后吞掉整座城市！万圣节小镇里还有三个 BOSS 追着你跑。和好友联机，空位由 AI 补上。

**About this game (EN)**

GROW EVERYTHING is a 3D arena "eat the city" game. Drive a small googly-eyed machine through Shanghai, New York, Paris or Halloween Town and swallow everything smaller than you: trash cans, cars, buses, whole buildings. Keep growing until you can bring down the city's landmark.

Bigger machines eat smaller ones, so every chase can flip in a second. Invite friends with one link, and AI rivals fill the empty seats so a round always starts right away.

Halloween Town: grow for the first half, then every machine shrinks back and three bosses (the Net-Addiction Shock Doctor, Dr. Cannibal and the Psycho Motel Keeper) crawl out of the plaza to hunt you. Get caught and your score is gone. Find the hidden Egg Valley and honk to turn invisible.

Pick one of four machines and unlock paint jobs, hats and horns with coins you earn in play. Cosmetics never make you stronger.

**关于这款游戏（中文）**

《GROW EVERYTHING》是一款 3D「吞掉整座城市」竞技游戏。驾驶一台大眼珠小机器，在上海、纽约、巴黎或万圣节小镇里，吃掉一切比你小的东西：垃圾桶、汽车、公交车、整栋楼。一直长大，直到能推倒城市地标。

大的吃小的，追逐随时反转。一个链接邀请好友，空位由 AI 对手补上，随时开局。

万圣节小镇：上半场吃东西长大，下半场所有车变回小车，戒网瘾电击院长、食人魔医生、惊魂旅馆老板三个 BOSS 从广场爬出来追人，被抓到分数清零。找到藏起来的蛋之谷，按喇叭就能隐身。

四种机器任选，用游戏里赚的金币解锁涂装、帽子和喇叭。外观不会让你变强。

**Tags**: Casual, Multiplayer, Online Co-Op/PvP, Arcade, Driving, Destruction, 3D, Cute, Funny, Halloween, Physics.

**Content survey notes**: cartoon violence (machines eat each other and objects; bosses catch players, no blood or gore); horror-themed characters played for comedy; online play with player-chosen names (name filter in place). No real-money purchases at launch.

**System requirements (minimum, to confirm on a low-end PC)**: Windows 10 64-bit; dual-core 2 GHz; 4 GB RAM; GPU with WebGL 2 / DirectX 11 (Intel HD 520 or better); 400 MB disk; broadband internet for online rooms (solo vs AI works offline).

## Steps (user)

1. Register at https://partner.steamgames.com/ with the business email, sign the Steam Distribution Agreement, fill in bank and tax information (the tax interview is the user's own; never share SSN or tax details with anyone).
2. Pay the USD 100 Steam Direct fee for one app. Steam then assigns an App ID.
3. Send the App ID to Claude: it goes into the build config and the SteamPipe depot script.
4. Fill in the store page with the text and images above; submit it for review; set it to "Coming Soon".
5. Upload the build with SteamPipe (Windows `GROW EVERYTHING.exe` as the launch option), submit the build for review.
6. Release no earlier than 30 days after paying the fee and 2 weeks after the store page went public.
