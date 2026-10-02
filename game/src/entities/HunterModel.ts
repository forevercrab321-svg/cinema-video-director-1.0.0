import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Halloween hunters (docs/halloween-mode.md): three stylised cartoon horror villains that chase
 * the machines in the second half of the Halloween round.
 *
 *   shock    — the electro-shock "director": round face, black side-parted hair, square glasses,
 *              smug grin, white coat over a blue shirt and navy tie, stethoscope, crackling baton.
 *   cannibal — gaunt, slicked-back hair with a widow's peak, heavy-lidded red eyes, white muzzle
 *              mask with a barred grille, orange jumpsuit with a number patch, cuffed hands.
 *   motel    — lanky young man in his mother's clothes: grey curled wig with a bun, smeared
 *              lipstick grin, pink floral dress, mustard cardigan, pearls, raised kitchen knife.
 *
 * Art direction (threejs-aaa-graphics-builder, hero-character recipe): silhouette first (each
 * villain reads by shape and colour block from the top-down gameplay camera), sculpted smooth
 * forms instead of stacked primitives (lathed torsos and skirts, deformed head and jaw shapes),
 * real joints (shoulder / elbow / hip / knee / neck pivots), four-finger cartoon hands, layered
 * costume parts (lapels, collars, pockets, cuffs, seams), expressive faces (eyelids, brows, irises
 * with highlights). Materials: vertex-coloured skin / cloth / gloss / metal classes shared by all
 * hunters, plus a moonlit rim and a little self-light so faces still read in the night scene.
 *
 * Built at a nominal 2.6 m (head ≈ 1/3 of the height) and scaled to `height`. Root origin at the
 * feet; heading 0 faces −Z (heading h faces (−sin h, −cos h)) like PlayerModel; character right = +X.
 * Each rig segment is one mesh with one geometry group per material class.
 */
export type HunterKind = 'shock' | 'cannibal' | 'motel';
export type HunterPose = 'rise' | 'idle' | 'chase' | 'lunge' | 'grab';

const NOMINAL_H = 2.6;

// ───────────────────────────────────────────────────────────── materials ──
type Cls = 'skin' | 'cloth' | 'gloss' | 'metal' | 'glow' | 'floral' | 'badge' | 'patch';
const CLS_ORDER: Cls[] = ['skin', 'cloth', 'gloss', 'metal', 'glow', 'floral', 'badge', 'patch'];

/** Moonlit rim + a little self-light: the villains must read in the night scene. */
function stylise<T extends THREE.MeshStandardMaterial>(m: T, rim: number, self: number): T {
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      {
        float rf = 1.0 - saturate(dot(normal, normalize(vViewPosition)));
        totalEmissiveRadiance += vec3(0.45, 0.55, 0.95) * (rf * rf * rf * ${rim.toFixed(3)}) + diffuseColor.rgb * ${self.toFixed(3)};
      }`,
    );
  };
  m.customProgramCacheKey = () => `hunter-rim-${rim}-${self}`;
  return m;
}

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat?: [number, number]): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) return null;
  draw(g);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  return t;
}

const floralTex = () =>
  canvasTex(
    256,
    256,
    (g) => {
      g.fillStyle = '#e48aa6';
      g.fillRect(0, 0, 256, 256);
      let s = 11;
      const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
      for (let i = 0; i < 26; i++) {
        const x = rnd() * 256;
        const y = rnd() * 256;
        const r = 9 + rnd() * 7;
        g.fillStyle = '#5d9a55';
        g.beginPath();
        g.ellipse(x + r * 1.1, y + r * 0.5, r * 0.8, r * 0.32, 0.7, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = i % 3 === 0 ? '#fff6ea' : i % 3 === 1 ? '#c22e55' : '#ffd0de';
        for (let p = 0; p < 5; p++) {
          const a = (p / 5) * Math.PI * 2 + i;
          g.beginPath();
          g.arc(x + Math.cos(a) * r * 0.55, y + Math.sin(a) * r * 0.55, r * 0.46, 0, Math.PI * 2);
          g.fill();
        }
        g.fillStyle = '#f4c534';
        g.beginPath();
        g.arc(x, y, r * 0.26, 0, Math.PI * 2);
        g.fill();
      }
    },
    [3, 2],
  );

const badgeTex = () =>
  canvasTex(128, 64, (g) => {
    g.fillStyle = '#fbfbf6';
    g.fillRect(0, 0, 128, 64);
    g.fillStyle = '#1f5fbf';
    g.fillRect(0, 0, 128, 16);
    g.fillStyle = '#d42a2a';
    g.fillRect(10, 30, 22, 7);
    g.fillRect(17.5, 23, 7, 21);
    g.fillStyle = '#16181c';
    g.font = 'bold 26px sans-serif';
    g.fillText('院长', 44, 50);
  });

const patchTex = () =>
  canvasTex(128, 64, (g) => {
    g.fillStyle = '#f4f1e8';
    g.fillRect(0, 0, 128, 64);
    g.strokeStyle = '#1b1b1b';
    g.lineWidth = 4;
    g.strokeRect(3, 3, 122, 58);
    g.fillStyle = '#1b1b1b';
    g.font = 'bold 30px monospace';
    g.fillText('1031', 26, 44);
  });

let MATS: Record<Cls, THREE.Material> | null = null;
function mats(): Record<Cls, THREE.Material> {
  return (MATS ??= {
    skin: stylise(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.55, sheen: 0.5, sheenColor: new THREE.Color(0xffc8a8), sheenRoughness: 0.45 }), 0.5, 0.1),
    cloth: stylise(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.82, sheen: 0.35, sheenColor: new THREE.Color(0xffffff), sheenRoughness: 0.7, side: THREE.DoubleSide }), 0.38, 0.07),
    gloss: stylise(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.3, clearcoat: 0.7, clearcoatRoughness: 0.2 }), 0.32, 0.04),
    metal: stylise(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.28, metalness: 0.85 }), 0.3, 0.12),
    glow: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
    floral: stylise(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, map: floralTex(), side: THREE.DoubleSide }), 0.35, 0.08),
    badge: stylise(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, map: badgeTex() }), 0.2, 0.15),
    patch: stylise(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, map: patchTex() }), 0.2, 0.1),
  });
}

interface Paint {
  cls: Cls;
  c: THREE.Color;
}
const P = (cls: Cls, hex: number): Paint => ({ cls, c: new THREE.Color(hex) });
const C = {
  white: P('glow', 0xffffff),
  sclera: P('gloss', 0xfbfaf5),
  pupil: P('gloss', 0x101014),
  lips: P('skin', 0x8f3b35),
  mouth: P('gloss', 0x3a0f12),
  teeth: P('gloss', 0xfffaf0),
  tongue: P('skin', 0xd0565a),
};

// ───────────────────────────────────────────────────────── geometry kit ──
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Primitives in one rig segment's frame → one mesh, one geometry group per material class. */
class Kit {
  private readonly parts = new Map<Cls, THREE.BufferGeometry[]>();
  add(g: THREE.BufferGeometry, p: Paint, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): this {
    const geo = g.index ? g.toNonIndexed() : g;
    if (geo !== g) g.dispose();
    _m.compose(_v.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz, 'XYZ')), _s.set(sx, sy, sz));
    geo.applyMatrix4(_m);
    if (!geo.getAttribute('uv')) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.getAttribute('position').count * 2), 2));
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
    const n = geo.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([p.c.r, p.c.g, p.c.b], i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const list = this.parts.get(p.cls) ?? [];
    list.push(geo);
    this.parts.set(p.cls, list);
    return this;
  }
  build(name: string): THREE.Mesh {
    const geos: THREE.BufferGeometry[] = [];
    const ms: THREE.Material[] = [];
    for (const cls of CLS_ORDER) {
      const list = this.parts.get(cls);
      if (!list?.length) continue;
      geos.push(list.length === 1 ? list[0] : mergeGeometries(list, false)!);
      ms.push(mats()[cls]);
    }
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, true)!;
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, ms.length === 1 ? ms[0] : ms);
    mesh.name = name;
    mesh.castShadow = true;
    return mesh;
  }
}

const ell = (rx: number, ry: number, rz: number, w = 28, h = 20) => new THREE.SphereGeometry(1, w, h).scale(rx, ry, rz);
const lathe = (pts: [number, number][], seg = 28, phiStart = 0, phiLen = Math.PI * 2) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(Math.max(0, r), y)), seg, phiStart, phiLen);
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt: number, rb: number, h: number, seg = 16) => new THREE.CylinderGeometry(rt, rb, h, seg);
const tube = (pts: [number, number, number][], r: number, seg = 24, rs = 8) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p))), seg, r, rs);
/** Tapered limb hanging from the origin along −Y: rounded top r0, rounded bottom r1, length len. */
function limb(r0: number, r1: number, len: number, seg = 18): THREE.BufferGeometry {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    pts.push([Math.sin(a) * r1, -len + r1 - Math.cos(a) * r1]);
  }
  for (let i = 6; i >= 0; i--) {
    const a = (i / 6) * (Math.PI / 2);
    pts.push([Math.sin(a) * r0, -r0 + Math.cos(a) * r0 + 0]);
  }
  return lathe(pts, seg);
}
/** Deform a geometry's vertices in place. */
function deform(g: THREE.BufferGeometry, fn: (v: THREE.Vector3) => void): THREE.BufferGeometry {
  const p = g.getAttribute('position');
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    fn(v.fromBufferAttribute(p, i));
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Four-finger cartoon hand around the wrist origin, fingers down (−Y), palm facing −X (inward on the right hand). */
function hand(k: Kit, p: Paint, x: number, y: number, z: number, mirror: number, curl = 0.5, grip = false): void {
  k.add(ell(0.055, 0.065, 0.075, 18, 14), p, x, y - 0.06, z);
  for (let i = 0; i < 3; i++) {
    const fz = z - 0.045 + i * 0.045;
    k.add(limb(0.022, 0.019, grip ? 0.06 : 0.085, 10), p, x - mirror * 0.01, y - 0.1, fz, 0, 0, mirror * curl);
  }
  k.add(limb(0.024, 0.02, 0.07, 10), p, x - mirror * 0.04, y - 0.05, z - 0.06, -0.6, 0, mirror * (grip ? 1.1 : 0.7)); // thumb
}

/** Point on the head ellipsoid (centre at the origin): yaw 0 = front (−Z), +yaw → +X; pitch up. */
function onHead(r: [number, number, number], yaw: number, pitch: number, inset = 0): [number, number, number] {
  const cp = Math.cos(pitch);
  return [(r[0] - inset) * Math.sin(yaw) * cp, (r[1] - inset) * Math.sin(pitch), -(r[2] - inset) * Math.cos(yaw) * cp];
}

// ──────────────────────────────────────────────────────────────── specs ──
interface Spec {
  hipY: number;
  hipX: number;
  thigh: number;
  shin: number;
  legR: number;
  torso: [number, number][];
  flat: number;
  torsoW: number;
  shoulderY: number;
  shoulderX: number;
  upper: number;
  fore: number;
  armR: number;
  neckY: number;
  head: [number, number, number];
  headY: number;
  skin: Paint;
}

const TORSO_STD: [number, number][] = [
  [0, -0.16], [0.22, -0.15], [0.29, -0.06], [0.3, 0.12], [0.3, 0.3], [0.32, 0.46], [0.34, 0.58], [0.31, 0.68], [0.2, 0.76], [0.1, 0.79], [0, 0.8],
];
const SPEC: Record<HunterKind, Spec> = {
  shock: { hipY: 0.95, hipX: 0.15, thigh: 0.45, shin: 0.4, legR: 0.12, torso: TORSO_STD.map(([r, y]) => [r * (y < 0.4 ? 1.08 : 1), y]), flat: 0.8, torsoW: 1.05, shoulderY: 0.66, shoulderX: 0.37, upper: 0.33, fore: 0.29, armR: 0.085, neckY: 0.78, head: [0.4, 0.4, 0.38], headY: 0.38, skin: P('skin', 0xf0c49c) },
  cannibal: { hipY: 1.0, hipX: 0.15, thigh: 0.48, shin: 0.42, legR: 0.115, torso: TORSO_STD, flat: 0.76, torsoW: 1.0, shoulderY: 0.66, shoulderX: 0.37, upper: 0.34, fore: 0.3, armR: 0.085, neckY: 0.78, head: [0.34, 0.42, 0.36], headY: 0.4, skin: P('skin', 0xe8c1a6) },
  motel: { hipY: 1.0, hipX: 0.12, thigh: 0.48, shin: 0.43, legR: 0.09, torso: TORSO_STD.map(([r, y]) => [r * 0.84, y]), flat: 0.78, torsoW: 0.9, shoulderY: 0.64, shoulderX: 0.31, upper: 0.35, fore: 0.31, armR: 0.068, neckY: 0.8, head: [0.33, 0.41, 0.34], headY: 0.42, skin: P('skin', 0xf2cdb0) },
};

/** Front (−Z) surface of the lathed torso at (x, y). */
function torsoZ(s: Spec, x: number, y: number): number {
  let r = s.torso[0][0];
  for (let i = 1; i < s.torso.length; i++) {
    const [r1, y1] = s.torso[i];
    const [r0, y0] = s.torso[i - 1];
    if (y <= y1) {
      r = r0 + ((r1 - r0) * (y - y0)) / (y1 - y0 || 1);
      break;
    }
  }
  const R = r * s.torsoW;
  return -s.flat * Math.sqrt(Math.max(0, R * R - x * x)) * (s.torsoW > 0 ? 1 / s.torsoW : 1) * s.torsoW;
}

// ───────────────────────────────────────────────────────── face kit ──
interface FaceOpts {
  iris: Paint;
  eyeY: number;
  eyeX: number;
  eyeSize: number;
  lid: number; // 0 wide open … 1 half closed
  brow: Paint;
  browAngle: number; // + = angry (inner ends down)
  browY: number;
  grin: 'smug' | 'wide' | 'none';
  lipstick?: boolean;
  glowIris?: boolean;
}

function buildFace(k: Kit, s: Spec, o: FaceOpts): void {
  const r = s.head;
  // Ears and nose.
  for (const sx of [-1, 1]) k.add(ell(0.05, 0.085, 0.035, 14, 10), s.skin, sx * r[0] * 0.97, -0.02, 0.02, 0, sx * 0.3, 0);
  const nose = onHead(r, 0, -0.08, -0.02);
  k.add(ell(0.05, 0.045, 0.05, 16, 12), s.skin, nose[0], nose[1], nose[2]);
  // Eyes: sclera, iris, pupil, two highlights, upper lid.
  for (const sx of [-1, 1]) {
    const yaw = sx * o.eyeX;
    const [x, y, z] = onHead(r, yaw, o.eyeY, 0.035);
    const e = o.eyeSize;
    k.add(ell(e * 0.85, e, e * 0.6, 20, 16), C.sclera, x, y, z, 0, yaw, 0);
    const front = (d: number): [number, number, number] => [x + Math.sin(yaw) * d, y, z - Math.cos(yaw) * d];
    const [ix, iy, iz] = front(e * 0.5);
    k.add(ell(e * 0.5, e * 0.55, e * 0.18, 16, 12), o.glowIris ? P('glow', o.iris.c.getHex()) : o.iris, ix - sx * e * 0.08, iy - e * 0.08, iz, 0, yaw, 0);
    const [px, py, pz] = front(e * 0.6);
    k.add(ell(e * 0.26, e * 0.3, e * 0.1, 12, 10), C.pupil, px - sx * e * 0.08, py - e * 0.08, pz, 0, yaw, 0);
    const [hx, hy, hz] = front(e * 0.66);
    k.add(ell(e * 0.11, e * 0.11, e * 0.05, 8, 6), C.white, hx + e * 0.12, hy + e * 0.12, hz, 0, yaw, 0);
    k.add(ell(e * 0.05, e * 0.05, e * 0.03, 6, 5), C.white, hx - e * 0.12, hy - e * 0.2, hz, 0, yaw, 0);
    // Upper lid: a skin shell over the top of the eye, rotated down by `lid`.
    const lidG = new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.5).scale(e * 0.93, e * 1.08, e * 0.7);
    k.add(lidG, s.skin, x, y, z, 0.75 - o.lid * 0.95, yaw, sx * o.browAngle * 0.35);
    // Brow: a thick curved stroke over the eye.
    const by = o.eyeY + o.browY;
    const b0 = onHead(r, yaw - sx * 0.2, by - sx * 0 + o.browAngle * 0.08, -0.012);
    const b1 = onHead(r, yaw, by + 0.03, -0.018);
    const b2 = onHead(r, yaw + sx * 0.2, by - o.browAngle * 0.1, -0.012);
    k.add(tube([b0, b1, b2], 0.022, 12, 6), o.brow);
  }
  // Mouth.
  if (o.grin !== 'none') {
    const wide = o.grin === 'wide';
    const w = wide ? 0.42 : 0.3;
    const pts: [number, number, number][] = [];
    const ptsLow: [number, number, number][] = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8 - 0.5;
      const yaw = t * w * 1.6;
      const up = (wide ? 0.07 : 0.05) * (4 * t * t) - 0.02;
      pts.push(onHead(r, yaw, -0.38 + up, -0.004));
      ptsLow.push(onHead(r, yaw * 0.92, -0.38 + up - (wide ? 0.11 : 0.06) * (1 - 4 * t * t), -0.004));
    }
    // Mouth opening (dark), teeth band, lip line.
    const mo = onHead(r, 0, -0.42, 0.02);
    k.add(ell(w * 0.36, wide ? 0.06 : 0.035, 0.03, 18, 10), C.mouth, mo[0], mo[1], mo[2] - 0.005);
    const tt = onHead(r, 0, -0.39, 0.0);
    k.add(ell(w * 0.3, wide ? 0.026 : 0.018, 0.022, 16, 8), C.teeth, tt[0], tt[1], tt[2] - 0.012);
    k.add(tube(pts, o.lipstick ? 0.016 : 0.011, 16, 6), o.lipstick ? P('skin', 0xc8202e) : C.lips);
    k.add(tube(ptsLow, o.lipstick ? 0.016 : 0.009, 16, 6), o.lipstick ? P('skin', 0xc8202e) : C.lips);
  }
}

// ──────────────────────────────────────────────────────── per character ──
interface Parts {
  pelvis: Kit;
  torso: Kit;
  head: Kit;
  upperL: Kit;
  upperR: Kit;
  foreL: Kit;
  foreR: Kit;
  thighL: Kit;
  thighR: Kit;
  shinL: Kit;
  shinR: Kit;
}

function common(s: Spec, cloth: { top: Paint; sleeve: Paint; leg: Paint; shoe: Paint; cuff?: Paint }): Parts {
  const p: Parts = { pelvis: new Kit(), torso: new Kit(), head: new Kit(), upperL: new Kit(), upperR: new Kit(), foreL: new Kit(), foreR: new Kit(), thighL: new Kit(), thighR: new Kit(), shinL: new Kit(), shinR: new Kit() };
  p.torso.add(lathe(s.torso, 32), cloth.top, 0, 0, 0, 0, 0, 0, s.torsoW, 1, s.flat);
  p.torso.add(cyl(0.085, 0.1, 0.12, 14), s.skin, 0, s.neckY + 0.02, 0); // neck
  for (const [kit, fk, sx] of [[p.upperL, p.foreL, -1], [p.upperR, p.foreR, 1]] as const) {
    kit.add(ell(s.armR * 1.18, s.armR * 1.12, s.armR * 1.15, 18, 14), cloth.sleeve, 0, -0.03, 0); // shoulder cap
    fk.add(ell(s.armR * 1.0, s.armR * 1.0, s.armR * 1.0, 14, 10), cloth.sleeve, 0, 0, 0); // elbow
    kit.add(limb(s.armR * 1.05, s.armR * 0.95, s.upper + 0.04), cloth.sleeve, 0, 0, 0);
    fk.add(limb(s.armR * 0.95, s.armR * 0.85, s.fore), cloth.sleeve, 0, 0, 0);
    fk.add(cyl(s.armR * 0.98, s.armR * 1.0, 0.05, 16), cloth.cuff ?? cloth.sleeve, 0, -s.fore + 0.06, 0);
    hand(fk, s.skin, 0, -s.fore + 0.02, 0, sx);
  }
  for (const [tk, sk] of [[p.thighL, p.shinL], [p.thighR, p.shinR]] as const) {
    tk.add(limb(s.legR, s.legR * 0.88, s.thigh + 0.04), cloth.leg, 0, 0.02, 0);
    sk.add(limb(s.legR * 0.88, s.legR * 0.8, s.shin), cloth.leg, 0, 0, 0);
    // Shoe: rounded toe box, sole, heel.
    const ankle = -s.shin + 0.02;
    sk.add(ell(s.legR * 1.05, 0.075, 0.17, 18, 12), cloth.shoe, 0, ankle - 0.045, -0.06);
    sk.add(box(s.legR * 2.0, 0.035, 0.31), P('gloss', 0x141416), 0, ankle - 0.1, -0.05);
  }
  p.pelvis.add(ell(0.3 * s.torsoW, 0.16, 0.3 * s.flat, 24, 14), cloth.leg, 0, -0.08, 0);
  return p;
}

function buildShock(s: Spec): Parts {
  const coat = P('cloth', 0xf6f7f8);
  const coatShade = P('cloth', 0xd9dfe6);
  const shirt = P('cloth', 0x9cc4ea);
  const tie = P('gloss', 0x1b2a52);
  const trousers = P('cloth', 0x343842);
  const p = common(s, { top: coat, sleeve: coat, leg: trousers, shoe: P('gloss', 0x17171a), cuff: coatShade });
  const r = s.head;
  // Coat: open-front tails over the hips to the knee, lapels, shirt V, tie, pockets, buttons.
  p.pelvis.add(lathe([[0.31, 0.02], [0.34, -0.2], [0.38, -0.42], [0.4, -0.52]], 32, Math.PI + 0.32, Math.PI * 2 - 0.64), coat, 0, 0, 0, 0, 0, 0, 1.05, 1, 0.84);
  p.pelvis.add(lathe([[0.4, -0.52], [0.405, -0.535]], 32, Math.PI + 0.32, Math.PI * 2 - 0.64), coatShade, 0, 0, 0, 0, 0, 0, 1.05, 1, 0.84); // hem
  for (const sx of [-1, 1]) p.pelvis.add(box(0.15, 0.13, 0.02), coatShade, sx * 0.22, -0.2, -0.29, 0.08, sx * 0.35, 0); // pockets
  const front = -0.3 * s.flat;
  p.torso.add(new THREE.ShapeGeometry(new THREE.Shape([new THREE.Vector2(-0.13, 0.36), new THREE.Vector2(0.13, 0.36), new THREE.Vector2(0, 0.08)])).rotateY(Math.PI), shirt, 0, 0.36, front - 0.035);
  p.torso.add(new THREE.ExtrudeGeometry(new THREE.Shape([new THREE.Vector2(-0.035, 0), new THREE.Vector2(0.035, 0), new THREE.Vector2(0.05, -0.24), new THREE.Vector2(0, -0.3), new THREE.Vector2(-0.05, -0.24)]), { depth: 0.012, bevelEnabled: false }).rotateY(Math.PI), tie, 0, 0.68, front - 0.04);
  p.torso.add(ell(0.045, 0.035, 0.03, 12, 8), tie, 0, 0.69, front - 0.04); // knot
  for (const sx of [-1, 1]) {
    // Lapel: a long folded wedge from the collar down to the top button.
    const lap = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(sx * 0.13, 0.02), new THREE.Vector2(sx * 0.17, -0.12), new THREE.Vector2(sx * 0.03, -0.36)]);
    if (sx > 0) lap.curves.reverse();
    p.torso.add(new THREE.ExtrudeGeometry(lap, { depth: 0.02, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 2 }), coat, sx * 0.02, 0.72, front - 0.03, -0.12, 0, 0);
    p.torso.add(tube([[sx * 0.11, 0.73, front + 0.04], [sx * 0.15, 0.78, 0.02], [sx * 0.09, 0.79, 0.12]], 0.025, 10, 6), coatShade); // collar roll
  }
  for (let i = 0; i < 3; i++) p.torso.add(cyl(0.022, 0.022, 0.012, 12), P('gloss', 0x2a2d33), 0.04, 0.32 - i * 0.14, front - 0.02, Math.PI / 2, 0, 0);
  p.torso.add(new THREE.PlaneGeometry(0.17, 0.085), P('badge', 0xffffff), -0.17, 0.5, torsoZ(s, -0.17, 0.5) - 0.012, 0, Math.PI - 0.6, 0); // badge (wearer's left)
  p.torso.add(box(0.15, 0.12, 0.015), coatShade, 0.17, 0.48, torsoZ(s, 0.17, 0.48) - 0.006, 0, 0.6, 0); // breast pocket
  p.torso.add(cyl(0.012, 0.012, 0.13, 8), P('gloss', 0x1f5fbf), 0.15, 0.56, torsoZ(s, 0.15, 0.56) - 0.015); // pen
  // Stethoscope around the neck, chest piece on the right.
  p.torso.add(tube([[-0.16, 0.5, front + 0.02], [-0.15, 0.7, -0.08], [0, 0.79, 0.12], [0.15, 0.7, -0.08], [0.16, 0.5, front + 0.02]], 0.014, 28, 6), P('gloss', 0x2b2e35));
  p.torso.add(cyl(0.04, 0.04, 0.02, 16), P('metal', 0xc9d0d8), 0.16, 0.47, front + 0.01, Math.PI / 2, 0, 0);
  // Head: round, full cheeks, double chin.
  p.head.add(deform(ell(r[0], r[1], r[2], 40, 30), (v) => {
    const low = smooth(0.0, -0.36, v.y);
    v.x *= 1 + 0.12 * low; // jowls
    v.z *= 1 + 0.05 * low;
  }), s.skin, 0, 0, 0);
  for (const sx of [-1, 1]) p.head.add(ell(0.07, 0.05, 0.03, 12, 8), P('skin', 0xf2a99a), sx * 0.2, -0.17, -0.31, 0, sx * 0.5, 0); // ruddy cheeks
  buildFace(p.head, s, { iris: P('gloss', 0x3b2414), eyeY: 0.05, eyeX: 0.3, eyeSize: 0.075, lid: 0.35, brow: P('gloss', 0x141418), browAngle: -0.2, browY: 0.2, grin: 'smug' });
  // Hair: black helmet with a side part and a swept fringe; short sides.
  const hairM = P('cloth', 0x1a1b20);
  p.head.add(new THREE.SphereGeometry(1, 40, 18, 0, Math.PI * 2, 0, 1.15).scale(r[0] * 1.06, r[1] * 1.07, r[2] * 1.07), hairM, 0, 0.01, 0.01);
  p.head.add(new THREE.SphereGeometry(1, 32, 16, -0.45, Math.PI + 0.9, 1.0, 0.85).scale(r[0] * 1.05, r[1] * 1.05, r[2] * 1.06), hairM, 0, 0, 0.01);
  p.head.add(deform(ell(0.26, 0.07, 0.12, 24, 12), (v) => {
    v.y += 0.05 * (v.x / 0.26); // swept up to the right
  }), hairM, 0.05, 0.27, -0.25, -0.55, 0, -0.1);
  p.head.add(box(0.012, 0.012, 0.26), P('skin', 0xd9a882), -0.15, 0.37, -0.08, 0.6, 0, 0.3); // side part
  // Square black glasses on the nose, temples back to the ears.
  for (const sx of [-1, 1]) {
    const [x, y, z] = onHead(r, sx * 0.3, 0.05, -0.04);
    const fr = new THREE.Shape();
    fr.moveTo(-0.1, -0.075);
    fr.lineTo(0.1, -0.075);
    fr.lineTo(0.1, 0.075);
    fr.lineTo(-0.1, 0.075);
    fr.closePath();
    const hole = new THREE.Path();
    hole.moveTo(-0.08, -0.058);
    hole.lineTo(-0.08, 0.058);
    hole.lineTo(0.08, 0.058);
    hole.lineTo(0.08, -0.058);
    hole.closePath();
    fr.holes.push(hole);
    p.head.add(new THREE.ExtrudeGeometry(fr, { depth: 0.02, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 2 }), P('gloss', 0x0d0d10), x, y, z - 0.02, 0, sx * 0.25, 0);
    p.head.add(tube([[sx * 0.2, y + 0.05, z + 0.03], [sx * 0.37, y + 0.04, -0.05], [sx * 0.38, y - 0.02, 0.1]], 0.012, 10, 5), P('gloss', 0x0d0d10));
  }
  p.head.add(tube([[-0.08, 0.1, onHead(r, 0, 0.08, -0.05)[2]], [0, 0.085, onHead(r, 0, 0.06, -0.06)[2]], [0.08, 0.1, onHead(r, 0, 0.08, -0.05)[2]]], 0.012, 8, 5), P('gloss', 0x0d0d10));
  // Electro-shock baton in the right fist (along the forearm, beyond the hand).
  const fy = -s.fore - 0.08;
  p.foreR.add(cyl(0.032, 0.036, 0.16, 14), P('gloss', 0x1d2026), 0, fy - 0.02, -0.02);
  p.foreR.add(cyl(0.022, 0.026, 0.36, 14), P('metal', 0x9aa3ad), 0, fy - 0.27, -0.02);
  for (let i = 0; i < 3; i++) p.foreR.add(cyl(0.03, 0.03, 0.02, 14), P('gloss', 0xf2c200), 0, fy - 0.14 - i * 0.1, -0.02);
  p.foreR.add(ell(0.035, 0.05, 0.035, 14, 10), P('glow', 0xbfe8ff), 0, fy - 0.47, -0.02);
  return p;
}

function buildCannibal(s: Spec): Parts {
  const suit = P('cloth', 0xf0661c);
  const suitDark = P('cloth', 0xc44f10);
  const p = common(s, { top: suit, sleeve: suit, leg: suit, shoe: P('cloth', 0xf3f2ee), cuff: suitDark });
  const r = s.head;
  const front = -0.3 * s.flat;
  // Jumpsuit details: V collar, placket and press studs, chest pocket, number patches, belt seam, rolled cuffs.
  for (const sx of [-1, 1]) {
    const col = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(sx * 0.16, 0.03), new THREE.Vector2(sx * 0.14, -0.1), new THREE.Vector2(0, -0.24)]);
    if (sx > 0) col.curves.reverse();
    p.torso.add(new THREE.ExtrudeGeometry(col, { depth: 0.02, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 2 }), suitDark, sx * 0.01, 0.76, front - 0.02, -0.18, 0, 0);
  }
  p.torso.add(box(0.035, 0.54, 0.02), suitDark, 0, 0.26, front - 0.03);
  for (let i = 0; i < 4; i++) p.torso.add(cyl(0.012, 0.012, 0.01, 8), P('metal', 0xd0d4d8), 0, 0.46 - i * 0.13, front - 0.042, Math.PI / 2, 0, 0);
  p.torso.add(new THREE.PlaneGeometry(0.16, 0.08), P('patch', 0xffffff), -0.17, 0.5, torsoZ(s, -0.17, 0.5) - 0.012, 0, Math.PI - 0.6, 0);
  p.torso.add(new THREE.PlaneGeometry(0.34, 0.17), P('patch', 0xffffff), 0, 0.46, 0.3 * s.flat + 0.025, 0, 0, 0); // back
  p.pelvis.add(cyl(0.33, 0.33, 0.06, 28), suitDark, 0, 0.02, 0, 0, 0, 0, 1, 1, s.flat);
  // Head: long and gaunt, hollow cheeks, strong jaw.
  p.head.add(deform(ell(r[0], r[1], r[2], 40, 30), (v) => {
    const mid = Math.exp(-(((v.y + 0.08) / 0.12) ** 2));
    v.x *= 1 - 0.1 * mid; // hollow cheeks
    const jaw = smooth(-0.2, -0.4, v.y);
    v.x *= 1 + 0.08 * jaw;
  }), s.skin, 0, 0, 0);
  buildFace(p.head, s, { iris: P('glow', 0xd01a32), glowIris: true, eyeY: 0.08, eyeX: 0.29, eyeSize: 0.068, lid: 0.7, brow: P('gloss', 0x3a2e28), browAngle: 0.5, browY: 0.16, grin: 'none' });
  // Slicked-back hair with a widow's peak, greying temples.
  const hair = P('cloth', 0x3a2c24);
  p.head.add(new THREE.SphereGeometry(1, 40, 16, -0.6, Math.PI + 1.2, 0, 1.75).scale(r[0] * 1.05, r[1] * 1.05, r[2] * 1.06), hair, 0, 0.01, 0.015);
  p.head.add(new THREE.SphereGeometry(1, 40, 12, 0, Math.PI * 2, 0, 0.98).scale(r[0] * 1.06, r[1] * 1.06, r[2] * 1.07), hair, 0, 0.012, 0);
  // Widow's peak: the slicked hair dips to a point mid-forehead.
  p.head.add(deform(new THREE.SphereGeometry(1, 24, 10, Math.PI * 1.25, Math.PI * 0.5, 0.5, 0.55).scale(r[0] * 1.05, r[1] * 1.05, r[2] * 1.06), (v) => {
    const off = Math.abs(v.x) / (r[0] * 0.5);
    if (v.y < r[1] * 0.75) v.y += Math.min(0.12, off * 0.12);
  }), hair, 0, 0.012, 0);
  // Muzzle mask: cream face plate over mouth and jaw, barred grille, straps round the head.
  const mask = P('gloss', 0xf1ebdc);
  p.head.add(new THREE.SphereGeometry(1, 36, 14, Math.PI + 0.55, Math.PI - 1.1, 1.75, 0.95).scale(r[0] * 1.08, r[1] * 1.04, r[2] * 1.1), mask, 0, 0, 0);
  const g = onHead(r, 0, -0.42, -0.05);
  p.head.add(ell(0.13, 0.075, 0.03, 20, 10), P('gloss', 0x16100e), g[0], g[1], g[2] + 0.005);
  for (let i = -3; i <= 3; i++) p.head.add(cyl(0.008, 0.008, 0.15, 8), P('metal', 0xbfc6cc), g[0] + i * 0.034, g[1], g[2] - 0.022);
  p.head.add(box(0.27, 0.016, 0.02), P('metal', 0xbfc6cc), g[0], g[1] + 0.075, g[2] - 0.02);
  p.head.add(box(0.27, 0.016, 0.02), P('metal', 0xbfc6cc), g[0], g[1] - 0.075, g[2] - 0.02);
  const strap = P('gloss', 0x4a2e1a);
  // Straps: from the mask's sides round the back of the head, and one over the crown.
  const sy = -0.2;
  const sk = Math.sqrt(1 - (sy / r[1]) ** 2) * 1.04;
  p.head.add(new THREE.TorusGeometry(1, 0.022, 6, 40, Math.PI * 1.1).rotateX(Math.PI / 2).rotateY(-Math.PI * 0.05).scale(r[0] * sk, 1, r[2] * sk), strap, 0, sy, 0);
  p.head.add(new THREE.TorusGeometry(1, 0.02, 6, 40, Math.PI * 0.62).rotateZ(Math.PI * 0.19).scale(r[0] * 1.05, r[1] * 1.05, 1), strap, 0, 0, 0.1, 0, Math.PI / 2, 0);
  for (const sx of [-1, 1]) p.head.add(cyl(0.028, 0.028, 0.02, 12), P('metal', 0xd2d6da), sx * r[0] * sk, sy, -0.06, 0, 0, Math.PI / 2);
  // Handcuffs on both wrists; the chain hangs from the right one across to the left.
  for (const fk of [p.foreL, p.foreR]) fk.add(new THREE.TorusGeometry(s.armR * 0.95, 0.014, 8, 20).rotateX(Math.PI / 2), P('metal', 0xc7cdd3), 0, -s.fore + 0.07, 0);
  for (let i = 0; i < 5; i++) p.foreR.add(new THREE.TorusGeometry(0.022, 0.007, 6, 10), P('metal', 0xc7cdd3), -0.03 - i * 0.04, -s.fore + 0.06 - Math.sin((i / 4) * Math.PI) * 0.04, 0, 0, i % 2 ? Math.PI / 2 : 0, 0);
  return p;
}

function buildMotel(s: Spec): Parts {
  const cardigan = P('cloth', 0xb48a3c);
  const cardiganDark = P('cloth', 0x8d6a2b);
  const dress = P('floral', 0xffffff);
  const p = common(s, { top: dress, sleeve: cardigan, leg: P('skin', 0xd9b8a0), shoe: P('gloss', 0x5a3320), cuff: cardiganDark });
  const r = s.head;
  // Dress: bell skirt from the waist to below the knee, scalloped hem; cardigan open over it.
  p.pelvis.add(lathe([[0.25, 0.05], [0.31, -0.12], [0.42, -0.42], [0.5, -0.6], [0.49, -0.62]], 36), dress, 0, 0, 0, 0, 0, 0, 1, 1, 0.92);
  p.pelvis.add(new THREE.TorusGeometry(0.495, 0.018, 6, 48).rotateX(Math.PI / 2).scale(1, 1, 0.92), P('cloth', 0xfff2f4), 0, -0.6, 0);
  p.torso.add(lathe(s.torso.map(([rr, y]): [number, number] => [rr * 1.08, y]).filter(([, y]) => y > -0.06 && y < 0.74), 32, Math.PI + 0.42, Math.PI * 2 - 0.84), cardigan, 0, 0, 0, 0, 0, 0, s.torsoW, 1, s.flat * 1.05);
  for (const sx of [-1, 1]) {
    const edge: [number, number, number][] = [];
    for (let i = 0; i <= 6; i++) {
      const y = -0.04 + i * 0.12;
      const rr = (s.torso.find(([, yy]) => yy >= y)?.[0] ?? 0.25) * 1.08 * s.torsoW;
      edge.push([sx * Math.sin(0.42) * rr, y, -Math.cos(0.42) * rr * s.flat * 1.05]);
    }
    p.torso.add(tube(edge, 0.018, 16, 6), cardiganDark);
    for (let i = 0; i < 3; i++) p.torso.add(ell(0.018, 0.018, 0.01, 8, 6), P('gloss', 0x4a3420), edge[1 + i * 2][0], edge[1 + i * 2][1], edge[1 + i * 2][2] - 0.012);
  }
  p.torso.add(lathe([[0.2, 0.0], [0.21, 0.02], [0.2, 0.04]], 32), P('cloth', 0xfff2f4), 0, 0.73, 0, 0, 0, 0, 1, 1, 0.9); // lace collar
  // Pearls.
  for (let i = 0; i <= 14; i++) {
    const a = Math.PI + (i / 14 - 0.5) * 2.4;
    p.torso.add(ell(0.018, 0.018, 0.018, 8, 6), P('gloss', 0xf8f2e6), Math.sin(a) * 0.16, 0.72 - Math.cos((i / 14 - 0.5) * Math.PI) * 0.06, Math.cos(a) * 0.15);
  }
  // Head: narrow, long neck, wide-eyed, smeared lipstick grin.
  p.head.add(deform(ell(r[0], r[1], r[2], 40, 30), (v) => {
    v.x *= 1 - 0.1 * smooth(-0.1, -0.4, v.y); // narrow chin
  }), s.skin, 0, 0, 0);
  for (const sx of [-1, 1]) p.head.add(ell(0.06, 0.04, 0.02, 12, 8), P('skin', 0xee8f9a), sx * 0.19, -0.16, -0.27, 0, sx * 0.55, 0); // rouge
  buildFace(p.head, s, { iris: P('gloss', 0x3d6aa8), eyeY: 0.07, eyeX: 0.29, eyeSize: 0.085, lid: 0.0, brow: P('gloss', 0x5a4636), browAngle: -0.35, browY: 0.24, grin: 'wide', lipstick: true });
  // Wig: grey curled helmet, bun on top, curls round the sides and back.
  const wig = P('cloth', 0xbfc0c8);
  const wigDark = P('cloth', 0x9fa1ab);
  p.head.add(new THREE.SphereGeometry(1, 40, 18, -0.55, Math.PI + 1.1, 0, 1.9).scale(r[0] * 1.12, r[1] * 1.1, r[2] * 1.12), wig, 0, 0.02, 0.02);
  p.head.add(new THREE.SphereGeometry(1, 40, 10, 0, Math.PI * 2, 0, 0.95).scale(r[0] * 1.13, r[1] * 1.1, r[2] * 1.13), wig, 0, 0.025, 0);
  p.head.add(ell(0.17, 0.15, 0.16, 24, 18), wigDark, 0, r[1] + 0.07, 0.08);
  p.head.add(new THREE.TorusGeometry(0.15, 0.03, 8, 24).rotateX(Math.PI / 2), wig, 0, r[1] + 0.02, 0.08);
  for (let i = 0; i < 16; i++) {
    const b = (i / 15 - 0.5) * 3.9; // 0 = back of the head, ±1.95 = just behind the ears
    const ry = i % 2 ? -0.08 : 0.08;
    p.head.add(ell(0.08, 0.075, 0.08, 12, 10), i % 3 ? wig : wigDark, Math.sin(b) * r[0] * 1.1, ry, Math.cos(b) * r[2] * 1.1);
  }
  for (let i = -2; i <= 2; i++) {
    const c = onHead(r, i * 0.32, 0.72 - Math.abs(i) * 0.05, -0.05);
    p.head.add(ell(0.07, 0.06, 0.06, 12, 10), wig, c[0], c[1], c[2]); // forehead curls above the hairline
  }
  // Kitchen knife (stab grip): handle above the fist, long blade down along the forearm.
  const fy = -s.fore - 0.07;
  p.foreR.add(box(0.04, 0.16, 0.05), P('gloss', 0x3b2416), 0, fy - 0.08, -0.05);
  p.foreR.add(box(0.06, 0.02, 0.09), P('metal', 0xb8c0c8), 0, fy + 0.005, -0.075); // bolster
  const blade = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0.085, 0), new THREE.Vector2(0.08, 0.36), new THREE.Vector2(0.0, 0.52)]);
  p.foreR.add(new THREE.ExtrudeGeometry(blade, { depth: 0.008, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.004, bevelSegments: 1 }), P('metal', 0xe6ecf2), -0.004, fy + 0.0, -0.11, 0, Math.PI / 2, 0);
  return p;
}

// ──────────────────────────────────────────────────────────────── poses ──
interface PoseT {
  spine: number;
  neck: number;
  tilt: number;
  shL: [number, number];
  shR: [number, number];
  elL: number;
  elR: number;
}
const IDLE: Record<HunterKind, PoseT> = {
  shock: { spine: -0.05, neck: 0.05, tilt: 0, shL: [0.15, -0.18], shR: [0.75, 0.15], elL: 0.35, elR: 0.75 },
  cannibal: { spine: 0.05, neck: -0.12, tilt: 0, shL: [0.45, 0.18], shR: [0.45, -0.18], elL: 1.1, elR: 1.1 },
  motel: { spine: -0.1, neck: 0.05, tilt: 0.22, shL: [0.2, -0.12], shR: [2.7, 0.25], elL: 0.4, elR: 0.7 },
};

const tmpPose: PoseT = { spine: 0, neck: 0, tilt: 0, shL: [0, 0], shR: [0, 0], elL: 0, elR: 0 };

// ──────────────────────────────────────────────────────────────── model ──
export class HunterModel {
  readonly root = new THREE.Group();
  readonly kind: HunterKind;
  private readonly body = new THREE.Group();
  private readonly pelvis = new THREE.Group();
  private readonly spine = new THREE.Group();
  private readonly neck = new THREE.Group();
  private readonly shL = new THREE.Group();
  private readonly shR = new THREE.Group();
  private readonly elL = new THREE.Group();
  private readonly elR = new THREE.Group();
  private readonly hipL = new THREE.Group();
  private readonly hipR = new THREE.Group();
  private readonly knL = new THREE.Group();
  private readonly knR = new THREE.Group();
  private readonly scale: number;
  private phase = 0;
  private time = 0;
  private sparkT = 0;
  private sparks: THREE.LineSegments | null = null;
  private glow: THREE.Sprite | null = null;
  private readonly own: THREE.Material[] = [];

  constructor(kind: HunterKind, height = NOMINAL_H) {
    this.kind = kind;
    this.scale = height / NOMINAL_H;
    const s = SPEC[kind];
    const parts = kind === 'shock' ? buildShock(s) : kind === 'cannibal' ? buildCannibal(s) : buildMotel(s);
    this.root.name = `Hunter_${kind}`;
    this.root.scale.setScalar(this.scale);
    this.root.add(this.body);
    this.body.add(this.pelvis);
    this.pelvis.position.y = s.hipY;
    this.pelvis.add(parts.pelvis.build('pelvis'), this.spine, this.hipL, this.hipR);
    this.spine.add(parts.torso.build('torso'), this.neck, this.shL, this.shR);
    this.neck.position.y = s.neckY;
    const head = parts.head.build('head');
    head.position.y = s.headY;
    this.neck.add(head);
    for (const [sh, el, up, fo, sx] of [[this.shL, this.elL, parts.upperL, parts.foreL, -1], [this.shR, this.elR, parts.upperR, parts.foreR, 1]] as const) {
      sh.position.set(sx * s.shoulderX, s.shoulderY, 0);
      sh.add(up.build('upperArm'), el);
      el.position.y = -s.upper;
      el.add(fo.build('forearm'));
    }
    for (const [hp, kn, th, sh, sx] of [[this.hipL, this.knL, parts.thighL, parts.shinL, -1], [this.hipR, this.knR, parts.thighR, parts.shinR, 1]] as const) {
      hp.position.set(sx * s.hipX, -0.04, 0);
      hp.add(th.build('thigh'), kn);
      kn.position.y = -s.thigh;
      kn.add(sh.build('shin'));
    }
    if (kind === 'shock') this.addSparks(s);
  }

  private addSparks(s: Spec): void {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 6 * 2 * 3), 3));
    const lm = new THREE.LineBasicMaterial({ color: 0xcff2ff, transparent: true, opacity: 0.95, toneMapped: false });
    this.sparks = new THREE.LineSegments(geo, lm);
    this.sparks.frustumCulled = false;
    const c = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    let tex: THREE.Texture | null = null;
    if (c) {
      c.width = c.height = 64;
      const g = c.getContext('2d')!;
      const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'rgba(220,245,255,1)');
      gr.addColorStop(0.35, 'rgba(120,200,255,0.55)');
      gr.addColorStop(1, 'rgba(60,120,255,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, 64, 64);
      tex = new THREE.CanvasTexture(c);
    }
    const sm = new THREE.SpriteMaterial({ map: tex, color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    this.glow = new THREE.Sprite(sm);
    this.glow.scale.setScalar(0.32);
    const tipY = -s.fore - 0.55;
    this.glow.position.set(0, tipY, -0.02);
    this.sparks.position.set(0, tipY, -0.02);
    this.elR.add(this.glow, this.sparks);
    this.own.push(lm, sm);
    if (tex) this.own.push(sm);
  }

  private redrawSparks(): void {
    const sp = this.sparks;
    if (!sp) return;
    const a = sp.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = a.array as Float32Array;
    let o = 0;
    for (let b = 0; b < 3; b++) {
      let x = 0;
      let y = 0;
      let z = 0;
      const dx = (Math.random() - 0.5) * 0.12;
      const dy = -0.05 - Math.random() * 0.06;
      const dz = (Math.random() - 0.5) * 0.12;
      for (let i = 0; i < 6; i++) {
        const nx = x + dx + (Math.random() - 0.5) * 0.06;
        const ny = y + dy * 0.5 + (Math.random() - 0.5) * 0.05;
        const nz = z + dz + (Math.random() - 0.5) * 0.06;
        arr.set([x, y, z, nx, ny, nz], o);
        o += 6;
        x = nx;
        y = ny;
        z = nz;
      }
    }
    a.needsUpdate = true;
  }

  update(dt: number, x: number, z: number, heading: number, speed: number, groundY: number, pose: HunterPose, riseT = 1): void {
    this.time += dt;
    const t = this.time;
    const s = SPEC[this.kind];
    this.root.position.set(x, groundY, z);
    this.root.rotation.y = heading;
    const run = pose === 'chase' || pose === 'lunge' ? Math.min(1, speed / (4.5 * this.scale)) : 0;
    this.phase += ((speed / this.scale) / 1.7) * Math.PI * 2 * dt;
    const ph = this.phase;
    const base = IDLE[this.kind];
    const p = tmpPose;
    p.spine = base.spine - 0.28 * run;
    p.neck = base.neck + 0.15 * run;
    p.tilt = base.tilt;
    p.shL[0] = base.shL[0];
    p.shL[1] = base.shL[1];
    p.shR[0] = base.shR[0];
    p.shR[1] = base.shR[1];
    p.elL = base.elL;
    p.elR = base.elR;
    // Arm swing: free arms pump against the legs; the prop arm and cuffed arms swing a little.
    const swing = Math.sin(ph) * 0.9 * run;
    if (this.kind === 'cannibal') {
      p.shL[0] += Math.abs(swing) * 0.15;
      p.shR[0] += Math.abs(swing) * 0.15;
    } else {
      p.shL[0] += -swing;
      p.elL += 0.8 * run;
      if (this.kind === 'shock') p.shR[0] += swing * 0.25 + 0.25 * run;
      else p.shR[0] += Math.sin(ph * 2) * 0.25 * run - 0.1 * run; // the knife stabs in time
    }
    let legA = 0.75 * run;
    let bodyY = Math.abs(Math.sin(ph)) * 0.07 * run;
    let riseOff = 0;
    if (pose === 'idle') {
      const br = Math.sin(t * 1.8);
      p.spine += br * 0.02;
      p.neck += Math.sin(t * 0.7) * 0.06;
      p.tilt += Math.sin(t * 0.5) * 0.08;
      bodyY += br * 0.008;
    } else if (pose === 'lunge') {
      p.spine = -0.55;
      p.neck = 0.35;
      p.shL = [1.55, -0.1];
      p.shR = this.kind === 'motel' ? [2.9, 0.2] : [1.5, 0.1];
      p.elL = 0.15;
      p.elR = this.kind === 'motel' ? 0.5 : 0.15;
      legA = Math.max(legA, 0.6);
    } else if (pose === 'grab') {
      const j = Math.sin(t * 40) * 0.05;
      p.spine = -0.35;
      p.neck = 0.2;
      p.shL = [1.35 + j, 0.3];
      p.shR = [1.35 - j, -0.3];
      p.elL = 0.55;
      p.elR = 0.55;
      legA = 0;
    } else if (pose === 'rise') {
      const e = riseT * riseT * (3 - 2 * riseT);
      riseOff = -(1 - e) * 1.05 * NOMINAL_H;
      const wob = Math.sin(t * 9) * (1 - e) * 0.2;
      p.spine = -0.25 + wob;
      p.neck = 0.4;
      p.tilt = wob;
      p.shL = [2.7 + Math.sin(t * 7) * 0.3, -0.25];
      p.shR = [2.7 - Math.sin(t * 7) * 0.3, 0.25];
      p.elL = 0.6;
      p.elR = 0.6;
      legA = 0;
    }
    const k = 1 - Math.exp(-14 * dt);
    const ease = (g: THREE.Group, ax: 'x' | 'z', target: number) => (g.rotation[ax] += (target - g.rotation[ax]) * k);
    this.body.position.y += (bodyY + riseOff - this.body.position.y) * (pose === 'rise' ? 1 : k);
    ease(this.spine, 'x', p.spine);
    ease(this.spine, 'z', p.tilt * 0.3);
    this.spine.rotation.y = Math.sin(ph) * 0.15 * run;
    ease(this.neck, 'x', p.neck);
    ease(this.neck, 'z', p.tilt);
    ease(this.shL, 'x', p.shL[0]);
    ease(this.shL, 'z', p.shL[1]);
    ease(this.shR, 'x', p.shR[0]);
    ease(this.shR, 'z', p.shR[1]);
    ease(this.elL, 'x', p.elL);
    ease(this.elR, 'x', p.elR);
    // Legs: thighs swing opposite, knees fold on the back swing.
    const sL = Math.sin(ph);
    const sR = -sL;
    ease(this.hipL, 'x', sL * legA);
    ease(this.hipR, 'x', sR * legA);
    ease(this.knL, 'x', -(0.15 + 1.1 * Math.max(0, -Math.cos(ph))) * (legA > 0 ? run || 0.6 : 0) - (pose === 'grab' ? 0.25 : 0));
    ease(this.knR, 'x', -(0.15 + 1.1 * Math.max(0, Math.cos(ph))) * (legA > 0 ? run || 0.6 : 0) - (pose === 'grab' ? 0.25 : 0));
    void s;
    // Baton: flickering glow and redrawn sparks.
    if (this.glow) {
      (this.glow.material as THREE.SpriteMaterial).opacity = 0.65 + Math.random() * 0.35;
      this.glow.scale.setScalar(0.26 + Math.random() * 0.12);
      this.sparkT -= dt;
      if (this.sparkT <= 0) {
        this.sparkT = 0.045;
        this.redrawSparks();
      }
    }
  }

  setVisible(v: boolean): void {
    this.root.visible = v;
  }

  dispose(): void {
    this.root.parent?.remove(this.root);
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) o.geometry.dispose();
    });
    for (const m of this.own) m.dispose();
  }
}
