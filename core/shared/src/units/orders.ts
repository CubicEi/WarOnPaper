import type { MapConfig } from "../map.js";
import type { TerrainMap } from "../terrain/types.js";
import type { PlacedBuilding } from "../buildings/actions.js";
import { isBuildingComplete } from "../buildings/actions.js";
import type { PlacedLiaison } from "../buildings/liaison.js";
import { isAdjacentGridNode } from "../buildings/liaison.js";
import {
  UNIT_BLOCKADE_ENTER_E_PER_U,
  UNIT_BLOCKADE_O_COST,
  UNIT_HOLD_ENTER_E_PER_U,
  UNIT_HOLD_O_COST,
  UNIT_MOVE_O_COST,
  UNIT_MUTUAL_DEFENSE_O_COST,
  UNIT_STOP_E_COST,
  UNIT_STOP_O_COST,
  UNIT_SUPPLY_O_COST,
  garrisonLockedInBuilding,
  unitKindFromBuilding,
  type UnitKind,
  type UnitState,
} from "./catalog.js";
import { attackOrganizationCost } from "./combat.js";
import { applyAirHitAndRunStrike, findHoldCoordOutside, isBuildingHeld } from "./fight.js";
import {
  deployFromBuilding,
  releaseAwayOccupation,
  returnToBuilding,
  snapToUnitCoord,
  unitCoordKey,
  awayOccupiedU,
} from "./garrison.js";
import {
  estimatePathTimeSec,
  findFreeUnitCoord,
  planAirPath,
  planLandOrNavyPath,
  terrainAllowsKind,
  type ActivityRangeLabel,
} from "./pathfind.js";
import {
  buildingCenterKeys,
  canUnitStop,
  isUnitDocked,
  occupiedUnitKeys,
  resolveFreeUnitCoord,
} from "./occupy.js";
import { collectMovingUnitCoverage, isInsideAnyCircle } from "./radio.js";
import { garrisonRoom } from "./train.js";
import {
  findSupplyStationAt,
  pathLengthDu,
  resupplyUnitFromStation,
  usesCarriedSupply,
} from "./supply.js";
import type { UnitGroup, UnitMoveRequest, UnitMoveSource } from "./types.js";

export interface MoveContext {
  map: MapConfig;
  terrain: TerrainMap;
  buildings: readonly PlacedBuilding[];
  liaisons: readonly PlacedLiaison[];
  units: readonly UnitGroup[];
  connectedIds: ReadonlySet<string> | readonly string[];
  nextId: () => string;
}

export interface MoveApplyResult {
  ok: boolean;
  error?: string;
  organizationCost: number;
  energyCost: number;
  buildings: PlacedBuilding[];
  units: UnitGroup[];
  /** Estimated seconds for the slowest group (preview). */
  travelTimeSec: number;
}

function fail(
  error: string,
  buildings: PlacedBuilding[],
  units: UnitGroup[],
): MoveApplyResult {
  return {
    ok: false,
    error,
    organizationCost: 0,
    energyCost: 0,
    buildings,
    units,
    travelTimeSec: 0,
  };
}

const RETREAT_LOCK = "退却中，回到归属建筑前不能接受其他命令";

function isNavyKind(kind: UnitKind): boolean {
  return kind === "navy" || kind === "navy_carrier";
}

function isPortCell(
  gx: number,
  gy: number,
  buildings: readonly { buildingId: string; gx: number; gy: number }[],
): boolean {
  const key = unitCoordKey(gx, gy);
  return buildings.some(
    (b) => b.buildingId === "port" && unitCoordKey(b.gx, b.gy) === key,
  );
}

interface PlanOpts {
  ignoreCoverage?: boolean;
  ignoreTerrain?: boolean;
}

function planFor(
  unit: Pick<UnitGroup, "kind" | "ownerId" | "homeBuildingId" | "gx" | "gy">,
  toGx: number,
  toGy: number,
  ctx: MoveContext,
  opts?: PlanOpts,
) {
  const ignoreCoverage = !!opts?.ignoreCoverage;
  const ignoreTerrain = !!opts?.ignoreTerrain;
  const home = ctx.buildings.find((b) => b.id === unit.homeBuildingId);
  const portNavy = isNavyKind(unit.kind) && home?.buildingId === "port";
  const rangeLabel: ActivityRangeLabel = portNavy ? "port" : "radio";
  const coverage = ignoreCoverage
    ? []
    : collectMovingUnitCoverage(unit, ctx.buildings, ctx.connectedIds);
  const dest = snapToUnitCoord(toGx, toGy);
  const allowImpassableStart =
    isNavyKind(unit.kind) && isPortCell(unit.gx, unit.gy, ctx.buildings);
  const allowImpassableGoal =
    isNavyKind(unit.kind) && isPortCell(dest.gx, dest.gy, ctx.buildings);
  if (unit.kind === "air") {
    const planned = planAirPath(unit.gx, unit.gy, toGx, toGy, coverage, {
      ignoreCoverage,
    });
    return {
      path: planned.path,
      error: planned.error,
      travelTimeSec: estimatePathTimeSec(
        unit.kind,
        planned.path,
        ctx.terrain,
        ctx.liaisons,
        unit.ownerId,
      ),
    };
  }
  return planLandOrNavyPath({
    kind: unit.kind,
    fromGx: unit.gx,
    fromGy: unit.gy,
    toGx,
    toGy,
    map: ctx.map,
    terrain: ctx.terrain,
    liaisons: ctx.liaisons,
    ownerId: unit.ownerId,
    coverage,
    ignoreCoverage,
    ignoreTerrain,
    allowImpassableStart,
    allowImpassableGoal,
    rangeLabel,
  });
}

function standAllow(
  unit: Pick<UnitGroup, "kind" | "ownerId">,
  ctx: MoveContext,
  ignoreTerrain: boolean,
): ((gx: number, gy: number) => boolean) | undefined {
  if (unit.kind === "air" || ignoreTerrain) return undefined;
  return (gx, gy) =>
    terrainAllowsKind(unit.kind, ctx.terrain, gx, gy, {
      liaisons: ctx.liaisons,
      ownerId: unit.ownerId,
    }) ||
    (isNavyKind(unit.kind) && isPortCell(gx, gy, ctx.buildings));
}

function enterBlockading(unit: UnitGroup, gx: number, gy: number): UnitGroup {
  return {
    ...unit,
    gx,
    gy,
    state: "blockading",
    path: undefined,
    pathIndex: undefined,
    depositOnArrival: undefined,
    depositBuildingId: undefined,
    pendingBlockade: undefined,
    pendingSupply: undefined,
    supplyBuildingId: undefined,
    blockadeTimerSec: 0,
    pendingAttackUnitId: undefined,
    pendingAttackBuildingId: undefined,
    pendingHoldBuildingId: undefined,
  };
}

function enterHolding(
  unit: UnitGroup,
  gx: number,
  gy: number,
  buildingId: string,
): UnitGroup {
  return {
    ...unit,
    gx,
    gy,
    state: "holding",
    path: undefined,
    pathIndex: undefined,
    depositOnArrival: undefined,
    depositBuildingId: undefined,
    pendingBlockade: undefined,
    pendingSupply: undefined,
    supplyBuildingId: undefined,
    blockadeTimerSec: undefined,
    pendingHoldBuildingId: undefined,
    holdBuildingId: buildingId,
    holdTimerSec: 0,
    pendingAttackUnitId: undefined,
    pendingAttackBuildingId: undefined,
  };
}

function enterFightArrive(
  unit: UnitGroup,
  gx: number,
  gy: number,
  attackUnitId?: string,
  attackBuildingId?: string,
): UnitGroup {
  if (attackUnitId) {
    return {
      ...unit,
      gx,
      gy,
      state: "fighting",
      path: undefined,
      pathIndex: undefined,
      pendingBlockade: undefined,
      pendingSupply: undefined,
      pendingHoldBuildingId: undefined,
      pendingAttackUnitId: undefined,
      pendingAttackBuildingId: undefined,
      fightTargetUnitId: attackUnitId,
      combatTimerSec: 0,
      siegeBuildingId: undefined,
    };
  }
  return {
    ...unit,
    gx,
    gy,
    state: "fighting",
    path: undefined,
    pathIndex: undefined,
    pendingBlockade: undefined,
    pendingSupply: undefined,
    pendingHoldBuildingId: undefined,
    pendingAttackUnitId: undefined,
    pendingAttackBuildingId: undefined,
    siegeBuildingId: attackBuildingId,
    siegeTimerSec: 0,
    siegeDamageDealt: 0,
    siegeAirDamageDealt: 0,
    fightTargetUnitId: undefined,
  };
}

function applyPath(
  unit: UnitGroup,
  path: Array<{ gx: number; gy: number }>,
  state: UnitState,
  depositOnArrival: boolean | undefined,
  asBlockade: boolean | undefined,
  depositBuildingId: string | undefined,
  asSupply?: boolean,
  supplyBuildingId?: string,
  asHold?: boolean,
  holdBuildingId?: string,
  attackTargetUnitId?: string,
  attackTargetBuildingId?: string,
): UnitGroup {
  if (path.length <= 1) {
    const p = path[0] ?? { gx: unit.gx, gy: unit.gy };
    if (asBlockade) return enterBlockading(unit, p.gx, p.gy);
    if (asHold && holdBuildingId) return enterHolding(unit, p.gx, p.gy, holdBuildingId);
    if (attackTargetUnitId || attackTargetBuildingId) {
      return enterFightArrive(
        unit,
        p.gx,
        p.gy,
        attackTargetUnitId,
        attackTargetBuildingId,
      );
    }
    return {
      ...unit,
      gx: p.gx,
      gy: p.gy,
      state: "idle",
      path: undefined,
      pathIndex: undefined,
      depositOnArrival: depositOnArrival || undefined,
      depositBuildingId: depositOnArrival ? depositBuildingId : undefined,
      pendingBlockade: undefined,
      pendingSupply: asSupply || undefined,
      supplyBuildingId: asSupply ? supplyBuildingId : undefined,
      blockadeTimerSec: undefined,
      pendingHoldBuildingId: undefined,
      pendingAttackUnitId: undefined,
      pendingAttackBuildingId: undefined,
    };
  }
  return {
    ...unit,
    state,
    path,
    pathIndex: 1,
    depositOnArrival: depositOnArrival || undefined,
    depositBuildingId: depositOnArrival ? depositBuildingId : undefined,
    pendingBlockade: asBlockade || undefined,
    pendingSupply: asSupply || undefined,
    supplyBuildingId: asSupply ? supplyBuildingId : undefined,
    blockadeTimerSec: undefined,
    pendingHoldBuildingId: asHold ? holdBuildingId : undefined,
    holdBuildingId: undefined,
    holdTimerSec: undefined,
    pendingAttackUnitId: attackTargetUnitId,
    pendingAttackBuildingId: attackTargetBuildingId,
  };
}

/**
 * Deploy and/or order existing groups to a coordinate.
 * Charges UNIT_MOVE_O_COST per group (each deploy source + each fielded unit),
 * blockade enter costs when `asBlockade`, or UNIT_SUPPLY_O_COST when `asSupply`.
 * Carried E is spent during movement ticks (not at order time).
 * Training delivery: pass `asTrainingDelivery` / `depositOnArrival` (caller already created units).
 * Training delivery paths ignore radio/airport activity range (plan + tick).
 */
export function applyUnitMove(req: UnitMoveRequest, ctx: MoveContext): MoveApplyResult {
  if (req.asBlockade && req.asTrainingDelivery) {
    return fail("封锁与训练送达不能同时下达", ctx.buildings.map((b) => ({ ...b })), [
      ...ctx.units,
    ]);
  }
  if (req.asSupply && (req.asBlockade || req.asTrainingDelivery)) {
    return fail("补给不能与封锁/训练同时下达", ctx.buildings.map((b) => ({ ...b })), [
      ...ctx.units,
    ]);
  }
  if (
    (req.asHold || req.attackTargetUnitId || req.attackTargetBuildingId) &&
    (req.asBlockade || req.asSupply || req.asTrainingDelivery)
  ) {
    return fail("进攻/驻守不能与封锁/补给/训练同时下达", ctx.buildings.map((b) => ({ ...b })), [
      ...ctx.units,
    ]);
  }
  if (req.asHold && (req.attackTargetUnitId || req.attackTargetBuildingId)) {
    return fail("驻守与进攻不能同时下达", ctx.buildings.map((b) => ({ ...b })), [
      ...ctx.units,
    ]);
  }
  if (req.attackTargetUnitId && req.attackTargetBuildingId) {
    return fail("进攻只能指定一个目标", ctx.buildings.map((b) => ({ ...b })), [
      ...ctx.units,
    ]);
  }

  const buildings = ctx.buildings.map((b) => ({ ...b }));
  const units = ctx.units.map((u) => ({ ...u, path: u.path?.map((p) => ({ ...p })) }));

  const asSupply = !!req.asSupply;
  const asHold = !!req.asHold;
  const attackUnitId = req.attackTargetUnitId;
  const attackBuildingId = req.attackTargetBuildingId;
  const isAttack = !!(attackUnitId || attackBuildingId);

  let supplyStation: (typeof buildings)[number] | undefined;
  if (asSupply) {
    if (!req.supplyBuildingId) {
      return fail("补给缺少目标补给站", buildings, units);
    }
    supplyStation = buildings.find((b) => b.id === req.supplyBuildingId);
    if (
      !supplyStation ||
      supplyStation.ownerId !== req.ownerId ||
      supplyStation.buildingId !== "supply_station"
    ) {
      return fail("补给站不存在或不属于你", buildings, units);
    }
    if (!isBuildingComplete(supplyStation)) {
      return fail("补给站尚未建成", buildings, units);
    }
  }

  let holdTarget: (typeof buildings)[number] | undefined;
  if (asHold) {
    if (!req.holdBuildingId) {
      return fail("驻守缺少目标建筑", buildings, units);
    }
    holdTarget = buildings.find((b) => b.id === req.holdBuildingId);
    if (!holdTarget || holdTarget.ownerId !== req.ownerId) {
      return fail("驻守目标不存在或不属于你", buildings, units);
    }
    if (holdTarget.mutualDefensePartnerId) {
      return fail("互防中的建筑不能再被驻守", buildings, units);
    }
  }

  let attackUnit = attackUnitId
    ? units.find((u) => u.id === attackUnitId)
    : undefined;
  let attackBuilding = attackBuildingId
    ? buildings.find((b) => b.id === attackBuildingId)
    : undefined;
  if (isAttack) {
    if (attackUnitId) {
      if (!attackUnit || attackUnit.ownerId === req.ownerId) {
        return fail("进攻单位目标无效", buildings, units);
      }
    } else if (attackBuildingId) {
      if (!attackBuilding || attackBuilding.ownerId === req.ownerId) {
        return fail("进攻建筑目标无效", buildings, units);
      }
      if (attackBuilding.buildingId === "artificial_island") {
        return fail("不能进攻人工岛", buildings, units);
      }
    }
  }

  const dest =
    asSupply && supplyStation
      ? snapToUnitCoord(supplyStation.gx, supplyStation.gy)
      : asHold && holdTarget
        ? findHoldCoordOutside(
            holdTarget.gx,
            holdTarget.gy,
            occupiedUnitKeys(units, new Set()),
          )
        : attackUnit
          ? snapToUnitCoord(attackUnit.gx, attackUnit.gy)
          : attackBuilding
            ? snapToUnitCoord(attackBuilding.gx, attackBuilding.gy)
            : snapToUnitCoord(req.gx, req.gy);

  const movingIds = new Set<string>();
  const created: UnitGroup[] = [];

  const sources = req.sources ?? [];
  for (const src of sources) {
    const b = buildings.find((x) => x.id === src.buildingId);
    if (!b || b.ownerId !== req.ownerId) {
      return fail("建筑不存在或不属于你", buildings, units);
    }
    if (!isBuildingComplete(b) && b.buildingId !== "capital") {
      return fail("建筑尚未建成，无法派出", buildings, units);
    }
    const deployed = deployFromBuilding(b, src.u, ctx.nextId());
    if ("error" in deployed) return fail(deployed.error, buildings, units);
    if (asSupply && !usesCarriedSupply(deployed.unit.kind)) {
      return fail("空军无需携行补给", buildings, units);
    }
    // Air sortie: target must be inside home airport work range (incl. linked radar).
    if (deployed.unit.kind === "air" && isAttack) {
      const coverage = collectMovingUnitCoverage(
        deployed.unit,
        buildings,
        ctx.connectedIds,
      );
      if (!isInsideAnyCircle(dest.gx, dest.gy, coverage)) {
        return fail("目标不在所属机场工作范围内（含关联雷达）", buildings, units);
      }
    }
    const idx = buildings.findIndex((x) => x.id === b.id);
    buildings[idx] = deployed.building;
    created.push(deployed.unit);
  }

  for (const id of req.unitIds ?? []) {
    const u = units.find((x) => x.id === id);
    if (!u || u.ownerId !== req.ownerId) {
      return fail("单位不存在或不属于你", buildings, units);
    }
    if (u.retreating) {
      return fail(RETREAT_LOCK, buildings, units);
    }
    if (u.retreating) {
      return fail(RETREAT_LOCK, buildings, units);
    }
    if (u.state === "fighting") {
      return fail("交战中的单位不能调动", buildings, units);
    }
    if (asSupply && !usesCarriedSupply(u.kind)) {
      return fail("空军无需携行补给", buildings, units);
    }
    if (u.kind === "air" && isAttack) {
      const coverage = collectMovingUnitCoverage(u, buildings, ctx.connectedIds);
      if (!isInsideAnyCircle(dest.gx, dest.gy, coverage)) {
        return fail("目标不在所属机场工作范围内（含关联雷达）", buildings, units);
      }
    }
    movingIds.add(id);
  }

  if (created.length === 0 && movingIds.size === 0) {
    return fail("没有可调动的单位", buildings, units);
  }

  const nextUnits = [...units, ...created];
  let maxTime = 0;
  const state: UnitState = req.asTrainingDelivery ? "training" : "moving";
  const deposit = req.depositOnArrival ?? req.asTrainingDelivery ?? false;
  const asBlockade = !!req.asBlockade;
  const depositBuildingId = req.depositBuildingId;
  const supplyBuildingId = asSupply ? req.supplyBuildingId : undefined;
  const holdBuildingId = asHold ? req.holdBuildingId : undefined;
  const centers = buildingCenterKeys(buildings);

  const toMove = nextUnits.filter((u) => created.includes(u) || movingIds.has(u.id));
  // Occupancy: ignore units that are themselves moving to the dest; reserve claimed ends.
  const ignore = new Set(toMove.map((u) => u.id));
  const reservedEnds = new Set<string>();
  let totalU = 0;
  const removed = new Set<string>();
  const groupCount = created.length + movingIds.size;
  const kinds: UnitKind[] = toMove.map((u) => u.kind);

  for (const unit of toMove) {
    totalU += unit.u;
    // Air ordered onto its home airport: fly straight in and deposit (no ring bounce + returnGx).
    let unitDeposit = deposit;
    let unitDepositBuildingId = depositBuildingId;
    if (
      !unitDeposit &&
      !asBlockade &&
      !asSupply &&
      !asHold &&
      !isAttack &&
      !req.asTrainingDelivery &&
      unit.kind === "air"
    ) {
      const home = buildings.find(
        (b) => b.id === unit.homeBuildingId && b.ownerId === req.ownerId,
      );
      if (
        home &&
        unitCoordKey(dest.gx, dest.gy) === unitCoordKey(home.gx, home.gy)
      ) {
        unitDeposit = true;
        unitDepositBuildingId = home.id;
      }
    }
    const planOpts: PlanOpts = {
      ignoreCoverage: !!req.asTrainingDelivery || unitDeposit,
      ignoreTerrain: !!req.asTrainingDelivery && unit.kind === "navy",
    };
    const planned = planFor(unit, dest.gx, dest.gy, ctx, planOpts);
    if (planned.error || planned.path.length === 0) {
      // #region agent log
      fetch("http://127.0.0.1:7277/ingest/6741dc77-72e2-46ba-9a2a-c7dd9d84b7e9", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Debug-Session-Id": "676d95",
        },
        body: JSON.stringify({
          sessionId: "676d95",
          runId: "pre-fix",
          hypothesisId: "F_G",
          location: "orders.ts:applyUnitMove:planFail",
          message: "unit plan failed",
          data: {
            kind: unit.kind,
            unitGx: unit.gx,
            unitGy: unit.gy,
            dest,
            error: planned.error ?? "empty_path",
            pathLen: planned.path.length,
            homeBuildingId: unit.homeBuildingId ?? null,
          },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
      return fail(planned.error ?? "无法规划路径", buildings, units);
    }
    let path = planned.path;
    // Hold / deposit / air strike keep the planned cell (air lands on the target).
    const skipNudge = asHold || unitDeposit || (isAttack && unit.kind === "air");
    if (!skipNudge && path.length >= 1) {
      const end = path[path.length - 1]!;
      const occupied = occupiedUnitKeys(nextUnits, ignore, unit);
      for (const k of reservedEnds) occupied.add(k);
      for (const k of centers) occupied.add(k);
      const free = findFreeUnitCoord(
        end.gx,
        end.gy,
        occupied,
        2,
        standAllow(unit, ctx, !!planOpts.ignoreTerrain),
      );
      if (free.gx !== end.gx || free.gy !== end.gy) {
        const replanned = planFor(unit, free.gx, free.gy, ctx, planOpts);
        if (!replanned.error && replanned.path.length > 0) {
          path = replanned.path;
        } else {
          path = [...path.slice(0, -1), free];
        }
      }
      const finalEnd = path[path.length - 1]!;
      reservedEnds.add(unitCoordKey(finalEnd.gx, finalEnd.gy));
    } else if (path.length >= 1) {
      const finalEnd = path[path.length - 1]!;
      reservedEnds.add(unitCoordKey(finalEnd.gx, finalEnd.gy));
    }
    // Refuse land/navy move that needs travel with zero carried E.
    if (usesCarriedSupply(unit.kind) && pathLengthDu(path) > 1e-6 && unit.carriedE <= 1e-6) {
      return fail("携行补给已用尽，无法继续移动", buildings, units);
    }
    const idx = nextUnits.findIndex((x) => x.id === unit.id);
    const moving = nextUnits[idx]!;
    const cleared = moving.liaisonCut ? { ...moving, liaisonCut: undefined } : moving;
    let next = applyPath(
      cleared,
      path,
      state,
      unitDeposit,
      asBlockade,
      unitDepositBuildingId,
      asSupply,
      supplyBuildingId,
      asHold,
      holdBuildingId,
      attackUnitId,
      attackBuildingId,
    );
    // Already at destination with deposit:入库 immediately.
    if (unitDeposit && next.state === "idle" && next.depositOnArrival) {
      const target =
        (unitDepositBuildingId
          ? buildings.find((b) => b.id === unitDepositBuildingId && b.ownerId === req.ownerId)
          : undefined) ??
        buildings.find(
          (b) =>
            b.ownerId === req.ownerId &&
            unitCoordKey(b.gx, b.gy) === unitCoordKey(next.gx, next.gy),
        );
      if (target) {
        const releaseAway = target.id === next.homeBuildingId;
        const result = returnToBuilding(target, next.u, { releaseAway });
        const bi = buildings.findIndex((b) => b.id === target.id);
        if (bi >= 0) buildings[bi] = result.building;
        if (result.leftover <= 0) {
          removed.add(next.id);
          nextUnits[idx] = next;
          continue;
        }
        next = {
          ...next,
          u: result.leftover,
          depositOnArrival: undefined,
          depositBuildingId: undefined,
        };
      } else {
        next = {
          ...next,
          depositOnArrival: undefined,
          depositBuildingId: undefined,
        };
      }
    }
    // Already at supply station: resupply immediately.
    if (asSupply && next.state === "idle" && next.pendingSupply) {
      const station =
        findSupplyStationAt(
          buildings,
          req.ownerId,
          next.gx,
          next.gy,
          supplyBuildingId,
        ) ?? supplyStation;
      if (!station) {
        return fail("未到达补给站", buildings, units);
      }
      const filled = resupplyUnitFromStation(next, station);
      if (!filled.ok) {
        return fail(filled.error ?? "无法补给", buildings, units);
      }
      const bi = buildings.findIndex((b) => b.id === station.id);
      if (bi >= 0) buildings[bi] = filled.building;
      next = {
        ...filled.unit,
        pendingSupply: undefined,
        supplyBuildingId: undefined,
      };
    }
    if (unit.kind === "air" && !next.depositOnArrival && !req.asTrainingDelivery) {
      const home = buildings.find(
        (b) => b.id === next.homeBuildingId && b.ownerId === req.ownerId,
      );
      if (home) {
        next = { ...next, returnGx: home.gx, returnGy: home.gy };
      }
    }
    // Path≤1 attack: resolve air strike immediately and begin return.
    if (next.kind === "air" && next.state === "fighting") {
      const strikeRemoved = new Set<string>();
      next = applyAirHitAndRunStrike(
        next,
        next.fightTargetUnitId,
        next.siegeBuildingId,
        nextUnits,
        buildings,
        strikeRemoved,
      );
      for (const id of strikeRemoved) removed.add(id);
      if (!strikeRemoved.has(next.id) && next.returnGx != null && next.returnGy != null) {
        const home = buildings.find(
          (b) => b.id === next.homeBuildingId && b.ownerId === req.ownerId,
        );
        const gx = home?.gx ?? next.returnGx;
        const gy = home?.gy ?? next.returnGy;
        const end = snapToUnitCoord(gx, gy);
        next = {
          ...next,
          returnGx: undefined,
          returnGy: undefined,
          depositOnArrival: true,
          depositBuildingId: home?.id ?? next.homeBuildingId,
        };
        if (unitCoordKey(next.gx, next.gy) === unitCoordKey(end.gx, end.gy)) {
          const target =
            (home && home.ownerId === req.ownerId ? home : undefined) ??
            buildings.find(
              (b) =>
                b.ownerId === req.ownerId &&
                unitCoordKey(b.gx, b.gy) === unitCoordKey(next.gx, next.gy),
            );
          if (target) {
            const bi = buildings.findIndex((b) => b.id === target.id);
            const result = returnToBuilding(buildings[bi]!, next.u, { releaseAway: true });
            if (bi >= 0) buildings[bi] = result.building;
            if (result.leftover <= 0) {
              removed.add(next.id);
            } else {
              next = {
                ...next,
                u: result.leftover,
                depositOnArrival: undefined,
                depositBuildingId: undefined,
                state: "idle",
              };
            }
          }
        } else {
          const back = planAirPath(next.gx, next.gy, end.gx, end.gy, [], {
            ignoreCoverage: true,
          });
          const start = snapToUnitCoord(next.gx, next.gy);
          next = {
            ...next,
            state: "moving",
            path: !back.error && back.path.length > 1 ? back.path : [start, end],
            pathIndex: 1,
          };
        }
      }
    }
    nextUnits[idx] = next;
    maxTime = Math.max(maxTime, planned.travelTimeSec);
  }

  return {
    ok: true,
    organizationCost: req.asTrainingDelivery
      ? 0
      : asSupply
        ? UNIT_SUPPLY_O_COST
        : asHold
          ? UNIT_HOLD_O_COST
          : isAttack
            ? attackOrganizationCost(kinds)
            : asBlockade
              ? UNIT_BLOCKADE_O_COST
              : UNIT_MOVE_O_COST * groupCount,
    energyCost: asBlockade
      ? UNIT_BLOCKADE_ENTER_E_PER_U * totalU
      : asHold
        ? UNIT_HOLD_ENTER_E_PER_U * totalU
        : 0,
    buildings,
    units: nextUnits.filter((u) => !removed.has(u.id)),
    travelTimeSec: maxTime,
  };
}

/** 封锁：复用调动管线，到达后进入 blockading. */
export function applyUnitBlockade(req: UnitMoveRequest, ctx: MoveContext): MoveApplyResult {
  return applyUnitMove({ ...req, asBlockade: true, asTrainingDelivery: false }, ctx);
}

/** 补给：移到补给站，到达后从 storeE 补携行（−1 O）. */
export function applyUnitSupply(req: UnitMoveRequest, ctx: MoveContext): MoveApplyResult {
  return applyUnitMove(
    {
      ...req,
      asSupply: true,
      asBlockade: false,
      asTrainingDelivery: false,
      asHold: false,
      gx: req.gx,
      gy: req.gy,
    },
    ctx,
  );
}

/** 进攻：先调动至目标，再交战/攻城. */
export function applyUnitAttack(req: UnitMoveRequest, ctx: MoveContext): MoveApplyResult {
  if (!req.attackTargetUnitId && !req.attackTargetBuildingId) {
    return fail("进攻缺少目标", ctx.buildings.map((b) => ({ ...b })), [...ctx.units]);
  }
  return applyUnitMove(
    {
      ...req,
      asBlockade: false,
      asSupply: false,
      asTrainingDelivery: false,
      asHold: false,
    },
    ctx,
  );
}

/** 驻守：移到建筑外，进入 holding. */
export function applyUnitHold(req: UnitMoveRequest, ctx: MoveContext): MoveApplyResult {
  if (!req.holdBuildingId) {
    return fail("驻守缺少目标建筑", ctx.buildings.map((b) => ({ ...b })), [...ctx.units]);
  }
  return applyUnitMove(
    {
      ...req,
      asHold: true,
      asBlockade: false,
      asSupply: false,
      asTrainingDelivery: false,
      attackTargetUnitId: undefined,
      attackTargetBuildingId: undefined,
    },
    ctx,
  );
}

export interface MutualDefenseResult {
  ok: boolean;
  error?: string;
  organizationCost: number;
  buildings: PlacedBuilding[];
}

/** 互防：相邻/对角建筑配对，−2 O. */
export function applyMutualDefense(
  ownerId: string,
  buildingIdA: string,
  buildingIdB: string,
  buildingsIn: readonly PlacedBuilding[],
  unitsIn: readonly UnitGroup[],
): MutualDefenseResult {
  const buildings = buildingsIn.map((b) => ({ ...b }));
  if (buildingIdA === buildingIdB) {
    return { ok: false, error: "不能与自己互防", organizationCost: 0, buildings };
  }
  const ai = buildings.findIndex((b) => b.id === buildingIdA);
  const bi = buildings.findIndex((b) => b.id === buildingIdB);
  if (ai < 0 || bi < 0) {
    return { ok: false, error: "建筑不存在", organizationCost: 0, buildings };
  }
  const a = buildings[ai]!;
  const b = buildings[bi]!;
  if (a.ownerId !== ownerId || b.ownerId !== ownerId) {
    return { ok: false, error: "只能互防己方建筑", organizationCost: 0, buildings };
  }
  if (!isBuildingComplete(a) || !isBuildingComplete(b)) {
    return { ok: false, error: "建造中的建筑不能互防", organizationCost: 0, buildings };
  }
  if (!isAdjacentGridNode(a, b)) {
    return { ok: false, error: "互防仅限相邻或对角建筑", organizationCost: 0, buildings };
  }
  if (a.mutualDefensePartnerId || b.mutualDefensePartnerId) {
    return { ok: false, error: "建筑已有互防对象", organizationCost: 0, buildings };
  }
  if (isBuildingHeld(a.id, unitsIn) || isBuildingHeld(b.id, unitsIn)) {
    return { ok: false, error: "已被驻守的建筑不能互防", organizationCost: 0, buildings };
  }
  if (garrisonLockedInBuilding(a.buildingId) || garrisonLockedInBuilding(b.buildingId)) {
    return { ok: false, error: "该建筑驻军不能出城，无法互防", organizationCost: 0, buildings };
  }
  const kindA = unitKindFromBuilding(a.buildingId);
  const kindB = unitKindFromBuilding(b.buildingId);
  if (!kindA || !kindB || (a.u ?? 0) < 1 || (b.u ?? 0) < 1) {
    return { ok: false, error: "没有可出城驻军的建筑不能互防", organizationCost: 0, buildings };
  }
  buildings[ai] = { ...a, mutualDefensePartnerId: b.id };
  buildings[bi] = { ...b, mutualDefensePartnerId: a.id };
  return {
    ok: true,
    organizationCost: UNIT_MUTUAL_DEFENSE_O_COST,
    buildings,
  };
}

export interface EndHoldResult {
  ok: boolean;
  error?: string;
  units: UnitGroup[];
}

/** 主动结束驻守. */
export function applyEndHold(
  ownerId: string,
  unitIds: readonly string[],
  unitsIn: readonly UnitGroup[],
): EndHoldResult {
  if (unitIds.length === 0) {
    return { ok: false, error: "没有选中单位", units: [...unitsIn] };
  }
  const units = unitsIn.map((u) => ({ ...u, path: u.path?.map((p) => ({ ...p })) }));
  let any = false;
  for (const id of unitIds) {
    const idx = units.findIndex((u) => u.id === id);
    if (idx < 0) return { ok: false, error: "单位不存在", units: [...unitsIn] };
    const u = units[idx]!;
    if (u.ownerId !== ownerId) {
      return { ok: false, error: "不能结束他人驻守", units: [...unitsIn] };
    }
    if (u.retreating) {
      return { ok: false, error: RETREAT_LOCK, units: [...unitsIn] };
    }
    if (u.state !== "holding") {
      return { ok: false, error: "单位不在驻守中", units: [...unitsIn] };
    }
    units[idx] = {
      ...u,
      state: "idle",
      holdBuildingId: undefined,
      holdTimerSec: undefined,
      pendingHoldBuildingId: undefined,
    };
    any = true;
  }
  if (!any) return { ok: false, error: "没有可结束的驻守", units: [...unitsIn] };
  return { ok: true, units };
}

export interface EndBlockadeResult {
  ok: boolean;
  error?: string;
  units: UnitGroup[];
}

/** 主动结束封锁：选中单位退出 blockading → idle. */
export function applyEndBlockade(
  ownerId: string,
  unitIds: readonly string[],
  unitsIn: readonly UnitGroup[],
): EndBlockadeResult {
  if (unitIds.length === 0) {
    return { ok: false, error: "没有选中单位", units: [...unitsIn] };
  }
  const units = unitsIn.map((u) => ({ ...u, path: u.path?.map((p) => ({ ...p })) }));
  let any = false;
  for (const id of unitIds) {
    const idx = units.findIndex((u) => u.id === id);
    if (idx < 0) {
      return { ok: false, error: "单位不存在", units: [...unitsIn] };
    }
    const u = units[idx]!;
    if (u.ownerId !== ownerId) {
      return { ok: false, error: "不能结束他人封锁", units: [...unitsIn] };
    }
    if (u.retreating) {
      return { ok: false, error: RETREAT_LOCK, units: [...unitsIn] };
    }
    if (u.state !== "blockading") {
      return { ok: false, error: "单位不在封锁中", units: [...unitsIn] };
    }
    units[idx] = {
      ...u,
      state: "idle",
      pendingBlockade: undefined,
      pendingSupply: undefined,
      supplyBuildingId: undefined,
      blockadeTimerSec: undefined,
    };
    any = true;
  }
  if (!any) {
    return { ok: false, error: "没有可结束的封锁", units: [...unitsIn] };
  }
  return { ok: true, units };
}

export interface StopApplyResult {
  ok: boolean;
  error?: string;
  organizationCost: number;
  energyCost: number;
  units: UnitGroup[];
  /** Present when retreat deposits into home buildings. */
  buildings?: PlacedBuilding[];
}

const retreatClearPending = {
  pendingBlockade: undefined,
  pendingSupply: undefined,
  supplyBuildingId: undefined,
  blockadeTimerSec: undefined,
  holdBuildingId: undefined,
  holdTimerSec: undefined,
  pendingHoldBuildingId: undefined,
  pendingAttackUnitId: undefined,
  pendingAttackBuildingId: undefined,
  returnGx: undefined,
  returnGy: undefined,
  retreating: undefined,
  fightTargetUnitId: undefined,
  siegeBuildingId: undefined,
  combatTimerSec: undefined,
  siegeTimerSec: undefined,
  siegeDamageDealt: undefined,
  siegeAirDamageDealt: undefined,
  mutualDefenseForBuildingId: undefined,
  mutualDefenseHomeBuildingId: undefined,
  liaisonCut: undefined,
} as const;

/**
 * Stop / retreat.
 *
 * - 停止：陆海军除交战、停泊外均可；原地结束当前行为；−20E −3O。退却中不可停止。
 *   空军停止 = 强制返航所属建筑入库（不能停泊），费用同停止。
 * - 撤退：任何时候都可以（含交战、停泊）；不耗 O/E；不检电台、地形、携行。
 *   途中若进入封锁半径，由封锁结算应战。回到归属建筑入库前不能接受其他命令。
 */
export function applyUnitStop(
  ownerId: string,
  unitIds: readonly string[],
  unitsIn: readonly UnitGroup[],
  ctx: Pick<MoveContext, "buildings" | "connectedIds" | "terrain" | "liaisons" | "map">,
  opts?: { retreat?: boolean },
): StopApplyResult {
  if (unitIds.length === 0) {
    return { ok: false, error: "没有选中单位", organizationCost: 0, energyCost: 0, units: [...unitsIn] };
  }
  const units: UnitGroup[] = unitsIn.map((u) => ({
    ...u,
    path: u.path?.map((p) => ({ ...p })),
  }));
  const buildings: PlacedBuilding[] = ctx.buildings.map((b) => ({ ...b }));
  const retreat = !!opts?.retreat;
  const reserved = new Set<string>();
  const removed = new Set<string>();
  let any = false;
  let buildingsDirty = false;

  const clearInPlace = (u: UnitGroup): UnitGroup => {
    const free = resolveFreeUnitCoord(
      u.gx,
      u.gy,
      units,
      new Set([u.id]),
      u,
      new Set([...reserved, ...buildingCenterKeys(buildings)]),
      (x, y) =>
        u.kind === "air" ||
        terrainAllowsKind(u.kind, ctx.terrain, x, y, {
          liaisons: ctx.liaisons,
          ownerId: u.ownerId,
        }) ||
        (isNavyKind(u.kind) && isPortCell(x, y, buildings)),
    );
    reserved.add(unitCoordKey(free.gx, free.gy));
    return {
      ...u,
      gx: free.gx,
      gy: free.gy,
      state: "idle",
      path: undefined,
      pathIndex: undefined,
      depositOnArrival: undefined,
      depositBuildingId: undefined,
      pendingBlockade: undefined,
      pendingSupply: undefined,
      supplyBuildingId: undefined,
      blockadeTimerSec: undefined,
      holdBuildingId: undefined,
      holdTimerSec: undefined,
      pendingHoldBuildingId: undefined,
      pendingAttackUnitId: undefined,
      pendingAttackBuildingId: undefined,
      liaisonCut: undefined,
      returnGx: undefined,
      returnGy: undefined,
    };
  };

  const depositNow = (u: UnitGroup, home: PlacedBuilding): UnitGroup | null => {
    const bi = buildings.findIndex((b) => b.id === home.id);
    if (bi < 0) return clearInPlace({ ...u, ...retreatClearPending });
    const result = returnToBuilding(buildings[bi]!, u.u, { releaseAway: true });
    buildings[bi] = result.building;
    if (result.leftover <= 0) {
      removed.add(u.id);
      return null;
    }
    return clearInPlace({
      ...u,
      ...retreatClearPending,
      u: result.leftover,
    });
  };

  const beginRetreatHome = (u: UnitGroup): { ok: true } | { ok: false; error: string } => {
    const home = buildings.find((b) => b.id === u.homeBuildingId && b.ownerId === ownerId);
    if (!home) {
      return { ok: false, error: "找不到所属建筑，无法撤退" };
    }
    const atHome =
      unitCoordKey(u.gx, u.gy) === unitCoordKey(home.gx, home.gy);
    if (atHome) {
      const idx = units.findIndex((x) => x.id === u.id);
      const next = depositNow(u, home);
      if (next) units[idx] = next;
      else units[idx] = { ...u, u: 0 };
      return { ok: true };
    }
    const planned = planFor(
      u,
      home.gx,
      home.gy,
      {
        ...ctx,
        buildings,
        units,
        nextId: () => u.id,
      },
      { ignoreCoverage: true, ignoreTerrain: true },
    );
    let path = planned.path;
    if (planned.error || path.length === 0) {
      const start = snapToUnitCoord(u.gx, u.gy);
      const end = snapToUnitCoord(home.gx, home.gy);
      path = [start, end];
    }
    const idx = units.findIndex((x) => x.id === u.id);
    if (path.length <= 1) {
      const next = depositNow(u, home);
      if (next) units[idx] = next;
      else units[idx] = { ...u, u: 0 };
      return { ok: true };
    }
    units[idx] = {
      ...u,
      ...retreatClearPending,
      retreating: true,
      state: "moving",
      path,
      pathIndex: 1,
      depositOnArrival: true,
      depositBuildingId: home.id,
    };
    return { ok: true };
  };

  for (const id of unitIds) {
    const idx = units.findIndex((u) => u.id === id);
    if (idx < 0) {
      return { ok: false, error: "单位不存在", organizationCost: 0, energyCost: 0, units: [...unitsIn] };
    }
    const u = units[idx]!;
    if (u.ownerId !== ownerId) {
      return {
        ok: false,
        error: retreat ? "不能撤退他人单位" : "不能停止他人单位",
        organizationCost: 0,
        energyCost: 0,
        units: [...unitsIn],
      };
    }
    if (retreat) {
      if (u.retreating) {
        any = true;
        continue;
      }
      const r = beginRetreatHome(u);
      if (!r.ok) {
        return {
          ok: false,
          error: r.error,
          organizationCost: 0,
          energyCost: 0,
          units: [...unitsIn],
        };
      }
      buildingsDirty = true;
      any = true;
      continue;
    }

    if (u.retreating) {
      return {
        ok: false,
        error: RETREAT_LOCK,
        organizationCost: 0,
        energyCost: 0,
        units: [...unitsIn],
      };
    }
    if (u.state === "fighting") {
      return {
        ok: false,
        error: "交战中无法停止",
        organizationCost: 0,
        energyCost: 0,
        units: [...unitsIn],
      };
    }
    const dock = { buildings, units };
    if (isUnitDocked(u, dock) || !canUnitStop(u, dock)) {
      return {
        ok: false,
        error: isUnitDocked(u, dock) ? "停泊中无法停止" : "无法停止",
        organizationCost: 0,
        energyCost: 0,
        units: [...unitsIn],
      };
    }

    // 空军不能停泊：停止 = 强制返航所属建筑入库（与撤退同路径，仍扣停止费用）。
    if (u.kind === "air") {
      const r = beginRetreatHome(u);
      if (!r.ok) {
        return {
          ok: false,
          error: r.error,
          organizationCost: 0,
          energyCost: 0,
          units: [...unitsIn],
        };
      }
      buildingsDirty = true;
      any = true;
      continue;
    }

    // 陆海军停止：原地结束行为。不改为退却。
    units[idx] = clearInPlace(u);
    any = true;
  }

  if (!any) {
    return {
      ok: false,
      error: retreat ? "没有可撤退的单位" : "没有可停止的单位",
      organizationCost: 0,
      energyCost: 0,
      units: [...unitsIn],
    };
  }

  const outUnits = units.filter((u) => !removed.has(u.id) && u.u > 0);
  return {
    ok: true,
    organizationCost: retreat ? 0 : UNIT_STOP_O_COST,
    energyCost: retreat ? 0 : UNIT_STOP_E_COST,
    units: outUnits,
    buildings: buildingsDirty ? buildings : undefined,
  };
}

/**
 * 建筑「部署」：把外出的同类型单位改归属到这座建筑。
 * 释放原建筑占位，占用新建筑空位，再调动到该建筑（无视电台）。
 * 空军直线飞回并入库；陆海军停在建筑外圈空位，占位保持为外出。
 * 空位不足则整单拒绝。
 */
export function applyAssignHome(
  ownerId: string,
  buildingId: string,
  unitIds: readonly string[],
  ctx: MoveContext,
): MoveApplyResult {
  const snapB = ctx.buildings.map((b) => ({ ...b }));
  const snapU = ctx.units.map((u) => ({ ...u, path: u.path?.map((p) => ({ ...p })) }));
  const bad = (error: string) => fail(error, snapB, snapU);
  if (unitIds.length === 0) return bad("没有选中单位");

  const buildings = snapB.map((b) => ({ ...b }));
  const units: UnitGroup[] = snapU.map((u) => ({ ...u, path: u.path?.map((p) => ({ ...p })) }));
  const target = buildings.find((b) => b.id === buildingId);
  if (!target || target.ownerId !== ownerId) return bad("建筑不存在或不属于你");
  if (!isBuildingComplete(target) && target.buildingId !== "capital") {
    return bad("建筑尚未建成");
  }
  const kind = unitKindFromBuilding(target.buildingId);
  if (!kind) return bad("该建筑不能接收单位");

  const picked: UnitGroup[] = [];
  for (const id of unitIds) {
    const u = units.find((x) => x.id === id);
    if (!u || u.ownerId !== ownerId) return bad("单位不存在或不属于你");
    if (u.kind !== kind) return bad("只能归属同类型单位");
    if (u.state === "training") return bad("训练送达中的单位不能改归属");
    if (u.retreating) return bad(RETREAT_LOCK);
    if (u.u < 1) return bad("单位没有编制");
    picked.push(u);
  }

  let need = 0;
  for (const u of picked) {
    if (u.homeBuildingId !== target.id) need += u.u;
  }
  const room = garrisonRoom(target);
  if (need > room) {
    return bad(`空位不足（剩余 ${room} U，需要 ${need} U）`);
  }

  for (const u of picked) {
    if (u.homeBuildingId === target.id) continue;
    const oldI = buildings.findIndex((b) => b.id === u.homeBuildingId);
    if (oldI >= 0) buildings[oldI] = releaseAwayOccupation(buildings[oldI]!, u.u);
    const ni = buildings.findIndex((b) => b.id === target.id);
    const cur = buildings[ni]!;
    const away = awayOccupiedU(cur) + u.u;
    buildings[ni] = { ...cur, awayOccupiedU: away > 0 ? away : undefined };
    u.homeBuildingId = target.id;
  }

  const planCtx: MoveContext = { ...ctx, buildings, units, nextId: ctx.nextId };
  const ignore = new Set(picked.map((u) => u.id));
  const reserved = new Set<string>();
  const removed = new Set<string>();
  let maxTime = 0;
  const centers = buildingCenterKeys(buildings);

  for (const unit of picked) {
    const deposit = unit.kind === "air";
    const occupied = occupiedUnitKeys(units, ignore, unit);
    for (const k of reserved) occupied.add(k);
    for (const k of centers) occupied.add(k);
    const stand = deposit
      ? snapToUnitCoord(target.gx, target.gy)
      : findFreeUnitCoord(
          target.gx,
          target.gy,
          occupied,
          3,
          standAllow(unit, planCtx, false),
        );
    if (
      !deposit &&
      unitCoordKey(stand.gx, stand.gy) === unitCoordKey(target.gx, target.gy)
    ) {
      return bad("建筑周围没有可停留的空位");
    }
    const planned = planFor(unit, stand.gx, stand.gy, planCtx, {
      ignoreCoverage: true,
    });
    if (planned.error || planned.path.length === 0) {
      return bad(planned.error ?? "无法规划路径");
    }
    if (
      usesCarriedSupply(unit.kind) &&
      pathLengthDu(planned.path) > 1e-6 &&
      unit.carriedE <= 1e-6
    ) {
      return bad("携行补给已用尽，无法继续移动");
    }
    const idx = units.findIndex((x) => x.id === unit.id);
    const cleared: UnitGroup = {
      ...units[idx]!,
      homeBuildingId: target.id,
      fightTargetUnitId: undefined,
      siegeBuildingId: undefined,
      combatTimerSec: undefined,
      siegeTimerSec: undefined,
      siegeDamageDealt: undefined,
      siegeAirDamageDealt: undefined,
      holdBuildingId: undefined,
      holdTimerSec: undefined,
      mutualDefenseForBuildingId: undefined,
      mutualDefenseHomeBuildingId: undefined,
      retreating: undefined,
      returnGx: undefined,
      returnGy: undefined,
    };
    units[idx] = cleared;
    let next = applyPath(
      cleared,
      planned.path,
      "moving",
      deposit,
      false,
      deposit ? target.id : undefined,
    );
    if (deposit && next.state === "idle" && next.depositOnArrival) {
      const bi = buildings.findIndex((b) => b.id === target.id);
      const result = returnToBuilding(buildings[bi]!, next.u, { releaseAway: true });
      if (bi >= 0) buildings[bi] = result.building;
      if (result.leftover <= 0) {
        removed.add(next.id);
        continue;
      }
      next = {
        ...next,
        u: result.leftover,
        depositOnArrival: undefined,
        depositBuildingId: undefined,
        state: "idle",
      };
    }
    const end = next.path?.[next.path.length - 1] ?? { gx: next.gx, gy: next.gy };
    reserved.add(unitCoordKey(end.gx, end.gy));
    units[idx] = next;
    maxTime = Math.max(maxTime, planned.travelTimeSec);
  }

  return {
    ok: true,
    organizationCost: UNIT_MOVE_O_COST * picked.length,
    energyCost: 0,
    buildings,
    units: units.filter((u) => !removed.has(u.id)),
    travelTimeSec: maxTime,
  };
}

/** Preview travel time without mutating (for UI). Does not charge. */
export function previewUnitMove(
  req: UnitMoveRequest,
  ctx: MoveContext,
): {
  ok: boolean;
  error?: string;
  travelTimeSec: number;
  organizationCost: number;
  energyCost: number;
} {
  const result = applyUnitMove(req, ctx);
  // #region agent log
  {
    const srcKinds = (req.sources ?? [])
      .map((s) => ctx.buildings.find((b) => b.id === s.buildingId)?.buildingId)
      .filter(Boolean);
    const unitKinds = (req.unitIds ?? [])
      .map((id) => ctx.units.find((u) => u.id === id)?.kind)
      .filter(Boolean);
    const interesting =
      srcKinds.includes("armor_barracks") || unitKinds.includes("armor");
    if (interesting || result.error) {
      fetch("http://127.0.0.1:7277/ingest/6741dc77-72e2-46ba-9a2a-c7dd9d84b7e9", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Debug-Session-Id": "676d95",
        },
        body: JSON.stringify({
          sessionId: "676d95",
          runId: "pre-fix",
          hypothesisId: "F_G",
          location: "orders.ts:previewUnitMove",
          message: "move preview result",
          data: {
            ok: result.ok,
            error: result.error ?? null,
            gx: req.gx,
            gy: req.gy,
            srcKinds,
            unitKinds,
            sourceIds: (req.sources ?? []).map((s) => s.buildingId),
            unitIds: req.unitIds ?? [],
          },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
    }
  }
  // #endregion
  return {
    ok: result.ok,
    error: result.error,
    travelTimeSec: result.travelTimeSec,
    organizationCost: result.ok ? result.organizationCost : 0,
    energyCost: result.ok ? result.energyCost : 0,
  };
}

export function isAirKind(kind: UnitKind): boolean {
  return kind === "air";
}

export { isInsideAnyCircle };

export type { UnitMoveSource };
