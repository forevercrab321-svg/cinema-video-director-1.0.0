import * as THREE from 'three';
import { SIZE_CLASSES } from '../config/classes';
import { collectionConfig as CC, feelConfig, growthConfig, movementConfig as MC } from '../config/growth';
import { circleVsObb, type Contact } from '../core/collision';
import type { Input } from '../core/Input';
import { createSeededRandom } from '../core/rng';
import { PlayerModel } from '../entities/PlayerModel';
import { CameraRig } from '../systems/CameraRig';
import { Effects } from '../systems/Effects';
import { classForPower, diameterForMass, massForDiameter, progressToNextClass, tierForClass } from '../systems/growth';
import { Hud } from '../ui/Hud';
import { L } from '../i18n';
import type { CityDef } from '../world/city';
import { SCRAP_CITY } from '../world/cities/scrap';
import type { MaterialLibrary } from '../art/materials';
import { createSkyDome } from '../art/environment';
import { World, type WorldObject } from '../world/World';
import { LAYER_NO_AO, skipAO } from '../art/layers';

export const FIXED_DT = 1 / 60;

/** Presentation events for audio and UI; the simulation never depends on them. */
export type GameEvent =
  | { kind: 'absorb'; cls: number; mass: number; size: number; destruction: string }
  | { kind: 'crunch'; cls: number; size: number }
  | { kind: 'tier'; tier: number }
  | { kind: 'unlock'; cls: number }
  | { kind: 'bump'; size: number }
  | { kind: 'collapse'; size: number }
  | { kind: 'dash' }
  | { kind: 'win' }
  // Arena: countdown beeps, being eaten, a landmark coming down.
  | { kind: 'beep'; high: boolean }
  | { kind: 'eaten' }
  | { kind: 'landmark' }
  // Arena comedy: rubber bumps, burps, pops, horns.
  | { kind: 'boing' }
  | { kind: 'burp' }
  | { kind: 'pop' }
  | { kind: 'horn'; horn?: import('../config/cosmetics').HornSound };

/** Seconds of on-the-spot destruction before a large object is pulled in. */
const BREAK_PHASE: Record<string, number> = { collect: 0, crush: 0.32, break: 0.22, rip: 0.45, collapse: 0.35, push: 0 };

/** Everything the balance pass (design §49) measures. Times are game seconds. */
export interface Metrics {
  firstMoveAt: number | null;
  firstCollectAt: number | null;
  classUnlockAt: Record<number, number>;
  tierAt: Record<number, number>;
  firstAbsorbOfClassAt: Record<number, number>;
  objectsCollected: number;
  bumps: number;
  stuckEvents: number;
  resets: number;
  /** Game time the last climax part was absorbed (warehouse destroyed), or null. */
  climaxAt: number | null;
  climaxPartsTotal: number;
  climaxPartsLeft: number;
}

export interface PlayerState {
  x: number;
  z: number;
  heading: number;
  speed: number;
  turnVelocity: number;
  mass: number;
  diameter: number; // rendered/collision size, eases toward targetDiameter
  targetDiameter: number;
  power: number;
  cls: number;
  tier: number;
  dashTime: number;
  dashCooldown: number;
}

export class Game {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(56, 16 / 9, 0.03, 600);
  readonly world: World;
  readonly model: PlayerModel;
  readonly rig: CameraRig;
  readonly hud = new Hud();
  effects: Effects;
  readonly sun: THREE.DirectionalLight;
  readonly sky: THREE.Mesh;
  player!: PlayerState;
  metrics!: Metrics;
  time = 0;
  frame = 0;
  seed: number;
  private resets = 0;
  private readonly contact: Contact = { nx: 0, nz: 0, depth: 0 };
  private readonly beacon: THREE.Mesh;
  private beaconTarget: WorldObject | null = null;
  private shadowExtent = 0;
  /** Set once the warehouse is destroyed; the run continues as free roam. */
  won = false;
  /** Presentation hooks (audio lives outside the simulation). */
  onEvent: ((e: GameEvent) => void) | null = null;

  constructor(
    private readonly input: Input,
    seed: number,
    lib: MaterialLibrary,
    readonly city: CityDef = SCRAP_CITY,
  ) {
    this.seed = seed;
    const pal = city.palette;
    this.sun = new THREE.DirectionalLight(pal.sunColor, pal.sunIntensity);
    this.world = new World(lib, city);
    this.model = new PlayerModel(lib);
    this.scene.fog = new THREE.Fog(pal.fog, pal.fogNear, pal.fogFar); // aerial perspective: distance hazes toward the warm horizon
    this.camera.layers.enable(LAYER_NO_AO);
    this.sun.shadow.camera.layers.enable(LAYER_NO_AO);
    this.sky = createSkyDome(900, pal);
    skipAO(this.sky);
    skipAO(this.model.root); // the machine is ~40 meshes at tier 4: its sun shadow grounds it, GTAO would triple its calls
    this.scene.add(this.sky, this.world.root, this.model.root);

    // The sky-baked environment map carries most ambient light; the hemisphere adds bounce.
    // Warm ground bounce keeps shaded streets from going navy under the blue sky dome.
    const sky = new THREE.HemisphereLight(pal.hemiSky, pal.hemiGround, pal.hemiIntensity);
    sky.name = 'LIGHT_Sky';
    this.scene.add(sky);
    // Late afternoon: low warm sun from the south-west, long readable shadows (design §28).
    this.sun.name = 'LIGHT_Sun';
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 2048); // the window is ~2:1 (see focusShadow)
    this.sun.shadow.bias = -0.00025;
    this.sun.shadow.normalBias = 0.025;
    this.sun.shadow.radius = 3;
    this.scene.add(this.sun, this.sun.target);

    this.effects = new Effects(createSeededRandom(seed ^ 0x9e37));
    skipAO(this.effects.root);
    this.scene.add(this.effects.root);
    this.rig = new CameraRig(this.camera, this.world.occluders);
    input.onDrag = (dx, dy) => this.rig.drag(dx, dy);

    this.beacon = new THREE.Mesh(
      new THREE.RingGeometry(0.75, 1, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffa640, transparent: true, opacity: 0.8, depthWrite: false }),
    );
    this.beacon.name = 'FX_OnboardingBeacon';
    skipAO(this.beacon);
    this.scene.add(this.beacon);
    this.reset(seed);
  }

  reset(seed = this.seed): void {
    this.seed = seed;
    this.world.spawnObjects(seed);
    this.effects.root.removeFromParent();
    this.effects = new Effects(createSeededRandom(seed ^ 0x9e37));
    skipAO(this.effects.root);
    this.scene.add(this.effects.root);
    const d = diameterForMass(growthConfig.startMass);
    this.player = {
      x: this.city.spawn.x,
      z: this.city.spawn.z,
      heading: this.city.spawn.heading,
      speed: 0,
      turnVelocity: 0,
      mass: growthConfig.startMass,
      diameter: d,
      targetDiameter: d,
      power: d,
      cls: classForPower(d),
      tier: 1,
      dashTime: 0,
      dashCooldown: 0,
    };
    const climaxParts = this.world.objects.filter((o) => o.def.climax).length;
    this.metrics = { firstMoveAt: null, firstCollectAt: null, classUnlockAt: {}, tierAt: { 1: 0 }, firstAbsorbOfClassAt: {}, objectsCollected: 0, bumps: 0, stuckEvents: 0, resets: this.resets++, climaxAt: null, climaxPartsTotal: climaxParts, climaxPartsLeft: climaxParts };
    this.won = false;
    this.hud.hideEnd();
    this.time = 0;
    this.world.applyEligibility(d);
    this.model.setTier(1, false);
    this.rig.pitch = 1;
    this.model.update(1, d, 0, this.player.heading, this.player.x, this.player.z, 0, this.city.groundHeight(this.player.x, this.player.z));
    this.rig.snap(this.player.x, this.player.z, this.player.heading, d);
    this.updateSun();
    this.hud.setHint(0);
    this.beaconTarget = this.pickBeaconTarget();
    this.refreshHud();
  }

  /** One fixed simulation step. Presentation state (FX, camera, HUD) advances with it so test stepping renders correctly. */
  step(dt: number): void {
    this.frame++;
    this.time += dt;
    const intents = this.input.read();
    if (intents.restart) {
      this.reset(this.seed);
      return;
    }
    this.movePlayer(dt, intents.forward, intents.right, intents.dash);
    this.collideObjects();
    this.updateCollection(dt);
    this.updateCollapses(dt);
    this.world.syncInstances();

    const p = this.player;
    p.diameter += (p.targetDiameter - p.diameter) * (1 - Math.exp(-growthConfig.visualGrowthRate * dt));
    const top = this.topSpeed();
    this.model.update(dt, p.diameter, p.speed, p.heading, p.x, p.z, p.turnVelocity * Math.min(1, p.speed / top), this.city.groundHeight(p.x, p.z));
    const fx = -Math.sin(p.heading);
    const fz = -Math.cos(p.heading);
    this.effects.update(dt, 0, p.x + fx * p.diameter * 0.35, p.diameter * 0.35, p.z + fz * p.diameter * 0.35);
    this.rig.update(dt, p.x, p.z, p.heading, Math.abs(p.speed) / top, p.diameter);
    this.effects.applyShake(this.camera, this.rig.distance);
    this.updateSun();
    this.updateBeacon();
  }

  // ── Movement ────────────────────────────────────────────────────────────────
  topSpeed(): number {
    return MC.baseTopSpeed * Math.pow(this.player.targetDiameter / growthConfig.startDiameter, MC.topSpeedExponent);
  }

  private movePlayer(dt: number, forward: number, right: number, dash: boolean): void {
    const p = this.player;
    const massLog = Math.log(p.mass / growthConfig.startMass);
    const top = this.topSpeed();
    const accel = top / (MC.accelSeconds * (1 + MC.accelMassDrag * massLog));
    const turnRate = MC.baseTurnRate / (1 + MC.turnMassDrag * massLog);

    // Camera-relative input → world direction.
    const sy = Math.sin(this.rig.yaw);
    const cy = Math.cos(this.rig.yaw);
    let dx = -sy * forward + cy * right;
    let dz = -cy * forward - sy * right;
    const mag = Math.min(1, Math.hypot(dx, dz));

    p.dashCooldown = Math.max(0, p.dashCooldown - dt);
    p.dashTime = Math.max(0, p.dashTime - dt);
    if (dash && p.dashCooldown <= 0) {
      p.dashTime = MC.dash.duration;
      p.dashCooldown = MC.dash.cooldown;
      this.effects.dust(p.x, p.z, p.diameter * 0.6, 5);
      this.onEvent?.({ kind: 'dash' });
    }

    let targetSpeed = 0;
    let turn = 0;
    if (mag > 0.05) {
      dx /= mag;
      dz /= mag;
      const want = Math.atan2(-dx, -dz);
      const diff = Math.atan2(Math.sin(want - p.heading), Math.cos(want - p.heading));
      turn = THREE.MathUtils.clamp(diff, -turnRate * dt, turnRate * dt);
      p.heading += turn;
      // Heavy machines slow down to turn sharply instead of pivoting at full speed.
      targetSpeed = mag * top * THREE.MathUtils.clamp(Math.cos(diff), 0.25, 1);
      if (this.metrics.firstMoveAt === null) this.metrics.firstMoveAt = this.time;
    }
    p.turnVelocity = turn / dt / turnRate;
    if (p.dashTime > 0) targetSpeed = Math.max(targetSpeed, top) * MC.dash.speedMultiplier;
    const dv = targetSpeed - p.speed;
    p.speed += Math.sign(dv) * Math.min(Math.abs(dv), accel * (dv < 0 && mag < 0.05 ? 1.6 : 1) * dt);

    const nx = p.x - Math.sin(p.heading) * p.speed * dt;
    const nz = p.z - Math.cos(p.heading) * p.speed * dt;
    const resolved = this.world.resolveStatic(nx, nz, p.diameter * 0.47);
    p.x = resolved.x;
    p.z = resolved.z;
  }

  /** Locked objects are solid; nearly-eligible ones can be shoved ("now I can move it"). */
  private collideObjects(): void {
    const p = this.player;
    const r = p.diameter * 0.47;
    for (const o of this.world.objects) {
      if (!this.world.isSolid(o, p.power)) continue;
      if (Math.abs(o.x - p.x) > o.radius + r || Math.abs(o.z - p.z) > o.radius + r) continue;
      if (!circleVsObb(p.x, p.z, r, o.obb, this.contact)) continue;
      const ratio = p.power / o.requiredPower;
      // Heavy, stacked or anchored objects never slide; light ones can be shoved before they unlock.
      const pushable = !o.anchored && o.def.objectClass <= 5 && o.y - o.baseY < 0.05 && o.supports.length === 0;
      const share = pushable && ratio >= CC.pushPowerRatio ? THREE.MathUtils.clamp((ratio - CC.pushPowerRatio) / (1 - CC.pushPowerRatio), 0.15, 0.85) : 0;
      p.x += this.contact.nx * this.contact.depth * (1 - share);
      p.z += this.contact.nz * this.contact.depth * (1 - share);
      if (share > 0) {
        const pushed = this.world.resolveStatic(o.x - this.contact.nx * this.contact.depth * share, o.z - this.contact.nz * this.contact.depth * share, Math.min(o.obb.hx, o.obb.hz));
        o.x = o.obb.cx = pushed.x;
        o.z = o.obb.cz = pushed.z;
        o.dirty = true;
      } else if (p.speed > this.topSpeed() * 0.45 && this.time > o.bumpCooldown) {
        o.bumpCooldown = this.time + CC.bumpToastCooldown;
        this.metrics.bumps++;
        p.speed *= 0.35;
        this.effects.addTrauma(feelConfig.bumpTrauma);
        this.onEvent?.({ kind: 'bump', size: p.diameter });
        if (o.anchored && p.power >= o.requiredPower) this.hud.toast(L(`${o.def.label.toUpperCase()} · 被撑着 · 先拆掉它的墙`, `${o.def.label.toUpperCase()} · HELD UP · TEAR DOWN ITS WALLS FIRST`));
        else {
          const needed = Math.ceil(massForDiameter(o.requiredPower));
          this.hud.toast(L(`${o.def.label.toUpperCase()} · 太大了 · 长到 ${needed.toLocaleString('en-US')} KG`, `${o.def.label.toUpperCase()} · TOO BIG · GROW TO ${needed.toLocaleString('en-US')} KG`));
        }
      }
    }
  }

  // ── Collection ──────────────────────────────────────────────────────────────
  private updateCollection(dt: number): void {
    const p = this.player;
    const reach = p.diameter / 2 + p.diameter * CC.reachFactor + CC.reachFlat;
    const fx = -Math.sin(p.heading);
    const fz = -Math.cos(p.heading);
    const ix = p.x + fx * p.diameter * 0.3;
    const iz = p.z + fz * p.diameter * 0.3;
    const iy = p.diameter * 0.32;
    const accel = CC.pullAcceleration * (0.4 + p.diameter);

    for (const o of this.world.objects) {
      if (o.state === 'idle') {
        if (!this.world.isEligible(o, p.power)) continue;
        // Debris that is tiny next to the machine is vacuumed from further away (it may sit in
        // an alley the machine no longer fits into).
        const r = o.radius * 2 < p.diameter * CC.vacuumSizeRatio ? reach * CC.vacuumReachMultiplier : reach;
        if (Math.abs(o.x - p.x) > o.radius + r || Math.abs(o.z - p.z) > o.radius + r) continue;
        if (!circleVsObb(p.x, p.z, r, o.obb, this.contact)) continue;
        o.state = 'pulled';
        o.pullTime = 0;
        o.vx = o.vy = o.vz = 0;
        this.startDestruction(o);
        continue;
      }
      if (o.state !== 'pulled') continue;
      o.pullTime += dt;
      // Large objects are destroyed on the spot first (crushed, split, torn off), then pulled in.
      const phase = o.def.objectClass >= 4 ? (BREAK_PHASE[o.def.destructionType] ?? 0) * (1 + Math.max(0, o.def.objectClass - 5) * CC.heavyPhasePerClass) : 0;
      if (o.pullTime < phase) {
        const k = o.pullTime / phase;
        const type = o.def.destructionType;
        if (type === 'crush' || type === 'collapse') o.squash = Math.max(o.squash, k);
        else if (type === 'rip') o.tilt = k * 0.55 * this.towardSign(o, ix, iz);
        else if (type === 'break') o.scale = 1 - 0.25 * k;
        o.dirty = true;
        continue;
      }
      const dx = ix - o.x;
      const dy = iy - o.y;
      const dz = iz - o.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist < p.diameter * CC.absorbDistanceFactor + o.radius * 0.25 || o.pullTime > CC.maxPullSeconds + phase) {
        this.absorb(o);
        continue;
      }
      const damp = Math.exp(-5 * dt);
      o.vx = o.vx * damp + (dx / dist) * accel * dt;
      o.vy = o.vy * damp + (dy / dist) * accel * dt + 2.5 * p.diameter * dt;
      o.vz = o.vz * damp + (dz / dist) * accel * dt;
      o.x += o.vx * dt;
      o.y = Math.max(0, o.y + o.vy * dt);
      o.z += o.vz * dt;
      o.spin += dt * (6 + o.pullTime * 10);
      o.scale = Math.max(0.35, Math.min(o.scale, 1 - (o.pullTime - phase) * 0.8));
      o.dirty = true;
    }
  }

  private absorb(o: WorldObject): void {
    const p = this.player;
    o.state = 'absorbed';
    o.dirty = true;
    this.metrics.objectsCollected++;
    if (this.metrics.firstCollectAt === null) {
      this.metrics.firstCollectAt = this.time;
      this.hud.setHint(2);
    }
    if (this.metrics.firstAbsorbOfClassAt[o.def.objectClass] === undefined) this.metrics.firstAbsorbOfClassAt[o.def.objectClass] = this.time;

    const big = o.def.objectClass >= 3;
    const size = Math.max(...o.def.size);
    this.effects.burst(o.x, Math.max(o.y, p.diameter * 0.3), o.z, o.baseColor, big ? 14 : 5, Math.max(0.02, size * (big ? 0.08 : 0.25)), 1 + p.diameter * (big ? 1.6 : 1.2));
    this.onEvent?.({ kind: 'absorb', cls: o.def.objectClass, mass: o.def.rewardMass, size, destruction: o.def.destructionType });
    for (const r of this.world.releaseDependents(o)) {
      this.effects.dust(r.x, r.z, Math.max(...r.def.size) * 0.4, 6);
    }
    if (o.def.climax) this.climaxPartAbsorbed();
    this.effects.addTrauma(big ? feelConfig.largePickupTrauma * Math.min(1, size / p.diameter) : feelConfig.pickupTrauma);
    if (o.def.objectClass >= 4 && this.metrics.firstAbsorbOfClassAt[o.def.objectClass] === this.time) {
      this.hud.showBanner(L(`回收 ${o.def.label.toUpperCase()}`, `${o.def.label.toUpperCase()} RECYCLED`), `+${o.def.rewardMass} KG`, 2);
      this.effects.pulse(p.x, p.z, p.diameter * 2.5);
    }
    this.hud.punch(o.def.rewardMass);
    this.model.pulseIntake(big ? 4 : 1.2);
    this.grow(o.def.rewardMass);
  }

  /** First frame of a pull: the break-up effects for the object's destruction type. */
  private startDestruction(o: WorldObject): void {
    if (o.def.objectClass < 4) return;
    const size = Math.max(...o.def.size);
    const type = o.def.destructionType;
    const y = o.y + o.def.size[1] * 0.5;
    this.effects.shards(o.x, y, o.z, o.baseColor, type === 'break' ? 18 : 12, size * 0.09, 2 + size * 0.9);
    this.effects.dust(o.x, o.z, size * 0.5, o.def.objectClass >= 6 ? 8 : 4);
    if (type === 'crush' || type === 'collapse') this.effects.sparks(o.x, o.y + o.def.size[1] * 0.8, o.z, 10 + o.def.objectClass * 2, 1.5 + size * 0.6);
    this.effects.addTrauma(Math.min(0.5, 0.08 + o.def.objectClass * 0.035) * Math.min(1, size / this.player.diameter + 0.3));
    this.onEvent?.({ kind: 'crunch', cls: o.def.objectClass, size });
  }

  /** +1 when the pulling machine is in front of the object's local −Z face, else −1 (for rip lean). */
  private towardSign(o: WorldObject, ix: number, iz: number): number {
    const fx = -Math.sin(o.yaw);
    const fz = -Math.cos(o.yaw);
    return (ix - o.x) * fx + (iz - o.z) * fz > 0 ? -1 : 1;
  }

  /** Supports removed: dropping structures land with dust, shake and a crumple. */
  private updateCollapses(dt: number): void {
    const landed = this.world.updateFalling(dt);
    if (!landed.length) return;
    for (const o of landed) {
      const size = Math.max(...o.def.size);
      this.effects.dust(o.x, o.z, size * 0.6, 14);
      this.effects.shards(o.x, o.y + 0.5, o.z, o.baseColor, 10, size * 0.05, 3 + size * 0.4);
      this.effects.addTrauma(Math.min(0.6, 0.15 + size * 0.02));
      this.onEvent?.({ kind: 'collapse', size });
      if (o.def.climax) this.hud.toast(L(`${o.def.label.toUpperCase()} 倒塌了`, `${o.def.label.toUpperCase()} COLLAPSED`));
    }
    this.world.applyEligibility(this.player.power);
  }

  private climaxPartAbsorbed(): void {
    const m = this.metrics;
    m.climaxPartsLeft = this.world.objects.filter((o) => o.def.climax && o.state !== 'absorbed').length;
    if (m.climaxPartsLeft > 0 || this.won) return;
    this.won = true;
    m.climaxAt = this.time;
    const p = this.player;
    this.hud.showBanner(L('仓库已摧毁', 'WAREHOUSE DESTROYED'), L('废料城回收完毕', 'SCRAP CITY RECYCLED'), 4);
    this.hud.showEnd({ time: this.time, mass: p.mass, objects: m.objectsCollected, tier: p.tier });
    this.effects.pulse(p.x, p.z, p.diameter * 6, 1.6);
    this.effects.dust(p.x, p.z, p.diameter * 2, 20);
    this.effects.addTrauma(0.6);
    this.onEvent?.({ kind: 'win' });
  }

  /** QA / review only: add mass as if absorbed (tier transformations included). */
  grantMass(kg: number): void {
    this.grow(kg);
    this.player.diameter = this.player.targetDiameter;
  }

  /** QA / review only: move the machine and snap the camera behind it. */
  teleport(x: number, z: number, heading: number): void {
    const p = this.player;
    p.x = x;
    p.z = z;
    p.heading = heading;
    p.speed = 0;
    this.rig.snap(x, z, heading, p.diameter);
  }

  private grow(amount: number): void {
    const p = this.player;
    p.mass += amount;
    p.targetDiameter = diameterForMass(p.mass);
    p.power = p.targetDiameter;
    const cls = classForPower(p.power);
    if (cls > p.cls) {
      for (let c = p.cls + 1; c <= cls; c++) this.metrics.classUnlockAt[c] = this.time;
      p.cls = cls;
      this.world.applyEligibility(p.power);
      const tier = tierForClass(cls);
      if (tier > p.tier) {
        p.tier = tier;
        this.metrics.tierAt[tier] = this.time;
        this.model.setTier(tier, true);
        this.onEvent?.({ kind: 'tier', tier });
        this.hud.showBanner(L(`进化到 ${tier} 阶`, `TIER ${tier} REACHED`), L(`解锁：${SIZE_CLASSES[cls].labelZh}`, `${SIZE_CLASSES[cls].label.toUpperCase()} UNLOCKED`), 2.6);
        this.effects.pulse(p.x, p.z, p.targetDiameter * 4, 1);
        this.effects.burst(p.x, p.targetDiameter * 0.5, p.z, new THREE.Color(0xffa640), 28, p.targetDiameter * 0.07, 3 + p.targetDiameter * 2);
        this.effects.addTrauma(feelConfig.tierUpTrauma);
      } else {
        this.hud.showBanner(L(`解锁：${SIZE_CLASSES[cls].labelZh}`, `${SIZE_CLASSES[cls].label.toUpperCase()} UNLOCKED`), L(`体型等级 ${cls}`, `SIZE CLASS ${cls}`), 1.8);
        this.onEvent?.({ kind: 'unlock', cls });
        this.effects.pulse(p.x, p.z, p.targetDiameter * 3);
      }
    }
    this.refreshHud();
  }

  private refreshHud(): void {
    const prog = progressToNextClass(this.player.mass);
    this.hud.update(this.player.mass, prog.fraction, this.player.tier, prog.nextClass, prog.nextMass);
    this.hud.setObjective(this.player.cls, this.metrics.climaxPartsLeft, this.metrics.climaxPartsTotal, this.won);
  }

  // ── Presentation helpers ────────────────────────────────────────────────────
  private updateSun(): void {
    // One 4096² sun shadow map covering the view ahead of the player, so buildings throw their
    // long golden-hour shadows across the street.
    const p = this.player;
    const extent = 42 + p.diameter * 10;
    const ahead = extent * 0.45;
    this.focusShadow(p.x - Math.sin(this.rig.yaw) * ahead, p.z - Math.cos(this.rig.yaw) * ahead, extent);
  }

  /** Centre the sun's shadow frustum on (fx, fz); the focus snaps to shadow texels (no shimmer). */
  focusShadow(fx: number, fz: number, extent = 42 + this.player.diameter * 10): void {
    const texel = (extent * 2) / this.sun.shadow.mapSize.x;
    const sx = Math.round(fx / texel) * texel;
    const sz = Math.round(fz / texel) * texel;
    this.sun.target.position.set(sx, 0, sz);
    this.sun.position.set(sx + this.city.palette.sunDirection.x * 150, this.city.palette.sunDirection.y * 150, sz + this.city.palette.sunDirection.z * 150);
    if (Math.abs(extent - this.shadowExtent) > this.shadowExtent * 0.05) {
      this.shadowExtent = extent;
      // Fit the window to the receivers' light-space footprint: a caster shadows the view iff
      // its light-space xy falls inside it. At a 20° sun the ground region spans only
      // ±extent·sin(elevation) vertically, plus facades/roofs rising up to ~16 m.
      const sinEl = this.city.palette.sunDirection.y;
      const cam = this.sun.shadow.camera;
      cam.left = -extent;
      cam.right = extent;
      cam.top = extent * sinEl + 16 + this.player.diameter;
      cam.bottom = -(extent * sinEl + 2);
      cam.near = 20;
      cam.far = 150 + extent + 30;
      cam.updateProjectionMatrix();
    }
  }

  private pickBeaconTarget(): WorldObject | null {
    let best: WorldObject | null = null;
    let bestD = Infinity;
    for (const o of this.world.objects) {
      if (!this.world.isEligible(o, this.player.power) || o.z > this.city.spawn.z) continue;
      const d = Math.hypot(o.x - this.city.spawn.x, o.z - this.city.spawn.z);
      if (d > 0.8 && d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }

  private updateBeacon(): void {
    if (this.metrics.firstMoveAt !== null && this.metrics.firstCollectAt === null) this.hud.setHint(1);
    const t = this.beaconTarget;
    const visible = !!t && t.state === 'idle' && this.metrics.firstCollectAt === null;
    this.beacon.visible = visible;
    if (!visible) return;
    const s = 0.14 + 0.03 * Math.sin(this.time * 6);
    this.beacon.position.set(t.x, 0.012, t.z);
    this.beacon.scale.setScalar(s);
  }

  /** True if a circle here would hit architecture or an object the player cannot absorb (used by the playtest bot). */
  isBlocked(x: number, z: number, r: number, ignore: WorldObject | null): boolean {
    for (const b of this.world.staticColliders) if (circleVsObb(x, z, r, b, this.contact)) return true;
    for (const o of this.world.objects) {
      if (o === ignore || !this.world.isSolid(o, this.player.power)) continue;
      if (Math.abs(o.x - x) > o.radius + r || Math.abs(o.z - z) > o.radius + r) continue;
      if (circleVsObb(x, z, r, o.obb, this.contact)) return true;
    }
    return false;
  }

  snapshot() {
    const p = this.player;
    return {
      t: Math.round(this.time * 100) / 100,
      frame: this.frame,
      seed: this.seed,
      x: p.x,
      z: p.z,
      heading: p.heading,
      speed: p.speed,
      mass: p.mass,
      diameter: p.diameter,
      power: p.power,
      cls: p.cls,
      tier: p.tier,
      remaining: this.world.objects.filter((o) => o.state !== 'absorbed').length,
      eligibleRemaining: this.world.objects.filter((o) => this.world.isEligible(o, p.power)).length,
      won: this.won,
      metrics: this.metrics,
    };
  }
}
