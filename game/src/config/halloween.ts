/**
 * HALLOWEEN TOWN — "The Hunt" (docs/halloween-mode.md). Balance for the Halloween map only;
 * every other city keeps arenaConfig as it is.
 *
 * First half: the normal arena (eat, grow, 3 lives). At `huntAt` the host locks each machine's
 * mass as its score, every machine shrinks back to `huntMass` and three horror villains rise
 * from the empty central plaza and chase everyone for `huntSeconds`. A machine they catch loses
 * its score (0) and is out of the round. Final ranking: score, then the later catch.
 */
export const HALLOWEEN_CITY = 'halloween';

export const HALLOWEEN = {
  maxPlayers: 6,
  /** Grow phase length; the hunt starts here (or earlier if the first half empties out). */
  huntAt: 300,
  huntSeconds: 300,
  /** After the scores lock: the shrink, the villains rising, the chase starting (s after the hunt starts). */
  shrinkDelay: 1,
  riseDelay: 3,
  chaseDelay: 6,
  /** Everyone runs at this mass in the second half (diameter ≈ 1 m: small again, quick enough to flee). */
  huntMass: 120,
  /** Villain size (m) and catch reach (m, added to the runner's radius). */
  hunterHeight: 3.0,
  hunterReach: 0.75,
  /** Villain speed as a share of a standard machine's top speed at huntMass, ramping over the hunt. */
  speedStart: 0.92,
  speedEnd: 1.12,
  /** Close to its target a villain lunges: speed × lungeMul for lungeSeconds, then cools down. */
  lungeRange: 6,
  lungeMul: 1.7,
  lungeSeconds: 0.6,
  lungeCooldown: 3,
  /** Villains walk through props (they are horror villains) but slower inside one. */
  phaseSlow: 0.7,
  /** Villains share the runners out: a target another villain already chases counts this many metres farther. */
  spreadPenalty: 18,
  /** Seconds of lead when aiming at a runner (cut corners instead of tail-chasing). */
  leadSeconds: 0.45,
  /** Coins by final rank 1..6 (the 4-player table extended). */
  coinsByRank: [120, 80, 55, 35, 25, 15],
  /** Heartbeat: villain closer than this (m) raises the proximity cue from 0 to 1. */
  dreadRange: 22,
} as const;

export type HunterKind = 'shock' | 'cannibal' | 'motel';

/**
 * The three villains. The own-site build shows the names the Creative Director chose; portal
 * builds (CrazyGames, GameDistribution …) show neutral nicknames, because platform review rejects
 * real people and third-party characters. Flip `PORTAL_REAL_NAMES` to show the names there too.
 */
export const PORTAL_REAL_NAMES = false;

export interface HunterDef {
  kind: HunterKind;
  name: string;
  nameZh: string;
  portalName: string;
  portalNameZh: string;
  /** Feed line when this villain catches someone. */
  catchLine: string;
  catchLineZh: string;
}

export const HUNTERS: readonly HunterDef[] = [
  { kind: 'shock', name: 'Yang Yongxin', nameZh: '杨永信', portalName: 'The Shock Doctor', portalNameZh: '电击院长', catchLine: 'zapped', catchLineZh: '电晕了' },
  { kind: 'cannibal', name: 'Hannibal', nameZh: '汉尼拔', portalName: 'The Cannibal', portalNameZh: '食人魔', catchLine: 'had for dinner', catchLineZh: '当成了晚餐' },
  { kind: 'motel', name: 'Norman Bates', nameZh: '诺曼·贝茨', portalName: 'The Motel Keeper', portalNameZh: '汽车旅馆老板', catchLine: 'checked in', catchLineZh: '请进了旅馆' },
];

const portal = (() => {
  try {
    return (import.meta as { env?: Record<string, string> }).env?.VITE_PORTAL_BUILD === '1';
  } catch {
    return false;
  }
})();

/** Display name of a villain for this build ([zh, en]). */
export function hunterName(h: HunterDef): [string, string] {
  return portal && !PORTAL_REAL_NAMES ? [h.portalNameZh, h.portalName] : [h.nameZh, h.name];
}

export const isHalloween = (city: string | undefined): boolean => city === HALLOWEEN_CITY;
