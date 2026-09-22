import type { UnitKind, UnitState } from "./catalog.js";
import { UNIT_BY_KIND } from "./catalog.js";
import type { UnitGroup } from "./types.js";
import {
  collectAllDirectVisionSources,
  unitInDirectVision,
} from "../vision/vision.js";
import type { PlacedBuilding } from "../buildings/actions.js";

function stripOwnServerOnly(u: UnitGroup): UnitGroup {
  const copy: UnitGroup = { ...u, visionLevel: "direct" };
  if (copy.path) copy.path = copy.path.map((p) => ({ ...p }));
  return copy;
}

/**
 * Viewer snapshot for units (§4.5).
 * - Own: full (position, kind, u, state, path + pathIndex, …) so client can
 *   preview remaining march route when selected
 * - Enemy satellite: omitted
 * - Enemy direct: position + kind + state; hide u (strengthHidden); no path
 * - Air-only vision sources only reveal enemy air (and flying missiles later)
 */
export function filterUnitForViewer(
  unit: UnitGroup,
  viewerId: string,
  sources: ReturnType<typeof collectAllDirectVisionSources>,
): UnitGroup | null {
  if (unit.ownerId === viewerId) return stripOwnServerOnly(unit);
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
          unit.state === "holding"
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
): UnitGroup[] {
  const sources = collectAllDirectVisionSources(
    buildings,
    units,
    viewerId,
    connectedIds,
  );
  const out: UnitGroup[] = [];
  for (const u of units) {
    const filtered = filterUnitForViewer(u, viewerId, sources);
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
