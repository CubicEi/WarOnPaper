import type { UnitKind, UnitState } from "./catalog.js";
import { UNIT_BY_KIND } from "./catalog.js";
import type { UnitGroup } from "./types.js";
import {
  collectAllDirectVisionSources,
  unitInDirectVision,
} from "../vision/vision.js";
import type { PlacedBuilding } from "../buildings/actions.js";
import { isFriendly, type TeamRoster } from "../teams.js";

function stripOwnServerOnly(u: UnitGroup): UnitGroup {
  const copy: UnitGroup = { ...u, visionLevel: "direct" };
  if (copy.path) copy.path = copy.path.map((p) => ({ ...p }));
  return copy;
}

/**
 * Viewer snapshot for units (§4.5).
 * - Own / ally: full (position, kind, u, state, path + pathIndex, …) so client can
 *   preview remaining march route when selected
 * - Enemy satellite: omitted
 * - Enemy direct: position + kind + state; hide u (strengthHidden); no path
 * - Air-only vision sources only reveal enemy air (and flying missiles later)
 */
export function filterUnitForViewer(
  unit: UnitGroup,
  viewerId: string,
  sources: ReturnType<typeof collectAllDirectVisionSources>,
  teams?: TeamRoster | null,
): UnitGroup | null {
  if (isFriendly(teams, unit.ownerId, viewerId)) return stripOwnServerOnly(unit);
  if (!unitInDirectVision(unit, sources)) return null;
  const moving = unit.state === "moving" || unit.state === "training";
  return {
    id: unit.id,
    ownerId: unit.ownerId,
    kind: unit.kind,
    u: 0,
    gx: unit.gx,
    gy: unit.gy,
    carriedE: 0,
    state: moving
      ? unit.state
      : unit.state === "blockading" ||
          unit.state === "fighting" ||
          unit.state === "holding" ||
          unit.state === "docked"
        ? unit.state
        : "idle",
    homeBuildingId: "",
    visionLevel: "direct",
    strengthHidden: true,
    // Explicitly omit path / pathIndex / embarkedAirU / aaEngagement for enemies.
  };
}

export function filterUnitsForViewer(
  units: readonly UnitGroup[],
  viewerId: string,
  buildings: readonly PlacedBuilding[],
  connectedIds: ReadonlySet<string> | readonly string[] = [],
  teams?: TeamRoster | null,
): UnitGroup[] {
  const sources = collectAllDirectVisionSources(
    buildings,
    units,
    viewerId,
    connectedIds,
    teams,
  );
  const out: UnitGroup[] = [];
  for (const u of units) {
    const filtered = filterUnitForViewer(u, viewerId, sources, teams);
    if (filtered) out.push(filtered);
  }
  return out;
}

function stripEnemyUnitForOverview(unit: UnitGroup): UnitGroup {
  const moving = unit.state === "moving" || unit.state === "training";
  return {
    id: unit.id,
    ownerId: unit.ownerId,
    kind: unit.kind,
    u: 0,
    gx: unit.gx,
    gy: unit.gy,
    carriedE: 0,
    state: moving
      ? unit.state
      : unit.state === "blockading" ||
          unit.state === "fighting" ||
          unit.state === "holding" ||
          unit.state === "docked"
        ? unit.state
        : "idle",
    homeBuildingId: "",
    visionLevel: "satellite",
    strengthHidden: true,
  };
}

/**
 * Read档大厅 · 存档持有者：展示全部单位（敌方仅位置/兵种，无 U）。
 */
export function restoreHolderOverviewUnits(
  units: readonly UnitGroup[],
  viewerId: string,
  teams?: TeamRoster | null,
): UnitGroup[] {
  const out: UnitGroup[] = [];
  for (const u of units) {
    if (isFriendly(teams, u.ownerId, viewerId)) {
      out.push(stripOwnServerOnly(u));
    } else {
      out.push(stripEnemyUnitForOverview(u));
    }
  }
  return out;
}

/**
 * Read档大厅 · 持有者：仅已入座下载者的单位全可见；其余仍走卫星规则。
 */
export function filterUnitsForRestoreHolderViewer(
  units: readonly UnitGroup[],
  holderId: string,
  downloaderOwnerIds: ReadonlySet<string>,
  buildings: readonly PlacedBuilding[],
  teams?: TeamRoster | null,
): UnitGroup[] {
  const sources = collectAllDirectVisionSources(
    buildings,
    [],
    holderId,
    [],
    teams,
  );
  const out: UnitGroup[] = [];
  for (const u of units) {
    if (isFriendly(teams, u.ownerId, holderId)) {
      out.push(stripOwnServerOnly(u));
      continue;
    }
    if (downloaderOwnerIds.has(u.ownerId)) {
      out.push(stripEnemyUnitForOverview(u));
      continue;
    }
    const filtered = filterUnitForViewer(u, holderId, sources, teams);
    if (filtered) out.push(filtered);
  }
  return out;
}

/** Restore lobby non-holder: no unit-based direct vision until playing. */
export function filterUnitsForRestoreLobbyViewer(
  units: readonly UnitGroup[],
  viewerId: string,
  buildings: readonly PlacedBuilding[],
  teams?: TeamRoster | null,
): UnitGroup[] {
  const sources = collectAllDirectVisionSources(
    buildings,
    [],
    viewerId,
    [],
    teams,
  );
  const out: UnitGroup[] = [];
  for (const u of units) {
    const filtered = filterUnitForViewer(u, viewerId, sources, teams);
    if (filtered) out.push(filtered);
  }
  return out;
}

export function unitHp(kind: UnitKind): number {
  return UNIT_BY_KIND[kind].hp;
}

export function isMovingState(state: UnitState): boolean {
  return state === "moving" || state === "training";
}
