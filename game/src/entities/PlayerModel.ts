import * as THREE from 'three';
import type { SkinDef } from '../config/cosmetics';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MaterialLibrary } from '../art/materials';
import { VEHICLES, type VehicleLook } from '../config/vehicles';

/**
 * AUTONOMOUS SCRAP COLLECTOR — production procedural model, authored at unit scale
 * (≈1 m footprint) and scaled by the collector's diameter. Growth is layered (§41):
 *   continuous  → root scale follows diameter
 *   tier change → new mechanical parts unfold on named pivots
 * Forward is local −Z. Design language: compact industrial machine, safety-orange
 * clearcoat shell over a gunmetal tub, a spinning intake roller behind a hazard-striped
 * lip, lidar puck, work lights. Part names are the contract for a future GLB replacement.
 */
export class PlayerModel {
  readonly root = new THREE.Group();
  private readonly chassis = new THREE.Group();
  private readonly spinners: { obj: THREE.Object3D; radius: number }[] = [];
  private readonly roller: THREE.Object3D;
  private readonly lidar: THREE.Object3D;
  private readonly tierParts = new Map<number, THREE.Group>();
  private readonly unfold = new Map<number, number>();
  private readonly arms: THREE.Object3D[] = [];
  private readonly jaws: THREE.Object3D[] = [];
  private chomp = 0;
  /**
   * Squash & stretch springs (design §47): `sq` > 0 flattens (gulp, landing), < 0 stretches tall
   * (tier-up); `ln` > 0 stretches forward (dash lunge). Underdamped, so they overshoot and settle.
   */
  private sq = 0;
  private sqV = 0;
  private ln = 0;
  private lnV = 0;
  private bob = 0;
  private t = 0;
  private readonly glow: THREE.MeshStandardMaterial;

  constructor(
    lib: MaterialLibrary,
    readonly look: VehicleLook = 'collector',
    skin?: SkinDef,
  ) {
    const R = lib.roles;
    const vdef = VEHICLES[look];
    const shell = new THREE.MeshPhysicalMaterial({ name: 'MAT_Player_Shell', color: skin?.shell ?? vdef.shell, roughness: skin?.roughness ?? 0.34, metalness: skin?.metalness ?? 0.1, clearcoat: 1, clearcoatRoughness: 0.12, envMapIntensity: 1.1 });
    const gunmetal = new THREE.MeshStandardMaterial({ name: 'MAT_Player_Gunmetal', color: 0x3a3f44, roughness: 0.42, metalness: 0.85, envMapIntensity: 1.1 });
    // Hazard chevrons scaled for a ~0.5 m lip: clone the kit texture with its own repeat.
    const hz = lib.kit.hazard;
    const rep = (t: THREE.Texture) => {
      const c = t.clone();
      c.repeat.set(7, 1);
      c.needsUpdate = true;
      return c;
    };
    const hazard = new THREE.MeshStandardMaterial({ name: 'MAT_Player_Hazard', map: rep(hz.map), normalMap: rep(hz.normalMap), roughnessMap: rep(hz.roughnessMap), metalness: 0.1 });
    this.glow = new THREE.MeshStandardMaterial({ name: 'MAT_Player_IntakeGlow', color: 0x2a1300, emissive: skin?.glow ?? 0xff9a2a, emissiveIntensity: 2.4, roughness: 0.4 });
    // Draw-call discipline: bright metal shares steel, rubber shares matte black, all small lamps share one vertex-coloured emissive.
    const M = { shell, gunmetal, hazard, steel: R.steel, chrome: R.steel, rubber: R.darkTrim, tread: R.tread, dark: R.darkTrim, glass: R.glass, glow: this.glow };
    const LAMP = { white: [1, 0.95, 0.85], red: [0.85, 0.06, 0.04], amber: [1, 0.55, 0.08] } as const;
    const lampGeo = (g: THREE.BufferGeometry, c: readonly [number, number, number]) => {
      const n = g.getAttribute('position').count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) col.set(c, i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      return g;
    };

    const mesh = (name: string, g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
      const o = new THREE.Mesh(g, m);
      o.name = name;
      o.position.set(x, y, z);
      o.rotation.set(rx, ry, rz);
      o.castShadow = true;
      o.receiveShadow = true;
      return o;
    };
    const rbox = (w: number, h: number, d: number, r: number) => new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4));
    const extrudeSide = (pts: [number, number][], width: number, bevel: number) => {
      const s = new THREE.Shape();
      s.moveTo(pts[0][0], pts[0][1]);
      for (const [z, y] of pts.slice(1)) s.lineTo(z, y);
      s.closePath();
      const depth = width - 2 * bevel;
      const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.9, bevelSegments: 4, curveSegments: 6 });
      g.translate(0, 0, -depth / 2);
      g.rotateY(-Math.PI / 2);
      return g;
    };
    /** One axle group holding both wheels (they turn together, so they merge into one mesh per material). */
    const axle = (name: string, r: number, w: number, halfTrack: number, y: number, z: number) => {
      const g = new THREE.Group();
      g.name = name;
      g.position.set(0, y, z);
      for (const side of [-1, 1]) {
        const wg = wheel(`${name}_${side < 0 ? 'L' : 'R'}`, r, w, side * halfTrack, 0, 0, side);
        g.add(wg);
      }
      this.spinners.push({ obj: g, radius: r });
      return g;
    };
    const wheel = (name: string, r: number, w: number, x: number, y: number, z: number, side: number) => {
      const g = new THREE.Group();
      g.name = name;
      g.position.set(x, y, z);
      const tyre = new THREE.LatheGeometry(
        [[r * 0.6, -w / 2], [r * 0.92, -w / 2], [r, -w * 0.34], [r, w * 0.34], [r * 0.92, w / 2], [r * 0.6, w / 2]].map(([a, b]) => new THREE.Vector2(a, b)),
        28,
      );
      const uv = tyre.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2 * Math.PI * r * 1.6, uv.getY(i) * w * 1.6);
      tyre.rotateZ(Math.PI / 2);
      g.add(mesh(`${name}_Tyre`, tyre, M.tread));
      g.add(mesh(`${name}_Rim`, new THREE.CylinderGeometry(r * 0.62, r * 0.62, w * 0.78, 24).rotateZ(Math.PI / 2), M.gunmetal));
      g.add(mesh(`${name}_Hub`, new THREE.CylinderGeometry(r * 0.22, r * 0.26, w * 0.9, 12).rotateZ(Math.PI / 2), M.chrome, side * 0.005));
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        g.add(mesh(`${name}_Bolt${i}`, new THREE.CylinderGeometry(r * 0.04, r * 0.04, w * 0.95, 6).rotateZ(Math.PI / 2), M.steel, 0, Math.cos(a) * r * 0.38, Math.sin(a) * r * 0.38));
      }
      return g;
    };

    this.root.name = 'PLAYER_ScrapCollector';
    this.chassis.name = 'Chassis';
    this.root.add(this.chassis);

    // ── Tier 1: compact collector ───────────────────────────────────────────
    const t1 = this.part(1);
    // Gunmetal tub (lower hull) and orange shell (upper body) from side profiles.
    t1.add(mesh('Hull_Tub', extrudeSide([[-0.36, 0.14], [0.38, 0.14], [0.42, 0.3], [0.4, 0.42], [-0.4, 0.42], [-0.44, 0.26]], 0.62, 0.035), M.gunmetal));
    t1.add(mesh('Body_Shell', extrudeSide([[-0.3, 0.4], [0.4, 0.4], [0.38, 0.6], [0.2, 0.68], [-0.14, 0.68], [-0.3, 0.56]], 0.58, 0.05), M.shell));
    // Panel lines and access hatch on the shell.
    // The shell's bevel pushes its surface ~0.045 out of the profile: surface details sit on that skin.
    for (const z of [-0.08, 0.2]) t1.add(mesh('Shell_PanelLine', new THREE.BoxGeometry(0.6, 0.006, 0.01), M.dark, 0, 0.727, z));
    t1.add(mesh('Shell_Hatch', rbox(0.3, 0.022, 0.22, 0.01), M.gunmetal, 0, 0.732, 0.06));
    for (const [x, z] of [[-0.13, -0.03], [0.13, -0.03], [-0.13, 0.15], [0.13, 0.15]]) t1.add(mesh('Hatch_Bolt', new THREE.CylinderGeometry(0.008, 0.008, 0.012, 6), M.steel, x, 0.745, z));
    for (const s of [-1, 1]) t1.add(mesh('Shell_SideVent', rbox(0.012, 0.07, 0.2, 0.004), M.dark, s * 0.338, 0.55, 0.12));
    // Intake: dark throat, spinning brush roller, hazard-striped lip, glow ring.
    t1.add(mesh('Intake_Throat', rbox(0.5, 0.22, 0.08, 0.03), M.dark, 0, 0.3, -0.4));
    const roller = new THREE.Group();
    roller.name = 'Intake_Roller';
    roller.position.set(0, 0.24, -0.43);
    roller.add(mesh('Roller_Core', new THREE.CylinderGeometry(0.075, 0.075, 0.46, 16).rotateZ(Math.PI / 2), M.gunmetal));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      roller.add(mesh('Roller_Flight', new THREE.BoxGeometry(0.44, 0.012, 0.05), M.rubber, 0, Math.cos(a) * 0.08, Math.sin(a) * 0.08, a));
    }
    t1.add(roller);
    this.roller = roller;
    t1.add(mesh('Intake_Lip', rbox(0.56, 0.05, 0.1, 0.015), M.hazard, 0, 0.12, -0.45));
    t1.add(mesh('Intake_GlowStrip', new THREE.BoxGeometry(0.46, 0.018, 0.02), M.glow, 0, 0.42, -0.425));
    // Work lights and sensor mast with a spinning lidar puck.
    for (const s of [-1, 1]) {
      t1.add(mesh('WorkLight_Housing', rbox(0.1, 0.06, 0.05, 0.012), M.dark, s * 0.22, 0.58, -0.36));
      t1.add(mesh('WorkLight_Lens', lampGeo(new THREE.BoxGeometry(0.075, 0.035, 0.01), LAMP.white), R.lamps, s * 0.22, 0.58, -0.388));
      t1.add(mesh('Fender_Small', extrudeSide([[-0.28, 0.3], [0.28, 0.3], [0.24, 0.46], [-0.24, 0.46]], 0.1, 0.02), M.gunmetal, s * 0.37, 0.06, -0.02));
    }
    t1.add(mesh('Sensor_Mast', new THREE.CylinderGeometry(0.018, 0.022, 0.14, 10), M.steel, 0.17, 0.75, 0.2));
    const lidar = new THREE.Group();
    lidar.name = 'Sensor_Lidar';
    lidar.position.set(0.17, 0.84, 0.2);
    lidar.add(mesh('Lidar_Puck', new THREE.CylinderGeometry(0.045, 0.045, 0.04, 16), M.dark));
    lidar.add(mesh('Lidar_Window', new THREE.CylinderGeometry(0.046, 0.046, 0.014, 16), M.glow));
    t1.add(lidar);
    this.lidar = lidar;
    t1.add(mesh('Exhaust_Grille', rbox(0.3, 0.1, 0.03, 0.01), M.dark, 0, 0.52, 0.455));
    for (let i = 0; i < 4; i++) t1.add(mesh('Grille_Slat', new THREE.BoxGeometry(0.27, 0.008, 0.012), M.steel, 0, 0.485 + i * 0.023, 0.47));
    for (const s of [-1, 1]) {
      t1.add(mesh('TailLight', lampGeo(rbox(0.1, 0.045, 0.02, 0.008), LAMP.red), R.lamps, s * 0.2, 0.61, 0.452));
      t1.add(mesh('Reflector', lampGeo(new THREE.BoxGeometry(0.05, 0.03, 0.01), LAMP.amber), R.lamps, s * 0.27, 0.34, 0.462));
    }
    t1.add(mesh('Rear_HazardBand', rbox(0.46, 0.06, 0.02, 0.008), M.hazard, 0, 0.3, 0.462));
    t1.add(mesh('Rear_TowHook', new THREE.TorusGeometry(0.03, 0.009, 6, 12), M.steel, 0, 0.22, 0.47));
    // Two drive wheels + a rear castor.
    t1.add(axle('Axle_Front', 0.21, 0.13, 0.38, 0.21, -0.12));
    t1.add(mesh('Castor_Fork', new THREE.BoxGeometry(0.05, 0.1, 0.06), M.gunmetal, 0, 0.12, 0.3));
    t1.add(mesh('Castor_Wheel', new THREE.CylinderGeometry(0.065, 0.065, 0.05, 14).rotateZ(Math.PI / 2), M.rubber, 0, 0.065, 0.32));

    // ── Machine type bolt-ons (arena vehicle choice) ─────────────────────────
    if (look === 'dozer') {
      // Full-width push blade with a hazard edge and push arms.
      t1.add(mesh('Dozer_Blade', extrudeSide([[-0.1, 0.02], [0.03, 0.02], [0.02, 0.36], [-0.08, 0.3]], 0.96, 0.02), M.gunmetal, 0, 0, -0.56));
      t1.add(mesh('Dozer_BladeEdge', rbox(0.98, 0.05, 0.05, 0.01), M.hazard, 0, 0.36, -0.6));
      for (const s of [-1, 1]) t1.add(mesh('Dozer_PushArm', new THREE.BoxGeometry(0.05, 0.06, 0.34), M.gunmetal, s * 0.36, 0.14, -0.36));
    } else if (look === 'racer') {
      // Rear wing on uprights and low side skirts.
      t1.add(mesh('Racer_Wing', rbox(0.66, 0.025, 0.14, 0.008), M.shell, 0, 0.86, 0.36, 0.12));
      for (const s of [-1, 1]) {
        t1.add(mesh('Racer_WingPost', new THREE.BoxGeometry(0.025, 0.2, 0.05), M.dark, s * 0.24, 0.76, 0.37));
        t1.add(mesh('Racer_Skirt', rbox(0.03, 0.06, 0.6, 0.01), M.hazard, s * 0.33, 0.2, 0));
      }
    } else if (look === 'magnet') {
      // Electromagnet dish on a pivot post.
      t1.add(mesh('Magnet_Post', new THREE.CylinderGeometry(0.035, 0.045, 0.2, 10), M.gunmetal, 0, 0.8, 0.02));
      t1.add(mesh('Magnet_Dish', new THREE.CylinderGeometry(0.26, 0.2, 0.06, 24), M.gunmetal, 0, 0.92, 0.02));
      t1.add(mesh('Magnet_Coil', new THREE.TorusGeometry(0.21, 0.025, 8, 28).rotateX(Math.PI / 2), M.chrome, 0, 0.955, 0.02));
      t1.add(mesh('Magnet_Core', new THREE.CylinderGeometry(0.12, 0.12, 0.02, 20), M.glow, 0, 0.96, 0.02));
    }

    // ── Tier 2: intake chassis — hopper, flared fenders, rear drive, dozer scoop ──
    const t2 = this.part(2);
    t2.add(mesh('Hopper_Bin', extrudeSide([[-0.05, 0.66], [0.4, 0.66], [0.44, 0.86], [-0.1, 0.86]], 0.5, 0.025), M.shell));
    for (let i = 0; i < 4; i++) t2.add(mesh('Hopper_Rib', new THREE.BoxGeometry(0.52, 0.02, 0.02), M.gunmetal, 0, 0.7 + i * 0.05, 0.43 - i * 0.003));
    t2.add(mesh('Hopper_Grate', new THREE.BoxGeometry(0.44, 0.012, 0.44), M.dark, 0, 0.862, 0.17));
    for (const s of [-1, 1]) {
      const side = s < 0 ? 'L' : 'R';
      t2.add(mesh(`Fender_${side}`, extrudeSide([[-0.36, 0.44], [0.36, 0.44], [0.3, 0.52], [-0.3, 0.52]], 0.2, 0.025), M.shell, s * 0.4, 0, -0.1));
      t2.add(mesh(`ScoopRam_${side}`, new THREE.CylinderGeometry(0.02, 0.02, 0.26, 8), M.chrome, s * 0.26, 0.26, -0.5, 1.2));
      t2.add(mesh(`ScoopRam_Barrel_${side}`, new THREE.CylinderGeometry(0.03, 0.03, 0.16, 8), M.gunmetal, s * 0.26, 0.33, -0.43, 1.2));
    }
    t2.add(axle('Axle_Rear', 0.16, 0.12, 0.37, 0.16, 0.3));
    t2.add(mesh('Scoop_Blade', extrudeSide([[-0.12, 0.02], [0.02, 0.02], [0.0, 0.2], [-0.1, 0.12]], 0.78, 0.015), M.gunmetal, 0, 0, -0.52));
    t2.add(mesh('Scoop_Edge', new THREE.BoxGeometry(0.78, 0.025, 0.04), M.steel, 0, 0.025, -0.65));
    t2.add(mesh('Beacon_Base', new THREE.CylinderGeometry(0.035, 0.04, 0.03, 12), M.dark, -0.17, 0.885, -0.02));
    t2.add(mesh('Beacon_Dome', lampGeo(new THREE.SphereGeometry(0.035, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), LAMP.amber), R.lamps, -0.17, 0.9, -0.02));

    // ── Tier 3: reinforced hauler — manipulator arms, roll cage, armour ──
    const t3 = this.part(3);
    for (const s of [-1, 1]) {
      const side = s < 0 ? 'L' : 'R';
      const arm = new THREE.Group();
      arm.name = `Arm_${side}`;
      arm.position.set(s * 0.33, 0.62, -0.18);
      arm.add(mesh(`Arm_${side}_Shoulder`, new THREE.SphereGeometry(0.05, 12, 8), M.gunmetal));
      arm.add(mesh(`Arm_${side}_Boom`, rbox(0.06, 0.07, 0.36, 0.015), M.shell, 0, 0, -0.18));
      arm.add(mesh(`Arm_${side}_Ram`, new THREE.CylinderGeometry(0.014, 0.014, 0.28, 8).rotateX(Math.PI / 2), M.chrome, 0, -0.05, -0.15));
      const claw = new THREE.Group();
      claw.name = `Arm_${side}_Claw`;
      claw.position.set(0, 0, -0.37);
      claw.add(mesh('Claw_Wrist', new THREE.CylinderGeometry(0.04, 0.04, 0.05, 10).rotateZ(Math.PI / 2), M.gunmetal));
      for (const k of [-1, 1]) claw.add(mesh('Claw_Finger', rbox(0.025, 0.1, 0.03, 0.008), M.steel, 0, k * 0.03, -0.05, k * 0.5));
      arm.add(claw);
      arm.rotation.x = 0.4;
      t3.add(arm);
      this.arms.push(arm);
      t3.add(mesh(`Armour_Skirt_${side}`, rbox(0.03, 0.14, 0.62, 0.01), M.gunmetal, s * 0.335, 0.28, 0));
    }
    const cage = new THREE.CatmullRomCurve3([new THREE.Vector3(-0.3, 0.66, 0.02), new THREE.Vector3(-0.26, 0.9, 0.0), new THREE.Vector3(0.26, 0.9, 0.0), new THREE.Vector3(0.3, 0.66, 0.02)]);
    t3.add(mesh('RollCage', new THREE.TubeGeometry(cage, 24, 0.018, 8), M.gunmetal));
    t3.add(mesh('RollCage_Lights', lampGeo(new THREE.BoxGeometry(0.3, 0.03, 0.03), LAMP.white), R.lamps, 0, 0.915, -0.005));

    // ── Tier 4: industrial recycler — track pods, crusher jaws, cyclone, twin stacks ──
    const t4 = this.part(4);
    for (const s of [-1, 1]) {
      const side = s < 0 ? 'L' : 'R';
      t4.add(mesh(`TrackPod_${side}`, rbox(0.15, 0.3, 1.0, 0.12), M.tread, s * 0.56, 0.15, 0.05));
      t4.add(mesh(`TrackFrame_${side}`, rbox(0.06, 0.12, 0.7, 0.03), M.gunmetal, s * 0.64, 0.17, 0.05));
      for (const z of [-0.28, 0.05, 0.38]) t4.add(mesh(`TrackRoller_${side}`, new THREE.CylinderGeometry(0.075, 0.075, 0.03, 14).rotateZ(Math.PI / 2), M.steel, s * 0.645, 0.13, z));
      t4.add(mesh(`TrackStrut_${side}`, rbox(0.14, 0.08, 0.3, 0.02), M.gunmetal, s * 0.44, 0.24, 0.05));
      t4.add(mesh(`Armour_Hazard_${side}`, rbox(0.02, 0.1, 0.62, 0.008), M.hazard, s * 0.35, 0.52, 0.04));
      t4.add(mesh(`Stack_${side}`, new THREE.CylinderGeometry(0.035, 0.04, 0.42, 12), M.chrome, s * 0.2, 1.06, 0.4));
      t4.add(mesh(`Stack_Cap_${side}`, new THREE.CylinderGeometry(0.045, 0.045, 0.03, 12), M.dark, s * 0.2, 1.28, 0.4));
      // Crusher jaw on a pivot so it can chomp.
      const jaw = new THREE.Group();
      jaw.name = `CrusherJaw_${side}`;
      jaw.position.set(s * 0.3, 0.28, -0.52);
      jaw.add(mesh(`Jaw_${side}_Plate`, rbox(0.06, 0.34, 0.26, 0.02), M.gunmetal, 0, 0, -0.1));
      for (let k = 0; k < 4; k++) jaw.add(mesh(`Jaw_${side}_Tooth`, new THREE.ConeGeometry(0.025, 0.07, 6).rotateZ(-s * Math.PI / 2), M.steel, -s * 0.05, -0.12 + k * 0.08, -0.16));
      jaw.add(mesh(`Jaw_${side}_Ram`, new THREE.CylinderGeometry(0.018, 0.018, 0.26, 8).rotateX(Math.PI / 2), M.chrome, 0, 0.14, 0.05));
      t4.add(jaw);
      this.jaws.push(jaw);
    }
    t4.add(mesh('Cyclone_Drum', new THREE.CylinderGeometry(0.13, 0.13, 0.22, 20), M.shell, -0.12, 1.0, 0.26));
    t4.add(mesh('Cyclone_Cone', new THREE.CylinderGeometry(0.13, 0.04, 0.14, 20), M.gunmetal, -0.12, 0.83, 0.26));
    t4.add(mesh('Cyclone_Duct', new THREE.TorusGeometry(0.12, 0.025, 8, 16, Math.PI), M.gunmetal, -0.12, 1.1, 0.14, 0, Math.PI / 2));
    t4.add(mesh('LightBar', lampGeo(new THREE.BoxGeometry(0.5, 0.035, 0.03), LAMP.white), R.lamps, 0, 0.95, -0.24));
    t4.add(mesh('LightBar_Mount', new THREE.BoxGeometry(0.54, 0.03, 0.05), M.dark, 0, 0.925, -0.22));
    for (const s of [-1, 1]) t4.add(mesh('Beacon_T4', lampGeo(new THREE.SphereGeometry(0.03, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), LAMP.amber), R.lamps, s * 0.28, 0.95, -0.24));

    mergeStaticParts(this.chassis);
  }

  private part(tier: number): THREE.Group {
    const g = new THREE.Group();
    g.name = `Tier${tier}_Parts`;
    this.chassis.add(g);
    this.tierParts.set(tier, g);
    this.unfold.set(tier, tier === 1 ? 1 : 0);
    g.visible = tier === 1;
    return g;
  }

  /** Show every part up to `tier`. With `animate`, newly reached parts unfold. */
  setTier(tier: number, animate: boolean): void {
    let grew = false;
    for (const [t, group] of this.tierParts) {
      const reached = t <= tier;
      if (reached && !group.visible) grew = true;
      group.visible = reached;
      if (!reached) this.unfold.set(t, 0);
      else if (!animate) this.unfold.set(t, 1);
    }
    if (animate && grew) {
      // Tier-up: the whole machine stretches up as the new parts unfold, then settles.
      this.sq = -0.22;
      this.sqV = 0;
      this.glow.emissiveIntensity = 8;
    }
  }

  /** Brief intake flare when something is absorbed; bigger meals also make the body gulp. */
  pulseIntake(amount: number): void {
    this.glow.emissiveIntensity = Math.min(8, this.glow.emissiveIntensity + amount);
    this.chomp = Math.min(1, this.chomp + amount * 0.25);
    this.squash(Math.min(0.12, amount * 0.016));
  }

  /** Instant squash (> 0 flatter, < 0 taller); the spring returns it to rest with overshoot. */
  squash(amount: number): void {
    this.sq = THREE.MathUtils.clamp(this.sq + amount, -0.3, 0.3);
  }

  /** Dash: a crouch that springs into a forward stretch. */
  lunge(amount: number): void {
    this.sq = Math.min(0.3, this.sq + amount * 0.5);
    this.lnV += amount * 14;
  }

  /** Dash is ready again: a quick glint on the intake. */
  blink(): void {
    this.glow.emissiveIntensity = Math.min(8, this.glow.emissiveIntensity + 1.6);
  }

  update(dt: number, diameter: number, speed: number, heading: number, x: number, z: number, lean: number, groundY = 0): void {
    this.t += dt;
    this.root.position.set(x, THREE.MathUtils.lerp(this.root.position.y, groundY, 1 - Math.exp(-14 * dt)), z);
    this.root.rotation.y = heading;
    this.root.scale.setScalar(diameter);
    const distance = (speed * dt) / diameter;
    for (const s of this.spinners) s.obj.rotation.x -= distance / s.radius;
    this.roller.rotation.x -= dt * (6 + (speed / diameter) * 8);
    this.lidar.rotation.y += dt * 5;
    this.bob += dt * (4 + (speed * 3) / Math.max(diameter, 0.2));
    this.chassis.position.y = Math.abs(Math.sin(this.bob)) * 0.008 * Math.min(1, speed);
    this.chassis.rotation.z = THREE.MathUtils.lerp(this.chassis.rotation.z, -lean * 0.1, 1 - Math.exp(-10 * dt));
    this.chassis.rotation.x = THREE.MathUtils.lerp(this.chassis.rotation.x, -Math.min(1, speed / (4 * diameter + 1)) * 0.03, 1 - Math.exp(-6 * dt));
    this.glow.emissiveIntensity += (2.4 - this.glow.emissiveIntensity) * (1 - Math.exp(-5 * dt));
    // Squash & stretch springs (semi-implicit Euler; stiff, underdamped → one visible overshoot).
    this.sqV += (-240 * this.sq - 13 * this.sqV) * dt;
    this.sq += this.sqV * dt;
    this.lnV += (-200 * this.ln - 12 * this.lnV) * dt;
    this.ln += this.lnV * dt;
    const sy = 1 - this.sq;
    const sxz = 1 + this.sq * 0.5;
    this.chassis.scale.set(sxz / (1 + this.ln * 0.3), sy / (1 + this.ln * 0.3), sxz * (1 + this.ln));
    for (const arm of this.arms) arm.rotation.x = 0.4 + Math.sin(this.t * 1.7 + arm.position.x * 9) * 0.06;
    // Crusher jaws snap shut on every big absorb, then reopen.
    this.chomp = Math.max(0, this.chomp - dt * 2.5);
    for (const jaw of this.jaws) jaw.rotation.y = Math.sign(jaw.position.x) * (0.35 - 0.5 * Math.sin(this.chomp * Math.PI));
    for (const [t, group] of this.tierParts) {
      if (!group.visible) continue;
      const p = Math.min(1, (this.unfold.get(t) ?? 1) + dt * 2.2);
      this.unfold.set(t, p);
      const k = 1 + 2.2 * Math.pow(p - 1, 3) + 1.2 * Math.pow(p - 1, 2);
      group.scale.setScalar(t === 1 ? 1 : Math.max(0.001, k));
    }
  }
}

/**
 * Draw-call discipline: inside every group, merge the directly-owned meshes that share a
 * material into one mesh (their local transforms baked in). Animated sub-groups (wheels,
 * roller, lidar, arms) stay separate groups and are merged internally the same way.
 */
function mergeStaticParts(group: THREE.Object3D): void {
  // Wheel sub-groups inside an axle never move relative to it: flatten them into the axle first.
  if (group.name.startsWith('Axle_')) {
    for (const wheelGroup of [...group.children]) {
      if ((wheelGroup as THREE.Mesh).isMesh) continue;
      wheelGroup.updateMatrix();
      for (const m of [...wheelGroup.children]) {
        m.applyMatrix4(wheelGroup.matrix);
        group.add(m);
      }
      group.remove(wheelGroup);
    }
  }
  for (const child of [...group.children]) if (!(child as THREE.Mesh).isMesh) mergeStaticParts(child);
  const byMaterial = new Map<THREE.Material, THREE.Mesh[]>();
  for (const child of group.children) {
    const m = child as THREE.Mesh;
    if (!m.isMesh) continue;
    const list = byMaterial.get(m.material as THREE.Material) ?? [];
    list.push(m);
    byMaterial.set(m.material as THREE.Material, list);
  }
  for (const [material, meshes] of byMaterial) {
    if (meshes.length < 2) continue;
    const geos = meshes.map((m) => {
      m.updateMatrix();
      const g = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(m.matrix);
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k);
      if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
      return g;
    });
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const out = new THREE.Mesh(merged, material);
    out.name = `${group.name || 'Group'}_${material.name || 'mat'}`;
    out.castShadow = true;
    out.receiveShadow = true;
    for (const m of meshes) group.remove(m);
    group.add(out);
  }
}
