import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

/**
 * Golden-hour light (design §28). The visible sky is procedural (gradient + sun + drifting
 * cloud deck) so it stays sharp at any resolution; image-based lighting comes from a real
 * photographed HDRI (Poly Haven, CC0), rotated so its sun agrees with SUN_DIRECTION.
 */
export const SUN_DIRECTION = new THREE.Vector3(-0.6, 0.34, 0.72).normalize(); // south-west, ~20° up
export const SUN_COLOR = new THREE.Color(0xffc98f);
export const FOG_COLOR = new THREE.Color(0xd8c4a8);

/**
 * A city's light: sun, sky gradient, haze and ambient. Every city defines one; Scrap City's
 * golden hour below is the reference the realism pass was tuned on.
 */
export interface Palette {
  sunDirection: THREE.Vector3;
  sunColor: THREE.Color;
  sunIntensity: number;
  sky: { top: THREE.Color; mid: THREE.Color; horizon: THREE.Color; ground: THREE.Color; sun: THREE.Color };
  /** Cloud deck coverage bias: −0.15 clear … +0.2 overcast. */
  clouds: number;
  fog: THREE.Color;
  fogNear: number;
  fogFar: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  envIntensity: number;
  /** Multiplier on the cloud deck's light (night skies: dim, cool clouds). Default white = unchanged. */
  cloudTint?: THREE.Color;
}

export const GOLDEN_HOUR: Palette = {
  sunDirection: SUN_DIRECTION,
  sunColor: SUN_COLOR,
  sunIntensity: 3.4,
  sky: {
    top: new THREE.Color(0x3d6aa6),
    mid: new THREE.Color(0x8fb2d6),
    horizon: new THREE.Color(0xf4cf9f),
    ground: new THREE.Color(0x5d554b),
    sun: new THREE.Color(0xfff0d6),
  },
  clouds: 0,
  fog: FOG_COLOR,
  fogNear: 80,
  fogFar: 520,
  hemiSky: new THREE.Color(0xc7cfd8),
  hemiGround: new THREE.Color(0x7a6450),
  hemiIntensity: 0.8,
  envIntensity: 1.1,
};

export function createSkyDome(radius = 900, palette: Palette = GOLDEN_HOUR): THREE.Mesh {
  const SKY = palette.sky;
  const uniforms = {
    uTop: { value: SKY.top },
    uMid: { value: SKY.mid },
    uHorizon: { value: SKY.horizon },
    uGround: { value: SKY.ground },
    uSun: { value: SKY.sun },
    uSunDir: { value: palette.sunDirection },
    uTime: { value: 0 },
    uClouds: { value: palette.clouds },
    uCloudTint: { value: palette.cloudTint ?? new THREE.Color(1, 1, 1) },
  };
  const mat = new THREE.ShaderMaterial({
    name: 'MAT_SkyDome',
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop, uMid, uHorizon, uGround, uSun, uSunDir;
      uniform float uTime;
      uniform float uClouds;
      uniform vec3 uCloudTint;
      varying vec3 vDir;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }
      float fbm(vec2 p) {
        float s = 0.0, a = 0.5;
        for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; }
        return s;
      }
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 sd = normalize(uSunDir);
        float s = max(dot(d, sd), 0.0);
        vec3 col = h > 0.0
          ? mix(mix(uHorizon, uMid, smoothstep(0.0, 0.22, h)), uTop, smoothstep(0.18, 0.9, h))
          : mix(uHorizon * 0.9, uGround, smoothstep(0.0, 0.06, -h));
        // Mie-like glow around the sun and warm horizon band toward it.
        col += uSun * (pow(s, 900.0) * 8.0 + pow(s, 32.0) * 0.45 + pow(s, 5.0) * 0.18);
        col += vec3(0.32, 0.16, 0.05) * pow(s, 2.5) * (1.0 - smoothstep(0.0, 0.35, abs(h)));
        // Cloud deck: project onto a plane, two layers of fbm, lit from the sun side.
        if (h > 0.02) {
          vec2 uv = d.xz / (h + 0.08) * 0.9 + vec2(uTime * 0.004, uTime * 0.0015);
          float c = fbm(uv * 1.1);
          float cover = smoothstep(0.52, 0.78, c + fbm(uv * 0.35 + 3.0) * 0.35 - 0.12 + uClouds);
          float thick = smoothstep(0.55, 0.95, c);
          vec3 lit = mix(vec3(1.0, 0.86, 0.7), vec3(1.0, 0.95, 0.9), h) * (1.0 + pow(s, 6.0) * 1.2) * uCloudTint;
          vec3 shade = mix(uMid, vec3(0.62, 0.6, 0.64) * uCloudTint, 0.5);
          vec3 cloud = mix(lit, shade, thick * 0.65);
          float fade = smoothstep(0.02, 0.2, h);
          col = mix(col, cloud, cover * fade * 0.92);
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), mat);
  dome.name = 'ENV_SkyDome';
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  dome.userData.uniforms = uniforms;
  return dome;
}

/** Sky bakes per renderer and palette: rounds reuse them (each bake is a PMREM render target). */
const skyBakes = new WeakMap<THREE.WebGLRenderer, Map<Palette, THREE.Texture>>();

/** Fallback when the HDRI cannot load: environment baked from the procedural sky (cached per palette). */
export function bakeSkyEnvironment(renderer: THREE.WebGLRenderer, palette: Palette = GOLDEN_HOUR): THREE.Texture {
  let bakes = skyBakes.get(renderer);
  if (!bakes) skyBakes.set(renderer, (bakes = new Map()));
  const cached = bakes.get(palette);
  if (cached) return cached;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = bakeSky(pmrem, palette);
  pmrem.dispose();
  bakes.set(palette, rt.texture);
  return rt.texture;
}

/** PMREM of the procedural sky over a dark ground disc (256² cube faces, PMREMGenerator's default). */
function bakeSky(pmrem: THREE.PMREMGenerator, palette: Palette): THREE.WebGLRenderTarget {
  const envScene = new THREE.Scene();
  envScene.add(createSkyDome(50, palette));
  const ground = new THREE.Mesh(new THREE.CircleGeometry(49, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x3e3b37 }));
  ground.position.y = -0.5;
  envScene.add(ground);
  const rt = pmrem.fromScene(envScene, 0.02);
  envScene.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
  return rt;
}

/** The photographed HDRI's sun sits at azimuth atan2(z, x) = +51°; this turns it onto a palette's sun. */
const HDRI_SUN_AZ = THREE.MathUtils.degToRad(51.1);
const hdriRotationFor = (sun: THREE.Vector3): number => HDRI_SUN_AZ - Math.atan2(sun.z, sun.x);

export interface HdriEnvironment {
  /** PMREM texture, usable at once: a sky bake until the HDRI is in, then the HDRI (same object). */
  texture: THREE.Texture;
  rotationFor: (sun: THREE.Vector3) => number;
  rotationY: number;
  /** Resolves true once the HDRI replaced the bake, false if it could not load. */
  loaded: Promise<boolean>;
}

/**
 * Image-based lighting that never blocks the first frame. The texture starts as a sky bake
 * (golden-hour palette with its sun placed where the HDRI's sun is, so the same `rotationFor`
 * applies) and the photographed HDRI is prefiltered INTO THE SAME render target when `source`
 * delivers its URL: scenes that already hold the texture switch to the HDRI untouched.
 * The HDRI must be 1k (1024 × 512) so its PMREM has the bake's 256² faces.
 */
export function createProgressiveEnvironment(renderer: THREE.WebGLRenderer, source: Promise<string | null>): HdriEnvironment {
  // One generator for both passes: re-targeting needs its ping-pong buffer at the matching size.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const elevation = Math.asin(SUN_DIRECTION.y);
  const sunAtHdri = new THREE.Vector3(Math.cos(HDRI_SUN_AZ) * Math.cos(elevation), Math.sin(elevation), Math.sin(HDRI_SUN_AZ) * Math.cos(elevation));
  const rt = bakeSky(pmrem, { ...GOLDEN_HOUR, sunDirection: sunAtHdri });
  const loaded = source
    .then(async (url) => {
      if (!url) return false;
      const hdr = await new HDRLoader().setDataType(THREE.HalfFloatType).loadAsync(url);
      try {
        if (hdr.image.width !== 1024) throw new Error(`HDRI must be 1024 px wide (got ${hdr.image.width})`);
        hdr.mapping = THREE.EquirectangularReflectionMapping;
        pmrem.fromEquirectangular(hdr, rt);
        return true;
      } finally {
        hdr.dispose();
      }
    })
    .catch((e: unknown) => {
      console.warn('HDRI unavailable, keeping the sky bake', e);
      return false;
    })
    .finally(() => pmrem.dispose());
  return { texture: rt.texture, rotationFor: hdriRotationFor, rotationY: hdriRotationFor(SUN_DIRECTION), loaded };
}
