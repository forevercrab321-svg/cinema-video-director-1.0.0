import { arenaConfig as A } from '../config/arena';
import { growthConfig } from '../config/growth';

/**
 * Plausibility ledger for machines simulated on other pages (audit 2026-10-01: lied-about mass).
 *
 * A player's own page owns its mass and reports it in presence, so a modified client could
 * claim any mass. That mass then drove eat checks, the standings and the match results.
 * Every client therefore keeps the most mass each remote machine can have earned, built
 * only from the decisions the host broadcasts:
 *   · the starting / drop-in mass the roster gives it;
 *   · each object the host granted it, at the best multipliers a legitimate pickup can reach
 *     (combo × catch-up; gold crates and the landmark's last piece scale with mass);
 *   · each eat the host confirmed (exact gain), and each time it was eaten (at most what a
 *     rewarded revive keeps).
 * Reported mass above that cap is clamped, so a liar can never be bigger than the best possible
 * honest play. Kills are capped by confirmed eats in the same way. The host also sends its caps
 * in the match beacon, so a page that missed a grant catches up, and a new host continues from
 * the old host's numbers.
 */
export interface LedgerDef {
  rewardMass: number;
  bonus?: boolean;
  climax?: boolean;
}

/** The best a legitimate pickup multiplies an object's reward by (combo × catch-up). */
export const MAX_PICKUP_MULT = A.comboMax * (1 + A.catchUpMax);
/** Rounding on the wire (mass to 0.1 kg) and timing slack. */
const MASS_SLACK = 1.02;
const MASS_FLAT = 0.5;

export class MassLedger {
  private readonly cap = new Map<string, number>();
  private readonly kills = new Map<string, number>();
  /** Reports that were clamped (diagnostics / tests). */
  clamped = 0;

  /** The roster (or a drop-in) decided this machine's mass. */
  set(id: string, mass: number, kills = this.kills.get(id) ?? 0): void {
    this.cap.set(id, Math.max(growthConfig.startMass, mass));
    this.kills.set(id, kills);
  }

  /** The host granted object `def` to `id`; `lastClimax` = it is the landmark's last piece. */
  grant(id: string, def: LedgerDef, lastClimax: boolean): void {
    const cap = this.cap.get(id);
    if (cap === undefined) return;
    let gain = def.bonus ? Math.max(def.rewardMass, cap * A.goldCrateShare) : def.rewardMass;
    gain *= MAX_PICKUP_MULT;
    if (lastClimax) gain += cap * A.landmarkBonus;
    this.cap.set(id, cap + gain);
  }

  /** The host confirmed `attacker` ate `victim` for `gain`. */
  eaten(victim: string, attacker: string, gain: number): void {
    const a = this.cap.get(attacker);
    if (a !== undefined) this.cap.set(attacker, a + Math.max(0, gain));
    this.kills.set(attacker, (this.kills.get(attacker) ?? 0) + 1);
    // The victim keeps a share; a rewarded revive keeps the most (reviveMassKeep of its death mass).
    const v = this.cap.get(victim);
    if (v !== undefined) this.cap.set(victim, Math.max(growthConfig.startMass, v * Math.max(A.reviveMassKeep, A.respawnMassKeep)));
  }

  clampMass(id: string, reported: number): number {
    const cap = this.cap.get(id);
    if (cap === undefined) return reported;
    const max = cap * MASS_SLACK + MASS_FLAT;
    if (reported <= max) return reported;
    this.clamped++;
    return max;
  }

  clampKills(id: string, reported: number): number {
    const k = this.kills.get(id);
    if (k === undefined || reported <= k) return reported;
    this.clamped++;
    return k;
  }

  capOf(id: string): number | undefined {
    return this.cap.get(id);
  }

  /** Host → beacon: [slot, cap kg (0.1), kills] for every machine it knows. */
  toWire(slotOf: (id: string) => number): number[][] {
    const out: number[][] = [];
    for (const [id, cap] of this.cap) {
      const slot = slotOf(id);
      if (slot >= 0) out.push([slot, Math.ceil(cap * 10) / 10, this.kills.get(id) ?? 0]);
    }
    return out;
  }

  /** Beacon → here: raise to the host's numbers (a missed grant must not clamp an honest player). */
  fromWire(rows: unknown, idOf: (slot: unknown) => string | null): void {
    if (!Array.isArray(rows)) return;
    for (const row of rows.slice(0, 8)) {
      if (!Array.isArray(row) || row.length < 3 || !row.every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
      const id = idOf(row[0]);
      if (!id) continue;
      const cap = Math.min(row[1] as number, 1e7);
      if (cap > (this.cap.get(id) ?? 0)) this.cap.set(id, cap);
      const k = Math.min(Math.max(0, Math.floor(row[2] as number)), 99);
      if (k > (this.kills.get(id) ?? 0)) this.kills.set(id, k);
    }
  }
}
