import {
  UNIT_BLOCKADE_INTERVAL_SEC,
  UNIT_BLOCKADE_RADIUS,
  UNIT_BLOCKADE_UPKEEP_E_PER_U,
} from "./catalog.js";
import { visionDistDu } from "../vision/vision.js";
import { releaseEmbarkedAirForCarrierDiff } from "./carrier.js";
import { resolveCombatRound } from "./combat.js";
import { releaseAwayForUnitDiff } from "./garrison.js";
import type { UnitGroup } from "./types.js";
import type { PlacedBuilding } from "../buildings/actions.js";
import { isFriendly, type TeamRoster } from "../teams.js";

export interface BlockadeTickResult {
  units: UnitGroup[];
  buildings: PlacedBuilding[];
  /** Energy to deduct per owner this tick (upkeep only). */
  energyByOwner: Map<string, number>;
  /** Unit ids removed (U ≤ 0 after combat). */
  removedIds: string[];
}

/**
 * Advance blockading units: every 5s charge 2E/U and resolve one combat round
 * against every enemy group within R=2.
 *
 * Upkeep is attempted first; if the owner cannot pay for a group, that group
 * leaves blockading (idle) without fighting that pulse.
 *
 * Combat rounds are resolved immediately (within the same tick; well under 2 ticks).
 * Combat losses release awayOccupiedU on home buildings.
 */
export function advanceBlockades(
  unitsIn: readonly UnitGroup[],
  buildingsIn: readonly PlacedBuilding[],
  energyAvailable: ReadonlyMap<string, number>,
  dtSec: number,
  teams?: TeamRoster | null,
): BlockadeTickResult {
  const before = unitsIn.map((u) => ({ ...u, path: u.path?.map((p) => ({ ...p })) }));
  const units = before.map((u) => ({ ...u, path: u.path?.map((p) => ({ ...p })) }));
  const energyByOwner = new Map<string, number>();
  const remainingE = new Map<string, number>(energyAvailable);
  const removed = new Set<string>();

  // Process blockaders in stable id order so multi-owner interactions are deterministic.
  const blockaderIndices = units
    .map((u, i) => ({ u, i }))
    .filter(({ u }) => u.state === "blockading" && u.u > 0)
    .sort((a, b) => a.u.id.localeCompare(b.u.id));

  for (const { u: blocker, i: bi } of blockaderIndices) {
    if (removed.has(blocker.id)) continue;
    if (units[bi]!.state !== "blockading") continue;

    let timer = (units[bi]!.blockadeTimerSec ?? 0) + dtSec;
    while (timer + 1e-9 >= UNIT_BLOCKADE_INTERVAL_SEC) {
      timer -= UNIT_BLOCKADE_INTERVAL_SEC;

      const uCount = units[bi]!.u;
      if (uCount <= 0) break;

      const upkeep = UNIT_BLOCKADE_UPKEEP_E_PER_U * uCount;
      const have = remainingE.get(blocker.ownerId) ?? 0;
      if (have < upkeep) {
        // Cannot sustain: leave blockade (主动结束/资源不足视同停止).
        units[bi] = {
          ...units[bi]!,
          state: "idle",
          blockadeTimerSec: undefined,
          pendingBlockade: undefined,
        };
        timer = 0;
        break;
      }

      remainingE.set(blocker.ownerId, have - upkeep);
      energyByOwner.set(
        blocker.ownerId,
        (energyByOwner.get(blocker.ownerId) ?? 0) + upkeep,
      );

      // One combat round vs every enemy within R=2 (sequential, stable by id).
      const enemies = units
        .map((e, ei) => ({ e, ei }))
        .filter(
          ({ e }) =>
            !removed.has(e.id) &&
            e.id !== blocker.id &&
            !isFriendly(teams, e.ownerId, blocker.ownerId) &&
            e.u > 0 &&
            visionDistDu(units[bi]!.gx, units[bi]!.gy, e.gx, e.gy) <=
              UNIT_BLOCKADE_RADIUS + 1e-9,
        )
        .sort((a, b) => a.e.id.localeCompare(b.e.id));

      for (const { e, ei } of enemies) {
        const a = units[bi]!;
        const b = units[ei]!;
        if (a.u <= 0 || b.u <= 0) continue;
        const round = resolveCombatRound(a.u, a.kind, b.u, b.kind, a.hullHp, b.hullHp);
        units[bi] = {
          ...a,
          u: round.ua1,
          ...(round.hullHpA != null ? { hullHp: round.hullHpA } : {}),
        };
        units[ei] = {
          ...b,
          u: round.ub1,
          ...(round.hullHpB != null ? { hullHp: round.hullHpB } : {}),
        };
        if (round.ub1 <= 0) removed.add(b.id);
        if (round.ua1 <= 0) {
          removed.add(a.id);
          break;
        }
      }

      if (removed.has(blocker.id)) {
        timer = 0;
        break;
      }
    }

    if (!removed.has(blocker.id) && units[bi]!.state === "blockading") {
      units[bi] = { ...units[bi]!, blockadeTimerSec: timer };
    }
  }

  const surviving = units.filter((u) => !removed.has(u.id) && u.u > 0);
  let buildings = releaseAwayForUnitDiff(buildingsIn, before, surviving);
  buildings = releaseEmbarkedAirForCarrierDiff(buildings, before, surviving);

  return {
    units: surviving,
    buildings,
    energyByOwner,
    removedIds: [...removed],
  };
}
