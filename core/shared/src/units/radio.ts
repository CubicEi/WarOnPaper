/**
 * Radio / airport activity range for units (§4.8).
 * Land/navy: union of connected 电台 work ranges (含可共享雷达).
 * Air: 所属机场工作范围（含关联雷达）.
 */

import type { PlacedBuilding } from "../buildings/actions.js";
import { isBuildingComplete } from "../buildings/actions.js";
import {
  workRangeCircles,
  isInsideWorkRange,
  type WorkRangeCircle,
} from "../buildings/workRange.js";
import { BUILDING_BY_ID } from "../buildings/catalog.js";
import type { UnitKind } from "./catalog.js";
import { isFriendly, type TeamRoster } from "../teams.js";

const RADIO_BUILDING_ID = "boardcast";

function linkedSet(
  connectedIds: ReadonlySet<string> | readonly string[],
): ReadonlySet<string> {
  return connectedIds instanceof Set ? connectedIds : new Set(connectedIds);
}

/** All radio coverage circles for an owner (completed, comms-linked 电台 + allies). */
export function collectRadioCoverage(
  buildings: readonly PlacedBuilding[],
  ownerId: string,
  connectedIds: ReadonlySet<string> | readonly string[] = [],
  teams?: TeamRoster | null,
): WorkRangeCircle[] {
  const linked = linkedSet(connectedIds);
  const out: WorkRangeCircle[] = [];
  for (const b of buildings) {
    if (!isFriendly(teams, b.ownerId, ownerId)) continue;
    if (b.buildingId !== RADIO_BUILDING_ID) continue;
    if (!isBuildingComplete(b)) continue;
    if (b.polluted) continue;
    if (!linked.has(b.id)) continue;
    out.push(...workRangeCircles(b, buildings, linked));
  }
  return out;
}

export function isInsideAnyCircle(
  gx: number,
  gy: number,
  circles: readonly WorkRangeCircle[],
): boolean {
  for (const c of circles) {
    if (Math.hypot(gx - c.gx, gy - c.gy) <= c.radiusDu + 1e-9) return true;
  }
  return false;
}

export function isInsideRadioCoverage(
  gx: number,
  gy: number,
  buildings: readonly PlacedBuilding[],
  ownerId: string,
  connectedIds: ReadonlySet<string> | readonly string[] = [],
  teams?: TeamRoster | null,
): boolean {
  return isInsideAnyCircle(
    gx,
    gy,
    collectRadioCoverage(buildings, ownerId, connectedIds, teams),
  );
}

/** Airport (+ linked radar) work range for a specific home airport building. */
export function collectAirportCoverage(
  airport: PlacedBuilding,
  buildings: readonly PlacedBuilding[],
  connectedIds: ReadonlySet<string> | readonly string[] = [],
): WorkRangeCircle[] {
  if (airport.buildingId !== "airport") return [];
  if (!isBuildingComplete(airport)) return [];
  if (airport.polluted) return [];
  return workRangeCircles(airport, buildings, connectedIds);
}

export function isInsideAirportCoverage(
  gx: number,
  gy: number,
  airport: PlacedBuilding,
  buildings: readonly PlacedBuilding[],
  connectedIds: ReadonlySet<string> | readonly string[] = [],
): boolean {
  return isInsideWorkRange(gx, gy, airport, buildings, connectedIds);
}

/**
 * Port work range for navy (and carriers) deployed from that port.
 * Includes linked radars via the same merge rule as other work ranges.
 */
export function collectPortNavyCoverage(
  port: PlacedBuilding,
  buildings: readonly PlacedBuilding[],
  connectedIds: ReadonlySet<string> | readonly string[] = [],
): WorkRangeCircle[] {
  if (port.buildingId !== "port") return [];
  if (!isBuildingComplete(port)) return [];
  if (port.polluted) return [];
  return workRangeCircles(port, buildings, connectedIds);
}

/**
 * Movement limit for a fielded group.
 * Air: home airport. Port navy / carrier: that port's work range (not radio).
 * Everyone else: radio.
 */
export function collectMovingUnitCoverage(
  unit: { kind: UnitKind; ownerId: string; homeBuildingId: string },
  buildings: readonly PlacedBuilding[],
  connectedIds: ReadonlySet<string> | readonly string[] = [],
  teams?: TeamRoster | null,
): WorkRangeCircle[] {
  if (unit.kind === "air") {
    return collectUnitActivityCoverage(
      "air",
      unit.ownerId,
      unit.homeBuildingId,
      buildings,
      connectedIds,
      teams,
    );
  }
  const home = buildings.find((b) => b.id === unit.homeBuildingId);
  if (
    (unit.kind === "navy" || unit.kind === "navy_carrier") &&
    home?.buildingId === "port"
  ) {
    return collectPortNavyCoverage(home, buildings, connectedIds);
  }
  return collectUnitActivityCoverage(
    "land",
    unit.ownerId,
    unit.homeBuildingId,
    buildings,
    connectedIds,
    teams,
  );
}

/**
 * Activity range for a unit kind:
 * - air → home airport work range
 * - else → owner radio coverage
 *
 * Training delivery, retreat, and port-navy orders that ignore radio must not use
 * this to constrain pathing — callers pass empty coverage / ignoreCoverage.
 * Port navy uses `collectPortNavyCoverage` instead of radio.
 */
export function collectUnitActivityCoverage(
  kind: "air" | "land",
  ownerId: string,
  homeBuildingId: string,
  buildings: readonly PlacedBuilding[],
  connectedIds: ReadonlySet<string> | readonly string[] = [],
  teams?: TeamRoster | null,
): WorkRangeCircle[] {
  if (kind === "air") {
    const home = buildings.find((b) => b.id === homeBuildingId);
    if (!home) return [];
    return collectAirportCoverage(home, buildings, connectedIds);
  }
  return collectRadioCoverage(buildings, ownerId, connectedIds, teams);
}

export function buildingHasWorkR(buildingId: string): boolean {
  const r = BUILDING_BY_ID[buildingId]?.workR;
  return r != null && r > 0;
}
