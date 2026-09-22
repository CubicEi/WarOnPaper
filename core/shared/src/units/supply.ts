/** Carried supply: move cost + resupply at supply_station (§4.4). */

import type { PlacedBuilding } from "../buildings/actions.js";
import { UNIT_BY_KIND, UNIT_COORD_STEP, type UnitKind } from "./catalog.js";
import { snapToUnitCoord } from "./garrison.js";
import type { UnitGroup } from "./types.js";

const EPS = 1e-6;

/** Chebyshev rings on the 0.2 grid (0 = same cell, 1 = adjacent for anti-stack supply). */
export function unitGridChebyshev(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const a = snapToUnitCoord(ax, ay);
  const b = snapToUnitCoord(bx, by);
  const dx = Math.round(Math.abs(a.gx - b.gx) / UNIT_COORD_STEP);
  const dy = Math.round(Math.abs(a.gy - b.gy) / UNIT_COORD_STEP);
  return Math.max(dx, dy);
}

export function isNearUnitCoord(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  maxRings = 1,
): boolean {
  return unitGridChebyshev(ax, ay, bx, by) <= maxRings;
}

/** Path length in Du (sum of segment lengths). */
export function pathLengthDu(
  path: ReadonlyArray<{ gx: number; gy: number }>,
): number {
  let d = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    d += Math.hypot(b.gx - a.gx, b.gy - a.gy);
  }
  return d;
}

/** Whether this kind consumes / carries supply (air does not). */
export function usesCarriedSupply(kind: UnitKind): boolean {
  const def = UNIT_BY_KIND[kind];
  return def.duPerE != null && def.carryEMax != null;
}

/**
 * Carried E cost per U for traveling `distanceDu`.
 * Formula: cost = distance / duPerE（1E 可供 1U 走 duPerE Du）.
 */
export function carriedECostPerU(kind: UnitKind, distanceDu: number): number {
  const duPerE = UNIT_BY_KIND[kind].duPerE;
  if (duPerE == null || duPerE <= 0 || distanceDu <= 0) return 0;
  return distanceDu / duPerE;
}

/** Max travel Du from current carriedE (null = unlimited / air). */
export function maxTravelDuFromCarried(
  kind: UnitKind,
  carriedE: number,
): number | null {
  const duPerE = UNIT_BY_KIND[kind].duPerE;
  if (duPerE == null) return null;
  return Math.max(0, carriedE) * duPerE;
}

/**
 * Consume carried E for a movement step. Returns distance actually allowed
 * (may be shorter when E runs out) and the new carriedE.
 */
export function consumeCarriedForStep(
  kind: UnitKind,
  carriedE: number,
  stepDu: number,
): { stepDu: number; carriedE: number; exhausted: boolean } {
  if (!usesCarriedSupply(kind) || stepDu <= EPS) {
    return { stepDu, carriedE, exhausted: false };
  }
  const duPerE = UNIT_BY_KIND[kind].duPerE!;
  const cost = stepDu / duPerE;
  if (carriedE + EPS >= cost) {
    const next = carriedE - cost;
    return {
      stepDu,
      carriedE: next <= EPS ? 0 : next,
      exhausted: next <= EPS,
    };
  }
  // Only travel as far as remaining E allows.
  const allowed = Math.max(0, carriedE) * duPerE;
  return { stepDu: allowed, carriedE: 0, exhausted: true };
}

export interface ResupplyResult {
  ok: boolean;
  error?: string;
  unit: UnitGroup;
  building: PlacedBuilding;
  /** E drawn from station store (refillPerU * u). */
  transferredE: number;
  refillPerU: number;
}

/**
 * Refill carriedE from a supply station's storeE.
 * - At least 1E per U; capped by carryEMax and floor(storeE / u).
 * - Air / no-carry kinds rejected.
 */
export function resupplyUnitFromStation(
  unit: UnitGroup,
  station: PlacedBuilding,
): ResupplyResult {
  if (station.buildingId !== "supply_station") {
    return {
      ok: false,
      error: "只能在补给站补给",
      unit,
      building: station,
      transferredE: 0,
      refillPerU: 0,
    };
  }
  if (station.ownerId !== unit.ownerId) {
    return {
      ok: false,
      error: "不能使用他人补给站",
      unit,
      building: station,
      transferredE: 0,
      refillPerU: 0,
    };
  }
  // Allow adjacent cell: anti-stack may nudge off the station node.
  if (!isNearUnitCoord(unit.gx, unit.gy, station.gx, station.gy, 1)) {
    return {
      ok: false,
      error: "单位未到达补给站",
      unit,
      building: station,
      transferredE: 0,
      refillPerU: 0,
    };
  }
  const def = UNIT_BY_KIND[unit.kind];
  if (def.carryEMax == null) {
    return {
      ok: false,
      error: "空军无需携行补给",
      unit,
      building: station,
      transferredE: 0,
      refillPerU: 0,
    };
  }
  if (unit.u < 1) {
    return {
      ok: false,
      error: "没有可补给的单位",
      unit,
      building: station,
      transferredE: 0,
      refillPerU: 0,
    };
  }
  const room = def.carryEMax - unit.carriedE;
  if (room < 1 - EPS) {
    return {
      ok: false,
      error: "携行补给已满（单次至少需 1E 空位）",
      unit,
      building: station,
      transferredE: 0,
      refillPerU: 0,
    };
  }
  const store = Math.max(0, station.storeE ?? 0);
  const byStore = Math.floor(store / unit.u);
  const byRoom = Math.floor(room + EPS);
  const refillPerU = Math.min(byRoom, byStore);
  if (refillPerU < 1) {
    return {
      ok: false,
      error: "站内能源不足（每单位至少 1E）",
      unit,
      building: station,
      transferredE: 0,
      refillPerU: 0,
    };
  }
  const transferredE = refillPerU * unit.u;
  const nextCarried = Math.min(def.carryEMax, unit.carriedE + refillPerU);
  return {
    ok: true,
    unit: { ...unit, carriedE: nextCarried },
    building: { ...station, storeE: store - transferredE },
    transferredE,
    refillPerU,
  };
}

/** Find own supply station at / adjacent to unit coords, optionally by id. */
export function findSupplyStationAt(
  buildings: readonly PlacedBuilding[],
  ownerId: string,
  gx: number,
  gy: number,
  preferId?: string,
  maxRings = 1,
): PlacedBuilding | undefined {
  if (preferId) {
    const byId = buildings.find((b) => b.id === preferId);
    if (
      byId &&
      byId.buildingId === "supply_station" &&
      byId.ownerId === ownerId &&
      isNearUnitCoord(byId.gx, byId.gy, gx, gy, maxRings)
    ) {
      return byId;
    }
  }
  let best: PlacedBuilding | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const b of buildings) {
    if (b.buildingId !== "supply_station" || b.ownerId !== ownerId) continue;
    const d = unitGridChebyshev(b.gx, b.gy, gx, gy);
    if (d > maxRings) continue;
    if (d < bestDist) {
      bestDist = d;
      best = b;
    }
  }
  return best;
}
