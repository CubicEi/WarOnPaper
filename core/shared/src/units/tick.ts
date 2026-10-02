import type { TerrainMap } from "../terrain/types.js";
import type { PlacedBuilding } from "../buildings/actions.js";
import type { PlacedLiaison } from "../buildings/liaison.js";
import { UNIT_BY_KIND } from "./catalog.js";
import type { UnitGroup } from "./types.js";
import { speedAt, terrainAllowsKind, findFreeUnitCoord, planAirPath } from "./pathfind.js";
import {
  unitCoordKey,
  snapToUnitCoord,
  returnToBuilding,
  releaseAwayForUnitDiff,
  shouldReleaseAwayOnDeposit,
} from "./garrison.js";
import { buildingCenterKeys, occupiedUnitKeys } from "./occupy.js";
import { collectMovingUnitCoverage, isInsideAnyCircle } from "./radio.js";
import {
  consumeCarriedForStep,
  findSupplyStationAt,
  resupplyUnitFromStation,
  usesCarriedSupply,
} from "./supply.js";
import { autoEmbarkCoLocatedAir } from "./carrier.js";
import { applyAirHitAndRunStrike } from "./fight.js";

const EPS = 1e-6;

export interface TickMoveResult {
  units: UnitGroup[];
  buildings: PlacedBuilding[];
  /** Groups removed after depositing into a building. */
  removedIds: string[];
}

/**
 * Advance moving units by `dtSec`.
 * Stops at radio/airport coverage edge (training delivery `state === "training"` is exempt).
 * Land/navy spend carriedE by distance (`distance / duPerE` per U fill); air does not.
 * E exhausted → stop in place (pending blockade/supply cleared).
 * Air with returnGx/returnGy flies straight home after finishing the outbound path.
 */
export function advanceUnits(
  unitsIn: readonly UnitGroup[],
  buildingsIn: readonly PlacedBuilding[],
  liaisons: readonly PlacedLiaison[],
  terrain: TerrainMap | null,
  connectedByOwner: ReadonlyMap<string, ReadonlySet<string> | readonly string[]>,
  dtSec: number,
): TickMoveResult {
  const buildings = buildingsIn.map((b) => ({ ...b }));
  const units = unitsIn.map((u) => ({ ...u, path: u.path?.map((p) => ({ ...p })) }));
  const removed = new Set<string>();
  const settleReserved = new Set<string>();
  /** U deposited via returnToBuilding this tick — exclude from away-release-on-loss. */
  const depositedU = new Map<string, number>();

  const settle = (
    unit: UnitGroup,
    arrived: boolean,
  ) =>
    settleIdle(
      unit,
      buildings,
      removed,
      { arrived },
      units,
      settleReserved,
      terrain,
      liaisons,
      depositedU,
    );

  for (const unit of units) {
    if (
      unit.kind === "air" &&
      unit.state === "idle" &&
      !unit.retreating &&
      unit.returnGx != null &&
      unit.returnGy != null
    ) {
      tryStartAirReturn(unit, buildings, removed, units, settleReserved, depositedU);
      continue;
    }
    if (unit.state !== "moving" && unit.state !== "training") continue;
    const path = unit.path;
    let idx = unit.pathIndex ?? 1;
    if (!path || path.length < 2 || idx >= path.length) {
      // Pending attack must settle into fighting before any air auto-return.
      // Otherwise returnGx steals the arrival and the fight starts at the airport.
      const pendingAttack =
        !!unit.pendingAttackUnitId || !!unit.pendingAttackBuildingId;
      if (
        !unit.depositOnArrival &&
        !pendingAttack &&
        tryStartAirReturn(unit, buildings, removed, units, settleReserved, depositedU)
      ) {
        continue;
      }
      settle(unit, true);
      continue;
    }

    // Training delivery / retreat-to-home may leave radio and port range freely.
    const ignoreCoverage = unit.state === "training" || !!unit.depositOnArrival;
    const coverage = ignoreCoverage
      ? []
      : collectMovingUnitCoverage(
          unit,
          buildings,
          connectedByOwner.get(unit.ownerId) ?? [],
        );
    // Retreat / training deposit does not consume carried E en route.
    const skipFuel = !!unit.depositOnArrival || unit.state === "training";

    let budget = dtSec;
    while (budget > EPS && idx < path.length) {
      const target = path[idx]!;
      const dx = target.gx - unit.gx;
      const dy = target.gy - unit.gy;
      const dist = Math.hypot(dx, dy);
      if (dist <= EPS) {
        unit.gx = target.gx;
        unit.gy = target.gy;
        idx += 1;
        continue;
      }

      if (!skipFuel && usesCarriedSupply(unit.kind) && unit.carriedE <= EPS) {
        stopForSupply(unit, buildings, removed, units, settleReserved, terrain, liaisons, depositedU);
        budget = 0;
        break;
      }

      const spd = speedAt(unit.kind, terrain, target.gx, target.gy, liaisons, unit.ownerId);
      let step = Math.min(dist, spd * budget);

      // Cap step by remaining carried E before moving (air / deposit: no cap).
      if (!skipFuel) {
        const fuel = consumeCarriedForStep(unit.kind, unit.carriedE, step);
        step = fuel.stepDu;
        if (step <= EPS) {
          stopForSupply(unit, buildings, removed, units, settleReserved, terrain, liaisons, depositedU);
          budget = 0;
          break;
        }
      }

      let nx = unit.gx + (dx / dist) * step;
      let ny = unit.gy + (dy / dist) * step;
      let stoppedEarly = false;

      if (coverage.length > 0 && !isInsideAnyCircle(nx, ny, coverage)) {
        let lo = 0;
        let hi = 1;
        let bx = unit.gx;
        let by = unit.gy;
        for (let k = 0; k < 16; k++) {
          const mid = (lo + hi) / 2;
          const x = unit.gx + (nx - unit.gx) * mid;
          const y = unit.gy + (ny - unit.gy) * mid;
          if (isInsideAnyCircle(x, y, coverage)) {
            bx = x;
            by = y;
            lo = mid;
          } else {
            hi = mid;
          }
        }
        nx = bx;
        ny = by;
        step = Math.hypot(nx - unit.gx, ny - unit.gy);
        stoppedEarly = true;
      }

      // Charge only the distance actually traveled this iteration (unless deposit/retreat).
      let exhausted = false;
      if (!skipFuel) {
        const charged = consumeCarriedForStep(unit.kind, unit.carriedE, step);
        unit.carriedE = charged.carriedE;
        step = charged.stepDu;
        exhausted = charged.exhausted;
        if (step <= EPS) {
          stopForSupply(unit, buildings, removed, units, settleReserved, terrain, liaisons, depositedU);
          budget = 0;
          break;
        }
        // If fuel capped mid-intent after coverage trim, rescale endpoint.
        const intended = Math.hypot(nx - unit.gx, ny - unit.gy);
        if (intended > EPS && Math.abs(intended - step) > EPS) {
          nx = unit.gx + ((nx - unit.gx) / intended) * step;
          ny = unit.gy + ((ny - unit.gy) / intended) * step;
          stoppedEarly = true;
        }
      }

      unit.gx = nx;
      unit.gy = ny;
      budget -= step / Math.max(EPS, spd);

      if (Math.hypot(target.gx - unit.gx, target.gy - unit.gy) <= EPS) {
        unit.gx = target.gx;
        unit.gy = target.gy;
        idx += 1;
      }

      // Coverage edge or fuel empty mid-route: stop (final waypoint still counts as arrived).
      if (stoppedEarly || (exhausted && idx < path.length)) {
        const snapped = snapToUnitCoord(unit.gx, unit.gy);
        unit.gx = snapped.gx;
        unit.gy = snapped.gy;
        if (exhausted && usesCarriedSupply(unit.kind)) {
          stopForSupply(unit, buildings, removed, units, settleReserved, terrain, liaisons, depositedU);
        } else {
          settle(unit, false);
        }
        budget = 0;
        break;
      }
    }

    if (removed.has(unit.id)) continue;
    if (unit.state !== "moving" && unit.state !== "training") continue;

    if (idx >= path.length) {
      const pendingAttack =
        !!unit.pendingAttackUnitId || !!unit.pendingAttackBuildingId;
      if (
        !unit.depositOnArrival &&
        !pendingAttack &&
        tryStartAirReturn(unit, buildings, removed, units, settleReserved, depositedU)
      ) {
        continue;
      }
      settle(unit, true);
    } else {
      unit.pathIndex = idx;
    }
  }

  yieldOffBuildingCenters(units, buildings, terrain, liaisons, removed, settleReserved);

  const surviving = units.filter((u) => !removed.has(u.id) && u.u > 0);
  // Release awayOccupiedU for combat losses / deaths during movement (air strike).
  // Skip U already入库 this tick — those are not losses (and training never occupied away).
  const afterAway = releaseAwayForUnitDiff(buildings, unitsIn, surviving, depositedU);

  return {
    units: autoEmbarkCoLocatedAir(surviving),
    buildings: afterAway,
    removedIds: [...removed],
  };
}

function stopForSupply(
  unit: UnitGroup,
  buildings: PlacedBuilding[],
  removed: Set<string>,
  allUnits: readonly UnitGroup[],
  reserved: Set<string>,
  terrain: TerrainMap | null,
  liaisons: readonly PlacedLiaison[],
  depositedU?: Map<string, number>,
): void {
  const snapped = snapToUnitCoord(unit.gx, unit.gy);
  unit.gx = snapped.gx;
  unit.gy = snapped.gy;
  if (usesCarriedSupply(unit.kind)) {
    unit.carriedE = Math.max(0, unit.carriedE);
    if (unit.carriedE <= EPS) unit.carriedE = 0;
  }
  settleIdle(
    unit,
    buildings,
    removed,
    { arrived: false },
    allUnits,
    reserved,
    terrain,
    liaisons,
    depositedU,
  );
}

function settleIdle(
  unit: UnitGroup,
  buildings: PlacedBuilding[],
  removed: Set<string>,
  opts: { arrived: boolean },
  allUnits: readonly UnitGroup[],
  reserved: Set<string>,
  terrain: TerrainMap | null,
  liaisons: readonly PlacedLiaison[],
  depositedU?: Map<string, number>,
): void {
  const enterBlockade = opts.arrived && !!unit.pendingBlockade;
  const enterHold = opts.arrived && !!unit.pendingHoldBuildingId;
  const holdBuildingId = unit.pendingHoldBuildingId;
  const attackUnitId = unit.pendingAttackUnitId;
  const attackBuildingId = unit.pendingAttackBuildingId;
  const enterAttack = opts.arrived && !!(attackUnitId || attackBuildingId);
  const doSupply = opts.arrived && !!unit.pendingSupply;
  const supplyBuildingId = unit.supplyBuildingId;
  // Capture before state→idle: training delivery must not release awayOccupiedU.
  const fromTrainingDelivery = unit.state === "training";
  unit.path = undefined;
  unit.pathIndex = undefined;
  unit.pendingBlockade = undefined;
  unit.pendingSupply = undefined;
  unit.supplyBuildingId = undefined;
  unit.pendingHoldBuildingId = undefined;
  unit.pendingAttackUnitId = undefined;
  unit.pendingAttackBuildingId = undefined;

  if (enterBlockade) {
    nudgeOffBuildingCenters(unit, buildings, allUnits, removed, reserved, terrain, liaisons);
    unit.state = "blockading";
    unit.blockadeTimerSec = 0;
    unit.depositOnArrival = undefined;
    unit.depositBuildingId = undefined;
    return;
  }

  if (enterHold && holdBuildingId) {
    nudgeOffBuildingCenters(unit, buildings, allUnits, removed, reserved, terrain, liaisons);
    unit.state = "holding";
    unit.holdBuildingId = holdBuildingId;
    unit.holdTimerSec = 0;
    unit.depositOnArrival = undefined;
    unit.depositBuildingId = undefined;
    return;
  }

  if (enterAttack) {
    // Air: one-round strike then immediate return — never linger as fighting/siege.
    if (unit.kind === "air") {
      const liveUnits = allUnits as UnitGroup[];
      applyAirHitAndRunStrike(
        unit,
        attackUnitId,
        attackBuildingId,
        liveUnits,
        buildings,
        removed,
      );
      if (removed.has(unit.id)) return;
      if (!tryStartAirReturn(unit, buildings, removed, liveUnits, reserved, depositedU)) {
        nudgeOffBuildingCenters(unit, buildings, allUnits, removed, reserved, terrain, liaisons);
      }
      return;
    }
    nudgeOffBuildingCenters(unit, buildings, allUnits, removed, reserved, terrain, liaisons);
    if (attackUnitId) {
      unit.state = "fighting";
      unit.fightTargetUnitId = attackUnitId;
      unit.combatTimerSec = 0;
      unit.siegeBuildingId = undefined;
    } else if (attackBuildingId) {
      unit.state = "fighting";
      unit.siegeBuildingId = attackBuildingId;
      unit.siegeTimerSec = 0;
      unit.siegeDamageDealt = 0;
      unit.siegeAirDamageDealt = 0;
      unit.fightTargetUnitId = undefined;
    }
    unit.depositOnArrival = undefined;
    unit.depositBuildingId = undefined;
    return;
  }

  unit.state = "idle";
  unit.blockadeTimerSec = undefined;

  if (doSupply) {
    // Supply allows adjacent cells; nudge first so anti-stack does not block the station node.
    nudgeOffBuildingCenters(unit, buildings, allUnits, removed, reserved, terrain, liaisons);
    unit.depositOnArrival = undefined;
    unit.depositBuildingId = undefined;
    const station = findSupplyStationAt(
      buildings,
      unit.ownerId,
      unit.gx,
      unit.gy,
      supplyBuildingId,
    );
    if (station) {
      const result = resupplyUnitFromStation(unit, station);
      if (result.ok) {
        unit.carriedE = result.unit.carriedE;
        const bi = buildings.findIndex((b) => b.id === station.id);
        if (bi >= 0) buildings[bi] = result.building;
      }
    }
    return;
  }

  // Deposit BEFORE nudging off building centers. Pushing first broke position-based
  //入库 (and home fallback) for air return / retreat when depositBuildingId was missing.
  if (unit.depositOnArrival) {
    const byId = unit.depositBuildingId
      ? buildings.find(
          (b) => b.id === unit.depositBuildingId && b.ownerId === unit.ownerId,
        )
      : undefined;
    const dest = buildings.find(
      (b) =>
        b.ownerId === unit.ownerId &&
        unitCoordKey(b.gx, b.gy) === unitCoordKey(unit.gx, unit.gy),
    );
    const home = buildings.find(
      (b) => b.id === unit.homeBuildingId && b.ownerId === unit.ownerId,
    );
    const target =
      byId ??
      dest ??
      (home &&
      (unit.retreating ||
        unit.kind === "air" ||
        unit.depositBuildingId === home.id ||
        !unit.depositBuildingId)
        ? home
        : undefined);
    if (target) {
      const releaseAway = shouldReleaseAwayOnDeposit(target.id, unit, {
        asTrainingDelivery: fromTrainingDelivery,
      });
      const result = returnToBuilding(target, unit.u, { releaseAway });
      const bi = buildings.findIndex((b) => b.id === target.id);
      if (bi >= 0) buildings[bi] = result.building;
      if (result.deposited > 0 && depositedU) {
        depositedU.set(
          unit.id,
          (depositedU.get(unit.id) ?? 0) + result.deposited,
        );
      }
      if (result.leftover <= 0) {
        reserved.delete(unitCoordKey(unit.gx, unit.gy));
        removed.add(unit.id);
        unit.depositOnArrival = undefined;
        unit.depositBuildingId = undefined;
        unit.retreating = undefined;
        return;
      }
      unit.u = result.leftover;
    }
  }
  unit.depositOnArrival = undefined;
  unit.depositBuildingId = undefined;
  unit.retreating = undefined;

  nudgeOffBuildingCenters(unit, buildings, allUnits, removed, reserved, terrain, liaisons);
}

/** Anti-stack: leave building centers free (navy may remain docked on a port). */
function nudgeOffBuildingCenters(
  unit: UnitGroup,
  buildings: readonly PlacedBuilding[],
  allUnits: readonly UnitGroup[],
  removed: ReadonlySet<string>,
  reserved: Set<string>,
  terrain: TerrainMap | null,
  liaisons: readonly PlacedLiaison[],
): void {
  const ignore = new Set<string>([unit.id, ...removed]);
  const occupied = occupiedUnitKeys(allUnits, ignore, unit);
  for (const k of reserved) occupied.add(k);
  const onPort =
    (unit.kind === "navy" || unit.kind === "navy_carrier") &&
    buildings.some(
      (b) =>
        b.buildingId === "port" &&
        unitCoordKey(b.gx, b.gy) === unitCoordKey(unit.gx, unit.gy),
    );
  for (const k of buildingCenterKeys(buildings)) {
    if (onPort && k === unitCoordKey(unit.gx, unit.gy)) continue;
    occupied.add(k);
  }
  const free = findFreeUnitCoord(unit.gx, unit.gy, occupied, 2, (x, y) => {
    if (unit.kind === "air" || !terrain) return true;
    if (
      (unit.kind === "navy" || unit.kind === "navy_carrier") &&
      buildings.some(
        (b) => b.buildingId === "port" && unitCoordKey(b.gx, b.gy) === unitCoordKey(x, y),
      )
    ) {
      return true;
    }
    return terrainAllowsKind(unit.kind, terrain, x, y, {
      liaisons,
      ownerId: unit.ownerId,
    });
  });
  unit.gx = free.gx;
  unit.gy = free.gy;
  reserved.add(unitCoordKey(free.gx, free.gy));
}

function tryStartAirReturn(
  unit: UnitGroup,
  buildings: PlacedBuilding[],
  removed: Set<string>,
  allUnits: readonly UnitGroup[],
  reserved: Set<string>,
  depositedU?: Map<string, number>,
): boolean {
  if (unit.kind !== "air" || unit.retreating) return false;
  if (unit.returnGx == null || unit.returnGy == null) return false;
  if (unit.depositOnArrival) return false;
  // Do not abort an inbound attack: pending fight must start at the target first.
  if (unit.pendingAttackUnitId || unit.pendingAttackBuildingId) return false;
  if (unit.state === "fighting") return false;
  const home = buildings.find(
    (b) => b.id === unit.homeBuildingId && b.ownerId === unit.ownerId,
  );
  const gx = home?.gx ?? unit.returnGx;
  const gy = home?.gy ?? unit.returnGy;
  unit.returnGx = undefined;
  unit.returnGy = undefined;
  unit.depositOnArrival = true;
  // Prefer live home id; fall back to homeBuildingId so settleIdle can still resolve by id.
  unit.depositBuildingId = home?.id ?? unit.homeBuildingId;
  const end = snapToUnitCoord(gx, gy);
  if (unitCoordKey(unit.gx, unit.gy) === unitCoordKey(end.gx, end.gy)) {
    settleIdle(
      unit,
      buildings,
      removed,
      { arrived: true },
      allUnits,
      reserved,
      null,
      [],
      depositedU,
    );
    return true;
  }
  const back = planAirPath(unit.gx, unit.gy, end.gx, end.gy, [], { ignoreCoverage: true });
  const start = snapToUnitCoord(unit.gx, unit.gy);
  unit.path = !back.error && back.path.length > 1 ? back.path : [start, end];
  unit.pathIndex = 1;
  unit.state = "moving";
  return true;
}

function yieldOffBuildingCenters(
  units: UnitGroup[],
  buildings: readonly PlacedBuilding[],
  terrain: TerrainMap | null,
  liaisons: readonly PlacedLiaison[],
  removed: ReadonlySet<string>,
  reserved: Set<string>,
): void {
  const centers = buildingCenterKeys(buildings);
  for (const unit of units) {
    if (removed.has(unit.id) || unit.u <= 0) continue;
    if (unit.state === "moving" || unit.state === "training") continue;
    if (unit.depositOnArrival) continue;
    const key = unitCoordKey(unit.gx, unit.gy);
    if (!centers.has(key)) continue;
    // Navy may remain docked on a port building cell (coastline, not pure ocean).
    const dockedAtPort =
      (unit.kind === "navy" || unit.kind === "navy_carrier") &&
      buildings.some(
        (b) => b.buildingId === "port" && unitCoordKey(b.gx, b.gy) === key,
      );
    if (dockedAtPort) continue;
    const occupied = occupiedUnitKeys(units, new Set([unit.id, ...removed]), unit);
    for (const k of centers) occupied.add(k);
    for (const k of reserved) occupied.add(k);
    const free = findFreeUnitCoord(unit.gx, unit.gy, occupied, 2, (x, y) => {
      if (unit.kind === "air" || !terrain) return true;
      return terrainAllowsKind(unit.kind, terrain, x, y, {
        liaisons,
        ownerId: unit.ownerId,
      });
    });
    const nextKey = unitCoordKey(free.gx, free.gy);
    if (nextKey === key) continue;
    unit.gx = free.gx;
    unit.gy = free.gy;
    reserved.add(nextKey);
  }
}

/** Exported for tests / preview: Du per 1E for kind. */
export function duPerEOf(kind: UnitGroup["kind"]): number | null {
  return UNIT_BY_KIND[kind].duPerE;
}
