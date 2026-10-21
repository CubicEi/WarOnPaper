/**
 * Unit grid occupancy / anti-stack (0.2 snap).
 * Exception: friendly idle air may share a cell with a carrier that has hangar room
 * (auto-embark). Embarked air is not a fielded unit.
 */

import {
  CARRIER_AIR_CAPACITY,
  isCarrierKind,
} from "./catalog.js";
import { unitCoordKey } from "./garrison.js";
import { findFreeUnitCoord } from "./pathfind.js";
import type { UnitGroup } from "./types.js";
import { isFriendly, type TeamRoster } from "../teams.js";

export type OccupyPlacer = Pick<UnitGroup, "id" | "kind" | "ownerId" | "embarkedAirU">;

function hangarRoom(unit: Pick<UnitGroup, "kind" | "embarkedAirU">): number {
  if (!isCarrierKind(unit.kind)) return 0;
  return Math.max(0, CARRIER_AIR_CAPACITY - (unit.embarkedAirU ?? 0));
}

/**
 * 停泊判定用的泊位。机库空军不是独立单位（并入 embarkedAirU），
 * 因此停泊只针对仍在野外的单位组。
 */
export interface UnitDockContext {
  buildings?: readonly {
    id?: string;
    ownerId: string;
    buildingId: string;
    gx: number;
    gy: number;
    u?: number;
  }[];
  units?: readonly {
    id: string;
    kind: UnitGroup["kind"];
    ownerId: string;
    gx: number;
    gy: number;
    u: number;
    state?: UnitGroup["state"];
    holdBuildingId?: string;
    mutualDefenseForBuildingId?: string;
  }[];
}

/** 正在拆城防（驻军已清空、无城外驻守/互防守军交战）。 */
export function isSiegeBuildingHpPhase(
  unit: UnitGroup,
  buildings: NonNullable<UnitDockContext["buildings"]>,
  units?: UnitDockContext["units"],
): boolean {
  if (unit.state !== "fighting" || !unit.siegeBuildingId || unit.fightTargetUnitId) {
    return false;
  }
  if (unit.kind === "air") return false;
  const b = buildings?.find((x) => x.id === unit.siegeBuildingId);
  if (!b || b.ownerId === unit.ownerId) return false;
  if ((b.u ?? 0) > 0) return false;
  if (units) {
    const buildingId = unit.siegeBuildingId;
    const guards = units.some(
      (u) =>
        u.u > 0 &&
        u.ownerId === b.ownerId &&
        (u.holdBuildingId === buildingId || u.mutualDefenseForBuildingId === buildingId),
    );
    if (guards) return false;
  }
  return true;
}

/**
 * 停泊：停留（idle）且坐标与己方港口或己方航母重合。
 * 航母船体可移动，本身不算停泊；行军 / 驻守 / 封锁 / 交战 / 训练途中也不算。
 * 未提供港口/航母上下文时无法判定泊位，返回 false。
 */
export function isUnitDocked(unit: UnitGroup, ctx?: UnitDockContext): boolean {
  if (unit.kind === "air") return false;
  if (isCarrierKind(unit.kind)) return false;
  if (unit.state !== "idle") return false;
  if (!ctx) return false;
  const key = unitCoordKey(unit.gx, unit.gy);
  const onPort = (ctx.buildings ?? []).some(
    (b) =>
      b.buildingId === "port" &&
      b.ownerId === unit.ownerId &&
      unitCoordKey(b.gx, b.gy) === key,
  );
  if (onPort) return true;
  return (ctx.units ?? []).some(
    (u) =>
      u.id !== unit.id &&
      isCarrierKind(u.kind) &&
      u.ownerId === unit.ownerId &&
      u.u > 0 &&
      unitCoordKey(u.gx, u.gy) === key,
  );
}

/**
 * 停止：驻守 / 封锁 / 移动中；或攻城 HP 阶段（非打守军）。
 * 撤退途中不可停止。（停泊、停留、训练途中、停港等不可，交战打守军时不可。）
 */
export function canUnitStop(unit: UnitGroup, ctx?: UnitDockContext): boolean {
  if (unit.retreating) return false;
  if (
    unit.state === "holding" ||
    unit.state === "blockading" ||
    unit.state === "moving"
  ) {
    return true;
  }
  if (ctx?.buildings) {
    return isSiegeBuildingHpPhase(unit, ctx.buildings, ctx.units);
  }
  return false;
}
/** 撤退：任何时候都可以（含交战、停泊）。已在撤回途中则不再重复下达。 */
export function canUnitRetreat(unit: UnitGroup, _ctx?: UnitDockContext): boolean {
  return unit.u > 0 && !unit.retreating;
}

/** Center cells of placed buildings. Units should not idle on these. */
export function buildingCenterKeys(
  buildings: readonly { gx: number; gy: number }[],
): Set<string> {
  const set = new Set<string>();
  for (const b of buildings) set.add(unitCoordKey(b.gx, b.gy));
  return set;
}

/**
 * Whether `occupant` blocks `placer` from sharing a cell.
 * Friendly / ally carrier↔air with hangar room may colocate for embark.
 * Allies do not block each other (incl. passing ally blockades).
 */
export function blocksUnitCell(
  occupant: UnitGroup,
  placer: OccupyPlacer | undefined,
  teams?: TeamRoster | null,
): boolean {
  if (!placer) return true;
  if (!isFriendly(teams, occupant.ownerId, placer.ownerId)) return true;
  if (placer.kind === "air" && isCarrierKind(occupant.kind) && hangarRoom(occupant) > 0) {
    return false;
  }
  if (
    isCarrierKind(placer.kind) &&
    occupant.kind === "air" &&
    occupant.state === "idle" &&
    hangarRoom(placer) > 0
  ) {
    return false;
  }
  return true;
}

/**
 * Keys of cells occupied by stationary units (moving/training ignored).
 * Optional `placer` applies carrier↔air colocation exception.
 */
export function occupiedUnitKeys(
  units: readonly UnitGroup[],
  ignoreIds: ReadonlySet<string> = new Set(),
  placer?: OccupyPlacer,
  teams?: TeamRoster | null,
): Set<string> {
  const set = new Set<string>();
  for (const u of units) {
    if (ignoreIds.has(u.id)) continue;
    if (u.state === "moving" || u.state === "training") continue;
    if (u.u <= 0) continue;
    if (!blocksUnitCell(u, placer, teams)) continue;
    set.add(unitCoordKey(u.gx, u.gy));
  }
  return set;
}

/** Snap to a free 0.2 cell near `gx,gy`, respecting occupancy. */
export function resolveFreeUnitCoord(
  gx: number,
  gy: number,
  units: readonly UnitGroup[],
  ignoreIds: ReadonlySet<string>,
  placer?: OccupyPlacer,
  reserved: ReadonlySet<string> = new Set(),
  allow?: (gx: number, gy: number) => boolean,
): { gx: number; gy: number } {
  const occupied = occupiedUnitKeys(units, ignoreIds, placer);
  for (const k of reserved) occupied.add(k);
  return findFreeUnitCoord(gx, gy, occupied, 2, allow);
}
