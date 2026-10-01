import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Palette } from '../../art/environment';
import type { MaterialLibrary } from '../../art/materials';
import { OBJECT_TYPES, type ObjectTypeId } from '../../config/objects';
import { createSeededRandom } from '../../core/rng';
import { Batch, facade, type ArchKey } from '../architecture';
import type { CityBuild, CityDef, SpawnPoint } from '../city';
import type { Cluster, Placement, StaticBlock } from '../scrapCity';

/**
 * WORLD CITY KIT — one parametric street plan that every world city is generated from.
 * Real-world metres, −Z = north. A 192 m square district:
 *
 *            │  street x=−56 │ boulevard x=0 │ street x=+56 │
 *     z=−56 ─┼───────────────┼───────────────┼──────────────┼─ street (14 m)
 *            │  block        │   block       │   block      │
 *     z=0   ─┼───────────────(  PLAZA r 30  )┼──────────────┼─ boulevard (20 m)
 *            │  block        │   block       │   block      │
 *     z=+56 ─┼───────────────┼───────────────┼──────────────┼─ street
 *
 * The landmark stands in the central plaza, visible down all four boulevards from every
 * spawn (§22: show the goal first). Blocks are lined with destructible buildings facing the
 * streets (class 7 houses, class 8 blocks near the plaza); roads carry parked vehicles; the
 * sidewalks carry street furniture and loose debris. The district is closed by static
 * facades just outside the bounds and a far skyline. Everything is seeded, so all players
 * generate the same city.
 */
export interface CityStyle {
  id: string;
  name: string;
  nameZh: string;
  tagline: string;
  taglineZh?: string;
  level: number;
  palette: Palette;
  seed: number;
  climaxName: string;
  climaxNameZh: string;
  landmark: () => Placement[];
  /** Class-7 houses and class-8 blocks lining the streets (weighted by repetition). */
  houses: ObjectTypeId[];
  blocks: ObjectTypeId[];
  /** Parked kerbside (class 5) and in-lane big vehicles (class 6). */
  cars: ObjectTypeId[];
  bigVehicles: ObjectTypeId[];
  /** Sidewalk furniture (class 3–5), weighted by repetition. */
  furniture: ObjectTypeId[];
  /** Static perimeter facades (arch materials) and their height range. */
  perimeter: { materials: StaticBlock['material'][]; h: [number, number] };
  /** Far skyline: count, height range, plus optional hero silhouettes. */
  skyline: { n: number; h: [number, number]; heroes?: Hero[] };
  /** Centre-line paint (NY / Shanghai yellow, Paris white). */
  centreLine: 'yellow' | 'white';
  /** Park cell ground: gravel (Paris) or paving. */
  parkGround: 'gravel' | 'sidewalk';
  treeCrown: number;
  /** Hand-placed secondary landmarks and signature objects, placed before the procedural fill. */
  extras?: Placement[];
  /** A river along one edge instead of perimeter facades (Shanghai: the Huangpu, Pudong beyond). */
  waterfront?: 'east';
  /** Strings of red lanterns across the side streets (Shanghai). */
  lanterns?: boolean;
}

/** Distant signature towers, shaped by kind (all far enough to read as silhouettes through haze). */
export interface Hero {
  x: number;
  z: number;
  w: number;
  h: number;
  taper?: number;
  kind?: 'box' | 'twist' | 'opener' | 'pagoda' | 'obelisk' | 'arch';
}

export const HALF = 96;
const BLVD = 20;
const STREET = 14;
const WALK = 4;
const CURB = 0.12;
export const PLAZA_R = 30;

/** Road centre lines: [position, width]; the same set runs along X and along Z. */
const ROADS: [number, number][] = [
  [-56, STREET],
  [0, BLVD],
  [56, STREET],
];
/** Off-road cells between the roads along one axis. */
const CELLS: [number, number][] = [
  [-HALF, -56 - STREET / 2],
  [-56 + STREET / 2, -BLVD / 2],
  [BLVD / 2, 56 - STREET / 2],
  [56 + STREET / 2, HALF],
];

/** Hot path (ground height under every machine and solid test): no allocation. */
function onRoad(x: number, z: number): boolean {
  if (x * x + z * z < PLAZA_R * PLAZA_R) return false;
  for (let i = 0; i < ROADS.length; i++) {
    const c = ROADS[i][0];
    const h = ROADS[i][1] / 2;
    if (Math.abs(x - c) < h || Math.abs(z - c) < h) return true;
  }
  return false;
}

/** Roads are at street level; sidewalks, blocks and the plaza are kerb-raised. */
export function cityGroundHeight(x: number, z: number): number {
  return onRoad(x, z) ? 0 : CURB;
}

const Q = Math.PI / 2;
/** Yaw that turns an object's front (−Z) toward direction (nx, nz). */
const faceYaw = (nx: number, nz: number) => Math.atan2(-nx, -nz);

interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export function makeCity(style: CityStyle): CityDef {
  const rand = createSeededRandom(style.seed);
  const placements: Placement[] = [...style.landmark()];
  const clusters: Cluster[] = [];
  const trees: { x: number; z: number; y: number }[] = [];
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
  const taken: Rect[] = [];
  const free = (r: Rect, pad: number) => !taken.some((t) => r.x0 < t.x1 + pad && r.x1 > t.x0 - pad && r.z0 < t.z1 + pad && r.z1 > t.z0 - pad);
  const inPlaza = (r: Rect, pad: number) => {
    const cx = THREE.MathUtils.clamp(0, r.x0, r.x1);
    const cz = THREE.MathUtils.clamp(0, r.z0, r.z1);
    return Math.hypot(cx, cz) < PLAZA_R + pad;
  };
  const place = (type: ObjectTypeId, x: number, z: number, yaw: number) => {
    placements.push({ type, x, z, yaw });
    const [w, , d] = OBJECT_TYPES[type].size;
    const rot = Math.abs(Math.sin(yaw)) > 0.7;
    const hw = (rot ? d : w) / 2;
    const hd = (rot ? w : d) / 2;
    taken.push({ x0: x - hw, x1: x + hw, z0: z - hd, z1: z + hd });
  };
  const fits = (type: ObjectTypeId, x: number, z: number, yaw: number, pad: number) => {
    const [w, , d] = OBJECT_TYPES[type].size;
    const rot = Math.abs(Math.sin(yaw)) > 0.7;
    const r = { x0: x - (rot ? d : w) / 2, x1: x + (rot ? d : w) / 2, z0: z - (rot ? w : d) / 2, z1: z + (rot ? w : d) / 2 };
    return free(r, pad) && !inPlaza(r, 2) && r.x0 > -HALF + 0.5 && r.x1 < HALF - 0.5 && r.z0 > -HALF + 0.5 && r.z1 < HALF - 0.5;
  };
  // Landmark footprint is reserved.
  taken.push({ x0: -16, x1: 16, z0: -16, z1: 16 });
  for (const p of style.extras ?? []) {
    placements.push(p);
    if ((p.y ?? 0) > 0.5) continue;
    const [w, , d] = OBJECT_TYPES[p.type].size;
    const rot = Math.abs(Math.sin(p.yaw ?? 0)) > 0.7;
    taken.push({ x0: p.x - (rot ? d : w) / 2, x1: p.x + (rot ? d : w) / 2, z0: p.z - (rot ? w : d) / 2, z1: p.z + (rot ? w : d) / 2 });
  }

  // ── Cells: 4 × 4 blocks. Pick a park and a construction site among the outer cells. ──
  const cells: { r: Rect; ix: number; iz: number }[] = [];
  CELLS.forEach(([x0, x1], ix) => CELLS.forEach(([z0, z1], iz) => cells.push({ r: { x0, x1, z0, z1 }, ix, iz })));
  const outer = cells.filter((c) => c.ix === 0 || c.ix === 3 || c.iz === 0 || c.iz === 3);
  const park = outer[Math.floor(rand() * outer.length)];
  const siteChoices = outer.filter((c) => c !== park && Math.abs(c.ix - park.ix) + Math.abs(c.iz - park.iz) > 2);
  const site = siteChoices[Math.floor(rand() * siteChoices.length)];

  for (const cell of cells) {
    const { r } = cell;
    const inner = (cell.ix === 1 || cell.ix === 2) && (cell.iz === 1 || cell.iz === 2);
    if (cell === park) {
      parkCell(r);
      continue;
    }
    if (cell === site) {
      siteCell(r);
      continue;
    }
    // Buildings along every edge that faces a road (fronts toward the street).
    const edges: { nx: number; nz: number; line: number; a0: number; a1: number }[] = [];
    if (r.x0 > -HALF + 1) edges.push({ nx: -1, nz: 0, line: r.x0, a0: r.z0, a1: r.z1 });
    if (r.x1 < HALF - 1) edges.push({ nx: 1, nz: 0, line: r.x1, a0: r.z0, a1: r.z1 });
    if (r.z0 > -HALF + 1) edges.push({ nx: 0, nz: -1, line: r.z0, a0: r.x0, a1: r.x1 });
    if (r.z1 < HALF - 1) edges.push({ nx: 0, nz: 1, line: r.z1, a0: r.x0, a1: r.x1 });
    for (const e of edges) {
      let a = e.a0 + WALK + 1.5;
      while (a < e.a1 - WALK - 4) {
        const type = inner && rand() < 0.6 ? pick(style.blocks) : rand() < 0.18 ? pick(style.blocks) : pick(style.houses);
        const [w, , d] = OBJECT_TYPES[type].size;
        const along = a + w / 2;
        if (along + w / 2 > e.a1 - WALK - 1) break;
        const inset = WALK + d / 2 + 0.4;
        const x = e.nx ? e.line - e.nx * inset : along;
        const z = e.nz ? e.line - e.nz * inset : along;
        const yaw = faceYaw(e.nx, e.nz);
        if (fits(type, x, z, yaw, 1.2)) {
          place(type, x, z, yaw);
          a += w + (rand() < 0.45 ? 5 + rand() * 4 : 1.5); // alleys between some buildings
        } else a += 3;
      }
    }
    // Courtyard: service bins and loose debris behind the street fronts.
    const cx = (r.x0 + r.x1) / 2;
    const cz = (r.z0 + r.z1) / 2;
    const span = Math.min(r.x1 - r.x0, r.z1 - r.z0);
    for (const [type, n] of [['DUMPSTER', 1], ['TRASH_CAN', 2], ['PALLET', 2], ['DELIVERY_TRUCK', 1], ['CONTAINER', 1], ['VAN', 1]] as const) {
      for (let i = 0; i < n; i++) {
        const x = cx + (rand() - 0.5) * span * 0.4;
        const z = cz + (rand() - 0.5) * span * 0.4;
        const yaw = rand() * Math.PI;
        if (fits(type, x, z, yaw, 0.4)) place(type, x, z, yaw);
      }
    }
    clusters.push(
      { type: 'SCRAP', x: cx, z: cz, radius: span * 0.3, count: 22 },
      { type: 'CARDBOARD_BOX', x: cx, z: cz, radius: span * 0.28, count: 6 },
      { type: 'TRASH_BAG', x: cx, z: cz, radius: span * 0.28, count: 5 },
      { type: 'BRICK', x: cx, z: cz, radius: span * 0.3, count: 10 },
    );
  }

  function parkCell(r: Rect): void {
    const cx = (r.x0 + r.x1) / 2;
    const cz = (r.z0 + r.z1) / 2;
    for (let i = 0; i < 9; i++) {
      const x = cx + (rand() - 0.5) * (r.x1 - r.x0 - 10);
      const z = cz + (rand() - 0.5) * (r.z1 - r.z0 - 10);
      if (trees.every((t) => Math.hypot(t.x - x, t.z - z) > 6)) trees.push({ x, z, y: CURB });
    }
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const x = cx + Math.cos(a) * 9;
      const z = cz + Math.sin(a) * 9;
      const yaw = faceYaw(-Math.cos(a), -Math.sin(a));
      if (fits('BENCH', x, z, yaw, 0.3)) place('BENCH', x, z, yaw);
    }
    for (const [type, n] of [['BICYCLE', 4], ['TRASH_CAN', 3], ['FOOD_CART', 1], ['CAFE_TABLE', 3]] as const) {
      for (let i = 0; i < n; i++) {
        const x = cx + (rand() - 0.5) * 20;
        const z = cz + (rand() - 0.5) * 20;
        if (fits(type, x, z, 0, 0.5)) place(type, x, z, rand() * Math.PI);
      }
    }
    clusters.push(
      { type: 'CAN', x: cx, z: cz, radius: 14, count: 16 },
      { type: 'BOTTLE', x: cx, z: cz, radius: 14, count: 12 },
      { type: 'CARDBOARD_SMALL', x: cx, z: cz, radius: 12, count: 8 },
      { type: 'GOLD_CRATE', x: cx, z: cz, radius: 8, count: 2 },
    );
  }

  function siteCell(r: Rect): void {
    const cx = (r.x0 + r.x1) / 2;
    const cz = (r.z0 + r.z1) / 2;
    const kit: [ObjectTypeId, number, number, number][] = [
      ['EXCAVATOR', -6, -4, 0.6],
      ['CONTAINER', 8, -8, 0],
      ['CONTAINER', 11.5, -8, 0],
      ['SITE_CABIN', -9, 9, Q],
      ['GENERATOR', 5, 6, 0.3],
      ['PIPE_STACK', 1, 10, Q],
      ['SCAFFOLD', 10, 5, Q],
      ['TIPPER_TRUCK', -1, -10, Q],
      ['PALLET_STACK', -3, 3, 0],
      ['PALLET_STACK', -1.5, 3.2, 0.2],
      ['JERSEY_BARRIER', 4, -1, 0],
      ['JERSEY_BARRIER', 4, 2.5, 0],
    ];
    for (const [type, dx, dz, yaw] of kit) if (fits(type, cx + dx, cz + dz, yaw, 0.6)) place(type, cx + dx, cz + dz, yaw);
    clusters.push({ type: 'BRICK', x: cx, z: cz, radius: 12, count: 24 }, { type: 'TRAFFIC_CONE', x: cx, z: cz, radius: 13, count: 8 }, { type: 'PALLET', x: cx, z: cz, radius: 12, count: 5 });
  }

  // ── Roads: parked cars along both kerbs, some traffic stopped at the lights, buses. ──
  const nearJunction = (a: number) => ROADS.some(([c, w]) => Math.abs(a - c) < w / 2 + 7);
  for (const [c, w] of ROADS) {
    for (const axis of ['x', 'z'] as const) {
      for (const side of [-1, 1]) {
        const lane = c + side * (w / 2 - 1.25);
        // Right-hand traffic: the +side lane of an X road runs +X.
        const dir = axis === 'x' ? side : -side;
        const yaw = axis === 'x' ? faceYaw(dir, 0) : faceYaw(0, dir);
        for (let a = -HALF + 6; a < HALF - 6; a += 6.4 + rand() * 1.5) {
          if (nearJunction(a) || rand() < 0.25) continue;
          const type = pick(style.cars);
          const x = axis === 'x' ? a : lane;
          const z = axis === 'x' ? lane : a;
          if (Math.hypot(x, z) < PLAZA_R + 4) continue;
          if (fits(type, x, z, yaw, 0.3)) place(type, x, z, yaw);
        }
        // Stopped traffic in the running lane approaching junctions on the boulevards.
        if (w === BLVD) {
          const run = c + side * (w / 4);
          for (const j of [-56, 56]) {
            for (let k = 0; k < 4; k++) {
              const a = j - dir * (w / 2 + 6 + k * 8);
              const type = k % 2 === 0 && rand() < 0.7 ? pick(style.bigVehicles) : pick(style.cars);
              const x = axis === 'x' ? a : run;
              const z = axis === 'x' ? run : a;
              if (Math.hypot(x, z) > PLAZA_R + 6 && fits(type, x, z, yaw, 0.4)) place(type, x, z, yaw);
            }
          }
        }
      }
    }
  }

  // ── Sidewalks: furniture line, street trees near the kerb, debris clusters. ──
  for (const [c, w] of ROADS) {
    for (const axis of ['x', 'z'] as const) {
      for (const side of [-1, 1]) {
        const kerb = c + side * (w / 2 + 1.0);
        const line = c + side * (w / 2 + 2.6);
        const yaw = axis === 'x' ? faceYaw(0, -side) : faceYaw(-side, 0);
        for (let a = -HALF + 5; a < HALF - 5; a += 7 + rand() * 5) {
          if (nearJunction(a)) continue;
          const x = axis === 'x' ? a : line;
          const z = axis === 'x' ? line : a;
          if (Math.hypot(x, z) < PLAZA_R + 2) continue;
          const type = pick(style.furniture);
          if (fits(type, x, z, yaw, 0.4)) place(type, x, z, yaw);
        }
        if (w === BLVD) {
          for (let a = -HALF + 8; a < HALF - 8; a += 12) {
            if (nearJunction(a)) continue;
            const x = axis === 'x' ? a : kerb;
            const z = axis === 'x' ? kerb : a;
            if (Math.hypot(x, z) > PLAZA_R + 3) trees.push({ x, z, y: CURB });
          }
        }
        for (let a = -HALF + 12; a < HALF - 12; a += 24) {
          if (nearJunction(a)) continue;
          const x = axis === 'x' ? a : c + side * (w / 2 + 2);
          const z = axis === 'x' ? c + side * (w / 2 + 2) : a;
          if (Math.hypot(x, z) < PLAZA_R + 2) continue;
          const t = pick(['CAN', 'BOTTLE', 'SCRAP', 'CARDBOARD_SMALL', 'TRAFFIC_CONE', 'TRASH_BAG'] as const);
          clusters.push({ type: t, x, z, radius: 3, count: t === 'SCRAP' ? 10 : 5 });
        }
      }
    }
  }
  // Plaza ring: benches, kiosks and a ring of food for mid-size machines circling the landmark.
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + 0.13;
    const x = Math.cos(a) * (PLAZA_R - 5);
    const z = Math.sin(a) * (PLAZA_R - 5);
    const type = i % 3 === 0 ? 'KIOSK' : i % 3 === 1 ? 'BENCH' : 'TRASH_CAN';
    const yaw = faceYaw(-Math.cos(a), -Math.sin(a));
    if (fits(type, x, z, yaw, 0.5)) place(type, x, z, yaw);
  }
  clusters.push({ type: 'SCRAP', x: 0, z: 0, radius: PLAZA_R - 2, count: 40 }, { type: 'CAN', x: 0, z: 0, radius: PLAZA_R - 2, count: 20 });

  // ── Static perimeter and spawns ──
  const perimeter: StaticBlock[] = [];
  const faces: { block: StaticBlock; cx: number; cz: number; ry: number; len: number }[] = [];
  const prand = createSeededRandom(style.seed ^ 0x77);
  for (const [nx, nz] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
    if (style.waterfront === 'east' && nx === 1) {
      // Embankment wall along the river (the district edge is a promenade).
      perimeter.push({ name: 'Wall_Embankment', x: HALF + 1.2, z: 0, w: 1.2, d: HALF * 2 + 44, h: 1.1, material: 'concrete' });
      continue;
    }
    // Facades along one side, facing into the district.
    for (let a = -HALF - 22; a < HALF + 22; ) {
      const len = 16 + prand() * 14;
      const depth = 18;
      const h = style.perimeter.h[0] + prand() * (style.perimeter.h[1] - style.perimeter.h[0]);
      const mid = a + len / 2;
      const off = HALF + 0.5 + depth / 2;
      const block: StaticBlock = {
        name: `Bldg_Perimeter_${nx}${nz}_${Math.round(a)}`,
        x: nx ? nx * off : mid,
        z: nz ? nz * off : mid,
        w: nx ? depth : len - 0.3,
        d: nx ? len - 0.3 : depth,
        h,
        material: style.perimeter.materials[Math.floor(prand() * style.perimeter.materials.length)],
      };
      perimeter.push(block);
      faces.push({ block, cx: nx ? nx * (HALF + 0.5) : mid, cz: nz ? nz * (HALF + 0.5) : mid, ry: Math.atan2(-nx, -nz), len: len - 0.3 });
      a += len;
    }
  }
  const spawns: SpawnPoint[] = [
    { x: 0, z: HALF - 8, heading: 0 },
    { x: 0, z: -HALF + 8, heading: Math.PI },
    { x: -HALF + 8, z: 0, heading: -Q },
    { x: HALF - 8, z: 0, heading: Q },
  ];

  return {
    id: style.id,
    name: style.name,
    nameZh: style.nameZh,
    tagline: style.tagline,
    taglineZh: style.taglineZh,
    level: style.level,
    palette: style.palette,
    bounds: { minX: -HALF, maxX: HALF, minZ: -HALF, maxZ: HALF },
    staticBlocks: perimeter,
    placements,
    clusters,
    groundHeight: cityGroundHeight,
    spawn: spawns[0],
    spawns,
    build: (lib) => buildDistrict(lib, style, perimeter, faces),
    dressing: { trees, crown: style.treeCrown, seed: style.seed },
    climaxName: style.climaxName,
    climaxNameZh: style.climaxNameZh,
  };
}

// ── Static district: ground, roads, markings, kerbs, lights, perimeter facades, skyline ──
function buildDistrict(lib: MaterialLibrary, style: CityStyle, perimeter: StaticBlock[], faces: { block: StaticBlock; cx: number; cz: number; ry: number; len: number }[]): CityBuild {
  const batch = new Batch();
  const occluders: THREE.Object3D[] = [];
  const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
  const WALL: Record<StaticBlock['material'], ArchKey> = { brick: 'brick', darkBrick: 'darkBrick', plaster: 'plaster', concrete: 'concrete', steel: 'steelDark' };

  // Ground: city ground under everything, asphalt road bed, raised cells and plaza.
  const east = style.waterfront === 'east' ? HALF + 2 : 350;
  batch.add('gravel', box(350 + east, 0.02, 700), (east - 350) / 2, -0.03, 0);
  batch.add('asphalt', box(Math.min(east, HALF + 20) + HALF + 20, 0.02, HALF * 2 + 40), (Math.min(east, HALF + 20) - HALF - 20) / 2, -0.01, 0);
  CELLS.forEach(([x0, x1], ix) =>
    CELLS.forEach(([z0, z1], iz) => {
      const w = x1 - x0;
      const d = z1 - z0;
      batch.add('sidewalk', box(w, CURB, d), (x0 + x1) / 2, CURB / 2, (z0 + z1) / 2);
      // Kerb stones along the four edges.
      for (const [x, z, kw, kd] of [
        [(x0 + x1) / 2, z0, w, 0.18],
        [(x0 + x1) / 2, z1, w, 0.18],
        [x0, (z0 + z1) / 2, 0.18, d],
        [x1, (z0 + z1) / 2, 0.18, d],
      ] as const)
        batch.add('curb', box(kw, CURB + 0.02, kd), x, (CURB + 0.02) / 2, z);
      void ix;
      void iz;
    }),
  );
  batch.add('sidewalk', new THREE.CylinderGeometry(PLAZA_R, PLAZA_R, CURB, 64), 0, CURB / 2, 0);
  batch.add('curb', new THREE.TorusGeometry(PLAZA_R, 0.1, 4, 64).rotateX(Math.PI / 2), 0, CURB, 0);
  // Plaza paving rings and radial joints.
  for (const r of [8, 14, 20, 26]) batch.add('paintLine', new THREE.RingGeometry(r - 0.12, r + 0.12, 64).rotateX(-Math.PI / 2), 0, CURB + 0.004, 0);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    batch.add('paintLine', box(0.14, 0.004, PLAZA_R - 8), Math.cos(a) * (PLAZA_R / 2 + 4), CURB + 0.004, Math.sin(a) * (PLAZA_R / 2 + 4), -a + Math.PI / 2);
  }

  // Markings: lane dashes, centre line, zebra crossings on every junction approach.
  const centre: ArchKey = style.centreLine === 'yellow' ? 'craneYellow' : 'paintLine';
  for (const [c, w] of ROADS) {
    for (const axis of ['x', 'z'] as const) {
      const seg = (a0: number, a1: number) => {
        const len = a1 - a0;
        if (len <= 0) return;
        const mid = (a0 + a1) / 2;
        const put = (key: ArchKey, off: number, dash: boolean) => {
          if (dash) {
            for (let a = a0 + 2; a < a1 - 2; a += 6) batch.add(key, axis === 'x' ? box(3, 0.004, 0.14) : box(0.14, 0.004, 3), axis === 'x' ? a + 1.5 : c + off, 0.012, axis === 'x' ? c + off : a + 1.5);
          } else batch.add(key, axis === 'x' ? box(len, 0.004, 0.12) : box(0.12, 0.004, len), axis === 'x' ? mid : c + off, 0.012, axis === 'x' ? c + off : mid);
        };
        put(centre, -0.15, false);
        put(centre, 0.15, false);
        if (w === BLVD) {
          put('paintLine', -w / 4, true);
          put('paintLine', w / 4, true);
        }
      };
      // Road runs between junctions; cut out junction boxes and the plaza.
      const stops = [-HALF - 20, ...ROADS.map(([cc, ww]) => [cc - ww / 2, cc + ww / 2]).flat(), HALF + 20];
      for (let i = 0; i < stops.length - 1; i += 2) {
        let a0 = stops[i];
        let a1 = stops[i + 1];
        if (c === 0) {
          if (a1 > -PLAZA_R && a0 < PLAZA_R) {
            if (a0 < -PLAZA_R) seg(a0, -PLAZA_R);
            if (a1 > PLAZA_R) seg(PLAZA_R, a1);
            continue;
          }
        }
        seg(a0, a1);
        // Zebra crossings just outside each junction.
        for (const [edge, s] of [[a0, 1], [a1, -1]] as const) {
          if (Math.abs(edge) > HALF) continue;
          for (let k = 0; k < Math.floor(w / 0.9) - 1; k++) {
            const across = c - w / 2 + 0.9 + k * 0.9;
            const along = edge + s * 2.2;
            batch.add('paintLine', axis === 'x' ? box(3, 0.004, 0.45) : box(0.45, 0.004, 3), axis === 'x' ? along : across, 0.013, axis === 'x' ? across : along);
          }
        }
        a0 = a1;
      }
    }
  }

  // Street lights along every road, both sides, 18 m apart.
  for (const [c, w] of ROADS) {
    for (const axis of ['x', 'z'] as const) {
      for (const side of [-1, 1]) {
        const off = c + side * (w / 2 + 0.6);
        for (let a = -HALF + 9; a < HALF - 9; a += 18) {
          if (ROADS.some(([cc, ww]) => Math.abs(a - cc) < ww / 2 + 3)) continue;
          const x = axis === 'x' ? a : off;
          const z = axis === 'x' ? off : a;
          if (Math.hypot(x, z) < PLAZA_R + 1) continue;
          const dx = axis === 'x' ? 0 : -side;
          const dz = axis === 'x' ? -side : 0;
          batch.add('steelDark', new THREE.CylinderGeometry(0.08, 0.12, 7, 8), x, CURB + 3.5, z);
          batch.add('steelDark', box(0.08, 0.08, 1.8), x + dx * 0.9, CURB + 6.9, z + dz * 0.9, axis === 'x' ? 0 : Q);
          batch.add('steelDark', box(0.36, 0.14, 0.7), x + dx * 1.7, CURB + 6.85, z + dz * 1.7, axis === 'x' ? 0 : Q);
          batch.add('lampGlow', box(0.3, 0.02, 0.6), x + dx * 1.7, CURB + 6.77, z + dz * 1.7, axis === 'x' ? 0 : Q);
        }
      }
    }
  }
  // Traffic signals on every junction corner: pole, mast arm over the carriageway, three-aspect head.
  for (const [cx, cz] of [[-56, -56], [0, -56], [56, -56], [-56, 0], [56, 0], [-56, 56], [0, 56], [56, 56]] as const) {
    const wx = cx === 0 ? BLVD : STREET; // width of the road running along Z through this junction
    const wz = cz === 0 ? BLVD : STREET;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const px = cx + sx * (wx / 2 + 0.9);
        const pz = cz + sz * (wz / 2 + 0.9);
        batch.add('steelDark', new THREE.CylinderGeometry(0.09, 0.12, 5.6, 8), px, CURB + 2.8, pz);
        const arm = wx / 2 - 0.5;
        batch.add('steelDark', box(arm, 0.1, 0.1), px - sx * arm / 2, CURB + 5.4, pz);
        // Head over the lane, facing traffic arriving along Z (toward −sz), green for them.
        const hx = px - sx * (arm - 0.3);
        const face = -sz;
        batch.add('steelDark', box(0.36, 1.0, 0.3), hx, CURB + 4.9, pz);
        batch.add('steelDark', new THREE.CylinderGeometry(0.11, 0.11, 0.04, 12).rotateX(Math.PI / 2), hx, CURB + 5.22, pz + face * 0.16);
        batch.add('signalGreen', new THREE.CylinderGeometry(0.11, 0.11, 0.04, 12).rotateX(Math.PI / 2), hx, CURB + 4.58, pz + face * 0.16);
        // Pole-mounted head for the cross traffic (along X): red.
        batch.add('steelDark', box(0.3, 0.9, 0.3), px, CURB + 3.1, pz - sz * 0.25);
        batch.add('signalRed', new THREE.CylinderGeometry(0.1, 0.1, 0.04, 12).rotateZ(Math.PI / 2), px - sx * 0.16, CURB + 3.4, pz - sz * 0.25);
        batch.add('steelDark', new THREE.CylinderGeometry(0.1, 0.1, 0.04, 12).rotateZ(Math.PI / 2), px - sx * 0.16, CURB + 2.85, pz - sz * 0.25);
      }
    }
  }
  if (style.lanterns) {
    // Red lantern strings across the side streets, sagging between the kerbs.
    const lrand = createSeededRandom(style.seed ^ 0x1a17);
    for (const [c, w] of ROADS) {
      if (w === BLVD) continue;
      for (const axis of ['x', 'z'] as const) {
        for (let a = -HALF + 10; a < HALF - 10; a += 9 + lrand() * 5) {
          if (ROADS.some(([cc, ww]) => Math.abs(a - cc) < ww / 2 + 4)) continue;
          const y0 = 6.4 + lrand() * 0.6;
          const pts: THREE.Vector3[] = [];
          const n = 7;
          for (let i = 0; i <= n; i++) {
            const t = i / n;
            const across = c - w / 2 - 1 + (w + 2) * t;
            const y = y0 - 1.1 * 4 * t * (1 - t);
            pts.push(axis === 'x' ? new THREE.Vector3(a, y, across) : new THREE.Vector3(across, y, a));
          }
          batch.add('steelDark', new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.015, 4), 0, 0, 0);
          for (let i = 1; i < n; i++) {
            const p = pts[i];
            batch.add('lantern', new THREE.SphereGeometry(0.26, 10, 8).scale(1, 1.25, 1), p.x, p.y - 0.45, p.z);
            batch.add('steelDark', new THREE.CylinderGeometry(0.12, 0.12, 0.06, 8), p.x, p.y - 0.1, p.z);
          }
        }
      }
    }
  }
  // Plaza lamp standards.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const x = Math.cos(a) * (PLAZA_R - 1.5);
    const z = Math.sin(a) * (PLAZA_R - 1.5);
    batch.add('steelDark', new THREE.CylinderGeometry(0.09, 0.14, 5, 8), x, CURB + 2.5, z);
    batch.add('lampGlow', new THREE.SphereGeometry(0.3, 10, 8), x, CURB + 5.2, z);
  }

  // Perimeter: masses with authored facades facing the district.
  for (const b of perimeter) {
    batch.add(WALL[b.material], box(b.w, b.h, b.d), b.x, b.h / 2, b.z);
    batch.add('roofing', box(b.w - 0.5, 0.06, b.d - 0.5), b.x, b.h + 0.03, b.z);
    const proxy = new THREE.Mesh(box(b.w, b.h, b.d));
    proxy.position.set(b.x, b.h / 2, b.z);
    proxy.updateMatrixWorld();
    occluders.push(proxy);
  }
  faces.forEach((f, i) => facade(batch, { block: f.block, cx: f.cx, cz: f.cz, ry: f.ry, len: f.len, ground: i % 3 === 2 ? 'service' : 'shop', seed: style.seed + i, lite: true }));

  if (style.waterfront === 'east') {
    // The river: 110 m of water between the embankment and the far bank, balustrade on top of the wall.
    batch.add('water', box(130, 0.02, 700), HALF + 67, -1.6, 0);
    batch.add('stone', box(1.6, 1.6, 700), HALF + 2.0, -0.8, 0); // granite quay wall down to the water
    batch.add('stone', box(1.6, 1.6, 700), HALF + 132, -0.8, 0);
    batch.add('gravel', box(300, 0.02, 700), HALF + 283, -0.03, 0); // Pudong ground
    batch.add('stone', box(0.5, 0.3, HALF * 2 + 44), HALF + 1.2, 1.25, 0);
    for (let z = -HALF - 20; z <= HALF + 20; z += 2.4) batch.add('stone', box(0.35, 0.9, 0.35), HALF + 1.2, 1.55, z);
    batch.add('stone', box(0.6, 0.18, HALF * 2 + 44), HALF + 1.2, 2.05, 0);
    batch.add('concrete', box(40, 2, 700), HALF + 132, 0.4, 0); // far bank
  }
  // Far skyline and hero silhouettes, fogged into depth.
  const srand = createSeededRandom(style.seed ^ 0x5151);
  for (let i = 0; i < style.skyline.n; i++) {
    const a = srand() * Math.PI * 2;
    const r = 150 + srand() * 170;
    const w = 14 + srand() * 22;
    const d = 14 + srand() * 18;
    const h = style.skyline.h[0] + srand() * (style.skyline.h[1] - style.skyline.h[0]);
    if (style.waterfront === 'east' && Math.cos(a) * r > HALF - 24 && Math.cos(a) * r < HALF + 150) continue;
    batch.add(srand() < 0.6 ? 'skylineWindows' : 'concrete', box(w, h, d), Math.cos(a) * r, h / 2, Math.sin(a) * r);
  }
  const heroes: THREE.BufferGeometry[] = [];
  for (const hero of style.skyline.heroes ?? []) heroes.push(heroGeometry(hero));
  if (heroes.length) batch.add('skylineWindows', mergeGeometries(heroes)!, 0, 0, 0);

  const cast = new Set<ArchKey>(['brick', 'darkBrick', 'plaster', 'concrete', 'steelDark', 'awning', 'stone']);
  return { meshes: batch.build(lib, cast), occluders };
}

/** Signature skyline silhouettes: simple solids that still read as the real towers at distance. */
function heroGeometry(hero: Hero): THREE.BufferGeometry {
  const { x, z, w, h } = hero;
  const t = hero.taper ?? 0.7;
  let g: THREE.BufferGeometry;
  switch (hero.kind ?? 'box') {
    case 'twist': {
      // Shanghai Tower: rounded triangle plan, tapering and twisting ~120° to the top.
      const seg = 24;
      g = new THREE.CylinderGeometry((w / 2) * t, w / 2, h, 18, seg);
      const p = g.getAttribute('position');
      const v = new THREE.Vector3();
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        const k = (v.y + h / 2) / h;
        const a = k * (Math.PI * 2) / 3;
        const ang = Math.atan2(v.z, v.x);
        const lobe = 1 + 0.12 * Math.cos(3 * (ang - a)); // three soft corners
        const c = Math.cos(a);
        const sn = Math.sin(a);
        const nx = v.x * lobe;
        const nz = v.z * lobe;
        p.setXYZ(i, nx * c - nz * sn, v.y, nx * sn + nz * c);
      }
      g.computeVertexNormals();
      break;
    }
    case 'opener': {
      // Shanghai World Financial Center: square base sweeping to a blade, trapezoid hole at the top.
      const shape = new THREE.Shape();
      shape.moveTo(-w / 2, 0);
      shape.lineTo(w / 2, 0);
      shape.lineTo(w * 0.3, h);
      shape.lineTo(-w * 0.3, h);
      shape.closePath();
      const hole = new THREE.Path();
      hole.moveTo(-w * 0.2, h - w * 0.55);
      hole.lineTo(w * 0.2, h - w * 0.55);
      hole.lineTo(w * 0.26, h - w * 0.12);
      hole.lineTo(-w * 0.26, h - w * 0.12);
      hole.closePath();
      shape.holes.push(hole);
      g = new THREE.ExtrudeGeometry(shape, { depth: w * 0.6, bevelEnabled: false });
      g.translate(0, -h / 2, -w * 0.3);
      break;
    }
    case 'pagoda': {
      // Jin Mao: stacked setbacks accelerating toward a spire.
      const parts: THREE.BufferGeometry[] = [];
      let y = 0;
      let ww = w;
      for (let i = 0; i < 12 && y < h * 0.85; i++) {
        const hh = h * 0.18 * Math.pow(0.82, i);
        parts.push(new THREE.BoxGeometry(ww, hh, ww).translate(0, y + hh / 2 - h / 2, 0));
        y += hh;
        ww *= 0.9;
      }
      parts.push(new THREE.CylinderGeometry(0.3, ww * 0.3, h - y, 8).translate(0, y + (h - y) / 2 - h / 2, 0));
      g = mergeGeometries(parts.map((q) => q.toNonIndexed()))!;
      break;
    }
    case 'obelisk': {
      // One World Trade Center: square base, chamfered into an octagon and a square rotated 45° at the top.
      g = new THREE.CylinderGeometry((w / 2) * 0.5, (w / 2) * Math.SQRT2, h * 0.86, 4, 8).rotateY(Math.PI / 4);
      const p = g.getAttribute('position');
      for (let i = 0; i < p.count; i++) {
        const k = (p.getY(i) + h * 0.43) / (h * 0.86);
        const a = k * (Math.PI / 4);
        const px = p.getX(i);
        const pz = p.getZ(i);
        p.setXYZ(i, px * Math.cos(a) - pz * Math.sin(a), p.getY(i) - h * 0.07, px * Math.sin(a) + pz * Math.cos(a));
      }
      g.computeVertexNormals();
      g = mergeGeometries([g.toNonIndexed(), new THREE.CylinderGeometry(0.4, 0.8, h * 0.14, 6).translate(0, h * 0.43, 0).toNonIndexed()])!;
      break;
    }
    case 'arch': {
      // Grande Arche: an open hollow cube.
      const shape = new THREE.Shape();
      shape.moveTo(-w / 2, 0);
      shape.lineTo(w / 2, 0);
      shape.lineTo(w / 2, h);
      shape.lineTo(-w / 2, h);
      shape.closePath();
      const hole = new THREE.Path();
      hole.moveTo(-w * 0.34, h * 0.12);
      hole.lineTo(w * 0.34, h * 0.12);
      hole.lineTo(w * 0.34, h * 0.82);
      hole.lineTo(-w * 0.34, h * 0.82);
      hole.closePath();
      shape.holes.push(hole);
      g = new THREE.ExtrudeGeometry(shape, { depth: w * 0.8, bevelEnabled: false });
      g.translate(0, -h / 2, -w * 0.4);
      break;
    }
    default:
      g = new THREE.CylinderGeometry((w / 2) * t, w / 2, h, 4, 1).rotateY(Math.PI / 4);
  }
  g.translate(x, h / 2, z);
  return g.index ? g.toNonIndexed() : g;
}
