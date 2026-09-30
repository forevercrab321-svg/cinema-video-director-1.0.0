# GROW EVERYTHING — Game Design

Brief: [`game/CLAUDE.md`](../game/CLAUDE.md). Balance: [`progression.md`](progression.md). Status: **Phase 1 (greybox), 60-second prototype.**

## Design brief

| | |
| --- | --- |
| Player promise | Something that looked enormous at the start ends up looking tiny. |
| Target feeling | Scale transformation: "wait, I got bigger" → "now I can collect THAT". |
| Primary verb | Roll into things to absorb them (magnetic intake). |
| Secondary verbs | Dash (Space); shove objects that are almost absorbable; bump into objects that are too big (they teach the next goal). |
| Repeats every 5–30 s | Sweep a cluster, gain mass, see the collector swell, see the next class light up. |
| Changes over 1–5 min | Size class: alley debris → street furniture → dumpsters → (Phase 2+) vehicles, structures, warehouse. |
| Lose / learn / restart | No fail state in the MVP. The pressure is the pacing: the locked class you keep bumping into. R restarts instantly. |
| Rewarded | Efficient routes through dense clusters; going for the newly unlocked class. |
| Better players | Chain clusters without stopping, use dash between clusters, read locked colours to plan the route. |
| Next decision communicated by | Locked objects are desaturated; the HUD shows `NEXT: <class> · <kg>`; a bump shows `TOO BIG · GROW TO X KG`. |
| Non-goals (this slice) | Destruction physics, audio, production art, mobile, zones C–G gameplay. |

## Core loop contract

The player **rolls into objects** to **absorb them and grow** while **locked, oversized objects block the way** and create the desire to grow. Success gives **mass, visible size, and new object classes**. The "failure" state is being too small, which costs **a detour and shows exactly how much mass is needed**.

| Clause | Implemented as |
| --- | --- |
| Verb mapped to real input | WASD/arrows camera-relative, Space dash, mouse-drag orbit, R restart (`core/Input.ts`). Verified by the keyboard smoke test. |
| Objective visible | HUD mass, growth bar, `NEXT:` class; locked objects desaturated; onboarding beacon on the first collectible. |
| Pressure in the first minute | The dumpster (class 4) blocks half the alley and every car is locked; bumping shows the mass required. |
| Reward changes state | Mass → diameter (cube-root law) → power → new classes, speed and camera. |
| Failure teaches | Bump toast names the object and the kg needed. |
| Fast restart | R resets the seeded world in one frame. |

## Level plan — Scrap City (MVP build)

The layout data lives in `game/src/world/scrapCity.ts`. −Z points downtown. Playable bounds are x ±80, z −126…36. North of the street, anything beyond x ±44 is closed off by street-end blocks.

| Zone | Content (class) | Role |
| --- | --- | --- |
| A Alley (x ±3.5, z 0–36) | scrap, cans, bottles, bricks (0–1) → boxes, bags, cones (2) → bins, chairs, bike (3) → dumpster (4) | Start, first growth, first "impossible" object |
| B Street + sidewalks | café furniture, bins, bikes (3); vending machine, dumpster, utility cabinets, motorcycle bay (4); parked cars and a van (5); delivery truck (6) | Class 3–4 payoff, cars as the next promise |
| C Parking lot | 19 cars and 5 vans (5), shopping carts (3) | The first "I can eat THAT" moment |
| D Construction site (x < −36) | a hoarding line to smash through (4); pallets, pallet stacks, jersey barriers (3–4); generators, pipe stacks, scaffold towers (5); site cabins (one stacked), containers, excavator, tipper (6) | Big jumps in scale |
| E Industrial yard (x > +36) | container rows, some stacked two high (6), tippers, a delivery truck, an excavator (6); storage tanks (7) | The player starts eating infrastructure |
| Back lot (z < −100) | garage rows and tanks (7), containers, a tipper | Class-7 warm-up |
| Warehouse (z −67…−97) | 19 class-7 parts: 4 front panels + the sign (8 m machine); 4 back panels, 6 gable panels and 4 roof bays (9.6 m machine); pallet racks inside (6) | **The climax**, visible from the first frame |

- **Staged tear-down:** a roof bay is held up by its front and back wall panels. When either panel goes, the bay collapses (dust, shake, crumple) and can then be absorbed. The front wall and sign come off first. The rest needs about 103 t, so the tanks, garages and what is left of the yard get eaten in between. Recycling the last part wins the run; play continues as free roam.
- **Destruction types (§10, §13):**
  - `collect`: pulled in.
  - `crush` / `collapse`: flattened on the spot with sparks and shards, then pulled in.
  - `break`: splits into shards that are sucked into the intake.
  - `rip`: leans away from its anchor, then tears off.
  - Stacked objects (containers, the top site cabin, the sign) fall when what holds them up is gone.
- **Anti-frustration (§52):**
  - Debris smaller than 8 % of the machine is vacuumed from 2.6× the normal reach, so an alley the machine no longer fits into is not a dead end.
  - Every threshold keeps at least 20 % mass slack in reachable content.
- **Landmarks:** crane, warehouse, storage tanks.

## Current verdict (MVP milestones §62–65)

| Requirement | Status | Evidence |
| --- | --- | --- |
| 60-second prototype (spawn → move → collect → grow → unlock → larger object) | DONE | `npm run playtest`, 3 seeds, first 11 assertions |
| 3-minute vertical slice: alley → street → lot → first vehicle destroyed | DONE | First car recycled at 67–68 s (bot) ≈ 1.9 min human; `07-first-vehicle.png` |
| Complete MVP: 5–8 minute run ending in warehouse destruction, warehouse visible early | DONE (bot) | Warehouse destroyed at 195–205 s (bot) ≈ 5.5–5.8 min human; `10-warehouse-destroyed.png` |
| Tier transformations 1 → 4 | DONE | Tier 2 hopper/scoop, tier 3 arms/cage, tier 4 track pods, crusher jaws, cyclone, stacks; `13-tier4-machine.png` |
| Sound (§45) | DONE (procedural) | WebAudio synth: size-scaled SFX, motor drone, tier-layered music (`audio/AudioEngine.ts`); not verified by ear in the cloud session |
| "Wait, I got bigger" / "I ate the car" for a new player | NEEDS REVIEW | Needs a human playtest (the bot runs ~1.7× human speed, an assumption) |

## Arena mode — online, up to 4 players (2026-09-23)

The Creative Director extended the brief: an online competitive mode on world-city maps (overrides §53, see design-decisions).

- **Join:** open the published artifact, pick a vehicle, *加入*; friends open the shared link while signed in (given *can interact*). The host (first player) picks the city and starts; empty slots fill with AI rivals.
- **Goal:** grow bigger than everyone. Bigger machines (≥1.25× diameter) eat smaller ones. Three lives; losing the last one = 出局 (out, then spectate).
- **Round end:** 5-minute timer, last machine standing, or the city landmark torn down. Champion = largest surviving machine.
- **Balance pass (2026-09-30, `tools/arena-balance.mjs`):** the landmark opens only for the final minute (`landmarkOpenSeconds` 240; before that its parts are solid) — it used to fall at a median 3:17 and end 23/24 rounds; catch-up is log-scaled up to +160 % for trailing machines and the leader's object gains shrink once it has 2.5× the runner-up; refills are no longer blocked by a giant machine's size; AI rivals ramp from rookie (slower, shorter hunts, no hunting humans for the first ~50 s) to full skill over the host's first 4 rounds; Racer nerfed, Collector and Dozer buffed. Numbers in `game/src/config/arena.ts` and `vehicles.ts`.
- **Rewards:** combos, golden crates, power-up crates (⚡ speed, 🧲 magnet, 🛡 shield), first blood, leader bounty, catch-up gain for trailing machines, landmark finisher bonus, coins, next-city unlock; the host can start a rematch from the results. **Penalties:** crash stun and mass loss, death costs a life and 55% of mass.
- **Levels:** 1 Shanghai: shikumen lanes, Shanghai taxis and scooters, Oriental Pearl Tower. 2 New York: brownstones, lofts with water towers, yellow cabs, hot-dog carts, Empire State Building. 3 Paris: Haussmann blocks with zinc mansards, cafés, kiosks, Eiffel Tower. Bonus: Scrap City.
- **Map plan (all cities):** 192 m district; 20 m boulevards cross at a 30 m landmark plaza, 14 m streets form the outer grid. Spawns sit at the four boulevard ends facing the landmark. Starter scrap rings every spawn; houses need a 6.5 m machine, blocks 9.5 m, landmark bases 10.5 m; upper landmark parts fall and topple when a base goes.

### Warm-up while waiting for friends (2026-09-25, Creative Director request)
- A host **alone in a room friends can join** (online / claude.ai / local tabs — not solo) sees the Start button as **"Warm up vs AI · restarts when a friend joins"**; the round is flagged `wu` in the match state and always fills with AI.
- During the warm-up a bar under the timer offers **Invite** (share sheet) and **Leave warm-up** (back to the lobby at any time).
- When a friend opens the invite link, the host sees them in the lobby within ~0.5 s and **starts a fresh real round for everyone** (new epoch, everyone back to 5 kg, countdown); both see "<name> joined! New round". A friend arriving in a *real* round (2+ humans) still drops in and takes over an AI machine as before.
- Tests: `tools/.wip/warmup.mjs` (13/13), `dropin.mjs` updated to a two-human round (10/10).

### Camera modes (2026-09-26, Creative Director request)
- **Follow view** (default) and **first-person cab view**, toggled with **V** or the **🎥** button in the emote bar; the choice is remembered (`localStorage grow-arena-camera`).
- First person: the eye sits at the front of the cab (0.62 × diameter up, 0.38 × diameter forward), my own machine and ring are hidden, keys/joystick steer relative to the heading, a drag looks around and eases back after 1 s, and the FOV opens from 72° by up to +10° with speed and +8° while dashing. Scale reads strongly: at 5 kg cars and buildings tower over the camera.
- While respawning or spectating the camera falls back to the follow view. Values live in `cameraConfig` (`fp*`).
- Test: `tools/.wip/camera.mjs` (13/13); screenshots `renders/review/game/camera-*.png`.
