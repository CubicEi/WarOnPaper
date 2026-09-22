/**
 * 航母：港口花 500E 将驻军派出为 navy_carrier（0.4 Du/s），可装载最多 3U 空军。
 */

import type { PlacedBuilding } from "../buildings/actions.js";
import { isBuildingComplete } from "../buildings/actions.js";
import {
  CARRIER_AIR_CAPACITY,
  CARRIER_BUILD_E,
  CARRIER_HULL_U,
  UNIT_BY_KIND,
} from "./catalog.js";
import {
  deployFromBuilding,
  releaseAwayOccupation,
  unitCoordKey,
  createUnitGroup,
} from "./garrison.js";
import { occupiedUnitKeys } from "./occupy.js";
import { findFreeUnitCoord } from "./pathfind.js";
import type { UnitGroup } from "./types.js";

export {
  CARRIER_AIR_CAPACITY,
  CARRIER_BUILD_E,
  CARRIER_HULL_U,
} from "./catalog.js";

export type BuildCarrierResult =
  | {
      ok: true;
      energyCost: number;
      buildings: PlacedBuilding[];
      units: UnitGroup[];
    }
  | { ok: false; error: string };

export type EmbarkAirResult =
  | {
      ok: true;
      buildings: PlacedBuilding[];
      units: UnitGroup[];
    }
  | { ok: false; error: string };

export type DisembarkAirResult =
  | {
      ok: true;
      units: UnitGroup[];
    }
  | { ok: false; error: string };

export function carrierEmbarkedU(unit: UnitGroup): number {
  return Math.max(0, unit.embarkedAirU ?? 0);
}

export function carrierAirRoom(unit: UnitGroup): number {
  if (unit.kind !== "navy_carrier") return 0;
  return Math.max(0, CARRIER_AIR_CAPACITY - carrierEmbarkedU(unit));
}

export function carrierCapacityLabel(unit: UnitGroup): string {
  return `${carrierEmbarkedU(unit)}/${CARRIER_AIR_CAPACITY}`;
}

export function carrierMoveSpeedDuPerS(): number {
  return UNIT_BY_KIND.navy_carrier.speedDuPerS;
}

/**
 * 港口建成且通讯已由调用方校验：扣 CARRIER_HULL_U，派出 navy_carrier。
 */
export function applyBuildCarrier(
  ownerId: string,
  portBuildingId: string,
  buildingsIn: readonly PlacedBuilding[],
  unitsIn: readonly UnitGroup[],
  nextId: () => string,
): BuildCarrierResult {
  const buildings = buildingsIn.map((b) => ({ ...b }));
  const port = buildings.find((b) => b.id === portBuildingId);
  if (!port || port.ownerId !== ownerId) {
    return { ok: false, error: "港口不存在或不属于你" };
  }
  if (port.buildingId !== "port") {
    return { ok: false, error: "只能在港口建造航母" };
  }
  if (!isBuildingComplete(port)) {
    return { ok: false, error: "港口尚未建成" };
  }
  const deployed = deployFromBuilding(port, CARRIER_HULL_U, nextId());
  if ("error" in deployed) {
    return { ok: false, error: deployed.error };
  }
  const idx = buildings.findIndex((b) => b.id === port.id);
  buildings[idx] = deployed.building;
  const unit: UnitGroup = {
    ...deployed.unit,
    kind: "navy_carrier",
    carriedE: UNIT_BY_KIND.navy_carrier.carryEMax ?? 0,
    embarkedAirU: 0,
    embarkedAirHomeBuildingId: undefined,
  };
  return {
    ok: true,
    energyCost: CARRIER_BUILD_E,
    buildings,
    units: [...unitsIn.map((u) => ({ ...u, path: u.path?.map((p) => ({ ...p })) })), unit],
  };
}

export function applyEmbarkAir(
  ownerId: string,
  carrierId: string,
  airUnitId: string,
  amount: number | undefined,
  unitsIn: readonly UnitGroup[],
  buildingsIn: readonly PlacedBuilding[],
): EmbarkAirResult {
  const units: UnitGroup[] = unitsIn.map((u) => ({
    ...u,
    path: u.path?.map((p) => ({ ...p })),
  })) as UnitGroup[];
  const buildings = buildingsIn.map((b) => ({ ...b }));
  const ci = units.findIndex((u) => u.id === carrierId);
  const ai = units.findIndex((u) => u.id === airUnitId);
  if (ci < 0 || ai < 0) return { ok: false, error: "单位不存在" };
  const carrier = units[ci]!;
  const air = units[ai]!;
  if (carrier.ownerId !== ownerId || air.ownerId !== ownerId) {
    return { ok: false, error: "只能操作自己的单位" };
  }
  if (carrier.retreating || air.retreating) {
    return { ok: false, error: "退却中，回到归属建筑前不能接受其他命令" };
  }
  if (carrier.kind !== "navy_carrier") {
    return { ok: false, error: "目标不是航母" };
  }
  if (air.kind !== "air") {
    return { ok: false, error: "只能装载空军" };
  }
  if (unitCoordKey(carrier.gx, carrier.gy) !== unitCoordKey(air.gx, air.gy)) {
    return { ok: false, error: "空军须与航母同格" };
  }
  if (air.state !== "idle") {
    return { ok: false, error: "空军须处于停留状态" };
  }
  const room = carrierAirRoom(carrier);
  const take = Math.min(
    room,
    Math.max(0, Math.floor(amount ?? air.u)),
    air.u,
  );
  if (take < 1) {
    return { ok: false, error: room < 1 ? "航母机库已满" : "没有可装载的空军" };
  }
  const nextEmbarked = carrierEmbarkedU(carrier) + take;
  const home = carrier.embarkedAirHomeBuildingId ?? air.homeBuildingId;
  units[ci] = {
    ...carrier,
    embarkedAirU: nextEmbarked,
    embarkedAirHomeBuildingId: home,
  };
  const left = air.u - take;
  if (left > 0) units[ai] = { ...air, u: left };
  else units.splice(ai, 1);
  return { ok: true, buildings, units };
}

export function applyDisembarkAir(
  ownerId: string,
  carrierId: string,
  amount: number | undefined,
  unitsIn: readonly UnitGroup[],
  _buildingsIn: readonly PlacedBuilding[],
  nextId: () => string,
): DisembarkAirResult {
  const units: UnitGroup[] = unitsIn.map((u) => ({
    ...u,
    path: u.path?.map((p) => ({ ...p })),
  })) as UnitGroup[];
  const ci = units.findIndex((u) => u.id === carrierId);
  if (ci < 0) return { ok: false, error: "航母不存在" };
  const carrier = units[ci]!;
  if (carrier.ownerId !== ownerId) {
    return { ok: false, error: "只能操作自己的航母" };
  }
  if (carrier.retreating) {
    return { ok: false, error: "退却中，回到归属建筑前不能接受其他命令" };
  }
  if (carrier.kind !== "navy_carrier") {
    return { ok: false, error: "目标不是航母" };
  }
  const total = carrierEmbarkedU(carrier);
  const take = Math.min(total, Math.max(0, Math.floor(amount ?? total)));
  if (take < 1) return { ok: false, error: "航母上没有空军" };
  const left = total - take;
  units[ci] = {
    ...carrier,
    embarkedAirU: left > 0 ? left : undefined,
    embarkedAirHomeBuildingId:
      left > 0 ? carrier.embarkedAirHomeBuildingId : undefined,
  };
  // 放飞到航母旁空位，避免同格立刻被 autoEmbark 装回.
  const occupied = occupiedUnitKeys(units, new Set());
  occupied.add(unitCoordKey(carrier.gx, carrier.gy));
  for (const b of _buildingsIn) occupied.add(unitCoordKey(b.gx, b.gy));
  const free = findFreeUnitCoord(carrier.gx, carrier.gy, occupied);
  units.push(
    createUnitGroup({
      id: nextId(),
      ownerId: carrier.ownerId,
      kind: "air",
      u: take,
      gx: free.gx,
      gy: free.gy,
      homeBuildingId:
        carrier.embarkedAirHomeBuildingId ?? carrier.homeBuildingId,
      carriedE: 0,
    }),
  );
  return { ok: true, units };
}

/**
 * 航母编制归零 / 消失时：按 embarkedAirU 释放机场 awayOccupied。
 */
export function releaseEmbarkedAirForCarrierDiff(
  buildings: readonly PlacedBuilding[],
  before: readonly UnitGroup[],
  after: readonly UnitGroup[],
): PlacedBuilding[] {
  const afterById = new Map(after.map((u) => [u.id, u] as const));
  const lossByHome = new Map<string, number>();
  for (const prev of before) {
    if (prev.kind !== "navy_carrier") continue;
    const cur = afterById.get(prev.id);
    const destroyed = !cur || cur.u <= 0;
    if (!destroyed) continue;
    const embarked = carrierEmbarkedU(prev);
    const home = prev.embarkedAirHomeBuildingId;
    if (embarked <= 0 || !home) continue;
    lossByHome.set(home, (lossByHome.get(home) ?? 0) + embarked);
  }
  if (lossByHome.size === 0) {
    return buildings.map((b) => ({ ...b }));
  }
  return buildings.map((b) => {
    const lost = lossByHome.get(b.id);
    return lost ? releaseAwayOccupation(b, lost) : { ...b };
  });
}

/** 同格友军航母自动装载停留中的空军. */
export function autoEmbarkCoLocatedAir(
  unitsIn: readonly UnitGroup[],
): UnitGroup[] {
  let units: UnitGroup[] = unitsIn.map((u) => ({
    ...u,
    path: u.path?.map((p) => ({ ...p })),
  })) as UnitGroup[];
  const removed = new Set<string>();

  for (let ai = 0; ai < units.length; ai++) {
    const air = units[ai]!;
    if (removed.has(air.id)) continue;
    if (air.kind !== "air" || air.state !== "idle" || air.u <= 0) continue;
    const key = unitCoordKey(air.gx, air.gy);
    const carrier = units.find(
      (c) =>
        !removed.has(c.id) &&
        c.kind === "navy_carrier" &&
        c.ownerId === air.ownerId &&
        c.u > 0 &&
        unitCoordKey(c.gx, c.gy) === key &&
        carrierAirRoom(c) > 0,
    );
    if (!carrier) continue;
    const result = applyEmbarkAir(
      air.ownerId,
      carrier.id,
      air.id,
      air.u,
      units,
      [],
    );
    if (!result.ok) continue;
    units = result.units as UnitGroup[];
    // Restart scan after mutation.
    ai = -1;
  }

  return units.filter((u) => !removed.has(u.id));
}
