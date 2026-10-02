import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Role } from '../art/materials';
import type { ObjectType, Shape } from '../config/objects';
import { boxProjectUV } from '../art/uv';
import { Builder, PROJECTED, box, cyl, lathe, poly, profile, rbox, strut, v3, type PropParts } from './propKit';

/**
 * HALLOWEEN TOWN prop kit: candy and bones, the graveyard, the pumpkin patch, the witch's
 * hollow, monster figures and the giant class 7–8 set pieces (no houses, cars or street props). Same contract as props.ts / cityProps.ts: real-world metres, pivot
 * on the ground at the footprint centre, forward = −Z, one geometry per material role.
 *
 * Colour discipline: every model carries ONE tinted role (its per-instance variant colour);
 * the other parts use untinted roles (bone, pumpkin, straw, velvet, wood, stone, darkTrim…).
 * Glows (carved faces, lit windows, ghost eyes) fold into the shared 'lamps' draw call.
 */
type Factory = (t: ObjectType, seed: number) => PropParts;
type Vec = THREE.Vector3;
/** Anything parts can be added to: a Builder, or a Builder shifted to a sub-assembly's origin. */
type Adder = Pick<Builder, 'add'>;
/** A sub-assembly origin inside a bigger model (a cauldron at a witch's feet). */
const shifted = (b: Builder, ox: number, oy: number, oz: number): Adder => ({
  add: (role, g, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => b.add(role, g, x + ox, y + oy, z + oz, rx, ry, rz),
});
const Q = Math.PI / 2;

// ── Geometry helpers ─────────────────────────────────────────────────────────
/** Ellipsoid. */
const ell = (rx: number, ry: number, rz: number, ws = 12, hs = 8) => new THREE.SphereGeometry(1, ws, hs).scale(rx, ry, rz);

/** Tapered cylinder from a (radius ra) to b (radius rb). */
function taper(a: Vec, b: Vec, ra: number, rb: number, seg = 8): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(b, a);
  const g = new THREE.CylinderGeometry(rb, ra, dir.length(), seg, 1);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

/** Limb: tapered cylinder with ball joints at both ends (organic figures). */
function limb(b: Builder, role: Role, a: Vec, c: Vec, ra: number, rc: number, seg = 8): void {
  b.add(role, taper(a, c, ra, rc, seg));
  const rings = Math.max(4, Math.round(seg * 0.6));
  b.add(role, new THREE.SphereGeometry(ra, seg, rings), a.x, a.y, a.z);
  b.add(role, new THREE.SphereGeometry(rc, seg, rings), c.x, c.y, c.z);
}

/** Cone from base point a to apex b (fur tufts, claws, straw, spikes). */
function spike(a: Vec, b: Vec, r: number, seg = 6): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(b, a);
  const g = new THREE.ConeGeometry(r, dir.length(), seg);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

/** A geometry authored along +Y from the origin, turned to run from a toward b. */
function along(g: THREE.BufferGeometry, a: Vec, b: Vec): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(b, a).normalize();
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
  return g.translate(a.x, a.y, a.z);
}

/** Shape (x right, y up) extruded through Z, centred on its depth. */
function slab(shape: THREE.Shape, depth: number, bevel = 0, curveSegments = 6): THREE.BufferGeometry {
  const core = Math.max(0.001, depth - 2 * bevel);
  const g = new THREE.ExtrudeGeometry(shape, { depth: core, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.9, bevelSegments: 2, curveSegments });
  return g.translate(0, 0, -core / 2);
}

/** Plan shape (x, z) extruded upward from y0 by h (coffins). */
function planSlab(pts: [number, number][], y0: number, h: number, bevel = 0): THREE.BufferGeometry {
  const s = poly(pts.map(([x, z]) => [x, -z]));
  const core = Math.max(0.001, h - 2 * bevel);
  const g = new THREE.ExtrudeGeometry(s, { depth: core, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.9, bevelSegments: 2 });
  g.rotateX(-Q); // shape y → −z, extrusion depth → +y
  return g.translate(0, y0 + bevel, 0);
}

/** Weld and smooth-shade (organic forms). */
function smooth(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  const m = mergeVertices(g, 1e-5);
  m.computeVertexNormals();
  return m;
}

/** Bend the part of a geometry above y0 sideways (+X) and down: drooping hat tips, curled stems. */
function bend(g: THREE.BufferGeometry, y0: number, y1: number, dx: number, dy: number): THREE.BufferGeometry {
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y <= y0) continue;
    const t = Math.min(1, (y - y0) / (y1 - y0));
    p.setXYZ(i, p.getX(i) + dx * t * t, y - dy * t * t, p.getZ(i));
  }
  g.computeVertexNormals();
  return g;
}

/**
 * Ribbed pumpkin, base on y = 0, exactly H tall and 2R wide. A lobe (not a groove) faces −Z so
 * a carved face sits on a full curve. Top and bottom are dimpled where the stem and blossom are.
 */
function pumpkinGeo(R: number, H: number, lobes = 8, groove = 0.12, seg = 24, rings = 12): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, seg, rings);
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  const m = mergeVertices(g, 1e-5);
  const p = m.getAttribute('position');
  const off = (Math.PI / 2 + (lobes / 2) * (Math.PI / 2)) / (lobes / 2);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const th = Math.atan2(z, x) + off;
    const lobe = Math.pow(Math.abs(Math.sin((lobes * th) / 2)), 0.55);
    const s = Math.hypot(x, z);
    const rr = 1 - groove * (1 - lobe) * Math.min(1, s * 1.6);
    const yy = y * (1 - (y > 0 ? 0.3 : 0.18) * Math.exp(-(s * s) / 0.07));
    p.setXYZ(i, x * rr * R, yy, z * rr * R);
    minY = Math.min(minY, yy);
    maxY = Math.max(maxY, yy);
  }
  for (let i = 0; i < p.count; i++) p.setY(i, ((p.getY(i) - minY) / (maxY - minY)) * H);
  m.computeVertexNormals();
  return m;
}

/**
 * Lay a flat extruded decal (x, y; extrusion 0…d along +Z) onto the front (−Z) of an ellipsoid
 * with radii (rx across, ry up, rz deep) centred at height yc: carved faces, printed pails,
 * carriage windows. The decal stands 0.55 d proud of the surface and sinks 0.45 d into it.
 */
function onShell(g: THREE.BufferGeometry, rx: number, ry: number, rz: number, yc: number, d: number): THREE.BufferGeometry {
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const u = x / rx;
    const w = (y - yc) / ry;
    const zs = -rz * Math.sqrt(Math.max(0.03, 1 - u * u - w * w));
    p.setXYZ(i, x, y, zs - p.getZ(i) + 0.45 * d);
  }
  g.computeVertexNormals();
  return g;
}

/** Carved jack-o'-lantern face in unit space (x across, y up; centre of the pumpkin at 0). */
const FACE: [number, number][][] = [
  [[-0.46, 0.06], [-0.12, 0.06], [-0.32, 0.36]], // eyes (slanted triangles)
  [[0.12, 0.06], [0.46, 0.06], [0.32, 0.36]],
  [[-0.08, -0.08], [0.08, -0.08], [0, 0.05]], // nose
  [
    [-0.56, -0.08], [-0.38, -0.2], [-0.3, -0.14], [-0.22, -0.23], [-0.06, -0.25], [0, -0.17], [0.06, -0.25],
    [0.22, -0.23], [0.3, -0.14], [0.38, -0.2], [0.56, -0.08], [0.42, -0.36], [0.16, -0.46], [0.08, -0.37],
    [0.0, -0.47], [-0.36, -0.42],
  ], // jagged grin
];

/** Carved face glow + dark cut rim, mapped onto a pumpkin of radius R, height H, base at y0. */
function carveFace(b: Adder, R: number, H: number, y0: number, glow: Role = 'pumpkinGlow', scale = 0.92): void {
  const yc = y0 + H * 0.5;
  const ry = H * 0.5;
  const d = Math.max(0.01, R * 0.05);
  for (const pts of FACE) {
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const at = (k: number) => poly(pts.map(([x, y]) => [(cx + (x - cx) * k) * R * scale, yc + (cy + (y - cy) * k) * ry * 1.0]));
    b.add(glow, onShell(new THREE.ExtrudeGeometry(at(1), { depth: d, bevelEnabled: false }), R, ry, R, yc, d));
    b.add('darkTrim', onShell(new THREE.ExtrudeGeometry(at(1.22), { depth: d * 0.7, bevelEnabled: false }), R, ry, R, yc, d * 0.9));
  }
}

/** Curled pumpkin stem. */
function stem(b: Builder, x: number, y: number, z: number, h: number, r: number, curl = 1): void {
  const g = bend(new THREE.CylinderGeometry(r * 0.75, r, h, 7, 4).translate(0, h / 2, 0), h * 0.3, h, r * 1.6 * curl, h * 0.15);
  b.add('wood', g, x, y, z);
}

/** Wooden carriage wheel with an iron tyre; axle along X. */
function spokedWheel(b: Builder, r: number, x: number, y: number, z: number, spokes = 12): void {
  b.add('darkTrim', new THREE.TorusGeometry(r - 0.02, 0.035, 4, 24).rotateY(Q), x, y, z);
  b.add('wood', new THREE.TorusGeometry(r - 0.075, 0.045, 4, 24).rotateY(Q), x, y, z);
  b.add('wood', cyl(0.1, 0.12, 0.24, 8).rotateZ(Q), x, y, z);
  b.add('darkTrim', cyl(0.06, 0.06, 0.3, 6).rotateZ(Q), x, y, z);
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2;
    b.add('wood', taper(v3(x, y + Math.cos(a) * 0.1, z + Math.sin(a) * 0.1), v3(x, y + Math.cos(a) * (r - 0.1), z + Math.sin(a) * (r - 0.1)), 0.028, 0.02, 4));
  }
}

// ── Class 0–2: candy and small finds ─────────────────────────────────────────
function candy(t: ObjectType): PropParts {
  const [W, H, D] = t.size; // twist-wrapped sweet
  const b = new Builder();
  const r = H / 2;
  b.add('glossyPlastic', ell(W * 0.26, r, D * 0.46, 8, 5), 0, r, 0);
  for (const s of [-1, 1]) b.add('glossyPlastic', new THREE.ConeGeometry(r * 0.92, W * 0.26, 6), s * W * 0.35, r, 0, 0, 0, s * Q);
  return b.build();
}

function candyCorn(t: ObjectType): PropParts {
  const [W, H, D] = t.size; // yellow base, orange band, white tip; faces ±X
  const b = new Builder();
  const hw = (y: number) => (D / 2) * Math.pow(Math.max(0, 1 - y / H), 0.8) + 0.002;
  const band = (role: Role, y0: number, y1: number) => b.add(role, profile(poly([[-hw(y0), y0], [hw(y0), y0], [hw(y1), y1], [-hw(y1), y1]]), W, 0, 1));
  band('plastic', 0.003, H * 0.4);
  band('pumpkin', H * 0.4, H * 0.72);
  band('bone', H * 0.72, H - 0.003);
  return b.build();
}

function lollipop(t: ObjectType): PropParts {
  const [W, , D] = t.size; // swirl lollipop lying on its side
  const b = new Builder();
  const R = W / 2;
  const zc = -D / 2 + R;
  b.add('glossyPlastic', cyl(R, R, 0.02, 16), 0, 0.011, zc);
  for (const k of [0.62, 0.3]) b.add('bone', new THREE.TorusGeometry(R * k, 0.0045, 3, 12).rotateX(Q), 0, 0.0215, zc);
  const len = D - 2 * R + 0.01;
  b.add('bone', cyl(0.004, 0.004, len, 6).rotateX(Q), 0, 0.005, zc + R + len / 2 - 0.01);
  return b.build();
}

function candle(t: ObjectType): PropParts {
  const [W] = t.size; // pillar candle with drips, lit
  const b = new Builder();
  const r = (W / 2) * 0.74;
  const h = 0.12;
  b.add('plastic', lathe([[r * 1.35, 0], [r * 1.05, 0.012], [r, 0.02], [r, h - 0.006], [r * 0.9, h], [0.001, h - 0.005]], 10));
  for (let i = 0; i < 2; i++) {
    const a = i * 2.6 + 0.3;
    b.add('plastic', ell(0.006, 0.02 + i * 0.012, 0.006, 5, 4), Math.cos(a) * r, h - 0.018 - i * 0.01, Math.sin(a) * r);
  }
  b.add('darkTrim', cyl(0.0015, 0.0015, 0.012, 4), 0, h + 0.002, 0);
  b.add('pumpkinGlow', lathe([[0.001, 0], [0.008, 0.008], [0.006, 0.022], [0.001, 0.038]], 8), 0, h + 0.006, 0);
  return b.build();
}

function boneProp(t: ObjectType): PropParts {
  const [, , D] = t.size; // femur lying along Z
  const b = new Builder();
  const y = 0.019;
  b.add('bone', cyl(0.011, 0.012, D - 0.06, 8).rotateX(Q), 0, y, 0);
  for (const s of [-1, 1]) for (const k of [-1, 1]) b.add('bone', ell(0.017, 0.018, 0.02, 6, 4), k * 0.0145, y, s * (D / 2 - 0.022));
  return b.build();
}

/** Skull at real size; `b` may be a bigger model (skeleton, scarecrow pile). */
function skullParts(b: Adder, x: number, y: number, z: number, k = 1, rx = 0, ry = 0, eyes?: Role): void {
  const put = (role: Role, g: THREE.BufferGeometry, px: number, py: number, pz: number) => {
    g.scale(k, k, k).translate(px * k, py * k, pz * k).rotateX(rx).rotateY(ry);
    b.add(role, g, x, y, z);
  };
  // Giant skulls (k > 12) need real curvature: more segments, same shape.
  const hi = k > 12;
  if (eyes) for (const s of [-1, 1]) put(eyes, ell(0.011, 0.012, 0.006, hi ? 12 : 6, hi ? 8 : 4), s * 0.028, 0.08, -0.088);
  put('bone', ell(0.07, 0.075, 0.088, hi ? 28 : 10, hi ? 18 : 8), 0, 0.09, 0.018);
  put('bone', ell(0.058, 0.05, 0.05, hi ? 22 : 8, hi ? 14 : 6), 0, 0.06, -0.04);
  put('bone', box(0.075, 0.03, 0.06), 0, 0.017, -0.045);
  put('bone', box(0.05, 0.012, 0.008), 0, 0.036, -0.08);
  for (const s of [-1, 1]) put('darkTrim', ell(0.02, 0.022, 0.012, hi ? 14 : 6, hi ? 10 : 4), s * 0.028, 0.08, -0.079);
  put('darkTrim', new THREE.ConeGeometry(0.01, 0.022, 3).rotateX(Math.PI), 0, 0.056, -0.087);
}

function skull(t: ObjectType): PropParts {
  void t;
  const b = new Builder();
  skullParts(b, 0, 0, 0);
  return b.build();
}

function miniPumpkin(t: ObjectType): PropParts {
  const [W, H] = t.size;
  const b = new Builder();
  const ph = H * 0.84;
  b.add('plastic', pumpkinGeo(W / 2, ph, 8, 0.13, 16, 8));
  stem(b, 0, ph - 0.03, 0, H - ph + 0.03, 0.02);
  return b.build();
}

function candyBucket(t: ObjectType): PropParts {
  const [W, H] = t.size; // jack-o'-lantern trick-or-treat pail, heaped with sweets
  const b = new Builder();
  const r = W / 2;
  b.add('plastic', lathe([[0.001, 0], [r * 0.74, 0], [r * 0.9, 0.015], [r * 0.99, 0.09], [r, 0.17], [r * 0.97, 0.25], [r * 0.93, 0.28], [r * 0.87, 0.285], [r * 0.85, 0.27], [r * 0.88, 0.17], [r * 0.8, 0.05], [0.001, 0.05]], 16));
  for (const pts of FACE) b.add('darkTrim', onShell(new THREE.ExtrudeGeometry(poly(pts.map(([x, y]) => [x * r * 0.85, 0.16 + y * 0.13])), { depth: 0.01, bevelEnabled: false }), r * 1.02, 10, r * 1.02, 0.16, 0.01));
  const handle = new THREE.TorusGeometry(r * 0.98, 0.006, 4, 18, Math.PI).rotateX(-0.5);
  b.add('darkTrim', handle, 0, 0.27, 0);
  const sweets: [Role, number, number, number][] = [[ 'pumpkin', -0.05, 0.285, -0.02], ['bone', 0.04, 0.29, 0.03], ['velvet', 0.0, 0.3, -0.05], ['pumpkin', 0.06, 0.28, -0.05], ['bone', -0.05, 0.28, 0.05], ['velvet', -0.02, 0.305, 0.02]];
  for (const [role, x, y, z] of sweets) b.add(role, ell(0.035, 0.022, 0.02, 6, 4), x, y, z, 0, x * 20, 0);
  void H;
  return b.build();
}

function witchHatParts(b: Adder, fabric: Role, x: number, y: number, z: number, k = 1, tilt = 0): void {
  const put = (role: Role, g: THREE.BufferGeometry) => b.add(role, g.scale(k, k, k), x, y, z, 0, 0, tilt);
  put(fabric, lathe([[0.001, 0.025], [0.16, 0.018], [0.24, 0.028], [0.25, 0.038], [0.235, 0.036], [0.16, 0.03], [0.001, 0.035]], 24));
  put(fabric, bend(lathe([[0.14, 0.02], [0.135, 0.12], [0.1, 0.27], [0.06, 0.42], [0.001, 0.6]], 14), 0.28, 0.6, 0.13, 0.06));
  put('pumpkin', lathe([[0.143, 0.032], [0.139, 0.085]], 16));
  for (const [w, h, py] of [[0.055, 0.008, 0.08], [0.055, 0.008, 0.037]] as const) put('steel', box(w, h, 0.012).translate(0, py, -0.142));
  for (const s of [-1, 1]) put('steel', box(0.008, 0.05, 0.012).translate(s * 0.024, 0.058, -0.142));
}

function witchHat(t: ObjectType): PropParts {
  void t;
  const b = new Builder();
  witchHatParts(b, 'fabric', 0, 0, 0);
  return b.build();
}

// ── Graveyard ────────────────────────────────────────────────────────────────
/** Headstones: rounded tablet, Celtic cross or obelisk, chosen by proportion. Slight lean. */
function tombstone(t: ObjectType): PropParts {
  const [W, H, D] = t.size;
  const b = new Builder();
  const s = 'concreteProp' as const;
  if (H > 2) {
    // Obelisk on a stepped plinth with an inscribed die.
    b.add(s, rbox(W, 0.24, W, 0.03), 0, 0.12, 0);
    b.add(s, rbox(W * 0.78, 0.26, W * 0.78, 0.03), 0, 0.37, 0);
    b.add(s, rbox(W * 0.56, 0.62, W * 0.56, 0.02), 0, 0.81, 0);
    b.add(s, rbox(W * 0.66, 0.08, W * 0.66, 0.02), 0, 1.15, 0);
    const shaftH = H - 1.19 - 0.22;
    b.add(s, new THREE.CylinderGeometry(W * 0.17, W * 0.26, shaftH, 4, 1).rotateY(Math.PI / 4), 0, 1.19 + shaftH / 2, 0);
    b.add(s, new THREE.ConeGeometry(W * 0.17 * 1.0, 0.22, 4).rotateY(Math.PI / 4), 0, H - 0.11, 0);
    b.add('darkTrim', box(W * 0.36, 0.3, 0.01), 0, 0.84, -W * 0.28 - 0.004);
    for (let i = 0; i < 3; i++) b.add('bone', box(W * 0.26, 0.018, 0.012), 0, 0.92 - i * 0.06, -W * 0.28 - 0.008);
    b.add('copper', ell(0.18, 0.06, 0.12, 8, 5), W * 0.32, 0.26, -W * 0.3);
    return b.build();
  }
  const lean = -0.05;
  const add = (role: Role, g: THREE.BufferGeometry, x: number, y: number, z: number) => b.add(role, g.translate(x, y, z), 0, 0, 0, lean, 0, 0.02);
  if (W / H < 0.6) {
    // Celtic cross: stepped base, shaft, arms, ring.
    add(s, rbox(0.5, 0.22, 0.36, 0.03), 0, 0.11, 0);
    const shaft = H - 0.22;
    add(s, rbox(0.15, shaft, D * 0.65, 0.02), 0, 0.22 + shaft / 2, 0);
    add(s, rbox(W, 0.14, D * 0.65, 0.02), 0, H - 0.36, 0);
    add(s, new THREE.TorusGeometry(0.19, 0.028, 6, 24), 0, H - 0.36, 0);
    for (let i = 0; i < 3; i++) add('darkTrim', box(0.07, 0.018, 0.01), 0, 0.75 - i * 0.07, -D * 0.33 - 0.004);
    add('copper', ell(0.16, 0.05, 0.12, 8, 5), 0.16, 0.21, -0.12);
    return b.build();
  }
  // Rounded tablet with a recessed inscription.
  add(s, rbox(W + 0.12, 0.14, D + 0.18, 0.025), 0, 0.07, 0);
  const tab = new THREE.Shape();
  const sh = H - 0.14 - W / 2;
  tab.moveTo(-W / 2, 0);
  tab.lineTo(W / 2, 0);
  tab.lineTo(W / 2, sh);
  tab.absarc(0, sh, W / 2, 0, Math.PI, false);
  tab.closePath();
  add(s, slab(tab, D, 0.025, 10), 0, 0.14, 0);
  const fz = -D / 2 - 0.003;
  add('darkTrim', box(0.04, 0.2, 0.01), 0, H - 0.4, fz);
  add('darkTrim', box(0.14, 0.04, 0.01), 0, H - 0.35, fz);
  for (let i = 0; i < 3; i++) add('darkTrim', box(W * (0.58 - i * 0.1), 0.022, 0.01), 0, H - 0.6 - i * 0.075, fz);
  add('copper', ell(0.2, 0.05, 0.1, 8, 5), -W * 0.3, 0.15, -D * 0.4);
  return b.build();
}

function ironFence(t: ObjectType): PropParts {
  const [W, H, D] = t.size; // wrought-iron railing on a stone kerb, post at one end (segments tile)
  const b = new Builder();
  b.add('concreteProp', rbox(W, 0.24, D + 0.06, 0.02), 0, 0.12, 0);
  const px = -W / 2 + 0.06;
  b.add('darkTrim', box(0.09, H - 0.32, 0.09), px, 0.24 + (H - 0.32) / 2, 0);
  b.add('darkTrim', new THREE.SphereGeometry(0.055, 8, 6), px, H - 0.05, 0);
  b.add('darkTrim', box(0.13, 0.04, 0.13), px, H - 0.1, 0);
  for (const y of [0.36, 1.24, 1.42]) b.add('darkTrim', box(W, 0.035, 0.03), 0, y, 0);
  const n = 14;
  for (let i = 0; i < n; i++) {
    const x = -W / 2 + 0.2 + (i * (W - 0.32)) / (n - 1);
    const top = 1.46 + (i % 2) * 0.06;
    b.add('darkTrim', cyl(0.012, 0.012, top - 0.24, 5), x, 0.24 + (top - 0.24) / 2, 0);
    b.add('darkTrim', new THREE.ConeGeometry(0.026, 0.11, 4), x, top + 0.05, 0);
    if (i % 2 === 0 && i < n - 1) b.add('darkTrim', new THREE.TorusGeometry(0.05, 0.007, 3, 10), x + (W - 0.32) / (n - 1) / 2, 1.33, 0);
  }
  return b.build();
}

function jackOLantern(t: ObjectType): PropParts {
  const [W, H] = t.size;
  const b = new Builder();
  const R = W / 2;
  const ph = H * 0.82;
  b.add('plastic', pumpkinGeo(R, ph, 9, 0.12, 24, 12));
  carveFace(b, R, ph, 0);
  stem(b, 0.01, ph - 0.04, 0, H - ph + 0.04, 0.035);
  return b.build();
}

function cauldronParts(b: Adder, k: number, fire: boolean): void {
  const s = (pts: [number, number][]) => pts.map(([r, y]) => [r * k, y * k] as [number, number]);
  b.add('darkTrim', lathe(s([[0.001, 0.14], [0.2, 0.13], [0.35, 0.21], [0.43, 0.4], [0.42, 0.58], [0.37, 0.71], [0.34, 0.76], [0.35, 0.8], [0.31, 0.79], [0.3, 0.72]]), 28));
  b.add('darkTrim', new THREE.TorusGeometry(0.35 * k, 0.03 * k, 6, 28).rotateX(Q), 0, 0.8 * k, 0);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    b.add('darkTrim', taper(v3(Math.cos(a) * 0.27 * k, 0.22 * k, Math.sin(a) * 0.27 * k), v3(Math.cos(a) * 0.36 * k, 0.02 * k, Math.sin(a) * 0.36 * k), 0.04 * k, 0.05 * k, 6));
    b.add('darkTrim', ell(0.06 * k, 0.03 * k, 0.06 * k, 8, 4), Math.cos(a) * 0.37 * k, 0.025 * k, Math.sin(a) * 0.37 * k);
  }
  for (const sx of [-1, 1]) b.add('darkTrim', new THREE.TorusGeometry(0.07 * k, 0.014 * k, 4, 12).rotateY(Q), sx * 0.42 * k, 0.66 * k, 0);
  // Bubbling goo: surface, bubbles, drips over the rim.
  b.add('slime', cyl(0.315 * k, 0.315 * k, 0.04 * k, 24), 0, 0.745 * k, 0);
  for (const [x, z, r] of [[0.1, -0.05, 0.06], [-0.12, 0.08, 0.045], [0.02, 0.15, 0.035], [-0.05, -0.14, 0.05], [0.16, 0.1, 0.03]] as const) b.add('slime', new THREE.SphereGeometry(r * k, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), x * k, 0.765 * k, z * k);
  for (const a of [0.3, 2.2, 4.1]) b.add('slime', ell(0.05 * k, 0.13 * k, 0.04 * k, 8, 6), Math.cos(a) * 0.38 * k, 0.72 * k, Math.sin(a) * 0.38 * k, 0, -a, 0);
  if (!fire) return;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI + 0.2;
    b.add('wood', cyl(0.035 * k, 0.04 * k, 0.55 * k, 6).rotateZ(Q), 0, 0.04 * k, 0, 0, a, 0);
  }
  for (const [x, z, h] of [[0, 0, 0.2], [0.08, 0.05, 0.14], [-0.07, -0.04, 0.16], [0.03, -0.09, 0.12]] as const) b.add('pumpkinGlow', new THREE.ConeGeometry(0.05 * k, h * k, 6), x * k, (0.06 + h / 2) * k, z * k);
}

function cauldron(t: ObjectType): PropParts {
  const b = new Builder();
  cauldronParts(b, t.size[1] / 0.95, true);
  return b.build();
}

/** Standing skeleton (1.75 m) on a display stand; one hand beckons. Facing −Z. */
function skeletonParts(b: Builder, ox: number, oy: number, oz: number, sitting = false): void {
  const P = (x: number, y: number, z: number) => v3(ox + x, oy + y, oz + z);
  const bone: Role = 'bone';
  const r = 0.021;
  // Skull and spine.
  skullParts(b, ox, oy + 1.55, oz + 0.005, 1.05);
  for (let i = 0; i < 10; i++) b.add(bone, cyl(0.022, 0.024, 0.03, 5), ox, oy + 0.99 + i * 0.056, oz + 0.04 + Math.sin(i / 3) * 0.012);
  // Rib cage: six pairs of arcs, sternum.
  for (let i = 0; i < 6; i++) {
    const y = oy + 1.43 - i * 0.052;
    const rr = 0.1 + Math.sin(((i + 1) / 7) * Math.PI) * 0.035;
    const rib = new THREE.TorusGeometry(rr, 0.01, 3, 9, Math.PI * 0.86).rotateX(Q).rotateY(Math.PI / 2 + Math.PI * 0.07).scale(1, 1, 0.75);
    b.add(bone, rib, ox, y, oz + 0.02, 0.18, 0, 0);
  }
  b.add(bone, box(0.03, 0.22, 0.016), ox, oy + 1.33, oz - 0.065, 0.1, 0, 0);
  // Pelvis.
  b.add(bone, new THREE.TorusGeometry(0.085, 0.026, 4, 10).scale(1.2, 0.75, 1).rotateX(1.1), ox, oy + 0.97, oz + 0.02);
  // Shoulders, arms.
  for (const s of [-1, 1]) {
    b.add(bone, strut(P(s * 0.03, 1.47, -0.05), P(s * 0.17, 1.48, 0.0), 0.011, 5)); // clavicle
    const sh = P(s * 0.18, 1.46, 0.01);
    const raised = s > 0;
    const el = raised ? P(0.27, 1.2, -0.12) : P(-0.22, 1.18, 0.03);
    const wr = raised ? P(0.3, 1.42, -0.3) : P(-0.24, 0.93, -0.02);
    limb(b, bone, sh, el, r, r * 0.85, 5);
    limb(b, bone, el, wr, r * 0.8, r * 0.7, 5);
    const hand = raised ? P(0.31, 1.52, -0.34) : P(-0.245, 0.84, -0.03);
    b.add(bone, box(0.05, 0.07, 0.02), hand.x, hand.y, hand.z, raised ? -0.4 : 0, 0, 0);
    for (let f = 0; f < 4; f++) {
      const fx = hand.x + (f - 1.5) * 0.012;
      b.add(bone, strut(v3(fx, hand.y + (raised ? 0.035 : -0.035), hand.z), v3(fx, hand.y + (raised ? 0.075 : -0.08), hand.z + (raised ? 0.02 : -0.01)), 0.005, 3));
    }
    // Legs.
    const hip = P(s * 0.09, 0.93, 0.02);
    const knee = sitting ? P(s * 0.12, 0.98, -0.42) : P(s * 0.1, 0.5, -0.01);
    const ankle = sitting ? P(s * 0.13, 0.52, -0.5) : P(s * 0.1, 0.09, 0.02);
    limb(b, bone, hip, knee, r * 1.25, r * 1.05, 5);
    limb(b, bone, knee, ankle, r, r * 0.8, 5);
    b.add(bone, box(0.07, 0.035, 0.2), ankle.x, ankle.y - 0.06, ankle.z - 0.06);
  }
}

function skeleton(t: ObjectType): PropParts {
  void t;
  const b = new Builder();
  b.add('darkTrim', cyl(0.24, 0.26, 0.03, 18), 0, 0.015, 0.02); // display stand
  b.add('steel', strut(v3(0, 0.03, 0.14), v3(0, 0.95, 0.07), 0.01, 6));
  skeletonParts(b, 0, 0.0, 0);
  return b.build();
}

function broomRack(t: ObjectType): PropParts {
  const [W] = t.size; // timber rack with three brooms leaning on it and a hat on a post
  const b = new Builder();
  const fx = W / 2 - 0.08;
  for (const s of [-1, 1]) {
    b.add('timber', box(0.08, 1.5, 0.08), s * fx, 0.75, 0.15);
    b.add('timber', box(0.08, 0.07, 0.5), s * fx, 0.035, 0.05);
    b.add('timber', strut(v3(s * fx, 0.07, -0.15), v3(s * fx, 0.6, 0.15), 0.025, 4));
  }
  b.add('timber', box(W - 0.06, 0.07, 0.07), 0, 1.25, 0.15);
  b.add('timber', box(W - 0.06, 0.05, 0.05), 0, 0.4, 0.15);
  for (const [x, lean] of [[-0.32, 0.06], [0.02, -0.04], [0.33, 0.03]] as const) {
    const foot = v3(x, 0, -0.18);
    const top = v3(x + lean * 3, 1.62, 0.2);
    const dir = new THREE.Vector3().subVectors(top, foot).normalize();
    const crook = foot.clone().addScaledVector(dir, 0.95).add(v3(lean, 0, 0));
    b.add('wood', taper(foot.clone().addScaledVector(dir, 0.3), crook, 0.022, 0.02, 6));
    b.add('wood', taper(crook, top, 0.02, 0.016, 6));
    b.add('straw', along(lathe([[0.12, 0], [0.11, 0.08], [0.07, 0.3], [0.035, 0.42], [0.001, 0.44]], 12), foot, top));
    b.add('darkTrim', along(cyl(0.042, 0.042, 0.04, 10).translate(0, 0.36, 0), foot, top));
  }
  witchHatParts(b, 'darkTrim', -fx, 1.48, 0.15, 0.62, 0.15);
  return b.build();
}

function batSign(t: ObjectType): PropParts {
  const [W, H] = t.size; // signpost: an arrow plank and a black bat board with glowing eyes
  const b = new Builder();
  b.add('wood', box(0.1, H - 0.35, 0.1), 0, (H - 0.35) / 2, 0.02);
  b.add('wood', new THREE.ConeGeometry(0.075, 0.12, 4).rotateY(Math.PI / 4), 0, H - 0.29, 0.02);
  const half: [number, number][] = [[0, 0.1], [0.045, 0.2], [0.07, 0.1], [0.13, 0.11], [0.3, 0.22], [0.52, 0.3], [0.55, 0.14], [0.44, 0.04], [0.4, 0.1], [0.3, -0.03], [0.24, 0.04], [0.12, -0.06], [0.06, -0.02], [0, -0.18]];
  const pts: [number, number][] = [...half, ...half.slice(1, -1).reverse().map(([x, y]) => [-x, y] as [number, number])];
  const sc = W / 1.1;
  b.add('darkTrim', slab(poly(pts.map(([x, y]) => [x * sc, y * sc])), 0.05, 0.012, 2), 0, H - 0.6, -0.06);
  for (const s of [-1, 1]) b.add('pumpkinGlow', ell(0.022, 0.016, 0.01, 6, 4), s * 0.035 * sc, H - 0.6 + 0.07 * sc, -0.092);
  const arrow = poly([[-0.42, -0.1], [0.3, -0.1], [0.3, -0.16], [0.46, 0], [0.3, 0.16], [0.3, 0.1], [-0.42, 0.1]]);
  b.add('timber', slab(arrow, 0.04, 0.008, 1), 0.12, H - 1.15, -0.06, 0, 0, 0.06);
  for (let i = 0; i < 4; i++) b.add('bone', box(0.09, 0.03, 0.01), -0.18 + i * 0.13, H - 1.15 + (i % 2) * 0.012, -0.085, 0, 0, 0.06);
  return b.build();
}

function coffinPlan(hw: number, hl: number, k = 1): [number, number][] {
  return [[-hw * 0.63 * k, -hl * k], [hw * 0.63 * k, -hl * k], [hw * k, -hl * 0.45 * k], [hw * 0.8 * k, hl * k], [-hw * 0.8 * k, hl * k], [-hw * k, -hl * 0.45 * k]];
}

function coffin(t: ObjectType): PropParts {
  const [W, , D] = t.size; // toe-pincher coffin, head at −Z, lid pushed ajar, a hand reaching out
  const b = new Builder();
  const hw = W / 2;
  const hl = D / 2;
  b.add('timber', planSlab(coffinPlan(hw - 0.01, hl - 0.01), 0, 0.42, 0.02));
  b.add('velvet', planSlab(coffinPlan(hw - 0.06, hl - 0.06), 0.36, 0.05));
  const lid = planSlab(coffinPlan(hw + 0.01, hl + 0.01), 0, 0.1, 0.02).translate(0, -0.05, 0);
  b.add('timber', lid, 0.13, 0.5, 0.12, 0.02, 0.1, -0.1);
  b.add('steel', box(0.05, 0.015, 0.52), 0.15, 0.566, -0.1, 0.02, 0.1, -0.1);
  b.add('steel', box(0.24, 0.015, 0.05), 0.135, 0.566, -0.3, 0.02, 0.1, -0.1);
  for (const s of [-1, 1]) for (const z of [-0.45, 0.15, 0.7]) b.add('steel', box(0.03, 0.03, 0.2), s * (hw * (z < 0 ? 0.98 : 0.86) + 0.012), 0.22, z);
  // Bony hand out of the gap on the −X side.
  const wrist = v3(-hw + 0.08, 0.44, -0.25);
  b.add('bone', taper(v3(-hw + 0.25, 0.42, -0.2), wrist, 0.018, 0.015, 5));
  b.add('bone', rbox(0.06, 0.02, 0.07, 0.008), wrist.x - 0.04, wrist.y + 0.015, wrist.z - 0.02, 0, 0.3, 0.4);
  for (let f = 0; f < 4; f++) b.add('bone', strut(v3(wrist.x - 0.06, wrist.y + 0.03, wrist.z - 0.05 + f * 0.016), v3(wrist.x - 0.12, wrist.y - 0.03, wrist.z - 0.06 + f * 0.018), 0.005, 4));
  return b.build();
}

function slimeGhost(t: ObjectType): PropParts {
  const [W] = t.size; // floating goo ghost, dripping to a puddle that holds it up
  const b = new Builder();
  // Body: head and shoulders swell out of a twisting goo tail that pools on the ground.
  const body = lathe([[0.001, 2.08], [0.16, 2.05], [0.3, 1.97], [0.39, 1.82], [0.43, 1.6], [0.45, 1.32], [0.47, 1.08], [0.43, 0.84], [0.33, 0.6], [0.23, 0.38], [0.19, 0.2], [0.24, 0.08], [0.34, 0.03], [0.001, 0.02]], 32);
  const p = body.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const th = Math.atan2(z, x);
    const k = THREE.MathUtils.smoothstep(1.2 - y, 0, 0.5) * THREE.MathUtils.smoothstep(y, 0.05, 0.3); // ripples on the tail only
    const rr = 1 + k * 0.14 * Math.cos(4 * th + y * 5);
    const sway = 0.12 * Math.pow(Math.max(0, 1.1 - y), 1.5); // tail swings back
    p.setXYZ(i, x * rr, y, z * rr + sway);
  }
  b.add('slime', smooth(body));
  for (const s of [-1, 1]) {
    const sh = v3(s * 0.36, 1.38, -0.04);
    const hand = v3(s * (W / 2 - 0.12), 1.62, -0.16);
    b.add('slime', smooth(taper(sh, hand, 0.13, 0.08, 10)));
    b.add('slime', ell(0.11, 0.1, 0.1, 10, 8), hand.x, hand.y + 0.02, hand.z);
    for (let f = 0; f < 3; f++) b.add('slime', spike(v3(hand.x + s * 0.03, hand.y + 0.06, hand.z - 0.02 + (f - 1) * 0.05), v3(hand.x + s * 0.14, hand.y + 0.16 + f * 0.02, hand.z - 0.04 + (f - 1) * 0.07), 0.035, 6));
  }
  // Puddle, splashes and drips running off the body into it.
  b.add('slime', ell(0.62, 0.045, 0.52, 16, 5), 0, 0.02, 0.08);
  for (const [x, z, r] of [[0.52, 0.32, 0.13], [-0.5, -0.12, 0.1], [0.18, -0.45, 0.09]] as const) b.add('slime', ell(r, 0.035, r, 8, 4), x, 0.025, z);
  for (const [a, y0, len] of [[0.6, 1.0, 0.75], [2.4, 0.9, 0.6], [4.4, 1.05, 0.85]] as const) {
    const top = v3(Math.cos(a) * 0.45, y0, Math.sin(a) * 0.45);
    b.add('slime', taper(top, v3(Math.cos(a) * 0.43, y0 - len, Math.sin(a) * 0.43), 0.045, 0.02, 6));
    b.add('slime', new THREE.SphereGeometry(0.035, 6, 4), Math.cos(a) * 0.43, y0 - len, Math.sin(a) * 0.43);
  }
  // Face: dark sockets with glowing pupils, an open wailing mouth.
  for (const s of [-1, 1]) {
    b.add('darkTrim', ell(0.09, 0.13, 0.05, 8, 6), s * 0.14, 1.66, -0.39, 0, 0, s * 0.15);
    b.add('ghostGlow', new THREE.SphereGeometry(0.03, 6, 4), s * 0.125, 1.63, -0.435);
  }
  b.add('darkTrim', ell(0.12, 0.1, 0.05, 10, 6), 0, 1.38, -0.44);
  return b.build();
}

function scarecrow(t: ObjectType): PropParts {
  const [, H] = t.size; // post-and-crossbar scarecrow: jacket, straw, carved pumpkin head, straw hat, a crow
  const b = new Builder();
  b.add('wood', box(0.1, 1.95, 0.1), 0, 0.975, 0.06);
  b.add('wood', box(1.62, 0.08, 0.08), 0, 1.6, 0.08);
  // Jacket body and sleeves (sagging along the bar).
  b.add('fabric', new THREE.CylinderGeometry(0.22, 0.27, 0.72, 10).scale(1, 1, 0.62), 0, 1.36, 0.02);
  b.add('fabric', new THREE.CylinderGeometry(0.12, 0.22, 0.12, 10).scale(1, 1, 0.7), 0, 1.76, 0.03);
  for (const s of [-1, 1]) {
    const sh = v3(s * 0.2, 1.62, 0.04);
    const mid = v3(s * 0.48, 1.56, 0.04);
    const cuff = v3(s * 0.74, 1.6, 0.04);
    b.add('fabric', taper(sh, mid, 0.1, 0.085, 8));
    b.add('fabric', taper(mid, cuff, 0.085, 0.08, 8));
    b.add('fabric', new THREE.SphereGeometry(0.085, 8, 6), mid.x, mid.y, mid.z);
    for (let i = 0; i < 5; i++) b.add('straw', spike(v3(cuff.x, cuff.y + (i - 2) * 0.03, cuff.z + ((i * 7) % 5 - 2) * 0.02), v3(cuff.x + s * (0.12 + (i % 3) * 0.04), cuff.y - 0.03 + (i - 2) * 0.05, cuff.z + (i - 2) * 0.03), 0.022, 4));
    b.add('velvet', box(0.12, 0.13, 0.02), s * 0.1, 1.28 + s * 0.08, -0.15, 0, 0, s * 0.2); // patches
  }
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    b.add('straw', spike(v3(Math.cos(a) * 0.2, 1.02, Math.sin(a) * 0.12 + 0.02), v3(Math.cos(a) * 0.26, 0.74 + (i % 3) * 0.06, Math.sin(a) * 0.17 + 0.02), 0.04, 4));
  }
  for (let i = 0; i < 6; i++) b.add('straw', spike(v3((i - 2.5) * 0.04, 1.8, -0.02), v3((i - 2.5) * 0.07, 1.9, -0.06 - (i % 2) * 0.04), 0.02, 4));
  // Pumpkin head with a carved face.
  const hy = 1.82;
  b.add('pumpkin', pumpkinGeo(0.19, 0.32, 8, 0.12, 16, 10), 0, hy, 0);
  carveFace(b, 0.19, 0.32, hy, 'pumpkinGlow', 0.9);
  // Straw hat.
  b.add('straw', lathe([[0.001, 0.0], [0.3, -0.02], [0.33, 0.0], [0.3, 0.02], [0.001, 0.02]], 18), 0, 2.08, 0.02, -0.15, 0, 0.08);
  b.add('straw', cyl(0.13, 0.15, 0.22, 14), 0, 2.2, 0.04, -0.15, 0, 0.08);
  b.add('velvet', cyl(0.152, 0.152, 0.05, 14, true), 0, 2.12, 0.035, -0.15, 0, 0.08);
  // A crow on the bar.
  b.add('darkTrim', ell(0.06, 0.06, 0.12, 8, 6), 0.66, 1.71, 0.08, -0.3, 0.3, 0);
  b.add('darkTrim', new THREE.SphereGeometry(0.045, 8, 6), 0.69, 1.79, 0.0);
  b.add('pumpkin', new THREE.ConeGeometry(0.014, 0.06, 4).rotateX(-Q), 0.7, 1.79, -0.06);
  b.add('darkTrim', spike(v3(0.64, 1.72, 0.14), v3(0.62, 1.68, 0.26), 0.035, 4));
  void H;
  return b.build();
}

// ── Class 5: monster figures and biers ────────────────────────────────────────
function vampireCoffin(t: ObjectType): PropParts {
  const [W, , D] = t.size; // black-lacquer coffin on a stone bier, lid swung open, candelabras
  const b = new Builder();
  b.add('stone', rbox(0.95, 0.48, 2.1, 0.04), 0, 0.26, 0);
  b.add('stone', rbox(1.1, 0.12, 2.3, 0.03), 0, 0.56, 0);
  b.add('stone', rbox(1.05, 0.08, 2.2, 0.02), 0, 0.04, 0);
  for (const s of [-1, 1]) b.add('darkTrim', box(0.01, 0.24, 1.3), s * 0.478, 0.27, 0);
  const hw = 0.42;
  const hl = 1.08;
  b.add('darkTrim', planSlab(coffinPlan(hw, hl), 0.62, 0.48, 0.025));
  b.add('fabric', planSlab(coffinPlan(hw - 0.05, hl - 0.05), 1.03, 0.08));
  b.add('fabric', ell(0.2, 0.06, 0.14, 10, 6), 0, 1.11, -hl + 0.3); // pillow
  b.add('copper', planSlab(coffinPlan(hw + 0.012, hl + 0.012), 0.86, 0.05));
  // Lid hinged on the +X edge, swung up and back.
  const lid = planSlab(coffinPlan(hw + 0.02, hl + 0.02), -0.05, 0.1, 0.02).translate(-hw, 0, 0);
  b.add('darkTrim', lid, hw + 0.04, 1.1, 0, 0, 0, -1.05);
  const lining = planSlab(coffinPlan(hw - 0.04, hl - 0.04), -0.07, 0.02).translate(-hw, 0, 0);
  b.add('fabric', lining, hw + 0.04, 1.1, 0, 0, 0, -1.05);
  b.add('copper', box(0.06, 0.02, 0.7).translate(-hw, 0.06, -0.15), hw + 0.04, 1.1, 0, 0, 0, -1.05);
  b.add('copper', box(0.34, 0.02, 0.06).translate(-hw, 0.06, -0.35), hw + 0.04, 1.1, 0, 0, 0, -1.05);
  // Candelabras at the head corners.
  for (const s of [-1, 1]) {
    const x = s * (W / 2 - 0.11);
    const z = -D / 2 + 0.11;
    b.add('darkTrim', cyl(0.12, 0.14, 0.04, 10), x, 0.02, z);
    b.add('darkTrim', taper(v3(x, 0.04, z), v3(x, 1.3, z), 0.03, 0.018, 6));
    for (const k of [-1, 0, 1]) {
      const cx = x + k * 0.13;
      const cy = 1.3 + (k === 0 ? 0.08 : 0);
      if (k) b.add('darkTrim', strut(v3(x, 1.22, z), v3(cx, cy, z), 0.01, 4));
      b.add('darkTrim', cyl(0.035, 0.02, 0.03, 8), cx, cy, z);
      b.add('bone', cyl(0.018, 0.018, 0.16, 8), cx, cy + 0.095, z);
      b.add('pumpkinGlow', ell(0.012, 0.03, 0.012, 6, 5), cx, cy + 0.2, z);
    }
  }
  return b.build();
}

/** Vampire: pale count with raised arms holding his cape open; red lining, glowing eyes. */
function vampire(t: ObjectType): PropParts {
  const [W] = t.size;
  const b = new Builder();
  b.add('stone', rbox(1.5, 0.26, 1.2, 0.04), 0, 0.13, 0);
  b.add('stone', rbox(1.2, 0.24, 0.95, 0.04), 0, 0.38, 0);
  const y0 = 0.5;
  const P = (x: number, y: number, z: number) => v3(x, y0 + y, z);
  // Legs, shoes, tailcoat body, shirt front, cravat.
  for (const s of [-1, 1]) {
    limb(b, 'darkTrim', P(s * 0.11, 0.1, 0), P(s * 0.12, 0.95, 0), 0.07, 0.09, 8);
    b.add('darkTrim', ell(0.07, 0.05, 0.15, 8, 6), s * 0.11, y0 + 0.05, -0.05);
  }
  b.add('darkTrim', lathe([[0.17, 0.0], [0.2, 0.15], [0.21, 0.35], [0.26, 0.6], [0.24, 0.72], [0.1, 0.8], [0.001, 0.8]], 12).scale(1, 1, 0.7), 0, y0 + 0.92, 0);
  b.add('bone', box(0.13, 0.42, 0.04), 0, y0 + 1.42, -0.17, -0.08, 0, 0);
  b.add('fabric', ell(0.06, 0.05, 0.03, 8, 6), 0, y0 + 1.6, -0.19);
  b.add('copper', cyl(0.035, 0.035, 0.012, 10).rotateX(Q), 0, y0 + 1.5, -0.2);
  // Head: pale skin, slicked hair with a widow's peak, pointed ears, red eyes, fangs.
  const hy = y0 + 1.84;
  b.add('bone', ell(0.1, 0.13, 0.11, 14, 10), 0, hy, -0.01);
  b.add('bone', cyl(0.05, 0.06, 0.12, 8), 0, hy - 0.15, 0);
  b.add('darkTrim', ell(0.108, 0.1, 0.115, 14, 8), 0, hy + 0.05, 0.015);
  b.add('darkTrim', new THREE.ConeGeometry(0.035, 0.07, 4).rotateX(Math.PI), 0, hy + 0.08, -0.1);
  for (const s of [-1, 1]) {
    b.add('bone', spike(v3(s * 0.09, hy, -0.0), v3(s * 0.16, hy + 0.07, 0.03), 0.03, 4));
    b.add('taillight', new THREE.SphereGeometry(0.016, 6, 5), s * 0.037, hy + 0.015, -0.103);
    b.add('bone', new THREE.ConeGeometry(0.007, 0.025, 4).rotateX(Math.PI), s * 0.018, hy - 0.08, -0.098);
  }
  // Stand-up collar: crimson inside, black outside.
  const collar = (r0: number, r1: number) => new THREE.CylinderGeometry(r1, r0, 0.42, 14, 1, true, Math.PI * 1.12, Math.PI * 1.76);
  b.add('fabric', collar(0.2, 0.32), 0, hy - 0.02, 0.05);
  const inner = collar(0.19, 0.31).scale(-1, 1, 1);
  inner.deleteAttribute('normal');
  inner.computeVertexNormals();
  b.add('velvet', inner, 0, hy - 0.02, 0.05);
  // Arms raised, holding the cape like wings.
  const sh: Vec[] = [];
  const wr: Vec[] = [];
  for (const s of [-1, 1]) {
    const S = P(s * 0.24, 1.62, 0);
    const E = P(s * 0.55, 1.78, 0.02);
    const Wr = P(s * (W / 2 - 0.15), 1.98, -0.06);
    limb(b, 'darkTrim', S, E, 0.075, 0.06, 8);
    limb(b, 'darkTrim', E, Wr, 0.06, 0.05, 8);
    b.add('bone', ell(0.045, 0.06, 0.03, 8, 6), Wr.x + s * 0.03, Wr.y + 0.06, Wr.z);
    for (let f = 0; f < 4; f++) b.add('bone', spike(v3(Wr.x + s * 0.04, Wr.y + 0.1, Wr.z - 0.02 + f * 0.012), v3(Wr.x + s * 0.07, Wr.y + 0.17, Wr.z - 0.03 + f * 0.02), 0.008, 4));
    sh.push(S);
    wr.push(Wr);
  }
  // Cape: a two-sided parametric sheet from the arms down to a scalloped hem behind the figure.
  const NU = 18;
  const NV = 9;
  const top = (u: number) => {
    const a = Math.abs(u);
    const s = Math.sign(u) || 1;
    if (a < 0.3) return v3(u * 0.8, y0 + 1.68, 0.14);
    const k = (a - 0.3) / 0.7;
    return v3(s * (0.24 + k * (W / 2 - 0.39)), y0 + 1.66 + k * 0.32, 0.12 - k * 0.18);
  };
  const bottom = (u: number) => v3(u * (W / 2 - 0.02), y0 + 0.08 + 0.32 * Math.abs(u) + 0.12 * Math.abs(Math.sin(u * Math.PI * 3)), 0.32 + 0.18 * (1 - Math.abs(u)));
  const sheet = (off: number, flip: boolean) => {
    const pos: number[] = [];
    for (let j = 0; j <= NV; j++)
      for (let i = 0; i <= NU; i++) {
        const u = (i / NU) * 2 - 1;
        const v = j / NV;
        const p = top(u).lerp(bottom(u), v);
        p.z += 0.22 * Math.sin(Math.PI * v) * (1 - 0.5 * Math.abs(u)) + off;
        pos.push(p.x, p.y, p.z);
      }
    const idx: number[] = [];
    for (let j = 0; j < NV; j++)
      for (let i = 0; i < NU; i++) {
        const a = j * (NU + 1) + i;
        const c = a + NU + 1;
        if (flip) idx.push(a, a + 1, c, a + 1, c + 1, c);
        else idx.push(a, c, a + 1, a + 1, c, c + 1);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  };
  b.add('fabric', sheet(0.012, false));
  b.add('velvet', sheet(-0.012, true));
  void sh;
  void wr;
  return b.build();
}

/** Werewolf on a rock: digitigrade legs, barrel chest arched back, howling at the moon. */
function werewolf(t: ObjectType): PropParts {
  void t;
  const b = new Builder();
  const rock = new THREE.IcosahedronGeometry(0.78, 1).scale(1, 0.42, 0.95);
  b.add('stone', rock, 0, 0.26, 0.02);
  b.add('stone', rbox(1.5, 0.12, 1.5, 0.04), 0, 0.06, 0);
  const y0 = 0.56;
  const P = (x: number, y: number, z: number) => v3(x, y0 + y, z);
  const fur: Role = 'fabric';
  // Legs.
  for (const s of [-1, 1]) {
    const toe = P(s * 0.24, 0.05, s > 0 ? 0.1 : -0.12);
    const ankle = P(s * 0.24, 0.32, toe.z + 0.2);
    const knee = P(s * 0.22, 0.74, toe.z - 0.12);
    const hip = P(s * 0.2, 1.12, 0.06);
    b.add(fur, ell(0.09, 0.06, 0.18, 8, 6), toe.x, toe.y, toe.z - 0.04);
    for (let c = 0; c < 3; c++) b.add('bone', spike(v3(toe.x + (c - 1) * 0.05, toe.y, toe.z - 0.17), v3(toe.x + (c - 1) * 0.06, toe.y - 0.04, toe.z - 0.27), 0.017, 4));
    limb(b, fur, toe, ankle, 0.06, 0.07, 8);
    limb(b, fur, ankle, knee, 0.075, 0.1, 8);
    limb(b, fur, knee, hip, 0.13, 0.17, 10);
    b.add('darkTrim', taper(knee.clone().lerp(hip, 0.35), hip, 0.15, 0.18, 10)); // torn trousers
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      const c = knee.clone().lerp(hip, 0.32);
      b.add('darkTrim', spike(v3(c.x + Math.cos(a) * 0.13, c.y, c.z + Math.sin(a) * 0.13), v3(c.x + Math.cos(a) * 0.14, c.y - 0.12, c.z + Math.sin(a) * 0.14), 0.05, 3));
    }
  }
  b.add('darkTrim', ell(0.3, 0.2, 0.22, 12, 8), 0, y0 + 1.13, 0.05);
  // Torso: belly, barrel chest leaning back as he howls.
  b.add(fur, ell(0.28, 0.3, 0.23, 12, 10), 0, y0 + 1.42, 0.02);
  b.add(fur, ell(0.42, 0.36, 0.32, 14, 10), 0, y0 + 1.82, 0.0, -0.22, 0, 0);
  // Mane and shoulder tufts.
  for (let i = 0; i < 11; i++) {
    const a = -0.4 + (i / 10) * (Math.PI + 0.8);
    const base = v3(Math.cos(a) * 0.3, y0 + 2.05 + Math.sin(a) * 0.05, 0.12 + Math.sin(a) * 0.12);
    b.add(fur, spike(base, base.clone().add(v3(Math.cos(a) * 0.12, 0.14, 0.18)), 0.07, 5));
  }
  // Arms with long clawed hands.
  for (const s of [-1, 1]) {
    const S = P(s * 0.42, 2.0, 0.0);
    const E = P(s * 0.62, 1.62, -0.1);
    const Wr = P(s * 0.66, 1.24, -0.24);
    limb(b, fur, S, E, 0.13, 0.095, 8);
    limb(b, fur, E, Wr, 0.09, 0.07, 8);
    b.add(fur, spike(E, E.clone().add(v3(s * 0.08, -0.02, 0.16)), 0.06, 4));
    b.add(fur, ell(0.08, 0.12, 0.06, 8, 6), Wr.x, Wr.y - 0.1, Wr.z);
    for (let c = 0; c < 4; c++) b.add('bone', spike(v3(Wr.x + (c - 1.5) * 0.035, Wr.y - 0.2, Wr.z - 0.02), v3(Wr.x + (c - 1.5) * 0.045, Wr.y - 0.34, Wr.z - 0.08), 0.014, 4));
  }
  // Neck and head tilted up, jaws open, ears back.
  b.add(fur, taper(P(0, 2.08, 0.02), P(0, 2.38, -0.12), 0.19, 0.15, 10));
  const head = P(0, 2.48, -0.14);
  b.add(fur, ell(0.19, 0.19, 0.22, 12, 10), head.x, head.y, head.z, -0.5, 0, 0);
  const muzzleTip = P(0, 2.82, -0.42);
  b.add(fur, taper(P(0, 2.55, -0.24), muzzleTip, 0.12, 0.06, 10));
  b.add('darkTrim', new THREE.SphereGeometry(0.045, 8, 6), muzzleTip.x, muzzleTip.y + 0.01, muzzleTip.z - 0.01);
  b.add(fur, taper(P(0, 2.42, -0.28), P(0, 2.6, -0.5), 0.07, 0.035, 8)); // lower jaw dropped open
  for (const s of [-1, 1]) {
    b.add('bone', new THREE.ConeGeometry(0.013, 0.05, 4), s * 0.04, y0 + 2.67, -0.37);
    b.add('bone', new THREE.ConeGeometry(0.012, 0.045, 4).rotateX(Math.PI), s * 0.03, y0 + 2.53, -0.42);
    b.add(fur, spike(P(s * 0.12, 2.58, -0.02), P(s * 0.18, 2.84, 0.1), 0.065, 4));
    b.add('signalAmber', new THREE.SphereGeometry(0.022, 6, 5), s * 0.085, y0 + 2.58, -0.28);
    b.add(fur, spike(P(s * 0.15, 2.42, -0.2), P(s * 0.27, 2.36, -0.12), 0.05, 4)); // cheek ruff
  }
  // Tail.
  b.add(fur, taper(P(0, 1.12, 0.26), P(0, 0.85, 0.58), 0.09, 0.07, 8));
  b.add(fur, taper(P(0, 0.85, 0.58), P(0.05, 0.6, 0.72), 0.07, 0.03, 8));
  return b.build();
}

function giantCauldron(t: ObjectType): PropParts {
  void t;
  const b = new Builder(); // witch's cauldron on iron legs over a stone fire pit, paddle and bone in the brew
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    b.add('stone', new THREE.DodecahedronGeometry(0.16, 0).scale(1.2, 0.7, 1), Math.cos(a) * 1.1, 0.1, Math.sin(a) * 1.1, 0, a * 2, 0);
  }
  cauldronParts(b, 2.45, false);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    b.add('wood', taper(v3(Math.cos(a) * 0.95, 0.08, Math.sin(a) * 0.95), v3(Math.cos(a) * 0.15, 0.22, Math.sin(a) * 0.15), 0.07, 0.06, 6));
  }
  for (const [x, z, h] of [[0, 0, 0.42], [0.18, 0.1, 0.3], [-0.16, -0.06, 0.34], [0.05, -0.2, 0.26], [-0.08, 0.2, 0.24]] as const) b.add('pumpkinGlow', new THREE.ConeGeometry(0.1, h, 6), x, 0.15 + h / 2, z);
  b.add('wood', taper(v3(0.15, 1.6, 0.1), v3(0.75, 2.85, 0.45), 0.05, 0.04, 6)); // paddle
  b.add('bone', taper(v3(-0.35, 1.75, -0.2), v3(-0.55, 2.2, -0.35), 0.035, 0.03, 6)); // a bone in the brew
  b.add('bone', ell(0.05, 0.05, 0.05, 6, 5), -0.55, 2.22, -0.35);
  return b.build();
}

// ── Class 6: crypts, giant pumpkins, the pumpkin coach ───────────────────────
function crypt(t: ObjectType): PropParts {
  const [W, H, D] = t.size; // Greek-revival mausoleum: steps, portico, pediment, iron doors leaking green light
  const b = new Builder();
  const s = 'concreteProp' as const;
  b.add(s, rbox(W, 0.3, D, 0.03), 0, 0.15, 0);
  b.add(s, rbox(W - 0.4, 0.3, D - 0.5, 0.03), 0, 0.45, 0.1);
  const cellaW = W - 1.0;
  const cellaD = D - 2.0;
  const cz = D / 2 - 0.35 - cellaD / 2;
  b.add(s, box(cellaW, 2.9, cellaD), 0, 0.6 + 1.45, cz);
  for (const sx of [-1, 1]) b.add(s, box(0.4, 2.9, 0.4), sx * (cellaW / 2), 0.6 + 1.45, cz - cellaD / 2 + 0.1); // antae
  // Portico columns.
  const colZ = -D / 2 + 0.8;
  for (const sx of [-1, 1]) {
    const x = sx * 1.25;
    b.add(s, lathe([[0.28, 0], [0.28, 0.12], [0.22, 0.18], [0.2, 2.5], [0.24, 2.58], [0.3, 2.7]], 14), x, 0.6, colZ);
    b.add(s, box(0.64, 0.12, 0.64), x, 3.36, colZ);
  }
  b.add(s, box(W - 0.3, 0.5, D - 0.6), 0, 3.67, 0.05); // entablature
  b.add('darkTrim', box(1.6, 0.12, 0.01), 0, 3.66, -D / 2 + 0.255); // carved name
  // Pediment and pitched stone roof.
  const pedW = W - 0.3;
  const rise = H - 3.92 - 0.42;
  const ped = poly([[-pedW / 2, 0], [pedW / 2, 0], [0, rise]]);
  b.add(s, slab(ped, 0.3), 0, 3.92, -D / 2 + 0.45);
  b.add(s, slab(ped, 0.3), 0, 3.92, D / 2 - 0.35);
  const half = pedW / 2 + 0.12;
  const ang = Math.atan2(rise, half);
  for (const sx of [-1, 1]) b.add(s, box(Math.hypot(half, rise) + 0.05, 0.18, D - 0.5), (sx * half) / 2, 3.92 + rise / 2 + 0.08, 0.05, 0, 0, -sx * ang);
  b.add(s, box(0.08, 0.42, 0.08), 0, H - 0.21, -D / 2 + 0.45); // cross
  b.add(s, box(0.28, 0.08, 0.08), 0, H - 0.12, -D / 2 + 0.45);
  for (const sx of [-1, 1]) b.add(s, box(0.22, 0.26, 0.22), sx * (pedW / 2 - 0.1), 4.05, -D / 2 + 0.45); // acroteria
  // Doors with a green glow leaking through the seam and under the sill.
  const dz = cz - cellaD / 2 - 0.04;
  b.add('darkTrim', box(1.4, 2.3, 0.08), 0, 0.6 + 1.15, dz);
  for (let i = 0; i < 5; i++) b.add('darkTrim', box(0.035, 2.2, 0.06), -0.5 + i * 0.25, 0.6 + 1.15, dz - 0.05);
  b.add('darkTrim', box(1.4, 0.05, 0.06), 0, 0.6 + 1.6, dz - 0.05);
  b.add('ghostGlow', box(0.05, 2.1, 0.06), 0, 0.6 + 1.1, dz - 0.03);
  b.add('ghostGlow', box(1.3, 0.04, 0.4), 0, 0.62, dz - 0.18);
  b.add(s, box(1.8, 0.25, 0.14), 0, 0.6 + 2.43, dz - 0.04); // lintel
  // Lancet windows of violet glass on the sides, a rose window at the back.
  for (const sx of [-1, 1]) {
    b.add('witchGlow', slab(lancet(0.42, 1.2), 0.06), sx * (cellaW / 2 + 0.005), 1.6, cz, 0, Q, 0);
    b.add(s, slab(lancet(0.6, 1.36), 0.04), sx * (cellaW / 2 + 0.02), 1.52, cz, 0, Q, 0);
    b.add('stone', lathe([[0.001, 0], [0.16, 0.02], [0.22, 0.2], [0.12, 0.42], [0.16, 0.48], [0.001, 0.5]], 12), sx * (W / 2 - 0.35), 0.6, -D / 2 + 0.25); // urns
    b.add('copper', ell(0.35, 0.08, 0.25, 8, 5), sx * (W / 2 - 0.4), 0.32, D / 2 - 0.6); // moss
  }
  b.add('witchGlow', cyl(0.4, 0.4, 0.06, 16).rotateX(Q), 0, 2.4, cz + cellaD / 2 + 0.01);
  b.add(s, new THREE.TorusGeometry(0.44, 0.07, 6, 16), 0, 2.4, cz + cellaD / 2 + 0.03);
  return b.build();
}

/** Gable triangle of base `span` and height `rise`, as a slab facing ±Z. */
function gable(span: number, rise: number, depth: number): THREE.BufferGeometry {
  return slab(poly([[-span / 2, 0], [span / 2, 0], [0, rise]]), depth);
}

/** Pointed (lancet) arch outline, base on y = 0. */
function lancet(w: number, h: number): THREE.Shape {
  const s = new THREE.Shape();
  const spring = h - w * 0.85;
  s.moveTo(-w / 2, 0);
  s.lineTo(w / 2, 0);
  s.lineTo(w / 2, spring);
  s.quadraticCurveTo(w / 2, h - w * 0.2, 0, h);
  s.quadraticCurveTo(-w / 2, h - w * 0.2, -w / 2, spring);
  s.closePath();
  return s;
}

function giantPumpkin(t: ObjectType): PropParts {
  const [W, H] = t.size;
  const b = new Builder();
  const R = W / 2;
  const ph = H * 0.86;
  b.add('plastic', pumpkinGeo(R, ph, 10, 0.1, 40, 18));
  carveFace(b, R, ph, 0, 'pumpkinGlow', 0.88);
  stem(b, 0.05, ph - 0.12, 0.02, H - ph + 0.12, 0.17, 1.4);
  // Vines and leaves trailing on the ground.
  for (const [a0, len] of [[0.6, 1.4], [2.6, 1.1], [4.3, 1.3]] as const) {
    const pts: Vec[] = [];
    for (let i = 0; i <= 5; i++) {
      const a = a0 + i * 0.22;
      const r = R * 0.75 + (i / 5) * len;
      pts.push(v3(Math.cos(a) * r, 0.06 + Math.sin(i * 1.7) * 0.03, Math.sin(a) * r));
    }
    b.add('copper', new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 14, 0.035, 5));
    const tip = pts[5];
    b.add('copper', ell(0.32, 0.03, 0.24, 10, 4), tip.x, 0.06, tip.z, 0, a0, 0.1);
    b.add('copper', ell(0.26, 0.03, 0.2, 10, 4), pts[3].x, 0.06, pts[3].z, 0, a0 + 1, -0.1);
  }
  return b.build();
}

/** Carriage undercarriage: four spoked wheels, axles, perch, leaf springs, shafts. */
function carriageChassis(b: Builder, W: number, L: number, rf: number, rr: number): void {
  const zf = -L / 2 + rf + 0.55;
  const zr = L / 2 - rr - 0.05;
  for (const s of [-1, 1]) {
    spokedWheel(b, rr, s * (W / 2 - 0.12), rr, zr, 14);
    spokedWheel(b, rf, s * (W / 2 - 0.2), rf, zf, 12);
  }
  b.add('darkTrim', box(W - 0.3, 0.08, 0.08), 0, rr, zr);
  b.add('darkTrim', box(W - 0.45, 0.08, 0.08), 0, rf, zf);
  b.add('darkTrim', box(0.12, 0.1, zr - zf), 0, Math.min(rf, rr) + 0.12, (zf + zr) / 2);
  for (const s of [-1, 1]) {
    for (const [z, r] of [[zr, rr], [zf, rf]] as const) b.add('darkTrim', new THREE.TorusGeometry(0.28, 0.025, 4, 12, Math.PI).rotateY(Q).rotateX(Math.PI), s * 0.55, r + 0.32, z);
    b.add('wood', strut(v3(s * 0.45, rf - 0.05, zf), v3(s * 0.4, rf - 0.15, -L / 2 + 0.05), 0.035, 6)); // shafts
  }
}

function pumpkinCarriage(t: ObjectType): PropParts {
  const [W, H, L] = t.size; // pumpkin coach: lit arched windows, wrought-iron crown, coachman's box, lanterns
  const b = new Builder();
  carriageChassis(b, W, L, 0.55, 0.78);
  const R = 1.05;
  const ph = 2.15;
  const y0 = 0.95;
  const zk = 1.22;
  const z0 = 0.25;
  b.add('plastic', pumpkinGeo(R, ph, 10, 0.1, 36, 16).scale(1, 1, zk), 0, y0, z0);
  // Arched windows on both sides (mapped onto the elongated rind), door outline on the right.
  const arch = new THREE.Shape();
  arch.moveTo(-0.32, -0.36);
  arch.lineTo(0.32, -0.36);
  arch.lineTo(0.32, 0.08);
  arch.absarc(0, 0.08, 0.32, 0, Math.PI, false);
  arch.closePath();
  const yc = y0 + ph * 0.52;
  for (const s of [-1, 1]) {
    const win = onShell(new THREE.ExtrudeGeometry(arch, { depth: 0.04, bevelEnabled: false, curveSegments: 8 }).translate(0, yc, 0), R * zk, ph * 0.5, R, yc, 0.04);
    b.add('windowGlow', win.rotateY(s * Q), 0, 0, z0);
    const frame = onShell(new THREE.ExtrudeGeometry(arch, { depth: 0.03, bevelEnabled: false, curveSegments: 8 }).scale(1.25, 1.18, 1).translate(0, yc, 0), R * zk, ph * 0.5, R, yc, 0.03);
    b.add('darkTrim', frame.rotateY(s * Q), 0, 0, z0);
    b.add('darkTrim', box(0.035, 0.7, 0.035).translate(0, yc, -R - 0.02).rotateY(s * Q), 0, 0, z0);
  }
  // Crown of iron curls and the stem.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.add('darkTrim', new THREE.TorusGeometry(0.16, 0.022, 4, 12, Math.PI * 1.4), Math.cos(a) * 0.3, y0 + ph + 0.02, z0 + Math.sin(a) * 0.36, 0, -a, Q * 0.5);
  }
  stem(b, 0, y0 + ph - 0.08, z0, H - (y0 + ph) + 0.08, 0.12, 1.6);
  // Coachman's box and lanterns.
  const fz = -L / 2 + 0.5;
  b.add('wood', box(1.1, 0.12, 0.5), 0, 1.7, fz + 0.15);
  b.add('darkTrim', box(1.1, 0.5, 0.06), 0, 1.92, fz + 0.4);
  b.add('darkTrim', strut(v3(0, 1.0, z0 - R * zk + 0.2), v3(0, 1.64, fz + 0.15), 0.06, 6));
  b.add('wood', box(1.0, 0.06, 0.4), 0, 1.15, fz - 0.15, -0.4, 0, 0);
  for (const s of [-1, 1]) {
    b.add('darkTrim', strut(v3(s * 0.62, 1.4, fz + 0.3), v3(s * 0.62, 2.25, fz + 0.3), 0.025, 5));
    b.add('darkTrim', box(0.2, 0.04, 0.2), s * 0.62, 2.28, fz + 0.3);
    b.add('pumpkinGlow', box(0.15, 0.22, 0.15), s * 0.62, 2.41, fz + 0.3);
    b.add('darkTrim', new THREE.ConeGeometry(0.15, 0.14, 4).rotateY(Math.PI / 4), s * 0.62, 2.59, fz + 0.3);
  }
  return b.build();
}

// ── New small finds ──────────────────────────────────────────────────────────
function eyeball(t: ObjectType): PropParts {
  const r = t.size[0] / 2; // a loose glass-bright eyeball; the iris glows in the instance colour
  const b = new Builder();
  b.add('bone', new THREE.SphereGeometry(r, 10, 8), 0, r, 0);
  b.add('slime', cyl(r * 0.5, r * 0.5, 0.004, 12).rotateX(Q), 0, r * 1.05, -r * 0.88, -0.25, 0, 0);
  b.add('darkTrim', cyl(r * 0.22, r * 0.22, 0.004, 8).rotateX(Q), 0, r * 1.07, -r * 0.95, -0.25, 0, 0);
  return b.build();
}

function spider(t: ObjectType): PropParts {
  void t;
  const b = new Builder(); // a hand-sized black spider: two body parts, eight bent legs, red eyes
  b.add('darkTrim', ell(0.022, 0.016, 0.026, 8, 6), 0, 0.03, -0.02);
  b.add('darkTrim', ell(0.032, 0.026, 0.038, 8, 6), 0, 0.034, 0.03);
  for (const s of [-1, 1]) {
    b.add('taillight', new THREE.SphereGeometry(0.004, 4, 3), s * 0.007, 0.038, -0.044);
    for (let i = 0; i < 4; i++) {
      const hip = v3(s * 0.016, 0.03, -0.035 + i * 0.014);
      const knee = v3(s * 0.042, 0.05, -0.05 + i * 0.028);
      const foot = v3(s * 0.058, 0.002, -0.066 + i * 0.044);
      b.add('darkTrim', strut(hip, knee, 0.0028, 3));
      b.add('darkTrim', strut(knee, foot, 0.0024, 3));
    }
  }
  return b.build();
}

/** Bat silhouette (unit wingspan ≈ 1.1), right half; mirrored for the left. */
const BAT_HALF: [number, number][] = [[0, 0.1], [0.045, 0.2], [0.07, 0.1], [0.13, 0.11], [0.3, 0.22], [0.52, 0.3], [0.55, 0.14], [0.44, 0.04], [0.4, 0.1], [0.3, -0.03], [0.24, 0.04], [0.12, -0.06], [0.06, -0.02], [0, -0.18]];
const batShape = (k: number) => poly([...BAT_HALF, ...BAT_HALF.slice(1, -1).reverse().map(([x, y]) => [-x, y] as [number, number])].map(([x, y]) => [x * k, y * k]));

function batPlush(t: ObjectType): PropParts {
  const [W] = t.size; // stuffed bat toy sitting with its wings spread
  const b = new Builder();
  b.add('fabric', slab(batShape(W / 1.1), 0.02, 0, 1), 0, 0.1, 0.03, -0.25, 0, 0);
  b.add('fabric', ell(0.065, 0.07, 0.055, 10, 8), 0, 0.07, 0);
  b.add('fabric', new THREE.SphereGeometry(0.048, 10, 8), 0, 0.13, -0.01);
  for (const s of [-1, 1]) {
    b.add('fabric', new THREE.ConeGeometry(0.018, 0.045, 5), s * 0.026, 0.18, -0.005, 0, 0, -s * 0.25);
    b.add('bone', new THREE.SphereGeometry(0.012, 6, 4), s * 0.018, 0.138, -0.05);
    b.add('darkTrim', new THREE.SphereGeometry(0.006, 5, 3), s * 0.018, 0.138, -0.061);
    b.add('bone', new THREE.ConeGeometry(0.004, 0.012, 3).rotateX(Math.PI), s * 0.008, 0.116, -0.052);
  }
  return b.build();
}

// ── New class 3–4 props ──────────────────────────────────────────────────────
function crow(b: Adder, x: number, y: number, z: number, yaw: number): void {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const at = (dx: number, dy: number, dz: number) => [x + dx * c + dz * s, y + dy, z - dx * s + dz * c] as const;
  b.add('darkTrim', ell(0.06, 0.06, 0.12, 8, 6), ...at(0, 0.06, 0), -0.3, yaw, 0);
  b.add('darkTrim', new THREE.SphereGeometry(0.045, 8, 6), ...at(0, 0.14, -0.09));
  b.add('darkTrim', new THREE.ConeGeometry(0.014, 0.07, 4).rotateX(-Q), ...at(0, 0.14, -0.15), 0, yaw, 0);
  b.add('darkTrim', new THREE.ConeGeometry(0.04, 0.16, 4).rotateX(Q), ...at(0, 0.03, 0.16), 0, yaw, 0);
  for (const k of [-1, 1]) b.add('signalAmber', new THREE.SphereGeometry(0.008, 4, 3), ...at(k * 0.03, 0.155, -0.12));
}

function crowPost(t: ObjectType): PropParts {
  const [W, H] = t.size; // weathered post and crossbar with three crows
  const b = new Builder();
  b.add('wood', box(0.09, H - 0.25, 0.09), 0, (H - 0.25) / 2, 0);
  b.add('wood', box(W, 0.06, 0.06), 0, H - 0.45, 0, 0, 0, 0.05);
  b.add('stone', ell(0.2, 0.08, 0.18, 8, 4), 0, 0, 0);
  crow(b, -W / 2 + 0.08, H - 0.43, 0, 0.6);
  crow(b, W / 2 - 0.1, H - 0.4, 0, -0.9);
  crow(b, 0, H - 0.25, 0, 2.6);
  return b.build();
}

function lanternPost(t: ObjectType): PropParts {
  const [, H] = t.size; // crooked post with a gallows arm and a carved pumpkin lantern on a chain
  const b = new Builder();
  b.add('stone', ell(0.26, 0.1, 0.24, 8, 4), 0, 0, 0.1);
  b.add('wood', taper(v3(0, 0, 0.1), v3(0.04, 1.4, 0.1), 0.075, 0.065, 7));
  b.add('wood', taper(v3(0.04, 1.4, 0.1), v3(-0.02, H - 0.1, 0.1), 0.065, 0.05, 7));
  b.add('wood', new THREE.ConeGeometry(0.07, 0.14, 4), -0.02, H - 0.04, 0.1);
  b.add('wood', taper(v3(-0.02, H - 0.3, 0.1), v3(0.5, H - 0.2, 0.1), 0.045, 0.035, 6));
  b.add('wood', strut(v3(0.0, H - 0.75, 0.1), v3(0.3, H - 0.24, 0.1), 0.025, 5));
  b.add('darkTrim', cyl(0.008, 0.008, 0.36, 4), 0.46, H - 0.4, 0.1);
  const r = 0.17;
  const ph = 0.27;
  const y0 = H - 0.58 - ph;
  b.add('plastic', pumpkinGeo(r, ph, 8, 0.12, 14, 8), 0.46, y0, 0.1);
  carveFace(shifted(b, 0.46, 0, 0.1), r, ph, y0, 'pumpkinGlow', 0.9);
  stem(b, 0.46, y0 + ph - 0.02, 0.1, 0.06, 0.02);
  return b.build();
}

function spiderWeb(t: ObjectType): PropParts {
  const [W, H] = t.size; // a web strung between two dead branches, with its owner waiting
  const b = new Builder();
  const lx = -W / 2 + 0.12;
  const rx = W / 2 - 0.12;
  b.add('wood', taper(v3(lx, 0, 0), v3(lx + 0.12, H - 0.05, 0.05), 0.07, 0.035, 6));
  b.add('wood', taper(v3(rx, 0, 0), v3(rx - 0.05, H - 0.2, -0.04), 0.07, 0.035, 6));
  b.add('wood', taper(v3(lx + 0.1, H - 0.25, 0.03), v3(rx - 0.06, H - 0.3, -0.03), 0.04, 0.03, 5));
  const c = v3(0.02, H * 0.56, 0);
  const n = 9;
  const anchors: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.2;
    const ax = THREE.MathUtils.clamp(Math.cos(a) * W, lx + 0.1, rx - 0.08);
    const ay = THREE.MathUtils.clamp(c.y + Math.sin(a) * H, 0.35, H - 0.32);
    anchors.push(v3(ax, ay, 0));
    b.add('bone', strut(c, anchors[i], 0.007, 3));
  }
  for (let ring = 1; ring <= 5; ring++) {
    const f = ring / 6;
    for (let i = 0; i < n; i++) {
      const p0 = c.clone().lerp(anchors[i], f);
      const p1 = c.clone().lerp(anchors[(i + 1) % n], f);
      p0.y -= 0.03 * ring;
      p1.y -= 0.03 * ring;
      b.add('bone', strut(p0, p1, 0.005, 3));
    }
  }
  b.add('darkTrim', ell(0.07, 0.06, 0.05, 8, 6), c.x + 0.25, c.y + 0.2, -0.02);
  b.add('darkTrim', ell(0.05, 0.05, 0.04, 8, 6), c.x + 0.25, c.y + 0.29, -0.02);
  for (const s of [-1, 1]) for (let i = 0; i < 4; i++) b.add('darkTrim', strut(v3(c.x + 0.25 + s * 0.04, c.y + 0.22 - i * 0.03, -0.02), v3(c.x + 0.25 + s * 0.16, c.y + 0.3 - i * 0.07, -0.04), 0.008, 3));
  b.add('taillight', new THREE.SphereGeometry(0.01, 4, 3), c.x + 0.24, c.y + 0.31, -0.055);
  b.add('taillight', new THREE.SphereGeometry(0.01, 4, 3), c.x + 0.27, c.y + 0.31, -0.055);
  return b.build();
}

// ── New class 5–6 props ──────────────────────────────────────────────────────
function witch(t: ObjectType): PropParts {
  void t;
  const b = new Builder(); // hunched witch stirring her cauldron: robe, straw hair, hat, glowing eyes
  const z0 = 0.42;
  b.add('fabric', lathe([[0.46, 0], [0.42, 0.18], [0.33, 0.75], [0.26, 1.18], [0.2, 1.36], [0.08, 1.44], [0.001, 1.45]], 14).scale(1, 1, 0.85), 0, 0, z0, -0.1, 0, 0);
  b.add('fabric', ell(0.2, 0.16, 0.16, 10, 6), 0, 1.3, z0 + 0.12); // hump
  const head = v3(0, 1.58, z0 - 0.2);
  b.add('bone', ell(0.1, 0.12, 0.11, 12, 8), head.x, head.y, head.z);
  b.add('bone', bend(new THREE.ConeGeometry(0.028, 0.16, 6).translate(0, 0.08, 0), 0.05, 0.16, 0.0, 0.03).rotateX(-Q - 0.4), head.x, head.y - 0.01, head.z - 0.09);
  b.add('bone', ell(0.04, 0.035, 0.04, 6, 4), head.x, head.y - 0.1, head.z - 0.07);
  for (const s of [-1, 1]) {
    b.add('ghostGlow', new THREE.SphereGeometry(0.014, 6, 4), s * 0.038, head.y + 0.025, head.z - 0.095);
    for (let i = 0; i < 4; i++) b.add('straw', spike(v3(s * 0.08, head.y + 0.05 - i * 0.02, head.z + 0.02 + i * 0.03), v3(s * (0.16 + i * 0.03), head.y - 0.3 - i * 0.05, head.z + 0.06 + i * 0.04), 0.035, 4));
    const sh = v3(s * 0.2, 1.3, z0 - 0.02);
    const wr = v3(s * 0.12, 1.08, z0 - 0.42);
    b.add('fabric', taper(sh, wr, 0.08, 0.11, 8));
    b.add('bone', ell(0.04, 0.035, 0.05, 6, 4), wr.x * 0.6, wr.y - 0.02, wr.z - 0.05);
  }
  witchHatParts(shifted(b, 0, 1.64, head.z + 0.02), 'fabric', 0, 0, 0, 0.95, -0.12);
  b.add('wood', strut(v3(0, 1.1, z0 - 0.5), v3(-0.05, 0.6, z0 - 0.82), 0.02, 5)); // ladle
  cauldronParts(shifted(b, 0, 0, -0.5), 0.85, true);
  return b.build();
}

function bonePile(t: ObjectType, seed: number): PropParts {
  const [W, H] = t.size; // a heap of bones and skulls on a mound of earth
  const b = new Builder();
  const R = W / 2 - 0.15;
  b.add('concreteProp', ell(R, H * 0.42, R * 0.92, 14, 6), 0, 0, 0);
  let k = seed * 9301 + 49297;
  const rnd = () => ((k = (k * 9301 + 49297) % 233280) / 233280);
  const surf = (r: number) => H * 0.42 * Math.sqrt(Math.max(0, 1 - (r / R) ** 2));
  for (let i = 0; i < 22; i++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * R * 0.85;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r * 0.92;
    const y = surf(r) + 0.03;
    const len = 0.35 + rnd() * 0.35;
    const g = cyl(0.028, 0.032, len, 6).rotateX(Q);
    b.add('bone', g, x, y, z, (rnd() - 0.5) * 0.6, rnd() * Math.PI, (rnd() - 0.5) * 0.5);
  }
  for (let i = 0; i < 5; i++) {
    const a = rnd() * Math.PI * 2;
    const r = rnd() * R * 0.6;
    skullParts(b, Math.cos(a) * r, surf(r) - 0.04, Math.sin(a) * r, 1.7, 0, a + Math.PI, undefined);
  }
  skullParts(b, 0, H * 0.42 - 0.02, 0, 2.2, 0, 0.3);
  return b.build();
}

function cryptGate(t: ObjectType): PropParts {
  const [W] = t.size; // cemetery gate: stone piers with pumpkin lanterns, arched iron gates, one ajar
  const b = new Builder();
  const px = W / 2 - 0.35;
  for (const s of [-1, 1]) {
    b.add('concreteProp', rbox(0.7, 2.7, 0.7, 0.04), s * px, 1.35, 0);
    b.add('concreteProp', rbox(0.86, 0.2, 0.86, 0.03), s * px, 2.8, 0);
    b.add('pumpkin', pumpkinGeo(0.22, 0.34, 8, 0.12, 14, 8), s * px, 2.9, 0);
    carveFace(shifted(b, s * px, 0, 0), 0.22, 0.34, 2.9, 'pumpkinGlow', 0.9);
  }
  const gw = px - 0.35;
  for (const s of [-1, 1]) {
    const leaf = new Builder();
    for (let i = 0; i < 7; i++) {
      const u = 0.08 + (i / 6) * (gw - 0.16);
      const top = 2.05 + 0.35 * Math.cos((u / gw) * Q);
      leaf.add('darkTrim', cyl(0.016, 0.016, top - 0.08, 5), s * u, 0.08 + (top - 0.08) / 2, 0);
      leaf.add('darkTrim', new THREE.ConeGeometry(0.03, 0.12, 4), s * u, top + 0.06, 0);
    }
    for (const y of [0.35, 1.85]) leaf.add('darkTrim', box(gw, 0.04, 0.03), (s * gw) / 2, y, 0);
    leaf.add('darkTrim', new THREE.TorusGeometry(0.12, 0.012, 3, 12), (s * gw) / 2, 1.1, 0);
    // Leaves hinge on the piers; the right one stands ajar.
    const hx = s * gw;
    const open = s > 0 ? 0.55 : 0;
    for (const [role, g] of Object.entries(leaf.build()) as [Role, THREE.BufferGeometry][]) b.add(role, g.translate(-hx, 0, 0).rotateY(open), hx, 0, 0);
  }
  b.add('darkTrim', new THREE.TorusGeometry(gw + 0.05, 0.04, 4, 20, Math.PI), 0, 2.4, 0);
  for (let i = 1; i < 6; i++) {
    const a = (i / 6) * Math.PI;
    b.add('darkTrim', strut(v3(Math.cos(a) * 0.2, 2.4 + Math.sin(a) * 0.2, 0), v3(Math.cos(a) * (gw + 0.03), 2.4 + Math.sin(a) * (gw + 0.03), 0), 0.012, 3));
  }
  return b.build();
}

function giantSpider(t: ObjectType): PropParts {
  const [W, H] = t.size; // hairy giant spider: eight jointed legs, hourglass mark, eight red eyes, fangs
  const b = new Builder();
  b.add('fabric', ell(0.55, 0.42, 0.65, 14, 10), 0, 1.25, -0.55);
  b.add('fabric', ell(0.95, 0.85, 1.15, 16, 12), 0, 1.55, 0.75, -0.25, 0, 0);
  b.add('velvet', ell(0.16, 0.04, 0.3, 8, 4), 0, 2.36, 0.7, -0.25, 0, 0);
  for (const s of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const hip = v3(s * 0.38, 1.25, -0.85 + i * 0.26);
      const knee = v3(s * (1.25 + 0.12 * Math.abs(i - 1.5)), H - 0.25 - 0.08 * i, -1.45 + i * 0.95);
      const foot = v3(s * (W / 2 - 0.15), 0.03, -2.25 + i * 1.5);
      limb(b, 'fabric', hip, knee, 0.11, 0.085, 7);
      limb(b, 'fabric', knee, foot, 0.08, 0.035, 6);
      b.add('fabric', spike(knee, knee.clone().add(v3(s * 0.12, 0.12, 0)), 0.05, 4));
    }
    b.add('bone', spike(v3(s * 0.12, 1.02, -1.1), v3(s * 0.07, 0.7, -1.2), 0.05, 5));
    b.add('taillight', new THREE.SphereGeometry(0.075, 8, 6), s * 0.14, 1.48, -1.12);
    for (let e = 0; e < 3; e++) b.add('taillight', new THREE.SphereGeometry(0.04, 6, 4), s * (0.06 + e * 0.1), 1.6 + (e % 2) * 0.05, -1.05 + e * 0.04);
  }
  return b.build();
}

function wishingWell(t: ObjectType): PropParts {
  const [, H] = t.size; // haunted well: mossy stone ring, glowing brew, shingled roof, crank and bucket
  const b = new Builder();
  b.add('stone', lathe([[1.0, 0], [1.1, 0.05], [1.1, 0.95], [1.2, 1.0], [1.2, 1.12], [0.86, 1.12], [0.86, 0.2]], 20));
  b.add('slime', cyl(0.87, 0.87, 0.04, 20), 0, 0.88, 0);
  for (const [x, z] of [[0.3, -0.2], [-0.25, 0.3]] as const) b.add('slime', new THREE.SphereGeometry(0.1, 8, 4, 0, Math.PI * 2, 0, Q), x, 0.9, z);
  for (const s of [-1, 1]) {
    b.add('wood', box(0.16, 2.3, 0.16), s * 1.0, 2.2, 0);
    b.add('wood', strut(v3(s * 1.0, 1.3, 0), v3(s * 1.0, 2.9, 0.5), 0.04, 4));
  }
  const half = 1.25;
  const rise = H - 0.15 - 3.25;
  const ang = Math.atan2(rise, half);
  for (const s of [-1, 1]) b.add('shingle', box(2.8, 0.12, Math.hypot(half, rise) + 0.1), 0, 3.25 + rise / 2, (s * half) / 2, s * ang, 0, 0);
  for (const s of [-1, 1]) b.add('wood', gable(2 * half - 0.2, rise - 0.08, 0.08), s * 1.05, 3.25, 0, 0, Q, 0);
  b.add('wood', cyl(0.07, 0.07, 2.1, 8).rotateZ(Q), 0, 2.75, 0);
  b.add('wood', strut(v3(1.08, 2.75, 0), v3(1.25, 2.55, 0), 0.03, 4));
  b.add('darkTrim', cyl(0.012, 0.012, 1.0, 4), 0.1, 2.25, 0);
  b.add('wood', lathe([[0.001, 0], [0.16, 0], [0.19, 0.3], [0.17, 0.3], [0.14, 0.04], [0.001, 0.04]], 10), 0.1, 1.45, 0);
  b.add('copper', ell(0.45, 0.12, 0.3, 8, 4), 0.85, 0.15, -0.6);
  b.add('copper', ell(0.35, 0.1, 0.3, 8, 4), -0.8, 0.12, 0.7);
  skullParts(b, 0.75, 1.12, -0.75, 1.2, 0, 0.7);
  return b.build();
}

// ── Class 7–8 giants ─────────────────────────────────────────────────────────
/** Re-texture box-projected roles after a model was resized (metre-scale UVs stay metre-scale). */
function reproject(parts: PropParts): PropParts {
  for (const [role, g] of Object.entries(parts) as [Role, THREE.BufferGeometry][]) {
    const out = PROJECTED.has(role) ? boxProjectUV(g) : g;
    out.computeBoundingSphere();
    parts[role] = out;
  }
  return parts;
}

/** A giant version of an authored prop: built at the base size, scaled to the type's size. */
function scaledFrom(base: Factory, baseSize: [number, number, number]): Factory {
  return (t, seed) => {
    const parts = base({ ...t, size: baseSize }, seed);
    const [sx, sy, sz] = [t.size[0] / baseSize[0], t.size[1] / baseSize[1], t.size[2] / baseSize[2]];
    for (const g of Object.values(parts)) g?.scale(sx, sy, sz);
    return reproject(parts);
  };
}

/** Uniformly scale a model built at a nominal scale so its height is H (base stays on y = 0). */
function fitHeight(parts: PropParts, H: number): PropParts {
  const bb = new THREE.Box3();
  for (const g of Object.values(parts)) {
    g!.computeBoundingBox();
    bb.union(g!.boundingBox!);
  }
  const k = H / Math.max(1e-3, bb.max.y);
  for (const g of Object.values(parts)) g!.scale(k, k, k);
  return reproject(parts);
}

/** Rough rock: an icosphere pushed in and out by a deterministic 3-D ripple. */
function rock(rx: number, ry: number, rz: number, detail: number, seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  const m = mergeVertices(g, 1e-5);
  const p = m.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const n = Math.sin(x * 3.1 + seed) * Math.cos(z * 2.7 - seed) * 0.5 + Math.sin(y * 4.3 + x * 1.7 + seed * 2) * 0.35 + Math.sin((x + z) * 6.1) * 0.12;
    const k = 1 + n * 0.16;
    p.setXYZ(i, x * rx * k, y * ry * k, z * rz * k);
  }
  m.computeVertexNormals();
  return m;
}

function skullRock(t: ObjectType): PropParts {
  const b = new Builder(); // a great skull grown out of a boulder, goo weeping from its eyes
  b.add('stone', rock(4.3, 2.4, 4.2, 2, 1.3), 0, 1.0, 0.2);
  for (const [x, z, r] of [[3.4, 2.2, 1.0], [-3.5, 1.4, 0.8], [2.4, -3.0, 0.7]] as const) b.add('stone', rock(r, r * 0.7, r, 1, x), x, 0.3, z);
  const k = 30;
  skullParts(b, 0, 2.2, -0.4, k, -0.08, 0, 'ghostGlow');
  for (const s of [-1, 1]) for (let i = 0; i < 3; i++) b.add('slime', ell(0.12, 0.45 + i * 0.25, 0.1, 8, 6), s * (0.84 + i * 0.1 - 0.1), 2.2 + 1.7 - i * 0.55, -0.4 - 2.55 + i * 0.12);
  b.add('slime', ell(1.3, 0.08, 0.8, 12, 4), 0, 0.05, -4.0);
  return fitHeight(b.build(), t.size[1]);
}

function skullMountain(t: ObjectType, seed: number): PropParts {
  const [, H] = t.size; // a crag piled with skulls; a giant skull at its foot forms a glowing cave
  const b = new Builder();
  b.add('stone', rock(8.4, H * 0.62, 8.2, 3, 2.1), 0, H * 0.3 - 1.2, 0.6);
  b.add('stone', rock(3.0, 3.4, 3.0, 2, 4.4), 1.2, H - 3.6, 1.2);
  let k = seed * 7 + 11;
  const rnd = () => ((k = (k * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + rnd() * 0.3;
    const y = 2 + rnd() * (H - 7);
    const rr = 8.2 * Math.sqrt(Math.max(0.05, 1 - ((y + 1.2 - H * 0.3) / (H * 0.62)) ** 2)) * 0.92;
    skullParts(b, Math.cos(a) * rr, y, 0.6 + Math.sin(a) * rr, 5 + rnd() * 5, 0, -a - Q, i % 4 === 0 ? 'ghostGlow' : undefined);
  }
  skullParts(b, 0, -0.4, -6.4, 42, 0, 0, 'ghostGlow');
  b.add('slime', ell(2.4, 0.1, 1.6, 12, 4), 0, 0.05, -10.2);
  for (const [x, z] of [[5.5, -5.5], [-6.5, -3.2], [6.8, 4.2]] as const) b.add('slime', ell(1.2, 0.08, 0.9, 10, 4), x, 0.05, z);
  return reproject(b.build());
}

function hauntedTree(t: ObjectType, seed: number): PropParts {
  const [W, H] = t.size; // ancient dead tree with a glowing carved face, gnarled limbs, hanging lanterns
  const b = new Builder();
  const bark: Role = 'timber';
  let k = seed * 13 + 7;
  const rnd = () => ((k = (k * 9301 + 49297) % 233280) / 233280);
  // Roots.
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.3;
    limb(b, bark, v3(Math.cos(a) * 0.9, 0.9, Math.sin(a) * 0.9), v3(Math.cos(a) * (W / 2 - 1.2), -0.15, Math.sin(a) * (W / 2 - 1.2)), 0.55, 0.14, 8);
  }
  // Trunk: straight-ish face section, then kinks.
  const pts = [v3(0, 0, 0), v3(0, 8, 0), v3(0.7, 11.5, 0.4), v3(0.2, 14.5, 0.9)];
  const radii = [1.65, 1.3, 1.0, 0.75];
  b.add(bark, new THREE.CylinderGeometry(radii[1], radii[0], 8, 14, 3), 0, 4, 0);
  for (let i = 1; i < pts.length - 1; i++) limb(b, bark, pts[i], pts[i + 1], radii[i], radii[i + 1], 12);
  // The face: hollow eyes and a jagged mouth, glowing from inside the trunk.
  const R = 1.47;
  const yc = 5.6;
  const decal = (pts2: [number, number][], role: Role, d: number, grow = 1) => {
    const cx = pts2.reduce((s2, q) => s2 + q[0], 0) / pts2.length;
    const cy = pts2.reduce((s2, q) => s2 + q[1], 0) / pts2.length;
    const g = new THREE.ExtrudeGeometry(poly(pts2.map(([x, y]) => [cx + (x - cx) * grow, cy + (y - cy) * grow])), { depth: d, bevelEnabled: false });
    b.add(role, onShell(g, R, 100, R, yc, d));
  };
  const eyeL: [number, number][] = [[-0.95, 6.3], [-0.2, 6.15], [-0.45, 6.85]];
  const eyeR: [number, number][] = [[0.2, 6.15], [0.95, 6.3], [0.45, 6.85]];
  const mouth: [number, number][] = [[-0.8, 4.9], [-0.5, 4.6], [-0.3, 4.85], [-0.05, 4.5], [0.2, 4.82], [0.45, 4.55], [0.8, 4.9], [0.55, 4.05], [0.2, 4.3], [-0.1, 3.95], [-0.45, 4.25]];
  for (const shape of [eyeL, eyeR, mouth]) {
    decal(shape, 'pumpkinGlow', 0.14);
    decal(shape, 'darkTrim', 0.1, 1.25);
  }
  // Limbs: seven big gnarled branches forking twice, tips drooping.
  const top = pts[pts.length - 1];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + rnd() * 0.5;
    const from = pts[1 + (i % 3)].clone().lerp(top, 0.3 + (i % 3) * 0.2);
    let q = from.clone();
    let r = 0.55;
    let dir = new THREE.Vector3(Math.cos(a), 0.55 + rnd() * 0.4, Math.sin(a)).normalize();
    for (let sgm = 0; sgm < 3; sgm++) {
      const len = (3.0 - sgm * 0.7) * (0.85 + rnd() * 0.3);
      let next = q.clone().addScaledVector(dir, len);
      next.x = THREE.MathUtils.clamp(next.x, -W / 2 + 0.4, W / 2 - 0.4);
      next.z = THREE.MathUtils.clamp(next.z, -W / 2 + 0.4, W / 2 - 0.4);
      next.y = Math.min(next.y, H - 0.4);
      limb(b, bark, q, next, r, r * 0.6, 7);
      if (sgm >= 1) {
        const fd = dir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.9 * (rnd() < 0.5 ? -1 : 1)).setY(dir.y + 0.2).normalize();
        const tip = next.clone().addScaledVector(fd, 1.6);
        tip.y = Math.min(tip.y, H - 0.2);
        b.add(bark, taper(next, tip, r * 0.5, 0.05, 5));
      }
      if (sgm === 1 && i % 2 === 0) {
        // A pumpkin lantern hanging on a chain from this limb.
        const hang = q.clone().lerp(next, 0.6);
        b.add('darkTrim', cyl(0.025, 0.025, 1.4, 4), hang.x, hang.y - 0.7, hang.z);
        b.add('pumpkin', pumpkinGeo(0.4, 0.62, 8, 0.12, 12, 7), hang.x, hang.y - 2.0, hang.z);
        b.add('pumpkinGlow', ell(0.16, 0.12, 0.05, 6, 4), hang.x, hang.y - 1.7, hang.z - 0.39);
      }
      q = next;
      r *= 0.6;
      dir = dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), (rnd() - 0.5) * 0.8).setY(dir.y - 0.25).normalize();
    }
  }
  return reproject(b.build());
}

function giantSkeleton(t: ObjectType): PropParts {
  // A giant skeleton clawing out of its grave: torso and skull above the mound, one arm raised,
  // the other hand planted. Authored at 1.75 m skeleton scale (ground at y 0.95), then fitted.
  const b = new Builder();
  const g0 = 0.95;
  const P = (x: number, y: number, z: number) => v3(x, y - g0, z);
  const r = 0.024;
  skullParts(b, 0.02, 1.53 - g0, 0.0, 1.1, -0.15, 0.2, 'ghostGlow');
  for (let i = 0; i < 7; i++) b.add('bone', cyl(0.024, 0.026, 0.03, 6), 0, 1.06 + i * 0.056 - g0, 0.05);
  for (let i = 0; i < 6; i++) {
    const y = 1.43 - i * 0.052 - g0;
    const rr = 0.1 + Math.sin(((i + 1) / 7) * Math.PI) * 0.035;
    b.add('bone', new THREE.TorusGeometry(rr, 0.011, 4, 10, Math.PI * 0.86).rotateX(Q).rotateY(Math.PI / 2 + Math.PI * 0.07).scale(1, 1, 0.75), 0, y, 0.02, 0.18, 0, 0);
  }
  b.add('bone', box(0.03, 0.22, 0.016), 0, 1.33 - g0, -0.065, 0.1, 0, 0);
  for (const s of [-1, 1]) b.add('bone', strut(P(s * 0.03, 1.47, -0.05), P(s * 0.17, 1.48, 0), 0.012, 5));
  // Raised arm (+X) reaching up, the other planted on the mound (−X).
  const shR = P(0.18, 1.46, 0.01);
  const elR = P(0.33, 1.76, -0.06);
  const wrR = P(0.36, 2.06, -0.12);
  limb(b, 'bone', shR, elR, r, r * 0.85, 6);
  limb(b, 'bone', elR, wrR, r * 0.8, r * 0.7, 6);
  b.add('bone', box(0.06, 0.08, 0.025), wrR.x, wrR.y + 0.05, wrR.z, -0.2, 0, 0);
  for (let f = 0; f < 4; f++) b.add('bone', strut(v3(wrR.x - 0.02 + f * 0.013, wrR.y + 0.09, wrR.z), v3(wrR.x - 0.03 + f * 0.018, wrR.y + 0.15, wrR.z - 0.03), 0.006, 3));
  const shL = P(-0.18, 1.46, 0.01);
  const elL = P(-0.36, 1.16, -0.14);
  const wrL = P(-0.46, 0.98, -0.32);
  limb(b, 'bone', shL, elL, r, r * 0.85, 6);
  limb(b, 'bone', elL, wrL, r * 0.8, r * 0.7, 6);
  b.add('bone', box(0.08, 0.02, 0.07), wrL.x - 0.02, wrL.y - 0.02, wrL.z - 0.04, 0, 0.4, 0);
  for (let f = 0; f < 4; f++) b.add('bone', strut(v3(wrL.x - 0.04 + f * 0.02, wrL.y - 0.02, wrL.z - 0.07), v3(wrL.x - 0.07 + f * 0.03, wrL.y - 0.035, wrL.z - 0.13), 0.006, 3));
  // Grave mound, broken slab and rubble.
  b.add('concreteProp', ell(0.6, 0.1, 0.48, 14, 5), 0, 0, 0.02);
  b.add('concreteProp', box(0.3, 0.035, 0.5), 0.34, 0.06, 0.2, 0.2, 0.4, 0.25);
  for (const [x, z, s] of [[-0.3, 0.3, 0.05], [0.4, -0.25, 0.04], [-0.1, -0.38, 0.035], [0.15, 0.4, 0.045]] as const) b.add('concreteProp', new THREE.DodecahedronGeometry(s, 0), x, 0.05, z, x, z, 0);
  return fitHeight(b.build(), t.size[1]);
}

function giantCauldronBase(t: ObjectType): PropParts {
  return giantCauldron(t);
}

export const HALLOWEEN_BUILDERS = {
  candy,
  candyCorn,
  lollipop,
  candle,
  bone: boneProp,
  eyeball,
  spider,
  batPlush,
  crowPost,
  lanternPost,
  spiderWeb,
  witch,
  bonePile,
  cryptGate,
  giantSpider,
  wishingWell,
  giantJack: scaledFrom(giantPumpkin, [3.0, 2.6, 3.0]),
  colossalPumpkin: scaledFrom(giantPumpkin, [3.0, 2.6, 3.0]),
  mausoleum: scaledFrom(crypt, [4.4, 4.9, 6.0]),
  giantObelisk: scaledFrom(tombstone, [0.95, 2.8, 0.95]),
  giantScarecrow: scaledFrom(scarecrow, [1.7, 2.35, 0.55]),
  witchHatTower: scaledFrom(witchHat, [0.5, 0.6, 0.5]),
  skullRock,
  skullMountain,
  hauntedTree,
  giantSkeleton,
  skull,
  miniPumpkin,
  candyBucket,
  witchHat,
  tombstone,
  ironFence,
  jackOLantern,
  cauldron,
  skeleton,
  broomRack,
  batSign,
  coffin,
  slimeGhost,
  scarecrow,
  vampireCoffin,
  vampire,
  werewolf,
  giantCauldron: scaledFrom(giantCauldronBase, [2.7, 2.9, 2.7]),
  crypt,
  giantPumpkin,
  pumpkinCarriage,
} satisfies Partial<Record<Shape, Factory>>;
