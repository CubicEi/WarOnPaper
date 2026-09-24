/**
 * 防空导弹结算（§7.3）：
 * - 对敌空军：进入射程后每秒减「进入前 U × 10%」，直到降至进入前 50%；一次消耗 2 枚弹药。
 * - 拦截飞行导弹：射程内每枚耗 1 枚弹药；高射炮发射物不拦截。弹药用尽后不再拦截。
 * 世界里还没有持续飞行的导弹实体；调用方传入落点，或发射点到落点的弹道。
 */

import type { PlacedBuilding } from "../buildings/actions.js";
import { isBuildingComplete } from "../buildings/actions.js";
import { distancePointToSegment, type GridNode } from "../buildings/liaison.js";
import {
  workRangeCircles,
  type WorkRangeCircle,
} from "../buildings/workRange.js";
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
/**
 * 火箭军武器（可被防空导弹拦截的发射建筑）。
 * 高射炮 `gun` 不在此列。
 */
export const ROCKET_FORCE_BUILDING_IDS = [
  "missile",
  "advenced_missile",
  "nuke_missile",
] as const;
export type RocketForceBuildingId = (typeof ROCKET_FORCE_BUILDING_IDS)[number];

const ROCKET_FORCE_SET = new Set<string>(ROCKET_FORCE_BUILDING_IDS);

/** 是否为火箭军可拦截弹药（导弹 / 洲际 / 核）. */
export function isRocketForceWeapon(
  buildingId: string | null | undefined,
): boolean {
  return !!buildingId && ROCKET_FORCE_SET.has(buildingId);
}

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

function isLiveAntiAir(b: PlacedBuilding): boolean {
  return (
    b.buildingId === ANTI_AIR_BUILDING_ID &&
    isBuildingComplete(b) &&
    b.hp > 0 &&
    !b.polluted
  );
}

function airInAaRange(
  air: UnitGroup,
  aa: PlacedBuilding,
  buildings: readonly PlacedBuilding[],
  connectedIds: ReadonlySet<string> | readonly string[],
): boolean {
  for (const circle of workRangeCircles(aa, buildings, connectedIds)) {
    if (visionDistDu(air.gx, air.gy, circle.gx, circle.gy) <= circle.radiusDu + 1e-9) {
      return true;
    }
  }
  return false;
}

function floorU(entryU: number): number {
  return Math.max(0, Math.floor(entryU * ANTI_AIR_FLOOR_RATIO));
}

/**
 * 推进防空对空军的持续减 U。
 * 新进入且弹药 ≥ 2 时扣弹并锁定 entryU；离开范围后清除交战记录。
 * 射程与工作范围并集一致（含雷达协同）。
 */
export function advanceAntiAir(
  unitsIn: readonly UnitGroup[],
  buildingsIn: readonly PlacedBuilding[],
  dtSec: number,
  connectedByOwner?: AntiAirConnectedByOwner | null,
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
      if (hit && hit.b.ownerId !== air.ownerId) {
        const linked = connectedByOwner?.get(hit.b.ownerId) ?? [];
        if (airInAaRange(air, hit.b, buildings, linked)) chosen = hit;
      }
    }
    if (!chosen) {
      for (const cand of aaList) {
        if (cand.b.ownerId === air.ownerId) continue;
        const linked = connectedByOwner?.get(cand.b.ownerId) ?? [];
        if (!airInAaRange(air, cand.b, buildings, linked)) continue;
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
 * 仅拦截 {@link ROCKET_FORCE_BUILDING_IDS}；高射炮发射物不拦截。
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
  /** 发射建筑 catalog id。须为火箭军武器才拦截. */
  sourceBuildingId?: string;
}

export type AntiAirConnectedByOwner = ReadonlyMap<
  string,
  ReadonlySet<string> | readonly string[]
>;

function cloneBuildings(buildings: readonly PlacedBuilding[]): PlacedBuilding[] {
  return buildings.map((b) => ({ ...b }));
}

/** 点 / 弹道到单个工作圆的距离（落点或发射点→落点线段）. */
function distanceToWorkCircle(
  missile: FlyingMissileStub,
  circle: WorkRangeCircle,
): number {
  if (missile.fromGx == null || missile.fromGy == null) {
    return visionDistDu(missile.gx, missile.gy, circle.gx, circle.gy);
  }
  const from: GridNode = { gx: missile.fromGx, gy: missile.fromGy };
  const to: GridNode = { gx: missile.gx, gy: missile.gy };
  return distancePointToSegment(circle.gx, circle.gy, from, to);
}

/**
 * 导弹是否进入该防空的工作范围并集（与 UI `workRangeCircles` 一致，含邻近雷达协同）。
 * 返回威胁距离（各圆到弹道的最小距离），供多座防空择近。
 */
function missileThreatInAaRange(
  missile: FlyingMissileStub,
  aa: PlacedBuilding,
  buildings: readonly PlacedBuilding[],
  connectedIds: ReadonlySet<string> | readonly string[],
): { inRange: boolean; dist: number } {
  const circles = workRangeCircles(aa, buildings, connectedIds);
  if (circles.length === 0) return { inRange: false, dist: Infinity };

  let bestDist = Infinity;
  let inRange = false;
  for (const circle of circles) {
    const d = distanceToWorkCircle(missile, circle);
    if (d < bestDist) bestDist = d;
    if (d <= circle.radiusDu + 1e-9) inRange = true;
  }
  return { inRange, dist: bestDist };
}

/**
 * 范围内拦截一枚火箭军导弹（不含高射炮），消耗 1 枚弹药。
 * 射程与信息框工作范围一致（自身 R + 合格雷达协同圆）。
 * 只拦截敌方导弹；弹药不足的防空导弹不参与。多座炮位时由最近的一座拦截。
 */
export function tryInterceptFlyingMissile(
  buildingsIn: readonly PlacedBuilding[],
  missile: FlyingMissileStub | null | undefined,
  connectedByOwner?: AntiAirConnectedByOwner | null,
): { buildings: PlacedBuilding[]; intercepted: boolean } {
  const buildings = cloneBuildings(buildingsIn);
  if (!missile || !isRocketForceWeapon(missile.sourceBuildingId)) {
    return { buildings, intercepted: false };
  }

  let best: { i: number; d: number; id: string } | null = null;
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i]!;
    if (!isLiveAntiAir(b)) continue;
    if (b.ownerId === missile.ownerId) continue;
    if ((b.ammo ?? 0) < ANTI_AIR_AMMO_PER_INTERCEPT) continue;
    const linked = connectedByOwner?.get(b.ownerId) ?? [];
    const threat = missileThreatInAaRange(missile, b, buildings, linked);
    if (!threat.inRange) continue;
    const d = threat.dist;
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
  connectedByOwner?: AntiAirConnectedByOwner | null,
): { buildings: PlacedBuilding[]; interceptedIds: string[] } {
  let buildings = cloneBuildings(buildingsIn);
  const interceptedIds: string[] = [];
  for (const missile of missiles) {
    const step = tryInterceptFlyingMissile(buildings, missile, connectedByOwner);
    buildings = step.buildings;
    if (step.intercepted) interceptedIds.push(missile.id);
  }
  return { buildings, interceptedIds };
}
