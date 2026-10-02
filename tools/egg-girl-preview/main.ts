// Egg girl (蛋之谷) review page. Served by vite from the repo root:
//   npx vite --host 127.0.0.1 --port 5211  →  /tools/egg-girl-preview/?view=front|quarter|back|side|face|bag|hint|top|states
// tools/egg-girl-preview/shoot.mjs captures every view to renders/review/egg-girl/ (JPEG).
import * as THREE from 'three';
import { EggGirlModel, type EggGirlState } from '../../game/src/entities/EggGirlModel';

const q = new URLSearchParams(location.search);
const view = q.get('view') ?? 'front';
const front = view === 'front';
const W = front ? 800 : 1280;
const H = front ? 900 : 720;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const wrap = document.getElementById('wrap')!;
wrap.insertBefore(renderer.domElement, wrap.firstChild);
if (front) (document.getElementById('ref') as HTMLImageElement).style.display = 'block';

const scene = new THREE.Scene();
const night = view === 'hint' || view === 'top' || view === 'states';
scene.background = new THREE.Color(night ? 0x0d1220 : 0x1a2133);
scene.add(new THREE.HemisphereLight(0x9fb2e0, 0x2a2420, night ? 1.0 : 1.4));
const key = new THREE.DirectionalLight(0xdfe6ff, night ? 1.8 : 2.4);
key.position.set(-5, 10, 9);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6 });
scene.add(key);
const warm = new THREE.DirectionalLight(0xffb070, 0.8);
warm.position.set(6, 4, -7);
scene.add(warm);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: night ? 0x22262c : 0x3a3d42, roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(40, 40, 0x55606e, 0x40464f);
grid.position.y = 0.002;
scene.add(grid);

interface Inst { m: EggGirlModel; x: number; z: number; h: number; s: EggGirlState; t: number }
const girls: Inst[] = [];
const add = (x: number, z: number, h: number, s: EggGirlState, t = 1.2) => {
  const m = new EggGirlModel();
  scene.add(m.root);
  girls.push({ m, x, z, h, s, t });
  return m;
};
const cam = new THREE.PerspectiveCamera(30, W / H, 0.05, 200);
const FACE = Math.PI; // heading π faces +Z (towards the camera)
if (front) add(0, 0, FACE, (q.get('state') as EggGirlState) || ('idle' as EggGirlState));
switch (view) {
  case 'front': cam.fov = 26; cam.position.set(0, 1.05, 5.4); cam.lookAt(0, 1.0, 0); break;
  case 'quarter': add(0, 0, FACE - 0.7, 'idle' as EggGirlState); cam.position.set(0, 1.2, 5.6); cam.lookAt(0, 1.0, 0); break;
  case 'side': add(0, 0, FACE - Math.PI / 2, 'idle' as EggGirlState); cam.position.set(0, 1.2, 5.6); cam.lookAt(0, 1.0, 0); break;
  case 'back': add(0, 0, 0, 'idle' as EggGirlState); cam.position.set(0, 1.2, 5.6); cam.lookAt(0, 1.0, 0); break;
  case 'face': add(0, 0, FACE + 0.25, 'idle' as EggGirlState); cam.fov = 22; cam.position.set(0.25, 1.82, 1.25); cam.lookAt(0, 1.74, 0); break;
  case 'bag': {
    const m = add(-0.6, 0, FACE, 'idle' as EggGirlState);
    const c = m.makeBackpackCopy(1);
    c.position.set(0.55, 0, 0.2);
    scene.add(c);
    m.backpack.visible = true;
    cam.fov = 24; cam.position.set(0.1, 1.5, 2.6); cam.lookAt(0.0, 0.55, 0);
    break;
  }
  case 'hint': add(0, 0, FACE, 'hint', 2.0); cam.position.set(0, 1.4, 6); cam.lookAt(0, 1.0, 0); break;
  case 'top': {
    add(0, 0, FACE + 0.4, 'reveal', 1.5);
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x8a8d92 }));
    box.position.set(-1.6, 0.5, 0.4);
    box.castShadow = true;
    scene.add(box);
    cam.fov = 50; cam.position.set(0, 7, 8); cam.lookAt(0, 0.4, -0.5);
    break;
  }
  case 'states': {
    const st: [EggGirlState, number][] = [['idle' as EggGirlState, 1], ['reveal', 1.3], ['give', 1.5], ['hint', 2], ['gone', 0.35]];
    st.forEach(([s, t], i) => add(-3.2 + i * 1.6, 0, FACE, s, t));
    cam.fov = 34; cam.position.set(0, 1.6, 9.5); cam.lookAt(0, 1.0, 0);
    break;
  }
}
cam.updateProjectionMatrix();

// 'idle' = the reference pose (hand on hip, bag in the left hand) with normal materials: the model
// falls back to its base pose for any state it does not animate specially.
const steps = Number(q.get('steps') ?? 50);
for (let i = 0; i < steps; i++)
  for (const g of girls) {
    const t = Math.max(0, g.t - (steps - 1 - i) / 60);
    const s = (g.s as string) === 'idle' ? ('__idle' as EggGirlState) : g.s;
    g.m.update(1 / 60, g.x, g.z, g.h, 0, s, t);
  }
renderer.render(scene, cam);

// Budget (one model): triangles of all geometry; draw calls of what is visible per state.
const m = new EggGirlModel();
const count = (st: EggGirlState) => {
  m.update(1 / 60, 0, 0, 0, 0, st, 0.1);
  m.root.updateMatrixWorld(true);
  let meshes = 0, tris = 0, draws = 0;
  m.root.traverseVisible((o) => {
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (!g) return;
    meshes++;
    if ((o as THREE.Points).isPoints) { draws++; return; }
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    draws += Array.isArray((o as THREE.Mesh).material) ? g.groups.length : 1;
  });
  return { meshes, triangles: tris, drawCalls: draws };
};
const normal = count('give');
const hint = count('hint');
m.dispose();
(window as unknown as { __stats: unknown }).__stats = { normal, hint, uniqueGeometryTris: normal.triangles / 2 };
(window as unknown as { __ready: boolean }).__ready = true;
