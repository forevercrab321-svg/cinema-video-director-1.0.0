import * as THREE from 'three';
import { SIZE_CLASSES } from '../config/classes';
import { OBJECT_TYPES, type ObjectType, type ObjectTypeId } from '../config/objects';
import { circleVsObb, obbRadius, type Contact, type Obb } from '../core/collision';
import { createSeededRandom } from '../core/rng';
import { TINTED, type MaterialLibrary, type Role } from '../art/materials';
import { skipAO } from '../art/layers';
import { buildDressing, type Dressing } from './dressing';
import { buildPropParts, type PropParts } from './props';
import { makeLod } from './lod';
import type { CityDef } from './city';
import type { Cluster } from './scrapCity';
import type { Quality } from '../art/postfx';

const SHADOW_ROLES: ReadonlySet<Role> = new Set<Role>(['paint', 'carPaint', 'plastic', 'glossyPlastic', 'cardboard', 'corrugated', 'roofMetal', 'concreteProp', 'wood', 'timber', 'tread', 'rubber', 'steel', 'propBrick', 'stone', 'copper']);

export type ObjectState = 'idle' | 'pulled' | 'absorbed';

/**
 * Render detail per quality tier (render only, never gameplay):
 *   hideSizes  — objects further than this many of their own sizes are not drawn (~3 px at high)
 *   lodLarge / lodSmall — far-LOD distance in sizes for class ≥ 5 / smaller objects
 *   smallShadows — class ≤ 5 props (cans … cars) cast sun shadows
 */
const DETAIL: Record<Quality, { hideSizes: number; lodLarge: number; lodSmall: number; smallShadows: boolean }> = {
  high: { hideSizes: 260, lodLarge: 7, lodSmall: 9, smallShadows: true },
  medium: { hideSizes: 200, lodLarge: 6, lodSmall: 8, smallShadows: true },
  low: { hideSizes: 150, lodLarge: 5, lodSmall: 6.5, smallShadows: false },
};
let detail = DETAIL.high;

/** Set the render detail tier (once at boot, before any World is built). */
export function setWorldDetail(quality: Quality): void {
  detail = DETAIL[quality] ?? DETAIL.high;
}

/**
 * Prop role geometries and their far LODs are deterministic per object type, and the LOD
 * edge-collapse is the most expensive part of building a World (~1.5 s on a low-end CPU).
 * Cache both for the page's lifetime: every round after the first (and the lobby preview →
 * round switch) reuses them. BatchedMesh copies what it draws, so these are never uploaded.
 */
const partsCache = new Map<ObjectTypeId, PropParts>();
const lodCache = new Map<ObjectTypeId, Partial<Record<Role, THREE.BufferGeometry>>>();

export interface WorldObject {
  id: number;
  typeId: ObjectTypeId;
  def: ObjectType;
  /** Instance ids in each material batch this object's model spans. */
  instances: { batch: RoleBatch; id: number; geometryId: number; lodId: number }[];
  /** Currently drawn with the simplified far geometry. */
  lod: boolean;
  x: number;
  y: number;
  z: number;
  /** Resting height of the base (ground, or the top of whatever supports it). */
  baseY: number;
  yaw: number;
  scale: number;
  /** Destruction deformation: 0 = intact, 1 = fully crushed (flattened, splayed). */
  squash: number;
  /** Lean about the object's local X axis (rip / collapse), radians. */
  tilt: number;
  obb: Obb;
  radius: number;
  requiredPower: number;
  baseColor: THREE.Color;
  /** Current instance tint (eligibility), written by applyEligibility. */
  tint: THREE.Color;
  state: ObjectState;
  vx: number;
  vy: number;
  vz: number;
  pullTime: number;
  spin: number;
  bumpCooldown: number;
  dirty: boolean;
  /** Objects holding this one up (stacked containers, roof bays on wall panels). */
  supports: WorldObject[];
  /** True while a 'collapse' object is still held up: it cannot be absorbed yet. */
  anchored: boolean;
  /** Falling after its supports were removed (vy integrates gravity until it lands). */
  falling: boolean;
  matrix: THREE.Matrix4;
  /** Arena: the machine this object is being pulled into (proposed, then granted by the host). */
  owner?: string;
  /** Arena: when this client last proposed it (for re-claims). */
  claimAt?: number;
}

/**
 * Props render through one BatchedMesh per (material role × size set): every object type that
 * uses a role shares its multi-draw call, and BatchedMesh culls instances per camera (the
 * main view and the sun's shadow camera alike). The small set (class ≤ 5) skips the GTAO pass.
 */
interface RoleBatch {
  mesh: THREE.BatchedMesh;
  tinted: boolean;
}

/** A support was removed: objects resting on it start to fall. */
export interface CollapseEvent {
  object: WorldObject;
}

export class World {
  readonly root = new THREE.Group();
  readonly staticColliders: Obb[] = [];
  /** Building masses the camera must not pass through (invisible proxies). */
  readonly occluders: THREE.Object3D[];
  /** Camera occluder proxies for standing structures (removed when they are pulled or fall). */
  private readonly structureProxies = new Map<WorldObject, THREE.Mesh>();
  /** Trees, weeds and decals (static, animated by wind). */
  readonly dressing: Dressing;
  objects: WorldObject[] = [];
  private readonly roleBatches = new Map<string, RoleBatch>();
  private readonly objectsRoot = new THREE.Group();
  private readonly quat = new THREE.Quaternion();
  private readonly spinQ = new THREE.Quaternion();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpScale = new THREE.Vector3();
  private readonly xAxis = new THREE.Vector3(1, 0, 0);
  private readonly contact: Contact = { nx: 0, nz: 0, depth: 0 };
  private readonly tiltQ = new THREE.Quaternion();
  /** Instances drawn last frame (after culling), for diagnostics. */
  visibleInstances = 0;

  // ── Broad phase: uniform grid over the city (see near()) ─────────────────
  private gridX0 = 0;
  private gridZ0 = 0;
  private gridCols = 1;
  private gridRows = 1;
  private cells: WorldObject[][] = [];
  /** Per object id: the cell rectangle it is binned in [cx0, cz0, cx1, cz1]. */
  private binned = new Int32Array(0);
  /** Per object id: the last query that returned it (dedup for objects spanning cells). */
  private seen = new Uint32Array(0);
  private stamp = 0;
  /** Per object id: 1 = drawn desaturated (locked), 0 = full colour, −1 = never tinted. */
  private tintLocked = new Int8Array(0);

  constructor(
    private readonly lib: MaterialLibrary,
    readonly city: CityDef,
  ) {
    this.root.name = `CITY_${city.id.toUpperCase()}`;
    const built = city.build(lib);
    for (const m of built.meshes) this.root.add(m);
    this.occluders = built.occluders;
    for (const b of city.staticBlocks) if (b.collide !== false && (b.y ?? 0) < 0.5) this.staticColliders.push({ cx: b.x, cz: b.z, hx: b.w / 2, hz: b.d / 2, yaw: 0 });
    this.dressing = buildDressing(city.dressing);
    for (const m of this.dressing.meshes) {
      if (m.name !== 'DRESS_TreeTrunks') skipAO(m);
      this.root.add(m);
    }
    this.staticColliders.push(...this.dressing.colliders);
    this.objectsRoot.name = 'OBJECTS';
    this.root.add(this.objectsRoot);
  }

  /** (Re)spawn every gameplay object deterministically from the layout data. */
  spawnObjects(seed: number, extraClusters: Cluster[] = []): void {
    for (const rb of this.roleBatches.values()) {
      rb.mesh.removeFromParent();
      rb.mesh.dispose();
    }
    this.roleBatches.clear();
    for (const m of this.structureProxies.values()) this.dropProxy(m);
    this.structureProxies.clear();
    this.objects = [];
    const rand = createSeededRandom(seed);

    const pending: { typeId: ObjectTypeId; x: number; z: number; yaw: number; y?: number; tag?: string; supports?: string[] }[] = [];
    const occupied: { x: number; z: number; r: number }[] = [];
    const blockers: Obb[] = [];
    for (const p of this.city.placements) {
      pending.push({ typeId: p.type, x: p.x, z: p.z, yaw: p.yaw ?? 0, y: p.y, tag: p.tag, supports: p.supports });
      // Hand placements may overlap on purpose (stacks, the warehouse kit); scatter still avoids their footprints.
      occupied.push({ x: p.x, z: p.z, r: Math.min(footprintRadius(OBJECT_TYPES[p.type]), 4) });
      // Structures block scatter across their whole footprint (no loose debris sealed inside a building).
      const def = OBJECT_TYPES[p.type];
      if (def.objectClass >= 7 && (p.y ?? 0) < 0.5) blockers.push({ cx: p.x, cz: p.z, hx: def.size[0] / 2 + 0.3, hz: def.size[2] / 2 + 0.3, yaw: p.yaw ?? 0 });
    }
    for (const c of [...this.city.clusters, ...extraClusters]) {
      const def = OBJECT_TYPES[c.type];
      const r = footprintRadius(def);
      let placed = 0;
      for (let attempt = 0; placed < c.count && attempt < c.count * 30; attempt++) {
        const a = rand() * Math.PI * 2;
        const dist = Math.sqrt(rand()) * c.radius;
        const x = c.x + Math.cos(a) * dist;
        const z = c.z + Math.sin(a) * dist;
        if (!this.isFree(x, z, r, occupied) || blockers.some((b) => circleVsObb(x, z, r, b, this.contact))) continue;
        pending.push({ typeId: c.type, x, z, yaw: rand() * Math.PI * 2 });
        occupied.push({ x, z, r });
        placed++;
      }
    }

    const counts = new Map<ObjectTypeId, number>();
    for (const p of pending) counts.set(p.typeId, (counts.get(p.typeId) ?? 0) + 1);
    const geometryIds = this.createBatches(counts);

    const byTag = new Map<string, WorldObject>();
    for (const p of pending) {
      const def = OBJECT_TYPES[p.typeId] as ObjectType;
      const [w, , d] = def.size;
      const baseY = p.y ?? this.city.groundHeight(p.x, p.z);
      const obj: WorldObject = {
        id: this.objects.length,
        typeId: p.typeId,
        def,
        instances: geometryIds.get(p.typeId)!.map(({ batch, geometryId, lodId }) => ({ batch, id: batch.mesh.addInstance(geometryId), geometryId, lodId })),
        lod: false,
        x: p.x,
        y: baseY,
        z: p.z,
        baseY,
        yaw: p.yaw,
        scale: 1,
        squash: 0,
        tilt: 0,
        obb: { cx: p.x, cz: p.z, hx: w / 2, hz: d / 2, yaw: p.yaw },
        radius: 0,
        requiredPower: def.requiredPower ?? SIZE_CLASSES[def.objectClass].requiredPower,
        baseColor: new THREE.Color(def.colors[Math.floor(rand() * def.colors.length)]),
        tint: new THREE.Color(1, 1, 1),
        state: 'idle',
        vx: 0,
        vy: 0,
        vz: 0,
        pullTime: 0,
        spin: 0,
        bumpCooldown: 0,
        dirty: true,
        supports: [],
        anchored: false,
        falling: false,
        matrix: new THREE.Matrix4(),
      };
      obj.radius = obbRadius(obj.obb);
      this.objects.push(obj);
      if (def.objectClass >= 7 && def.size[1] > 4 && baseY < 0.5) {
        const proxy = new THREE.Mesh(new THREE.BoxGeometry(def.size[0], def.size[1], def.size[2]));
        proxy.position.set(p.x, baseY + def.size[1] / 2, p.z);
        proxy.rotation.y = p.yaw;
        proxy.updateMatrixWorld();
        this.occluders.push(proxy);
        this.structureProxies.set(obj, proxy);
      }
      if (p.tag) byTag.set(p.tag, obj);
    }
    this.buildGrid();
    pending.forEach((p, i) => {
      if (!p.supports) return;
      const o = this.objects[i];
      o.supports = p.supports.map((t) => byTag.get(t)).filter((x): x is WorldObject => !!x);
      o.anchored = o.def.destructionType === 'collapse' && o.supports.length > 0;
    });
    this.syncInstances();
  }

  /** Absorbable right now: idle, not held up by a support, and within the player's power. */
  isEligible(o: WorldObject, power: number): boolean {
    return o.state === 'idle' && !o.anchored && !o.falling && power >= o.requiredPower;
  }

  /** Solid to the player: idle and either too big or still anchored. */
  isSolid(o: WorldObject, power: number): boolean {
    // Held up in the air (roof bays, landmark decks, arch attics): machines pass underneath.
    if (!o.falling && o.y > this.city.groundHeight(o.x, o.z) + 2.5) return false;
    return o.state === 'idle' && (o.anchored || power < o.requiredPower);
  }

  /**
   * Called when an object is absorbed: what it held up may fall. A spanning 'collapse' member
   * (roof bay) fails as soon as either end loses its support; a stacked object (container)
   * only falls once everything under it is gone.
   */
  releaseDependents(removed: WorldObject, from: WorldObject = removed): WorldObject[] {
    const released: WorldObject[] = [];
    const gone = (s: WorldObject) => s.state === 'absorbed' || s.falling;
    for (const o of this.objects) {
      if (o.state !== 'idle' || o.falling || !o.supports.includes(removed)) continue;
      const spans = o.def.destructionType === 'collapse';
      if (spans || o.supports.every(gone)) {
        o.falling = true;
        o.vy = 0;
        o.baseY = this.city.groundHeight(o.x, o.z);
        // Tall stacks topple away from the support that failed: the higher the part, the
        // further it lands (capped so the pieces stay in the plaza around the structure).
        const dx = from.x - o.x;
        const dz = from.z - o.z;
        const len = Math.hypot(dx, dz);
        const drop = o.y - this.city.groundHeight(o.x, o.z);
        if (o.def.topple && drop > 3) {
          const reach = Math.min(drop * 0.45, 22);
          const t = Math.sqrt((2 * drop) / 9.8);
          const [nx, nz] = len > 0.5 ? [dx / len, dz / len] : [Math.cos(o.id * 2.4), Math.sin(o.id * 2.4)];
          o.vx = (nx * reach) / t;
          o.vz = (nz * reach) / t;
        }
        released.push(o);
        // Whatever this part held up goes with it (cascading collapse).
        released.push(...this.releaseDependents(o, from));
      }
    }
    return released;
  }

  /** Advance falling objects; returns the ones that landed this step. */
  updateFalling(dt: number): WorldObject[] {
    const landed: WorldObject[] = [];
    for (const o of this.objects) {
      if (!o.falling || o.state !== 'idle') continue;
      o.vy -= 9.8 * dt;
      o.y += o.vy * dt;
      if (o.vx || o.vz) {
        const b = this.city.bounds;
        o.x = THREE.MathUtils.clamp(o.x + o.vx * dt, b.minX + o.radius, b.maxX - o.radius);
        o.z = THREE.MathUtils.clamp(o.z + o.vz * dt, b.minZ + o.radius, b.maxZ - o.radius);
        o.baseY = this.city.groundHeight(o.x, o.z);
      }
      o.tilt += dt * 0.35 * (o.id % 2 ? 1 : -1); // slump as it drops
      if (o.y <= o.baseY) {
        o.y = o.baseY;
        o.falling = false;
        o.vx = o.vz = 0;
        o.obb.cx = o.x;
        o.obb.cz = o.z;
        o.anchored = false;
        o.tilt = THREE.MathUtils.clamp(o.tilt, -0.12, 0.12);
        o.squash = Math.max(o.squash, 0.25); // crumpled by the impact
        landed.push(o);
      }
      o.dirty = true;
    }
    return landed;
  }

  /** Build the role batches for this spawn and register every type's role geometries in them. */
  private createBatches(counts: Map<ObjectTypeId, number>): Map<ObjectTypeId, { batch: RoleBatch; geometryId: number; lodId: number }[]> {
    const partsOf = (typeId: ObjectTypeId): PropParts => {
      let parts = partsCache.get(typeId);
      if (!parts) {
        parts = buildPropParts(OBJECT_TYPES[typeId] as ObjectType, typeId.length * 31);
        partsCache.set(typeId, parts);
      }
      return parts;
    };
    // Far LODs (quarter-density) for the heavy role geometries of class ≥ 3 objects.
    const lodsOf = (typeId: ObjectTypeId) => {
      let lods = lodCache.get(typeId);
      if (!lods) {
        lods = {};
        if (OBJECT_TYPES[typeId].objectClass >= 3)
          for (const [role, g] of Object.entries(partsOf(typeId)) as [Role, THREE.BufferGeometry][]) {
            const lod = role === 'lamps' ? null : makeLod(g, role);
            if (lod) lods[role] = lod;
          }
        lodCache.set(typeId, lods);
      }
      return lods;
    };
    // Size every batch first: BatchedMesh buffers are allocated up front.
    const sizing = new Map<string, { role: Role; small: boolean; instances: number; vertices: number }>();
    for (const [typeId, count] of counts) {
      const small = OBJECT_TYPES[typeId].objectClass <= 5;
      for (const [role, g] of Object.entries(partsOf(typeId)) as [Role, THREE.BufferGeometry][]) {
        const key = `${small ? 'S' : 'L'}:${role}`;
        const e = sizing.get(key) ?? { role, small, instances: 0, vertices: 0 };
        e.instances += count;
        e.vertices += g.getAttribute('position').count + (lodsOf(typeId)[role]?.getAttribute('position').count ?? 0);
        sizing.set(key, e);
      }
    }
    for (const [key, e] of sizing) {
      const mesh = new THREE.BatchedMesh(e.instances, e.vertices, 0, this.lib.roles[e.role]);
      mesh.name = `OBJ_${key.replace(':', '_')}`;
      // Real shadows for body roles; trim, lamps and glass rely on MSAA/GTAO contact.
      // The low tier keeps shadows for structures only (the small set is most of the shadow pass).
      mesh.castShadow = SHADOW_ROLES.has(e.role) && (!e.small || detail.smallShadows);
      mesh.receiveShadow = true;
      mesh.sortObjects = false;
      if (e.small) skipAO(mesh);
      this.objectsRoot.add(mesh);
      this.roleBatches.set(key, { mesh, tinted: TINTED.has(e.role) });
    }
    const out = new Map<ObjectTypeId, { batch: RoleBatch; geometryId: number; lodId: number }[]>();
    for (const typeId of counts.keys()) {
      const small = OBJECT_TYPES[typeId].objectClass <= 5;
      const list: { batch: RoleBatch; geometryId: number; lodId: number }[] = [];
      for (const [role, g] of Object.entries(partsOf(typeId)) as [Role, THREE.BufferGeometry][]) {
        const batch = this.roleBatches.get(`${small ? 'S' : 'L'}:${role}`)!;
        const geometryId = batch.mesh.addGeometry(g);
        const lod = lodsOf(typeId)[role];
        list.push({ batch, geometryId, lodId: lod ? batch.mesh.addGeometry(lod) : geometryId });
      }
      out.set(typeId, list);
    }
    return out;
  }

  /**
   * Tint: absorbable objects show full paint colour, locked ones are desaturated and darker.
   * Only objects whose locked/unlocked state changed are rewritten (a class-up used to rewrite
   * every instance colour of ~1,700 objects in the frame of the swallow that caused it).
   */
  applyEligibility(power: number): void {
    for (const o of this.objects) if (o.state !== 'absorbed') this.applyEligibilityTo(o, power);
  }

  /** Tint one object for `power` (revived props; applyEligibility for all of them). */
  applyEligibilityTo(o: WorldObject, power: number): void {
    const locked = power >= o.requiredPower && !o.anchored ? 0 : 1;
    if (this.tintLocked[o.id] === locked) return;
    this.tintLocked[o.id] = locked;
    o.tint.copy(o.baseColor);
    if (locked) o.tint.lerp(LOCKED_GREY, 0.32).multiplyScalar(0.94);
    for (const inst of o.instances) if (inst.batch.tinted) inst.batch.mesh.setColorAt(inst.id, o.tint);
  }

  /**
   * Objects whose bounding square may overlap the square (x ± r, z ± r), in id order (the
   * order a full scan would visit them), written into `out`. Callers still run their exact
   * test; this only replaces "check all ~1,700 objects" per machine per tick with the few
   * cells around it. Positions are re-binned by refreshGrid() (once per simulation step).
   */
  near(x: number, z: number, r: number, out: WorldObject[]): WorldObject[] {
    out.length = 0;
    const stamp = ++this.stamp;
    const cx0 = this.cellX(x - r);
    const cx1 = this.cellX(x + r);
    const cz0 = this.cellZ(z - r);
    const cz1 = this.cellZ(z + r);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const cell = this.cells[cz * this.gridCols + cx];
        for (let i = 0; i < cell.length; i++) {
          const o = cell[i];
          if (this.seen[o.id] === stamp) continue;
          this.seen[o.id] = stamp;
          out.push(o);
        }
      }
    }
    if (out.length > 1) out.sort(byId);
    return out;
  }

  /** Re-bin every object that moved to other cells since the last call (falling, dropped, revived). */
  refreshGrid(): void {
    const b = this.binned;
    for (const o of this.objects) {
      const k = o.id * 4;
      const cx0 = this.cellX(o.x - o.radius);
      const cz0 = this.cellZ(o.z - o.radius);
      const cx1 = this.cellX(o.x + o.radius);
      const cz1 = this.cellZ(o.z + o.radius);
      if (b[k] === cx0 && b[k + 1] === cz0 && b[k + 2] === cx1 && b[k + 3] === cz1) continue;
      this.unbin(o);
      this.bin(o, cx0, cz0, cx1, cz1);
    }
  }

  private buildGrid(): void {
    const bd = this.city.bounds;
    const margin = GRID_CELL * 2;
    this.gridX0 = bd.minX - margin;
    this.gridZ0 = bd.minZ - margin;
    this.gridCols = Math.max(1, Math.ceil((bd.maxX - bd.minX + margin * 2) / GRID_CELL));
    this.gridRows = Math.max(1, Math.ceil((bd.maxZ - bd.minZ + margin * 2) / GRID_CELL));
    this.cells = Array.from({ length: this.gridCols * this.gridRows }, () => []);
    const n = this.objects.length;
    this.binned = new Int32Array(n * 4).fill(-1);
    this.seen = new Uint32Array(n);
    this.stamp = 0;
    this.tintLocked = new Int8Array(n).fill(-1);
    for (const o of this.objects) this.bin(o, this.cellX(o.x - o.radius), this.cellZ(o.z - o.radius), this.cellX(o.x + o.radius), this.cellZ(o.z + o.radius));
  }

  private cellX(x: number): number {
    return Math.min(this.gridCols - 1, Math.max(0, Math.floor((x - this.gridX0) / GRID_CELL)));
  }

  private cellZ(z: number): number {
    return Math.min(this.gridRows - 1, Math.max(0, Math.floor((z - this.gridZ0) / GRID_CELL)));
  }

  private bin(o: WorldObject, cx0: number, cz0: number, cx1: number, cz1: number): void {
    const k = o.id * 4;
    this.binned[k] = cx0;
    this.binned[k + 1] = cz0;
    this.binned[k + 2] = cx1;
    this.binned[k + 3] = cz1;
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) this.cells[cz * this.gridCols + cx].push(o);
  }

  private unbin(o: WorldObject): void {
    const k = o.id * 4;
    const b = this.binned;
    if (b[k] < 0) return;
    for (let cz = b[k + 1]; cz <= b[k + 3]; cz++) {
      for (let cx = b[k]; cx <= b[k + 2]; cx++) {
        const cell = this.cells[cz * this.gridCols + cx];
        const i = cell.indexOf(o);
        if (i >= 0) {
          cell[i] = cell[cell.length - 1];
          cell.pop();
        }
      }
    }
    b[k] = -1;
  }

  /** Rebuild the instance transform of every object that moved or changed. */
  syncInstances(): void {
    for (const o of this.objects) {
      if (!o.dirty) continue;
      o.dirty = false;
      if (o.state !== 'idle' || o.falling) {
        const proxy = this.structureProxies.get(o);
        if (proxy) {
          this.dropProxy(proxy);
          this.structureProxies.delete(o);
        }
      }
      const s = o.state === 'absorbed' ? 0 : o.scale;
      this.quat.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, o.yaw);
      if (o.tilt) this.quat.multiply(this.tiltQ.setFromAxisAngle(this.xAxis, o.tilt));
      if (o.spin) this.quat.multiply(this.spinQ.setFromAxisAngle(this.xAxis, o.spin));
      const k = o.squash;
      o.matrix.compose(this.tmpPos.set(o.x, o.y, o.z), this.quat, this.tmpScale.set(s * (1 + 0.18 * k), s * (1 - 0.55 * k), s * (1 + 0.1 * k)));
      for (const inst of o.instances) {
        inst.batch.mesh.setMatrixAt(inst.id, o.matrix);
        if (o.state === 'absorbed') inst.batch.mesh.setVisibleAt(inst.id, false);
      }
    }
  }

  /**
   * Per-frame distance culling and LOD (render only, never gameplay): objects smaller than
   * ~3 px on screen are hidden; beyond ~9 sizes away the simplified geometry is drawn.
   * Frustum culling per camera (view and shadow) is done by BatchedMesh itself.
   */
  cull(camera: THREE.Camera): void {
    const cp = camera.position;
    const hide = detail.hideSizes * detail.hideSizes;
    const farLarge = detail.lodLarge * detail.lodLarge;
    const farSmall = detail.lodSmall * detail.lodSmall;
    let visible = 0;
    for (const o of this.objects) {
      if (o.state === 'absorbed') continue;
      const size = Math.max(o.def.size[0], o.def.size[1], o.def.size[2]);
      const dx = o.x - cp.x;
      const dy = o.y - cp.y;
      const dz = o.z - cp.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const show = d2 < size * size * hide;
      const far2 = o.def.objectClass >= 5 ? farLarge : farSmall; // vehicles and up carry the heavy geometry: simplify sooner
      const lod = o.state === 'idle' && d2 > size * size * far2;
      if (show) visible++;
      for (const inst of o.instances) {
        inst.batch.mesh.setVisibleAt(inst.id, show);
        if (lod !== o.lod) inst.batch.mesh.setGeometryIdAt(inst.id, lod ? inst.lodId : inst.geometryId);
      }
      o.lod = lod;
    }
    this.visibleInstances = visible;
  }

  get instancedMeshCount(): number {
    return this.roleBatches.size;
  }

  /** BatchedMesh keeps per-instance data in small float textures (matrices, draw indirection, colours). */
  get batchDataTextures(): number {
    let n = 0;
    for (const rb of this.roleBatches.values()) n += 2 + (rb.tinted ? 1 : 0);
    return n;
  }

  private dropProxy(m: THREE.Mesh): void {
    const i = this.occluders.indexOf(m);
    if (i >= 0) this.occluders.splice(i, 1);
    m.geometry.dispose();
  }

  /** Resolve a circle against static architecture; returns the corrected position. */
  resolveStatic(x: number, z: number, r: number): { x: number; z: number; hit: boolean } {
    let hit = false;
    for (let pass = 0; pass < 2; pass++) {
      for (const b of this.staticColliders) {
        if (circleVsObb(x, z, r, b, this.contact)) {
          x += this.contact.nx * this.contact.depth;
          z += this.contact.nz * this.contact.depth;
          hit = true;
        }
      }
    }
    x = Math.max(this.city.bounds.minX + r, Math.min(this.city.bounds.maxX - r, x));
    z = Math.max(this.city.bounds.minZ + r, Math.min(this.city.bounds.maxZ - r, z));
    return { x, z, hit };
  }

  private isFree(x: number, z: number, r: number, occupied: { x: number; z: number; r: number }[]): boolean {
    if (x < this.city.bounds.minX + r || x > this.city.bounds.maxX - r || z < this.city.bounds.minZ + r || z > this.city.bounds.maxZ - r) return false;
    for (const b of this.staticColliders) if (circleVsObb(x, z, r + 0.05, b, this.contact)) return false;
    for (const o of occupied) if (Math.hypot(o.x - x, o.z - z) < (o.r + r) * 0.85) return false;
    return true;
  }
}

/** Broad-phase cell edge, metres: a few small props per cell, a car spans 1–2, a warehouse wall ~4. */
const GRID_CELL = 8;
const LOCKED_GREY = new THREE.Color(0x6d6e70);
const byId = (a: WorldObject, b: WorldObject): number => a.id - b.id;

function footprintRadius(def: ObjectType): number {
  return Math.hypot(def.size[0], def.size[2]) / 2;
}
