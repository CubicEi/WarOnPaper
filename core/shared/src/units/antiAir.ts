/**
 * 防空导弹结算（§7.3）：
 * - 对敌空军：进入射程后每秒减「进入前 U × 10%」，直到降至进入前 50%；一次消耗 2 枚弹药。
 * - 拦截飞行导弹：射程内每枚耗 1 枚弹药；高射炮发射物不拦截。弹药用尽后不再拦截。
 * 世界里还没有持续飞行的导弹实体；调用方传入落点，或发射点到落点的弹道。
 */

import type { PlacedBuilding } from "../buildings/actions.js";
import { isBuildingComplete } from "../buildings/actions.js";
import { effectiveWorkR } from "../buildings/levelUpgrade.js";
import { distancePointToSegment, type GridNode } from "../buildings/liaison.js";
import { releaseAwayForUnitDiff } from "./garrison.js";
import type { UnitGroup } from "./types.js";
import { visionDistDu } from "../vision/vision.js";

export const ANTI_AIR_BUILDING_ID = "anti-air_gun";
/** @deprecated alias */
export const AA_BUILDING_ID = ANTI_AIR_BUILDING_ID;

/** 对空军一次交战消耗弹药. */
export const ANTI_AIR_AMMO_PER_ENGAGEMENT = 2;
/** 拦截一枚飞行导弹消耗弹药. */
export const ANTI_AIR_AMMO_PER_INTERCEPT = 1;
/** 高射炮发射物不在拦截范围内（规则：不包括高射炮）. */
export const GUN_BUILDING_ID = "gun";
/** @deprecated alias */
export const AA_AMMO_PER_AIR_ENGAGEMENT = ANTI_AIR_AMMO_PER_ENGAGEMENT;

/** 每秒相对进入时 U 的减员比例. */
export const ANTI_AIR_DRAIN_RATE_OF_ENTRY = 0.1;
/** @deprecated alias */
export const AA_U_LOSS_RATE_OF_ENTRY_PER_SEC = ANTI_AIR_DRAIN_RATE_OF_ENTRY;

/** 减员下限：进入时 U 的比例. */
export const ANTI_AIR_FLOOR_RATIO = 0.5;
/** @deprecated alias */
export const AA_U_FLOOR_OF_ENTRY = ANTI_AIR_FLOOR_RATIO;

export interface AntiAirTickResult {
  units: UnitGroup[];
  buildings: PlacedBuilding[];
  removedIds: string[];
}

function aaWorkR(building: PlacedBuilding): number {
  return effectiveWorkR(building) ?? 5;
}

function isLiveAntiAir(b: PlacedBuilding): boolean {
  return (
    b.buildingId === ANTI_AIR_BUILDING_ID &&
    isBuildingComplete(b) &&
    b.hp > 0 &&
    !b.polluted
  );
}

function airInRange(air: UnitGroup, aa: PlacedBuilding): boolean {
  return visionDistDu(air.gx, air.gy, aa.gx, aa.gy) <= aaWorkR(aa) + 1e-9;
}

function floorU(entryU: number): number {
  return Math.max(0, Math.floor(entryU * ANTI_AIR_FLOOR_RATIO));
}

/**
 * 推进防空对空军的持续减 U。
 * 新进入且弹药 ≥ 2 时扣弹并锁定 entryU；离开范围后清除交战记录。
 */
export function advanceAntiAir(
  unitsIn: readonly UnitGroup[],
  buildingsIn: readonly PlacedBuilding[],
  dtSec: number,
): AntiAirTickResult {
  const before = unitsIn.map((u) => ({
    ...u,
    path: u.path?.map((p) => ({ ...p })),
    aaEngagement: u.aaEngagement ? { ...u.aaEngagement } : undefined,
  }));
  const units = before.map((u) => ({
    ...u,
    path: u.path?.map((p) => ({ ...p })),
    aaEngagement: u.aaEngagement ? { ...u.aaEngagement } : undefined,
  }));
  const buildings = buildingsIn.map((b) => ({ ...b }));
  const removed = new Set<string>();

  const aaList = buildings
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => isLiveAntiAir(b))
    .sort((a, b) => a.b.id.localeCompare(b.b.id));

  for (let ui = 0; ui < units.length; ui++) {
    const air = units[ui]!;
    if (air.kind !== "air" || air.u <= 0) {
      if (air.aaEngagement) {
        units[ui] = { ...air, aaEngagement: undefined };
      }
      continue;
    }

    let chosen: { b: PlacedBuilding; i: number } | null = null;
    const ongoing = air.aaEngagement;
    if (ongoing) {
      const hit = aaList.find(({ b }) => b.id === ongoing.buildingId);
      if (hit && hit.b.ownerId !== air.ownerId && airInRange(air, hit.b)) chosen = hit;
    }
    if (!chosen) {
      for (const cand of aaList) {
        if (cand.b.ownerId === air.ownerId) continue;
        if (!airInRange(air, cand.b)) continue;
        if ((buildings[cand.i]!.ammo ?? 0) < ANTI_AIR_AMMO_PER_ENGAGEMENT) continue;
        chosen = cand;
        break;
      }
    }

    if (!chosen) {
      if (air.aaEngagement) {
        units[ui] = { ...air, aaEngagement: undefined };
      }
      continue;
    }

    let eng = air.aaEngagement;
    const same = eng && eng.buildingId === chosen.b.id;
    if (!same) {
      const live = buildings[chosen.i]!;
      const ammo = live.ammo ?? 0;
      if (ammo < ANTI_AIR_AMMO_PER_ENGAGEMENT) {
        units[ui] = { ...air, aaEngagement: undefined };
        continue;
      }
      buildings[chosen.i] = {
        ...live,
        ammo: Math.max(0, ammo - ANTI_AIR_AMMO_PER_ENGAGEMENT),
      };
      eng = {
        buildingId: chosen.b.id,
        entryU: air.u,
        damageAcc: 0,
      };
    } else {
      eng = { ...eng! };
    }

    eng.damageAcc += eng.entryU * ANTI_AIR_DRAIN_RATE_OF_ENTRY * dtSec;
    const floor = floorU(eng.entryU);
    let cur = air.u;
    while (eng.damageAcc + 1e-9 >= 1 && cur > floor) {
      eng.damageAcc -= 1;
      cur -= 1;
    }
    if (cur <= floor) {
      eng.damageAcc = 0;
      cur = floor;
    }

    if (cur <= 0) {
      removed.add(air.id);
      continue;
    }
    units[ui] = {
      ...air,
      u: cur,
      aaEngagement: eng,
    };
  }

  const surviving = units.filter((u) => !removed.has(u.id) && u.u > 0);
  const withAway = releaseAwayForUnitDiff(buildings, before, surviving);

  return {
    units: surviving,
    buildings: withAway,
    removedIds: [...removed],
  };
}

/**
 * 飞行导弹。世界状态里还没有这种实体时，由开火瞬间传入弹道。
 * `sourceBuildingId === gun` 的高射炮发射物不拦截。
 */
export interface FlyingMissileStub {
  id: string;
  ownerId: string;
  /** 落点 / 当前坐标. */
  gx: number;
  gy: number;
  /** 发射点。缺省时只按落点是否进入射程判断. */
  fromGx?: number;
  fromGy?: number;
  /** 发射建筑 id。高射炮不拦截. */
  sourceBuildingId?: string;
}

function cloneBuildings(buildings: readonly PlacedBuilding[]): PlacedBuilding[] {
  return buildings.map((b) => ({ ...b }));
}

function threatDistance(missile: FlyingMissileStub, aa: PlacedBuilding): number {
  if (missile.fromGx == null || missile.fromGy == null) {
    return visionDistDu(missile.gx, missile.gy, aa.gx, aa.gy);
  }
  const from: GridNode = { gx: missile.fromGx, gy: missile.fromGy };
  const to: GridNode = { gx: missile.gx, gy: missile.gy };
  return distancePointToSegment(aa.gx, aa.gy, from, to);
}

/**
 * 范围内拦截一枚导弹（不含高射炮），消耗 1 枚弹药。
 * 只拦截敌方导弹；弹药不足的防空导弹不参与。多座炮位时由最近的一座拦截。
 */
export function tryInterceptFlyingMissile(
  buildingsIn: readonly PlacedBuilding[],
  missile: FlyingMissileStub | null | undefined,
): { buildings: PlacedBuilding[]; intercepted: boolean } {
  const buildings = cloneBuildings(buildingsIn);
  if (!missile || missile.sourceBuildingId === GUN_BUILDING_ID) {
    return { buildings, intercepted: false };
  }

  let best: { i: number; d: number; id: string } | null = null;
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i]!;
    if (!isLiveAntiAir(b)) continue;
    if (b.ownerId === missile.ownerId) continue;
    if ((b.ammo ?? 0) < ANTI_AIR_AMMO_PER_INTERCEPT) continue;
    const d = threatDistance(missile, b);
    if (d > aaWorkR(b) + 1e-9) continue;
    if (
      !best ||
      d < best.d - 1e-9 ||
      (Math.abs(d - best.d) <= 1e-9 && b.id.localeCompare(best.id) < 0)
    ) {
      best = { i, d, id: b.id };
    }
  }
  if (!best) return { buildings, intercepted: false };

  const aa = buildings[best.i]!;
  buildings[best.i] = {
    ...aa,
    ammo: Math.max(0, (aa.ammo ?? 0) - ANTI_AIR_AMMO_PER_INTERCEPT),
  };
  return { buildings, intercepted: true };
}

/** 按顺序拦截多枚导弹，前一枚扣弹会影响后一枚. */
export function tryInterceptFlyingMissiles(
  buildingsIn: readonly PlacedBuilding[],
  missiles: readonly FlyingMissileStub[],
): { buildings: PlacedBuilding[]; interceptedIds: string[] } {
  let buildings = cloneBuildings(buildingsIn);
  const interceptedIds: string[] = [];
  for (const missile of missiles) {
    const step = tryInterceptFlyingMissile(buildings, missile);
    buildings = step.buildings;
    if (step.intercepted) interceptedIds.push(missile.id);
  }
  return { buildings, interceptedIds };
}
