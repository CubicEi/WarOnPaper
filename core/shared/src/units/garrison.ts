import type { PlacedBuilding } from "../buildings/actions.js";
import { effectiveUmax } from "../buildings/levelUpgrade.js";
import {
  UNIT_BY_KIND,
  garrisonLockedInBuilding,
  unitKindFromBuilding,
  type UnitKind,
} from "./catalog.js";
import type { UnitGroup } from "./types.js";

/** Snap to unit coordinate step (0.2). */
export function snapToUnitCoord(gx: number, gy: number): { gx: number; gy: number } {
  const step = 0.2;
  const round = (v: number) => Math.round(v / step) * step;
  // Avoid -0 and float noise (e.g. 1.0000000002)
  const clean = (v: number) => Math.round(round(v) * 1000) / 1000;
  return { gx: clean(gx), gy: clean(gy) };
}

export function unitCoordKey(gx: number, gy: number): string {
  const s = snapToUnitCoord(gx, gy);
  return `${s.gx},${s.gy}`;
}

/**
 * Click hit-test: nearest unit within `radius` Du (default 0.35).
 */
export function findUnitNear(
  units: readonly UnitGroup[],
  gx: number,
  gy: number,
  radius = 0.35,
): UnitGroup | undefined {
  let best: UnitGroup | undefined;
  let bestDist = Infinity;
  for (const u of units) {
    const d = Math.hypot(u.gx - gx, u.gy - gy);
    if (d > radius || d >= bestDist) continue;
    bestDist = d;
    best = u;
  }
  return best;
}

/** Present U in the building（在营）. */
export function presentU(building: PlacedBuilding): number {
  return building.u ?? 0;
}

/** Away U still occupying Umax slots（外出占用）. */
export function awayOccupiedU(building: PlacedBuilding): number {
  return Math.max(0, building.awayOccupiedU ?? 0);
}

/** present + away; capped conceptually by catalog u max. */
export function occupiedGarrisonU(building: PlacedBuilding): number {
  return presentU(building) + awayOccupiedU(building);
}

/** Reduce away occupation (combat loss / destroy / return). */
export function releaseAwayOccupation(
  building: PlacedBuilding,
  amount: number,
): PlacedBuilding {
  if (amount <= 0) return building;
  const next = Math.max(0, awayOccupiedU(building) - amount);
  if (next === awayOccupiedU(building)) return building;
  return { ...building, awayOccupiedU: next > 0 ? next : undefined };
}

/**
 * After units lose U or despawn, release matching awayOccupied on home buildings.
 * `before` = groups prior to the change; `after` = surviving groups (may omit destroyed).
 *
 * `ignoreDepositedU`: U already入库 via returnToBuilding this tick — those are not
 * combat losses and must not release away again (and training never occupied away).
 */
export function releaseAwayForUnitDiff(
  buildings: readonly PlacedBuilding[],
  before: readonly UnitGroup[],
  after: readonly UnitGroup[],
  ignoreDepositedU?: ReadonlyMap<string, number>,
): PlacedBuilding[] {
  const afterById = new Map(after.map((u) => [u.id, u] as const));
  const lossByHome = new Map<string, number>();
  for (const prev of before) {
    const cur = afterById.get(prev.id);
    const deposited = Math.max(0, ignoreDepositedU?.get(prev.id) ?? 0);
    const effectivePrevU = Math.max(0, prev.u - deposited);
    const lost = cur
      ? Math.max(0, effectivePrevU - cur.u)
      : Math.max(0, effectivePrevU);
    if (lost <= 0 || !prev.homeBuildingId) continue;
    lossByHome.set(
      prev.homeBuildingId,
      (lossByHome.get(prev.homeBuildingId) ?? 0) + lost,
    );
  }
  if (lossByHome.size === 0) {
    return buildings.map((b) => ({ ...b }));
  }
  return buildings.map((b) => {
    const lost = lossByHome.get(b.id);
    return lost ? releaseAwayOccupation(b, lost) : { ...b };
  });
}

/** Pull U from a building garrison; returns null if insufficient / wrong kind. */
export function deployFromBuilding(
  building: PlacedBuilding,
  amount: number,
  newId: string,
): { unit: UnitGroup; building: PlacedBuilding } | { error: string } {
  if (amount < 1) return { error: "派出数量至少为 1" };
  if (garrisonLockedInBuilding(building.buildingId)) {
    return { error: "市镇及以上聚落与首都驻军不能离城" };
  }
  const kind = unitKindFromBuilding(building.buildingId);
  if (!kind) return { error: "该建筑不能派出单位" };
  const stock = presentU(building);
  if (stock < amount) return { error: "驻军不足，无法派出" };
  const def = UNIT_BY_KIND[kind];
  const carriedE = def.carryEMax ?? 0;
  const pos = snapToUnitCoord(building.gx, building.gy);
  const unit: UnitGroup = {
    id: newId,
    ownerId: building.ownerId,
    kind,
    u: amount,
    gx: pos.gx,
    gy: pos.gy,
    carriedE,
    state: "idle",
    homeBuildingId: building.id,
  };
  const away = awayOccupiedU(building) + amount;
  return {
    unit,
    building: {
      ...building,
      u: stock - amount,
      awayOccupiedU: away > 0 ? away : undefined,
    },
  };
}

/**
 * Whether depositing into `targetId` should free `awayOccupiedU`.
 * Returning fielded units already occupy via away; training deliveries never did.
 */
export function shouldReleaseAwayOnDeposit(
  targetId: string,
  unit: { homeBuildingId: string; state?: string },
  opts?: { asTrainingDelivery?: boolean },
): boolean {
  if (opts?.asTrainingDelivery || unit.state === "training") return false;
  return targetId === unit.homeBuildingId;
}

/** Add U back into a building (capped by effective Umax, counting away occupation). */
export function returnToBuilding(
  building: PlacedBuilding,
  amount: number,
  opts?: { releaseAway?: boolean },
): { building: PlacedBuilding; deposited: number; leftover: number } {
  const max = effectiveUmax(building);
  if (max <= 0 || amount <= 0) {
    return { building, deposited: 0, leftover: amount };
  }
  const cur = presentU(building);
  const away = awayOccupiedU(building);
  // Returning home units already occupy via away: room = max - present.
  // Training delivery / other deposits must leave away slots reserved.
  const effectiveRoom = opts?.releaseAway
    ? Math.max(0, max - cur)
    : Math.max(0, max - cur - away);
  const deposited = Math.min(effectiveRoom, amount);
  let nextAway = away;
  if (opts?.releaseAway && deposited > 0) {
    nextAway = Math.max(0, away - deposited);
  }
  return {
    building: {
      ...building,
      u: cur + deposited,
      awayOccupiedU: nextAway > 0 ? nextAway : undefined,
    },
    deposited,
    leftover: amount - deposited,
  };
}

/** 训练产出 / 派出默认满携行（空军 0）。 */
export function defaultCarriedE(kind: UnitKind): number {
  return UNIT_BY_KIND[kind].carryEMax ?? 0;
}

/**
 * Create a fielded group without touching a building (training completion,
 * cheats, tests). Caller owns id generation.
 */
export function createUnitGroup(args: {
  id: string;
  ownerId: string;
  kind: UnitKind;
  u: number;
  gx: number;
  gy: number;
  homeBuildingId: string;
  carriedE?: number;
  state?: UnitGroup["state"];
}): UnitGroup {
  const pos = snapToUnitCoord(args.gx, args.gy);
  return {
    id: args.id,
    ownerId: args.ownerId,
    kind: args.kind,
    u: args.u,
    gx: pos.gx,
    gy: pos.gy,
    carriedE: args.carriedE ?? defaultCarriedE(args.kind),
    state: args.state ?? "idle",
    homeBuildingId: args.homeBuildingId,
  };
}
