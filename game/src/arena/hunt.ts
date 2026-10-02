import * as THREE from 'three';
import { skipAO } from '../art/layers';
import { HALLOWEEN as H, HUNTERS, hunterName, type HunterDef } from '../config/halloween';
import { growthConfig, movementConfig as MC } from '../config/growth';
import { HunterModel, type HunterPose } from '../entities/HunterModel';
import { diameterForMass } from '../systems/growth';
import { L } from '../i18n';
import type { Actor, ArenaGame } from './ArenaGame';

/**
 * THE HUNT — second half of a Halloween round (docs/halloween-mode.md, config/halloween.ts).
 *
 * The host stamps the hunt start (`hk`) and the locked scores into the match; every client then
 * runs the same timeline from it: scores lock → machines shrink (each owner shrinks its own) →
 * three villains rise from the empty central plaza → the chase. The host simulates the villains
 * (sent ~20 Hz in its presence, like the AI rivals) and decides catches; everyone else mirrors.
 */
export type HuntStage = 'grow' | 'locked' | 'rise' | 'chase';

/** Wire row of one villain: x, z, heading, pose code, target slot (−1 none). */
export type HunterWire = [number, number, number, number, number];

const POSES: HunterPose[] = ['idle', 'rise', 'chase', 'lunge', 'grab'];

export interface Hunter {
  def: HunterDef;
  model: HunterModel;
  x: number;
  z: number;
  heading: number;
  speed: number;
  pose: HunterPose;
  target: Actor | null;
  thinkAt: number;
  lungeUntil: number;
  lungeReadyAt: number;
  /** After a catch the villain savours it for a moment (others get a chance to run). */
  restUntil: number;
  /** Mirror (non-host): last network sample. */
  net: { x: number; z: number; heading: number } | null;
  inProp: boolean;
}

export class Hunt {
  /** Match time the hunt started (scores locked), or null while the round is still growing. */
  start: number | null = null;
  /** Locked scores by machine id. */
  readonly scores = new Map<string, number>();
  /** Caught machines: id → match time. */
  readonly caught = new Map<string, number>();
  readonly hunters: Hunter[] = [];
  private shrunk = false;
  private announced: Record<string, boolean> = {};
  private dreadTimer = 0;
  private readonly nearBuf: import('../world/World').WorldObject[] = [];

  constructor(private readonly g: ArenaGame) {
    const ring = 6;
    HUNTERS.forEach((def, i) => {
      const a = (i / HUNTERS.length) * Math.PI * 2 + Math.PI / 2;
      const model = new HunterModel(def.kind, H.hunterHeight);
      skipAO(model.root);
      model.setVisible(false);
      g.scene.add(model.root);
      this.hunters.push({ def, model, x: Math.cos(a) * ring, z: Math.sin(a) * ring, heading: Math.atan2(-Math.cos(a), -Math.sin(a)), speed: 0, pose: 'rise', target: null, thinkAt: 0, lungeUntil: 0, lungeReadyAt: 0, restUntil: 0, net: null, inProp: false });
    });
  }

  // ── Timeline ────────────────────────────────────────────────────────────────
  stage(t = this.g.matchTime): HuntStage {
    if (this.start === null || t < this.start) return 'grow';
    const s = t - this.start;
    if (s < H.riseDelay) return 'locked';
    if (s < H.chaseDelay) return 'rise';
    return 'chase';
  }

  /** Eating (objects and machines) stops once the scores are locked. */
  locked(): boolean {
    return this.start !== null && this.g.matchTime >= this.start;
  }

  /** Match time the round ends. */
  endsAt(): number {
    return (this.start ?? H.huntAt) + H.huntSeconds;
  }

  /** Seconds until the next milestone the HUD counts down to (hunt start, then the end). */
  timeLeft(): number {
    return Math.max(0, (this.start === null ? H.huntAt : this.endsAt()) - this.g.matchTime);
  }

  /** The host's word: hunt start and locked scores (idempotent). */
  setStart(t: number, scores: Map<string, number>): void {
    if (this.start === null) this.start = t;
    for (const [id, s] of scores) if (!this.scores.has(id)) this.scores.set(id, s);
  }

  /** Locked score of a machine (0 once caught; its live mass before the lock). */
  scoreOf(a: Actor): number {
    if (this.caught.has(a.id)) return 0;
    if (this.start === null) return a.mass;
    return this.scores.get(a.id) ?? 0;
  }

  /** A runner the villains may catch right now. */
  private prey(a: Actor): boolean {
    return a.alive && !a.left && !this.caught.has(a.id) && this.g.matchTime >= a.invulnerableUntil;
  }

  /** Standard machine top speed at the hunt mass (villain speeds are a share of it). */
  private refSpeed(): number {
    return MC.baseTopSpeed * Math.pow(diameterForMass(H.huntMass) / growthConfig.startDiameter, MC.topSpeedExponent);
  }

  // ── Per frame ───────────────────────────────────────────────────────────────
  update(dt: number, host: boolean): void {
    const g = this.g;
    const st = this.stage();
    if (st === 'grow') return;
    const s = g.matchTime - this.start!;
    if (!this.announced.locked) {
      this.announced.locked = true;
      g.onEvent?.({ kind: 'scoresLocked' });
      g.atmosphere?.onScoresLocked();
      g.hud.showBanner(L('上半场结束 · 分数已锁定', 'HALF TIME · SCORES LOCKED'), L('马上变小……有东西要来了', 'Shrinking… something is coming'), 2.6);
      g.onFeed?.(L('🎃 分数已锁定。下半场：别被抓住，被抓分数清零！', '🎃 Scores locked. Second half: don’t get caught — caught = score 0!'), 'bonus');
    }
    if (!this.shrunk && s >= H.shrinkDelay) {
      this.shrunk = true;
      this.shrinkAll();
    }
    if (st !== 'locked' && !this.announced.rise) {
      this.announced.rise = true;
      g.onEvent?.({ kind: 'hunterRise' });
      g.atmosphere?.onHuntStart();
      g.effects.pulse(0, 0, 30, 1.6);
      g.effects.addTrauma(0.35);
    }
    if (st === 'chase' && !this.announced.chase) {
      this.announced.chase = true;
      g.onEvent?.({ kind: 'huntStart' });
      const names = this.hunters.map((h) => hunterName(h.def));
      g.hud.showBanner(L('快逃！', 'RUN!'), L(`${names.map((n) => n[0]).join('、')} 来抓人了`, `${names.map((n) => n[1]).join(', ')} are hunting you`), 3);
    }
    for (const h of this.hunters) {
      if (st === 'locked') {
        h.model.setVisible(false);
        continue;
      }
      h.model.setVisible(true);
      if (st === 'rise') {
        h.pose = 'rise';
        h.speed = 0;
      } else if (host) this.think(h, dt);
      else this.follow(h, dt);
    }
    if (host && st === 'chase') this.resolveOverlap();
  }

  /** Presentation (every frame, after the simulation). */
  present(dt: number): void {
    const st = this.stage();
    if (st === 'grow' || st === 'locked') return;
    const riseT = st === 'rise' ? Math.min(1, (this.g.matchTime - this.start! - H.riseDelay) / (H.chaseDelay - H.riseDelay)) : 1;
    for (const h of this.hunters) h.model.update(dt, h.x, h.z, h.heading, h.speed, this.g.city.groundHeight(h.x, h.z), h.pose, riseT);
    // Proximity dread for the audio (~10 Hz): the nearest villain to what this viewer watches.
    this.dreadTimer += dt;
    if (this.dreadTimer >= 0.1) {
      this.dreadTimer = 0;
      const f = this.g.local?.alive ? this.g.local : null;
      let level = 0;
      if (f && st === 'chase') for (const h of this.hunters) level = Math.max(level, 1 - Math.hypot(h.x - f.x, h.z - f.z) / H.dreadRange);
      this.g.onEvent?.({ kind: 'hunterNear', level: Math.max(0, level) });
    }
  }

  // ── The shrink ──────────────────────────────────────────────────────────────
  /** Each client shrinks the machines it owns and brings back anyone eliminated in the first half. */
  private shrinkAll(): void {
    const g = this.g;
    for (const a of g.actors) {
      g.effects.pulse(a.x, a.z, a.diameter * 2, 0.8);
      g.effects.burst(a.x, a.diameter * 0.5, a.z, new THREE.Color(0xff8a1f), 18, Math.max(0.05, a.diameter * 0.06), 2 + a.diameter);
      if (!a.owned || a.left || this.caught.has(a.id)) continue;
      g.setMass(a, H.huntMass);
      a.diameter = a.targetDiameter;
      a.alive = true;
      a.eliminated = false;
      a.lives = 1;
      a.speed = 0;
      a.respawnAt = 0;
      a.stunUntil = 0;
      a.invulnerableUntil = this.start! + H.chaseDelay;
      a.shieldUntil = a.speedUntil = a.magnetUntil = 0;
      a.model.setTier(a.tier, false);
      if (a.kind === 'local') {
        g.rig.snap(a.x, a.z, a.heading, a.diameter);
        g.world.applyEligibility(a.power);
      }
    }
  }

  // ── Host: villain AI ────────────────────────────────────────────────────────
  private think(h: Hunter, dt: number): void {
    const g = this.g;
    const t = g.matchTime;
    if (t < h.restUntil) {
      h.speed = 0;
      h.pose = 'grab';
      return;
    }
    if (t >= h.thinkAt || !h.target || !this.prey(h.target)) {
      h.thinkAt = t + 0.5;
      // Share the runners out: a runner another villain already chases counts farther away.
      let best: Actor | null = null;
      let bestScore = Infinity;
      for (const a of g.actors) {
        if (!a.alive || a.left || this.caught.has(a.id)) continue;
        const taken = this.hunters.some((o) => o !== h && o.target === a);
        const score = Math.hypot(a.x - h.x, a.z - h.z) + (taken ? H.spreadPenalty : 0);
        if (score < bestScore) {
          bestScore = score;
          best = a;
        }
      }
      h.target = best;
    }
    const a = h.target;
    if (!a) {
      h.speed *= Math.exp(-3 * dt);
      h.pose = 'idle';
      return;
    }
    // Aim where the runner will be (cut corners instead of tail-chasing).
    const lead = H.leadSeconds;
    const ax = a.x - Math.sin(a.heading) * a.speed * lead;
    const az = a.z - Math.cos(a.heading) * a.speed * lead;
    const dist = Math.hypot(a.x - h.x, a.z - h.z);
    const want = Math.atan2(-(ax - h.x), -(az - h.z));
    const diff = Math.atan2(Math.sin(want - h.heading), Math.cos(want - h.heading));
    h.heading += THREE.MathUtils.clamp(diff, -3.4 * dt, 3.4 * dt);
    const k = THREE.MathUtils.clamp((t - this.start! - H.chaseDelay) / (H.huntSeconds - H.chaseDelay), 0, 1);
    let speed = this.refSpeed() * (H.speedStart + (H.speedEnd - H.speedStart) * k);
    if (dist < H.lungeRange && t >= h.lungeReadyAt && Math.abs(diff) < 0.6) {
      h.lungeUntil = t + H.lungeSeconds;
      h.lungeReadyAt = t + H.lungeCooldown;
    }
    const lunging = t < h.lungeUntil;
    if (lunging) speed *= H.lungeMul;
    // Through props, but slower inside one.
    if (g.frame % 4 === 0) {
      h.inProp = false;
      for (const o of g.world.near(h.x, h.z, 1.2, this.nearBuf)) {
        if (o.state === 'idle' && o.def.objectClass >= 3 && Math.hypot(o.x - h.x, o.z - h.z) < o.radius) {
          h.inProp = true;
          break;
        }
      }
    }
    if (h.inProp) speed *= H.phaseSlow;
    speed *= THREE.MathUtils.clamp(Math.cos(diff), 0.35, 1);
    h.speed += (speed - h.speed) * (1 - Math.exp(-6 * dt));
    const b = g.city.bounds;
    const r = g.world.resolveStatic(h.x - Math.sin(h.heading) * h.speed * dt, h.z - Math.cos(h.heading) * h.speed * dt, 0.5);
    h.x = THREE.MathUtils.clamp(r.x, b.minX + 1, b.maxX - 1);
    h.z = THREE.MathUtils.clamp(r.z, b.minZ + 1, b.maxZ - 1);
    h.pose = lunging ? 'lunge' : 'chase';
  }

  /** Villains never stack on one spot. */
  private resolveOverlap(): void {
    for (let i = 0; i < this.hunters.length; i++)
      for (let j = i + 1; j < this.hunters.length; j++) {
        const p = this.hunters[i];
        const q = this.hunters[j];
        const dx = q.x - p.x;
        const dz = q.z - p.z;
        const d = Math.hypot(dx, dz) || 0.001;
        if (d >= 1.4) continue;
        const push = (1.4 - d) / 2;
        p.x -= (dx / d) * push;
        p.z -= (dz / d) * push;
        q.x += (dx / d) * push;
        q.z += (dz / d) * push;
      }
  }

  /** Host: runners a villain touches this frame. */
  detectCatches(): { id: string; by: number }[] {
    if (this.stage() !== 'chase') return [];
    const out: { id: string; by: number }[] = [];
    this.hunters.forEach((h, i) => {
      if (this.g.matchTime < h.restUntil) return;
      for (const a of this.g.actors) {
        if (!this.prey(a) || out.some((c) => c.id === a.id)) continue;
        if (Math.hypot(a.x - h.x, a.z - h.z) > H.hunterReach + a.diameter * 0.5) continue;
        out.push({ id: a.id, by: i });
        h.restUntil = this.g.matchTime + 1.2;
        h.target = null;
        break;
      }
    });
    return out;
  }

  /** Everyone: a catch the host decided (idempotent). */
  applyCaught(id: string, at: number, by: number): boolean {
    if (this.caught.has(id)) return false;
    const g = this.g;
    const a = g.byId.get(id);
    this.caught.set(id, at);
    if (!a) return true;
    const h = this.hunters[by] ?? this.hunters[0];
    if (a.owned) {
      a.alive = false;
      a.eliminated = true;
      a.eliminatedAt = at;
      a.speed = 0;
    }
    g.effects.shards(a.x, a.diameter * 0.5, a.z, new THREE.Color(a.vehicle.shell), 22, a.diameter * 0.12, 3 + a.diameter * 2);
    g.effects.burst(a.x, a.diameter * 0.6, a.z, new THREE.Color(0x7dff6a), 26, Math.max(0.05, a.diameter * 0.1), 4);
    g.effects.pulse(a.x, a.z, 6, 0.9);
    g.atmosphere?.onCaught(a.x, a.z);
    const [zh, en] = hunterName(h.def);
    const lost = Math.round(this.scores.get(id) ?? 0).toLocaleString('en-US');
    g.onFeed?.(L(`👻 ${a.name} 被${zh}${h.def.catchLineZh} · 分数清零（-${lost} kg）`, `👻 ${a.name} got ${h.def.catchLine} by ${en} · score reset (−${lost} kg)`), 'kill');
    const me = a === g.local;
    g.onEvent?.({ kind: 'caught', me });
    if (me) {
      g.effects.addTrauma(0.8);
      g.effects.hitStop(0.12);
      g.hud.showBanner(L('被抓住了！', 'CAUGHT!'), L(`${zh}抓住了你 · 分数清零 · 观战中`, `${en} got you · score 0 · spectating`), 3);
    }
    return true;
  }

  // ── Mirror (non-host) ───────────────────────────────────────────────────────
  wire(slotOf: (id: string) => number): HunterWire[] {
    const r = (v: number, k = 100) => Math.round(v * k) / k;
    return this.hunters.map((h) => [r(h.x), r(h.z), r(h.heading, 1000), POSES.indexOf(h.pose), h.target ? slotOf(h.target.id) : -1]);
  }

  applyWire(rows: unknown): void {
    if (!Array.isArray(rows)) return;
    rows.slice(0, this.hunters.length).forEach((row, i) => {
      if (!Array.isArray(row) || row.length < 4 || !row.slice(0, 4).every((v) => typeof v === 'number' && Number.isFinite(v))) return;
      const h = this.hunters[i];
      h.net = { x: row[0], z: row[1], heading: row[2] };
      h.pose = POSES[row[3]] ?? 'chase';
    });
  }

  private follow(h: Hunter, dt: number): void {
    const n = h.net;
    if (!n) return;
    const k = 1 - Math.exp(-10 * dt);
    const px = h.x;
    const pz = h.z;
    if (Math.hypot(n.x - h.x, n.z - h.z) > 25) {
      h.x = n.x;
      h.z = n.z;
    } else {
      h.x += (n.x - h.x) * k;
      h.z += (n.z - h.z) * k;
    }
    h.heading += Math.atan2(Math.sin(n.heading - h.heading), Math.cos(n.heading - h.heading)) * k;
    h.speed = h.speed * 0.8 + (Math.hypot(h.x - px, h.z - pz) / Math.max(dt, 1e-3)) * 0.2;
  }

  dispose(): void {
    for (const h of this.hunters) {
      this.g.scene.remove(h.model.root);
      h.model.dispose();
    }
  }
}
