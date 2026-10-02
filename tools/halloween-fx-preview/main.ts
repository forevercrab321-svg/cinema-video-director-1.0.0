// Halloween atmosphere layer review page. Served by vite from the repo root:
//   npx vite --host 127.0.0.1 --port 5199  →  /tools/halloween-fx-preview/?view=play|chase|wide|moon&state=normal|locked|hunt|erupt|caught&quality=low|medium|high
// tools/halloween-fx-preview/shoot.mjs captures the review set to renders/review/halloween-fx/.
// The scene is a stand-in district (dark ground, street grid, block massing, lantern props) on
// the city kit's plan; only game/src/world/halloweenFx.ts is under review.
import * as THREE from 'three';
import { createSkyDome, type Palette } from '../../game/src/art/environment';
import { LAYER_NO_AO } from '../../game/src/art/layers';
import { RenderPipeline } from '../../game/src/art/postfx';
import { createHalloweenFx, HALLOWEEN_MOON_DIR } from '../../game/src/world/halloweenFx';

const q = new URLSearchParams(location.search);
const view = q.get('view') ?? 'play';
const state = q.get('state') ?? 'normal';
const quality = (q.get('quality') ?? 'medium') as 'low' | 'medium' | 'high';
const live = q.has('live');
const W = Number(q.get('w') ?? 1280);
const H = Number(q.get('h') ?? 720);

const renderer = new THREE.WebGLRenderer({ antialias: quality === 'low', preserveDrawingBuffer: true });
renderer.setSize(W, H);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const PALETTE: Palette = {
  sunDirection: HALLOWEEN_MOON_DIR,
  sunColor: new THREE.Color(0xb8c6ff),
  sunIntensity: 2.3,
  sky: { top: new THREE.Color(0x0d1230), mid: new THREE.Color(0x3a2a68), horizon: new THREE.Color(0xd8743e), ground: new THREE.Color(0x1a1622), sun: new THREE.Color(0xe9eeff) },
  clouds: -0.12,
  fog: new THREE.Color(0x3d3558),
  fogNear: 70,
  fogFar: 400,
  hemiSky: new THREE.Color(0x9a92d6),
  hemiGround: new THREE.Color(0x3e3040),
  hemiIntensity: 1.15,
  envIntensity: 0.5,
  cloudTint: new THREE.Color(0.3, 0.3, 0.42),
};

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(PALETTE.fog.clone(), PALETTE.fogNear, PALETTE.fogFar);
scene.add(createSkyDome(900, PALETTE));
scene.add(new THREE.HemisphereLight(PALETTE.hemiSky, PALETTE.hemiGround, PALETTE.hemiIntensity));
const key = new THREE.DirectionalLight(PALETTE.sunColor, PALETTE.sunIntensity);
key.position.copy(HALLOWEEN_MOON_DIR).multiplyScalar(150);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -110, right: 110, top: 110, bottom: -110, near: 1, far: 400 });
key.shadow.bias = -0.0005;
scene.add(key);

// ── Stand-in district (city kit plan: roads at 0/±56, plaza r 30, kerb 0.12) ─────────────────
const asphalt = new THREE.MeshStandardMaterial({ color: 0x2b2a30, roughness: 0.92 });
const paving = new THREE.MeshStandardMaterial({ color: 0x4a4650, roughness: 0.9 });
const wall = new THREE.MeshStandardMaterial({ color: 0x3e3640, roughness: 0.9 });
const roof = new THREE.MeshStandardMaterial({ color: 0x241f2a, roughness: 0.85 });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(260, 260).rotateX(-Math.PI / 2), asphalt);
ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(192, 48, 0x4c4658, 0x34303e);
grid.position.y = 0.005;
scene.add(grid);
const plaza = new THREE.Mesh(new THREE.CylinderGeometry(30, 30, 0.12, 64), paving);
plaza.position.y = 0.06;
plaza.receiveShadow = true;
scene.add(plaza);
const CELLS: [number, number][] = [[-96, -63], [-49, -10], [10, 49], [63, 96]];
let s = 7;
const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
for (const [x0, x1] of CELLS)
  for (const [z0, z1] of CELLS) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0 + 8, 0.12, z1 - z0 + 8), paving);
    side.position.set((x0 + x1) / 2, 0.06, (z0 + z1) / 2);
    side.receiveShadow = true;
    scene.add(side);
    // Two rows of houses facing the streets.
    for (let i = 0; i < 4; i++) {
      const w = (x1 - x0) / 2 - 2;
      const d = (z1 - z0) / 2 - 2;
      const h = 7 + rnd() * 9;
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wall);
      b.position.set(x0 + 1 + w / 2 + (i % 2) * (w + 2), h / 2, z0 + 1 + d / 2 + Math.floor(i / 2) * (d + 2));
      b.castShadow = b.receiveShadow = true;
      scene.add(b);
      const r = new THREE.Mesh(new THREE.ConeGeometry(Math.min(w, d) * 0.62, 4, 4).rotateY(Math.PI / 4), roof);
      r.position.set(b.position.x, h + 2, b.position.z);
      r.castShadow = true;
      scene.add(r);
    }
  }
// Jack-o'-lantern stand-ins on the sidewalks, every 16 m along each road.
const lanternPts: { x: number; y: number; z: number }[] = [];
const pumpkin = new THREE.MeshStandardMaterial({ color: 0xe0661a, emissive: 0xff7a1a, emissiveIntensity: 2.2, roughness: 0.6 });
const pumpkinGeo = new THREE.SphereGeometry(0.35, 12, 8).scale(1, 0.8, 1);
for (const [c, w] of [[-56, 14], [0, 20], [56, 14]] as const)
  for (let t = -88; t <= 88; t += 16)
    for (const sgn of [-1, 1]) {
      const off = c + sgn * (w / 2 + 2);
      for (const [x, z] of [[t, off], [off, t + 8]]) {
        if (x * x + z * z < 32 * 32) continue;
        lanternPts.push({ x, y: 0.12, z });
        const m = new THREE.Mesh(pumpkinGeo, pumpkin);
        m.position.set(x, 0.4, z);
        scene.add(m);
      }
    }

// ── Camera ──────────────────────────────────────────────────────────────────────────────────
const camera = new THREE.PerspectiveCamera(56, W / H, 0.03, 700);
camera.layers.enable(LAYER_NO_AO); // as the game's camera: FX live on the no-AO layer
const VIEWS: Record<string, [number[], number[], number?]> = {
  play: [[6, 8, 58], [6, 0.6, 46]], // gameplay: 8 m up, ~10 m back of a big machine south of the plaza
  chase: [[8, 2.6, 41.5], [10, 0.65, 35.4], 57.6], // second half: ≈1 m machine (CameraRig at diameter 1)
  wide: [[-30, 48, 112], [8, 0, -6]],
  moon: [[-20, 9, 66], [26, 18, -40]],
};
const [cp, lp, fov] = VIEWS[view] ?? VIEWS.play;
camera.position.set(cp[0], cp[1], cp[2]);
camera.lookAt(lp[0], lp[1], lp[2]);
if (fov) camera.fov = fov;
camera.updateProjectionMatrix();

// ── FX ──────────────────────────────────────────────────────────────────────────────────────
const fx = createHalloweenFx({ bounds: { minX: -96, maxX: 96, minZ: -96, maxZ: 96 }, quality, seed: 1031 });
scene.add(fx.root);
fx.setLanterns(lanternPts);
fx.setGraveyard({ minX: 63, maxX: 96, minZ: -49, maxZ: -10 });

const pipeline = new RenderPipeline(renderer, scene, camera, quality);

// Deterministic timeline: step to T, firing the state's events on the way.
const T = Number(q.get('t') ?? 40);
const events: [number, () => void][] = [];
if (state === 'locked') events.push([T - 3.5, () => fx.onScoresLocked()]);
if (state === 'hunt') events.push([T - 6.5, () => fx.onScoresLocked()], [T - 0.33, () => fx.onHuntStart()]);
if (state === 'erupt') events.push([T - 6.5, () => fx.onScoresLocked()], [T - 1.6, () => fx.onHuntStart()]);
if (state === 'caught') {
  const [x, z] = view === 'wide' ? [0, 40] : [lp[0] - 1, lp[2] - 4];
  events.push([T - 0.5, () => fx.onCaught(x, z)], [T - 0.2, () => fx.onCaught(x + 6, z - 5)]);
}
const dt = 1 / 30;
let time = 0;
for (; time < T; time += dt) {
  for (const e of events) if (e[0] >= time - 1e-6 && e[0] < time + dt - 1e-6) e[1]();
  fx.update(dt, time, camera);
}
fx.update(dt, T, camera);
pipeline.render();

// Layer cost: render the FX root alone (no composer) and read renderer.info.
function measure(): { calls: number; triangles: number } {
  const solo = new THREE.Scene();
  const parent = fx.root.parent!;
  solo.add(fx.root);
  renderer.info.autoReset = false;
  renderer.info.reset();
  renderer.setRenderTarget(null);
  renderer.render(solo, camera);
  const r = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
  renderer.info.autoReset = true;
  parent.add(fx.root);
  return r;
}
const fxStats = measure();
renderer.info.reset();
renderer.render(scene, camera);
const sceneStats = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
pipeline.render();
const w = window as unknown as { __ready: boolean; __stats: unknown };
w.__stats = { view, state, quality, fx: fxStats, scene: sceneStats };
w.__ready = true;

if (live) {
  const clock = new THREE.Clock();
  const loop = () => {
    const d = clock.getDelta();
    time += d;
    fx.update(d, time, camera);
    pipeline.render();
    requestAnimationFrame(loop);
  };
  addEventListener('keydown', (e) => {
    if (e.key === 'l') fx.onScoresLocked();
    if (e.key === 'h') fx.onHuntStart();
    if (e.key === 'c') fx.onCaught(lp[0], lp[2]);
  });
  loop();
}
