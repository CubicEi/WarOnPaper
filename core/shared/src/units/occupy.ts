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
    ownerId: string;
    buildingId: string;
    gx: number;
    gy: number;
  }[];
  units?: readonly {
    id: string;
    kind: UnitGroup["kind"];
    ownerId: string;
    gx: number;
    gy: number;
    u: number;
  }[];
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

/** 停止：除交战、停泊外均可。空军不会进入停泊。 */
export function canUnitStop(unit: UnitGroup, ctx?: UnitDockContext): boolean {
  return unit.state !== "fighting" && !isUnitDocked(unit, ctx);
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
 * Friendly carrier↔air with hangar room may colocate for embark.
 */
export function blocksUnitCell(
  occupant: UnitGroup,
  placer: OccupyPlacer | undefined,
): boolean {
  if (!placer) return true;
  if (occupant.ownerId !== placer.ownerId) return true;
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
): Set<string> {
  const set = new Set<string>();
  for (const u of units) {
    if (ignoreIds.has(u.id)) continue;
    if (u.state === "moving" || u.state === "training") continue;
    if (u.u <= 0) continue;
    if (!blocksUnitCell(u, placer)) continue;
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
