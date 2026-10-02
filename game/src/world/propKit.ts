import * as THREE from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Role } from '../art/materials';
import { boxProjectUV } from '../art/uv';

/**
 * Shared prop-authoring kit: the role Builder and geometry primitives used by every prop
 * factory (props.ts street kit, heavyProps.ts site/industrial kit).
 */
export type PropParts = Partial<Record<Role, THREE.BufferGeometry>>;

/** Metre-space UV of a flat lug texel in the 0.3 m tread texture (see art/textures.ts tread()). */
export const BLACK_TEXEL: [number, number] = [0.0175, 0.15];

export const LAMP_COLOURS: Partial<Record<Role, [number, number, number]>> = {
  headlight: [1, 0.95, 0.85],
  taillight: [0.85, 0.06, 0.04],
  signalAmber: [1, 0.55, 0.08],
  // Halloween glows: over-unity colours so carved faces, windows and goo cross the bloom threshold.
  ghostGlow: [0.55, 2.1, 0.4],
  pumpkinGlow: [2.5, 1.05, 0.16],
  windowGlow: [2.1, 1.2, 0.42],
  witchGlow: [1.25, 0.5, 2.3],
};

/** Roles whose texture follows metre-scale box projection. */
export const PROJECTED: ReadonlySet<Role> = new Set<Role>(['paint', 'cardboard', 'propBrick', 'corrugated', 'roofMetal', 'concreteProp', 'timber', 'stone', 'straw', 'shingle']);

export class Builder {
  private readonly parts = new Map<Role, THREE.BufferGeometry[]>();
  private readonly m = new THREE.Matrix4();
  /** Optional whole-model deformation (e.g. car tumblehome) applied to every role at build time. */
  deform: ((v: THREE.Vector3) => void) | null = null;
  /** Roles that get creased smooth normals after deformation (curved body panels). */
  smoothRoles = new Set<Role>();

  add(role: Role, g: THREE.BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): this {
    if (role === 'chrome') role = 'steel'; // small bright-metal trim shares the steel draw call
    if (role === 'rubber' || role === 'darkTrim') {
      // Matte black rubber/plastic shares the tread material (one draw call): pin its UVs to a
      // flat, dark lug texel so it samples a constant colour/roughness with no tread pattern.
      const n = g.getAttribute('position').count;
      const uv = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) uv.set(BLACK_TEXEL, i * 2);
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      role = 'tread';
    }
    this.m.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(1, 1, 1));
    g.applyMatrix4(this.m);
    const list = this.parts.get(role) ?? [];
    list.push(g);
    this.parts.set(role, list);
    return this;
  }

  build(): PropParts {
    const out: PropParts = {};
    const lamps: THREE.BufferGeometry[] = [];
    for (const [role, list] of this.parts) {
      const clean = list.map((g) => {
        const n = g.index ? g.toNonIndexed() : g;
        if (!n.getAttribute('uv')) n.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n.getAttribute('position').count * 2), 2));
        if (!n.getAttribute('normal')) n.computeVertexNormals();
        for (const key of Object.keys(n.attributes)) if (!['position', 'normal', 'uv'].includes(key)) n.deleteAttribute(key);
        return n;
      });
      let merged = mergeGeometries(clean, false);
      if (!merged) throw new Error(`merge failed for role ${role}`);
      if (this.deform) {
        const pos = merged.getAttribute('position');
        const v = new THREE.Vector3();
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i);
          this.deform(v);
          pos.setXYZ(i, v.x, v.y, v.z);
        }
      }
      if (this.smoothRoles.has(role)) merged = toCreasedNormals(merged, THREE.MathUtils.degToRad(40));
      if (LAMP_COLOURS[role]) {
        // Fold head/tail/indicator lamps into the shared 'lamps' role with a per-vertex colour.
        const c = LAMP_COLOURS[role]!;
        const n = merged.getAttribute('position').count;
        const col = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) col.set(c, i * 3);
        merged.setAttribute('color', new THREE.BufferAttribute(col, 3));
        lamps.push(merged);
        continue;
      }
      if (PROJECTED.has(role)) merged = boxProjectUV(merged);
      merged.computeBoundingSphere();
      out[role] = merged;
    }
    if (lamps.length) out.lamps = mergeGeometries(lamps, false)!;
    return out;
  }
}

// ── primitives ───────────────────────────────────────────────────────────────
export const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
export const rbox = (w: number, h: number, d: number, r: number, seg = 2) => new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4));
export const cyl = (rt: number, rb: number, h: number, seg = 16, open = false) => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);
export const lathe = (pts: [number, number][], seg = 24) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);
/** Cylinder between two points. */
export function strut(a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 8): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(b, a);
  const g = cyl(r, r, dir.length(), seg);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}
export const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * Side-profile extrusion: `pts` are (z, y) with forward = −z, extruded across `width` on X,
 * centred. Bevel softens every edge (the single biggest "not a primitive" cue).
 */
export function profile(shape: THREE.Shape, width: number, bevel: number, curveSegments = 10, smooth = false): THREE.BufferGeometry {
  const depth = Math.max(0.001, width - 2 * bevel);
  let g: THREE.BufferGeometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.9, bevelSegments: 3, curveSegments });
  if (smooth) g = smoothWalls(g);
  g.translate(0, 0, -depth / 2);
  g.rotateY(-Math.PI / 2); // shape x (length) → z (front at −z), extrusion depth → x
  return g;
}
/**
 * Smooth-shade the extrusion walls (the curved outline: hood, roof, bevels) while the flat
 * side caps stay flat — smoothing the caps smears their long thin triangles into blotches.
 */
export function smoothWalls(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const src = g.index ? g.toNonIndexed() : g;
  const pick = (groupIndex: number) => {
    const parts = src.groups.filter((gr) => gr.materialIndex === groupIndex);
    const out = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'uv'] as const) {
      const a = src.getAttribute(name);
      const items: number[] = [];
      for (const gr of parts) for (let i = gr.start; i < gr.start + gr.count; i++) for (let k = 0; k < a.itemSize; k++) items.push(a.array[i * a.itemSize + k]);
      out.setAttribute(name, new THREE.Float32BufferAttribute(items, a.itemSize));
    }
    return out;
  };
  const caps = pick(0);
  const walls = toCreasedNormals(pick(1), THREE.MathUtils.degToRad(50));
  return mergeGeometries([caps, walls.index ? walls.toNonIndexed() : walls], false)!;
}

export function poly(pts: [number, number][]): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
  s.closePath();
  return s;
}

/** Tyre tread band with metre-scale UVs (u around the circumference, v across) for the tread texture. */
export function treadBand(r: number, w: number, seg = 16): THREE.BufferGeometry {
  const g = lathe([[r * 0.95, -w * 0.46], [r, -w * 0.34], [r, w * 0.34], [r * 0.95, w * 0.46]], seg);
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2 * Math.PI * r, uv.getY(i) * w);
  g.rotateZ(Math.PI / 2);
  return g;
}
/** Tyre sidewalls (plain rubber), bead to shoulder. */
export function sidewalls(r: number, w: number, seg = 16): THREE.BufferGeometry {
  const g = lathe([[r * 0.6, w * 0.44], [r * 0.95, w * 0.46], [r * 0.95, -w * 0.46], [r * 0.6, -w * 0.44]], seg);
  g.rotateZ(Math.PI / 2);
  return g;
}

/** Road wheel: tyre + rim + hub + spokes. Axle along X. */
export function wheel(b: Builder, r: number, w: number, x: number, y: number, z: number, side: number, spokes = 5, rimRole: Role = 'steel'): void {
  b.add('tread', treadBand(r, w), x, y, z);
  b.add('rubber', sidewalls(r, w), x, y, z);
  // Rim: bright lip ring, dark recessed barrel, spokes from hub to lip.
  b.add(rimRole, lathe([[r * 0.46, w * 0.4], [r * 0.6, w * 0.44], [r * 0.6, -w * 0.44], [r * 0.46, -w * 0.4]], 14).rotateZ(Math.PI / 2), x, y, z);
  b.add('darkTrim', cyl(r * 0.47, r * 0.47, w * 0.6, 12, true).rotateZ(Math.PI / 2), x, y, z);
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2;
    b.add(rimRole, box(0.025, r * 0.36, r * 0.1), x + side * (w * 0.33), y + Math.cos(a) * r * 0.29, z + Math.sin(a) * r * 0.29, a);
  }
  b.add('chrome', cyl(r * 0.13, r * 0.15, w * 0.72, 8).rotateZ(Math.PI / 2), x + side * 0.01, y, z);
}

