// Halloween hunter review page. Served by vite from the repo root:
//   npx vite --host 127.0.0.1 --port 5198  →  /tools/hunter-preview/?view=lineup|quarter|top|poses
// tools/hunter-preview/shoot.mjs captures every view to renders/review/hunters/.
import * as THREE from 'three';
import { HunterModel, type HunterKind, type HunterPose } from '../../game/src/entities/HunterModel';

const q = new URLSearchParams(location.search);
const view = q.get('view') ?? 'lineup';
const W = 1280, H = 720;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x141a2a);
scene.fog = new THREE.Fog(0x141a2a, 30, 70);
scene.add(new THREE.HemisphereLight(0x8aa0d0, 0x2a2018, 1.3));
const moon = new THREE.DirectionalLight(0xc8d8ff, 2.2);
moon.position.set(-7, 12, 9); // key from the camera side so faces read; rim below
moon.castShadow = true;
moon.shadow.mapSize.set(2048, 2048);
Object.assign(moon.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12 });
scene.add(moon);
const warm = new THREE.DirectionalLight(0xffa860, 0.7); // jack-o'-lantern fill
warm.position.set(6, 4, -7);
scene.add(warm);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: 0x3a3d40, roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(40, 40, 0x55606e, 0x454c58);
grid.position.y = 0.002;
scene.add(grid);

const kinds: HunterKind[] = ['shock', 'cannibal', 'motel'];
const hunters: { m: HunterModel; x: number; z: number; h: number; pose: HunterPose; speed: number; rise?: number }[] = [];
const add = (kind: HunterKind, x: number, z: number, h: number, pose: HunterPose, speed: number, rise?: number) => {
  const m = new HunterModel(kind);
  scene.add(m.root);
  hunters.push({ m, x, z, h, pose, speed, rise });
};
const refs = () => {
  const boxM = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x8a8d92 }));
  boxM.position.set(-5.2, 0.5, 0);
  boxM.castShadow = true;
  const human = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 1.36, 6, 12), new THREE.MeshStandardMaterial({ color: 0x6f8fb0 }));
  human.position.set(-3.8, 0.9, 0);
  human.castShadow = true;
  scene.add(boxM, human);
};

const cam = new THREE.PerspectiveCamera(35, W / H, 0.1, 200);
if (view === 'lineup' || view === 'quarter' || view === 'top' || view === 'back') {
  refs();
  // facing the camera: heading π faces +Z
  const h = view === 'back' ? 0 : Math.PI;
  kinds.forEach((k, i) => add(k, -1.6 + i * 2.6, 0, h, 'idle', 0));
  if (view === 'lineup') { cam.position.set(-0.6, 1.6, 12.5); cam.lookAt(-0.6, 1.25, 0); }
  if (view === 'back') { cam.position.set(-0.6, 1.6, 12.5); cam.lookAt(-0.6, 1.25, 0); }
  if (view === 'quarter') { cam.position.set(7, 3.2, 9); cam.lookAt(-0.4, 1.2, 0); }
  if (view === 'top') {
    hunters.forEach((u) => { u.pose = 'chase'; u.speed = 6; u.h = 0; });
    cam.fov = 50; cam.position.set(0, 8, 10); cam.lookAt(0, 0, -1);
  }
} else if (view === 'face') {
  kinds.forEach((k, i) => add(k, -1.4 + i * 1.4, 0, Math.PI, 'idle', 0));
  cam.fov = 30; cam.position.set(0, 2.25, 5.2); cam.lookAt(0, 2.15, 0);
} else if (view === 'poses') {
  const k = (q.get('kind') as HunterKind) ?? 'shock';
  const poses: [HunterPose, number, number?][] = [['chase', 6], ['lunge', 6], ['grab', 0], ['rise', 0, 0.3], ['rise', 0, 0.7]];
  poses.forEach(([p, s, r], i) => add(k, -5.2 + i * 2.6, 0, Math.PI / 2 + 0.5, p, s, r));
  cam.fov = 40; cam.position.set(0, 2.4, 13); cam.lookAt(0, 1.1, 0);
}
cam.updateProjectionMatrix();

// Advance the procedural animation to a stable, representative frame.
const steps = Number(q.get('steps') ?? 47);
for (let i = 0; i < steps; i++) for (const u of hunters) u.m.update(1 / 60, u.x, u.z, u.h, u.speed, 0, u.pose, u.rise);
renderer.render(scene, cam);

// Geometry budget per character.
const stats: Record<string, { meshes: number; triangles: number; drawCalls: number }> = {};
for (const k of kinds) {
  const m = new HunterModel(k);
  let meshes = 0, tris = 0, draws = 0;
  m.root.traverse((o) => {
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (!g) return;
    meshes++;
    if ((o as THREE.Sprite).isSprite) { tris += 2; draws++; return; }
    if ((o as THREE.LineSegments).isLineSegments) { draws++; return; }
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    draws += Array.isArray((o as THREE.Mesh).material) ? g.groups.length : 1;
  });
  stats[k] = { meshes, triangles: tris, drawCalls: draws };
  m.dispose();
}
(window as unknown as { __stats: unknown; __ready: boolean }).__stats = stats;
(window as unknown as { __ready: boolean }).__ready = true;
