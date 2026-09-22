/**
 * Unit-vs-unit fighting, siege/occupy, hold upkeep, mutual-defense response.
 * Blockade combat stays in blockade.ts — do not merge.
 */

import type { MapConfig } from "../map.js";
import type { TerrainMap } from "../terrain/types.js";
import type { PlacedBuilding } from "../buildings/actions.js";
import {
  applyBuildingHpDamage,
  buildingHpZeroShouldDestroy,
  isRepairing,
} from "../buildings/actions.js";
import type { PlacedLiaison } from "../buildings/liaison.js";
import {
  UNIT_COMBAT_ROUND_INTERVAL_SEC,
  UNIT_HOLD_INTERVAL_SEC,
  UNIT_HOLD_UPKEEP_E_PER_U,
  UNIT_OCCUPY_DEMOLISH_REFUND_RATE,
  UNIT_SIEGE_INTERVAL_SEC,
  unitKindFromBuilding,
} from "./catalog.js";
import {
  resolveCombatRound,
  siegeDamageFromBuilding,
  siegeDamageFromUnits,
} from "./combat.js";
import {
  deployFromBuilding,
  releaseAwayForUnitDiff,
  returnToBuilding,
  snapToUnitCoord,
  unitCoordKey,
} from "./garrison.js";
import { releaseEmbarkedAirForCarrierDiff } from "./carrier.js";
import { occupiedUnitKeys } from "./occupy.js";
import { findFreeUnitCoord, planAirPath, planLandOrNavyPath } from "./pathfind.js";
import { collectUnitActivityCoverage } from "./radio.js";
import type { UnitGroup } from "./types.js";

export interface FightTickResult {
  units: UnitGroup[];
  buildings: PlacedBuilding[];
  energyByOwner: Map<string, number>;
  removedIds: string[];
  destroyedIds: string[];
}

export interface FightMoveContext {
  map: MapConfig;
  terrain: TerrainMap | null;
  liaisons: readonly PlacedLiaison[];
  connectedByOwner: ReadonlyMap<string, ReadonlySet<string> | readonly string[]>;
  nextId: () => string;
}

function cloneUnits(units: readonly UnitGroup[]): UnitGroup[] {
  return units.map((u) => ({ ...u, path: u.path?.map((p) => ({ ...p })) }));
}

function cloneBuildings(buildings: readonly PlacedBuilding[]): PlacedBuilding[] {
  return buildings.map((b) => ({ ...b }));
}

export function isBuildingHeld(
  buildingId: string,
  units: readonly UnitGroup[],
): boolean {
  return units.some(
    (u) =>
      u.u > 0 &&
      (u.holdBuildingId === buildingId || u.pendingHoldBuildingId === buildingId),
  );
}

export function occupyDemolishRefund(building: PlacedBuilding): number {
  if (!building.capturePending || building.hp > 0) return 0;
  return Math.max(0, building.investedE) * UNIT_OCCUPY_DEMOLISH_REFUND_RATE;
}

function clearMutualPair(
  buildings: PlacedBuilding[],
  aId: string,
  bId?: string,
): void {
  for (const id of [aId, bId].filter(Boolean) as string[]) {
    const i = buildings.findIndex((b) => b.id === id);
    if (i < 0) continue;
    buildings[i] = { ...buildings[i]!, mutualDefensePartnerId: undefined };
  }
}

function clearSiegeState(u: UnitGroup): UnitGroup {
  return {
    ...u,
    state: "idle",
    siegeBuildingId: undefined,
    siegeTimerSec: undefined,
    siegeDamageDealt: undefined,
    siegeAirDamageDealt: undefined,
    fightTargetUnitId: undefined,
    combatTimerSec: undefined,
    pendingAttackBuildingId: undefined,
    pendingAttackUnitId: undefined,
  };
}

function applyUnitLoss(
  units: UnitGroup[],
  idx: number,
  nextU: number,
  removed: Set<string>,
): void {
  if (nextU <= 0) {
    removed.add(units[idx]!.id);
    units[idx] = { ...units[idx]!, u: 0 };
  } else {
    units[idx] = { ...units[idx]!, u: nextU };
  }
}

/** 目标已死或消失后，同一场交战里仍指向它的单位退出 fighting. */
function clearFightsWithGoneTargets(units: UnitGroup[], removed: Set<string>): void {
  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    if (removed.has(u.id) || u.u <= 0) continue;
    if (u.state !== "fighting") continue;
    if (u.siegeBuildingId) continue;
    if (u.liaisonCut && u.liaisonCut.elapsedSec >= 0) continue;
    const targetId = u.fightTargetUnitId;
    if (!targetId) continue;
    const target = units.find((x) => x.id === targetId);
    if (!target || removed.has(targetId) || target.u <= 0) {
      units[i] = {
        ...u,
        state: "idle",
        fightTargetUnitId: undefined,
        combatTimerSec: undefined,
      };
    }
  }
}

function planMoveTo(
  unit: UnitGroup,
  toGx: number,
  toGy: number,
  buildings: readonly PlacedBuilding[],
  ctx: FightMoveContext,
): Array<{ gx: number; gy: number }> | null {
  if (!ctx.terrain) return null;
  const coverage = collectUnitActivityCoverage(
    unit.kind === "air" ? "air" : "land",
    unit.ownerId,
    unit.homeBuildingId,
    buildings,
    ctx.connectedByOwner.get(unit.ownerId) ?? [],
  );
  if (unit.kind === "air") {
    const planned = planAirPath(unit.gx, unit.gy, toGx, toGy, coverage);
    return planned.error || planned.path.length === 0 ? null : planned.path;
  }
  const planned = planLandOrNavyPath({
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
  });
  return planned.error || planned.path.length === 0 ? null : planned.path;
}

/** Prefer a free cell next to the building node (守在外面). */
export function findHoldCoordOutside(
  bgx: number,
  bgy: number,
  occupied: ReadonlySet<string>,
): { gx: number; gy: number } {
  const center = snapToUnitCoord(bgx, bgy);
  const centerKey = unitCoordKey(center.gx, center.gy);
  const step = 0.2;
  for (let ring = 1; ring <= 10; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const p = snapToUnitCoord(center.gx + dx * step, center.gy + dy * step);
        const k = unitCoordKey(p.gx, p.gy);
        if (k === centerKey) continue;
        if (!occupied.has(k)) return p;
      }
    }
  }
  return findFreeUnitCoord(center.gx, center.gy, occupied);
}

/**
 * Hold upkeep every 5s: 1E per U. Cannot pay → leave holding.
 */
export function advanceHolds(
  unitsIn: readonly UnitGroup[],
  buildingsIn: readonly PlacedBuilding[],
  energyAvailable: ReadonlyMap<string, number>,
  dtSec: number,
): FightTickResult {
  const before = cloneUnits(unitsIn);
  const units = cloneUnits(unitsIn);
  const buildings = cloneBuildings(buildingsIn);
  const energyByOwner = new Map<string, number>();
  const remainingE = new Map(energyAvailable);
  const removed = new Set<string>();

  const holders = units
    .map((u, i) => ({ u, i }))
    .filter(({ u }) => u.state === "holding" && u.u > 0)
    .sort((a, b) => a.u.id.localeCompare(b.u.id));

  for (const { i } of holders) {
    if (removed.has(units[i]!.id)) continue;
    let timer = (units[i]!.holdTimerSec ?? 0) + dtSec;
    while (timer + 1e-9 >= UNIT_HOLD_INTERVAL_SEC) {
      timer -= UNIT_HOLD_INTERVAL_SEC;
      const uCount = units[i]!.u;
      if (uCount <= 0) break;
      const upkeep = UNIT_HOLD_UPKEEP_E_PER_U * uCount;
      const have = remainingE.get(units[i]!.ownerId) ?? 0;
      if (have < upkeep) {
        units[i] = {
          ...units[i]!,
          state: "idle",
          holdBuildingId: undefined,
          holdTimerSec: undefined,
          pendingHoldBuildingId: undefined,
        };
        timer = 0;
        break;
      }
      remainingE.set(units[i]!.ownerId, have - upkeep);
      energyByOwner.set(
        units[i]!.ownerId,
        (energyByOwner.get(units[i]!.ownerId) ?? 0) + upkeep,
      );
    }
    if (!removed.has(units[i]!.id) && units[i]!.state === "holding") {
      units[i] = { ...units[i]!, holdTimerSec: timer };
    }
  }

  const surviving = units.filter((u) => !removed.has(u.id) && u.u > 0);
  let nextBuildings = releaseAwayForUnitDiff(buildings, before, surviving);
  nextBuildings = releaseEmbarkedAirForCarrierDiff(nextBuildings, before, surviving);
  return {
    units: surviving,
    buildings: nextBuildings,
    energyByOwner,
    removedIds: [...removed],
    destroyedIds: [],
  };
}

function triggerMutualDefense(
  targetBuildingId: string,
  units: UnitGroup[],
  buildings: PlacedBuilding[],
  ctx: FightMoveContext,
): void {
  const bi = buildings.findIndex((b) => b.id === targetBuildingId);
  if (bi < 0) return;
  const target = buildings[bi]!;
  const partnerId = target.mutualDefensePartnerId;
  if (!partnerId) return;
  if (
    units.some(
      (u) => u.u > 0 && u.mutualDefenseForBuildingId === targetBuildingId,
    )
  ) {
    return;
  }
  const pi = buildings.findIndex((b) => b.id === partnerId);
  if (pi < 0) return;
  const partner = buildings[pi]!;
  if (partner.ownerId !== target.ownerId) {
    clearMutualPair(buildings, target.id, partnerId);
    return;
  }
  const present = partner.u ?? 0;
  if (present <= 0) return;
  if (!unitKindFromBuilding(partner.buildingId)) return;

  const deployed = deployFromBuilding(partner, present, ctx.nextId());
  if ("error" in deployed) return;
  buildings[pi] = deployed.building;
  let unit: UnitGroup = {
    ...deployed.unit,
    mutualDefenseForBuildingId: targetBuildingId,
    mutualDefenseHomeBuildingId: partner.id,
    pendingAttackBuildingId: targetBuildingId,
  };
  const dest = snapToUnitCoord(target.gx, target.gy);
  const free = findFreeUnitCoord(dest.gx, dest.gy, occupiedUnitKeys(units, new Set()));
  const path = planMoveTo(unit, free.gx, free.gy, buildings, ctx);
  if (!path || path.length === 0) {
    const back = returnToBuilding(buildings[pi]!, unit.u, { releaseAway: true });
    buildings[pi] = back.building;
    return;
  }
  if (path.length <= 1) {
    unit = {
      ...unit,
      gx: free.gx,
      gy: free.gy,
      state: "fighting",
      siegeBuildingId: targetBuildingId,
      pendingAttackBuildingId: undefined,
      siegeTimerSec: 0,
      path: undefined,
      pathIndex: undefined,
    };
  } else {
    unit = {
      ...unit,
      state: "moving",
      path,
      pathIndex: 1,
    };
  }
  units.push(unit);
}

function returnMutualResponders(
  buildingId: string,
  units: UnitGroup[],
  buildings: PlacedBuilding[],
  ctx: FightMoveContext,
  removed: Set<string>,
): void {
  const bi = buildings.findIndex((b) => b.id === buildingId);
  const partnerId = bi >= 0 ? buildings[bi]!.mutualDefensePartnerId : undefined;
  clearMutualPair(buildings, buildingId, partnerId);

  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    if (removed.has(u.id)) continue;
    if (u.mutualDefenseForBuildingId !== buildingId || u.u <= 0) continue;
    const homeId = u.mutualDefenseHomeBuildingId;
    const home = homeId ? buildings.find((b) => b.id === homeId) : undefined;
    if (!home) {
      units[i] = {
        ...u,
        state: "idle",
        mutualDefenseForBuildingId: undefined,
        mutualDefenseHomeBuildingId: undefined,
        siegeBuildingId: undefined,
        fightTargetUnitId: undefined,
        pendingAttackBuildingId: undefined,
        combatTimerSec: undefined,
        siegeTimerSec: undefined,
      };
      continue;
    }
    const path = planMoveTo(u, home.gx, home.gy, buildings, ctx);
    if (!path || path.length <= 1) {
      const result = returnToBuilding(home, u.u, { releaseAway: true });
      const hi = buildings.findIndex((b) => b.id === home.id);
      if (hi >= 0) buildings[hi] = result.building;
      if (result.leftover <= 0) removed.add(u.id);
      else {
        units[i] = {
          ...u,
          u: result.leftover,
          state: "idle",
          mutualDefenseForBuildingId: undefined,
          mutualDefenseHomeBuildingId: undefined,
          siegeBuildingId: undefined,
          depositOnArrival: undefined,
        };
      }
      continue;
    }
    units[i] = {
      ...u,
      state: "moving",
      path,
      pathIndex: 1,
      depositOnArrival: true,
      depositBuildingId: home.id,
      mutualDefenseForBuildingId: undefined,
      mutualDefenseHomeBuildingId: undefined,
      siegeBuildingId: undefined,
      fightTargetUnitId: undefined,
      pendingAttackBuildingId: undefined,
      combatTimerSec: undefined,
      siegeTimerSec: undefined,
    };
  }
}

/**
 * Advance unit-vs-unit fights and sieges (5s pulses; rounds resolve in-tick).
 */
export function advanceFightsAndSieges(
  unitsIn: readonly UnitGroup[],
  buildingsIn: readonly PlacedBuilding[],
  dtSec: number,
  ctx: FightMoveContext,
): FightTickResult {
  const before = cloneUnits(unitsIn);
  const units = cloneUnits(unitsIn);
  const buildings = cloneBuildings(buildingsIn);
  const removed = new Set<string>();
  const destroyed = new Set<string>();

  // --- Unit vs unit ---
  const foughtPairs = new Set<string>();
  const fighters = units
    .map((u, i) => ({ u, i }))
    .filter(
      ({ u }) =>
        u.state === "fighting" && !!u.fightTargetUnitId && !u.siegeBuildingId && u.u > 0,
    )
    .sort((a, b) => a.u.id.localeCompare(b.u.id));

  for (const { i } of fighters) {
    if (removed.has(units[i]!.id)) continue;
    const targetId = units[i]!.fightTargetUnitId!;
    const pairKey = [units[i]!.id, targetId].sort().join(":");
    if (foughtPairs.has(pairKey)) continue;

    const ti = units.findIndex((x) => x.id === targetId);
    if (ti < 0 || removed.has(targetId) || units[ti]!.u <= 0) {
      units[i] = {
        ...units[i]!,
        state: "idle",
        fightTargetUnitId: undefined,
        combatTimerSec: undefined,
      };
      continue;
    }
    if (units[ti]!.ownerId === units[i]!.ownerId) {
      units[i] = {
        ...units[i]!,
        state: "idle",
        fightTargetUnitId: undefined,
        combatTimerSec: undefined,
      };
      continue;
    }

    if (
      units[ti]!.state !== "fighting" ||
      units[ti]!.fightTargetUnitId !== units[i]!.id
    ) {
      units[ti] = {
        ...units[ti]!,
        state: "fighting",
        fightTargetUnitId: units[i]!.id,
        combatTimerSec: units[ti]!.combatTimerSec ?? 0,
        path: undefined,
        pathIndex: undefined,
      };
    }

    let timer =
      Math.max(units[i]!.combatTimerSec ?? 0, units[ti]!.combatTimerSec ?? 0) +
      dtSec;
    while (timer + 1e-9 >= UNIT_COMBAT_ROUND_INTERVAL_SEC) {
      timer -= UNIT_COMBAT_ROUND_INTERVAL_SEC;
      const a = units[i]!;
      const b = units[ti]!;
      if (a.u <= 0 || b.u <= 0) break;
      const round = resolveCombatRound(a.u, a.kind, b.u, b.kind);
      applyUnitLoss(units, i, round.ua1, removed);
      applyUnitLoss(units, ti, round.ub1, removed);
      if (round.ua1 <= 0 || round.ub1 <= 0) break;
    }
    foughtPairs.add(pairKey);

    if (!removed.has(units[i]!.id) && units[i]!.u > 0) {
      if (removed.has(targetId) || units[ti]!.u <= 0) {
        units[i] = {
          ...units[i]!,
          state: "idle",
          fightTargetUnitId: undefined,
          combatTimerSec: undefined,
        };
      } else {
        units[i] = { ...units[i]!, combatTimerSec: timer };
        if (!removed.has(units[ti]!.id)) {
          units[ti] = { ...units[ti]!, combatTimerSec: timer };
        }
      }
    } else if (!removed.has(units[ti]!.id) && units[ti]!.u > 0) {
      units[ti] = {
        ...units[ti]!,
        state: "idle",
        fightTargetUnitId: undefined,
        combatTimerSec: undefined,
      };
    }
  }

  clearFightsWithGoneTargets(units, removed);

  // --- Siege ---
  const siegeIds = [
    ...new Set(
      units
        .filter(
          (u) =>
            !removed.has(u.id) &&
            u.state === "fighting" &&
            !!u.siegeBuildingId &&
            u.u > 0,
        )
        .map((u) => u.siegeBuildingId!),
    ),
  ].sort();

  for (const buildingId of siegeIds) {
    if (destroyed.has(buildingId)) continue;
    const bi = buildings.findIndex((b) => b.id === buildingId);
    if (bi < 0) {
      for (let i = 0; i < units.length; i++) {
        if (units[i]!.siegeBuildingId === buildingId && !removed.has(units[i]!.id)) {
          units[i] = clearSiegeState(units[i]!);
        }
      }
      continue;
    }

    triggerMutualDefense(buildingId, units, buildings, ctx);

    const listAttackers = () =>
      units
        .map((u, i) => ({ u, i }))
        .filter(
          ({ u }) =>
            !removed.has(u.id) &&
            u.state === "fighting" &&
            u.siegeBuildingId === buildingId &&
            u.u > 0 &&
            u.ownerId !== buildings[bi]!.ownerId,
        )
        .sort((a, b) => a.u.id.localeCompare(b.u.id));

    if (listAttackers().length === 0) {
      returnMutualResponders(buildingId, units, buildings, ctx, removed);
      continue;
    }

    let timer =
      Math.max(0, ...listAttackers().map(({ i }) => units[i]!.siegeTimerSec ?? 0)) +
      dtSec;

    while (timer + 1e-9 >= UNIT_SIEGE_INTERVAL_SEC) {
      timer -= UNIT_SIEGE_INTERVAL_SEC;
      const atk = listAttackers();
      if (atk.length === 0) break;
      const building = buildings[bi]!;

      const guards = units
        .map((u, i) => ({ u, i }))
        .filter(
          ({ u }) =>
            !removed.has(u.id) &&
            u.u > 0 &&
            u.ownerId === building.ownerId &&
            (u.holdBuildingId === buildingId ||
              u.mutualDefenseForBuildingId === buildingId),
        )
        .sort((a, b) => a.u.id.localeCompare(b.u.id));

      if (guards.length > 0) {
        for (const { i: ai } of atk) {
          if (removed.has(units[ai]!.id) || units[ai]!.u <= 0) continue;
          for (const { i: gi } of guards) {
            if (removed.has(units[gi]!.id) || units[gi]!.u <= 0) continue;
            const round = resolveCombatRound(
              units[ai]!.u,
              units[ai]!.kind,
              units[gi]!.u,
              units[gi]!.kind,
            );
            applyUnitLoss(units, ai, round.ua1, removed);
            applyUnitLoss(units, gi, round.ub1, removed);
            if (units[ai]!.u <= 0) break;
          }
        }
        continue;
      }

      const garrisonU = buildings[bi]!.u ?? 0;
      if (garrisonU > 0) {
        const gKind = unitKindFromBuilding(buildings[bi]!.buildingId) ?? "infantry";
        let remainingG = garrisonU;
        for (const { i: ai } of atk) {
          if (removed.has(units[ai]!.id) || units[ai]!.u <= 0 || remainingG <= 0) {
            continue;
          }
          const round = resolveCombatRound(
            units[ai]!.u,
            units[ai]!.kind,
            remainingG,
            gKind,
          );
          applyUnitLoss(units, ai, round.ua1, removed);
          remainingG = round.ub1;
        }
        buildings[bi] = { ...buildings[bi]!, u: remainingG };
        continue;
      }

      const live = atk.filter(({ i }) => !removed.has(units[i]!.id) && units[i]!.u > 0);
      if (live.length === 0) break;

      const weights = live.map(({ i }) => ({
        i,
        u: units[i]!.u,
        kind: units[i]!.kind,
      }));
      const totalU = weights.reduce((s, w) => s + w.u, 0);
      const dmgToBuilding = siegeDamageFromUnits(totalU);
      const dmgToUnits = siegeDamageFromBuilding(totalU);

      let leftRet = dmgToUnits;
      for (let k = 0; k < weights.length; k++) {
        const w = weights[k]!;
        const share =
          k === weights.length - 1
            ? leftRet
            : Math.floor((dmgToUnits * w.u) / totalU);
        leftRet -= share;
        if (!removed.has(units[w.i]!.id)) {
          applyUnitLoss(units, w.i, units[w.i]!.u - share, removed);
        }
      }

      let leftDmg = dmgToBuilding;
      let totalDealt = 0;
      let airDealt = 0;
      for (let k = 0; k < weights.length; k++) {
        const w = weights[k]!;
        const share =
          k === weights.length - 1
            ? leftDmg
            : Math.floor((dmgToBuilding * w.u) / totalU);
        leftDmg -= share;
        totalDealt += share;
        if (w.kind === "air") airDealt += share;
        if (!removed.has(units[w.i]!.id)) {
          const cur = units[w.i]!;
          units[w.i] = {
            ...cur,
            siegeDamageDealt: (cur.siegeDamageDealt ?? 0) + share,
            siegeAirDamageDealt:
              (cur.siegeAirDamageDealt ?? 0) + (w.kind === "air" ? share : 0),
          };
        }
      }

      const b = buildings[bi]!;
      const wasConstructing = b.buildTicksRemaining > 0;
      const wasRepairing = isRepairing(b);
      const damaged = applyBuildingHpDamage(b, totalDealt);
      const hpAfter = damaged.hp;
      buildings[bi] = damaged;

      if (hpAfter > 0) continue;

      const survivors = weights.map((w) => units[w.i]!);
      const sumDealt = survivors.reduce((s, u) => s + (u.siegeDamageDealt ?? 0), 0);
      const sumAir = survivors.reduce((s, u) => s + (u.siegeAirDamageDealt ?? 0), 0);
      const airRatio =
        sumDealt > 0 ? sumAir / sumDealt : airDealt / Math.max(1, totalDealt);
      const capturer = live[0]!.u.ownerId;
      const forceDestroy =
        airRatio > 0.5 ||
        buildingHpZeroShouldDestroy(wasConstructing, wasRepairing);

      if (forceDestroy) {
        destroyed.add(buildingId);
        clearMutualPair(buildings, buildingId, b.mutualDefensePartnerId);
        for (let i = 0; i < units.length; i++) {
          if (units[i]!.siegeBuildingId === buildingId && !removed.has(units[i]!.id)) {
            units[i] = clearSiegeState(units[i]!);
          }
        }
        returnMutualResponders(buildingId, units, buildings, ctx, removed);
      } else {
        clearMutualPair(buildings, buildingId, b.mutualDefensePartnerId);
        buildings[bi] = {
          ...buildings[bi]!,
          ownerId: capturer,
          hp: 0,
          u: 0,
          awayOccupiedU: undefined,
          capturePending: true,
          mutualDefensePartnerId: undefined,
          trainingQueue: undefined,
        };
        for (let i = 0; i < units.length; i++) {
          if (units[i]!.siegeBuildingId === buildingId && !removed.has(units[i]!.id)) {
            units[i] = clearSiegeState(units[i]!);
          }
        }
        returnMutualResponders(buildingId, units, buildings, ctx, removed);
      }
      timer = 0;
      break;
    }

    if (!destroyed.has(buildingId) && (buildings[bi]?.hp ?? 0) > 0) {
      const still = listAttackers();
      for (const { i } of still) {
        if (!removed.has(units[i]!.id)) {
          units[i] = { ...units[i]!, siegeTimerSec: timer };
        }
      }
      if (still.length === 0) {
        returnMutualResponders(buildingId, units, buildings, ctx, removed);
      }
    }
  }

  clearFightsWithGoneTargets(units, removed);

  const keptBuildings = buildings.filter((b) => !destroyed.has(b.id));
  const surviving = units.filter((u) => !removed.has(u.id) && u.u > 0);
  let nextBuildings = releaseAwayForUnitDiff(keptBuildings, before, surviving);
  nextBuildings = releaseEmbarkedAirForCarrierDiff(nextBuildings, before, surviving);
  return {
    units: surviving,
    buildings: nextBuildings,
    energyByOwner: new Map(),
    removedIds: [...removed],
    destroyedIds: [...destroyed],
  };
}
