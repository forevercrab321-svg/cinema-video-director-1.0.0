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

// ── Stand-in landscape (Halloween Town after the CD correction: no houses, cars or roads) ─────
// Dark grass, dirt paths on the four axes out of the empty plaza (r 30, kerb 0.12), a graveyard
// of tombstones, dead trees, giant pumpkins, jack-o'-lanterns, an iron-fence perimeter at ±96 m.
const grass = new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 0.95 });
const dirt = new THREE.MeshStandardMaterial({ color: 0x3a3030, roughness: 0.95 });
const paving = new THREE.MeshStandardMaterial({ color: 0x46424c, roughness: 0.9 });
const stone = new THREE.MeshStandardMaterial({ color: 0x5a5866, roughness: 0.85 });
const bark = new THREE.MeshStandardMaterial({ color: 0x241d1c, roughness: 0.9 });
const iron = new THREE.MeshStandardMaterial({ color: 0x15141a, roughness: 0.6, metalness: 0.6 });
const pumpkinSkin = new THREE.MeshStandardMaterial({ color: 0xc8571a, roughness: 0.7 });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(260, 260).rotateX(-Math.PI / 2), grass);
ground.receiveShadow = true;
scene.add(ground);
for (const along of [0, 1]) {
  const path = new THREE.Mesh(new THREE.PlaneGeometry(along ? 6 : 192, along ? 192 : 6).rotateX(-Math.PI / 2), dirt);
  path.position.y = 0.01;
  path.receiveShadow = true;
  scene.add(path);
}
const plaza = new THREE.Mesh(new THREE.CylinderGeometry(30, 30, 0.12, 64), paving);
plaza.position.y = 0.06;
plaza.receiveShadow = true;
scene.add(plaza);
let s = 7;
const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
const add = (m: THREE.Mesh, x: number, y: number, z: number, ry = 0) => {
  m.position.set(x, y, z);
  m.rotation.y = ry;
  m.castShadow = m.receiveShadow = true;
  scene.add(m);
  return m;
};
// Graveyard (the east cell north of the axis path).
const yard = { minX: 50, maxX: 92, minZ: -46, maxZ: -12 };
for (let x = yard.minX + 3; x < yard.maxX - 2; x += 4.2)
  for (let z = yard.minZ + 3; z < yard.maxZ - 2; z += 4.6) add(new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.1 + rnd() * 0.6, 0.25), stone), x + rnd(), 0.6, z + rnd(), (rnd() - 0.5) * 0.2);
// Dead trees and giant pumpkins (the bat roosts).
const roosts: { x: number; z: number; h: number }[] = [];
const trees: [number, number][] = [[-48, -40], [44, 52], [-60, 58], [70, 20], [-30, -76], [20, -64], [-78, -10]];
for (const [x, z] of trees) {
  const h = 9 + rnd() * 5;
  add(new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.6, h, 6), bark), x, h / 2, z);
  for (let k = 0; k < 4; k++) {
    const br = add(new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.22, 4, 5), bark), x, h * (0.6 + k * 0.1), z, k * 1.6);
    br.rotation.z = 0.9;
  }
  roosts.push({ x, z, h });
}
for (const [x, z] of [[-40, 40], [44, -70], [-70, -60]]) {
  add(new THREE.Mesh(new THREE.SphereGeometry(3.2, 20, 14).scale(1.2, 0.85, 1.2), pumpkinSkin), x, 2.6, z);
  roosts.push({ x, z, h: 5.5 });
}
// Iron fence perimeter.
const post = new THREE.CylinderGeometry(0.05, 0.05, 2.2, 5);
for (let t = -96; t <= 96; t += 2)
  for (const [x, z] of [[t, -96], [t, 96], [-96, t], [96, t]]) add(new THREE.Mesh(post, iron), x, 1.1, z);
// Jack-o'-lanterns along the paths every 12 m, both sides.
const lanternPts: { x: number; y: number; z: number }[] = [];
const pumpkin = new THREE.MeshStandardMaterial({ color: 0xe0661a, emissive: 0xff7a1a, emissiveIntensity: 2.2, roughness: 0.6 });
const pumpkinGeo = new THREE.SphereGeometry(0.35, 12, 8).scale(1, 0.8, 1);
for (let t = 36; t <= 90; t += 12)
  for (const sgn of [-1, 1])
    for (const dir of [-1, 1])
      for (const [x, z] of [[dir * t, sgn * 4.2], [sgn * 4.2, dir * t + 6]]) {
        lanternPts.push({ x, y: 0, z });
        add(new THREE.Mesh(pumpkinGeo, pumpkin), x, 0.3, z);
      }

// ── Camera ──────────────────────────────────────────────────────────────────────────────────
const camera = new THREE.PerspectiveCamera(56, W / H, 0.03, 700);
camera.layers.enable(LAYER_NO_AO); // as the game's camera: FX live on the no-AO layer
const VIEWS: Record<string, [number[], number[], number?]> = {
  play: [[4, 8, 60], [4, 0.6, 48]], // gameplay: 8 m up, ~10 m back of a big machine on the south path
  chase: [[2, 2.6, 46], [5, 0.65, 40], 57.6], // second half: ≈1 m machine (CameraRig at diameter 1)
  wide: [[-30, 48, 112], [8, 0, -6]],
  moon: [[-24, 7, 70], [26, 16, -40]],
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
fx.setGraveyard(yard);
fx.setRoosts(roosts);

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
