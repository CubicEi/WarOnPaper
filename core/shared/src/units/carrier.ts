/**
 * 母舰：港口花 2000E 将驻军派出为 navy_carrier（0.4 Du/s），可装载最多 5U 空军。
 */

import type { PlacedBuilding } from "../buildings/actions.js";
import { isBuildingComplete } from "../buildings/actions.js";
import {
  CARRIER_AIR_CAPACITY,
  CARRIER_BUILD_E,
  CARRIER_HULL_U,
  CARRIER_SORTIE_RADIUS_DU,
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
  CARRIER_SORTIE_RADIUS_DU,
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

export type CarrierSortieLaunchResult =
  | { ok: true; units: UnitGroup[]; sortieIds: string[] }
  | { ok: false; error: string };

export function carrierEmbarkedU(unit: UnitGroup): number {
  return Math.max(0, unit.embarkedAirU ?? 0);
}

export function carrierAirRoom(
  unit: UnitGroup,
  fieldedUnits: readonly UnitGroup[] = [],
  excludeSortieUnitId?: string,
): number {
  if (unit.kind !== "navy_carrier") return 0;
  const sortieU = fieldedUnits.reduce(
    (sum, candidate) =>
      sum +
      (candidate.id !== excludeSortieUnitId &&
      candidate.carrierId === unit.id &&
      candidate.carrierSortieState != null &&
      candidate.u > 0
        ? candidate.u
        : 0),
    0,
  );
  return Math.max(
    0,
    CARRIER_AIR_CAPACITY - carrierEmbarkedU(unit) - sortieU,
  );
}

export function carrierCapacityLabel(
  unit: UnitGroup,
  fieldedUnits: readonly UnitGroup[] = [],
): string {
  return `${CARRIER_AIR_CAPACITY - carrierAirRoom(unit, fieldedUnits)}/${CARRIER_AIR_CAPACITY}`;
}

function embarkedManifest(carrier: UnitGroup): Array<{ homeBuildingId: string; u: number }> {
  const current = carrier.embarkedAirByHome?.filter(
    (entry) => entry.homeBuildingId && Number.isFinite(entry.u) && entry.u > 0,
  );
  if (current?.length) return current.map((entry) => ({ ...entry }));
  const u = carrierEmbarkedU(carrier);
  const homeBuildingId = carrier.embarkedAirHomeBuildingId;
  return u > 0 && homeBuildingId ? [{ homeBuildingId, u }] : [];
}

function withEmbarkedManifest(
  carrier: UnitGroup,
  manifest: Array<{ homeBuildingId: string; u: number }>,
): UnitGroup {
  const clean = manifest.filter((entry) => entry.u > 0);
  return {
    ...carrier,
    embarkedAirU: clean.reduce((sum, entry) => sum + entry.u, 0) || undefined,
    embarkedAirHomeBuildingId: clean[0]?.homeBuildingId,
    embarkedAirByHome: clean.length ? clean : undefined,
  };
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
    hullHp: UNIT_BY_KIND.navy_carrier.hp,
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

/** Create outbound aircraft groups from the carrier hangar without releasing airport slots. */
export function applyCarrierSortieLaunch(
  ownerId: string,
  carrierId: string,
  amount: number,
  unitsIn: readonly UnitGroup[],
  nextId: () => string,
): CarrierSortieLaunchResult {
  const units: UnitGroup[] = unitsIn.map((unit) => ({
    ...unit,
    path: unit.path?.map((point) => ({ ...point })),
  }));
  const carrierIndex = units.findIndex((unit) => unit.id === carrierId);
  if (carrierIndex < 0) return { ok: false, error: "航母不存在" };
  const carrier = units[carrierIndex]!;
  if (carrier.ownerId !== ownerId) return { ok: false, error: "只能操作自己的航母" };
  if (carrier.kind !== "navy_carrier") return { ok: false, error: "目标不是航母" };
  if (carrier.retreating) return { ok: false, error: "航母撤退中，不能出击" };
  const requested = Math.floor(amount);
  if (!Number.isFinite(requested) || requested < 1) {
    return { ok: false, error: "出击数量至少为 1U" };
  }
  if (requested > carrierEmbarkedU(carrier)) {
    return { ok: false, error: "机库空军不足" };
  }

  const manifest = embarkedManifest(carrier);
  let remaining = requested;
  const launchGroups: Array<{ homeBuildingId: string; u: number }> = [];
  for (const entry of manifest) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, entry.u);
    if (take <= 0) continue;
    launchGroups.push({ homeBuildingId: entry.homeBuildingId, u: take });
    entry.u -= take;
    remaining -= take;
  }
  if (remaining > 0) return { ok: false, error: "舰载机归属数据不完整" };

  units[carrierIndex] = withEmbarkedManifest(carrier, manifest);
  const sortieIds: string[] = [];
  for (const group of launchGroups) {
    const aircraft = createUnitGroup({
      id: nextId(),
      ownerId,
      kind: "air",
      u: group.u,
      gx: carrier.gx,
      gy: carrier.gy,
      homeBuildingId: group.homeBuildingId,
      carriedE: 0,
    });
    aircraft.carrierId = carrier.id;
    aircraft.carrierSortieState = "outbound";
    sortieIds.push(aircraft.id);
    units.push(aircraft);
  }
  return { ok: true, units, sortieIds };
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
  if (
    air.retreating ||
    (carrier.retreating && air.carrierSortieState !== "returning_carrier")
  ) {
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
  const room = carrierAirRoom(
    carrier,
    units,
    air.carrierId === carrier.id ? air.id : undefined,
  );
  const take = Math.min(
    room,
    Math.max(0, Math.floor(amount ?? air.u)),
    air.u,
  );
  if (take < 1) {
    return { ok: false, error: room < 1 ? "航母机库已满" : "没有可装载的空军" };
  }
  const manifest = embarkedManifest(carrier);
  const existingHome = manifest.find((entry) => entry.homeBuildingId === air.homeBuildingId);
  if (existingHome) existingHome.u += take;
  else manifest.push({ homeBuildingId: air.homeBuildingId, u: take });
  units[ci] = withEmbarkedManifest(carrier, manifest);
  // Sortie aircraft never occupied home away slots; carrier-deploy boarding did.
  const releaseHomeAway = air.carrierSortieState !== "returning_carrier";
  if (releaseHomeAway && air.homeBuildingId) {
    const hi = buildings.findIndex(
      (b) => b.id === air.homeBuildingId && b.ownerId === air.ownerId,
    );
    if (hi >= 0) buildings[hi] = releaseAwayOccupation(buildings[hi]!, take);
  }
  const left = air.u - take;
  if (left > 0) {
    units[ai] = {
      ...air,
      u: left,
      carrierId: undefined,
      carrierSortieState: undefined,
    };
  } else units.splice(ai, 1);
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
  let remaining = take;
  const manifest = embarkedManifest(carrier);
  const disembarked: Array<{ homeBuildingId: string; u: number }> = [];
  for (const entry of manifest) {
    if (remaining <= 0) break;
    const amountForHome = Math.min(remaining, entry.u);
    if (amountForHome > 0) {
      disembarked.push({ homeBuildingId: entry.homeBuildingId, u: amountForHome });
      entry.u -= amountForHome;
      remaining -= amountForHome;
    }
  }
  units[ci] = withEmbarkedManifest(carrier, manifest);
  // Spawn each origin separately so aircraft can always return to its own airport.
  const occupied = occupiedUnitKeys(units, new Set());
  occupied.add(unitCoordKey(carrier.gx, carrier.gy));
  for (const b of _buildingsIn) occupied.add(unitCoordKey(b.gx, b.gy));
  for (const group of disembarked) {
    const free = findFreeUnitCoord(carrier.gx, carrier.gy, occupied);
    occupied.add(unitCoordKey(free.gx, free.gy));
    units.push(
      createUnitGroup({
        id: nextId(),
        ownerId: carrier.ownerId,
        kind: "air",
        u: group.u,
        gx: free.gx,
        gy: free.gy,
        homeBuildingId: group.homeBuildingId,
        carriedE: 0,
      }),
    );
  }
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
    const manifest = embarkedManifest(prev);
    if (!manifest.length && carrierEmbarkedU(prev) > 0 && prev.embarkedAirHomeBuildingId) {
      manifest.push({ homeBuildingId: prev.embarkedAirHomeBuildingId, u: carrierEmbarkedU(prev) });
    }
    for (const entry of manifest) {
      lossByHome.set(
        entry.homeBuildingId,
        (lossByHome.get(entry.homeBuildingId) ?? 0) + entry.u,
      );
    }
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
  buildingsIn: readonly PlacedBuilding[] = [],
): { units: UnitGroup[]; buildings: PlacedBuilding[] } {
  let units: UnitGroup[] = unitsIn.map((u) => ({
    ...u,
    path: u.path?.map((p) => ({ ...p })),
  })) as UnitGroup[];
  let buildings = buildingsIn.map((b) => ({ ...b }));
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
        carrierAirRoom(c, units) > 0,
    );
    if (!carrier) continue;
    const result = applyEmbarkAir(
      air.ownerId,
      carrier.id,
      air.id,
      air.u,
      units,
      buildings,
    );
    if (!result.ok) continue;
    units = result.units as UnitGroup[];
    buildings = result.buildings;
    // Restart scan after mutation.
    ai = -1;
  }

  return {
    units: units.filter((u) => !removed.has(u.id)),
    buildings,
  };
}
