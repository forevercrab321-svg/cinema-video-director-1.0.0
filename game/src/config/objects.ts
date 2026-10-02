/**
 * OBJECT_TYPES — every gameplay object is defined here (design §09, §32, §59).
 * Gameplay code reads these fields; it never special-cases an individual object.
 *
 * size: [width (local X), height, depth (local Z)] in metres, real-world dimensions.
 * rewardMass: kg added to the player on absorption (game mass, tuned for pacing).
 */
export type Shape =
  | 'scrap'
  | 'box'
  | 'cylinder'
  | 'bottle'
  | 'cone'
  | 'bag'
  | 'chair'
  | 'table'
  | 'bike'
  | 'dumpster'
  | 'vending'
  | 'car'
  | 'truck'
  | 'cart'
  | 'pallet'
  | 'palletStack'
  | 'motorcycle'
  | 'utility'
  | 'barrier'
  | 'hoarding'
  | 'van'
  | 'generator'
  | 'pipes'
  | 'scaffold'
  | 'container'
  | 'cabin'
  | 'tipper'
  | 'excavator'
  | 'rack'
  | 'tank'
  | 'garages'
  | 'whFront'
  | 'whBack'
  | 'whEnd'
  | 'whRoof'
  | 'whRoofEnd'
  | 'whSign'
  | 'goldCrate'
  | 'taxi'
  | 'bus'
  | 'kiosk'
  | 'foodCart'
  | 'bench'
  | 'bShikumen'
  | 'bShMid'
  | 'bBrownstone'
  | 'bNyLoft'
  | 'bHaussmann'
  | 'bParisCafe'
  | 'pearlLeg'
  | 'pearlSphere'
  | 'pearlShaft'
  | 'pearlTop'
  | 'esbPodium'
  | 'esbShaft'
  | 'esbCrown'
  | 'eiffelLeg'
  | 'eiffelDeck'
  | 'eiffelMid'
  | 'eiffelUpper'
  | 'eiffelTop'
  | 'customsHouse'
  | 'peaceHotel'
  | 'flatiron'
  | 'timesTower'
  | 'subway'
  | 'hydrant'
  | 'arcPier'
  | 'arcAttic'
  | 'morris'
  | 'metro'
  // Halloween Town
  | 'candy'
  | 'candyCorn'
  | 'lollipop'
  | 'candle'
  | 'bone'
  | 'skull'
  | 'miniPumpkin'
  | 'candyBucket'
  | 'witchHat'
  | 'tombstone'
  | 'ironFence'
  | 'jackOLantern'
  | 'cauldron'
  | 'skeleton'
  | 'broomRack'
  | 'batSign'
  | 'coffin'
  | 'slimeGhost'
  | 'scarecrow'
  | 'candyCart'
  | 'hearse'
  | 'vampireCoffin'
  | 'vampire'
  | 'werewolf'
  | 'giantCauldron'
  | 'crypt'
  | 'giantPumpkin'
  | 'pumpkinCarriage'
  | 'hauntedCarriage'
  | 'bHauntedHouse'
  | 'bHauntedManor';

export type DestructionType = 'collect' | 'crush' | 'push' | 'break' | 'rip' | 'collapse';

export interface ObjectType {
  label: string;
  objectClass: number;
  size: [number, number, number];
  shape: Shape;
  /** Per-instance colour variants (greybox paint). */
  colors: number[];
  rewardMass: number;
  destructionType: DestructionType;
  /** Override of the class threshold, only when an object is unusually heavy or light for its class. */
  requiredPower?: number;
  /** Part of the climax structure: absorbing every such object wins the run. */
  climax?: boolean;
  /** Arena power-up crate: absorbing it grants a timed ability instead of much mass. */
  power?: 'speed' | 'magnet' | 'shield';
  /** Tall landmark part: when its support fails it topples sideways as it falls. */
  topple?: boolean;
  /** Arena bonus pickup: worth a share of the collector's current mass (see arenaConfig). */
  bonus?: boolean;
}

export const OBJECT_TYPES = {
  POWER_SPEED: { power: 'speed', label: 'Speed crate', objectClass: 1, size: [0.55, 0.45, 0.55], shape: 'goldCrate', colors: [0x3fa9ff], rewardMass: 1, destructionType: 'collect' },
  POWER_MAGNET: { power: 'magnet', label: 'Magnet crate', objectClass: 1, size: [0.55, 0.45, 0.55], shape: 'goldCrate', colors: [0xb05cff], rewardMass: 1, destructionType: 'collect' },
  POWER_SHIELD: { power: 'shield', label: 'Shield crate', objectClass: 1, size: [0.55, 0.45, 0.55], shape: 'goldCrate', colors: [0x3fe0c0], rewardMass: 1, destructionType: 'collect' },
  GOLD_CRATE: { bonus: true, label: 'Golden crate', objectClass: 1, size: [0.5, 0.42, 0.5], shape: 'goldCrate', colors: [0xf2c14e], rewardMass: 3, destructionType: 'collect' },
  SCRAP: { label: 'Metal scrap', objectClass: 0, size: [0.09, 0.04, 0.07], shape: 'scrap', colors: [0x8d8f91, 0x9a8a74, 0x6f7a80, 0xa0673f], rewardMass: 0.14, destructionType: 'collect' },
  CAN: { label: 'Can', objectClass: 1, size: [0.066, 0.12, 0.066], shape: 'cylinder', colors: [0xb8402f, 0x3f6fa8, 0xc9b458, 0x5c8a4f], rewardMass: 0.28, destructionType: 'collect' },
  BOTTLE: { label: 'Bottle', objectClass: 1, size: [0.075, 0.26, 0.075], shape: 'bottle', colors: [0x2f6b4a, 0x6b4a2f, 0x9fb7bd], rewardMass: 0.36, destructionType: 'collect' },
  BRICK: { label: 'Brick', objectClass: 1, size: [0.215, 0.065, 0.1025], shape: 'box', colors: [0x9c4f3a, 0x8a4633, 0xa35a42], rewardMass: 0.48, destructionType: 'collect' },
  CARDBOARD_SMALL: { label: 'Small box', objectClass: 1, size: [0.3, 0.22, 0.25], shape: 'box', colors: [0xb08a5a, 0xa27d4f], rewardMass: 0.65, destructionType: 'collect' },
  CARDBOARD_BOX: { label: 'Cardboard box', objectClass: 2, size: [0.55, 0.42, 0.45], shape: 'box', colors: [0xa47f50, 0xb89262], rewardMass: 2.4, destructionType: 'collect' },
  TRASH_BAG: { label: 'Trash bag', objectClass: 2, size: [0.55, 0.6, 0.5], shape: 'bag', colors: [0x2b2d30, 0x3b3f33, 0x2d3440], rewardMass: 2.8, destructionType: 'collect' },
  TRAFFIC_CONE: { label: 'Traffic cone', objectClass: 2, size: [0.36, 0.7, 0.36], shape: 'cone', colors: [0xd9622b], rewardMass: 2.2, destructionType: 'collect' },
  CHAIR: { label: 'Chair', objectClass: 3, size: [0.48, 0.85, 0.5], shape: 'chair', colors: [0x6d5a45, 0x4b5b63], rewardMass: 12.5, destructionType: 'collect' },
  CAFE_TABLE: { label: 'Café table', objectClass: 3, size: [0.75, 0.75, 0.75], shape: 'table', colors: [0x5a5f63], rewardMass: 15, destructionType: 'collect' },
  TRASH_CAN: { label: 'Trash can', objectClass: 3, size: [0.6, 0.95, 0.6], shape: 'cylinder', colors: [0x3f5a45, 0x4a4f55], rewardMass: 19.5, destructionType: 'collect' },
  BICYCLE: { label: 'Bicycle', objectClass: 3, size: [0.55, 1.05, 1.75], shape: 'bike', colors: [0x2f5d8a, 0x8a2f2f, 0x3d3d3d], rewardMass: 21, destructionType: 'collect' },
  DUMPSTER: { label: 'Dumpster', objectClass: 4, size: [1.9, 1.3, 1.1], shape: 'dumpster', colors: [0x2f5a3d, 0x3a4c6b], rewardMass: 140, destructionType: 'crush' },
  VENDING_MACHINE: { label: 'Vending machine', objectClass: 4, size: [0.9, 1.85, 0.8], shape: 'vending', colors: [0xa33a35, 0x2f5f8f], rewardMass: 110, destructionType: 'crush' },
  CAR_COMPACT: { label: 'Compact car', objectClass: 5, size: [1.75, 1.45, 3.9], shape: 'car', colors: [0x8a969e, 0x9b2a24, 0x284d78, 0xe3e1da, 0x4a4f54, 0x3f5b45], rewardMass: 380, destructionType: 'crush' },
  DELIVERY_TRUCK: { label: 'Delivery truck', objectClass: 6, size: [2.3, 3.2, 7.2], shape: 'truck', colors: [0xe4e1d8, 0x5d6a4a], rewardMass: 1200, destructionType: 'break' },
  // ── Class 3–4 transition: the street, lot and site entrance carry the player to vehicles.
  SHOPPING_CART: { label: 'Shopping cart', objectClass: 3, size: [0.6, 1.0, 0.95], shape: 'cart', colors: [0xb9bec2], rewardMass: 16, destructionType: 'collect' },
  PALLET: { label: 'Pallet', objectClass: 3, size: [1.2, 0.144, 1.0], shape: 'pallet', colors: [0xf0dfc2, 0xe2cca6], rewardMass: 14, destructionType: 'collect' },
  PALLET_STACK: { label: 'Pallet stack', objectClass: 4, size: [1.2, 0.9, 1.0], shape: 'palletStack', colors: [0xf0dfc2, 0xd9c29c], rewardMass: 70, destructionType: 'break' },
  MOTORCYCLE: { label: 'Motorcycle', objectClass: 4, size: [0.8, 1.15, 2.1], shape: 'motorcycle', colors: [0x9b2a24, 0x1f2a36, 0xd9d4c7, 0x2f4f3a], rewardMass: 75, destructionType: 'crush' },
  UTILITY_BOX: { label: 'Utility cabinet', objectClass: 4, size: [1.2, 1.4, 0.5], shape: 'utility', colors: [0x6e7a6a, 0x8a8f86], rewardMass: 60, destructionType: 'crush' },
  JERSEY_BARRIER: { label: 'Concrete barrier', objectClass: 4, size: [0.6, 0.81, 3.0], shape: 'barrier', colors: [0xc9c4ba, 0xb8b2a6], rewardMass: 85, destructionType: 'break' },
  HOARDING: { label: 'Site hoarding', objectClass: 4, size: [2.4, 2.4, 0.3], shape: 'hoarding', colors: [0x2f5b46, 0x3a4f6a], rewardMass: 35, destructionType: 'break' },
  // ── Class 5: vehicles and site machinery.
  VAN: { label: 'Panel van', objectClass: 5, size: [2.0, 2.45, 5.3], shape: 'van', colors: [0xe6e3dc, 0x2f4d6e, 0x8a2f2a, 0x5a5f63], rewardMass: 480, destructionType: 'crush' },
  GENERATOR: { label: 'Site generator', objectClass: 5, size: [1.3, 1.7, 3.2], shape: 'generator', colors: [0xd9a21b, 0x3f6a4a], rewardMass: 300, destructionType: 'break' },
  PIPE_STACK: { label: 'Pipe stack', objectClass: 5, size: [2.6, 1.35, 6.0], shape: 'pipes', colors: [0x6c7278, 0x8a5a3a], rewardMass: 270, destructionType: 'break' },
  SCAFFOLD: { label: 'Scaffold tower', objectClass: 5, size: [2.6, 6.2, 1.3], shape: 'scaffold', colors: [0x9aa1a6], rewardMass: 320, destructionType: 'rip' },
  // ── Class 6: trucks, containers, cabins — the industrial yard.
  CONTAINER: { label: 'Shipping container', objectClass: 6, size: [2.44, 2.59, 6.06], shape: 'container', colors: [0x9b3a2a, 0x2f5b7a, 0x3f6a4a, 0xb5782a, 0x6a6f74], rewardMass: 1100, destructionType: 'crush' },
  SITE_CABIN: { label: 'Site cabin', objectClass: 6, size: [2.6, 2.75, 7.2], shape: 'cabin', colors: [0xd8d3c6, 0x3d6a8a], rewardMass: 1100, destructionType: 'crush' },
  TIPPER_TRUCK: { label: 'Tipper truck', objectClass: 6, size: [2.5, 3.3, 8.2], shape: 'tipper', colors: [0xd9a21b, 0xc9c4ba, 0x8a2f2a], rewardMass: 1700, destructionType: 'break' },
  EXCAVATOR: { label: 'Excavator', objectClass: 6, size: [3.0, 3.3, 9.6], shape: 'excavator', colors: [0xe0a51c], rewardMass: 2400, destructionType: 'break' },
  PALLET_RACK: { label: 'Pallet rack', objectClass: 6, size: [2.7, 5.4, 1.2], shape: 'rack', colors: [0x2f5a8a], rewardMass: 1100, destructionType: 'collapse' },
  // ── Class 7: structures. The warehouse is a kit of class-7 parts. The front wall and sign
  // come off first (8 m machine); gables, back wall and roof bays need 9.6 m (~103 t of the 125 t available below it), so the
  // tanks and garages have to be eaten in between. A roof bay collapses when a wall under it goes.
  FUEL_TANK: { label: 'Storage tank', objectClass: 7, size: [7, 9, 7], shape: 'tank', colors: [0xd9d6cf, 0xb4bcc2], rewardMass: 5000, destructionType: 'crush' },
  GARAGE_ROW: { label: 'Garage row', objectClass: 7, size: [16, 2.8, 6.4], shape: 'garages', colors: [0xb07560, 0xc2b8a4], rewardMass: 4500, destructionType: 'collapse' },
  WH_PANEL_FRONT: { climax: true, label: 'Warehouse wall', objectClass: 7, size: [12, 11.5, 0.8], shape: 'whFront', colors: [0xb4bcc2], rewardMass: 3600, destructionType: 'rip' },
  WH_PANEL_BACK: { climax: true, requiredPower: 9.6, label: 'Warehouse wall', objectClass: 7, size: [12, 11.5, 0.8], shape: 'whBack', colors: [0xb4bcc2], rewardMass: 3600, destructionType: 'rip' },
  WH_PANEL_END: { climax: true, requiredPower: 9.6, label: 'Warehouse gable', objectClass: 7, size: [10, 11.5, 0.8], shape: 'whEnd', colors: [0xb4bcc2], rewardMass: 3000, destructionType: 'rip' },
  WH_ROOF_END: { climax: true, requiredPower: 9.6, label: 'Warehouse roof', objectClass: 7, size: [12, 4.6, 31.2], shape: 'whRoofEnd', colors: [0xb4bcc2], rewardMass: 6500, destructionType: 'collapse' },
  WH_ROOF: { climax: true, requiredPower: 9.6, label: 'Warehouse roof', objectClass: 7, size: [12, 4.6, 31.2], shape: 'whRoof', colors: [0xb4bcc2], rewardMass: 6000, destructionType: 'collapse' },
  WH_SIGN: { climax: true, label: 'Warehouse sign', objectClass: 6, size: [18, 2.4, 0.5], shape: 'whSign', colors: [0xe9e4d8], rewardMass: 900, destructionType: 'rip' },
  // ── World cities (arena levels) ─────────────────────────────────────────────
  // Street identity: taxis, buses, scooters, kiosks, food carts, benches.
  TAXI_NY: { label: 'Yellow cab', objectClass: 5, size: [1.85, 1.5, 4.6], shape: 'taxi', colors: [0xf2b705, 0xeeb00c], rewardMass: 420, destructionType: 'crush' },
  TAXI_SH: { label: 'Shanghai taxi', objectClass: 5, size: [1.8, 1.5, 4.6], shape: 'taxi', colors: [0x3aa6b9, 0x49a36b, 0xd9c34a], rewardMass: 420, destructionType: 'crush' },
  TAXI_PA: { label: 'Paris taxi', objectClass: 5, size: [1.8, 1.5, 4.5], shape: 'taxi', colors: [0x1d1f22, 0xe3e1da, 0x3a3f45], rewardMass: 420, destructionType: 'crush' },
  BUS_SH: { label: 'City bus', objectClass: 6, size: [2.55, 3.1, 12], shape: 'bus', colors: [0x2f7fbf, 0xd9412b, 0xe8e4da], rewardMass: 1600, destructionType: 'break' },
  BUS_NY: { label: 'MTA bus', objectClass: 6, size: [2.6, 3.2, 12.2], shape: 'bus', colors: [0xe8e6e0, 0x2a5caa], rewardMass: 1600, destructionType: 'break' },
  BUS_PA: { label: 'Paris bus', objectClass: 6, size: [2.55, 3.1, 12], shape: 'bus', colors: [0x4f8a5b, 0xe8e4da], rewardMass: 1600, destructionType: 'break' },
  SCOOTER: { label: 'Scooter', objectClass: 4, size: [0.7, 1.1, 1.8], shape: 'motorcycle', colors: [0xd9d4c7, 0x3f6fa8, 0x9b2a24, 0x2b8a6e], rewardMass: 60, destructionType: 'crush' },
  KIOSK: { label: 'Newsstand', objectClass: 5, size: [2.4, 3.2, 2.0], shape: 'kiosk', colors: [0x2f4f3a, 0x35553f], rewardMass: 350, destructionType: 'crush' },
  FOOD_CART: { label: 'Hot-dog cart', objectClass: 4, size: [1.9, 2.4, 0.9], shape: 'foodCart', colors: [0x2f5f9f, 0xc23b2a], rewardMass: 90, destructionType: 'crush' },
  BENCH: { label: 'Bench', objectClass: 3, size: [1.8, 0.85, 0.62], shape: 'bench', colors: [0x5a4a3a], rewardMass: 14, destructionType: 'collect' },
  // Destructible buildings: houses need a 6.5 m machine, blocks 9.5 m.
  B_SHIKUMEN: { requiredPower: 6.5, label: 'Shikumen house', objectClass: 7, size: [12, 9.6, 9], shape: 'bShikumen', colors: [0xb3ada3, 0xa8a196, 0xa56a55], rewardMass: 4500, destructionType: 'collapse' },
  B_SH_MID: { label: 'Shanghai block', objectClass: 8, requiredPower: 9.5, size: [16, 21.4, 14], shape: 'bShMid', colors: [0xe8e2d6, 0xd8d0c0, 0xc9d3d6], rewardMass: 12000, destructionType: 'collapse' },
  B_BROWNSTONE: { requiredPower: 6.5, label: 'Brownstone', objectClass: 7, size: [7, 14.4, 13], shape: 'bBrownstone', colors: [0x7a4a36, 0x6e4436, 0x8a5a44], rewardMass: 5200, destructionType: 'collapse' },
  B_NY_LOFT: { label: 'Loft building', objectClass: 8, requiredPower: 9.5, size: [18, 29.3, 16], shape: 'bNyLoft', colors: [0x9b5a41, 0x8a4f3a, 0xa8765c], rewardMass: 16000, destructionType: 'collapse' },
  B_HAUSSMANN: { label: 'Haussmann block', objectClass: 8, requiredPower: 9.5, size: [18, 24, 13], shape: 'bHaussmann', colors: [0xdcd0b6, 0xe2d7bf, 0xd4c7aa], rewardMass: 14000, destructionType: 'collapse' },
  B_PARIS_CAFE: { requiredPower: 6.5, label: 'Café house', objectClass: 7, size: [10, 13.5, 10], shape: 'bParisCafe', colors: [0xdcd0b6, 0xe6dcc6, 0xd0c2a4], rewardMass: 4800, destructionType: 'collapse' },
  // Landmarks at 1:5 gameplay scale. Bases need a 12 m machine; what they hold up falls.
  PEARL_LEG: { climax: true, requiredPower: 12, label: 'Pearl Tower column', objectClass: 8, size: [3.4, 24, 3.4], shape: 'pearlLeg', colors: [0xd9d5cc], rewardMass: 18000, destructionType: 'rip' },
  PEARL_SPHERE_LOW: { climax: true, topple: true, requiredPower: 12, label: 'Pearl Tower sphere', objectClass: 8, size: [10, 10, 10], shape: 'pearlSphere', colors: [0xc2386a], rewardMass: 30000, destructionType: 'collapse' },
  PEARL_SHAFT: { climax: true, topple: true, requiredPower: 11, label: 'Pearl Tower shaft', objectClass: 8, size: [5.5, 26, 5.5], shape: 'pearlShaft', colors: [0xc2386a], rewardMass: 20000, destructionType: 'collapse' },
  PEARL_SPHERE_UP: { climax: true, topple: true, requiredPower: 11.5, label: 'Pearl Tower sphere', objectClass: 8, size: [8, 8, 8], shape: 'pearlSphere', colors: [0xc2386a], rewardMass: 24000, destructionType: 'collapse' },
  PEARL_TOP: { climax: true, topple: true, requiredPower: 8, label: 'Pearl Tower spire', objectClass: 7, size: [4.6, 36, 4.6], shape: 'pearlTop', colors: [0xc2386a], rewardMass: 9000, destructionType: 'collapse' },
  ESB_PODIUM: { climax: true, requiredPower: 12, label: 'Empire State base', objectClass: 8, size: [13, 13.1, 22], shape: 'esbPodium', colors: [0xcfc6b2], rewardMass: 26000, destructionType: 'rip' },
  ESB_SHAFT_LOW: { climax: true, topple: true, requiredPower: 11.5, label: 'Empire State tower', objectClass: 8, size: [16, 30, 14], shape: 'esbShaft', colors: [0xcfc6b2], rewardMass: 36000, destructionType: 'collapse' },
  ESB_SHAFT_HIGH: { climax: true, topple: true, requiredPower: 11, label: 'Empire State tower', objectClass: 8, size: [12, 22, 10], shape: 'esbShaft', colors: [0xcfc6b2], rewardMass: 26000, destructionType: 'collapse' },
  ESB_CROWN: { climax: true, topple: true, requiredPower: 8, label: 'Empire State crown', objectClass: 7, size: [9, 32, 8], shape: 'esbCrown', colors: [0xcfc6b2], rewardMass: 12000, destructionType: 'collapse' },
  EIFFEL_LEG: { climax: true, requiredPower: 12, label: 'Eiffel Tower leg', objectClass: 8, size: [4.2, 12, 4.2], shape: 'eiffelLeg', colors: [0x6f5a44], rewardMass: 16000, destructionType: 'rip' },
  EIFFEL_DECK: { climax: true, topple: true, requiredPower: 11.5, label: 'Eiffel first floor', objectClass: 8, size: [15, 2.2, 15], shape: 'eiffelDeck', colors: [0x6f5a44], rewardMass: 26000, destructionType: 'collapse' },
  EIFFEL_MID: { climax: true, topple: true, requiredPower: 11, label: 'Eiffel second stage', objectClass: 8, size: [12, 12, 12], shape: 'eiffelMid', colors: [0x6f5a44], rewardMass: 22000, destructionType: 'collapse' },
  EIFFEL_UPPER: { climax: true, topple: true, requiredPower: 10, label: 'Eiffel upper tower', objectClass: 8, size: [7.2, 30, 7.2], shape: 'eiffelUpper', colors: [0x6f5a44], rewardMass: 16000, destructionType: 'collapse' },
  EIFFEL_TOP: { climax: true, topple: true, requiredPower: 7, label: 'Eiffel summit', objectClass: 7, size: [3.2, 12, 3.2], shape: 'eiffelTop', colors: [0x6f5a44], rewardMass: 6000, destructionType: 'collapse' },
  // Secondary landmarks (~1:2.5) and signature street objects.
  CUSTOMS_HOUSE: { requiredPower: 9.5, label: 'Customs House', objectClass: 8, size: [24, 33, 16], shape: 'customsHouse', colors: [0xd9d0bd], rewardMass: 16000, destructionType: 'collapse' },
  PEACE_HOTEL: { requiredPower: 9.5, label: 'Peace Hotel', objectClass: 8, size: [16, 35, 14], shape: 'peaceHotel', colors: [0xd9d0bd], rewardMass: 15000, destructionType: 'collapse' },
  FLATIRON: { requiredPower: 9.5, label: 'Flatiron Building', objectClass: 8, size: [12, 29, 28], shape: 'flatiron', colors: [0xd9d0bd], rewardMass: 16000, destructionType: 'collapse' },
  TIMES_TOWER: { requiredPower: 9.5, label: 'Times Square tower', objectClass: 8, size: [11, 40, 11], shape: 'timesTower', colors: [0x202328], rewardMass: 14000, destructionType: 'collapse' },
  SUBWAY_ENTRANCE: { label: 'Subway entrance', objectClass: 4, size: [2.2, 2.1, 4.2], shape: 'subway', colors: [0x2f5f3a], rewardMass: 80, destructionType: 'rip' },
  FIRE_HYDRANT: { label: 'Fire hydrant', objectClass: 2, size: [0.4, 0.75, 0.4], shape: 'hydrant', colors: [0xc62828, 0xf2c14e, 0xc62828], rewardMass: 3, destructionType: 'collect' },
  ARC_PIER: { requiredPower: 9.5, label: 'Arc de Triomphe pier', objectClass: 8, size: [6, 13.5, 9], shape: 'arcPier', colors: [0xd9d0bd], rewardMass: 20000, destructionType: 'rip' },
  ARC_ATTIC: { topple: true, requiredPower: 8, label: 'Arc de Triomphe attic', objectClass: 7, size: [18, 6.5, 9], shape: 'arcAttic', colors: [0xd9d0bd], rewardMass: 12000, destructionType: 'collapse' },
  MORRIS_COLUMN: { label: 'Morris column', objectClass: 4, size: [1.3, 3.6, 1.3], shape: 'morris', colors: [0x2e4a32], rewardMass: 70, destructionType: 'crush' },
  METRO_ENTRANCE: { label: 'Métro entrance', objectClass: 5, size: [3.2, 3.4, 5], shape: 'metro', colors: [0x2e4a32], rewardMass: 260, destructionType: 'rip' },
  // ── Halloween Town (event map). Class budgets copy the city sets above: same reward per class,
  // similar sizes per class, so the map paces like every other city.
  // Class 0–2 food: real-world sizes (a wrapped sweet is 7.5 cm).
  CANDY: { label: 'Wrapped candy', objectClass: 0, size: [0.075, 0.028, 0.032], shape: 'candy', colors: [0xc92a2a, 0x7a3fbf, 0x2f9e5a, 0xf2a01c, 0xe8e1d0], rewardMass: 0.14, destructionType: 'collect' },
  CANDY_CORN: { label: 'Candy corn', objectClass: 0, size: [0.024, 0.05, 0.036], shape: 'candyCorn', colors: [0xf2b705], rewardMass: 0.14, destructionType: 'collect' },
  CANDLE: { label: 'Candle', objectClass: 1, size: [0.06, 0.17, 0.06], shape: 'candle', colors: [0xe9e1cf, 0x2a2430, 0x5b2a6e], rewardMass: 0.28, destructionType: 'collect' },
  LOLLIPOP: { label: 'Lollipop', objectClass: 1, size: [0.09, 0.025, 0.26], shape: 'lollipop', colors: [0xd9342b, 0x8a3fd0, 0x2fae6a, 0xf28a1c], rewardMass: 0.36, destructionType: 'collect' },
  BONE: { label: 'Bone', objectClass: 1, size: [0.065, 0.045, 0.28], shape: 'bone', colors: [0xe4d9bf], rewardMass: 0.48, destructionType: 'collect' },
  SKULL: { label: 'Skull', objectClass: 1, size: [0.15, 0.17, 0.2], shape: 'skull', colors: [0xe4d9bf], rewardMass: 0.65, destructionType: 'collect' },
  MINI_PUMPKIN: { label: 'Mini pumpkin', objectClass: 2, size: [0.32, 0.27, 0.32], shape: 'miniPumpkin', colors: [0xe0661c, 0xd9561a, 0xeee6d2, 0xc77a2a, 0x6f8a4a], rewardMass: 2.4, destructionType: 'collect' },
  CANDY_BUCKET: { label: 'Trick-or-treat pail', objectClass: 2, size: [0.3, 0.38, 0.3], shape: 'candyBucket', colors: [0xe8661a, 0x7a3fbf], rewardMass: 2.8, destructionType: 'collect' },
  WITCH_HAT: { label: 'Witch hat', objectClass: 2, size: [0.5, 0.6, 0.5], shape: 'witchHat', colors: [0x231c2c, 0x3b2357, 0x1f2a24], rewardMass: 2.2, destructionType: 'collect' },
  // Class 3–4: graveyard, street and camp props.
  TOMBSTONE: { label: 'Tombstone', objectClass: 3, size: [0.75, 1.0, 0.22], shape: 'tombstone', colors: [0xa9a6a0, 0x9a9e98, 0xb4ada2, 0x8e948c], rewardMass: 15, destructionType: 'collect' },
  TOMBSTONE_CROSS: { label: 'Celtic cross', objectClass: 3, size: [0.66, 1.4, 0.2], shape: 'tombstone', colors: [0xa9a6a0, 0x9ea39c, 0xb4ada2], rewardMass: 14, destructionType: 'collect' },
  IRON_FENCE: { label: 'Iron fence', objectClass: 3, size: [2.4, 1.7, 0.16], shape: 'ironFence', colors: [0x6f6a64], rewardMass: 14, destructionType: 'collect' },
  JACK_O_LANTERN: { label: "Jack-o'-lantern", objectClass: 3, size: [0.62, 0.62, 0.62], shape: 'jackOLantern', colors: [0xe0661c, 0xd9561a, 0xc9721e], rewardMass: 19.5, destructionType: 'collect' },
  CAULDRON: { label: 'Cauldron', objectClass: 3, size: [0.9, 0.95, 0.9], shape: 'cauldron', colors: [0x6dff4a, 0xb35cff, 0x3ff0c0], rewardMass: 19.5, destructionType: 'collect' },
  SKELETON: { label: 'Skeleton', objectClass: 3, size: [0.7, 1.8, 0.5], shape: 'skeleton', colors: [0xe4d9bf], rewardMass: 21, destructionType: 'collect' },
  BROOM_RACK: { label: 'Broom rack', objectClass: 3, size: [1.3, 1.75, 0.55], shape: 'broomRack', colors: [0x2a2233, 0x3b2357], rewardMass: 14, destructionType: 'collect' },
  BAT_SIGN: { label: 'Bat sign', objectClass: 3, size: [1.1, 2.6, 0.16], shape: 'batSign', colors: [0x5a4632, 0x4a3a2a], rewardMass: 12.5, destructionType: 'collect' },
  GRAVE_OBELISK: { label: 'Grave obelisk', objectClass: 4, size: [0.95, 2.8, 0.95], shape: 'tombstone', colors: [0xa9a6a0, 0xb4ada2, 0x9a9e98], rewardMass: 80, destructionType: 'crush' },
  COFFIN: { label: 'Coffin', objectClass: 4, size: [0.76, 0.58, 2.1], shape: 'coffin', colors: [0x4a2e1e, 0x2a1c16, 0x5a2a22], rewardMass: 70, destructionType: 'crush' },
  SLIME_GHOST: { label: 'Slime ghost', objectClass: 4, size: [1.6, 2.1, 1.1], shape: 'slimeGhost', colors: [0x7dff52, 0x52ffb8, 0xb6ff3a], rewardMass: 90, destructionType: 'crush' },
  SCARECROW: { label: 'Scarecrow', objectClass: 4, size: [1.7, 2.35, 0.55], shape: 'scarecrow', colors: [0x5b4a3a, 0x4a5a3a, 0x6a3a2a, 0x3f4a5f], rewardMass: 70, destructionType: 'crush' },
  CANDY_CART: { label: 'Candy cart', objectClass: 4, size: [1.9, 2.5, 0.95], shape: 'candyCart', colors: [0x6a2f9a, 0xd9601a, 0x2f8a7a], rewardMass: 90, destructionType: 'crush' },
  // Class 5: vehicles and monster figures.
  HEARSE: { label: 'Hearse', objectClass: 5, size: [1.95, 1.75, 5.8], shape: 'hearse', colors: [0x16161b, 0x2a1838, 0x3a1016, 0x1c2622], rewardMass: 420, destructionType: 'crush' },
  VAMPIRE_COFFIN: { label: "Vampire's coffin", objectClass: 5, size: [1.45, 1.9, 2.7], shape: 'vampireCoffin', colors: [0x8a0f22, 0x4a1a6a, 0x1f5a3a], rewardMass: 300, destructionType: 'crush' },
  VAMPIRE: { label: 'Vampire', objectClass: 5, size: [1.9, 2.75, 1.4], shape: 'vampire', colors: [0x1c1622, 0x16161c], rewardMass: 350, destructionType: 'break' },
  WEREWOLF: { label: 'Werewolf', objectClass: 5, size: [1.7, 3.4, 1.7], shape: 'werewolf', colors: [0x4a3a2c, 0x3e3a3c, 0x55402e], rewardMass: 350, destructionType: 'break' },
  GIANT_CAULDRON: { label: "Witch's cauldron", objectClass: 5, size: [2.7, 2.9, 2.7], shape: 'giantCauldron', colors: [0x6dff4a, 0xb35cff], rewardMass: 300, destructionType: 'break' },
  // Class 6: carriages, crypts, giant pumpkins.
  CRYPT: { label: 'Crypt', objectClass: 6, size: [4.4, 4.9, 6.0], shape: 'crypt', colors: [0xb0aca4, 0xa0a69e, 0xbab2a6], rewardMass: 1300, destructionType: 'collapse' },
  GIANT_PUMPKIN: { label: 'Giant pumpkin', objectClass: 6, size: [3.0, 2.6, 3.0], shape: 'giantPumpkin', colors: [0xe0661c, 0xd9561a, 0xc9721e], rewardMass: 1100, destructionType: 'break' },
  PUMPKIN_CARRIAGE: { label: 'Pumpkin carriage', objectClass: 6, size: [2.5, 3.5, 5.6], shape: 'pumpkinCarriage', colors: [0xe0661c, 0xd9561a], rewardMass: 1400, destructionType: 'break' },
  HAUNTED_CARRIAGE: { label: 'Funeral coach', objectClass: 6, size: [2.2, 3.3, 5.4], shape: 'hauntedCarriage', colors: [0x141418, 0x24162e], rewardMass: 1200, destructionType: 'break' },
  // Destructible buildings: houses need a 6.5 m machine, blocks 9.5 m (as in every city).
  B_HAUNTED_HOUSE: { requiredPower: 6.5, label: 'Haunted house', objectClass: 7, size: [11, 14, 10], shape: 'bHauntedHouse', colors: [0x6e6584, 0x5e7068, 0x6f6a72, 0x5a6878], rewardMass: 4800, destructionType: 'collapse' },
  B_HAUNTED_MANOR: { label: 'Haunted manor', objectClass: 8, requiredPower: 9.5, size: [17, 24, 14], shape: 'bHauntedManor', colors: [0x6a5560, 0x5a6064, 0x70544a], rewardMass: 14000, destructionType: 'collapse' },
} satisfies Record<string, ObjectType>;

export type ObjectTypeId = keyof typeof OBJECT_TYPES;
