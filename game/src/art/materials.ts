import * as THREE from 'three';
import { signTexture, type TextureKit } from './textures';
import { createSignAtlas } from './signs';
import { interiorMapping, weathering } from './surfaceShaders';
import type { Quality } from './postfx';

/** Parameters only MeshPhysicalMaterial understands (dropped when the low tier folds it to standard). */
const PHYSICAL_ONLY = ['clearcoat', 'clearcoatRoughness', 'clearcoatMap', 'clearcoatNormalMap', 'clearcoatNormalScale', 'clearcoatRoughnessMap', 'sheen', 'sheenColor', 'sheenRoughness', 'sheenColorMap', 'sheenRoughnessMap', 'transmission', 'thickness', 'ior', 'reflectivity', 'iridescence', 'specularIntensity', 'specularColor', 'anisotropy', 'dispersion'] as const;

/**
 * Shared material roles (technical-art.md: one material per role, reused everywhere).
 * `tinted` roles receive per-instance colour (object paint variants + locked/unlocked read);
 * the rest keep their true colour so glass, rubber and lights never get tinted.
 */
export type Role =
  // props
  | 'paint' // painted metal, tinted (dumpsters, vending, bins)
  | 'carPaint' // clearcoat automotive paint, tinted
  | 'plastic' // moulded plastic, tinted (cones, bins, bags, crates)
  | 'glossyPlastic' // trash-bag film, tinted
  | 'cardboard' // textured, tinted
  | 'propBrick' // clay brick, tinted
  | 'glassTint' // bottle glass, tinted
  | 'aluminium' // cans, tinted (printed label colour)
  | 'fabric' // awnings, seat pads, tinted
  | 'wood' // slats (chairs, tables)
  | 'timber' // sawn timber, tinted (pallets, scaffold boards, bearers)
  | 'steel' // bare/brushed steel
  | 'chrome'
  | 'rubber'
  | 'tread'
  | 'darkTrim' // black plastic trim, grilles, bumpers
  | 'glass' // automotive glass, untinted
  | 'clearGlass' // see-through glazing (vending fronts)
  | 'sign' // lettered signage (warehouse)
  | 'citySign' // city signage atlas (neon, shop boards, billboards), self-lit
  | 'copper' // verdigris copper roofs and domes (Peace Hotel, Paris kiosks)
  | 'stone' // pale dressed limestone / granite for monuments (untinted)
  | 'headlight'
  | 'taillight'
  | 'signalAmber'
  | 'lamps' // merged vehicle lamps: emissive colour comes from vertex colour
  | 'reflective' // retro-reflective band (cones)
  | 'screen' // vending machine lit panel
  | 'corrugated' // warehouse cladding, tinted
  | 'roofMetal'
  | 'concreteProp';

export const TINTED: ReadonlySet<Role> = new Set<Role>(['paint', 'carPaint', 'plastic', 'glossyPlastic', 'cardboard', 'propBrick', 'glassTint', 'aluminium', 'fabric', 'corrugated', 'concreteProp', 'timber']);

function tex(set: { map: THREE.Texture; normalMap: THREE.Texture; roughnessMap: THREE.Texture }, normalScale = 1) {
  return { map: set.map, normalMap: set.normalMap, roughnessMap: set.roughnessMap, normalScale: new THREE.Vector2(normalScale, normalScale) };
}

/** City signage: the atlas both colours and lights the sign (neon halos bloom). */
function citySignMaterial(): THREE.MeshStandardMaterial {
  const atlas = createSignAtlas();
  return new THREE.MeshStandardMaterial({ map: atlas, emissiveMap: atlas, emissive: 0xffffff, emissiveIntensity: 0.85, roughness: 0.45, metalness: 0 });
}

/** Vehicle lamps in one draw call: vertex colour drives both base and emissive colour. */
function lampsMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.25 });
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance *= vColor.rgb;');
  };
  m.customProgramCacheKey = () => 'lamps-vertex-emissive';
  return m;
}

export class MaterialLibrary {
  readonly roles: Record<Role, THREE.Material>;
  /** Architecture + ground. */
  readonly arch: Record<'brick' | 'darkBrick' | 'plaster' | 'concrete' | 'asphalt' | 'sidewalk' | 'curb' | 'windowGlass' | 'windowFrame' | 'steelDark' | 'roofing' | 'awning' | 'shopGlass' | 'puddle' | 'paintLine' | 'lampGlow' | 'skylineWindows' | 'hazard' | 'craneYellow' | 'gravel' | 'metalLight' | 'metals' | 'water' | 'stone' | 'signalRed' | 'signalGreen' | 'lantern', THREE.Material>;

  /**
   * `quality: 'low'` folds every physical material (clearcoat / sheen lobes) into a standard
   * one: the second specular lobe roughly doubles the lighting cost of car paint and glass,
   * which the low tier (weak phones) cannot afford. Other tiers are unchanged.
   */
  constructor(
    readonly kit: TextureKit,
    quality: Quality = 'high',
  ) {
    const std = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(p);
    const phy = (p: THREE.MeshPhysicalMaterialParameters): THREE.MeshStandardMaterial => {
      if (quality !== 'low') return new THREE.MeshPhysicalMaterial(p);
      const q: Record<string, unknown> = { ...p };
      for (const k of PHYSICAL_ONLY) delete q[k];
      return new THREE.MeshStandardMaterial(q as THREE.MeshStandardMaterialParameters);
    };
    this.roles = {
      paint: std({ color: 0xffffff, ...tex(kit.wornPaint, 0.6), metalness: 0.35, envMapIntensity: 0.8 }),
      carPaint: phy({ color: 0xffffff, metalness: 0.35, roughness: 0.38, clearcoat: 0.8, clearcoatRoughness: 0.1, envMapIntensity: 1.0 }),
      plastic: std({ color: 0xffffff, roughness: 0.55, metalness: 0, envMapIntensity: 0.6 }),
      glossyPlastic: phy({ color: 0xffffff, roughness: 0.42, metalness: 0, clearcoat: 0.25, clearcoatRoughness: 0.45, envMapIntensity: 0.7 }),
      cardboard: std({ color: 0xffffff, ...tex(kit.cardboard, 0.5), metalness: 0 }),
      propBrick: std({ color: 0xffffff, ...tex(kit.concrete, 0.8), roughness: 1, metalness: 0 }),
      glassTint: phy({ color: 0xffffff, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.72, clearcoat: 1, envMapIntensity: 1.4, depthWrite: true }),
      aluminium: std({ color: 0xffffff, roughness: 0.3, metalness: 0.75, envMapIntensity: 1.2 }),
      fabric: phy({ color: 0xffffff, roughness: 0.9, sheen: 0.6, sheenRoughness: 0.6, sheenColor: new THREE.Color(0xffffff), envMapIntensity: 0.4 }),
      wood: std({ color: 0x8a6440, roughness: 0.78, metalness: 0 }),
      timber: std({ color: 0xffffff, ...tex(kit.cardboard, 0.9), roughness: 0.85, metalness: 0 }),
      steel: std({ color: 0xa9afb5, roughness: 0.42, metalness: 1, envMapIntensity: 1.1 }),
      chrome: std({ color: 0xe6e9ec, roughness: 0.12, metalness: 1, envMapIntensity: 1.3 }),
      rubber: std({ color: 0x1a1a1c, roughness: 0.9, metalness: 0, envMapIntensity: 0.35 }),
      tread: std({ color: 0xffffff, ...tex(kit.tread, 1.2), metalness: 0, envMapIntensity: 0.3 }),
      darkTrim: std({ color: 0x1f2123, roughness: 0.6, metalness: 0.1, envMapIntensity: 0.5 }),
      glass: phy({ color: 0x1b2328, roughness: 0.05, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.6 }),
      clearGlass: phy({ color: 0xcfd8de, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.22, clearcoat: 1, envMapIntensity: 1.5, depthWrite: false }),
      sign: std({ map: signTexture('SCRAP CITY RECYCLING', '#e9e4d8', '#8a2f1f', 2048, 200, 'bold 150px system-ui, sans-serif'), roughness: 0.55, metalness: 0.05 }),
      citySign: citySignMaterial(),
      copper: std({ color: 0x5f9e8a, roughness: 0.62, metalness: 0.35, envMapIntensity: 0.9 }),
      stone: std({ color: 0xd9d0bd, ...tex(kit.concrete, 0.7), roughness: 0.85, metalness: 0 }),
      lamps: lampsMaterial(),
      headlight: std({ color: 0xf4f1e8, emissive: 0xfff2d6, emissiveIntensity: 0.6, roughness: 0.2 }),
      taillight: std({ color: 0x5a0d0d, emissive: 0xc41a14, emissiveIntensity: 0.8, roughness: 0.25 }),
      signalAmber: std({ color: 0x5a3000, emissive: 0xff9a1f, emissiveIntensity: 1.2, roughness: 0.3 }),
      reflective: std({ color: 0xf2f2f2, roughness: 0.25, metalness: 0.1, emissive: 0x2a2a2a }),
      screen: std({ color: 0x223040, emissive: 0xdde8ff, emissiveIntensity: 0.9, roughness: 0.3 }),
      corrugated: std({ color: 0xffffff, ...tex(kit.corrugated, 1), metalness: 0.55, envMapIntensity: 0.9 }),
      roofMetal: std({ color: 0x7c8084, ...tex(kit.corrugated, 0.8), metalness: 0.6, envMapIntensity: 0.8 }),
      concreteProp: std({ color: 0xffffff, ...tex(kit.concrete, 1), metalness: 0 }),
    };
    for (const [name, m] of Object.entries(this.roles)) m.name = `MAT_${name}`;

    this.arch = {
      brick: std({ ...tex(kit.brick, 1.1), vertexColors: true, metalness: 0 }),
      darkBrick: std({ ...tex(kit.darkBrick, 1.1), vertexColors: true, metalness: 0 }),
      plaster: std({ color: 0xb4ada2, ...tex(kit.plaster, 0.55), vertexColors: true, metalness: 0 }),
      concrete: std({ ...tex(kit.concrete, 1), vertexColors: true, metalness: 0 }),
      asphalt: std({ color: 0xe0dcd4, ...tex(kit.asphalt, 0.3), metalness: 0 }),
      sidewalk: std({ ...tex(kit.sidewalk, 1), metalness: 0 }),
      curb: std({ color: 0xbdb8ae, ...tex(kit.concrete, 1), metalness: 0 }),
      windowGlass: phy({ color: 0x3a4650, roughness: 0.04, metalness: 0.0, clearcoat: 1, envMapIntensity: 1.0 }),
      windowFrame: std({ color: 0x2c2f31, roughness: 0.5, metalness: 0.4 }),
      steelDark: std({ color: 0x3d4145, roughness: 0.55, metalness: 0.8, envMapIntensity: 0.9 }),
      roofing: std({ color: 0x8c8983, ...tex(kit.concrete, 0.5), roughness: 0.95, metalness: 0 }), // weathered bitumen membrane
      awning: phy({ color: 0x2f5140, roughness: 0.85, sheen: 0.5, sheenColor: new THREE.Color(0x9fc0a8) }),
      shopGlass: phy({ color: 0x28323a, roughness: 0.03, metalness: 0.0, clearcoat: 1, envMapIntensity: 1.0 }),
      puddle: phy({ color: 0x1c1f22, roughness: 0.02, metalness: 0.6, clearcoat: 1, envMapIntensity: 1.8, transparent: true, opacity: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      paintLine: std({ color: 0xd8d2bd, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
      lampGlow: std({ color: 0xfff1d0, emissive: 0xffd9a0, emissiveIntensity: 2.2, roughness: 0.3 }),
      skylineWindows: std({ ...tex(kit.facadeGrid, 0.4), metalness: 0.2 }),
      hazard: std({ ...tex(kit.hazard, 0.6), metalness: 0.1 }),
      metalLight: std({ color: 0x9aa0a4, roughness: 0.5, metalness: 0.6, envMapIntensity: 0.9 }),
      metals: std({ color: 0xffffff, vertexColors: true, roughness: 0.5, metalness: 0.7, envMapIntensity: 0.9 }),
      gravel: std({ color: 0x9a9184, ...tex(kit.concrete, 0.5), roughness: 1, metalness: 0 }),
      craneYellow: std({ color: 0xd8a01c, roughness: 0.5, metalness: 0.35, envMapIntensity: 0.9 }),
      water: phy({ color: 0x2c4650, roughness: 0.12, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.3, normalMap: kit.asphalt.normalMap, normalScale: new THREE.Vector2(0.25, 0.25) }),
      stone: std({ color: 0xd9d0bd, ...tex(kit.concrete, 0.7), vertexColors: true, roughness: 0.85, metalness: 0 }),
      signalRed: std({ color: 0x3a0404, emissive: 0xff2a1a, emissiveIntensity: 2.4, roughness: 0.3 }),
      signalGreen: std({ color: 0x033a14, emissive: 0x19ff7a, emissiveIntensity: 2.0, roughness: 0.3 }),
      lantern: std({ color: 0x8a0f0a, emissive: 0xff3a14, emissiveIntensity: 1.6, roughness: 0.6 }),
    };
    for (const [name, m] of Object.entries(this.arch)) m.name = `MAT_ARCH_${name}`;

    // Lived-in pass: world-space weathering on every surface family, fake rooms behind glass.
    for (const k of ['brick', 'darkBrick', 'plaster', 'concrete', 'curb'] as const) weathering(this.arch[k], 'wall');
    weathering(this.arch.metals, 'wall', 0.6);
    weathering(this.arch.skylineWindows, 'wall', 0.5);
    for (const k of ['asphalt', 'sidewalk', 'gravel', 'roofing'] as const) weathering(this.arch[k], 'ground');
    for (const r of ['paint', 'concreteProp', 'roofMetal', 'stone'] as const) weathering(this.roles[r], 'prop', 0.8);
    weathering(this.roles.corrugated, 'prop', 0.35); // containers: grime blotches read as camouflage on dark paint
    interiorMapping(this.arch.windowGlass as THREE.MeshStandardMaterial, { width: 3.2, depth: 4.2, height: 3.0, floorBelowCentre: 1.75, litChance: 0.3, shop: false });
    interiorMapping(this.arch.shopGlass as THREE.MeshStandardMaterial, { width: 3.6, depth: 6, height: 3.8, floorBelowCentre: 1.9, litChance: 1, shop: true });
  }
}
