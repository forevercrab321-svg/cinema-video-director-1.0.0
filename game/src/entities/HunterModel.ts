import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Halloween hunters: three stylised cartoon horror characters that chase the machines in the
 * second half of the Halloween round (docs/halloween-mode.md).
 *
 *   shock    — electro-shock "doctor": white coat, square glasses, crackling baton.
 *   cannibal — orange prison jumpsuit, white muzzle mask, maroon eyes, cuffed hands.
 *   motel    — lanky man in his mother's floral dress, cardigan and grey bun wig, kitchen knife.
 *
 * Built at a nominal 2.6 m (chibi proportions: head ≈ 1/3.5 of height) and scaled to `height`.
 * Static geometry is merged per rig segment (torso, head, two arms, two legs) with one geometry
 * group per shared material, so each character is 6 skinned-by-hierarchy meshes plus a few FX
 * meshes. Materials are module-level and shared by all hunters. Animation is procedural:
 * shoulder/hip pivots, run cycle with arm swing, bob and lean, plus lunge / grab / rise poses.
 *
 * Root origin is at the feet; heading 0 faces −Z (heading h faces (−sin h, −cos h)), the same
 * convention as PlayerModel. Character right = +X.
 */
export type HunterKind = 'shock' | 'cannibal' | 'motel';
export type HunterPose = 'rise' | 'idle' | 'chase' | 'lunge' | 'grab';

const NOMINAL_H = 2.6;

// ---------------------------------------------------------------- shared materials
//
// Colour lives in vertex colours, so a whole rig segment of mixed colours is one draw call per
// material *class* (cloth / gloss / glow / textured). All classes are shared by every hunter.

type Cls = 'cloth' | 'gloss' | 'glow' | 'floral' | 'badge' | 'knife';
interface Paint { cls: Cls; c: THREE.Color }
const paint = (cls: Cls, hex: number): Paint => ({ cls, c: new THREE.Color(hex) });


function floralTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#d97f9d';
  g.fillRect(0, 0, 128, 128);
  // Deterministic scatter so every build looks the same.
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 14; i++) {
    const x = rnd() * 128, y = rnd() * 128, r = 6 + rnd() * 5;
    const petal = i % 3 === 0 ? '#fff4e6' : i % 3 === 1 ? '#b8284a' : '#f7c4d4';
    g.fillStyle = '#4f8a4a';
    g.beginPath();
    g.ellipse(x + r, y + r * 0.6, r * 0.7, r * 0.3, 0.6, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = petal;
    for (let p = 0; p < 5; p++) {
      const a = (p / 5) * Math.PI * 2;
      g.beginPath();
      g.arc(x + Math.cos(a) * r * 0.55, y + Math.sin(a) * r * 0.55, r * 0.45, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#f2c230';
    g.beginPath();
    g.arc(x, y, r * 0.28, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(4, 2);
  return t;
}

function badgeTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 32;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#f6f6f2';
  g.fillRect(0, 0, 64, 32);
  g.fillStyle = '#1f5fbf';
  g.fillRect(0, 0, 64, 9);
  g.fillStyle = '#d42a2a'; // red cross
  g.fillRect(6, 14, 12, 4);
  g.fillRect(10, 10, 4, 12);
  g.fillStyle = '#1b1b1b';
  g.font = 'bold 13px sans-serif';
  g.fillText('DR.', 24, 26);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}


type Mats = ReturnType<typeof makePaints>;
function makePaints() {
  return {
    skin: paint('cloth', 0xf1c194),
    pale: paint('cloth', 0xf0d0b4),
    coat: paint('cloth', 0xf4f6f7),
    shirt: paint('cloth', 0x9fc6ea),
    tie: paint('gloss', 0x1c2846),
    hairBlack: paint('gloss', 0x16171b),
    hairDark: paint('gloss', 0x2c2520),
    hairSlick: paint('cloth', 0x3a2f28),
    frame: paint('gloss', 0x0c0c0e),
    trousers: paint('cloth', 0x363a42),
    shoe: paint('gloss', 0x18181a),
    orange: paint('cloth', 0xf26a1b),
    orangeDark: paint('cloth', 0xc24f12),
    sneaker: paint('cloth', 0xeeeeea),
    muzzle: paint('gloss', 0xf3eee2),
    leather: paint('gloss', 0x5e3a20),
    steel: paint('gloss', 0xc8d0d8),
    knife: paint('knife', 0xffffff),
    wig: paint('cloth', 0xbab9c0),
    cardigan: paint('cloth', 0x8c703a),
    floral: paint('floral', 0xffffff),
    badge: paint('badge', 0xffffff),
    dark: paint('gloss', 0x1a0d10),
    batonBody: paint('gloss', 0x2a2d33),
    batonGrip: paint('gloss', 0xd8b020),
    eyeShock: paint('glow', 0xe6f6ff),
    eyeCannibal: paint('glow', 0xfff0e8),
    eyeMotel: paint('glow', 0xfff0c0),
    pupilDark: paint('glow', 0x111111),
    pupilMaroon: paint('glow', 0xb0102a),
  };
}
let paints: Mats | null = null;
const mats = (): Mats => (paints ??= makePaints());

let classMats: Record<Cls, THREE.Material> | null = null;
function classMaterial(cls: Cls): THREE.Material {
  classMats ??= {
    cloth: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, side: THREE.DoubleSide }),
    gloss: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38 }),
    glow: new THREE.MeshBasicMaterial({ vertexColors: true }),
    floral: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide, map: floralTexture() }),
    badge: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, map: badgeTexture() }),
    knife: new THREE.MeshStandardMaterial({ vertexColors: true, color: 0xdfe6ee, roughness: 0.25, metalness: 0.3, emissive: 0x3a4450 }),
  };
  return classMats[cls];
}

// ---------------------------------------------------------------- geometry kit

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Collects primitives in a segment's local frame, then merges them into one mesh with one group per material class. */
class Kit {
  private items: { g: THREE.BufferGeometry; cls: Cls }[] = [];
  add(g: THREE.BufferGeometry, p: Paint, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): this {
    _m4.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
    g.applyMatrix4(_m4);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = p.c.r; col[i * 3 + 1] = p.c.g; col[i * 3 + 2] = p.c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.items.push({ g, cls: p.cls });
    return this;
  }
  build(name: string, castShadow = true): THREE.Mesh {
    const byCls = new Map<Cls, THREE.BufferGeometry[]>();
    for (const it of this.items) {
      const list = byCls.get(it.cls) ?? [];
      list.push(it.g);
      byCls.set(it.cls, list);
    }
    const geos: THREE.BufferGeometry[] = [];
    const ms: THREE.Material[] = [];
    for (const [cls, list] of byCls) {
      geos.push(list.length === 1 ? list[0] : mergeGeometries(list, false)!);
      if (list.length > 1) for (const g of list) g.dispose();
      ms.push(classMaterial(cls));
    }
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, true)!;
    if (geos.length > 1) for (const g of geos) g.dispose();
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, ms.length === 1 ? ms[0] : ms);
    mesh.name = name;
    mesh.castShadow = castShadow;
    return mesh;
  }
}

const sphere = (r: number, w = 16, h = 12) => new THREE.SphereGeometry(r, w, h);
const cyl = (rt: number, rb: number, h: number, seg = 12, open = false) => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const lathe = (pts: [number, number][], seg = 18, phiStart = 0, phiLen = Math.PI * 2) =>
  new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg, phiStart, phiLen);
/** Arc of a torus in the XY plane, centred on angle `mid` (0 = +X, −π/2 = down). */
const arc = (r: number, tube: number, len: number, mid: number) => {
  const g = new THREE.TorusGeometry(r, tube, 6, 12, len);
  g.rotateZ(mid - len / 2);
  return g;
};

// ---------------------------------------------------------------- character specs

interface Body {
  hipY: number; // hip pivot height
  hipX: number; // leg pivot offset
  shoulderX: number;
  shoulderY: number; // relative to spine pivot (= hipY)
  neckY: number; // relative to spine pivot
  headR: number;
  headScale: [number, number, number];
  limbR: number;
  armLen: number;
}

const BODY: Record<HunterKind, Body> = {
  shock: { hipY: 0.82, hipX: 0.15, shoulderX: 0.37, shoulderY: 0.84, neckY: 0.98, headR: 0.37, headScale: [1.1, 0.96, 1.0], limbR: 0.105, armLen: 0.62 },
  cannibal: { hipY: 0.84, hipX: 0.16, shoulderX: 0.4, shoulderY: 0.82, neckY: 0.96, headR: 0.36, headScale: [1.0, 1.04, 1.0], limbR: 0.11, armLen: 0.62 },
  motel: { hipY: 0.9, hipX: 0.12, shoulderX: 0.31, shoulderY: 0.8, neckY: 0.93, headR: 0.36, headScale: [0.9, 1.08, 0.95], limbR: 0.08, armLen: 0.7 },
};

/** Position on the head ellipsoid's front surface (head-local, head centre at origin). */
function face(b: Body, x: number, y: number, out = 0): [number, number, number] {
  const [sx, sy, sz] = b.headScale;
  const R = b.headR;
  const u = x / (sx * R), v = y / (sy * R);
  const z = -sz * R * Math.sqrt(Math.max(0, 1 - u * u - v * v));
  return [x, y, z - out];
}

function buildTorso(kind: HunterKind, M: Mats): THREE.Mesh {
  const k = new Kit();
  const flat = 0.74;
  if (kind === 'shock') {
    // White coat: barrel torso + flared skirt to the knee.
    k.add(lathe([[0, -0.1], [0.3, -0.08], [0.32, 0.2], [0.33, 0.62], [0.32, 0.82], [0.22, 0.97], [0, 1.0]]), M.coat, 0, 0, 0, 0, 0, 0, 1, 1, flat);
    k.add(lathe([[0.31, 0.06], [0.355, -0.2], [0.39, -0.42]], 18), M.coat, 0, 0, 0, 0, 0, 0, 1, 1, 0.8);
    // Shirt V + tie on the chest, lapels framing it.
    const v = new THREE.CircleGeometry(0.17, 3, -Math.PI / 2);
    k.add(v, M.shirt, 0, 0.83, -0.228, 0.2, Math.PI, 0, 0.95, 1.25, 1);
    k.add(box(0.07, 0.3, 0.02), M.tie, 0, 0.72, -0.24, -0.06);
    k.add(box(0.09, 0.06, 0.03), M.tie, 0, 0.9, -0.215, -0.2);
    k.add(box(0.05, 0.36, 0.03), M.coat, -0.12, 0.79, -0.23, -0.12, 0, -0.42);
    k.add(box(0.05, 0.36, 0.03), M.coat, 0.12, 0.79, -0.23, -0.12, 0, 0.42);
    // Buttons + name badge on the wearer's left chest (−X).
    for (let i = 0; i < 3; i++) k.add(sphere(0.022, 8, 6), M.frame, 0, 0.5 - i * 0.17, -0.245);
    k.add(new THREE.PlaneGeometry(0.17, 0.085), M.badge, -0.18, 0.66, -0.212, 0, Math.PI + 0.45, 0);
    k.add(box(0.025, 0.12, 0.025), M.batonGrip, 0.2, 0.68, -0.205, 0, -0.45, 0); // breast-pocket pen line
  } else if (kind === 'cannibal') {
    k.add(lathe([[0, -0.12], [0.31, -0.1], [0.33, 0.2], [0.35, 0.6], [0.35, 0.8], [0.24, 0.95], [0, 0.98]]), M.orange, 0, 0, 0, 0, 0, 0, 1, 1, flat);
    // Collar, chest zip, prison number patch, belt.
    k.add(new THREE.CircleGeometry(0.12, 3, -Math.PI / 2), M.sneaker, 0, 0.87, -0.215, 0.3, Math.PI, 0, 1, 1.1, 1);
    k.add(box(0.03, 0.62, 0.02), M.orangeDark, 0, 0.45, -0.258);
    k.add(box(0.16, 0.1, 0.02), M.sneaker, 0.17, 0.66, -0.235, 0, -0.35, 0);
    k.add(box(0.3, 0.2, 0.02), M.sneaker, 0, 0.62, 0.25, 0.12, 0, 0); // number patch on the back
    k.add(box(0.22, 0.04, 0.025), M.dark, 0, 0.62, 0.262, 0.12, 0, 0);
    k.add(cyl(0.335, 0.32, 0.07, 18), M.orangeDark, 0, 0.06, 0, 0, 0, 0, 1, 1, flat + 0.04);
  } else {
    // Floral bodice under an open cardigan, flared dress skirt below the knee.
    k.add(lathe([[0, -0.08], [0.24, -0.06], [0.25, 0.25], [0.27, 0.62], [0.27, 0.78], [0.19, 0.92], [0, 0.95]]), M.floral, 0, 0, 0, 0, 0, 0, 1, 1, flat);
    k.add(lathe([[0.25, -0.02], [0.27, 0.25], [0.29, 0.62], [0.29, 0.78], [0.2, 0.93]], 16, Math.PI + 0.62, Math.PI * 2 - 1.24), M.cardigan, 0, 0, 0, 0, 0, 0, 1, 1, flat + 0.02);
    k.add(lathe([[0.23, 0.04], [0.3, -0.2], [0.38, -0.5], [0.4, -0.53]], 18), M.floral, 0, 0, 0, 0, 0, 0, 1, 1, 0.85);
    k.add(cyl(0.255, 0.255, 0.05, 16), M.cardigan, 0, 0.02, 0, 0, 0, 0, 1, 1, flat + 0.06);
    for (let i = 0; i < 3; i++) k.add(sphere(0.02, 8, 6), M.wig, 0.12, 0.62 - i * 0.16, -0.21);
  }
  return k.build(`Hunter_${kind}_Torso`);
}

function buildHead(kind: HunterKind, b: Body, M: Mats): THREE.Mesh {
  const k = new Kit();
  const R = b.headR;
  const [sx, sy, sz] = b.headScale;
  const skin = kind === 'shock' ? M.skin : M.pale;
  const cy = R * sy; // head centre above the neck pivot
  const at = (x: number, y: number, out = 0): [number, number, number] => {
    const p = face(b, x, y, out);
    return [p[0], p[1] + cy, p[2]];
  };
  k.add(sphere(R, 20, 14), skin, 0, cy, 0, 0, 0, 0, sx, sy, sz);
  k.add(cyl(0.11, 0.13, 0.16, 10), skin, 0, 0.02, 0);
  // Ears.
  k.add(sphere(0.07, 10, 8), skin, -sx * R, cy - 0.01, 0.02, 0, 0, 0, 0.55, 1, 0.8);
  k.add(sphere(0.07, 10, 8), skin, sx * R, cy - 0.01, 0.02, 0, 0, 0, 0.55, 1, 0.8);
  // Nose.
  k.add(sphere(0.05, 10, 8), skin, ...at(0, -0.04, -0.015), 0, 0, 0, 1, 0.9, 1);

  const eyeMat = kind === 'shock' ? M.eyeShock : kind === 'cannibal' ? M.eyeCannibal : M.eyeMotel;
  const pupil = kind === 'cannibal' ? M.pupilMaroon : M.pupilDark;
  const ex = kind === 'motel' ? 0.11 : 0.13;
  const ey = 0.05;
  const er = kind === 'motel' ? 0.07 : kind === 'cannibal' ? 0.06 : 0.065;
  for (const s of [-1, 1]) {
    k.add(sphere(er, 12, 8), eyeMat, ...at(s * ex, ey, -0.02), 0, 0, 0, 1, kind === 'cannibal' ? 0.7 : 1.1, 0.5);
    const pr = kind === 'motel' ? 0.022 : kind === 'cannibal' ? 0.032 : 0.03;
    k.add(sphere(pr, 8, 6), pupil, ...at(s * (ex - (kind === 'motel' ? 0 : 0.012)), ey - 0.005, 0.005), 0, 0, 0, 1, 1, 0.5);
    // Brows: angled down toward the nose for menace.
    const tilt = kind === 'motel' ? 0.15 : kind === 'cannibal' ? 0.32 : 0.28;
    const browMat = kind === 'motel' ? M.hairDark : kind === 'cannibal' ? M.hairDark : M.hairBlack;
    k.add(box(0.13, 0.03, 0.03), browMat, ...at(s * ex, ey + 0.11, 0.0), 0, 0, s * tilt);
  }

  if (kind === 'shock') {
    // Short black hair, side part (cap tilted back and to one side + a swept fringe).
    k.add(new THREE.SphereGeometry(R * 1.05, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), M.hairBlack, 0, cy + 0.02, 0.02, 0.42, 0, -0.08, sx, sy, sz);
    k.add(sphere(0.2, 12, 8), M.hairBlack, 0.1, cy + R * 0.72, -R * 0.45, 0.2, 0, -0.5, 1.4, 0.45, 0.8);
    k.add(box(0.012, 0.02, 0.2), M.skin, -0.12, cy + R * 0.98, -0.08, 0.3, 0, 0.3); // part line
    // Square dark-rimmed glasses.
    for (const s of [-1, 1]) {
      const rim = new THREE.TorusGeometry(0.095, 0.017, 4, 4);
      rim.rotateZ(Math.PI / 4);
      k.add(rim, M.frame, ...at(s * 0.13, 0.05, 0.035), 0, -s * 0.2, 0, 1.2, 0.9, 1);
      k.add(box(0.02, 0.022, 0.26), M.frame, s * (sx * R * 0.93), cy + 0.06, -0.15, 0, 0, 0);
    }
    k.add(box(0.07, 0.022, 0.022), M.frame, ...at(0, 0.075, 0.03));
    // Manic grin.
    k.add(arc(0.11, 0.02, Math.PI * 0.8, -Math.PI / 2), M.dark, ...at(0, -0.12, -0.0), -0.2, 0, 0, 1, 0.8, 1);
    k.add(box(0.15, 0.03, 0.02), M.sneaker, ...at(0, -0.17, -0.005), -0.25);
  } else if (kind === 'cannibal') {
    // Slicked-back hair with a widow's peak.
    // Slicked-back hair: a full ellipsoid shifted up and back, so it meets the forehead in a
    // clean receding curve (no jagged cap rim), with a slight widow's-peak dip from the tilt.
    k.add(sphere(R * 1.0, 22, 14), M.hairSlick, 0, cy + 0.075, 0.075, 0.12, 0, 0, sx * 1.03, sy * 0.98, sz * 1.02);
    // Muzzle: cream plate over mouth + jaw, dark slot with bars, leather strap round the head.
    const plate = new THREE.CylinderGeometry(R * 0.9, R * 0.72, 0.3, 18, 1, true, Math.PI - 1.2, 2.4);
    k.add(plate, M.muzzle, 0, cy - 0.14, 0, 0, 0, 0, sx, 1, sz * 1.08);
    k.add(box(0.24, 0.11, 0.02), M.dark, ...at(0, -0.14, 0.035));
    for (let i = -2; i <= 2; i++) k.add(box(0.026, 0.15, 0.03), M.muzzle, ...at(i * 0.05, -0.14, 0.05));
    k.add(box(0.3, 0.03, 0.03), M.muzzle, ...at(0, -0.065, 0.045));
    k.add(box(0.3, 0.03, 0.03), M.muzzle, ...at(0, -0.215, 0.03));
    k.add(new THREE.TorusGeometry(R * 1.1, 0.032, 4, 16, Math.PI + 0.9).rotateZ(-0.45), M.leather, 0, cy - 0.1, 0, Math.PI / 2, 0, 0, sx, sz, 1);
  } else {
    // Grey bun wig over dark hair.
    k.add(new THREE.SphereGeometry(R * 1.1, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.56), M.wig, 0, cy + 0.02, 0.03, 0.3, 0, 0, sx, sy * 0.95, sz);
    k.add(sphere(0.17, 14, 10), M.wig, 0, cy + R * 1.0, R * 0.32, 0, 0, 0, 1, 0.85, 1);
    k.add(new THREE.TorusGeometry(0.15, 0.04, 6, 14), M.wig, 0, cy + R * 0.94, R * 0.3, Math.PI / 2 - 0.4, 0, 0);
    k.add(box(0.2, 0.05, 0.04), M.hairDark, ...at(-0.06, 0.2, 0.01), 0, 0, 0.25); // dark fringe peeking out
    // Gaunt cheeks (dark eye bags) and a wide thin grin.
    for (const s of [-1, 1]) k.add(arc(0.06, 0.012, Math.PI * 0.7, -Math.PI / 2), M.dark, ...at(s * 0.11, -0.005, -0.005));
    k.add(arc(0.15, 0.016, Math.PI * 0.62, -Math.PI / 2), M.dark, ...at(0, -0.09, -0.005), -0.25, 0, 0, 1, 0.55, 1);
  }
  return k.build(`Hunter_${kind}_Head`);
}

/** Arm hanging along −Y from the shoulder pivot; hand at y = −(armLen + 0.08). */
function buildArm(kind: HunterKind, b: Body, M: Mats, right: boolean): THREE.Mesh {
  const k = new Kit();
  const sleeve = kind === 'shock' ? M.coat : kind === 'cannibal' ? M.orange : M.cardigan;
  const skin = kind === 'shock' ? M.skin : M.pale;
  const r = b.limbR;
  const L = b.armLen;
  k.add(sphere(r * 1.15, 12, 8), sleeve, 0, 0, 0);
  k.add(cyl(r * 1.0, r * 0.9, L, 10), sleeve, 0, -L / 2, 0);
  const handY = -(L + 0.07);
  k.add(sphere(r * 1.05, 12, 8), skin, 0, handY, 0, 0, 0, 0, 1, 1.1, 1);
  k.add(sphere(r * 0.45, 8, 6), skin, right ? -r * 0.7 : r * 0.7, handY + 0.02, -r * 0.5); // thumb
  if (kind === 'shock') {
    k.add(cyl(r * 0.92, r * 0.92, 0.05, 10), M.shirt, 0, -L + 0.01, 0);
    if (right) {
      // Baton gripped like a sword, pointing forward (−Z) out of the fist.
      const bx = 0, by = handY;
      k.add(cyl(0.035, 0.035, 0.24, 8), M.batonGrip, bx, by, -0.02, Math.PI / 2);
      k.add(cyl(0.06, 0.06, 0.03, 10), M.batonBody, bx, by, -0.15, Math.PI / 2);
      k.add(cyl(0.04, 0.045, 0.46, 8), M.batonBody, bx, by, -0.39, Math.PI / 2);
      for (const s of [-1, 1]) k.add(box(0.015, 0.015, 0.07), M.steel, bx + s * 0.025, by, -0.64);
    }
  } else if (kind === 'cannibal') {
    // Steel cuff + half the chain (the two halves meet between the clasped hands).
    k.add(new THREE.TorusGeometry(r * 0.95, 0.025, 6, 12), M.steel, 0, -L + 0.0, 0, Math.PI / 2);
    for (let i = 0; i < 2; i++) {
      const t = new THREE.TorusGeometry(0.035, 0.011, 4, 8);
      k.add(t, M.steel, (right ? -1 : 1) * (r + 0.03 + i * 0.05), -L, 0, 0, i % 2 ? Math.PI / 2 : 0, 0);
    }
  } else {
    k.add(cyl(r * 1.1, r * 1.1, 0.06, 10), M.cardigan, 0, -L + 0.02, 0);
    if (right) {
      // Kitchen knife held in an overhead stabbing grip: blade exits the fist at the pinky side.
      k.add(cyl(0.03, 0.032, 0.17, 8), M.leather, 0, handY, 0.02, Math.PI / 2);
      k.add(new THREE.BoxGeometry(0.014, 0.08, 0.4).translate(0, -0.01, 0.2), M.knife, 0, handY + 0.03, 0.11);
      k.add(new THREE.ConeGeometry(0.04, 0.12, 4).rotateX(Math.PI / 2).scale(0.35, 1, 1), M.knife, 0, handY + 0.03, 0.56);
    }
  }
  return k.build(`Hunter_${kind}_Arm${right ? 'R' : 'L'}`);
}

function buildLeg(kind: HunterKind, b: Body, M: Mats, right: boolean): THREE.Mesh {
  const k = new Kit();
  const cloth = kind === 'cannibal' ? M.orange : M.trousers;
  const shoe = kind === 'cannibal' ? M.sneaker : kind === 'motel' ? M.leather : M.shoe;
  const r = b.limbR * 1.15;
  const L = b.hipY - 0.12;
  k.add(cyl(r, r * 0.88, L, 10), cloth, 0, -L / 2, 0);
  if (kind === 'cannibal') k.add(cyl(r * 0.92, r * 0.92, 0.05, 10), M.orangeDark, 0, -L + 0.04, 0);
  k.add(sphere(0.15, 12, 8), shoe, right ? 0.01 : -0.01, -b.hipY + 0.075, -0.07, 0, 0, 0, 0.78, 0.55, 1.35);
  return k.build(`Hunter_${kind}_Leg${right ? 'R' : 'L'}`);
}

// ---------------------------------------------------------------- spark FX (shock only)

let sparkTex: THREE.CanvasTexture | null = null;
function glowTexture(): THREE.CanvasTexture | null {
  if (sparkTex || typeof document === 'undefined') return sparkTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (!g) return null;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(160,220,255,0.85)');
  grd.addColorStop(1, 'rgba(60,120,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  sparkTex = new THREE.CanvasTexture(c);
  sparkTex.colorSpace = THREE.SRGBColorSpace;
  return sparkTex;
}

const SPARK_SEGS = 14;

// ---------------------------------------------------------------- the model

export class HunterModel {
  readonly root = new THREE.Group();
  readonly kind: HunterKind;
  private readonly body = new THREE.Group(); // bob / rise offset
  private readonly spine = new THREE.Group(); // lean pivot at the hips
  private readonly neck = new THREE.Group();
  private readonly shoulderL = new THREE.Group();
  private readonly shoulderR = new THREE.Group();
  private readonly hipL = new THREE.Group();
  private readonly hipR = new THREE.Group();
  private readonly meshes: THREE.Object3D[] = [];
  private readonly ownMaterials: THREE.Material[] = [];
  private readonly b: Body;
  private readonly scale: number;

  // FX (shock)
  private tip: THREE.Mesh | null = null;
  private tipMat: THREE.MeshBasicMaterial | null = null;
  private sparks: THREE.LineSegments | null = null;
  private sparkPos: THREE.BufferAttribute | null = null;
  private halo: THREE.Sprite | null = null;
  private readonly tipZ = -0.68;
  private sparkTimer = 0;

  // animation state
  private t = Math.random() * 10;
  private phase = 0;
  private aLX = 0; private aLZ = -0.1;
  private aRX = 0; private aRZ = 0.1;
  private lL = 0; private lR = 0;
  private lean = 0; private twist = 0; private headX = 0; private headZ = 0; private bob = 0;

  constructor(kind: HunterKind, height = NOMINAL_H) {
    this.kind = kind;
    const b = (this.b = BODY[kind]);
    const M = mats();
    this.scale = height / NOMINAL_H;
    this.root.name = `Hunter_${kind}`;
    this.root.scale.setScalar(this.scale);

    this.body.name = 'Body';
    this.root.add(this.body);
    this.spine.position.y = b.hipY;
    this.body.add(this.spine);

    const torso = buildTorso(kind, M);
    this.spine.add(torso);

    this.neck.position.y = b.neckY;
    this.spine.add(this.neck);
    const head = buildHead(kind, b, M);
    this.neck.add(head);

    this.shoulderL.position.set(-b.shoulderX, b.shoulderY, 0);
    this.shoulderR.position.set(b.shoulderX, b.shoulderY, 0);
    this.spine.add(this.shoulderL, this.shoulderR);
    const armL = buildArm(kind, b, M, false);
    const armR = buildArm(kind, b, M, true);
    this.shoulderL.add(armL);
    this.shoulderR.add(armR);

    this.hipL.position.set(-b.hipX, b.hipY, 0);
    this.hipR.position.set(b.hipX, b.hipY, 0);
    this.body.add(this.hipL, this.hipR);
    const legL = buildLeg(kind, b, M, false);
    const legR = buildLeg(kind, b, M, true);
    this.hipL.add(legL);
    this.hipR.add(legR);

    this.meshes.push(torso, head, armL, armR, legL, legR);

    if (kind === 'shock') {
      const handY = -(b.armLen + 0.07);
      this.tipMat = new THREE.MeshBasicMaterial({ color: 0x9fdcff });
      this.ownMaterials.push(this.tipMat);
      const tipGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.1, 8).rotateX(Math.PI / 2);
      this.tip = new THREE.Mesh(tipGeo, this.tipMat);
      this.tip.name = 'Hunter_shock_BatonTip';
      this.tip.position.set(0, handY, this.tipZ + 0.06);
      this.shoulderR.add(this.tip);

      const sg = new THREE.BufferGeometry();
      this.sparkPos = new THREE.BufferAttribute(new Float32Array(SPARK_SEGS * 2 * 3), 3);
      this.sparkPos.setUsage(THREE.DynamicDrawUsage);
      sg.setAttribute('position', this.sparkPos);
      sg.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, handY, this.tipZ), 0.6);
      const sm = new THREE.LineBasicMaterial({ color: 0xd8f2ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
      this.ownMaterials.push(sm);
      this.sparks = new THREE.LineSegments(sg, sm);
      this.sparks.name = 'Hunter_shock_Sparks';
      this.sparks.frustumCulled = false;
      this.shoulderR.add(this.sparks);

      const hm = new THREE.SpriteMaterial({ map: glowTexture(), color: 0x8fd0ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
      this.ownMaterials.push(hm);
      this.halo = new THREE.Sprite(hm);
      this.halo.name = 'Hunter_shock_Glow';
      this.halo.position.set(0, handY, this.tipZ);
      this.halo.scale.setScalar(0.6);
      this.shoulderR.add(this.halo);
      this.meshes.push(this.tip, this.sparks, this.halo);
    }
  }

  update(dt: number, x: number, z: number, heading: number, speed: number, groundY: number, pose: HunterPose, riseT = 1): void {
    const s = this.scale;
    this.t += dt;
    const t = this.t;
    this.root.position.set(x, groundY, z);
    this.root.rotation.y = heading;

    // Run cycle: one full cycle (two steps) per ~2.4 m at nominal size.
    const amp = pose === 'chase' || pose === 'lunge' ? Math.min(1, speed / (4.5 * s)) : pose === 'idle' ? Math.min(0.5, speed / (4.5 * s)) : 0;
    this.phase += dt * (speed / (2.4 * s)) * Math.PI * 2;
    const ph = this.phase;
    const sw = Math.sin(ph);

    // ----- targets
    let aLX = -0.65 * amp * sw, aRX = 0.65 * amp * sw;
    let aLZ = -0.12, aRZ = 0.12;
    let lL = 0.75 * amp * sw, lR = -0.75 * amp * sw;
    let lean = -0.3 * amp, twist = 0.12 * amp * sw;
    let headX = 0.1 * amp, headZ = 0;
    let bob = (1 - Math.abs(Math.cos(ph))) * 0.07 * amp;
    let breathe = 0;

    if (pose === 'idle') {
      breathe = Math.sin(t * 1.8);
      aLX += 0.04 * breathe; aRX += 0.04 * breathe;
      lean = -0.03 + 0.02 * breathe;
      headX = 0.05 * Math.sin(t * 0.9);
      twist = 0.12 * Math.sin(t * 0.5);
      bob = 0.012 * breathe;
    } else if (pose === 'lunge') {
      aLX = 1.5; aRX = 1.5; aLZ = 0.05; aRZ = -0.05;
      lL = 0.8; lR = -0.55; lean = -0.5; headX = -0.25; bob = -0.05; twist = 0;
    } else if (pose === 'grab') {
      const clamp = Math.sin(t * 14) * 0.06;
      aLX = 1.25 + clamp; aRX = 1.25 + clamp; aLZ = 0.55; aRZ = -0.55;
      lL = 0.35; lR = -0.25; lean = -0.32; headX = -0.15; bob = -0.08; twist = 0;
    } else if (pose === 'rise') {
      const claw = Math.sin(t * 7);
      aLX = 2.75 + 0.3 * claw; aRX = 2.75 - 0.3 * claw; aLZ = -0.25; aRZ = 0.25;
      lL = 0.15 * claw; lR = -0.15 * claw; lean = 0.1 * Math.sin(t * 3); headX = -0.2; twist = 0.15 * claw;
      bob = 0;
    }

    // Character-specific arm business.
    if (this.kind === 'shock') {
      if (pose === 'chase' || pose === 'idle') { aRX = (pose === 'chase' ? 1.05 : 0.55) + 0.12 * Math.sin(ph * 2); aRZ = 0.05; }
      else if (pose === 'lunge') { aRX = 1.6; aRZ = -0.08; }
      else if (pose === 'grab') { aRX = 1.1 + 0.25 * Math.sin(t * 20); aRZ = -0.2; }
      headZ = 0.06 * Math.sin(t * 2.3); // jaunty head bobble
    } else if (this.kind === 'cannibal') {
      // Cuffed: both arms always move together, hands clasped in front.
      let ax = pose === 'chase' ? 0.55 + 0.1 * Math.sin(ph * 2) : pose === 'idle' ? 0.38 + 0.02 * breathe : (aLX + aRX) / 2;
      if (pose === 'grab') ax = 1.6 + 0.1 * Math.sin(t * 14);
      aLX = aRX = ax;
      aLZ = 0.42; aRZ = -0.42;
      headX += 0.08; // head lowered, staring up from under the brow
    } else {
      if (pose === 'chase') { aRX = 2.75 + 0.35 * Math.sin(ph * 2); aRZ = 0.2; aLX *= 1.3; aLZ = -0.3; }
      else if (pose === 'idle') { aRX = 0.25 + 0.04 * breathe; aRZ = 0.1; }
      else if (pose === 'lunge') { aRX = 2.0; aRZ = 0.05; }
      else if (pose === 'grab') { aRX = 2.95 + 0.3 * Math.sin(t * 16); aRZ = 0.15; aLX = 1.3; aLZ = 0.4; }
      headZ = 0.22 + 0.05 * Math.sin(t * 1.3); // creepy head tilt
    }

    // ----- ease toward targets (frame-rate independent)
    const k = 1 - Math.exp(-dt * 14);
    this.aLX += (aLX - this.aLX) * k; this.aRX += (aRX - this.aRX) * k;
    this.aLZ += (aLZ - this.aLZ) * k; this.aRZ += (aRZ - this.aRZ) * k;
    this.lL += (lL - this.lL) * k; this.lR += (lR - this.lR) * k;
    this.lean += (lean - this.lean) * k; this.twist += (twist - this.twist) * k;
    this.headX += (headX - this.headX) * k; this.headZ += (headZ - this.headZ) * k;
    this.bob += (bob - this.bob) * k;

    this.shoulderL.rotation.set(this.aLX, 0, this.aLZ);
    this.shoulderR.rotation.set(this.aRX, 0, this.aRZ);
    this.hipL.rotation.x = this.lL;
    this.hipR.rotation.x = this.lR;
    this.spine.rotation.set(this.lean, this.twist, 0);
    this.neck.rotation.set(this.headX, 0, this.headZ);
    this.spine.scale.set(1 + 0.012 * breathe, 1 + 0.015 * breathe, 1 + 0.012 * breathe);

    if (pose === 'rise') {
      // Sunk below the ground, clawing upward with a side-to-side wobble that settles.
      const r = Math.min(1, Math.max(0, riseT));
      const e = r * r * (3 - 2 * r);
      const settle = 1 - r;
      this.body.position.y = -NOMINAL_H * 1.02 * (1 - e) + Math.sin(r * Math.PI) * 0.12;
      this.body.rotation.z = Math.sin(t * 9) * 0.2 * settle;
      this.body.rotation.x = Math.sin(t * 6.3) * 0.08 * settle;
    } else {
      this.body.position.y = this.bob;
      this.body.rotation.z *= 1 - k;
      this.body.rotation.x *= 1 - k;
    }

    if (this.kind === 'shock') this.crackle(dt);
  }

  private crackle(dt: number): void {
    const t = this.t;
    const f = 0.55 + 0.45 * Math.abs(Math.sin(t * 37) * Math.sin(t * 23.3));
    if (this.tipMat) this.tipMat.color.setRGB(0.55 + 0.45 * f, 0.8 + 0.2 * f, 1);
    if (this.halo) {
      this.halo.scale.setScalar(0.28 + 0.22 * f);
      (this.halo.material as THREE.SpriteMaterial).opacity = 0.45 + 0.4 * f;
    }
    this.sparkTimer -= dt;
    if (this.sparkTimer > 0 || !this.sparkPos || !this.sparks) return;
    this.sparkTimer = 0.045;
    const a = this.sparkPos.array as Float32Array;
    const hy = -(this.b.armLen + 0.07);
    // A few jagged bolts arcing off the tip: each bolt is a chain of short segments.
    let i = 0;
    const bolts = 3;
    const per = Math.floor(SPARK_SEGS / bolts);
    for (let bolt = 0; bolt < bolts; bolt++) {
      let px = 0, py = hy, pz = this.tipZ - 0.02;
      const dx = (Math.random() - 0.5) * 2, dy = (Math.random() - 0.5) * 2, dz = -Math.random();
      for (let sgi = 0; sgi < per; sgi++) {
        const nx = px + dx * 0.06 + (Math.random() - 0.5) * 0.08;
        const ny = py + dy * 0.06 + (Math.random() - 0.5) * 0.08;
        const nz = pz + dz * 0.06 + (Math.random() - 0.5) * 0.06;
        a[i++] = px; a[i++] = py; a[i++] = pz;
        a[i++] = nx; a[i++] = ny; a[i++] = nz;
        px = nx; py = ny; pz = nz;
      }
    }
    while (i < a.length) a[i++] = 0; // collapse unused segments onto the shoulder (invisible)
    this.sparkPos.needsUpdate = true;
    this.sparks.visible = Math.random() > 0.12;
  }

  setVisible(v: boolean): void {
    this.root.visible = v;
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const o of this.meshes) {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) o.geometry.dispose();
    }
    for (const m of this.ownMaterials) m.dispose();
  }
}
