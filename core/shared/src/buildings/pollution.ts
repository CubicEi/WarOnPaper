/**
 * 核导弹污染区（§7.3）：命中后持久污染，半径见 NUKE_POLLUTION_R_DU。
 * 区内禁止建造；已有建筑失效（仅可拆除）；首都每 3 秒扣 1 HP。
 */

export const NUKE_MISSILE_BUILDING_ID = "nuke_missile";

/** 核导弹污染半径（Du），与规则表「污染 R = 2」一致。 */
export const NUKE_POLLUTION_R_DU = 2;

/** 首都处于污染内时的扣血间隔（秒）。 */
export const POLLUTION_CAPITAL_HP_INTERVAL_SEC = 3;

/** 每次污染结算对首都造成的 HP 伤害。 */
export const POLLUTION_CAPITAL_HP_DAMAGE = 1;

export interface PollutionZone {
  id: string;
  /** 污染圆心（格点）。 */
  gx: number;
  gy: number;
  /** 半径（Du）。 */
  radiusDu: number;
}

/** 点是否落在任一污染区内（含边界）。 */
export function isPointInPollution(
  gx: number,
  gy: number,
  zones: readonly PollutionZone[],
): boolean {
  for (const z of zones) {
    const r = z.radiusDu > 0 ? z.radiusDu : NUKE_POLLUTION_R_DU;
    if (Math.hypot(gx - z.gx, gy - z.gy) <= r + 1e-9) return true;
  }
  return false;
}

export function isBuildingInPollution(
  building: { gx: number; gy: number; polluted?: boolean },
  zones: readonly PollutionZone[],
): boolean {
  if (building.polluted) return true;
  return isPointInPollution(building.gx, building.gy, zones);
}

/** 创建以命中点为圆心的核污染区。 */
export function createNukePollutionZone(
  id: string,
  gx: number,
  gy: number,
): PollutionZone {
  return { id, gx, gy, radiusDu: NUKE_POLLUTION_R_DU };
}
