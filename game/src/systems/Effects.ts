import * as THREE from 'three';
import { feelConfig } from '../config/growth';

/**
 * Pooled presentation effects (design §11, §13, §38). Nothing is allocated after construction.
 *   burst   — small bouncing debris (pickups)
 *   shards  — painted fragments thrown off a large object, then sucked into the intake
 *   dust    — soft billboard puffs (impacts, collapses, dash)
 *   sparks  — additive hot streaks (metal crushed)
 *   pulse   — ground ring (unlocks, tier-ups)
 *   shake   — trauma² camera shake
 */
const DEBRIS = 160;
const SHARDS = 220;
const DUST = 96;
const SPARKS = 128;
const RINGS = 4;
const STREAKS = 48;
const POPS = 24;

/**
 * Feel tunables owned by the presentation layer (design §11, §23–24, §47). Gameplay balance
 * lives in config/; these only change how events LOOK, never what happens.
 */
export const FEEL = {
  /** Hit-stop: presentation time runs at `hitStopScale` for the duration (sim never pauses). */
  hitStopMax: 0.08,
  hitStopScale: 0.06,
  hitStopBig: 0.045, // eating a vehicle-class object while it is large relative to you
  hitStopRival: 0.075, // eating / being eaten by a rival machine
  hitStopStun: 0.06, // dashing into something too big
  hitStopLandmark: 0.07, // the landmark's supports give way
  /** Dash: FOV kick (degrees, eased out) and speed-line streaks. */
  dashFovKick: 7,
  fovKickDecay: 5,
  dashStreaks: 10,
  dashStreaksPerSecond: 45,
  /** Tier-up: transient camera dolly-out (fraction of camera distance) and its duration. */
  tierPullBack: 0.28,
  tierPullSeconds: 1.6,
  landmarkPullBack: 0.35,
  landmarkPullSeconds: 2.6,
  /** Degrees of extra FOV per unit of pull-back (the dolly is a lens widen + camera lift). */
  pullBackFovPerUnit: 30,
  /** Shake: smooth noise frequency (Hz-ish); trauma² × this × camera distance = offset. */
  shakeFrequency: 17,
  /** Far-away collapses fade out: full shake within this many metres (+ 3 × object size). */
  shakeFalloffMetres: 45,
  /** Multiplier for shake / hit-stop / FOV kick / dolly when the viewer asks for reduced motion. */
  reducedMotionScale: 0.3,
};

function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

interface Particle {
  life: number;
  max: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  size: number;
  spin: number;
}

const blank = (): Particle => ({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, size: 0, spin: 0 });

/** Camera-facing soft sprite; instanceColor = (alpha, tone, heat). Size from the instance scale. */
function spriteMaterial(additive: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: additive ? 'MAT_FX_Sparks' : 'MAT_FX_Dust',
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vData;
      void main() {
        vUv = uv;
        vData = instanceColor;
        vec4 centre = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float s = length(instanceMatrix[0].xyz);
        gl_Position = projectionMatrix * (centre + vec4(position.xy * s, 0.0, 0.0));
      }`,
    fragmentShader: additive
      ? /* glsl */ `
      varying vec2 vUv;
      varying vec3 vData;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.0, d) * vData.x;
        vec3 hot = mix(vec3(1.0, 0.45, 0.08), vec3(1.0, 0.92, 0.7), smoothstep(0.4, 0.0, d));
        gl_FragColor = vec4(hot * a * 3.0, 1.0);
      }`
      : /* glsl */ `
      varying vec2 vUv;
      varying vec3 vData;
      void main() {
        vec2 p = vUv - 0.5;
        float d = length(p) * 2.0;
        // Soft billow: two low-frequency lobes break the disc without a star silhouette.
        float ang = atan(p.y, p.x);
        float lump = 0.92 + 0.05 * sin(ang * 2.0 + vData.z * 17.0) + 0.03 * sin(ang * 3.0 - vData.z * 11.0);
        float a = pow(smoothstep(lump, 0.0, d), 1.6) * vData.x;
        // Lit from the sun side (upper part brighter), warm site dust.
        vec3 col = mix(vec3(0.42, 0.38, 0.33), vec3(0.72, 0.66, 0.57), vData.y) * (0.85 + 0.25 * vUv.y);
        gl_FragColor = vec4(col, a * 0.6);
      }`,
  });
}

export class Effects {
  readonly root = new THREE.Group();
  private readonly debris: THREE.InstancedMesh;
  private readonly debrisP: Particle[] = [];
  private readonly shardMesh: THREE.InstancedMesh;
  private readonly shardP: Particle[] = [];
  private readonly dustMesh: THREE.InstancedMesh;
  private readonly dustP: Particle[] = [];
  private readonly sparkMesh: THREE.InstancedMesh;
  private readonly sparkP: Particle[] = [];
  private readonly rings: { mesh: THREE.Mesh; life: number; max: number; radius: number }[] = [];
  /** Speed lines: thin additive bars laid along the direction of travel (dash). */
  private readonly streakMesh: THREE.InstancedMesh;
  private readonly streakP: Particle[] = [];
  private nStreak = 0;
  private streakHeading = 0;
  /** Intake pops: a soft hot flash that swells and fades where a small object is swallowed. */
  private readonly popMesh: THREE.InstancedMesh;
  private readonly popP: Particle[] = [];
  private nPop = 0;
  private streakAcc = 0;
  /** Presentation clocks: hit-stop, FOV kick (degrees), dolly-out envelope. */
  private stop = 0;
  private fovKick = 0;
  private pullAmount = 0;
  private pullTime = 0;
  private pullDuration = 1;
  /** What applyCamera added last frame, so restoreCamera can hand the rig a clean camera. */
  private readonly applied = new THREE.Vector3();
  private appliedFov = 0;
  /** 1 normally; FEEL.reducedMotionScale when the viewer prefers reduced motion. Settable. */
  motion = prefersReducedMotion() ? FEEL.reducedMotionScale : 1;
  private nDebris = 0;
  private nShard = 0;
  private nDust = 0;
  private nSpark = 0;
  private trauma = 0;
  private time = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly axis = new THREE.Vector3(1, 1, 0).normalize();
  private readonly c = new THREE.Color();

  constructor(private readonly rand: () => number) {
    this.root.name = 'FX';
    const pool = (name: string, geo: THREE.BufferGeometry, mat: THREE.Material, n: number, list: Particle[]) => {
      const mesh = new THREE.InstancedMesh(geo, mat, n);
      mesh.name = name;
      mesh.frustumCulled = false;
      for (let i = 0; i < n; i++) {
        list.push(blank());
        mesh.setMatrixAt(i, this.m.makeScale(0, 0, 0));
        mesh.setColorAt(i, this.c.setRGB(1, 1, 1));
      }
      this.root.add(mesh);
      return mesh;
    };
    this.debris = pool('FX_Debris', new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }), DEBRIS, this.debrisP);
    // Shards: bent, flat plates (painted panel fragments), not cubes.
    const shard = new THREE.BufferGeometry();
    shard.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, -0.35, 0.45, 0.05, -0.5, 0.5, -0.02, 0.3, -0.3, 0.08, 0.5, 0, 0.12, 0], 3));
    shard.setIndex([0, 4, 1, 1, 4, 2, 2, 4, 3, 3, 4, 0, 0, 1, 2, 0, 2, 3]);
    shard.computeVertexNormals();
    this.shardMesh = pool('FX_Shards', shard, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.4, side: THREE.DoubleSide }), SHARDS, this.shardP);
    this.dustMesh = pool('FX_Dust', new THREE.PlaneGeometry(1, 1), spriteMaterial(false), DUST, this.dustP);
    this.sparkMesh = pool('FX_Sparks', new THREE.PlaneGeometry(1, 1), spriteMaterial(true), SPARKS, this.sparkP);
    this.popMesh = pool('FX_Pops', new THREE.PlaneGeometry(1, 1), spriteMaterial(true), POPS, this.popP);
    // Streak bar: 1 m long on local Z, rotated to the travel heading at spawn.
    const streakMat = new THREE.MeshBasicMaterial({ name: 'MAT_FX_Streak', color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.streakMesh = pool('FX_SpeedLines', new THREE.BoxGeometry(0.03, 0.03, 1), streakMat, STREAKS, this.streakP);
    this.dustMesh.renderOrder = 5;
    this.sparkMesh.renderOrder = 6;
    this.popMesh.renderOrder = 6;
    this.streakMesh.renderOrder = 6;
    for (let i = 0; i < RINGS; i++) {
      const mesh = new THREE.Mesh(
        new THREE.RingGeometry(0.93, 1, 64).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xffa640, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      mesh.name = `FX_PulseRing_${i}`;
      mesh.visible = false;
      this.rings.push({ mesh, life: 0, max: 1, radius: 1 });
      this.root.add(mesh);
    }
  }

  burst(x: number, y: number, z: number, color: THREE.Color, count: number, size: number, speed: number): void {
    for (let i = 0; i < count; i++) {
      const idx = this.nDebris;
      this.nDebris = (this.nDebris + 1) % DEBRIS;
      this.launch(this.debrisP[idx], x, y, z, speed, size, 0.45 + this.rand() * 0.35);
      this.debris.setColorAt(idx, color);
    }
    if (this.debris.instanceColor) this.debris.instanceColor.needsUpdate = true;
  }

  /** Fragments fly off, hang for a moment, then are pulled into the intake (see update's target). */
  shards(x: number, y: number, z: number, color: THREE.Color, count: number, size: number, speed: number): void {
    for (let i = 0; i < count; i++) {
      const idx = this.nShard;
      this.nShard = (this.nShard + 1) % SHARDS;
      this.launch(this.shardP[idx], x, y, z, speed, size, 1.1 + this.rand() * 0.5);
      this.c.copy(color).multiplyScalar(0.7 + this.rand() * 0.4);
      this.shardMesh.setColorAt(idx, this.c);
    }
    if (this.shardMesh.instanceColor) this.shardMesh.instanceColor.needsUpdate = true;
  }

  dust(x: number, z: number, radius: number, count: number): void {
    for (let i = 0; i < count; i++) {
      const p = this.dustP[this.nDust];
      const a = this.rand() * Math.PI * 2;
      const r = Math.sqrt(this.rand()) * radius;
      p.x = x + Math.cos(a) * r;
      p.z = z + Math.sin(a) * r;
      p.y = 0.2 + this.rand() * radius * 0.3;
      p.vx = Math.cos(a) * radius * (0.4 + this.rand() * 0.6);
      p.vz = Math.sin(a) * radius * (0.4 + this.rand() * 0.6);
      p.vy = 0.3 + this.rand() * radius * 0.25;
      p.size = Math.max(0.3, radius * (0.6 + this.rand() * 0.6));
      p.max = p.life = 1.4 + this.rand() * 1.2;
      p.spin = this.rand();
      this.nDust = (this.nDust + 1) % DUST;
    }
  }

  sparks(x: number, y: number, z: number, count: number, speed: number): void {
    for (let i = 0; i < count; i++) {
      const p = this.sparkP[this.nSpark];
      this.launch(p, x, y, z, speed, 0.05 + speed * 0.012, 0.35 + this.rand() * 0.4);
      this.nSpark = (this.nSpark + 1) % SPARKS;
    }
  }

  private launch(p: Particle, x: number, y: number, z: number, speed: number, size: number, life: number): void {
    const a = this.rand() * Math.PI * 2;
    p.x = x;
    p.y = y;
    p.z = z;
    p.vx = Math.cos(a) * speed * (0.4 + this.rand());
    p.vz = Math.sin(a) * speed * (0.4 + this.rand());
    p.vy = (0.4 + this.rand() * 0.8) * speed * 1.4;
    p.size = size * (0.5 + this.rand() * 0.7);
    p.max = p.life = life;
    p.spin = this.rand() * 6;
  }

  pulse(x: number, z: number, radius: number, duration = 0.7): void {
    const ring = this.rings.find((r) => r.life <= 0) ?? this.rings[0];
    ring.life = ring.max = duration;
    ring.radius = radius;
    ring.mesh.position.set(x, 0.03, z);
    ring.mesh.visible = true;
  }

  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount * this.motion);
  }

  /** Trauma for an event at (x, z) seen from (fx, fz): full nearby, fading to nothing far away. */
  addTraumaAt(amount: number, x: number, z: number, fx: number, fz: number, size = 0): void {
    const reach = FEEL.shakeFalloffMetres + size * 3;
    const d = Math.hypot(x - fx, z - fz);
    const k = d <= reach ? 1 : Math.max(0, 1 - (d - reach) / reach);
    if (k > 0) this.addTrauma(amount * k);
  }

  /** Freeze-frame: presentation time nearly stops for `seconds` (capped; hits don't stack past the cap). */
  hitStop(seconds: number): void {
    if (this.motion < 1) seconds *= 0.5;
    this.stop = Math.min(FEEL.hitStopMax, Math.max(this.stop, seconds));
  }

  /**
   * Presentation delta for this frame: `dt` normally, ~0 during a hit-stop. Advances the
   * hit-stop clock by the real `dt`, so call it exactly once per frame before updating visuals.
   */
  presentDt(dt: number): number {
    if (this.stop <= 0) return dt;
    const frozen = Math.min(dt, this.stop);
    this.stop -= frozen;
    return dt - frozen + frozen * FEEL.hitStopScale;
  }

  get stopping(): boolean {
    return this.stop > 0;
  }

  /** Dash: FOV punch plus a burst of speed lines around the machine. */
  dashKick(x: number, y: number, z: number, heading: number, diameter: number): void {
    this.fovKick = Math.max(this.fovKick, FEEL.dashFovKick * this.motion);
    this.streaks(x, y, z, heading, diameter, FEEL.dashStreaks);
  }

  /** Keep speed lines flowing while a dash lasts (call per frame with the dash still active). */
  dashTrail(dt: number, x: number, y: number, z: number, heading: number, diameter: number): void {
    this.streakAcc += dt * FEEL.dashStreaksPerSecond;
    const n = Math.floor(this.streakAcc);
    if (n <= 0) return;
    this.streakAcc -= n;
    this.streaks(x, y, z, heading, diameter, n);
  }

  private streaks(x: number, y: number, z: number, heading: number, diameter: number, count: number): void {
    this.streakHeading = heading;
    const fx = -Math.sin(heading);
    const fz = -Math.cos(heading);
    for (let i = 0; i < count; i++) {
      const p = this.streakP[this.nStreak];
      this.nStreak = (this.nStreak + 1) % STREAKS;
      // Beside and slightly ahead of the machine, at body height; they hang in the air and the
      // machine rushes past them, so they read as wind, not as particles glued to the car.
      const side = (this.rand() < 0.5 ? -1 : 1) * diameter * (0.55 + this.rand() * 0.6);
      const ahead = diameter * (0.2 + this.rand() * 0.9);
      p.x = x + fx * ahead - fz * side;
      p.z = z + fz * ahead + fx * side;
      p.y = y + diameter * (0.1 + this.rand() * 0.7);
      p.vx = -fx * diameter * 2;
      p.vz = -fz * diameter * 2;
      p.vy = 0;
      p.size = diameter * (0.9 + this.rand() * 0.9);
      p.max = p.life = 0.22 + this.rand() * 0.12;
      p.spin = 0.5 + this.rand() * 0.5;
    }
  }

  /** A swallow flash at the intake; `size` in metres (small pickups ≈ 0.2–0.5). */
  pop(x: number, y: number, z: number, size: number): void {
    const p = this.popP[this.nPop];
    this.nPop = (this.nPop + 1) % POPS;
    p.x = x;
    p.y = y;
    p.z = z;
    p.vx = p.vy = p.vz = 0;
    p.size = size;
    p.max = p.life = 0.16;
  }

  /** Transient dolly-out (tier-up, landmark): a smooth bump of `amount` × camera distance. */
  pullBack(amount: number, seconds: number): void {
    this.pullAmount = Math.max(amount * this.motion, this.pullTime < this.pullDuration ? this.pullAmount : 0);
    this.pullTime = 0;
    this.pullDuration = seconds;
  }

  /** A random hue for comedy bursts, from this pool's own seeded stream (never Math.random). */
  hue(): number {
    return this.rand();
  }

  /** (tx, ty, tz) is the player's intake: shards home onto it in the second half of their life. */
  update(dt: number, groundY = 0, tx = 0, ty = 0, tz = 0): void {
    this.time += dt;
    this.trauma = Math.max(0, this.trauma - feelConfig.traumaDecay * dt);
    this.fovKick = Math.max(0, this.fovKick - this.fovKick * Math.min(1, FEEL.fovKickDecay * dt) - 0.2 * dt);
    if (this.pullTime < this.pullDuration) this.pullTime += dt;

    // Idle pools are hidden so they cost no draw call in any pass.
    this.debris.visible = anyAlive(this.debrisP);
    this.shardMesh.visible = anyAlive(this.shardP);
    this.dustMesh.visible = anyAlive(this.dustP);
    this.sparkMesh.visible = anyAlive(this.sparkP);
    this.streakMesh.visible = anyAlive(this.streakP);
    this.popMesh.visible = anyAlive(this.popP);
    for (let i = 0; i < DEBRIS; i++) {
      const p = this.debrisP[i];
      if (p.life <= 0) continue;
      this.ballistic(p, dt, groundY);
      const k = p.life > 0 ? p.size * Math.min(1, (p.life / p.max) * 2) : 0;
      this.q.setFromAxisAngle(this.axis, p.life * 9);
      this.debris.setMatrixAt(i, this.m.compose(this.v.set(p.x, p.y, p.z), this.q, this.s.set(k, k, k)));
    }
    this.debris.instanceMatrix.needsUpdate = true;

    for (let i = 0; i < SHARDS; i++) {
      const p = this.shardP[i];
      if (p.life <= 0) continue;
      const age = 1 - p.life / p.max;
      if (age < 0.4) this.ballistic(p, dt, groundY);
      else {
        // Suction: accelerate toward the intake, shrink on arrival.
        p.life -= dt;
        const dx = tx - p.x;
        const dy = ty - p.y;
        const dz = tz - p.z;
        const d = Math.hypot(dx, dy, dz) || 1;
        const pull = 40 + 60 * age;
        p.vx = p.vx * 0.9 + (dx / d) * pull * dt * 6;
        p.vy = p.vy * 0.9 + (dy / d) * pull * dt * 6;
        p.vz = p.vz * 0.9 + (dz / d) * pull * dt * 6;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        if (d < p.size * 2 + 0.2) p.life = 0;
      }
      const k = p.life > 0 ? p.size : 0;
      this.q.setFromAxisAngle(this.axis, p.spin + (p.max - p.life) * 7);
      this.shardMesh.setMatrixAt(i, this.m.compose(this.v.set(p.x, p.y, p.z), this.q, this.s.set(k, k, k)));
    }
    this.shardMesh.instanceMatrix.needsUpdate = true;

    for (let i = 0; i < DUST; i++) {
      const p = this.dustP[i];
      if (p.life <= 0) {
        this.dustMesh.setMatrixAt(i, this.m.makeScale(0, 0, 0));
        continue;
      }
      p.life -= dt;
      const drag = Math.exp(-2.2 * dt);
      p.vx *= drag;
      p.vz *= drag;
      p.vy = p.vy * drag + 0.25 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const age = 1 - Math.max(0, p.life) / p.max;
      const size = p.size * (0.6 + age * 1.3);
      this.dustMesh.setMatrixAt(i, this.m.compose(this.v.set(p.x, p.y + size * 0.25, p.z), this.q.identity(), this.s.set(size, size, size)));
      this.dustMesh.setColorAt(i, this.c.setRGB(Math.sin(Math.PI * Math.min(1, age * 1.4 + 0.05)) * (1 - age), 0.3 + p.spin * 0.5, p.spin));
    }
    this.dustMesh.instanceMatrix.needsUpdate = true;
    if (this.dustMesh.instanceColor) this.dustMesh.instanceColor.needsUpdate = true;

    for (let i = 0; i < SPARKS; i++) {
      const p = this.sparkP[i];
      if (p.life <= 0) {
        this.sparkMesh.setMatrixAt(i, this.m.makeScale(0, 0, 0));
        continue;
      }
      this.ballistic(p, dt, groundY);
      const f = Math.max(0, p.life / p.max);
      this.sparkMesh.setMatrixAt(i, this.m.compose(this.v.set(p.x, p.y, p.z), this.q.identity(), this.s.setScalar(p.size * (0.5 + f))));
      this.sparkMesh.setColorAt(i, this.c.setRGB(f, 0, 0));
    }
    this.sparkMesh.instanceMatrix.needsUpdate = true;
    if (this.sparkMesh.instanceColor) this.sparkMesh.instanceColor.needsUpdate = true;

    if (this.streakMesh.visible) {
      this.q.setFromAxisAngle(this.v.set(0, 1, 0), this.streakHeading);
      for (let i = 0; i < STREAKS; i++) {
        const p = this.streakP[i];
        if (p.life <= 0) {
          this.streakMesh.setMatrixAt(i, this.m.makeScale(0, 0, 0));
          continue;
        }
        p.life -= dt;
        p.x += p.vx * dt;
        p.z += p.vz * dt;
        const f = Math.max(0, p.life / p.max);
        // Thin bar that stretches then thins out; brightness through the (additive) instance colour.
        const len = p.size * (0.6 + 0.8 * (1 - f));
        const w = Math.max(0.3, p.size * 0.5) * (0.4 + 0.6 * f);
        this.streakMesh.setMatrixAt(i, this.m.compose(this.v.set(p.x, p.y, p.z), this.q, this.s.set(w, w, len)));
        const b = 0.45 * p.spin * Math.sin(Math.PI * Math.min(1, (1 - f) * 1.3 + 0.1));
        this.streakMesh.setColorAt(i, this.c.setRGB(b, b, b * 1.05));
      }
      this.streakMesh.instanceMatrix.needsUpdate = true;
      if (this.streakMesh.instanceColor) this.streakMesh.instanceColor.needsUpdate = true;
    }

    if (this.popMesh.visible) {
      for (let i = 0; i < POPS; i++) {
        const p = this.popP[i];
        if (p.life <= 0) {
          this.popMesh.setMatrixAt(i, this.m.makeScale(0, 0, 0));
          continue;
        }
        p.life -= dt;
        const f = Math.max(0, p.life / p.max);
        // Swell fast (ease-out), fade quadratically: a "pop", not a glow.
        const k = p.size * (0.5 + 1.1 * (1 - f * f));
        this.popMesh.setMatrixAt(i, this.m.compose(this.v.set(p.x, p.y, p.z), this.q.identity(), this.s.setScalar(k)));
        this.popMesh.setColorAt(i, this.c.setRGB(0.45 * f * f, 0, 0));
      }
      this.popMesh.instanceMatrix.needsUpdate = true;
      if (this.popMesh.instanceColor) this.popMesh.instanceColor.needsUpdate = true;
    }

    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      const t = 1 - Math.max(0, r.life) / r.max;
      const s = r.radius * (0.3 + 0.9 * (1 - Math.pow(1 - t, 3)));
      r.mesh.scale.set(s, 1, s);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - t) * (1 - t);
      if (r.life <= 0) r.mesh.visible = false;
    }
  }

  private ballistic(p: Particle, dt: number, groundY: number): void {
    p.life -= dt;
    p.vy -= 9.8 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
    if (p.y < groundY + p.size / 2) {
      p.y = groundY + p.size / 2;
      p.vy *= -0.3;
      p.vx *= 0.6;
      p.vz *= 0.6;
    }
  }

  /** Apply after the camera rig has written the base transform. trauma² keeps small events subtle. */
  applyShake(camera: THREE.PerspectiveCamera, distance: number): void {
    if (this.trauma <= 0) return;
    const shake = this.trauma * this.trauma * feelConfig.maxShakeOffset * distance;
    const f = this.time * FEEL.shakeFrequency;
    const ox = shake * smoothNoise(f, 1);
    const oy = shake * smoothNoise(f, 2);
    camera.position.x += ox;
    camera.position.y += oy;
    camera.rotation.z += this.trauma * this.trauma * 0.04 * smoothNoise(f, 3);
  }

  /**
   * Everything transient the camera wears on top of the rig: shake, dash FOV kick and the
   * tier-up / landmark dolly-out. Call after the rig update; call restoreCamera before the next
   * rig update so the rig's easing never integrates the offsets (they must return to rest).
   */
  applyCamera(camera: THREE.PerspectiveCamera, distance: number, firstPerson: boolean): void {
    this.applied.copy(camera.position);
    let pullFov = 0;
    if (!firstPerson && this.pullTime < this.pullDuration && this.pullAmount > 0) {
      // Smooth bump: ease out to the peak by ~35 %, ease back in over the rest.
      const t = this.pullTime / this.pullDuration;
      const env = t < 0.35 ? 1 - Math.pow(1 - t / 0.35, 3) : 0.5 + 0.5 * Math.cos(((t - 0.35) / 0.65) * Math.PI);
      // Widen the lens and lift the camera rather than dolly backwards: the rig already
      // resolved occlusion behind the machine, and a backward dolly would push into walls.
      pullFov = env * this.pullAmount * FEEL.pullBackFovPerUnit;
      camera.position.y += env * this.pullAmount * distance * 0.45;
    }
    this.applyShake(camera, distance);
    this.applied.subVectors(camera.position, this.applied);
    this.appliedFov = this.fovKick + pullFov;
    if (this.appliedFov > 0.01) {
      camera.fov += this.appliedFov;
      camera.updateProjectionMatrix();
    } else this.appliedFov = 0;
  }

  restoreCamera(camera: THREE.PerspectiveCamera): void {
    camera.position.sub(this.applied);
    this.applied.set(0, 0, 0);
    if (this.appliedFov) {
      camera.fov -= this.appliedFov;
      camera.updateProjectionMatrix();
      this.appliedFov = 0;
    }
  }
}

function anyAlive(list: Particle[]): boolean {
  for (let i = 0; i < list.length; i++) if (list[i].life > 0) return true;
  return false;
}

/** Smooth, deterministic pseudo-noise in [-1, 1]: incommensurate sines, not a per-frame hash (which buzzes). */
function smoothNoise(t: number, seed: number): number {
  return 0.5 * Math.sin(t * 1.0 + seed * 1.7) + 0.3 * Math.sin(t * 2.31 + seed * 4.1) + 0.2 * Math.sin(t * 4.77 + seed * 2.3);
}
