import * as THREE from 'three';
import { skipAO } from '../art/layers';
import { createSeededRandom } from '../core/rng';

/**
 * HALLOWEEN TOWN — atmosphere layer (docs/halloween-mode.md). Everything that makes the night
 * graveyard / pumpkin-patch landscape feel alive and is not a prop: the moon, distant hills with
 * dead trees, bats, will-o'-wisps, ground mist in the paths and hollows, the summoning circle in
 * the empty plaza, jack-o'-lantern light pools, and the event beats of the second half (scores
 * lock → blood sky, hunt → lightning + eruption, catch → a soul leaves). No town assumptions:
 * no streets, lamps or skyline (CD correction 2026-10-02: Halloween elements only).
 *
 * Budget (technical-art.md, mobile): ≤ 11 draw calls in the worst state, no real lights, no
 * textures, no per-frame allocation. Every repeated element is one instanced draw whose motion
 * is evaluated in its vertex shader from static per-instance attributes and a shared time
 * uniform, so the CPU cost per frame is a handful of scalar envelopes.
 *
 *   draw                 what                                         visible
 *   SKY_Tint             blood-red sky tint + lightning flash/bolt       after scores lock / flashes
 *   SKY_Moon             moon disc + halo + passing cloud (billboard)    always
 *   FX_Bats              all flocks, wing flap in the vertex shader      always (opaque silhouettes)
 *   FX_Wisps             green wisps + their trail ghosts + ground glow  always
 *   BG_HillsDeadTrees    two hill ridges + dead-tree silhouettes        always (opaque, 1 static mesh)
 *   FX_GroundMist        low mist patches in the paths and hollows       always
 *   FX_PlazaMist         slow vortex of mist over the plaza (3 layers)   always
 *   FX_SummoningCircle   ground ring, runes, triangle, rise nodes        always (faint until the hunt)
 *   FX_LanternPools      flickering warm pools under lanterns           once setLanterns() is fed
 *   FX_Bursts            pooled sparks / shock rings / rising ghosts     while a burst is alive
 *
 * All materials are unlit ShaderMaterials (tone mapping + colour space chunks included, so the
 * low tier's direct render matches the composer tiers). Glow cores exceed the bloom threshold
 * (1.25) only where glow is wanted: the moon, wisp cores, the flaring circle, bolts.
 */

// ── Key light ────────────────────────────────────────────────────────────────────────────────
/**
 * Moonlight key direction (unit vector toward the moon), −Z = north. Azimuth ~34° east of
 * north (the existing MOONLIGHT palette's bearing), elevation 18°: low enough that the disc
 * and its halo enter the top of the second-half chase camera (≈1 m machines), high enough that
 * shadows stay ≈3× object height. Align `palette.sunDirection` (and so the sky dome's own disc,
 * which then sits hidden under this moon) to this vector.
 */
export const HALLOWEEN_MOON_DIR = new THREE.Vector3(0.537, 0.309, -0.785).normalize();

export interface HalloweenFx {
  root: THREE.Object3D;
  update(dt: number, time: number, camera: THREE.Camera): void;
  /** Half time: the sky bleeds red and the mist thickens over ~3 s. */
  onScoresLocked(): void;
  /** Villains rise: the plaza mist erupts, the circle flares, lightning splits the sky. */
  onHuntStart(): void;
  /** A machine was caught at (x, z): green soul burst. */
  onCaught(x: number, z: number): void;
  /** Jack-o'-lantern pools. `y` = ground height under the lantern (pools sit 2 cm above it). */
  setLanterns(points: { x: number; y: number; z: number }[]): void;
  /** Optional: the graveyard, so a cluster of wisps haunts it. */
  setGraveyard(rect: { minX: number; maxX: number; minZ: number; maxZ: number } | null): void;
  /**
   * Optional: where the ground mist lies — path samples and graveyard hollows ({x, z} centre,
   * r radius m, y ground height, default 0). Replaces the default layout (the four axis paths
   * out of the plaza plus seeded hollows). Roaming wisps follow the largest zones.
   */
  setMistZones(zones: { x: number; z: number; r: number; y?: number }[]): void;
  /** Optional: what the bat flocks circle — dead trees, giant pumpkins (h = top height, m). */
  setRoosts(points: { x: number; z: number; h: number }[]): void;
  /** Back to the first-half look (new round on the same map). */
  reset(): void;
  dispose(): void;
}

export interface HalloweenFxOptions {
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  quality: 'low' | 'medium' | 'high';
  seed: number;
  /** Accessibility: soften lightning flashes (no full-sky strobe). */
  reducedFlash?: boolean;
  /** Distant hills + dead-tree silhouettes beyond the fence (default true). */
  background?: boolean;
}

// ── Tiers ────────────────────────────────────────────────────────────────────────────────────
const TIERS = {
  low: { bats: 14, wisps: 9, trail: 2, hollows: 10, pathStep: 22, mistLayers: 1, plazaLayers: 2, trees: 22, oct: 2 },
  medium: { bats: 26, wisps: 15, trail: 3, hollows: 16, pathStep: 16, mistLayers: 2, plazaLayers: 3, trees: 36, oct: 3 },
  high: { bats: 40, wisps: 22, trail: 4, hollows: 22, pathStep: 13, mistLayers: 2, plazaLayers: 3, trees: 50, oct: 4 },
} as const;

const PLAZA_R = 30;
const MAX_MIST = 96; // zones (each drawn on mistLayers layers)
const MAX_ROOSTS = 6;
/** Hunters rise at radius 6 m, angles 90° + i·120° (arena/hunt.ts). */
const RISE_R = 6;
const MAX_LANTERNS = 256;
const BURST_SLOTS = 12;
const SPARKS = 16;
const PER_BURST = SPARKS + 2; // sparks + shock ring + ghost
const MOON_DIST = 560; // camera far is 700
const MOON_R = Math.tan(THREE.MathUtils.degToRad(4.4)) * MOON_DIST;
const MOON_QUAD = 5; // quad half-size in moon radii (halo reach)

// ── GLSL ─────────────────────────────────────────────────────────────────────────────────────
const NOISE = /* glsl */ `
  float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < OCT; i++) { s += a * vnoise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.3; a *= 0.5; }
    return s / (1.0 - pow(0.5, float(OCT)));
  }
`;
const FINISH = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;
/** Camera right/up in world space, for billboards (rows of the view matrix). */
const BILLBOARD = /* glsl */ `
  vec3 camRight() { return vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]); }
  vec3 camUp() { return vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]); }
`;

type U = { value: number };

/** Premultiplied "over + add": rgb is premultiplied; alpha 0 adds, alpha 1 covers. */
function premultiplied(m: THREE.ShaderMaterial): THREE.ShaderMaterial {
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = THREE.OneFactor;
  m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  return m;
}

function fxMaterial(name: string, oct: number, uniforms: Record<string, THREE.IUniform>, vertexShader: string, fragmentShader: string, extra: Partial<THREE.ShaderMaterialParameters> = {}): THREE.ShaderMaterial {
  return premultiplied(
    new THREE.ShaderMaterial({
      name,
      uniforms,
      vertexShader,
      fragmentShader,
      defines: { OCT: oct },
      transparent: true,
      depthWrite: false,
      fog: false,
      ...extra,
    }),
  );
}

/** Instanced copy of a base geometry with `count` instances. */
function instanced(base: THREE.BufferGeometry, count: number): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  for (const k of Object.keys(base.attributes)) g.setAttribute(k, base.attributes[k]);
  g.instanceCount = count;
  // Positions come from the shaders: cull by hand (never), keep a generous bound for raycasts.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return g;
}

function mesh(name: string, g: THREE.BufferGeometry, m: THREE.Material, renderOrder: number): THREE.Mesh {
  const o = new THREE.Mesh(g, m);
  o.name = name;
  o.frustumCulled = false;
  o.renderOrder = renderOrder;
  o.matrixAutoUpdate = false;
  return o;
}

const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

export function createHalloweenFx(opts: HalloweenFxOptions): HalloweenFx {
  const T = TIERS[opts.quality];
  const rand = createSeededRandom(opts.seed ^ 0x6a11);
  const b = opts.bounds;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const half = Math.min(b.maxX - b.minX, b.maxZ - b.minZ) / 2;

  const root = new THREE.Group();
  root.name = 'FX_Halloween';

  // Shared uniforms (one object per value, referenced by every material that needs it).
  const uTime: U = { value: 0 };
  const uFlash: U = { value: 0 }; // sky/world flash 0..1
  const uBolt: U = { value: 0 }; // visible bolt 0..1
  const uBoltAz: U = { value: 0 };
  const uBoltSeed: U = { value: 0 };
  const uRed: U = { value: 0 }; // scores-locked blood tint 0..1
  const uDensity: U = { value: 1 }; // mist density multiplier
  const uErupt: U = { value: 0 }; // plaza eruption 0..1
  const uSwirl: U = { value: 0 }; // integrated vortex phase
  const uRing: U = { value: 0.32 }; // circle intensity
  const uReveal: U = { value: 0 }; // triangle + nodes reveal
  const uFogColor = { value: new THREE.Color(0x3d3558) };
  const uMoonDir = { value: HALLOWEEN_MOON_DIR.clone() };
  const uCenter = { value: new THREE.Vector2(cx, cz) };
  // Low tier renders straight to the canvas: every additive layer is tone-mapped on its own, so
  // stacked glows saturate far sooner than through the HDR composer. Scale the plaza glows down.
  const uGain: U = { value: opts.quality === 'low' ? 0.5 : 1 };

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const track = <G extends THREE.BufferGeometry, M extends THREE.Material>(g: G, m: M): [G, M] => {
    geometries.push(g);
    materials.push(m);
    return [g, m];
  };

  // ── Sky tint + lightning (one dome, sky pixels only) ──────────────────────────────────────────
  const [tintGeo, tintMat] = track(
    new THREE.SphereGeometry(1, 32, 16),
    fxMaterial(
      'MAT_FX_SkyTint',
      T.oct,
      { uTime, uFlash, uBolt, uBoltAz, uBoltSeed, uRed },
      /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * viewMatrix * vec4(cameraPosition + position * 500.0, 1.0);
        gl_Position = p.xyww; // at the far plane: only sky pixels pass the depth test
      }`,
      /* glsl */ `
      uniform float uTime, uFlash, uBolt, uBoltAz, uBoltSeed, uRed;
      varying vec3 vDir;
      ${NOISE}
      float jag(float e, float s) { return (fbm(vec2(e * 9.0, s)) - 0.5) * 0.16 + (vnoise(vec2(e * 70.0, s * 3.1)) - 0.5) * 0.025; }
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        // Blood sky: crimson at the horizon to a bruised maroon overhead, darker than the sky it covers.
        float up = smoothstep(-0.05, 0.65, h);
        // Deep, low-luminance red: bright saturated reds roll off to orange under AgX.
        vec3 red = mix(vec3(0.3, 0.012, 0.018), vec3(0.055, 0.002, 0.018), up);
        red *= 0.75 + 0.5 * fbm(d.xz / (abs(h) + 0.25) * 1.4 + uTime * 0.01);
        red = mix(red, vec3(0.02, 0.0, 0.006), smoothstep(0.0, -0.08, h)); // below the horizon: dark
        float a = uRed * mix(0.88, 0.76, up);
        vec3 col = red * a;
        // Lightning: whole-sky flash, brighter toward the strike, plus the bolt itself.
        float az = atan(d.x, -d.z);
        float dAz = mod(az - uBoltAz + 3.14159265, 6.2831853) - 3.14159265;
        float near = exp(-abs(dAz) * 2.2);
        col += vec3(0.62, 0.6, 0.95) * uFlash * (0.18 + 0.75 * near) * (1.0 - 0.5 * up);
        if (uBolt > 0.001 && abs(dAz) < 0.6 && h > -0.02 && h < 0.5) {
          float top = 0.42 + 0.06 * hash12(vec2(uBoltSeed, 1.0));
          float x = dAz - jag(h, uBoltSeed) * (1.0 - h * 0.8);
          float on = step(h, top) * smoothstep(top, top - 0.05, h);
          float core = exp(-abs(x) * 900.0) + exp(-abs(x) * 160.0) * 0.35;
          // A fork splitting off two thirds of the way down.
          float fh = 0.24;
          float x2 = dAz - jag(fh, uBoltSeed) * (1.0 - fh * 0.8) - (fh - h) * 0.55 - (jag(h, uBoltSeed + 4.0) - jag(fh, uBoltSeed + 4.0)) * 0.6;
          float fork = step(h, fh) * smoothstep(0.0, 0.1, h) * (exp(-abs(x2) * 1300.0) + exp(-abs(x2) * 200.0) * 0.25) * 0.75;
          col += vec3(0.85, 0.82, 1.0) * (core * on + fork) * uBolt * 6.0;
        }
        gl_FragColor = vec4(col, a);
        ${FINISH}
      }`,
      { side: THREE.BackSide },
    ),
  );
  // Event-only meshes start VISIBLE (each draws nothing until its event) so RenderPipeline's
  // prewarm compiles their programs; the first update() hides them. No shader hitch at half time.
  const sky = mesh('SKY_Tint', tintGeo, tintMat, -10);
  root.add(sky);

  // ── Moon ─────────────────────────────────────────────────────────────────────────────────────
  const [moonGeo, moonMat] = track(
    new THREE.PlaneGeometry(2, 2),
    fxMaterial(
      'MAT_FX_Moon',
      T.oct,
      { uTime, uRed, uMoonDir, uR: { value: MOON_R }, uDist: { value: MOON_DIST } },
      /* glsl */ `
      uniform vec3 uMoonDir;
      uniform float uR, uDist;
      varying vec2 vQ;
      ${BILLBOARD}
      void main() {
        vQ = position.xy * ${MOON_QUAD.toFixed(1)};
        vec3 c = cameraPosition + normalize(uMoonDir) * uDist;
        vec3 w = c + (camRight() * vQ.x + camUp() * vQ.y) * uR;
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
      }`,
      /* glsl */ `
      uniform float uTime, uRed;
      varying vec2 vQ;
      ${NOISE}
      void main() {
        float r = length(vQ);
        float disc = 1.0 - smoothstep(0.988, 1.0, r);
        // Surface: limb darkening, maria, a few craters.
        float z = sqrt(max(0.0, 1.0 - min(r * r, 1.0)));
        vec2 sp = vQ / (0.6 + 0.4 * z); // slight spherical warp
        float maria = smoothstep(0.48, 0.72, fbm(sp * 1.35 + 3.7));
        vec2 g = sp * 3.2; vec2 id = floor(g); vec2 f = fract(g) - 0.5;
        float hs = hash12(id + 5.0);
        float cr = 0.12 + 0.2 * hs;
        float dc = length(f - (vec2(hash12(id), hash12(id + 9.0)) - 0.5) * 0.4);
        float crater = hs > 0.45 ? smoothstep(cr, cr * 0.55, dc) - smoothstep(cr * 1.25, cr, dc) * 0.6 : 0.0;
        vec3 moon = mix(vec3(1.0, 0.97, 0.88), vec3(0.58, 0.6, 0.66), maria * 0.8);
        moon *= 1.0 - crater * 0.18;
        moon *= mix(0.68, 1.0, pow(z, 0.45));
        moon = mix(moon, vec3(1.0, 0.13, 0.045) * (0.7 + 0.4 * (1.0 - maria)), uRed * 0.9);
        moon *= mix(1.9, 0.8, uRed); // a blood moon is dim: bright reds wash to peach under AgX
        // Halo: tight glow + wide veil, cool; blood-orange once the scores lock.
        float o = max(r - 1.0, 0.0);
        float halo = exp(-o * 1.7) * 0.34 + exp(-o * 0.42) * 0.075;
        halo *= 1.0 - smoothstep(3.4, ${MOON_QUAD.toFixed(1)}, r);
        vec3 hc = mix(vec3(0.5, 0.58, 0.9), vec3(0.95, 0.16, 0.08), uRed);
        // A thin cloud drifting across: darkens the disc, catches silver light in the halo.
        vec2 cq = vec2(vQ.x * 0.45 + uTime * 0.012, vQ.y * 1.9 + 0.6);
        float cloud = smoothstep(0.5, 0.78, fbm(cq)) * (1.0 - smoothstep(1.6, 3.2, abs(vQ.y + 0.3)));
        moon *= 1.0 - cloud * 0.55;
        vec3 col = moon * disc + (1.0 - disc) * hc * halo * (1.0 + cloud * 1.6 * exp(-o * 1.2));
        gl_FragColor = vec4(col, disc);
        ${FINISH}
      }`,
    ),
  );
  const moon = mesh('SKY_Moon', moonGeo, moonMat, -9);
  root.add(moon);

  // ── Distant hills + dead trees (beyond the fence; one static opaque mesh) ─────────────────────
  if (opts.background !== false) {
    const bgGeo = buildBackground(rand, cx, cz, half, T.trees, opts.quality === 'low' ? 2 : 3);
    const bgMat = new THREE.ShaderMaterial({
      name: 'MAT_BG_HillsDeadTrees',
      uniforms: { uFogColor, uFlash, uRed },
      side: THREE.DoubleSide,
      fog: false,
      vertexShader: /* glsl */ `
        attribute float aHaze;
        varying float vHaze;
        varying float vY;
        void main() {
          vHaze = aHaze;
          vY = position.y;
          gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uFogColor;
        uniform float uFlash, uRed;
        varying float vHaze;
        varying float vY;
        void main() {
          // Aerial perspective: near ridge a dark violet silhouette, far ridge hazier; mist pools at the foot.
          vec3 col = vec3(0.02, 0.017, 0.03);
          float haze = vHaze + (1.0 - smoothstep(0.0, 10.0, vY)) * 0.35;
          vec3 fogGrey = mix(uFogColor, vec3(dot(uFogColor, vec3(0.3, 0.55, 0.15))), 0.45);
          col = mix(col, fogGrey * 0.8, clamp(haze, 0.0, 0.85));
          col *= 1.0 - uFlash * 0.35;
          gl_FragColor = vec4(col, 1.0);
          ${FINISH}
        }`,
    });
    track(bgGeo, bgMat);
    root.add(mesh('BG_HillsDeadTrees', bgGeo, bgMat, 0));
  }

  // ── Bats ─────────────────────────────────────────────────────────────────────────────────────
  const batBase = buildBatGeometry();
  const batGeo = instanced(batBase, T.bats);
  const batOrbit = new Float32Array(T.bats * 4);
  const batMotion = new Float32Array(T.bats * 4);
  batGeo.setAttribute('aOrbit', new THREE.InstancedBufferAttribute(batOrbit, 4));
  batGeo.setAttribute('aMotion', new THREE.InstancedBufferAttribute(batMotion, 4));
  /**
   * Flocks: one wheeling over the plaza (the villains' stage), one per roost circling just above
   * a dead tree / giant pumpkin, and ~15 % wide stragglers crossing the whole landscape.
   */
  function writeBats(roosts: { x: number; z: number; h: number }[]): void {
    const br = createSeededRandom(opts.seed ^ 0xba7);
    const flocks: [number, number, number, number, number][] = [[cx, cz, 15, 13, 0.5]];
    for (const r of roosts.slice(0, MAX_ROOSTS)) flocks.push([r.x, r.z, 5 + br() * 4, r.h + 3 + br() * 3, 0.3]);
    for (let i = 0; i < T.bats; i++) {
      const straggler = i >= Math.round(T.bats * 0.85);
      const fi = i % flocks.length;
      const f = flocks[fi];
      const dir = fi % 2 === 0 ? 1 : -1;
      if (straggler) {
        batOrbit.set([cx + (br() - 0.5) * half * 0.6, cz + (br() - 0.5) * half * 0.6, half * (0.45 + br() * 0.25), 18 + br() * 8], i * 4);
        batMotion.set([dir * (0.06 + br() * 0.04), br() * Math.PI * 2, 6 + br() * 6, 9 + br() * 3], i * 4);
      } else {
        batOrbit.set([f[0] + (br() - 0.5) * 2, f[1] + (br() - 0.5) * 2, f[2] * (0.75 + br() * 0.5), f[3] + (br() - 0.5) * 3], i * 4);
        batMotion.set([dir * (f[4] * (0.85 + br() * 0.3)) * (12 / f[2]), br() * Math.PI * 2, 1 + br() * 2, 10 + br() * 4], i * 4);
      }
    }
    for (const k of ['aOrbit', 'aMotion']) (batGeo.getAttribute(k) as THREE.InstancedBufferAttribute).needsUpdate = true;
  }
  const defaultRoosts: { x: number; z: number; h: number }[] = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + rand() * 1.2;
    const d = half * (0.45 + rand() * 0.35);
    defaultRoosts.push({ x: cx + Math.cos(a) * d, z: cz + Math.sin(a) * d, h: 9 + rand() * 4 });
  }
  writeBats(defaultRoosts);
  geometries.push(batBase, batGeo);
  const batMat = new THREE.ShaderMaterial({
    name: 'MAT_FX_Bat',
    uniforms: { uTime, uFogColor, uFlash },
    side: THREE.DoubleSide,
    fog: false,
    vertexShader: /* glsl */ `
      attribute float aSpan;
      attribute vec4 aOrbit; // centre x, z, radius, height
      attribute vec4 aMotion; // angular speed (signed), phase, radius wobble, flap rate
      uniform float uTime;
      varying float vDist;
      varying float vSpan;
      void main() {
        float t = uTime, ph = aMotion.y;
        float th = ph + aMotion.x * t;
        float R = aOrbit.z + sin(t * 0.37 + ph * 3.1) * aMotion.z;
        vec3 c = vec3(aOrbit.x + cos(th) * R, aOrbit.w + sin(t * 0.8 + ph * 5.0) * 1.6, aOrbit.y + sin(th) * R);
        float sg = sign(aMotion.x);
        vec3 fwd = normalize(vec3(-sin(th), 0.0, cos(th)) * sg + vec3(0.0, cos(t * 0.8 + ph * 5.0) * 0.12, 0.0));
        vec3 inward = -vec3(cos(th), 0.0, sin(th));
        vec3 up = normalize(vec3(0.0, 1.0, 0.0) + inward * 0.5);
        vec3 rgt = normalize(cross(up, fwd));
        up = cross(fwd, rgt);
        // Flap: shoulder and lagging wrist; every few seconds a glide (amplitude drops).
        float fp = t * aMotion.w + ph * 7.0;
        float glide = smoothstep(-0.2, 0.5, sin(t * 0.45 + ph * 2.0));
        float amp = mix(0.2, 1.0, glide);
        float a1 = sin(fp) * 0.85 * amp;
        float a2 = sin(fp - 1.1) * 0.6 * amp;
        vec3 p = position;
        float side = sign(aSpan);
        float ax = abs(p.x);
        float elbow = 0.21;
        vec2 e1 = vec2(cos(a1), sin(a1));
        vec2 e2 = vec2(cos(a1 + a2), sin(a1 + a2));
        vec2 xy = e1 * min(ax, elbow) + e2 * max(ax - elbow, 0.0);
        p.x = side * xy.x;
        p.y += xy.y - sin(fp) * 0.07 * amp;
        p *= 0.95 + 0.35 * fract(ph * 3.7);
        vec3 w = c + rgt * p.x + up * p.y + fwd * p.z;
        vSpan = abs(aSpan);
        vec4 mv = viewMatrix * vec4(w, 1.0);
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uFogColor;
      uniform float uFlash;
      varying float vDist;
      varying float vSpan;
      void main() {
        vec3 col = mix(vec3(0.028, 0.018, 0.04), vec3(0.07, 0.045, 0.085), vSpan); // membrane a touch lighter
        col = mix(col, uFogColor * 0.6, smoothstep(40.0, 240.0, vDist) * 0.8);
        col *= 1.0 - uFlash * 0.5; // silhouettes go black against a lightning sky
        gl_FragColor = vec4(col, 1.0);
        ${FINISH}
      }`,
  });
  materials.push(batMat);
  const bats = mesh('FX_Bats', batGeo, batMat, 0);
  root.add(bats);

  // ── Wisps ────────────────────────────────────────────────────────────────────────────────────
  // Each wisp = head + (trail-1) lagging ghosts + one ground glow, all from the same path attributes.
  const perWisp = T.trail + 1;
  const wispCount = T.wisps * perWisp;
  const quad = new THREE.PlaneGeometry(1, 1);
  const wispGeo = instanced(quad, wispCount);
  const wispPath = new Float32Array(wispCount * 4);
  const wispMove = new Float32Array(wispCount * 4);
  const wispKind = new Float32Array(wispCount * 2);
  const setWisp = (i: number, path: number[], move: number[]) => {
    for (let k = 0; k < perWisp; k++) {
      const j = i * perWisp + k;
      wispPath.set(path, j * 4);
      wispMove.set(move, j * 4);
      wispKind.set(k === T.trail ? [0, 1] : [k * 0.16, 0], j * 2);
    }
  };
  // Path wisps drift back and forth along the four axis paths out of the plaza; the rest roam
  // the mist hollows (re-anchored by setMistZones / setGraveyard).
  const pathWisps = Math.round(T.wisps * 0.45);
  const legMid = PLAZA_R + (half - PLAZA_R) / 2;
  const legRange = ((half - PLAZA_R) / 2) * 0.85;
  for (let i = 0; i < T.wisps; i++) {
    const move = [0.05 + rand() * 0.06, rand() * 6.28, 1.0 + rand() * 1.2, 0.75 + rand() * 0.35];
    if (i < pathWisps) {
      const leg = i % 4;
      const along = leg < 2 ? 0 : 1;
      const mid = (leg % 2 === 0 ? 1 : -1) * legMid;
      const lane = (rand() - 0.5) * 4;
      setWisp(i, along === 0 ? [0, cx + mid, cz + lane, legRange] : [1, cx + lane, cz + mid, legRange], move);
    } else setWisp(i, [2, cx, cz + legMid, 8], move); // placed by writeMist()
  }
  wispGeo.setAttribute('aPath', new THREE.InstancedBufferAttribute(wispPath, 4));
  wispGeo.setAttribute('aMove', new THREE.InstancedBufferAttribute(wispMove, 4));
  wispGeo.setAttribute('aKind', new THREE.InstancedBufferAttribute(wispKind, 2));
  geometries.push(quad, wispGeo);
  const wispMat = fxMaterial(
    'MAT_FX_Wisp',
    T.oct,
    { uTime, uRed },
    /* glsl */ `
    attribute vec4 aPath; // mode (0 along x, 1 along z, 2 roam), x, z, range
    attribute vec4 aMove; // speed, phase, height, size
    attribute vec2 aKind; // lag (s), ground glow flag
    uniform float uTime;
    varying vec2 vUv;
    varying float vI;
    varying float vGround;
    ${BILLBOARD}
    vec3 wispPos(float t) {
      float ph = aMove.y;
      float s = sin(t * aMove.x + ph);
      float wob = sin(t * 0.6 + ph * 2.0) * 1.4;
      vec2 xz = aPath.x < 0.5 ? vec2(aPath.y + s * aPath.w, aPath.z + wob)
              : aPath.x < 1.5 ? vec2(aPath.y + wob, aPath.z + s * aPath.w)
              : vec2(aPath.y + sin(t * aMove.x * 2.6 + ph) * aPath.w, aPath.z + sin(t * aMove.x * 1.9 + ph * 1.7) * aPath.w * 0.8);
      float y = aMove.z + sin(t * 1.7 + ph * 3.0) * 0.3 + sin(t * 0.53 + ph) * 0.25;
      return vec3(xz.x, y, xz.y);
    }
    void main() {
      vUv = position.xy * 2.0;
      vGround = aKind.y;
      float flick = 0.78 + 0.14 * sin(uTime * 11.0 + aMove.y * 9.0) + 0.08 * sin(uTime * 27.0 + aMove.y * 3.0);
      vec3 c = wispPos(uTime - aKind.x * 3.0);
      vec3 w;
      if (aKind.y > 0.5) {
        float sz = 4.2 * aMove.w;
        w = vec3(c.x + position.x * sz, 0.145, c.z - position.y * sz);
        vI = flick * 0.32 / (0.6 + c.y * 0.35);
      } else {
        float k = 1.0 - aKind.x * 1.6;
        float sz = aMove.w * (aKind.x > 0.0 ? 0.55 * k : 1.0);
        w = c + (camRight() * position.x + camUp() * position.y) * sz;
        vI = flick * (aKind.x > 0.0 ? 0.4 * k : 1.0);
      }
      vec4 mv = viewMatrix * vec4(w, 1.0);
      vI *= 1.0 - smoothstep(70.0, 150.0, -mv.z);
      gl_Position = projectionMatrix * mv;
    }`,
    /* glsl */ `
    uniform float uRed;
    varying vec2 vUv;
    varying float vI;
    varying float vGround;
    void main() {
      float r2 = dot(vUv, vUv);
      vec3 green = mix(vec3(0.22, 1.0, 0.42), vec3(0.45, 1.0, 0.3), uRed * 0.5);
      vec3 col;
      if (vGround > 0.5) {
        col = green * exp(-r2 * 4.0) * vI;
      } else {
        float core = exp(-r2 * 38.0);
        float halo = exp(-r2 * 6.5);
        col = (vec3(0.85, 1.0, 0.82) * core * 2.6 + green * halo * 0.55) * vI;
      }
      col *= 1.0 - smoothstep(0.8, 1.0, r2);
      gl_FragColor = vec4(col, 0.0);
      ${FINISH}
    }`,
  );
  const wisps = mesh('FX_Wisps', wispGeo, wispMat, 3);
  root.add(wisps);

  // ── Ground mist (paths + hollows) ────────────────────────────────────────────────────────────
  const disc = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
  const mistGeo = instanced(disc, 0);
  const mistA = new Float32Array(MAX_MIST * T.mistLayers * 4); // x, z, radius, y
  const mistB = new Float32Array(MAX_MIST * T.mistLayers * 4); // seed, layer, stretch, angle
  const mistAttrA = new THREE.InstancedBufferAttribute(mistA, 4);
  const mistAttrB = new THREE.InstancedBufferAttribute(mistB, 4);
  mistGeo.setAttribute('aBank', mistAttrA);
  mistGeo.setAttribute('aBank2', mistAttrB);
  geometries.push(disc, mistGeo);
  let mistZones: { x: number; z: number; r: number; y?: number }[] = [];
  let graveyard: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null;

  /** Roaming wisps: the graveyard (if known) gets a third of them, the rest the largest mist zones. */
  function placeRoamers(): void {
    const wr = createSeededRandom(opts.seed ^ 0x3157);
    const zones = [...mistZones].sort((p, q) => q.r - p.r);
    const roamers = T.wisps - pathWisps;
    const inYard = graveyard ? Math.max(1, Math.round(roamers / 3)) : 0;
    for (let n = 0; n < roamers; n++) {
      const i = pathWisps + n;
      let x = cx, z = cz + legMid, reach = 8, y = 0;
      if (n < inYard && graveyard) {
        const g = graveyard;
        reach = Math.min(g.maxX - g.minX, g.maxZ - g.minZ) * 0.35;
        x = (g.minX + g.maxX) / 2 + (wr() - 0.5) * reach * 0.5;
        z = (g.minZ + g.maxZ) / 2 + (wr() - 0.5) * reach * 0.5;
      } else if (zones.length) {
        const zn = zones[n % zones.length];
        x = zn.x + (wr() - 0.5) * zn.r * 0.4;
        z = zn.z + (wr() - 0.5) * zn.r * 0.4;
        reach = Math.max(3, zn.r * 0.6);
        y = zn.y ?? 0;
      }
      for (let k = 0; k < perWisp; k++) {
        const j = (i * perWisp + k) * 4;
        wispPath.set([2, x, z, reach], j);
        wispMove[j + 2] = y + 0.9 + ((i * 0.37) % 1) * 1.1;
      }
    }
    (wispGeo.getAttribute('aPath') as THREE.InstancedBufferAttribute).needsUpdate = true;
    (wispGeo.getAttribute('aMove') as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  function writeMist(zones: { x: number; z: number; r: number; y?: number }[]): void {
    const mr = createSeededRandom(opts.seed ^ 0x5157);
    mistZones = zones.slice(0, MAX_MIST);
    let n = 0;
    for (let layer = 0; layer < T.mistLayers; layer++)
      for (const zn of mistZones) {
        const y = (zn.y ?? 0) + (layer === 0 ? 0.2 + mr() * 0.1 : 0.7 + mr() * 0.2);
        mistA.set([zn.x + (mr() - 0.5) * 2, zn.z + (mr() - 0.5) * 2, zn.r * (layer === 0 ? 1.15 : 0.85), y], n * 4);
        mistB.set([mr(), layer, 1 + mr() * 0.5, mr() * Math.PI], n * 4);
        n++;
      }
    mistGeo.instanceCount = n;
    mistAttrA.needsUpdate = true;
    mistAttrB.needsUpdate = true;
    placeRoamers();
  }

  // Default layout: the four axis paths out of the plaza, plus seeded hollows in between.
  const defaultZones: { x: number; z: number; r: number }[] = [];
  for (let d = PLAZA_R + 5; d < half - 4; d += T.pathStep)
    for (let leg = 0; leg < 4; leg++) {
      const sx = leg === 0 ? 1 : leg === 1 ? -1 : 0;
      const sz = leg === 2 ? 1 : leg === 3 ? -1 : 0;
      defaultZones.push({ x: cx + sx * d + (rand() - 0.5) * 3, z: cz + sz * d + (rand() - 0.5) * 3, r: 7 + rand() * 2.5 });
    }
  for (let tries = 0, made = 0; made < T.hollows && tries < 400; tries++) {
    const a = rand() * Math.PI * 2;
    const d = PLAZA_R + 10 + rand() * (half - PLAZA_R - 16);
    const x = cx + Math.cos(a) * d;
    const z = cz + Math.sin(a) * d;
    if (Math.abs(x - cx) > half - 6 || Math.abs(z - cz) > half - 6) continue;
    if (defaultZones.some((q) => (q.x - x) ** 2 + (q.z - z) ** 2 < 15 * 15)) continue;
    defaultZones.push({ x, z, r: 7 + rand() * 5 });
    made++;
  }

  const mistMat = fxMaterial(
    'MAT_FX_GroundMist',
    T.oct,
    { uTime, uFlash, uRed, uDensity },
    /* glsl */ `
    attribute vec4 aBank;
    attribute vec4 aBank2;
    varying vec2 vLocal;
    varying vec3 vWorld;
    varying float vSeed;
    varying float vLayer;
    void main() {
      // Slightly stretched, rotated discs so neighbouring patches do not read as circles.
      float c = cos(aBank2.w), s = sin(aBank2.w);
      vec2 l = position.xz * vec2(aBank2.z, 1.0);
      vLocal = position.xz;
      vec2 o = vec2(c * l.x - s * l.y, s * l.x + c * l.y) * aBank.z;
      vWorld = vec3(aBank.x + o.x, aBank.w, aBank.y + o.y);
      vSeed = aBank2.x;
      vLayer = aBank2.y;
      gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
    }`,
    /* glsl */ `
    uniform float uTime, uFlash, uRed, uDensity;
    varying vec2 vLocal;
    varying vec3 vWorld;
    varying float vSeed;
    varying float vLayer;
    ${NOISE}
    void main() {
      vec2 w = vWorld.xz * 0.09 + vec2(uTime * 0.035, uTime * 0.014) * (1.0 + vLayer * 0.6) + vSeed * 13.0;
      float n = fbm(w);
      float n2 = vnoise(w * 3.1 - uTime * 0.06);
      // Noise-eroded edge: no visible disc outline.
      float e = length(vLocal) + (n - 0.5) * 0.55;
      float edge = 1.0 - smoothstep(0.25, 0.95, e);
      float d = smoothstep(0.38, 0.85, n * 0.6 + n2 * 0.5);
      float a = edge * d * (vLayer > 0.5 ? 0.12 : 0.2) * uDensity;
      vec3 v = vWorld - cameraPosition;
      float dist = length(v);
      float steep = abs(v.y) / dist;
      a *= smoothstep(0.02, 0.16, steep);              // no edge-on sheets
      a *= mix(1.0, 0.55, smoothstep(0.5, 0.9, steep)); // thin when seen from above, like real ground fog
      a *= smoothstep(2.5, 11.0, dist);               // no veil over the lens
      a *= 1.0 - smoothstep(90.0, 190.0, dist);
      a = min(a, 0.5);
      vec3 col = mix(vec3(0.13, 0.13, 0.21), vec3(0.3, 0.3, 0.43), n2);
      col = mix(col, vec3(0.3, 0.1, 0.14), uRed * 0.55);
      col += vec3(0.3, 0.3, 0.45) * uFlash;
      gl_FragColor = vec4(col * a, a);
      ${FINISH}
    }`,
  );
  const mist = mesh('FX_GroundMist', mistGeo, mistMat, 2);
  root.add(mist);
  writeMist(defaultZones);

  // ── Plaza vortex mist ────────────────────────────────────────────────────────────────────────
  const circle = new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2);
  const plazaGeo = instanced(circle, T.plazaLayers);
  const plazaLayers = new Float32Array(T.plazaLayers * 4);
  const plazaY = [0.22, 0.6, 1.05];
  for (let i = 0; i < T.plazaLayers; i++) plazaLayers.set([plazaY[i], PLAZA_R + 3 - i * 2, i * 3.7, i], i * 4);
  plazaGeo.setAttribute('aLayer', new THREE.InstancedBufferAttribute(plazaLayers, 4));
  geometries.push(circle, plazaGeo);
  const plazaMat = fxMaterial(
    'MAT_FX_PlazaMist',
    T.oct,
    { uTime, uFlash, uRed, uDensity, uErupt, uSwirl, uRing, uCenter, uGain },
    /* glsl */ `
    attribute vec4 aLayer; // y, radius, seed, index
    uniform float uErupt;
    uniform vec2 uCenter;
    varying vec3 vWorld;
    varying vec2 vP;
    varying float vSeed;
    varying float vIdx;
    void main() {
      vP = position.xz * aLayer.y;
      vWorld = vec3(uCenter.x + vP.x, aLayer.x + uErupt * aLayer.w * 0.3, uCenter.y + vP.y);
      vSeed = aLayer.z;
      vIdx = aLayer.w;
      gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
    }`,
    /* glsl */ `
    uniform float uTime, uFlash, uRed, uDensity, uErupt, uSwirl, uRing, uGain;
    varying vec3 vWorld;
    varying vec2 vP;
    varying float vSeed;
    varying float vIdx;
    ${NOISE}
    void main() {
      float r = length(vP);
      float th = atan(vP.y, vP.x);
      // Differential rotation: the inner mist turns faster, so the noise winds into a vortex.
      float ang = th + uSwirl * (1.0 + vIdx * 0.25) * (6.0 / (r + 6.0));
      vec2 q = vec2(cos(ang), sin(ang)) * r * 0.085;
      float n = fbm(q + vSeed);
      float arms = 0.5 + 0.5 * sin(th * 3.0 + log(r + 1.0) * 3.2 - uSwirl * 2.0);
      float d = smoothstep(0.3, 0.8, n * mix(0.85, 1.2, arms) + (1.0 - smoothstep(0.0, 14.0, r)) * 0.12);
      float edge = 1.0 - smoothstep(${(PLAZA_R - 12).toFixed(1)}, ${(PLAZA_R + 2).toFixed(1)}, r + (n - 0.5) * 10.0);
      float a = d * edge * (0.17 - vIdx * 0.04) * (uDensity + uErupt * 1.6);
      vec3 v = vWorld - cameraPosition;
      float dist = length(v);
      a *= smoothstep(0.06, 0.3, abs(v.y) / dist);
      a *= smoothstep(2.5, 11.0, dist);
      a = min(a, 0.6);
      vec3 col = mix(vec3(0.16, 0.15, 0.25), vec3(0.32, 0.29, 0.43), n);
      // Under-glow from the circle, strongest on the lowest layer and near the ring/nodes.
      vec3 glow = mix(vec3(0.85, 0.1, 0.16), vec3(0.5, 0.12, 0.9), 0.5 + 0.5 * sin(th + uTime * 0.3));
      float ring = exp(-abs(r - 27.0) * 0.45) + exp(-r * 0.12) * uErupt * 1.5;
      col += glow * ring * uRing * uGain * (0.35 - vIdx * 0.1);
      col = mix(col, vec3(0.45, 0.16, 0.22), uRed * 0.4);
      col += vec3(0.5, 0.5, 0.75) * uFlash;
      gl_FragColor = vec4(col * a, a);
      ${FINISH}
    }`,
  );
  const plaza = mesh('FX_PlazaMist', plazaGeo, plazaMat, 2);
  root.add(plaza);

  // ── Summoning circle ─────────────────────────────────────────────────────────────────────────
  const [ringGeo, ringMat] = track(
    new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2),
    fxMaterial(
      'MAT_FX_SummoningCircle',
      T.oct,
      { uTime, uRing, uReveal, uErupt, uCenter, uGain, uExt: { value: PLAZA_R } },
      /* glsl */ `
      uniform vec2 uCenter;
      uniform float uExt;
      varying vec2 vP;
      void main() {
        vP = position.xz * uExt;
        gl_Position = projectionMatrix * viewMatrix * vec4(uCenter.x + vP.x, 0.135, uCenter.y + vP.y, 1.0);
      }`,
      /* glsl */ `
      uniform float uTime, uRing, uReveal, uErupt, uGain;
      varying vec2 vP;
      ${NOISE}
      float seg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)); }
      float stroke(float d, float w) { return smoothstep(w, w * 0.25, d) + exp(-d * 1.1) * 0.22; }
      void main() {
        float r = length(vP);
        float th = atan(vP.y, vP.x);
        float crack = 0.5 + 0.5 * vnoise(vec2(th * 18.0, 1.0));
        float I = (stroke(abs(r - 27.0), 0.22) + stroke(abs(r - 24.6), 0.1) * 0.7) * mix(0.45, 1.0, crack);
        // Rune band: 40 cells, about two thirds carry a glyph of bars and ticks.
        float cells = 40.0;
        float u = th / 6.2831853 * cells;
        float id = floor(u);
        float fu = fract(u) - 0.5;
        float fv = (r - 25.8) / 0.7;
        float hs = hash12(vec2(id, 3.0));
        float inBand = step(abs(fv), 1.0);
        float glyph = smoothstep(0.08, 0.02, abs(fu)) * step(0.3, hs);
        glyph = max(glyph, smoothstep(0.1, 0.03, abs(fv - (hs - 0.5) * 1.2)) * step(abs(fu), 0.28) * step(0.55, hs));
        glyph = max(glyph, smoothstep(0.1, 0.03, abs(fu - fv * 0.3 * sign(hs - 0.7))) * step(0.82, hs));
        I += glyph * inBand * 0.75;
        // Triangle between the three rise points (revealed in the second half).
        vec2 A = vec2(0.0, 24.6), B = vec2(-21.3, -12.3), C = vec2(21.3, -12.3);
        float tri = min(seg(vP, A, B), min(seg(vP, B, C), seg(vP, C, A)));
        I += stroke(tri, 0.1) * uReveal * smoothstep(0.25, 0.6, vnoise(vP * 0.7 + 4.0)) * 0.8;
        // Rise nodes at radius 6 (90°, 210°, 330°).
        float node = 1e3;
        for (int i = 0; i < 3; i++) {
          float a = 1.5707963 + float(i) * 2.0943951;
          node = min(node, abs(length(vP - vec2(cos(a), sin(a)) * ${RISE_R.toFixed(1)}) - 1.5));
        }
        I += (stroke(node, 0.12) * 1.5 + exp(-node * 0.6) * uErupt * 2.0) * (0.25 + uReveal);
        // A slow pulse circling the ring, and breakup so it reads as glowing cracks, not neon.
        I *= 0.62 + 0.38 * sin(th * 3.0 - uTime * 0.7);
        I *= 0.55 + 0.6 * vnoise(vP * 0.9 + uTime * 0.05);
        vec3 col = mix(vec3(1.0, 0.08, 0.1), vec3(0.55, 0.1, 1.0), 0.5 + 0.5 * sin(th + uTime * 0.25));
        float outer = 1.0 - smoothstep(28.5, 29.8, r);
        gl_FragColor = vec4(col * I * uRing * uGain * outer, 0.0);
        ${FINISH}
      }`,
      { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 },
    ),
  );
  const ring = mesh('FX_SummoningCircle', ringGeo, ringMat, 1);
  root.add(ring);

  // ── Lantern pools ────────────────────────────────────────────────────────────────────────────
  const lanternGeo = instanced(quad, 0);
  const lanternData = new Float32Array(MAX_LANTERNS * 4);
  const lanternAttr = new THREE.InstancedBufferAttribute(lanternData, 4);
  lanternGeo.setAttribute('aLan', lanternAttr);
  geometries.push(lanternGeo);
  const lanternMat = fxMaterial(
    'MAT_FX_LanternPool',
    T.oct,
    { uTime, uRed },
    /* glsl */ `
    attribute vec4 aLan; // x, ground y, z, phase
    uniform float uTime;
    varying vec2 vUv;
    varying float vI;
    void main() {
      vUv = position.xy * 2.0;
      float ph = aLan.w;
      // Candle flicker: two incommensurate sines plus a rare gutter.
      float t = uTime;
      vI = 0.86 + 0.08 * sin(t * 8.3 + ph * 5.0) + 0.06 * sin(t * 21.7 + ph * 11.0) - 0.18 * smoothstep(0.93, 1.0, sin(t * 1.3 + ph * 3.0));
      float sz = 3.6;
      vec4 mv = viewMatrix * vec4(aLan.x + position.x * sz, aLan.y + 0.02, aLan.z - position.y * sz, 1.0);
      vI *= 1.0 - smoothstep(70.0, 140.0, -mv.z);
      gl_Position = projectionMatrix * mv;
    }`,
    /* glsl */ `
    uniform float uRed;
    varying vec2 vUv;
    varying float vI;
    void main() {
      float r2 = dot(vUv, vUv);
      float f = (exp(-r2 * 9.0) * 0.7 + exp(-r2 * 3.0) * 0.3) * (1.0 - smoothstep(0.6, 1.0, r2));
      vec3 col = mix(vec3(1.0, 0.38, 0.07), vec3(1.0, 0.22, 0.05), uRed) * f * 0.5 * vI;
      gl_FragColor = vec4(col, 0.0);
      ${FINISH}
    }`,
    { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 },
  );
  const lanterns = mesh('FX_LanternPools', lanternGeo, lanternMat, 1);
  root.add(lanterns);

  // ── Burst pool (catches, eruption) ───────────────────────────────────────────────────────────
  const burstCount = BURST_SLOTS * PER_BURST;
  const burstGeo = instanced(quad, burstCount);
  const bA = new Float32Array(burstCount * 4).fill(-1e4); // origin xyz, start time (far past: dead)
  const bB = new Float32Array(burstCount * 4); // velocity xyz | ring radius, life
  const bC = new Float32Array(burstCount * 4); // colour rgb, kind
  const attrA = new THREE.InstancedBufferAttribute(bA, 4);
  const attrB = new THREE.InstancedBufferAttribute(bB, 4);
  const attrC = new THREE.InstancedBufferAttribute(bC, 4);
  for (const a of [attrA, attrB, attrC]) a.setUsage(THREE.DynamicDrawUsage);
  burstGeo.setAttribute('aA', attrA);
  burstGeo.setAttribute('aB', attrB);
  burstGeo.setAttribute('aC', attrC);
  geometries.push(burstGeo);
  const burstMat = fxMaterial(
    'MAT_FX_Burst',
    T.oct,
    { uTime },
    /* glsl */ `
    attribute vec4 aA;
    attribute vec4 aB;
    attribute vec4 aC;
    uniform float uTime;
    varying vec2 vUv;
    varying float vK;
    varying float vKind;
    varying vec3 vCol;
    ${BILLBOARD}
    void main() {
      float age = uTime - aA.w;
      float k = age / max(aB.w, 1e-3);
      vUv = position.xy * 2.0;
      vK = k;
      vKind = aC.w;
      vCol = aC.rgb;
      if (k < 0.0 || k > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
      vec3 w;
      if (aC.w < 0.5) {
        // Spark: thrown out, then buoyant and spiralling up like a released soul.
        float sp = age * 3.0;
        vec2 v = mat2(cos(sp), sin(sp), -sin(sp), cos(sp)) * aB.xz;
        vec3 c = aA.xyz + vec3(v.x, 0.0, v.y) * (1.0 - exp(-age * 2.5)) * 0.9 + vec3(0.0, aB.y * age + 0.9 * age * age, 0.0);
        float sz = 0.42 * (1.0 - k * 0.7);
        w = c + (camRight() * position.x + camUp() * position.y) * sz;
      } else if (aC.w < 1.5) {
        float e = 1.0 - pow(1.0 - k, 3.0);
        float rad = aB.x * e * 1.1 + 0.2;
        w = vec3(aA.x + position.x * rad * 2.0, aA.y, aA.z - position.y * rad * 2.0);
      } else {
        // Ghost: rises and sways, fading in then out.
        vec3 c = aA.xyz + vec3(sin(age * 3.0) * 0.35, 0.6 + age * 2.4, 0.0);
        float sz = 1.9 * (0.65 + 0.35 * min(k * 5.0, 1.0));
        vec3 up = vec3(0.0, 1.0, 0.0);
        w = c + (camRight() * position.x + up * position.y) * sz;
      }
      gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
    }`,
    /* glsl */ `
    uniform float uTime;
    varying vec2 vUv;
    varying float vK;
    varying float vKind;
    varying vec3 vCol;
    float sdEllipse(vec2 p, vec2 c, vec2 r) { return length((p - c) / r) - 1.0; }
    void main() {
      vec3 col;
      if (vKind < 0.5) {
        float r2 = dot(vUv, vUv);
        col = (vCol * exp(-r2 * 5.0) + vec3(0.9) * exp(-r2 * 30.0)) * 1.8 * (1.0 - vK);
      } else if (vKind < 1.5) {
        float r = length(vUv) * 1.1;
        float band = exp(-abs(r - 1.0) * 40.0) + exp(-abs(r - 1.0) * 9.0) * 0.12;
        col = vCol * band * 1.8 * pow(1.0 - vK, 2.0) * step(r, 1.08);
      } else {
        // Bedsheet ghost: head + body with a wavy hem, two eye holes and an O mouth.
        vec2 p = vUv;
        float hem = -0.78 + 0.08 * sin(p.x * 14.0 + uTime * 6.0);
        float body = max(abs(p.x) - 0.42 - (0.2 - p.y) * 0.12, max(p.y - 0.25, hem - p.y));
        float head = length(p - vec2(0.0, 0.25)) - 0.42;
        float d = min(head, body);
        float holes = min(min(sdEllipse(p, vec2(-0.15, 0.32), vec2(0.07, 0.11)), sdEllipse(p, vec2(0.15, 0.32), vec2(0.07, 0.11))), sdEllipse(p, vec2(0.0, 0.08), vec2(0.07, 0.09)));
        float fill = smoothstep(0.03, -0.03, d) * smoothstep(-0.02, 0.03, holes);
        float rim = exp(-abs(d) * 30.0) * 0.8;
        float fade = min(vK * 6.0, 1.0) * pow(1.0 - vK, 1.4);
        col = vCol * (fill * 0.55 + rim + exp(-max(d, 0.0) * 8.0) * 0.18) * fade * 1.5;
      }
      gl_FragColor = vec4(col, 0.0);
      ${FINISH}
    }`,
  );
  const bursts = mesh('FX_Bursts', burstGeo, burstMat, 4);
  root.add(bursts);

  skipAO(root);

  // ── State and envelopes ──────────────────────────────────────────────────────────────────────
  let now = 0;
  let lockedAt = -1;
  let huntAt = -1;
  let burstsUntil = -1;
  let nextSlot = 0;
  let nextAmbient = Infinity;
  const strikes = new Float32Array(6).fill(-1e4); // start times
  const strikeI = new Float32Array(6);
  const strikeBolt = new Uint8Array(6);
  let strikeNext = 0;
  let camYaw = 0;
  const camDir = new THREE.Vector3();
  const flashCap = opts.reducedFlash ? 0.25 : 1;

  // Scene fog / hemisphere modulation (found once the root is in a scene; restored on dispose).
  let scene: THREE.Scene | null = null;
  let hemi: THREE.HemisphereLight | null = null;
  let fogBase: { near: number; far: number; color: THREE.Color } | null = null;
  let hemiBase = 0;
  let hemiTouched = false;
  const fogRed = new THREE.Color(0x4a2436);

  function strike(at: number, intensity: number, bolt: boolean): void {
    strikes[strikeNext] = at;
    strikeI[strikeNext] = intensity;
    strikeBolt[strikeNext] = bolt ? 1 : 0;
    strikeNext = (strikeNext + 1) % strikes.length;
  }

  function emit(x: number, y: number, z: number, r: number, g: number, bl: number, sparks: number, ringR: number, ghost: boolean, delay = 0): void {
    const slot = nextSlot;
    nextSlot = (nextSlot + 1) % BURST_SLOTS;
    const t0 = now + delay;
    const base = slot * PER_BURST;
    for (let i = 0; i < PER_BURST; i++) {
      const j = (base + i) * 4;
      const kind = i < SPARKS ? 0 : i === SPARKS ? 1 : 2;
      const alive = kind === 0 ? i < sparks : kind === 1 ? ringR > 0 : ghost;
      bA[j] = x;
      bA[j + 1] = kind === 1 ? y + 0.03 : y + 0.4;
      bA[j + 2] = z;
      bA[j + 3] = alive ? t0 : -1e4;
      if (kind === 0) {
        const a = (i / sparks) * Math.PI * 2 + rand() * 0.4;
        const sp = 1.6 + rand() * 2.2;
        bB[j] = Math.cos(a) * sp;
        bB[j + 1] = 0.8 + rand() * 1.8;
        bB[j + 2] = Math.sin(a) * sp;
        bB[j + 3] = 0.9 + rand() * 0.6;
      } else if (kind === 1) {
        bB[j] = ringR;
        bB[j + 3] = 0.7 + ringR * 0.03;
      } else bB[j + 3] = 2.0;
      const w = kind === 2 ? 0.6 : 0;
      bC[j] = r + (1 - r) * w * 0.5;
      bC[j + 1] = g + (1 - g) * w * 0.3;
      bC[j + 2] = bl + (1 - bl) * w * 0.5;
      bC[j + 3] = kind;
    }
    for (const a of [attrA, attrB, attrC]) {
      a.clearUpdateRanges();
      a.addUpdateRange(base * 4, PER_BURST * 4);
      a.needsUpdate = true;
    }
    burstsUntil = Math.max(burstsUntil, t0 + 2.2);
    bursts.visible = true;
  }

  function findScene(): void {
    let o: THREE.Object3D | null = root.parent;
    while (o && !(o as THREE.Scene).isScene) o = o.parent;
    if (!o) return;
    scene = o as THREE.Scene;
    scene.traverse((c) => {
      if (!hemi && (c as THREE.HemisphereLight).isHemisphereLight) hemi = c as THREE.HemisphereLight;
    });
    if (scene.fog && (scene.fog as THREE.Fog).isFog) uFogColor.value.copy((scene.fog as THREE.Fog).color);
  }

  const fx: HalloweenFx = {
    root,

    update(dt: number, time: number, camera: THREE.Camera): void {
      now = time;
      uTime.value = time;
      if (!scene) findScene();
      camera.getWorldDirection(camDir);
      camYaw = Math.atan2(camDir.x, -camDir.z);

      // Half time: blood sky + thicker mist over ~3 s.
      const lock = lockedAt >= 0 ? ease((time - lockedAt) / 3) : 0;
      uRed.value = lock;
      // Hunt: eruption spike decaying to a restless baseline, circle flare → steady burn.
      let erupt = 0;
      let ringI = 0.32 + lock * 0.25;
      let reveal = lock * 0.25;
      if (huntAt >= 0) {
        const h = time - huntAt;
        const rise = ease(h / 0.35);
        erupt = rise * (0.35 + 0.65 * Math.exp(-Math.max(0, h - 0.35) / 2.2));
        ringI = 0.9 + rise * 1.9 * Math.exp(-Math.max(0, h - 0.35) / 1.6);
        reveal = 0.25 + 0.75 * rise;
        if (time >= nextAmbient) {
          strike(time, 0.3 + rand() * 0.25, rand() < 0.4);
          nextAmbient = time + 14 + rand() * 16;
        }
      }
      uErupt.value = erupt;
      uRing.value = ringI;
      uReveal.value = reveal;
      uDensity.value = 1 + lock * 0.7 + erupt * 0.3;
      uSwirl.value += dt * (0.07 + erupt * 0.5);

      // Lightning: sum of decaying strikes (each a sharp attack, ~70 ms decay).
      let flash = 0;
      let bolt = 0;
      for (let i = 0; i < strikes.length; i++) {
        const a = time - strikes[i];
        if (a < 0 || a > 1.2) continue;
        const e = strikeI[i] * Math.exp(-a * 14) * Math.min(1, a * 60 + 0.2);
        flash += e;
        if (strikeBolt[i]) bolt = Math.max(bolt, strikeI[i] * Math.exp(-a * 5));
      }
      flash = Math.min(flash, 1.2) * flashCap;
      uFlash.value = flash;
      uBolt.value = bolt;
      sky.visible = lock > 0.001 || flash > 0.002 || bolt > 0.002;

      if (scene) {
        const fog = scene.fog as THREE.Fog | null;
        if (fog && fog.isFog && lockedAt >= 0) {
          if (!fogBase) fogBase = { near: fog.near, far: fog.far, color: fog.color.clone() };
          fog.near = fogBase.near * (1 - 0.45 * lock);
          fog.far = fogBase.far * (1 - 0.4 * lock);
          fog.color.copy(fogBase.color).lerp(fogRed, lock * 0.6);
          uFogColor.value.copy(fog.color);
        }
        if (hemi) {
          if (flash > 0.002) {
            if (!hemiTouched) {
              hemiBase = hemi.intensity;
              hemiTouched = true;
            }
            hemi.intensity = hemiBase * (1 + flash * 1.6);
          } else if (hemiTouched) {
            hemi.intensity = hemiBase;
            hemiTouched = false;
          }
        }
      }

      if (bursts.visible && time > burstsUntil) bursts.visible = false;
      lanterns.visible = lanternGeo.instanceCount > 0;
    },

    onScoresLocked(): void {
      if (lockedAt < 0) lockedAt = now;
    },

    onHuntStart(): void {
      if (lockedAt < 0) lockedAt = now - 3;
      if (huntAt >= 0) return;
      huntAt = now;
      // Strike inside the player's view so the moment is seen: three-stroke flicker.
      uBoltAz.value = camYaw + (rand() - 0.5) * 0.5;
      uBoltSeed.value = rand() * 100;
      strike(now, 1, true);
      strike(now + 0.09, 0.55, true);
      strike(now + 0.3, 0.85, true);
      nextAmbient = now + 12 + rand() * 10;
      // The three rise points burst red/purple; one shock ring sweeps the whole plaza.
      for (let i = 0; i < 3; i++) {
        const a = Math.PI / 2 + (i * Math.PI * 2) / 3;
        const purple = i === 1;
        emit(cx + Math.cos(a) * RISE_R, 0.12, cz + Math.sin(a) * RISE_R, purple ? 0.6 : 1, 0.1, purple ? 1 : 0.18, SPARKS, 5, false, i * 0.12);
      }
      emit(cx, 0.12, cz, 0.9, 0.12, 0.5, 0, PLAZA_R - 2, false, 0.05);
    },

    onCaught(x: number, z: number): void {
      emit(x, 0.12, z, 0.3, 1, 0.45, SPARKS, 3.6, true);
    },

    setLanterns(points): void {
      const n = Math.min(points.length, MAX_LANTERNS);
      for (let i = 0; i < n; i++) {
        const p = points[i];
        lanternData[i * 4] = p.x;
        lanternData[i * 4 + 1] = p.y;
        lanternData[i * 4 + 2] = p.z;
        lanternData[i * 4 + 3] = (i * 7.31) % 6.28;
      }
      lanternAttr.clearUpdateRanges();
      lanternAttr.needsUpdate = true;
      lanternGeo.instanceCount = n;
      lanterns.visible = n > 0;
    },

    setGraveyard(rect): void {
      graveyard = rect;
      placeRoamers();
    },

    setMistZones(zones): void {
      writeMist(zones.length ? zones : defaultZones);
    },

    setRoosts(points): void {
      writeBats(points.length ? points : defaultRoosts);
    },

    reset(): void {
      lockedAt = -1;
      huntAt = -1;
      nextAmbient = Infinity;
      strikes.fill(-1e4);
      bA.fill(-1e4);
      attrA.clearUpdateRanges();
      attrA.needsUpdate = true;
      bursts.visible = false;
      restoreScene();
      uSwirl.value = 0;
    },

    dispose(): void {
      restoreScene();
      root.removeFromParent();
      for (const g of geometries) g.dispose();
      for (const m of new Set([...materials, wispMat, mistMat, plazaMat, lanternMat, burstMat])) m.dispose();
    },
  };

  function restoreScene(): void {
    const fog = scene?.fog as THREE.Fog | null | undefined;
    if (fog && fog.isFog && fogBase) {
      fog.near = fogBase.near;
      fog.far = fogBase.far;
      fog.color.copy(fogBase.color);
    }
    fogBase = null;
    if (hemi && hemiTouched) hemi.intensity = hemiBase;
    hemiTouched = false;
  }

  return fx;
}

/**
 * Bat silhouette (wingspan 1 m before per-bat scale ≈ 1.0–1.3 m; stylised large so it reads at
 * rooftop distance). +Z forward, +Y up. `aSpan` = signed span fraction (0 on the body) drives
 * the flap in the vertex shader. Two scalloped wings with finger tips, a body diamond with a
 * vertical keel so it does not vanish edge-on, and two ears. 34 triangles.
 */
function buildBatGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const span: number[] = [];
  const tri = (a: number[], b: number[], c: number[], s: [number, number, number]) => {
    pos.push(...a, ...b, ...c);
    span.push(...s);
  };
  // Right wing outline (x, z), half-span 0.5, from the shoulder round the tip and back.
  const outline = [
    [0.05, 0.08], [0.22, 0.16], [0.4, 0.15], [0.5, 0.02],
    [0.4, -0.06], [0.4, -0.2], [0.29, -0.07], [0.25, -0.22], [0.16, -0.08], [0.09, -0.18], [0.05, -0.1],
  ];
  const root = [0.04, 0];
  for (const side of [1, -1]) {
    for (let i = 0; i < outline.length - 1; i++) {
      const p = outline[i];
      const q = outline[i + 1];
      const sp = (x: number) => side * Math.max(0.001, x / 0.5);
      tri([side * root[0], 0, root[1]], [side * p[0], 0, p[1]], [side * q[0], 0, q[1]], [sp(root[0]), sp(p[0]), sp(q[0])]);
    }
  }
  // Body: flat diamond + vertical keel; ears.
  const head = [0, 0.02, 0.17];
  const tail = [0, 0, -0.14];
  tri(head, [0.05, 0, 0.04], tail, [0, 0, 0]);
  tri(head, tail, [-0.05, 0, 0.04], [0, 0, 0]);
  tri(head, [0, 0.05, 0.02], tail, [0, 0, 0]);
  tri(head, [0, -0.04, 0.02], tail, [0, 0, 0]);
  tri([0.015, 0.02, 0.15], [0.035, 0.07, 0.16], [0.03, 0.02, 0.12], [0, 0, 0]);
  tri([-0.015, 0.02, 0.15], [-0.03, 0.02, 0.12], [-0.035, 0.07, 0.16], [0, 0, 0]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aSpan', new THREE.Float32BufferAttribute(span, 1));
  return g;
}

/**
 * Landscape beyond the fence: two hill ridges (near ≈1.75× the half extent, far ≈3×) and dead,
 * forked trees standing on them as flat cards facing the district centre. Non-indexed, with an
 * `aHaze` attribute (0 near … 1 far) for aerial perspective. Near ridge 10–24 m, far 24–52 m
 * high: below the 18° moon from anywhere inside the bounds.
 */
function buildBackground(rand: () => number, cx: number, cz: number, half: number, trees: number, depth: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const haze: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[], h: number) => {
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    for (let i = 0; i < 6; i++) haze.push(h);
  };
  const ridges = [
    { R: half * 2.1, h0: 9, h1: 26, haze: 0.34, seg: 120 },
    { R: half * 3.2, h0: 26, h1: 56, haze: 0.6, seg: 96 },
  ];
  const crest: ((t: number) => number)[] = [];
  for (const rg of ridges) {
    const ph = [rand() * 6.28, rand() * 6.28, rand() * 6.28, rand() * 6.28];
    const height = (t: number) => {
      const n = 0.5 + 0.22 * Math.sin(t * 3 + ph[0]) + 0.16 * Math.sin(t * 7 + ph[1]) + 0.08 * Math.sin(t * 13 + ph[2]) + 0.05 * Math.sin(t * 29 + ph[3]);
      return rg.h0 + (rg.h1 - rg.h0) * Math.min(1, Math.max(0, n));
    };
    crest.push(height);
    for (let i = 0; i < rg.seg; i++) {
      const t0 = (i / rg.seg) * Math.PI * 2;
      const t1 = ((i + 1) / rg.seg) * Math.PI * 2;
      const P = (t: number, r: number, y: number) => [cx + Math.cos(t) * r, y, cz + Math.sin(t) * r];
      const h0 = height(t0);
      const h1 = height(t1);
      // Inner slope (foot → crest) and back slope (crest → outer shoulder).
      // The near ridge's apron runs in to 1.2× the half extent so no sky shows under a finite ground plane.
      const foot = rg === ridges[0] ? half * 1.2 : rg.R - 50;
      quad(P(t0, foot, -0.6), P(t1, foot, -0.6), P(t1, rg.R, h1), P(t0, rg.R, h0), rg.haze);
      quad(P(t0, rg.R, h0), P(t1, rg.R, h1), P(t1, rg.R + 40, h1 * 0.55), P(t0, rg.R + 40, h0 * 0.55), rg.haze);
    }
  }
  // Dead trees: forked branches as tapered cards in the plane facing the centre.
  const branch = (x: number, y: number, z: number, tx: number, tz: number, ang: number, len: number, w: number, d: number, h: number) => {
    const dx = Math.sin(ang);
    const dy = Math.cos(ang);
    const ex = x + tx * dx * len;
    const ey = y + dy * len;
    const ez = z + tz * dx * len;
    const sx = tx * Math.cos(ang);
    const sy = -Math.sin(ang);
    const w2 = w * 0.55;
    quad([x - (sx * w) / 2, y - (sy * w) / 2, z - (tz * Math.cos(ang) * w) / 2], [x + (sx * w) / 2, y + (sy * w) / 2, z + (tz * Math.cos(ang) * w) / 2],
      [ex + (sx * w2) / 2, ey + (sy * w2) / 2, ez + (tz * Math.cos(ang) * w2) / 2], [ex - (sx * w2) / 2, ey - (sy * w2) / 2, ez - (tz * Math.cos(ang) * w2) / 2], h);
    if (d <= 0) return;
    const kids = rand() < 0.3 ? 3 : 2;
    for (let k = 0; k < kids; k++) {
      const spread = (k - (kids - 1) / 2) * (0.55 + rand() * 0.35) + (rand() - 0.5) * 0.3;
      branch(ex, ey, ez, tx, tz, ang * 0.6 + spread, len * (0.58 + rand() * 0.18), w2, d - 1, h);
    }
  };
  const ringTrees = [trees, Math.round(trees / 2)];
  for (let r = 0; r < 2; r++) {
    const rg = ridges[r];
    for (let i = 0; i < ringTrees[r]; i++) {
      const t = ((i + rand() * 0.8) / ringTrees[r]) * Math.PI * 2;
      const rr = rg.R - rand() * 6;
      const x = cx + Math.cos(t) * rr;
      const z = cz + Math.sin(t) * rr;
      const ground = crest[r](t) * (1 - (rg.R - rr) / (r === 0 ? rg.R - half * 1.2 : 50)) - 0.8;
      const H = (r === 0 ? 9 + rand() * 8 : 13 + rand() * 9) * (rand() < 0.12 ? 1.6 : 1);
      // Card plane: tangent to the ring (faces the centre).
      branch(x, ground, z, -Math.sin(t), Math.cos(t), (rand() - 0.5) * 0.25, H * 0.45, H * 0.07, depth, rg.haze);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aHaze', new THREE.Float32BufferAttribute(haze, 1));
  g.computeBoundingSphere();
  return g;
}
