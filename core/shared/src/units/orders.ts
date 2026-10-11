import type { MapConfig } from "../map.js";
import type { TerrainMap } from "../terrain/types.js";
import type { PlacedBuilding } from "../buildings/actions.js";
import {
  clearMutualDefensePair,
  isBuildingComplete,
} from "../buildings/actions.js";
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
  createUnitGroup,
  deployFromBuilding,
  releaseAwayOccupation,
  returnToBuilding,
  snapToUnitCoord,
  unitCoordKey,
  awayOccupiedU,
  shouldReleaseAwayOnDeposit,
} from "./garrison.js";
import {
  estimatePathTimeSec,
  findFreeUnitCoord,
  findNearestAllowedCoord,
  isFoothillTerrain,
  isMountainTerrain,
  planAirPath,
  planLandOrNavyPath,
  PATHFIND_MAX_EXPAND_PREVIEW,
  terrainAllowsKind,
  transportAt,
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
import { isFriendly, sameTeam, type TeamRoster } from "../teams.js";

export interface MoveContext {
  map: MapConfig;
  terrain: TerrainMap;
  buildings: readonly PlacedBuilding[];
  liaisons: readonly PlacedLiaison[];
  units: readonly UnitGroup[];
  connectedIds: ReadonlySet<string> | readonly string[];
  nextId: () => string;
  /** Optional team roster — allies share cells / cannot be attacked. */
  teams?: TeamRoster | null;
  /**
   * Cap A* expansions (UI dry-run). When set (or `previewPathfind`), failed
   * ocean/mountain crossings return a tip instead of freezing the client.
   */
  pathfindMaxExpand?: number;
  /** Shorthand: use {@link PATHFIND_MAX_EXPAND_PREVIEW} for client previews. */
  previewPathfind?: boolean;
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
  /**
   * Attack: treat the target tile as a legal path goal even when the unit cannot
   * stand there (navy vs coastal buildings). Caller then nudges to an adjacent
   * standable cell.
   */
  allowImpassableGoal?: boolean;
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
    : collectMovingUnitCoverage(unit, ctx.buildings, ctx.connectedIds, ctx.teams);
  const dest = snapToUnitCoord(toGx, toGy);
  const allowImpassableStart =
    isNavyKind(unit.kind) && isPortCell(unit.gx, unit.gy, ctx.buildings);
  const allowImpassableGoal =
    !!opts?.allowImpassableGoal ||
    (isNavyKind(unit.kind) && isPortCell(dest.gx, dest.gy, ctx.buildings));
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
  const maxExpand =
    ctx.pathfindMaxExpand ??
    (ctx.previewPathfind ? PATHFIND_MAX_EXPAND_PREVIEW : undefined);
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
    buildings: ctx.buildings,
    coverage,
    ignoreCoverage,
    ignoreTerrain,
    allowImpassableStart,
    allowImpassableGoal,
    rangeLabel,
    maxExpand,
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
      buildings: ctx.buildings,
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
      if (
        !attackUnit ||
        isFriendly(ctx.teams, attackUnit.ownerId, req.ownerId)
      ) {
        return fail("进攻单位目标无效", buildings, units);
      }
    } else if (attackBuildingId) {
      if (
        !attackBuilding ||
        isFriendly(ctx.teams, attackBuilding.ownerId, req.ownerId)
      ) {
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
            occupiedUnitKeys(units, new Set(), undefined, ctx.teams),
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
        ctx.teams,
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
      const coverage = collectMovingUnitCoverage(
        u,
        buildings,
        ctx.connectedIds,
        ctx.teams,
      );
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
      // Navy training embarks onto ocean (below) and paths with normal navy rules.
      ignoreTerrain: false,
      // Land/navy attack: destination may be impassable (coastal building). Path to
      // the target tile, then nudge onto an adjacent standable cell below.
      allowImpassableGoal: isAttack && unit.kind !== "air",
    };
    // Training navy spawns on land (training ground). Embark nearest ocean, then
    // sail around coastline to a standable dock cell (port or adjacent ocean).
    let planUnit = unit;
    let planToGx = dest.gx;
    let planToGy = dest.gy;
    if (req.asTrainingDelivery && isNavyKind(unit.kind)) {
      const embark = findNearestAllowedCoord(
        unit.kind,
        ctx.map,
        ctx.terrain,
        unit.gx,
        unit.gy,
        { liaisons: ctx.liaisons, ownerId: unit.ownerId },
      );
      if (!embark) {
        return fail("附近没有可出航水域，无法送达海军", buildings, units);
      }
      const ui = nextUnits.findIndex((x) => x.id === unit.id);
      if (ui >= 0) {
        nextUnits[ui] = { ...nextUnits[ui]!, gx: embark.gx, gy: embark.gy };
        planUnit = nextUnits[ui]!;
      } else {
        planUnit = { ...unit, gx: embark.gx, gy: embark.gy };
      }
      const dockOccupied = occupiedUnitKeys(nextUnits, ignore, unit, ctx.teams);
      for (const k of reservedEnds) dockOccupied.add(k);
      for (const k of centers) dockOccupied.add(k);
      const dock = findFreeUnitCoord(
        dest.gx,
        dest.gy,
        dockOccupied,
        2,
        standAllow(unit, ctx, false),
      );
      planToGx = dock.gx;
      planToGy = dock.gy;
    } else if (
      created.some((c) => c.id === unit.id) &&
      (unit.kind === "infantry" || unit.kind === "armor")
    ) {
      // Coastal / mountain-cliff barracks: the building node can be standable while
      // every inland step is pure mountain. Prefer the nearest non-building cell
      // land units can march from before planning the order path.
      const terrainOpts = {
        liaisons: ctx.liaisons,
        ownerId: unit.ownerId,
        buildings: ctx.buildings,
      };
      const start = snapToUnitCoord(unit.gx, unit.gy);
      const step = 0.2;
      const maxRing = Math.ceil(12 / step);
      const maxX = ctx.map.linesX - 1;
      const maxY = ctx.map.linesY - 1;
      let spawn: { gx: number; gy: number } | null = null;
      for (let ring = 1; ring <= maxRing && !spawn; ring++) {
        for (let dx = -ring; dx <= ring && !spawn; dx++) {
          for (let dy = -ring; dy <= ring; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
            const p = snapToUnitCoord(start.gx + dx * step, start.gy + dy * step);
            if (
              p.gx < -1e-9 ||
              p.gy < -1e-9 ||
              p.gx > maxX + 1e-9 ||
              p.gy > maxY + 1e-9
            ) {
              continue;
            }
            if (centers.has(unitCoordKey(p.gx, p.gy))) continue;
            if (
              !terrainAllowsKind(
                unit.kind,
                ctx.terrain,
                p.gx,
                p.gy,
                terrainOpts,
              )
            ) {
              continue;
            }
                            // Armor: skip mountain-cliff coastline strips (standable but no
                            // inland step) unless a road/rail corridor (incl. 借道) is underfoot.
                            if (
                              unit.kind === "armor" &&
                              isMountainTerrain(ctx.terrain, p.gx, p.gy) &&
                              !isFoothillTerrain(ctx.terrain, p.gx, p.gy) &&
                              transportAt(
                                p.gx,
                                p.gy,
                                ctx.liaisons,
                                unit.ownerId,
                              ) == null
                            ) {
                              continue;
                            }
            spawn = p;
            break;
          }
        }
      }
      if (
        !spawn &&
        terrainAllowsKind(unit.kind, ctx.terrain, start.gx, start.gy, terrainOpts)
      ) {
        spawn = start;
      }
      if (!spawn) {
        return fail("附近没有可部署的陆地，无法派出", buildings, units);
      }
      const ui = nextUnits.findIndex((x) => x.id === unit.id);
      if (ui >= 0) {
        nextUnits[ui] = { ...nextUnits[ui]!, gx: spawn.gx, gy: spawn.gy };
        planUnit = nextUnits[ui]!;
      } else {
        planUnit = { ...unit, gx: spawn.gx, gy: spawn.gy };
      }
    }
    const planned = planFor(planUnit, planToGx, planToGy, ctx, planOpts);
    if (planned.error || planned.path.length === 0) {
      return fail(planned.error ?? "无法规划路径", buildings, units);
    }
    let path = planned.path;
    // Hold / deposit / air strike keep the planned cell (air lands on the target).
    // Navy training already resolved a standable dock above — skip re-nudge.
    const skipNudge =
      asHold ||
      unitDeposit ||
      (isAttack && unit.kind === "air") ||
      (!!req.asTrainingDelivery && isNavyKind(unit.kind));
    if (!skipNudge && path.length >= 1) {
      const end = path[path.length - 1]!;
      const occupied = occupiedUnitKeys(nextUnits, ignore, unit, ctx.teams);
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
        const replanned = planFor(planUnit, free.gx, free.gy, ctx, planOpts);
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
        const releaseAway = shouldReleaseAwayOnDeposit(target.id, next, {
          asTrainingDelivery: !!req.asTrainingDelivery,
        });
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

/** 主动解除互防（任一方发起即可清双边）. */
export function applyEndMutualDefense(
  ownerId: string,
  buildingId: string,
  buildingsIn: readonly PlacedBuilding[],
): MutualDefenseResult {
  const buildings = buildingsIn.map((b) => ({ ...b }));
  const ai = buildings.findIndex((b) => b.id === buildingId);
  if (ai < 0) {
    return { ok: false, error: "建筑不存在", organizationCost: 0, buildings };
  }
  const a = buildings[ai]!;
  if (a.ownerId !== ownerId) {
    return { ok: false, error: "只能解除己方建筑的互防", organizationCost: 0, buildings };
  }
  const partnerId = a.mutualDefensePartnerId;
  if (!partnerId) {
    return { ok: false, error: "该建筑未在互防中", organizationCost: 0, buildings };
  }
  clearMutualDefensePair(buildings, a.id, partnerId);
  return { ok: true, organizationCost: 0, buildings };
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
 * - 撤退：任何时候都可以（含交战、停泊）；不耗 O/E；不检电台与携行。
 *   陆军仍遵守地形（不得穿海）；海军/空军可忽略地形捷径。
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
          buildings,
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
    const landUnit = u.kind === "infantry" || u.kind === "armor";
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
      {
        ignoreCoverage: true,
        // Land must not cut across ocean; navy/air may still take a direct home path.
        ignoreTerrain: !landUnit,
        allowImpassableGoal: landUnit,
      },
    );
    let path = planned.path;
    if (planned.error || path.length === 0) {
      if (landUnit) {
        return {
          ok: false,
          error: planned.error ?? "无法撤退（无路可回所属建筑）",
        };
      }
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
    const occupied = occupiedUnitKeys(units, ignore, unit, ctx.teams);
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
  /** Planned polylines for each group that received a path (UI preview). */
  paths: Array<Array<{ gx: number; gy: number }>>;
} {
  // Always cap A* on UI dry-runs (unreachable water crossings must not freeze).
  const result = applyUnitMove(req, {
    ...ctx,
    previewPathfind: true,
    pathfindMaxExpand: ctx.pathfindMaxExpand ?? PATHFIND_MAX_EXPAND_PREVIEW,
  });
  const paths: Array<Array<{ gx: number; gy: number }>> = [];
  if (result.ok) {
    for (const u of result.units) {
      if (u.path && u.path.length >= 2) paths.push(u.path.map((p) => ({ ...p })));
    }
  }
  return {
    ok: result.ok,
    error: result.error,
    travelTimeSec: result.travelTimeSec,
    organizationCost: result.ok ? result.organizationCost : 0,
    energyCost: result.ok ? result.energyCost : 0,
    paths,
  };
}

/**
 * Dry-run training delivery path from a training ground to a target building.
 * Uses the same planner flags as server completion (`asTrainingDelivery`).
 */
export function previewTrainingDeliveryPath(
  ownerId: string,
  kind: UnitKind,
  fromGx: number,
  fromGy: number,
  toGx: number,
  toGy: number,
  depositBuildingId: string,
  ctx: MoveContext,
): { ok: boolean; error?: string; path: Array<{ gx: number; gy: number }> } {
  const tempId = "__train_preview__";
  const unit = createUnitGroup({
    id: tempId,
    ownerId,
    kind,
    u: 1,
    gx: fromGx,
    gy: fromGy,
    homeBuildingId: depositBuildingId,
  });
  const result = applyUnitMove(
    {
      ownerId,
      gx: toGx,
      gy: toGy,
      unitIds: [tempId],
      asTrainingDelivery: true,
      depositOnArrival: true,
      depositBuildingId,
    },
    {
      ...ctx,
      units: [...ctx.units, unit],
      previewPathfind: true,
      pathfindMaxExpand: ctx.pathfindMaxExpand ?? PATHFIND_MAX_EXPAND_PREVIEW,
    },
  );
  if (!result.ok) {
    return { ok: false, error: result.error, path: [] };
  }
  const moved = result.units.find((u) => u.id === tempId);
  if (moved?.path && moved.path.length >= 2) {
    return { ok: true, path: moved.path.map((p) => ({ ...p })) };
  }
  // Already at destination (immediate deposit) or path collapsed: show endpoints.
  const start = snapToUnitCoord(fromGx, fromGy);
  const end = snapToUnitCoord(toGx, toGy);
  if (unitCoordKey(start.gx, start.gy) === unitCoordKey(end.gx, end.gy)) {
    return { ok: true, path: [start] };
  }
  return { ok: true, path: [start, end] };
}

export function isAirKind(kind: UnitKind): boolean {
  return kind === "air";
}

/**
 * Merge a fielded ally unit into a teammate building's present U (approval path).
 * Removes the unit, adds U to the building, releases away on the unit's home.
 */
export function applyAllyGarrisonDeposit(
  fromPlayerId: string,
  buildingOwnerId: string,
  unitId: string,
  buildingId: string,
  buildingsIn: readonly PlacedBuilding[],
  unitsIn: readonly UnitGroup[],
  teams?: TeamRoster | null,
): {
  ok: boolean;
  error?: string;
  buildings: PlacedBuilding[];
  units: UnitGroup[];
} {
  const buildings = buildingsIn.map((b) => ({ ...b }));
  const units = unitsIn.map((u) => ({
    ...u,
    path: u.path?.map((p) => ({ ...p })),
  }));
  if (!sameTeam(teams, fromPlayerId, buildingOwnerId)) {
    return { ok: false, error: "仅可进驻友方建筑", buildings, units };
  }
  const ui = units.findIndex((u) => u.id === unitId);
  if (ui < 0) return { ok: false, error: "单位不存在", buildings, units };
  const unit = units[ui]!;
  if (unit.ownerId !== fromPlayerId) {
    return { ok: false, error: "单位不属于申请人", buildings, units };
  }
  if (unit.u < 1) return { ok: false, error: "单位没有编制", buildings, units };
  if (unit.state === "training") {
    return { ok: false, error: "训练送达中的单位不能进驻", buildings, units };
  }
  if (unit.retreating) {
    return { ok: false, error: RETREAT_LOCK, buildings, units };
  }
  const bi = buildings.findIndex((b) => b.id === buildingId);
  if (bi < 0) return { ok: false, error: "建筑不存在", buildings, units };
  const building = buildings[bi]!;
  if (building.ownerId !== buildingOwnerId) {
    return { ok: false, error: "建筑不属于审批方", buildings, units };
  }
  if (!isBuildingComplete(building) && building.buildingId !== "capital") {
    return { ok: false, error: "建筑尚未建成", buildings, units };
  }
  const kind = unitKindFromBuilding(building.buildingId);
  if (!kind || kind !== unit.kind) {
    return { ok: false, error: "兵种与目标建筑不匹配", buildings, units };
  }
  const room = garrisonRoom(building);
  if (unit.u > room) {
    return {
      ok: false,
      error: `空位不足（剩余 ${room} U，需要 ${unit.u} U）`,
      buildings,
      units,
    };
  }
  const deposited = returnToBuilding(building, unit.u, { releaseAway: false });
  if (deposited.deposited < unit.u) {
    return { ok: false, error: "空位不足", buildings, units };
  }
  buildings[bi] = deposited.building;
  const homeI = buildings.findIndex((b) => b.id === unit.homeBuildingId);
  if (homeI >= 0 && buildings[homeI]!.ownerId === fromPlayerId) {
    buildings[homeI] = releaseAwayOccupation(buildings[homeI]!, unit.u);
  }
  units.splice(ui, 1);
  return { ok: true, buildings, units };
}

export { isInsideAnyCircle };

export type { UnitMoveSource };
