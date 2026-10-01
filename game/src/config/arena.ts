/**
 * ARENA — competitive multiplayer balance (central config, like growth.ts).
 * Up to 4 machines grow in the same city. Bigger machines eat smaller ones; each machine has
 * 3 lives; the round ends on the timer, when one machine is left, or when the city's landmark
 * is torn down. Champion = most mass at the end (survivors rank above eliminated machines).
 */
export const arenaConfig = {
  maxPlayers: 4,
  roundSeconds: 300,
  countdownSeconds: 3,
  resultsSeconds: 12,
  lives: 3,
  /** Eat another machine when your diameter is at least this multiple of theirs. */
  eatRatio: 1.25,
  /** Overlap needed: centres closer than attacker radius × this. */
  eatReach: 0.95,
  /** Share of the victim's mass the attacker gains. */
  eatGain: 0.6,
  firstBloodBonus: 0.2,
  /** Victim keeps this share of mass (never below the start mass) and respawns after a delay. */
  respawnMassKeep: 0.45,
  /** Rewarded-ad revive (once per match) keeps this share of the mass instead. */
  reviveMassKeep: 0.75,
  /** Drop-in players who do not inherit a machine start at this share of the field's median mass. */
  dropInMassShare: 0.35,
  /** No drop-in during the last seconds of a round (join the next one instead). */
  dropInCutoffSeconds: 25,
  /** Hidden longer than this during a round = away: step out and rejoin on return (ms). */
  awayMs: 5000,
  respawnDelay: 3,
  invulnerableSeconds: 3,
  /** Chain absorbs within this window to build a combo (+10 % per step, capped). */
  comboWindow: 1.6,
  comboStep: 0.1,
  comboMax: 1.6,
  /** Golden crates: worth this share of the collector's current mass (minimum rewardMass). */
  goldCrateShare: 0.08,
  goldCrateCount: 12,
  /**
   * Arena-only object reward scale per city, indexed by size class (missing = 1; story mode keeps
   * OBJECT_TYPES values). Scrap City is the story map: a linear alley → street → lot path laid
   * out for one player, so its class 3–4 street furniture (chairs, bins, café tables, bikes,
   * motorbikes, barriers, pallets) sits packed along the spawns' first 40 m — ~10× the other
   * cities' density there, chained into combos (tools/spawn-food.mjs). Audit (tools/arena-balance.mjs,
   * median leader mass): Scrap 913 / 15,537 / 47,195 kg at 30 / 90 / 120 s and a first car at 62 s,
   * vs ~150 / ~1,900 / 2,700–9,400 kg and 104–120 s in the other cities. Scaling class 3 to 0.3 and
   * class 4 to 0.6 brings Scrap to ~300 / ~2,000 / ~4,700 kg and a first car at ~119 s.
   */
  cityRewardScale: { scrap: [1, 1, 0.9, 0.3, 0.6] } as Readonly<Record<string, readonly number[]>>,
  /** The machine that recycles the last landmark part gains this share of its mass. */
  landmarkBonus: 0.25,
  /** Penalty: slamming a locked object while dashing stuns and sheds mass. */
  crashStunSeconds: 0.8,
  crashMassLoss: 0.03,
  /**
   * Refill (host): absorbed small and medium props (class ≤ refillMaxClass — trucks and containers
   * too since the 2026-09-30 audit, when more machines reach class 6 and ran dry there; not landmark parts,
   * not stacked) respawn at home after refillDelay + class × refillPerClass seconds, when no
   * machine is within refillClearance m — so a 5-minute round with 4 machines never runs dry
   * and a respawned machine always has something to rebuild with.
   */
  refillMaxClass: 6,
  refillDelay: 25,
  refillPerClass: 4,
  refillClearance: 12,
  /**
   * A machine's own size widens the clearance by 2 × diameter, capped here (audit: a 20 m
   * leader blocked refills within ~52 m — a quarter of the map — and starved mid-size machines;
   * no-food time rose from 3 % to 8 % once rounds ran longer).
   */
  refillClearanceMaxExtra: 14,
  refillCheckSeconds: 2,
  refillPerCheck: 16,
  /** AI rivals ignore prey worth less than this share of their own mass (no endless chases). */
  botPreyMinShare: 0.04,
  botHuntGiveUp: 6,
  /**
   * AI difficulty ramp (balance audit 2026-09-30, tools/arena-balance.mjs): skill 0..1 comes from
   * the host's finished rounds — botSkillRookie on the first round, full skill after
   * botSkillRounds. Low skill = slower decisions (think interval × 1 + (1 − skill) × botThinkSlow),
   * a shorter hunt radius (× botHuntRangeRookie at skill 0), rarer dashes, and a grace period
   * (botHumanGraceSeconds × (1 − skill)) before AI rivals hunt human players at all.
   */
  botSkillRookie: 0.3,
  botSkillRounds: 4,
  botThinkSlow: 1.4,
  botHuntRangeRookie: 0.45,
  botHumanGraceSeconds: 75,
  /**
   * Rookie AI neither chases nor eats a human worth less than (1 − skill) × this share of its own
   * mass — they bounce off (ArenaGame.spares). Audit: a new player lost 2 of 3 lives, mostly to
   * giant rivals hunting or driving over them at a tenth of their size.
   */
  botRookieHumanPreyShare: 0.4,
  /**
   * Catch-up (audit: leader held 96 % of all mass at the end, 27× second place): a machine
   * behind the leader gains up to catchUpMax extra from objects, scaled by log(lead / mass) and
   * full at catchUpFullRatio; eating the current leader pays a bounty.
   */
  catchUpMax: 1.6,
  catchUpFullRatio: 12,
  leaderBounty: 0.25,
  /**
   * Leader drag: once the leader has leaderDragFrom × the runner-up's mass, its object gains
   * shrink as (leaderDragFrom × second / mass) ^ leaderDragExp, never below leaderDragMin.
   * The leader still grows (and still wins), but the field stays in the race.
   */
  leaderDragFrom: 2.5,
  leaderDragExp: 0.5,
  leaderDragMin: 0.35,
  /**
   * Landmark opens at this match time (audit: it fell at a median 197 s, ending 23/24 rounds
   * early and handing the leader +25 % — as early as 73 s in Scrap City). Until then its parts
   * are solid to everyone; the final minute becomes a race to topple it.
   */
  landmarkOpenSeconds: 240,
  /** Power-up crates (refill like other small props). */
  powerCount: 5,
  speedMul: 1.4,
  speedSeconds: 8,
  magnetMul: 1.8,
  magnetSeconds: 8,
  shieldSeconds: 6,
  /** Coins (local reward currency) by final rank 1..4, plus per kill. */
  coinsByRank: [100, 60, 35, 20],
  coinsPerKill: 15,
  /** Network cadence. */
  grantBatchMs: 90,
  matchBeaconMs: 1000,
} as const;
