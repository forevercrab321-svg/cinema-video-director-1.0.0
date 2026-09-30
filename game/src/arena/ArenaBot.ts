import { arenaConfig as A } from '../config/arena';
import { createSeededRandom } from '../core/rng';
import type { WorldObject } from '../world/World';
import type { Actor, ArenaGame } from './ArenaGame';

/**
 * AI rival for the arena (run by the host). Priorities, re-evaluated every few hundred ms:
 *   1. flee a machine that can eat it,
 *   2. hunt a machine it can eat when one is close,
 *   3. otherwise collect: nearest worthwhile object, favouring golden crates and big classes.
 * Skill (game.botSkill, 0..1) softens rookie rounds: slower decisions, a shorter hunt radius,
 * rarer dashes, and no hunting human players during a grace period (arenaConfig.bot*).
 * Output is a world-space direction, like the player's input after camera mapping.
 */
export class ArenaBot {
  private target: WorldObject | null = null;
  private prey: Actor | null = null;
  private threat: Actor | null = null;
  private thinkAt = 0;
  private checkAt = 0;
  private lastDist = Infinity;
  private readonly blacklist = new Map<number, number>();
  private wanderUntil = 0;
  private wx = 0;
  private wz = -1;
  private nextDash = 0;
  private huntStart = 0;
  private readonly spared = new Map<string, number>();
  private readonly rand: () => number;

  constructor(seed: number) {
    this.rand = createSeededRandom(seed);
  }

  intents(game: ArenaGame, me: Actor): { dx: number; dz: number; dash: boolean } {
    const t = game.time;
    if (t >= this.thinkAt) this.think(game, me);
    let dx = 0;
    let dz = -1;
    let dash = false;
    if (t < this.wanderUntil) {
      dx = this.wx;
      dz = this.wz;
    } else if (this.threat) {
      dx = me.x - this.threat.x;
      dz = me.z - this.threat.z;
      dash = t > this.nextDash;
    } else if (this.prey) {
      dx = this.prey.x - me.x;
      dz = this.prey.z - me.z;
      dash = Math.hypot(dx, dz) < 6 + me.diameter * 2 && t > this.nextDash;
    } else if (this.target) {
      dx = this.target.x - me.x;
      dz = this.target.z - me.z;
      const dist = Math.hypot(dx, dz);
      if (t >= this.checkAt) {
        if (this.lastDist !== Infinity && this.lastDist - dist < 0.08 * Math.max(1, me.diameter)) {
          this.blacklist.set(this.target.id, t + 6);
          this.target = null;
          const side = this.rand() < 0.5 ? 1 : -1;
          this.wx = (-dz / (dist || 1)) * side;
          this.wz = (dx / (dist || 1)) * side;
          this.wanderUntil = t + 0.7;
        }
        this.lastDist = dist;
        this.checkAt = t + 0.8;
      }
      dash = dist > 4 + me.diameter * 3 && t > this.nextDash;
    }
    if (dash) this.nextDash = t + (2.2 + this.rand() * 1.5) * (1 + (1 - game.botSkill) * A.botThinkSlow);
    const len = Math.hypot(dx, dz) || 1;
    [dx, dz] = this.avoid(game, me, dx / len, dz / len);
    return { dx, dz, dash };
  }

  private think(game: ArenaGame, me: Actor): void {
    const skill = Math.min(1, Math.max(0, game.botSkill));
    this.thinkAt = game.time + (0.25 + this.rand() * 0.15) * (1 + (1 - skill) * A.botThinkSlow);
    const huntRange = A.botHuntRangeRookie + (1 - A.botHuntRangeRookie) * skill;
    const graceOver = game.matchTime >= A.botHumanGraceSeconds * (1 - skill);
    const prevPrey = this.prey;
    this.threat = null;
    this.prey = null;
    let bestThreat = Infinity;
    let bestPrey = Infinity;
    for (const o of game.actors) {
      if (o === me || !o.alive) continue;
      const d = Math.hypot(o.x - me.x, o.z - me.z);
      if (game.canEat(o, me) && d < 10 + o.diameter * 3 && d < bestThreat) {
        bestThreat = d;
        this.threat = o;
      } else if (
        game.canEat(me, o) &&
        d < (22 + me.diameter * 3) * huntRange &&
        (o.kind === 'bot' || graceOver) &&
        d < bestPrey &&
        // Not worth the chase: tiny prey, or one it already failed to catch.
        (o.mass >= me.mass * A.botPreyMinShare || d < me.diameter) &&
        !game.spares(me, o) &&
        (this.spared.get(o.id) ?? 0) <= game.time
      ) {
        bestPrey = d;
        this.prey = o;
      }
    }
    const prey = this.prey as Actor | null;
    if (prey !== prevPrey) this.huntStart = game.time;
    else if (prey && game.time - this.huntStart > A.botHuntGiveUp) {
      this.spared.set(prey.id, game.time + A.botHuntGiveUp);
      this.prey = null;
    }
    if (this.target && (this.target.state !== 'idle' || game.grants.has(this.target.id) || !game.eligible(this.target, me.power))) this.target = null;
    if (!this.target) {
      let best: WorldObject | null = null;
      let bestScore = Infinity;
      for (const o of game.world.objects) {
        if (!game.eligible(o, me.power) || game.grants.has(o.id)) continue;
        if ((this.blacklist.get(o.id) ?? 0) > game.time) continue;
        const d = Math.hypot(o.x - me.x, o.z - me.z);
        // Worth the trip: reward mass (diminishing), so growing rivals move on from dust to bigger prizes.
        const value = Math.sqrt(Math.max(0.05, o.def.rewardMass)) * (o.def.bonus ? 2 : o.def.power ? 6 : 1) * (o.def.objectClass === me.cls ? 1.4 : 1);
        // Squared distance: a nearby can beats a prize across the map, unless the prize is much bigger.
        const score = (d + 1.5) * (d + 1.5) / value;
        if (score < bestScore) {
          bestScore = score;
          best = o;
        }
      }
      this.target = best;
      this.lastDist = Infinity;
      this.checkAt = game.time + 0.8;
    }
  }

  private avoid(game: ArenaGame, me: Actor, dx: number, dz: number): [number, number] {
    const r = me.diameter * 0.5;
    const ahead = me.diameter * 0.9 + 0.4;
    for (const deg of [0, 30, -30, 60, -60, 90, -90, 120, -120]) {
      const a = (deg * Math.PI) / 180;
      const cx = dx * Math.cos(a) - dz * Math.sin(a);
      const cz = dx * Math.sin(a) + dz * Math.cos(a);
      if (!game.isBlocked(me.x + cx * ahead, me.z + cz * ahead, r, me.power, this.target)) return [cx, cz];
    }
    return [dx, dz];
  }
}
