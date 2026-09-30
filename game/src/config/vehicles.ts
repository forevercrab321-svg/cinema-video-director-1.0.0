/**
 * Machine types the player picks in the lobby. Multipliers apply on top of growth.ts
 * (movement) and collection settings; the look selects paint and bolt-on parts on the
 * shared collector chassis (entities/PlayerModel.ts).
 */
export type VehicleLook = 'collector' | 'dozer' | 'racer' | 'magnet';

export interface VehicleDef {
  id: VehicleLook;
  name: string;
  nameZh: string;
  blurb: string;
  blurbZh: string;
  speed: number;
  accel: number;
  turn: number;
  reach: number;
  pull: number;
  dashCooldown: number;
  /** Eat threshold multiplier (below 1 = can eat rivals closer to its own size). */
  eatRatio: number;
  shell: number;
  accent: number;
}

// Balance audit 2026-09-30 (tools/arena-balance.mjs, 16 AI rounds): Racer won 8/16 with 25 kills / 3
// deaths, Dozer 1/16 and Collector 2/16 → Racer speed 1.22→1.15, accel 1.3→1.2, dash cooldown
// 0.65→0.8, reach 0.82→0.78; Collector speed/reach/pull +4/+10/+10 %; Dozer speed 0.86→0.92,
// accel 0.8→0.9, reach 1.25→1.35. Later passes: Magnet then won 10/16 → reach 1.6→1.35,
// pull 1.35→1.2; Collector (0 wins) speed 1.06, accel 1.05, reach 1.12.
export const VEHICLES: Record<VehicleLook, VehicleDef> = {
  collector: { id: 'collector', name: 'Collector', nameZh: '回收者', blurb: 'Balanced all-rounder', blurbZh: '各项均衡的全能型', speed: 1.06, accel: 1.05, turn: 1, reach: 1.12, pull: 1.1, dashCooldown: 1, eatRatio: 1, shell: 0xe8781a, accent: 0xffb347 },
  dozer: { id: 'dozer', name: 'Dozer', nameZh: '推土机', blurb: 'Slow, wide blade, eats rivals closer to its size', blurbZh: '慢但铲子宽，能吞比自己小不多的对手', speed: 0.92, accel: 0.9, turn: 0.85, reach: 1.35, pull: 1.1, dashCooldown: 1.2, eatRatio: 0.92, shell: 0xd9a21b, accent: 0xffd35a },
  racer: { id: 'racer', name: 'Racer', nameZh: '疾风', blurb: 'Fast and nimble, short reach, quick dash', blurbZh: '又快又灵活，吸取范围短，冲刺冷却快', speed: 1.15, accel: 1.2, turn: 1.25, reach: 0.78, pull: 0.95, dashCooldown: 0.8, eatRatio: 1.04, shell: 0xc4302b, accent: 0xff6b5a },
  magnet: { id: 'magnet', name: 'Magnet', nameZh: '磁吸车', blurb: 'Long-range pull, average speed', blurbZh: '远距离吸取，速度一般', speed: 0.95, accel: 0.95, turn: 1, reach: 1.35, pull: 1.2, dashCooldown: 1.1, eatRatio: 1.02, shell: 0x2f6fb8, accent: 0x7fc4ff },
};

export const VEHICLE_ORDER: VehicleLook[] = ['collector', 'dozer', 'racer', 'magnet'];

/** Player slot colours (chips, rings, name tags), in slot order. */
export const SLOT_COLORS = [0xffb347, 0x5ec8ff, 0xff6b8a, 0x8be07a] as const;
