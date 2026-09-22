import { cellAt, type TerrainMap } from "./types.js";

/** Cells that meet at an integer grid intersection (gx, gy) — up to 4. */
export function cellsTouchingNode(
  map: TerrainMap,
  gx: number,
  gy: number,
): Array<{ x: number; y: number }> {
  const nx = Math.round(gx);
  const ny = Math.round(gy);
  const out: Array<{ x: number; y: number }> = [];
  for (const dx of [-1, 0] as const) {
    for (const dy of [-1, 0] as const) {
      const x = nx + dx;
      const y = ny + dy;
      if (x >= 0 && y >= 0 && x < map.width && y < map.height) {
        out.push({ x, y });
      }
    }
  }
  return out;
}

const UNIT_NODE_EPS = 1e-6;

function nearInteger(v: number): boolean {
  return Math.abs(v - Math.round(v)) < UNIT_NODE_EPS;
}

/**
 * Cells geometrically incident to a unit-grid point (0.2 Du step).
 * Unlike {@link cellsTouchingNode}, does not round fractional coords to the
 * nearest integer (that wrongly classified mid-sea 0.2 points as coastline).
 *
 * - Integer corner: up to 4 cells (same as cellsTouchingNode).
 * - On a vertical/horizontal grid line: 2 cells sharing that edge.
 * - Cell interior: the single containing cell.
 */
export function cellsTouchingUnitCoord(
  map: TerrainMap,
  gx: number,
  gy: number,
): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  const push = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < map.width && y < map.height) out.push({ x, y });
  };

  if (nearInteger(gx) && nearInteger(gy)) {
    const nx = Math.round(gx);
    const ny = Math.round(gy);
    for (const dx of [-1, 0] as const) {
      for (const dy of [-1, 0] as const) {
        push(nx + dx, ny + dy);
      }
    }
    return out;
  }

  if (nearInteger(gx)) {
    const nx = Math.round(gx);
    const y = Math.floor(gy + UNIT_NODE_EPS);
    push(nx - 1, y);
    push(nx, y);
    return out;
  }

  if (nearInteger(gy)) {
    const ny = Math.round(gy);
    const x = Math.floor(gx + UNIT_NODE_EPS);
    push(x, ny - 1);
    push(x, ny);
    return out;
  }

  push(Math.floor(gx + UNIT_NODE_EPS), Math.floor(gy + UNIT_NODE_EPS));
  return out;
}

/** 山脚：格点周围四格至少有一个山区格子。 */
export function isFoothillNode(map: TerrainMap, gx: number, gy: number): boolean {
  return cellsTouchingNode(map, gx, gy).some(({ x, y }) => {
    return cellAt(map, x, y)?.ground === "mountain";
  });
}

/** 海岸线：格点周围四格至少有一个海洋格子。 */
export function isCoastlineNode(map: TerrainMap, gx: number, gy: number): boolean {
  return cellsTouchingNode(map, gx, gy).some(({ x, y }) => {
    return cellAt(map, x, y)?.ground === "ocean";
  });
}

/** 森林中间：格点周围四格均为林地。 */
export function isForestInteriorNode(map: TerrainMap, gx: number, gy: number): boolean {
  const cells = cellsTouchingNode(map, gx, gy);
  if (cells.length === 0) return false;
  return cells.every(({ x, y }) => cellAt(map, x, y)?.resource?.kind === "forest");
}

/**
 * 首都可选点：除山区、海洋、山脚、海边、森林中间以外的格点。
 * 即四格皆为陆地，且非森林中间（四格不全是林地）。
 */
export function isValidCapitalSite(map: TerrainMap, gx: number, gy: number): boolean {
  const cells = cellsTouchingNode(map, gx, gy);
  if (cells.length === 0) return false;
  if (isFoothillNode(map, gx, gy)) return false;
  if (isCoastlineNode(map, gx, gy)) return false;
  if (isForestInteriorNode(map, gx, gy)) return false;
  return cells.every(({ x, y }) => cellAt(map, x, y)?.ground === "land");
}

/** @deprecated Prefer node-level checks; kept for callers that inspect a single cell. */
export function isValidCapitalCell(map: TerrainMap, x: number, y: number): boolean {
  const cell = cellAt(map, x, y);
  if (!cell || cell.ground !== "land") return false;
  // Approximate: treat cell center as a node at (x+1, y+1) corner — not used for placement.
  return true;
}

export type CapitalSiteRejectReason =
  | "ocean"
  | "mountain"
  | "coast"
  | "foothill"
  | "forest"
  | "too_close"
  | "invalid";

/** 规则：两座首都距离必须大于该值（Du）。圈内（含边界）不能再设首都。 */
export const CAPITAL_EXCLUSION_R_DU = 10;

export function capitalExclusionRejectReason(
  gx: number,
  gy: number,
  sites: readonly { gx: number; gy: number; ownerId?: string; buildingId?: string }[],
  selfOwnerId?: string | null,
): "too_close" | null {
  for (const c of sites) {
    if (c.buildingId && c.buildingId !== "capital") continue;
    if (selfOwnerId && c.ownerId === selfOwnerId) continue;
    const dist = Math.hypot(c.gx - gx, c.gy - gy);
    if (dist <= CAPITAL_EXCLUSION_R_DU + 1e-6) return "too_close";
  }
  return null;
}

export function capitalSiteRejectReason(
  map: TerrainMap,
  gx: number,
  gy: number,
): CapitalSiteRejectReason | null {
  if (isValidCapitalSite(map, gx, gy)) return null;

  const cells = cellsTouchingNode(map, gx, gy);
  if (cells.length === 0) return "invalid";

  let mountainCount = 0;
  let oceanCount = 0;
  for (const { x, y } of cells) {
    const g = cellAt(map, x, y)?.ground;
    if (g === "mountain") mountainCount += 1;
    if (g === "ocean") oceanCount += 1;
  }

  // Prefer specific terrain messages when the node sits fully on that ground.
  if (mountainCount === cells.length) return "mountain";
  if (oceanCount === cells.length) return "ocean";
  if (isFoothillNode(map, gx, gy)) return "foothill";
  if (isCoastlineNode(map, gx, gy)) return "coast";
  if (isForestInteriorNode(map, gx, gy)) return "forest";
  return "invalid";
}

export function capitalSiteRejectMessage(reason: CapitalSiteRejectReason): string {
  switch (reason) {
    case "mountain":
      return "首都不能建在山上";
    case "ocean":
      return "首都不能建在海上";
    case "coast":
      return "首都不能建在海边";
    case "foothill":
      return "首都不能建在山脚";
    case "forest":
      return "首都不能建在森林中间";
    case "too_close":
      return "不能建在其他首都 10 Du 范围内";
    default:
      return "此处不能定为首都";
  }
}
