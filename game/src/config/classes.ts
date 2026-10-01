/**
 * Size classes (design §07). An object is absorbable when player power (diameter, m)
 * ≥ its requiredPower, which defaults to its class threshold.
 */
export interface SizeClass {
  id: number;
  label: string;
  /** Chinese label for the HUD (zh mode). */
  labelZh: string;
  requiredPower: number;
}

export const SIZE_CLASSES: readonly SizeClass[] = [
  { id: 0, label: 'Dust & scrap', labelZh: '碎屑', requiredPower: 0 },
  { id: 1, label: 'Cans & bricks', labelZh: '罐子和砖块', requiredPower: 0.3 },
  { id: 2, label: 'Boxes & bags', labelZh: '纸箱和垃圾袋', requiredPower: 0.6 },
  { id: 3, label: 'Bins & street furniture', labelZh: '垃圾桶和街道设施', requiredPower: 0.9 },
  { id: 4, label: 'Dumpsters & machines', labelZh: '大垃圾箱和机器', requiredPower: 1.5 },
  { id: 5, label: 'Vehicles', labelZh: '汽车', requiredPower: 3.0 },
  { id: 6, label: 'Trucks & containers', labelZh: '卡车和集装箱', requiredPower: 5.0 },
  { id: 7, label: 'Walls & garages', labelZh: '墙体和车库', requiredPower: 8.0 },
  { id: 8, label: 'Buildings', labelZh: '楼房', requiredPower: 14 },
  { id: 9, label: 'Large buildings', labelZh: '大型建筑', requiredPower: 25 },
  { id: 10, label: 'City blocks', labelZh: '城市街区', requiredPower: 50 },
];
