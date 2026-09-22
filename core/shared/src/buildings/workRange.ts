import type { PlacedBuilding } from "./actions.js";
import { effectiveWorkR } from "./levelUpgrade.js";

/** 雷达与具有工作半径的建筑相距小于该值（Du）才合并工作范围。 */
export const RADAR_WORK_BOOST_DIST_DU = 1.5;
export const RADAR_BUILDING_ID = "radar";

export interface WorkRangeCircle {
  gx: number;
  gy: number;
  radiusDu: number;
}

function commsLinked(
  buildingId: string,
  connectedIds: ReadonlySet<string> | readonly string[],
): boolean {
  if (connectedIds instanceof Set) return connectedIds.has(buildingId);
  return (connectedIds as readonly string[]).includes(buildingId);
}

/**
 * 工作范围圆。
 * 建筑自身有 workR 时包含自身圆（含线性等级缩放）。
 * 若同阵营雷达距离 < 1.5 Du，且双方都已接入通信，再并入该雷达的工作圆。
 */
export function workRangeCircles(
  building: PlacedBuilding,
  buildings: readonly PlacedBuilding[],
  connectedIds: ReadonlySet<string> | readonly string[] = [],
): WorkRangeCircle[] {
  const ownR = effectiveWorkR(building);
  if (ownR == null || ownR <= 0) return [];

  const circles: WorkRangeCircle[] = [
    { gx: building.gx, gy: building.gy, radiusDu: ownR },
  ];
  if (!commsLinked(building.id, connectedIds)) return circles;

  for (const other of buildings) {
    if (other.id === building.id) continue;
    if (other.ownerId !== building.ownerId) continue;
    if (other.buildingId !== RADAR_BUILDING_ID) continue;
    if (!commsLinked(other.id, connectedIds)) continue;
    const dist = Math.hypot(other.gx - building.gx, other.gy - building.gy);
    if (!(dist < RADAR_WORK_BOOST_DIST_DU)) continue;
    const radarR = effectiveWorkR(other);
    if (radarR == null || radarR <= 0) continue;
    circles.push({ gx: other.gx, gy: other.gy, radiusDu: radarR });
  }
  return circles;
}

/** 点是否落在工作范围并集内（含边界）。 */
export function isInsideWorkRange(
  gx: number,
  gy: number,
  building: PlacedBuilding,
  buildings: readonly PlacedBuilding[],
  connectedIds: ReadonlySet<string> | readonly string[] = [],
): boolean {
  for (const circle of workRangeCircles(building, buildings, connectedIds)) {
    if (Math.hypot(gx - circle.gx, gy - circle.gy) <= circle.radiusDu + 1e-9) return true;
  }
  return false;
}
