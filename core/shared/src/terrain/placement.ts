/**
 * Terrain placement rules for buildings and road/railway liaisons.
 */

import { cellAt, type TerrainMap } from "./types.js";
import { cellsTouchingNode, isCoastlineNode } from "./capitalSite.js";
import type { GridNode, LiaisonKind } from "../buildings/liaison.js";
import { isAdjacentGridNode, segmentLengthDu } from "../buildings/liaison.js";

/** 穿越林地内部额外造价（E / Du）；沿林缘不叠加. */
export const ROAD_RAIL_FOREST_E_PER_DU = 50;

/** 公路/铁路山区、海洋额外造价（E / Du）；山脚/海岸线按半价. */
export const ROAD_RAIL_TERRAIN_E_PER_DU = {
  railway: { mountain: 200, ocean: 250 },
  road: { mountain: 150, ocean: 150 },
} as const;

export type RoadRailLineKind = keyof typeof ROAD_RAIL_TERRAIN_E_PER_DU;

/** 港口：须在海岸线（邻海且邻陆）. */
export function isValidPortSite(map: TerrainMap, gx: number, gy: number): boolean {
  if (!isCoastlineNode(map, gx, gy)) return false;
  const cells = cellsTouchingNode(map, gx, gy);
  const hasLand = cells.some(({ x, y }) => {
    const g = cellAt(map, x, y)?.ground;
    return g === "land" || g === "mountain";
  });
  return hasLand;
}

/**
 * Cells geometrically crossed / bordered by a unit grid segment (edge or diagonal).
 */
export function cellsTouchedBySegment(
  map: TerrainMap,
  a: GridNode,
  b: GridNode,
): Array<{ x: number; y: number }> {
  const dx = b.gx - a.gx;
  const dy = b.gy - a.gy;
  const out: Array<{ x: number; y: number }> = [];
  const push = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < map.width && y < map.height) out.push({ x, y });
  };

  if (Math.abs(dx) + Math.abs(dy) === 1) {
    // Orthogonal: edge shared by two cells
    if (dy === 0) {
      const x = Math.min(a.gx, b.gx);
      const y = a.gy;
      push(x, y - 1);
      push(x, y);
    } else {
      const y = Math.min(a.gy, b.gy);
      const x = a.gx;
      push(x - 1, y);
      push(x, y);
    }
    return out;
  }

  if (Math.abs(dx) === 1 && Math.abs(dy) === 1) {
    // Diagonal: passes through one cell
    push(Math.min(a.gx, b.gx), Math.min(a.gy, b.gy));
    return out;
  }

  return out;
}

export type RoadRailSegmentTerrain =
  | "plain"
  | "foothill"
  | "mountain"
  | "coastline"
  | "ocean";

/**
 * Classify a unit segment for surcharge.
 * 山脚 = 陆|山共边；海岸线 = 陆|海共边；纯山/纯海为全价.
 */
export function classifyRoadRailSegment(
  map: TerrainMap,
  a: GridNode,
  b: GridNode,
): RoadRailSegmentTerrain {
  const cells = cellsTouchedBySegment(map, a, b);
  let hasLand = false;
  let hasMountain = false;
  let hasOcean = false;
  for (const { x, y } of cells) {
    const g = cellAt(map, x, y)?.ground;
    if (g === "land") hasLand = true;
    else if (g === "mountain") hasMountain = true;
    else if (g === "ocean") hasOcean = true;
  }
  if (hasMountain && hasLand && !hasOcean) return "foothill";
  if (hasMountain) return "mountain";
  if (hasOcean && hasLand) return "coastline";
  if (hasOcean) return "ocean";
  return "plain";
}

/** True when every cell the segment touches is forest (内部穿越，非林缘). */
export function isForestInteriorSegment(
  map: TerrainMap,
  a: GridNode,
  b: GridNode,
): boolean {
  const cells = cellsTouchedBySegment(map, a, b);
  if (cells.length === 0) return false;
  return cells.every(
    ({ x, y }) => cellAt(map, x, y)?.resource?.kind === "forest",
  );
}

export function roadRailTerrainRateEPerDu(
  lineKind: RoadRailLineKind,
  terrain: RoadRailSegmentTerrain,
): number {
  const rates = ROAD_RAIL_TERRAIN_E_PER_DU[lineKind];
  switch (terrain) {
    case "mountain":
      return rates.mountain;
    case "foothill":
      return rates.mountain / 2;
    case "ocean":
      return rates.ocean;
    case "coastline":
      return rates.ocean / 2;
    default:
      return 0;
  }
}

export function roadRailTerrainDu(
  map: TerrainMap,
  nodes: readonly GridNode[],
): {
  mountainDu: number;
  foothillDu: number;
  oceanDu: number;
  coastlineDu: number;
  forestDu: number;
  plainDu: number;
} {
  let mountainDu = 0;
  let foothillDu = 0;
  let oceanDu = 0;
  let coastlineDu = 0;
  let forestDu = 0;
  let plainDu = 0;
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1]!;
    const b = nodes[i]!;
    const len = segmentLengthDu(a, b);
    const terrain = classifyRoadRailSegment(map, a, b);
    if (terrain === "mountain") mountainDu += len;
    else if (terrain === "foothill") foothillDu += len;
    else if (terrain === "ocean") oceanDu += len;
    else if (terrain === "coastline") coastlineDu += len;
    else plainDu += len;
    if (isForestInteriorSegment(map, a, b)) forestDu += len;
  }
  return { mountainDu, foothillDu, oceanDu, coastlineDu, forestDu, plainDu };
}

/**
 * Extra E for mountain/ocean/foothill/coastline/forest on road or railway.
 * 山脚/海岸线按山区/海洋半价；林内 +50E/Du，林缘不加.
 */
export function roadRailTerrainSurchargeE(
  map: TerrainMap,
  nodes: readonly GridNode[],
  lineKind: LiaisonKind | RoadRailLineKind,
): number {
  if (lineKind !== "road" && lineKind !== "railway") return 0;
  let total = 0;
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1]!;
    const b = nodes[i]!;
    const len = segmentLengthDu(a, b);
    let rate = roadRailTerrainRateEPerDu(lineKind, classifyRoadRailSegment(map, a, b));
    if (isForestInteriorSegment(map, a, b)) rate += ROAD_RAIL_FOREST_E_PER_DU;
    total += len * rate;
  }
  return Math.floor(total);
}

/** @deprecated Nodes may sit on any terrain; kept for callers. */
export function isValidRoadRailNode(map: TerrainMap, gx: number, gy: number): boolean {
  return cellsTouchingNode(map, gx, gy).length > 0;
}

/** Road/railway may cross mountain and ocean (with surcharge). */
export function isValidRoadRailSegment(
  map: TerrainMap,
  a: GridNode,
  b: GridNode,
): boolean {
  if (!isAdjacentGridNode(a, b)) return false;
  return isValidRoadRailNode(map, a.gx, a.gy) && isValidRoadRailNode(map, b.gx, b.gy);
}

/** No hard terrain bans; structural checks live elsewhere. */
export function roadRailPathRejectReason(
  _map: TerrainMap,
  nodes: readonly GridNode[],
): string | null {
  if (nodes.length < 2) return "请拖出至少一段路径";
  return null;
}

/** Identity clamp (mountain/ocean allowed); keeps API for drawing helpers. */
export function clampRoadRailPath(
  map: TerrainMap,
  nodes: readonly GridNode[],
): GridNode[] {
  if (nodes.length === 0) return [];
  if (!isValidRoadRailNode(map, nodes[0]!.gx, nodes[0]!.gy)) return [];
  const out: GridNode[] = [{ ...nodes[0]! }];
  for (let i = 1; i < nodes.length; i++) {
    if (!isValidRoadRailSegment(map, out[out.length - 1]!, nodes[i]!)) break;
    out.push({ ...nodes[i]! });
  }
  return out;
}
