/** Terrain / resource kinds from rules §2.1 */
export type GroundKind = "ocean" | "land" | "mountain";
export type ResourceKind = "oil" | "uranium" | "forest";

export interface TerrainResource {
  kind: ResourceKind;
  /** Remaining reserve (油田按整块，铀矿按矿点，林地按格). */
  reserve: number;
  /** Initial reserve (for UI ring). */
  reserveMax: number;
  /** Oil/uranium deposit id (forest cells are independent). */
  depositId?: number;
  /** 规则：储量仅在首次开采后对玩家可见 */
  revealed?: boolean;
}

export interface TerrainCell {
  ground: GroundKind;
  resource: TerrainResource | null;
}

export interface TerrainDeposit {
  id: number;
  kind: "oil" | "uranium";
  cells: Array<{ x: number; y: number }>;
  reserve: number;
  reserveMax: number;
}

export interface TerrainMap {
  seed: number;
  width: number;
  height: number;
  /** Row-major: index = y * width + x */
  cells: TerrainCell[];
  deposits: TerrainDeposit[];
}

/** Client overlay for revealed resource reserves (server-authoritative).
 *  `x`/`y` are cell indices (may be fractional for deposit centroids). */
export interface ResourceSightCell {
  x: number;
  y: number;
  kind: ResourceKind;
  reserve: number;
  reserveMax: number;
}

/**
 * Authoritative resource-layer sync so the client can update terrain visuals
 * after depletion (forest → plains, oil/uranium borders removed).
 */
export interface ResourceTerrainSync {
  /** Cells whose resource was removed (枯竭). */
  cleared: Array<{ x: number; y: number }>;
  /** Current deposit reserves (oil / uranium). */
  deposits: Array<{ id: number; reserve: number }>;
}

export function cellAt(map: TerrainMap, x: number, y: number): TerrainCell | null {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return null;
  return map.cells[y * map.width + x];
}
