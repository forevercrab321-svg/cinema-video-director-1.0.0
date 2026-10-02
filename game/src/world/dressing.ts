import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Obb } from '../core/collision';
import { createSeededRandom } from '../core/rng';
import { sceneOwned } from '../art/sceneGpu';
import { CURB_HEIGHT } from './scrapCity';

/** What a city asks the dressing pass for: street trees (with the ground height at each) and, for Scrap City, the alley weeds and decals. */
export interface DressingSpec {
  trees: { x: number; z: number; y: number }[];
  scrapAlley?: boolean;
  /** Canopy radius multiplier (plane trees in Paris are broad; Shanghai street trees narrower). */
  crown?: number;
  seed?: number;
  /** Bare, twisted dead trees (Halloween): no canopy, dark bark, some carry a hanging lantern. */
  dead?: boolean;
}

/**
 * Set dressing that makes the city read as lived-in: street trees (leaf-card canopies with
 * outward normals and wind sway), weeds along wall bases and kerbs, and a decal atlas
 * (posters, graffiti, stains). Everything is static and merged: 4 meshes in total.
 */
export interface Dressing {
  meshes: THREE.Object3D[];
  colliders: Obb[];
  /** Advance wind animation (game time, seconds). */
  /** Advance wind (game time, s); canopies closer to the camera than `fadeNear` m dissolve away. */
  update(t: number, fadeNear?: number): void;
}

// ── Canvas textures ──────────────────────────────────────────────────────────
function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = sceneOwned(new THREE.CanvasTexture(c)); // built per city: released with the round's scene
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 4;
  return t;
}

/** A cluster of broad leaves on transparent background (one leaf card). */
function leafTexture(rand: () => number): THREE.CanvasTexture {
  return canvasTexture(256, 256, (g) => {
    g.clearRect(0, 0, 256, 256);
    for (let i = 0; i < 70; i++) {
      const r = Math.sqrt(rand()) * 105;
      const a = rand() * Math.PI * 2;
      const x = 128 + Math.cos(a) * r;
      const y = 128 + Math.sin(a) * r;
      const s = 10 + rand() * 12;
      const hue = 78 + rand() * 38;
      const light = 22 + rand() * 20;
      g.save();
      g.translate(x, y);
      g.rotate(rand() * Math.PI * 2);
      g.fillStyle = `hsl(${hue}, ${40 + rand() * 25}%, ${light}%)`;
      g.beginPath();
      g.ellipse(0, 0, s, s * 0.52, 0, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = `hsla(${hue}, 30%, ${light - 10}%, 0.8)`;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(-s, 0);
      g.lineTo(s, 0);
      g.stroke();
      g.restore();
    }
  });
}

/** Weed blades, drawn into atlas cell 15 (x, y = cell origin, 256 px). */
function drawGrass(g: CanvasRenderingContext2D, x: number, y: number, rand: () => number): void {
  g.clearRect(x, y, 256, 256);
  for (let i = 0; i < 38; i++) {
    const bx = x + 40 + rand() * 176;
    const hgt = 80 + rand() * 150;
    const lean = (rand() - 0.5) * 60;
    g.strokeStyle = `hsl(${60 + rand() * 45}, ${30 + rand() * 30}%, ${22 + rand() * 22}%)`;
    g.lineWidth = 3 + rand() * 5;
    g.beginPath();
    g.moveTo(bx, y + 252);
    g.quadraticCurveTo(bx + lean * 0.3, y + 252 - hgt * 0.6, bx + lean, y + 252 - hgt);
    g.stroke();
  }
}

/** Decal atlas, 4 × 4 cells of 256 px: posters, graffiti tags, stains, signage, weeds (cell 15). */
function decalAtlas(rand: () => number): THREE.CanvasTexture {
  return canvasTexture(1024, 1024, (g) => {
    g.clearRect(0, 0, 1024, 1024);
    const cell = (i: number, draw: (x: number, y: number) => void) => draw((i % 4) * 256, Math.floor(i / 4) * 256);
    const posters = [
      ['#d9432b', '#f3e6c8', 'LIVE', 'FRI 9PM'],
      ['#1f4e79', '#f2d24b', 'SALE', '50% OFF'],
      ['#f0e6d2', '#222222', 'LOST CAT', 'CALL 555-0142'],
      ['#2e6b3f', '#f5f0e0', 'MARKET', 'SUNDAYS'],
    ];
    posters.forEach(([bg, fg, title, sub], i) =>
      cell(i, (x, y) => {
        g.save();
        g.translate(x + 128, y + 128);
        g.rotate((rand() - 0.5) * 0.08);
        g.fillStyle = bg;
        g.fillRect(-88, -118, 176, 236);
        g.fillStyle = fg;
        g.font = 'bold 44px system-ui, sans-serif';
        g.textAlign = 'center';
        g.fillText(title, 0, -40);
        g.font = '24px system-ui, sans-serif';
        g.fillText(sub, 0, 10);
        g.fillRect(-60, 40, 120, 6);
        g.fillRect(-60, 60, 90, 6);
        // wear: torn corner + fading
        g.globalCompositeOperation = 'destination-out';
        g.beginPath();
        g.moveTo(88, 118);
        g.lineTo(88 - 30 - rand() * 30, 118);
        g.lineTo(88, 118 - 30 - rand() * 40);
        g.fill();
        g.globalAlpha = 0.35;
        for (let k = 0; k < 40; k++) g.fillRect(-88 + rand() * 176, -118 + rand() * 236, 3 + rand() * 10, 2 + rand() * 6);
        g.restore();
      }),
    );
    // Graffiti tags (4 cells): thick outlined scribbles.
    for (let i = 4; i < 8; i++)
      cell(i, (x, y) => {
        const hue = [350, 200, 45, 280][i - 4];
        g.lineCap = 'round';
        g.lineJoin = 'round';
        const pts = Array.from({ length: 9 }, (_, k) => [x + 30 + k * 24 + rand() * 10, y + 90 + rand() * 90] as const);
        for (const [w, col] of [[26, '#111'], [16, `hsl(${hue}, 70%, 55%)`]] as const) {
          g.strokeStyle = col;
          g.lineWidth = w;
          g.beginPath();
          g.moveTo(pts[0][0], pts[0][1]);
          for (let k = 1; k < pts.length; k++) g.quadraticCurveTo(pts[k][0] - 12, pts[k][1] - 40 * (k % 2 ? 1 : -1), pts[k][0], pts[k][1]);
          g.stroke();
        }
        g.fillStyle = `hsla(${hue}, 70%, 55%, 0.6)`;
        for (let k = 0; k < 30; k++) g.fillRect(x + 20 + rand() * 216, y + 190 + rand() * 50, 2, 2 + rand() * 12); // drips
      });
    // Stains (4 cells): soft dark blotches with transparent falloff (ground oil, wall damp).
    for (let i = 8; i < 12; i++)
      cell(i, (x, y) => {
        for (let k = 0; k < 9; k++) {
          const r = 18 + rand() * 60;
          const reach = 124 - r; // keep every blotch inside its cell so the quad edge never shows
          const cx = x + 128 + (rand() * 2 - 1) * reach;
          const cy = y + 128 + (rand() * 2 - 1) * reach;
          const grd = g.createRadialGradient(cx, cy, 0, cx, cy, r);
          const tone = i === 11 ? '40, 55, 35' : '20, 18, 16';
          grd.addColorStop(0, `rgba(${tone}, ${0.07 + rand() * 0.09})`);
          grd.addColorStop(1, `rgba(${tone}, 0)`);
          g.fillStyle = grd;
          g.fillRect(x, y, 256, 256);
        }
      });
    // Signage (3 cells).
    const signs: [string, string, string][] = [
      ['#b3261e', '#ffffff', 'NO PARKING'],
      ['#ffffff', '#111111', 'LOADING ZONE'],
      ['#1d5f2e', '#ffffff', 'MAIN ST'],
    ];
    signs.forEach(([bg, fg, text], i) =>
      cell(12 + i, (x, y) => {
        g.fillStyle = bg;
        g.fillRect(x + 16, y + 80, 224, 96);
        g.strokeStyle = fg;
        g.lineWidth = 6;
        g.strokeRect(x + 26, y + 90, 204, 76);
        g.fillStyle = fg;
        g.font = 'bold 30px system-ui, sans-serif';
        g.textAlign = 'center';
        g.fillText(text, x + 128, y + 138);
      }),
    );
    cell(15, (x, y) => drawGrass(g, x, y, rand));
  });
}

// ── Geometry helpers ─────────────────────────────────────────────────────────
function quad(w: number, h: number, u0: number, v0: number, u1: number, v1: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  return g;
}
const atlasCell = (i: number, sub = 1) => {
  const cx = i % 4;
  const cy = Math.floor(i / 4);
  const pad = sub === 1 ? 0.003 : 0;
  return [cx / 4 + pad, 1 - (cy + 1) / 4 + pad, (cx + 1) / 4 - pad, 1 - cy / 4 - pad] as const;
};

// ── Build ────────────────────────────────────────────────────────────────────
export function buildDressing(spec: DressingSpec): Dressing {
  const rand = createSeededRandom(spec.seed ?? 8080);
  const meshes: THREE.Object3D[] = [];
  const colliders: Obb[] = [];

  // Street trees: sidewalk south (between lamp posts) and the parking-lot perimeter.
  const trees: [number, number, number][] = spec.trees.map((t) => [t.x, t.z, t.y]);
  const trunkParts: THREE.BufferGeometry[] = [];
  const leafParts: THREE.BufferGeometry[] = [];
  const pitParts: THREE.BufferGeometry[] = [];
  const lanternParts: THREE.BufferGeometry[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  /** Tapered branch segment between two points. */
  const segment = (a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number) => {
    const dir = b.clone().sub(a);
    const g = new THREE.CylinderGeometry(rb, ra, dir.length(), 5);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir.normalize()));
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    trunkParts.push(g);
  };
  /** Dead tree: crooked trunk in three kinks, five gnarled limbs that fork once, maybe a lantern. */
  const deadTree = (tx: number, tz: number, base: number) => {
    const h = 3.6 + rand() * 1.6;
    trunkParts.push(new THREE.CylinderGeometry(0.2, 0.34, 0.45, 7).translate(tx, base + 0.22, tz)); // root flare
    const lean = new THREE.Vector3((rand() - 0.5) * 0.6, 0, (rand() - 0.5) * 0.6);
    let p = new THREE.Vector3(tx, base, tz);
    let r = 0.21;
    const knots: { p: THREE.Vector3; r: number }[] = [];
    for (let k = 0; k < 3; k++) {
      const next = p.clone().add(new THREE.Vector3(lean.x * 0.4 + (rand() - 0.5) * 0.35, h / 3, lean.z * 0.4 + (rand() - 0.5) * 0.35));
      segment(p, next, r, r * 0.72);
      p = next;
      r *= 0.72;
      knots.push({ p: p.clone(), r });
    }
    let lantern = rand() < 0.4;
    for (let bI = 0; bI < 5; bI++) {
      const from = knots[bI < 2 ? 1 : 2];
      const a = (bI / 5) * Math.PI * 2 + rand() * 0.9;
      let q = from.p.clone();
      let rr = from.r * 0.8;
      let dir = new THREE.Vector3(Math.cos(a), 0.45 + rand() * 0.5, Math.sin(a)).normalize();
      for (let s = 0; s < 3; s++) {
        const len = (1.0 - s * 0.22) * (0.8 + rand() * 0.4);
        const next = q.clone().addScaledVector(dir, len);
        segment(q, next, rr, rr * 0.62);
        if (s === 1) {
          // One fork that kinks the other way.
          const fd = dir.clone().applyAxisAngle(up, (rand() < 0.5 ? -1 : 1) * (0.7 + rand() * 0.5)).setY(dir.y + 0.25).normalize();
          segment(next, next.clone().addScaledVector(fd, 0.7), rr * 0.6, rr * 0.25);
        }
        if (s === 0 && lantern && dir.y < 0.75) {
          // A jack-o'-lantern hanging on a cord from the first limb.
          const hang = q.clone().lerp(next, 0.75);
          trunkParts.push(new THREE.CylinderGeometry(0.008, 0.008, 0.6, 3).translate(hang.x, hang.y - 0.3, hang.z));
          lanternParts.push(new THREE.SphereGeometry(0.2, 10, 7).scale(1, 0.8, 1).translate(hang.x, hang.y - 0.72, hang.z));
          lantern = false;
        }
        q = next;
        rr *= 0.62;
        dir = dir.applyAxisAngle(up, (rand() - 0.5) * 1.1).setY(dir.y + (rand() - 0.35) * 0.5).normalize();
      }
    }
  };
  for (const [tx, tz, base] of trees) {
    if (spec.dead) {
      pitParts.push(new THREE.BoxGeometry(1.2, 0.03, 1.2).translate(tx, base + 0.015, tz));
      colliders.push({ cx: tx, cz: tz, hx: 0.24, hz: 0.24, yaw: 0 });
      deadTree(tx, tz, base);
      continue;
    }
    const h = 2.6 + rand() * 0.8;
    const trunk = new THREE.CylinderGeometry(0.1, 0.17, h, 8).translate(tx, base + h / 2, tz);
    trunkParts.push(trunk);
    pitParts.push(new THREE.BoxGeometry(1.2, 0.03, 1.2).translate(tx, base + 0.015, tz));
    colliders.push({ cx: tx, cz: tz, hx: 0.2, hz: 0.2, yaw: 0 });
    // Branches into the crown.
    const crown = new THREE.Vector3(tx + (rand() - 0.5) * 0.4, base + h + 1.6 + rand() * 0.6, tz + (rand() - 0.5) * 0.4);
    const radius = (1.9 + rand() * 0.6) * (spec.crown ?? 1);
    for (let b = 0; b < 5; b++) {
      const a = (b / 5) * Math.PI * 2 + rand();
      const from = new THREE.Vector3(tx, base + h * (0.8 + rand() * 0.2), tz);
      const to = crown.clone().add(new THREE.Vector3(Math.cos(a) * radius * 0.6, rand() * 0.8, Math.sin(a) * radius * 0.6));
      const dir = to.clone().sub(from);
      const br = new THREE.CylinderGeometry(0.035, 0.07, dir.length(), 5);
      br.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir.clone().normalize()));
      br.translate((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
      trunkParts.push(br);
    }
    // Canopy: ~170 leaf cards in a squashed ellipsoid, normals pointing out of the crown so the
    // foliage shades like a volume instead of flat planes. Vertex colour = per-card tint + AO.
    for (let i = 0; i < 170; i++) {
      const dir = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize();
      const r = radius * Math.cbrt(0.35 + rand() * 0.65);
      const p = crown.clone().add(new THREE.Vector3(dir.x * r, dir.y * r * 0.72, dir.z * r));
      const size = 0.85 + rand() * 0.55;
      const card = new THREE.PlaneGeometry(size, size);
      card.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI)));
      card.translate(p.x, p.y, p.z);
      const outward = p.clone().sub(crown).normalize();
      const n = card.getAttribute('normal');
      const col = new Float32Array(n.count * 3);
      const depth = r / radius; // inner cards darker (self-shadowing)
      const tint = 0.75 + rand() * 0.35;
      for (let k = 0; k < n.count; k++) {
        n.setXYZ(k, outward.x, outward.y * 0.8 + 0.2, outward.z);
        const ao = 0.45 + 0.55 * depth * (0.6 + 0.4 * Math.max(0, outward.y));
        col.set([tint * ao, tint * ao * (0.95 + rand() * 0.1), tint * ao * 0.8], k * 3);
      }
      card.setAttribute('color', new THREE.BufferAttribute(col, 3));
      leafParts.push(card);
    }
  }
  // Trunks, tree-pit soil and the street-sign pole share one vertex-coloured rough material.
  const paint = (g: THREE.BufferGeometry, hex: number) => {
    const c = new THREE.Color(hex);
    const n = g.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) col.set([c.r, c.g, c.b], k * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  };
  const woodParts = [
    ...trunkParts.map((g) => paint(g, spec.dead ? 0x3a3130 : 0x4a3c30)),
    ...pitParts.map((g) => paint(g, 0x3b2f25)),
    ...(spec.scrapAlley ? [paint(new THREE.CylinderGeometry(0.035, 0.035, 3.1, 8).translate(4.3, CURB_HEIGHT + 1.55, -2.34), 0x6a6f74)] : []), // sign pole
  ];
  const bark = new THREE.MeshStandardMaterial({ name: 'MAT_TreeBarkSoil', vertexColors: true, roughness: 0.92 });
  const trunkMesh = new THREE.Mesh(mergeGeometries(woodParts)!, bark);
  trunkMesh.name = 'DRESS_TreeTrunks';
  trunkMesh.castShadow = trunkMesh.receiveShadow = true;
  if (spec.scrapAlley) colliders.push({ cx: 4.3, cz: -2.34, hx: 0.06, hz: 0.06, yaw: 0 });

  const leafUniforms = { uTime: { value: 0 }, uFadeNear: { value: 0 } };
  const leaves = new THREE.MeshStandardMaterial({
    name: 'MAT_Leaves',
    map: leafTexture(rand),
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    vertexColors: true,
    roughness: 0.8,
    envMapIntensity: 0.6,
  });
  leaves.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = leafUniforms.uTime;
    shader.uniforms.uFadeNear = leafUniforms.uFadeNear;
    // Camera-side canopies dissolve (screen-door) so a tree never hides the machine.
    shader.fragmentShader = 'uniform float uFadeNear;\n' + shader.fragmentShader.replace(
      '#include <alphatest_fragment>',
      `#include <alphatest_fragment>
       float camD = length(vViewPosition);
       float keep = smoothstep(uFadeNear * 0.6, uFadeNear, camD);
       if (keep < 1.0 && fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453) > keep) discard;`,
    );
    shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       float sway = sin(uTime * 1.3 + position.x * 0.35 + position.z * 0.27) * 0.06 + sin(uTime * 3.1 + position.y * 2.0) * 0.015;
       transformed.x += sway * (position.y - 2.0) * 0.25;
       transformed.z += sway * 0.6 * (position.y - 2.0) * 0.25;`,
    );
  };
  leaves.customProgramCacheKey = () => 'leaves-sway';
  const leafMesh = new THREE.Mesh(leafParts.length ? mergeGeometries(leafParts)! : new THREE.BufferGeometry(), leaves);
  leafMesh.name = 'DRESS_TreeCanopies';
  leafMesh.castShadow = leafMesh.receiveShadow = true;
  leafMesh.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: leaves.map, alphaTest: 0.5 });
  meshes.push(trunkMesh);
  if (leafParts.length) meshes.push(leafMesh);
  if (lanternParts.length) {
    const glow = new THREE.MeshStandardMaterial({ name: 'MAT_TreeLanterns', color: 0xa8460c, emissive: 0xff7414, emissiveIntensity: 1.9, roughness: 0.55 });
    const lanterns = new THREE.Mesh(mergeGeometries(lanternParts)!, glow);
    lanterns.name = 'DRESS_TreeLanterns';
    meshes.push(lanterns);
  }

  // Weeds: crossed grass cards along the alley wall bases, kerb lines and tree pits.
  // Weeds and decals share one atlas texture (weeds live in cell 15).
  const atlas = decalAtlas(rand);
  const [gu0, gv0, gu1, gv1] = atlasCell(15);
  const grassParts: THREE.BufferGeometry[] = [];
  const tuft = (x: number, y: number, z: number, s: number) => {
    for (let k = 0; k < 2; k++) {
      const q = quad(0.5 * s, 0.4 * s, gu0, gv0, gu1, gv1).translate(0, 0.2 * s, 0);
      q.rotateY(k * Math.PI / 2 + rand());
      q.translate(x, y, z);
      const n = q.getAttribute('normal');
      for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
      grassParts.push(q);
    }
  };
  if (spec.scrapAlley) {
  for (let z = 1; z < 35.5; z += 0.9) {
      if (rand() < 0.55) tuft(-3.42 + rand() * 0.12, 0, z + rand() * 0.6, 0.6 + rand() * 0.8);
      if (rand() < 0.55) tuft(3.42 - rand() * 0.12, 0, z + rand() * 0.6, 0.6 + rand() * 0.8);
    }
    for (let x = -44; x < 44; x += 1.3) {
      if (rand() < 0.3) tuft(x, 0, -9.5 + 0.12, 0.5 + rand() * 0.6);
      if (rand() < 0.3) tuft(x, 0, -2.5 - 0.12, 0.5 + rand() * 0.6);
      if (rand() < 0.5) tuft(x, 0, -40.2 + rand() * 0.5, 0.7 + rand() * 1.0);
    }
  }
  for (const [tx, tz, ty] of trees) for (let k = 0; k < 5; k++) tuft(tx + (rand() - 0.5) * 1.0, ty + 0.03, tz + (rand() - 0.5) * 1.0, 0.5 + rand() * 0.6);
  const grass = new THREE.MeshStandardMaterial({ name: 'MAT_Weeds', map: atlas, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.9, envMapIntensity: 0.5 });
  const grassMesh = new THREE.Mesh(mergeGeometries(grassParts)!, grass);
  grassMesh.name = 'DRESS_Weeds';
  grassMesh.receiveShadow = true;
  meshes.push(grassMesh);

  // Decals: posters and graffiti on alley walls, signage, stains on walls and ground.
  const decalParts: THREE.BufferGeometry[] = [];
  const wallDecal = (cellIndex: number, x: number, y: number, z: number, face: 1 | -1, w: number, h: number) => {
    const [u0, v0, u1, v1] = atlasCell(cellIndex);
    const q = quad(w, h, u0, v0, u1, v1);
    q.rotateY(face > 0 ? Math.PI / 2 : -Math.PI / 2);
    q.translate(x + face * 0.012, y, z);
    decalParts.push(q);
  };
  const groundDecal = (cellIndex: number, x: number, y: number, z: number, s: number) => {
    const [u0, v0, u1, v1] = atlasCell(cellIndex);
    const q = quad(s, s, u0, v0, u1, v1);
    q.rotateX(-Math.PI / 2);
    q.rotateY(rand() * Math.PI * 2);
    q.translate(x, y, z);
    decalParts.push(q);
  };
  if (spec.scrapAlley) {
    // Alley west wall (x = −3.5, facing +x) and east wall (x = +3.5, facing −x).
    for (const [z, cellIndex, s] of [[29, 0, 0.9], [29.8, 1, 0.9], [20.5, 2, 0.8], [5, 3, 0.9], [5.9, 0, 0.9]] as const) wallDecal(cellIndex, -3.5, 1.6, z, 1, 0.62 * s, 0.85 * s);
    for (const [z, cellIndex, s] of [[26.5, 4, 2.6], [12, 5, 3.0], [3.5, 6, 2.4]] as const) wallDecal(cellIndex, 3.5, 1.2, z, -1, s, s * 0.6);
    for (const [z, cellIndex, s] of [[31, 7, 2.8], [18, 4, 2.2]] as const) wallDecal(cellIndex, -3.5, 1.1, z, 1, s, s * 0.6);
    for (let z = 2; z < 35; z += 3.1) {
      if (rand() < 0.6) wallDecal(8 + Math.floor(rand() * 3), -3.5, 0.9 + rand() * 0.6, z, 1, 2.2, 1.8);
      if (rand() < 0.6) wallDecal(8 + Math.floor(rand() * 3), 3.5, 0.9 + rand() * 0.6, z, -1, 2.2, 1.8);
    }
    wallDecal(12, -3.5, 2.6, 33.2, 1, 0.9, 0.4); // NO PARKING
    wallDecal(13, 3.5, 2.7, 16.9, -1, 1.0, 0.45); // LOADING ZONE
    for (let k = 0; k < 26; k++) groundDecal(8 + Math.floor(rand() * 3), (rand() - 0.5) * 6, 0.016, 2 + rand() * 33, 1.2 + rand() * 1.8); // alley grime
    for (let k = 0; k < 18; k++) groundDecal(8 + Math.floor(rand() * 2), (rand() - 0.5) * 50, 0.016, -24 - rand() * 12, 1.5 + rand() * 1.5); // lot oil
    for (let k = 0; k < 8; k++) groundDecal(11, (rand() - 0.5) * 80, 0.016, -9.2 + rand() * 0.4, 1.0); // damp/moss along the south kerb
    // Street name sign on a pole at the alley mouth corner.
    const [u0, v0, u1, v1] = atlasCell(14);
    decalParts.push(quad(0.9, 0.4, u0, v0, u1, v1).rotateY(Math.PI).translate(4.3, CURB_HEIGHT + 2.9, -2.35));
    decalParts.push(quad(0.9, 0.4, u0, v0, u1, v1).translate(4.3, CURB_HEIGHT + 2.9, -2.33));
  }
  const decals = new THREE.MeshStandardMaterial({
    name: 'MAT_Decals',
    map: atlas,
    transparent: true,
    depthWrite: false,
    roughness: 0.85,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  if (decalParts.length) {
    const decalMesh = new THREE.Mesh(mergeGeometries(decalParts)!, decals);
    decalMesh.name = 'DRESS_Decals';
    decalMesh.receiveShadow = true;
    decalMesh.renderOrder = 2;
    meshes.push(decalMesh);
  }

  return {
    meshes,
    colliders,
    update(t: number, fadeNear = 0) {
      leafUniforms.uTime.value = t;
      leafUniforms.uFadeNear.value = fadeNear;
    },
  };
}
