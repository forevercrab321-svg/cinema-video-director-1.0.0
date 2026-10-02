import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * 蛋之谷 / "Egg Valley" — the Creative Director's egg girl (reference:
 * references/characters/egg-girl-danzhigu.jpg).
 *
 * Short white-silver bob with bangs and an ahoge, two orange bar clips (her left) and a fried-egg
 * pin (her right), amber eyes with a smug half-lidded look, egg stud earrings, black choker. White
 * collared shirt with a heart pin, yellow tie with a silver clip; cropped orange varsity jacket
 * with oversized cream sleeves, orange cuffs, cream hem stripes, a fried-egg chest patch and snap
 * buttons; brown belt with a gold buckle; blue plaid pleated mini skirt; slouchy orange/cream
 * striped leg warmers; chunky blue platform sneakers with white soles and a white four-point star.
 * Right hand on the hip, left hand holding a round fried-egg backpack (sleepy "≈ ≈" eyes, doodled
 * yolk, orange handle and straps).
 *
 * Art direction (threejs-aaa-graphics-builder, hero-character recipe): sculpted smooth forms —
 * lathed torso / sleeves / pleated skirt / leg warmers, a deformed head with a tapered chin, a hair
 * shell with clump grooves and flipped hem plus ribbon locks for bangs, side locks and the ahoge —
 * and a painted anime face decal (eyes with iris gradient, highlights, lashes, brows, blush, mouth)
 * conforming to the head. Colour blocking cream / orange / blue for night readability, a soft cool
 * rim and a little self-light (same approach as HunterModel).
 *
 * Performance: the whole body is ONE rigidly-skinned SkinnedMesh (14 bones) with one geometry
 * group per material class (8 draw calls); the backpack is a separate mesh (3 draw calls) parented
 * to the left wrist bone; the 'hint' sparkles are one THREE.Points (1 draw call, only when shown).
 *
 * Built at a nominal 2.0 m (head ≈ 1/5.5 of the height) and scaled to `height`. Root origin at the
 * feet; heading 0 faces −Z (heading h faces (−sin h, −cos h)); character right = +X.
 */
export type EggGirlState = 'hidden' | 'hint' | 'reveal' | 'give' | 'gone';

const NOMINAL_H = 2.0;
const GONE_T = 0.8;

// ───────────────────────────────────────────────────────────── materials ──
type Cls = 'skin' | 'cloth' | 'gloss' | 'metal' | 'hair' | 'plaid' | 'stripe' | 'bag' | 'face';
const CLS_ORDER: Cls[] = ['skin', 'cloth', 'gloss', 'metal', 'hair', 'plaid', 'stripe', 'bag', 'face'];

/** Soft cool rim + a little self-light so the colour blocks read at night. */
function stylise<T extends THREE.MeshStandardMaterial>(m: T, rim: number, self: number, key: string): T {
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      {
        float rf = 1.0 - saturate(dot(normal, normalize(vViewPosition)));
        totalEmissiveRadiance += vec3(0.78, 0.84, 1.0) * (rf * rf * rf * ${rim.toFixed(3)}) + diffuseColor.rgb * ${self.toFixed(3)};
      }`,
    );
  };
  m.customProgramCacheKey = () => `egg-${key}-${rim}-${self}`;
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

// Face decal mapping: a patch of the head ellipsoid, yaw ±FACE_W/2 around the front, polar angle
// TH0…TH1 (θ = π/2 − pitch). Canvas x runs screen-left → screen-right as seen from the front.
const FACE_W = 1.6;
const TH0 = 1.12;
const TH1 = 2.45;

function drawEye(g: CanvasRenderingContext2D, cx: number, cy: number, outer: number): void {
  const w = 122;
  const h = 108;
  g.save();
  g.translate(cx, cy);
  g.scale(outer, 1); // +x = towards the outer corner
  const upper = (p: Path2D | CanvasRenderingContext2D) => {
    p.moveTo(-0.46 * w, 0.08 * h);
    p.bezierCurveTo(-0.3 * w, -0.34 * h, 0.22 * w, -0.4 * h, 0.52 * w, -0.2 * h);
  };
  const eye = new Path2D();
  upper(eye);
  eye.bezierCurveTo(0.46 * w, 0.18 * h, 0.22 * w, 0.46 * h, -0.04 * w, 0.45 * h);
  eye.bezierCurveTo(-0.3 * w, 0.43 * h, -0.43 * w, 0.27 * h, -0.46 * w, 0.08 * h);
  g.fillStyle = '#fff8f2';
  g.fill(eye);
  g.save();
  g.clip(eye);
  // Iris: deep amber at the top to bright gold at the bottom, dark rim, pupil, lower glow.
  const ix = 0.04 * w;
  const iy = 0.1 * h;
  const irx = 0.3 * w;
  const iry = 0.47 * h;
  const gr = g.createLinearGradient(0, iy - iry, 0, iy + iry);
  gr.addColorStop(0, '#5e1e08');
  gr.addColorStop(0.42, '#c2520e');
  gr.addColorStop(0.78, '#f39a22');
  gr.addColorStop(1, '#ffd65e');
  g.fillStyle = gr;
  g.beginPath();
  g.ellipse(ix, iy, irx, iry, 0, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = '#4a1606';
  g.stroke();
  g.fillStyle = '#3a0f04';
  g.beginPath();
  g.ellipse(ix, iy - 0.02 * h, 0.12 * w, 0.22 * h, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = 'rgba(255,225,130,0.75)';
  g.beginPath();
  g.ellipse(ix, iy + 0.27 * h, 0.17 * w, 0.1 * h, 0, 0, Math.PI * 2);
  g.fill();
  // Shadow of the upper lid across the top of the eye.
  const sh = g.createLinearGradient(0, -0.45 * h, 0, -0.05 * h);
  sh.addColorStop(0, 'rgba(90,40,30,0.55)');
  sh.addColorStop(1, 'rgba(90,40,30,0)');
  g.fillStyle = sh;
  g.fillRect(-w, -h, 2 * w, h);
  // Highlights.
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.ellipse(ix - 0.11 * w, iy - 0.15 * h, 0.09 * w, 0.12 * h, -0.4, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.ellipse(ix + 0.13 * w, iy + 0.2 * h, 0.04 * w, 0.045 * h, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();
  // Upper lash line with an outer flick, lower lash, lid crease.
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.strokeStyle = '#3b1d14';
  g.lineWidth = 8;
  g.beginPath();
  upper(g);
  g.stroke();
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(0.5 * w, -0.2 * h);
  g.quadraticCurveTo(0.6 * w, -0.24 * h, 0.66 * w, -0.34 * h);
  g.stroke();
  g.lineWidth = 3.5;
  g.beginPath();
  g.moveTo(0.4 * w, -0.3 * h);
  g.quadraticCurveTo(0.5 * w, -0.38 * h, 0.54 * w, -0.47 * h);
  g.stroke();
  g.strokeStyle = '#a5553a';
  g.lineWidth = 2.5;
  g.beginPath();
  g.moveTo(0.44 * w, 0.16 * h);
  g.quadraticCurveTo(0.25 * w, 0.44 * h, 0.0, 0.46 * h);
  g.stroke();
  g.strokeStyle = 'rgba(170,100,90,0.6)';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(-0.24 * w, -0.4 * h);
  g.quadraticCurveTo(0.12 * w, -0.56 * h, 0.42 * w, -0.4 * h);
  g.stroke();
  g.restore();
}

const faceTex = () =>
  canvasTex(512, 512, (g) => {
    const U = (yaw: number) => 256 - yaw * (512 / FACE_W);
    const V = (pitch: number) => ((Math.PI / 2 - pitch - TH0) / (TH1 - TH0)) * 512;
    g.clearRect(0, 0, 512, 512);
    // Blush with little hatch strokes.
    for (const s of [-1, 1]) {
      const bx = U(s * 0.46);
      const by = V(-0.34);
      g.save();
      g.translate(bx, by);
      g.scale(1, 0.45);
      const b = g.createRadialGradient(0, 0, 0, 0, 0, 44);
      b.addColorStop(0, 'rgba(255,120,130,0.55)');
      b.addColorStop(1, 'rgba(255,120,130,0)');
      g.fillStyle = b;
      g.beginPath();
      g.arc(0, 0, 44, 0, Math.PI * 2);
      g.fill();
      g.restore();
      g.strokeStyle = 'rgba(240,100,110,0.75)';
      g.lineWidth = 2.5;
      g.lineCap = 'round';
      for (let i = -1; i <= 1; i++) {
        g.beginPath();
        g.moveTo(bx + i * 12 - 4, by + 6);
        g.lineTo(bx + i * 12 + 4, by - 6);
        g.stroke();
      }
    }
    // Eyes (canvas-left eye is her right: outer corner to the left).
    drawEye(g, U(0.37), V(-0.1), -1);
    drawEye(g, U(-0.37), V(-0.1), 1);
    // Brows: thin, light (silver hair), a little lowered at the inner end — smug.
    g.strokeStyle = '#9d8a86';
    g.lineWidth = 4;
    g.lineCap = 'round';
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(U(s * 0.17), V(0.15));
      g.quadraticCurveTo(U(s * 0.37), V(0.25), U(s * 0.58), V(0.18));
      g.stroke();
    }
    // Nose: a tiny stroke.
    g.strokeStyle = 'rgba(205,130,115,0.8)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(256 - 2, V(-0.33));
    g.lineTo(256 + 3, V(-0.37));
    g.stroke();
    // Mouth: smug little smile, open at one side with the tongue tip showing.
    const my = V(-0.5);
    g.fillStyle = '#922c34';
    g.beginPath();
    g.moveTo(244, my + 2);
    g.quadraticCurveTo(258, my + 20, 274, my);
    g.quadraticCurveTo(258, my + 6, 244, my + 2);
    g.fill();
    g.fillStyle = '#ff8f9c';
    g.beginPath();
    g.ellipse(262, my + 9, 8, 4.5, -0.2, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#7a3428';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(230, my - 3);
    g.quadraticCurveTo(254, my + 8, 284, my - 7);
    g.stroke();
  });

const plaidTex = () =>
  canvasTex(
    256,
    256,
    (g) => {
      g.fillStyle = '#4b7cc2';
      g.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 4; i++) {
        const o = i * 64;
        g.fillStyle = 'rgba(32,66,140,0.42)';
        g.fillRect(0, o + 18, 256, 20);
        g.fillRect(o + 18, 0, 20, 256);
        g.fillStyle = 'rgba(200,222,252,0.75)';
        g.fillRect(0, o + 50, 256, 2);
        g.fillRect(o + 50, 0, 2, 256);
        g.fillStyle = 'rgba(24,44,96,0.55)';
        g.fillRect(0, o + 8, 256, 1.5);
        g.fillRect(o + 8, 0, 1.5, 256);
      }
    },
    [14, 4],
  );

const stripeTex = () =>
  canvasTex(16, 256, (g) => {
    for (let i = 0; i < 8; i++) {
      g.fillStyle = '#f39a2c';
      g.fillRect(0, i * 32, 16, 17);
      g.fillStyle = '#fff2e0';
      g.fillRect(0, i * 32 + 17, 16, 15);
    }
  });

function heartPath(g: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  g.beginPath();
  g.moveTo(x, y + s * 0.35);
  g.bezierCurveTo(x - s * 0.9, y - s * 0.25, x - s * 0.35, y - s * 0.85, x, y - s * 0.35);
  g.bezierCurveTo(x + s * 0.35, y - s * 0.85, x + s * 0.9, y - s * 0.25, x, y + s * 0.35);
}

/** Backpack atlas: left half = the white face with sleepy eyes, right half = the doodled yolk. */
const bagTex = () =>
  canvasTex(1024, 512, (g) => {
    const bg = g.createRadialGradient(256, 230, 60, 256, 256, 256);
    bg.addColorStop(0, '#fffbf2');
    bg.addColorStop(0.8, '#fbf1df');
    bg.addColorStop(1, '#efdcc0');
    g.fillStyle = bg;
    g.fillRect(0, 0, 512, 512);
    g.strokeStyle = '#5b2a1a';
    g.lineWidth = 10;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    for (const cx of [150, 362]) {
      g.beginPath();
      for (let i = 0; i <= 6; i++) {
        const x = cx - 45 + i * 15;
        const y = 150 + (i % 2 ? -12 : 10);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    }
    // Yolk.
    const ox = 512;
    const yg = g.createRadialGradient(ox + 220, 210, 20, ox + 256, 256, 256);
    yg.addColorStop(0, '#ffc548');
    yg.addColorStop(0.75, '#f6981c');
    yg.addColorStop(1, '#e27c10');
    g.fillStyle = yg;
    g.fillRect(ox, 0, 512, 512);
    g.fillStyle = '#ffd98e';
    g.beginPath();
    g.arc(ox + 165, 165, 40, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ffeacc';
    heartPath(g, ox + 345, 170, 70);
    g.fill();
    // Four-point sparkle.
    g.fillStyle = '#fff6e6';
    g.beginPath();
    const sx = ox + 350;
    const sy = 345;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const r = i % 2 ? 12 : 48;
      g.lineTo(sx + Math.sin(a) * r, sy - Math.cos(a) * r);
    }
    g.closePath();
    g.fill();
    // Mini fried egg.
    g.fillStyle = '#fffaf0';
    g.beginPath();
    for (let i = 0; i <= 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const r = 50 + Math.sin(a * 5) * 6;
      g.lineTo(ox + 170 + Math.cos(a) * r, 340 + Math.sin(a) * r * 0.85);
    }
    g.fill();
    g.fillStyle = '#ffb020';
    g.beginPath();
    g.arc(ox + 176, 334, 18, 0, Math.PI * 2);
    g.fill();
  });

let MATS: Record<Cls, THREE.Material> | null = null;
function mats(): Record<Cls, THREE.Material> {
  if (MATS) return MATS;
  const face = faceTex();
  MATS = {
    skin: stylise(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.6, sheen: 0.4, sheenColor: new THREE.Color(0xffd0c0), sheenRoughness: 0.5 }), 0.35, 0.24, 'skin'),
    cloth: stylise(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.85, sheen: 0.3, sheenColor: new THREE.Color(0xffffff), sheenRoughness: 0.7, side: THREE.DoubleSide }), 0.4, 0.2, 'cloth'),
    gloss: stylise(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.38, clearcoat: 0.6, clearcoatRoughness: 0.25 }), 0.35, 0.16, 'gloss'),
    metal: stylise(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.85 }), 0.3, 0.16, 'metal'),
    hair: stylise(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.45, sheen: 0.8, sheenColor: new THREE.Color(0xdfe6ff), sheenRoughness: 0.35, side: THREE.DoubleSide }), 0.5, 0.2, 'hair'),
    plaid: stylise(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, map: plaidTex(), side: THREE.DoubleSide }), 0.4, 0.2, 'plaid'),
    stripe: stylise(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, map: stripeTex(), side: THREE.DoubleSide }), 0.4, 0.2, 'stripe'),
    bag: stylise(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, map: bagTex() }), 0.35, 0.2, 'bag'),
    face: stylise(
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, map: face, emissive: 0xffffff, emissiveMap: face, emissiveIntensity: 0.22, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      0,
      0.08,
      'face',
    ),
  };
  return MATS;
}

interface Paint {
  cls: Cls;
  c: THREE.Color;
  /** Optional vertical gradient (own-frame y0 → y1) towards c2. */
  c2?: THREE.Color;
  y0?: number;
  y1?: number;
}
const P = (cls: Cls, hex: number, hex2?: number, y0 = 0, y1 = 1): Paint => ({ cls, c: new THREE.Color(hex), c2: hex2 === undefined ? undefined : new THREE.Color(hex2), y0, y1 });

const COL = {
  skin: P('skin', 0xffd0b8),
  hair: P('hair', 0xf7f5fb, 0xc7c0dc, 0.3, -0.9),
  hairLock: P('hair', 0xf9f8fc, 0xd2cce4, 0.05, -0.2),
  shirt: P('cloth', 0xffffff),
  jacket: P('cloth', 0xff8812),
  jacketDark: P('cloth', 0xe86c10),
  cream: P('cloth', 0xf6eadb),
  sleeve: P('cloth', 0xfff0dc, 0xf3dcbc, -0.02, -0.25),
  tie: P('gloss', 0xf2c436),
  belt: P('gloss', 0x6e3420),
  gold: P('metal', 0xe8b84a),
  silver: P('metal', 0xd8dde2),
  choker: P('gloss', 0x1c1418),
  shorts: P('cloth', 0x2b3a5c),
  plaid: P('plaid', 0xf2f6ff),
  stripe: P('stripe', 0xffffff),
  warmerTop: P('cloth', 0xf39a2c),
  shoe: P('gloss', 0x3f78d8),
  sole: P('gloss', 0xf6f3ee),
  white: P('cloth', 0xfffcf4),
  yolk: P('gloss', 0xffaa1e),
  nail: P('gloss', 0xf59a2a),
  bagWhite: P('cloth', 0xfdf6ea),
  bagOrange: P('cloth', 0xf3901f),
  bagTex: P('bag', 0xffffff),
  face: P('face', 0xffffff),
};

// ───────────────────────────────────────────────────────── geometry kit ──
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

/**
 * Primitives authored in a bone's frame → merged into one mesh with one geometry group per
 * material class. When skinned, every vertex is rigidly bound to the current bone (optionally
 * blended with its parent near the joint, `soft` metres: > 0 parent above, < 0 parent below).
 */
class Kit {
  private readonly parts = new Map<Cls, THREE.BufferGeometry[]>();
  private bone = 0;
  private parent = -1;
  private readonly bind = new THREE.Matrix4();
  pre: THREE.Matrix4 | null = null;
  constructor(private readonly skinned: boolean) {}

  at(bone: number, parent: number, world: THREE.Vector3): this {
    this.bone = bone;
    this.parent = parent;
    this.bind.makeTranslation(world.x, world.y, world.z);
    this.pre = null;
    return this;
  }

  add(g: THREE.BufferGeometry, p: Paint, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1, soft = 0): this {
    const geo = g.index ? g.toNonIndexed() : g;
    if (geo !== g) g.dispose();
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    if (!geo.getAttribute('uv')) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.getAttribute('position').count * 2), 2));
    for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
    const pos = geo.getAttribute('position');
    const n = pos.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      let c = p.c;
      if (p.c2) c = _c.copy(p.c).lerp(p.c2, smooth(p.y0!, p.y1!, pos.getY(i)));
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    _m.compose(_v.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz, 'XYZ')), _s.set(sx, sy, sz));
    if (this.pre) _m.premultiply(this.pre);
    geo.applyMatrix4(_m);
    if (_m.determinant() < 0) flipWinding(geo);
    if (this.skinned) {
      const si = new Uint16Array(n * 4);
      const sw = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        const w = soft !== 0 && this.parent >= 0 ? Math.min(1, Math.max(0, 0.5 * (1 + pos.getY(i) / soft))) : 0;
        si[i * 4] = this.bone;
        si[i * 4 + 1] = Math.max(0, this.parent);
        sw[i * 4] = 1 - w;
        sw[i * 4 + 1] = w;
      }
      geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
      geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
      geo.applyMatrix4(this.bind);
    }
    const list = this.parts.get(p.cls) ?? [];
    list.push(geo);
    this.parts.set(p.cls, list);
    return this;
  }

  build(): { geometry: THREE.BufferGeometry; materials: THREE.Material[] } {
    const geos: THREE.BufferGeometry[] = [];
    const ms: THREE.Material[] = [];
    for (const cls of CLS_ORDER) {
      const list = this.parts.get(cls);
      if (!list?.length) continue;
      for (const g of list) g.clearGroups();
      geos.push(list.length === 1 ? list[0] : mergeGeometries(list, false)!);
      ms.push(mats()[cls]);
    }
    const merged = mergeGeometries(geos, true)!;
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    return { geometry: merged, materials: ms };
  }
}

function flipWinding(g: THREE.BufferGeometry): void {
  for (const name of Object.keys(g.attributes)) {
    const a = g.getAttribute(name) as THREE.BufferAttribute;
    const s = a.itemSize;
    const arr = a.array as Float32Array;
    for (let t = 0; t + 2 < a.count; t += 3) {
      for (let k = 0; k < s; k++) {
        const i1 = (t + 1) * s + k;
        const i2 = (t + 2) * s + k;
        const tmp = arr[i1];
        arr[i1] = arr[i2];
        arr[i2] = tmp;
      }
    }
    a.needsUpdate = true;
  }
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ell = (rx: number, ry: number, rz: number, w = 20, h = 14) => new THREE.SphereGeometry(1, w, h).scale(rx, ry, rz);
const lathe = (pts: [number, number][], seg = 24, phiStart = 0, phiLen = Math.PI * 2) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(Math.max(0, r), y)), seg, phiStart, phiLen);
const cyl = (rt: number, rb: number, h: number, seg = 16) => new THREE.CylinderGeometry(rt, rb, h, seg);
const tube = (pts: [number, number, number][], r: number, seg = 16, rs = 6) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p))), seg, r, rs);
const extrude = (shape: THREE.Shape, depth: number, bevel = 0.002) =>
  new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 3 }).translate(0, 0, -depth / 2);

/** Tapered limb hanging from the origin along −Y: rounded top r0, rounded bottom r1, length len. */
function limb(r0: number, r1: number, len: number, seg = 14, st = 3): THREE.BufferGeometry {
  const pts: [number, number][] = [];
  for (let i = 0; i <= st; i++) {
    const a = (i / st) * (Math.PI / 2);
    pts.push([Math.sin(a) * r1, -len + r1 - Math.cos(a) * r1]);
  }
  for (let i = st; i >= 0; i--) {
    const a = (i / st) * (Math.PI / 2);
    pts.push([Math.sin(a) * r0, -r0 + Math.cos(a) * r0]);
  }
  return lathe(pts, seg);
}

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

/** Fold wrinkles around a lathed sleeve / warmer between y0 and y1 (own frame). */
const wrinkle = (g: THREE.BufferGeometry, amp: number, freq: number, y0: number, y1: number) =>
  deform(g, (v) => {
    const k = 1 + amp * Math.sin(v.y * freq + Math.atan2(v.x, v.z) * 2) * smooth(y0, y0 + 0.02, v.y) * smooth(y1, y1 - 0.02, v.y);
    v.x *= k;
    v.z *= k;
  });

/**
 * Tapered flat strand along a curve (hair locks, tie, straps). `out` gives the strand's outward
 * (thickness) direction: a centre point (radial) or a fixed vector.
 */
function ribbon(pts: THREE.Vector3[], width: (t: number) => number, th: number, out: { center?: THREE.Vector3; dir?: THREE.Vector3 }, seg = 12, rad = 6): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(pts);
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const o = new THREE.Vector3();
  const sd = new THREE.Vector3();
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const c = curve.getPointAt(t);
    const T = curve.getTangentAt(t);
    if (out.center) o.copy(c).sub(out.center);
    else o.copy(out.dir!);
    o.addScaledVector(T, -o.dot(T)).normalize();
    sd.crossVectors(T, o).normalize();
    const w = width(t);
    const thk = th * Math.min(1, w / 0.01 + 0.25);
    for (let j = 0; j <= rad; j++) {
      const a = (j / rad) * Math.PI * 2;
      pos.push(c.x + sd.x * Math.cos(a) * w + o.x * Math.sin(a) * thk, c.y + sd.y * Math.cos(a) * w + o.y * Math.sin(a) * thk, c.z + sd.z * Math.cos(a) * w + o.z * Math.sin(a) * thk);
      uv.push(j / rad, t);
    }
  }
  for (let i = 0; i < seg; i++)
    for (let j = 0; j < rad; j++) {
      const a = i * (rad + 1) + j;
      const b = a + rad + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Orient a −Z-facing decoration to a surface direction: tilt up by pitch, then turn by yaw (+ = towards +X). */
const orient = (g: THREE.BufferGeometry, yaw: number, pitch: number, roll = 0) => g.rotateZ(roll).rotateX(pitch).rotateY(-yaw);

function roundRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + r, -h / 2);
  s.lineTo(w / 2 - r, -h / 2);
  s.absarc(w / 2 - r, -h / 2 + r, r, -Math.PI / 2, 0, false);
  s.lineTo(w / 2, h / 2 - r);
  s.absarc(w / 2 - r, h / 2 - r, r, 0, Math.PI / 2, false);
  s.lineTo(-w / 2 + r, h / 2);
  s.absarc(-w / 2 + r, h / 2 - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-w / 2, -h / 2 + r);
  s.absarc(-w / 2 + r, -h / 2 + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

/** Wobbly fried-egg white outline. */
function eggWhite(r: number): THREE.Shape {
  const s = new THREE.Shape();
  for (let i = 0; i <= 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const rr = r * (1 + 0.12 * Math.sin(a * 3 + 0.6) + 0.06 * Math.sin(a * 5));
    if (i === 0) s.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
    else s.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  return s;
}

function heartShape(s: number): THREE.Shape {
  const h = new THREE.Shape();
  h.moveTo(0, -s * 0.45);
  h.bezierCurveTo(-s * 1.0, s * 0.2, -s * 0.45, s * 0.85, 0, s * 0.35);
  h.bezierCurveTo(s * 0.45, s * 0.85, s * 1.0, s * 0.2, 0, -s * 0.45);
  return h;
}

function starShape(r: number, ri: number): THREE.Shape {
  const s = new THREE.Shape();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const rr = i % 2 ? ri : r;
    if (i === 0) s.moveTo(Math.sin(a) * rr, Math.cos(a) * rr);
    else s.lineTo(Math.sin(a) * rr, Math.cos(a) * rr);
  }
  s.closePath();
  return s;
}

// ──────────────────────────────────────────────────────────── skeleton ──
// Bones (nominal metres, rest pose = arms hanging straight down).
const B = { root: 0, pelvis: 1, spine: 2, neck: 3, shL: 4, elL: 5, wrL: 6, shR: 7, elR: 8, wrR: 9, hipL: 10, knL: 11, hipR: 12, knR: 13 } as const;
const PARENT = [-1, 0, 1, 2, 2, 4, 5, 2, 7, 8, 1, 10, 1, 12];
const PELVIS_Y = 1.04;
const LOCAL: [number, number, number][] = [
  [0, 0, 0], [0, PELVIS_Y, 0], [0, 0.08, 0], [0, 0.42, 0],
  [-0.165, 0.355, 0], [0, -0.27, 0], [0, -0.25, 0],
  [0.165, 0.355, 0], [0, -0.27, 0], [0, -0.25, 0],
  [-0.085, -0.04, 0], [0, -0.43, 0], [0.085, -0.04, 0], [0, -0.43, 0],
];
const HEAD_Y = 0.225; // head centre above the neck bone
const HR: [number, number, number] = [0.157, 0.177, 0.162]; // head radii
const HAIR_C = new THREE.Vector3(0, 0.014, 0.01);
const HRH: [number, number, number] = [0.188, 0.196, 0.19]; // hair shell radii
/** Left-hand grip point (wrist frame, palm side) where the backpack handle sits. */
const GRIP = new THREE.Vector3(0.022, -0.07, 0);

function restWorld(i: number): THREE.Vector3 {
  const v = new THREE.Vector3();
  for (let b = i; b >= 0; b = PARENT[b]) v.add(_v.set(...LOCAL[b]));
  return v;
}

/** Head shape: round cranium, cheeks narrowing to a small chin, flatter face. */
function headShape(v: THREE.Vector3): void {
  const t = smooth(0, -1, v.y / HR[1]);
  v.x *= 1 - 0.28 * t * t;
  if (v.z < 0) v.z *= 0.93 - 0.05 * t;
  else v.z *= 1 - 0.42 * t;
  v.y *= 1 - 0.1 * t * t;
}

/** Point on an ellipsoid of radii r around the head centre: yaw 0 = front (−Z), + → +X; pitch up. */
function onHead(r: [number, number, number], yaw: number, pitch: number, c = HAIR_C): THREE.Vector3 {
  const cp = Math.cos(pitch);
  return new THREE.Vector3(r[0] * Math.sin(yaw) * cp + c.x, r[1] * Math.sin(pitch) + c.y, -r[2] * Math.cos(yaw) * cp + c.z);
}
const mixR = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// Torso profile (spine frame) and its front surface.
const TORSO: [number, number][] = [
  [0, -0.07], [0.094, -0.07], [0.092, 0.0], [0.096, 0.06], [0.11, 0.13], [0.124, 0.19], [0.127, 0.25], [0.128, 0.3], [0.133, 0.335], [0.112, 0.37], [0.075, 0.392], [0.045, 0.402], [0, 0.408],
];
const JACKET: [number, number][] = [
  [0.108, 0.05], [0.112, 0.09], [0.124, 0.13], [0.138, 0.19], [0.142, 0.25], [0.143, 0.3], [0.149, 0.335], [0.128, 0.372], [0.092, 0.395], [0.072, 0.405],
];
const FLAT = 0.74;
const GAP = 0.36;
function profR(prof: [number, number][], y: number): number {
  for (let i = 1; i < prof.length; i++) {
    const [r1, y1] = prof[i];
    const [r0, y0] = prof[i - 1];
    if (y <= y1 && y1 > y0) return r0 + ((r1 - r0) * (y - y0)) / (y1 - y0);
  }
  return prof[prof.length - 1][0];
}
const frontZ = (prof: [number, number][], x: number, y: number) => {
  const R = profR(prof, y);
  return -FLAT * Math.sqrt(Math.max(0, R * R - x * x));
};

// ───────────────────────────────────────────────────────── body parts ──
function buildHand(k: Kit, side: number, grip: boolean): void {
  // Authored as a right hand (palm facing −X, thumb to the front); mirrored for the left.
  k.pre = side < 0 ? new THREE.Matrix4().makeScale(-1, 1, 1) : null;
  const sk = COL.skin;
  k.add(limb(0.025, 0.024, 0.045, 8, 2), sk, 0, 0.01, 0);
  k.add(ell(0.017, 0.04, 0.034, 8, 6), sk, 0.002, -0.052, 0);
  const zs = [-0.024, -0.008, 0.008, 0.023];
  const lens = [0.052, 0.058, 0.054, 0.044];
  for (let i = 0; i < 4; i++) {
    const L = lens[i];
    const fy = -0.086;
    if (grip) {
      // Curled round the handle: proximal phalanx forward to the palm side, tip folded back up.
      k.add(limb(0.0095, 0.0085, L * 0.55, 6, 2), sk, -0.002, fy + 0.008, zs[i], 0, 0, -1.25);
      const a = -1.25;
      const ex = -0.002 + L * 0.55 * Math.sin(a) * -1;
      const ey = fy + 0.008 - L * 0.55 * Math.cos(a);
      k.add(limb(0.0085, 0.0075, L * 0.5, 6, 2), sk, ex + 0.004, ey + 0.004, zs[i], 0, 0, -2.75);
    } else {
      const curl = 0.25 + i * 0.05;
      k.add(limb(0.0095, 0.0075, L, 6, 2), sk, -0.002, fy, zs[i], 0, 0, -curl);
      const tx = -0.002 - L * Math.sin(curl) * 0.92;
      const ty = fy - L * Math.cos(curl) * 0.92;
      k.add(ell(0.0065, 0.009, 0.007, 6, 4), COL.nail, tx + 0.004, ty, zs[i]);
    }
  }
  k.add(limb(0.011, 0.0085, 0.045, 6, 2), sk, -0.012, -0.03, -0.03, 0.55, 0, grip ? -0.9 : -0.45);
  k.pre = null;
}

function buildBody(k: Kit): void {
  const W = (i: number) => restWorld(i);
  // ── pelvis: shorts, pleated plaid skirt, belt and buckle
  k.at(B.pelvis, B.root, W(B.pelvis));
  k.add(ell(0.112, 0.1, 0.094, 12, 8), COL.shorts, 0, -0.03, 0);
  const skirt = deform(
    lathe([[0.252, -0.205], [0.226, -0.155], [0.165, -0.045], [0.12, 0.055], [0.106, 0.1], [0.104, 0.118]], 32),
    (v) => {
      const phi = Math.atan2(v.x, v.z);
      const f = (((phi / (Math.PI * 2)) * 16) % 1 + 1) % 1;
      const tri = Math.abs(f * 2 - 1);
      const k2 = 1 + smooth(0.07, -0.12, v.y) * 0.08 * (tri - 0.5);
      v.x *= k2;
      v.z *= k2;
    },
  );
  k.add(skirt, COL.plaid, 0, 0, 0, 0, 0, 0, 1, 1, 0.88);
  k.add(lathe([[0.107, 0.086], [0.11, 0.09], [0.11, 0.118], [0.107, 0.122]], 32), COL.belt, 0, 0, 0, 0, 0, 0, 1, 1, 0.88);
  const bk = roundRect(0.042, 0.03, 0.006);
  const hole = roundRect(0.026, 0.016, 0.003);
  bk.holes.push(new THREE.Path(hole.getPoints(2).reverse()));
  k.add(extrude(bk, 0.005, 0), COL.gold, 0, 0.104, -0.11 * 0.88 - 0.006);
  k.add(new THREE.BoxGeometry(0.004, 0.018, 0.004), COL.gold, 0.004, 0.104, -0.11 * 0.88 - 0.008);

  // ── spine: shirt, jacket, collar, tie, patch
  k.at(B.spine, B.pelvis, W(B.spine));
  k.add(lathe(TORSO, 16), COL.shirt, 0, 0, 0, 0, 0, 0, 1, 1, FLAT, -0.06);
  const jacketOpen = (prof: [number, number][]) => lathe(prof, 22, Math.PI + GAP, Math.PI * 2 - 2 * GAP);
  k.add(jacketOpen(JACKET), COL.jacket, 0, 0, 0, 0, 0, 0, 1, 1, FLAT, -0.06);
  k.add(jacketOpen([[0.111, 0.044], [0.116, 0.052], [0.117, 0.088], [0.113, 0.096]]), COL.jacketDark, 0, 0, 0, 0, 0, 0, 1, 1, FLAT);
  for (const yb of [0.058, 0.074]) k.add(jacketOpen([[0.1185, yb], [0.1185, yb + 0.007]]), COL.cream, 0, 0, 0, 0, 0, 0, 1, 1, FLAT);
  k.add(jacketOpen([[0.074, 0.39], [0.072, 0.42], [0.066, 0.432]]), COL.jacket, 0, 0, 0, 0, 0, 0, 1, 1, 0.9);
  for (const s of [-1, 1]) {
    const edge: [number, number, number][] = [];
    for (let y = 0.05; y <= 0.395; y += 0.0575) {
      const R = profR(JACKET, y);
      edge.push([s * R * Math.sin(GAP), y, -FLAT * R * Math.cos(GAP)]);
    }
    k.add(tube(edge, 0.0055, 10, 4), COL.jacketDark);
    for (const y of [0.11, 0.19, 0.27, 0.34]) {
      const R = profR(JACKET, y) + 0.002;
      const a = GAP + 0.1;
      k.add(cyl(0.0075, 0.0075, 0.004, 6), COL.silver, s * R * Math.sin(a), y, -FLAT * R * Math.cos(a), Math.PI / 2, 0, 0);
    }
    // Shirt collar points splayed over the jacket.
    const cp = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0.058, -0.004), new THREE.Vector2(0.03, -0.062)]);
    k.add(extrude(cp, 0.005, 0.0015), COL.shirt, s * 0.01, 0.4, frontZ(TORSO, 0, 0.39) - 0.012, -0.5, s * 0.25, 0, s, 1, 1);
  }
  // Heart pin on her left collar point.
  k.add(extrude(heartShape(0.011), 0.004, 0.001), P('gloss', 0xf29a1e), -0.042, 0.372, frontZ(TORSO, 0.042, 0.372) - 0.022, -0.4, 0.25, 0);
  // Tie: knot, blade following the chest, silver clip.
  const tz = (y: number) => frontZ(TORSO, 0, y) - 0.013;
  k.add(ell(0.017, 0.016, 0.011, 8, 6), COL.tie, 0, 0.382, tz(0.382) + 0.002);
  const tiePts = [0.372, 0.3, 0.24, 0.18, 0.13, 0.1].map((y) => new THREE.Vector3(0, y, Math.min(tz(y), -0.098 - (0.372 - y) * 0.02)));
  k.add(ribbon(tiePts, (t) => (t < 0.88 ? 0.011 + 0.012 * t : (0.022 * (1 - t)) / 0.12 + 0.002), 0.003, { dir: new THREE.Vector3(0, 0, -1) }, 10, 4), COL.tie);
  k.add(new THREE.BoxGeometry(0.05, 0.007, 0.006), COL.silver, 0, 0.22, tiePts[2].z - 0.006);
  // Fried-egg chest patch (her left).
  const px = -0.082;
  const py = 0.275;
  const pz = -FLAT * Math.sqrt(profR(JACKET, py) ** 2 - px * px) - 0.003;
  const pry = Math.asin(-px / profR(JACKET, py)) * 0.8;
  k.add(orient(extrude(eggWhite(0.026), 0.004, 0), -pry, 0), COL.white, px, py, pz);
  k.add(ell(0.011, 0.011, 0.006, 8, 6), COL.yolk, px + 0.003 * Math.cos(pry), py + 0.003, pz - 0.004);

  // ── neck + head
  k.at(B.neck, B.spine, W(B.neck));
  k.add(cyl(0.04, 0.045, 0.14, 16), COL.skin, 0, 0.03, 0, 0, 0, 0, 1, 1, 1, -0.04);
  k.add(new THREE.TorusGeometry(0.0425, 0.008, 4, 16).rotateX(Math.PI / 2), COL.choker, 0, 0.05, 0);
  k.add(new THREE.TorusGeometry(0.007, 0.002, 4, 10), COL.silver, 0, 0.042, -0.05);
  k.pre = new THREE.Matrix4().makeTranslation(0, HEAD_Y, 0);
  k.add(deform(ell(1, 1, 1, 20, 16).scale(...HR), headShape), COL.skin);
  // Face decal: a conforming patch of the head with the painted anime face.
  const fp = new THREE.SphereGeometry(1, 16, 10, Math.PI * 1.5 - FACE_W / 2, FACE_W, TH0, TH1 - TH0).scale(HR[0] * 1.004, HR[1] * 1.004, HR[2] * 1.004);
  k.add(deform(fp, headShape), COL.face);
  buildHair(k);
  k.pre = null;

  // ── arms
  for (const [sh, el, wr, s] of [[B.shL, B.elL, B.wrL, -1], [B.shR, B.elR, B.wrR, 1]] as const) {
    k.at(sh, B.spine, W(sh));
    const up = lathe([[0, -0.292], [0.05, -0.29], [0.066, -0.272], [0.071, -0.22], [0.073, -0.16], [0.072, -0.1], [0.07, -0.04], [0.066, 0.0], [0.056, 0.03], [0.032, 0.046], [0, 0.05]], 10);
    k.add(wrinkle(up, 0.035, 48, -0.26, -0.03), COL.sleeve, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0.04);
    k.at(el, sh, W(el));
    const fo = lathe([[0, -0.236], [0.05, -0.233], [0.07, -0.2], [0.079, -0.14], [0.077, -0.08], [0.071, -0.02], [0.065, 0.01], [0.046, 0.03], [0, 0.036]], 10);
    k.add(wrinkle(fo, 0.04, 52, -0.21, -0.02), COL.sleeve, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0.045);
    k.add(lathe([[0.046, -0.272], [0.053, -0.268], [0.055, -0.222], [0.05, -0.214]], 10), COL.jacket);
    k.add(lathe([[0.047, -0.272], [0.047, -0.262]], 10), COL.jacketDark);
    k.at(wr, el, W(wr));
    buildHand(k, s, s < 0);
  }

  // ── legs: thighs, shins, leg warmers, platform sneakers
  for (const [hp, kn, s] of [[B.hipL, B.knL, -1], [B.hipR, B.knR, 1]] as const) {
    k.at(hp, B.pelvis, W(hp));
    k.add(limb(0.08, 0.052, 0.46, 10), COL.skin, 0, 0.02, 0, 0, 0, 0, 1, 1, 1, 0.06);
    k.at(kn, hp, W(kn));
    k.add(lathe([[0, -0.432], [0.036, -0.426], [0.038, -0.36], [0.046, -0.28], [0.053, -0.18], [0.052, -0.1], [0.05, -0.03], [0.051, 0.0], [0.036, 0.03], [0, 0.036]], 10), COL.skin, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0.05);
    // Slouchy striped warmer (evenly spaced profile so the stripe texture stays even).
    const wp: [number, number][] = [];
    const N = 10;
    for (let i = 0; i <= N; i++) {
      const y = lerp(-0.45, -0.105, i / N);
      const r = 0.066 + 0.036 * smooth(-0.15, -0.42, y) + 0.006 * Math.sin(y * 75) + (i === 0 ? -0.012 : 0);
      wp.push([r, y]);
    }
    const warmer = deform(lathe(wp, 12), (v) => {
      const k2 = 1 + 0.06 * Math.sin(Math.atan2(v.x, v.z) * 3 + v.y * 40) * smooth(-0.12, -0.2, v.y);
      v.x *= k2;
      v.z *= k2;
    });
    k.add(warmer, COL.stripe);
    k.add(lathe([[0.052, -0.13], [0.068, -0.132], [0.075, -0.11], [0.071, -0.082], [0.056, -0.076]], 12), COL.warmerTop);
    buildShoe(k, s);
  }
}

function buildShoe(k: Kit, s: number): void {
  const base = -0.57; // knee frame: sole bottom on the ground
  // Chunky platform: an elliptical sole with a rounded top edge and a blue band.
  k.add(lathe([[0, 0], [0.96, 0], [1, 0.12], [1, 0.8], [0.93, 1], [0, 1]], 18), COL.sole, 0, base, -0.05, 0, 0, 0, 0.078, 0.09, 0.18);
  k.add(cyl(1, 1, 1, 18).translate(0, 0.5, 0), COL.shoe, 0, base + 0.018, -0.05, 0, 0, 0, 0.0795, 0.016, 0.1815);
  // Upper: a rounded wedge — high at the ankle, sloping down to a low rounded toe.
  const upper = deform(ell(0.064, 0.07, 0.15, 14, 9), (v) => {
    if (v.y < -0.015) v.y = -0.015 + (v.y + 0.015) * 0.2;
    if (v.y > 0) v.y *= 1 - 0.45 * smooth(0.0, -0.15, v.z);
  });
  k.add(upper, COL.shoe, 0, base + 0.1, -0.06, 0, 0, 0, 1.15, 1.05, 1.22);
  for (let i = 0; i < 3; i++) k.add(new THREE.BoxGeometry(0.07, 0.009, 0.015), COL.sole, 0, base + 0.172 - i * 0.014, -0.085 - i * 0.03, 0.5, 0, 0);
  const star = extrude(starShape(0.04, 0.012), 0.003, 0);
  for (const side of [-1, 1]) k.add(star.clone(), COL.sole, side * 0.0745, base + 0.105, -0.035, 0, side * Math.PI / 2, 0);
  star.dispose();
  void s;
}

function buildHair(k: Kit): void {
  // Shell: open at the front (face window), clump grooves, flared and scalloped hem.
  const WIN = 0.95;
  const shell = new THREE.SphereGeometry(1, 26, 12, Math.PI * 1.5 + WIN, Math.PI * 2 - 2 * WIN, 0, 2.3);
  const shapeHair = (v: THREE.Vector3, hemmed: boolean) => {
    const th = Math.acos(Math.max(-1, Math.min(1, v.y)));
    const phi = Math.atan2(v.z, -v.x);
    let f = 1 + 0.028 * Math.cos(phi * 13) * smooth(0.8, 1.7, th);
    if (hemmed) {
      f += 0.12 * smooth(1.2, 1.9, th) + 0.22 * smooth(1.8, 2.3, th) ** 2;
      // Layered, pointed tips: clumps hang lower between notches, plus a slow wave.
      const tip = Math.pow(Math.abs(Math.sin(phi * 6.5 + 0.7)), 0.5);
      v.y -= smooth(1.95, 2.3, th) * (0.11 * tip - 0.05 + 0.03 * Math.sin(phi * 2 + 1));
    }
    v.x *= f;
    v.z *= f;
  };
  k.add(deform(shell, (v) => shapeHair(v, true)), COL.hair, HAIR_C.x, HAIR_C.y, HAIR_C.z, 0, 0, 0, ...HRH);
  // Crown cap over the face window (no overlap with the shell).
  const cap = new THREE.SphereGeometry(1, 12, 8, Math.PI * 1.5 - WIN, 2 * WIN, 0, 1.2);
  k.add(deform(cap, (v) => shapeHair(v, false)), COL.hair, HAIR_C.x, HAIR_C.y, HAIR_C.z, 0, 0, 0, ...HRH);
  const center = HAIR_C.clone();
  const HTIP: [number, number, number] = [0.168, 0.19, 0.162];
  const lock = (y0: number, y1: number, p0: number, p1: number, w: number, tipR = HTIP, n = 6) => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts.push(onHead(mixR(HRH, tipR, t * t), lerp(y0, y1, t), lerp(p0, p1, t)));
    }
    k.add(ribbon(pts, (t) => w * (1 - Math.pow(t, 2.2)) + 0.002, 0.015, { center }, 6, 6), COL.hairLock);
  };
  // Bangs: seven tapered locks over the forehead, the middle one dipping between the eyes.
  const bangs: [number, number, number, number][] = [
    [-0.7, -0.8, 0.12, 0.034], [-0.48, -0.54, 0.05, 0.036], [-0.26, -0.3, 0.09, 0.034], [-0.06, 0.04, -0.03, 0.03], [0.14, 0.2, 0.07, 0.034], [0.36, 0.44, 0.03, 0.036], [0.6, 0.7, 0.1, 0.034],
  ];
  for (const [a, b, pe, w] of bangs) lock(a, b, 0.8, pe, w);
  // Face-framing side locks reaching the chin, curling in a little.
  for (const s of [-1, 1]) {
    lock(s * 0.86, s * 0.78, 0.55, -0.85, 0.034, [0.19, 0.2, 0.17], 6);
    lock(s * 1.05, s * 1.02, 0.5, -0.92, 0.038, [0.225, 0.21, 0.2], 6);
  }
  // Ahoge: one swept lock springing from the crown (her right).
  const top = HAIR_C.y + HRH[1];
  const ah = [new THREE.Vector3(0.0, top - 0.01, 0.01), new THREE.Vector3(0.025, top + 0.045, -0.015), new THREE.Vector3(0.065, top + 0.07, -0.045), new THREE.Vector3(0.1, top + 0.045, -0.07)];
  k.add(ribbon(ah, (t) => 0.012 * (1 - t) + 0.0015, 0.006, { dir: new THREE.Vector3(0, 0.3, -1) }, 10, 5), COL.hairLock);
  // Hair clips: two orange bars on her left, a fried-egg pin on her right.
  for (const [pitch, roll] of [[0.5, 0.5], [0.36, 0.42]] as const) {
    const yaw = -0.8;
    const p = onHead([HRH[0] + 0.012, HRH[1] + 0.012, HRH[2] + 0.012], yaw, pitch);
    k.add(orient(extrude(roundRect(0.072, 0.02, 0.009), 0.008, 0), yaw, pitch, roll), P('gloss', 0xff9416), p.x, p.y, p.z);
    const d = onHead([HRH[0] + 0.019, HRH[1] + 0.019, HRH[2] + 0.019], yaw, pitch);
    k.add(ell(0.0045, 0.0045, 0.003, 6, 4), COL.white, d.x, d.y, d.z);
  }
  {
    const yaw = 0.55;
    const pitch = 0.46;
    const p = onHead([HRH[0] + 0.004, HRH[1] + 0.004, HRH[2] + 0.004], yaw, pitch);
    k.add(orient(extrude(eggWhite(0.02), 0.005, 0), yaw, pitch), COL.white, p.x, p.y, p.z);
    const y = onHead([HRH[0] + 0.011, HRH[1] + 0.011, HRH[2] + 0.011], yaw, pitch);
    k.add(ell(0.0085, 0.0085, 0.005, 8, 6), COL.yolk, y.x, y.y, y.z);
  }
  // Egg stud earrings peeking between the side locks and the shell.
  for (const s of [-1, 1]) {
    const e = onHead([HR[0] + 0.01, HR[1], HR[2] + 0.01], s * 0.93, -0.42, new THREE.Vector3());
    k.add(ell(0.009, 0.012, 0.008, 6, 4), COL.white, e.x, e.y, e.z);
    k.add(ell(0.0045, 0.0045, 0.003, 6, 4), COL.yolk, e.x + s * 0.002, e.y - 0.001, e.z - 0.007);
  }
}

// ──────────────────────────────────────────────────────────── backpack ──
const BAG_R = 0.195;
const BAG_CY = -0.07 - BAG_R; // bag centre below the grip
/** The round fried-egg backpack, origin at the handle grip, face towards −Z. */
function buildBackpack(): THREE.Mesh {
  const k = new Kit(false);
  const half = 0.05;
  const cushion = lathe([[0, -half], [0.168, -half], [0.186, -0.038], [0.193, -0.02], [BAG_R, 0], [0.193, 0.02], [0.186, 0.038], [0.168, half], [0, half]], 20).rotateX(Math.PI / 2);
  k.add(cushion, COL.bagWhite, 0, BAG_CY, 0);
  // Front panel (face) and the yolk: planar-UV rings bulged forward, sharing the atlas.
  const disc = (r: number, bulge: number, u0: number) => {
    const g = new THREE.RingGeometry(0.0005, r, 24, 3);
    const uv = g.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setX(i, u0 + uv.getX(i) * 0.5);
    g.rotateY(Math.PI);
    return deform(g, (v) => {
      const d = Math.min(1, Math.hypot(v.x, v.y) / r);
      v.z = -bulge * (1 - d * d);
    });
  };
  k.add(disc(0.172, 0.014, 0), COL.bagTex, 0, BAG_CY, -half - 0.0015);
  k.add(disc(0.088, 0.024, 0.5), COL.bagTex, 0, BAG_CY - 0.03, -half - 0.0135);
  // Zip round the side seam with an orange pull on the left side (as seen from the front: +X).
  k.add(new THREE.TorusGeometry(BAG_R + 0.001, 0.0045, 3, 32), P('cloth', 0xe9b070), 0, BAG_CY, 0);
  k.add(new THREE.BoxGeometry(0.01, 0.034, 0.008), COL.bagOrange, BAG_R + 0.006, BAG_CY - 0.04, -0.004);
  k.add(new THREE.BoxGeometry(0.012, 0.012, 0.01), P('metal', 0xd8c090), BAG_R + 0.005, BAG_CY - 0.02, -0.004);
  // Handle (the hand closes round its top at the origin) and its tabs.
  k.add(tube([[-0.062, -0.072, 0.0], [-0.05, -0.02, 0], [0, 0.004, 0], [0.05, -0.02, 0], [0.062, -0.072, 0]], 0.011, 14, 6), COL.bagOrange);
  for (const s of [-1, 1]) k.add(new THREE.BoxGeometry(0.03, 0.022, 0.03), COL.bagOrange, s * 0.062, -0.074, 0);
  // Shoulder straps on the back, hanging loose below the bag, with buckles.
  for (const s of [-1, 1]) {
    const pts = [new THREE.Vector3(s * 0.07, BAG_CY + 0.16, half + 0.004), new THREE.Vector3(s * 0.085, BAG_CY + 0.02, half + 0.012), new THREE.Vector3(s * 0.095, BAG_CY - 0.14, half + 0.02), new THREE.Vector3(s * 0.1, BAG_CY - 0.3, half + 0.03), new THREE.Vector3(s * 0.096, BAG_CY - 0.36, half + 0.02)];
    k.add(ribbon(pts, () => 0.015, 0.004, { dir: new THREE.Vector3(0, 0, 1) }, 10, 4), COL.bagOrange);
    k.add(new THREE.BoxGeometry(0.036, 0.022, 0.012), COL.silver, s * 0.095, BAG_CY - 0.14, half + 0.024);
  }
  const { geometry, materials } = k.build();
  const mesh = new THREE.Mesh(geometry, materials);
  mesh.name = 'EggBackpack';
  mesh.castShadow = true;
  return mesh;
}

// ──────────────────────────────────────────────────────────────── ghost ──
interface GhostU {
  uTime: { value: number };
  uOpacity: { value: number };
}
function ghostMaterial(u: GhostU): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, transparent: true, depthWrite: true });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = u.uTime;
    sh.uniforms.uOpacity = u.uOpacity;
    sh.vertexShader = 'varying float vGy;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  vGy = (modelMatrix * vec4(transformed, 1.0)).y;');
    sh.fragmentShader =
      'uniform float uTime;\nuniform float uOpacity;\nvarying float vGy;\n' +
      sh.fragmentShader.replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>
        {
          float fr = 1.0 - saturate(abs(dot(normal, normalize(vViewPosition))));
          float band = 0.5 + 0.5 * sin(vGy * 14.0 - uTime * 3.5);
          vec3 gold = vec3(1.0, 0.6, 0.12);
          gl_FragColor.rgb = gl_FragColor.rgb * 0.15 + gold * (0.55 + fr * fr * 1.3 + band * 0.4);
          gl_FragColor.a = saturate(uOpacity * (0.8 + 0.5 * band) + fr * fr * min(0.75, uOpacity * 4.0));
        }`,
      );
  };
  m.customProgramCacheKey = () => 'egg-ghost';
  return m;
}

let EGG_TEX: THREE.Texture | null | undefined;
function eggSparkTex(): THREE.Texture | null {
  if (EGG_TEX !== undefined) return EGG_TEX;
  EGG_TEX = canvasTex(64, 64, (g) => {
    const gr = g.createRadialGradient(32, 36, 0, 32, 34, 30);
    gr.addColorStop(0, 'rgba(255,252,235,1)');
    gr.addColorStop(0.45, 'rgba(255,220,120,0.55)');
    gr.addColorStop(1, 'rgba(255,170,40,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = 'rgba(255,236,170,1)';
    g.beginPath();
    g.ellipse(32, 35, 11, 15, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.beginPath();
    g.ellipse(26, 26, 4, 6, -0.5, 0, Math.PI * 2);
    g.fill();
  });
  return EGG_TEX;
}

// ──────────────────────────────────────────────────────────────── model ──
const N_SPARK = 8;
const _qa = new THREE.Quaternion();
const _qs = new THREE.Quaternion();
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const BAG_CHAIN = [B.pelvis, B.spine, B.shL, B.elL, B.wrL];

export class EggGirlModel {
  readonly root = new THREE.Group();
  readonly backpack: THREE.Object3D;
  private readonly body: THREE.SkinnedMesh;
  private readonly bag: THREE.Mesh;
  private readonly bones: THREE.Bone[] = [];
  private readonly scale: number;
  private readonly target = new Float32Array(14 * 3);
  private readonly bodyMats: THREE.Material[];
  private readonly bagMats: THREE.Material[];
  private readonly bodyGhost: THREE.Material[];
  private readonly bagGhost: THREE.Material[];
  private readonly ghost: THREE.MeshStandardMaterial;
  private readonly gu: GhostU = { uTime: { value: 0 }, uOpacity: { value: 0.18 } };
  private readonly sparks: THREE.Points;
  private readonly sparkMat: THREE.PointsMaterial;
  private ghosted = false;
  private snap = true;
  private time = 0;

  constructor(height = NOMINAL_H) {
    this.scale = height / NOMINAL_H;
    this.root.name = 'EggGirl';
    // Skeleton.
    for (let i = 0; i < LOCAL.length; i++) {
      const b = new THREE.Bone();
      b.name = ['root', 'pelvis', 'spine', 'neck', 'shoulder_L', 'elbow_L', 'wrist_L', 'shoulder_R', 'elbow_R', 'wrist_R', 'hip_L', 'knee_L', 'hip_R', 'knee_R'][i];
      b.position.set(...LOCAL[i]);
      if (PARENT[i] >= 0) this.bones[PARENT[i]].add(b);
      this.bones.push(b);
    }
    const kit = new Kit(true);
    buildBody(kit);
    const { geometry, materials } = kit.build();
    this.body = new THREE.SkinnedMesh(geometry, materials);
    this.body.name = 'EggGirl_Body';
    this.body.castShadow = true;
    this.body.frustumCulled = false;
    this.body.add(this.bones[0]);
    this.bones[0].updateMatrixWorld(true);
    this.body.bind(new THREE.Skeleton(this.bones));
    this.root.add(this.body);
    this.bodyMats = materials;
    // Backpack in the left hand.
    this.bag = buildBackpack();
    const holder = new THREE.Group();
    holder.name = 'EggBackpack_Holder';
    holder.position.copy(GRIP);
    holder.add(this.bag);
    this.bones[B.wrL].add(holder);
    this.backpack = holder;
    this.bagMats = this.bag.material as THREE.Material[];
    // Ghost ('hint' / 'gone') material set: one translucent golden material for every group.
    this.ghost = ghostMaterial(this.gu);
    this.bodyGhost = this.bodyMats.map(() => this.ghost);
    this.bagGhost = this.bagMats.map(() => this.ghost);
    // Golden egg sparkles orbiting her in 'hint'.
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N_SPARK * 3), 3));
    this.sparkMat = new THREE.PointsMaterial({ map: eggSparkTex(), color: 0xffc84a, size: 0.5 * this.scale, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    this.sparks = new THREE.Points(sg, this.sparkMat);
    this.sparks.name = 'EggGirl_Sparkles';
    this.sparks.frustumCulled = false;
    this.sparks.visible = false;
    this.root.add(this.sparks);
    this.root.scale.setScalar(this.scale);
    this.root.visible = false;
  }

  private setT(b: number, x: number, y: number, z: number): void {
    this.target[b * 3] = x;
    this.target[b * 3 + 1] = y;
    this.target[b * 3 + 2] = z;
  }

  /** Base pose from the reference: right hand on the hip, left hand holding the bag, contrapposto. */
  private poseIdle(t: number): void {
    const br = Math.sin(t * 1.7);
    this.target.fill(0);
    this.setT(B.pelvis, 0, 0, 0.03);
    this.setT(B.spine, 0.02 + br * 0.012, 0, -0.05);
    this.setT(B.neck, 0.06, 0.08, 0.1 + Math.sin(t * 0.6) * 0.03);
    this.setT(B.shR, -0.12, 0, 0.72);
    this.setT(B.elR, 0, 0, -1.95);
    this.setT(B.wrR, 0, 0.2, 0.75);
    this.setT(B.shL, 0.05, 0, -0.14);
    this.setT(B.elL, 0.12, 0, 0.06);
    this.setT(B.wrL, 0, -1.45, 0);
    this.setT(B.hipL, 0, 0, -0.085);
    this.setT(B.knL, 0, 0, 0.055);
    this.setT(B.hipR, 0, 0, 0.02);
    this.setT(B.knR, 0, 0, -0.05);
  }

  update(dt: number, x: number, z: number, heading: number, groundY: number, state: EggGirlState, t: number): void {
    if (state === 'hidden' || (state === 'gone' && t >= GONE_T)) {
      this.root.visible = false;
      this.snap = true;
      return;
    }
    this.root.visible = true;
    this.time += dt;
    const tm = this.time;
    this.root.position.set(x, groundY, z);
    this.root.rotation.y = heading;

    const ghost = state === 'hint' || state === 'gone';
    if (ghost !== this.ghosted) {
      this.ghosted = ghost;
      this.body.material = ghost ? this.bodyGhost : this.bodyMats;
      this.bag.material = ghost ? this.bagGhost : this.bagMats;
      this.body.castShadow = this.bag.castShadow = !ghost;
    }
    this.gu.uTime.value = tm;

    // Pose.
    this.poseIdle(tm);
    let lift = 0;
    let sc = 1;
    let sway = Math.sin(tm * 2.1) * 0.06;
    if (state === 'hint') {
      lift = 0.06 + Math.sin(tm * 1.6) * 0.03;
      this.gu.uOpacity.value = 0.18 + Math.sin(tm * 3.1) * 0.035;
    } else if (state === 'gone') {
      const f = Math.min(1, t / GONE_T);
      this.gu.uOpacity.value = 0.85 * (1 - f) * (1 - f);
      lift = 0.25 * f * f;
      sc = 1 + 0.08 * f;
    } else if (state === 'reveal') {
      const hop = Math.abs(Math.sin(tm * Math.PI * 2 * 1.4));
      this.setT(B.pelvis, 0, 0, 0.03);
      lift = 0.035 * hop;
      if (t < 0.35) sc = 1 + 0.07 * Math.sin((t / 0.35) * Math.PI);
      this.setT(B.shR, 0.1, 0, 2.55);
      this.setT(B.elR, 0, 0, 0.35 + Math.sin(tm * 10) * 0.42);
      this.setT(B.wrR, 0, -1.3, 0);
      this.setT(B.neck, 0.0, 0.1, 0.16 + Math.sin(tm * 2.8) * 0.06);
      this.setT(B.spine, -0.02, 0, -0.08);
      sway = Math.sin(tm * 5) * 0.12;
    } else if (state === 'give') {
      this.setT(B.spine, 0.12, 0, 0);
      this.setT(B.neck, 0.08, 0, 0.12);
      this.setT(B.shL, 1.2, 0, 0.18);
      this.setT(B.elL, 0.3, 0, 0);
      this.setT(B.wrL, 0, -1.45, 0);
      this.setT(B.shR, 0.95, 0, -0.3);
      this.setT(B.elR, 0.55, 0, 0);
      this.setT(B.wrR, 0, 0.6, 0);
      this.setT(B.hipL, 0, 0, -0.06);
      sway = Math.sin(tm * 2.4) * 0.03;
    }
    const k = this.snap ? 1 : 1 - Math.exp(-10 * dt);
    this.snap = false;
    for (let b = 1; b < 14; b++) {
      const r = this.bones[b].rotation;
      r.set(r.x + (this.target[b * 3] - r.x) * k, r.y + (this.target[b * 3 + 1] - r.y) * k, r.z + (this.target[b * 3 + 2] - r.z) * k);
    }
    const pel = this.bones[B.pelvis].position;
    pel.y += (PELVIS_Y + lift - pel.y) * (state === 'reveal' ? 1 : k);
    this.root.scale.setScalar(this.scale * sc);

    // Backpack hangs plumb from the grip whatever the arm does (plus a little pendulum sway).
    _qa.identity();
    for (const b of BAG_CHAIN) _qa.multiply(this.bones[b].quaternion);
    this.backpack.quaternion.copy(_qa).invert().multiply(_qs.setFromAxisAngle(AXIS_Z, sway));

    // Sparkles.
    const showS = ghost;
    this.sparks.visible = showS;
    if (showS) {
      const a = this.sparks.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = a.array as Float32Array;
      const burst = state === 'gone' ? Math.min(1, t / GONE_T) : 0;
      for (let i = 0; i < N_SPARK; i++) {
        const ang = tm * (0.9 + i * 0.06) + (i / N_SPARK) * Math.PI * 2;
        const r = (0.5 + 0.07 * Math.sin(tm * 1.3 + i)) * (1 + burst * 1.2);
        arr[i * 3] = Math.cos(ang) * r;
        arr[i * 3 + 1] = 0.3 + (i / N_SPARK) * 1.55 + 0.12 * Math.sin(tm * 2 + i * 1.7) + burst * 0.5;
        arr[i * 3 + 2] = Math.sin(ang) * r;
      }
      a.needsUpdate = true;
      this.sparkMat.opacity = (0.75 + 0.25 * Math.sin(tm * 6)) * (1 - burst);
    }
  }

  /**
   * Hide the held backpack and return a standalone copy ≈ 0.45 m across (× scale), lying face-up
   * (egg face → +Y, handle → −Z) with its origin at the underside centre, ready to sit on a car roof.
   * The copy owns its geometry (dispose it with the car); materials are shared module-wide.
   */
  makeBackpackCopy(scale = 1): THREE.Object3D {
    this.backpack.visible = false;
    const mesh = buildBackpack();
    mesh.position.set(0, -BAG_CY, 0); // bag centre at the pivot
    const pivot = new THREE.Group();
    pivot.rotation.set(Math.PI / 2, Math.PI, 0, 'YXZ'); // face (−Z) → up, handle → −Z
    pivot.position.y = 0.05;
    pivot.add(mesh);
    const g = new THREE.Group();
    g.name = 'EggBackpack_Copy';
    g.add(pivot);
    g.scale.setScalar((0.45 / (2 * BAG_R)) * scale);
    return g;
  }

  dispose(): void {
    this.root.parent?.remove(this.root);
    this.body.geometry.dispose();
    this.bag.geometry.dispose();
    this.sparks.geometry.dispose();
    this.body.skeleton.dispose();
    this.ghost.dispose();
    this.sparkMat.dispose();
  }
}
