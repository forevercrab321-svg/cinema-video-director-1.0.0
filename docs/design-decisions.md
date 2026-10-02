# Design Decisions — Studio Memory

Single place for settled decisions (CLAUDE.md §19–20). Update on every approval or correction. Newest entry wins.

## Active project

**GROW EVERYTHING**: browser 3D growth/destruction game. Brief: `game/CLAUDE.md`. Status: story MVP complete; online 4-player arena with Shanghai / New York / Paris levels added (bot- and 2-tab-verified), human multiplayer session pending.

### Decisions (2026-09-23)

| Decision | Choice | Type | Reversible |
| --- | --- | --- | --- |
| Stack | Existing Vite + TS + three.js (no React/R3F) | INFERRED (§35 "use the existing stack") | Yes: systems are framework-agnostic |
| Physics | Custom circle-vs-box collision in Phase 1, Rapier from Phase 4 | INFERRED (§61 don't overbuild) | Yes |
| Power | Power = collector diameter (m); mass → diameter by a cube-root law | INFERRED | Tunable in `game/src/config` |
| Class thresholds | 0 / 0.3 / 0.6 / 0.9 / 1.5 / 3 / 5 / 8 / 14 / 25 / 50 m | INFERRED | Config |
| Tier unlocks | T2 at class 2, T3 at class 5 (vehicles), T4 at class 7, T5 at class 9 | INFERRED from §42 example | Config |
| Player identity | Grey metal plus safety-orange paint and amber intake glow | INFERRED (§27) | Phase 5 art pass |
| World orientation | Alley faces downtown (−Z); warehouse and crane in the spawn sight line | REQUIRED (§21–22 promises) | — |
| Art pass (2026-09-23) | "更加真实高端的3D": procedural PBR kit, authored props/architecture/player, sky env + GTAO + bloom; no external generation (no API keys) | REQUIRED (Creative Director) → INFERRED implementation | Yes: props/architecture are data-driven; GLB swap path documented |
| Quality tiers | high (GTAO+bloom), medium (bloom), low (none); touch devices default to medium | INFERRED | Yes |
| Sidewalk height | Raised 0.12 m visually, collision unchanged | INFERRED (realism) | Yes |
| MVP completion (2026-09-23) | "按照这个方案开始继续做。完成游戏": zones D/E, 22 new object types, staged warehouse climax, destruction types, tier 4, procedural audio, HUD objective and end card | REQUIRED (Creative Director) → INFERRED implementation | Yes: all content is data in `config/objects.ts` and `world/scrapCity.ts` |
| Warehouse as a kit | The class-8 monolith is replaced by 19 class-7 parts. The front wall and sign need 8 m; the back wall, gables and roof need 9.6 m. Roof bays collapse when a supporting wall goes | INFERRED (brief §13 hierarchical destruction) | Yes |
| Heavier top-speed curve | Exponent 0.45 → 0.36 | INFERRED (brief §08 "top speed may rise slightly") | Yes |
| **Online arena (2026-09-23)** | "可以在线游玩…最多四个…发链接连线游玩，以他们的账号…上海、纽约、巴黎…奖励机制，加上惩罚机制…出局机制跟冠军…车子的类型也可以变" — **overrides brief §53** ("no multiplayer, accounts…"): the Creative Director's latest explicit instruction wins | REQUIRED | Story mode is kept unchanged (`?mode=story` / `#story`) |
| Transport | claude.ai artifact `room` capability (presence + events) with the `user` capability for account names; no game server. Players join through the artifact's Share link (signed-in accounts given *can interact*); public-link visitors cannot join | INFERRED (only realtime channel available without a backend) | Yes: `net/Net.ts` interface; a WebSocket server can implement the same interface |
| Authority | Host = lowest joined peer id (deterministic migration). Host grants object claims, validates eats, owns match phases/clock, runs AI rivals | INFERRED | Yes |
| Round rules | 4 slots (AI fills empty ones), 5-min round, 3 lives, eat at 1.25× diameter (gain 60%), respawn keeping 45% mass with 3 s invulnerability; round ends on time, last machine standing, or landmark destroyed. Champion = most mass among survivors | INFERRED from "奖励/惩罚/出局/冠军" | `config/arena.ts` |
| Rewards / penalties | Rewards: combo multiplier, golden crates (8% of mass), first blood +20%, landmark last-part +25%, coins by rank and kills, next-city unlock on a win. Penalties: dash-crash into locked objects stuns and sheds 3% mass; being eaten costs a life and 55% mass | INFERRED | `config/arena.ts` |
| Vehicles | Collector (balanced), Dozer (reach, eats closer to its size), Racer (speed, dash), Magnet (pull reach); multipliers only, same growth model | INFERRED from "车子的类型也可以变" | `config/vehicles.ts` |
| City levels | Level 1 Shanghai (Oriental Pearl Tower), 2 New York (Empire State Building), 3 Paris (Eiffel Tower); Scrap City is a bonus map. One parametric 192 m district (`world/cities/cityKit.ts`) styled per city | REQUIRED cities → INFERRED plan | Yes: styles are data |
| **Landmark scale 1:5** | Landmarks are built at 1:5 (Pearl ≈ 94 m, ESB ≈ 97 m, Eiffel ≈ 68 m) so a machine can grow big enough to eat them within a 5-minute round; everything else is real-world scale | INFERRED — documented deviation from §07 | Yes: part sizes live in `config/objects.ts` |
| City identity pass (2026-09-23) | Signage atlas (Chinese neon, NY boards and billboards, Paris shopfronts); secondary landmarks at ~1:2.5 (Bund Customs House + Peace Hotel on a Huangpu waterfront, Flatiron, Times Square tower, Arc de Triomphe you can drive through, Métro entrances, Morris columns, subway entrances, hydrants); shaped Pudong / One WTC / La Défense skyline; traffic signals; Shanghai lantern strings | INFERRED from "全力复刻各大城市" | Yes: styles and extras are data |
| Catch-up balance | Trailing machines gain up to +60% from objects; the leader carries a +25% bounty | INFERRED (keep 4-player rounds contested) | `config/arena.ts` |
| Power-ups | Speed (+40% top speed, 8 s), magnet (1.8× pull, 8 s), shield (can't be eaten, 6 s); 5 crates of each per city, refilling | INFERRED from 奖励机制 | `config/arena.ts` |
| City BGM (2026-09-23) | Procedural per-city themes (Shanghai pentatonic guzheng/pipa funk, NY swung boom-bap, Paris musette waltz); `public/music/<city>.mp3` (Suno exports) overrides them. Claude cannot operate the user's Suno account, so the prompts are in `docs/music/suno-prompts.md` | REQUIRED (city BGM) → INFERRED implementation | Yes |
| Suno BGM adopted (2026-09-26) | "可爱洗脑" Suno tracks made by the user (paid member account, generated 2026-09-26) replace the procedural themes: Shanghai take a (120 BPM), New York take b (116), Paris take a (139, 3/4), Scrap City take b (126), victory = "Big Eater Champion" (take a), first 6.4 s. Loops are cut on the beat grid in whole 4-bar phrases (`tools/make-music-loops.py`, seam ≤ 8 ms), −14 LUFS files, trimmed in the mix to the procedural level (−36 LUFS BGM, −24 LUFS jingle) and played gaplessly from an AudioBuffer. Takes picked by loop quality and tempo fit; the user may swap any take | REQUIRED (Suno BGM + victory) → INFERRED selection | Yes: rerun the tool with other picks |
| Comedy direction (2026-09-23) | Googly eyes, bumper-car boings, burps and pops, city food quips in the kill feed, emotes/horn, joke awards. The joke is always on the eaten machine, never on a person | REQUIRED ("加点搞笑效果") → INFERRED | Yes: `arena/comedy.ts` |
| Platform (2026-09-23) | Own web + CrazyGames first, Poki next, TikTok/YouTube Shorts for acquisition, Steam after D1/D7 prove retention; sell cosmetics only, never power | INFERRED (user delegated) | See `docs/business/platform-strategy.md` |
| Backend | Supabase (Postgres + anonymous auth + Realtime rooms); results and coins written server-side | INFERRED | Net interface keeps transports swappable |
| Touch controls | Left-half floating joystick, right-half camera drag, DASH button | INFERRED (friends join from phones) | Yes |
| Arena render budget | High tier ≤ 1.5 M triangles, ≤ 350 draw calls (4 machines, 192 m district, ~1,600 objects); adaptive quality drops tiers on slow devices. Story budget unchanged (≤ 750 k / 300) | INFERRED | Measured in playtest notes |
| Realism pass (2026-09-23) | "整体视觉更真实，不要像低端3D游戏": HDRI IBL + golden-hour sun, AgX + cinematic output, weathering, interior-mapped windows, trees/weeds/decals | REQUIRED (Creative Director) → INFERRED implementation | Yes: each layer is a separate module/flag (`?tonemap`, `?quality`) |

## Locked elements

| Element | Value | Approved on | Notes |
| --- | --- | --- | --- |
| — | — | — | — |

## Approved dimensions / proportions

| Element | Value | Source (REQUIRED / INFERRED) |
| --- | --- | --- |
| — | — | — |

## Approved materials

| Material | Parameters | Used on |
| --- | --- | --- |
| — | — | — |

## Camera settings

| Camera | Location | Rotation | Lens | Sensor | Aspect | Resolution | Locked |
| --- | --- | --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | — | — | — |

## User corrections log

| Date | Feedback | Controlling parameter changed | Result |
| --- | --- | --- | --- |
| 2026-09-23 | 更加真实高端的3D | Procedural PBR kit, authored models | Phase 5 art pass |
| 2026-09-23 | 整体视觉像低端3D游戏 | Lighting (HDRI, sun 20°, AgX), post grade, surface shaders, dressing | Realism pass; budgets held |
| 2026-09-23 | 在线多人（≤4 人，账号，链接）、上海/纽约/巴黎关卡、奖惩、出局、冠军、车型 | New arena mode, `config/arena.ts`, `config/vehicles.ts`, city kit + 3 cities | All three cities finish with a champion in 3.5–4.5 min (bots); 2-tab sync test passes |
| 2026-09-23 | 全力复刻各大城市作为游戏地图，四人竞争 | City identity pass: per-city buildings, vehicles, furniture, light, skyline, landmark kits | Review renders in `renders/review/arena-*` |
| 2026-09-23 | 做成能直接卖、上线的完整游戏 | zh/en i18n; cosmetics shop (coins); settings; first-run tip; portal SDK layer (CrazyGames/Poki) with rewarded revive (75% mass, once per match), double coins, midrolls; legal pages, icons, OG image, PWA, `build:web` | Shop/revive smoke test en+zh; see `docs/business/launch-checklist.md` |
| 2026-09-23 | 分享/和好友一起玩赠送固定皮肤；付费再想想卖什么 | Friend gifts (never for sale): share → Party Hat; finish a match with 1 friend → Best Buddies skin; squad of 4 → Crown. Procedural hats (`entities/Hat.ts`). Paid proposal in `docs/business/paid-catalog.md`, SKUs in `0002_products_seed.sql` | Gift unlock + hat sync verified in test; paid items await user decision |
| 2026-09-24 | 好友拿邀请链接进不来；房主退出后好友卡住 · 分享要能一键跳 TikTok / IG / 微信 / 小红书 | Drop-in join (takes over an AI rival), sticky host that skips left/frozen players, online heartbeats + goodbye on hide, away players re-admitted to their own machine; share sheet with system share (phones), per-app copy-and-open, WeChat QR on desktop, WhatsApp/X/Telegram/Facebook/LINE intents; clean invite links | `tools/.wip/dropin.mjs` 11/11, `fulltest.mjs` 31/31, net4, 3-city rounds, story 24/24 |
| 2026-10-02 | 万圣节主题地图（小鬼、墓地、骷髅、吸血鬼、狼人、南瓜、女巫），中间先空着；时间翻倍；下半场全部变小，三个恐怖角色（杨永信、汉尼拔、诺曼·贝茨）追人，被抓分数归零；6 人房；万圣节恐怖 BGM（Suno） | New map `halloween` (city kit options, themed props), `config/halloween.ts` (huntAt 300, huntSeconds 300, huntMass 120, 6 seats), `arena/hunt.ts`, `entities/HunterModel.ts`, migration 0007, procedural BGM + SFX, Suno prompts §7. Confirmed with the user: mode on the Halloween map only; caught = score 0 and out (spectate); cartoon models with costume + names (portal builds show neutral nicknames, `PORTAL_REAL_NAMES`) | Spec `docs/halloween-mode.md`; tests `tools/halloween-test.mjs`, SQL suite |
| 2026-09-23 | 完成游戏 | Content, destruction, climax, tier 4, audio, HUD; reward table and speed curve rebalanced | Full MVP run passes 24/24 on 3 seeds |

## Pending issues

- Arena: landmark and building models are procedural approximations (1:5 landmarks); no photoreal facades or signage text per city yet.
- Arena: mid-game plateau around 1.5–3 t (class 5→6) is still ~40 s.
- Arena: needs a real 4-human session on claude.ai to validate latency feel (tested with 2 local tabs + AI).

- Plaster facade still flat and yellow in direct sun.
- Skyline towers are simple boxes.
- VFX and HUD are below premium (Phase 6).
- Photoscanned textures would need a reachable asset host or user-supplied files.
