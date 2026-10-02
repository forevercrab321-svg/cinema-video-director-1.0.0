import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Role } from '../art/materials';
import type { ObjectType, Shape } from '../config/objects';
import { Builder, box, cyl, lathe, poly, profile, rbox, strut, v3, wheel, type PropParts } from './propKit';

/**
 * HALLOWEEN TOWN prop kit: graveyard, witch camp, monster figures, carriages and the two
 * haunted building types. Same contract as props.ts / cityProps.ts: real-world metres, pivot
 * on the ground at the footprint centre, forward = −Z, one geometry per material role.
 *
 * Colour discipline: every model carries ONE tinted role (its per-instance variant colour);
 * the other parts use untinted roles (bone, pumpkin, straw, velvet, wood, stone, darkTrim…).
 * Glows (carved faces, lit windows, ghost eyes) fold into the shared 'lamps' draw call.
 */
type Factory = (t: ObjectType, seed: number) => PropParts;
type Vec = THREE.Vector3;
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
function carveFace(b: Builder, R: number, H: number, y0: number, glow: Role = 'pumpkinGlow', scale = 0.92): void {
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
function skullParts(b: Builder, x: number, y: number, z: number, k = 1, rx = 0): void {
  const put = (role: Role, g: THREE.BufferGeometry, px: number, py: number, pz: number) => {
    g.scale(k, k, k).translate(px * k, py * k, pz * k).rotateX(rx);
    b.add(role, g, x, y, z);
  };
  put('bone', ell(0.07, 0.075, 0.088, 10, 8), 0, 0.09, 0.018);
  put('bone', ell(0.058, 0.05, 0.05, 8, 6), 0, 0.06, -0.04);
  put('bone', box(0.075, 0.03, 0.06), 0, 0.017, -0.045);
  put('bone', box(0.05, 0.012, 0.008), 0, 0.036, -0.08);
  for (const s of [-1, 1]) put('darkTrim', ell(0.02, 0.022, 0.012, 6, 4), s * 0.028, 0.08, -0.079);
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

function witchHatParts(b: Builder, fabric: Role, x: number, y: number, z: number, k = 1, tilt = 0): void {
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

function cauldronParts(b: Builder, k: number, fire: boolean): void {
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
  const body = lathe([[0.001, 2.08], [0.16, 2.05], [0.3, 1.97], [0.39, 1.82], [0.43, 1.6], [0.45, 1.32], [0.47, 1.08], [0.43, 0.84], [0.33, 0.6], [0.23, 0.38], [0.19, 0.2], [0.24, 0.08], [0.34, 0.03], [0.001, 0.02]], 24);
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

function candyCart(t: ObjectType): PropParts {
  const [W, H, D] = t.size; // painted candy cart: glass jars, striped parasol, pumpkin, string lights
  const b = new Builder();
  b.add('paint', rbox(W - 0.3, 0.8, D - 0.1, 0.05), 0, 0.82, 0);
  b.add('wood', box(W - 0.15, 0.05, D), 0, 1.25, 0);
  b.add('darkTrim', box(W - 0.3, 0.06, D - 0.08), 0, 0.44, 0);
  for (const s of [-1, 1]) wheel(b, 0.32, 0.1, s * (W / 2 - 0.2), 0.32, 0.1, s, 8, 'wood');
  b.add('darkTrim', cyl(0.035, 0.035, 0.4, 6), 0, 0.2, -D / 2 + 0.15);
  b.add('wood', strut(v3(W / 2 - 0.1, 1.0, -0.15), v3(W / 2 + 0.25, 1.1, -0.15), 0.025, 6));
  // Jars of sweets.
  const fill: Role[] = ['pumpkin', 'bone', 'velvet', 'pumpkin'];
  for (let i = 0; i < 4; i++) {
    const x = -0.6 + i * 0.36;
    b.add('clearGlass', cyl(0.1, 0.1, 0.28, 14), x, 1.42, -0.1);
    b.add(fill[i], cyl(0.085, 0.085, 0.17, 12), x, 1.36, -0.1);
    b.add('steel', cyl(0.105, 0.105, 0.04, 14), x, 1.58, -0.1);
  }
  b.add('pumpkin', pumpkinGeo(0.17, 0.26, 8, 0.12, 16, 8), 0.55, 1.27, 0.22);
  carveFace(b, 0.17, 0.26, 1.27, 'pumpkinGlow', 0.9);
  // Striped parasol on a mast.
  b.add('steel', cyl(0.025, 0.025, H - 1.27, 6), -0.05, 1.27 + (H - 1.27) / 2, 0.3);
  const gores = 10;
  const canopy: [number, number][] = [[1.0, 0], [0.72, 0.18], [0.32, 0.31], [0.001, 0.36]];
  for (let i = 0; i < gores; i++) {
    const g = new THREE.LatheGeometry(canopy.map(([r, y]) => new THREE.Vector2(r, y)), 3, (i / gores) * Math.PI * 2, (Math.PI * 2) / gores);
    b.add(i % 2 ? 'bone' : 'fabric', g, -0.05, H - 0.38, 0.3);
  }
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    b.add('pumpkinGlow', new THREE.SphereGeometry(0.035, 6, 4), -0.05 + Math.cos(a) * 0.98, H - 0.42, 0.3 + Math.sin(a) * 0.98);
  }
  return b.build();
}

// ── Class 5: vehicles and monster figures ────────────────────────────────────
function hearse(t: ObjectType): PropParts {
  const [W, , L] = t.size; // long-wheelbase funeral car: landau bars, draped rear windows
  const b = new Builder();
  const hl = L / 2;
  const wr = 0.36;
  const fA = -1.85;
  const rA = 1.75;
  const sill = 0.32;
  const arch = 0.43;
  const body = new THREE.Shape();
  body.moveTo(-hl + 0.04, sill + 0.04);
  body.lineTo(-hl, 0.55);
  body.splineThru(([[-hl + 0.04, 0.72], [-hl + 0.4, 0.84], [-hl + 1.2, 0.93], [-0.8, 0.98], [hl - 0.6, 1.0], [hl - 0.12, 0.97], [hl, 0.78]] as [number, number][]).map(([z, y]) => new THREE.Vector2(z, y)));
  body.lineTo(hl - 0.02, 0.45);
  body.lineTo(hl - 0.1, sill);
  body.lineTo(rA + arch, sill);
  body.absarc(rA, sill, arch, 0, Math.PI, false);
  body.lineTo(fA + arch, sill);
  body.absarc(fA, sill, arch, 0, Math.PI, false);
  body.closePath();
  b.add('carPaint', profile(body, W, 0.08, 10, true));
  // Glasshouse: raked windscreen, long flat roof, near-vertical rear.
  const cab = poly([[-hl + 1.28, 0.95], [-hl + 1.98, 1.64], [hl - 0.22, 1.68], [hl - 0.05, 1.44], [hl - 0.04, 0.97]]);
  b.add('carPaint', profile(cab, W - 0.16, 0.05, 2));
  const wsLen = Math.hypot(0.7, 0.69);
  b.add('glass', box(W - 0.34, wsLen - 0.08, 0.03), 0, (0.95 + 1.64) / 2, -hl + (1.28 + 1.98) / 2 - 0.02, 0.79, 0, 0);
  b.deform = (v) => {
    const tumble = 1 - 0.08 * THREE.MathUtils.smoothstep(v.y, 0.95, 1.7);
    const taperZ = 1 - 0.07 * THREE.MathUtils.smoothstep(Math.abs(v.z), hl - 0.45, hl + 0.1);
    v.x *= tumble * taperZ;
  };
  for (const s of [-1, 1]) {
    const sx = s * (W / 2 - 0.085);
    b.add('glass', box(0.03, 0.52, 0.82), sx, 1.28, -hl + 2.42); // front door window
    b.add('glass', box(0.03, 0.46, 2.0), sx, 1.27, 0.55); // long rear window
    b.add('velvet', box(0.035, 0.12, 2.0), sx * 1.002, 1.46, 0.55); // valance
    for (const z of [-0.38, 1.48]) b.add('velvet', box(0.04, 0.44, 0.2), sx * 1.003, 1.25, z); // tied-back drapes
    b.add('darkTrim', box(0.04, 0.62, 1.05), sx * 1.004, 1.33, hl - 0.68); // padded landau panel
    const landau = new THREE.TorusGeometry(0.2, 0.018, 4, 12, Math.PI * 1.1).rotateY(Q);
    b.add('steel', landau, sx * 1.01, 1.28, hl - 0.66, Math.PI * 0.5, 0, 0);
    b.add('steel', box(0.02, 0.025, 4.6), s * (W / 2 - 0.005), 0.95, 0.05); // beltline chrome
    b.add('steel', box(0.02, 0.03, 0.15), s * (W / 2 + 0.01), 0.86, -hl + 2.4); // handle
    b.add('headlight', cyl(0.11, 0.11, 0.05, 14).rotateX(Q), s * 0.62, 0.7, -hl - 0.02);
    b.add('steel', new THREE.TorusGeometry(0.115, 0.018, 4, 14), s * 0.62, 0.7, -hl - 0.03);
    b.add('taillight', box(0.12, 0.3, 0.05), s * (W / 2 - 0.16), 0.72, hl + 0.02);
    b.add('signalAmber', box(0.1, 0.05, 0.04), s * 0.82, 0.5, -hl - 0.03);
    b.add('steel', box(0.02, 0.025, 2.0), s * (W / 2 - 0.12), 1.7, 0.5); // roof rail
  }
  b.add('steel', rbox(W - 0.04, 0.16, 0.16, 0.05), 0, 0.42, -hl + 0.02); // chrome bumpers
  b.add('steel', rbox(W - 0.04, 0.16, 0.16, 0.05), 0, 0.42, hl - 0.02);
  b.add('darkTrim', box(0.9, 0.34, 0.04), 0, 0.68, -hl - 0.02); // tall grille
  for (let i = 0; i < 9; i++) b.add('steel', box(0.02, 0.32, 0.02), -0.4 + i * 0.1, 0.68, -hl - 0.05);
  b.add('steel', strut(v3(0, 0.95, -hl + 0.2), v3(0, 1.0, -hl + 0.32), 0.02, 5)); // mascot
  b.add('glass', box(W - 0.5, 0.48, 0.03), 0, 1.24, hl - 0.04); // rear door glass
  b.add('reflective', box(0.52, 0.12, 0.01), 0, 0.55, hl + 0.06);
  for (const sx of [-1, 1]) for (const z of [fA, rA]) wheel(b, wr, 0.24, sx * (W / 2 - 0.15), wr, z, sx, 6);
  return b.build();
}

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

// ── Class 6: crypts, giant pumpkins, carriages ───────────────────────────────
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

function hauntedCarriage(t: ObjectType): PropParts {
  const [W, H, L] = t.size; // glass-sided funeral coach: coffin inside, plumes, green lanterns, skeleton driver
  const b = new Builder();
  carriageChassis(b, W, L, 0.55, 0.75);
  const bz = 0.55;
  const bl = 2.9;
  const y0 = 1.1;
  const bh = 1.65;
  b.add('carPaint', rbox(1.7, 0.3, bl, 0.05), 0, y0 + 0.15, bz);
  b.add('carPaint', rbox(1.85, 0.16, bl + 0.25, 0.04), 0, y0 + bh + 0.08, bz);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add('carPaint', lathe([[0.07, 0], [0.06, 0.1], [0.05, bh - 0.4], [0.07, bh - 0.3]], 8), sx * 0.8, y0 + 0.3, bz + sz * (bl / 2 - 0.07));
  for (const sx of [-1, 1]) {
    b.add('clearGlass', box(0.02, bh - 0.4, bl - 0.25), sx * 0.8, y0 + 0.3 + (bh - 0.4) / 2, bz);
    b.add('carPaint', box(0.06, 0.08, bl - 0.2), sx * 0.8, y0 + 0.85, bz);
    for (const z of [-0.5, 0.5]) b.add('carPaint', box(0.05, bh - 0.4, 0.06), sx * 0.8, y0 + 0.3 + (bh - 0.4) / 2, bz + z);
    b.add('velvet', box(0.03, 0.18, bl - 0.25), sx * 0.76, y0 + bh - 0.2, bz); // drapes
  }
  b.add('clearGlass', box(1.55, bh - 0.4, 0.02), 0, y0 + 0.3 + (bh - 0.4) / 2, bz + bl / 2 - 0.02);
  b.add('carPaint', box(1.6, bh - 0.4, 0.04), 0, y0 + 0.3 + (bh - 0.4) / 2, bz - bl / 2 + 0.03);
  b.add('velvet', box(1.5, 0.06, bl - 0.3), 0, y0 + 0.32, bz);
  b.add('wood', planSlab(coffinPlan(0.32, 1.05), y0 + 0.35, 0.42, 0.02).translate(0, 0, bz));
  b.add('steel', box(0.05, 0.015, 0.5), 0, y0 + 0.78, bz - 0.15);
  b.add('steel', box(0.22, 0.015, 0.05), 0, y0 + 0.78, bz - 0.3);
  // Roof crest: urn finials and black plumes.
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const x = sx * 0.8;
      const z = bz + sz * (bl / 2);
      b.add('darkTrim', lathe([[0.001, 0], [0.09, 0.05], [0.1, 0.15], [0.05, 0.22], [0.001, 0.24]], 8), x, y0 + bh + 0.16, z);
      for (let k = 0; k < 4; k++) b.add('darkTrim', spike(v3(x, y0 + bh + 0.38, z), v3(x + Math.cos(k * 1.6) * 0.1, H - 0.05 - (k % 2) * 0.1, z + Math.sin(k * 1.6) * 0.1), 0.06, 5));
    }
  // Driver's box with a skeleton coachman and green lanterns.
  const fz = bz - bl / 2 - 0.45;
  b.add('wood', box(1.2, 0.1, 0.55), 0, 1.92, fz + 0.05);
  b.add('carPaint', box(1.2, 0.8, 0.06), 0, 1.55, fz + 0.32);
  b.add('wood', box(1.0, 0.06, 0.45), 0, 1.2, fz - 0.32, -0.5, 0, 0);
  skeletonParts(b, 0, 1.0, fz + 0.12, true);
  for (const s of [-1, 1]) {
    b.add('darkTrim', strut(v3(s * 0.75, 1.5, fz + 0.32), v3(s * 0.75, 2.15, fz + 0.32), 0.025, 5));
    b.add('darkTrim', box(0.2, 0.04, 0.2), s * 0.75, 2.18, fz + 0.32);
    b.add('ghostGlow', box(0.14, 0.22, 0.14), s * 0.75, 2.31, fz + 0.32);
    b.add('darkTrim', new THREE.ConeGeometry(0.15, 0.14, 4).rotateY(Math.PI / 4), s * 0.75, 2.49, fz + 0.32);
  }
  return b.build();
}

// ── Class 7–8: haunted buildings ─────────────────────────────────────────────
interface Face {
  len: number;
  at: (u: number, out: number) => [number, number];
  ry: number;
}

/** The four faces of an axis-aligned block: local +X runs along the face, front = outward. */
function blockFaces(x0: number, x1: number, z0: number, z1: number): { front: Face; back: Face; left: Face; right: Face } {
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  return {
    front: { len: x1 - x0, at: (u, o) => [cx + u, z0 - o], ry: 0 },
    back: { len: x1 - x0, at: (u, o) => [cx - u, z1 + o], ry: Math.PI },
    left: { len: z1 - z0, at: (u, o) => [x0 - o, cz - u], ry: Q },
    right: { len: z1 - z0, at: (u, o) => [x1 + o, cz + u], ry: -Q },
  };
}

type WinKind = 'lit' | 'dark' | 'boarded' | 'ghost';

/** Deterministic per-window pick so every instance of a building type looks the same. */
function hashKind(i: number, litBias = 0.5): WinKind {
  const r = Math.abs(Math.sin(i * 12.9898 + 78.233) * 43758.5453) % 1;
  if (r < litBias) return 'lit';
  if (r < litBias + 0.22) return 'dark';
  if (r < 0.97) return 'boarded';
  return 'ghost';
}

/** Victorian sash window: glowing or dark pane, ivory trim, muntins, maybe boarded or a shutter askew. */
function sashWindow(b: Builder, f: Face, u: number, y: number, w: number, h: number, kind: WinKind, i: number): void {
  const put = (role: Role, g: THREE.BufferGeometry, uu: number, yy: number, out: number, rz = 0) => {
    const [x, z] = f.at(uu, out);
    b.add(role, g, x, yy, z, 0, f.ry, rz);
  };
  const pane: Role = kind === 'lit' ? 'windowGlow' : kind === 'ghost' ? 'ghostGlow' : 'glass';
  put(pane, box(w, h, 0.04), u, y, 0.05);
  put('bone', box(w + 0.32, 0.18, 0.12), u, y + h / 2 + 0.09, 0.08);
  put('bone', slab(poly([[-(w + 0.4) / 2, 0], [(w + 0.4) / 2, 0], [0, 0.26]]), 0.1), u, y + h / 2 + 0.18, 0.1);
  put('bone', box(w + 0.24, 0.08, 0.2), u, y - h / 2 - 0.04, 0.1);
  for (const s of [-1, 1]) put('bone', box(0.09, h, 0.08), u + s * (w / 2 + 0.045), y, 0.06);
  put('darkTrim', box(0.04, h, 0.03), u, y, 0.085);
  put('darkTrim', box(w, 0.04, 0.03), u, y + 0.05, 0.085);
  if (kind === 'boarded') {
    put('wood', box(w + 0.16, 0.16, 0.03), u, y + h * 0.18, 0.12, 0.32);
    put('wood', box(w + 0.16, 0.16, 0.03), u, y - h * 0.15, 0.125, -0.28);
    put('wood', box(w + 0.1, 0.14, 0.03), u, y - h * 0.38, 0.13, 0.05);
  } else if (i % 5 === 2) {
    put('darkTrim', box(w * 0.5, h, 0.04), u - w * 0.78, y - 0.12, 0.1, 0.18); // shutter hanging off one hinge
  }
}

/** Gable end triangle of base `span` and height `rise`, as a wall slab facing ±Z. */
function gable(span: number, rise: number, depth: number): THREE.BufferGeometry {
  return slab(poly([[-span / 2, 0], [span / 2, 0], [0, rise]]), depth);
}

/** Roof cresting: an iron rail with spikes along a ridge (along X, centred). */
function cresting(b: Builder, len: number, x: number, y: number, z: number, ry = 0): void {
  b.add('darkTrim', box(len, 0.05, 0.05), x, y + 0.12, z, 0, ry, 0);
  const n = Math.floor(len / 0.4);
  for (let i = 0; i <= n; i++) {
    const u = -len / 2 + (i * len) / n;
    const px = x + Math.cos(ry) * u;
    const pz = z - Math.sin(ry) * u;
    b.add('darkTrim', new THREE.ConeGeometry(0.035, i % 2 ? 0.28 : 0.42, 4), px, y + (i % 2 ? 0.14 : 0.21), pz);
  }
}

function hauntedHouse(t: ObjectType): PropParts {
  const [, H] = t.size; // 11 × 14 × 10: crooked Victorian with cross gable, turret, porch, cresting
  const b = new Builder();
  const wall: Role = 'concreteProp';
  const plinth = 0.7;
  const eave = plinth + 3.3 + 3.2;
  // Main body, front wing, turret.
  const main = { x0: -4.6, x1: 3.4, z0: -3.0, z1: 5.0 };
  const wing = { x0: -5.5, x1: -1.3, z0: -5.0, z1: -3.0 };
  b.add('stone', box(main.x1 - main.x0 + 0.2, plinth, main.z1 - main.z0 + 0.2), (main.x0 + main.x1) / 2, plinth / 2, (main.z0 + main.z1) / 2);
  b.add('stone', box(wing.x1 - wing.x0 + 0.2, plinth, wing.z1 - wing.z0 + 0.2), (wing.x0 + wing.x1) / 2, plinth / 2, (wing.z0 + wing.z1) / 2 - 0.1);
  b.add(wall, box(main.x1 - main.x0, eave - plinth, main.z1 - main.z0), (main.x0 + main.x1) / 2, (eave + plinth) / 2, (main.z0 + main.z1) / 2);
  b.add(wall, box(wing.x1 - wing.x0, eave - plinth, wing.z1 - wing.z0 + 0.1), (wing.x0 + wing.x1) / 2, (eave + plinth) / 2, (wing.z0 + wing.z1) / 2 - 0.05);
  const tx = 4.25;
  const tz = -3.55;
  const tr = 1.22;
  const tTop = 9.2;
  b.add('stone', cyl(tr + 0.1, tr + 0.1, plinth, 16), tx, plinth / 2, tz);
  b.add(wall, cyl(tr, tr, tTop - plinth, 16), tx, (tTop + plinth) / 2, tz);
  // Lap siding: thin boards on every face of body and wing (windows sit proud of them).
  const siding = (fs: Face[]) => {
    for (const f of fs)
      for (let y = plinth + 0.3; y < eave - 0.3; y += 0.34) {
        const [x, z] = f.at(0, 0.012);
        b.add(wall, box(f.len + 0.02, 0.06, 0.024), x, y, z, 0, f.ry, 0);
      }
  };
  const mf = blockFaces(main.x0, main.x1, main.z0, main.z1);
  const wf = blockFaces(wing.x0, wing.x1, wing.z0, wing.z1);
  siding([mf.back, mf.left, mf.right, wf.front, wf.left, { len: 4.3, at: (u, o) => [0.85 + u, main.z0 - o], ry: 0 }]);
  for (let y = 1.2; y < tTop - 0.3; y += 0.68) b.add(wall, new THREE.TorusGeometry(tr + 0.01, 0.025, 3, 16).rotateX(Q), tx, y, tz);
  // Corner boards and frieze.
  for (const [x, z] of [[main.x0, main.z1], [main.x1, main.z1], [main.x0, main.z0], [wing.x0, wing.z0], [wing.x1, wing.z0], [wing.x0, wing.z1]] as const) b.add('bone', box(0.18, eave - plinth, 0.18), x, (eave + plinth) / 2, z);
  for (const f of [mf.back, mf.left, mf.right, wf.front]) {
    const [x, z] = f.at(0, 0.06);
    b.add('bone', box(f.len + 0.2, 0.3, 0.1), x, eave - 0.2, z, 0, f.ry, 0);
    const [x2, z2] = f.at(0, 0.06);
    b.add('bone', box(f.len + 0.2, 0.12, 0.12), x2, plinth + 3.3, z2, 0, f.ry, 0); // floor band
  }
  // Windows.
  let wi = 0;
  const g0 = plinth + 1.75;
  const g1 = plinth + 3.3 + 1.6;
  const win = (f: Face, u: number, y: number, w = 0.95, h = 1.8) => sashWindow(b, f, u, y, w, h, hashKind(wi++ + 3), wi);
  win(wf.front, 0, g0, 1.3, 1.9);
  win(wf.front, 0, g1);
  win(wf.left, 0, g0);
  win(wf.left, 0, g1);
  win(mf.front, 2.7, g1);
  win(mf.front, 0.3, g1);
  win(mf.front, 3.0, g0, 0.9, 1.7);
  for (const u of [-2.4, 0, 2.4]) {
    win(mf.back, u, g0);
    win(mf.back, u, g1);
  }
  for (const u of [-2.2, 1.2]) {
    win(mf.left, u - 0.4, g0);
    win(mf.left, u - 0.4, g1);
    win(mf.right, u, g0);
    win(mf.right, u, g1);
  }
  // Turret windows on three sides and a band of glow at the top.
  for (const a of [-0.4, 0.5, 1.5]) {
    for (const y of [g0, g1, 8.2]) {
      const k = hashKind(wi++ + 11, 0.6);
      const role: Role = k === 'lit' ? 'windowGlow' : k === 'ghost' ? 'ghostGlow' : 'glass';
      const x = tx + Math.sin(a) * (tr + 0.02);
      const z = tz - Math.cos(a) * (tr + 0.02);
      b.add(role, box(0.7, y > 8 ? 0.8 : 1.6, 0.05), x, y, z, 0, -a, 0);
      b.add('bone', box(0.86, 0.1, 0.14), tx + Math.sin(a) * (tr + 0.06), y - (y > 8 ? 0.45 : 0.85), tz - Math.cos(a) * (tr + 0.06), 0, -a, 0);
      b.add('bone', box(0.86, 0.12, 0.1), tx + Math.sin(a) * (tr + 0.05), y + (y > 8 ? 0.46 : 0.86), tz - Math.cos(a) * (tr + 0.05), 0, -a, 0);
    }
  }
  b.add('bone', cyl(tr + 0.12, tr + 0.12, 0.3, 16), tx, tTop - 0.15, tz);
  // Roofs: main gable (ridge along X), wing gable (ridge along Z), conical turret roof, porch shed.
  const mainHalf = (main.z1 - main.z0) / 2 + 0.45;
  const mainRise = H - 1.1 - eave;
  const mz = (main.z0 + main.z1) / 2;
  const mx = (main.x0 + main.x1) / 2;
  const mAng = Math.atan2(mainRise, mainHalf);
  for (const s of [-1, 1]) b.add('shingle', box(main.x1 - main.x0 + 0.7, 0.2, Math.hypot(mainHalf, mainRise)), mx, eave + mainRise / 2, mz + (s * mainHalf) / 2, s * mAng, 0, 0);
  for (const s of [-1, 1]) {
    const gx = s < 0 ? main.x0 : main.x1;
    b.add(wall, gable(main.z1 - main.z0, mainRise - 0.15, 0.3), gx - s * 0.15, eave, mz, 0, Q, 0);
    for (const k of [-1, 1]) b.add('bone', box(0.12, 0.3, Math.hypot(mainHalf, mainRise)), gx + s * 0.2, eave + mainRise / 2 - 0.05, mz + (k * mainHalf) / 2, k * mAng, 0, 0); // bargeboards
    const k = s < 0 ? 'witchGlow' : 'ghostGlow';
    b.add(k, cyl(0.42, 0.42, 0.06, 16).rotateZ(Q), gx + s * 0.16, eave + 1.9, mz);
    b.add('bone', new THREE.TorusGeometry(0.46, 0.07, 5, 16).rotateY(Q), gx + s * 0.19, eave + 1.9, mz);
  }
  b.add('darkTrim', box(main.x1 - main.x0 + 0.8, 0.12, 0.3), mx, eave + mainRise + 0.05, mz);
  cresting(b, main.x1 - main.x0 - 0.4, mx, eave + mainRise + 0.1, mz);
  const wHalf = (wing.x1 - wing.x0) / 2 + 0.4;
  const wRise = 3.9;
  const wx = (wing.x0 + wing.x1) / 2;
  const wAng = Math.atan2(wRise, wHalf);
  const wLen = wing.z1 - wing.z0 + 2.2;
  const wzc = wing.z0 + wLen / 2 - 0.4;
  for (const s of [-1, 1]) b.add('shingle', box(Math.hypot(wHalf, wRise), 0.2, wLen), wx + (s * wHalf) / 2, eave + wRise / 2, wzc, 0, 0, -s * wAng);
  b.add(wall, gable(wing.x1 - wing.x0, wRise - 0.12, 0.3), wx, eave, wing.z0 + 0.15);
  for (const s of [-1, 1]) b.add('bone', box(Math.hypot(wHalf, wRise), 0.3, 0.12), wx + (s * wHalf) / 2, eave + wRise / 2 - 0.05, wing.z0 - 0.12, 0, 0, -s * wAng);
  b.add('bone', box(0.12, 1.2, 0.12), wx, eave + wRise + 0.4, wing.z0 - 0.1); // finial
  b.add('windowGlow', slab(lancet(0.6, 1.1), 0.06), wx, eave + 1.0, wing.z0 - 0.02);
  b.add('bone', slab(lancet(0.84, 1.3), 0.05), wx, eave + 0.92, wing.z0 + 0.01);
  b.add('shingle', new THREE.ConeGeometry(tr + 0.38, H - 0.4 - tTop, 16), tx, tTop + (H - 0.4 - tTop) / 2, tz);
  b.add('steel', cyl(0.025, 0.05, 0.7, 6), tx, H - 0.38, tz);
  b.add('steel', new THREE.SphereGeometry(0.08, 8, 6), tx, H - 0.5, tz);
  // Porch: deck, turned posts, shed roof, rail, steps; front door with a lit transom.
  const px0 = -1.3;
  const px1 = tx - tr;
  const pz0 = -4.4;
  const pcx = (px0 + px1) / 2;
  b.add('wood', box(px1 - px0, 0.14, main.z0 - pz0), pcx, plinth - 0.07, (pz0 + main.z0) / 2);
  for (const x of [px0 + 0.15, pcx - 0.5, pcx + 0.5, px1 - 0.1]) b.add('bone', lathe([[0.1, 0], [0.08, 0.2], [0.06, 0.4], [0.075, 1.4], [0.055, 2.4], [0.09, 2.6]], 8), x, plinth, pz0 + 0.12);
  b.add('shingle', box(px1 - px0 + 0.4, 0.14, main.z0 - pz0 + 0.6), pcx, plinth + 2.95, (pz0 + main.z0) / 2 - 0.2, -0.28, 0, 0);
  b.add('bone', box(px1 - px0 + 0.3, 0.22, 0.1), pcx, plinth + 2.66, pz0 + 0.1);
  for (const [x0, x1] of [[px0, pcx - 0.6], [pcx + 0.6, px1]] as const) {
    b.add('bone', box(x1 - x0, 0.06, 0.08), (x0 + x1) / 2, plinth + 0.9, pz0 + 0.12);
    for (let x = x0 + 0.12; x < x1 - 0.05; x += 0.16) b.add('bone', box(0.035, 0.8, 0.035), x, plinth + 0.45, pz0 + 0.12);
  }
  for (let i = 0; i < 3; i++) b.add('stone', box(1.3, (plinth / 4) * (i + 1), 0.6 - 0.2 * i), pcx, (plinth / 8) * (i + 1), -5.0 + 0.2 * i + (0.6 - 0.2 * i) / 2);
  const dx = pcx;
  b.add('darkTrim', box(1.1, 2.3, 0.08), dx, plinth + 1.15, main.z0 - 0.04);
  b.add('windowGlow', box(1.1, 0.35, 0.05), dx, plinth + 2.55, main.z0 - 0.03);
  b.add('bone', box(1.4, 0.14, 0.12), dx, plinth + 2.8, main.z0 - 0.06);
  for (const s of [-1, 1]) b.add('bone', box(0.12, 2.9, 0.1), dx + s * 0.62, plinth + 1.45, main.z0 - 0.05);
  // Porch pumpkins on the steps and deck.
  for (const [x, y, z, r] of [[pcx - 0.75, plinth, pz0 + 0.35, 0.24], [pcx + 0.75, plinth, pz0 + 0.35, 0.2], [pcx + 0.5, 0.18, pz0 - 0.35, 0.17]] as const) {
    b.add('pumpkin', pumpkinGeo(r, r * 1.5, 8, 0.12, 12, 7), x, y, z);
    carveFace(b, r, r * 1.5, y, 'pumpkinGlow', 0.9);
    void x;
  }
  // Chimneys: one leans.
  b.add('stone', box(0.9, 4.2, 0.8), -2.4, H - 2.0 - 0.1, 2.2, 0, 0, 0.07);
  b.add('stone', box(1.1, 0.25, 1.0), -2.4 - 0.14, H - 0.15, 2.2, 0, 0, 0.07);
  b.add('stone', box(0.8, 3.0, 0.7), 2.4, eave + mainRise - 1.0, 3.2);
  b.add('stone', box(1.0, 0.2, 0.9), 2.4, eave + mainRise + 0.5, 3.2);
  // Crooked: the whole house leans and its ridge sags a little.
  b.deform = (v) => {
    v.x += 0.016 * Math.max(0, v.y - plinth);
    v.y -= 0.18 * THREE.MathUtils.smoothstep(v.y, eave, H) * Math.cos((v.x / 5.5) * Q);
  };
  return b.build();
}

function hauntedManor(t: ObjectType): PropParts {
  const [W, H, D] = t.size; // 17 × 24 × 14 Gothic manor: corner turrets with copper spires, lancets, rose window
  const b = new Builder();
  const wall: Role = 'propBrick';
  const base = 1.0;
  const groundH = 4.0;
  const floorH = 3.4;
  const floors = 3;
  const eave = base + groundH + floors * floorH;
  const x0 = -6.2;
  const x1 = 6.2;
  const z0 = -6.0;
  const z1 = D / 2;
  b.add('stone', box(x1 - x0 + 0.3, base, z1 - z0 + 0.3), 0, base / 2, (z0 + z1) / 2);
  b.add(wall, box(x1 - x0, eave - base, z1 - z0), 0, (eave + base) / 2, (z0 + z1) / 2);
  const F = blockFaces(x0, x1, z0, z1);
  // String courses at each floor and a corbelled cornice.
  for (const f of [F.front, F.back, F.left, F.right]) {
    for (let k = 0; k <= floors; k++) {
      const [x, z] = f.at(0, 0.08);
      b.add('stone', box(f.len + 0.16, 0.18, 0.16), x, base + groundH + k * floorH - (k === floors ? 0.2 : 0), z, 0, f.ry, 0);
    }
    const [x, z] = f.at(0, 0.2);
    b.add('stone', box(f.len + 0.4, 0.35, 0.4), x, eave + 0.05, z, 0, f.ry, 0);
  }
  // Lancet windows.
  let wi = 0;
  const lancetWin = (f: Face, u: number, y: number, w: number, h: number, kind: WinKind) => {
    const pane: Role = kind === 'lit' ? 'windowGlow' : kind === 'ghost' ? 'ghostGlow' : 'glass';
    const put = (role: Role, g: THREE.BufferGeometry, out: number, yy = y) => {
      const [x, z] = f.at(u, out);
      b.add(role, g, x, yy, z, 0, f.ry, 0);
    };
    put(pane, slab(lancet(w, h), 0.05, 0, 3), 0.04);
    put('stone', slab(lancet(w + 0.3, h + 0.2), 0.06, 0, 3), 0.01, y - 0.06);
    put('stone', box(w + 0.4, 0.1, 0.22), 0.1, y - 0.08);
    put('darkTrim', box(0.05, h * 0.86, 0.03), 0.075, y + h * 0.43);
    put('darkTrim', box(w, 0.05, 0.03), 0.075, y + h * 0.42);
    if (kind === 'boarded') {
      put('wood', box(w + 0.1, 0.16, 0.03).rotateZ(0.35), 0.1, y + h * 0.35);
      put('wood', box(w + 0.1, 0.16, 0.03).rotateZ(-0.3), 0.105, y + h * 0.6);
    }
  };
  const winRow = (f: Face, us: number[], skip: (u: number, k: number) => boolean = () => false) => {
    for (let k = 0; k < floors + 1; k++) {
      const y = k === 0 ? base + 0.9 : base + groundH + (k - 1) * floorH + 0.75;
      const h = k === 0 ? 2.5 : 2.2;
      for (const u of us) if (!skip(u, k)) lancetWin(f, u, y, 1.0, h, hashKind(wi++ + 21, 0.45));
    }
  };
  winRow(F.front, [-3.25, 3.25]);
  winRow(F.back, [-4.8, -2.4, 0, 2.4, 4.8]);
  winRow(F.left, [-3.2, -0.4, 2.4, 5.0], (u) => u > 2.5);
  winRow(F.right, [-5.0, -2.4, 0.4, 3.2], (u) => u < -2.5);
  // Central front gable: projecting bay with the entrance, a balcony and a violet rose window.
  const gw = 4.8;
  const gz = z0 - 0.6;
  b.add(wall, box(gw, eave - base, 0.6), 0, (eave + base) / 2, z0 - 0.3);
  b.add('stone', box(gw + 0.3, base, 0.9), 0, base / 2, z0 - 0.3);
  const gRise = 6.8;
  b.add(wall, gable(gw + 0.2, gRise, 0.6), 0, eave, z0 - 0.3);
  const gAng = Math.atan2(gRise, gw / 2 + 0.5);
  const gSlope = Math.hypot(gw / 2 + 0.5, gRise);
  for (const s of [-1, 1]) {
    b.add('shingle', box(gSlope, 0.24, 5.0), (s * (gw / 2 + 0.5)) / 2, eave + gRise / 2, z0 + 1.6, 0, 0, -s * gAng);
    b.add('stone', box(gSlope, 0.32, 0.2), (s * (gw / 2 + 0.5)) / 2, eave + gRise / 2 + 0.05, gz - 0.06, 0, 0, -s * gAng);
  }
  b.add('stone', box(0.25, 1.6, 0.25), 0, eave + gRise + 0.5, gz);
  b.add('witchGlow', cyl(1.05, 1.05, 0.06, 24).rotateX(Q), 0, eave + 2.4, gz - 0.01);
  b.add('stone', new THREE.TorusGeometry(1.15, 0.13, 6, 24), 0, eave + 2.4, gz - 0.04);
  b.add('stone', new THREE.TorusGeometry(0.4, 0.07, 6, 16), 0, eave + 2.4, gz - 0.05);
  for (let i = 0; i < 8; i++) b.add('stone', box(0.07, 0.7, 0.06), Math.cos((i / 8) * Math.PI * 2) * 0.76, eave + 2.4 + Math.sin((i / 8) * Math.PI * 2) * 0.76, gz - 0.05, 0, 0, (i / 8) * Math.PI * 2 + Q);
  const gf: Face = { len: gw, at: (u, o) => [u, gz - o], ry: 0 };
  for (let k = 1; k <= floors; k++) for (const u of [-1.2, 1.2]) lancetWin(gf, u, base + groundH + (k - 1) * floorH + 0.75, 0.9, 2.2, hashKind(wi++ + 5, 0.55));
  // Entrance: pointed door, lit fanlight, stone surround, steps, lanterns, balcony over it.
  b.add('stone', slab(lancet(2.6, 3.9), 0.3, 0, 6), 0, base, gz - 0.1);
  b.add('darkTrim', slab(lancet(1.9, 3.4), 0.2, 0, 6), 0, base, gz - 0.2);
  b.add('windowGlow', slab(lancet(1.5, 0.9), 0.04, 0, 6).translate(0, 2.4, 0), 0, base, gz - 0.31);
  for (let i = 0; i < 3; i++) b.add('stone', box(3.2, (base / 3) * (i + 1), 0.4 - 0.1 * i), 0, (base / 6) * (i + 1), -D / 2 + 0.1 * i + (0.4 - 0.1 * i) / 2);
  for (const s of [-1, 1]) {
    b.add('darkTrim', box(0.26, 0.38, 0.26), s * 1.7, base + 2.6, gz - 0.25);
    b.add('windowGlow', box(0.18, 0.28, 0.18), s * 1.7, base + 2.6, gz - 0.25);
    b.add('darkTrim', new THREE.ConeGeometry(0.2, 0.25, 4).rotateY(Math.PI / 4), s * 1.7, base + 2.92, gz - 0.25);
  }
  b.add('stone', box(3.4, 0.2, 0.9), 0, base + groundH + 0.1, gz - 0.4);
  b.add('darkTrim', box(3.4, 0.9, 0.04), 0, base + groundH + 0.65, gz - 0.83);
  for (const s of [-1, 1]) b.add('darkTrim', box(0.04, 0.9, 0.85), s * 1.68, base + groundH + 0.65, gz - 0.4);
  // Main roof: steep slate, ridge along X, cresting; two tall chimney stacks.
  const half = (z1 - z0) / 2 + 0.5;
  const rise = H - 0.7 - eave;
  const zc = (z0 + z1) / 2;
  const ang = Math.atan2(rise, half);
  for (const s of [-1, 1]) b.add('shingle', box(x1 - x0 + 0.6, 0.24, Math.hypot(half, rise)), 0, eave + rise / 2, zc + (s * half) / 2, s * ang, 0, 0);
  for (const s of [-1, 1]) b.add(wall, gable(z1 - z0, rise - 0.2, 0.4), s * (x1 - 0.2), eave, zc, 0, Q, 0);
  b.add('darkTrim', box(x1 - x0 + 0.6, 0.16, 0.36), 0, eave + rise + 0.05, zc);
  cresting(b, x1 - x0 - 0.6, 0, eave + rise + 0.1, zc);
  for (const s of [-1, 1]) {
    b.add('stone', box(1.2, 5.0, 0.9), s * 3.6, H - 2.6, zc + 2.0);
    b.add('stone', box(1.4, 0.25, 1.1), s * 3.6, H - 0.2, zc + 2.0);
    for (const k of [-1, 1]) b.add('propBrick', cyl(0.13, 0.13, 0.55, 6), s * 3.6 + k * 0.3, H + 0.15, zc + 2.0);
  }
  // Dormers on the back slope.
  for (const dxp of [-3.6, 0, 3.6]) {
    const dzp = z1 - 1.6;
    const dy = eave + 1.6;
    b.add(wall, box(1.5, 1.9, 1.6), dxp, dy, dzp - 0.4);
    b.add(wall, gable(1.5, 1.0, 0.2), dxp, dy + 0.95, dzp + 0.38);
    for (const k of [-1, 1]) b.add('shingle', box(1.15, 0.12, 2.0), dxp + k * 0.42, dy + 1.4, dzp - 0.4, 0, 0, -k * 0.85);
    lancetWin({ len: 1.5, at: (u, o) => [dxp - u, dzp + 0.38 + o], ry: Math.PI }, 0, dy - 0.7, 0.75, 1.4, dxp < 0 ? 'lit' : dxp > 0 ? 'ghost' : 'dark');
  }
  // Corner turrets: octagonal, battered, copper spires and finials.
  const tr = 2.2;
  const tTop = 17.0;
  for (const s of [-1, 1]) {
    const tx = s * (W / 2 - tr - 0.05);
    const tz = -D / 2 + tr + 0.05;
    b.add('stone', new THREE.CylinderGeometry(tr + 0.2, tr + 0.25, base, 8), tx, base / 2, tz);
    b.add(wall, new THREE.CylinderGeometry(tr, tr + 0.08, tTop - base, 8), tx, (tTop + base) / 2, tz);
    for (let k = 0; k <= floors; k++) b.add('stone', new THREE.CylinderGeometry(tr + 0.1, tr + 0.1, 0.2, 8), tx, base + groundH + k * floorH - (k === floors ? 0.2 : 0), tz);
    b.add('stone', new THREE.CylinderGeometry(tr + 0.35, tr + 0.1, 0.6, 8), tx, tTop - 0.3, tz); // corbelled top
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      b.add('stone', box(0.5, 0.5, 0.3), tx + Math.cos(a) * (tr + 0.25), tTop + 0.25, tz + Math.sin(a) * (tr + 0.25), 0, -a + Q, 0); // merlons
    }
    b.add('copper', new THREE.ConeGeometry(tr + 0.15, H - 1.0 - tTop, 8), tx, tTop + (H - 1.0 - tTop) / 2, tz);
    b.add('steel', cyl(0.03, 0.07, 1.0, 6), tx, H - 0.5, tz);
    b.add('steel', new THREE.SphereGeometry(0.1, 8, 6), tx, H - 0.7, tz);
    for (let k = 0; k <= floors; k++) {
      const y = k === 0 ? base + 1.0 : base + groundH + (k - 1) * floorH + 0.8;
      for (const ar of [Math.PI, Math.PI - s * Q * 0.5, Math.PI - s * Q]) {
        const kind = hashKind(wi++ + 41, 0.5);
        const pane: Role = kind === 'lit' ? 'windowGlow' : kind === 'ghost' ? 'ghostGlow' : 'glass';
        const ox = Math.sin(ar);
        const oz = Math.cos(ar);
        b.add(pane, slab(lancet(0.75, 1.9), 0.05, 0, 4), tx + ox * (tr * 0.93 + 0.02), y, tz + oz * (tr * 0.93 + 0.02), 0, ar, 0);
        b.add('stone', slab(lancet(1.0, 2.05), 0.05, 0, 4), tx + ox * (tr * 0.93 - 0.01), y - 0.05, tz + oz * (tr * 0.93 - 0.01), 0, ar, 0);
      }
    }
  }
  b.deform = (v) => {
    v.x += 0.006 * v.y;
  };
  return b.build();
}

export const HALLOWEEN_BUILDERS = {
  candy,
  candyCorn,
  lollipop,
  candle,
  bone: boneProp,
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
  candyCart,
  hearse,
  vampireCoffin,
  vampire,
  werewolf,
  giantCauldron,
  crypt,
  giantPumpkin,
  pumpkinCarriage,
  hauntedCarriage,
  bHauntedHouse: hauntedHouse,
  bHauntedManor: hauntedManor,
} satisfies Partial<Record<Shape, Factory>>;
