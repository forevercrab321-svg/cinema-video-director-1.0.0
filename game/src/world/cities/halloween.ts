import * as THREE from 'three';
import type { Palette } from '../../art/environment';
import type { Placement } from '../scrapCity';
import { makeCity } from './cityKit';

/**
 * Moonlit night. The moon is the key light (cool, ~25° up in the north so the long shadows fall
 * toward the south spawn's camera), a violet hemisphere keeps dark props readable, and the sky
 * runs from deep indigo to a violet band with an orange town-glow on the horizon. Gameplay
 * readability beats drama: the moon is bright enough to model every prop.
 */
const MOONLIGHT: Palette = {
  sunDirection: new THREE.Vector3(0.5, 0.46, -0.73).normalize(),
  sunColor: new THREE.Color(0xb8c6ff),
  sunIntensity: 2.3,
  sky: { top: new THREE.Color(0x0d1230), mid: new THREE.Color(0x3a2a68), horizon: new THREE.Color(0xd8743e), ground: new THREE.Color(0x1a1622), sun: new THREE.Color(0xe9eeff) },
  clouds: -0.12,
  fog: new THREE.Color(0x3d3558),
  fogNear: 70,
  fogFar: 400,
  hemiSky: new THREE.Color(0x9a92d6),
  hemiGround: new THREE.Color(0x3e3040),
  hemiIntensity: 1.15,
  envIntensity: 0.5,
};

/** Monster figures guard the four boulevard approaches to the (empty) plaza. */
const GUARDIANS: Placement[] = [
  { type: 'VAMPIRE', x: 12.4, z: -36, yaw: Math.PI / 2 },
  { type: 'WEREWOLF', x: -12.4, z: -36, yaw: -Math.PI / 2 },
  { type: 'WEREWOLF', x: 12.4, z: 36, yaw: Math.PI / 2 },
  { type: 'VAMPIRE', x: -12.4, z: 36, yaw: -Math.PI / 2 },
];

const Q = Math.PI / 2;

/**
 * HALLOWEEN TOWN — the event map (docs/halloween-mode.md). The standard 192 m district themed
 * end to end: haunted houses and Gothic manors line the streets, hearses and carriages park at
 * the kerbs, the park is a graveyard, the building site is a witch's camp and pumpkin patch.
 * The central plaza stays EMPTY (the hunters rise there in the second half).
 */
export const HALLOWEEN = makeCity({
  id: 'halloween',
  name: 'Halloween Town',
  nameZh: '万圣节小镇',
  tagline: 'Grow fat on candy — then run from the monsters',
  taglineZh: '先吃糖长大，再逃离怪物',
  level: 0,
  palette: MOONLIGHT,
  seed: 1031,
  climaxName: 'the haunted plaza',
  climaxNameZh: '鬼影广场',
  landmark: () => [],
  emptyPlaza: true,
  spawnCount: 6,
  houses: ['B_HAUNTED_HOUSE', 'B_HAUNTED_HOUSE'],
  blocks: ['B_HAUNTED_MANOR', 'B_HAUNTED_MANOR'],
  cars: ['HEARSE', 'HEARSE', 'HEARSE', 'HEARSE', 'HEARSE', 'CANDY_CART'],
  bigVehicles: ['HAUNTED_CARRIAGE', 'PUMPKIN_CARRIAGE'],
  furniture: ['JACK_O_LANTERN', 'JACK_O_LANTERN', 'SCARECROW', 'TOMBSTONE', 'BAT_SIGN', 'CAULDRON', 'SKELETON', 'SLIME_GHOST', 'CANDY_CART', 'VAMPIRE_COFFIN'],
  courtyard: [['COFFIN', 1], ['CAULDRON', 2], ['TOMBSTONE', 2], ['HAUNTED_CARRIAGE', 1], ['CRYPT', 1], ['HEARSE', 1]],
  courtyardFood: [['CANDY', 0.3, 22], ['MINI_PUMPKIN', 0.28, 6], ['CANDY_BUCKET', 0.28, 5], ['BONE', 0.3, 10]],
  parkKind: 'graveyard',
  // The construction site becomes a witch's camp in a pumpkin patch.
  siteKit: [
    ['GIANT_CAULDRON', 0, 0, 0],
    ['PUMPKIN_CARRIAGE', -7.5, -8.5, 0.5],
    ['HAUNTED_CARRIAGE', 8.5, 7.5, Q + 0.2],
    ['GIANT_PUMPKIN', 8, -8, 0.4],
    ['GIANT_PUMPKIN', -8.5, 7.5, 1.1],
    ['GIANT_PUMPKIN', -1, 10.5, 2.2],
    ['CAULDRON', 3.6, 2.4, 0],
    ['CAULDRON', -3.2, 2.8, 0],
    ['BROOM_RACK', 4.2, -3.4, -0.5],
    ['BROOM_RACK', -4.4, -3.0, 0.5],
    ['SCARECROW', 0.5, -10.5, 0],
    ['SCARECROW', -11, -0.5, Q],
    ['SCARECROW', 11, -0.5, -Q],
  ],
  siteFood: [['MINI_PUMPKIN', 12, 18], ['JACK_O_LANTERN', 11, 5], ['WITCH_HAT', 9, 6], ['CANDY_CORN', 12, 24], ['CANDLE', 6, 10]],
  streetFood: ['CANDY', 'CANDY_CORN', 'LOLLIPOP', 'SKULL', 'CANDLE', 'MINI_PUMPKIN', 'BONE', 'WITCH_HAT'],
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
  lanterns: 'pumpkin',
  streetLamps: 'gas',
  signals: false,
  deadTrees: true,
  perimeter: { materials: ['darkBrick', 'darkBrick', 'plaster', 'brick'], h: [14, 22] },
  skyline: {
    n: 48,
    h: [14, 26],
    heroes: [
      { x: -170, z: -250, w: 22, h: 70, kind: 'spire' },
      { x: 200, z: -230, w: 44, h: 64, kind: 'castle' },
      { x: 260, z: 150, w: 18, h: 56, kind: 'spire' },
    ],
  },
  centreLine: 'white',
  parkGround: 'gravel',
  treeCrown: 1,
  extras: GUARDIANS,
});
