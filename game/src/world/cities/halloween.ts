import * as THREE from 'three';
import type { Palette } from '../../art/environment';
import type { MaterialLibrary } from '../../art/materials';
import { OBJECT_TYPES, type ObjectTypeId } from '../../config/objects';
import { createSeededRandom } from '../../core/rng';
import { Batch } from '../architecture';
import { HALLOWEEN_MOON_DIR } from '../halloweenFx';
import type { Bounds, CityBuild, CityDef, SpawnPoint } from '../city';
import type { Cluster, Placement, StaticBlock } from '../scrapCity';

/**
 * HALLOWEEN TOWN — the event map (docs/halloween-mode.md). A graveyard-and-pumpkin-patch
 * landscape, Halloween elements only (Creative Director, 2026-10-02: no houses, cars or street
 * furniture). Real-world metres, −Z = north, the same 192 m playable square as the city maps:
 *
 *              NW  GRAVEYARD          │          NE  PUMPKIN PATCH
 *       fenced plots, crypts,         │   furrows, jack-o'-lanterns, scarecrows,
 *       mausoleums, obelisks          │   giant pumpkins, the colossal pumpkin
 *   ──────── dirt trail ───────(  EMPTY PLAZA r 30  )──────── dirt trail ────────
 *              SW  BONE YARD          │          SE  WITCH'S HOLLOW
 *       skeletons, bone piles,        │   cauldrons, witches, spiders, the well,
 *       skull rocks, giant skeleton   │   the giant witch's hat
 *
 * Every size class exists, with the same reward per class as the cities: candy and bones
 * (0–2) → props (3–4) → monster figures and biers (5) → crypts, giant pumpkins, spiders (6) →
 * giant set pieces that need a 6.5 m machine (7) and 9.5 m colossi (8). Dirt trails run out of
 * the plaza ring along the axes and diagonals to six spawns. The plaza (r 30) stays EMPTY.
 * A stone-and-iron cemetery wall closes the square; a dead forest stands beyond it.
 * Everything is seeded, so all players generate the same map.
 */
const HALF = 96;
const PLAZA_R = 30;
const RING: [number, number] = [31, 35]; // dirt ring trail around the plaza
const AXIS_W = 5; // axis trails
const DIAG_W = 4; // diagonal trails (end at the corner spawns / clearings)
const DIAG_END = 64;
const Q = Math.PI / 2;
const SQ2 = Math.SQRT2;

/**
 * Moonlit night. The moon is the key light (cool, 18° up, ~34° east of north — the same
 * direction as the FX layer's moon disc, HALLOWEEN_MOON_DIR), a violet hemisphere and the baked
 * night sky fill the shadow side so dark props, machines and villains stay readable.
 */
const MOONLIGHT: Palette = {
  sunDirection: HALLOWEEN_MOON_DIR.clone(),
  sunColor: new THREE.Color(0xb8c6ff),
  sunIntensity: 2.6,
  sky: { top: new THREE.Color(0x0d1230), mid: new THREE.Color(0x3a2a68), horizon: new THREE.Color(0xd8743e), ground: new THREE.Color(0x1a1622), sun: new THREE.Color(0xe9eeff) },
  clouds: -0.25,
  fog: new THREE.Color(0x3d3558),
  fogNear: 70,
  fogFar: 400,
  hemiSky: new THREE.Color(0x9a92d6),
  hemiGround: new THREE.Color(0x4c3e56),
  hemiIntensity: 1.75,
  envIntensity: 0.9,
  cloudTint: new THREE.Color(0.3, 0.3, 0.42),
};

/** Six arena spawns: the four trail ends and two corner clearings, all facing the plaza. */
const SPAWNS: SpawnPoint[] = [
  { x: 0, z: HALF - 8, heading: 0 },
  { x: 0, z: -HALF + 8, heading: Math.PI },
  { x: -HALF + 8, z: 0, heading: -Q },
  { x: HALF - 8, z: 0, heading: Q },
  { x: -62, z: -62, heading: (-3 * Math.PI) / 4 },
  { x: 62, z: 62, heading: Math.PI / 4 },
];

interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** Fenced graveyard plots (NW); the gate side faces the nearest trail. */
const PLOTS: { r: Rect; gate: 'n' | 's' | 'e' | 'w' }[] = [
  { r: { x0: -58, x1: -42, z0: -28, z1: -16 }, gate: 's' },
  { r: { x0: -28, x1: -16, z0: -58, z1: -42 }, gate: 'e' },
  { r: { x0: -84, x1: -68, z0: -50, z1: -38 }, gate: 's' },
  { r: { x0: -50, x1: -38, z0: -84, z1: -68 }, gate: 'e' },
];

/** Pumpkin-patch furrows (NE): trodden-earth rows the jack-o'-lanterns and pumpkins sit along. */
const FURROWS: Rect[] = [
  ...[-9, -12.5, -16, -19.5].map((z) => ({ x0: 40, x1: 88, z0: z - 0.7, z1: z + 0.7 })),
  ...[9, 12.5, 16, 19.5].map((x) => ({ x0: x - 0.7, x1: x + 0.7, z0: -88, z1: -42 })),
];

/** Class 8 colossi: hand-placed so each zone shows its final goal from the plaza (§22). */
const COLOSSI: Placement[] = [
  { type: 'HAUNTED_TREE', x: -22, z: -78, yaw: 0.4 },
  { type: 'COLOSSAL_PUMPKIN', x: 66, z: -32, yaw: Math.PI * 0.8 },
  { type: 'SKULL_MOUNTAIN', x: 76, z: -76, yaw: Math.PI * 0.75 },
  { type: 'WITCH_HAT_TOWER', x: 28, z: 70, yaw: 0.3 },
  { type: 'GIANT_SKELETON', x: -62, z: 30, yaw: (-3 * Math.PI) / 4 + 0.2 },
  { type: 'HAUNTED_TREE', x: -80, z: 80, yaw: 2.1 },
];

type Kit = [ObjectTypeId, number, number, number][]; // type, count, min radius, max radius
/** Zone kits: what each quadrant is made of (counts are tries; collisions drop a few). */
const ZONES: { sx: number; sz: number; kit: Kit; food: ObjectTypeId[][] }[] = [
  {
    // NW graveyard (the plots add ~60 headstones, ~70 railings and 4 gates).
    sx: -1,
    sz: -1,
    kit: [
      ['MAUSOLEUM', 4, 46, 92], ['GIANT_OBELISK', 3, 42, 85], ['CRYPT', 3, 40, 85], ['VAMPIRE_COFFIN', 9, 40, 88], ['VAMPIRE', 5, 38, 88],
      ['CRYPT_GATE', 2, 40, 80], ['COFFIN', 6, 38, 88], ['SLIME_GHOST', 5, 38, 88], ['GRAVE_OBELISK', 5, 38, 88], ['SKELETON', 3, 38, 88],
      ['TOMBSTONE', 12, 38, 90], ['TOMBSTONE_CROSS', 6, 38, 90], ['JACK_O_LANTERN', 4, 38, 88], ['CROW_POST', 3, 38, 88], ['BAT_SIGN', 2, 38, 70],
    ],
    food: [['CANDY_CORN', 'EYEBALL', 'CANDY'], ['CANDLE', 'SKULL', 'BONE', 'SPIDER'], ['WITCH_HAT', 'CANDY_BUCKET']],
  },
  {
    // NE pumpkin patch.
    sx: 1,
    sz: -1,
    kit: [
      ['GIANT_JACK', 5, 42, 90], ['GIANT_SCARECROW', 3, 42, 88], ['GIANT_PUMPKIN', 5, 38, 88], ['PUMPKIN_CARRIAGE', 3, 40, 85], ['WITCH', 5, 38, 88],
      ['WEREWOLF', 5, 40, 88], ['BONE_PILE', 4, 40, 88], ['VAMPIRE_COFFIN', 5, 40, 88], ['SCARECROW', 9, 38, 90], ['SLIME_GHOST', 2, 38, 85],
      ['JACK_O_LANTERN', 10, 38, 90], ['CROW_POST', 6, 38, 90], ['BAT_SIGN', 3, 38, 80], ['CAULDRON', 3, 38, 85],
    ],
    food: [['CANDY', 'CANDY_CORN', 'CANDY'], ['LOLLIPOP', 'CANDLE', 'SPIDER'], ['MINI_PUMPKIN', 'CANDY_BUCKET', 'MINI_PUMPKIN']],
  },
  {
    // SE witch's hollow.
    sx: 1,
    sz: 1,
    kit: [
      ['GIANT_CAULDRON', 4, 42, 90], ['SKULL_ROCK', 2, 45, 90], ['GIANT_SPIDER', 3, 40, 88], ['WISHING_WELL', 3, 38, 85], ['WITCH', 9, 38, 88],
      ['BONE_PILE', 4, 40, 88], ['VAMPIRE', 4, 38, 88], ['WEREWOLF', 4, 40, 88], ['VAMPIRE_COFFIN', 5, 40, 88], ['CAULDRON', 12, 38, 90],
      ['BROOM_RACK', 8, 38, 90], ['SPIDER_WEB', 8, 38, 90], ['SLIME_GHOST', 4, 38, 88], ['JACK_O_LANTERN', 6, 38, 88], ['SKELETON', 3, 38, 88],
    ],
    food: [['EYEBALL', 'CANDY', 'CANDY_CORN'], ['SPIDER', 'CANDLE', 'LOLLIPOP'], ['WITCH_HAT', 'BAT_PLUSH', 'CANDY_BUCKET']],
  },
  {
    // SW bone yard.
    sx: -1,
    sz: 1,
    kit: [
      ['SKULL_ROCK', 3, 45, 90], ['GIANT_OBELISK', 2, 42, 88], ['GIANT_SPIDER', 2, 40, 88], ['CRYPT', 2, 40, 85], ['BONE_PILE', 11, 38, 90],
      ['WEREWOLF', 6, 38, 88], ['VAMPIRE', 5, 38, 88], ['VAMPIRE_COFFIN', 7, 38, 88], ['CRYPT_GATE', 3, 40, 85], ['SKELETON', 10, 38, 90],
      ['COFFIN', 8, 38, 90], ['SPIDER_WEB', 6, 38, 90], ['TOMBSTONE', 8, 38, 90], ['SLIME_GHOST', 3, 38, 88], ['CROW_POST', 3, 38, 90],
    ],
    food: [['CANDY', 'EYEBALL', 'CANDY_CORN'], ['BONE', 'SKULL', 'SPIDER'], ['BAT_PLUSH', 'CANDY_BUCKET', 'MINI_PUMPKIN']],
  },
];

/** Inside the plaza, on a trail or a spawn clearing (with `pad` metres to spare). */
function onTrail(x: number, z: number, pad: number): boolean {
  const r = Math.hypot(x, z);
  if (r < RING[1] + pad) return true;
  if (Math.abs(x) < AXIS_W / 2 + pad || Math.abs(z) < AXIS_W / 2 + pad) return true;
  if (Math.max(Math.abs(x), Math.abs(z)) < DIAG_END && Math.abs(Math.abs(x) - Math.abs(z)) / SQ2 < DIAG_W / 2 + pad) return true;
  return SPAWNS.some((s) => Math.hypot(s.x - x, s.z - z) < 9 + pad);
}

function build(): CityDef {
  const rand = createSeededRandom(1031);
  const placements: Placement[] = [];
  const clusters: Cluster[] = [];
  const trees: { x: number; z: number; y: number }[] = [];
  const taken: { x: number; z: number; r: number }[] = [];
  const reserved: Rect[] = [...PLOTS.map((p) => p.r), ...FURROWS];
  const lanterns: { x: number; y: number; z: number }[] = [];
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
  const radius = (type: ObjectTypeId) => {
    const [w, , d] = OBJECT_TYPES[type].size;
    return Math.max(w, d) / 2;
  };
  const inRect = (x: number, z: number, r: number, q: Rect) => x + r > q.x0 && x - r < q.x1 && z + r > q.z0 && z - r < q.z1;
  const free = (x: number, z: number, r: number, pad: number) => taken.every((t) => Math.hypot(t.x - x, t.z - z) > t.r + r + pad);
  const place = (type: ObjectTypeId, x: number, z: number, yaw: number) => {
    placements.push({ type, x, z, yaw });
    taken.push({ x, z, r: radius(type) });
    if (type === 'JACK_O_LANTERN' || type === 'GIANT_JACK') lanterns.push({ x, y: 0, z });
  };
  /** Free-standing placement: off the trails and plaza, inside the wall, clear of others. */
  const fits = (type: ObjectTypeId, x: number, z: number, pad: number, allowReserved = false) => {
    const r = radius(type);
    if (Math.abs(x) + r > HALF - 2 || Math.abs(z) + r > HALF - 2) return false;
    if (onTrail(x, z, r * 0.9)) return false;
    if (!allowReserved && reserved.some((q) => inRect(x, z, r + 0.5, q))) return false;
    return free(x, z, r, pad);
  };

  // ── Class 8 colossi (fixed) ──
  for (const p of COLOSSI) place(p.type, p.x, p.z, p.yaw ?? 0);

  // ── Graveyard plots: iron railings, a gate toward the trail, headstone rows ──
  const seg = OBJECT_TYPES.IRON_FENCE.size[0];
  const gateW = OBJECT_TYPES.CRYPT_GATE.size[0];
  const graves: ObjectTypeId[] = ['TOMBSTONE', 'TOMBSTONE', 'TOMBSTONE', 'TOMBSTONE', 'TOMBSTONE_CROSS', 'TOMBSTONE_CROSS', 'GRAVE_OBELISK'];
  for (const { r, gate } of PLOTS) {
    const sides: [number, number, number, boolean, 'n' | 's' | 'e' | 'w'][] = [
      [r.x0, r.x1, r.z0, true, 'n'],
      [r.x0, r.x1, r.z1, true, 's'],
      [r.z0, r.z1, r.x0, false, 'w'],
      [r.z0, r.z1, r.x1, false, 'e'],
    ];
    for (const [a0, a1, line, alongX, side] of sides) {
      const mid = (a0 + a1) / 2;
      const n = Math.round((a1 - a0) / seg);
      for (let i = 0; i < n; i++) {
        const a = a0 + (i + 0.5) * ((a1 - a0) / n);
        if (side === gate && Math.abs(a - mid) < gateW / 2 + seg / 2 - 0.1) continue;
        place('IRON_FENCE', alongX ? a : line, alongX ? line : a, alongX ? 0 : Q);
      }
      if (side === gate) place('CRYPT_GATE', alongX ? mid : line, alongX ? line : mid, alongX ? 0 : Q);
    }
    // Rows of graves facing the gate side, with the gate's walk kept clear.
    const gx = (r.x0 + r.x1) / 2;
    const gz = (r.z0 + r.z1) / 2;
    const yawToGate = gate === 'n' ? 0 : gate === 's' ? Math.PI : gate === 'e' ? -Q : Q;
    const walkAlongX = gate === 'e' || gate === 'w';
    for (let z = r.z0 + 1.7; z < r.z1 - 1.2; z += 2.4)
      for (let x = r.x0 + 1.4; x < r.x1 - 1.0; x += 1.75) {
        if ((walkAlongX ? Math.abs(z - gz) : Math.abs(x - gx)) < 1.6) continue;
        const roll = rand();
        if (roll < 0.08) continue;
        const type: ObjectTypeId = roll > 0.985 ? 'SKELETON' : roll > 0.965 ? 'COFFIN' : roll > 0.95 ? 'SLIME_GHOST' : pick(graves);
        const yaw = yawToGate + (rand() - 0.5) * 0.14;
        if (free(x, z, radius(type), 0.05)) place(type, x, z, yaw);
      }
    clusters.push({ type: 'CANDLE', x: gx, z: gz, radius: 6, count: 10 }, { type: 'SKULL', x: gx, z: gz, radius: 6, count: 3 });
  }

  // ── Pumpkin-patch furrows: jack-o'-lanterns and scarecrows along the rows, pumpkins between ──
  for (const f of FURROWS) {
    const alongX = f.x1 - f.x0 > f.z1 - f.z0;
    const cx = (f.x0 + f.x1) / 2;
    const cz = (f.z0 + f.z1) / 2;
    const len = alongX ? f.x1 - f.x0 : f.z1 - f.z0;
    for (let a = 2; a < len - 2; a += 7 + rand() * 4) {
      const x = alongX ? f.x0 + a : cx;
      const z = alongX ? cz : f.z0 + a;
      const type: ObjectTypeId = rand() < 0.82 ? 'JACK_O_LANTERN' : 'SCARECROW';
      if (fits(type, x, z, 0.3, true)) place(type, x, z, alongX ? (rand() < 0.5 ? 0 : Math.PI) : rand() < 0.5 ? Q : -Q);
    }
    for (let a = 4; a < len - 3; a += 9) clusters.push({ type: 'MINI_PUMPKIN', x: alongX ? f.x0 + a : cx, z: alongX ? cz : f.z0 + a, radius: 2.2, count: 4 });
  }

  // ── Zone kits: biggest first so the giants claim the outer ground ──
  for (const zone of ZONES) {
    const kit = [...zone.kit].sort((a, b) => OBJECT_TYPES[b[0]].objectClass - OBJECT_TYPES[a[0]].objectClass);
    for (const [type, count, r0, r1] of kit) {
      const big = OBJECT_TYPES[type].objectClass >= 6;
      for (let i = 0, tries = 0; i < count && tries < count * 60; tries++) {
        const x = zone.sx * (4 + rand() * (HALF - 6));
        const z = zone.sz * (4 + rand() * (HALF - 6));
        const d = Math.hypot(x, z);
        if (d < r0 || d > r1) continue;
        if (!fits(type, x, z, big ? 2.5 : 0.8)) continue;
        place(type, x, z, rand() * Math.PI * 2);
        i++;
      }
    }
    // Dead trees among the props, and the zone's food.
    for (let i = 0, tries = 0; i < 11 && tries < 300; tries++) {
      const x = zone.sx * (8 + rand() * (HALF - 12));
      const z = zone.sz * (8 + rand() * (HALF - 12));
      if (onTrail(x, z, 1.5) || !free(x, z, 0.4, 1.2) || reserved.some((q) => inRect(x, z, 1, q))) continue;
      trees.push({ x, z, y: 0 });
      taken.push({ x, z, r: 0.4 });
      i++;
    }
    for (let i = 0; i < 12; i++) {
      const tier = i < 5 ? 0 : i < 9 ? 1 : 2;
      const x = zone.sx * (40 + rand() * 48) * (rand() < 0.5 ? 1 : 0.6);
      const z = zone.sz * (40 + rand() * 48) * (rand() < 0.5 ? 1 : 0.6);
      if (Math.hypot(x, z) < PLAZA_R + 6) continue;
      clusters.push({ type: pick(zone.food[tier]), x, z, radius: 4 + rand() * 2, count: tier === 0 ? 18 : tier === 1 ? 9 : 5 });
    }
  }
  clusters.push({ type: 'GOLD_CRATE', x: -50, z: -50, radius: 8, count: 2 });

  // ── Trails: pumpkin lantern posts lining them, food scattered along ──
  const lanternAt = (x: number, z: number, yaw: number) => {
    place('LANTERN_POST', x, z, yaw);
    lanterns.push({ x: x + 0.46 * Math.cos(yaw) + 0.1 * Math.sin(yaw), y: 0, z: z - 0.46 * Math.sin(yaw) + 0.1 * Math.cos(yaw) });
  };
  for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    let k = 0;
    for (let d = 41; d < HALF - 8; d += 12, k++) {
      const side = k % 2 ? 1 : -1;
      const off = AXIS_W / 2 + 1.1;
      const x = ax * d + (az ? side * off : 0);
      const z = az * d + (ax ? side * off : 0);
      // Arm (local +X) over the trail.
      const yaw = ax ? side * Q : side > 0 ? Math.PI : 0;
      if (free(x, z, 0.5, 0.3)) lanternAt(x, z, yaw);
      const t: ObjectTypeId = k % 3 === 0 ? 'CANDY' : k % 3 === 1 ? 'LOLLIPOP' : 'CANDY_BUCKET';
      clusters.push({ type: t, x: ax * (d + 6), z: az * (d + 6), radius: 3, count: OBJECT_TYPES[t].objectClass === 0 ? 10 : OBJECT_TYPES[t].objectClass === 1 ? 6 : 4 });
    }
  }
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
    for (let d = 40, k = 0; d < DIAG_END * SQ2 - 12; d += 15, k++) {
      const side = k % 2 ? 1 : -1;
      const u = d / SQ2;
      const nx = (-sz * side * (DIAG_W / 2 + 1.1)) / SQ2;
      const nz = (sx * side * (DIAG_W / 2 + 1.1)) / SQ2;
      const x = sx * u + nx;
      const z = sz * u + nz;
      if (free(x, z, 0.5, 0.3)) lanternAt(x, z, Math.atan2(nz, -nx) + Math.PI);
      clusters.push({ type: k % 2 ? 'CANDY_CORN' : 'EYEBALL', x: sx * (u + 4), z: sz * (u + 4), radius: 3, count: 10 });
    }
  }
  // Plaza rim: eight lantern posts just outside the ring trail, arms toward the empty plaza.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const x = Math.cos(a) * (RING[1] + 1.8);
    const z = Math.sin(a) * (RING[1] + 1.8);
    lanternAt(x, z, Math.atan2(z, -x) + Math.PI);
  }

  // ── Dead forest beyond the south and west walls (dressing only). The low moon is in the
  // north-east, so trees there would throw 40 m shadows across the play area; the FX layer's
  // hill silhouettes close the view on those sides instead.
  const frand = createSeededRandom(1031 ^ 0x7ee);
  for (let i = 0; i < 260 && trees.length < 44 + 110; i++) {
    const a = frand() * Math.PI * 2;
    const r = HALF + 5 + frand() * 32;
    const x = THREE.MathUtils.clamp(Math.cos(a) * r * 1.3, -HALF - 36, HALF + 36);
    const z = THREE.MathUtils.clamp(Math.sin(a) * r * 1.3, -HALF - 36, HALF + 36);
    if (Math.max(Math.abs(x), Math.abs(z)) < HALF + 4) continue;
    if (z < -HALF || x > HALF) continue; // north and east sides stay open
    trees.push({ x, z, y: 0 });
  }

  // ── Static: the cemetery wall ──
  const staticBlocks: StaticBlock[] = [
    { name: 'Wall_Cemetery_N', x: 0, z: -HALF - 0.9, w: HALF * 2 + 4, d: 0.9, h: 1.7, material: 'concrete' },
    { name: 'Wall_Cemetery_S', x: 0, z: HALF + 0.9, w: HALF * 2 + 4, d: 0.9, h: 1.7, material: 'concrete' },
    { name: 'Wall_Cemetery_W', x: -HALF - 0.9, z: 0, w: 0.9, d: HALF * 2 + 4, h: 1.7, material: 'concrete' },
    { name: 'Wall_Cemetery_E', x: HALF + 0.9, z: 0, w: 0.9, d: HALF * 2 + 4, h: 1.7, material: 'concrete' },
  ];

  // ── FX hints ──
  const graveyard: Bounds = { minX: -86, maxX: -14, minZ: -86, maxZ: -14 };
  const mistZones: { x: number; z: number; r: number }[] = [];
  for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) for (let d = 40; d < HALF - 6; d += 13) mistZones.push({ x: ax * d, z: az * d, r: 7 });
  for (const { r } of PLOTS) mistZones.push({ x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, r: 10 });
  for (const zone of ZONES) mistZones.push({ x: zone.sx * 58, z: zone.sz * 58, r: 12 });
  const roosts = COLOSSI.map((p) => ({ x: p.x, z: p.z, h: OBJECT_TYPES[p.type].size[1] }));

  return {
    id: 'halloween',
    name: 'Halloween Town',
    nameZh: '万圣节小镇',
    tagline: 'Grow fat on candy — then run from the monsters',
    taglineZh: '先吃糖长大，再逃离怪物',
    level: 0,
    palette: MOONLIGHT,
    bounds: { minX: -HALF, maxX: HALF, minZ: -HALF, maxZ: HALF },
    staticBlocks,
    placements,
    clusters,
    groundHeight: () => 0,
    spawn: SPAWNS[0],
    spawns: SPAWNS,
    // Same total reward as the arena's generic starter ring (52.76 kg), as candy, bones and pumpkins.
    starterRing: [
      ['CANDY', 5, 30],
      ['CANDY_CORN', 6, 20],
      ['LOLLIPOP', 6, 10],
      ['CANDLE', 6, 4],
      ['BONE', 7, 8],
      ['SKULL', 8, 8],
      ['MINI_PUMPKIN', 9, 5],
      ['CANDY_BUCKET', 10, 4],
      ['WITCH_HAT', 10, 4],
    ],
    fxHints: { lanterns, graveyard, mistZones, roosts },
    build: (lib) => buildGround(lib),
    dressing: { trees, crown: 1, seed: 1031, dead: true },
    climaxName: 'the haunted plaza',
    climaxNameZh: '鬼影广场',
  };
}

/** Ground, trails, plaza disc, cemetery wall with iron railings and lantern piers. */
function buildGround(lib: MaterialLibrary): CityBuild {
  const batch = new Batch();
  const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
  const flat = (g: THREE.BufferGeometry) => g.rotateX(-Q);
  batch.add('deadGrass', box(900, 0.02, 900), 0, -0.012, 0);
  // Trails: plaza ring, axis legs, diagonals, spawn clearings, furrows.
  batch.add('dirt', flat(new THREE.RingGeometry(RING[0], RING[1], 96)), 0, 0.004, 0);
  for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const len = HALF + 4 - RING[0];
    const mid = RING[0] + len / 2;
    batch.add('dirt', ax ? box(len, 0.01, AXIS_W) : box(AXIS_W, 0.01, len), ax * mid, 0.004, az * mid);
  }
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
    const len = DIAG_END * SQ2 - RING[0] + 2;
    const mid = (RING[0] + len / 2) / SQ2;
    batch.add('dirt', box(DIAG_W, 0.01, len), sx * mid, 0.0045, sz * mid, Math.atan2(sx, sz));
  }
  for (const s of SPAWNS) batch.add('dirt', flat(new THREE.CircleGeometry(7, 28)), s.x, 0.005, s.z);
  for (const f of FURROWS) batch.add('dirt', box(f.x1 - f.x0, 0.01, f.z1 - f.z0), (f.x0 + f.x1) / 2, 0.004, (f.z0 + f.z1) / 2);
  // The empty plaza: weathered flagstone disc inside a low kerb of stone.
  batch.add('curb', flat(new THREE.CircleGeometry(PLAZA_R, 96)), 0, 0.006, 0);
  batch.add('stone', new THREE.TorusGeometry(PLAZA_R, 0.22, 4, 96).rotateX(Q).scale(1, 0.4, 1), 0, 0.04, 0);
  // Cemetery wall: stone base and coping, iron railing on top, piers with jack-o'-lantern lamps.
  const L = HALF * 2 + 4;
  for (const [nx, nz] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
    const off = HALF + 0.9;
    const cx = nx * off;
    const cz = nz * off;
    const alongX = nz !== 0;
    batch.add('stone', alongX ? box(L, 1.4, 0.9) : box(0.9, 1.4, L), cx, 0.7, cz);
    batch.add('stone', alongX ? box(L, 0.14, 1.1) : box(1.1, 0.14, L), cx, 1.47, cz);
    batch.add('steelDark', alongX ? box(L, 0.05, 0.05) : box(0.05, 0.05, L), cx, 2.75, cz);
    batch.add('steelDark', alongX ? box(L, 0.05, 0.05) : box(0.05, 0.05, L), cx, 1.75, cz);
    for (let a = -L / 2 + 0.2; a < L / 2; a += 0.3) {
      const x = alongX ? a : cx;
      const z = alongX ? cz : a;
      batch.add('steelDark', box(0.035, 1.5, 0.035), x, 2.29, z);
    }
    for (let a = -L / 2 + 2; a < L / 2; a += 12) {
      const x = alongX ? a : cx;
      const z = alongX ? cz : a;
      batch.add('stone', box(1.2, 3.0, 1.2), x, 1.5, z);
      batch.add('stone', box(1.45, 0.2, 1.45), x, 3.1, z);
      batch.add('jackLantern', new THREE.SphereGeometry(0.38, 12, 8).scale(1, 0.78, 1), x, 3.48, z);
      batch.add('steelDark', new THREE.CylinderGeometry(0.05, 0.08, 0.16, 6), x, 3.82, z);
    }
  }
  const cast = new Set<'stone'>(['stone']);
  return { meshes: batch.build(lib, cast), occluders: [] };
}

export const HALLOWEEN = build();

/**
 * Layout for the atmosphere layer (halloweenFx setGraveyard / setMistZones / setRoosts /
 * setLanterns). The ground is flat at y = 0 everywhere (plaza included).
 */
export const HALLOWEEN_LAYOUT = {
  graveyard: HALLOWEEN.fxHints!.graveyard!,
  mist: HALLOWEEN.fxHints!.mistZones.map((m) => ({ ...m, y: 0 })),
  roosts: HALLOWEEN.fxHints!.roosts,
  lanterns: HALLOWEEN.fxHints!.lanterns,
};
